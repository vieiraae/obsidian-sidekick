import {Modal, Notice, setIcon} from 'obsidian';
import type SidekickPlugin from './main';
import {approveAll} from './copilot';
import type {PermissionRequest, PermissionRequestResult, UserInputRequest, UserInputResponse} from './copilot';
import {TASKS, TEXT_ACTION_SYSTEM_MESSAGE} from './tasks';
import type {TaskLabel} from './tasks';
import {SidekickView, SIDEKICK_VIEW_TYPE} from './sidekickView';
import {DEFAULT_EDIT_MODAL} from './settings';

/** Tone options for the edit modal. */
const TONES = [
	'Professional',
	'Casual',
	'Enthusiastic',
	'Informational',
	'Confident',
	'Technical',
	'Funny',
] as const;

type Tone = typeof TONES[number];

const TONE_ICONS: Record<Tone, string> = {
	'Professional': '👔',
	'Casual': '😊',
	'Enthusiastic': '🎉',
	'Informational': 'ℹ️',
	'Confident': '💪',
	'Technical': '⚙️',
	'Funny': '😂',
};

/** Format options for the edit modal. */
const FORMATS = [
	'Single paragraph',
	'Paragraphs with line breaks',
	'List',
	'Ordered list',
	'Table',
	'Task list',
	'Headings',
	'Blockquotes',
	'Code blocks',
	'Emojis',
	'HTML',
	'JSON',
] as const;

type Format = typeof FORMATS[number];

const FORMAT_ICONS: Record<Format, string> = {
	'Single paragraph': '¶',
	'Paragraphs with line breaks': '↵',
	'List': '•',
	'Ordered list': '#',
	'Table': '☰',
	'Task list': '☑',
	'Headings': 'H',
	'Blockquotes': '❝',
	'Code blocks': '</>',
	'Emojis': '😀',
	'HTML': '🌐',
	'JSON': '{}',
};

/** Callback that receives the chosen result text. */
export type EditResultCallback = (text: string) => void;

/**
 * A modal dialog for advanced text editing with AI.
 * Lets the user configure tone, length, number of choices,
 * and an optional edit prompt before sending to the LLM.
 */
export class EditModal extends Modal {
	private plugin: SidekickPlugin;
	private initialText: string;
	private onChoose: EditResultCallback;

	// Form state
	private task: TaskLabel = 'Rewrite';
	private adjustTask = false;
	private tone: Tone = 'Professional';
	private adjustTone = false;
	private format: Format = 'Single paragraph';
	private adjustFormat = false;
	private length = 5;
	private adjustLength = false;
	private choices = 4;
	private editPrompt = '';

	// DOM refs
	private textArea!: HTMLTextAreaElement;
	private taskSelect!: HTMLSelectElement;
	private toneSelect!: HTMLSelectElement;
	private formatSelect!: HTMLSelectElement;
	private lengthSlider!: HTMLInputElement;
	private lengthValue!: HTMLSpanElement;
	private choicesSlider!: HTMLInputElement;
	private choicesValue!: HTMLSpanElement;
	private promptArea!: HTMLTextAreaElement;
	private sendBtn!: HTMLButtonElement;
	private sendBtnIcon!: HTMLSpanElement;
	private cancelBtn!: HTMLButtonElement;
	private resultsContainer!: HTMLElement;
	private formContainer!: HTMLElement;

	private abortController: AbortController | null = null;
	private isProcessing = false;
	// 5 lines at ~1.5 line-height * font-ui-small (~13px) ≈ ~98px
	private readonly promptAreaMaxHeight = 98;

	constructor(
		plugin: SidekickPlugin,
		initialText: string,
		onChoose: EditResultCallback,
	) {
		super(plugin.app);
		this.plugin = plugin;
		this.initialText = initialText;
		this.onChoose = onChoose;

		// Restore persisted form defaults
		const d = plugin.settings.editModalDefaults ?? DEFAULT_EDIT_MODAL;
		this.task = (d.task ?? DEFAULT_EDIT_MODAL.task) as TaskLabel;
		this.adjustTask = d.adjustTask ?? DEFAULT_EDIT_MODAL.adjustTask;
		this.tone = (d.tone ?? DEFAULT_EDIT_MODAL.tone) as Tone;
		this.adjustTone = d.adjustTone ?? DEFAULT_EDIT_MODAL.adjustTone;
		this.format = (d.format ?? DEFAULT_EDIT_MODAL.format) as Format;
		this.adjustFormat = d.adjustFormat ?? DEFAULT_EDIT_MODAL.adjustFormat;
		this.length = d.length ?? DEFAULT_EDIT_MODAL.length;
		this.adjustLength = d.adjustLength ?? DEFAULT_EDIT_MODAL.adjustLength;
		this.choices = d.choices ?? DEFAULT_EDIT_MODAL.choices;
		this.editPrompt = d.editPrompt ?? DEFAULT_EDIT_MODAL.editPrompt;
	}

	onOpen(): void {
		const {contentEl, titleEl} = this;
		titleEl.setText('Sidekick edit');
		contentEl.addClass('sidekick-edit-modal');

		this.formContainer = contentEl.createDiv({cls: 'sidekick-edit-form'});
		this.buildForm(this.formContainer);

		this.resultsContainer = contentEl.createDiv({cls: 'sidekick-edit-results'});
		this.resultsContainer.style.display = 'none';
	}

	onClose(): void {
		this.abortController?.abort();

		// Persist current form state for next open
		this.plugin.settings.editModalDefaults = {
			task: this.task,
			adjustTask: this.adjustTask,
			tone: this.tone,
			adjustTone: this.adjustTone,
			format: this.format,
			adjustFormat: this.adjustFormat,
			length: this.length,
			adjustLength: this.adjustLength,
			choices: this.choices,
			editPrompt: this.promptArea?.value ?? this.editPrompt,
		};
		void this.plugin.saveSettings();

		this.contentEl.empty();
	}

	private buildForm(parent: HTMLElement): void {
		// Text area
		const textGroup = parent.createDiv({cls: 'sidekick-edit-group'});
		this.textArea = textGroup.createEl('textarea', {
			cls: 'sidekick-edit-textarea',
			attr: {rows: '5', placeholder: 'Enter text to edit…', title: 'The text you want to edit or transform'},
		});
		this.textArea.value = this.initialText;
		this.textArea.addEventListener('keydown', (e: KeyboardEvent) => {
			if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
				e.preventDefault();
				this.sendBtn.click();
			}
		});

		// Options row
		const optionsRow = parent.createDiv({cls: 'sidekick-edit-options'});

		// Task (with adjust checkbox)
		const taskGroup = optionsRow.createDiv({cls: 'sidekick-edit-option-group'});
		const taskLabelRow = taskGroup.createDiv({cls: 'sidekick-edit-label sidekick-edit-checkbox-row'});
		const taskCheckbox = taskLabelRow.createEl('input', {
			type: 'checkbox',
			cls: 'sidekick-edit-adjust-checkbox',
			attr: {title: 'Enable task selection'},
		});
		taskCheckbox.checked = this.adjustTask;
		taskLabelRow.createSpan({text: 'Task'});
		this.taskSelect = taskGroup.createEl('select', {cls: 'sidekick-edit-select', attr: {title: 'Select the editing task'}});
		for (const task of TASKS) {
			const opt = this.taskSelect.createEl('option', {text: `${task.emoji} ${task.label}`});
			opt.value = task.label;
		}
		this.taskSelect.value = this.task;
		if (!this.adjustTask) this.taskSelect.addClass('is-disabled');
		this.taskSelect.addEventListener('change', () => { this.task = this.taskSelect.value as TaskLabel; });
		taskGroup.addEventListener('click', (e) => {
			if (!this.adjustTask && e.target !== taskCheckbox) {
				this.adjustTask = true;
				taskCheckbox.checked = true;
				this.taskSelect.removeClass('is-disabled');
			}
		});
		taskCheckbox.addEventListener('change', () => {
			this.adjustTask = taskCheckbox.checked;
			this.taskSelect.toggleClass('is-disabled', !this.adjustTask);
		});

		// Tone (with adjust checkbox)
		const toneGroup = optionsRow.createDiv({cls: 'sidekick-edit-option-group'});
		const toneLabelRow = toneGroup.createDiv({cls: 'sidekick-edit-label sidekick-edit-checkbox-row'});
		const toneCheckbox = toneLabelRow.createEl('input', {
			type: 'checkbox',
			cls: 'sidekick-edit-adjust-checkbox',
			attr: {title: 'Enable tone adjustment'},
		});
		toneCheckbox.checked = this.adjustTone;
		toneLabelRow.createSpan({text: 'Tone'});
		this.toneSelect = toneGroup.createEl('select', {cls: 'sidekick-edit-select', attr: {title: 'Select the desired tone'}});
		for (const tone of TONES) {
			const opt = this.toneSelect.createEl('option', {text: `${TONE_ICONS[tone]} ${tone}`});
			opt.value = tone;
		}
		this.toneSelect.value = this.tone;
		if (!this.adjustTone) this.toneSelect.addClass('is-disabled');
		this.toneSelect.addEventListener('change', () => { this.tone = this.toneSelect.value as Tone; });
		toneGroup.addEventListener('click', (e) => {
			if (!this.adjustTone && e.target !== toneCheckbox) {
				this.adjustTone = true;
				toneCheckbox.checked = true;
				this.toneSelect.removeClass('is-disabled');
			}
		});
		toneCheckbox.addEventListener('change', () => {
			this.adjustTone = toneCheckbox.checked;
			this.toneSelect.toggleClass('is-disabled', !this.adjustTone);
		});

		// Format (with adjust checkbox)
		const formatGroup = optionsRow.createDiv({cls: 'sidekick-edit-option-group'});
		const formatLabelRow = formatGroup.createDiv({cls: 'sidekick-edit-label sidekick-edit-checkbox-row'});
		const formatCheckbox = formatLabelRow.createEl('input', {
			type: 'checkbox',
			cls: 'sidekick-edit-adjust-checkbox',
			attr: {title: 'Enable format adjustment'},
		});
		formatCheckbox.checked = this.adjustFormat;
		formatLabelRow.createSpan({text: 'Format'});
		this.formatSelect = formatGroup.createEl('select', {cls: 'sidekick-edit-select', attr: {title: 'Select the desired output format'}});
		for (const fmt of FORMATS) {
			const opt = this.formatSelect.createEl('option', {text: `${FORMAT_ICONS[fmt]} ${fmt}`});
			opt.value = fmt;
		}
		this.formatSelect.value = this.format;
		if (!this.adjustFormat) this.formatSelect.addClass('is-disabled');
		this.formatSelect.addEventListener('change', () => { this.format = this.formatSelect.value as Format; });
		formatGroup.addEventListener('click', (e) => {
			if (!this.adjustFormat && e.target !== formatCheckbox) {
				this.adjustFormat = true;
				formatCheckbox.checked = true;
				this.formatSelect.removeClass('is-disabled');
			}
		});
		formatCheckbox.addEventListener('change', () => {
			this.adjustFormat = formatCheckbox.checked;
			this.formatSelect.toggleClass('is-disabled', !this.adjustFormat);
		});

		// Length (with adjust checkbox)
		const lengthGroup = optionsRow.createDiv({cls: 'sidekick-edit-option-group'});
		const lengthLabelRow = lengthGroup.createDiv({cls: 'sidekick-edit-label sidekick-edit-checkbox-row'});
		const lengthCheckbox = lengthLabelRow.createEl('input', {
			type: 'checkbox',
			cls: 'sidekick-edit-adjust-checkbox',
			attr: {title: 'Enable length adjustment'},
		});
		lengthCheckbox.checked = this.adjustLength;
		const lengthTextSpan = lengthLabelRow.createSpan({text: 'Length: '});
		this.lengthValue = lengthLabelRow.createSpan({text: String(this.length), cls: 'sidekick-edit-slider-value'});
		this.lengthSlider = lengthGroup.createEl('input', {
			type: 'range',
			cls: 'sidekick-edit-slider',
			attr: {min: '1', max: '10', value: String(this.length), title: 'Relative output length (1 = shortest, 10 = longest)'},
		});
		if (!this.adjustLength) this.lengthSlider.addClass('is-disabled');
		this.lengthSlider.addEventListener('input', () => {
			this.length = Number(this.lengthSlider.value);
			this.lengthValue.textContent = String(this.length);
		});
		lengthGroup.addEventListener('click', (e) => {
			if (!this.adjustLength && e.target !== lengthCheckbox) {
				this.adjustLength = true;
				lengthCheckbox.checked = true;
				this.lengthSlider.removeClass('is-disabled');
			}
		});
		lengthCheckbox.addEventListener('change', () => {
			this.adjustLength = lengthCheckbox.checked;
			this.lengthSlider.toggleClass('is-disabled', !this.adjustLength);
		});

		// Edit instructions textarea
		this.promptArea = parent.createEl('textarea', {
			cls: 'sidekick-edit-textarea sidekick-edit-prompt-area',
			attr: {rows: '1', placeholder: 'Make it...', title: 'Optional instructions for how to edit the text'},
		});
		if (this.editPrompt) {
			this.promptArea.value = this.editPrompt;
		}
		this.promptArea.addEventListener('input', () => {
			this.promptArea.style.height = 'auto';
			const clamped = Math.min(this.promptArea.scrollHeight, this.promptAreaMaxHeight);
			this.promptArea.style.height = clamped + 'px';
			this.promptArea.style.overflowY = this.promptArea.scrollHeight > this.promptAreaMaxHeight ? 'auto' : 'hidden';
		});
		this.promptArea.addEventListener('keydown', (e: KeyboardEvent) => {
			if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
				e.preventDefault();
				this.sendBtn.click();
			}
		});

		// Bottom row: Choices (left) + buttons (right)
		const btnRow = parent.createDiv({cls: 'sidekick-edit-buttons'});

		// Choices slider (left side)
		const choicesGroup = btnRow.createDiv({cls: 'sidekick-edit-choices-inline'});
		const choicesLabel = choicesGroup.createEl('label', {cls: 'sidekick-edit-label'});
		choicesLabel.createSpan({text: 'Choices: '});
		this.choicesValue = choicesLabel.createSpan({text: String(this.choices), cls: 'sidekick-edit-slider-value'});
		this.choicesSlider = choicesGroup.createEl('input', {
			type: 'range',
			cls: 'sidekick-edit-slider',
			attr: {min: '1', max: '5', value: String(this.choices), title: 'Number of alternative results to generate'},
		});
		this.choicesSlider.addEventListener('input', () => {
			this.choices = Number(this.choicesSlider.value);
			this.choicesValue.textContent = String(this.choices);
		});

		// Spacer to push buttons right
		btnRow.createDiv({cls: 'sidekick-edit-btn-spacer'});

		this.cancelBtn = btnRow.createEl('button', {text: 'Cancel', cls: 'sidekick-edit-btn-secondary', attr: {title: 'Cancel or stop generation'}});
		this.cancelBtn.addEventListener('click', () => {
			if (this.isProcessing) {
				this.abortController?.abort();
				this.isProcessing = false;
				this.updateSendBtn(false);
			} else {
				this.close();
			}
		});

		this.sendBtn = btnRow.createEl('button', {cls: 'sidekick-edit-btn-primary', attr: {title: 'Generate choices (Ctrl+Enter)'}});
		this.sendBtnIcon = this.sendBtn.createSpan({cls: 'sidekick-edit-btn-icon'});
		setIcon(this.sendBtnIcon, 'arrow-right');
		this.sendBtn.addEventListener('click', () => {
			if (this.isProcessing) {
				this.abortController?.abort();
				this.isProcessing = false;
				this.updateSendBtn(false);
			} else {
				void this.handleGenerate();
			}
		});
	}

	private updateSendBtn(processing: boolean): void {
		this.sendBtnIcon.empty();
		if (processing) {
			setIcon(this.sendBtnIcon, 'square');
			this.sendBtn.setAttribute('title', 'Stop');
			this.sendBtn.addClass('is-streaming');
		} else {
			setIcon(this.sendBtnIcon, 'arrow-right');
			this.sendBtn.setAttribute('title', 'Send');
			this.sendBtn.removeClass('is-streaming');
		}
	}

	private async handleGenerate(): Promise<void> {
		const text = this.textArea.value.trim();
		if (!text) {
			new Notice('Please enter some text.');
			return;
		}
		if (!this.plugin.copilot) {
			new Notice('Copilot is not configured.');
			return;
		}

		this.isProcessing = true;
		this.abortController = new AbortController();
		this.updateSendBtn(true);

		// Show "Generating…" in the results header
		this.resultsContainer.empty();
		this.resultsContainer.style.display = '';
		const generatingHeader = this.resultsContainer.createDiv({cls: 'sidekick-edit-results-header'});
		const generatingSpan = generatingHeader.createSpan({text: 'Generating…', cls: 'sidekick-edit-generating'});

		const startTime = performance.now();

		try {
			const results = await this.generateChoices(text);
			if (!this.isProcessing) return; // cancelled

			const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);
			const modelUsed = this.plugin.settings.inlineModel || 'default';

			// Replace generating indicator with results
			this.resultsContainer.empty();
			this.showResults(results, modelUsed, elapsed);
		} catch (e) {
			if (!this.isProcessing) return;
			const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);
			const modelUsed = this.plugin.settings.inlineModel || 'default';
			this.resultsContainer.empty();
			const errorHeader = this.resultsContainer.createDiv({cls: 'sidekick-edit-results-header sidekick-edit-error'});
			errorHeader.createSpan({text: `\u26A0\uFE0F \uD83E\uDDE0 ${modelUsed} | \u231A ${elapsed}s | Error: ${String(e)}`});
		} finally {
			this.isProcessing = false;
			this.abortController = null;
			this.updateSendBtn(false);
		}
	}

	private async generateChoices(text: string): Promise<string[]> {
		const editInstruction = this.promptArea.value.trim();

		const lengthDesc = this.getLengthDescription();
		const choicesCount = this.choices;

		const prompt =
			`Edit the following text according to these parameters:\n` +
			(this.adjustTask ? `- Task: ${this.task}\n` : '') +
			(this.adjustTone ? `- Tone: ${this.tone}\n` : '') +
			(this.adjustFormat ? `- Format: ${this.getFormatDescription()}\n` : '') +
			(this.adjustLength ? `- Length: ${lengthDesc}\n` : '') +
			`- Number of variations: ${choicesCount}\n` +
			(editInstruction ? `- Edit instruction: ${editInstruction}\n` : '') +
			`\nProvide exactly ${choicesCount} different variation(s) of the text. ` +
			`Separate each variation with the delimiter: ===CHOICE===\n` +
			`Do not include "Choice 1:", "Option 1:", numbering, or any labels before each variation.\n` +
			`Return ONLY the variations separated by ===CHOICE===, nothing else.\n\n` +
			`TEXT:\n${text}`;

		const systemMessage =
			TEXT_ACTION_SYSTEM_MESSAGE + ' ' +
			`When asked for multiple variations, separate them with ===CHOICE=== on its own line. ` +
			`Do not add any labels, numbers, or headings before each choice.`;

		const permissionHandler = (request: PermissionRequest) => {
			if (this.plugin.settings.toolApproval === 'allow') {
				return approveAll(request, {sessionId: ''});
			}
			return new Promise<PermissionRequestResult>((resolve) => {
				const modal = new Modal(this.app);
				modal.titleEl.setText('Tool approval required');
				const desc = modal.contentEl.createEl('p');
				desc.setText(`Permission: ${request.kind}${request.toolCallId ? ` (${request.toolCallId})` : ''}`);
				const btnRow = modal.contentEl.createDiv({cls: 'modal-button-container'});
				const allowBtn = btnRow.createEl('button', {text: 'Allow', cls: 'mod-cta'});
				const denyBtn = btnRow.createEl('button', {text: 'Deny'});
				allowBtn.addEventListener('click', () => { modal.close(); resolve({kind: 'approved'}); });
				denyBtn.addEventListener('click', () => { modal.close(); resolve({kind: 'denied-interactively-by-user'}); });
				modal.open();
			});
		};

		// Build user input handler that shows a simple modal when the agent asks
		const userInputHandler = (request: UserInputRequest) => {
			return new Promise<UserInputResponse>((resolve) => {
				const modal = new Modal(this.app);
				modal.titleEl.setText('Copilot needs your input');
				modal.contentEl.createEl('p', {text: request.question});

				if (request.choices && request.choices.length > 0) {
					const choiceRow = modal.contentEl.createDiv({cls: 'modal-button-container'});
					for (const choice of request.choices) {
						const btn = choiceRow.createEl('button', {text: choice});
						btn.addEventListener('click', () => { modal.close(); resolve({answer: choice, wasFreeform: false}); });
					}
				}

				if (request.allowFreeform !== false) {
					const input = modal.contentEl.createEl('textarea', {attr: {placeholder: 'Type your answer\u2026', rows: '3'}});
					input.style.width = '100%';
					input.style.marginTop = '8px';
					const btnRow = modal.contentEl.createDiv({cls: 'modal-button-container'});
					const submitBtn = btnRow.createEl('button', {text: 'Submit', cls: 'mod-cta'});
					submitBtn.addEventListener('click', () => {
						const answer = input.value.trim();
						if (!answer) return;
						modal.close();
						resolve({answer, wasFreeform: true});
					});
					input.addEventListener('keydown', (e) => {
						if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitBtn.click(); }
					});
				}

				modal.onClose = () => { resolve({answer: '', wasFreeform: true}); };
				modal.open();
			});
		};

		const {content: result, sessionId} = await this.plugin.copilot!.inlineChat({
			prompt,
			model: this.plugin.settings.inlineModel || undefined,
			systemMessage,
			onPermissionRequest: permissionHandler,
			onUserInputRequest: userInputHandler,
		});

		// Register as inline session so the sidebar filter can distinguish it
		const editDesc = this.editPrompt.trim() || 'Edit';
		const leaves = this.plugin.app.workspace.getLeavesOfType(SIDEKICK_VIEW_TYPE);
		if (leaves.length > 0 && leaves[0]) {
			(leaves[0].view as SidekickView).registerInlineSession(sessionId, `Edit: ${editDesc.slice(0, 30)}`);
		}

		if (!result) throw new Error('No response received.');

		// Parse choices
		const raw = result.trim();
		const choices = raw.split(/===CHOICE===/).map(c => c.trim()).filter(c => c.length > 0);

		// If the model didn't split properly, return the whole thing as one choice
		if (choices.length === 0) return [raw];
		return choices;
	}

	private getLengthDescription(): string {
		const descriptions: Record<number, string> = {
			1: 'extremely short (a few words)',
			2: 'very short (one sentence)',
			3: 'short (2-3 sentences)',
			4: 'somewhat brief',
			5: 'medium length',
			6: 'somewhat detailed',
			7: 'detailed',
			8: 'long and thorough',
			9: 'very long and comprehensive',
			10: 'extremely long and exhaustive',
		};
		return descriptions[this.length] ?? 'medium length';
	}

	private getFormatDescription(): string {
		const formatMap: Record<Format, string> = {
			'Single paragraph': 'a single markdown paragraph with no line breaks',
			'Paragraphs with line breaks': 'multiple markdown paragraphs separated by blank lines',
			'List': 'a markdown unordered bullet list (- items)',
			'Ordered list': 'a markdown ordered/numbered list (1. 2. 3. items)',
			'Table': 'a markdown table with header row and alignment',
			'Task list': 'a markdown task list (- [ ] items)',
			'Headings': 'markdown content organized with heading levels (# ## ###)',
			'Blockquotes': 'markdown blockquotes (> prefixed lines)',
			'Code blocks': 'markdown fenced code blocks (``` delimited)',
			'Emojis': 'text enriched with relevant emojis throughout',
			'HTML': 'raw HTML markup (not markdown)',
			'JSON': 'valid JSON (not markdown)',
		};
		return formatMap[this.format] ?? this.format;
	}

	private showResults(choices: string[], model: string, elapsed: string): void {
		// Header
		const header = this.resultsContainer.createDiv({cls: 'sidekick-edit-results-header'});
		header.createSpan({text: `🧠 ${model} | ⌚ ${elapsed}s | ${choices.length} choice${choices.length > 1 ? 's' : ''} generated`});

		// Choice cards
		const cardsContainer = this.resultsContainer.createDiv({cls: 'sidekick-edit-cards'});
		for (let i = 0; i < choices.length; i++) {
			const choice = choices[i];
			if (!choice) continue;
			this.buildChoiceCard(cardsContainer, choice, i + 1);
		}
	}

	private buildChoiceCard(parent: HTMLElement, text: string, index: number): void {
		const card = parent.createDiv({cls: 'sidekick-edit-card'});

		const cardHeader = card.createDiv({cls: 'sidekick-edit-card-header'});

		// Expand / collapse toggle (before the title)
		const expandBtn = cardHeader.createEl('button', {cls: 'clickable-icon sidekick-edit-card-btn', attr: {title: 'Expand'}});
		setIcon(expandBtn, 'maximize-2');
		expandBtn.addEventListener('click', () => {
			const expanded = card.classList.toggle('is-expanded');
			setIcon(expandBtn, expanded ? 'minimize-2' : 'maximize-2');
			expandBtn.title = expanded ? 'Collapse' : 'Expand';
		});

		cardHeader.createSpan({text: `Choice ${index}`, cls: 'sidekick-edit-card-title'});

		const actions = cardHeader.createDiv({cls: 'sidekick-edit-card-actions'});

		// Refine: copy choice text back to input and go back to form
		const refineBtn = actions.createEl('button', {cls: 'clickable-icon sidekick-edit-card-btn', attr: {title: 'Refine this choice'}});
		setIcon(refineBtn, 'pencil');
		refineBtn.addEventListener('click', () => {
			this.textArea.value = text;
			this.resultsContainer.empty();
			this.resultsContainer.style.display = 'none';
			this.textArea.focus();
		});

		const copyBtn = actions.createEl('button', {cls: 'clickable-icon sidekick-edit-card-btn', attr: {title: 'Copy to clipboard'}});
		setIcon(copyBtn, 'copy');
		copyBtn.addEventListener('click', () => {
			void navigator.clipboard.writeText(text);
			setIcon(copyBtn, 'check');
			setTimeout(() => setIcon(copyBtn, 'copy'), 1500);
			new Notice('Copied to clipboard.');
		});

		const useBtn = actions.createEl('button', {cls: 'clickable-icon sidekick-edit-card-btn sidekick-edit-card-use', attr: {title: 'Use this choice'}});
		setIcon(useBtn, 'check');
		useBtn.addEventListener('click', () => {
			this.onChoose(text);
			this.close();
		});

		const cardBody = card.createDiv({cls: 'sidekick-edit-card-body'});
		const ta = cardBody.createEl('textarea', {
			cls: 'sidekick-edit-card-text',
			attr: {readonly: '', tabindex: '-1'},
		});
		ta.value = text;
	}
}

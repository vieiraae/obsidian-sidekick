import {MarkdownView, Notice, Plugin, requestUrl} from 'obsidian';
import {DEFAULT_SETTINGS, SidekickSettings, SidekickSettingTab, SECURE_FIELDS, loadSecureField, saveSecureField} from "./settings";
import {CopilotService} from "./copilot";
import {SidekickView, SIDEKICK_VIEW_TYPE} from "./sidekickView";
import {registerEditorMenu, registerFileMenu, openSidekickView, showEditNoteModal, showStructureModal, runSelectionAction} from './editor/editorMenu';
import {buildGhostTextExtension, triggerComplete} from './editor/ghostText';
import {TelegramBotService} from './bots';
import {TASKS} from './tasks';
import {EditModal} from './modals/editModal';
import type {EditorView} from '@codemirror/view';

export default class SidekickPlugin extends Plugin {
	settings!: SidekickSettings;
	copilot: CopilotService | null = null;
	telegramBot: TelegramBotService | null = null;

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new SidekickSettingTab(this.app, this));

		// Register the Sidekick chat view
		this.registerView(SIDEKICK_VIEW_TYPE, (leaf) => new SidekickView(leaf, this));

		// Ribbon icon to open view
		this.addRibbonIcon('brain', 'Open sidekick', () => void this.activateView());

		// Command to open view
		this.addCommand({
			id: 'open-chat',
			name: 'Open chat',
			hotkeys: [{modifiers: ['Mod', 'Shift'], key: 'k'}],
			callback: () => void this.activateView(),
		});

		// Helper to get CM6 EditorView from active MarkdownView
		const getEditorView = (): EditorView | null => {
			const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (!mdView) return null;
			return (mdView as unknown as {editor?: {cm?: EditorView}}).editor?.cm ?? null;
		};

		// Command: Chat with sidekick (send selection or open chat)
		this.addCommand({
			id: 'chat-with-sidekick',
			name: 'Chat with sidekick',
			hotkeys: [{modifiers: ['Mod', 'Shift'], key: 'l'}],
			callback: () => {
				const cmView = getEditorView();
				if (cmView) {
					const sel = cmView.state.selection.main;
					if (!sel.empty) {
						const text = cmView.state.sliceDoc(sel.from, sel.to);
						const startLine = cmView.state.doc.lineAt(sel.from);
						const endLine = cmView.state.doc.lineAt(sel.to);
						const activeFile = this.app.workspace.getActiveFile();
						openSidekickView(this, text, {
							filePath: activeFile?.path,
							fileName: activeFile?.name ?? 'unknown',
							startLine: startLine.number,
							startChar: sel.from - startLine.from,
							endLine: endLine.number,
							endChar: sel.to - endLine.from,
						});
						return;
					}
				}
				openSidekickView(this);
			},
		});

		// Command: Edit the note
		this.addCommand({
			id: 'edit-note',
			name: 'Edit the note',
			hotkeys: [{modifiers: ['Mod', 'Shift'], key: 'e'}],
			editorCallback: (_editor, view) => {
				const cmView = (view as unknown as {editor?: {cm?: EditorView}}).editor?.cm;
				if (cmView) showEditNoteModal(this, cmView);
			},
		});

		// Command: Structure and refine
		this.addCommand({
			id: 'structure-and-refine',
			name: 'Structure and refine',
			editorCallback: (_editor, view) => {
				const cmView = (view as unknown as {editor?: {cm?: EditorView}}).editor?.cm;
				if (cmView) showStructureModal(this, cmView);
			},
		});

		// Command: Edit selection (advanced editing modal)
		this.addCommand({
			id: 'edit-selection',
			name: 'Edit selection',
			editorCallback: (_editor, view) => {
				const cmView = (view as unknown as {editor?: {cm?: EditorView}}).editor?.cm;
				if (!cmView) return;
				const sel = cmView.state.selection.main;
				if (sel.empty) {
					new Notice('Sidekick: select some text first.');
					return;
				}
				const selectedText = cmView.state.sliceDoc(sel.from, sel.to);
				new EditModal(this, selectedText, (result: string) => {
					const currentSel = cmView.state.selection.main;
					cmView.dispatch({changes: {from: currentSel.from, to: currentSel.to, insert: result}});
				}).open();
			},
		});

		// Text-transform commands for each task
		for (const task of TASKS) {
			this.addCommand({
				id: `text-action-${task.label.toLowerCase().replace(/\s+/g, '-')}`,
				name: task.label,
				editorCallback: (_editor, view) => {
					const cmView = (view as unknown as {editor?: {cm?: EditorView}}).editor?.cm;
					if (!cmView) return;
					const sel = cmView.state.selection.main;
					if (sel.empty) {
						new Notice('Sidekick: select some text first.');
						return;
					}
					const selectedText = cmView.state.sliceDoc(sel.from, sel.to);
					void runSelectionAction(this, cmView, selectedText, task);
				},
			});
		}

		// Command: Toggle autocomplete
		this.addCommand({
			id: 'toggle-autocomplete',
			name: 'Toggle autocomplete',
			callback: async () => {
				this.settings.autocompleteEnabled = !this.settings.autocompleteEnabled;
				await this.saveData(this.settings);
				new Notice(`Sidekick: autocomplete ${this.settings.autocompleteEnabled ? 'enabled' : 'disabled'}.`);
			},
		});

		// Command: Trigger autocomplete
		this.addCommand({
			id: 'trigger-autocomplete',
			name: 'Trigger autocomplete',
			editorCallback: (_editor, view) => {
				const cmView = (view as unknown as {editor?: {cm?: EditorView}}).editor?.cm;
				if (cmView) cmView.dispatch({effects: triggerComplete.of(null)});
			},
		});

		// Editor context menu (Sidekick submenu for selected text)
		registerEditorMenu(this);

		// Vault tree context menu (Sidekick submenu for note files)
		registerFileMenu(this);

		// Ghost-text autocomplete (inline suggestions)
		this.registerEditorExtension(buildGhostTextExtension(this));

		try {
			await this.initCopilot();
		} catch (e) {
			console.error('Sidekick: failed to initialize Copilot service', e);
		}
	}

	async initCopilot(): Promise<void> {
		if (this.copilot) {
			try {
				await this.copilot.stop();
			} catch {
				// ignore stop errors
			}
			this.copilot = null;
		}
		const s = this.settings;

		// BYOK model listing: when a non-GitHub provider is configured, fetch
		// models from the provider endpoint so client.listModels() returns them.
		const onListModels = this.buildOnListModels();

		if (s.copilotType === 'remote') {
			const url = s.cliUrl.trim();
			this.copilot = new CopilotService({
				cliUrl: url || undefined,
				githubToken: s.githubToken || undefined,
				...(onListModels ? {onListModels} : {}),
			});
		} else {
			const loc = s.copilotLocation.trim();
			this.copilot = new CopilotService({
				cliPath: loc.length > 0 ? loc : undefined,
				useLoggedInUser: s.useLoggedInUser,
				githubToken: !s.useLoggedInUser && s.githubToken ? s.githubToken : undefined,
				...(onListModels ? {onListModels} : {}),
			});
		}
	}

	/**
	 * Build an onListModels callback for BYOK providers that fetches models
	 * from the provider's endpoint. Returns undefined for GitHub preset.
	 */
	private buildOnListModels(): (() => Promise<import('./copilot').ModelInfo[]>) | undefined {
		const s = this.settings;
		if (s.providerPreset === 'github' || !s.providerBaseUrl) return undefined;

		const baseUrl = s.providerBaseUrl.replace(/\/$/, '');
		const apiKey = s.providerApiKey;
		const bearerToken = s.providerBearerToken;
		const preset = s.providerPreset;

		return async (): Promise<import('./copilot').ModelInfo[]> => {
			try {
				const headers: Record<string, string> = {'Content-Type': 'application/json'};
				if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
				else if (bearerToken) headers['Authorization'] = `Bearer ${bearerToken}`;

				// Ollama uses /api/tags, OpenAI-compatible use /v1/models
				const url = preset === 'ollama'
					? `${baseUrl}/api/tags`
					: `${baseUrl}/v1/models`;

				const resp = await requestUrl({url, headers});
				if (resp.status < 200 || resp.status >= 300) return [];
				const json = resp.json as Record<string, unknown>;

				if (preset === 'ollama') {
					// Ollama format: { models: [{ name, ... }] }
					const models = (json.models ?? []) as Array<{name: string; modified_at?: string}>;
					return models.map(m => ({
						id: m.name,
						name: m.name,
						version: m.name,
						capabilities: {supports: {vision: false, reasoningEffort: false}, limits: {max_context_window_tokens: 0}},
					})) as import('./copilot').ModelInfo[];
				}
				// OpenAI-compatible format: { data: [{ id, ... }] }
				const data = (json.data ?? []) as Array<{id: string; name?: string}>;
				return data.map(m => ({
					id: m.id,
					name: m.name ?? m.id,
					version: m.id,
					capabilities: {supports: {vision: false, reasoningEffort: false}, limits: {max_context_window_tokens: 0}},
				})) as import('./copilot').ModelInfo[];
			} catch {
				return [];
			}
		};
	}

	onunload() {
		if (this.copilot) {
			void this.copilot.stop();
		}
		if (this.telegramBot) {
			void this.telegramBot.disconnect();
		}
	}

	async connectTelegram(): Promise<void> {
		const token = this.settings.telegramBotToken;
		if (!token) throw new Error('No bot token configured.');
		if (!this.telegramBot) {
			this.telegramBot = new TelegramBotService(this);
		}
		await this.telegramBot.connect(token);
	}

	disconnectTelegram(): void {
		if (this.telegramBot) {
			this.telegramBot.disconnect();
		}
	}

	async activateView(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(SIDEKICK_VIEW_TYPE);
		if (existing.length > 0 && existing[0]) {
			void this.app.workspace.revealLeaf(existing[0]);
			return;
		}
		const leaf = this.app.workspace.getRightLeaf(false);
		if (leaf) {
			await leaf.setViewState({type: SIDEKICK_VIEW_TYPE, active: true});
			void this.app.workspace.revealLeaf(leaf);
		}
	}

	async loadSettings() {
		const raw = await this.loadData() as Partial<SidekickSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, raw);

		// Migrate any plaintext secrets from data.json to local storage, then strip
		let needsSave = false;
		for (const key of SECURE_FIELDS) {
			const plaintext = raw?.[key];
			if (plaintext && typeof plaintext === 'string') {
				// Migrate: write to local storage if not already present
				const existing = loadSecureField(this.app, key);
				if (!existing) {
					saveSecureField(this.app, key, plaintext);
				}
				needsSave = true;
			}
			// Load from secure storage into runtime settings
			(this.settings as unknown as Record<string, unknown>)[key] = loadSecureField(this.app, key);
		}

		// Strip plaintext secrets from data.json if they were present
		if (needsSave) {
			await this.saveSettings();
		}
	}

	async saveSettings() {
		// Clone settings and strip secure fields before writing to data.json
		const dataToSave = {...this.settings};
		for (const key of SECURE_FIELDS) {
			(dataToSave as Record<string, unknown>)[key] = '';
		}
		await this.saveData(dataToSave);
	}
}

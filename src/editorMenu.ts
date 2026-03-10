import {Editor, EventRef, MarkdownView, Menu, Modal, Notice, TextComponent, TFile, TFolder, normalizePath} from 'obsidian';
import type {EditorView} from '@codemirror/view';
import type SidekickPlugin from './main';
import {approveAll} from './copilot';
import type {PermissionRequest, PermissionRequestResult, UserInputRequest, UserInputResponse} from './copilot';
import {setFetching, triggerComplete} from './ghostText';
import {SIDEKICK_VIEW_TYPE, SidekickView} from './sidekickView';
import {EditModal} from './editModal';
import {TASKS, TEXT_ACTION_SYSTEM_MESSAGE} from './tasks';
import type {TextTask} from './tasks';
import type {SelectionInfo} from './types';

// Re-export for consumers that still import from editorMenu
export {TEXT_ACTION_SYSTEM_MESSAGE} from './tasks';
export type {TextTask as TextAction} from './tasks';

/**
 * Register a "Sidekick" submenu on the editor right-click context menu.
 * Shows selection-level actions when text is selected, or note-level
 * actions when nothing is selected.
 */
export function registerEditorMenu(plugin: SidekickPlugin): void {
	plugin.registerEvent(
		(plugin.app.workspace as unknown as {on: (name: string, cb: (menu: Menu, editor: Editor, view: MarkdownView) => void) => EventRef}).on('editor-menu', (menu: Menu, editor: Editor, view: MarkdownView) => {
			const cmView: EditorView | undefined = (view as unknown as {editor?: {cm?: EditorView}}).editor?.cm;
			if (!cmView) return;

			menu.addItem((item) => {
				item.setTitle('Sidekick')
					.setIcon('brain');

				const submenu: Menu = (item as unknown as {setSubmenu: () => Menu}).setSubmenu();
				buildSidekickMenu(submenu, plugin, cmView);
			});
		}),
	);
}

/**
 * Open a markdown file and resolve its CM6 EditorView.
 * Returns null if the view cannot be obtained.
 */
async function openFileAndGetView(plugin: SidekickPlugin, file: TFile): Promise<EditorView | null> {
	const leaf = plugin.app.workspace.getLeaf();
	await leaf.openFile(file);
	const view = leaf.view;
	if (view instanceof MarkdownView) {
		return (view as unknown as {editor?: {cm?: EditorView}}).editor?.cm ?? null;
	}
	return null;
}

/**
 * Register a "Sidekick" submenu on the vault file-explorer context menu.
 * Shows note-level actions for markdown files and folder-level actions for folders.
 */
export function registerFileMenu(plugin: SidekickPlugin): void {
	plugin.registerEvent(
		(plugin.app.workspace as unknown as {on: (name: string, cb: (menu: Menu, abstractFile: TFile | TFolder) => void) => EventRef}).on('file-menu', (menu: Menu, abstractFile: TFile | TFolder) => {
			if (abstractFile instanceof TFolder) {
				buildFolderMenu(menu, plugin, abstractFile);
				return;
			}
			if (!(abstractFile instanceof TFile)) return;

			// Image files
			if (IMAGE_EXTENSIONS.has(abstractFile.extension.toLowerCase())) {
				buildImageMenu(menu, plugin, abstractFile);
				return;
			}

			// Markdown files only
			if (abstractFile.extension !== 'md') return;

			menu.addItem((item) => {
				item.setTitle('Sidekick')
					.setIcon('brain');

				const submenu: Menu = (item as unknown as {setSubmenu: () => Menu}).setSubmenu();

				submenu.addItem((si) =>
					si.setTitle('Edit the note')
						.setIcon('pencil')
						.onClick(async () => {
							const cmView = await openFileAndGetView(plugin, abstractFile);
							if (cmView) showEditNoteModal(plugin, cmView);
						}),
				);
				submenu.addItem((si) =>
					si.setTitle('Structure and refine')
						.setIcon('layout-list')
						.onClick(async () => {
							const cmView = await openFileAndGetView(plugin, abstractFile);
							if (cmView) showStructureModal(plugin, cmView);
						}),
				);

				submenu.addSeparator();

				submenu.addItem((si) =>
					si.setTitle('Chat with sidekick')
						.setIcon('brain')
						.onClick(async () => {
							const leaf = plugin.app.workspace.getLeaf();
							await leaf.openFile(abstractFile);
							openSidekickView(plugin);
						}),
				);

				submenu.addSeparator();

				submenu.addItem((si) => {
					si.setTitle('Autocomplete')
						.setIcon('sparkles')
						.setChecked(plugin.settings.autocompleteEnabled);
					const acSub: Menu = (si as unknown as {setSubmenu: () => Menu}).setSubmenu();

					const autoEnabled = plugin.settings.autocompleteEnabled;
					acSub.addItem((ai) =>
						ai.setTitle(autoEnabled ? 'Disable' : 'Enable')
							.setIcon(autoEnabled ? 'toggle-right' : 'toggle-left')
							.onClick(async () => {
								plugin.settings.autocompleteEnabled = !autoEnabled;
								await plugin.saveData(plugin.settings);
								new Notice(`Sidekick: autocomplete ${plugin.settings.autocompleteEnabled ? 'enabled' : 'disabled'}.`);
							}),
					);
				});
			});
		}),
	);
}

/* ── Folder context menu ──────────────────────────────────────── */

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg']);

/** Add Sidekick submenu items for a folder in the vault tree. */
function buildFolderMenu(menu: Menu, plugin: SidekickPlugin, folder: TFolder): void {
	menu.addItem((item) => {
		item.setTitle('Sidekick')
			.setIcon('brain');

		const submenu: Menu = (item as unknown as {setSubmenu: () => Menu}).setSubmenu();

		submenu.addItem((si) =>
			si.setTitle('New note')
				.setIcon('file-plus')
				.onClick(() => showNewNoteModal(plugin, folder)),
		);
		submenu.addItem((si) =>
			si.setTitle('New canvas')
				.setIcon('layout-dashboard')
				.onClick(() => showNewCanvasModal(plugin, folder)),
		);
		submenu.addItem((si) =>
			si.setTitle('New summary note')
				.setIcon('file-text')
				.onClick(() => void createSummaryNote(plugin, folder)),
		);

		submenu.addSeparator();

		submenu.addItem((si) =>
			si.setTitle('Semantic search')
				.setIcon('search')
				.onClick(() => void openSidekickSearchWithScope(plugin, folder.path)),
		);
		submenu.addItem((si) =>
			si.setTitle('Chat with sidekick')
				.setIcon('brain')
				.onClick(() => void openSidekickViewWithScope(plugin, folder.path)),
		);
	});
}

/* ── Folder actions ─────────────────────────────────────────── */

/** Generate a unique filename in the folder, based on a stem. */
function uniqueFileName(folder: TFolder, stem: string, extension: string): string {
	const existing = new Set(
		folder.children
			.filter((c): c is TFile => c instanceof TFile && c.extension === extension)
			.map((f) => f.basename),
	);
	if (!existing.has(stem)) return stem;
	for (let i = 2; ; i++) {
		const candidate = `${stem} ${i}`;
		if (!existing.has(candidate)) return candidate;
	}
}

function uniqueNoteName(folder: TFolder, stem: string): string {
	const existing = new Set(
		folder.children
			.filter((c): c is TFile => c instanceof TFile && c.extension === 'md')
			.map((f) => f.basename),
	);
	if (!existing.has(stem)) return stem;
	for (let i = 2; ; i++) {
		const candidate = `${stem} ${i}`;
		if (!existing.has(candidate)) return candidate;
	}
}

/** Show a modal asking for an optional template type, then create a new note. */
function showNewNoteModal(plugin: SidekickPlugin, folder: TFolder): void {
	const modal = new Modal(plugin.app);
	modal.titleEl.setText('New note');

	modal.contentEl.createEl('p', {
		text: 'Optionally specify a template type for the note:',
		cls: 'sidekick-menu-modal-desc',
	});

	const tc = new TextComponent(modal.contentEl);
	tc.inputEl.classList.add('sidekick-modal-text-input');
	tc.setPlaceholder('Ex: daily notes, meeting notes, project brief');

	const btnRow = modal.contentEl.createDiv({cls: 'modal-button-container'});
	const goBtn = btnRow.createEl('button', {text: 'Create', cls: 'mod-cta'});
	const cancelBtn = btnRow.createEl('button', {text: 'Cancel'});

	goBtn.addEventListener('click', () => {
		modal.close();
		void createNewNote(plugin, folder, tc.getValue().trim());
	});
	cancelBtn.addEventListener('click', () => modal.close());

	modal.scope.register([], 'Enter', () => { goBtn.click(); return false; });

	modal.open();
	tc.inputEl.focus();
}

async function createNewNote(plugin: SidekickPlugin, folder: TFolder, templateType: string): Promise<void> {
	if (!plugin.copilot) { new Notice('Copilot is not configured.'); return; }

	const templateClause = templateType
		? `The note should follow a "${templateType}" template. `
		: '';

	const notice = new Notice('Sidekick: creating note…', 0);
	try {
		// Ask the LLM for a suggested filename and structured content
		const {content: result, sessionId} = await plugin.copilot.inlineChat({
			prompt:
				`Create a new Markdown note. ${templateClause}` +
				`Return the output in exactly this format:\n` +
				`TITLE: <short descriptive title for the note>\n` +
				`---\n` +
				`<note content in Markdown>`,
			model: plugin.settings.inlineModel || undefined,
			systemMessage:
				'You are a note creation assistant. When asked to create a note, return a title line ' +
				'followed by the separator --- and then the note body in Markdown. ' +
				'Do not include markdown code fences or extra explanations.',
		});
		registerInlineSession(plugin, sessionId, `New note in ${folder.name}`);

		if (!result) { notice.hide(); new Notice('Sidekick: no response.'); return; }

		// Parse title and content
		let title = 'New note';
		let content = result.trim();
		const sepIndex = content.indexOf('---');
		if (sepIndex !== -1) {
			const header = content.slice(0, sepIndex).trim();
			const titleMatch = header.match(/^TITLE:\s*(.+)/i);
			if (titleMatch && titleMatch[1]) {
				title = titleMatch[1].trim();
			}
			content = content.slice(sepIndex + 3).trim();
		}

		// Sanitise title for filename
		title = title.replace(/[\\/:*?"<>|]/g, '').trim() || 'New note';
		const basename = uniqueNoteName(folder, title);
		const filePath = normalizePath(`${folder.path}/${basename}.md`);

		const newFile = await plugin.app.vault.create(filePath, content);
		notice.hide();
		new Notice(`Sidekick: created "${basename}".`);

		// Open the new note
		const leaf = plugin.app.workspace.getLeaf();
		await leaf.openFile(newFile);
	} catch (e) {
		notice.hide();
		new Notice(`Sidekick: error — ${String(e)}`);
	}
}

/** Show a modal asking for an optional template type, then create a new canvas. */
function showNewCanvasModal(plugin: SidekickPlugin, folder: TFolder): void {
	const modal = new Modal(plugin.app);
	modal.titleEl.setText('New canvas');

	modal.contentEl.createEl('p', {
		text: 'Optionally specify a template type for the canvas:',
		cls: 'sidekick-menu-modal-desc',
	});

	const tc = new TextComponent(modal.contentEl);
	tc.inputEl.classList.add('sidekick-modal-text-input');
	tc.setPlaceholder('Ex: brainstorming, project plan, mind map');

	const btnRow = modal.contentEl.createDiv({cls: 'modal-button-container'});
	const goBtn = btnRow.createEl('button', {text: 'Create', cls: 'mod-cta'});
	const cancelBtn = btnRow.createEl('button', {text: 'Cancel'});

	goBtn.addEventListener('click', () => {
		modal.close();
		void createNewCanvas(plugin, folder, tc.getValue().trim());
	});
	cancelBtn.addEventListener('click', () => modal.close());

	modal.scope.register([], 'Enter', () => { goBtn.click(); return false; });

	modal.open();
	tc.inputEl.focus();
}

async function createNewCanvas(plugin: SidekickPlugin, folder: TFolder, templateType: string): Promise<void> {
	if (!plugin.copilot) { new Notice('Copilot is not configured.'); return; }

	const templateClause = templateType
		? `The canvas should follow a "${templateType}" template. `
		: '';

	const notice = new Notice('Sidekick: creating canvas\u2026', 0);
	try {
		const {content: result, sessionId} = await plugin.copilot.inlineChat({
			prompt:
				`Create an Obsidian canvas. ${templateClause}` +
				`Return the output in exactly this format:\n` +
				`TITLE: <short descriptive title for the canvas>\n` +
				`---\n` +
				`<valid Obsidian canvas JSON>`,
			model: plugin.settings.inlineModel || undefined,
			systemMessage:
				'You are a canvas creation assistant for Obsidian. When asked to create a canvas, return a title line ' +
				'followed by the separator --- and then valid Obsidian .canvas JSON.\n\n' +
				'Obsidian canvas format is a JSON object with "nodes" and "edges" arrays.\n' +
				'Each node has: id (unique string), type ("text", "group", "file", or "link"), ' +
				'x, y (number), width, height (number). Text nodes also have a "text" field (Markdown string). ' +
				'Group nodes have a "label" field. Link nodes have a "url" field.\n' +
				'Each edge has: id (unique string), fromNode, toNode (node id strings), ' +
				'fromSide, toSide ("top"|"bottom"|"left"|"right"), and optionally "label" (string).\n' +
				'Layout nodes with enough spacing (at least 50px gaps). Use reasonable sizes (width 250-400, height 100-250).\n' +
				'Do not include markdown code fences or extra explanations. Return ONLY the title and JSON.',
		});
		registerInlineSession(plugin, sessionId, `New canvas in ${folder.name}`);

		if (!result) { notice.hide(); new Notice('Sidekick: no response.'); return; }

		// Parse title and content
		let title = 'New canvas';
		let content = result.trim();
		const sepIndex = content.indexOf('---');
		if (sepIndex !== -1) {
			const header = content.slice(0, sepIndex).trim();
			const titleMatch = header.match(/^TITLE:\s*(.+)/i);
			if (titleMatch && titleMatch[1]) {
				title = titleMatch[1].trim();
			}
			content = content.slice(sepIndex + 3).trim();
		}

		// Validate that content is valid JSON with nodes array
		try {
			const parsed = JSON.parse(content);
			if (!parsed.nodes || !Array.isArray(parsed.nodes)) {
				throw new Error('Missing nodes array');
			}
			content = JSON.stringify(parsed, null, '\t');
		} catch (e) {
			notice.hide();
			new Notice(`Sidekick: invalid canvas format \u2014 ${String(e)}`);
			return;
		}

		// Sanitise title for filename
		title = title.replace(/[\\/:*?"<>|]/g, '').trim() || 'New canvas';
		const basename = uniqueFileName(folder, title, 'canvas');
		const filePath = normalizePath(`${folder.path}/${basename}.canvas`);

		const newFile = await plugin.app.vault.create(filePath, content);
		notice.hide();
		new Notice(`Sidekick: created "${basename}".`);

		// Open the new canvas
		const leaf = plugin.app.workspace.getLeaf();
		await leaf.openFile(newFile);
	} catch (e) {
		notice.hide();
		new Notice(`Sidekick: error \u2014 ${String(e)}`);
	}
}

async function createSummaryNote(plugin: SidekickPlugin, folder: TFolder): Promise<void> {
	if (!plugin.copilot) { new Notice('Copilot is not configured.'); return; }

	// Gather markdown notes in the folder
	const mdFiles = folder.children
		.filter((c): c is TFile => c instanceof TFile && c.extension === 'md')
		.sort((a, b) => a.basename.localeCompare(b.basename));

	if (mdFiles.length === 0) {
		new Notice('Sidekick: no notes found in this folder.');
		return;
	}

	const notice = new Notice('Sidekick: creating summary…', 0);
	try {
		// Read all notes (truncate each to keep within context limits)
		const MAX_PER_NOTE = 2000;
		const noteContents: string[] = [];
		for (const f of mdFiles) {
			let text = await plugin.app.vault.cachedRead(f);
			if (text.length > MAX_PER_NOTE) text = text.slice(0, MAX_PER_NOTE) + '\n…(truncated)';
			noteContents.push(`## ${f.basename}\n${text}`);
		}

		const combined = noteContents.join('\n\n---\n\n');

		const {content: result, sessionId} = await plugin.copilot.inlineChat({
			prompt:
				`Summarize the following ${mdFiles.length} notes from the folder "${folder.name}". ` +
				`Produce a single cohesive summary note in Markdown that captures the key topics, ` +
				`themes, and important details across all notes.\n\n${combined}`,
			model: plugin.settings.inlineModel || undefined,
			systemMessage:
				'You are a note summarisation assistant. Return ONLY the summary note in Markdown. ' +
				'Do not include markdown code fences, introductory text, or explanations.',
		});
		registerInlineSession(plugin, sessionId, `Summary of ${folder.name}`);

		if (!result) { notice.hide(); new Notice('Sidekick: no response.'); return; }

		const basename = uniqueNoteName(folder, `${folder.name} — Summary`);
		const filePath = normalizePath(`${folder.path}/${basename}.md`);

		const newFile = await plugin.app.vault.create(filePath, result.trim());
		notice.hide();
		new Notice(`Sidekick: created "${basename}".`);

		const leaf = plugin.app.workspace.getLeaf();
		await leaf.openFile(newFile);
	} catch (e) {
		notice.hide();
		new Notice(`Sidekick: error — ${String(e)}`);
	}
}

/**
 * Run a text action on selected text in a CM6 EditorView directly.
 * Used by both the gutter indicator menu and the context menu.
 */
export async function runSelectionAction(
	plugin: SidekickPlugin,
	view: EditorView,
	selectedText: string,
	action: TextTask,
): Promise<void> {
	if (!plugin.copilot) {
		new Notice('Copilot is not configured.');
		return;
	}

	const notice = new Notice(`Sidekick: ${action.label}…`, 0);
	try { view.dispatch({effects: setFetching.of(true)}); } catch { /* ignore */ }

	try {
		const result = await runActionPrompt(plugin, action, selectedText);

		if (!result) {
			notice.hide();
			new Notice('Sidekick: no response received.');
			return;
		}

		// Replace the selection in the CM6 view
		const sel = view.state.selection.main;
		view.dispatch({
			changes: {from: sel.from, to: sel.to, insert: result.trim()},
		});
		notice.hide();
		new Notice(`Sidekick: ${action.label} — done.`);
	} catch (e) {
		notice.hide();
		console.error('Sidekick: editor action error', e);
		new Notice(`Sidekick: error — ${String(e)}`);
	} finally {
		try { view.dispatch({effects: setFetching.of(false)}); } catch { /* view destroyed */ }
	}
}

/**
 * Core helper: send the action prompt to Copilot and return the result.
 */
async function runActionPrompt(
	plugin: SidekickPlugin,
	action: TextTask,
	selectedText: string,
): Promise<string | null> {
	if (!plugin.copilot) return null;

	// Build permission handler that respects the plugin's toolApproval setting
	const permissionHandler = (request: PermissionRequest) => {
			if (plugin.settings.toolApproval === 'allow') {
				return approveAll(request, {sessionId: ''});
			}
			// For 'ask' mode, show a simple confirmation modal
			return new Promise<PermissionRequestResult>((resolve) => {
				const modal = new Modal(plugin.app);
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
			const modal = new Modal(plugin.app);
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

	const {content: result, sessionId} = await plugin.copilot.inlineChat({
		prompt: action.prompt(selectedText),
		model: plugin.settings.inlineModel || undefined,
		systemMessage: TEXT_ACTION_SYSTEM_MESSAGE,
		onPermissionRequest: permissionHandler,
		onUserInputRequest: userInputHandler,
	});
	registerInlineSession(plugin, sessionId, action.label);

	return result ?? null;
}

/* ── Image context menu ───────────────────────────────────────── */

/** Add Sidekick submenu items for an image file in the vault tree. */
function buildImageMenu(menu: Menu, plugin: SidekickPlugin, file: TFile): void {
	menu.addItem((item) => {
		item.setTitle('Sidekick')
			.setIcon('brain');

		const submenu: Menu = (item as unknown as {setSubmenu: () => Menu}).setSubmenu();

		submenu.addItem((si) =>
			si.setTitle('Insert extracted content below')
				.setIcon('arrow-down-to-line')
				.onClick(() => void extractAndInsertBelow(plugin, file)),
		);
		submenu.addItem((si) =>
			si.setTitle('Replace with extracted content')
				.setIcon('replace')
				.onClick(() => void extractAndReplace(plugin, file)),
		);
	});
}

/** Get the absolute OS path for a vault file. */
function getAbsolutePath(plugin: SidekickPlugin, file: TFile): string {
	const basePath = (plugin.app.vault.adapter as unknown as {basePath: string}).basePath;
	return basePath + '/' + file.path;
}

/** Extract content from an image by sending it to the LLM. */
async function extractImageContent(plugin: SidekickPlugin, file: TFile): Promise<string | null> {
	if (!plugin.copilot) { new Notice('Copilot is not configured.'); return null; }

	const absPath = getAbsolutePath(plugin, file);

	const {content: result, sessionId} = await plugin.copilot.inlineChat({
		prompt:
			`Extract all visible content from this image and convert it to well-structured Markdown. ` +
			`Include text, tables, lists, diagrams descriptions, and any other meaningful content. ` +
			`If the image contains a diagram or chart, describe it in detail.`,
		model: plugin.settings.inlineModel || undefined,
		systemMessage:
			'You are an image content extraction assistant. Extract all visible content from the provided image ' +
			'and return it as clean Markdown. Do not include markdown code fences, introductory text, or explanations. ' +
			'Return only the extracted content.',
		attachments: [{type: 'file', path: absPath, displayName: file.name}],
	});
	registerInlineSession(plugin, sessionId, `Extract ${file.name}`);

	return result?.trim() ?? null;
}

/**
 * Find the image embed reference in the active note's EditorView.
 * Searches for `![[filename]]` and `![...](path)` patterns.
 * Returns {from, to} of the full embed match, or null.
 */
function findImageEmbed(view: EditorView, file: TFile): {from: number; to: number} | null {
	const doc = view.state.doc.toString();

	// Try wikilink: ![[filename]] or ![[path/filename]]
	const wikiPatterns = [
		`![[${file.path}]]`,
		`![[${file.name}]]`,
		`![[${file.basename}]]`,
	];
	for (const pattern of wikiPatterns) {
		const idx = doc.indexOf(pattern);
		if (idx !== -1) return {from: idx, to: idx + pattern.length};
	}

	// Try wikilink with alt text: ![[filename|alt]]
	const wikiAltRegex = new RegExp(
		`!\\[\\[(?:${escapeRegex(file.path)}|${escapeRegex(file.name)}|${escapeRegex(file.basename)})\\|[^\\]]*\\]\\]`
	);
	const wikiAltMatch = wikiAltRegex.exec(doc);
	if (wikiAltMatch) return {from: wikiAltMatch.index, to: wikiAltMatch.index + wikiAltMatch[0].length};

	// Try standard markdown: ![alt](path)
	const mdRegex = new RegExp(
		`!\\[[^\\]]*\\]\\((?:${escapeRegex(file.path)}|${escapeRegex(file.name)})\\)`
	);
	const mdMatch = mdRegex.exec(doc);
	if (mdMatch) return {from: mdMatch.index, to: mdMatch.index + mdMatch[0].length};

	return null;
}

/** Escape special regex characters in a string. */
function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Extract image content and insert it below the embed in the active note. */
async function extractAndInsertBelow(plugin: SidekickPlugin, file: TFile): Promise<void> {
	const activeView = plugin.app.workspace.getActiveViewOfType(MarkdownView);
	if (!activeView) {
		new Notice('Sidekick: open a note that contains this image first.');
		return;
	}
	const cmView: EditorView | undefined = (activeView as unknown as {editor?: {cm?: EditorView}}).editor?.cm;
	if (!cmView) return;

	const embed = findImageEmbed(cmView, file);
	if (!embed) {
		new Notice(`Sidekick: could not find a reference to "${file.name}" in the active note.`);
		return;
	}

	const notice = new Notice('Sidekick: extracting image content…', 0);
	try {
		const content = await extractImageContent(plugin, file);
		if (!content) { notice.hide(); new Notice('Sidekick: no content extracted.'); return; }

		// Insert after the embed line
		const line = cmView.state.doc.lineAt(embed.to);
		const insertPos = line.to;
		cmView.dispatch({
			changes: {from: insertPos, insert: '\n\n' + content},
		});
		notice.hide();
		new Notice('Sidekick: extracted content inserted.');
	} catch (e) {
		notice.hide();
		new Notice(`Sidekick: error — ${String(e)}`);
	}
}

/** Extract image content and replace the embed in the active note. */
async function extractAndReplace(plugin: SidekickPlugin, file: TFile): Promise<void> {
	const activeView = plugin.app.workspace.getActiveViewOfType(MarkdownView);
	if (!activeView) {
		new Notice('Sidekick: open a note that contains this image first.');
		return;
	}
	const cmView: EditorView | undefined = (activeView as unknown as {editor?: {cm?: EditorView}}).editor?.cm;
	if (!cmView) return;

	const embed = findImageEmbed(cmView, file);
	if (!embed) {
		new Notice(`Sidekick: could not find a reference to "${file.name}" in the active note.`);
		return;
	}

	const notice = new Notice('Sidekick: extracting image content…', 0);
	try {
		const content = await extractImageContent(plugin, file);
		if (!content) { notice.hide(); new Notice('Sidekick: no content extracted.'); return; }

		cmView.dispatch({
			changes: {from: embed.from, to: embed.to, insert: content},
		});
		notice.hide();
		new Notice('Sidekick: image replaced with extracted content.');
	} catch (e) {
		notice.hide();
		new Notice(`Sidekick: error — ${String(e)}`);
	}
}

/* ── Note-level actions ───────────────────────────────────────── */

/** "Edit the note" — user enters a free-form editing prompt. */
export function showEditNoteModal(plugin: SidekickPlugin, view: EditorView): void {
	const modal = new Modal(plugin.app);
	modal.titleEl.setText('Edit the note');

	modal.contentEl.createEl('p', {
		text: 'Describe how the note should be edited:',
		cls: 'sidekick-menu-modal-desc',
	});

	const tc = new TextComponent(modal.contentEl);
	tc.inputEl.classList.add('sidekick-modal-text-input');
	tc.setPlaceholder('Ex: convert bullet points to a table');

	const btnRow = modal.contentEl.createDiv({cls: 'modal-button-container'});
	const goBtn = btnRow.createEl('button', {text: 'Apply', cls: 'mod-cta'});
	const cancelBtn = btnRow.createEl('button', {text: 'Cancel'});

	goBtn.addEventListener('click', () => {
		const prompt = tc.getValue().trim();
		if (!prompt) { new Notice('Please enter a prompt.'); return; }
		modal.close();
		void applyEditNote(plugin, view, prompt);
	});
	cancelBtn.addEventListener('click', () => modal.close());

	modal.scope.register([], 'Enter', () => { goBtn.click(); return false; });

	modal.open();
	tc.inputEl.focus();
}

async function applyEditNote(plugin: SidekickPlugin, view: EditorView, userPrompt: string): Promise<void> {
	if (!plugin.copilot) { new Notice('Copilot is not configured.'); return; }
	const doc = view.state.doc.toString();
	const notice = new Notice('Sidekick: editing note…', 0);
	view.dispatch({effects: setFetching.of(true)});
	try {
		const {content: result, sessionId} = await plugin.copilot.inlineChat({
			prompt:
				`Apply the following edit instruction to the note and return the FULL updated note.\n\n` +
				`INSTRUCTION:\n${userPrompt}\n\nNOTE:\n${doc}`,
			model: plugin.settings.inlineModel || undefined,
			systemMessage:
				'You are a note editor. When given a note and an edit instruction, return ONLY the updated note content. ' +
				'Do not include explanations, markdown code fences, or introductory text. Return the full note.',
		});
		registerInlineSession(plugin, sessionId, `Edit: ${userPrompt.slice(0, 30)}`);
		if (!result) { notice.hide(); new Notice('Sidekick: no response.'); return; }
		view.dispatch({changes: {from: 0, to: view.state.doc.length, insert: result.trim()}});
		notice.hide();
		new Notice('Sidekick: note edited.');
	} catch (e) {
		notice.hide();
		new Notice(`Sidekick: error — ${String(e)}`);
	} finally {
		try { view.dispatch({effects: setFetching.of(false)}); } catch { /* view destroyed */ }
	}
}

/** "Structure and refine" — restructures the note with optional template type. */
export function showStructureModal(plugin: SidekickPlugin, view: EditorView): void {
	const modal = new Modal(plugin.app);
	modal.titleEl.setText('Structure and refine');

	modal.contentEl.createEl('p', {
		text: 'The note will be restructured using Markdown and refined for clarity.',
		cls: 'sidekick-menu-modal-desc',
	});

	modal.contentEl.createEl('label', {text: 'Template type (optional):', cls: 'sidekick-modal-label'});

	const tc = new TextComponent(modal.contentEl);
	tc.inputEl.classList.add('sidekick-modal-text-input');
	tc.setPlaceholder('Ex: daily notes, meeting notes, project brief');

	const btnRow = modal.contentEl.createDiv({cls: 'modal-button-container'});
	const goBtn = btnRow.createEl('button', {text: 'Structure', cls: 'mod-cta'});
	const cancelBtn = btnRow.createEl('button', {text: 'Cancel'});

	goBtn.addEventListener('click', () => {
		modal.close();
		void applyStructure(plugin, view, tc.getValue().trim());
	});
	cancelBtn.addEventListener('click', () => modal.close());

	modal.scope.register([], 'Enter', () => { goBtn.click(); return false; });

	modal.open();
}

async function applyStructure(plugin: SidekickPlugin, view: EditorView, templateType: string): Promise<void> {
	if (!plugin.copilot) { new Notice('Copilot is not configured.'); return; }
	const doc = view.state.doc.toString();
	const notice = new Notice('Sidekick: structuring note…', 0);
	view.dispatch({effects: setFetching.of(true)});

	const templateClause = templateType
		? `Structure the note as a "${templateType}" template. `
		: '';

	try {
		const {content: result, sessionId} = await plugin.copilot.inlineChat({
			prompt:
				`Structure and refine the following note using Markdown. ${templateClause}` +
				`Organise the content with headings, lists, and emphasis where appropriate. ` +
				`Improve clarity and readability while preserving all original information.\n\nNOTE:\n${doc}`,
			model: plugin.settings.inlineModel || undefined,
			systemMessage:
				'You are a note structuring assistant. Return ONLY the restructured note in Markdown. ' +
				'Do not include explanations, markdown code fences, or introductory text. Return the full note.',
		});
		registerInlineSession(plugin, sessionId, 'Structure and refine');
		if (!result) { notice.hide(); new Notice('Sidekick: no response.'); return; }
		view.dispatch({changes: {from: 0, to: view.state.doc.length, insert: result.trim()}});
		notice.hide();
		new Notice('Sidekick: note structured.');
	} catch (e) {
		notice.hide();
		new Notice(`Sidekick: error — ${String(e)}`);
	} finally {
		try { view.dispatch({effects: setFetching.of(false)}); } catch { /* view destroyed */ }
	}
}

/**
 * Register an inline session in the SidekickView session list.
 * Stores the session name with an [inline] prefix so the sidebar
 * filter can distinguish inline sessions from chat sessions.
 */
function registerInlineSession(plugin: SidekickPlugin, sessionId: string, description: string): void {
	const leaves = plugin.app.workspace.getLeavesOfType(SIDEKICK_VIEW_TYPE);
	if (leaves.length > 0 && leaves[0]) {
		const view = leaves[0].view as SidekickView;
		view.registerInlineSession(sessionId, description);
	}
}

export {type SelectionInfo} from './types';

/** "Chat with Sidekick" — open the sidebar view, optionally with prompt text and selection. */
export function openSidekickView(plugin: SidekickPlugin, promptText?: string, selection?: SelectionInfo): void {
	void (async () => {
		await plugin.activateView();
		if (promptText || selection) {
			const leaves = plugin.app.workspace.getLeavesOfType(SIDEKICK_VIEW_TYPE);
			if (leaves.length > 0 && leaves[0]) {
				const view = leaves[0].view as SidekickView;
				if (promptText) view.setPromptText(promptText);
				if (selection) view.addSelectionAttachment(promptText ?? '', selection);
			}
		}
	})();
}

/** Open the Sidekick chat view with a specific folder set as scope. */
async function openSidekickViewWithScope(plugin: SidekickPlugin, folderPath: string): Promise<void> {
	await plugin.activateView();
	const leaves = plugin.app.workspace.getLeavesOfType(SIDEKICK_VIEW_TYPE);
	if (leaves.length > 0 && leaves[0]) {
		const view = leaves[0].view as SidekickView;
		view.setScope([folderPath]);
		view.setWorkingDir(folderPath);
	}
}

/** Open the Sidekick search tab scoped to a specific folder. */
async function openSidekickSearchWithScope(plugin: SidekickPlugin, folderPath: string): Promise<void> {
	await plugin.activateView();
	const leaves = plugin.app.workspace.getLeavesOfType(SIDEKICK_VIEW_TYPE);
	if (leaves.length > 0 && leaves[0]) {
		const view = leaves[0].view as SidekickView;
		view.openSearchWithScope(folderPath);
	}
}

/**
 * Populate a menu with Sidekick actions. Used by both the context menu
 * and the gutter brain-button to keep behaviour consistent.
 *
 * @param menu      The Obsidian Menu (or submenu) to populate.
 * @param plugin    The Sidekick plugin instance.
 * @param view      The CM6 EditorView.
 */
export function buildSidekickMenu(menu: Menu, plugin: SidekickPlugin, view: EditorView): void {
	const sel = view.state.selection.main;
	const hasSelection = !sel.empty;

	if (hasSelection) {
		// ── Selection: text-transform actions ──
		const selectedText = view.state.sliceDoc(sel.from, sel.to);

		// Edit — advanced editing with tone, length, choices
		menu.addItem((item) =>
			item.setTitle('Edit')
				.setIcon('pencil-line')
				.onClick(() => {
					new EditModal(plugin, selectedText, (result) => {
						const currentSel = view.state.selection.main;
						view.dispatch({
							changes: {from: currentSel.from, to: currentSel.to, insert: result},
						});
					}).open();
				}),
		);
		menu.addSeparator();

		for (const action of TASKS) {
			menu.addItem((item) =>
				item.setTitle(action.label)
					.setIcon(action.icon)
					.onClick(() => void runSelectionAction(plugin, view, selectedText, action)),
			);
		}
	} else {
		// ── No selection: note-level actions ──
		menu.addItem((item) =>
			item.setTitle('Edit the note')
				.setIcon('pencil')
				.onClick(() => showEditNoteModal(plugin, view)),
		);
		menu.addItem((item) =>
			item.setTitle('Structure and refine')
				.setIcon('layout-list')
				.onClick(() => showStructureModal(plugin, view)),
		);
	}

	menu.addSeparator();

	menu.addItem((item) =>
		item.setTitle('Chat with sidekick')
			.setIcon('brain')
			.onClick(() => {
				if (hasSelection) {
					const text = view.state.sliceDoc(sel.from, sel.to);
					const startLine = view.state.doc.lineAt(sel.from);
					const endLine = view.state.doc.lineAt(sel.to);
					const activeFile = plugin.app.workspace.getActiveFile();
					const filePath = activeFile?.path;
					const fileName = activeFile?.name ?? 'unknown';
					openSidekickView(plugin, text, {
						filePath,
						fileName,
						startLine: startLine.number,
						startChar: sel.from - startLine.from,
						endLine: endLine.number,
						endChar: sel.to - endLine.from,
					});
				} else {
					openSidekickView(plugin);
				}
			}),
	);

	// ── Autocomplete submenu ──
	menu.addSeparator();
	menu.addItem((item) => {
		item.setTitle('Autocomplete')
			.setIcon('sparkles')
			.setChecked(plugin.settings.autocompleteEnabled);
		const sub: Menu = (item as unknown as {setSubmenu: () => Menu}).setSubmenu();

		const autoEnabled = plugin.settings.autocompleteEnabled;
		sub.addItem((si) =>
			si.setTitle(autoEnabled ? 'Disable' : 'Enable')
				.setIcon(autoEnabled ? 'toggle-right' : 'toggle-left')
				.onClick(async () => {
					plugin.settings.autocompleteEnabled = !autoEnabled;
					await plugin.saveData(plugin.settings);
					new Notice(`Sidekick: autocomplete ${plugin.settings.autocompleteEnabled ? 'enabled' : 'disabled'}.`);
				}),
		);
		sub.addItem((si) =>
			si.setTitle('Start')
				.setIcon('play')
				.onClick(() => {
					view.dispatch({effects: triggerComplete.of(null)});
				}),
		);
	});
}

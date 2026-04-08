import {MarkdownView, Menu, Notice, TFile, TFolder, setIcon} from 'obsidian';
import type {SidekickView} from '../sidekickView';
import type {PromptConfig, SelectionInfo} from '../types';
import {VaultScopeModal} from '../modals/vaultScopeModal';

declare module '../sidekickView' {
	interface SidekickView {
		buildInputArea(parent: HTMLElement): void;
		handleAttachFile(): void;
		handleClipboard(): Promise<void>;
		handleImagePaste(blob: File): Promise<void>;
		handleFileDrop(e: DragEvent): void;

		renderAttachments(): void;
		renderScopeBar(): void;
		renderActiveNoteBar(): void;
		updateActiveNote(): void;
		startSelectionPolling(): void;
		pollSelection(): void;
		openScopeModal(): void;
		handlePromptTrigger(): void;
		showPromptDropdown(prompts: PromptConfig[]): void;
		closePromptDropdown(): void;
		navigatePromptDropdown(direction: number): void;
		updatePromptDropdownSelection(): void;
		selectPromptFromDropdown(): void;
		setScope(paths: string[]): void;
		openSearchWithScope(folderPath: string): void;
		setWorkingDir(folderPath: string): void;
		setPromptText(text: string): void;
		addSelectionAttachment(text: string, info: SelectionInfo): void;
	}
}

export function installInputArea(ViewClass: {prototype: unknown}): void {
	const proto = ViewClass.prototype as SidekickView;

	proto.buildInputArea = function (parent: HTMLElement): void {
		const inputArea = parent.createDiv({cls: 'sidekick-input-area'});

		// Attach buttons row above textarea
		const inputActions = inputArea.createDiv({cls: 'sidekick-input-actions'});

		const scopeBtn = inputActions.createEl('button', {cls: 'clickable-icon sidekick-icon-btn', attr: {title: 'Select vault scope'}});
		setIcon(scopeBtn, 'folder');
		scopeBtn.addEventListener('click', () => this.openScopeModal());

		const attachBtn = inputActions.createEl('button', {cls: 'clickable-icon sidekick-icon-btn', attr: {title: 'Attach file'}});
		setIcon(attachBtn, 'paperclip');
		attachBtn.addEventListener('click', () => this.handleAttachFile());

		const clipBtn = inputActions.createEl('button', {cls: 'clickable-icon sidekick-icon-btn', attr: {title: 'Paste clipboard'}});
		setIcon(clipBtn, 'clipboard-paste');
		clipBtn.addEventListener('click', () => void this.handleClipboard());

		// Attachments, active note & scope (shown inline after action buttons)
		this.attachmentsBar = inputActions.createDiv({cls: 'sidekick-attachments-bar'});
		this.activeNoteBar = inputActions.createDiv({cls: 'sidekick-active-note-bar'});
		this.scopeBar = inputActions.createDiv({cls: 'sidekick-scope-bar'});

		// Row for textarea + send button
		const inputRow = inputArea.createDiv({cls: 'sidekick-input-row'});

		this.inputEl = inputRow.createEl('textarea', {
			cls: 'sidekick-input',
			attr: {placeholder: 'Ask or paste something to work on...', rows: '1'},
		});

		// Auto-resize
		this.inputEl.addEventListener('input', () => {
			this.inputEl.setCssProps({'--input-height': 'auto'});
			this.inputEl.setCssProps({'--input-height': Math.min(this.inputEl.scrollHeight, 200) + 'px'});
			this.handlePromptTrigger();
		});

		// Ctrl+Enter or Enter (without Shift) to send
		// Register on window in capture phase — earliest interception before Obsidian's hotkey system
		const keyHandler = (e: KeyboardEvent) => {
			if (document.activeElement !== this.inputEl) return;

			// Handle prompt dropdown navigation
			if (this.promptDropdown) {
				if (e.key === 'ArrowDown') {
					e.preventDefault();
					e.stopPropagation();
					this.navigatePromptDropdown(1);
					return;
				}
				if (e.key === 'ArrowUp') {
					e.preventDefault();
					e.stopPropagation();
					this.navigatePromptDropdown(-1);
					return;
				}
				if (e.key === 'Enter' || e.key === 'Tab') {
					e.preventDefault();
					e.stopPropagation();
					e.stopImmediatePropagation();
					this.selectPromptFromDropdown();
					return;
				}
				if (e.key === 'Escape') {
					e.preventDefault();
					this.closePromptDropdown();
					return;
				}
			}

			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				e.stopPropagation();
				e.stopImmediatePropagation();
				void this.handleSend();
			}
		};
		window.addEventListener('keydown', keyHandler, true);
		this.register(() => window.removeEventListener('keydown', keyHandler, true));

		// Paste handler for images
		this.inputEl.addEventListener('paste', (e: ClipboardEvent) => {
			const items = e.clipboardData?.items;
			if (!items) return;
			for (let i = 0; i < items.length; i++) {
				const item = items[i];
				if (item && item.type.startsWith('image/')) {
					e.preventDefault();
					const blob = item.getAsFile();
					if (blob) void this.handleImagePaste(blob);
					return;
				}
			}
		});

		// Drag-and-drop external files onto the input area
		let dragCounter = 0;
		inputArea.addEventListener('dragenter', (e: DragEvent) => {
			e.preventDefault();
			dragCounter++;
			inputArea.addClass('sidekick-drag-over');
		});
		inputArea.addEventListener('dragover', (e: DragEvent) => {
			e.preventDefault();
			if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
		});
		inputArea.addEventListener('dragleave', () => {
			dragCounter--;
			if (dragCounter <= 0) {
				dragCounter = 0;
				inputArea.removeClass('sidekick-drag-over');
			}
		});
		inputArea.addEventListener('drop', (e: DragEvent) => {
			e.preventDefault();
			dragCounter = 0;
			inputArea.removeClass('sidekick-drag-over');
			this.handleFileDrop(e);
		});

		// Edit button (opens Edit modal with chat input text)
		const editBtn = inputRow.createEl('button', {cls: 'clickable-icon sidekick-icon-btn', attr: {title: 'Edit text'}});
		setIcon(editBtn, 'pencil-line');
		editBtn.addEventListener('click', () => this.openEditFromChat());

		// Send / Stop button
		this.sendBtn = inputRow.createEl('button', {
			cls: 'clickable-icon sidekick-send-btn',
			attr: {title: 'Send message'},
		});
		setIcon(this.sendBtn, 'arrow-up');
		this.sendBtn.addEventListener('click', () => {
			if (this.isStreaming) {
				void this.handleAbort();
			} else {
				void this.handleSend();
			}
		});
	};

	proto.handleAttachFile = function (): void {
		const input = document.createElement('input');
		input.type = 'file';
		input.multiple = true;
		input.classList.add('sidekick-file-input-hidden');
		document.body.appendChild(input);

		input.addEventListener('change', () => {
			if (!input.files) { input.remove(); return; }

			// Resolve absolute OS path: prefer Electron webUtils, fallback to File.path
			let getPath: (f: File) => string;
			try {
				const {webUtils} = globalThis.require('electron') as {webUtils?: {getPathForFile: (f: File) => string}};
				if (webUtils?.getPathForFile) {
					getPath = (f: File) => webUtils.getPathForFile(f);
				} else {
					getPath = (f: File) => (f as unknown as {path: string}).path || '';
				}
			} catch {
				getPath = (f: File) => (f as unknown as {path: string}).path || '';
			}

			for (let i = 0; i < input.files.length; i++) {
				const file = input.files[i];
				if (!file) continue;
				const filePath = getPath(file);
				if (!filePath) {
					continue;
				}
				this.attachments.push({type: 'file', name: file.name, path: filePath, absolutePath: true});
			}
			this.renderAttachments();
			input.remove();
		});

		input.addEventListener('cancel', () => input.remove());
		input.click();
	};

	proto.handleClipboard = async function (): Promise<void> {
		try {
			const text = await navigator.clipboard.readText();
			if (!text.trim()) {
				new Notice('Clipboard is empty.');
				return;
			}
			const preview = text.length > 40 ? text.slice(0, 40) + '…' : text;
			this.attachments.push({type: 'clipboard', name: `Clipboard: ${preview}`, content: text});
			this.renderAttachments();
		} catch (e) {
			new Notice(`Failed to read clipboard: ${String(e)}`);
		}
	};

	proto.handleImagePaste = async function (blob: File): Promise<void> {
		try {
			const buffer = await blob.arrayBuffer();
			const bytes = new Uint8Array(buffer);
			let binary = '';
			for (let i = 0; i < bytes.length; i++) {
				binary += String.fromCharCode(bytes[i]!);
			}
			const base64 = btoa(binary);
			const mimeType = blob.type || 'image/png';
			const ext = mimeType === 'image/png' ? 'png' : mimeType === 'image/jpeg' ? 'jpg' : 'png';
			const name = `paste-${Date.now()}.${ext}`;

			this.attachments.push({type: 'blob', name, data: base64, mimeType});
			this.renderAttachments();
			new Notice('Image attached.');
		} catch (e) {
			new Notice(`Failed to attach image: ${String(e)}`);
		}
	};

	/** Handle files dropped onto the input area from the OS or vault tree. */
	proto.handleFileDrop = function (e: DragEvent): void {
		const dt = e.dataTransfer;
		if (!dt) return;

		// ── Obsidian vault drag (file explorer) ──────────────────
		// Obsidian's file tree uses its internal dragManager rather than
		// standard HTML5 dataTransfer text.  The draggable object has
		// { type: 'file'|'folder'|'files', file?: TAbstractFile, files?: TAbstractFile[] }.
		const dragManager = (this.app as unknown as {dragManager?: {draggable?: {type: string; file?: unknown; files?: unknown[]}}}).dragManager;
		const draggable = dragManager?.draggable as {type: string; file?: TFile | TFolder; files?: (TFile | TFolder)[]} | undefined;

		if (draggable) {
			const items: (TFile | TFolder)[] = [];
			if ((draggable.type === 'file' || draggable.type === 'folder') && draggable.file) {
				items.push(draggable.file);
			} else if (draggable.type === 'files' && draggable.files) {
				items.push(...draggable.files);
			}

			if (items.length > 0) {
				for (const item of items) {
					if (item instanceof TFolder) {
						this.setScope([item.path]);
						this.setWorkingDir(item.path);
						new Notice(`Scope and working directory set to "${item.path}".`);
					} else if (item instanceof TFile) {
						this.attachments.push({type: 'file', name: item.name, path: item.path});
						this.renderAttachments();
						new Notice(`"${item.name}" attached.`);
					}
				}
				return;
			}
		}

		// ── Plain text drag (e.g. selected text from editor or browser) ──
		if (dt.files.length === 0) {
			const text = dt.getData('text/plain');
			if (text) {
				this.inputEl.value = text;
				this.inputEl.setCssProps({'--input-height': 'auto'});
				this.inputEl.setCssProps({'--input-height': Math.min(this.inputEl.scrollHeight, 200) + 'px'});
				this.inputEl.focus();
				return;
			}
		}

		// ── External OS file drag ────────────────────────────────
		const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg']);

		// Resolve absolute OS path using Electron webUtils, same as handleAttachFile
		let getPath: (f: File) => string;
		try {
			const {webUtils} = globalThis.require('electron') as {webUtils?: {getPathForFile: (f: File) => string}};
			if (webUtils?.getPathForFile) {
				getPath = (f: File) => webUtils.getPathForFile(f);
			} else {
				getPath = (f: File) => (f as unknown as {path: string}).path || '';
			}
		} catch {
			getPath = (f: File) => (f as unknown as {path: string}).path || '';
		}

		let attached = 0;
		for (let i = 0; i < dt.files.length; i++) {
			const file = dt.files[i];
			if (!file) continue;
			const filePath = getPath(file);
			if (!filePath) continue;

			const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
			if (IMAGE_EXTS.has(ext)) {
				// Save image to vault attachment folder, same as paste
				void this.handleImagePaste(file);
			} else {
				this.attachments.push({type: 'file', name: file.name, path: filePath, absolutePath: true});
			}
			attached++;
		}

		if (attached > 0) {
			this.renderAttachments();
			new Notice(`${attached} file${attached > 1 ? 's' : ''} attached.`);
		}
	};

	proto.renderAttachments = function (): void {
		this.attachmentsBar.empty();
		if (this.attachments.length === 0) {
			this.attachmentsBar.addClass('is-hidden');
			return;
		}
		this.attachmentsBar.removeClass('is-hidden');

		for (let i = 0; i < this.attachments.length; i++) {
			const att = this.attachments[i];
			if (!att) continue;
			const tag = this.attachmentsBar.createDiv({cls: 'sidekick-attachment-tag'});
			const typeIcon = att.type === 'image' ? 'image' : att.type === 'clipboard' ? 'clipboard' : att.type === 'selection' ? 'text-cursor-input' : 'file-text';
			const ic = tag.createSpan({cls: 'sidekick-attachment-icon'});
			setIcon(ic, typeIcon);
			tag.createSpan({text: att.name, cls: 'sidekick-attachment-name'});
			const removeBtn = tag.createSpan({cls: 'sidekick-attachment-remove'});
			setIcon(removeBtn, 'x');
			const idx = i;
			removeBtn.addEventListener('click', () => {
				this.attachments.splice(idx, 1);
				this.renderAttachments();
				this.renderActiveNoteBar();
			});
		}
	};

	proto.renderScopeBar = function (): void {
		this.scopeBar.empty();
		if (this.scopePaths.length === 0) {
			this.scopeBar.addClass('is-hidden');
			return;
		}
		this.scopeBar.removeClass('is-hidden');

		const label = this.scopeBar.createSpan({cls: 'sidekick-scope-label'});
		setIcon(label, 'folder-tree');
		const isEntireVault = this.scopePaths.length === 1 && this.scopePaths[0] === '/';
		const scopeText = isEntireVault
			? ' Entire vault scope'
			: ` ${this.scopePaths.length} item(s) in scope`;
		label.appendText(scopeText);

		const tooltipItems = this.scopePaths.map(p => p === '/' ? this.app.vault.getName() : p).join('\n');
		label.setAttribute('title', tooltipItems);
		label.addEventListener('click', (e) => {
			const menu = new Menu();
			for (const p of this.scopePaths) {
				const display = p === '/' ? this.app.vault.getName() : p;
				menu.addItem(item => item.setTitle(display).setDisabled(true));
			}
			menu.showAtMouseEvent(e);
		});

		const removeBtn = this.scopeBar.createSpan({cls: 'sidekick-scope-remove'});
		setIcon(removeBtn, 'x');
		removeBtn.addEventListener('click', () => {
			this.scopePaths = [];
			this.renderScopeBar();
		});
	};

	proto.updateActiveNote = function (): void {
		const file = this.app.workspace.getActiveFile();
		this.activeNotePath = file ? file.path : null;
		// Clear selection when switching files — pollSelection will pick up the new one
		this.activeSelection = null;
		this.renderActiveNoteBar();

		// Update working directory to the parent folder of the active note
		if (file) {
			const lastSlash = file.path.lastIndexOf('/');
			const newDir = lastSlash > 0 ? file.path.substring(0, lastSlash) : '';
			if (newDir !== this.workingDir) {
				this.workingDir = newDir;
				this.updateCwdButton();
				this.configDirty = true;
			}
		}
	};

	/**
	 * Poll the active editor for selection changes and update the active note bar.
	 * Uses a lightweight interval instead of a CM6 extension to avoid coupling.
	 */
	proto.startSelectionPolling = function (): void {
		const POLL_MS = 300;
		const timerId = window.setInterval(() => this.pollSelection(), POLL_MS);
		this.selectionPollTimer = timerId as unknown as ReturnType<typeof setInterval>;
		this.registerInterval(timerId);
	};

	proto.pollSelection = function (): void {
		// Try to get the active MarkdownView. If focus is in our chat view,
		// fall back to iterating workspace leaves to find the most recent editor.
		let mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
		let editorIsActive = !!mdView;

		if (!mdView && this.containerEl.contains(document.activeElement)) {
			// Focus is in our chat — find the last MarkdownView leaf to read cursor from
			this.editorHadFocus = false;
			this.app.workspace.iterateAllLeaves(leaf => {
				if (!mdView && leaf.view instanceof MarkdownView) {
					mdView = leaf.view;
				}
			});
			editorIsActive = false;
		}

		if (!mdView) {
			this.editorHadFocus = false;
			if (this.activeSelection) {
				this.activeSelection = null;
				this.renderActiveNoteBar();
			}
			this.cursorPosition = null;
			return;
		}

		const editorFocused = editorIsActive && mdView.containerEl.contains(document.activeElement);
		const editor = mdView.editor;
		const from = editor.getCursor('from');
		const to = editor.getCursor('to');
		const hasSelection = from.line !== to.line || from.ch !== to.ch;

		// Always update cursor position from the editor
		const cursorFile = mdView.file;
		if (cursorFile) {
			this.cursorPosition = {
				filePath: cursorFile.path,
				fileName: cursorFile.name,
				line: from.line + 1,
				ch: from.ch,
			};
		}

		if (!hasSelection) {
			// Editor just regained focus (wasn't focused last tick) — the selection
			// collapsed because of the focus change, not a deliberate user action.
			// Keep the tracked selection intact.
			if (editorFocused && !this.editorHadFocus) {
				this.editorHadFocus = true;
				return;
			}
			// Editor was already focused — user deliberately deselected.
			// Or editor is not focused (cursor read from background leaf) — keep selection if tracked.
			if (!editorIsActive) {
				// Reading from background editor — don't clear selection
				return;
			}
			this.editorHadFocus = editorFocused;
			if (this.activeSelection) {
				this.activeSelection = null;
				this.renderActiveNoteBar();
			}
			return;
		}
		// Active selection present — cursor position is the selection start (already set above)
		this.editorHadFocus = editorFocused;

		const file = mdView.file;
		if (!file) return;

		const text = editor.getRange(from, to);
		const prev = this.activeSelection;
		// Only re-render if the selection actually changed
		if (prev && prev.filePath === file.path && prev.startLine === from.line + 1 && prev.endLine === to.line + 1 && prev.startChar === from.ch && prev.endChar === to.ch) {
			return;
		}

		this.activeSelection = {
			filePath: file.path,
			fileName: file.name,
			text,
			startLine: from.line + 1,
			startChar: from.ch,
			endLine: to.line + 1,
			endChar: to.ch,
		};
		this.renderActiveNoteBar();
	};

	proto.renderActiveNoteBar = function (): void {
		this.activeNoteBar.empty();

		// If there's a live editor selection, show it instead of the active note
		if (this.activeSelection) {
			this.activeNoteBar.removeClass('is-hidden');
			const tag = this.activeNoteBar.createDiv({cls: 'sidekick-attachment-tag sidekick-active-note-tag'});
			const ic = tag.createSpan({cls: 'sidekick-attachment-icon'});
			setIcon(ic, 'text-cursor-input');
			const sel = this.activeSelection;
			const displayName = sel.startLine === sel.endLine
				? `${sel.fileName}:${sel.startLine}`
				: `${sel.fileName}:${sel.startLine}-${sel.endLine}`;
			tag.createSpan({text: displayName, cls: 'sidekick-attachment-name'});
			tag.setAttribute('title', `Selection in ${sel.filePath} (${sel.startLine === sel.endLine ? `line ${sel.startLine}` : `lines ${sel.startLine}-${sel.endLine}`})`);
			return;
		}

		if (!this.activeNotePath) {
			this.activeNoteBar.addClass('is-hidden');
			return;
		}
		// Don't show the active note file chip when a selection attachment for the
		// same file already exists — the selection supersedes the whole-file context.
		if (this.attachments.some(a => a.type === 'selection' && a.path === this.activeNotePath)) {
			this.activeNoteBar.addClass('is-hidden');
			return;
		}
		this.activeNoteBar.removeClass('is-hidden');
		const tag = this.activeNoteBar.createDiv({cls: 'sidekick-attachment-tag sidekick-active-note-tag'});
		const ic = tag.createSpan({cls: 'sidekick-attachment-icon'});
		setIcon(ic, 'file-text');
		const name = this.activeNotePath.split('/').pop() || this.activeNotePath;
		tag.createSpan({text: name, cls: 'sidekick-attachment-name'});
		tag.setAttribute('title', `Active note: ${this.activeNotePath}`);
	};

	proto.openScopeModal = function (): void {
		new VaultScopeModal(this.app, this.scopePaths, (paths) => {
			this.scopePaths = paths;
			this.renderScopeBar();
		}).open();
	};

	// ── Prompt slash-command dropdown ─────────────────────────────

	proto.handlePromptTrigger = function (): void {
		const value = this.inputEl.value;
		// Trigger only when text starts with "/" (no space before the slash)
		if (!value.startsWith('/') || value.includes(' ')) {
			this.closePromptDropdown();
			// Clear tooltip if input no longer matches the active prompt
			if (this.activePrompt && !value.startsWith(`/${this.activePrompt.name}`)) {
				this.activePrompt = null;
				this.inputEl.removeAttribute('title');
			}
			return;
		}
		const query = value.slice(1).toLowerCase();
		const filtered = this.prompts.filter(p => p.name.toLowerCase().includes(query));
		if (filtered.length === 0) {
			this.closePromptDropdown();
			return;
		}
		this.showPromptDropdown(filtered);
	};

	proto.showPromptDropdown = function (prompts: PromptConfig[]): void {
		this.closePromptDropdown();
		this.promptDropdown = document.createElement('div');
		this.promptDropdown.addClass('sidekick-prompt-dropdown');
		this.promptDropdownIndex = 0;

		for (let i = 0; i < prompts.length; i++) {
			const p = prompts[i];
			if (!p) continue;
			const item = this.promptDropdown.createDiv({cls: 'sidekick-prompt-item'});
			if (i === 0) item.addClass('is-selected');
			item.setAttribute('title', p.content);

			item.createSpan({cls: 'sidekick-prompt-item-name', text: `/${p.name}`});
			const descText = p.description || (p.content.length > 60 ? p.content.slice(0, 60) + '…' : p.content);
			item.createSpan({cls: 'sidekick-prompt-item-desc', text: descText});
			if (p.agent) {
				item.createSpan({cls: 'sidekick-prompt-item-agent', text: p.agent});
			}

			item.addEventListener('click', () => {
				this.promptDropdownIndex = i;
				this.selectPromptFromDropdown();
			});
			item.addEventListener('mouseenter', () => {
				this.promptDropdownIndex = i;
				this.updatePromptDropdownSelection();
			});
		}

		// Position above the input area
		const inputArea = this.inputEl.closest('.sidekick-input-area');
		if (inputArea) {
			inputArea.appendChild(this.promptDropdown);
		}
	};

	proto.closePromptDropdown = function (): void {
		if (this.promptDropdown) {
			this.promptDropdown.remove();
			this.promptDropdown = null;
			this.promptDropdownIndex = -1;
		}
	};

	proto.navigatePromptDropdown = function (direction: number): void {
		if (!this.promptDropdown) return;
		const items = this.promptDropdown.querySelectorAll('.sidekick-prompt-item');
		if (items.length === 0) return;
		this.promptDropdownIndex = (this.promptDropdownIndex + direction + items.length) % items.length;
		this.updatePromptDropdownSelection();
	};

	proto.updatePromptDropdownSelection = function (): void {
		if (!this.promptDropdown) return;
		const items = this.promptDropdown.querySelectorAll('.sidekick-prompt-item');
		items.forEach((el, i) => {
			el.toggleClass('is-selected', i === this.promptDropdownIndex);
		});
	};

	proto.selectPromptFromDropdown = function (): void {
		if (!this.promptDropdown) return;
		const value = this.inputEl.value;
		const query = value.startsWith('/') ? value.slice(1).toLowerCase() : '';
		const filtered = this.prompts.filter(p => p.name.toLowerCase().includes(query));
		const selected = filtered[this.promptDropdownIndex];
		if (!selected) {
			this.closePromptDropdown();
			return;
		}

		this.activePrompt = selected;

		// Auto-select the prompt's agent
		if (selected.agent) {
			this.selectAgent(selected.agent);
		}

		// Replace input with /prompt-name + space
		this.inputEl.value = `/${selected.name} `;
		this.inputEl.setAttribute('title', selected.content);
		this.inputEl.setCssProps({'--input-height': 'auto'});
		this.inputEl.setCssProps({'--input-height': Math.min(this.inputEl.scrollHeight, 200) + 'px'});
		this.inputEl.focus();
		this.closePromptDropdown();
	};

	// ── Public API ───────────────────────────────────────────────

	/** Set the vault scope programmatically and refresh the scope bar. */
	proto.setScope = function (paths: string[]): void {
		this.scopePaths = paths;
		this.renderScopeBar();
	};

	/** Open the search tab with scope set to the given folder. */
	proto.openSearchWithScope = function (folderPath: string): void {
		this.searchWorkingDir = folderPath;
		this.updateSearchCwdButton();
		this.switchTab('search');
		this.searchInputEl.focus();
	};

	/** Set the working directory programmatically. */
	proto.setWorkingDir = function (folderPath: string): void {
		this.workingDir = folderPath;
		this.updateCwdButton();
		this.configDirty = true;
	};

	/** Set the prompt text programmatically and focus the input. */
	proto.setPromptText = function (text: string): void {
		this.inputEl.value = text;
		this.inputEl.setCssProps({'--input-height': 'auto'});
		this.inputEl.setCssProps({'--input-height': Math.min(this.inputEl.scrollHeight, 200) + 'px'});
		this.inputEl.focus();
	};

	/** Add a selection attachment from the editor context menu / brain button. */
	proto.addSelectionAttachment = function (text: string, info: SelectionInfo): void {
		// Resolve filePath: prefer info.filePath, fall back to current active file
		const filePath = info.filePath ?? this.app.workspace.getActiveFile()?.path;
		if (!filePath) return; // can't create selection attachment without a file
		const displayName = info.startLine === info.endLine
			? `${info.fileName}:${info.startLine}`
			: `${info.fileName}:${info.startLine}-${info.endLine}`;
		this.attachments.push({
			type: 'selection',
			name: displayName,
			path: filePath,
			content: text,
			selection: {
				startLine: info.startLine,
				startChar: info.startChar,
				endLine: info.endLine,
				endChar: info.endChar,
			},
		});
		this.renderAttachments();
		this.renderActiveNoteBar();
	};
}

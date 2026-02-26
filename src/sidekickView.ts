import {
	App,
	ItemView,
	WorkspaceLeaf,
	MarkdownRenderer,
	Notice,
	Modal,
	normalizePath,
	setIcon,
	TFile,
	TFolder,
	Component,
	Menu,
} from 'obsidian';
import type SidekickPlugin from './main';
import {approveAll} from './copilot';
import type {
	CopilotSession,
	SessionConfig,
	MCPServerConfig,
	ModelInfo,
	MessageOptions,
	PermissionRequest,
	PermissionRequestResult,
} from './copilot';
import type {AgentConfig, SkillInfo, McpServerEntry, ChatMessage, ChatAttachment} from './types';
import {loadAgents, loadSkills, loadMcpServers} from './configLoader';
import {VaultScopeModal} from './vaultScopeModal';

export const SIDEKICK_VIEW_TYPE = 'sidekick-view';

// FileAttachModal removed — attach now uses OS native file dialog

// ── Folder tree picker modal ────────────────────────────────────

class FolderTreeModal extends Modal {
	private readonly onSelect: (folder: TFolder) => void;
	private readonly currentPath: string;
	private collapsed: Set<string>;
	private searchInput!: HTMLInputElement;
	private listContainer!: HTMLElement;

	constructor(app: App, currentPath: string, onSelect: (folder: TFolder) => void) {
		super(app);
		this.onSelect = onSelect;
		this.currentPath = currentPath;
		this.collapsed = new Set<string>();
		this.collapseAllBelow(this.app.vault.getRoot(), 1);
		// Ensure current path is visible
		if (currentPath) {
			const parts = currentPath.split('/');
			for (let i = 1; i <= parts.length; i++) {
				this.collapsed.delete(parts.slice(0, i).join('/'));
			}
		}
		this.collapsed.delete('/');
	}

	onOpen(): void {
		const {contentEl} = this;
		contentEl.addClass('sidekick-scope-modal');

		contentEl.createEl('h3', {text: 'Select working directory'});

		this.searchInput = contentEl.createEl('input', {
			type: 'text',
			placeholder: 'Filter folders…',
			cls: 'sidekick-scope-search',
		});
		this.searchInput.addEventListener('input', () => this.renderTree());

		this.listContainer = contentEl.createDiv({cls: 'sidekick-scope-tree'});

		this.renderTree();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private renderTree(): void {
		this.listContainer.empty();
		const filter = this.searchInput.value.toLowerCase();
		const root = this.app.vault.getRoot();

		// Root node
		const rootRow = this.listContainer.createDiv({cls: 'sidekick-scope-item'});
		rootRow.style.paddingLeft = '8px';
		if (this.currentPath === '') rootRow.addClass('is-active');

		const toggle = rootRow.createSpan({cls: 'sidekick-scope-toggle'});
		setIcon(toggle, this.collapsed.has('/') ? 'chevron-right' : 'chevron-down');
		toggle.addEventListener('click', (e) => {
			e.stopPropagation();
			if (this.collapsed.has('/')) this.collapsed.delete('/');
			else this.collapsed.add('/');
			this.renderTree();
		});

		const iconSpan = rootRow.createSpan({cls: 'sidekick-scope-icon'});
		setIcon(iconSpan, 'vault');

		rootRow.createSpan({text: this.app.vault.getName(), cls: 'sidekick-scope-name sidekick-scope-root-name'});

		rootRow.addEventListener('click', () => {
			this.onSelect(root);
			this.close();
		});

		if (!this.collapsed.has('/')) {
			this.renderFolder(root, this.listContainer, 1, filter);
		}
	}

	private renderFolder(folder: TFolder, parent: HTMLElement, depth: number, filter: string): void {
		const children = [...folder.children]
			.filter((c): c is TFolder => c instanceof TFolder && !c.name.startsWith('.'))
			.sort((a, b) => a.name.localeCompare(b.name));

		for (const child of children) {
			const matchesFilter = !filter || child.path.toLowerCase().includes(filter);
			const hasMatch = this.hasMatchingDescendants(child, filter);
			if (!matchesFilter && !hasMatch) continue;

			const row = parent.createDiv({cls: 'sidekick-scope-item'});
			row.style.paddingLeft = `${depth * 20 + 8}px`;
			if (child.path === this.currentPath) row.addClass('is-active');

			const hasSubfolders = child.children.some(c => c instanceof TFolder && !c.name.startsWith('.'));
			if (hasSubfolders) {
				const toggle = row.createSpan({cls: 'sidekick-scope-toggle'});
				setIcon(toggle, this.collapsed.has(child.path) ? 'chevron-right' : 'chevron-down');
				toggle.addEventListener('click', (e) => {
					e.stopPropagation();
					if (this.collapsed.has(child.path)) this.collapsed.delete(child.path);
					else this.collapsed.add(child.path);
					this.renderTree();
				});
			} else {
				row.createSpan({cls: 'sidekick-scope-toggle sidekick-scope-toggle-spacer'});
			}

			const iconEl = row.createSpan({cls: 'sidekick-scope-icon'});
			setIcon(iconEl, 'folder');

			row.createSpan({text: child.name, cls: 'sidekick-scope-name'});

			row.addEventListener('click', () => {
				this.onSelect(child);
				this.close();
			});

			if (hasSubfolders && !this.collapsed.has(child.path)) {
				this.renderFolder(child, parent, depth + 1, filter);
			}
		}
	}

	private hasMatchingDescendants(folder: TFolder, filter: string): boolean {
		if (!filter) return true;
		for (const child of folder.children) {
			if (!(child instanceof TFolder) || child.name.startsWith('.')) continue;
			if (child.path.toLowerCase().includes(filter)) return true;
			if (this.hasMatchingDescendants(child, filter)) return true;
		}
		return false;
	}

	private collapseAllBelow(folder: TFolder, maxDepth: number, current = 0): void {
		for (const child of folder.children) {
			if (child instanceof TFolder) {
				if (current >= maxDepth) this.collapsed.add(child.path);
				this.collapseAllBelow(child, maxDepth, current + 1);
			}
		}
	}
}

// ── Tool-approval modal ─────────────────────────────────────────

class ToolApprovalModal extends Modal {
	private resolved = false;
	private resolve!: (result: PermissionRequestResult) => void;
	private readonly request: PermissionRequest;
	readonly promise: Promise<PermissionRequestResult>;

	constructor(app: App, request: PermissionRequest) {
		super(app);
		this.request = request;
		this.promise = new Promise<PermissionRequestResult>((res) => {
			this.resolve = res;
		});
	}

	onOpen(): void {
		const {contentEl} = this;
		contentEl.empty();
		contentEl.addClass('sidekick-approval-modal');

		contentEl.createEl('h3', {text: 'Tool approval required'});

		const info = contentEl.createDiv({cls: 'sidekick-approval-info'});
		info.createDiv({cls: 'sidekick-approval-row', text: `Kind: ${this.request.kind}`});

		// Show relevant details based on request kind
		const details: Record<string, unknown> = {...this.request};
		delete details.kind;
		delete details.toolCallId;
		if (Object.keys(details).length > 0) {
			const pre = info.createEl('pre', {cls: 'sidekick-approval-details'});
			pre.createEl('code', {text: JSON.stringify(details, null, 2)});
		}

		const btnRow = contentEl.createDiv({cls: 'sidekick-approval-buttons'});

		const allowBtn = btnRow.createEl('button', {cls: 'mod-cta', text: 'Allow'});
		allowBtn.addEventListener('click', () => {
			this.resolved = true;
			this.resolve({kind: 'approved'});
			this.close();
		});

		const denyBtn = btnRow.createEl('button', {text: 'Deny'});
		denyBtn.addEventListener('click', () => {
			this.resolved = true;
			this.resolve({kind: 'denied-interactively-by-user'});
			this.close();
		});
	}

	onClose(): void {
		if (!this.resolved) {
			this.resolve({kind: 'denied-interactively-by-user'});
		}
	}
}

// ── Sidekick view ───────────────────────────────────────────────

export class SidekickView extends ItemView {
	plugin: SidekickPlugin;

	// ── State ────────────────────────────────────────────────────
	private messages: ChatMessage[] = [];
	private currentSession: CopilotSession | null = null;
	private agents: AgentConfig[] = [];
	private models: ModelInfo[] = [];
	private skills: SkillInfo[] = [];
	private mcpServers: McpServerEntry[] = [];

	private selectedAgent = '';
	private selectedModel = '';
	private enabledSkills: Set<string> = new Set();
	private enabledMcpServers: Set<string> = new Set();
	private attachments: ChatAttachment[] = [];
	private scopePaths: string[] = [];
	private workingDir = '';  // vault-relative path, '' means vault root

	private isStreaming = false;
	private configDirty = true;
	private streamingContent = '';
	private renderScheduled = false;
	private showDebugInfo = false;

	// ── Turn-level metadata ────────────────────────────────────
	private turnStartTime = 0;
	private turnToolsUsed: string[] = [];
	private turnSkillsUsed: string[] = [];
	private turnUsage: {inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; model?: string} | null = null;
	private activeToolCalls = new Map<string, {toolName: string; detailsEl: HTMLDetailsElement}>();

	// ── DOM refs ─────────────────────────────────────────────────
	private chatContainer!: HTMLElement;
	private streamingBodyEl: HTMLElement | null = null;
	private toolCallsContainer: HTMLElement | null = null;
	private inputEl!: HTMLTextAreaElement;
	private attachmentsBar!: HTMLElement;
	private scopeBar!: HTMLElement;
	private sendBtn!: HTMLButtonElement;
	private agentSelect!: HTMLSelectElement;
	private modelSelect!: HTMLSelectElement;
	private skillsBtnEl!: HTMLButtonElement;
	private toolsBtnEl!: HTMLButtonElement;
	private cwdBtnEl!: HTMLButtonElement;
	private debugBtnEl!: HTMLElement;
	private streamingComponent: Component | null = null;
	private streamingWrapperEl: HTMLElement | null = null;

	private eventUnsubscribers: (() => void)[] = [];

	constructor(leaf: WorkspaceLeaf, plugin: SidekickPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return SIDEKICK_VIEW_TYPE;
	}
	getDisplayText(): string {
		return 'Sidekick';
	}
	getIcon(): string {
		return 'brain';
	}

	// ── Lifecycle ────────────────────────────────────────────────

	async onOpen(): Promise<void> {
		// Header actions
		this.addAction('refresh-cw', 'Refresh configuration', () => void this.loadAllConfigs());
		this.addAction('plus', 'New conversation', () => void this.newConversation());

		this.buildUI();
		await this.loadAllConfigs();
	}

	async onClose(): Promise<void> {
		await this.destroySession();
	}

	// ── UI construction ──────────────────────────────────────────

	private buildUI(): void {
		const root = this.containerEl.children[1] as HTMLElement;
		root.empty();
		root.addClass('sidekick-root');

		// Chat history (scrollable)
		this.chatContainer = root.createDiv({cls: 'sidekick-chat sidekick-hide-debug'});
		this.renderWelcome();

		// Bottom panel
		const bottom = root.createDiv({cls: 'sidekick-bottom'});

		// Input area
		this.buildInputArea(bottom);

		// Config toolbar (agents, models, skills, tools, action buttons)
		this.buildConfigToolbar(bottom);
	}

	private renderWelcome(): void {
		const welcome = this.chatContainer.createDiv({cls: 'sidekick-welcome'});
		const icon = welcome.createDiv({cls: 'sidekick-welcome-icon'});
		setIcon(icon, 'brain');
		welcome.createEl('h3', {text: 'Sidekick'});
		welcome.createEl('p', {
			text: 'Your AI-powered second brain. Select an agent, choose a model, configure tools and get the job done!',
			cls: 'sidekick-welcome-desc',
		});
	}

	private buildInputArea(parent: HTMLElement): void {
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

		// Attachments & scope (shown inline after action buttons)
		this.attachmentsBar = inputActions.createDiv({cls: 'sidekick-attachments-bar'});
		this.scopeBar = inputActions.createDiv({cls: 'sidekick-scope-bar'});

		// Row for textarea + send button
		const inputRow = inputArea.createDiv({cls: 'sidekick-input-row'});

		this.inputEl = inputRow.createEl('textarea', {
			cls: 'sidekick-input',
			attr: {placeholder: 'Ask or paste something to work on...', rows: '1'},
		});

		// Auto-resize
		this.inputEl.addEventListener('input', () => {
			this.inputEl.style.height = 'auto';
			this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 200) + 'px';
		});

		// Ctrl+Enter or Enter (without Shift) to send
		// Register on window in capture phase — earliest interception before Obsidian's hotkey system
		const keyHandler = (e: KeyboardEvent) => {
			if (document.activeElement !== this.inputEl) return;
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
	}

	private buildConfigToolbar(parent: HTMLElement): void {
		const toolbar = parent.createDiv({cls: 'sidekick-toolbar'});

		// New conversation button
		const newChatBtn = toolbar.createEl('button', {cls: 'clickable-icon sidekick-icon-btn', attr: {title: 'New conversation'}});
		setIcon(newChatBtn, 'plus');
		newChatBtn.addEventListener('click', () => void this.newConversation());

		// Refresh button
		const refreshBtn = toolbar.createEl('button', {cls: 'clickable-icon sidekick-icon-btn', attr: {title: 'Refresh configuration'}});
		setIcon(refreshBtn, 'refresh-cw');
		refreshBtn.addEventListener('click', () => void this.loadAllConfigs());

		// Agent dropdown
		const agentGroup = toolbar.createDiv({cls: 'sidekick-toolbar-group'});
		const agentIcon = agentGroup.createSpan({cls: 'sidekick-toolbar-icon'});
		setIcon(agentIcon, 'bot');
		this.agentSelect = agentGroup.createEl('select', {cls: 'sidekick-select'});
		this.agentSelect.addEventListener('change', () => {
			this.selectedAgent = this.agentSelect.value;
			// Auto-select agent's preferred model
			const agent = this.agents.find(a => a.name === this.selectedAgent);
			if (agent?.model) {
				const target = agent.model.toLowerCase();
				// Try exact match first (name or id)
				let modelMatch = this.models.find(
					m => m.name.toLowerCase() === target || m.id.toLowerCase() === target
				);
				// Fallback: partial match (id or name contains the agent's model string)
				if (!modelMatch) {
					modelMatch = this.models.find(
						m => m.id.toLowerCase().includes(target) || m.name.toLowerCase().includes(target)
					);
				}
				if (modelMatch) {
					this.selectedModel = modelMatch.id;
					this.modelSelect.value = modelMatch.id;
				}
			}
			this.configDirty = true;
		});

		// Model dropdown
		const modelGroup = toolbar.createDiv({cls: 'sidekick-toolbar-group'});
		const modelIcon = modelGroup.createSpan({cls: 'sidekick-toolbar-icon'});
		setIcon(modelIcon, 'cpu');
		this.modelSelect = modelGroup.createEl('select', {cls: 'sidekick-select'});
		this.modelSelect.addEventListener('change', () => {
			this.selectedModel = this.modelSelect.value;
			this.configDirty = true;
		});

		// Skills button
		this.skillsBtnEl = toolbar.createEl('button', {cls: 'clickable-icon sidekick-icon-btn', attr: {title: 'Skills'}});
		setIcon(this.skillsBtnEl, 'wand-2');
		this.skillsBtnEl.addEventListener('click', (e) => this.openSkillsMenu(e));

		// Tools button
		this.toolsBtnEl = toolbar.createEl('button', {cls: 'clickable-icon sidekick-icon-btn', attr: {title: 'Tools'}});
		setIcon(this.toolsBtnEl, 'plug');
		this.toolsBtnEl.addEventListener('click', (e) => this.openToolsMenu(e));

		// Working directory button
		this.cwdBtnEl = toolbar.createEl('button', {cls: 'clickable-icon sidekick-icon-btn', attr: {title: 'Working directory'}});
		setIcon(this.cwdBtnEl, 'hard-drive-download');
		this.cwdBtnEl.addEventListener('click', () => this.openCwdPicker());
		this.updateCwdButton();

		// Spacer to push debug toggle to the right
		toolbar.createDiv({cls: 'sidekick-toolbar-spacer'});

		// Debug toggle
		this.debugBtnEl = toolbar.createDiv({cls: 'sidekick-debug-toggle', attr: {title: 'Show tool & token details'}});
		const debugIcon = this.debugBtnEl.createSpan({cls: 'sidekick-debug-icon clickable-icon'});
		setIcon(debugIcon, 'bug');
		const debugCheck = this.debugBtnEl.createEl('input', {type: 'checkbox', cls: 'sidekick-debug-checkbox'}) as HTMLInputElement;
		debugCheck.checked = this.showDebugInfo;
		debugCheck.addEventListener('change', () => {
			this.showDebugInfo = debugCheck.checked;
			this.chatContainer.toggleClass('sidekick-hide-debug', !this.showDebugInfo);
		});
		this.debugBtnEl.addEventListener('click', (e) => {
			if (e.target !== debugCheck) {
				debugCheck.checked = !debugCheck.checked;
				debugCheck.dispatchEvent(new Event('change'));
			}
		});
	}

	// ── Config loading ───────────────────────────────────────────

	private async loadAllConfigs(): Promise<void> {
		try {
			this.agents = await loadAgents(this.app, this.plugin.settings.agentsFolder);
			this.skills = await loadSkills(this.app, this.plugin.settings.skillsFolder);
			this.mcpServers = await loadMcpServers(this.app, this.plugin.settings.toolsFolder);

			// Select all skills and tools by default
			this.enabledSkills = new Set(this.skills.map(s => s.name));
			this.enabledMcpServers = new Set(this.mcpServers.map(s => s.name));

			if (this.plugin.copilot) {
				try {
					this.models = await this.plugin.copilot.listModels();
				} catch (e) {
					console.warn('Sidekick: failed to load models', e);
				}
			}
		} catch (e) {
			console.error('Sidekick: failed to load configs', e);
		}

		this.updateConfigUI();
		this.configDirty = true;
		new Notice(`Loaded ${this.agents.length} agent(s), ${this.models.length} model(s), ${this.skills.length} skill(s), ${this.mcpServers.length} tool server(s).`);
	}

	private updateConfigUI(): void {
		// Agents
		this.agentSelect.empty();
		const noAgent = this.agentSelect.createEl('option', {text: 'Agent', attr: {value: ''}});
		noAgent.value = '';
		for (const agent of this.agents) {
			const opt = this.agentSelect.createEl('option', {text: agent.name});
			opt.value = agent.name;
		}
		if (this.selectedAgent && this.agents.some(a => a.name === this.selectedAgent)) {
			this.agentSelect.value = this.selectedAgent;
		} else if (this.agents.length > 0 && this.agents[0]) {
			this.selectedAgent = this.agents[0].name;
			this.agentSelect.value = this.selectedAgent;
		}

		// Auto-select agent's preferred model
		const selectedAgentConfig = this.agents.find(a => a.name === this.selectedAgent);
		if (selectedAgentConfig?.model) {
			const target = selectedAgentConfig.model.toLowerCase();
			let modelMatch = this.models.find(
				m => m.name.toLowerCase() === target || m.id.toLowerCase() === target
			);
			if (!modelMatch) {
				modelMatch = this.models.find(
					m => m.id.toLowerCase().includes(target) || m.name.toLowerCase().includes(target)
				);
			}
			if (modelMatch) {
				this.selectedModel = modelMatch.id;
			}
		}

		// Models
		this.modelSelect.empty();
		for (const model of this.models) {
			const opt = this.modelSelect.createEl('option', {text: model.name});
			opt.value = model.id;
		}
		if (this.selectedModel && this.models.some(m => m.id === this.selectedModel)) {
			this.modelSelect.value = this.selectedModel;
		} else if (this.models.length > 0 && this.models[0]) {
			this.selectedModel = this.models[0].id;
			this.modelSelect.value = this.selectedModel;
		}

		// Update skill / tool button badges
		this.updateSkillsBadge();
		this.updateToolsBadge();
	}

	private openSkillsMenu(e: MouseEvent): void {
		const menu = new Menu();
		if (this.skills.length === 0) {
			menu.addItem(item => item.setTitle('No skills configured').setDisabled(true));
		} else {
			for (const skill of this.skills) {
				menu.addItem(item => {
					item.setTitle(skill.name)
						.setChecked(this.enabledSkills.has(skill.name))
						.onClick(() => {
							if (this.enabledSkills.has(skill.name)) {
								this.enabledSkills.delete(skill.name);
							} else {
								this.enabledSkills.add(skill.name);
							}
							this.configDirty = true;
							this.updateSkillsBadge();
						});
				});
			}
		}
		menu.showAtMouseEvent(e);
	}

	private openToolsMenu(e: MouseEvent): void {
		const menu = new Menu();
		if (this.mcpServers.length === 0) {
			menu.addItem(item => item.setTitle('No tools configured').setDisabled(true));
		} else {
			for (const server of this.mcpServers) {
				menu.addItem(item => {
					item.setTitle(server.name)
						.setChecked(this.enabledMcpServers.has(server.name))
						.onClick(() => {
							if (this.enabledMcpServers.has(server.name)) {
								this.enabledMcpServers.delete(server.name);
							} else {
								this.enabledMcpServers.add(server.name);
							}
							this.configDirty = true;
							this.updateToolsBadge();
						});
				});
			}
		}
		menu.showAtMouseEvent(e);
	}

	private updateSkillsBadge(): void {
		const count = this.enabledSkills.size;
		this.skillsBtnEl.toggleClass('is-active', count > 0);
		this.skillsBtnEl.setAttribute('title', count > 0 ? `Skills (${count} active)` : 'Skills');
	}

	private updateToolsBadge(): void {
		const count = this.enabledMcpServers.size;
		this.toolsBtnEl.toggleClass('is-active', count > 0);
		this.toolsBtnEl.setAttribute('title', count > 0 ? `Tools (${count} active)` : 'Tools');
	}

	// ── Attachments & scope ──────────────────────────────────────

	private renderAttachments(): void {
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
			const typeIcon = att.type === 'image' ? 'image' : att.type === 'clipboard' ? 'clipboard' : 'file-text';
			const ic = tag.createSpan({cls: 'sidekick-attachment-icon'});
			setIcon(ic, typeIcon);
			tag.createSpan({text: att.name, cls: 'sidekick-attachment-name'});
			const removeBtn = tag.createSpan({cls: 'sidekick-attachment-remove'});
			setIcon(removeBtn, 'x');
			const idx = i;
			removeBtn.addEventListener('click', () => {
				this.attachments.splice(idx, 1);
				this.renderAttachments();
			});
		}
	}

	private renderScopeBar(): void {
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
		label.style.cursor = 'pointer';
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
	}

	private handleAttachFile(): void {
		const input = document.createElement('input');
		input.type = 'file';
		input.multiple = true;
		input.style.display = 'none';
		document.body.appendChild(input);

		input.addEventListener('change', () => {
			if (!input.files) { input.remove(); return; }

			// Resolve absolute OS path: prefer Electron webUtils, fallback to File.path
			let getPath: (f: File) => string;
			try {
				// eslint-disable-next-line @typescript-eslint/no-var-requires
				const {webUtils} = require('electron') as {webUtils?: {getPathForFile: (f: File) => string}};
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
					console.warn('Sidekick: could not resolve OS path for', file.name);
					continue;
				}
				console.log('Sidekick: attached OS file', file.name, filePath);
				this.attachments.push({type: 'file', name: file.name, path: filePath, absolutePath: true});
			}
			this.renderAttachments();
			input.remove();
		});

		input.addEventListener('cancel', () => input.remove());
		input.click();
	}

	private async handleClipboard(): Promise<void> {
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
	}

	private async handleImagePaste(blob: File): Promise<void> {
		try {
			const buffer = await blob.arrayBuffer();
			const ext = blob.type === 'image/png' ? 'png' : blob.type === 'image/jpeg' ? 'jpg' : 'png';
			const name = `paste-${Date.now()}.${ext}`;
			const folder = normalizePath('.sidekick-attachments');

			if (!(await this.app.vault.adapter.exists(folder))) {
				await this.app.vault.createFolder(folder);
			}

			const filePath = normalizePath(`${folder}/${name}`);
			await this.app.vault.adapter.writeBinary(filePath, buffer);

			this.attachments.push({type: 'image', name, path: filePath});
			this.renderAttachments();
			new Notice('Image attached.');
		} catch (e) {
			new Notice(`Failed to attach image: ${String(e)}`);
		}
	}

	private openScopeModal(): void {
		new VaultScopeModal(this.app, this.scopePaths, (paths) => {
			this.scopePaths = paths;
			this.renderScopeBar();
		}).open();
	}

	// ── Message rendering ────────────────────────────────────────

	private addUserMessage(content: string, attachments: ChatAttachment[], scopePaths: string[]): void {
		// Combine file/clipboard attachments with scope path entries for display
		const allAttachments = [...attachments];
		for (const sp of scopePaths) {
			const displayName = sp === '/' ? this.app.vault.getName() : sp;
			const abstract = sp === '/'
				? this.app.vault.getRoot()
				: this.app.vault.getAbstractFileByPath(sp);
			const type = abstract instanceof TFolder ? 'directory' as const : 'file' as const;
			allAttachments.push({type, name: displayName, path: sp});
		}

		const msg: ChatMessage = {
			id: `u-${Date.now()}`,
			role: 'user',
			content,
			timestamp: Date.now(),
			attachments: allAttachments.length > 0 ? allAttachments : undefined,
		};
		this.messages.push(msg);
		this.renderMessageBubble(msg);
		this.scrollToBottom();
	}

	private addInfoMessage(text: string): void {
		const msg: ChatMessage = {id: `i-${Date.now()}`, role: 'info', content: text, timestamp: Date.now()};
		this.messages.push(msg);
		this.renderMessageBubble(msg);
		this.scrollToBottom();
	}

	private renderMessageBubble(msg: ChatMessage): void {
		if (msg.role === 'info') {
			const el = this.chatContainer.createDiv({cls: 'sidekick-msg sidekick-msg-info'});
			el.createSpan({text: msg.content});
			return;
		}

		const wrapper = this.chatContainer.createDiv({
			cls: `sidekick-msg sidekick-msg-${msg.role}`,
		});

		const bodyWrapper = wrapper.createDiv({cls: 'sidekick-msg-body-wrapper'});

		// Attachments
		if (msg.attachments && msg.attachments.length > 0) {
			const attRow = bodyWrapper.createDiv({cls: 'sidekick-msg-attachments'});
			for (const att of msg.attachments) {
				const chip = attRow.createSpan({cls: 'sidekick-msg-att-chip sidekick-att-clickable'});
				const ic = chip.createSpan();
				const icon = att.type === 'directory' ? 'folder' : att.type === 'image' ? 'image' : att.type === 'clipboard' ? 'clipboard' : 'file-text';
				setIcon(ic, icon);
				chip.appendText(` ${att.name}`);

				// Click to open
				if (att.type === 'clipboard') {
					// Clipboard: copy content back to clipboard
					if (att.content) {
						chip.setAttribute('title', 'Copy to clipboard');
						chip.addEventListener('click', () => {
							void navigator.clipboard.writeText(att.content!);
							new Notice('Copied to clipboard.');
						});
					}
				} else if (att.absolutePath && att.path) {
					// External OS file: open with default OS application
					chip.setAttribute('title', 'Open with OS default application');
					chip.addEventListener('click', () => {
						try {
							const {shell} = require('electron') as {shell: {openPath: (p: string) => Promise<string>}};
							void shell.openPath(att.path!);
						} catch (e) {
							new Notice(`Failed to open file: ${String(e)}`);
						}
					});
				} else if (att.type === 'image' && att.path) {
					// Pasted image in vault: open with OS image viewer
					chip.setAttribute('title', 'Open with OS image viewer');
					chip.addEventListener('click', () => {
						try {
							const {shell} = require('electron') as {shell: {openPath: (p: string) => Promise<string>}};
							const absPath = this.getVaultBasePath() + '/' + normalizePath(att.path!);
							void shell.openPath(absPath);
						} catch (e) {
							new Notice(`Failed to open image: ${String(e)}`);
						}
					});
				} else if (att.type === 'directory' && att.path) {
					// Vault folder: reveal in file explorer
					chip.setAttribute('title', 'Reveal in file explorer');
					chip.addEventListener('click', () => {
						const folder = att.path === '/'
							? this.app.vault.getRoot()
							: this.app.vault.getAbstractFileByPath(att.path!);
						if (folder) {
							// Reveal the folder in Obsidian's file explorer
							const fileExplorer = this.app.workspace.getLeavesOfType('file-explorer')[0];
							if (fileExplorer) {
								this.app.workspace.revealLeaf(fileExplorer);
								(fileExplorer.view as unknown as {revealInFolder?: (f: unknown) => void}).revealInFolder?.(folder);
							}
						}
					});
				} else if (att.type === 'file' && att.path) {
					// Vault file: open in Obsidian
					chip.setAttribute('title', 'Open in Obsidian');
					chip.addEventListener('click', () => {
						const file = this.app.vault.getAbstractFileByPath(att.path!);
						if (file instanceof TFile) {
							void this.app.workspace.getLeaf(false).openFile(file);
						}
					});
				}
			}
		}

		const body = bodyWrapper.createDiv({cls: 'sidekick-msg-body'});

		if (msg.role === 'assistant') {
			void this.renderMarkdownSafe(msg.content, body);
		} else {
			body.createEl('p', {text: msg.content});
			// Copy button for user messages
			const copyBtn = wrapper.createEl('button', {
				cls: 'sidekick-msg-copy',
				attr: {title: 'Copy to clipboard'},
			});
			setIcon(copyBtn, 'copy');
			copyBtn.addEventListener('click', () => {
				void navigator.clipboard.writeText(msg.content);
				setIcon(copyBtn, 'check');
				setTimeout(() => setIcon(copyBtn, 'copy'), 1500);
			});
		}
	}

	private addAssistantPlaceholder(): void {
		const wrapper = this.chatContainer.createDiv({cls: 'sidekick-msg sidekick-msg-assistant'});

		const bodyWrapper = wrapper.createDiv({cls: 'sidekick-msg-body-wrapper'});

		// Container for collapsible tool call blocks
		this.toolCallsContainer = bodyWrapper.createDiv({cls: 'sidekick-tool-calls'});

		const body = bodyWrapper.createDiv({cls: 'sidekick-msg-body'});
		const thinking = body.createDiv({cls: 'sidekick-thinking'});
		thinking.createSpan({text: 'Thinking'});
		const dots = thinking.createSpan({cls: 'sidekick-thinking-dots'});
		dots.createSpan({cls: 'sidekick-dot', text: '.'});
		dots.createSpan({cls: 'sidekick-dot', text: '.'});
		dots.createSpan({cls: 'sidekick-dot', text: '.'});

		// Clean up any previous streaming component
		if (this.streamingComponent) {
			this.removeChild(this.streamingComponent);
			this.streamingComponent = null;
		}
		this.streamingComponent = this.addChild(new Component());

		this.streamingBodyEl = body;
		this.streamingWrapperEl = bodyWrapper;
		this.scrollToBottom();
	}

	private showProcessingIndicator(): void {
		if (!this.streamingBodyEl) return;
		// Remove any existing thinking/processing indicator
		const existing = this.streamingBodyEl.querySelector('.sidekick-thinking');
		if (existing) existing.remove();
		const processing = this.streamingBodyEl.createDiv({cls: 'sidekick-thinking'});
		processing.createSpan({text: 'Processing'});
		const dots = processing.createSpan({cls: 'sidekick-thinking-dots'});
		dots.createSpan({cls: 'sidekick-dot', text: '.'});
		dots.createSpan({cls: 'sidekick-dot', text: '.'});
		dots.createSpan({cls: 'sidekick-dot', text: '.'});
	}

	private removeProcessingIndicator(): void {
		if (!this.streamingBodyEl) return;
		const indicator = this.streamingBodyEl.querySelector('.sidekick-thinking');
		if (indicator) indicator.remove();
	}

	// ── Streaming ────────────────────────────────────────────────

	private appendDelta(delta: string): void {
		this.streamingContent += delta;
		// Remove processing indicator once real content starts streaming
		this.removeProcessingIndicator();
		if (!this.renderScheduled) {
			this.renderScheduled = true;
			window.requestAnimationFrame(() => {
				this.renderScheduled = false;
				void this.updateStreamingRender();
			});
		}
	}

	private async updateStreamingRender(): Promise<void> {
		if (!this.streamingBodyEl) return;
		this.streamingBodyEl.empty();
		await this.renderMarkdownSafe(this.streamingContent, this.streamingBodyEl);
		this.scrollToBottom();
	}

	private finalizeStreamingMessage(): void {
		if (this.streamingContent) {
			const msg: ChatMessage = {
				id: `a-${Date.now()}`,
				role: 'assistant',
				content: this.streamingContent,
				timestamp: Date.now(),
			};
			this.messages.push(msg);
		}

		// Render metadata footer
		this.renderMessageMetadata();

		this.streamingContent = '';
		this.streamingBodyEl = null;
		this.streamingWrapperEl = null;
		this.toolCallsContainer = null;
		this.activeToolCalls.clear();

		if (this.streamingComponent) {
			this.removeChild(this.streamingComponent);
			this.streamingComponent = null;
		}

		// Reset turn metadata
		this.turnStartTime = 0;
		this.turnToolsUsed = [];
		this.turnSkillsUsed = [];
		this.turnUsage = null;

		this.isStreaming = false;
		this.updateSendButton();
	}

	private renderMessageMetadata(): void {
		if (!this.streamingWrapperEl) return;

		const hasTime = this.turnStartTime > 0;
		const hasTokens = this.turnUsage !== null;
		const uniqueTools = [...new Set(this.turnToolsUsed)];
		const hasTools = uniqueTools.length > 0;
		const uniqueSkills = [...new Set(this.turnSkillsUsed)];
		const hasSkills = uniqueSkills.length > 0;

		if (!hasTime && !hasTokens && !hasTools && !hasSkills) return;

		const footer = this.streamingWrapperEl.createDiv({cls: 'sidekick-msg-metadata'});

		// Elapsed time
		if (hasTime) {
			const elapsed = Date.now() - this.turnStartTime;
			const timeText = elapsed < 1000 ? `${elapsed}ms` : `${(elapsed / 1000).toFixed(1)}s`;
			const timeSpan = footer.createSpan({cls: 'sidekick-metadata-item'});
			const timeIcon = timeSpan.createSpan({cls: 'sidekick-metadata-icon'});
			setIcon(timeIcon, 'clock');
			timeSpan.appendText(timeText);
		}

		// Token usage — show rounded total, detail on hover
		if (hasTokens) {
			const u = this.turnUsage!;
			const total = u.inputTokens + u.cacheReadTokens + u.outputTokens;
			const rounded = total >= 1000 ? `${(total / 1000).toFixed(1)}k` : `${total}`;
			const tooltipLines: string[] = [];
			if (u.model) tooltipLines.push(`Model: ${u.model}`);
			tooltipLines.push(`Input: ${u.inputTokens}`);
			tooltipLines.push(`Output: ${u.outputTokens}`);
			if (u.cacheReadTokens > 0) tooltipLines.push(`Cached: ${u.cacheReadTokens}`);
			if (u.cacheWriteTokens > 0) tooltipLines.push(`Cache write: ${u.cacheWriteTokens}`);
			const tokenSpan = footer.createSpan({cls: 'sidekick-metadata-item'});
			const tokenIcon = tokenSpan.createSpan({cls: 'sidekick-metadata-icon'});
			setIcon(tokenIcon, 'hash');
			tokenSpan.appendText(`${rounded} tokens`);
			tokenSpan.setAttribute('title', tooltipLines.join('\n'));
		}

		// Tools used
		if (hasTools) {
			const toolSpan = footer.createSpan({cls: 'sidekick-metadata-item sidekick-metadata-tools'});
			const toolIcon = toolSpan.createSpan({cls: 'sidekick-metadata-icon'});
			setIcon(toolIcon, 'wrench');
			const toolLabel = uniqueTools.length === 1 ? '1 tool' : `${uniqueTools.length} tools`;
			toolSpan.appendText(toolLabel);
			toolSpan.setAttribute('title', uniqueTools.join('\n'));
		}

		// Skills used
		if (hasSkills) {
			const skillSpan = footer.createSpan({cls: 'sidekick-metadata-item sidekick-metadata-tools'});
			const skillIcon = skillSpan.createSpan({cls: 'sidekick-metadata-icon'});
			setIcon(skillIcon, 'wand-2');
			const skillLabel = uniqueSkills.length === 1 ? '1 skill' : `${uniqueSkills.length} skills`;
			skillSpan.appendText(skillLabel);
			skillSpan.setAttribute('title', uniqueSkills.join('\n'));
		}
	}

	private addToolCallBlock(toolCallId: string, toolName: string, args?: unknown): void {
		if (!this.toolCallsContainer) return;

		const details = this.toolCallsContainer.createEl('details', {cls: 'sidekick-tool-call'});
		const summary = details.createEl('summary', {cls: 'sidekick-tool-call-summary'});
		const iconEl = summary.createSpan({cls: 'sidekick-tool-call-icon'});
		setIcon(iconEl, 'wrench');
		summary.createSpan({cls: 'sidekick-tool-call-name', text: toolName});
		const spinner = summary.createSpan({cls: 'sidekick-tool-call-spinner'});
		setIcon(spinner, 'loader');

		// Input section
		if (args && Object.keys(args as Record<string, unknown>).length > 0) {
			const inputSection = details.createDiv({cls: 'sidekick-tool-call-section'});
			inputSection.createDiv({cls: 'sidekick-tool-call-label', text: 'Input'});
			const pre = inputSection.createEl('pre', {cls: 'sidekick-tool-call-code'});
			pre.createEl('code', {text: JSON.stringify(args, null, 2)});
		}

		this.activeToolCalls.set(toolCallId, {toolName, detailsEl: details});

		// Show "Processing ..." animation while tools are running
		this.showProcessingIndicator();

		this.scrollToBottom();
	}

	private completeToolCallBlock(toolCallId: string, success: boolean, result?: {content?: string; detailedContent?: string}, error?: {message: string}): void {
		const entry = this.activeToolCalls.get(toolCallId);
		if (!entry) return;

		const {detailsEl} = entry;

		// Remove spinner, add status icon
		const spinner = detailsEl.querySelector('.sidekick-tool-call-spinner');
		if (spinner) spinner.remove();
		const summaryEl = detailsEl.querySelector('summary');
		if (summaryEl) {
			const statusEl = summaryEl.createSpan({cls: `sidekick-tool-call-status ${success ? 'is-success' : 'is-error'}`});
			setIcon(statusEl, success ? 'check' : 'x');
		}

		// Output section
		const output = error ? `Error: ${error.message}` : (result?.detailedContent || result?.content || '');
		if (output) {
			const outputSection = detailsEl.createDiv({cls: 'sidekick-tool-call-section'});
			outputSection.createDiv({cls: 'sidekick-tool-call-label', text: success ? 'Output' : 'Error'});
			const pre = outputSection.createEl('pre', {cls: 'sidekick-tool-call-code'});
			const maxLen = 5000;
			const displayText = output.length > maxLen ? output.slice(0, maxLen) + '\n… (truncated)' : output;
			pre.createEl('code', {text: displayText});
		}

		this.activeToolCalls.delete(toolCallId);
		this.scrollToBottom();
	}

	private updateSendButton(): void {
		this.sendBtn.empty();
		if (this.isStreaming) {
			setIcon(this.sendBtn, 'square');
			this.sendBtn.title = 'Stop';
			this.sendBtn.addClass('is-streaming');
		} else {
			setIcon(this.sendBtn, 'arrow-up');
			this.sendBtn.title = 'Send message';
			this.sendBtn.removeClass('is-streaming');
		}
	}

	// ── Send & abort ─────────────────────────────────────────────

	private async handleSend(): Promise<void> {
		const prompt = this.inputEl.value.trim();
		if (!prompt || this.isStreaming) return;

		if (!this.plugin.copilot) {
			new Notice('Copilot is not configured. Go to Settings → Sidekick.');
			return;
		}

		// Snapshot attachments and scope
		const currentAttachments = [...this.attachments];
		const currentScopePaths = [...this.scopePaths];

		// Update UI
		this.addUserMessage(prompt, currentAttachments, currentScopePaths);
		this.inputEl.value = '';
		this.inputEl.style.height = 'auto';
		this.attachments = [];
		this.renderAttachments();

		// Begin streaming
		this.isStreaming = true;
		this.streamingContent = '';
		this.updateSendButton();
		this.addAssistantPlaceholder();

		try {
			await this.ensureSession();

			const sdkAttachments = this.buildSdkAttachments(currentAttachments);
			const fullPrompt = this.buildPrompt(prompt, currentAttachments);

			console.log('Sidekick: sending message', {
				prompt: fullPrompt.slice(0, 100),
				attachments: sdkAttachments,
				scopePaths: this.scopePaths,
			});

			await this.currentSession!.send({
				prompt: fullPrompt,
				...(sdkAttachments && sdkAttachments.length > 0 ? {attachments: sdkAttachments} : {}),
			});
		} catch (e) {
			this.finalizeStreamingMessage();
			this.addInfoMessage(`Error: ${String(e)}`);
		}
	}

	private async handleAbort(): Promise<void> {
		if (this.currentSession) {
			try {
				await this.currentSession.abort();
			} catch { /* ignore */ }
		}

		// If no content was streamed yet, replace "Thinking..." with "Cancelled"
		if (!this.streamingContent && this.streamingBodyEl) {
			this.streamingBodyEl.empty();
			this.streamingBodyEl.createDiv({cls: 'sidekick-thinking sidekick-cancelled', text: 'Cancelled'});
		}

		this.finalizeStreamingMessage();
	}

	// ── Session management ───────────────────────────────────────

	private async ensureSession(): Promise<void> {
		if (this.currentSession && !this.configDirty) return;

		// Tear down existing session
		if (this.currentSession) {
			this.unsubscribeEvents();
			try {
				await this.currentSession.destroy();
			} catch { /* ignore */ }
			this.currentSession = null;
		}

		const agent = this.agents.find(a => a.name === this.selectedAgent);
		const model = this.selectedModel || undefined;

		// System message from agent instructions
		let systemContent = '';
		if (agent?.instructions) {
			systemContent = agent.instructions;
		}

		// MCP servers — pass config through to the SDK, only defaulting required fields
		const mcpServers: Record<string, MCPServerConfig> = {};
		for (const server of this.mcpServers) {
			if (!this.enabledMcpServers.has(server.name)) continue;
			const cfg = server.config;
			const serverType = cfg['type'] as string | undefined;
			const tools = (cfg['tools'] as string[] | undefined) ?? ['*'];

			if (serverType === 'http' || serverType === 'sse') {
				mcpServers[server.name] = {
					type: serverType,
					url: cfg['url'] as string,
					tools,
					...(cfg['headers'] ? {headers: cfg['headers'] as Record<string, string>} : {}),
					...(cfg['timeout'] != null ? {timeout: cfg['timeout'] as number} : {}),
				} as MCPServerConfig;
			} else if (cfg['command']) {
				mcpServers[server.name] = {
					type: 'local',
					command: cfg['command'] as string,
					args: (cfg['args'] as string[] | undefined) ?? [],
					tools,
					...(cfg['env'] ? {env: cfg['env'] as Record<string, string>} : {}),
					...(cfg['cwd'] ? {cwd: cfg['cwd'] as string} : {}),
					...(cfg['timeout'] != null ? {timeout: cfg['timeout'] as number} : {}),
				} as MCPServerConfig;
			} else {
				console.warn(`Sidekick: skipping MCP server "${server.name}" — no type/url or command found`);
			}
		}

		if (Object.keys(mcpServers).length > 0) {
			console.log('Sidekick: configuring MCP servers:', Object.keys(mcpServers));
		}

		// Skills directories
		const basePath = this.getVaultBasePath();
		const skillDirs: string[] = [];
		if (this.skills.length > 0) {
			skillDirs.push(basePath + '/' + normalizePath(this.plugin.settings.skillsFolder));
		}
		const disabledSkills = this.skills
			.filter(s => !this.enabledSkills.has(s.name))
			.map(s => s.name);

		const permissionHandler = (request: PermissionRequest) => {
			if (this.plugin.settings.toolApproval === 'allow') {
				return approveAll(request, {sessionId: ''});
			}
			const modal = new ToolApprovalModal(this.app, request);
			modal.open();
			return modal.promise;
		};

		const sessionConfig: SessionConfig = {
			model,
			streaming: true,
			onPermissionRequest: permissionHandler,
			workingDirectory: this.getWorkingDirectory(),
			...(Object.keys(mcpServers).length > 0 ? {mcpServers} : {}),
			...(skillDirs.length > 0 ? {skillDirectories: skillDirs} : {}),
			...(disabledSkills.length > 0 ? {disabledSkills} : {}),
			...(systemContent ? {systemMessage: {mode: 'append' as const, content: systemContent}} : {}),
		};

		this.currentSession = await this.plugin.copilot!.createSession(sessionConfig);
		this.configDirty = false;
		this.registerSessionEvents();
	}

	private registerSessionEvents(): void {
		if (!this.currentSession) return;
		const session = this.currentSession;

		this.eventUnsubscribers.push(
			session.on('assistant.turn_start', () => {
				// Only record start time on the first turn of a streaming response
				if (this.turnStartTime === 0) {
					this.turnStartTime = Date.now();
				}
			}),
			session.on('assistant.message_delta', (event) => {
				this.appendDelta(event.data.deltaContent);
			}),
			session.on('assistant.message', () => {
				// Content already accumulated via deltas
			}),
			session.on('assistant.usage', (event) => {
				const d = event.data;
				// Accumulate usage across multiple calls in a turn
				if (!this.turnUsage) {
					this.turnUsage = {
						inputTokens: d.inputTokens ?? 0,
						outputTokens: d.outputTokens ?? 0,
						cacheReadTokens: d.cacheReadTokens ?? 0,
						cacheWriteTokens: d.cacheWriteTokens ?? 0,
						model: d.model,
					};
				} else {
					this.turnUsage.inputTokens += d.inputTokens ?? 0;
					this.turnUsage.outputTokens += d.outputTokens ?? 0;
					this.turnUsage.cacheReadTokens += d.cacheReadTokens ?? 0;
					this.turnUsage.cacheWriteTokens += d.cacheWriteTokens ?? 0;
					if (d.model) this.turnUsage.model = d.model;
				}
			}),
			session.on('session.idle', () => {
				this.finalizeStreamingMessage();
			}),
			session.on('session.error', (event) => {
				this.finalizeStreamingMessage();
				this.addInfoMessage(`Error: ${event.data.message}`);
			}),
			session.on('tool.execution_start', (event) => {
				console.log('Sidekick: tool.execution_start', event.data.toolName, event.data);
				this.turnToolsUsed.push(event.data.toolName);
				this.addToolCallBlock(event.data.toolCallId, event.data.toolName, event.data.arguments);
			}),
			session.on('tool.execution_complete', (event) => {
				this.completeToolCallBlock(
					event.data.toolCallId,
					event.data.success,
					event.data.result as {content?: string; detailedContent?: string} | undefined,
					event.data.error as {message: string} | undefined,
				);
			}),
			session.on('skill.invoked', (event) => {
				console.log('Sidekick: skill.invoked', event.data.name);
				this.turnSkillsUsed.push(event.data.name);
			}),
		);
	}

	private unsubscribeEvents(): void {
		for (const unsub of this.eventUnsubscribers) unsub();
		this.eventUnsubscribers = [];
	}

	private async destroySession(): Promise<void> {
		this.unsubscribeEvents();
		if (this.currentSession) {
			try {
				await this.currentSession.destroy();
			} catch { /* ignore */ }
			this.currentSession = null;
		}
	}

	private async newConversation(): Promise<void> {
		await this.destroySession();
		this.messages = [];
		this.streamingContent = '';
		this.streamingBodyEl = null;
		this.isStreaming = false;
		this.configDirty = true;
		this.attachments = [];
		this.scopePaths = [];

		this.chatContainer.empty();
		this.renderWelcome();
		this.renderAttachments();
		this.renderScopeBar();
		this.updateSendButton();
	}

	// ── Prompt & attachment building ─────────────────────────────

	private buildPrompt(basePrompt: string, attachments: ChatAttachment[]): string {
		let prompt = basePrompt;
		const clipboards = attachments.filter(a => a.type === 'clipboard');
		for (const clip of clipboards) {
			if (clip.content) {
				prompt += `\n\n---\nClipboard content:\n${clip.content}`;
			}
		}
		return prompt;
	}

	private buildSdkAttachments(attachments: ChatAttachment[]): MessageOptions['attachments'] {
		const basePath = this.getVaultBasePath();
		const result: NonNullable<MessageOptions['attachments']> = [];

		for (const att of attachments) {
			if ((att.type === 'file' || att.type === 'image') && att.path) {
				const filePath = att.absolutePath ? att.path : basePath + '/' + normalizePath(att.path);
				result.push({
					type: 'file',
					path: filePath,
					displayName: att.name,
				});
			} else if (att.type === 'directory' && att.path) {
				const dirPath = att.absolutePath ? att.path : basePath + '/' + normalizePath(att.path);
				result.push({
					type: 'directory',
					path: dirPath,
					displayName: att.name,
				});
			}
		}

		// Add vault scope paths (skip children if a parent folder is selected)
		const scopeSorted = [...this.scopePaths].sort((a, b) => a.length - b.length);
		const includedFolders: string[] = [];

		for (const scopePath of scopeSorted) {
			// Skip if an ancestor folder is already included
			const normalized = normalizePath(scopePath);
			const isChild = includedFolders.some(parent =>
				parent === '/' || normalized.startsWith(parent + '/')
			);
			if (isChild) continue;

			const absPath = scopePath === '/'
				? basePath
				: basePath + '/' + normalized;
			const displayName = scopePath === '/' ? this.app.vault.getName() : scopePath;
			const abstract = scopePath === '/'
				? this.app.vault.getRoot()
				: this.app.vault.getAbstractFileByPath(scopePath);

			if (abstract instanceof TFolder) {
				result.push({type: 'directory', path: absPath, displayName});
				includedFolders.push(normalized);
			} else if (abstract instanceof TFile) {
				result.push({type: 'file', path: absPath, displayName});
			}
		}

		return result.length > 0 ? result : undefined;
	}

	// ── Utilities ────────────────────────────────────────────────

	private getWorkingDirectory(): string {
		const base = this.getVaultBasePath();
		if (!this.workingDir) return base;
		return base + '/' + normalizePath(this.workingDir);
	}

	private openCwdPicker(): void {
		new FolderTreeModal(this.app, this.workingDir, (folder) => {
			this.workingDir = folder.path;
			this.updateCwdButton();
			this.configDirty = true;
		}).open();
	}

	private updateCwdButton(): void {
		const vaultName = this.app.vault.getName();
		const display = this.workingDir || '/';
		const label = `Working directory: ${vaultName}/${this.workingDir}`;
		this.cwdBtnEl.setAttribute('title', label);
		this.cwdBtnEl.toggleClass('is-active', true);
	}

	private getVaultBasePath(): string {
		return (this.app.vault.adapter as unknown as {basePath: string}).basePath;
	}

	private scrollToBottom(): void {
		// Only auto-scroll if user is near the bottom
		const threshold = 100;
		const isNear = this.chatContainer.scrollHeight - this.chatContainer.scrollTop - this.chatContainer.clientHeight < threshold;
		if (isNear) {
			window.requestAnimationFrame(() => {
				this.chatContainer.scrollTop = this.chatContainer.scrollHeight;
			});
		}
	}

	private async renderMarkdownSafe(content: string, container: HTMLElement): Promise<void> {
		try {
			const component = this.streamingComponent ?? this;
			await MarkdownRenderer.render(this.app, content, container, '', component);
		} catch {
			// Fallback to plain text
			container.setText(content);
		}
	}
}

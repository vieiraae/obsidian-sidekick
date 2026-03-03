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
	SessionMetadata,
	MCPServerConfig,
	ModelInfo,
	MessageOptions,
	PermissionRequest,
	PermissionRequestResult,
	ProviderConfig,
} from './copilot';
import type {AgentConfig, SkillInfo, McpServerEntry, PromptConfig, TriggerConfig, ChatMessage, ChatAttachment} from './types';
import {loadAgents, loadSkills, loadMcpServers, loadPrompts, loadTriggers} from './configLoader';
import {getAgentsFolder, getSkillsFolder, getToolsFolder, getPromptsFolder, getTriggersFolder} from './settings';
import {TriggerScheduler} from './triggerScheduler';
import type {TriggerFireContext} from './triggerScheduler';
import {VaultScopeModal} from './vaultScopeModal';
import {debugTrace, setDebugEnabled} from './debug';

export const SIDEKICK_VIEW_TYPE = 'sidekick-view';

/** State for a session that may be running in the background while the user views another session. */
interface BackgroundSession {
	sessionId: string;
	session: CopilotSession;
	messages: ChatMessage[];
	isStreaming: boolean;
	streamingContent: string;
	/** Preserved DOM from chat container when the session is hidden. */
	savedDom: DocumentFragment | null;
	/** Event unsubscribers for this session. */
	unsubscribers: (() => void)[];
	/** Turn-level metadata accumulated while streaming (even in background). */
	turnStartTime: number;
	turnToolsUsed: string[];
	turnSkillsUsed: string[];
	turnUsage: {inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; model?: string} | null;
	activeToolCalls: Map<string, {toolName: string; detailsEl: HTMLDetailsElement}>;
	/** Streaming component for Markdown rendering. */
	streamingComponent: Component | null;
	streamingBodyEl: HTMLElement | null;
	streamingWrapperEl: HTMLElement | null;
	toolCallsContainer: HTMLElement | null;
}

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
	private prompts: PromptConfig[] = [];
	private triggers: TriggerConfig[] = [];
	private triggerScheduler: TriggerScheduler | null = null;
	private activePrompt: PromptConfig | null = null;

	private selectedAgent = '';
	private selectedModel = '';
	private enabledSkills: Set<string> = new Set();
	private enabledMcpServers: Set<string> = new Set();
	private attachments: ChatAttachment[] = [];
	private activeNotePath: string | null = null;
	private scopePaths: string[] = [];
	private workingDir = '';  // vault-relative path, '' means vault root

	private isStreaming = false;
	private configDirty = true;
	private streamingContent = '';
	private renderScheduled = false;
	private showDebugInfo = false;
	/** Index up to which streamingContent has been fully re-rendered via Markdown. */
	private lastFullRenderLen = 0;
	/** Timer for periodic full markdown re-renders during streaming. */
	private fullRenderTimer: ReturnType<typeof setTimeout> | null = null;

	// ── Turn-level metadata ────────────────────────────────────
	private turnStartTime = 0;
	private turnToolsUsed: string[] = [];
	private turnSkillsUsed: string[] = [];
	private turnUsage: {inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; model?: string} | null = null;
	private activeToolCalls = new Map<string, {toolName: string; detailsEl: HTMLDetailsElement}>();

	// ── Session sidebar state ──────────────────────────────────
	private activeSessions = new Map<string, BackgroundSession>();
	private sessionList: SessionMetadata[] = [];
	private sessionNames: Record<string, string> = {};
	private currentSessionId: string | null = null;
	private sidebarWidth = 40;
	private sessionFilter = '';
	private sessionTypeFilter = new Set<'chat' | 'inline' | 'trigger' | 'other'>(['chat', 'trigger']);
	private sessionSort: 'modified' | 'created' | 'name' = 'modified';

	// ── DOM refs ─────────────────────────────────────────────────
	private mainEl!: HTMLElement;
	private chatContainer!: HTMLElement;
	private streamingBodyEl: HTMLElement | null = null;
	private toolCallsContainer: HTMLElement | null = null;
	private inputEl!: HTMLTextAreaElement;
	private attachmentsBar!: HTMLElement;
	private activeNoteBar!: HTMLElement;
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

	// ── Config file watcher ──────────────────────────────────────
	private configRefreshTimer: ReturnType<typeof setTimeout> | null = null;

	// ── Prompt dropdown DOM refs ─────────────────────────────────
	private promptDropdown: HTMLElement | null = null;
	private promptDropdownIndex = -1;

	// ── Session sidebar DOM refs ─────────────────────────────────
	private sidebarEl!: HTMLElement;
	private sidebarListEl!: HTMLElement;
	private sidebarSearchEl!: HTMLInputElement;
	private sidebarFilterEl!: HTMLButtonElement;
	private sidebarSortEl!: HTMLButtonElement;
	private sidebarRefreshEl!: HTMLButtonElement;
	private splitterEl!: HTMLElement;

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

		// Load session sidebar
		this.sessionNames = this.plugin.settings.sessionNames ?? {};
		void this.loadSessions();

		// Initialize trigger scheduler
		this.initTriggerScheduler();

		// Watch sidekick folder for config changes and auto-refresh
		this.registerConfigFileWatcher();

		// Track active note
		this.updateActiveNote();
		this.registerEvent(
			this.app.workspace.on('file-open', () => this.updateActiveNote())
		);
	}

	async onClose(): Promise<void> {
		if (this.configRefreshTimer) clearTimeout(this.configRefreshTimer);
		this.triggerScheduler?.stop();
		await this.destroyAllSessions();
	}

	// ── UI construction ──────────────────────────────────────────

	private buildUI(): void {
		const root = this.containerEl.children[1] as HTMLElement;
		root.empty();
		root.addClass('sidekick-root');

		// Main conversation area
		this.mainEl = root.createDiv({cls: 'sidekick-main'});

		// Chat history (scrollable)
		this.chatContainer = this.mainEl.createDiv({cls: 'sidekick-chat sidekick-hide-debug'});
		this.renderWelcome();

		// Bottom panel
		const bottom = this.mainEl.createDiv({cls: 'sidekick-bottom'});

		// Input area
		this.buildInputArea(bottom);

		// Config toolbar (agents, models, skills, tools, action buttons)
		this.buildConfigToolbar(bottom);

		// Splitter
		this.splitterEl = root.createDiv({cls: 'sidekick-splitter'});
		this.initSplitter();

		// Session sidebar
		this.buildSessionSidebar(root);
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
			this.inputEl.style.height = 'auto';
			this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 200) + 'px';
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
			const agent = this.agents.find(a => a.name === this.selectedAgent);
			// Auto-select agent's preferred model
			const resolvedModel = this.resolveModelForAgent(agent, this.selectedModel || undefined);
			if (resolvedModel && resolvedModel !== this.selectedModel) {
				this.selectedModel = resolvedModel;
				this.modelSelect.value = resolvedModel;
			}
			// Apply agent's tools and skills filter
			this.applyAgentToolsAndSkills(agent);
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
			setDebugEnabled(this.showDebugInfo);
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

	private async loadAllConfigs(options?: {silent?: boolean}): Promise<void> {
		try {
			// Parallel-load all config files (independent I/O)
			const [agents, skills, mcpServers, prompts, triggers] = await Promise.all([
				loadAgents(this.app, getAgentsFolder(this.plugin.settings)),
				loadSkills(this.app, getSkillsFolder(this.plugin.settings)),
				loadMcpServers(this.app, getToolsFolder(this.plugin.settings)),
				loadPrompts(this.app, getPromptsFolder(this.plugin.settings)),
				loadTriggers(this.app, getTriggersFolder(this.plugin.settings)),
			]);
			this.agents = agents;
			this.skills = skills;
			this.mcpServers = mcpServers;
			this.prompts = prompts;
			this.triggers = triggers;
			this.triggerScheduler?.setTriggers(this.triggers);

			// Enable all skills and tools by default (agent filter applied in updateConfigUI)
			this.enabledSkills = new Set(this.skills.map(s => s.name));
			this.enabledMcpServers = new Set(this.mcpServers.map(s => s.name));

			// Populate model list: BYOK direct providers don't need a copilot connection
			if (!options?.silent) {
				const preset = this.plugin.settings.providerPreset;
				const isByok = preset !== 'github';
				if (isByok && this.plugin.settings.providerModel) {
					const id = this.plugin.settings.providerModel;
					this.models = [{id, name: id} as ModelInfo];
				} else if (isByok) {
					// BYOK providers without a model name: keep existing list
				} else if (this.plugin.copilot) {
					try {
						this.models = await this.plugin.copilot.listModels();
					} catch {
						// silently ignore — models list stays empty
					}
				}
			}
		} catch (e) {
			console.error('Sidekick: failed to load configs', e);
		}

		this.updateConfigUI();
		this.configDirty = true;
		if (options?.silent) {
			new Notice('Configuration refreshed.');
		} else {
			new Notice(`Loaded ${this.agents.length} agent(s), ${this.models.length} model(s), ${this.skills.length} skill(s), ${this.mcpServers.length} tool server(s), ${this.prompts.length} prompt(s), ${this.triggers.length} trigger(s).`);
		}
	}

	/**
	 * Watch the sidekick folder for file changes and auto-refresh configs.
	 * Debounces rapid changes (e.g. multiple saves) into a single reload.
	 */
	private registerConfigFileWatcher(): void {
		const DEBOUNCE_MS = 500;

		const scheduleRefresh = (filePath: string) => {
			const base = normalizePath(this.plugin.settings.sidekickFolder);
			if (!filePath.startsWith(base + '/')) return;
			debugTrace(`Sidekick: config file changed: ${filePath}`);
			if (this.configRefreshTimer) clearTimeout(this.configRefreshTimer);
			this.configRefreshTimer = setTimeout(() => {
				this.configRefreshTimer = null;
				void this.loadAllConfigs({silent: true});
			}, DEBOUNCE_MS);
		};

		this.registerEvent(
			this.app.vault.on('modify', (file) => scheduleRefresh(file.path))
		);
		this.registerEvent(
			this.app.vault.on('create', (file) => scheduleRefresh(file.path))
		);
		this.registerEvent(
			this.app.vault.on('delete', (file) => scheduleRefresh(file.path))
		);
		this.registerEvent(
			this.app.vault.on('rename', (file, oldPath) => {
				scheduleRefresh(file.path);
				scheduleRefresh(oldPath);
			})
		);
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
		const resolvedModel = this.resolveModelForAgent(selectedAgentConfig, this.selectedModel || undefined);
		if (resolvedModel) {
			this.selectedModel = resolvedModel;
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

		// Apply agent's tools and skills filter
		const selectedAgentForFilter = this.agents.find(a => a.name === this.selectedAgent);
		this.applyAgentToolsAndSkills(selectedAgentForFilter);
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
		menu.addSeparator();
		const currentApproval = this.plugin.settings.toolApproval;
		menu.addItem(item => {
			item.setTitle('Approval mode');
			const sub: Menu = (item as unknown as {setSubmenu: () => Menu}).setSubmenu();
			sub.addItem(si => {
				si.setTitle('Allow (auto-approve)')
					.setChecked(currentApproval === 'allow')
					.onClick(async () => {
						this.plugin.settings.toolApproval = 'allow';
						await this.plugin.saveSettings();
					});
			});
			sub.addItem(si => {
				si.setTitle('Ask (require approval)')
					.setChecked(currentApproval === 'ask')
					.onClick(async () => {
						this.plugin.settings.toolApproval = 'ask';
						await this.plugin.saveSettings();
					});
			});
		});
		menu.showAtMouseEvent(e);
	}

	/**
	 * Apply the agent's tools and skills filter.
	 * If the agent specifies a list, enable only those.
	 * If the list is empty/undefined or the agent has no preference, enable all.
	 */
	private applyAgentToolsAndSkills(agent?: AgentConfig): void {
		// Tools
		if (agent?.tools && agent.tools.length > 0) {
			const allowed = new Set(agent.tools);
			this.enabledMcpServers = new Set(
				this.mcpServers.filter(s => allowed.has(s.name)).map(s => s.name)
			);
		} else {
			this.enabledMcpServers = new Set(this.mcpServers.map(s => s.name));
		}

		// Skills
		if (agent?.skills && agent.skills.length > 0) {
			const allowed = new Set(agent.skills);
			this.enabledSkills = new Set(
				this.skills.filter(s => allowed.has(s.name)).map(s => s.name)
			);
		} else {
			this.enabledSkills = new Set(this.skills.map(s => s.name));
		}

		this.updateSkillsBadge();
		this.updateToolsBadge();
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

	/** Set the vault scope programmatically and refresh the scope bar. */
	public setScope(paths: string[]): void {
		this.scopePaths = paths;
		this.renderScopeBar();
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

	private updateActiveNote(): void {
		const file = this.app.workspace.getActiveFile();
		this.activeNotePath = file ? file.path : null;
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
	}

	private renderActiveNoteBar(): void {
		this.activeNoteBar.empty();
		if (!this.activeNotePath) {
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
	}

	private handleAttachFile(): void {
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
				const {webUtils} = (globalThis.require as NodeRequire)('electron') as {webUtils?: {getPathForFile: (f: File) => string}};
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

			if (!this.app.vault.getAbstractFileByPath(folder)) {
				await this.app.vault.createFolder(folder);
			}

			const filePath = normalizePath(`${folder}/${name}`);
			await this.app.vault.createBinary(filePath, buffer);

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

	// ── Prompt slash-command dropdown ─────────────────────────────

	private handlePromptTrigger(): void {
		const value = this.inputEl.value;
		// Trigger only when text starts with "/" (no space before the slash)
		if (!value.startsWith('/') || value.includes(' ')) {
			this.closePromptDropdown();
			return;
		}
		const query = value.slice(1).toLowerCase();
		const filtered = this.prompts.filter(p => p.name.toLowerCase().includes(query));
		if (filtered.length === 0) {
			this.closePromptDropdown();
			return;
		}
		this.showPromptDropdown(filtered);
	}

	private showPromptDropdown(prompts: PromptConfig[]): void {
		this.closePromptDropdown();
		this.promptDropdown = document.createElement('div');
		this.promptDropdown.addClass('sidekick-prompt-dropdown');
		this.promptDropdownIndex = 0;

		for (let i = 0; i < prompts.length; i++) {
			const p = prompts[i];
			if (!p) continue;
			const item = this.promptDropdown.createDiv({cls: 'sidekick-prompt-item'});
			if (i === 0) item.addClass('is-selected');

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
	}

	private closePromptDropdown(): void {
		if (this.promptDropdown) {
			this.promptDropdown.remove();
			this.promptDropdown = null;
			this.promptDropdownIndex = -1;
		}
	}

	private navigatePromptDropdown(direction: number): void {
		if (!this.promptDropdown) return;
		const items = this.promptDropdown.querySelectorAll('.sidekick-prompt-item');
		if (items.length === 0) return;
		this.promptDropdownIndex = (this.promptDropdownIndex + direction + items.length) % items.length;
		this.updatePromptDropdownSelection();
	}

	private updatePromptDropdownSelection(): void {
		if (!this.promptDropdown) return;
		const items = this.promptDropdown.querySelectorAll('.sidekick-prompt-item');
		items.forEach((el, i) => {
			el.toggleClass('is-selected', i === this.promptDropdownIndex);
		});
	}

	private selectPromptFromDropdown(): void {
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
			const matchingAgent = this.agents.find(a => a.name === selected.agent);
			if (matchingAgent) {
				this.selectedAgent = matchingAgent.name;
				this.agentSelect.value = matchingAgent.name;
				const resolvedModel = this.resolveModelForAgent(matchingAgent, this.selectedModel || undefined);
				if (resolvedModel && resolvedModel !== this.selectedModel) {
					this.selectedModel = resolvedModel;
					this.modelSelect.value = resolvedModel;
				}
				this.configDirty = true;
			}
		}

		// Replace input with /prompt-name + space
		this.inputEl.value = `/${selected.name} `;
		this.inputEl.style.height = 'auto';
		this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 200) + 'px';
		this.inputEl.focus();
		this.closePromptDropdown();
	}

	// ── Session sidebar ──────────────────────────────────────────

	private buildSessionSidebar(parent: HTMLElement): void {
		this.sidebarEl = parent.createDiv({cls: 'sidekick-sidebar'});
		this.sidebarEl.style.width = `${this.sidebarWidth}px`;

		// Header: new session button + filter + sort + search
		const header = this.sidebarEl.createDiv({cls: 'sidekick-sidebar-header'});

		const headerBtnRow = header.createDiv({cls: 'sidekick-sidebar-btn-row'});

		const newBtn = headerBtnRow.createEl('button', {
			cls: 'clickable-icon sidekick-icon-btn sidekick-sidebar-new-btn',
			attr: {title: 'New session'},
		});
		setIcon(newBtn, 'plus');
		newBtn.addEventListener('click', () => void this.newConversation());

		this.sidebarFilterEl = headerBtnRow.createEl('button', {
			cls: 'clickable-icon sidekick-sidebar-filter-btn',
			attr: {title: 'Filter sessions by type'},
		});
		setIcon(this.sidebarFilterEl, 'filter');
		this.sidebarFilterEl.addEventListener('click', (e) => this.openSessionFilterMenu(e));
		this.updateFilterBadge();

		this.sidebarSortEl = headerBtnRow.createEl('button', {
			cls: 'clickable-icon sidekick-sidebar-sort-btn',
			attr: {title: 'Sort sessions'},
		});
		setIcon(this.sidebarSortEl, 'arrow-up-down');
		this.sidebarSortEl.addEventListener('click', (e) => this.openSessionSortMenu(e));
		this.updateSortBadge();

		this.sidebarRefreshEl = headerBtnRow.createEl('button', {
			cls: 'clickable-icon sidekick-sidebar-refresh-btn',
			attr: {title: 'Refresh sessions'},
		});
		setIcon(this.sidebarRefreshEl, 'refresh-cw');
		this.sidebarRefreshEl.addEventListener('click', () => void this.loadSessions());

		this.sidebarSearchEl = header.createEl('input', {
			type: 'text',
			placeholder: 'Search…',
			cls: 'sidekick-sidebar-search',
		});
		this.sidebarSearchEl.addEventListener('input', () => {
			this.sessionFilter = this.sidebarSearchEl.value.toLowerCase();
			this.renderSessionList();
		});

		// Session list (scrollable)
		this.sidebarListEl = this.sidebarEl.createDiv({cls: 'sidekick-sidebar-list'});
	}

	private initSplitter(): void {
		let startX = 0;
		let startWidth = 0;
		let dragging = false;

		const onMouseMove = (e: MouseEvent) => {
			if (!dragging) return;
			// Sidebar is on the right, so dragging left increases width
			const dx = startX - e.clientX;
			const newWidth = Math.max(40, Math.min(300, startWidth + dx));
			this.sidebarWidth = newWidth;
			this.sidebarEl.style.width = `${newWidth}px`;
		};

		const onMouseUp = () => {
			dragging = false;
			document.removeEventListener('mousemove', onMouseMove);
			document.removeEventListener('mouseup', onMouseUp);
			this.splitterEl.removeClass('is-dragging');
			document.body.removeClass('sidekick-no-select');
			// Re-render session list once on drag end instead of every mousemove
			this.renderSessionList();
		};

		this.splitterEl.addEventListener('mousedown', (e) => {
			e.preventDefault();
			dragging = true;
			startX = e.clientX;
			startWidth = this.sidebarWidth;
			this.splitterEl.addClass('is-dragging');
			document.body.addClass('sidekick-no-select');
			document.addEventListener('mousemove', onMouseMove);
			document.addEventListener('mouseup', onMouseUp);
		});

		this.register(() => {
			document.removeEventListener('mousemove', onMouseMove);
			document.removeEventListener('mouseup', onMouseUp);
		});
	}

	private async loadSessions(): Promise<void> {
		if (!this.plugin.copilot) return;
		try {
			this.sessionList = await this.plugin.copilot.listSessions();
			this.sortSessionList();
			this.renderSessionList();
		} catch {
			// silently ignore — session list stays as-is
		}
	}

	private sortSessionList(): void {
		switch (this.sessionSort) {
			case 'modified':
				this.sessionList.sort((a, b) => {
					const ta = a.modifiedTime instanceof Date ? a.modifiedTime.getTime() : new Date(a.modifiedTime).getTime();
					const tb = b.modifiedTime instanceof Date ? b.modifiedTime.getTime() : new Date(b.modifiedTime).getTime();
					return tb - ta;
				});
				break;
			case 'created':
				this.sessionList.sort((a, b) => {
					const ta = a.startTime instanceof Date ? a.startTime.getTime() : new Date(a.startTime).getTime();
					const tb = b.startTime instanceof Date ? b.startTime.getTime() : new Date(b.startTime).getTime();
					return tb - ta;
				});
				break;
			case 'name':
				this.sessionList.sort((a, b) => {
					const na = this.getSessionDisplayName(a).toLowerCase();
					const nb = this.getSessionDisplayName(b).toLowerCase();
					return na.localeCompare(nb);
				});
				break;
		}
	}

	private renderSessionList(): void {
		if (!this.sidebarListEl) return;
		this.sidebarListEl.empty();

		const isExpanded = this.sidebarWidth > 80;
		// Show/hide search and filter/sort/refresh when collapsed
		if (this.sidebarSearchEl) {
			this.sidebarSearchEl.toggleClass('is-hidden', !isExpanded);
		}
		if (this.sidebarFilterEl) {
			this.sidebarFilterEl.toggleClass('is-hidden', !isExpanded);
		}
		if (this.sidebarSortEl) {
			this.sidebarSortEl.toggleClass('is-hidden', !isExpanded);
		}
		if (this.sidebarRefreshEl) {
			this.sidebarRefreshEl.toggleClass('is-hidden', !isExpanded);
		}

		for (const session of this.sessionList) {
			// Apply type filter
			if (this.sessionTypeFilter.size > 0) {
				const type = this.getSessionType(session);
				if (!this.sessionTypeFilter.has(type)) continue;
			}

			const name = this.getSessionDisplayName(session);
			if (this.sessionFilter && !name.toLowerCase().includes(this.sessionFilter)) continue;

			const item = this.sidebarListEl.createDiv({cls: 'sidekick-session-item'});
			const isActive = session.sessionId === this.currentSessionId;
			if (isActive) item.addClass('is-active');

			const sessionType = this.getSessionType(session);
			const iconName = sessionType === 'chat' ? 'message-square' : sessionType === 'trigger' ? 'zap' : sessionType === 'inline' ? 'file-text' : 'code';
			const iconEl = item.createSpan({cls: 'sidekick-session-icon'});
			setIcon(iconEl, iconName);

			// Green active dot when processing (current or background session)
			const isCurrentStreaming = isActive && this.isStreaming;
			const bgSession = this.activeSessions.get(session.sessionId);
			const isBgStreaming = bgSession?.isStreaming ?? false;
			if (isCurrentStreaming || isBgStreaming) {
				iconEl.createSpan({cls: 'sidekick-session-active-dot'});
			}

			if (isExpanded) {
				const details = item.createDiv({cls: 'sidekick-session-details'});
				details.createDiv({cls: 'sidekick-session-name', text: name});
				const modTime = session.modifiedTime instanceof Date
					? session.modifiedTime
					: new Date(session.modifiedTime);
				details.createDiv({cls: 'sidekick-session-time', text: this.formatTimeAgo(modTime)});
			}

			item.setAttribute('title', name);
			item.addEventListener('click', () => void this.selectSession(session.sessionId));
			item.addEventListener('contextmenu', (e) => this.showSessionContextMenu(e, session.sessionId));
		}
	}

	private getSessionDisplayName(session: SessionMetadata): string {
		const raw = this.sessionNames[session.sessionId]
			|| session.summary
			|| `Session ${session.sessionId.slice(0, 8)}`;
		// Strip session type prefix for display
		return raw.replace(/^\[(chat|inline|trigger)\]\s*/, '');
	}

	/** Return the session type prefix: 'chat', 'inline', 'trigger', or 'other'. */
	private getSessionType(session: SessionMetadata): 'chat' | 'inline' | 'trigger' | 'other' {
		const name = this.sessionNames[session.sessionId] || '';
		debugTrace(`Sidekick: getSessionType id=${session.sessionId.slice(0, 8)} name="${name.slice(0, 40)}"`);
		if (name.startsWith('[chat]')) return 'chat';
		if (name.startsWith('[inline]')) return 'inline';
		if (name.startsWith('[trigger]')) return 'trigger';
		return 'other';
	}

	private openSessionFilterMenu(e: MouseEvent): void {
		const menu = new Menu();
		const types: Array<{value: 'chat' | 'inline' | 'trigger' | 'other'; label: string}> = [
			{value: 'chat', label: 'Chat'},
			{value: 'trigger', label: 'Triggers'},
			{value: 'inline', label: 'Inline'},
			{value: 'other', label: 'Other'},
		];
		for (const {value, label} of types) {
			menu.addItem(item => {
				item.setTitle(label)
					.setChecked(this.sessionTypeFilter.has(value))
					.onClick(() => {
						if (this.sessionTypeFilter.has(value)) {
							this.sessionTypeFilter.delete(value);
						} else {
							this.sessionTypeFilter.add(value);
						}
						this.updateFilterBadge();
						this.renderSessionList();
					});
			});
		}
		menu.addSeparator();
		menu.addItem(item => {
			item.setTitle('Show all')
				.onClick(() => {
					this.sessionTypeFilter.clear();
					this.updateFilterBadge();
					this.renderSessionList();
				});
		});
		menu.showAtMouseEvent(e);
	}

	private updateFilterBadge(): void {
		// When no types selected (show all), dim the icon; otherwise mark active
		const hasFilter = this.sessionTypeFilter.size > 0;
		this.sidebarFilterEl.toggleClass('is-active', hasFilter);
		this.sidebarFilterEl.setAttribute('title',
			hasFilter
				? `Filter: ${[...this.sessionTypeFilter].join(', ')}`
				: 'Filter sessions (showing all)');
	}

	private openSessionSortMenu(e: MouseEvent): void {
		const menu = new Menu();
		const sorts: Array<{value: 'modified' | 'created' | 'name'; label: string}> = [
			{value: 'modified', label: 'Modified date'},
			{value: 'created', label: 'Created date'},
			{value: 'name', label: 'Name'},
		];
		for (const {value, label} of sorts) {
			menu.addItem(item => {
				item.setTitle(label)
					.setChecked(this.sessionSort === value)
					.onClick(() => {
						this.sessionSort = value;
						this.updateSortBadge();
						this.sortSessionList();
						this.renderSessionList();
					});
			});
		}
		menu.showAtMouseEvent(e);
	}

	private updateSortBadge(): void {
		const labels: Record<string, string> = {modified: 'Modified', created: 'Created', name: 'Name'};
		this.sidebarSortEl.setAttribute('title', `Sort: ${labels[this.sessionSort]}`);
	}

	/**
	 * Public API: register an inline session so it appears in the sidebar.
	 * Called by editorMenu after completing an inline operation.
	 */
	public registerInlineSession(sessionId: string, description: string): void {
		this.sessionNames[sessionId] = `[inline] ${description}`;
		this.saveSessionNames();

		// Add to session list immediately so sidebar updates
		if (!this.sessionList.some(s => s.sessionId === sessionId)) {
			const now = new Date();
			this.sessionList.unshift({
				sessionId,
				startTime: now,
				modifiedTime: now,
				isRemote: false,
			} as SessionMetadata);
		}
		this.renderSessionList();
	}

	// ── Background session management ────────────────────────────

	/**
	 * Save the currently viewed session into the activeSessions map.
	 * If the session is streaming, events keep routing to the BackgroundSession.
	 * If idle, the session handle is preserved for quick switching.
	 */
	private saveCurrentToBackground(): void {
		if (!this.currentSession || !this.currentSessionId) return;

		// Evict the oldest idle background session if at capacity
		const MAX_BACKGROUND_SESSIONS = 8;
		if (this.activeSessions.size >= MAX_BACKGROUND_SESSIONS) {
			let oldestKey: string | null = null;
			let oldestTime = Infinity;
			for (const [key, bg] of this.activeSessions) {
				if (bg.isStreaming) continue; // don't evict active streams
				const entry = this.sessionList.find(s => s.sessionId === key);
				const t = entry?.modifiedTime instanceof Date
					? entry.modifiedTime.getTime()
					: entry ? new Date(entry.modifiedTime).getTime() : 0;
				if (t < oldestTime) {
					oldestTime = t;
					oldestKey = key;
				}
			}
			if (oldestKey) {
				const evicted = this.activeSessions.get(oldestKey);
				if (evicted) {
					for (const unsub of evicted.unsubscribers) unsub();
					evicted.savedDom = null; // release DOM fragment
					try { void evicted.session.destroy(); } catch { /* ignore */ }
					this.activeSessions.delete(oldestKey);
				}
			}
		}

		// Detach events from foreground routing
		this.unsubscribeEvents();

		// Save chat DOM into a DocumentFragment for fast restore
		const fragment = document.createDocumentFragment();
		while (this.chatContainer.firstChild) {
			fragment.appendChild(this.chatContainer.firstChild);
		}

		const bg: BackgroundSession = {
			sessionId: this.currentSessionId,
			session: this.currentSession,
			messages: [...this.messages],
			isStreaming: this.isStreaming,
			streamingContent: this.streamingContent,
			savedDom: fragment,
			unsubscribers: [],
			turnStartTime: this.turnStartTime,
			turnToolsUsed: [...this.turnToolsUsed],
			turnSkillsUsed: [...this.turnSkillsUsed],
			turnUsage: this.turnUsage ? {...this.turnUsage} : null,
			activeToolCalls: new Map(this.activeToolCalls),
			streamingComponent: this.streamingComponent,
			streamingBodyEl: this.streamingBodyEl,
			streamingWrapperEl: this.streamingWrapperEl,
			toolCallsContainer: this.toolCallsContainer,
		};

		// If still streaming, attach background event routing
		if (bg.isStreaming) {
			this.registerBackgroundEvents(bg);
		}

		this.activeSessions.set(this.currentSessionId, bg);

		// Detach streaming component from the view (it lives in the bg now)
		if (this.streamingComponent) {
			this.streamingComponent = null;
		}
		this.currentSession = null;
		this.currentSessionId = null;
	}

	/**
	 * Restore a BackgroundSession as the foreground session.
	 */
	private restoreFromBackground(bg: BackgroundSession): void {
		// Unsubscribe background event routing
		for (const unsub of bg.unsubscribers) unsub();
		bg.unsubscribers = [];

		// Restore state
		this.currentSession = bg.session;
		this.currentSessionId = bg.sessionId;
		this.messages = bg.messages;
		this.isStreaming = bg.isStreaming;
		this.streamingContent = bg.streamingContent;
		this.turnStartTime = bg.turnStartTime;
		this.turnToolsUsed = bg.turnToolsUsed;
		this.turnSkillsUsed = bg.turnSkillsUsed;
		this.turnUsage = bg.turnUsage;
		this.configDirty = false;

		this.chatContainer.empty();

		if (bg.isStreaming && bg.savedDom) {
			// Session is still streaming — restore its live DOM (including streaming placeholder)
			this.streamingComponent = bg.streamingComponent;
			this.streamingBodyEl = bg.streamingBodyEl;
			this.streamingWrapperEl = bg.streamingWrapperEl;
			this.toolCallsContainer = bg.toolCallsContainer;
			this.activeToolCalls = bg.activeToolCalls;
			this.chatContainer.appendChild(bg.savedDom);
			bg.savedDom = null;
			// Re-render the streaming content that accumulated while in background
			if (this.streamingContent && this.streamingBodyEl) {
				void this.updateStreamingRender();
			}
		} else {
			// Session finished while in background — re-render messages from scratch
			this.streamingComponent = null;
			this.streamingBodyEl = null;
			this.streamingWrapperEl = null;
			this.toolCallsContainer = null;
			this.activeToolCalls.clear();
			for (const msg of this.messages) {
				this.renderMessageBubble(msg);
			}
			if (this.messages.length === 0) {
				this.renderWelcome();
			}
		}

		// Re-attach foreground event routing
		this.registerSessionEvents();

		// Remove from background map
		this.activeSessions.delete(bg.sessionId);

		// Restore agent from session name
		this.restoreAgentFromSessionName(bg.sessionId);

		// Force scroll to end
		window.requestAnimationFrame(() => {
			this.chatContainer.scrollTop = this.chatContainer.scrollHeight;
		});
	}

	/**
	 * Register event handlers that route session events into a BackgroundSession
	 * object while the session is not being viewed.
	 */
	private registerBackgroundEvents(bg: BackgroundSession): void {
		const session = bg.session;

		bg.unsubscribers.push(
			session.on('assistant.turn_start', () => {
				if (bg.turnStartTime === 0) bg.turnStartTime = Date.now();
			}),
			session.on('assistant.message_delta', (event) => {
				bg.streamingContent += event.data.deltaContent;
				// No DOM rendering — session is hidden
			}),
			session.on('assistant.message', () => { /* accumulated via deltas */ }),
			session.on('assistant.usage', (event) => {
				const d = event.data;
				if (!bg.turnUsage) {
					bg.turnUsage = {
						inputTokens: d.inputTokens ?? 0,
						outputTokens: d.outputTokens ?? 0,
						cacheReadTokens: d.cacheReadTokens ?? 0,
						cacheWriteTokens: d.cacheWriteTokens ?? 0,
						model: d.model,
					};
				} else {
					bg.turnUsage.inputTokens += d.inputTokens ?? 0;
					bg.turnUsage.outputTokens += d.outputTokens ?? 0;
					bg.turnUsage.cacheReadTokens += d.cacheReadTokens ?? 0;
					bg.turnUsage.cacheWriteTokens += d.cacheWriteTokens ?? 0;
					if (d.model) bg.turnUsage.model = d.model;
				}
			}),
			session.on('session.idle', () => {
				// Finalize the background streaming turn
				if (bg.streamingContent) {
					bg.messages.push({
						id: `a-${Date.now()}`,
						role: 'assistant',
						content: bg.streamingContent,
						timestamp: Date.now(),
					});
				}
				bg.streamingContent = '';
				bg.streamingBodyEl = null;
				bg.streamingWrapperEl = null;
				bg.toolCallsContainer = null;
				bg.activeToolCalls.clear();
				bg.streamingComponent = null;
				bg.turnStartTime = 0;
				bg.turnToolsUsed = [];
				bg.turnSkillsUsed = [];
				bg.turnUsage = null;
				bg.isStreaming = false;
				// Re-render sidebar to remove the green dot
				this.renderSessionList();
				void this.loadSessions();
			}),
			session.on('session.error', (event) => {
				bg.messages.push({
					id: `i-${Date.now()}`,
					role: 'info',
					content: `Error: ${event.data.message}`,
					timestamp: Date.now(),
				});
				bg.isStreaming = false;
				bg.streamingContent = '';
				bg.streamingBodyEl = null;
				bg.streamingWrapperEl = null;
				bg.toolCallsContainer = null;
				bg.activeToolCalls.clear();
				bg.streamingComponent = null;
				this.renderSessionList();
			}),
			session.on('tool.execution_start', (event) => {
				bg.turnToolsUsed.push(event.data.toolName);
				// No DOM manipulation — hidden session
			}),
			session.on('tool.execution_complete', () => {
				// No DOM manipulation — hidden session
			}),
			session.on('skill.invoked', (event) => {
				bg.turnSkillsUsed.push(event.data.name);
			}),
		);
	}

	/**
	 * Restore the agent and model dropdowns from a session's saved name.
	 */
	private restoreAgentFromSessionName(sessionId: string): void {
		let sessionName = this.sessionNames[sessionId] || '';
		// Strip session type prefix
		sessionName = sessionName.replace(/^\[(chat|inline|trigger)\]\s*/, '');
		const colonIdx = sessionName.indexOf(':');
		if (colonIdx > 0) {
			const agentName = sessionName.substring(0, colonIdx).trim();
			const matchingAgent = this.agents.find(a => a.name === agentName);
			if (matchingAgent) {
				this.selectedAgent = matchingAgent.name;
				this.agentSelect.value = matchingAgent.name;
				const resolvedModel = this.resolveModelForAgent(matchingAgent, this.selectedModel || undefined);
				if (resolvedModel && resolvedModel !== this.selectedModel) {
					this.selectedModel = resolvedModel;
					this.modelSelect.value = resolvedModel;
				}
			}
		}
	}

	private async selectSession(sessionId: string): Promise<void> {
		if (sessionId === this.currentSessionId && this.currentSession) return;

		// ── Save current session to background (if streaming, keep it alive) ──
		if (this.currentSession && this.currentSessionId) {
			this.saveCurrentToBackground();
		}

		// Clear UI for the new session
		this.messages = [];
		this.streamingContent = '';
		this.streamingBodyEl = null;
		this.streamingWrapperEl = null;
		this.toolCallsContainer = null;
		this.activeToolCalls.clear();
		if (this.streamingComponent) {
			this.removeChild(this.streamingComponent);
			this.streamingComponent = null;
		}
		this.isStreaming = false;
		this.chatContainer.empty();

		// ── Check if the target session is already alive in background ──
		const bg = this.activeSessions.get(sessionId);
		if (bg) {
			this.restoreFromBackground(bg);
			this.renderSessionList();
			this.updateSendButton();
			return;
		}

		// ── Otherwise, resume from SDK (cold load) ──

		try {
			// Build full session config so skills, MCP servers, etc. are available
			const agent = this.agents.find(a => a.name === this.selectedAgent);
			const sessionConfig = this.buildSessionConfig({
				model: this.selectedModel || undefined,
				systemContent: agent?.instructions || undefined,
			});

			this.currentSession = await this.plugin.copilot!.resumeSession(sessionId, {
				...sessionConfig,
			});
			this.currentSessionId = sessionId;
			this.configDirty = false;
			this.registerSessionEvents();

			// Load and render message history from SDK
			const events = await this.currentSession.getMessages();
			for (const event of events) {
				if (event.type === 'user.message') {
					const msg: ChatMessage = {
						id: event.id,
						role: 'user',
						content: event.data.content,
						timestamp: new Date(event.timestamp).getTime(),
					};
					this.messages.push(msg);
					this.renderMessageBubble(msg);
				} else if (event.type === 'assistant.message') {
					const msg: ChatMessage = {
						id: event.id,
						role: 'assistant',
						content: event.data.content,
						timestamp: new Date(event.timestamp).getTime(),
					};
					this.messages.push(msg);
					this.renderMessageBubble(msg);
				}
			}

			if (this.messages.length === 0) {
				this.renderWelcome();
			}

			// Restore the agent that was used in this session
			this.restoreAgentFromSessionName(sessionId);

			// Force scroll to the end of the loaded conversation
			window.requestAnimationFrame(() => {
				this.chatContainer.scrollTop = this.chatContainer.scrollHeight;
			});

			this.renderSessionList();
			this.updateSendButton();
		} catch (e) {
			this.addInfoMessage(`Failed to load session: ${String(e)}`);
			this.renderWelcome();
			this.currentSessionId = null;
			this.renderSessionList();
		}
	}

	private showSessionContextMenu(e: MouseEvent, sessionId: string): void {
		e.preventDefault();
		e.stopPropagation();
		const menu = new Menu();

		menu.addItem(item => item
			.setTitle('Rename')
			.setIcon('pencil')
			.onClick(() => this.renameSession(sessionId)));

		menu.addItem(item => item
			.setTitle('Delete')
			.setIcon('trash-2')
			.onClick(() => void this.deleteSessionById(sessionId)));

		menu.showAtMouseEvent(e);
	}

	private renameSession(sessionId: string): void {
		const rawName = this.sessionNames[sessionId] || '';
		// Extract prefix and display name
		const prefixMatch = rawName.match(/^(\[(chat|inline|trigger)\]\s*)/);
		const prefix = prefixMatch ? prefixMatch[1] : '';
		const displayName = prefix ? rawName.slice(prefix.length) : rawName;

		const modal = new Modal(this.app);
		modal.titleEl.setText('Rename session');

		const input = modal.contentEl.createEl('input', {
			type: 'text',
			value: displayName,
			cls: 'sidekick-rename-input',
		});


		const btnRow = modal.contentEl.createDiv({cls: 'sidekick-approval-buttons'});
		const saveBtn = btnRow.createEl('button', {cls: 'mod-cta', text: 'Save'});
		saveBtn.addEventListener('click', () => {
			const newName = input.value.trim();
			if (newName) {
				this.sessionNames[sessionId] = `${prefix}${newName}`;
				this.saveSessionNames();
				this.renderSessionList();
			}
			modal.close();
		});

		const cancelBtn = btnRow.createEl('button', {text: 'Cancel'});
		cancelBtn.addEventListener('click', () => modal.close());

		// Enter key to save
		input.addEventListener('keydown', (ke) => {
			if (ke.key === 'Enter') {
				ke.preventDefault();
				saveBtn.click();
			}
		});

		modal.open();
		input.focus();
		input.select();
	}

	private async deleteSessionById(sessionId: string): Promise<void> {
		// Clean up background session if it exists
		const bg = this.activeSessions.get(sessionId);
		if (bg) {
			for (const unsub of bg.unsubscribers) unsub();
			try { await bg.session.destroy(); } catch { /* ignore */ }
			if (bg.streamingComponent) {
				try { this.removeChild(bg.streamingComponent); } catch { /* ignore */ }
			}
			this.activeSessions.delete(sessionId);
		}

		try {
			await this.plugin.copilot!.deleteSession(sessionId);
		} catch (e) {
			new Notice(`Failed to delete session: ${String(e)}`);
			return;
		}

		delete this.sessionNames[sessionId];
		this.saveSessionNames();
		this.sessionList = this.sessionList.filter(s => s.sessionId !== sessionId);

		if (this.currentSessionId === sessionId) {
			this.currentSessionId = null;
			this.currentSession = null;
			await this.newConversation();
		}

		this.renderSessionList();
		new Notice('Session deleted.');
	}

	private saveSessionNames(): void {
		this.plugin.settings.sessionNames = {...this.sessionNames};
		void this.plugin.saveSettings();
	}

	private formatTimeAgo(d: Date): string {
		const now = Date.now();
		const diff = now - d.getTime();
		const minutes = Math.floor(diff / 60000);
		const hours = Math.floor(diff / 3600000);
		const days = Math.floor(diff / 86400000);

		if (minutes < 1) return 'Just now';
		if (minutes < 60) return `${minutes}m ago`;
		if (hours < 24) return `${hours}h ago`;
		if (days === 1) return 'Yesterday';
		if (days < 7) return `${days}d ago`;
		return d.toLocaleDateString();
	}

	// ── Trigger scheduler ───────────────────────────────────────

	/**
	 * Set up the trigger scheduler for cron-based and file-change-based triggers.
	 * Called once during onOpen after configs are loaded.
	 */
	private initTriggerScheduler(): void {
		this.triggerScheduler = new TriggerScheduler({
			onTriggerFire: (trigger, context) => void this.fireTriggerInBackground(trigger, context),
			getLastFired: (key) => this.plugin.settings.triggerLastFired?.[key] ?? 0,
			setLastFired: (key, ts) => {
				if (!this.plugin.settings.triggerLastFired) {
					this.plugin.settings.triggerLastFired = {};
				}
				this.plugin.settings.triggerLastFired[key] = ts;
				void this.plugin.saveSettings();
			},
		});
		this.triggerScheduler.setTriggers(this.triggers);
		const intervalId = this.triggerScheduler.start();
		this.registerInterval(intervalId);

		// File change events for onFileChange triggers
		const sidekickFolder = normalizePath(this.plugin.settings.sidekickFolder);
		this.registerEvent(
			this.app.vault.on('modify', (file) => {
				if (!(file instanceof TFile)) return;
				if (file.path.startsWith(sidekickFolder + '/') || file.path.startsWith('.sidekick-attachments/')) {
					debugTrace(`Sidekick: ignoring modify in excluded folder: ${file.path}`);
					return;
				}
				debugTrace(`Sidekick: vault modify event: ${file.path}`);
				this.triggerScheduler?.checkFileChangeTriggers(file.path);
			})
		);
		this.registerEvent(
			this.app.vault.on('create', (file) => {
				if (!(file instanceof TFile)) return;
				if (file.path.startsWith(sidekickFolder + '/') || file.path.startsWith('.sidekick-attachments/')) return;
				debugTrace(`Sidekick: vault create event: ${file.path}`);
				this.triggerScheduler?.checkFileChangeTriggers(file.path);
			})
		);
		this.registerEvent(
			this.app.vault.on('rename', (file, oldPath) => {
				if (!(file instanceof TFile)) return;
				if (file.path.startsWith(sidekickFolder + '/') || file.path.startsWith('.sidekick-attachments/')) return;
				debugTrace(`Sidekick: vault rename event: ${oldPath} → ${file.path}`);
				this.triggerScheduler?.checkFileChangeTriggers(file.path);
			})
		);
	}

	/**
	 * Fire a trigger as a background session.
	 * Creates a new SDK session with the trigger's agent, names it "Trigger: <description>",
	 * sends the trigger content as the user prompt, and routes all events to a BackgroundSession.
	 */
	private async fireTriggerInBackground(trigger: TriggerConfig, context?: TriggerFireContext): Promise<void> {
		if (!this.plugin.copilot) {
			return;
		}

		try {
			// Resolve agent and model
			const agent = trigger.agent ? this.agents.find(a => a.name === trigger.agent) : undefined;
			const model = this.resolveModelForAgent(agent, this.selectedModel || undefined);

			// System message from agent instructions
			const systemContent = agent?.instructions || undefined;

			const sessionConfig = this.buildSessionConfig({model, systemContent});

			const session = await this.plugin.copilot.createSession(sessionConfig);
			const sessionId = session.sessionId;

			// Name the session: [trigger] <agent>: <content truncated>
			const agentName = trigger.agent || 'Chat';
			const truncatedContent = trigger.content.length > 40 ? trigger.content.slice(0, 40) + '…' : trigger.content;
			const sessionName = `[trigger] ${agentName}: ${truncatedContent}`;
			this.sessionNames[sessionId] = sessionName;
			this.saveSessionNames();

			// Build prompt (augment with file path for file-change triggers)
			let prompt = trigger.content;
			if (context?.filePath) {
				prompt = `[File changed: ${context.filePath}]\n\n${trigger.content}`;
			}

			// Create background session
			const bg: BackgroundSession = {
				sessionId,
				session,
				messages: [{
					id: `u-${Date.now()}`,
					role: 'user',
					content: prompt,
					timestamp: Date.now(),
				}],
				isStreaming: true,
				streamingContent: '',
				savedDom: null,
				unsubscribers: [],
				turnStartTime: Date.now(),
				turnToolsUsed: [],
				turnSkillsUsed: [],
				turnUsage: null,
				activeToolCalls: new Map(),
				streamingComponent: null,
				streamingBodyEl: null,
				streamingWrapperEl: null,
				toolCallsContainer: null,
			};

			this.registerBackgroundEvents(bg);
			this.activeSessions.set(sessionId, bg);

			// Add to session list
			const now = new Date();
			if (!this.sessionList.some(s => s.sessionId === sessionId)) {
				this.sessionList.unshift({
					sessionId,
					startTime: now,
					modifiedTime: now,
					isRemote: false,
				} as SessionMetadata);
			}
			this.renderSessionList();

			// Send the trigger content
			await session.send({prompt});

			new Notice(`Trigger fired: ${trigger.description || trigger.name}`);
		} catch (e) {
			console.error('Sidekick: trigger failed', trigger.name, e);
			new Notice(`Trigger failed: ${trigger.description || trigger.name} — ${String(e)}`);
		}
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
							const filePath = att.path!;
							// Reject paths with traversal sequences
							if (/\.\.[\/\\]/.test(filePath)) {
								new Notice('Cannot open file: path contains directory traversal.');
								return;
							}
							const {shell} = (globalThis.require as NodeRequire)('electron') as {shell: {openPath: (p: string) => Promise<string>}};
							void shell.openPath(filePath);
						} catch (e) {
							new Notice(`Failed to open file: ${String(e)}`);
						}
					});
				} else if (att.type === 'image' && att.path) {
					// Pasted image in vault: open with OS image viewer
					chip.setAttribute('title', 'Open with OS image viewer');
					chip.addEventListener('click', () => {
						try {
							const vaultPath = normalizePath(att.path!);
							// Reject paths that escape the vault via traversal
							if (vaultPath.startsWith('..') || vaultPath.includes('/../')) {
								new Notice('Cannot open image: path escapes the vault.');
								return;
							}
							const {shell} = (globalThis.require as NodeRequire)('electron') as {shell: {openPath: (p: string) => Promise<string>}};
							const absPath = this.getVaultBasePath() + '/' + vaultPath;
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
								void this.app.workspace.revealLeaf(fileExplorer);
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
				this.updateStreamingRenderIncremental();
			});
		}
	}

	/**
	 * Append only the new delta text as a plain text node.
	 * A periodic timer does full markdown re-renders every 300ms
	 * to resolve cross-boundary syntax (code blocks, lists, etc.).
	 */
	private updateStreamingRenderIncremental(): void {
		if (!this.streamingBodyEl) return;

		const newText = this.streamingContent.slice(this.lastFullRenderLen);
		if (newText) {
			// Append raw text node for immediate visual feedback
			this.streamingBodyEl.appendText(newText);
			this.lastFullRenderLen = this.streamingContent.length;
		}

		// Schedule a periodic full re-render if not already scheduled
		if (!this.fullRenderTimer) {
			this.fullRenderTimer = setTimeout(() => {
				this.fullRenderTimer = null;
				void this.doFullStreamingRender();
			}, 300);
		}

		this.scrollToBottom();
	}

	/** Full markdown re-render of the entire streamed content so far. */
	private async doFullStreamingRender(): Promise<void> {
		if (!this.streamingBodyEl) return;
		this.streamingBodyEl.empty();
		await this.renderMarkdownSafe(this.streamingContent, this.streamingBodyEl);
		this.lastFullRenderLen = this.streamingContent.length;
		this.scrollToBottom();
	}

	private async updateStreamingRender(): Promise<void> {
		if (!this.streamingBodyEl) return;
		this.streamingBodyEl.empty();
		await this.renderMarkdownSafe(this.streamingContent, this.streamingBodyEl);
		this.scrollToBottom();
	}

	private finalizeStreamingMessage(): void {
		// Always remove any lingering thinking/processing indicator
		this.removeProcessingIndicator();

		if (this.streamingContent) {
			const msg: ChatMessage = {
				id: `a-${Date.now()}`,
				role: 'assistant',
				content: this.streamingContent,
				timestamp: Date.now(),
			};
			this.messages.push(msg);
		}

		// Clean up incremental render timer and do final full render
		if (this.fullRenderTimer) {
			clearTimeout(this.fullRenderTimer);
			this.fullRenderTimer = null;
		}
		if (this.streamingBodyEl && this.streamingContent) {
			this.streamingBodyEl.empty();
			void this.renderMarkdownSafe(this.streamingContent, this.streamingBodyEl);
		} else if (this.streamingBodyEl && !this.streamingContent) {
			// No text was streamed — show a subtle fallback
			this.streamingBodyEl.empty();
			this.streamingBodyEl.createDiv({
				cls: 'sidekick-thinking sidekick-cancelled',
				text: 'No response',
			});
		}
		this.lastFullRenderLen = 0;

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

		// Update local session timestamp instead of full SDK round-trip
		if (this.currentSessionId) {
			const entry = this.sessionList.find(s => s.sessionId === this.currentSessionId);
			if (entry) {
				entry.modifiedTime = new Date();
			}
		}
		this.renderSessionList();
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
		const rawInput = this.inputEl.value.trim();
		if (!rawInput || this.isStreaming) return;

		if (!this.plugin.copilot) {
			new Notice('Copilot is not configured. Go to Settings → Sidekick.');
			return;
		}

		// Close prompt dropdown if open
		this.closePromptDropdown();

		// Resolve prompt command: strip /prompt-name prefix, extract user text
		let prompt = rawInput;
		let usedPrompt: PromptConfig | null = this.activePrompt;

		if (rawInput.startsWith('/')) {
			const spaceIdx = rawInput.indexOf(' ');
			if (spaceIdx > 0) {
				const cmdName = rawInput.slice(1, spaceIdx);
				const found = this.prompts.find(p => p.name === cmdName);
				if (found) {
					usedPrompt = found;
					prompt = rawInput.slice(spaceIdx + 1).trim();
				}
			}
		}

		// Display prompt (show original input to user)
		const displayPrompt = rawInput;

		// Snapshot attachments and scope
		const currentAttachments = [...this.attachments];
		// Auto-include active note if not already in attachments
		if (this.activeNotePath && !currentAttachments.some(a => a.type === 'file' && a.path === this.activeNotePath && !a.absolutePath)) {
			const name = this.activeNotePath.split('/').pop() || this.activeNotePath;
			currentAttachments.push({type: 'file', name, path: this.activeNotePath});
		}
		const currentScopePaths = [...this.scopePaths];

		// Auto-select agent from prompt if specified
		if (usedPrompt?.agent) {
			const matchingAgent = this.agents.find(a => a.name === usedPrompt!.agent);
			if (matchingAgent) {
				this.selectedAgent = matchingAgent.name;
				this.agentSelect.value = matchingAgent.name;
				const resolvedModel = this.resolveModelForAgent(matchingAgent, this.selectedModel || undefined);
				if (resolvedModel && resolvedModel !== this.selectedModel) {
					this.selectedModel = resolvedModel;
					this.modelSelect.value = resolvedModel;
				}
			}
		}

		// Prepend prompt template content if active
		const sendPrompt = usedPrompt ? `${usedPrompt.content}\n\n${prompt}` : prompt;
		this.activePrompt = null;

		// Update UI
		this.addUserMessage(displayPrompt, currentAttachments, currentScopePaths);
		this.inputEl.value = '';
		this.inputEl.style.height = 'auto';
		this.attachments = [];
		this.renderAttachments();

		// Begin streaming
		this.isStreaming = true;
		this.streamingContent = '';
		this.updateSendButton();
		this.renderSessionList();  // Show green active dot
		this.addAssistantPlaceholder();

		try {
			await this.ensureSession();

			// Name the session if this is the first message
			if (this.currentSessionId && !this.sessionNames[this.currentSessionId]) {
				const agentName = this.selectedAgent || 'Chat';
				const truncated = prompt.length > 40 ? prompt.slice(0, 40) + '…' : prompt;
				this.sessionNames[this.currentSessionId] = `[chat] ${agentName}: ${truncated}`;
				this.saveSessionNames();
				this.renderSessionList();
			}

			const sdkAttachments = this.buildSdkAttachments(currentAttachments);
			const fullPrompt = this.buildPrompt(sendPrompt, currentAttachments);

			try {
				await this.currentSession!.send({
					prompt: fullPrompt,
					...(sdkAttachments && sdkAttachments.length > 0 ? {attachments: sdkAttachments} : {}),
				});
			} catch (sendErr) {
				// If the session is stale (e.g. SDK restarted), invalidate and retry once
				if (String(sendErr).includes('Session not found')) {
					this.unsubscribeEvents();
					this.currentSession = null;
					this.currentSessionId = null;
					this.configDirty = true;
					await this.ensureSession();
					this.registerSessionEvents();
					await this.currentSession!.send({
						prompt: fullPrompt,
						...(sdkAttachments && sdkAttachments.length > 0 ? {attachments: sdkAttachments} : {}),
					});
				} else {
					throw sendErr;
				}
			}
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
		const sessionConfig = this.buildSessionConfig({
			model: this.selectedModel || undefined,
			systemContent: agent?.instructions || undefined,
		});

		this.currentSession = await this.plugin.copilot!.createSession(sessionConfig);
		this.currentSessionId = this.currentSession.sessionId;
		this.configDirty = false;
		this.registerSessionEvents();

		// Add new session to list immediately so sidebar updates instantly
		if (!this.sessionList.some(s => s.sessionId === this.currentSession!.sessionId)) {
			const now = new Date();
			this.sessionList.unshift({
				sessionId: this.currentSession.sessionId,
				startTime: now,
				modifiedTime: now,
				isRemote: false,
			} as SessionMetadata);
		}
		this.renderSessionList();
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

	/** Destroy all sessions — current and background. Used on plugin close. */
	private async destroyAllSessions(): Promise<void> {
		await this.destroySession();
		for (const [, bg] of this.activeSessions) {
			for (const unsub of bg.unsubscribers) unsub();
			try { await bg.session.destroy(); } catch { /* ignore */ }
			if (bg.streamingComponent) {
				try { this.removeChild(bg.streamingComponent); } catch { /* ignore */ }
			}
		}
		this.activeSessions.clear();
	}

	private async newConversation(): Promise<void> {
		// Save the current session to background instead of destroying it
		if (this.currentSession && this.currentSessionId) {
			this.saveCurrentToBackground();
		} else {
			// No active session handle, just clean up
			this.unsubscribeEvents();
			this.currentSession = null;
		}
		this.currentSessionId = null;
		this.messages = [];
		this.streamingContent = '';
		this.streamingBodyEl = null;
		this.streamingWrapperEl = null;
		this.toolCallsContainer = null;
		this.activeToolCalls.clear();
		if (this.streamingComponent) {
			this.removeChild(this.streamingComponent);
			this.streamingComponent = null;
		}
		this.isStreaming = false;
		this.configDirty = true;
		this.attachments = [];
		this.scopePaths = [];
		this.activePrompt = null;
		this.chatContainer.empty();
		this.renderWelcome();
		this.renderAttachments();
		this.renderScopeBar();
		this.updateSendButton();
		this.renderSessionList();
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

	// ── Shared helpers ───────────────────────────────────────────

	/**
	 * Resolve a model ID from an agent's preferred model name / partial match.
	 * Returns the matching model ID, or `fallback` if no match is found.
	 */
	private resolveModelForAgent(agent: AgentConfig | undefined, fallback: string | undefined): string | undefined {
		if (!agent?.model) return fallback;
		const target = agent.model.toLowerCase();
		let match = this.models.find(
			m => m.name.toLowerCase() === target || m.id.toLowerCase() === target
		);
		if (!match) {
			match = this.models.find(
				m => m.id.toLowerCase().includes(target) || m.name.toLowerCase().includes(target)
			);
		}
		return match ? match.id : fallback;
	}

	/**
	 * Build a full SessionConfig from the current UI state.
	 * Centralises MCP server mapping, skills, permissions, and working directory
	 * so callers (ensureSession, fireTriggerInBackground) stay DRY.
	 */
	private buildSessionConfig(opts: {
		model?: string;
		systemContent?: string;
	}): SessionConfig {
		// MCP servers
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
			}
		}

		// Skills
		const basePath = this.getVaultBasePath();
		const skillDirs: string[] = [];
		if (this.skills.length > 0) {
			skillDirs.push([basePath, getSkillsFolder(this.plugin.settings)].join('/'));
		}
		const disabledSkills = this.skills
			.filter(s => !this.enabledSkills.has(s.name))
			.map(s => s.name);

		// Permission handler
		const permissionHandler = (request: PermissionRequest) => {
			if (this.plugin.settings.toolApproval === 'allow') {
				return approveAll(request, {sessionId: ''});
			}
			const modal = new ToolApprovalModal(this.app, request);
			modal.open();
			return modal.promise;
		};

		// Build BYOK provider config if a non-GitHub preset is selected
		const providerPreset = this.plugin.settings.providerPreset;
		let provider: ProviderConfig | undefined;
		if (providerPreset !== 'github' && this.plugin.settings.providerBaseUrl) {
			const typeMap: Record<string, 'openai' | 'azure' | 'anthropic'> = {
				openai: 'openai',
				azure: 'azure',
				anthropic: 'anthropic',
				ollama: 'openai',
				'foundry-local': 'openai',
				'other-openai': 'openai',
			};
			provider = {
				type: typeMap[providerPreset] ?? 'openai',
				baseUrl: this.plugin.settings.providerBaseUrl,
				...(this.plugin.settings.providerApiKey ? {apiKey: this.plugin.settings.providerApiKey} : {}),
				...(this.plugin.settings.providerBearerToken ? {bearerToken: this.plugin.settings.providerBearerToken} : {}),
				wireApi: this.plugin.settings.providerWireApi,
			};
		}

		return {
			model: (provider && this.plugin.settings.providerModel) ? this.plugin.settings.providerModel : opts.model,
			streaming: providerPreset !== 'foundry-local',
			onPermissionRequest: permissionHandler,
			workingDirectory: this.getWorkingDirectory(),
			...(provider ? {provider} : {}),
			...(Object.keys(mcpServers).length > 0 ? {mcpServers} : {}),
			...(skillDirs.length > 0 ? {skillDirectories: skillDirs} : {}),
			...(disabledSkills.length > 0 ? {disabledSkills} : {}),
			...(opts.systemContent ? {systemMessage: {mode: 'append' as const, content: opts.systemContent}} : {}),
		};
	}

	/**
	 * Return the current skill/MCP/workingDirectory config for external callers
	 * (e.g. editorMenu inline sessions) so they can pass it to createSession.
	 */
	getSessionExtras(): {
		skillDirectories?: string[];
		disabledSkills?: string[];
		mcpServers?: Record<string, MCPServerConfig>;
		workingDirectory?: string;
	} {
		const basePath = this.getVaultBasePath();

		// Skills
		const skillDirs: string[] = [];
		if (this.skills.length > 0) {
			skillDirs.push([basePath, getSkillsFolder(this.plugin.settings)].join('/'));
		}
		const disabledSkills = this.skills
			.filter(s => !this.enabledSkills.has(s.name))
			.map(s => s.name);

		// MCP servers
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
			}
		}

		return {
			...(skillDirs.length > 0 ? {skillDirectories: skillDirs} : {}),
			...(disabledSkills.length > 0 ? {disabledSkills} : {}),
			...(Object.keys(mcpServers).length > 0 ? {mcpServers} : {}),
			workingDirectory: this.getWorkingDirectory(),
		};
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
			// Strip obsidian:// protocol URIs that could trigger vault actions
			// when rendered as clickable links from AI-generated content.
			const sanitized = content.replace(
				/\[([^\]]*)\]\(obsidian:\/\/[^)]*\)/gi,
				'[$1](blocked-uri)',
			);
			const component = this.streamingComponent ?? this;
			await MarkdownRenderer.render(this.app, sanitized, container, '', component);
		} catch {
			// Fallback to plain text
			container.setText(content);
		}
	}
}

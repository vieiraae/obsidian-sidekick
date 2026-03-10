import {
	App,
	ItemView,
	WorkspaceLeaf,
	MarkdownRenderer,
	MarkdownView,
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
	ReasoningEffort,
	CustomAgentConfig,
} from './copilot';
import type {AgentConfig, SkillInfo, McpServerEntry, McpInputVariable, PromptConfig, TriggerConfig, ChatMessage, ChatAttachment, SelectionInfo} from './types';
import {loadAgents, loadSkills, loadMcpServers, loadPrompts, loadTriggers} from './configLoader';
import type {InputResolver} from './configLoader';
import {getAgentsFolder, getSkillsFolder, getToolsFolder, getPromptsFolder, getTriggersFolder, getMcpInputValue, setMcpInputValue, McpInputPromptModal} from './settings';
import {TriggerScheduler} from './triggerScheduler';
import type {TriggerFireContext} from './triggerScheduler';
import {VaultScopeModal} from './vaultScopeModal';
import {EditModal} from './editModal';
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

/** Type re-exports for user input handling (mirrors SDK types). */
interface UserInputRequest {
	question: string;
	choices?: string[];
	allowFreeform?: boolean;
}

interface UserInputResponse {
	answer: string;
	wasFreeform: boolean;
}

/**
 * Modal that prompts the user for input when the Copilot agent invokes
 * the ask_user tool.  Supports optional multiple-choice buttons and an
 * optional freeform text input.
 */
class UserInputModal extends Modal {
	private resolved = false;
	private resolve!: (result: UserInputResponse) => void;
	private readonly request: UserInputRequest;
	readonly promise: Promise<UserInputResponse>;

	constructor(app: App, request: UserInputRequest) {
		super(app);
		this.request = request;
		this.promise = new Promise<UserInputResponse>((res) => {
			this.resolve = res;
		});
	}

	onOpen(): void {
		const {contentEl} = this;
		contentEl.empty();
		contentEl.addClass('sidekick-userinput-modal');

		contentEl.createEl('h3', {text: 'Copilot needs your input'});

		contentEl.createDiv({cls: 'sidekick-userinput-question', text: this.request.question});

		const allowFreeform = this.request.allowFreeform !== false; // default true

		// Choice buttons
		if (this.request.choices && this.request.choices.length > 0) {
			const choicesContainer = contentEl.createDiv({cls: 'sidekick-userinput-choices'});
			for (const choice of this.request.choices) {
				const btn = choicesContainer.createEl('button', {cls: 'sidekick-userinput-choice', text: choice});
				btn.addEventListener('click', () => {
					this.resolved = true;
					this.resolve({answer: choice, wasFreeform: false});
					this.close();
				});
			}
		}

		// Freeform text input
		if (allowFreeform) {
			const inputContainer = contentEl.createDiv({cls: 'sidekick-userinput-freeform'});
			const input = inputContainer.createEl('textarea', {
				cls: 'sidekick-userinput-textarea',
				attr: {placeholder: 'Type your answer…', rows: '3'},
			});

			const btnRow = inputContainer.createDiv({cls: 'sidekick-userinput-buttons'});
			const submitBtn = btnRow.createEl('button', {cls: 'mod-cta', text: 'Submit'});
			submitBtn.addEventListener('click', () => {
				const answer = input.value.trim();
				if (!answer) return;
				this.resolved = true;
				this.resolve({answer, wasFreeform: true});
				this.close();
			});

			// Submit on Enter (Shift+Enter for newline)
			input.addEventListener('keydown', (e) => {
				if (e.key === 'Enter' && !e.shiftKey) {
					e.preventDefault();
					submitBtn.click();
				}
			});

			// Auto-focus the textarea
			setTimeout(() => input.focus(), 50);
		}
	}

	onClose(): void {
		if (!this.resolved) {
			// Cancelled — return empty answer so the agent can handle it
			this.resolve({answer: '', wasFreeform: true});
		}
	}
}

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
	/** Live editor selection for the active note (null when no text is selected). */
	private activeSelection: {filePath: string; fileName: string; text: string; startLine: number; startChar: number; endLine: number; endChar: number} | null = null;
	private selectionPollTimer: ReturnType<typeof setInterval> | null = null;
	/** Whether the MarkdownView editor was focused on the previous poll tick. */
	private editorHadFocus = false;
	/** Current cursor position in the active note (when no text is selected). */
	private cursorPosition: {filePath: string; fileName: string; line: number; ch: number} | null = null;
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
	private sessionTypeFilter = new Set<'chat' | 'inline' | 'trigger' | 'search' | 'other'>(['chat', 'trigger']);
	private sessionSort: 'modified' | 'created' | 'name' = 'modified';

	// ── Tab state ────────────────────────────────────────────────
	private activeTab: 'chat' | 'triggers' | 'search' = 'chat';

	// ── Triggers panel state ─────────────────────────────────────
	private triggerHistoryFilter = '';
	private triggerHistoryAgentFilter = '';
	private triggerHistorySort: 'date' | 'name' = 'date';
	private triggerConfigSort: 'name' | 'modified' = 'name';

	// ── Search panel state ───────────────────────────────────────
	private searchAgent = '';
	private searchModel = '';
	private searchWorkingDir = '';
	private searchEnabledSkills: Set<string> = new Set();
	private searchEnabledMcpServers: Set<string> = new Set();
	private searchAgentSelect!: HTMLSelectElement;
	private searchModelSelect!: HTMLSelectElement;
	private searchSkillsBtnEl!: HTMLButtonElement;
	private searchToolsBtnEl!: HTMLButtonElement;
	private searchCwdBtnEl!: HTMLButtonElement;
	private searchInputEl!: HTMLTextAreaElement;
	private searchBtnEl!: HTMLButtonElement;
	private searchResultsEl!: HTMLElement;
	private searchSession: CopilotSession | null = null;
	private isSearching = false;
	private searchModeToggleEl!: HTMLButtonElement;
	private searchAdvancedToolbarEl!: HTMLElement;
	/** Persistent session reused across basic-mode searches. */
	private basicSearchSession: CopilotSession | null = null;

	// ── DOM refs ─────────────────────────────────────────────────
	private mainEl!: HTMLElement;
	private tabBarEl!: HTMLElement;
	private chatPanelEl!: HTMLElement;
	private triggersPanelEl!: HTMLElement;
	private searchPanelEl!: HTMLElement;
	private triggerHistoryListEl!: HTMLElement;
	private triggerConfigListEl!: HTMLElement;
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
	private modelIconEl!: HTMLSpanElement;
	private skillsBtnEl!: HTMLButtonElement;
	private toolsBtnEl!: HTMLButtonElement;
	private cwdBtnEl!: HTMLButtonElement;
	private debugBtnEl!: HTMLElement;
	private streamingComponent: Component | null = null;
	private streamingWrapperEl: HTMLElement | null = null;

	// ── Config file watcher ──────────────────────────────────────
	private configRefreshTimer: ReturnType<typeof setTimeout> | null = null;
	private configLoading = false;
	private configLoadedAt = 0;

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
	private sidebarDeleteEl!: HTMLButtonElement;
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
		this.addAction('plus', 'New conversation', () => void this.newConversation());

		this.buildUI();

		// Load persisted state before rendering lists
		this.sessionNames = this.plugin.settings.sessionNames ?? {};

		await this.loadAllConfigs();
		void this.loadSessions();

		// Initialize trigger scheduler
		this.initTriggerScheduler();

		// Watch sidekick folder for config changes and auto-refresh
		this.registerConfigFileWatcher();

		// Track active note and editor selection
		this.updateActiveNote();
		this.registerEvent(
			this.app.workspace.on('file-open', () => this.updateActiveNote())
		);
		this.startSelectionPolling();
	}

	async onClose(): Promise<void> {
		if (this.selectionPollTimer) { clearInterval(this.selectionPollTimer); this.selectionPollTimer = null; }
		if (this.configRefreshTimer) clearTimeout(this.configRefreshTimer);
		this.triggerScheduler?.stop();
		if (this.basicSearchSession) {
			try { await this.basicSearchSession.destroy(); } catch { /* ignore */ }
			this.basicSearchSession = null;
		}
		await this.destroyAllSessions();
	}

	// ── UI construction ──────────────────────────────────────────

	private buildUI(): void {
		const root = this.containerEl.children[1] as HTMLElement;
		root.empty();
		root.addClass('sidekick-root');

		// Main area (tab bar + panels)
		this.mainEl = root.createDiv({cls: 'sidekick-main'});

		// Tab bar
		this.buildTabBar(this.mainEl);

		// ── Chat panel ───────────────────────────────────────
		this.chatPanelEl = this.mainEl.createDiv({cls: 'sidekick-tab-panel sidekick-tab-panel-chat'});

		// Chat content wrapper (chat + bottom)
		const chatContent = this.chatPanelEl.createDiv({cls: 'sidekick-chat-content'});

		// Chat history (scrollable)
		this.chatContainer = chatContent.createDiv({cls: 'sidekick-chat sidekick-hide-debug'});
		this.renderWelcome();

		// Bottom panel
		const bottom = chatContent.createDiv({cls: 'sidekick-bottom'});

		// Input area
		this.buildInputArea(bottom);

		// Config toolbar (agents, models, skills, tools, action buttons)
		this.buildConfigToolbar(bottom);

		// Splitter + session sidebar inside chat panel
		this.splitterEl = this.chatPanelEl.createDiv({cls: 'sidekick-splitter'});
		this.initSplitter();
		this.buildSessionSidebar(this.chatPanelEl);

		// ── Triggers panel ────────────────────────────────────
		this.triggersPanelEl = this.mainEl.createDiv({cls: 'sidekick-tab-panel sidekick-tab-panel-triggers'});
		this.triggersPanelEl.style.display = 'none';
		this.buildTriggersPanel(this.triggersPanelEl);

		// ── Search panel ─────────────────────────────────────
		this.searchPanelEl = this.mainEl.createDiv({cls: 'sidekick-tab-panel sidekick-tab-panel-search'});
		this.searchPanelEl.style.display = 'none';
		this.buildSearchPanel(this.searchPanelEl);
	}

	private buildTabBar(parent: HTMLElement): void {
		this.tabBarEl = parent.createDiv({cls: 'sidekick-tab-bar'});
		const tabs: {id: 'chat' | 'triggers' | 'search'; icon: string; label: string}[] = [
			{id: 'chat', icon: 'message-square', label: 'Chat'},
			{id: 'triggers', icon: 'zap', label: 'Triggers'},
			{id: 'search', icon: 'search', label: 'Search'},
		];
		for (const tab of tabs) {
			const btn = this.tabBarEl.createDiv({cls: 'sidekick-tab' + (tab.id === this.activeTab ? ' is-active' : '')});
			btn.dataset.tab = tab.id;
			const iconEl = btn.createSpan({cls: 'sidekick-tab-icon'});
			setIcon(iconEl, tab.icon);
			btn.createSpan({cls: 'sidekick-tab-label', text: tab.label});
			btn.addEventListener('click', () => this.switchTab(tab.id));
		}
	}

	private switchTab(tab: 'chat' | 'triggers' | 'search'): void {
		if (tab === this.activeTab) return;
		this.activeTab = tab;

		// Update tab bar active state
		this.tabBarEl.querySelectorAll('.sidekick-tab').forEach(el => {
			el.toggleClass('is-active', (el as HTMLElement).dataset.tab === tab);
		});

		// Show/hide panels
		this.chatPanelEl.style.display = tab === 'chat' ? '' : 'none';
		this.triggersPanelEl.style.display = tab === 'triggers' ? '' : 'none';
		this.searchPanelEl.style.display = tab === 'search' ? '' : 'none';
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
	}

	private buildConfigToolbar(parent: HTMLElement): void {
		const toolbar = parent.createDiv({cls: 'sidekick-toolbar'});

		// New conversation button
		const newChatBtn = toolbar.createEl('button', {cls: 'clickable-icon sidekick-icon-btn', attr: {title: 'New conversation'}});
		setIcon(newChatBtn, 'plus');
		newChatBtn.addEventListener('click', () => void this.newConversation());

		// Agent dropdown
		const agentGroup = toolbar.createDiv({cls: 'sidekick-toolbar-group'});
		const agentIcon = agentGroup.createSpan({cls: 'sidekick-toolbar-icon'});
		setIcon(agentIcon, 'bot');
		this.agentSelect = agentGroup.createEl('select', {cls: 'sidekick-select'});
		this.agentSelect.addEventListener('change', () => {
			this.selectedAgent = this.agentSelect.value;
			const agent = this.agents.find(a => a.name === this.selectedAgent);
			// Update tooltip to show the selected agent's instructions
			this.agentSelect.title = agent ? agent.instructions : '';
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
		this.modelIconEl = modelGroup.createSpan({cls: 'sidekick-toolbar-icon clickable-icon'});
		setIcon(this.modelIconEl, 'cpu');
		this.modelIconEl.addEventListener('click', (e) => { e.stopPropagation(); this.openReasoningMenu(e); });
		this.modelSelect = modelGroup.createEl('select', {cls: 'sidekick-select sidekick-model-select'});
		this.modelSelect.addEventListener('change', () => {
			this.selectedModel = this.modelSelect.value;
			this.configDirty = true;
			this.updateReasoningBadge();
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
		const debugIcon = this.debugBtnEl.createSpan({cls: 'sidekick-debug-icon'});
		setIcon(debugIcon, 'bug');
		const debugCheck = this.debugBtnEl.createEl('input', {type: 'checkbox', cls: 'sidekick-debug-checkbox'});
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
		if (this.configLoading) return;
		this.configLoading = true;
		try {
			// Build input resolver that reads stored values or prompts for missing ones
			const inputResolver: InputResolver = async (input: McpInputVariable) => {
				const isPassword = input.password === true;
				let value = await getMcpInputValue(this.app, this.plugin, input.id, isPassword);
				if (value === undefined) {
					// Prompt user for the missing value
					value = await new Promise<string | undefined>(resolve => {
						const modal = new McpInputPromptModal(this.app, input, async (v) => {
							if (v !== undefined) {
								await setMcpInputValue(this.app, this.plugin, input.id, v, isPassword);
							}
							resolve(v);
						});
						modal.open();
					});
				}
				return value;
			};

			// Parallel-load all config files (independent I/O)
			const [agents, skills, mcpServers, prompts, triggers] = await Promise.all([
				loadAgents(this.app, getAgentsFolder(this.plugin.settings)),
				loadSkills(this.app, getSkillsFolder(this.plugin.settings)),
				loadMcpServers(this.app, getToolsFolder(this.plugin.settings), inputResolver),
				loadPrompts(this.app, getPromptsFolder(this.plugin.settings)),
				loadTriggers(this.app, getTriggersFolder(this.plugin.settings)),
			]);
			this.agents = agents;
			this.skills = skills;
			this.mcpServers = mcpServers;
			this.prompts = prompts;
			this.triggers = triggers;
			this.triggerScheduler?.setTriggers(this.triggers);
			this.renderTriggerConfigList();
			this.renderTriggerHistory();

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
		} finally {
			this.configLoading = false;
			this.configLoadedAt = Date.now();
		}

		this.updateConfigUI();
		this.configDirty = true;
		if (!options?.silent) {
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
			// Skip if currently loading or just finished loading (prevents cascading reloads)
			if (this.configLoading || (Date.now() - this.configLoadedAt < 2_000)) return;
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
			opt.title = agent.instructions;
		}
		if (this.selectedAgent && this.agents.some(a => a.name === this.selectedAgent)) {
			this.agentSelect.value = this.selectedAgent;
			const selAgent = this.agents.find(a => a.name === this.selectedAgent);
			this.agentSelect.title = selAgent ? selAgent.instructions : '';
		} else if (this.agents.length > 0 && this.agents[0]) {
			this.selectedAgent = this.agents[0].name;
			this.agentSelect.value = this.selectedAgent;
			this.agentSelect.title = this.agents[0].instructions;
		}

		// Auto-select agent's preferred model
		const selectedAgentConfig = this.agents.find(a => a.name === this.selectedAgent);
		const resolvedModel = this.resolveModelForAgent(selectedAgentConfig, this.selectedModel || undefined);
		if (resolvedModel) {
			this.selectedModel = resolvedModel;
		}

		// Models
		this.populateModelSelect();
		if (this.selectedModel && this.models.some(m => m.id === this.selectedModel)) {
			this.modelSelect.value = this.selectedModel;
		} else if (this.models.length > 0 && this.models[0]) {
			this.selectedModel = this.models[0].id;
			this.modelSelect.value = this.selectedModel;
		}

		// Apply agent's tools and skills filter
		const selectedAgentForFilter = this.agents.find(a => a.name === this.selectedAgent);
		this.applyAgentToolsAndSkills(selectedAgentForFilter);
		this.updateReasoningBadge();

		// Update search panel dropdowns
		if (this.searchAgentSelect) {
			this.updateSearchConfigUI();
		}
	}

	private populateModelSelect(): void {
		this.modelSelect.empty();
		for (const model of this.models) {
			const opt = this.modelSelect.createEl('option', {text: model.name});
			opt.value = model.id;
		}
	}

	private getSelectedModelInfo(): ModelInfo | undefined {
		return this.models.find(m => m.id === this.selectedModel);
	}

	private openReasoningMenu(e: MouseEvent): void {
		if (this.currentSession && !this.configDirty) return;
		const model = this.getSelectedModelInfo();
		const supported = model?.supportedReasoningEfforts;
		if (!model?.capabilities?.supports?.reasoningEffort || !supported || supported.length === 0) {
			const menu = new Menu();
			menu.addItem(item => item.setTitle('Model does not support reasoning effort').setDisabled(true));
			menu.showAtMouseEvent(e);
			return;
		}
		const menu = new Menu();
		const current = this.plugin.settings.reasoningEffort;
		for (const level of supported) {
			const label = level.charAt(0).toUpperCase() + level.slice(1);
			menu.addItem(item => {
				item.setTitle(label)
					.setChecked(level === current)
					.onClick(() => {
						// Toggle off if already selected
						this.plugin.settings.reasoningEffort = level === current ? '' : level;
						void this.plugin.saveSettings();
						this.configDirty = true;
						this.updateReasoningBadge();
					});
			});
		}
		menu.showAtMouseEvent(e);
	}

	private updateReasoningBadge(): void {
		const model = this.getSelectedModelInfo();
		const supportsReasoning = model?.capabilities?.supports?.reasoningEffort && (model.supportedReasoningEfforts?.length ?? 0) > 0;
		const level = this.plugin.settings.reasoningEffort;
		// Reset if current level isn't supported by the new model
		if (level !== '' && supportsReasoning && model?.supportedReasoningEfforts && !model.supportedReasoningEfforts.includes(level as ReasoningEffort)) {
			this.plugin.settings.reasoningEffort = '';
			void this.plugin.saveSettings();
		}
		const current = this.plugin.settings.reasoningEffort;
		const active = current !== '' && !!supportsReasoning;
		this.modelIconEl.toggleClass('is-active', active);
		if (!supportsReasoning) {
			this.modelIconEl.setAttribute('title', 'Model does not support reasoning effort');
			this.modelIconEl.style.cursor = 'default';
		} else {
			const label = current === '' ? 'Reasoning effort' : `Reasoning effort: ${current.charAt(0).toUpperCase() + current.slice(1)}`;
			this.modelIconEl.setAttribute('title', label);
			this.modelIconEl.style.cursor = 'pointer';
		}
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
		// Tools: undefined = enable all, [] = disable all, [...] = enable listed
		if (agent?.tools !== undefined) {
			const allowed = new Set(agent.tools);
			this.enabledMcpServers = new Set(
				this.mcpServers.filter(s => allowed.has(s.name)).map(s => s.name)
			);
		} else {
			this.enabledMcpServers = new Set(this.mcpServers.map(s => s.name));
		}

		// Skills: undefined = enable all, [] = disable all, [...] = enable listed
		if (agent?.skills !== undefined) {
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
	}

	/** Set the vault scope programmatically and refresh the scope bar. */
	public setScope(paths: string[]): void {
		this.scopePaths = paths;
		this.renderScopeBar();
	}

	/** Open the search tab with scope set to the given folder. */
	public openSearchWithScope(folderPath: string): void {
		this.searchWorkingDir = folderPath;
		this.updateSearchCwdButton();
		this.switchTab('search');
		this.searchInputEl.focus();
	}

	/** Set the working directory programmatically. */
	public setWorkingDir(folderPath: string): void {
		this.workingDir = folderPath;
		this.updateCwdButton();
		this.configDirty = true;
	}

	/** Set the prompt text programmatically and focus the input. */
	public setPromptText(text: string): void {
		this.inputEl.value = text;
		this.inputEl.setCssProps({'--input-height': 'auto'});
		this.inputEl.setCssProps({'--input-height': Math.min(this.inputEl.scrollHeight, 200) + 'px'});
		this.inputEl.focus();
	}

	/** Add a selection attachment from the editor context menu / brain button. */
	public addSelectionAttachment(text: string, info: SelectionInfo): void {
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
	}

	/**
	 * Poll the active editor for selection changes and update the active note bar.
	 * Uses a lightweight interval instead of a CM6 extension to avoid coupling.
	 */
	private startSelectionPolling(): void {
		const POLL_MS = 300;
		const timerId = window.setInterval(() => this.pollSelection(), POLL_MS);
		this.selectionPollTimer = timerId as unknown as ReturnType<typeof setInterval>;
		this.registerInterval(timerId);
	}

	private pollSelection(): void {
		// Try to get the active MarkdownView. If focus is in our chat view,
		// fall back to iterating workspace leaves to find the most recent editor.
		let mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
		let editorIsActive = !!mdView;

		if (!mdView && this.containerEl.contains(document.activeElement)) {
			// Focus is in our chat — find the last MarkdownView leaf to read cursor from
			this.editorHadFocus = false;
			this.app.workspace.iterateAllLeaves(leaf => {
				if (!mdView && leaf.view instanceof MarkdownView) {
					mdView = leaf.view as MarkdownView;
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
	}

	private renderActiveNoteBar(): void {
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
			const folder = normalizePath(this.getImageAttachmentFolder());

			await this.ensureFolderExists(folder);

			const filePath = normalizePath(`${folder}/${name}`);
			await this.app.vault.createBinary(filePath, buffer);

			this.attachments.push({type: 'image', name, path: filePath});
			this.renderAttachments();
			new Notice('Image attached.');
		} catch (e) {
			new Notice(`Failed to attach image: ${String(e)}`);
		}
	}

	/** Handle files dropped onto the input area from the OS or vault tree. */
	private handleFileDrop(e: DragEvent): void {
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
	}

	/** Recursively create a folder path if it doesn't already exist. */
	private async ensureFolderExists(folderPath: string): Promise<void> {
		if (this.app.vault.getAbstractFileByPath(folderPath)) return;
		const parts = folderPath.split('/');
		let current = '';
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			if (!this.app.vault.getAbstractFileByPath(current)) {
				await this.app.vault.createFolder(current);
			}
		}
	}

	/**
	 * Resolve the folder where pasted images are saved.
	 * Uses the Obsidian "Attachment folder path" setting + a "sidekick" subfolder.
	 * Falls back to ".sidekick-attachments" at the vault root.
	 */
	private getImageAttachmentFolder(): string {
		const configured = (this.app.vault as unknown as {getConfig: (key: string) => unknown}).getConfig('attachmentFolderPath') as string | undefined;
		if (configured && configured !== '/' && configured !== './' && configured !== '.') {
			// Obsidian attachment folder is set — use a "sidekick" subfolder inside it
			return `${configured}/sidekick`;
		}
		// No folder configured — use fallback at vault root
		return '.sidekick-attachments';
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
		this.inputEl.setAttribute('title', selected.content);
		this.inputEl.setCssProps({'--input-height': 'auto'});
		this.inputEl.setCssProps({'--input-height': Math.min(this.inputEl.scrollHeight, 200) + 'px'});
		this.inputEl.focus();
		this.closePromptDropdown();
	}

	// ── Session sidebar ──────────────────────────────────────────

	private buildSessionSidebar(parent: HTMLElement): void {
		this.sidebarEl = parent.createDiv({cls: 'sidekick-sidebar'});
		this.sidebarEl.setCssProps({'--sidebar-width': `${this.sidebarWidth}px`});

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
		this.sidebarRefreshEl.addEventListener('click', () => {
			void this.loadSessions();
			void this.loadAllConfigs();
		});

		this.sidebarDeleteEl = headerBtnRow.createEl('button', {
			cls: 'clickable-icon sidekick-sidebar-delete-btn',
			attr: {title: 'Delete displayed sessions'},
		});
		setIcon(this.sidebarDeleteEl, 'trash-2');
		this.sidebarDeleteEl.addEventListener('click', () => this.confirmDeleteDisplayedSessions());

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
			this.sidebarEl.setCssProps({'--sidebar-width': `${newWidth}px`});
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
		if (this.sidebarDeleteEl) {
			this.sidebarDeleteEl.toggleClass('is-hidden', !isExpanded);
		}

		for (const session of this.sessionList) {
			// Apply type filter
			if (this.sessionTypeFilter.size > 0) {
				const type = this.getSessionType(session);
				if (!this.sessionTypeFilter.has(type)) continue;
			}

			const name = this.getSessionDisplayName(session);
			if (this.sessionFilter && !name.toLowerCase().includes(this.sessionFilter)) continue;

			this.renderSessionItem(this.sidebarListEl, session, {
				expanded: isExpanded,
				onClick: () => void this.selectSession(session.sessionId),
				onContextMenu: (e) => this.showSessionContextMenu(e, session.sessionId),
			});
		}

		// Keep trigger history in sync with session list
		this.renderTriggerHistory();
	}

	/** Render a single session item into a container. Shared by session list and trigger history. */
	private renderSessionItem(container: HTMLElement, session: SessionMetadata, opts: {
		expanded?: boolean;
		onClick: () => void;
		onContextMenu: (e: MouseEvent) => void;
	}): void {
		const expanded = opts.expanded ?? true;
		const item = container.createDiv({cls: 'sidekick-session-item'});
		const isActive = session.sessionId === this.currentSessionId;
		if (isActive) item.addClass('is-active');

		const sessionType = this.getSessionType(session);
		const iconName = sessionType === 'chat' ? 'message-square' : sessionType === 'trigger' ? 'zap' : sessionType === 'inline' ? 'file-text' : sessionType === 'search' ? 'search' : 'code';
		const iconEl = item.createSpan({cls: 'sidekick-session-icon'});
		setIcon(iconEl, iconName);

		// Green active dot when processing (current or background session)
		const isCurrentStreaming = isActive && this.isStreaming;
		const bgSession = this.activeSessions.get(session.sessionId);
		const isBgStreaming = bgSession?.isStreaming ?? false;
		if (isCurrentStreaming || isBgStreaming) {
			iconEl.createSpan({cls: 'sidekick-session-active-dot'});
		}

		const name = this.getSessionDisplayName(session);
		if (expanded) {
			const details = item.createDiv({cls: 'sidekick-session-details'});
			details.createDiv({cls: 'sidekick-session-name', text: name});
			const modTime = session.modifiedTime instanceof Date
				? session.modifiedTime
				: new Date(session.modifiedTime);
			details.createDiv({cls: 'sidekick-session-time', text: this.formatTimeAgo(modTime)});
		}

		item.setAttribute('title', name);
		item.addEventListener('click', opts.onClick);
		item.addEventListener('contextmenu', opts.onContextMenu);
	}

	private getSessionDisplayName(session: SessionMetadata): string {
		const raw = this.sessionNames[session.sessionId]
			|| session.summary
			|| `Session ${session.sessionId.slice(0, 8)}`;
		// Strip session type prefix for display
		return raw.replace(/^\[(chat|inline|trigger|search)\]\s*/, '');
	}

	/** Return the session type prefix: 'chat', 'inline', 'trigger', 'search', or 'other'. */
	private getSessionType(session: SessionMetadata): 'chat' | 'inline' | 'trigger' | 'search' | 'other' {
		const name = this.sessionNames[session.sessionId] || '';
		debugTrace(`Sidekick: getSessionType id=${session.sessionId.slice(0, 8)} name="${name.slice(0, 40)}"`);
		if (name.startsWith('[chat]')) return 'chat';
		if (name.startsWith('[inline]')) return 'inline';
		if (name.startsWith('[trigger]')) return 'trigger';
		if (name.startsWith('[search]')) return 'search';
		return 'other';
	}

	private openSessionFilterMenu(e: MouseEvent): void {
		const menu = new Menu();
		const types: Array<{value: 'chat' | 'inline' | 'trigger' | 'search' | 'other'; label: string}> = [
			{value: 'chat', label: 'Chat'},
			{value: 'trigger', label: 'Triggers'},
			{value: 'search', label: 'Search'},
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
	private async restoreFromBackground(bg: BackgroundSession): Promise<void> {
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
			const renderPromises: Promise<void>[] = [];
			for (const msg of this.messages) {
				renderPromises.push(this.renderMessageBubble(msg));
			}
			await Promise.all(renderPromises);
			if (this.messages.length === 0) {
				this.renderWelcome();
			}
		}

		// Re-attach foreground event routing
		this.registerSessionEvents();

		// Lock toolbar since session is active
		this.updateToolbarLock();

		// Remove from background map
		this.activeSessions.delete(bg.sessionId);

		// Restore agent from session name
		this.restoreAgentFromSessionName(bg.sessionId);

		// Force scroll to end
		this.forceScrollToBottom();
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
			await this.restoreFromBackground(bg);
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
			this.updateToolbarLock();

			// Load and render message history from SDK
			const events = await this.currentSession.getMessages();
			const renderPromises: Promise<void>[] = [];
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
					renderPromises.push(this.renderMessageBubble(msg));
				}
			}
			await Promise.all(renderPromises);

			if (this.messages.length === 0) {
				this.renderWelcome();
			}

			// Restore the agent that was used in this session
			this.restoreAgentFromSessionName(sessionId);

			// Force scroll to the end of the loaded conversation
			this.forceScrollToBottom();

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
			this.newConversation();
		}

		this.renderSessionList();
		new Notice('Session deleted.');
	}

	private confirmDeleteDisplayedSessions(): void {
		const displayed = this.getDisplayedSessions();
		if (displayed.length === 0) {
			new Notice('No sessions to delete.');
			return;
		}

		const modal = new Modal(this.app);
		modal.titleEl.setText('Delete sessions');
		modal.contentEl.createEl('p', {
			text: `Are you sure you want to delete ${displayed.length} session${displayed.length === 1 ? '' : 's'}?`,
		});
		const btnRow = modal.contentEl.createDiv({cls: 'modal-button-container'});
		btnRow.createEl('button', {text: 'Cancel', cls: 'mod-cancel'}).addEventListener('click', () => modal.close());
		const confirmBtn = btnRow.createEl('button', {text: 'Delete', cls: 'mod-warning'});
		confirmBtn.addEventListener('click', () => {
			modal.close();
			void this.deleteDisplayedSessions(displayed);
		});
		modal.open();
	}

	private getDisplayedSessions(): SessionMetadata[] {
		return this.sessionList.filter(session => {
			if (this.sessionTypeFilter.size > 0) {
				const type = this.getSessionType(session);
				if (!this.sessionTypeFilter.has(type)) return false;
			}
			if (this.sessionFilter) {
				const name = this.getSessionDisplayName(session);
				if (!name.toLowerCase().includes(this.sessionFilter)) return false;
			}
			return true;
		});
	}

	private async deleteDisplayedSessions(sessions: SessionMetadata[]): Promise<void> {
		let deleted = 0;
		for (const session of sessions) {
			try {
				await this.deleteSessionById(session.sessionId);
				deleted++;
			} catch { /* continue with remaining */ }
		}
		new Notice(`Deleted ${deleted} session${deleted === 1 ? '' : 's'}.`);
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

	// ── Search panel ────────────────────────────────────────────

	private buildSearchPanel(parent: HTMLElement): void {
		const wrapper = parent.createDiv({cls: 'sidekick-search-wrapper'});

		// ── Toolbar row: scope | mode toggle | [advanced: agent | model | skills | tools] ──
		const toolbar = wrapper.createDiv({cls: 'sidekick-toolbar sidekick-search-toolbar'});

		// Search scope (folder picker) — always visible
		this.searchCwdBtnEl = toolbar.createEl('button', {cls: 'clickable-icon sidekick-icon-btn', attr: {title: 'Search scope'}});
		setIcon(this.searchCwdBtnEl, 'folder');
		this.searchCwdBtnEl.addEventListener('click', () => this.openSearchScopePicker());
		this.updateSearchCwdButton();

		// Mode toggle (basic / advanced)
		this.searchModeToggleEl = toolbar.createEl('button', {cls: 'clickable-icon sidekick-icon-btn', attr: {title: 'Toggle basic/advanced mode'}});
		this.searchModeToggleEl.addEventListener('click', () => this.toggleSearchMode());
		this.updateSearchModeToggle();

		// Advanced controls group — hidden in basic mode
		this.searchAdvancedToolbarEl = toolbar.createDiv({cls: 'sidekick-search-advanced-group'});

		// Agent dropdown
		const agentGroup = this.searchAdvancedToolbarEl.createDiv({cls: 'sidekick-toolbar-group'});
		const agentIcon = agentGroup.createSpan({cls: 'sidekick-toolbar-icon'});
		setIcon(agentIcon, 'bot');
		this.searchAgentSelect = agentGroup.createEl('select', {cls: 'sidekick-select'});
		this.searchAgentSelect.addEventListener('change', () => {
			this.searchAgent = this.searchAgentSelect.value;
			const agent = this.agents.find(a => a.name === this.searchAgent);
			this.searchAgentSelect.title = agent ? agent.instructions : '';
			// Auto-select agent's preferred model
			const resolvedModel = this.resolveModelForAgent(agent, this.searchModel || undefined);
			if (resolvedModel && resolvedModel !== this.searchModel) {
				this.searchModel = resolvedModel;
				this.searchModelSelect.value = resolvedModel;
			}
			// Apply agent's tools and skills filter for search
			this.applySearchAgentToolsAndSkills(agent);
			// Persist
			this.plugin.settings.searchAgent = this.searchAgent;
			void this.plugin.saveSettings();
		});

		// Model dropdown
		const modelGroup = this.searchAdvancedToolbarEl.createDiv({cls: 'sidekick-toolbar-group'});
		const modelIcon = modelGroup.createSpan({cls: 'sidekick-toolbar-icon'});
		setIcon(modelIcon, 'cpu');
		this.searchModelSelect = modelGroup.createEl('select', {cls: 'sidekick-select sidekick-model-select'});
		this.searchModelSelect.addEventListener('change', () => {
			this.searchModel = this.searchModelSelect.value;
		});

		// Skills button
		this.searchSkillsBtnEl = this.searchAdvancedToolbarEl.createEl('button', {cls: 'clickable-icon sidekick-icon-btn', attr: {title: 'Skills'}});
		setIcon(this.searchSkillsBtnEl, 'wand-2');
		this.searchSkillsBtnEl.addEventListener('click', (e) => this.openSearchSkillsMenu(e));

		// Tools button
		this.searchToolsBtnEl = this.searchAdvancedToolbarEl.createEl('button', {cls: 'clickable-icon sidekick-icon-btn', attr: {title: 'Tools'}});
		setIcon(this.searchToolsBtnEl, 'plug');
		this.searchToolsBtnEl.addEventListener('click', (e) => this.openSearchToolsMenu(e));

		// Apply initial visibility
		this.updateSearchAdvancedVisibility();

		// ── Search input + button ──
		const inputRow = wrapper.createDiv({cls: 'sidekick-search-input-row'});
		this.searchInputEl = inputRow.createEl('textarea', {
			cls: 'sidekick-search-input',
			attr: {placeholder: 'Describe what you\'re looking for…', rows: '2'},
		});
		this.searchInputEl.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				void this.handleSearch();
			}
		});

		this.searchBtnEl = inputRow.createEl('button', {cls: 'sidekick-search-btn', attr: {title: 'Search'}});
		setIcon(this.searchBtnEl, 'search');
		this.searchBtnEl.addEventListener('click', () => void this.handleSearch());

		// ── Results area ──
		this.searchResultsEl = wrapper.createDiv({cls: 'sidekick-search-results'});
	}

	private get searchMode(): 'basic' | 'advanced' {
		return this.plugin.settings.searchMode;
	}

	private toggleSearchMode(): void {
		const newMode = this.searchMode === 'basic' ? 'advanced' : 'basic';
		this.plugin.settings.searchMode = newMode;
		void this.plugin.saveSettings();
		this.updateSearchModeToggle();
		this.updateSearchAdvancedVisibility();
		// Destroy cached basic session when switching modes
		if (newMode === 'advanced' && this.basicSearchSession) {
			void this.basicSearchSession.destroy().catch(() => {});
			this.basicSearchSession = null;
		}
	}

	private updateSearchModeToggle(): void {
		this.searchModeToggleEl.empty();
		if (this.searchMode === 'basic') {
			setIcon(this.searchModeToggleEl, 'settings');
			this.searchModeToggleEl.title = 'Basic mode (fast) — click for advanced';
		} else {
			setIcon(this.searchModeToggleEl, 'settings');
			this.searchModeToggleEl.title = 'Advanced mode — click for basic (fast)';
		}
		this.searchModeToggleEl.toggleClass('is-active', this.searchMode === 'advanced');
	}

	private updateSearchAdvancedVisibility(): void {
		this.searchAdvancedToolbarEl.style.display = this.searchMode === 'advanced' ? '' : 'none';
	}

	private updateSearchConfigUI(): void {
		// Agents
		this.searchAgentSelect.empty();
		const noAgent = this.searchAgentSelect.createEl('option', {text: 'Agent', attr: {value: ''}});
		noAgent.value = '';
		for (const agent of this.agents) {
			const opt = this.searchAgentSelect.createEl('option', {text: agent.name});
			opt.value = agent.name;
			opt.title = agent.instructions;
		}

		// Restore saved search agent from settings
		const savedAgent = this.plugin.settings.searchAgent;
		if (savedAgent && this.agents.some(a => a.name === savedAgent)) {
			this.searchAgent = savedAgent;
			this.searchAgentSelect.value = savedAgent;
			const selAgent = this.agents.find(a => a.name === savedAgent);
			this.searchAgentSelect.title = selAgent ? selAgent.instructions : '';
		}

		// Auto-select agent's preferred model
		const agentConfig = this.agents.find(a => a.name === this.searchAgent);
		const resolvedModel = this.resolveModelForAgent(agentConfig, this.searchModel || undefined);
		if (resolvedModel) {
			this.searchModel = resolvedModel;
		}

		// Models
		this.searchModelSelect.empty();
		for (const model of this.models) {
			const opt = this.searchModelSelect.createEl('option', {text: model.name});
			opt.value = model.id;
		}
		if (this.searchModel && this.models.some(m => m.id === this.searchModel)) {
			this.searchModelSelect.value = this.searchModel;
		} else if (this.models.length > 0 && this.models[0]) {
			this.searchModel = this.models[0].id;
			this.searchModelSelect.value = this.searchModel;
		}

		// Apply agent's tools and skills filter
		this.applySearchAgentToolsAndSkills(agentConfig);
	}

	private applySearchAgentToolsAndSkills(agent?: AgentConfig): void {
		// Tools: undefined = enable all, [] = disable all, [...] = enable listed
		if (agent?.tools !== undefined) {
			const allowed = new Set(agent.tools);
			this.searchEnabledMcpServers = new Set(
				this.mcpServers.filter(s => allowed.has(s.name)).map(s => s.name)
			);
		} else {
			this.searchEnabledMcpServers = new Set(this.mcpServers.map(s => s.name));
		}

		// Skills: undefined = enable all, [] = disable all, [...] = enable listed
		if (agent?.skills !== undefined) {
			const allowed = new Set(agent.skills);
			this.searchEnabledSkills = new Set(
				this.skills.filter(s => allowed.has(s.name)).map(s => s.name)
			);
		} else {
			this.searchEnabledSkills = new Set(this.skills.map(s => s.name));
		}

		this.updateSearchSkillsBadge();
		this.updateSearchToolsBadge();
	}

	private openSearchSkillsMenu(e: MouseEvent): void {
		const menu = new Menu();
		if (this.skills.length === 0) {
			menu.addItem(item => item.setTitle('No skills configured').setDisabled(true));
		} else {
			for (const skill of this.skills) {
				menu.addItem(item => {
					item.setTitle(skill.name)
						.setChecked(this.searchEnabledSkills.has(skill.name))
						.onClick(() => {
							if (this.searchEnabledSkills.has(skill.name)) {
								this.searchEnabledSkills.delete(skill.name);
							} else {
								this.searchEnabledSkills.add(skill.name);
							}
							this.updateSearchSkillsBadge();
						});
				});
			}
		}
		menu.showAtMouseEvent(e);
	}

	private openSearchToolsMenu(e: MouseEvent): void {
		const menu = new Menu();
		if (this.mcpServers.length === 0) {
			menu.addItem(item => item.setTitle('No tools configured').setDisabled(true));
		} else {
			for (const server of this.mcpServers) {
				menu.addItem(item => {
					item.setTitle(server.name)
						.setChecked(this.searchEnabledMcpServers.has(server.name))
						.onClick(() => {
							if (this.searchEnabledMcpServers.has(server.name)) {
								this.searchEnabledMcpServers.delete(server.name);
							} else {
								this.searchEnabledMcpServers.add(server.name);
							}
							this.updateSearchToolsBadge();
						});
				});
			}
		}
		menu.showAtMouseEvent(e);
	}

	private updateSearchSkillsBadge(): void {
		const count = this.searchEnabledSkills.size;
		this.searchSkillsBtnEl.toggleClass('is-active', count > 0);
		this.searchSkillsBtnEl.setAttribute('title', count > 0 ? `Skills (${count} active)` : 'Skills');
	}

	private updateSearchToolsBadge(): void {
		const count = this.searchEnabledMcpServers.size;
		this.searchToolsBtnEl.toggleClass('is-active', count > 0);
		this.searchToolsBtnEl.setAttribute('title', count > 0 ? `Tools (${count} active)` : 'Tools');
	}

	private openSearchScopePicker(): void {
		new FolderTreeModal(this.app, this.searchWorkingDir, (folder) => {
			this.searchWorkingDir = folder.path;
			this.updateSearchCwdButton();
		}).open();
	}

	private updateSearchCwdButton(): void {
		const vaultName = this.app.vault.getName();
		const label = this.searchWorkingDir
			? `Search scope: ${vaultName}/${this.searchWorkingDir}`
			: `Search scope: ${vaultName} (entire vault)`;
		this.searchCwdBtnEl.setAttribute('title', label);
		this.searchCwdBtnEl.toggleClass('is-active', !!this.searchWorkingDir);
	}

	private getSearchWorkingDirectory(): string {
		const base = this.getVaultBasePath();
		if (!this.searchWorkingDir) return base;
		return base + '/' + normalizePath(this.searchWorkingDir);
	}

	private buildSearchSessionConfig(): SessionConfig {
		const basePath = this.getVaultBasePath();

		// MCP servers (search-specific selection)
		const mcpServers: Record<string, MCPServerConfig> = {};
		for (const server of this.mcpServers) {
			if (!this.searchEnabledMcpServers.has(server.name)) continue;
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
		const skillDirs: string[] = [];
		if (this.skills.length > 0) {
			skillDirs.push([basePath, getSkillsFolder(this.plugin.settings)].join('/'));
		}
		const disabledSkills = this.skills
			.filter(s => !this.searchEnabledSkills.has(s.name))
			.map(s => s.name);

		// Custom agents
		const customAgents: CustomAgentConfig[] = this.agents.map(a => ({
			name: a.name,
			displayName: a.name,
			description: a.description || undefined,
			prompt: a.instructions,
			tools: a.tools ?? null,
			infer: this.searchAgent ? a.name === this.searchAgent : true,
		}));

		// Permission handler
		const permissionHandler = (request: PermissionRequest) => {
			if (this.plugin.settings.toolApproval === 'allow') {
				return approveAll(request, {sessionId: ''});
			}
			const modal = new ToolApprovalModal(this.app, request);
			modal.open();
			return modal.promise;
		};

		// BYOK provider
		const providerPreset = this.plugin.settings.providerPreset;
		let provider: ProviderConfig | undefined;
		if (providerPreset !== 'github' && this.plugin.settings.providerBaseUrl) {
			const typeMap: Record<string, 'openai' | 'azure' | 'anthropic'> = {
				openai: 'openai', azure: 'azure', anthropic: 'anthropic',
				ollama: 'openai', 'foundry-local': 'openai', 'other-openai': 'openai',
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
			model: (provider && this.plugin.settings.providerModel) ? this.plugin.settings.providerModel : (this.searchModel || undefined),
			streaming: providerPreset !== 'foundry-local',
			onPermissionRequest: permissionHandler,
			workingDirectory: this.getSearchWorkingDirectory(),
			...(provider ? {provider} : {}),
			...(Object.keys(mcpServers).length > 0 ? {mcpServers} : {}),
			...(customAgents.length > 0 ? {customAgents} : {}),
			...(skillDirs.length > 0 ? {skillDirectories: skillDirs} : {}),
			...(disabledSkills.length > 0 ? {disabledSkills} : {}),
		};
	}

	private async handleSearch(): Promise<void> {
		if (this.isSearching) {
			// Cancel in-progress search
			const session = this.searchMode === 'basic' ? this.basicSearchSession : this.searchSession;
			if (session) {
				try { await session.abort(); } catch { /* ignore */ }
			}
			if (this.searchMode === 'advanced' && this.searchSession) {
				try { await this.searchSession.destroy(); } catch { /* ignore */ }
				this.searchSession = null;
			}
			this.isSearching = false;
			this.updateSearchButton();
			return;
		}

		const query = this.searchInputEl.value.trim();
		if (!query) return;

		if (!this.plugin.copilot) {
			new Notice('Copilot is not configured.');
			return;
		}

		this.isSearching = true;
		this.updateSearchButton();
		this.searchResultsEl.empty();
		this.searchResultsEl.createDiv({cls: 'sidekick-search-loading', text: 'Searching…'});

		try {
			if (this.searchMode === 'basic') {
				await this.handleBasicSearch(query);
			} else {
				await this.handleAdvancedSearch(query);
			}
		} catch (e) {
			if (this.isSearching) {
				this.searchResultsEl.empty();
				this.searchResultsEl.createDiv({cls: 'sidekick-search-empty', text: `Search failed: ${String(e)}`});
			}
		} finally {
			this.isSearching = false;
			this.updateSearchButton();
		}
	}

	private async handleBasicSearch(query: string): Promise<void> {
		// Reuse persistent session; create only if missing
		if (!this.basicSearchSession) {
			this.basicSearchSession = await this.plugin.copilot!.createSession(this.buildBasicSearchSessionConfig());
		}

		const scopePath = this.getSearchWorkingDirectory();
		const scopeLabel = this.searchWorkingDir || this.app.vault.getName();
		const searchPrompt = `Perform a semantic search for files matching the following query. Return ONLY a JSON array of objects, each with "file" (vault-relative path), "folder" (parent folder path), and "reason" (brief description why it matches). Sort by relevance (best match first). No markdown fences, no extra text.\n\nQuery: ${query}`;

		try {
			const response = await this.basicSearchSession.sendAndWait({
				prompt: searchPrompt,
				attachments: [{type: 'directory', path: scopePath, displayName: scopeLabel}],
			}, 120_000);
			const content = response?.data.content || '';
			this.renderSearchResults(content);
		} catch (e) {
			// Session may be broken — discard and rethrow so outer catch handles it
			try { await this.basicSearchSession.destroy(); } catch { /* ignore */ }
			this.basicSearchSession = null;
			throw e;
		}
	}

	private async handleAdvancedSearch(query: string): Promise<void> {
		const sessionConfig = this.buildSearchSessionConfig();
		this.searchSession = await this.plugin.copilot!.createSession(sessionConfig);
		const sessionId = this.searchSession.sessionId;

		// Name the session
		const agentLabel = this.searchAgent || 'Search';
		const truncated = query.length > 40 ? query.slice(0, 40) + '…' : query;
		this.sessionNames[sessionId] = `[search] ${agentLabel}: ${truncated}`;
		this.saveSessionNames();

		// Add to session list
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

		const searchPrompt = this.searchAgent
			? `/${this.searchAgent} Perform a semantic search for files matching the following query. Return ONLY a JSON array of objects, each with "file" (vault-relative path), "folder" (parent folder path), and "reason" (brief description why it matches). Sort by relevance (best match first). No markdown fences, no extra text.\n\nQuery: ${query}`
			: `Perform a semantic search for files matching the following query. Return ONLY a JSON array of objects, each with "file" (vault-relative path), "folder" (parent folder path), and "reason" (brief description why it matches). Sort by relevance (best match first). No markdown fences, no extra text.\n\nQuery: ${query}`;

		const scopePath = this.getSearchWorkingDirectory();
		const scopeLabel = this.searchWorkingDir || this.app.vault.getName();
		try {
			const response = await this.searchSession.sendAndWait({
				prompt: searchPrompt,
				attachments: [{type: 'directory', path: scopePath, displayName: scopeLabel}],
			}, 120_000);
			const content = response?.data.content || '';
			this.renderSearchResults(content);
		} finally {
			if (this.searchSession) {
				try { await this.searchSession.destroy(); } catch { /* ignore */ }
				this.searchSession = null;
			}
		}
	}

	/** Minimal session config for basic search — no MCP servers, skills, or custom agents. */
	private buildBasicSearchSessionConfig(): SessionConfig {
		const permissionHandler = (request: PermissionRequest) => {
			if (this.plugin.settings.toolApproval === 'allow') {
				return approveAll(request, {sessionId: ''});
			}
			const modal = new ToolApprovalModal(this.app, request);
			modal.open();
			return modal.promise;
		};

		// Use inline model setting, fall back to first available model
		let model = this.plugin.settings.inlineModel || undefined;
		if (!model && this.models.length > 0 && this.models[0]) {
			model = this.models[0].id;
		}

		// BYOK provider
		const providerPreset = this.plugin.settings.providerPreset;
		let provider: ProviderConfig | undefined;
		if (providerPreset !== 'github' && this.plugin.settings.providerBaseUrl) {
			const typeMap: Record<string, 'openai' | 'azure' | 'anthropic'> = {
				openai: 'openai', azure: 'azure', anthropic: 'anthropic',
				ollama: 'openai', 'foundry-local': 'openai', 'other-openai': 'openai',
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
			model: (provider && this.plugin.settings.providerModel) ? this.plugin.settings.providerModel : model,
			streaming: providerPreset !== 'foundry-local',
			onPermissionRequest: permissionHandler,
			workingDirectory: this.getSearchWorkingDirectory(),
			...(provider ? {provider} : {}),
		};
	}

	private renderSearchResults(content: string): void {
		this.searchResultsEl.empty();

		// Try to parse JSON array from the response
		let results: Array<{file?: string; path?: string; folder: string; reason: string}> = [];
		try {
			// Strip markdown fences if present
			const cleaned = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
			const parsed = JSON.parse(cleaned);
			// Handle both single object and array responses
			results = Array.isArray(parsed) ? parsed : [parsed];
		} catch {
			// If not valid JSON, show the raw response
			this.searchResultsEl.createDiv({cls: 'sidekick-search-empty', text: content || 'No results found.'});
			return;
		}

		if (!Array.isArray(results) || results.length === 0) {
			this.searchResultsEl.createDiv({cls: 'sidekick-search-empty', text: 'No results found.'});
			return;
		}

		for (const result of results) {
			const item = this.searchResultsEl.createDiv({cls: 'sidekick-search-result'});

			const fileRow = item.createDiv({cls: 'sidekick-search-result-file'});
			const fileIcon = fileRow.createSpan({cls: 'sidekick-search-result-icon'});
			setIcon(fileIcon, 'file-text');
			const filePath = (result.file || result.path || '').replace(/^\/+/, '');
			const fileName = filePath.split('/').pop() || filePath || 'Unknown';
			const fileLink = fileRow.createSpan({cls: 'sidekick-search-result-name', text: fileName});

			fileLink.addEventListener('click', () => {
				if (!filePath) return;
				const resolved = this.app.vault.getAbstractFileByPath(filePath)
					?? (result.folder ? this.app.vault.getAbstractFileByPath(result.folder + '/' + filePath) : null);
				if (resolved instanceof TFile) {
					void this.app.workspace.openLinkText(resolved.path, '', false);
				} else {
					// Fallback: let Obsidian try to resolve the link
					void this.app.workspace.openLinkText(filePath, '', false);
				}
			});

			if (result.folder) {
				fileRow.createSpan({cls: 'sidekick-search-result-folder', text: result.folder});
			}

			if (result.reason) {
				item.createDiv({cls: 'sidekick-search-result-reason', text: result.reason});
			}
		}
	}

	private updateSearchButton(): void {
		this.searchBtnEl.empty();
		if (this.isSearching) {
			setIcon(this.searchBtnEl, 'square');
			this.searchBtnEl.title = 'Cancel search';
			this.searchBtnEl.addClass('is-searching');
		} else {
			setIcon(this.searchBtnEl, 'search');
			this.searchBtnEl.title = 'Search';
			this.searchBtnEl.removeClass('is-searching');
		}
	}

	// ── Triggers panel ──────────────────────────────────────────

	private buildTriggersPanel(parent: HTMLElement): void {
		// ── History section (top) ─────────────────────────────
		const historySection = parent.createDiv({cls: 'sidekick-triggers-section sidekick-triggers-history-section'});
		const historyHeader = historySection.createDiv({cls: 'sidekick-triggers-header'});
		historyHeader.createDiv({cls: 'sidekick-triggers-title', text: 'History'});

		const historyControls = historyHeader.createDiv({cls: 'sidekick-triggers-controls'});

		// Filter by name
		const historySearchEl = historyControls.createEl('input', {
			type: 'text',
			placeholder: 'Filter…',
			cls: 'sidekick-triggers-search',
		});
		historySearchEl.addEventListener('input', () => {
			this.triggerHistoryFilter = historySearchEl.value.toLowerCase();
			this.renderTriggerHistory();
		});

		// Filter by agent
		const agentFilterBtn = historyControls.createEl('button', {
			cls: 'clickable-icon sidekick-triggers-ctrl-btn',
			attr: {title: 'Filter by agent'},
		});
		setIcon(agentFilterBtn, 'user');
		agentFilterBtn.addEventListener('click', (e) => {
			const menu = new Menu();
			const agents = new Set<string>();
			for (const s of this.sessionList) {
				if (this.getSessionType(s) === 'trigger') {
					agents.add(this.parseTriggerAgent(s));
				}
			}
			menu.addItem(item => item.setTitle('All agents')
				.setChecked(!this.triggerHistoryAgentFilter)
				.onClick(() => {
					this.triggerHistoryAgentFilter = '';
					this.renderTriggerHistory();
				}));
			for (const agent of agents) {
				menu.addItem(item => item.setTitle(agent)
					.setChecked(this.triggerHistoryAgentFilter === agent)
					.onClick(() => {
						this.triggerHistoryAgentFilter = agent;
						this.renderTriggerHistory();
					}));
			}
			menu.showAtMouseEvent(e);
		});

		// Sort
		const historySortBtn = historyControls.createEl('button', {
			cls: 'clickable-icon sidekick-triggers-ctrl-btn',
			attr: {title: 'Sort history'},
		});
		setIcon(historySortBtn, 'arrow-up-down');
		historySortBtn.addEventListener('click', (e) => {
			const menu = new Menu();
			menu.addItem(item => item.setTitle('Execution date')
				.setChecked(this.triggerHistorySort === 'date')
				.onClick(() => { this.triggerHistorySort = 'date'; this.renderTriggerHistory(); }));
			menu.addItem(item => item.setTitle('Name')
				.setChecked(this.triggerHistorySort === 'name')
				.onClick(() => { this.triggerHistorySort = 'name'; this.renderTriggerHistory(); }));
			menu.showAtMouseEvent(e);
		});

		this.triggerHistoryListEl = historySection.createDiv({cls: 'sidekick-triggers-list'});

		// ── Configured triggers section (bottom) ──────────────
		const configSection = parent.createDiv({cls: 'sidekick-triggers-section sidekick-triggers-config-section'});
		const configHeader = configSection.createDiv({cls: 'sidekick-triggers-header'});
		configHeader.createDiv({cls: 'sidekick-triggers-title', text: 'Configured triggers'});

		const configControls = configHeader.createDiv({cls: 'sidekick-triggers-controls'});

		// Sort
		const configSortBtn = configControls.createEl('button', {
			cls: 'clickable-icon sidekick-triggers-ctrl-btn',
			attr: {title: 'Sort triggers'},
		});
		setIcon(configSortBtn, 'arrow-up-down');
		configSortBtn.addEventListener('click', (e) => {
			const menu = new Menu();
			menu.addItem(item => item.setTitle('Name')
				.setChecked(this.triggerConfigSort === 'name')
				.onClick(() => { this.triggerConfigSort = 'name'; this.renderTriggerConfigList(); }));
			menu.addItem(item => item.setTitle('Modified date')
				.setChecked(this.triggerConfigSort === 'modified')
				.onClick(() => { this.triggerConfigSort = 'modified'; this.renderTriggerConfigList(); }));
			menu.showAtMouseEvent(e);
		});

		this.triggerConfigListEl = configSection.createDiv({cls: 'sidekick-triggers-list'});
	}

	private renderTriggerHistory(): void {
		if (!this.triggerHistoryListEl) return;
		this.triggerHistoryListEl.empty();

		// Derive trigger history from session list — sessions with [trigger] prefix
		let items = this.sessionList.filter(s => this.getSessionType(s) === 'trigger');

		// Filter by name/agent text
		if (this.triggerHistoryFilter) {
			items = items.filter(s => {
				const name = this.getSessionDisplayName(s).toLowerCase();
				return name.includes(this.triggerHistoryFilter);
			});
		}

		// Filter by agent
		if (this.triggerHistoryAgentFilter) {
			items = items.filter(s => {
				const agent = this.parseTriggerAgent(s);
				return agent === this.triggerHistoryAgentFilter;
			});
		}

		// Sort
		if (this.triggerHistorySort === 'date') {
			items.sort((a, b) => {
				const ta = a.modifiedTime instanceof Date ? a.modifiedTime.getTime() : new Date(a.modifiedTime).getTime();
				const tb = b.modifiedTime instanceof Date ? b.modifiedTime.getTime() : new Date(b.modifiedTime).getTime();
				return tb - ta;
			});
		} else {
			items.sort((a, b) => this.getSessionDisplayName(a).localeCompare(this.getSessionDisplayName(b)));
		}

		if (items.length === 0) {
			this.triggerHistoryListEl.createDiv({cls: 'sidekick-triggers-empty', text: 'No trigger history yet.'});
			return;
		}

		for (const session of items) {
			this.renderSessionItem(this.triggerHistoryListEl, session, {
				onClick: () => { void this.selectSession(session.sessionId); this.switchTab('chat'); },
				onContextMenu: (e) => this.showTriggerHistoryContextMenu(e, session.sessionId),
			});
		}
	}

	/** Parse agent name from a trigger session name. Format: "[trigger] Agent: content" */
	private parseTriggerAgent(session: SessionMetadata): string {
		const raw = this.sessionNames[session.sessionId] || '';
		const m = raw.match(/^\[trigger\]\s*([^:]+?):\s/);
		return m ? m[1]!.trim() : 'Chat';
	}

	private showTriggerHistoryContextMenu(e: MouseEvent, sessionId: string): void {
		e.preventDefault();
		e.stopPropagation();
		const menu = new Menu();

		menu.addItem(item => item
			.setTitle('Open session')
			.setIcon('message-square')
			.onClick(() => {
				void this.selectSession(sessionId);
				this.switchTab('chat');
			}));

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

	private static describeCron(cron: string): string {
		const parts = cron.trim().split(/\s+/);
		if (parts.length !== 5) return `Cron: ${cron}`;
		const [min, hour, dom, mon, dow] = parts;

		// */N minute patterns
		const everyMin = min!.match(/^\*\/(\d+)$/);
		if (everyMin && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
			return `Every ${everyMin[1]} minute(s)`;
		}
		// Daily at HH:MM
		if (/^\d+$/.test(min!) && /^\d+$/.test(hour!) && dom === '*' && mon === '*' && dow === '*') {
			return `Daily at ${hour!.padStart(2, '0')}:${min!.padStart(2, '0')}`;
		}
		// Weekly (specific dow)
		if (/^\d+$/.test(min!) && /^\d+$/.test(hour!) && dom === '*' && mon === '*' && /^\d+$/.test(dow!)) {
			const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
			const day = days[parseInt(dow!, 10)] ?? dow;
			return `Weekly on ${day} at ${hour!.padStart(2, '0')}:${min!.padStart(2, '0')}`;
		}
		// Hourly at :MM
		if (/^\d+$/.test(min!) && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
			return `Hourly at :${min!.padStart(2, '0')}`;
		}
		return `Cron: ${cron}`;
	}

	private static describeGlob(glob: string): string {
		// **/*.ext — all .ext files recursively
		const recursiveExt = glob.match(/^\*\*\/\*\.([\w]+)$/);
		if (recursiveExt) return `All .${recursiveExt[1]} files (recursive)`;
		// *.ext — .ext files in root
		const rootExt = glob.match(/^\*\.([\w]+)$/);
		if (rootExt) return `.${rootExt[1]} files in root`;
		// folder/**/*.ext
		const folderExt = glob.match(/^(.+)\/\*\*\/\*\.([\w]+)$/);
		if (folderExt) return `All .${folderExt[2]} files in ${folderExt[1]}/`;
		// folder/** — everything under folder
		const folderAll = glob.match(/^(.+)\/\*\*$/);
		if (folderAll) return `All files in ${folderAll[1]}/`;
		return `Glob: ${glob}`;
	}

	private renderTriggerConfigList(): void {
		if (!this.triggerConfigListEl) return;
		this.triggerConfigListEl.empty();

		let items = [...this.triggers];

		// Sort
		if (this.triggerConfigSort === 'name') {
			items.sort((a, b) => a.name.localeCompare(b.name));
		} else {
			// Sort by file modified date
			items.sort((a, b) => {
				const fileA = this.app.vault.getAbstractFileByPath(a.filePath);
				const fileB = this.app.vault.getAbstractFileByPath(b.filePath);
				const mtimeA = (fileA instanceof TFile) ? fileA.stat.mtime : 0;
				const mtimeB = (fileB instanceof TFile) ? fileB.stat.mtime : 0;
				return mtimeB - mtimeA;
			});
		}

		if (items.length === 0) {
			this.triggerConfigListEl.createDiv({cls: 'sidekick-triggers-empty', text: 'No triggers configured.'});
			return;
		}

		for (const trigger of items) {
			const item = this.triggerConfigListEl.createDiv({cls: 'sidekick-session-item sidekick-triggers-config-item'});
			if (!trigger.enabled) item.addClass('is-disabled');

			// Icon with enabled/disabled dot (mirrors session list icon pattern)
			const iconEl = item.createSpan({cls: 'sidekick-session-icon'});
			setIcon(iconEl, 'zap');
			if (trigger.enabled) {
				iconEl.createSpan({cls: 'sidekick-triggers-enabled-dot'});
			}

			// Details: name + schedule description (mirrors session list)
			const agentName = trigger.agent || 'Chat';
			const displayName = `${agentName}: ${trigger.name}`;
			const details = item.createDiv({cls: 'sidekick-session-details'});
			details.createDiv({cls: 'sidekick-session-name', text: displayName});

			// Schedule description as subtitle
			const scheduleParts: string[] = [];
			if (trigger.cron) scheduleParts.push(SidekickView.describeCron(trigger.cron));
			if (trigger.glob) scheduleParts.push(SidekickView.describeGlob(trigger.glob));
			if (scheduleParts.length === 0) scheduleParts.push('No schedule');
			const scheduleText = scheduleParts.join(' · ');
			details.createDiv({cls: 'sidekick-session-time', text: scheduleText});

			const tooltipParts = [displayName];
			if (trigger.description) tooltipParts.push(trigger.description);
			tooltipParts.push(scheduleText);
			item.setAttribute('title', tooltipParts.join('\n'));

			// Click opens the trigger file
			item.addEventListener('click', () => {
				const file = this.app.vault.getAbstractFileByPath(trigger.filePath);
				if (file instanceof TFile) {
					void this.app.workspace.getLeaf(false).openFile(file);
				}
			});
		}
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
		// Debounce: collect changed file paths, then check triggers once after 1s of quiet
		const sidekickFolder = normalizePath(this.plugin.settings.sidekickFolder);
		const pendingFilePaths = new Set<string>();
		let fileChangeTimer: ReturnType<typeof setTimeout> | null = null;
		const FILE_CHANGE_DEBOUNCE = 1_000;

		const scheduleFileChangeCheck = (filePath: string) => {
			if (filePath.startsWith(sidekickFolder + '/') || filePath.startsWith('.sidekick-attachments/')) {
				debugTrace(`Sidekick: ignoring change in excluded folder: ${filePath}`);
				return;
			}
			pendingFilePaths.add(filePath);
			if (fileChangeTimer) clearTimeout(fileChangeTimer);
			fileChangeTimer = setTimeout(() => {
				fileChangeTimer = null;
				const paths = [...pendingFilePaths];
				pendingFilePaths.clear();
				for (const p of paths) {
					debugTrace(`Sidekick: vault file-change event (debounced): ${p}`);
					this.triggerScheduler?.checkFileChangeTriggers(p);
				}
			}, FILE_CHANGE_DEBOUNCE);
		};

		this.registerEvent(
			this.app.vault.on('modify', (file) => {
				if (!(file instanceof TFile)) return;
				scheduleFileChangeCheck(file.path);
			})
		);
		this.registerEvent(
			this.app.vault.on('create', (file) => {
				if (!(file instanceof TFile)) return;
				scheduleFileChangeCheck(file.path);
			})
		);
		this.registerEvent(
			this.app.vault.on('rename', (file, oldPath) => {
				if (!(file instanceof TFile)) return;
				scheduleFileChangeCheck(file.path);
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
			console.warn('Sidekick: trigger skipped — no copilot client available');
			return;
		}

		try {
			// Resolve agent and model
			const agent = trigger.agent ? this.agents.find(a => a.name === trigger.agent) : undefined;
			const model = this.resolveModelForAgent(agent, this.selectedModel || undefined);

			const sessionConfig = this.buildSessionConfig({model, selectedAgentName: trigger.agent || undefined});

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

	private renderMessageBubble(msg: ChatMessage): Promise<void> {
		if (msg.role === 'info') {
			const el = this.chatContainer.createDiv({cls: 'sidekick-msg sidekick-msg-info'});
			el.createSpan({text: msg.content});
			return Promise.resolve();
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
				const icon = att.type === 'directory' ? 'folder' : att.type === 'image' ? 'image' : att.type === 'clipboard' ? 'clipboard' : att.type === 'selection' ? 'text-cursor-input' : 'file-text';
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
					chip.setAttribute('title', 'Open with os default application');
					chip.addEventListener('click', () => {
						try {
							const filePath = att.path!;
							// Reject paths with traversal sequences
							if (/\.\.[/\\]/.test(filePath)) {
								new Notice('Cannot open file: path contains directory traversal.');
								return;
							}
							const {shell} = globalThis.require('electron') as {shell: {openPath: (p: string) => Promise<string>}};
							void shell.openPath(filePath);
						} catch (e) {
							new Notice(`Failed to open file: ${String(e)}`);
						}
					});
				} else if (att.type === 'image' && att.path) {
					// Pasted image in vault: open with OS image viewer
					chip.setAttribute('title', 'Open with os image viewer');
					chip.addEventListener('click', () => {
						try {
							const vaultPath = normalizePath(att.path!);
							// Reject paths that escape the vault via traversal
							if (vaultPath.startsWith('..') || vaultPath.includes('/../')) {
								new Notice('Cannot open image: path escapes the vault.');
								return;
							}
							const {shell} = globalThis.require('electron') as {shell: {openPath: (p: string) => Promise<string>}};
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
				} else if (att.type === 'selection' && att.path) {
					// Selection: open file at the selected line
					const selRange = att.selection;
					const preview = att.content && att.content.length > 80 ? att.content.slice(0, 80) + '…' : att.content || '';
					const rangeLabel = selRange
						? selRange.startLine === selRange.endLine
							? `line ${selRange.startLine}`
							: `lines ${selRange.startLine}-${selRange.endLine}`
						: '';
					chip.setAttribute('title', `Open ${att.path}${rangeLabel ? ` (${rangeLabel})` : ''}${preview ? `:\n${preview}` : ''}`);
					chip.addEventListener('click', () => {
						const file = this.app.vault.getAbstractFileByPath(att.path!);
						if (file instanceof TFile) {
							const leaf = this.app.workspace.getLeaf(false);
							void leaf.openFile(file).then(() => {
								if (selRange) {
									const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
									if (mdView) {
										mdView.editor.setCursor({line: selRange.startLine - 1, ch: selRange.startChar});
										mdView.editor.setSelection(
											{line: selRange.startLine - 1, ch: selRange.startChar},
											{line: selRange.endLine - 1, ch: selRange.endChar},
										);
									}
								}
							});
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
			return this.renderMarkdownSafe(msg.content, body);
		} else {
			this.renderUserMessageContent(msg.content, body);
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
		return Promise.resolve();
	}

	/**
	 * Render user message content, highlighting `/prompt-name` with a tooltip if it matches a known prompt.
	 */
	private renderUserMessageContent(content: string, body: HTMLElement): void {
		if (content.startsWith('/')) {
			const spaceIdx = content.indexOf(' ');
			const cmdName = spaceIdx > 0 ? content.slice(1, spaceIdx) : content.slice(1);
			const matchedPrompt = this.prompts.find(p => p.name === cmdName);
			if (matchedPrompt) {
				const p = body.createEl('p');
				const promptSpan = p.createSpan({cls: 'sidekick-prompt-tag', text: `/${cmdName}`});
				promptSpan.setAttribute('title', matchedPrompt.content);
				if (spaceIdx > 0) {
					p.appendText(content.slice(spaceIdx));
				}
				return;
			}
		}
		body.createEl('p', {text: content});
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

	/** Disable config controls that cannot be changed mid-session. */
	private updateToolbarLock(): void {
		const locked = !!(this.currentSession && !this.configDirty);
		this.modelIconEl.toggleClass('is-disabled', locked);
		this.skillsBtnEl.disabled = locked;
		this.toolsBtnEl.disabled = locked;
		this.cwdBtnEl.disabled = locked;
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
			new Notice('Copilot is not configured.');
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
		// Auto-include live editor selection or active note
		if (this.activeSelection && !currentAttachments.some(a => a.type === 'selection' && a.path === this.activeSelection!.filePath && !a.absolutePath)) {
			const sel = this.activeSelection;
			const displayName = sel.startLine === sel.endLine
				? `${sel.fileName}:${sel.startLine}`
				: `${sel.fileName}:${sel.startLine}-${sel.endLine}`;
			currentAttachments.push({
				type: 'selection',
				name: displayName,
				path: sel.filePath,
				content: sel.text,
				selection: {
					startLine: sel.startLine,
					startChar: sel.startChar,
					endLine: sel.endLine,
					endChar: sel.endChar,
				},
			});
		} else if (this.activeNotePath && !currentAttachments.some(a => (a.type === 'file' || a.type === 'selection') && a.path === this.activeNotePath && !a.absolutePath)) {
			const name = this.activeNotePath.split('/').pop() || this.activeNotePath;
			currentAttachments.push({type: 'file', name, path: this.activeNotePath});
		}
		const currentScopePaths = [...this.scopePaths];

		// Auto-select agent from prompt if specified
		if (usedPrompt?.agent) {
			const matchingAgent = this.agents.find(a => a.name === usedPrompt.agent);
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
		this.inputEl.removeAttribute('title');

		// Update UI
		this.addUserMessage(displayPrompt, currentAttachments, currentScopePaths);
		this.inputEl.value = '';
		this.inputEl.setCssProps({'--input-height': 'auto'});
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
			let fullPrompt = this.buildPrompt(sendPrompt, currentAttachments);

			// Mention the selected agent so the SDK routes to it
			if (this.selectedAgent) {
				fullPrompt = `/${this.selectedAgent} ${fullPrompt}`;
			}

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
			// DEBUG: log full error with stack trace
			console.error('[sidekick] Send error:', e);
			if (e instanceof Error) {
				console.error('[sidekick] Stack:', e.stack);
			}
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
			model: this.resolveModelForAgent(agent, this.selectedModel || undefined),
			selectedAgentName: this.selectedAgent || undefined,
		});

		this.currentSession = await this.plugin.copilot!.createSession(sessionConfig);
		this.currentSessionId = this.currentSession.sessionId;
		this.configDirty = false;
		this.registerSessionEvents();
		this.updateToolbarLock();

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

	private newConversation(): void {
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
		this.inputEl.removeAttribute('title');
		this.chatContainer.empty();
		this.renderWelcome();
		this.renderAttachments();
		this.renderScopeBar();
		this.updateSendButton();
		this.updateToolbarLock();
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
		// Inline selection text in the prompt because the Copilot CLI server's
		// session.send handler normalises all attachments to {type, path, displayName},
		// stripping the selection-specific fields (filePath, text, selection range).
		const selections = attachments.filter(a => a.type === 'selection');
		for (const sel of selections) {
			if (sel.content) {
				const range = sel.selection
					? sel.selection.startLine === sel.selection.endLine
						? `line ${sel.selection.startLine}`
						: `lines ${sel.selection.startLine}-${sel.selection.endLine}`
					: '';
				const header = sel.path
					? `Selected text from ${sel.path}${range ? ` (${range})` : ''}`
					: 'Selected text';
				prompt += `\n\n---\n${header}:\n${sel.content}`;
			}
		}
		// Include cursor position so the model knows where the user's cursor is
		if (this.cursorPosition && !this.activeSelection) {
			prompt += `\n\n---\nCurrent cursor position: ${this.cursorPosition.filePath}, line ${this.cursorPosition.line}, column ${this.cursorPosition.ch}`;
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
			} else if (att.type === 'selection' && att.path) {
				// Workaround: send as 'file' instead of 'selection' because the Copilot CLI
				// server's session.send handler maps all attachments to {type, path, displayName},
				// reading .path (not .filePath) and dropping text/selection fields.
				// The selection text is inlined in the prompt by buildPrompt().
				const resolvedPath = att.absolutePath ? att.path : basePath + '/' + normalizePath(att.path);
				result.push({
					type: 'file',
					path: resolvedPath,
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
		selectedAgentName?: string;
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

		// Custom agents — register all agents from the agents folder
		const customAgents: CustomAgentConfig[] = this.agents.map(a => ({
			name: a.name,
			displayName: a.name,
			description: a.description || undefined,
			prompt: a.instructions,
			tools: a.tools ?? null,
			infer: opts.selectedAgentName ? a.name === opts.selectedAgentName : true,
		}));

		// Permission handler
		const permissionHandler = (request: PermissionRequest) => {
			if (this.plugin.settings.toolApproval === 'allow') {
				return approveAll(request, {sessionId: ''});
			}
			const modal = new ToolApprovalModal(this.app, request);
			modal.open();
			return modal.promise;
		};

		// User input handler — shows a modal when the agent invokes ask_user
		const userInputHandler = (request: UserInputRequest) => {
			const modal = new UserInputModal(this.app, request);
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

		const reasoningEffort = this.plugin.settings.reasoningEffort;

		return {
			model: (provider && this.plugin.settings.providerModel) ? this.plugin.settings.providerModel : opts.model,
			streaming: providerPreset !== 'foundry-local',
			onPermissionRequest: permissionHandler,
			onUserInputRequest: userInputHandler,
			workingDirectory: this.getWorkingDirectory(),
			...(reasoningEffort !== '' ? {reasoningEffort: reasoningEffort as ReasoningEffort} : {}),
			...(provider ? {provider} : {}),
			...(Object.keys(mcpServers).length > 0 ? {mcpServers} : {}),
			...(customAgents.length > 0 ? {customAgents} : {}),
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

	private openEditFromChat(): void {
		const text = this.inputEl.value.trim();
		new EditModal(this.plugin, text, (result) => {
			this.inputEl.value = result;
			this.inputEl.setCssProps({'--input-height': 'auto'});
			this.inputEl.setCssProps({'--input-height': Math.min(this.inputEl.scrollHeight, 200) + 'px'});
			this.inputEl.focus();
		}).open();
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

	private forceScrollToBottom(): void {
		// Double rAF ensures layout is complete after markdown rendering
		window.requestAnimationFrame(() => {
			window.requestAnimationFrame(() => {
				this.chatContainer.scrollTop = this.chatContainer.scrollHeight;
			});
		});
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

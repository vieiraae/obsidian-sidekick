import type {SidekickView} from '../sidekickView';
import {Menu, Modal, Notice, setIcon} from 'obsidian';
import type {SessionMetadata} from '../copilot';
import type {ChatMessage} from '../types';
import {debugTrace} from '../debug';
import {formatTimeAgo} from './utils';
import type {BackgroundSession} from './types';

declare module '../sidekickView' {
	interface SidekickView {
		buildSessionSidebar(parent: HTMLElement): void;
		initSplitter(): void;
		loadSessions(): Promise<void>;
		sortSessionList(): void;
		renderSessionList(): void;
		renderSessionItem(container: HTMLElement, session: SessionMetadata, opts: {
			expanded?: boolean;
			onClick: () => void;
			onContextMenu: (e: MouseEvent) => void;
		}): void;
		getSessionDisplayName(session: SessionMetadata): string;
		getSessionType(session: SessionMetadata): 'chat' | 'inline' | 'trigger' | 'search' | 'other';
		openSessionFilterMenu(e: MouseEvent): void;
		updateFilterBadge(): void;
		openSessionSortMenu(e: MouseEvent): void;
		updateSortBadge(): void;
		registerInlineSession(sessionId: string, description: string): void;
		saveCurrentToBackground(): void;
		restoreFromBackground(bg: BackgroundSession): Promise<void>;
		registerBackgroundEvents(bg: BackgroundSession): void;
		restoreAgentFromSessionName(sessionId: string): void;
		selectSession(sessionId: string): Promise<void>;
		showSessionContextMenu(e: MouseEvent, sessionId: string): void;
		renameSession(sessionId: string): void;
		deleteSessionById(sessionId: string): Promise<void>;
		confirmDeleteDisplayedSessions(): void;
		getDisplayedSessions(): SessionMetadata[];
		deleteDisplayedSessions(sessions: SessionMetadata[]): Promise<void>;
		saveSessionNames(): void;
	}
}

export function installSessionSidebar(ViewClass: {prototype: unknown}): void {
	const proto = ViewClass.prototype as SidekickView;

	proto.buildSessionSidebar = function (parent: HTMLElement): void {
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
	};

	proto.initSplitter = function (): void {
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
	};

	proto.loadSessions = async function (): Promise<void> {
		if (!this.plugin.copilot) return;
		try {
			this.sessionList = await this.plugin.copilot.listSessions();
			this.sortSessionList();
			this.renderSessionList();
		} catch {
			// silently ignore — session list stays as-is
		}
	};

	proto.sortSessionList = function (): void {
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
	};

	proto.renderSessionList = function (): void {
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
	};

	proto.renderSessionItem = function (container: HTMLElement, session: SessionMetadata, opts: {
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
			details.createDiv({cls: 'sidekick-session-time', text: formatTimeAgo(modTime)});
		}

		item.setAttribute('title', name);
		item.addEventListener('click', opts.onClick);
		item.addEventListener('contextmenu', opts.onContextMenu);
	};

	proto.getSessionDisplayName = function (session: SessionMetadata): string {
		const raw = this.sessionNames[session.sessionId]
			|| session.summary
			|| `Session ${session.sessionId.slice(0, 8)}`;
		// Strip session type prefix for display
		return raw.replace(/^\[(chat|inline|trigger|search)\]\s*/, '');
	};

	proto.getSessionType = function (session: SessionMetadata): 'chat' | 'inline' | 'trigger' | 'search' | 'other' {
		const name = this.sessionNames[session.sessionId] || '';
		debugTrace(`Sidekick: getSessionType id=${session.sessionId.slice(0, 8)} name="${name.slice(0, 40)}"`);
		if (name.startsWith('[chat]')) return 'chat';
		if (name.startsWith('[inline]')) return 'inline';
		if (name.startsWith('[trigger]')) return 'trigger';
		if (name.startsWith('[search]')) return 'search';
		return 'other';
	};

	proto.openSessionFilterMenu = function (e: MouseEvent): void {
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
	};

	proto.updateFilterBadge = function (): void {
		// When no types selected (show all), dim the icon; otherwise mark active
		const hasFilter = this.sessionTypeFilter.size > 0;
		this.sidebarFilterEl.toggleClass('is-active', hasFilter);
		this.sidebarFilterEl.setAttribute('title',
			hasFilter
				? `Filter: ${[...this.sessionTypeFilter].join(', ')}`
				: 'Filter sessions (showing all)');
	};

	proto.openSessionSortMenu = function (e: MouseEvent): void {
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
	};

	proto.updateSortBadge = function (): void {
		const labels: Record<string, string> = {modified: 'Modified', created: 'Created', name: 'Name'};
		this.sidebarSortEl.setAttribute('title', `Sort: ${labels[this.sessionSort]}`);
	};

	proto.registerInlineSession = function (sessionId: string, description: string): void {
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
	};

	proto.saveCurrentToBackground = function (): void {
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
					try { void evicted.session.disconnect(); } catch { /* ignore */ }
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
			streamingReasoning: this.streamingReasoning,
			reasoningComplete: this.reasoningComplete,
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
			reasoningEl: this.reasoningEl,
			reasoningBodyEl: this.reasoningBodyEl,
		};

		// If still streaming, attach background event routing
		if (bg.isStreaming) {
			this.registerBackgroundEvents(bg);
		}

		this.activeSessions.set(this.currentSessionId, bg);

		if (this.fullRenderTimer) {
			clearTimeout(this.fullRenderTimer);
			this.fullRenderTimer = null;
		}
		this.lastFullRenderLen = 0;
		this.clearReasoningState();

		// Detach streaming component from the view (it lives in the bg now)
		if (this.streamingComponent) {
			this.streamingComponent = null;
		}
		this.currentSession = null;
		this.currentSessionId = null;
	};

	proto.restoreFromBackground = async function (bg: BackgroundSession): Promise<void> {
		// Unsubscribe background event routing
		for (const unsub of bg.unsubscribers) unsub();
		bg.unsubscribers = [];

		// Restore state
		this.currentSession = bg.session;
		this.currentSessionId = bg.sessionId;
		this.messages = bg.messages;
		this.isStreaming = bg.isStreaming;
		this.streamingContent = bg.streamingContent;
		this.streamingReasoning = bg.streamingReasoning;
		this.reasoningComplete = bg.reasoningComplete;
		this.turnStartTime = bg.turnStartTime;
		this.turnToolsUsed = bg.turnToolsUsed;
		this.turnSkillsUsed = bg.turnSkillsUsed;
		this.turnUsage = bg.turnUsage;
		this.configDirty = false;
		this.lastFullRenderLen = 0;

		this.chatContainer.empty();

		if (bg.isStreaming && bg.savedDom) {
			// Session is still streaming — restore its live DOM (including streaming placeholder)
			this.streamingComponent = bg.streamingComponent;
			this.streamingBodyEl = bg.streamingBodyEl;
			this.streamingWrapperEl = bg.streamingWrapperEl;
			this.toolCallsContainer = bg.toolCallsContainer;
			this.activeToolCalls = bg.activeToolCalls;
			this.reasoningEl = bg.reasoningEl;
			this.reasoningBodyEl = bg.reasoningBodyEl;
			this.chatContainer.appendChild(bg.savedDom);
			bg.savedDom = null;
			if (this.streamingReasoning && this.reasoningBodyEl) {
				this.syncReasoningContent(this.streamingReasoning);
				if (this.reasoningComplete) {
					const restoredReasoningComplete = this.reasoningComplete;
					this.reasoningComplete = false;
					this.finalizeReasoning();
					this.reasoningComplete = restoredReasoningComplete;
				}
			}
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
			this.clearReasoningState();
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
	};

	proto.registerBackgroundEvents = function (bg: BackgroundSession): void {
		const session = bg.session;

		bg.unsubscribers.push(
			session.on('assistant.turn_start', () => {
				if (bg.turnStartTime === 0) bg.turnStartTime = Date.now();
			}),
			session.on('assistant.reasoning_delta', (event) => {
				bg.streamingReasoning += event.data.deltaContent;
				bg.reasoningComplete = false;
			}),
			session.on('assistant.reasoning', (event) => {
				if (event.data.content) {
					bg.streamingReasoning = event.data.content;
				}
				bg.reasoningComplete = bg.streamingReasoning.length > 0;
			}),
			session.on('assistant.message_delta', (event) => {
				bg.streamingContent += event.data.deltaContent;
				// No DOM rendering — session is hidden
			}),
			session.on('assistant.message', (event) => {
				if (typeof event.data.reasoningText === 'string' && event.data.reasoningText.length > 0) {
					bg.streamingReasoning = event.data.reasoningText;
					bg.reasoningComplete = true;
				}
				if (typeof event.data.content === 'string' && event.data.content !== bg.streamingContent) {
					bg.streamingContent = event.data.content;
				}
			}),
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
				if (bg.streamingContent || bg.streamingReasoning) {
					bg.messages.push({
						id: `a-${Date.now()}`,
						role: 'assistant',
						content: bg.streamingContent,
						reasoning: bg.streamingReasoning || undefined,
						timestamp: Date.now(),
					});
				}
				bg.streamingContent = '';
				bg.streamingReasoning = '';
				bg.reasoningComplete = false;
				bg.streamingBodyEl = null;
				bg.streamingWrapperEl = null;
				bg.toolCallsContainer = null;
				bg.reasoningEl = null;
				bg.reasoningBodyEl = null;
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
				bg.streamingReasoning = '';
				bg.reasoningComplete = false;
				bg.streamingBodyEl = null;
				bg.streamingWrapperEl = null;
				bg.toolCallsContainer = null;
				bg.reasoningEl = null;
				bg.reasoningBodyEl = null;
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
	};

	proto.restoreAgentFromSessionName = function (sessionId: string): void {
		let sessionName = this.sessionNames[sessionId] || '';
		// Strip session type prefix
		sessionName = sessionName.replace(/^\[(chat|inline|trigger|search)\]\s*/, '');
		const colonIdx = sessionName.indexOf(':');
		if (colonIdx > 0) {
			const agentName = sessionName.substring(0, colonIdx).trim();
			if (this.agents.some(a => a.name === agentName)) {
				this.selectAgent(agentName);
			}
		}
	};

	proto.selectSession = async function (sessionId: string): Promise<void> {
		if (sessionId === this.currentSessionId && this.currentSession) return;

		// ── Save current session to background (if streaming, keep it alive) ──
		if (this.currentSession && this.currentSessionId) {
			this.saveCurrentToBackground();
		}

		// Clear UI for the new session
		this.messages = [];
		if (this.fullRenderTimer) {
			clearTimeout(this.fullRenderTimer);
			this.fullRenderTimer = null;
		}
		this.streamingContent = '';
		this.lastFullRenderLen = 0;
		this.streamingBodyEl = null;
		this.streamingWrapperEl = null;
		this.toolCallsContainer = null;
		this.activeToolCalls.clear();
		this.clearReasoningState();
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
				selectedAgentName: this.selectedAgent || undefined,
				systemContent: agent?.instructions || undefined,
			});

			this.earlyEventBuffer = [];
			const session = await this.plugin.copilot!.resumeSession(sessionId, {
				...sessionConfig,
			});

			// Explicitly select the agent via RPC after resume
			if (sessionConfig.agent) {
				try {
					await session.rpc.agent.select({name: sessionConfig.agent});
				} catch (e) {
					console.warn('[sidekick] agent.select on resume failed:', e);
				}
			}

			// Load message history from SDK
			const events = await session.getMessages();
			const renderPromises: Promise<void>[] = [];
			let pendingReasoning: string | undefined;
			for (const event of events) {
				if (event.type === 'user.message') {
					const msg: ChatMessage = {
						id: event.id,
						role: 'user',
						content: event.data.content,
						timestamp: new Date(event.timestamp).getTime(),
					};
					this.messages.push(msg);
					renderPromises.push(this.renderMessageBubble(msg));
					pendingReasoning = undefined;
				} else if (event.type === 'assistant.reasoning') {
					pendingReasoning = event.data.content || pendingReasoning;
				} else if (event.type === 'assistant.message') {
					const reasoning = typeof event.data.reasoningText === 'string' && event.data.reasoningText.length > 0
						? event.data.reasoningText
						: pendingReasoning;
					const msg: ChatMessage = {
						id: event.id,
						role: 'assistant',
						content: event.data.content,
						reasoning,
						timestamp: new Date(event.timestamp).getTime(),
					};
					this.messages.push(msg);
					renderPromises.push(this.renderMessageBubble(msg));
					pendingReasoning = undefined;
				}
			}
			await Promise.all(renderPromises);

			if (this.messages.length === 0) {
				this.renderWelcome();
			}

			// Regular session — keep the handle active for interaction
			this.currentSession = session;
			this.currentSessionId = sessionId;
			this.configDirty = false;
			this.registerSessionEvents();
			this.updateToolbarLock();

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
	};

	proto.showSessionContextMenu = function (e: MouseEvent, sessionId: string): void {
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
	};

	proto.renameSession = function (sessionId: string): void {
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
	};

	proto.deleteSessionById = async function (sessionId: string): Promise<void> {
		// Clean up background session if it exists
		const bg = this.activeSessions.get(sessionId);
		if (bg) {
			for (const unsub of bg.unsubscribers) unsub();
			try { await bg.session.disconnect(); } catch { /* ignore */ }
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
	};

	proto.confirmDeleteDisplayedSessions = function (): void {
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
	};

	proto.getDisplayedSessions = function (): SessionMetadata[] {
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
	};

	proto.deleteDisplayedSessions = async function (sessions: SessionMetadata[]): Promise<void> {
		let deleted = 0;
		for (const session of sessions) {
			try {
				await this.deleteSessionById(session.sessionId);
				deleted++;
			} catch { /* continue with remaining */ }
		}
		new Notice(`Deleted ${deleted} session${deleted === 1 ? '' : 's'}.`);
	};

	proto.saveSessionNames = function (): void {
		this.plugin.settings.sessionNames = {...this.sessionNames};
		void this.plugin.saveSettings();
	};
}

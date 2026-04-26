import {Menu, Notice, TFile, normalizePath, setIcon} from 'obsidian';
import type {SidekickView} from '../sidekickView';
import type {SessionMetadata} from '../copilot';
import type {TriggerConfig} from '../types';
import {TriggerScheduler} from '../triggerScheduler';
import type {TriggerFireContext} from '../triggerScheduler';
import {debugTrace} from '../debug';
import {describeCron, describeGlob} from './utils';
import type {BackgroundSession} from './types';

declare module '../sidekickView' {
	interface SidekickView {
		buildTriggersPanel(parent: HTMLElement): void;
		renderTriggerHistory(): void;
		parseTriggerAgent(session: SessionMetadata): string;
		showTriggerHistoryContextMenu(e: MouseEvent, sessionId: string): void;
		renderTriggerConfigList(): void;
		initTriggerScheduler(): void;
		fireTriggerInBackground(trigger: TriggerConfig, context?: TriggerFireContext): Promise<void>;
	}
}

export function installTriggersPanel(ViewClass: {prototype: unknown}): void {
	const proto = ViewClass.prototype as SidekickView;

	proto.buildTriggersPanel = function (parent: HTMLElement): void {
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
	};

	proto.renderTriggerHistory = function (): void {
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
	};

	/** Parse agent name from a trigger session name. Format: "[trigger] Agent: content" */
	proto.parseTriggerAgent = function (session: SessionMetadata): string {
		const raw = this.sessionNames[session.sessionId] || '';
		const m = raw.match(/^\[trigger\]\s*([^:]+?):\s/);
		return m ? m[1]!.trim() : 'Chat';
	};

	proto.showTriggerHistoryContextMenu = function (e: MouseEvent, sessionId: string): void {
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
	};

	proto.renderTriggerConfigList = function (): void {
		if (!this.triggerConfigListEl) return;
		this.triggerConfigListEl.empty();

		const items = [...this.triggers];

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
			if (trigger.cron) scheduleParts.push(describeCron(trigger.cron));
			if (trigger.glob) scheduleParts.push(describeGlob(trigger.glob));
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

			// Context menu with "Fire trigger" (only when enabled)
			if (trigger.enabled) {
				item.addEventListener('contextmenu', (e) => {
					e.preventDefault();
					e.stopPropagation();
					const menu = new Menu();
					menu.addItem(mi => mi
						.setTitle('Fire trigger')
						.setIcon('play')
						.onClick(() => {
							void this.fireTriggerInBackground(trigger);
							new Notice(`Trigger fired: ${trigger.name}`);
						}));
					menu.showAtMouseEvent(e);
				});
			}
		}
	};

	/**
	 * Set up the trigger scheduler for cron-based and file-change-based triggers.
	 * Called once during onOpen after configs are loaded.
	 */
	proto.initTriggerScheduler = function (): void {
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
			this.app.vault.on('rename', (file, _oldPath) => {
				if (!(file instanceof TFile)) return;
				scheduleFileChangeCheck(file.path);
			})
		);
	};

	/**
	 * Fire a trigger as a background session.
	 * Creates a new SDK session with the trigger's agent, names it "Trigger: <description>",
	 * sends the trigger content as the user prompt, and routes all events to a BackgroundSession.
	 */
	proto.fireTriggerInBackground = async function (trigger: TriggerConfig, context?: TriggerFireContext): Promise<void> {
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
				streamingReasoning: '',
				reasoningComplete: false,
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
				reasoningEl: null,
				reasoningBodyEl: null,
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
	};
}

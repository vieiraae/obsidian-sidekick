/**
 * Telegram Bot service — handles long-polling, message routing,
 * topic-based session management, file attachments, and replying.
 */

import {normalizePath, Notice} from 'obsidian';
import type SidekickPlugin from '../main';
import type {SidekickView} from '../sidekickView';
import {SIDEKICK_VIEW_TYPE} from '../sidekickView';
import type {SessionConfig, CopilotSession, PermissionRequest, CustomAgentConfig} from '../copilot';
import {approveAll} from '../copilot';
import type {AgentConfig, SkillInfo, McpServerEntry} from '../types';
import {getSkillsFolder, getMcpInputValue} from '../settings';
import {loadAgents, loadSkills, loadMcpServers} from '../configLoader';
import type {InputResolver} from '../configLoader';
import {mapMcpServers} from '../view/sessionConfig';
import {resolveModelForAgent} from '../view/sessionConfig';
import type {TelegramMessage} from './telegramApi';
import {TelegramApi, TelegramApiError} from './telegramApi';
import type {BotConnectionStatus} from './types';

/** Key for a topic-based session: "chatId" or "chatId:threadId". */
function sessionKey(chatId: number, threadId?: number): string {
	return threadId != null ? `${chatId}:${threadId}` : `${chatId}`;
}

/** Maximum response length per Telegram message (4096 chars). */
const TG_MAX_LENGTH = 4096;

/** Typing indicator interval (5s, Telegram recommends refreshing). */
const TYPING_INTERVAL = 5000;

interface ActiveBotSession {
	sessionId: string;
	lastActivity: number;
	/** Serializes message processing — each message waits for the previous one. */
	queue: Promise<void>;
}

/**
 * Manages a Telegram bot connection including polling, session routing,
 * and message processing.
 */
export class TelegramBotService {
	private api: TelegramApi | null = null;
	private polling = false;
	private pollAbort: AbortController | null = null;
	private offset = 0;
	status: BotConnectionStatus = 'disconnected';
	botUsername = '';

	/** Active copilot sessions keyed by chat:thread. */
	private sessions = new Map<string, ActiveBotSession>();

	/** Cached agent/skill/tool configs (reloaded on connect). */
	private agents: AgentConfig[] = [];
	private skills: SkillInfo[] = [];
	private mcpServers: McpServerEntry[] = [];

	/** Status change callbacks. */
	private statusListeners: Array<(status: BotConnectionStatus) => void> = [];

	constructor(private plugin: SidekickPlugin) {}

	onStatusChange(cb: (status: BotConnectionStatus) => void): () => void {
		this.statusListeners.push(cb);
		return () => {
			this.statusListeners = this.statusListeners.filter(l => l !== cb);
		};
	}

	private setStatus(status: BotConnectionStatus): void {
		this.status = status;
		for (const cb of this.statusListeners) cb(status);
	}

	/** Connect to Telegram and start polling. */
	async connect(botToken: string): Promise<void> {
		if (this.polling) {
			await this.disconnect();
		}
		this.setStatus('connecting');

		// Require at least one allowed user before connecting
		const allowedRaw = this.plugin.settings.telegramAllowedUsers.trim();
		if (!allowedRaw) {
			this.setStatus('disconnected');
			throw new Error('Please add at least one allowed user ID before connecting.');
		}

		this.api = new TelegramApi(botToken);

		try {
			const me = await this.api.getMe();
			this.botUsername = me.username ?? me.first_name;
			new Notice(`Telegram bot @${this.botUsername} connected.`);
		} catch (e) {
			this.api = null;
			this.setStatus('error');
			const msg = e instanceof TelegramApiError ? e.description : String(e);
			throw new Error(msg);
		}

		// Load agent/skill/tool configs for session creation
		await this.reloadConfigs();

		this.setStatus('connected');
		this.startPolling();
	}

	/** Stop polling and disconnect. */
	async disconnect(): Promise<void> {
		this.polling = false;
		if (this.pollAbort) {
			this.pollAbort.abort();
			this.pollAbort = null;
		}

		// Clear all sessions (no handles to disconnect — they disconnect after each message)
		this.sessions.clear();

		this.api = null;
		this.botUsername = '';
		this.setStatus('disconnected');
	}

	isConnected(): boolean {
		return this.status === 'connected' && this.polling;
	}

	// ── Polling ──────────────────────────────────────────────────

	private startPolling(): void {
		this.polling = true;
		void this.pollLoop();
	}

	private async pollLoop(): Promise<void> {
		while (this.polling && this.api) {
			try {
				this.pollAbort = new AbortController();
				const updates = await this.api.getUpdates(this.offset, 30);
				for (const update of updates) {
					this.offset = update.update_id + 1;
					const msg = update.message ?? update.edited_message;
					if (msg) {
						void this.handleMessage(msg);
					}
				}
			} catch (e) {
				if (!this.polling) break; // disconnect was called
				console.error('Sidekick Telegram: poll error', e);
				// Back off on error
				await new Promise(r => setTimeout(r, 5000));
			}
		}
	}

	// ── Message handling ─────────────────────────────────────────

	private async handleMessage(msg: TelegramMessage): Promise<void> {
		const text = msg.text ?? msg.caption ?? '';
		const chatId = msg.chat.id;
		const threadId = msg.message_thread_id;

		// Check allowed users list — at least one user must be configured
		const allowedRaw = this.plugin.settings.telegramAllowedUsers.trim();
		const allowedIds = new Set(allowedRaw.split(',').map(s => s.trim()).filter(Boolean));
		const senderId = msg.from?.id?.toString();
		if (!senderId || !allowedIds.has(senderId)) {
			return; // silently ignore unauthorized users
		}

		// Ignore messages with no usable content
		if (!text && !msg.photo && !msg.document && !msg.audio && !msg.voice && !msg.video) {
			return;
		}

		// Handle /start command
		if (text === '/start') {
			await this.sendReply(chatId, threadId, `Hello! I'm your Sidekick assistant. Send me a message and I'll help you.`);
			return;
		}

		// Handle /help command
		if (text === '/help') {
			await this.sendReply(chatId, threadId,
				`I'm your Obsidian Sidekick bot. Here's what you can do:\n` +
				`• Send me any text message to chat\n` +
				`• Attach photos, documents, or audio\n` +
				`• Use forum topics for parallel conversations\n` +
				`• /start — Start a new conversation\n` +
				`• /new — Start a fresh session\n` +
				`• /help — Show this help`
			);
			return;
		}

		// Handle /new command — reset the session for this chat/topic
		if (text === '/new') {
			const key = sessionKey(chatId, threadId);
			this.sessions.delete(key);
			await this.sendReply(chatId, threadId, 'Session reset. Send a new message to start fresh.');
			return;
		}

		// Get or create session tracking entry (needed for queuing)
		const key = sessionKey(chatId, threadId);
		let entry = this.sessions.get(key);
		if (!entry) {
			entry = {
				sessionId: '', // will be set on first processMessage
				lastActivity: Date.now(),
				queue: Promise.resolve(),
			};
			this.sessions.set(key, entry);
		}

		// Queue this message so we serialize per chat/topic.
		const currentEntry = entry;
		entry.queue = entry.queue.then(() => this.processMessage(currentEntry, msg)).catch(() => {});
	}

	/** Process a single message within a serialized queue. */
	private async processMessage(entry: ActiveBotSession, msg: TelegramMessage): Promise<void> {
		const text = msg.text ?? msg.caption ?? '';
		const chatId = msg.chat.id;
		const threadId = msg.message_thread_id;

		// Send typing indicator
		const stopTyping = this.sendTypingLoop(chatId, threadId);

		try {
			entry.lastActivity = Date.now();

			// Download attachments if any
			const attachmentPaths = await this.downloadAttachments(msg);

			// Build SDK attachments
			const sdkAttachments: Array<{type: 'file'; path: string; displayName: string}> = [];
			for (const att of attachmentPaths) {
				sdkAttachments.push({type: 'file', path: att.path, displayName: att.name});
			}

			const sendOpts = {
				prompt: text || '(attachment)',
				...(sdkAttachments.length > 0 ? {attachments: sdkAttachments} : {}),
			};

			// Create a fresh session for each message. If we have a previous sessionId,
			// resume it to maintain conversation history. This avoids all shared-state
			// issues with the chat view's resumeSession taking over event listeners.
			const config = this.buildBotSessionConfig();
			let session: CopilotSession;
			if (entry.sessionId) {
				// Resume existing session to continue conversation
				session = await this.plugin.copilot!.resumeSession(entry.sessionId, config);
			} else {
				// First message — create new session
				session = await this.plugin.copilot!.createSession(config);
				entry.sessionId = session.sessionId;
			}

			try {
				const response = await session.sendAndWait(sendOpts, 120_000);
				const content = response?.data.content ?? '';

				if (content) {
					await this.sendReply(chatId, threadId, content, msg.message_id);
				}
			} finally {
				// Always disconnect our handle — the session persists server-side
				// and can be resumed by the next message or the chat view.
				try { await session.disconnect(); } catch { /* ignore */ }
			}

		} catch (e) {
			console.error('Sidekick Telegram: message handling error', e);
			// If session is broken, clear it so next message creates a fresh one
			if (String(e).includes('Session not found')) {
				entry.sessionId = '';
			}
			const errorText = e instanceof Error ? e.message : String(e);
			await this.sendReply(chatId, threadId, `Error: ${errorText}`);
		} finally {
			stopTyping();
		}
	}

	// ── Session creation ─────────────────────────────────────────

	private buildBotSessionConfig(): SessionConfig {
		const basePath = this.getVaultBasePath();
		const defaultAgentName = this.plugin.settings.telegramDefaultAgent;

		// Resolve agent
		const agent = defaultAgentName
			? this.agents.find(a => a.name === defaultAgentName)
			: undefined;

		// Tools — agent may restrict to specific tool servers
		let enabledServers: Set<string>;
		if (agent?.tools !== undefined) {
			const allowed = new Set(agent.tools);
			enabledServers = new Set(this.mcpServers.filter(s => allowed.has(s.name)).map(s => s.name));
		} else {
			enabledServers = new Set(this.mcpServers.map(s => s.name));
		}
		const mcpServers = mapMcpServers(this.mcpServers, enabledServers);

		// Skills
		const skillDirs: string[] = [];
		if (this.skills.length > 0) {
			skillDirs.push([basePath, getSkillsFolder(this.plugin.settings)].join('/'));
		}
		let disabledSkills: string[] = [];
		if (agent?.skills !== undefined) {
			const allowed = new Set(agent.skills);
			disabledSkills = this.skills.filter(s => !allowed.has(s.name)).map(s => s.name);
		}

		// Custom agents
		const agentPool = agent ? [agent] : this.agents;
		const customAgents: CustomAgentConfig[] = agentPool.map(a => ({
			name: a.name,
			displayName: a.name,
			description: a.description || undefined,
			prompt: a.instructions,
			tools: a.tools ?? null,
			infer: true,
		}));

		// Model
		const models = this.getAvailableModels();
		const model = resolveModelForAgent(agent, models, undefined);

		// Permission handler — auto-approve for bot sessions
		const permissionHandler = (request: PermissionRequest) => {
			if (this.plugin.settings.toolApproval === 'allow') {
				return approveAll(request, {sessionId: ''});
			}
			// For bot sessions, auto-approve since there's no UI to ask
			return approveAll(request, {sessionId: ''});
		};

		// BYOK provider
		const providerPreset = this.plugin.settings.providerPreset;
		let provider: import('../copilot').ProviderConfig | undefined;
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

		const reasoningEffort = this.plugin.settings.reasoningEffort;

		return {
			model: (provider && this.plugin.settings.providerModel) ? this.plugin.settings.providerModel : model,
			streaming: providerPreset !== 'foundry-local',
			onPermissionRequest: permissionHandler,
			workingDirectory: basePath,
			...(reasoningEffort !== '' ? {reasoningEffort: reasoningEffort as import('../copilot').ReasoningEffort} : {}),
			...(provider ? {provider} : {}),
			...(Object.keys(mcpServers).length > 0 ? {mcpServers} : {}),
			...(customAgents.length > 0 ? {customAgents} : {}),
			...(skillDirs.length > 0 ? {skillDirectories: skillDirs} : {}),
			...(disabledSkills.length > 0 ? {disabledSkills} : {}),
		};
	}

	// ── Replies ──────────────────────────────────────────────────

	private async sendReply(chatId: number, threadId: number | undefined, text: string, replyToMessageId?: number): Promise<void> {
		if (!this.api) return;

		// Split long messages (Telegram max 4096 chars)
		const chunks = this.splitMessage(text);
		for (const chunk of chunks) {
			try {
				await this.api.sendMessage({
					chat_id: chatId,
					text: chunk,
					...(threadId != null ? {message_thread_id: threadId} : {}),
					...(replyToMessageId != null ? {reply_to_message_id: replyToMessageId} : {}),
				});
			} catch (e) {
				// If markdown parsing fails, retry as plain text
				if (e instanceof TelegramApiError && e.description.includes("can't parse")) {
					await this.api.sendMessage({
						chat_id: chatId,
						text: chunk,
						...(threadId != null ? {message_thread_id: threadId} : {}),
						...(replyToMessageId != null ? {reply_to_message_id: replyToMessageId} : {}),
					});
				} else {
					throw e;
				}
			}
			// Only reply-to the first chunk
			replyToMessageId = undefined;
		}
	}

	private splitMessage(text: string): string[] {
		if (text.length <= TG_MAX_LENGTH) return [text];

		const chunks: string[] = [];
		let remaining = text;
		while (remaining.length > 0) {
			if (remaining.length <= TG_MAX_LENGTH) {
				chunks.push(remaining);
				break;
			}
			// Try to split at a newline near the limit
			let splitAt = remaining.lastIndexOf('\n', TG_MAX_LENGTH);
			if (splitAt < TG_MAX_LENGTH / 2) {
				// No good newline, try space
				splitAt = remaining.lastIndexOf(' ', TG_MAX_LENGTH);
			}
			if (splitAt < TG_MAX_LENGTH / 2) {
				splitAt = TG_MAX_LENGTH;
			}
			chunks.push(remaining.slice(0, splitAt));
			remaining = remaining.slice(splitAt).trimStart();
		}
		return chunks;
	}

	/** Send typing indicator in a loop until the returned stop function is called. */
	private sendTypingLoop(chatId: number, threadId: number | undefined): () => void {
		let running = true;
		const loop = async () => {
			while (running && this.api) {
				try {
					await this.api.sendChatAction({
						chat_id: chatId,
						action: 'typing',
						...(threadId != null ? {message_thread_id: threadId} : {}),
					});
				} catch { /* ignore */ }
				await new Promise(r => setTimeout(r, TYPING_INTERVAL));
			}
		};
		void loop();
		return () => { running = false; };
	}

	// ── Attachments ──────────────────────────────────────────────

	private async downloadAttachments(msg: TelegramMessage): Promise<Array<{name: string; path: string}>> {
		if (!this.api) return [];

		const results: Array<{name: string; path: string}> = [];
		const filesToDownload: Array<{fileId: string; name: string}> = [];

		// Photos — pick the largest resolution
		if (msg.photo && msg.photo.length > 0) {
			const largest = msg.photo[msg.photo.length - 1]!;
			filesToDownload.push({fileId: largest.file_id, name: `photo_${msg.message_id}.jpg`});
		}

		if (msg.document) {
			filesToDownload.push({fileId: msg.document.file_id, name: msg.document.file_name ?? `doc_${msg.message_id}`});
		}

		if (msg.audio) {
			filesToDownload.push({fileId: msg.audio.file_id, name: msg.audio.file_name ?? `audio_${msg.message_id}.mp3`});
		}

		if (msg.voice) {
			filesToDownload.push({fileId: msg.voice.file_id, name: `voice_${msg.message_id}.ogg`});
		}

		if (msg.video) {
			filesToDownload.push({fileId: msg.video.file_id, name: msg.video.file_name ?? `video_${msg.message_id}.mp4`});
		}

		for (const file of filesToDownload) {
			try {
				const fileInfo = await this.api.getFile(file.fileId);
				if (!fileInfo.file_path) continue;

				const data = await this.api.downloadFile(fileInfo.file_path);

				// Save to temp location in vault
				const tempDir = normalizePath(`${this.plugin.settings.sidekickFolder}/bot-attachments`);
				const adapter = this.plugin.app.vault.adapter;
				if (!await adapter.exists(tempDir)) {
					await adapter.mkdir(tempDir);
				}

				// Sanitize filename
				const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
				const filePath = normalizePath(`${tempDir}/${Date.now()}_${safeName}`);
				await adapter.writeBinary(filePath, data);

				const basePath = this.getVaultBasePath();
				results.push({name: safeName, path: `${basePath}/${filePath}`});
			} catch (e) {
				console.error(`Sidekick Telegram: failed to download file ${file.name}`, e);
			}
		}

		return results;
	}

	// ── Helpers ──────────────────────────────────────────────────

	private getSidekickView(): SidekickView | null {
		const leaves = this.plugin.app.workspace.getLeavesOfType(SIDEKICK_VIEW_TYPE);
		if (leaves.length > 0 && leaves[0]) {
			return leaves[0].view as SidekickView;
		}
		return null;
	}

	private getVaultBasePath(): string {
		return (this.plugin.app.vault.adapter as unknown as {basePath: string}).basePath;
	}

	private getAvailableModels(): import('../copilot').ModelInfo[] {
		const view = this.getSidekickView();
		return view?.models ?? [];
	}

	async reloadConfigs(): Promise<void> {
		try {
			const app = this.plugin.app;
			const s = this.plugin.settings;

			// Resolve stored input values (no UI prompts — bot runs headless)
			const inputResolver: InputResolver = async (input) => {
				const isPassword = input.password === true;
				return getMcpInputValue(app, this.plugin, input.id, isPassword);
			};

			const [agents, skills, mcpServers] = await Promise.all([
				loadAgents(app, normalizePath(`${s.sidekickFolder}/agents`)),
				loadSkills(app, normalizePath(`${s.sidekickFolder}/skills`)),
				loadMcpServers(app, normalizePath(`${s.sidekickFolder}/tools`), inputResolver),
			]);
			this.agents = agents;
			this.skills = skills;
			this.mcpServers = mcpServers;
		} catch (e) {
			console.error('Sidekick Telegram: failed to reload configs', e);
		}
	}
}

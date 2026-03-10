import {CopilotClient, CopilotSession, approveAll} from '@github/copilot-sdk';
import type {
	ConnectionState,
	CustomAgentConfig,
	ModelInfo,
	SessionConfig,
	SessionMetadata,
	SessionListFilter,
	GetAuthStatusResponse,
	AssistantMessageEvent,
	MCPServerConfig,
	MCPRemoteServerConfig,
	MCPLocalServerConfig,
	SessionEvent,
	SessionEventType,
	MessageOptions,
	PermissionRequest,
	PermissionRequestResult,
	PermissionHandler,
} from '@github/copilot-sdk';
import type {ProviderConfig, UserInputHandler, UserInputRequest, UserInputResponse, ReasoningEffort} from '@github/copilot-sdk/dist/types';

// Available at runtime in the esbuild CJS bundle.
const nodeRequire = typeof globalThis.require === 'function' ? globalThis.require : undefined;
declare const __dirname: string;
declare const process: {
	platform: string;
	arch: string;
	env: Record<string, string | undefined>;
	cwd(): string;
};

/**
 * Resolve the platform-specific Copilot native binary from node_modules.
 * Falls back to the JS entry point if the native binary is not found.
 */
async function resolveDefaultCliPath(): Promise<string> {
	// Lazy-load Node.js builtins so the module can be imported on mobile
	const path = nodeRequire?.('node:path') as typeof import('node:path') ?? await import('node:path');
	const fs = nodeRequire?.('node:fs/promises') as typeof import('node:fs/promises') ?? await import('node:fs/promises');
	const nativePkg = `@github/copilot-${process.platform}-${process.arch}`;
	const ext = process.platform === 'win32' ? '.exe' : '';
	const nativeBin = path.join(__dirname, 'node_modules', nativePkg, `copilot${ext}`);
	try {
		await fs.access(nativeBin);
		return nativeBin;
	} catch {
		// Fallback to the JS CLI entry point
		return path.join(__dirname, 'node_modules', '@github', 'copilot', 'index.js');
	}
}

/**
 * Build a clean environment for the Copilot CLI subprocess.
 * Uses an allowlist of safe, well-known environment variables
 * to avoid leaking sensitive or Electron-specific values.
 */
function cleanEnv(): Record<string, string> {
	const ALLOWED_PREFIXES = [
		'PATH', 'HOME', 'USERPROFILE', 'TMPDIR', 'TEMP', 'TMP',
		'LANG', 'LC_', 'SHELL', 'TERM', 'COLORTERM',
		'USER', 'USERNAME', 'LOGNAME', 'HOSTNAME',
		'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PROGRAMFILES',
		'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH',
		'XDG_', 'DISPLAY', 'WAYLAND_DISPLAY',
		'NODE_', 'NPM_', 'NVM_',
		'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY',
		'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
		'GITHUB_', 'GH_', 'COPILOT_',
		'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
	];
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value === undefined) continue;
		if (ALLOWED_PREFIXES.some(prefix => key === prefix || key.startsWith(prefix))) {
			env[key] = value;
		}
	}
	return env;
}

/**
 * Manages the CopilotClient lifecycle and provides high-level methods
 * for interacting with the Copilot SDK from within Obsidian.
 */
export class CopilotService {
	private client: CopilotClient | null = null;
	private readonly cliPath: string | undefined;
	private readonly cliUrl: string | undefined;
	private readonly githubToken: string | undefined;
	private readonly useLoggedInUser: boolean | undefined;

	constructor(opts?: {
		cliPath?: string;
		cliUrl?: string;
		githubToken?: string;
		useLoggedInUser?: boolean;
	}) {
		this.cliPath = opts?.cliPath;
		this.cliUrl = opts?.cliUrl;
		this.githubToken = opts?.githubToken;
		this.useLoggedInUser = opts?.useLoggedInUser;
	}

	private async createClient(): Promise<CopilotClient> {
		if (this.cliUrl) {
			// Remote mode — connect to existing server
			return new CopilotClient({
				cliUrl: this.cliUrl,
				...(this.githubToken ? {githubToken: this.githubToken} : {}),
			});
		}
		// Local mode — spawn CLI process
		const cliPath = this.cliPath || await resolveDefaultCliPath();
		const os = nodeRequire?.('node:os') as typeof import('node:os') ?? await import('node:os');
		return new CopilotClient({
			cliPath: cliPath,
			cwd: os.homedir(),
			env: cleanEnv(),
			...(this.githubToken ? {githubToken: this.githubToken} : {}),
			...(this.useLoggedInUser !== undefined ? {useLoggedInUser: this.useLoggedInUser} : {}),
		});
	}

	/**
	 * Ensure the client is started and connected.
	 * If the client is in a broken state, recreates it before starting.
	 */
	async ensureConnected(): Promise<void> {
		if (!this.client) {
			this.client = await this.createClient();
		}
		const state = this.client.getState();
		if (state === 'connected') {
			return;
		}
		if (state === 'error') {
			// Previous client is broken — tear it down and recreate.
			try { await this.client.forceStop(); } catch { /* ignore */ }
			this.client = await this.createClient();
		}
		await this.client.start();
	}

	/** Current connection state. */
	getState(): ConnectionState {
		return this.client?.getState() ?? 'disconnected';
	}

	// ── Authentication ──────────────────────────────────────────────

	/** Check the current authentication status against the Copilot backend. */
	async getAuthStatus(): Promise<GetAuthStatusResponse> {
		await this.ensureConnected();
		return await this.client!.getAuthStatus();
	}

	// ── Models ──────────────────────────────────────────────────────

	/** List available models with capabilities, policy and billing info. */
	async listModels(): Promise<ModelInfo[]> {
		await this.ensureConnected();
		return await this.client!.listModels();
	}

	// ── Sessions ────────────────────────────────────────────────────

	/**
	 * Create a new conversation session.
	 *
	 * @param config - Session configuration (model, tools, system message, etc.)
	 * @returns The newly created CopilotSession.
	 */
	async createSession(config: SessionConfig): Promise<CopilotSession> {
		await this.ensureConnected();
		return await this.client!.createSession({clientName: 'obsidian-sidekick', ...config});
	}

	/**
	 * Resume an existing session by its ID.
	 *
	 * @param sessionId - ID of the session to resume.
	 * @param config - Optional overrides (model, tools, etc.).
	 */
	async resumeSession(
		sessionId: string,
		config: Omit<SessionConfig, 'clientName'>,
	): Promise<CopilotSession> {
		await this.ensureConnected();
		return await this.client!.resumeSession(sessionId, {
			clientName: 'obsidian-sidekick',
			...config,
		});
	}

	/** List all persisted sessions, optionally filtered. */
	async listSessions(filter?: SessionListFilter): Promise<SessionMetadata[]> {
		await this.ensureConnected();
		return await this.client!.listSessions(filter);
	}

	/** Permanently delete a session and its data. */
	async deleteSession(sessionId: string): Promise<void> {
		await this.ensureConnected();
		return await this.client!.deleteSession(sessionId);
	}

	/** Get the most recently updated session ID, if any. */
	async getLastSessionId(): Promise<string | undefined> {
		await this.ensureConnected();
		return await this.client!.getLastSessionId();
	}

	// ── Convenience: one-shot chat ──────────────────────────────────

	/**
	 * Send a single prompt and wait for the assistant's response.
	 * Creates a temporary session, sends the message, waits for idle,
	 * then destroys the session.
	 *
	 * @param prompt - The user prompt.
	 * @param model  - Model to use (e.g. "gpt-5", "claude-sonnet-4.5").
	 * @param systemMessage - Optional system message content to append.
	 * @param customAgents - Optional custom agent configs.
	 * @returns The assistant's final message content, or undefined.
	 */
	async chat(options: {
		prompt: string;
		model?: string;
		systemMessage?: string;
		customAgents?: CustomAgentConfig[];
		onPermissionRequest?: PermissionHandler;
		onUserInputRequest?: UserInputHandler;
		attachments?: MessageOptions['attachments'];
	}): Promise<string | undefined> {
		const session = await this.createSession({
			model: options.model,
			onPermissionRequest: options.onPermissionRequest ?? approveAll,
			...(options.onUserInputRequest ? {onUserInputRequest: options.onUserInputRequest} : {}),
			customAgents: options.customAgents,
			...(options.systemMessage
				? {systemMessage: {content: options.systemMessage}}
				: {}),
		});
		try {
			const response: AssistantMessageEvent | undefined =
				await session.sendAndWait({
					prompt: options.prompt,
					...(options.attachments && options.attachments.length > 0 ? {attachments: options.attachments} : {}),
				});
			return response?.data.content;
		} finally {
			await session.destroy();
		}
	}

	/**
	 * Send a single prompt, wait for the response, and keep the session alive.
	 * Like chat() but the session is NOT destroyed, so it persists in the
	 * session list and can be resumed later.
	 *
	 * @returns Object containing the assistant's response content and the sessionId.
	 */
	async inlineChat(options: {
		prompt: string;
		model?: string;
		systemMessage?: string;
		customAgents?: CustomAgentConfig[];
		onPermissionRequest?: PermissionHandler;
		onUserInputRequest?: UserInputHandler;
		attachments?: MessageOptions['attachments'];
	}): Promise<{content: string | undefined; sessionId: string}> {
		const session = await this.createSession({
			model: options.model,
			onPermissionRequest: options.onPermissionRequest ?? approveAll,
			...(options.onUserInputRequest ? {onUserInputRequest: options.onUserInputRequest} : {}),
			customAgents: options.customAgents,
			...(options.systemMessage
				? {systemMessage: {content: options.systemMessage}}
				: {}),
		});
		const response: AssistantMessageEvent | undefined =
			await session.sendAndWait({
				prompt: options.prompt,
				...(options.attachments && options.attachments.length > 0 ? {attachments: options.attachments} : {}),
			});
		return {content: response?.data.content, sessionId: session.sessionId};
	}

	// ── Health ───────────────────────────────────────────────────────

	/** Ping the Copilot CLI server to verify connectivity. */
	async ping(): Promise<{message: string; timestamp: number}> {
		await this.ensureConnected();
		return await this.client!.ping();
	}

	// ── Lifecycle ───────────────────────────────────────────────────

	/**
	 * Gracefully stop the client. Falls back to forceStop on errors.
	 * Call this from the plugin's `onunload()`.
	 */
	async stop(): Promise<void> {
		if (!this.client) return;
		const errors = await this.client.stop();
		if (errors.length > 0) {
			console.error('Copilot service stop errors:', errors);
			await this.client.forceStop();
		}
	}
}

export {approveAll};

export type {
	CopilotSession,
	ModelInfo,
	SessionMetadata,
	ConnectionState,
	GetAuthStatusResponse,
	CustomAgentConfig,
	AssistantMessageEvent,
	SessionConfig,
	MCPServerConfig,
	MCPRemoteServerConfig,
	MCPLocalServerConfig,
	SessionEvent,
	SessionEventType,
	MessageOptions,
	PermissionRequest,
	PermissionRequestResult,
	PermissionHandler,
	UserInputHandler,
	UserInputRequest,
	UserInputResponse,
	SessionListFilter,
	ProviderConfig,
	ReasoningEffort,
};

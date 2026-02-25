import {CopilotClient, CopilotSession, approveAll} from '@github/copilot-sdk';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
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

// Available at runtime in the esbuild CJS bundle.
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
function resolveDefaultCliPath(): string {
	const nativePkg = `@github/copilot-${process.platform}-${process.arch}`;
	const ext = process.platform === 'win32' ? '.exe' : '';
	const nativeBin = join(__dirname, 'node_modules', nativePkg, `copilot${ext}`);
	if (existsSync(nativeBin)) {
		return nativeBin;
	}
	// Fallback to the JS CLI entry point
	return join(__dirname, 'node_modules', '@github', 'copilot', 'index.js');
}

/**
 * Build a clean environment for the Copilot CLI subprocess.
 * Strips Electron-specific variables that can interfere with native binaries.
 */
function cleanEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined
			&& !key.startsWith('ELECTRON_')
			&& key !== 'ORIGINAL_XDG_CURRENT_DESKTOP') {
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
	private client: CopilotClient;
	private readonly cliPath: string | undefined;

	/**
	 * @param cliPath - Optional explicit path to the Copilot CLI.
	 *                   When omitted the SDK resolves it automatically.
	 */
	constructor(cliPath?: string) {
		this.cliPath = cliPath;
		this.client = this.createClient();
	}

	private createClient(): CopilotClient {
		const cliPath = this.cliPath || resolveDefaultCliPath();
		return new CopilotClient({
			cliPath: cliPath,
			autoStart: false,
			autoRestart: false,
			cwd: homedir(),
			env: cleanEnv(),
		});
	}

	/**
	 * Ensure the client is started and connected.
	 * If the client is in a broken state, recreates it before starting.
	 */
	async ensureConnected(): Promise<void> {
		const state = this.client.getState();
		if (state === 'connected') {
			return;
		}
		if (state === 'error') {
			// Previous client is broken — tear it down and recreate.
			try { await this.client.forceStop(); } catch { /* ignore */ }
			this.client = this.createClient();
		}
		await this.client.start();
	}

	/** Current connection state. */
	getState(): ConnectionState {
		return this.client.getState();
	}

	// ── Authentication ──────────────────────────────────────────────

	/** Check the current authentication status against the Copilot backend. */
	async getAuthStatus(): Promise<GetAuthStatusResponse> {
		await this.ensureConnected();
		return await this.client.getAuthStatus();
	}

	// ── Models ──────────────────────────────────────────────────────

	/** List available models with capabilities, policy and billing info. */
	async listModels(): Promise<ModelInfo[]> {
		await this.ensureConnected();
		return await this.client.listModels();
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
		return await this.client.createSession(config);
	}

	/**
	 * Resume an existing session by its ID.
	 *
	 * @param sessionId - ID of the session to resume.
	 * @param config - Optional overrides (model, tools, etc.).
	 */
	async resumeSession(
		sessionId: string,
		config?: Partial<SessionConfig>,
	): Promise<CopilotSession> {
		await this.ensureConnected();
		return await this.client.resumeSession(sessionId, {
			onPermissionRequest: approveAll,
			...config,
		});
	}

	/** List all persisted sessions, optionally filtered. */
	async listSessions(filter?: SessionListFilter): Promise<SessionMetadata[]> {
		await this.ensureConnected();
		return await this.client.listSessions(filter);
	}

	/** Permanently delete a session and its data. */
	async deleteSession(sessionId: string): Promise<void> {
		await this.ensureConnected();
		return await this.client.deleteSession(sessionId);
	}

	/** Get the most recently updated session ID, if any. */
	async getLastSessionId(): Promise<string | undefined> {
		await this.ensureConnected();
		return await this.client.getLastSessionId();
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
	}): Promise<string | undefined> {
		const session = await this.createSession({
			model: options.model,
			onPermissionRequest: approveAll,
			customAgents: options.customAgents,
			...(options.systemMessage
				? {systemMessage: {content: options.systemMessage}}
				: {}),
		});
		try {
			const response: AssistantMessageEvent | undefined =
				await session.sendAndWait({prompt: options.prompt});
			return response?.data.content;
		} finally {
			await session.destroy();
		}
	}

	// ── Health ───────────────────────────────────────────────────────

	/** Ping the Copilot CLI server to verify connectivity. */
	async ping(): Promise<{message: string; timestamp: number}> {
		await this.ensureConnected();
		return await this.client.ping();
	}

	// ── Lifecycle ───────────────────────────────────────────────────

	/**
	 * Gracefully stop the client. Falls back to forceStop on errors.
	 * Call this from the plugin's `onunload()`.
	 */
	async stop(): Promise<void> {
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
};

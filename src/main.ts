import {Plugin} from 'obsidian';
import {DEFAULT_SETTINGS, SidekickSettings, SidekickSettingTab, SECURE_FIELDS, loadSecureField, saveSecureField} from "./settings";
import {CopilotService} from "./copilot";
import {SidekickView, SIDEKICK_VIEW_TYPE} from "./sidekickView";
import {registerEditorMenu, registerFileMenu} from './editor/editorMenu';
import {buildGhostTextExtension} from './editor/ghostText';
import {TelegramBotService} from './bots';

export default class SidekickPlugin extends Plugin {
	settings!: SidekickSettings;
	copilot: CopilotService | null = null;
	telegramBot: TelegramBotService | null = null;

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new SidekickSettingTab(this.app, this));

		// Register the Sidekick chat view
		this.registerView(SIDEKICK_VIEW_TYPE, (leaf) => new SidekickView(leaf, this));

		// Ribbon icon to open view
		this.addRibbonIcon('brain', 'Open sidekick', () => void this.activateView());

		// Command to open view
		this.addCommand({
			id: 'open-chat',
			name: 'Open chat',
			callback: () => void this.activateView(),
		});

		// Editor context menu (Sidekick submenu for selected text)
		registerEditorMenu(this);

		// Vault tree context menu (Sidekick submenu for note files)
		registerFileMenu(this);

		// Ghost-text autocomplete (inline suggestions)
		this.registerEditorExtension(buildGhostTextExtension(this));

		try {
			await this.initCopilot();
		} catch (e) {
			console.error('Sidekick: failed to initialize Copilot service', e);
		}
	}

	async initCopilot(): Promise<void> {
		if (this.copilot) {
			try {
				await this.copilot.stop();
			} catch {
				// ignore stop errors
			}
			this.copilot = null;
		}
		const s = this.settings;

		// BYOK model listing: when a non-GitHub provider is configured, fetch
		// models from the provider endpoint so client.listModels() returns them.
		const onListModels = this.buildOnListModels();

		if (s.copilotType === 'remote') {
			const url = s.cliUrl.trim();
			this.copilot = new CopilotService({
				cliUrl: url || undefined,
				githubToken: s.githubToken || undefined,
				...(onListModels ? {onListModels} : {}),
			});
		} else {
			const loc = s.copilotLocation.trim();
			this.copilot = new CopilotService({
				cliPath: loc.length > 0 ? loc : undefined,
				useLoggedInUser: s.useLoggedInUser,
				githubToken: !s.useLoggedInUser && s.githubToken ? s.githubToken : undefined,
				...(onListModels ? {onListModels} : {}),
			});
		}
	}

	/**
	 * Build an onListModels callback for BYOK providers that fetches models
	 * from the provider's endpoint. Returns undefined for GitHub preset.
	 */
	private buildOnListModels(): (() => Promise<import('./copilot').ModelInfo[]>) | undefined {
		const s = this.settings;
		if (s.providerPreset === 'github' || !s.providerBaseUrl) return undefined;

		const baseUrl = s.providerBaseUrl.replace(/\/$/, '');
		const apiKey = s.providerApiKey;
		const bearerToken = s.providerBearerToken;
		const preset = s.providerPreset;

		return async (): Promise<import('./copilot').ModelInfo[]> => {
			try {
				const headers: Record<string, string> = {'Content-Type': 'application/json'};
				if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
				else if (bearerToken) headers['Authorization'] = `Bearer ${bearerToken}`;

				// Ollama uses /api/tags, OpenAI-compatible use /v1/models
				const url = preset === 'ollama'
					? `${baseUrl}/api/tags`
					: `${baseUrl}/v1/models`;

				const resp = await fetch(url, {headers});
				if (!resp.ok) return [];
				const json = await resp.json() as Record<string, unknown>;

				if (preset === 'ollama') {
					// Ollama format: { models: [{ name, ... }] }
					const models = (json.models ?? []) as Array<{name: string; modified_at?: string}>;
					return models.map(m => ({
						id: m.name,
						name: m.name,
						version: m.name,
						capabilities: {supports: {vision: false, reasoningEffort: false}, limits: {max_context_window_tokens: 0}},
					})) as import('./copilot').ModelInfo[];
				}
				// OpenAI-compatible format: { data: [{ id, ... }] }
				const data = (json.data ?? []) as Array<{id: string; name?: string}>;
				return data.map(m => ({
					id: m.id,
					name: m.name ?? m.id,
					version: m.id,
					capabilities: {supports: {vision: false, reasoningEffort: false}, limits: {max_context_window_tokens: 0}},
				})) as import('./copilot').ModelInfo[];
			} catch {
				return [];
			}
		};
	}

	onunload() {
		if (this.copilot) {
			void this.copilot.stop();
		}
		if (this.telegramBot) {
			void this.telegramBot.disconnect();
		}
	}

	async connectTelegram(): Promise<void> {
		const token = this.settings.telegramBotToken;
		if (!token) throw new Error('No bot token configured.');
		if (!this.telegramBot) {
			this.telegramBot = new TelegramBotService(this);
		}
		await this.telegramBot.connect(token);
	}

	disconnectTelegram(): void {
		if (this.telegramBot) {
			this.telegramBot.disconnect();
		}
	}

	async activateView(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(SIDEKICK_VIEW_TYPE);
		if (existing.length > 0 && existing[0]) {
			void this.app.workspace.revealLeaf(existing[0]);
			return;
		}
		const leaf = this.app.workspace.getRightLeaf(false);
		if (leaf) {
			await leaf.setViewState({type: SIDEKICK_VIEW_TYPE, active: true});
			void this.app.workspace.revealLeaf(leaf);
		}
	}

	async loadSettings() {
		const raw = await this.loadData() as Partial<SidekickSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, raw);

		// Migrate any plaintext secrets from data.json to local storage, then strip
		let needsSave = false;
		for (const key of SECURE_FIELDS) {
			const plaintext = raw?.[key];
			if (plaintext && typeof plaintext === 'string') {
				// Migrate: write to local storage if not already present
				const existing = loadSecureField(this.app, key);
				if (!existing) {
					saveSecureField(this.app, key, plaintext);
				}
				needsSave = true;
			}
			// Load from secure storage into runtime settings
			(this.settings as unknown as Record<string, unknown>)[key] = loadSecureField(this.app, key);
		}

		// Strip plaintext secrets from data.json if they were present
		if (needsSave) {
			await this.saveSettings();
		}
	}

	async saveSettings() {
		// Clone settings and strip secure fields before writing to data.json
		const dataToSave = {...this.settings};
		for (const key of SECURE_FIELDS) {
			(dataToSave as Record<string, unknown>)[key] = '';
		}
		await this.saveData(dataToSave);
	}
}

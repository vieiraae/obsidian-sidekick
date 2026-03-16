import {App, Modal, Notice, PluginSettingTab, Setting, normalizePath} from "obsidian";
import SidekickPlugin from "./main";
import type {ModelInfo, ProviderConfig} from "./copilot";
import type {McpInputVariable} from "./types";
import {loadMcpInputs, loadAgents} from "./configLoader";

const DEFAULT_COPILOT_LOCATION = '';

/** Helper to update a secure field in both runtime settings and local storage. */
function updateSecureField(app: App, plugin: SidekickPlugin, key: keyof SidekickSettings, value: string): void {
	(plugin.settings as unknown as Record<string, unknown>)[key] = value;
	saveSecureField(app, key, value);
}

export interface SidekickSettings {
	/** 'local' uses cliPath, 'remote' uses cliUrl. */
	copilotType: 'local' | 'remote';
	copilotLocation: string;
	/** URL of an existing CLI server to connect to. */
	cliUrl: string;
	/** Use the logged-in GitHub user for auth (local mode). */
	useLoggedInUser: boolean;
	/** GitHub personal access token (used when useLoggedInUser is false or in remote mode). */
	githubToken: string;
	sidekickFolder: string;
	toolApproval: 'ask' | 'allow';
	/** Model ID used for inline editor operations (context menu). Empty = SDK default. */
	inlineModel: string;
	/** Enable ghost-text autocomplete in the editor. */
	autocompleteEnabled: boolean;
	/** Provider preset for BYOK. 'github' uses built-in auth. */
	providerPreset: 'github' | 'openai' | 'azure' | 'anthropic' | 'ollama' | 'foundry-local' | 'other-openai';
	/** Base URL for the BYOK provider endpoint. */
	providerBaseUrl: string;
	/** API key for the BYOK provider. */
	providerApiKey: string;
	/** Bearer token for the BYOK provider. */
	providerBearerToken: string;
	/** Wire API format: completions or responses. */
	providerWireApi: 'completions' | 'responses';
	/** Model name/ID to use with a BYOK provider. */
	providerModel: string;
	/** Persisted form defaults for the Edit modal. */
	editModalDefaults?: EditModalDefaults;
	/** Custom display names for sessions, keyed by SDK sessionId. */
	sessionNames?: Record<string, string>;
	/** Last-fired timestamps for trigger deduplication, keyed by trigger name. */
	triggerLastFired?: Record<string, number>;
	/** Stored values for non-password MCP input variables, keyed by input id. */
	mcpInputValues?: Record<string, string>;
	/** Reasoning effort level for model inference. 'default' means unset. */
	reasoningEffort: '' | 'low' | 'medium' | 'high' | 'xhigh';
	/** Agent name used for semantic search. */
	searchAgent: string;
	/** Search mode: 'basic' reuses session with minimal config, 'advanced' allows full agent/model/skills/tools. */
	searchMode: 'basic' | 'advanced';

	/** Telegram Bot ID (informational, not secret). */
	telegramBotId: string;
	/** Telegram Bot token (stored securely via local storage). */
	telegramBotToken: string;
	/** Comma-separated list of allowed Telegram user IDs. Empty = allow all. */
	telegramAllowedUsers: string;
	/** Default agent for Telegram bot sessions. */
	telegramDefaultAgent: string;
}

/** Persisted preferences for the Edit modal form. */
export interface EditModalDefaults {
	task: string;
	adjustTask: boolean;
	tone: string;
	adjustTone: boolean;
	format: string;
	adjustFormat: boolean;
	length: number;
	adjustLength: boolean;
	choices: number;
	editPrompt: string;
}

export const DEFAULT_EDIT_MODAL: EditModalDefaults = {
	task: 'Rewrite',
	adjustTask: false,
	tone: 'Professional',
	adjustTone: false,
	format: 'Single paragraph',
	adjustFormat: false,
	length: 5,
	adjustLength: false,
	choices: 4,
	editPrompt: '',
};

export const DEFAULT_SETTINGS: SidekickSettings = {
	copilotType: 'local',
	copilotLocation: DEFAULT_COPILOT_LOCATION,
	cliUrl: '',
	useLoggedInUser: true,
	githubToken: '',
	sidekickFolder: 'sidekick',
	toolApproval: 'ask',
	inlineModel: '',
	autocompleteEnabled: false,
	providerPreset: 'github',
	providerBaseUrl: '',
	providerApiKey: '',
	providerBearerToken: '',
	providerWireApi: 'completions',
	providerModel: '',
	reasoningEffort: '',
	searchAgent: '',
	searchMode: 'basic',
	telegramBotId: '',
	telegramBotToken: '',
	telegramAllowedUsers: '',
	telegramDefaultAgent: '',
}

/** Fields stored in vault-specific local storage instead of data.json. */
export const SECURE_FIELDS: ReadonlyArray<keyof SidekickSettings> = ['githubToken', 'providerApiKey', 'providerBearerToken', 'telegramBotToken'];

const SECURE_PREFIX = 'sidekick-secure-';

/** Load a secure field from vault-specific local storage. */
export function loadSecureField(app: App, key: string): string {
	const stored = app.loadLocalStorage(SECURE_PREFIX + key);
	return stored != null ? String(stored) : '';
}

/** Save a secure field to vault-specific local storage. */
export function saveSecureField(app: App, key: string, value: string): void {
	app.saveLocalStorage(SECURE_PREFIX + key, value || null);
}

/** Derive the agents subfolder from the base Sidekick folder. */
export function getAgentsFolder(settings: SidekickSettings): string {
	return normalizePath(`${settings.sidekickFolder}/agents`);
}

/** Derive the skills subfolder from the base Sidekick folder. */
export function getSkillsFolder(settings: SidekickSettings): string {
	return normalizePath(`${settings.sidekickFolder}/skills`);
}

/** Derive the tools subfolder from the base Sidekick folder. */
export function getToolsFolder(settings: SidekickSettings): string {
	return normalizePath(`${settings.sidekickFolder}/tools`);
}

/** Derive the prompts subfolder from the base Sidekick folder. */
export function getPromptsFolder(settings: SidekickSettings): string {
	return normalizePath(`${settings.sidekickFolder}/prompts`);
}

/** Derive the triggers subfolder from the base Sidekick folder. */
export function getTriggersFolder(settings: SidekickSettings): string {
	return normalizePath(`${settings.sidekickFolder}/triggers`);
}

const SAMPLE_SKILL_CONTENT = `---
name: ascii-art
description: Generates stylized ASCII art text using block characters
---

# ASCII Art Generator

This skill generates ASCII art representations of text using block-style Unicode characters.

## Usage

When a user requests ASCII art for any word or phrase, generate the block-style representation immediately without asking for clarification on style preferences.
`;

const SAMPLE_AGENT_CONTENT = `---
name: Grammar
description: The Grammar Assistant agent helps users improve their writing
tools:
  - github
skills:
  - ascii-art
model: Claude Sonnet 4.5
---

# Grammar Assistant agent Instructions

You are the **Grammar Assistant agent** - the primary task is to helps users improve their writing
`;

const SAMPLE_PROMPT_CONTENT = `---
agent: Grammar
---
Translate the provided text from English to Portuguese.
`;

const SAMPLE_TRIGGER_CONTENT = `---
name: Daily planner
description: Prepares a plan for the day every morning at 8am
agent: Planner
cron: "0 8 * * *"
glob: "**/*.md"
enabled: true
---
Help me prepare my day, including asks on me, recommendations for clear actions to prepare, and suggestions on which items to prioritize over others.
`;

export class SidekickSettingTab extends PluginSettingTab {
	plugin: SidekickPlugin;

	constructor(app: App, plugin: SidekickPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;

		containerEl.empty();
		containerEl.addClass('sidekick-settings');

		// ── Tab bar ──────────────────────────────────────────────
		const tabBar = containerEl.createDiv({cls: 'sidekick-settings-tab-bar'});
		const panels: Record<string, HTMLElement> = {};
		const tabButtons: Record<string, HTMLElement> = {};
		const tabIds = ['copilot', 'models', 'capabilities', 'tools', 'bots'] as const;
		const tabLabels: Record<string, string> = {
			copilot: 'Copilot',
			models: 'Models',
			capabilities: 'Capabilities',
			tools: 'Tools',
			bots: 'Bots',
		};

		const switchSettingsTab = (id: string) => {
			for (const tid of tabIds) {
				panels[tid]?.toggleClass('is-hidden', tid !== id);
				tabButtons[tid]?.toggleClass('is-active', tid === id);
			}
		};

		for (const id of tabIds) {
			const btn = tabBar.createEl('button', {
				cls: 'sidekick-settings-tab',
				text: tabLabels[id],
			});
			btn.addEventListener('click', () => switchSettingsTab(id));
			tabButtons[id] = btn;
		}

		// ── Panels ───────────────────────────────────────────────
		const toolsFolder = normalizePath(`${this.plugin.settings.sidekickFolder}/tools`);
		if (!this.app.vault.getAbstractFileByPath(toolsFolder)) {
			const warning = containerEl.createDiv({cls: 'sidekick-settings-warning'});
			warning.createEl('p', {
				text: 'Sidekick folder is not initialized. Go to the capabilities tab to configure and initialize it.',
			});
		}

		for (const id of tabIds) {
			panels[id] = containerEl.createDiv({cls: `sidekick-settings-panel${id === 'copilot' ? '' : ' is-hidden'}`});
		}
		tabButtons['copilot']?.addClass('is-active');

		// Hoisted so the Test button and Models section can both reference it
		let refreshModels: () => Promise<void> = async () => {};
		let inlineModelSelect: HTMLSelectElement | null = null;

		const populateInlineDropdown = (models: ModelInfo[]) => {
			if (inlineModelSelect) {
				const prev = this.plugin.settings.inlineModel;
				inlineModelSelect.empty();
				const defOpt = inlineModelSelect.createEl('option', {text: 'Default (SDK default)'});
				defOpt.value = '';
				for (const model of models) {
					const opt = inlineModelSelect.createEl('option', {text: model.name});
					opt.value = model.id;
				}
				const ids = models.map(m => m.id);
				inlineModelSelect.value = (prev && ids.includes(prev)) ? prev : '';
				if (inlineModelSelect.value !== prev) {
					this.plugin.settings.inlineModel = inlineModelSelect.value;
					void this.plugin.saveSettings();
				}
			}
		};

		refreshModels = async () => {
			try {
				const preset = this.plugin.settings.providerPreset;
				const isByok = preset !== 'github';
				if (isByok && this.plugin.settings.providerModel) {
					const id = this.plugin.settings.providerModel;
					this.plugin.settings.inlineModel = id;
					await this.plugin.saveSettings();
					populateInlineDropdown([{id, name: id} as ModelInfo]);
				} else if (isByok) {
					populateInlineDropdown([]);
				} else if (this.plugin.copilot) {
					const models: ModelInfo[] = await this.plugin.copilot.listModels();
					populateInlineDropdown(models);
				}
			} catch {
				// silently ignore — dropdown keeps its placeholder
			}
		};

		// ══════════════════════════════════════════════════════════
		// TAB 1: Copilot client
		// ══════════════════════════════════════════════════════════
		const copilotPanel = panels['copilot']!;
		const clientFieldsEl = copilotPanel.createDiv();

		const renderClientFields = () => {
			clientFieldsEl.empty();
			const isRemote = this.plugin.settings.copilotType === 'remote';

			if (isRemote) {
				new Setting(clientFieldsEl)
					.setName('URL')
					.setDesc('URL of existing CLI server to connect to.')
					.addText(text => text
						.setPlaceholder('Ex: localhost:8080')
						.setValue(this.plugin.settings.cliUrl)
						.onChange(async (value) => {
							this.plugin.settings.cliUrl = value.trim();
							await this.plugin.saveSettings();
							await this.plugin.initCopilot();
						}));

				new Setting(clientFieldsEl)
					.setName('GitHub token')
					.setDesc('GitHub token for authentication (stored securely).')
					.addText(text => {
						text.inputEl.type = 'password';
						text.inputEl.autocomplete = 'off';
						text.setPlaceholder('')
							.setValue(this.plugin.settings.githubToken)
							.onChange(async (value) => {
								updateSecureField(this.app, this.plugin, 'githubToken', value.trim());
								await this.plugin.initCopilot();
							});
					});
			} else {
				new Setting(clientFieldsEl)
					.setName('Path')
					.setDesc('Path to copilot executable.')
					.addText(text => text
						.setPlaceholder('Leave blank for default')
						.setValue(this.plugin.settings.copilotLocation)
						.onChange(async (value) => {
							const sanitized = value.trim();
							if (/[;|&`$(){}]/.test(sanitized)) {
								new Notice('Copilot location contains invalid characters.');
								return;
							}
							this.plugin.settings.copilotLocation = sanitized;
							await this.plugin.saveSettings();
							await this.plugin.initCopilot();
						}));

				new Setting(clientFieldsEl)
					.setName('Use logged\u2011in user')
					.setDesc('Whether to use logged-in user for authentication.')
					.addToggle(toggle => toggle
						.setValue(this.plugin.settings.useLoggedInUser)
						.onChange(async (value) => {
							this.plugin.settings.useLoggedInUser = value;
							await this.plugin.saveSettings();
							await this.plugin.initCopilot();
							renderClientFields();
						}));

				if (!this.plugin.settings.useLoggedInUser) {
					new Setting(clientFieldsEl)
						.setName('GitHub token')
						.setDesc('GitHub token for authentication (stored securely).')
						.addText(text => {
							text.inputEl.type = 'password';
							text.inputEl.autocomplete = 'off';
							text.setPlaceholder('')
								.setValue(this.plugin.settings.githubToken)
								.onChange(async (value) => {
									updateSecureField(this.app, this.plugin, 'githubToken', value.trim());
									await this.plugin.initCopilot();
								});
						});
				}
			}
		};

		new Setting(copilotPanel)
			.setName('Client type')
			.setDesc('Use a local or remote copilot client.')
			.addDropdown(dropdown => dropdown
				.addOptions({local: 'Local CLI', remote: 'Remote CLI'})
				.setValue(this.plugin.settings.copilotType)
				.onChange(async (value) => {
					this.plugin.settings.copilotType = value as 'local' | 'remote';
					await this.plugin.saveSettings();
					await this.plugin.initCopilot();
					renderClientFields();
				}))
			.addButton(button => button
				.setButtonText('Test')
				.onClick(async () => {
					button.setDisabled(true);
					button.setButtonText('Testing…');
					try {
						if (!this.plugin.copilot) {
							throw new Error('Copilot service is not available');
						}
						const result = await this.plugin.copilot.ping();
						new Notice(`Copilot connected: ${result.message}`);
						await refreshModels();
					} catch (e) {
						new Notice(`Test failed: ${String(e)}`);
					} finally {
						button.setDisabled(false);
						button.setButtonText('Test');
					}
				}));

		copilotPanel.appendChild(clientFieldsEl);
		renderClientFields();

		// ══════════════════════════════════════════════════════════
		// TAB 2: Models
		// ══════════════════════════════════════════════════════════
		const modelsPanel = panels['models']!;
		const providerFieldsEl = modelsPanel.createDiv();

		const providerDefaults: Record<string, {baseUrl?: string; wireApi?: 'completions' | 'responses'}> = {
			openai:          {baseUrl: 'https://api.openai.com/v1'},
			azure:           {baseUrl: 'https://your-resource.openai.azure.com/openai/v1/', wireApi: 'responses'},
			anthropic:       {baseUrl: 'https://api.anthropic.com'},
			ollama:          {baseUrl: 'http://localhost:11434/v1'},
			'foundry-local': {baseUrl: 'http://localhost:<PORT>/v1'},
		};

		const rebuildProviderFields = () => {
			providerFieldsEl.empty();
			const preset = this.plugin.settings.providerPreset;
			const isByok = preset !== 'github';

			if (isByok) {
				const defaults = providerDefaults[preset];
				const placeholderUrl = defaults?.baseUrl ?? 'https://api.example.com/v1';

				new Setting(providerFieldsEl)
					.setName('Base URL')
					.setDesc('Provider API endpoint (required).')
					.addText(text => text
						.setPlaceholder(placeholderUrl)
						.setValue(this.plugin.settings.providerBaseUrl)
						.onChange(async (value) => {
							this.plugin.settings.providerBaseUrl = value.trim();
							await this.plugin.saveSettings();
						}));

				new Setting(providerFieldsEl)
					.setName('Model name')
					.setDesc('Ex: gpt-4o, claude-sonnet-4, etc.')
					.addText(text => text
						.setPlaceholder('')
						.setValue(this.plugin.settings.providerModel)
						.onChange(async (value) => {
							this.plugin.settings.providerModel = value.trim();
							await this.plugin.saveSettings();
							await refreshModels();
						}));

				new Setting(providerFieldsEl)
					.setName('API key')
					.setDesc('Sent as optional header (stored securely).')
					.addText(text => {
						text.inputEl.type = 'password';
						text.setPlaceholder('')
							.setValue(this.plugin.settings.providerApiKey)
							.onChange((value) => {
								updateSecureField(this.app, this.plugin, 'providerApiKey', value.trim());
							});
					});

				new Setting(providerFieldsEl)
					.setName('Bearer token')
					.setDesc('Authorization optional token header (stored securely).')
					.addText(text => {
						text.inputEl.type = 'password';
						text.setPlaceholder('')
							.setValue(this.plugin.settings.providerBearerToken)
							.onChange((value) => {
								updateSecureField(this.app, this.plugin, 'providerBearerToken', value.trim());
							});
					});

				new Setting(providerFieldsEl)
					.setName('Wire API')
					.setDesc('API format to use.')
					.addDropdown(dropdown => dropdown
						.addOptions({completions: 'Completions', responses: 'Responses'})
						.setValue(this.plugin.settings.providerWireApi)
						.onChange(async (value) => {
							this.plugin.settings.providerWireApi = value as 'completions' | 'responses';
							await this.plugin.saveSettings();
						}));
			}
		};

		const providerOptions: Record<string, string> = {
			github: 'GitHub (built-in)',
			openai: 'OpenAI',
			azure: 'Microsoft Foundry',
			anthropic: 'Anthropic',
			ollama: 'Ollama',
			'foundry-local': 'Microsoft Foundry Local',
			'other-openai': 'Other OpenAI-compatible',
		};

		new Setting(modelsPanel)
			.setName('Provider')
			.setDesc('Use the built-in models or configure your own (local or remote).')
			.addDropdown(dropdown => dropdown
				.addOptions(providerOptions)
				.setValue(this.plugin.settings.providerPreset)
				.onChange(async (value) => {
					const newPreset = value as SidekickSettings['providerPreset'];
					this.plugin.settings.providerPreset = newPreset;
					const defaults = providerDefaults[newPreset];
					if (defaults?.baseUrl) {
						this.plugin.settings.providerBaseUrl = defaults.baseUrl;
					} else if (newPreset === 'github') {
						this.plugin.settings.providerBaseUrl = '';
					}
					this.plugin.settings.providerWireApi = defaults?.wireApi ?? 'completions';
					await this.plugin.saveSettings();
					rebuildProviderFields();
					await refreshModels();
				}))
			.addButton(button => button
				.setButtonText('Test')
				.onClick(async () => {
					button.setDisabled(true);
					button.setButtonText('Testing…');
					try {
						if (!this.plugin.copilot) {
							throw new Error('Copilot service is not available');
						}
						const testSession = await this.plugin.copilot.createSession({
							onPermissionRequest: () => ({allow: false, kind: 'denied-interactively-by-user' as const}),
							...(this.plugin.settings.providerModel ? {model: this.plugin.settings.providerModel} : {}),
							...(this.plugin.settings.providerPreset !== 'github' && this.plugin.settings.providerBaseUrl
								? {provider: (() => {
									const typeMap: Record<string, 'openai' | 'azure' | 'anthropic'> = {
										openai: 'openai', azure: 'azure', anthropic: 'anthropic',
										ollama: 'openai', 'foundry-local': 'openai', 'other-openai': 'openai',
									};
									const cfg: ProviderConfig = {
										type: typeMap[this.plugin.settings.providerPreset] ?? 'openai',
										baseUrl: this.plugin.settings.providerBaseUrl,
										wireApi: this.plugin.settings.providerWireApi,
										...(this.plugin.settings.providerApiKey ? {apiKey: this.plugin.settings.providerApiKey} : {}),
										...(this.plugin.settings.providerBearerToken ? {bearerToken: this.plugin.settings.providerBearerToken} : {}),
									};
									return cfg;
								})()}
								: {}),
						});
						await testSession.disconnect();
						new Notice('Provider session created successfully.');
						await refreshModels();
					} catch (e) {
						new Notice(`Test failed: ${String(e)}`);
					} finally {
						button.setDisabled(false);
						button.setButtonText('Test');
					}
				}));

		modelsPanel.appendChild(providerFieldsEl);
		rebuildProviderFields();

		new Setting(modelsPanel)
			.setName('Inline operations model')
			.setDesc('Model used for editor context-menu actions (fix grammar, summarize, etc.).')
			.addDropdown(dropdown => {
				inlineModelSelect = dropdown.selectEl;
				dropdown.addOption('', 'Default (SDK default)');
				if (this.plugin.settings.inlineModel) {
					dropdown.addOption(this.plugin.settings.inlineModel, this.plugin.settings.inlineModel);
					dropdown.setValue(this.plugin.settings.inlineModel);
				}
				dropdown.onChange(async (value) => {
					this.plugin.settings.inlineModel = value;
					await this.plugin.saveSettings();
				});
			});

		// ══════════════════════════════════════════════════════════
		// TAB 3: Capabilities
		// ══════════════════════════════════════════════════════════
		const capPanel = panels['capabilities']!;

		new Setting(capPanel)
			.setName('Sidekick folder')
			.setDesc('Vault folder for agents, skills, tools and triggers.')
			.addText(text => text
				.setPlaceholder('Ex: sidekick')
				.setValue(this.plugin.settings.sidekickFolder)
				.onChange(async (value) => {
					const sanitized = value.trim().replace(/\.\./g, '');
					if (!sanitized || /[;|&`$(){}]/.test(sanitized)) {
						new Notice('Sidekick folder name is invalid.');
						return;
					}
					this.plugin.settings.sidekickFolder = sanitized;
					await this.plugin.saveSettings();
				}))
			.addButton(button => button
				.setButtonText('Initialize')
				.onClick(async () => {
					try {
						const base = normalizePath(this.plugin.settings.sidekickFolder);

						for (const sub of ['', '/agents', '/skills', '/skills/ascii-art', '/tools', '/prompts', '/triggers']) {
							const dir = normalizePath(`${base}${sub}`);
							if (!this.app.vault.getAbstractFileByPath(dir)) {
								await this.app.vault.createFolder(dir);
							}
						}

						const agentPath = normalizePath(`${base}/agents/grammar.agent.md`);
						if (!this.app.vault.getAbstractFileByPath(agentPath)) {
							await this.app.vault.create(agentPath, SAMPLE_AGENT_CONTENT);
						}

						const skillPath = normalizePath(`${base}/skills/ascii-art/SKILL.md`);
						if (!this.app.vault.getAbstractFileByPath(skillPath)) {
							await this.app.vault.create(skillPath, SAMPLE_SKILL_CONTENT);
						}

						const mcpPath = normalizePath(`${base}/tools/mcp.json`);
						if (!this.app.vault.getAbstractFileByPath(mcpPath)) {
							const mcpContent = JSON.stringify({
								servers: {
									github: {
										type: 'http',
										url: 'https://api.githubcopilot.com/mcp/'
									}
								}
							}, null, '\t');
							await this.app.vault.create(mcpPath, mcpContent);
						}

						const promptPath = normalizePath(`${base}/prompts/en-to-pt.prompt.md`);
						if (!this.app.vault.getAbstractFileByPath(promptPath)) {
							await this.app.vault.create(promptPath, SAMPLE_PROMPT_CONTENT);
						}

						const triggerPath = normalizePath(`${base}/triggers/daily-planner.trigger.md`);
						if (!this.app.vault.getAbstractFileByPath(triggerPath)) {
							await this.app.vault.create(triggerPath, SAMPLE_TRIGGER_CONTENT);
						}

						new Notice('Sidekick folder initialized with sample agent, skill, prompt, trigger, and mcp.json.');
					} catch (e) {
						new Notice(`Failed to initialize sidekick folder: ${String(e)}`);
					}
				}));

		new Setting(capPanel)
			.setName('Enable ghost-text autocomplete')
			.setDesc('Show inline suggestions as you type (uses the inline operations model).')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.autocompleteEnabled)
				.onChange(async (value) => {
					this.plugin.settings.autocompleteEnabled = value;
					await this.plugin.saveSettings();
				}));

		// ══════════════════════════════════════════════════════════
		// TAB 4: Tools
		// ══════════════════════════════════════════════════════════
		const toolsPanel = panels['tools']!;

		new Setting(toolsPanel)
			.setName('Tools approval')
			.setDesc('Whether tool invocations require manual approval or are allowed automatically.')
			.addDropdown(dropdown => dropdown
				.addOptions({allow: 'Allow (auto-approve)', ask: 'Ask (require approval)'})
				.setValue(this.plugin.settings.toolApproval)
				.onChange(async (value) => {
					this.plugin.settings.toolApproval = value as 'ask' | 'allow';
					await this.plugin.saveSettings();
				}));

		// ── MCP input variables (always visible) ─────────────────
		new Setting(toolsPanel)
			.setName('Input variables')
			.setHeading();

		const mcpInputsEl = toolsPanel.createDiv();
		const renderMcpInputs = async () => {
			mcpInputsEl.empty();
			new Setting(mcpInputsEl)
				.setDesc('Manage values for input variables defined in mcp.json. Password inputs are stored securely.');

			let inputs: McpInputVariable[] = [];
			try {
				inputs = await loadMcpInputs(this.app, getToolsFolder(this.plugin.settings));
			} catch {
				// mcp.json may not exist yet
			}

			if (inputs.length === 0) {
				mcpInputsEl.createEl('p', {
					text: 'No input variables defined in mcp.json.',
					cls: 'setting-item-description',
				});
			} else {
				for (const input of inputs) {
					const isPassword = input.password === true;
					const currentValue = getMcpInputValue(this.app, this.plugin, input.id, isPassword);
					new Setting(mcpInputsEl)
						.setName(input.id)
						.setDesc(input.description + (isPassword ? ' (password — stored securely)' : ''))
						.addText(text => {
							if (isPassword) {
								text.inputEl.type = 'password';
								text.inputEl.autocomplete = 'off';
							}
							text.setPlaceholder('Enter value…')
								.setValue(currentValue ?? '')
								.onChange(async (value) => {
									await setMcpInputValue(this.app, this.plugin, input.id, value, isPassword);
								});
						})
						.addExtraButton(button => button
							.setIcon('trash')
							.setTooltip('Delete stored value')
							.onClick(async () => {
								await deleteMcpInputValue(this.app, this.plugin, input.id, isPassword);
								await renderMcpInputs();
								new Notice(`Deleted value for input "${input.id}".`);
							}));
				}
			}
		};
		void renderMcpInputs();

		// ══════════════════════════════════════════════════════════
		// TAB 5: Bots
		// ══════════════════════════════════════════════════════════
		const botsPanel = panels['bots']!;
		this.renderBotsPanel(botsPanel);

		// Auto-refresh models when opening settings
		void refreshModels();
	}

	/** Render the Bots settings tab (Telegram section). */
	private renderBotsPanel(panel: HTMLElement): void {
		// ── Telegram section ──────────────────────────────────────
		// Heading with connect/disconnect button on the right and status after label
		const headingSetting = new Setting(panel)
			.setName('Telegram')
			.setHeading();

		const statusEl = headingSetting.nameEl.createSpan({cls: 'sidekick-bot-status'});

		const updateStatusDisplay = (status: string, isError = false) => {
			statusEl.empty();
			if (status) {
				statusEl.createSpan({
					text: ` — ${status}`,
					cls: isError ? 'sidekick-bot-status-error' : 'sidekick-bot-status-ok',
				});
			}
		};

		const telegram = this.plugin.telegramBot;
		if (telegram?.isConnected()) {
			updateStatusDisplay(`Connected as @${telegram.botUsername}`);
		}

		const updateConnectButton = () => {
			headingSetting.controlEl.empty();
			const isConnected = this.plugin.telegramBot?.isConnected() ?? false;

			if (isConnected) {
				updateStatusDisplay(`Connected as @${this.plugin.telegramBot!.botUsername}`);
				headingSetting.addButton(button => button
					.setButtonText('Disconnect')
					.setWarning()
					.onClick(() => {
						button.setDisabled(true);
						button.setButtonText('Disconnecting…');
						try {
							this.plugin.disconnectTelegram();
							updateStatusDisplay('');
						} catch (e) {
							updateStatusDisplay(`Disconnect error: ${String(e)}`, true);
						} finally {
							updateConnectButton();
						}
					}));
			} else {
				headingSetting.addButton(button => button
					.setButtonText('Connect')
					.setCta()
					.onClick(async () => {
						const token = this.plugin.settings.telegramBotToken;
						if (!token) {
							new Notice('Please enter a bot token first.');
							return;
						}
						button.setDisabled(true);
						button.setButtonText('Connecting…');
						try {
							await this.plugin.connectTelegram();
							updateStatusDisplay(`Connected as @${this.plugin.telegramBot!.botUsername}`);
						} catch (e) {
							updateStatusDisplay(`Connection failed: ${String(e)}`, true);
						} finally {
							updateConnectButton();
						}
					}));
			}
		};

		updateConnectButton();

		new Setting(panel)
			.setName('Bot identifier')
			.setDesc('The unique identifier for your bot.')
			.addText(text => text
				.setPlaceholder('_bot')
				.setValue(this.plugin.settings.telegramBotId)
				.onChange(async (value) => {
					this.plugin.settings.telegramBotId = value.trim();
					await this.plugin.saveSettings();
				}));

		new Setting(panel)
			.setName('Bot token')
			.setDesc('The bot token (stored securely).')
			.addText(text => {
				text.inputEl.type = 'password';
				text.inputEl.autocomplete = 'off';
				text.setPlaceholder('')
					.setValue(this.plugin.settings.telegramBotToken)
					.onChange((value) => {
						updateSecureField(this.app, this.plugin, 'telegramBotToken', value.trim());
					});
			});

		new Setting(panel)
			.setName('Allowed users')
			.setDesc('Comma-separated user ids that can use the bot (required).')
			.addText(text => text
				.setPlaceholder('123456789, 987654321')
				.setValue(this.plugin.settings.telegramAllowedUsers)
				.onChange(async (value) => {
					this.plugin.settings.telegramAllowedUsers = value;
					await this.plugin.saveSettings();
				}));

		// Default agent dropdown — populated from vault agents
		const agentSetting = new Setting(panel)
			.setName('Default agent')
			.setDesc('The agent used to respond to incoming messages.');

		agentSetting.addDropdown(dropdown => {
			dropdown.addOption('', 'Auto');
			// Load agents asynchronously and populate
			void loadAgents(this.app, getAgentsFolder(this.plugin.settings)).then(agents => {
				for (const agent of agents) {
					dropdown.addOption(agent.name, agent.name);
				}
				if (this.plugin.settings.telegramDefaultAgent) {
					dropdown.setValue(this.plugin.settings.telegramDefaultAgent);
				}
			}).catch(() => { /* ignore */ });
			if (this.plugin.settings.telegramDefaultAgent) {
				dropdown.setValue(this.plugin.settings.telegramDefaultAgent);
			}
			dropdown.onChange(async (value) => {
				this.plugin.settings.telegramDefaultAgent = value;
				await this.plugin.saveSettings();
			});
		});
	}
}

// ── MCP Input value helpers ─────────────────────────────────

const MCP_SECRET_PREFIX = 'sidekick-mcp-input-';

/** Retrieve the stored value for an MCP input variable. */
export function getMcpInputValue(app: App, plugin: SidekickPlugin, id: string, isPassword: boolean): string | undefined {
	if (isPassword) {
		const stored = app.loadLocalStorage(MCP_SECRET_PREFIX + id);
		return stored != null ? String(stored) : undefined;
	}
	return plugin.settings.mcpInputValues?.[id];
}

/** Store a value for an MCP input variable. */
export async function setMcpInputValue(app: App, plugin: SidekickPlugin, id: string, value: string, isPassword: boolean): Promise<void> {
	if (isPassword) {
		app.saveLocalStorage(MCP_SECRET_PREFIX + id, value);
	} else {
		if (!plugin.settings.mcpInputValues) plugin.settings.mcpInputValues = {};
		plugin.settings.mcpInputValues[id] = value;
		await plugin.saveSettings();
	}
}

/** Delete the stored value for an MCP input variable. */
export async function deleteMcpInputValue(app: App, plugin: SidekickPlugin, id: string, isPassword: boolean): Promise<void> {
	if (isPassword) {
		app.saveLocalStorage(MCP_SECRET_PREFIX + id, null);
	} else {
		if (plugin.settings.mcpInputValues) {
			delete plugin.settings.mcpInputValues[id];
			await plugin.saveSettings();
		}
	}
}

/**
 * Modal that prompts the user to provide a value for a missing MCP input variable.
 */
export class McpInputPromptModal extends Modal {
	private readonly input: McpInputVariable;
	private readonly onSubmit: (value: string | undefined) => void;

	constructor(app: App, input: McpInputVariable, onSubmit: (value: string | undefined) => void) {
		super(app);
		this.input = input;
		this.onSubmit = onSubmit;
	}

	onOpen(): void {
		const {contentEl} = this;
		contentEl.createEl('h3', {text: 'Input required'});
		contentEl.createEl('p', {text: this.input.description});
		contentEl.createEl('p', {text: `Variable: ${this.input.id}`, cls: 'setting-item-description'});

		let inputValue = '';
		new Setting(contentEl)
			.setName('Value')
			.addText(text => {
				if (this.input.password) {
					text.inputEl.type = 'password';
					text.inputEl.autocomplete = 'off';
				}
				text.setPlaceholder('Enter value…')
					.onChange(v => { inputValue = v; });
				// Focus input after render
				setTimeout(() => text.inputEl.focus(), 50);
			});

		const btnRow = contentEl.createDiv({cls: 'modal-button-container'});
		const saveBtn = btnRow.createEl('button', {text: 'Save', cls: 'mod-cta'});
		saveBtn.addEventListener('click', () => {
			this.close();
			this.onSubmit(inputValue || undefined);
		});
		const cancelBtn = btnRow.createEl('button', {text: 'Cancel'});
		cancelBtn.addEventListener('click', () => {
			this.close();
			this.onSubmit(undefined);
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

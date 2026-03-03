import {App, Notice, PluginSettingTab, Setting, normalizePath} from "obsidian";
import SidekickPlugin from "./main";
import type {ModelInfo, ProviderConfig} from "./copilot";

const DEFAULT_COPILOT_LOCATION = '';

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
	/** Custom display names for sessions, keyed by SDK sessionId. */
	sessionNames?: Record<string, string>;
	/** Last-fired timestamps for trigger deduplication, keyed by trigger name. */
	triggerLastFired?: Record<string, number>;
}

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
description: Daily planner
agent: Planner
triggers:
  - type: scheduler 
    cron: "0 8 * * *"
  - type: onFileChange
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

		// Hoisted so the Test button and Models section can both reference it
		let refreshModels: () => Promise<void> = async () => {};

		// ── GitHub Copilot Client section ────────────────────────
		// Heading row with Type dropdown + Test button
		const clientFieldsEl = containerEl.createDiv();

		const renderClientFields = () => {
			clientFieldsEl.empty();
			const isRemote = this.plugin.settings.copilotType === 'remote';

			if (isRemote) {
				new Setting(clientFieldsEl)
					.setName('URL')
					.setDesc('URL of existing CLI server to connect to.')
					.addText(text => text
						.setPlaceholder('e.g. localhost:8080')
						.setValue(this.plugin.settings.cliUrl)
						.onChange(async (value) => {
							this.plugin.settings.cliUrl = value.trim();
							await this.plugin.saveSettings();
							await this.plugin.initCopilot();
						}));

				new Setting(clientFieldsEl)
					.setName('GitHub token')
					.setDesc('GitHub token for authentication.')
					.addText(text => {
						text.inputEl.type = 'password';
						text.inputEl.autocomplete = 'off';
						text.setPlaceholder('ghp_…')
							.setValue(this.plugin.settings.githubToken)
							.onChange(async (value) => {
								this.plugin.settings.githubToken = value.trim();
								await this.plugin.saveSettings();
								await this.plugin.initCopilot();
							});
					});
			} else {
				new Setting(clientFieldsEl)
					.setName('Path')
					.setDesc('Path to CLI executable (default: "copilot" from PATH).')
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
						.setDesc('GitHub token for authentication.')
						.addText(text => {
							text.inputEl.type = 'password';
							text.inputEl.autocomplete = 'off';
							text.setPlaceholder('ghp_…')
								.setValue(this.plugin.settings.githubToken)
								.onChange(async (value) => {
									this.plugin.settings.githubToken = value.trim();
									await this.plugin.saveSettings();
									await this.plugin.initCopilot();
								});
						});
				}
			}
		};

		new Setting(containerEl)
			.setName('GitHub Copilot client')
			.setHeading()
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

		containerEl.appendChild(clientFieldsEl);
		renderClientFields();

		// --- Models section ---

		const providerFieldsEl = containerEl.createDiv();

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
					.setDesc('Model ID to use (e.g. gpt-4o, claude-sonnet-4).')
					.addText(text => text
						.setPlaceholder('model-id')
						.setValue(this.plugin.settings.providerModel)
						.onChange(async (value) => {
							this.plugin.settings.providerModel = value.trim();
							await this.plugin.saveSettings();
							await refreshModels();
						}));

				new Setting(providerFieldsEl)
					.setName('API key')
					.setDesc('Sent as x-api-key header (optional).')
					.addText(text => {
						text.inputEl.type = 'password';
						text.setPlaceholder('sk-…')
							.setValue(this.plugin.settings.providerApiKey)
							.onChange(async (value) => {
								this.plugin.settings.providerApiKey = value.trim();
								await this.plugin.saveSettings();
							});
					});

				new Setting(providerFieldsEl)
					.setName('Bearer token')
					.setDesc('Authorization header token (optional).')
					.addText(text => {
						text.inputEl.type = 'password';
						text.setPlaceholder('token')
							.setValue(this.plugin.settings.providerBearerToken)
							.onChange(async (value) => {
								this.plugin.settings.providerBearerToken = value.trim();
								await this.plugin.saveSettings();
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

		new Setting(containerEl)
			.setName('Models')
			.setHeading()
			.addDropdown(dropdown => dropdown
				.addOptions(providerOptions)
				.setValue(this.plugin.settings.providerPreset)
				.onChange(async (value) => {
					const newPreset = value as SidekickSettings['providerPreset'];
					this.plugin.settings.providerPreset = newPreset;
					// Apply provider-specific defaults
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
						// Attempt to create (and immediately destroy) a session to validate provider config
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
						await testSession.destroy();
						new Notice('Provider session created successfully.');
						await refreshModels();
					} catch (e) {
						new Notice(`Test failed: ${String(e)}`);
					} finally {
						button.setDisabled(false);
						button.setButtonText('Test');
					}
				}));

		containerEl.appendChild(providerFieldsEl);
		rebuildProviderFields();

		let inlineModelSelect: HTMLSelectElement | null = null;

		const populateInlineDropdown = (models: ModelInfo[]) => {
			if (inlineModelSelect) {
				// Preserve current selection
				const prev = this.plugin.settings.inlineModel;
				inlineModelSelect.empty();
				const defOpt = inlineModelSelect.createEl('option', {text: 'Default (SDK default)'});
				defOpt.value = '';
				for (const model of models) {
					const opt = inlineModelSelect.createEl('option', {text: model.name});
					opt.value = model.id;
				}
				// Restore previous selection if still available, otherwise reset
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
					// BYOK providers with a model name: use it and auto-select
					const id = this.plugin.settings.providerModel;
					this.plugin.settings.inlineModel = id;
					await this.plugin.saveSettings();
					populateInlineDropdown([{id, name: id} as ModelInfo]);
				} else if (isByok) {
					// BYOK providers without a model name: clear the list
					populateInlineDropdown([]);
				} else if (this.plugin.copilot) {
					const models: ModelInfo[] = await this.plugin.copilot.listModels();
					populateInlineDropdown(models);
				}
			} catch {
				// silently ignore — dropdown keeps its placeholder
			}
		};

		// --- Sidekick settings section ---
		new Setting(containerEl).setName('Sidekick').setHeading();

		new Setting(containerEl)
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

		new Setting(containerEl)
			.setName('Sidekick folder')
			.setDesc('Vault folder for agents, skills, tools and triggers.')
			.addText(text => text
				.setPlaceholder('e.g. sidekick')
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

						// Create base folder and subfolders
						for (const sub of ['', '/agents', '/skills', '/skills/ascii-art', '/tools', '/prompts', '/triggers']) {
							const dir = normalizePath(`${base}${sub}`);
							if (!this.app.vault.getAbstractFileByPath(dir)) {
								await this.app.vault.createFolder(dir);
							}
						}

						// Sample agent
						const agentPath = normalizePath(`${base}/agents/grammar.agent.md`);
						if (!this.app.vault.getAbstractFileByPath(agentPath)) {
							await this.app.vault.create(agentPath, SAMPLE_AGENT_CONTENT);
						}

						// Sample skill
						const skillPath = normalizePath(`${base}/skills/ascii-art/SKILL.md`);
						if (!this.app.vault.getAbstractFileByPath(skillPath)) {
							await this.app.vault.create(skillPath, SAMPLE_SKILL_CONTENT);
						}

						// Sample mcp.json
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

						// Sample prompt
						const promptPath = normalizePath(`${base}/prompts/en-to-pt.prompt.md`);
						if (!this.app.vault.getAbstractFileByPath(promptPath)) {
							await this.app.vault.create(promptPath, SAMPLE_PROMPT_CONTENT);
						}

						// Sample trigger
						const triggerPath = normalizePath(`${base}/triggers/daily-planner.trigger.md`);
						if (!this.app.vault.getAbstractFileByPath(triggerPath)) {
							await this.app.vault.create(triggerPath, SAMPLE_TRIGGER_CONTENT);
						}

						new Notice('Sidekick folder initialized with sample agent, skill, prompt, trigger, and mcp.json.');
					} catch (e) {
						new Notice(`Failed to initialize Sidekick folder: ${String(e)}`);
					}
				}));

		new Setting(containerEl)
			.setName('Tools approval')
			.setDesc('Whether tool invocations require manual approval or are allowed automatically.')
			.addDropdown(dropdown => dropdown
				.addOptions({allow: 'Allow (auto-approve)', ask: 'Ask (require approval)'})
				.setValue(this.plugin.settings.toolApproval)
				.onChange(async (value) => {
					this.plugin.settings.toolApproval = value as 'ask' | 'allow';
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Enable ghost-text autocomplete')
			.setDesc('Show inline suggestions as you type (uses the inline operations model).')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.autocompleteEnabled)
				.onChange(async (value) => {
					this.plugin.settings.autocompleteEnabled = value;
					await this.plugin.saveSettings();
				}));

		// Auto-refresh models when opening settings
		void refreshModels();
	}
}

import {App, Notice, PluginSettingTab, Setting, normalizePath} from "obsidian";
import SidekickPlugin from "./main";
import type {ModelInfo} from "./copilot";

const DEFAULT_COPILOT_LOCATION = '';

export interface SidekickSettings {
	copilotLocation: string;
	agentsFolder: string;
	skillsFolder: string;
	toolsFolder: string;
}

export const DEFAULT_SETTINGS: SidekickSettings = {
	copilotLocation: DEFAULT_COPILOT_LOCATION,
	agentsFolder: 'sidekick/agents',
	skillsFolder: 'sidekick/skills',
	toolsFolder: 'sidekick/tools'
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
model: Claude Sonnet 4.5 (copilot)
---

# Grammar Assistant agent Instructions

You are the **Grammar Assistant agent** - the primary task is to helps users improve their writing
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

		new Setting(containerEl)
			.setName('Copilot location')
			.setDesc('Path to the copilot CLI')
			.addText(text => text
				.setPlaceholder('e.g. /usr/local/bin/copilot')
				.setValue(this.plugin.settings.copilotLocation)
				.onChange(async (value) => {
					this.plugin.settings.copilotLocation = value.trim();
					await this.plugin.saveSettings();
					await this.plugin.initCopilot();
				}))
			.addButton(button => button
				.setButtonText('Ping')
				.onClick(async () => {
					button.setDisabled(true);
					button.setButtonText('Pinging…');
					try {
						if (!this.plugin.copilot) {
							throw new Error('Copilot service is not available');
						}
						const result = await this.plugin.copilot.ping();
						new Notice(`Copilot connected: ${result.message}`);
					} catch (e) {
						new Notice(`Ping failed: ${String(e)}`);
					} finally {
						button.setDisabled(false);
						button.setButtonText('Ping');
					}
				}));

		new Setting(containerEl)
			.setName('Agents folder')
			.setDesc('Vault folder where custom agents are stored.')
			.addText(text => text
				.setPlaceholder('e.g. sidekick/agents')
				.setValue(this.plugin.settings.agentsFolder)
				.onChange(async (value) => {
					this.plugin.settings.agentsFolder = value;
					await this.plugin.saveSettings();
				}))
			.addButton(button => button
				.setButtonText('Initialize')
				.onClick(async () => {
					try {
						const folder = normalizePath(this.plugin.settings.agentsFolder);
						const adapter = this.app.vault.adapter;

						if (!(await adapter.exists(folder))) {
							await this.app.vault.createFolder(folder);
						}

						const filePath = normalizePath(`${folder}/grammar.agent.md`);
						if (await adapter.exists(filePath)) {
							new Notice('Sample agent already exists.');
							return;
						}

						await this.app.vault.create(filePath, SAMPLE_AGENT_CONTENT);
						new Notice('Agents folder initialized with sample agent.');
					} catch (e) {
						new Notice(`Failed to initialize agents folder: ${String(e)}`);
					}
				}));

		new Setting(containerEl)
			.setName('Skills folder')
			.setDesc('Vault folder where skills are stored.')
			.addText(text => text
				.setPlaceholder('e.g. sidekick/skills')
				.setValue(this.plugin.settings.skillsFolder)
				.onChange(async (value) => {
					this.plugin.settings.skillsFolder = value;
					await this.plugin.saveSettings();
				}))
			.addButton(button => button
				.setButtonText('Initialize')
				.onClick(async () => {
					try {
						const folder = normalizePath(this.plugin.settings.skillsFolder);
						const adapter = this.app.vault.adapter;

						if (!(await adapter.exists(folder))) {
							await this.app.vault.createFolder(folder);
						}

						const skillFolder = normalizePath(`${folder}/ascii-art`);
						if (!(await adapter.exists(skillFolder))) {
							await this.app.vault.createFolder(skillFolder);
						}

						const filePath = normalizePath(`${skillFolder}/SKILL.md`);
						if (await adapter.exists(filePath)) {
							new Notice('Sample skill already exists.');
							return;
						}

						await this.app.vault.create(filePath, SAMPLE_SKILL_CONTENT);
						new Notice('Skills folder initialized with ascii-art skill.');
					} catch (e) {
						new Notice(`Failed to initialize skills folder: ${String(e)}`);
					}
				}));

		new Setting(containerEl)
			.setName('Tools folder')
			.setDesc('Vault folder where tool configurations are stored.')
			.addText(text => text
				.setPlaceholder('e.g. sidekick/tools')
				.setValue(this.plugin.settings.toolsFolder)
				.onChange(async (value) => {
					this.plugin.settings.toolsFolder = value;
					await this.plugin.saveSettings();
				}))
			.addButton(button => button
				.setButtonText('Initialize')
				.onClick(async () => {
					try {
						const folder = normalizePath(this.plugin.settings.toolsFolder);
						const adapter = this.app.vault.adapter;

						if (!(await adapter.exists(folder))) {
							await this.app.vault.createFolder(folder);
						}

						const filePath = normalizePath(`${folder}/mcp.json`);
						if (await adapter.exists(filePath)) {
							new Notice('The mcp.json file already exists.');
							return;
						}

						const mcpContent = JSON.stringify({
							servers: {
								github: {
									type: 'http',
									url: 'https://api.githubcopilot.com/mcp/'
								}
							}
						}, null, '\t');

						await this.app.vault.create(filePath, mcpContent);
						new Notice('Tools folder initialized with mcp.json.');
					} catch (e) {
						new Notice(`Failed to initialize tools folder: ${String(e)}`);
					}
				}));

		// --- Models section ---
		new Setting(containerEl).setName('Models').setHeading();

		const modelsContainer = containerEl.createDiv({cls: 'sidekick-models-list'});

		new Setting(containerEl)
			.setName('Available models')
			.setDesc('Fetch available models from the copilot backend')
			.addButton(button => button
				.setButtonText('List')
				.onClick(async () => {
					button.setDisabled(true);
					button.setButtonText('Loading…');
					modelsContainer.empty();
					try {
						if (!this.plugin.copilot) {
							throw new Error('Copilot service is not available');
						}
						const models: ModelInfo[] = await this.plugin.copilot.listModels();
						this.renderModels(modelsContainer, models);
						new Notice(`Loaded ${models.length} model(s).`);
					} catch (e) {
						modelsContainer.createEl('p', {
							text: `Error: ${String(e)}`,
							cls: 'sidekick-models-error'
						});
						new Notice(`Failed to load models: ${String(e)}`);
					} finally {
						button.setDisabled(false);
						button.setButtonText('List');
					}
				}));
	}

	private renderModels(container: HTMLElement, models: ModelInfo[]): void {
		if (models.length === 0) {
			container.createEl('p', {text: 'No models available.'});
			return;
		}

		const list = container.createEl('ul', {cls: 'sidekick-models-ul'});
		for (const model of models) {
			const item = list.createEl('li');
			item.createEl('strong', {text: model.name});
			item.createSpan({text: ` (${model.id})`});
		}
	}
}

import {Plugin} from 'obsidian';
import {DEFAULT_SETTINGS, SidekickSettings, SidekickSettingTab} from "./settings";
import {CopilotService} from "./copilot";

export default class SidekickPlugin extends Plugin {
	settings: SidekickSettings;
	copilot: CopilotService | null = null;

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new SidekickSettingTab(this.app, this));

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
			} catch (e) {
				console.warn('Sidekick: error stopping previous Copilot service', e);
			}
			this.copilot = null;
		}
		const loc = this.settings.copilotLocation.trim();
		this.copilot = new CopilotService(loc.length > 0 ? loc : undefined);
	}

	onunload() {
		if (this.copilot) {
			void this.copilot.stop();
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<SidekickSettings>);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

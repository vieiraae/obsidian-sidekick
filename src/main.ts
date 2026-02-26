import {Plugin} from 'obsidian';
import {DEFAULT_SETTINGS, SidekickSettings, SidekickSettingTab} from "./settings";
import {CopilotService} from "./copilot";
import {SidekickView, SIDEKICK_VIEW_TYPE} from "./sidekickView";
import {registerEditorMenu} from "./editorMenu";

export default class SidekickPlugin extends Plugin {
	settings: SidekickSettings;
	copilot: CopilotService | null = null;

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new SidekickSettingTab(this.app, this));

		// Register the Sidekick chat view
		this.registerView(SIDEKICK_VIEW_TYPE, (leaf) => new SidekickView(leaf, this));

		// Ribbon icon to open view
		this.addRibbonIcon('brain', 'Open Sidekick', () => void this.activateView());

		// Command to open view
		this.addCommand({
			id: 'open-sidekick',
			name: 'Open Sidekick',
			callback: () => void this.activateView(),
		});

		// Editor context menu (Sidekick submenu for selected text)
		registerEditorMenu(this);

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
		this.app.workspace.detachLeavesOfType(SIDEKICK_VIEW_TYPE);
	}

	async activateView(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(SIDEKICK_VIEW_TYPE);
		if (existing.length > 0 && existing[0]) {
			this.app.workspace.revealLeaf(existing[0]);
			return;
		}
		const leaf = this.app.workspace.getRightLeaf(false);
		if (leaf) {
			await leaf.setViewState({type: SIDEKICK_VIEW_TYPE, active: true});
			this.app.workspace.revealLeaf(leaf);
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<SidekickSettings>);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

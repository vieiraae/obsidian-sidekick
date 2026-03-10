import {Plugin} from 'obsidian';
import {DEFAULT_SETTINGS, SidekickSettings, SidekickSettingTab, SECURE_FIELDS, loadSecureField, saveSecureField} from "./settings";
import {CopilotService} from "./copilot";
import {SidekickView, SIDEKICK_VIEW_TYPE} from "./sidekickView";
import {registerEditorMenu, registerFileMenu} from './editorMenu';
import {buildGhostTextExtension} from "./ghostText";

export default class SidekickPlugin extends Plugin {
	settings!: SidekickSettings;
	copilot: CopilotService | null = null;

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
		if (s.copilotType === 'remote') {
			const url = s.cliUrl.trim();
			this.copilot = new CopilotService({
				cliUrl: url || undefined,
				githubToken: s.githubToken || undefined,
			});
		} else {
			const loc = s.copilotLocation.trim();
			this.copilot = new CopilotService({
				cliPath: loc.length > 0 ? loc : undefined,
				useLoggedInUser: s.useLoggedInUser,
				githubToken: !s.useLoggedInUser && s.githubToken ? s.githubToken : undefined,
			});
		}
	}

	onunload() {
		if (this.copilot) {
			void this.copilot.stop();
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

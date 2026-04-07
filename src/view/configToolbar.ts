import {Menu, setIcon} from 'obsidian';
import type {SidekickView} from '../sidekickView';
import type {ModelInfo, ReasoningEffort} from '../copilot';
import type {AgentConfig} from '../types';
import {FolderTreeModal} from '../modals';
import {EditModal} from '../modals/editModal';
import {setDebugEnabled} from '../debug';

declare module '../sidekickView' {
	interface SidekickView {
		buildConfigToolbar(parent: HTMLElement): void;
		populateModelSelect(): void;
		getSelectedModelInfo(): ModelInfo | undefined;
		openReasoningMenu(e: MouseEvent): void;
		updateReasoningBadge(): void;
		openSkillsMenu(e: MouseEvent): void;
		openToolsMenu(e: MouseEvent): void;
		selectAgent(agentName: string): void;
		applyAgentToolsAndSkills(agent?: AgentConfig): void;
		updateSkillsBadge(): void;
		updateToolsBadge(): void;
		openCwdPicker(): void;
		updateCwdButton(): void;
		openEditFromChat(): void;
		resolveModelForAgent(agent: AgentConfig | undefined, fallback: string | undefined): string | undefined;
	}
}

export function installConfigToolbar(ViewClass: { prototype: unknown }): void {
	const proto = ViewClass.prototype as SidekickView;

	proto.buildConfigToolbar = function(parent: HTMLElement): void {
		const toolbar = parent.createDiv({cls: 'sidekick-toolbar'});

		// New conversation button
		const newChatBtn = toolbar.createEl('button', {cls: 'clickable-icon sidekick-icon-btn', attr: {title: 'New conversation'}});
		setIcon(newChatBtn, 'plus');
		newChatBtn.addEventListener('click', () => void this.newConversation());

		// Agent dropdown
		const agentGroup = toolbar.createDiv({cls: 'sidekick-toolbar-group'});
		const agentIcon = agentGroup.createSpan({cls: 'sidekick-toolbar-icon'});
		setIcon(agentIcon, 'bot');
		this.agentSelect = agentGroup.createEl('select', {cls: 'sidekick-select'});
		this.agentSelect.addEventListener('change', () => {
			this.selectAgent(this.agentSelect.value);
		});

		// Model dropdown
		const modelGroup = toolbar.createDiv({cls: 'sidekick-toolbar-group'});
		this.modelIconEl = modelGroup.createSpan({cls: 'sidekick-toolbar-icon clickable-icon'});
		setIcon(this.modelIconEl, 'cpu');
		this.modelIconEl.addEventListener('click', (e) => { e.stopPropagation(); this.openReasoningMenu(e); });
		this.modelSelect = modelGroup.createEl('select', {cls: 'sidekick-select sidekick-model-select'});
		this.modelSelect.addEventListener('change', () => {
			const newModel = this.modelSelect.value;
			this.selectedModel = newModel;
			if (this.currentSession && !this.configDirty) {
				// Mid-session model switch via setModel()
				const effort = this.plugin.settings.reasoningEffort;
				void this.currentSession.setModel(newModel, effort ? {reasoningEffort: effort as ReasoningEffort} : undefined);
			} else {
				this.configDirty = true;
			}
			this.updateReasoningBadge();
		});

		// Skills button
		this.skillsBtnEl = toolbar.createEl('button', {cls: 'clickable-icon sidekick-icon-btn', attr: {title: 'Skills'}});
		setIcon(this.skillsBtnEl, 'wand-2');
		this.skillsBtnEl.addEventListener('click', (e) => this.openSkillsMenu(e));

		// Tools button
		this.toolsBtnEl = toolbar.createEl('button', {cls: 'clickable-icon sidekick-icon-btn', attr: {title: 'Tools'}});
		setIcon(this.toolsBtnEl, 'plug');
		this.toolsBtnEl.addEventListener('click', (e) => this.openToolsMenu(e));

		// Working directory button
		this.cwdBtnEl = toolbar.createEl('button', {cls: 'clickable-icon sidekick-icon-btn', attr: {title: 'Working directory'}});
		setIcon(this.cwdBtnEl, 'hard-drive-download');
		this.cwdBtnEl.addEventListener('click', () => this.openCwdPicker());
		this.updateCwdButton();

		// Spacer to push debug toggle to the right
		toolbar.createDiv({cls: 'sidekick-toolbar-spacer'});

		// Debug toggle
		this.debugBtnEl = toolbar.createDiv({cls: 'sidekick-debug-toggle', attr: {title: 'Show tool & token details'}});
		const debugIcon = this.debugBtnEl.createSpan({cls: 'sidekick-debug-icon'});
		setIcon(debugIcon, 'bug');
		const debugCheck = this.debugBtnEl.createEl('input', {type: 'checkbox', cls: 'sidekick-debug-checkbox'});
		debugCheck.checked = this.showDebugInfo;
		debugCheck.addEventListener('change', () => {
			this.showDebugInfo = debugCheck.checked;
			setDebugEnabled(this.showDebugInfo);
			this.chatContainer.toggleClass('sidekick-hide-debug', !this.showDebugInfo);
		});
		this.debugBtnEl.addEventListener('click', (e) => {
			if (e.target !== debugCheck) {
				debugCheck.checked = !debugCheck.checked;
				debugCheck.dispatchEvent(new Event('change'));
			}
		});
	};

	proto.populateModelSelect = function(): void {
		this.modelSelect.empty();
		for (const model of this.models) {
			const opt = this.modelSelect.createEl('option', {text: model.name});
			opt.value = model.id;
		}
	};

	proto.getSelectedModelInfo = function(): ModelInfo | undefined {
		return this.models.find(m => m.id === this.selectedModel);
	};

	proto.openReasoningMenu = function(e: MouseEvent): void {
		const model = this.getSelectedModelInfo();
		const supported = model?.supportedReasoningEfforts;
		if (!model?.capabilities?.supports?.reasoningEffort || !supported || supported.length === 0) {
			const menu = new Menu();
			menu.addItem(item => item.setTitle('Model does not support reasoning effort').setDisabled(true));
			menu.showAtMouseEvent(e);
			return;
		}
		const menu = new Menu();
		const current = this.plugin.settings.reasoningEffort;
		for (const level of supported) {
			const label = level.charAt(0).toUpperCase() + level.slice(1);
			menu.addItem(item => {
				item.setTitle(label)
					.setChecked(level === current)
					.onClick(() => {
						// Toggle off if already selected
						const newEffort = level === current ? '' : level;
						this.plugin.settings.reasoningEffort = newEffort;
						void this.plugin.saveSettings();
						if (this.currentSession && !this.configDirty) {
							// Mid-session reasoning change via setModel()
							void this.currentSession.setModel(
								this.selectedModel,
								newEffort ? {reasoningEffort: newEffort as ReasoningEffort} : undefined,
							);
						} else {
							this.configDirty = true;
						}
						this.updateReasoningBadge();
					});
			});
		}
		menu.showAtMouseEvent(e);
	};

	proto.updateReasoningBadge = function(): void {
		const model = this.getSelectedModelInfo();
		const supportsReasoning = model?.capabilities?.supports?.reasoningEffort && (model.supportedReasoningEfforts?.length ?? 0) > 0;
		const level = this.plugin.settings.reasoningEffort;
		// Reset if current level isn't supported by the new model
		if (level !== '' && supportsReasoning && model?.supportedReasoningEfforts && !model.supportedReasoningEfforts.includes(level as ReasoningEffort)) {
			this.plugin.settings.reasoningEffort = '';
			void this.plugin.saveSettings();
		}
		const current = this.plugin.settings.reasoningEffort;
		const active = current !== '' && !!supportsReasoning;
		this.modelIconEl.toggleClass('is-active', active);
		this.modelIconEl.toggleClass('is-non-interactive', !supportsReasoning);
		if (!supportsReasoning) {
			this.modelIconEl.setAttribute('title', 'Model does not support reasoning effort');
		} else {
			const label = current === '' ? 'Reasoning effort' : `Reasoning effort: ${current.charAt(0).toUpperCase() + current.slice(1)}`;
			this.modelIconEl.setAttribute('title', label);
		}
	};

	proto.openSkillsMenu = function(e: MouseEvent): void {
		const menu = new Menu();
		if (this.skills.length === 0) {
			menu.addItem(item => item.setTitle('No skills configured').setDisabled(true));
		} else {
			for (const skill of this.skills) {
				menu.addItem(item => {
					item.setTitle(skill.name)
						.setChecked(this.enabledSkills.has(skill.name))
						.onClick(() => {
							if (this.enabledSkills.has(skill.name)) {
								this.enabledSkills.delete(skill.name);
							} else {
								this.enabledSkills.add(skill.name);
							}
							this.configDirty = true;
							this.updateSkillsBadge();
						});
				});
			}
		}
		menu.showAtMouseEvent(e);
	};

	proto.openToolsMenu = function(e: MouseEvent): void {
		const menu = new Menu();
		if (this.mcpServers.length === 0) {
			menu.addItem(item => item.setTitle('No tools configured').setDisabled(true));
		} else {
			for (const server of this.mcpServers) {
				menu.addItem(item => {
					item.setTitle(server.name)
						.setChecked(this.enabledMcpServers.has(server.name))
						.onClick(() => {
							if (this.enabledMcpServers.has(server.name)) {
								this.enabledMcpServers.delete(server.name);
							} else {
								this.enabledMcpServers.add(server.name);
							}
							this.configDirty = true;
							this.updateToolsBadge();
						});
				});
			}
		}
		menu.addSeparator();
		const currentApproval = this.plugin.settings.toolApproval;
		menu.addItem(item => {
			item.setTitle('Approval mode');
			const sub: Menu = (item as unknown as {setSubmenu: () => Menu}).setSubmenu();
			sub.addItem(si => {
				si.setTitle('Allow (auto-approve)')
					.setChecked(currentApproval === 'allow')
					.onClick(async () => {
						this.plugin.settings.toolApproval = 'allow';
						await this.plugin.saveSettings();
					});
			});
			sub.addItem(si => {
				si.setTitle('Ask (require approval)')
					.setChecked(currentApproval === 'ask')
					.onClick(async () => {
						this.plugin.settings.toolApproval = 'ask';
						await this.plugin.saveSettings();
					});
			});
		});
		menu.showAtMouseEvent(e);
	};

	proto.selectAgent = function(agentName: string): void {
		// Handle deselecting (empty = "Auto" / no agent)
		if (!agentName) {
			this.selectedAgent = '';
			this.agentSelect.value = '';
			this.agentSelect.selectedIndex = 0;
			this.agentSelect.title = '';
			this.applyAgentToolsAndSkills(undefined);
			this.configDirty = true;
			return;
		}
		const agent = this.agents.find(a => a.name === agentName)
			// Fallback: case-insensitive match
			?? this.agents.find(a => a.name.toLowerCase() === agentName.toLowerCase());
		if (!agent) return; // No matching agent found — leave dropdown unchanged
		this.selectedAgent = agent.name;
		// Update the dropdown — set both .value and .selectedIndex for reliability
		this.agentSelect.value = agent.name;
		const opts = this.agentSelect.options;
		for (let i = 0; i < opts.length; i++) {
			if (opts[i]!.value === agent.name) {
				this.agentSelect.selectedIndex = i;
				break;
			}
		}
		this.agentSelect.title = agent.instructions;
		// Auto-select agent's preferred model
		const resolvedModel = this.resolveModelForAgent(agent, this.selectedModel || undefined);
		if (resolvedModel && resolvedModel !== this.selectedModel) {
			this.selectedModel = resolvedModel;
			this.modelSelect.value = resolvedModel;
		}
		this.applyAgentToolsAndSkills(agent);
		this.configDirty = true;
	};

	proto.applyAgentToolsAndSkills = function(agent?: AgentConfig): void {
		// Tools: undefined = enable all, [] = disable all, [...] = enable listed
		if (agent?.tools !== undefined) {
			const allowed = new Set(agent.tools);
			this.enabledMcpServers = new Set(
				this.mcpServers.filter(s => allowed.has(s.name)).map(s => s.name)
			);
		} else {
			this.enabledMcpServers = new Set(this.mcpServers.map(s => s.name));
		}

		// Skills: undefined = enable all, [] = disable all, [...] = enable listed
		if (agent?.skills !== undefined) {
			const allowed = new Set(agent.skills);
			this.enabledSkills = new Set(
				this.skills.filter(s => allowed.has(s.name)).map(s => s.name)
			);
		} else {
			this.enabledSkills = new Set(this.skills.map(s => s.name));
		}

		this.updateSkillsBadge();
		this.updateToolsBadge();
	};

	proto.updateSkillsBadge = function(): void {
		const count = this.enabledSkills.size;
		this.skillsBtnEl.toggleClass('is-active', count > 0);
		this.skillsBtnEl.setAttribute('title', count > 0 ? `Skills (${count} active)` : 'Skills');
	};

	proto.updateToolsBadge = function(): void {
		const count = this.enabledMcpServers.size;
		this.toolsBtnEl.toggleClass('is-active', count > 0);
		this.toolsBtnEl.setAttribute('title', count > 0 ? `Tools (${count} active)` : 'Tools');
	};

	proto.openCwdPicker = function(): void {
		new FolderTreeModal(this.app, this.workingDir, (folder) => {
			this.workingDir = folder.path;
			this.updateCwdButton();
			this.configDirty = true;
		}).open();
	};

	proto.updateCwdButton = function(): void {
		const vaultName = this.app.vault.getName();
		const label = `Working directory: ${vaultName}/${this.workingDir}`;
		this.cwdBtnEl.setAttribute('title', label);
		this.cwdBtnEl.toggleClass('is-active', true);
	};

	proto.openEditFromChat = function(): void {
		const text = this.inputEl.value.trim();
		new EditModal(this.plugin, text, (result) => {
			this.inputEl.value = result;
			this.inputEl.setCssProps({'--input-height': 'auto'});
			this.inputEl.setCssProps({'--input-height': Math.min(this.inputEl.scrollHeight, 200) + 'px'});
			this.inputEl.focus();
		}).open();
	};

	proto.resolveModelForAgent = function(agent: AgentConfig | undefined, fallback: string | undefined): string | undefined {
		if (!agent?.model) return fallback;
		const target = agent.model.toLowerCase();
		let match = this.models.find(
			m => m.name.toLowerCase() === target || m.id.toLowerCase() === target
		);
		if (!match) {
			match = this.models.find(
				m => m.id.toLowerCase().includes(target) || m.name.toLowerCase().includes(target)
			);
		}
		return match ? match.id : fallback;
	};
}

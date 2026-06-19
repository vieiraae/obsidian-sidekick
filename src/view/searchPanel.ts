import {Menu, Notice, TFile, normalizePath, setIcon} from 'obsidian';
import type {SidekickView} from '../sidekickView';
import type {SessionConfig, SessionMetadata, ProviderConfig, PermissionRequest, CustomAgentConfig} from '../copilot';
import {approveAll} from '../copilot';
import type {AgentConfig} from '../types';
import {getSkillsFolder} from '../settings';
import {FolderTreeModal, ToolApprovalModal} from '../modals';
import {mapMcpServers} from './sessionConfig';

declare module '../sidekickView' {
	interface SidekickView {
		buildSearchPanel(parent: HTMLElement): void;
		readonly searchMode: 'basic' | 'advanced';
		toggleSearchMode(): void;
		updateSearchModeToggle(): void;
		updateSearchAdvancedVisibility(): void;
		updateSearchConfigUI(): void;
		applySearchAgentToolsAndSkills(agent?: AgentConfig): void;
		openSearchSkillsMenu(e: MouseEvent): void;
		openSearchToolsMenu(e: MouseEvent): void;
		updateSearchSkillsBadge(): void;
		updateSearchToolsBadge(): void;
		openSearchScopePicker(): void;
		updateSearchCwdButton(): void;
		getSearchWorkingDirectory(): string;
		buildSearchSessionConfig(): SessionConfig;
		handleSearch(): Promise<void>;
		handleBasicSearch(query: string): Promise<void>;
		handleAdvancedSearch(query: string): Promise<void>;
		buildBasicSearchSessionConfig(): SessionConfig;
		renderSearchResults(content: string): void;
		updateSearchButton(): void;
	}
}

export function installSearchPanel(ViewClass: { prototype: unknown }): void {
	const proto = ViewClass.prototype as SidekickView;

	proto.buildSearchPanel = function (this: SidekickView, parent: HTMLElement): void {
		const wrapper = parent.createDiv({cls: 'sidekick-search-wrapper'});

		// ── Toolbar row: scope | mode toggle | [advanced: agent | model | skills | tools] ──
		const toolbar = wrapper.createDiv({cls: 'sidekick-toolbar sidekick-search-toolbar'});

		// Search scope (folder picker) — always visible
		this.searchCwdBtnEl = toolbar.createEl('button', {cls: 'clickable-icon sidekick-icon-btn', attr: {title: 'Search scope'}});
		setIcon(this.searchCwdBtnEl, 'folder');
		this.searchCwdBtnEl.addEventListener('click', () => this.openSearchScopePicker());
		this.updateSearchCwdButton();

		// Mode toggle (basic / advanced)
		this.searchModeToggleEl = toolbar.createEl('button', {cls: 'clickable-icon sidekick-icon-btn', attr: {title: 'Toggle basic/advanced mode'}});
		this.searchModeToggleEl.addEventListener('click', () => this.toggleSearchMode());
		this.updateSearchModeToggle();

		// Advanced controls group — hidden in basic mode
		this.searchAdvancedToolbarEl = toolbar.createDiv({cls: 'sidekick-search-advanced-group'});

		// Agent dropdown
		const agentGroup = this.searchAdvancedToolbarEl.createDiv({cls: 'sidekick-toolbar-group'});
		const agentIcon = agentGroup.createSpan({cls: 'sidekick-toolbar-icon'});
		setIcon(agentIcon, 'bot');
		this.searchAgentSelect = agentGroup.createEl('select', {cls: 'sidekick-select'});
		this.searchAgentSelect.addEventListener('change', () => {
			this.searchAgent = this.searchAgentSelect.value;
			const agent = this.agents.find(a => a.name === this.searchAgent);
			this.searchAgentSelect.title = agent ? agent.instructions : '';
			// Auto-select agent's preferred model
			const resolvedModel = this.resolveModelForAgent(agent, this.searchModel || undefined);
			if (resolvedModel && resolvedModel !== this.searchModel) {
				this.searchModel = resolvedModel;
				this.searchModelSelect.value = resolvedModel;
			}
			// Apply agent's tools and skills filter for search
			this.applySearchAgentToolsAndSkills(agent);
			// Persist
			this.plugin.settings.searchAgent = this.searchAgent;
			void this.plugin.saveSettings();
		});

		// Model dropdown
		const modelGroup = this.searchAdvancedToolbarEl.createDiv({cls: 'sidekick-toolbar-group'});
		const modelIcon = modelGroup.createSpan({cls: 'sidekick-toolbar-icon'});
		setIcon(modelIcon, 'cpu');
		this.searchModelSelect = modelGroup.createEl('select', {cls: 'sidekick-select sidekick-model-select'});
		this.searchModelSelect.addEventListener('change', () => {
			this.searchModel = this.searchModelSelect.value;
		});

		// Skills button
		this.searchSkillsBtnEl = this.searchAdvancedToolbarEl.createEl('button', {cls: 'clickable-icon sidekick-icon-btn', attr: {title: 'Skills'}});
		setIcon(this.searchSkillsBtnEl, 'wand-2');
		this.searchSkillsBtnEl.addEventListener('click', (e) => this.openSearchSkillsMenu(e));

		// Tools button
		this.searchToolsBtnEl = this.searchAdvancedToolbarEl.createEl('button', {cls: 'clickable-icon sidekick-icon-btn', attr: {title: 'Tools'}});
		setIcon(this.searchToolsBtnEl, 'plug');
		this.searchToolsBtnEl.addEventListener('click', (e) => this.openSearchToolsMenu(e));

		// Apply initial visibility
		this.updateSearchAdvancedVisibility();

		// ── Search input + button ──
		const inputRow = wrapper.createDiv({cls: 'sidekick-search-input-row'});
		this.searchInputEl = inputRow.createEl('textarea', {
			cls: 'sidekick-search-input',
			attr: {placeholder: 'Describe what you\'re looking for…', rows: '2'},
		});
		this.searchInputEl.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				void this.handleSearch();
			}
		});

		this.searchBtnEl = inputRow.createEl('button', {cls: 'sidekick-search-btn', attr: {title: 'Search'}});
		setIcon(this.searchBtnEl, 'search');
		this.searchBtnEl.addEventListener('click', () => void this.handleSearch());

		// ── Results area ──
		this.searchResultsEl = wrapper.createDiv({cls: 'sidekick-search-results'});
	};

	Object.defineProperty(proto, 'searchMode', {
		get(this: SidekickView) { return this.plugin.settings.searchMode; },
		configurable: true,
	});

	proto.toggleSearchMode = function (this: SidekickView): void {
		const newMode = this.searchMode === 'basic' ? 'advanced' : 'basic';
		this.plugin.settings.searchMode = newMode;
		void this.plugin.saveSettings();
		this.updateSearchModeToggle();
		this.updateSearchAdvancedVisibility();
		// Disconnect cached basic session when switching modes
		if (newMode === 'advanced' && this.basicSearchSession) {
			void this.basicSearchSession.disconnect().catch(() => {});
			this.basicSearchSession = null;
		}
	};

	proto.updateSearchModeToggle = function (this: SidekickView): void {
		this.searchModeToggleEl.empty();
		if (this.searchMode === 'basic') {
			setIcon(this.searchModeToggleEl, 'settings');
			this.searchModeToggleEl.title = 'Basic mode (fast) — click for advanced';
		} else {
			setIcon(this.searchModeToggleEl, 'settings');
			this.searchModeToggleEl.title = 'Advanced mode — click for basic (fast)';
		}
		this.searchModeToggleEl.toggleClass('is-active', this.searchMode === 'advanced');
	};

	proto.updateSearchAdvancedVisibility = function (this: SidekickView): void {
		this.searchAdvancedToolbarEl.toggleClass('is-hidden', this.searchMode !== 'advanced');
	};

	proto.updateSearchConfigUI = function (this: SidekickView): void {
		// Agents
		this.searchAgentSelect.empty();
		const noAgent = this.searchAgentSelect.createEl('option', {text: 'Agent', attr: {value: ''}});
		noAgent.value = '';
		for (const agent of this.agents) {
			const opt = this.searchAgentSelect.createEl('option', {text: agent.name});
			opt.value = agent.name;
			opt.title = agent.instructions;
		}

		// Restore saved search agent from settings
		const savedAgent = this.plugin.settings.searchAgent;
		if (savedAgent && this.agents.some(a => a.name === savedAgent)) {
			this.searchAgent = savedAgent;
			this.searchAgentSelect.value = savedAgent;
			const selAgent = this.agents.find(a => a.name === savedAgent);
			this.searchAgentSelect.title = selAgent ? selAgent.instructions : '';
		}

		// Auto-select agent's preferred model
		const agentConfig = this.agents.find(a => a.name === this.searchAgent);
		const resolvedModel = this.resolveModelForAgent(agentConfig, this.searchModel || undefined);
		if (resolvedModel) {
			this.searchModel = resolvedModel;
		}

		// Models
		this.searchModelSelect.empty();
		for (const model of this.models) {
			const opt = this.searchModelSelect.createEl('option', {text: model.name});
			opt.value = model.id;
		}
		if (this.searchModel && this.models.some(m => m.id === this.searchModel)) {
			this.searchModelSelect.value = this.searchModel;
		} else if (this.models.length > 0 && this.models[0]) {
			this.searchModel = this.models[0].id;
			this.searchModelSelect.value = this.searchModel;
		}

		// Apply agent's tools and skills filter
		this.applySearchAgentToolsAndSkills(agentConfig);
	};

	proto.applySearchAgentToolsAndSkills = function (this: SidekickView, agent?: AgentConfig): void {
		// Tools: undefined = enable all, [] = disable all, [...] = enable listed
		if (agent?.tools !== undefined) {
			const allowed = new Set(agent.tools);
			this.searchEnabledMcpServers = new Set(
				this.mcpServers.filter(s => allowed.has(s.name)).map(s => s.name)
			);
		} else {
			this.searchEnabledMcpServers = new Set(this.mcpServers.map(s => s.name));
		}

		// Skills: undefined = enable all, [] = disable all, [...] = enable listed
		if (agent?.skills !== undefined) {
			const allowed = new Set(agent.skills);
			this.searchEnabledSkills = new Set(
				this.skills.filter(s => allowed.has(s.name)).map(s => s.name)
			);
		} else {
			this.searchEnabledSkills = new Set(this.skills.map(s => s.name));
		}

		this.updateSearchSkillsBadge();
		this.updateSearchToolsBadge();
	};

	proto.openSearchSkillsMenu = function (this: SidekickView, e: MouseEvent): void {
		const menu = new Menu();
		if (this.skills.length === 0) {
			menu.addItem(item => item.setTitle('No skills configured').setDisabled(true));
		} else {
			for (const skill of this.skills) {
				menu.addItem(item => {
					item.setTitle(skill.name)
						.setChecked(this.searchEnabledSkills.has(skill.name))
						.onClick(() => {
							if (this.searchEnabledSkills.has(skill.name)) {
								this.searchEnabledSkills.delete(skill.name);
							} else {
								this.searchEnabledSkills.add(skill.name);
							}
							this.updateSearchSkillsBadge();
						});
				});
			}
		}
		menu.showAtMouseEvent(e);
	};

	proto.openSearchToolsMenu = function (this: SidekickView, e: MouseEvent): void {
		const menu = new Menu();
		if (this.mcpServers.length === 0) {
			menu.addItem(item => item.setTitle('No tools configured').setDisabled(true));
		} else {
			for (const server of this.mcpServers) {
				menu.addItem(item => {
					item.setTitle(server.name)
						.setChecked(this.searchEnabledMcpServers.has(server.name))
						.onClick(() => {
							if (this.searchEnabledMcpServers.has(server.name)) {
								this.searchEnabledMcpServers.delete(server.name);
							} else {
								this.searchEnabledMcpServers.add(server.name);
							}
							this.updateSearchToolsBadge();
						});
				});
			}
		}
		menu.showAtMouseEvent(e);
	};

	proto.updateSearchSkillsBadge = function (this: SidekickView): void {
		const count = this.searchEnabledSkills.size;
		this.searchSkillsBtnEl.toggleClass('is-active', count > 0);
		this.searchSkillsBtnEl.setAttribute('title', count > 0 ? `Skills (${count} active)` : 'Skills');
	};

	proto.updateSearchToolsBadge = function (this: SidekickView): void {
		const count = this.searchEnabledMcpServers.size;
		this.searchToolsBtnEl.toggleClass('is-active', count > 0);
		this.searchToolsBtnEl.setAttribute('title', count > 0 ? `Tools (${count} active)` : 'Tools');
	};

	proto.openSearchScopePicker = function (this: SidekickView): void {
		new FolderTreeModal(this.app, this.searchWorkingDir, (folder) => {
			this.searchWorkingDir = folder.path;
			this.updateSearchCwdButton();
		}).open();
	};

	proto.updateSearchCwdButton = function (this: SidekickView): void {
		const vaultName = this.app.vault.getName();
		const label = this.searchWorkingDir
			? `Search scope: ${vaultName}/${this.searchWorkingDir}`
			: `Search scope: ${vaultName} (entire vault)`;
		this.searchCwdBtnEl.setAttribute('title', label);
		this.searchCwdBtnEl.toggleClass('is-active', !!this.searchWorkingDir);
	};

	proto.getSearchWorkingDirectory = function (this: SidekickView): string {
		const base = this.getVaultBasePath();
		if (!this.searchWorkingDir) return base;
		return base + '/' + normalizePath(this.searchWorkingDir);
	};

	proto.buildSearchSessionConfig = function (this: SidekickView): SessionConfig {
		const basePath = this.getVaultBasePath();

		// MCP servers (search-specific selection)
		const mcpServers = mapMcpServers(this.mcpServers, this.searchEnabledMcpServers, this.plugin.settings.githubToken || undefined);

		// Skills
		const skillDirs: string[] = [];
		if (this.skills.length > 0) {
			skillDirs.push([basePath, getSkillsFolder(this.plugin.settings)].join('/'));
		}
		const disabledSkills = this.skills
			.filter(s => !this.searchEnabledSkills.has(s.name))
			.map(s => s.name);

		// Custom agents — only the selected search agent, or all if none selected
		const agentPool = this.searchAgent
			? this.agents.filter(a => a.name === this.searchAgent)
			: this.agents;
		const customAgents: CustomAgentConfig[] = agentPool.map(a => ({
			name: a.name,
			displayName: a.name,
			description: a.description || undefined,
			prompt: a.instructions,
			tools: a.tools ?? null,
			infer: true,
		}));

		// Permission handler
		const permissionHandler = (request: PermissionRequest) => {
			if (this.plugin.settings.toolApproval === 'allow') {
				return approveAll(request, {sessionId: ''});
			}
			const modal = new ToolApprovalModal(this.app, request);
			modal.open();
			return modal.promise;
		};

		// BYOK provider
		const providerPreset = this.plugin.settings.providerPreset;
		let provider: ProviderConfig | undefined;
		if (providerPreset !== 'github' && this.plugin.settings.providerBaseUrl) {
			const typeMap: Record<string, 'openai' | 'azure' | 'anthropic'> = {
				openai: 'openai', azure: 'azure', anthropic: 'anthropic',
				ollama: 'openai', 'foundry-local': 'openai', 'other-openai': 'openai',
			};
			provider = {
				type: typeMap[providerPreset] ?? 'openai',
				baseUrl: this.plugin.settings.providerBaseUrl,
				...(this.plugin.settings.providerApiKey ? {apiKey: this.plugin.settings.providerApiKey} : {}),
				...(this.plugin.settings.providerBearerToken ? {bearerToken: this.plugin.settings.providerBearerToken} : {}),
				wireApi: this.plugin.settings.providerWireApi,
			};
		}

		return {
			model: (provider && this.plugin.settings.providerModel) ? this.plugin.settings.providerModel : (this.searchModel || undefined),
			streaming: providerPreset !== 'foundry-local',
			onPermissionRequest: permissionHandler,
			workingDirectory: this.getSearchWorkingDirectory(),
			...(provider ? {provider} : {}),
			...(Object.keys(mcpServers).length > 0 ? {mcpServers} : {}),
			...(customAgents.length > 0 ? {customAgents} : {}),
			...(skillDirs.length > 0 ? {skillDirectories: skillDirs} : {}),
			...(disabledSkills.length > 0 ? {disabledSkills} : {}),
		};
	};

	proto.handleSearch = async function (this: SidekickView): Promise<void> {
		if (this.isSearching) {
			// Cancel in-progress search
			const session = this.searchMode === 'basic' ? this.basicSearchSession : this.searchSession;
			if (session) {
				try { await session.abort(); } catch { /* ignore */ }
			}
			if (this.searchMode === 'advanced' && this.searchSession) {
				try { await this.searchSession.disconnect(); } catch { /* ignore */ }
				this.searchSession = null;
			}
			this.isSearching = false;
			this.updateSearchButton();
			return;
		}

		const query = this.searchInputEl.value.trim();
		if (!query) return;

		if (!this.plugin.copilot) {
			new Notice('Copilot is not configured.');
			return;
		}

		this.isSearching = true;
		this.updateSearchButton();
		this.searchResultsEl.empty();
		this.searchResultsEl.createDiv({cls: 'sidekick-search-loading', text: 'Searching…'});

		try {
			if (this.searchMode === 'basic') {
				await this.handleBasicSearch(query);
			} else {
				await this.handleAdvancedSearch(query);
			}
		} catch (e) {
			if (this.isSearching) {
				this.searchResultsEl.empty();
				this.searchResultsEl.createDiv({cls: 'sidekick-search-empty', text: `Search failed: ${String(e)}`});
			}
		} finally {
			this.isSearching = false;
			this.updateSearchButton();
		}
	};

	proto.handleBasicSearch = async function (this: SidekickView, query: string): Promise<void> {
		// Reuse persistent session; create only if missing
		if (!this.basicSearchSession) {
			this.basicSearchSession = await this.plugin.copilot!.createSession(this.buildBasicSearchSessionConfig());
		}

		const scopePath = this.getSearchWorkingDirectory();
		const scopeLabel = this.searchWorkingDir || this.app.vault.getName();
		const searchPrompt = `Perform a semantic search for files matching the following query. Return ONLY a JSON array of objects, each with "file" (vault-relative path), "folder" (parent folder path), and "reason" (brief description why it matches). Sort by relevance (best match first). No markdown fences, no extra text.\n\nQuery: ${query}`;

		try {
			const response = await this.basicSearchSession.sendAndWait({
				prompt: searchPrompt,
				attachments: [{type: 'directory', path: scopePath, displayName: scopeLabel}],
			}, 120_000);
			const content = response?.data.content || '';
			this.renderSearchResults(content);
		} catch (e) {
			// Session may be broken — discard and rethrow so outer catch handles it
			try { await this.basicSearchSession.disconnect(); } catch { /* ignore */ }
			this.basicSearchSession = null;
			throw e;
		}
	};

	proto.handleAdvancedSearch = async function (this: SidekickView, query: string): Promise<void> {
		const sessionConfig = this.buildSearchSessionConfig();
		this.searchSession = await this.plugin.copilot!.createSession(sessionConfig);
		const sessionId = this.searchSession.sessionId;

		// Name the session
		const agentLabel = this.searchAgent || 'Search';
		const truncated = query.length > 40 ? query.slice(0, 40) + '…' : query;
		this.sessionNames[sessionId] = `[search] ${agentLabel}: ${truncated}`;
		this.saveSessionNames();

		// Add to session list
		if (!this.sessionList.some(s => s.sessionId === sessionId)) {
			const now = new Date();
			this.sessionList.unshift({
				sessionId,
				startTime: now,
				modifiedTime: now,
				isRemote: false,
			} as SessionMetadata);
		}
		this.renderSessionList();

		const searchPrompt = this.searchAgent
			? `Perform a semantic search for files matching the following query. Return ONLY a JSON array of objects, each with "file" (vault-relative path), "folder" (parent folder path), and "reason" (brief description why it matches). Sort by relevance (best match first). No markdown fences, no extra text.\n\nQuery: ${query}`
			: `Perform a semantic search for files matching the following query. Return ONLY a JSON array of objects, each with "file" (vault-relative path), "folder" (parent folder path), and "reason" (brief description why it matches). Sort by relevance (best match first). No markdown fences, no extra text.\n\nQuery: ${query}`;

		const scopePath = this.getSearchWorkingDirectory();
		const scopeLabel = this.searchWorkingDir || this.app.vault.getName();
		try {
			const response = await this.searchSession.sendAndWait({
				prompt: searchPrompt,
				attachments: [{type: 'directory', path: scopePath, displayName: scopeLabel}],
			}, 120_000);
			const content = response?.data.content || '';
			this.renderSearchResults(content);
		} finally {
			if (this.searchSession) {
				try { await this.searchSession.disconnect(); } catch { /* ignore */ }
				this.searchSession = null;
			}
		}
	};

	proto.buildBasicSearchSessionConfig = function (this: SidekickView): SessionConfig {
		const permissionHandler = (request: PermissionRequest) => {
			if (this.plugin.settings.toolApproval === 'allow') {
				return approveAll(request, {sessionId: ''});
			}
			const modal = new ToolApprovalModal(this.app, request);
			modal.open();
			return modal.promise;
		};

		// Use inline model setting, fall back to first available model
		let model = this.plugin.settings.inlineModel || undefined;
		if (!model && this.models.length > 0 && this.models[0]) {
			model = this.models[0].id;
		}

		// BYOK provider
		const providerPreset = this.plugin.settings.providerPreset;
		let provider: ProviderConfig | undefined;
		if (providerPreset !== 'github' && this.plugin.settings.providerBaseUrl) {
			const typeMap: Record<string, 'openai' | 'azure' | 'anthropic'> = {
				openai: 'openai', azure: 'azure', anthropic: 'anthropic',
				ollama: 'openai', 'foundry-local': 'openai', 'other-openai': 'openai',
			};
			provider = {
				type: typeMap[providerPreset] ?? 'openai',
				baseUrl: this.plugin.settings.providerBaseUrl,
				...(this.plugin.settings.providerApiKey ? {apiKey: this.plugin.settings.providerApiKey} : {}),
				...(this.plugin.settings.providerBearerToken ? {bearerToken: this.plugin.settings.providerBearerToken} : {}),
				wireApi: this.plugin.settings.providerWireApi,
			};
		}

		return {
			model: (provider && this.plugin.settings.providerModel) ? this.plugin.settings.providerModel : model,
			streaming: providerPreset !== 'foundry-local',
			onPermissionRequest: permissionHandler,
			workingDirectory: this.getSearchWorkingDirectory(),
			...(provider ? {provider} : {}),
		};
	};

	proto.renderSearchResults = function (this: SidekickView, content: string): void {
		this.searchResultsEl.empty();

		// Try to parse JSON array from the response
		let results: Array<{file?: string; path?: string; folder: string; reason: string}> = [];
		try {
			// Strip markdown fences if present
			const cleaned = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
			const parsed = JSON.parse(cleaned);
			// Handle both single object and array responses
			results = Array.isArray(parsed) ? parsed : [parsed];
		} catch {
			// If not valid JSON, show the raw response
			this.searchResultsEl.createDiv({cls: 'sidekick-search-empty', text: content || 'No results found.'});
			return;
		}

		if (!Array.isArray(results) || results.length === 0) {
			this.searchResultsEl.createDiv({cls: 'sidekick-search-empty', text: 'No results found.'});
			return;
		}

		for (const result of results) {
			const item = this.searchResultsEl.createDiv({cls: 'sidekick-search-result'});

			const fileRow = item.createDiv({cls: 'sidekick-search-result-file'});
			const fileIcon = fileRow.createSpan({cls: 'sidekick-search-result-icon'});
			setIcon(fileIcon, 'file-text');
			const filePath = (result.file || result.path || '').replace(/^\/+/, '');
			const fileName = filePath.split('/').pop() || filePath || 'Unknown';
			const fileLink = fileRow.createSpan({cls: 'sidekick-search-result-name', text: fileName});

			fileLink.addEventListener('click', () => {
				if (!filePath) return;
				const resolved = this.app.vault.getAbstractFileByPath(filePath)
					?? (result.folder ? this.app.vault.getAbstractFileByPath(result.folder + '/' + filePath) : null);
				if (resolved instanceof TFile) {
					void this.app.workspace.openLinkText(resolved.path, '', false);
				} else {
					// Fallback: let Obsidian try to resolve the link
					void this.app.workspace.openLinkText(filePath, '', false);
				}
			});

			if (result.folder) {
				fileRow.createSpan({cls: 'sidekick-search-result-folder', text: result.folder});
			}

			if (result.reason) {
				item.createDiv({cls: 'sidekick-search-result-reason', text: result.reason});
			}
		}
	};

	proto.updateSearchButton = function (this: SidekickView): void {
		this.searchBtnEl.empty();
		if (this.isSearching) {
			setIcon(this.searchBtnEl, 'square');
			this.searchBtnEl.title = 'Cancel search';
			this.searchBtnEl.addClass('is-searching');
		} else {
			setIcon(this.searchBtnEl, 'search');
			this.searchBtnEl.title = 'Search';
			this.searchBtnEl.removeClass('is-searching');
		}
	};
}

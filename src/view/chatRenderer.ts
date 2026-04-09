import {
	Component,
	MarkdownView,
	Notice,
	TFile,
	TFolder,
	normalizePath,
	setIcon,
} from 'obsidian';
import type {SidekickView} from '../sidekickView';
import type {ChatMessage, ChatAttachment} from '../types';
import {renderMarkdownSafe} from './utils';

declare module '../sidekickView' {
	interface SidekickView {
		addUserMessage(content: string, attachments: ChatAttachment[], scopePaths: string[]): void;
		addInfoMessage(text: string): void;
		renderMessageBubble(msg: ChatMessage): Promise<void>;
		renderUserMessageContent(content: string, body: HTMLElement): void;
		addAssistantPlaceholder(): void;
		showProcessingIndicator(): void;
		removeProcessingIndicator(): void;
		appendDelta(delta: string): void;
		updateStreamingRenderIncremental(): void;
		doFullStreamingRender(): Promise<void>;
		updateStreamingRender(): Promise<void>;
		finalizeStreamingMessage(): void;
		renderMessageMetadata(): void;
		addToolCallBlock(toolCallId: string, toolName: string, args?: unknown): void;
		completeToolCallBlock(toolCallId: string, success: boolean, result?: {content?: string; detailedContent?: string}, error?: {message: string}): void;
		renderWelcome(): void;
		updateSendButton(): void;
		renderReasoningBlock(reasoning: string, parent: HTMLElement): Promise<void>;
		startReasoningBlock(): void;
		appendReasoningDelta(delta: string): void;
		syncReasoningContent(content: string): void;
		doFullReasoningRender(): Promise<void>;
		finalizeReasoning(): void;
		clearReasoningState(): void;
	}
}

export function installChatRenderer(ViewClass: {prototype: unknown}): void {
	const proto = ViewClass.prototype as SidekickView;

	proto.addUserMessage = function (content: string, attachments: ChatAttachment[], scopePaths: string[]): void {
		// Combine file/clipboard attachments with scope path entries for display
		const allAttachments = [...attachments];
		for (const sp of scopePaths) {
			const displayName = sp === '/' ? this.app.vault.getName() : sp;
			const abstract = sp === '/'
				? this.app.vault.getRoot()
				: this.app.vault.getAbstractFileByPath(sp);
			const type = abstract instanceof TFolder ? 'directory' as const : 'file' as const;
			allAttachments.push({type, name: displayName, path: sp});
		}

		const msg: ChatMessage = {
			id: `u-${Date.now()}`,
			role: 'user',
			content,
			timestamp: Date.now(),
			attachments: allAttachments.length > 0 ? allAttachments : undefined,
		};
		this.messages.push(msg);
		void this.renderMessageBubble(msg);
		this.scrollToBottom();
	};

	proto.addInfoMessage = function (text: string): void {
		const msg: ChatMessage = {id: `i-${Date.now()}`, role: 'info', content: text, timestamp: Date.now()};
		this.messages.push(msg);
		void this.renderMessageBubble(msg);
		this.scrollToBottom();
	};

	proto.renderMessageBubble = function (msg: ChatMessage): Promise<void> {
		if (msg.role === 'info') {
			const el = this.chatContainer.createDiv({cls: 'sidekick-msg sidekick-msg-info'});
			el.createSpan({text: msg.content});
			return Promise.resolve();
		}

		const wrapper = this.chatContainer.createDiv({
			cls: `sidekick-msg sidekick-msg-${msg.role}`,
		});

		const bodyWrapper = wrapper.createDiv({cls: 'sidekick-msg-body-wrapper'});

		// Attachments
		if (msg.attachments && msg.attachments.length > 0) {
			const attRow = bodyWrapper.createDiv({cls: 'sidekick-msg-attachments'});
			for (const att of msg.attachments) {
				const chip = attRow.createSpan({cls: 'sidekick-msg-att-chip sidekick-att-clickable'});
				const ic = chip.createSpan();
				const icon = att.type === 'directory' ? 'folder' : att.type === 'image' ? 'image' : att.type === 'clipboard' ? 'clipboard' : att.type === 'selection' ? 'text-cursor-input' : 'file-text';
				setIcon(ic, icon);
				chip.appendText(` ${att.name}`);

				// Click to open
				if (att.type === 'clipboard') {
					// Clipboard: copy content back to clipboard
					if (att.content) {
						chip.setAttribute('title', 'Copy to clipboard');
						chip.addEventListener('click', () => {
							void navigator.clipboard.writeText(att.content!);
							new Notice('Copied to clipboard.');
						});
					}
				} else if (att.absolutePath && att.path) {
					// External OS file: open with default OS application
					chip.setAttribute('title', 'Open with os default application');
					chip.addEventListener('click', () => {
						try {
							const filePath = att.path!;
							// Reject paths with traversal sequences
							if (/\.\.[/\\]/.test(filePath)) {
								new Notice('Cannot open file: path contains directory traversal.');
								return;
							}
							const {shell} = globalThis.require('electron') as {shell: {openPath: (p: string) => Promise<string>}};
							void shell.openPath(filePath);
						} catch (e) {
							new Notice(`Failed to open file: ${String(e)}`);
						}
					});
				} else if (att.type === 'image' && att.path) {
					// Pasted image in vault: open with OS image viewer
					chip.setAttribute('title', 'Open with os image viewer');
					chip.addEventListener('click', () => {
						try {
							const vaultPath = normalizePath(att.path!);
							// Reject paths that escape the vault via traversal
							if (vaultPath.startsWith('..') || vaultPath.includes('/../')) {
								new Notice('Cannot open image: path escapes the vault.');
								return;
							}
							const {shell} = globalThis.require('electron') as {shell: {openPath: (p: string) => Promise<string>}};
							const absPath = this.getVaultBasePath() + '/' + vaultPath;
							void shell.openPath(absPath);
						} catch (e) {
							new Notice(`Failed to open image: ${String(e)}`);
						}
					});
				} else if (att.type === 'directory' && att.path) {
					// Vault folder: reveal in file explorer
					chip.setAttribute('title', 'Reveal in file explorer');
					chip.addEventListener('click', () => {
						const folder = att.path === '/'
							? this.app.vault.getRoot()
							: this.app.vault.getAbstractFileByPath(att.path!);
						if (folder) {
							// Reveal the folder in Obsidian's file explorer
							const fileExplorer = this.app.workspace.getLeavesOfType('file-explorer')[0];
							if (fileExplorer) {
								void this.app.workspace.revealLeaf(fileExplorer);
								(fileExplorer.view as unknown as {revealInFolder?: (f: unknown) => void}).revealInFolder?.(folder);
							}
						}
					});
				} else if (att.type === 'selection' && att.path) {
					// Selection: open file at the selected line
					const selRange = att.selection;
					const preview = att.content && att.content.length > 80 ? att.content.slice(0, 80) + '…' : att.content || '';
					const rangeLabel = selRange
						? selRange.startLine === selRange.endLine
							? `line ${selRange.startLine}`
							: `lines ${selRange.startLine}-${selRange.endLine}`
						: '';
					chip.setAttribute('title', `Open ${att.path}${rangeLabel ? ` (${rangeLabel})` : ''}${preview ? `:\n${preview}` : ''}`);
					chip.addEventListener('click', () => {
						const file = this.app.vault.getAbstractFileByPath(att.path!);
						if (file instanceof TFile) {
							const leaf = this.app.workspace.getLeaf(false);
							void leaf.openFile(file).then(() => {
								if (selRange) {
									const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
									if (mdView) {
										mdView.editor.setCursor({line: selRange.startLine - 1, ch: selRange.startChar});
										mdView.editor.setSelection(
											{line: selRange.startLine - 1, ch: selRange.startChar},
											{line: selRange.endLine - 1, ch: selRange.endChar},
										);
									}
								}
							});
						}
					});
				} else if (att.type === 'file' && att.path) {
					// Vault file: open in Obsidian
					chip.setAttribute('title', 'Open in Obsidian');
					chip.addEventListener('click', () => {
						const file = this.app.vault.getAbstractFileByPath(att.path!);
						if (file instanceof TFile) {
							void this.app.workspace.getLeaf(false).openFile(file);
						}
					});
				}
			}
		}

		if (msg.role === 'assistant' && msg.reasoning) {
			void this.renderReasoningBlock(msg.reasoning, bodyWrapper);
		}

		const body = bodyWrapper.createDiv({cls: 'sidekick-msg-body'});

		if (msg.role === 'assistant') {
			return renderMarkdownSafe(this.app, msg.content, body, this.streamingComponent ?? this);
		} else {
			this.renderUserMessageContent(msg.content, body);
			// Copy button for user messages
			const copyBtn = wrapper.createEl('button', {
				cls: 'sidekick-msg-copy',
				attr: {title: 'Copy to clipboard'},
			});
			setIcon(copyBtn, 'copy');
			copyBtn.addEventListener('click', () => {
				void navigator.clipboard.writeText(msg.content);
				setIcon(copyBtn, 'check');
				setTimeout(() => setIcon(copyBtn, 'copy'), 1500);
			});
		}
		return Promise.resolve();
	};

	proto.renderReasoningBlock = function (reasoning: string, parent: HTMLElement): Promise<void> {
		const details = parent.createEl('details', {cls: 'sidekick-reasoning'});
		const summary = details.createEl('summary', {cls: 'sidekick-reasoning-summary'});
		const iconEl = summary.createSpan({cls: 'sidekick-reasoning-icon'});
		setIcon(iconEl, 'lightbulb');
		summary.appendText('Reasoning');
		const body = details.createDiv({cls: 'sidekick-reasoning-body'});
		return renderMarkdownSafe(this.app, reasoning, body, this.streamingComponent ?? this);
	};

	/**
	 * Render user message content, highlighting `/prompt-name` with a tooltip if it matches a known prompt.
	 */
	proto.renderUserMessageContent = function (content: string, body: HTMLElement): void {
		if (content.startsWith('/')) {
			const spaceIdx = content.indexOf(' ');
			const cmdName = spaceIdx > 0 ? content.slice(1, spaceIdx) : content.slice(1);
			const matchedPrompt = this.prompts.find(p => p.name === cmdName);
			if (matchedPrompt) {
				const p = body.createEl('p');
				const promptSpan = p.createSpan({cls: 'sidekick-prompt-tag', text: `/${cmdName}`});
				promptSpan.setAttribute('title', matchedPrompt.content);
				if (spaceIdx > 0) {
					p.appendText(content.slice(spaceIdx));
				}
				return;
			}
		}
		body.createEl('p', {text: content});
	};

	proto.addAssistantPlaceholder = function (): void {
		const wrapper = this.chatContainer.createDiv({cls: 'sidekick-msg sidekick-msg-assistant'});

		const bodyWrapper = wrapper.createDiv({cls: 'sidekick-msg-body-wrapper'});

		// Container for collapsible tool call blocks
		this.toolCallsContainer = bodyWrapper.createDiv({cls: 'sidekick-tool-calls'});

		const body = bodyWrapper.createDiv({cls: 'sidekick-msg-body'});
		const thinking = body.createDiv({cls: 'sidekick-thinking'});
		thinking.createSpan({text: 'Thinking'});
		const dots = thinking.createSpan({cls: 'sidekick-thinking-dots'});
		dots.createSpan({cls: 'sidekick-dot', text: '.'});
		dots.createSpan({cls: 'sidekick-dot', text: '.'});
		dots.createSpan({cls: 'sidekick-dot', text: '.'});

		// Clean up any previous streaming component
		if (this.streamingComponent) {
			this.removeChild(this.streamingComponent);
			this.streamingComponent = null;
		}
		this.streamingComponent = this.addChild(new Component());

		this.streamingBodyEl = body;
		this.streamingWrapperEl = bodyWrapper;
		this.scrollToBottom();
	};

	proto.showProcessingIndicator = function (): void {
		if (!this.streamingBodyEl) return;
		// Remove any existing thinking/processing indicator
		const existing = this.streamingBodyEl.querySelector('.sidekick-thinking');
		if (existing) existing.remove();
		const processing = this.streamingBodyEl.createDiv({cls: 'sidekick-thinking'});
		processing.createSpan({text: 'Processing'});
		const dots = processing.createSpan({cls: 'sidekick-thinking-dots'});
		dots.createSpan({cls: 'sidekick-dot', text: '.'});
		dots.createSpan({cls: 'sidekick-dot', text: '.'});
		dots.createSpan({cls: 'sidekick-dot', text: '.'});
	};

	proto.removeProcessingIndicator = function (): void {
		if (!this.streamingBodyEl) return;
		const indicator = this.streamingBodyEl.querySelector('.sidekick-thinking');
		if (indicator) indicator.remove();
	};

	// ── Streaming ────────────────────────────────────────────────

	proto.appendDelta = function (delta: string): void {
		this.streamingContent += delta;
		// Remove processing indicator once real content starts streaming
		this.removeProcessingIndicator();
		if (!this.renderScheduled) {
			this.renderScheduled = true;
			window.requestAnimationFrame(() => {
				this.renderScheduled = false;
				this.updateStreamingRenderIncremental();
			});
		}
	};

	// ── Reasoning streaming ──────────────────────────────────────

	proto.startReasoningBlock = function (): void {
		if (this.reasoningEl && !this.reasoningEl.isConnected) {
			this.reasoningEl = null;
			this.reasoningBodyEl = null;
		}
		if (!this.streamingWrapperEl || !this.streamingBodyEl || this.reasoningEl) return;

		// Remove the thinking placeholder from the answer body
		const thinking = this.streamingBodyEl?.querySelector('.sidekick-thinking');
		if (thinking) thinking.remove();

		const details = document.createElement('details') as HTMLDetailsElement;
		details.className = 'sidekick-reasoning';
		details.open = true;

		const summary = document.createElement('summary');
		summary.className = 'sidekick-reasoning-summary';
		const spinner = document.createElement('span');
		spinner.className = 'sidekick-reasoning-spinner';
		summary.appendChild(spinner);
		summary.appendChild(document.createTextNode('Thinking\u2026'));
		details.appendChild(summary);

		const body = document.createElement('div');
		body.className = 'sidekick-reasoning-body';
		details.appendChild(body);

		// Insert before the answer body element
		this.streamingWrapperEl.insertBefore(details, this.streamingBodyEl);
		this.reasoningEl = details;
		this.reasoningBodyEl = body;
	};

	proto.appendReasoningDelta = function (delta: string): void {
		if (!this.reasoningEl) {
			this.startReasoningBlock();
		}
		this.reasoningComplete = false;
		this.streamingReasoning += delta;
		if (this.reasoningBodyEl) {
			this.reasoningBodyEl.appendText(delta);
		}
		if (!this.fullReasoningRenderTimer) {
			this.fullReasoningRenderTimer = setTimeout(() => {
				this.fullReasoningRenderTimer = null;
				void this.doFullReasoningRender();
			}, 300);
		}
		this.scrollToBottom();
	};

	proto.syncReasoningContent = function (content: string): void {
		if (!content) return;
		if (!this.reasoningEl) {
			this.startReasoningBlock();
		}
		this.streamingReasoning = content;
		if (this.fullReasoningRenderTimer) {
			clearTimeout(this.fullReasoningRenderTimer);
			this.fullReasoningRenderTimer = null;
		}
		void this.doFullReasoningRender();
	};

	proto.doFullReasoningRender = async function (): Promise<void> {
		if (!this.reasoningBodyEl || !this.reasoningBodyEl.isConnected || !this.streamingReasoning) return;
		this.reasoningBodyEl.empty();
		await renderMarkdownSafe(this.app, this.streamingReasoning, this.reasoningBodyEl, this.streamingComponent ?? this);
		this.scrollToBottom();
	};

	proto.finalizeReasoning = function (): void {
		if (this.reasoningComplete) return;
		this.reasoningComplete = true;

		// Cancel pending incremental render and do a final full render
		if (this.fullReasoningRenderTimer) {
			clearTimeout(this.fullReasoningRenderTimer);
			this.fullReasoningRenderTimer = null;
		}
		void this.doFullReasoningRender();

		if (this.reasoningEl) {
			// Collapse the block
			this.reasoningEl.removeAttribute('open');
			// Swap spinner for a static icon and change label
			const summary = this.reasoningEl.querySelector<HTMLElement>('summary');
			if (summary) {
				summary.empty();
				const iconEl = summary.createSpan({cls: 'sidekick-reasoning-icon'});
				setIcon(iconEl, 'lightbulb');
				summary.appendText('Reasoning');
			}
		}

		// Restore the thinking indicator in the answer body if no answer content has arrived yet
		if (!this.streamingContent && this.streamingBodyEl) {
			const thinking = this.streamingBodyEl.createDiv({cls: 'sidekick-thinking'});
			thinking.createSpan({text: 'Thinking'});
			const dots = thinking.createSpan({cls: 'sidekick-thinking-dots'});
			dots.createSpan({cls: 'sidekick-dot', text: '.'});
			dots.createSpan({cls: 'sidekick-dot', text: '.'});
			dots.createSpan({cls: 'sidekick-dot', text: '.'});
		}
	};

	proto.clearReasoningState = function (): void {
		if (this.fullReasoningRenderTimer) {
			clearTimeout(this.fullReasoningRenderTimer);
			this.fullReasoningRenderTimer = null;
		}
		this.streamingReasoning = '';
		this.reasoningEl = null;
		this.reasoningBodyEl = null;
		this.reasoningComplete = false;
	};

	/**
	 * Append only the new delta text as a plain text node.
	 * A periodic timer does full markdown re-renders every 300ms
	 * to resolve cross-boundary syntax (code blocks, lists, etc.).
	 */
	proto.updateStreamingRenderIncremental = function (): void {
		if (!this.streamingBodyEl) return;

		const newText = this.streamingContent.slice(this.lastFullRenderLen);
		if (newText) {
			// Append raw text node for immediate visual feedback
			this.streamingBodyEl.appendText(newText);
			this.lastFullRenderLen = this.streamingContent.length;
		}

		// Schedule a periodic full re-render if not already scheduled
		if (!this.fullRenderTimer) {
			this.fullRenderTimer = setTimeout(() => {
				this.fullRenderTimer = null;
				void this.doFullStreamingRender();
			}, 300);
		}

		this.scrollToBottom();
	};

	/** Full markdown re-render of the entire streamed content so far. */
	proto.doFullStreamingRender = async function (): Promise<void> {
		if (!this.streamingBodyEl) return;
		this.streamingBodyEl.empty();
		await renderMarkdownSafe(this.app, this.streamingContent, this.streamingBodyEl, this.streamingComponent ?? this);
		this.lastFullRenderLen = this.streamingContent.length;
		this.scrollToBottom();
	};

	proto.updateStreamingRender = async function (): Promise<void> {
		if (!this.streamingBodyEl) return;
		this.streamingBodyEl.empty();
		await renderMarkdownSafe(this.app, this.streamingContent, this.streamingBodyEl, this.streamingComponent ?? this);
		this.scrollToBottom();
	};

	proto.finalizeStreamingMessage = function (): void {
		// Always remove any lingering thinking/processing indicator
		this.removeProcessingIndicator();
		if (this.streamingReasoning && !this.reasoningComplete) {
			this.finalizeReasoning();
		}

		if (this.streamingContent || this.streamingReasoning) {
			const msg: ChatMessage = {
				id: `a-${Date.now()}`,
				role: 'assistant',
				content: this.streamingContent,
				reasoning: this.streamingReasoning || undefined,
				timestamp: Date.now(),
			};
			this.messages.push(msg);
		}

		// Clean up incremental render timer and do final full render
		if (this.fullRenderTimer) {
			clearTimeout(this.fullRenderTimer);
			this.fullRenderTimer = null;
		}
		if (this.streamingBodyEl && this.streamingContent) {
			this.streamingBodyEl.empty();
			void renderMarkdownSafe(this.app, this.streamingContent, this.streamingBodyEl, this.streamingComponent ?? this);
		} else if (this.streamingBodyEl && !this.streamingContent && !this.streamingReasoning) {
			// No text was streamed — show a subtle fallback
			this.streamingBodyEl.empty();
			this.streamingBodyEl.createDiv({
				cls: 'sidekick-thinking sidekick-cancelled',
				text: 'No response',
			});
		}
		this.lastFullRenderLen = 0;

		// Render metadata footer
		this.renderMessageMetadata();

		this.streamingContent = '';
		this.streamingBodyEl = null;
		this.streamingWrapperEl = null;
		this.toolCallsContainer = null;
		this.activeToolCalls.clear();

		this.clearReasoningState();

		if (this.streamingComponent) {
			this.removeChild(this.streamingComponent);
			this.streamingComponent = null;
		}

		// Reset turn metadata
		this.turnStartTime = 0;
		this.turnToolsUsed = [];
		this.turnSkillsUsed = [];
		this.turnUsage = null;

		this.isStreaming = false;
		this.updateSendButton();

		// Update local session timestamp instead of full SDK round-trip
		if (this.currentSessionId) {
			const entry = this.sessionList.find(s => s.sessionId === this.currentSessionId);
			if (entry) {
				entry.modifiedTime = new Date();
			}
		}
		this.renderSessionList();
	};

	proto.renderMessageMetadata = function (): void {
		if (!this.streamingWrapperEl) return;

		const hasTime = this.turnStartTime > 0;
		const hasTokens = this.turnUsage !== null;
		const uniqueTools = [...new Set(this.turnToolsUsed)];
		const hasTools = uniqueTools.length > 0;
		const uniqueSkills = [...new Set(this.turnSkillsUsed)];
		const hasSkills = uniqueSkills.length > 0;

		if (!hasTime && !hasTokens && !hasTools && !hasSkills) return;

		const footer = this.streamingWrapperEl.createDiv({cls: 'sidekick-msg-metadata'});

		// Elapsed time
		if (hasTime) {
			const elapsed = Date.now() - this.turnStartTime;
			const timeText = elapsed < 1000 ? `${elapsed}ms` : `${(elapsed / 1000).toFixed(1)}s`;
			const timeSpan = footer.createSpan({cls: 'sidekick-metadata-item'});
			const timeIcon = timeSpan.createSpan({cls: 'sidekick-metadata-icon'});
			setIcon(timeIcon, 'clock');
			timeSpan.appendText(timeText);
		}

		// Token usage — show rounded total, detail on hover
		if (hasTokens) {
			const u = this.turnUsage!;
			const total = u.inputTokens + u.cacheReadTokens + u.outputTokens;
			const rounded = total >= 1000 ? `${(total / 1000).toFixed(1)}k` : `${total}`;
			const tooltipLines: string[] = [];
			if (u.model) tooltipLines.push(`Model: ${u.model}`);
			tooltipLines.push(`Input: ${u.inputTokens}`);
			tooltipLines.push(`Output: ${u.outputTokens}`);
			if (u.cacheReadTokens > 0) tooltipLines.push(`Cached: ${u.cacheReadTokens}`);
			if (u.cacheWriteTokens > 0) tooltipLines.push(`Cache write: ${u.cacheWriteTokens}`);
			const tokenSpan = footer.createSpan({cls: 'sidekick-metadata-item'});
			const tokenIcon = tokenSpan.createSpan({cls: 'sidekick-metadata-icon'});
			setIcon(tokenIcon, 'hash');
			tokenSpan.appendText(`${rounded} tokens`);
			tokenSpan.setAttribute('title', tooltipLines.join('\n'));
		}

		// Tools used
		if (hasTools) {
			const toolSpan = footer.createSpan({cls: 'sidekick-metadata-item sidekick-metadata-tools'});
			const toolIcon = toolSpan.createSpan({cls: 'sidekick-metadata-icon'});
			setIcon(toolIcon, 'wrench');
			const toolLabel = uniqueTools.length === 1 ? '1 tool' : `${uniqueTools.length} tools`;
			toolSpan.appendText(toolLabel);
			toolSpan.setAttribute('title', uniqueTools.join('\n'));
		}

		// Skills used
		if (hasSkills) {
			const skillSpan = footer.createSpan({cls: 'sidekick-metadata-item sidekick-metadata-tools'});
			const skillIcon = skillSpan.createSpan({cls: 'sidekick-metadata-icon'});
			setIcon(skillIcon, 'wand-2');
			const skillLabel = uniqueSkills.length === 1 ? '1 skill' : `${uniqueSkills.length} skills`;
			skillSpan.appendText(skillLabel);
			skillSpan.setAttribute('title', uniqueSkills.join('\n'));
		}
	};

	proto.addToolCallBlock = function (toolCallId: string, toolName: string, args?: unknown): void {
		if (!this.toolCallsContainer) return;

		const details = this.toolCallsContainer.createEl('details', {cls: 'sidekick-tool-call'});
		const summary = details.createEl('summary', {cls: 'sidekick-tool-call-summary'});
		const iconEl = summary.createSpan({cls: 'sidekick-tool-call-icon'});
		setIcon(iconEl, 'wrench');
		summary.createSpan({cls: 'sidekick-tool-call-name', text: toolName});
		const spinner = summary.createSpan({cls: 'sidekick-tool-call-spinner'});
		setIcon(spinner, 'loader');

		// Input section
		if (args && Object.keys(args as Record<string, unknown>).length > 0) {
			const inputSection = details.createDiv({cls: 'sidekick-tool-call-section'});
			inputSection.createDiv({cls: 'sidekick-tool-call-label', text: 'Input'});
			const pre = inputSection.createEl('pre', {cls: 'sidekick-tool-call-code'});
			pre.createEl('code', {text: JSON.stringify(args, null, 2)});
		}

		this.activeToolCalls.set(toolCallId, {toolName, detailsEl: details});

		// Show "Processing ..." animation while tools are running
		this.showProcessingIndicator();

		this.scrollToBottom();
	};

	proto.completeToolCallBlock = function (toolCallId: string, success: boolean, result?: {content?: string; detailedContent?: string}, error?: {message: string}): void {
		const entry = this.activeToolCalls.get(toolCallId);
		if (!entry) return;

		const {detailsEl} = entry;

		// Remove spinner, add status icon
		const spinner = detailsEl.querySelector('.sidekick-tool-call-spinner');
		if (spinner) spinner.remove();
		const summaryEl = detailsEl.querySelector('summary');
		if (summaryEl) {
			const statusEl = summaryEl.createSpan({cls: `sidekick-tool-call-status ${success ? 'is-success' : 'is-error'}`});
			setIcon(statusEl, success ? 'check' : 'x');
		}

		// Output section
		const output = error ? `Error: ${error.message}` : (result?.detailedContent || result?.content || '');
		if (output) {
			const outputSection = detailsEl.createDiv({cls: 'sidekick-tool-call-section'});
			outputSection.createDiv({cls: 'sidekick-tool-call-label', text: success ? 'Output' : 'Error'});
			const pre = outputSection.createEl('pre', {cls: 'sidekick-tool-call-code'});
			const maxLen = 5000;
			const displayText = output.length > maxLen ? output.slice(0, maxLen) + '\n… (truncated)' : output;
			pre.createEl('code', {text: displayText});
		}

		this.activeToolCalls.delete(toolCallId);
		this.scrollToBottom();
	};

	proto.renderWelcome = function (): void {
		const welcome = this.chatContainer.createDiv({cls: 'sidekick-welcome'});
		const icon = welcome.createDiv({cls: 'sidekick-welcome-icon'});
		setIcon(icon, 'brain');
		welcome.createEl('h3', {text: 'Sidekick'});
		welcome.createEl('p', {
			text: 'Your AI-powered second brain. Select an agent, choose a model, configure tools and get the job done!',
			cls: 'sidekick-welcome-desc',
		});
	};

	proto.updateSendButton = function (): void {
		this.sendBtn.empty();
		if (this.isStreaming) {
			setIcon(this.sendBtn, 'square');
			this.sendBtn.title = 'Stop';
			this.sendBtn.addClass('is-streaming');
		} else {
			setIcon(this.sendBtn, 'arrow-up');
			this.sendBtn.title = 'Send message';
			this.sendBtn.removeClass('is-streaming');
		}
	};
}

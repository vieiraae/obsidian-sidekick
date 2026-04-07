import {normalizePath, TFile, TFolder} from 'obsidian';
import type {App} from 'obsidian';
import type {MCPServerConfig, ModelInfo, MessageOptions} from '../copilot';
import type {AgentConfig, McpServerEntry, ChatAttachment} from '../types';

/**
 * Map MCP server entries to MCPServerConfig objects, filtering by enabled set.
 */
export function mapMcpServers(mcpServers: McpServerEntry[], enabledMcpServers: Set<string>): Record<string, MCPServerConfig> {
	const result: Record<string, MCPServerConfig> = {};
	for (const server of mcpServers) {
		if (!enabledMcpServers.has(server.name)) continue;
		const cfg = server.config;
		const serverType = cfg['type'] as string | undefined;
		const tools = (cfg['tools'] as string[] | undefined) ?? ['*'];

		if (serverType === 'http' || serverType === 'sse') {
			result[server.name] = {
				type: serverType,
				url: cfg['url'] as string,
				tools,
				...(cfg['headers'] ? {headers: cfg['headers'] as Record<string, string>} : {}),
				...(cfg['timeout'] != null ? {timeout: cfg['timeout'] as number} : {}),
			} as MCPServerConfig;
		} else if (cfg['command']) {
			result[server.name] = {
				type: 'local',
				command: cfg['command'] as string,
				args: (cfg['args'] as string[] | undefined) ?? [],
				tools,
				...(cfg['env'] ? {env: cfg['env'] as Record<string, string>} : {}),
				...(cfg['cwd'] ? {cwd: cfg['cwd'] as string} : {}),
				...(cfg['timeout'] != null ? {timeout: cfg['timeout'] as number} : {}),
			} as MCPServerConfig;
		}
	}
	return result;
}

/**
 * Resolve a model ID from an agent's preferred model name / partial match.
 * Returns the matching model ID, or `fallback` if no match is found.
 */
export function resolveModelForAgent(agent: AgentConfig | undefined, models: ModelInfo[], fallback: string | undefined): string | undefined {
	if (!agent?.model) return fallback;
	const target = agent.model.toLowerCase();
	let match = models.find(
		m => m.name.toLowerCase() === target || m.id.toLowerCase() === target
	);
	if (!match) {
		match = models.find(
			m => m.id.toLowerCase().includes(target) || m.name.toLowerCase().includes(target)
		);
	}
	return match ? match.id : fallback;
}

/**
 * Build the user prompt, inlining clipboard content, selection text, and cursor position.
 */
export function buildPrompt(
	basePrompt: string,
	attachments: ChatAttachment[],
	cursorPosition: {filePath: string; fileName: string; line: number; ch: number} | null,
	activeSelection: {filePath: string; text: string} | null,
): string {
	let prompt = basePrompt;
	const clipboards = attachments.filter(a => a.type === 'clipboard');
	for (const clip of clipboards) {
		if (clip.content) {
			prompt += `\n\n---\nClipboard content:\n${clip.content}`;
		}
	}
	// Inline selection text in the prompt because the Copilot CLI server's
	// session.send handler normalises all attachments to {type, path, displayName},
	// stripping the selection-specific fields (filePath, text, selection range).
	const selections = attachments.filter(a => a.type === 'selection');
	for (const sel of selections) {
		if (sel.content) {
			const range = sel.selection
				? sel.selection.startLine === sel.selection.endLine
					? `line ${sel.selection.startLine}`
					: `lines ${sel.selection.startLine}-${sel.selection.endLine}`
				: '';
			const header = sel.path
				? `Selected text from ${sel.path}${range ? ` (${range})` : ''}`
				: 'Selected text';
			prompt += `\n\n---\n${header}:\n${sel.content}`;
		}
	}
	// Include cursor position so the model knows where the user's cursor is
	if (cursorPosition && !activeSelection) {
		prompt += `\n\n---\nCurrent cursor position: ${cursorPosition.filePath}, line ${cursorPosition.line}, column ${cursorPosition.ch}`;
	}
	return prompt;
}

/**
 * Build SDK-compatible attachments array from ChatAttachment items and scope paths.
 */
export function buildSdkAttachments(params: {
	attachments: ChatAttachment[];
	scopePaths: string[];
	vaultBasePath: string;
	app: App;
}): MessageOptions['attachments'] {
	const {attachments, scopePaths, vaultBasePath, app} = params;
	const result: NonNullable<MessageOptions['attachments']> = [];

	for (const att of attachments) {
		if ((att.type === 'file' || att.type === 'image') && att.path) {
			const filePath = att.absolutePath ? att.path : vaultBasePath + '/' + normalizePath(att.path);
			result.push({
				type: 'file',
				path: filePath,
				displayName: att.name,
			});
		} else if (att.type === 'blob' && att.data && att.mimeType) {
			result.push({
				type: 'blob',
				data: att.data,
				mimeType: att.mimeType,
				displayName: att.name,
			});
		} else if (att.type === 'selection' && att.path) {
			// Workaround: send as 'file' instead of 'selection' because the Copilot CLI
			// server's session.send handler maps all attachments to {type, path, displayName},
			// reading .path (not .filePath) and dropping text/selection fields.
			// The selection text is inlined in the prompt by buildPrompt().
			const resolvedPath = att.absolutePath ? att.path : vaultBasePath + '/' + normalizePath(att.path);
			result.push({
				type: 'file',
				path: resolvedPath,
				displayName: att.name,
			});
		} else if (att.type === 'directory' && att.path) {
			const dirPath = att.absolutePath ? att.path : vaultBasePath + '/' + normalizePath(att.path);
			result.push({
				type: 'directory',
				path: dirPath,
				displayName: att.name,
			});
		}
	}

	// Add vault scope paths (skip children if a parent folder is selected)
	const scopeSorted = [...scopePaths].sort((a, b) => a.length - b.length);
	const includedFolders: string[] = [];

	for (const scopePath of scopeSorted) {
		// Skip if an ancestor folder is already included
		const normalized = normalizePath(scopePath);
		const isChild = includedFolders.some(parent =>
			parent === '/' || normalized.startsWith(parent + '/')
		);
		if (isChild) continue;

		const absPath = scopePath === '/'
			? vaultBasePath
			: vaultBasePath + '/' + normalized;
		const displayName = scopePath === '/' ? app.vault.getName() : scopePath;
		const abstract = scopePath === '/'
			? app.vault.getRoot()
			: app.vault.getAbstractFileByPath(scopePath);

		if (abstract instanceof TFolder) {
			result.push({type: 'directory', path: absPath, displayName});
			includedFolders.push(normalized);
		} else if (abstract instanceof TFile) {
			result.push({type: 'file', path: absPath, displayName});
		}
	}

	return result.length > 0 ? result : undefined;
}

/** Parsed agent configuration from *.agent.md frontmatter + body. */
export interface AgentConfig {
	name: string;
	description: string;
	model?: string;
	tools?: string;
	instructions: string;
	filePath: string;
}

/** Parsed skill information from a skill folder's SKILL.md. */
export interface SkillInfo {
	name: string;
	description: string;
	/** Vault-relative path to the skill folder. */
	folderPath: string;
}

/** A single MCP server entry parsed from mcp.json. */
export interface McpServerEntry {
	name: string;
	config: Record<string, unknown>;
}

/** A message in the Sidekick chat conversation. */
export interface ChatMessage {
	id: string;
	role: 'user' | 'assistant' | 'info';
	content: string;
	timestamp: number;
	attachments?: ChatAttachment[];
}

/** An attachment added to a chat message. */
export interface ChatAttachment {
	type: 'file' | 'directory' | 'clipboard' | 'image';
	name: string;
	/** Vault-relative path (for files, directories, images) or absolute OS path when `absolutePath` is true. */
	path?: string;
	/** Raw text content (for clipboard). */
	content?: string;
	/** When true, `path` is an absolute OS path (not vault-relative). */
	absolutePath?: boolean;
}

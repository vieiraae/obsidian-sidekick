/** Parsed agent configuration from *.agent.md frontmatter + body. */
export interface AgentConfig {
	name: string;
	description: string;
	model?: string;
	/** List of MCP tool server names to enable. Empty/undefined = all. */
	tools?: string[];
	/** List of skill names to enable. Empty/undefined = all. */
	skills?: string[];
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

/** An input variable definition from the mcp.json "inputs" array. */
export interface McpInputVariable {
	type: string;
	id: string;
	description: string;
	password?: boolean;
}

/** A message in the Sidekick chat conversation. */
export interface ChatMessage {
	id: string;
	role: 'user' | 'assistant' | 'info';
	content: string;
	timestamp: number;
	attachments?: ChatAttachment[];
}

/** Parsed prompt template from *.prompt.md. */
export interface PromptConfig {
	name: string;
	/** Agent to auto-select when this prompt is used. */
	agent?: string;
	/** Short description shown in the prompt picker dropdown. */
	description?: string;
	/** Content to prepend to the user's message. */
	content: string;
}

/** An attachment added to a chat message. */
export interface ChatAttachment {
	type: 'file' | 'directory' | 'clipboard' | 'image' | 'selection' | 'blob';
	name: string;
	/** Vault-relative path (for files, directories, images, selections) or absolute OS path when `absolutePath` is true. */
	path?: string;
	/** Raw text content (for clipboard or selection). */
	content?: string;
	/** When true, `path` is an absolute OS path (not vault-relative). */
	absolutePath?: boolean;
	/** Base64-encoded binary data (for blob attachments). */
	data?: string;
	/** MIME type of the binary data (for blob attachments). */
	mimeType?: string;
	/** Selection range (1-based line numbers). */
	selection?: {
		startLine: number;
		startChar: number;
		endLine: number;
		endChar: number;
	};
}

/** Selection info passed when "Chat with sidekick" is invoked on selected text. */
export interface SelectionInfo {
	filePath?: string;
	fileName: string;
	startLine: number;
	startChar: number;
	endLine: number;
	endChar: number;
}

/** Parsed trigger configuration from *.trigger.md. */
export interface TriggerConfig {
	name: string;
	description?: string;
	agent?: string;
	/** Whether the trigger is active. Defaults to true when not set. */
	enabled: boolean;
	/** Cron expression for scheduled triggers (5-field: min hour dom month dow). */
	cron?: string;
	/** Glob pattern for file-change triggers. */
	glob?: string;
	/** Prompt content to send when the trigger fires. */
	content: string;
	/** Vault-relative path to the trigger file. */
	filePath: string;
}

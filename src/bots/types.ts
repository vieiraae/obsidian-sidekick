/** Shared types for bot integrations. */

/** Status of a bot connection. */
export type BotConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

/** Base configuration shared by all bot types. */
export interface BotConfig {
	/** The default agent to use for incoming bot messages. */
	defaultAgent: string;
}

/** Telegram-specific configuration. */
export interface TelegramBotConfig extends BotConfig {
	/** Telegram Bot ID (numeric). */
	botId: string;
	/** Telegram Bot token (stored securely). */
	botToken: string;
}

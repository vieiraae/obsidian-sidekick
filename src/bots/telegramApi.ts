/**
 * Minimal Telegram Bot API client.
 *
 * Uses only the subset of the Telegram Bot API needed by Sidekick:
 * - getMe (validate token)
 * - getUpdates (long-polling)
 * - sendMessage
 * - sendChatAction
 * - getFile + file download
 *
 * Reference: https://core.telegram.org/bots/api
 */

const TELEGRAM_API = 'https://api.telegram.org';

/** Telegram User object (subset). */
export interface TelegramUser {
	id: number;
	is_bot: boolean;
	first_name: string;
	last_name?: string;
	username?: string;
}

/** Telegram Chat object (subset). */
export interface TelegramChat {
	id: number;
	type: 'private' | 'group' | 'supergroup' | 'channel';
	title?: string;
	first_name?: string;
	last_name?: string;
	username?: string;
	is_forum?: boolean;
}

/** Telegram PhotoSize object. */
export interface TelegramPhotoSize {
	file_id: string;
	file_unique_id: string;
	width: number;
	height: number;
	file_size?: number;
}

/** Telegram Document object. */
export interface TelegramDocument {
	file_id: string;
	file_unique_id: string;
	file_name?: string;
	mime_type?: string;
	file_size?: number;
}

/** Telegram Audio object. */
export interface TelegramAudio {
	file_id: string;
	file_unique_id: string;
	file_name?: string;
	mime_type?: string;
	file_size?: number;
	duration: number;
}

/** Telegram Voice object. */
export interface TelegramVoice {
	file_id: string;
	file_unique_id: string;
	duration: number;
	mime_type?: string;
	file_size?: number;
}

/** Telegram Video object. */
export interface TelegramVideo {
	file_id: string;
	file_unique_id: string;
	width: number;
	height: number;
	duration: number;
	file_name?: string;
	mime_type?: string;
	file_size?: number;
}

/** Telegram Message object (subset of fields we use). */
export interface TelegramMessage {
	message_id: number;
	from?: TelegramUser;
	chat: TelegramChat;
	date: number;
	message_thread_id?: number;
	text?: string;
	caption?: string;
	photo?: TelegramPhotoSize[];
	document?: TelegramDocument;
	audio?: TelegramAudio;
	voice?: TelegramVoice;
	video?: TelegramVideo;
	reply_to_message?: TelegramMessage;
	is_topic_message?: boolean;
}

/** Telegram Update object. */
export interface TelegramUpdate {
	update_id: number;
	message?: TelegramMessage;
	edited_message?: TelegramMessage;
}

/** Telegram File object returned by getFile. */
export interface TelegramFile {
	file_id: string;
	file_unique_id: string;
	file_size?: number;
	file_path?: string;
}

/** Result wrapper for Telegram API responses. */
interface TelegramApiResponse<T> {
	ok: boolean;
	result?: T;
	description?: string;
	error_code?: number;
}

export class TelegramApiError extends Error {
	constructor(public status: number, public description: string) {
		super(`Telegram API error ${status}: ${description}`);
		this.name = 'TelegramApiError';
	}
}

/**
 * Low-level Telegram Bot API client.
 */
export class TelegramApi {
	private readonly baseUrl: string;

	constructor(private readonly token: string) {
		this.baseUrl = `${TELEGRAM_API}/bot${token}`;
	}

	/** Call a Telegram Bot API method. */
	private async call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
		const url = `${this.baseUrl}/${method}`;
		const resp = await fetch(url, {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: params ? JSON.stringify(params) : undefined,
		});
		const data = (await resp.json()) as TelegramApiResponse<T>;
		if (!data.ok) {
			throw new TelegramApiError(data.error_code ?? resp.status, data.description ?? 'Unknown error');
		}
		return data.result as T;
	}

	/** Validate the bot token and return bot info. */
	async getMe(): Promise<TelegramUser> {
		return this.call<TelegramUser>('getMe');
	}

	/**
	 * Long-poll for updates.
	 * @param offset - Update ID offset (exclusive lower bound).
	 * @param timeout - Long-poll timeout in seconds (default 30).
	 */
	async getUpdates(offset?: number, timeout = 30): Promise<TelegramUpdate[]> {
		return this.call<TelegramUpdate[]>('getUpdates', {
			offset,
			timeout,
			allowed_updates: ['message', 'edited_message'],
		});
	}

	/** Send a text message. Supports Markdown formatting. */
	async sendMessage(params: {
		chat_id: number;
		text: string;
		message_thread_id?: number;
		parse_mode?: 'MarkdownV2' | 'HTML';
		reply_to_message_id?: number;
		disable_web_page_preview?: boolean;
	}): Promise<TelegramMessage> {
		return this.call<TelegramMessage>('sendMessage', params);
	}

	/** Send a chat action (e.g. "typing"). */
	async sendChatAction(params: {
		chat_id: number;
		action: string;
		message_thread_id?: number;
	}): Promise<boolean> {
		return this.call<boolean>('sendChatAction', params);
	}

	/** Get file info for downloading. */
	async getFile(fileId: string): Promise<TelegramFile> {
		return this.call<TelegramFile>('getFile', {file_id: fileId});
	}

	/** Download a file by its file_path (from getFile). Returns the file as an ArrayBuffer. */
	async downloadFile(filePath: string): Promise<ArrayBuffer> {
		const url = `${TELEGRAM_API}/file/bot${this.token}/${filePath}`;
		const resp = await fetch(url);
		if (!resp.ok) {
			throw new TelegramApiError(resp.status, `Failed to download file: ${resp.statusText}`);
		}
		return resp.arrayBuffer();
	}
}

import type {TriggerConfig} from './types';
import {debugTrace} from './debug';

/**
 * Minimal 5-field cron expression matcher.
 * Fields: minute hour day-of-month month day-of-week
 * Supports: *, numbers, ranges 1-5, lists 1,3,5, steps star/5, 1-10/2
 */
function matchCronField(field: string, value: number, max: number): boolean {
	for (const part of field.split(',')) {
		const stepMatch = part.match(/^(.+)\/(\d+)$/);
		if (stepMatch) {
			const range = stepMatch[1]!;
			const step = parseInt(stepMatch[2]!, 10);
			let start = 0;
			let end = max;
			if (range !== '*') {
				const rangeParts = range.split('-');
				start = parseInt(rangeParts[0]!, 10);
				end = rangeParts.length > 1 ? parseInt(rangeParts[1]!, 10) : max;
			}
			for (let i = start; i <= end; i += step) {
				if (i === value) return true;
			}
		} else if (part === '*') {
			return true;
		} else if (part.includes('-')) {
			const parts = part.split('-');
			const low = parseInt(parts[0]!, 10);
			const high = parseInt(parts[1]!, 10);
			if (value >= low && value <= high) return true;
		} else {
			if (parseInt(part, 10) === value) return true;
		}
	}
	return false;
}

/** Check if a 5-field cron expression matches the given Date. */
export function cronMatches(cron: string, date: Date): boolean {
	const parts = cron.trim().split(/\s+/);
	if (parts.length !== 5) return false;
	const minute = parts[0]!;
	const hour = parts[1]!;
	const dayOfMonth = parts[2]!;
	const month = parts[3]!;
	const dayOfWeek = parts[4]!;

	return (
		matchCronField(minute, date.getMinutes(), 59) &&
		matchCronField(hour, date.getHours(), 23) &&
		matchCronField(dayOfMonth, date.getDate(), 31) &&
		matchCronField(month, date.getMonth() + 1, 12) &&
		matchCronField(dayOfWeek, date.getDay(), 6)
	);
}

/**
 * Convert a simple glob pattern to a RegExp.
 * Supports **, *, ?, and literal characters.
 * Rejects overly long patterns to prevent ReDoS.
 */
export function globToRegex(glob: string): RegExp {
	if (glob.length > 500) {
		throw new Error(`Glob pattern too long (${glob.length} chars, max 500)`);
	}
	let regex = '';
	let i = 0;
	while (i < glob.length) {
		const c = glob[i]!;
		if (c === '*') {
			if (glob[i + 1] === '*') {
				if (glob[i + 2] === '/') {
					regex += '(?:.*/)?';
					i += 3;
				} else {
					regex += '.*';
					i += 2;
				}
			} else {
				regex += '[^/]*';
				i++;
			}
		} else if (c === '?') {
			regex += '[^/]';
			i++;
		} else if ('.+^${}()|[]\\'.includes(c)) {
			regex += '\\' + c;
			i++;
		} else {
			regex += c;
			i++;
		}
	}
	return new RegExp('^' + regex + '$', 'i');
}

/** Context passed when a trigger fires. */
export interface TriggerFireContext {
	/** Vault-relative path of the file that changed (for onFileChange triggers). */
	filePath?: string;
}

/** Callbacks for the trigger scheduler. */
export interface TriggerSchedulerCallbacks {
	onTriggerFire: (trigger: TriggerConfig, context?: TriggerFireContext) => void;
	getLastFired: (key: string) => number;
	setLastFired: (key: string, timestamp: number) => void;
}

/**
 * Manages cron-based and file-change-based trigger firing.
 * Cron triggers are checked every 60 seconds via a polling interval.
 * File change triggers are checked on-demand when a vault file event occurs.
 */
export class TriggerScheduler {
	private triggers: TriggerConfig[] = [];
	private callbacks: TriggerSchedulerCallbacks;
	private intervalId: number | null = null;
	/** Cached compiled glob regexes, keyed by glob pattern. Invalidated on setTriggers(). */
	private globCache = new Map<string, RegExp>();

	constructor(callbacks: TriggerSchedulerCallbacks) {
		this.callbacks = callbacks;
	}

	/** Update the list of active triggers (call after config reload). */
	setTriggers(triggers: TriggerConfig[]): void {
		this.triggers = triggers.filter(t => t.enabled);
		this.globCache.clear();
	}

	/** Get or compile a glob regex, caching the result. */
	private getGlobRegex(glob: string): RegExp {
		let re = this.globCache.get(glob);
		if (!re) {
			re = globToRegex(glob);
			this.globCache.set(glob, re);
		}
		return re;
	}

	/**
	 * Start the 60-second polling loop for scheduler triggers.
	 * Returns the setInterval ID for use with registerInterval().
	 */
	start(): number {
		this.intervalId = window.setInterval(() => this.checkScheduledTriggers(), 60_000);
		// Run an initial check after a short delay to catch triggers due now
		window.setTimeout(() => this.checkScheduledTriggers(), 5_000);
		return this.intervalId;
	}

	/** Stop the polling loop. */
	stop(): void {
		if (this.intervalId !== null) {
			window.clearInterval(this.intervalId);
			this.intervalId = null;
		}
	}

	/** Poll all cron triggers and fire any that match the current minute. */
	private checkScheduledTriggers(): void {
		const now = new Date();
		const minuteKey = Math.floor(now.getTime() / 60_000) * 60_000;

		for (const trigger of this.triggers) {
			for (const entry of trigger.triggers) {
				if (entry.type === 'scheduler' && entry.cron) {
					if (cronMatches(entry.cron, now)) {
						const lastFired = this.callbacks.getLastFired(trigger.name);
						if (lastFired < minuteKey) {
							this.callbacks.setLastFired(trigger.name, minuteKey);
							this.callbacks.onTriggerFire(trigger);
						}
					}
				}
			}
		}
	}

	/**
	 * Check if a file event matches any onFileChange triggers.
	 * Uses a 5-second per-trigger cooldown to debounce rapid changes.
	 */
	checkFileChangeTriggers(filePath: string): void {
		const now = Date.now();
		if (this.triggers.length === 0) {
			debugTrace('Sidekick: checkFileChangeTriggers — no triggers loaded');
			return;
		}
		debugTrace(`Sidekick: checkFileChangeTriggers("${filePath}") — ${this.triggers.length} trigger(s)`);
		for (const trigger of this.triggers) {
			for (const entry of trigger.triggers) {
				if (entry.type === 'onFileChange' && entry.glob) {
					const regex = this.getGlobRegex(entry.glob);
					const matches = regex.test(filePath);
					debugTrace(`Sidekick: trigger "${trigger.name}" glob="${entry.glob}" regex=${regex} match=${matches}`);
					if (matches) {
						const key = `file:${trigger.name}`;
						const lastFired = this.callbacks.getLastFired(key);
						const elapsed = now - lastFired;
						if (elapsed > 5_000) {
							this.callbacks.setLastFired(key, now);
							this.callbacks.onTriggerFire(trigger, {filePath});
						} else {
							debugTrace(`Sidekick: trigger "${trigger.name}" skipped — cooldown (${Math.round(elapsed / 1000)}s / 5s)`);
						}
						break; // Don't fire same trigger twice for same event
					}
				}
			}
		}
	}
}

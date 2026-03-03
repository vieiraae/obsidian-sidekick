/**
 * Centralised debug logging gate.
 * Only emits console.log / console.debug output when enabled.
 * console.warn / console.error are NOT gated — they always print.
 */

let _enabled = false;

/** Enable or disable debug logging globally. */
export function setDebugEnabled(enabled: boolean): void {
	_enabled = enabled;
}

/** Log a debug-level trace (only when debug mode is on). */
export function debugTrace(...args: unknown[]): void {
	if (_enabled) console.debug(...args);
}

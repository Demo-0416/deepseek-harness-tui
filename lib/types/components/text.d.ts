/**
 * Terminal text sanitization shared across the pi-tui front door. External text
 * (model output, tool results, clipboard) is escaped or stripped of C0/C1
 * controls before the TUI adds its own application-owned ANSI.
 * @module @deepseek-ai/dsh-tui/components/text
 */
/** Bracketed-paste start marker emitted by terminals around pasted content. */
export declare const BRACKETED_PASTE_START = "\u001B[200~";
/** Bracketed-paste end marker emitted by terminals around pasted content. */
export declare const BRACKETED_PASTE_END = "\u001B[201~";
/**
 * Escape external C0/C1 controls before pi-tui adds application-owned ANSI.
 * Line feeds remain structural so transcript and tool output retain their layout.
 * @param text - Untrusted text to render.
 * @returns The text with control characters escaped as `\xNN`.
 */
export declare function displayText(text: string): string;
/**
 * Escape external controls for terminal fields that must remain on one line.
 * @param text - Untrusted text to render inline.
 * @returns The escaped text with newlines rendered as `\x0a`.
 */
export declare function displayInlineText(text: string): string;
/**
 * Remove terminal controls from clipboard text before an editable field stores it.
 * @param text - Raw pasted clipboard text.
 * @returns The text stripped of OSC, CSI, escape, and control sequences.
 */
export declare function sanitizePastedText(text: string): string;

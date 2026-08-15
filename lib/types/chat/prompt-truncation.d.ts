/**
 * The one length rule a submitted prompt has to obey before it becomes a turn.
 *
 * pi-tui's paste marker already keeps the editor's line buffer small — a large
 * paste lives in the editor's private map and shows as `[paste #1 30000 chars]`
 * — but `Editor.submitValue()` expands every marker before it calls `onSubmit`,
 * so what reaches this terminal is the full text with no ceiling at all. A
 * pasted file therefore used to travel verbatim into `agent.followup()`, into
 * the session log, and into the request body, where the provider answers with a
 * context-length error the user cannot connect to anything they did.
 *
 * The cut is deliberately lossy and deliberately exact: the result is exactly
 * `limit` characters, which makes the function idempotent (re-submitting a
 * truncated prompt from history changes nothing) and makes the guarantee
 * statable — "no turn this terminal sends is longer than `limit`".
 * @see A `!`-prefixed bash line, if this terminal ever grows one, must not come
 * through here: a shell command cut in the middle is a different command, so
 * that branch would have to leave before the length rule runs.
 * @module @deepseek-ai/dsh-tui/chat/prompt-truncation
 */
/**
 * Characters a submitted prompt may carry before its middle is dropped.
 *
 * Claude Code's own input ceiling (`PromptInput/inputPaste.ts:4`), kept as the
 * default so the two terminals refuse the same paste.
 */
export declare const DEFAULT_MAX_PROMPT_CHARS = 10000;
/** What one length check decided about one prompt. */
export interface TruncatedPrompt {
    /** The text to submit. Identical to the input when nothing was dropped. */
    text: string;
    /** Characters the prompt had before the cut. */
    original: number;
    /** Characters dropped from the middle; `0` when the prompt was inside the budget. */
    removed: number;
}
/**
 * Hold a prompt to its character budget, dropping the middle if it is over.
 *
 * `limit <= 0` disables the rule entirely, which is what a deployment that
 * trusts its own provider configures.
 *
 * The marker is paid for out of the budget rather than added on top, so the
 * result is exactly `limit` characters (minus at most one per edge, when the cut
 * would have split a surrogate pair). That is what makes a second call a no-op:
 * a prompt recalled from history and submitted again is already inside the
 * budget, so it is neither cut twice nor announced twice.
 * @param text - the prompt as submitted, with paste markers already expanded.
 * @param limit - the character budget; `0` or less disables truncation.
 * @returns the text to send, with what it cost.
 */
export declare function truncatePrompt(text: string, limit: number): TruncatedPrompt;

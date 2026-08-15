/**
 * The prompts this user has typed, kept past the process that took them.
 *
 * pi-tui's editor history lives and dies with the editor, so every new terminal
 * used to open on an empty Up arrow and an empty Ctrl+R — the one thing a shell
 * has done for forty years. This module is the file behind it:
 * `$DSH_HOME/history.jsonl`, one JSON object per line, appended by every
 * submission and read back at mount.
 *
 * Three rules the read side owes the write side, all of them ported from Claude
 * Code's `src/history.ts`:
 *
 * - Newest first, and this session's own prompts before any other session's
 *   (`history.ts:190-217`), because the prompt a user reaches for first is
 *   almost always the one they just typed.
 * - Entries are filtered by working directory (`entry.project` there, `cwd`
 *   here): a prompt about another repository is noise in this one.
 * - A line that will not parse is skipped rather than fatal
 *   (`history.ts:131-134`). A history file is not worth a failed mount, and a
 *   torn line costs exactly one prompt.
 *
 * Long prompts do not sit in the jsonl: past 1024 characters the body moves to
 * a content-addressed file under `history-cache/`, which is upstream's
 * `pasteStore` trick (`utils/pasteStore.ts`) and keeps the line-reverse scan
 * cheap. A body that has been swept leaves its entry unreadable, and an
 * unreadable entry is dropped whole — never rendered from the preview, because
 * quietly putting a truncated prompt back in someone's editor is worse than
 * losing it.
 * @module @deepseek-ai/dsh-tui/chat/prompt-history
 */
/** File under the harness home this history is kept in. */
export declare const PROMPT_HISTORY_FILE_NAME = "history.jsonl";
/** Directory beside it holding the externalized bodies. */
export declare const PROMPT_HISTORY_BODY_DIR = "history-cache";
/** Truthy stops writes and only writes; reads keep working. Upstream's `CLAUDE_CODE_SKIP_PROMPT_HISTORY`. */
export declare const SKIP_PROMPT_HISTORY_ENV = "DSH_SKIP_PROMPT_HISTORY";
/**
 * Longest the exit path waits for a queued history write.
 *
 * A prompt is worth a moment on the way out and no more: a disk that is not
 * answering must not be what keeps a terminal on screen after goodbye.
 */
export declare const PROMPT_HISTORY_FLUSH_TIMEOUT_MS = 1000;
/**
 * One line of `$DSH_HOME/history.jsonl`.
 *
 * Unknown fields are ignored rather than refused, which is what lets a later
 * version add `pastes`/`mode` without this one dropping every entry it wrote.
 * A line missing one of the four required fields is treated as corrupt.
 */
export interface PromptHistoryRecord {
    /** The submitted prompt; when `bodyHash` is set this is a 200-character preview and not the content. */
    display: string;
    /** `Date.now()` at the moment it was written. */
    timestamp: number;
    /** The workspace it was typed in; reads filter on it. */
    cwd: string;
    /** The session that submitted it; reads sort this session's own entries first. */
    sessionId: string;
    /** Content hash (sha256, first 16 hex) when the body lives in `history-cache/<hash>.txt`. */
    bodyHash?: string;
    /** Character length of the externalized body, for a human reading the file. */
    bodyLength?: number;
    /** Reserved for the input mode a bash-prefixed line would carry. Never written today; ignored when read. */
    mode?: string;
}
/** How one prompt history is opened. */
export interface PromptHistoryOptions {
    /** The workspace; reads keep only entries whose `cwd` is exactly this. */
    readonly cwd: string;
    /** This session's id; its entries come back before any other session's. */
    readonly sessionId: string;
    /** Failure report, one finished sentence. The caller logs it; nothing reaches the screen. */
    readonly reportError?: (message: string) => void;
    /** Override the path under `$DSH_HOME`; tests only. */
    readonly path?: string;
    /** Override the tail window; tests only. */
    readonly windowBytes?: number;
}
/** A read/write handle on one cross-session prompt history. */
export interface PromptHistoryStore {
    /** Absolute path of the history file, for diagnostics. */
    readonly path: string;
    /**
     * Read the history back: newest first, this session first, deduplicated by text.
     *
     * Never throws — an IO or parse failure returns whatever was read before it.
     * @param limit - most entries to return; defaults to 100.
     * @returns the prompts, newest first.
     */
    load(limit?: number): string[];
    /**
     * Record one prompt. Fire-and-forget, serialized in-process, never throws.
     * @param text - the submitted prompt.
     */
    append(text: string): void;
    /**
     * Wait for every queued write to land; called on the way out.
     * @returns a promise that settles when the queue is empty.
     */
    flush(): Promise<void>;
}
/**
 * Compact one history file: keep the newest entries, drop the bodies nothing
 * references any more.
 *
 * Held under the writer lock, because this is the one operation that rewrites
 * the file rather than appending to it. Plain appends stay lock-free on
 * purpose — see the module's own note on why a stuck lock must not be able to
 * block every future prompt.
 * @param path - the history file.
 * @param options - how many entries to keep and how old an orphan body must be.
 * @returns the number of entries kept, or `undefined` when nothing was compacted.
 */
export declare function compactPromptHistory(path: string, options?: {
    readonly keep?: number;
    readonly bodyTtlMs?: number;
}): Promise<number | undefined>;
/**
 * Open `$DSH_HOME/history.jsonl` (or `options.path`). Never throws.
 * @param options - workspace, session, and the test overrides.
 * @returns the handle the editor's history is seeded from and appended to.
 */
export declare function openPromptHistory(options: PromptHistoryOptions): PromptHistoryStore;

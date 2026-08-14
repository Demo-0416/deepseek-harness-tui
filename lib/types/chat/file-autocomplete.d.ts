/**
 * Host-workspace discovery for TUI `@file` completion. The index contains
 * paths only: selected values remain ordinary prompt text and file contents
 * stay behind the model-facing `read` tool.
 *
 * @module @deepseek-ai/dsh-tui/chat/file-autocomplete
 */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
/** Default maximum file and directory candidates rendered for one query. */
export declare const DEFAULT_FILE_SEARCH_MAX_RESULTS = 20;
/** Default maximum entries retained in one workspace search index. */
export declare const DEFAULT_FILE_SEARCH_MAX_ENTRIES = 10000;
/**
 * Directory basenames omitted from traversal unless the deployment overrides them.
 *
 * This walker only runs when the host has no `fd` (see `./fd.ts`), so it has to
 * approximate by name what `fd` would have read out of `.gitignore`. The list
 * is build and dependency output — the directories a repository ignores
 * whatever its language is — and not a taste list: excluding a directory here
 * makes it unreachable through `@`, so anything a user might plausibly want to
 * mention (`.github`, `docs`, `vendor` in a repo that checks it in) stays.
 */
export declare const DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES: readonly [".git", "node_modules", "dist", "build", "out", "coverage", ".cache", ".next", ".nuxt", ".turbo", ".venv", "__pycache__", "target"];
/** Resolved limits and exclusions for one TUI workspace index. */
export interface FileSearchConfig {
    /** Maximum ranked candidates returned for one query. */
    maxResults: number;
    /** Maximum indexed files and directories. */
    maxEntries: number;
    /** Directory basenames never traversed or offered. */
    excludedDirectories: readonly string[];
}
/** One path-only completion candidate inside the session cwd. */
export interface FileSearchCandidate {
    /** User-facing path accepted by the normal prompt and filesystem tools. */
    path: string;
    /** Directories keep completion open; files finish the mention. */
    kind: 'file' | 'directory';
}
/** Active `@` token ending at the editor cursor. */
export interface ActiveAtToken {
    /** Complete token replaced when the user accepts a completion. */
    prefix: string;
    /** Path query after `@` or `@"`. */
    query: string;
    /** Whether the user opened a quoted path. */
    quoted: boolean;
}
/**
 * Extract an `@path` or `@"path with spaces` token at the cursor. An `@`
 * inside another token, such as an email address, is not a completion trigger.
 * @param line - current editor line.
 * @param cursorCol - cursor column within that line.
 * @returns the active token, or `undefined` outside an `@` token.
 */
export declare function activeAtToken(line: string, cursorCol: number): ActiveAtToken | undefined;
/**
 * Format a selected path as prompt text. Whitespace uses Pi's quoted
 * `@"path"` grammar; directories retain a trailing slash so completion can
 * descend another level.
 * @param candidate - selected file or directory.
 * @param preserveQuote - retain an explicitly opened quote even when unnecessary.
 * @returns the insertion value, or `undefined` for a path the editor grammar cannot represent safely.
 */
export declare function formatFileMention(candidate: FileSearchCandidate, preserveQuote: boolean): string | undefined;
/**
 * Whether a completed tool call could have changed the workspace tree, and the
 * `@` index therefore has to be discarded.
 *
 * Invalidating on every tool result threw away a full traversal (up to
 * `maxEntries` paths) after a `grep`, a `web_search`, or a `todo_write` — none
 * of which can move a file — and rebuilt it on the next `@`, which is precisely
 * the interaction the index exists to keep fast.
 *
 * The classification is the tool's own declared render intent, never a name
 * list: a profile mounts tools this bundle has never heard of, and a tool's
 * `presentCall` is a pure function of its arguments, so it can be asked without
 * running anything. A diff card is a file mutation; a terminal card is a shell
 * whose side effects are unknowable, so it counts as one. Anything this cannot
 * classify — no presenter, unparsable arguments, a presenter that threw, a
 * generic card with no `kind` — is assumed to have written, because a stale
 * completion list is a wrong answer while a redundant rescan is only slow.
 * @param definition - the registered tool, when the runtime still has it.
 * @param rawArguments - the call's arguments exactly as the model produced them.
 * @returns true when the index must be rebuilt before the next bare query.
 */
export declare function toolCallTouchesFiles(definition: ToolDefinition | undefined, rawArguments: string): boolean;
/**
 * Cancellable, reusable fuzzy index rooted at one agent working directory.
 * Directory-scoped queries list live state; bare fuzzy queries share one
 * bounded traversal until the `@` interaction ends or a tool result invalidates it.
 */
export declare class WorkspaceFileSearch {
    private readonly root;
    private readonly config;
    private readonly excludedDirectories;
    private generation;
    private disposed;
    constructor(root: string, config: FileSearchConfig);
    /**
     * Return ranked path candidates for the current token.
     * @param rawQuery - path text following `@` or `@"`.
     * @param signal - cancels this caller's wait without killing an index shared by a newer query.
     * @returns at most `maxResults` deterministic candidates.
     */
    list(rawQuery: string, signal: AbortSignal): Promise<FileSearchCandidate[]>;
    /** Discard the current index so the next bare query observes a fresh tree. */
    invalidate(): void;
    /** Abort traversal and make later queries return no candidates. */
    dispose(): void;
    private ensureIndex;
    private scanWorkspace;
    private listDirectory;
}

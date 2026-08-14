/**
 * Read/search collapse: the classification and grouping behind the transcript's
 * one-row summary of a run of read-only calls (`Searched for 3 patterns, read
 * 2 files`), ported from Claude Code's `utils/collapseReadSearch.ts`.
 *
 * Everything here is a pure function of the folded node list — no clock, no
 * `process`, no service lookup — for the same reason `foldEvent` is: a resumed
 * log and a live stream have to produce the same rows. It is a *derivation*
 * over the fold's output rather than a step inside it, because group membership
 * is retroactive: the call that breaks a group arrives after the group's own
 * nodes are folded, and the calls a group absorbs keep arriving while it runs.
 * Rewriting the node array to hold an aggregate node would therefore have to
 * delete and re-key nodes as events land, and the node array's indices are
 * anchors elsewhere (the `/clear` cut, the process-local rows the reconciler
 * interleaves by node count). The upstream does exactly the same thing:
 * `collapseReadSearchGroups(messages, tools)` runs at render time over the
 * message list, not at message-construction time.
 *
 * The renderer asks {@link collapseToolGroups} for the group plan and looks up
 * each node index in it; `collapsedSummary`, in the transcript component, words
 * the row. The wording lives there rather than here because it is the only
 * locale-dependent part of collapse: this module stays a pure derivation over
 * the node list, with no message table behind it, exactly like the rest of
 * `src/core`.
 * @module dsh-tui/core/collapse
 */
import type { ChatNode } from './types.ts';
/**
 * Cap on a `⎿` hint, in characters (~5 rows of ~60 columns). Generous and
 * static, exactly as upstream: the renderer wraps what fits.
 */
export declare const MAX_HINT_CHARS = 300;
/** One kind of read-only operation a collapsed group counts. */
export type CollapseKind = 'search' | 'read' | 'list' | 'mcp';
/** The last operation in a group, as the `⎿` row wants to show it. */
export interface CollapseHint {
    /** A file path (shown relative to the workspace), a pattern, or a command. */
    readonly kind: 'path' | 'pattern' | 'command';
    readonly value: string;
}
/** One tool call's read-only classification, or `undefined` when it writes. */
export interface CollapseClassification {
    readonly kind: CollapseKind;
    /** The MCP server this call went to, when `kind` is `mcp`. */
    readonly server?: string;
    /** File path this call read, when it names one. */
    readonly path?: string;
    /** What the `⎿` row shows for this call. */
    readonly hint?: CollapseHint;
}
/** One run of consecutive read-only calls, as the collapsed row reports it. */
export interface CollapsedGroup {
    /**
     * Node index of the **last** member: where the summary row renders.
     *
     * The last rather than the first, because a group carries non-breaking nodes
     * over itself (a notice, a process-local row anchored mid-run) and those
     * render at their own index. A row at the first member's index therefore
     * printed `Read 2 files` *above* the notice that arrived between the two
     * reads, claiming both files before the second one happened. At the last
     * member's index the summary can never precede content it already counts.
     */
    readonly index: number;
    /** Node keys of every member, in log order (the expanded phase's cards). */
    readonly keys: readonly string[];
    /** Search operations, counted per call. */
    readonly searchCount: number;
    /**
     * Files read: distinct `file_path`s, plus one per read that named no path of
     * its own (a `cat` inside a shell command). The same file read twice through
     * `read` counts once; a shell read counts as one more, because nothing here
     * knows which file it opened. Over- rather than under-reporting is the
     * deliberate direction — the previous rule dropped path-less reads entirely
     * whenever any call named a path, so `read(a)` + `cat b` + `read(c)` said
     * "Read 2 files" about three.
     */
    readonly readCount: number;
    /** Directory listings, counted per call. */
    readonly listCount: number;
    /** MCP queries, counted per call. */
    readonly mcpCallCount: number;
    /** Distinct MCP servers queried, in first-seen order. */
    readonly mcpServers: readonly string[];
    /** Whether any member call is still running: the row is present-tense. */
    readonly active: boolean;
    /** Whether any member call failed. */
    readonly failed: boolean;
    /** The most recent operation, for the `⎿` row under a running group. */
    readonly hint?: CollapseHint;
}
/**
 * Classify a shell command as search, read, or listing.
 *
 * Every non-neutral segment of a pipeline has to be one of the three: `cat
 * file | jq .` is a read, and `cat file > out` is not a read at all — it is a
 * write, so the whole command is disqualified. A redirect is judged by where it
 * points rather than skipped: `< in` only names an input, `2>&1` and `2>` to
 * {@link NULL_DEVICE} throw bytes away, and everything else creates or
 * truncates a file the user would want to see reported. Skipping the target
 * instead — which is what this did — folded a real file write into the
 * transcript's `Read 1 file` row, with no card and no command text behind it.
 *
 * The same reasoning disqualifies a command that runs another one out of this
 * classifier's sight ({@link COMMAND_SUBSTITUTION}) or writes through an
 * argument instead of a redirect ({@link writesThroughArguments}): the leading
 * word says `cat`, and the line still deletes a tree or truncates a file.
 *
 * A command of nothing but neutral words (`echo hi`) is not collapsible either
 * — it read nothing.
 * @param command - The raw command line.
 * @returns Which of the three kinds the command performs, all false when none.
 */
export declare function classifyShellCommand(command: string): {
    isSearch: boolean;
    isRead: boolean;
    isList: boolean;
};
/**
 * Classify one tool call as a read-only operation.
 *
 * The tool set is this harness's own: `read`/`read_image` read, `grep`/`glob`
 * search, `str_replace_editor` reads only under its `view` command, and
 * `bash`/`pwsh` are whatever their command line says they are. Everything else
 * — edits, writes, web calls, task tools — is not collapsible and breaks the
 * group it lands in.
 * @param name - The tool's registered name.
 * @param args - The call's parsed arguments.
 * @returns The classification, or `undefined` when the call is not read-only.
 */
export declare function classifyToolCall(name: string, args: unknown): CollapseClassification | undefined;
/** Options narrowing which nodes {@link collapseToolGroups} may absorb. */
export interface CollapseOptions {
    /** First node index to consider; earlier nodes are off the transcript. */
    readonly from?: number;
    /** Reports a call the transcript is not rendering (a `/clear`ed step's). */
    readonly isHidden?: (callId: string) => boolean;
}
/**
 * Plan the collapsed groups over a folded node list.
 *
 * A run of one is not a run: a lone `read` keeps its card, because the summary
 * row it would become names no file, no pattern and no command (the `⎿` hint
 * only shows while the group is running), and "Read 1 file" is strictly less
 * than the `Read(src/a.ts)` card it replaced. The row earns its place from two
 * members up, which is where it starts saving rows instead of spending them.
 *
 * @param nodes - The snapshot's nodes, in log order.
 * @param options - Range and per-call exclusions.
 * @returns A map from node index to the group that index belongs to. Every
 *   member index maps to the same object, whose `index` names the last member —
 *   the one whose place the summary row takes. Indices of a single-member run
 *   are absent, so the caller renders their card.
 */
export declare function collapseToolGroups(nodes: readonly ChatNode[], options?: CollapseOptions): Map<number, CollapsedGroup>;
/**
 * Render a group's `⎿` hint: the file's workspace-relative path, the quoted
 * pattern, or the `$ `-prefixed command, capped at {@link MAX_HINT_CHARS}.
 * @param hint - The group's latest operation.
 * @param displayPath - Shortens an absolute path for display.
 * @returns The hint row's text.
 */
export declare function formatCollapseHint(hint: CollapseHint, displayPath: (path: string) => string): string;

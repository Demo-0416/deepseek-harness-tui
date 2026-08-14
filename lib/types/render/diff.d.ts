/**
 * Claude Code's inline diff renderer, ported from pi-claude-code-ui: a
 * `structuredPatch`-based parse, word-level intra-line highlighting, and two
 * layouts — a unified view, and a side-by-side split that only engages on a wide
 * enough terminal.
 *
 * Three deliberate departures from the upstream source:
 *
 * - The palette is the fixed Claude default (`_claudeStyleDefaults`), not a
 *   preset/settings system. A diff's meaning lives in its own greens and reds,
 *   so these are 24-bit constants rather than theme roles.
 * - Rendering is synchronous and returns rows rather than one joined string, so
 *   a pi-tui component can render inside its own `render(width)` pass. Syntax
 *   highlighting is therefore a *pre-warmed* input: {@link warmHighlightCache}
 *   is awaited off the render path and {@link shikiHighlighter} reads its cache.
 * - shiki is an optional peer: {@link warmHighlightCache} imports `@shikijs/cli`
 *   dynamically and falls back to plain, unhighlighted text when it is absent.
 *   The package is deliberately NOT a dependency.
 *
 * Every row a renderer emits owns its whole terminal line (it ends with a full
 * SGR reset), which is what lets background fills run to the right margin.
 * @module @deepseek-ai/dsh-tui/render/diff
 */
/** Split view engages only at this width or above; below it a diff renders unified. */
export declare const SPLIT_MIN_WIDTH = 150;
/** One row of a parsed diff. `sep` is a collapsed-context marker, not file content. */
export interface DiffLine {
    type: 'add' | 'del' | 'ctx' | 'sep';
    /** 1-based line number on the old side, or `null` when the row has none. */
    oldNum: number | null;
    /** 1-based line number on the new side; for a `sep` row, the skipped line count. */
    newNum: number | null;
    content: string;
}
/** A parsed diff: its rows and exact change totals. */
export interface ParsedDiff {
    lines: DiffLine[];
    added: number;
    removed: number;
    /** Combined input size, used to decide whether highlighting is affordable. */
    chars: number;
}
/**
 * Highlight `code` for `language`, one entry per line. Returns `undefined` to
 * render plain — the shape a missing highlighter, an unknown language, or an
 * oversized block all take.
 */
export type DiffHighlighter = (code: string, language: string | undefined) => readonly string[] | undefined;
/** Rendering budgets and inputs shared by both layouts. */
export interface DiffRenderOptions {
    /** Rows rendered before the body is clipped. */
    readonly maxLines?: number;
    /** Language id for highlighting (a shiki id such as `typescript`). */
    readonly language?: string;
    /** Pre-warmed highlighter; omit to render plain text. */
    readonly highlight?: DiffHighlighter;
    /** Trailing hint on the clip marker. */
    readonly toggleHint?: string;
}
/**
 * The add/remove proportion bar shown beside a change summary.
 * @param added - Added row count.
 * @param removed - Removed row count.
 * @param width - Available width; below 20 columns the bar is dropped.
 * @returns The bar, or `''` when there is nothing to show.
 */
export declare function renderDiffStatBar(added: number, removed: number, width?: number): string;
/**
 * A one-line change summary: `+A -R` followed by the proportion bar.
 * @param added - Added row count.
 * @param removed - Removed row count.
 * @param width - Available width, passed to {@link renderDiffStatBar}.
 * @returns The summary text.
 */
export declare function summarizeDiff(added: number, removed: number, width?: number): string;
/**
 * A change summary with hunk count and layout mode appended.
 * @param added - Added row count.
 * @param removed - Removed row count.
 * @param hunks - Hunk count; omitted from the summary when zero.
 * @param mode - Layout label (`unified`, `split`), or `''` to omit.
 * @param width - Available width, passed to {@link summarizeDiff}.
 * @returns The summary text.
 */
export declare function diffSummaryWithMeta(added: number, removed: number, hunks: number, mode: string, width?: number): string;
/**
 * The clip marker under a truncated diff, degrading through shorter phrasings
 * until one fits the available width.
 * @param remainingLines - Rows the render dropped.
 * @param hiddenHunks - Hunks the render dropped entirely.
 * @param width - Available width.
 * @param toggleHint - Key hint appended to the longest phrasing.
 * @returns The marker text, always within `width`.
 */
export declare function collapsedDiffHint(remainingLines: number, hiddenHunks: number, width?: number, toggleHint?: string): string;
/**
 * Whether a diff should render side-by-side at this width: wide enough for two
 * readable code columns, and few enough long rows that the split would not
 * degenerate into wrapped fragments.
 * @param diff - The parsed diff.
 * @param width - Available width.
 * @param maxRows - Row budget the caller will render.
 * @returns `true` when the split layout applies.
 */
export declare function shouldUseSplit(diff: ParsedDiff, width: number, maxRows?: number): boolean;
/**
 * The syntax-highlighting language for a file path.
 * @param path - The file path.
 * @returns A shiki language id, or `undefined` when the extension maps to none.
 */
export declare function diffLanguage(path: string): string | undefined;
/** Default shiki theme; only consulted when `@shikijs/cli` is installed. */
export declare const DEFAULT_SHIKI_THEME = "github-dark";
/** Clear the highlight cache (a theme change invalidates every entry). */
export declare function clearHighlightCache(): void;
/**
 * Highlight a block off the render path and cache the result, so a later
 * synchronous render can pick it up through {@link shikiHighlighter}.
 *
 * `@shikijs/cli` is an OPTIONAL dependency: the import is dynamic and every
 * failure path (package absent, unknown language, oversized block, a throw
 * inside shiki) resolves to the plain lines instead.
 * @param code - The block to highlight.
 * @param language - Shiki language id; `undefined` renders plain.
 * @param theme - Shiki theme name.
 * @returns One entry per line of `code`.
 */
export declare function warmHighlightCache(code: string, language: string | undefined, theme?: string): Promise<readonly string[]>;
/**
 * A synchronous highlighter reading {@link warmHighlightCache}'s results.
 * @param theme - Shiki theme the cache was warmed with.
 * @returns A highlighter that returns `undefined` for anything not warmed yet.
 */
export declare function shikiHighlighter(theme?: string): DiffHighlighter;
/**
 * Parse two file versions into diff rows with `contextLines` of context, with a
 * `sep` row standing in for each collapsed gap between hunks.
 * @param oldContent - The prior file text.
 * @param newContent - The new file text.
 * @param contextLines - Context rows kept around each change.
 * @returns The parsed diff and its exact totals.
 */
export declare function parseDiff(oldContent: string, newContent: string, contextLines?: number): ParsedDiff;
/**
 * {@link parseDiff} under an edit-distance budget: a comparison that would need
 * more than `maxEditLength` changed lines declines rather than stalling the UI
 * on a model-authored pending edit.
 * @param oldContent - The prior file text.
 * @param newContent - The new file text.
 * @param maxEditLength - Changed-line budget for the comparison.
 * @param contextLines - Context rows kept around each change.
 * @returns The parsed diff, or `undefined` when the comparison exceeded the budget.
 */
export declare function parseDiffBounded(oldContent: string, newContent: string, maxEditLength: number, contextLines?: number): ParsedDiff | undefined;
/**
 * Word-level comparison of a changed line pair: how similar the two sides are,
 * and the character ranges that actually differ on each side.
 * @param oldText - The removed line.
 * @param newText - The added line.
 * @returns Similarity in [0, 1] and the differing ranges per side.
 */
export declare function wordDiffAnalysis(oldText: string, newText: string): {
    similarity: number;
    oldRanges: Array<[number, number]>;
    newRanges: Array<[number, number]>;
};
/**
 * Render a diff as a unified view: one column, each changed row carrying its
 * sign, its gutter number, and a full-width background fill, with word-level
 * highlighting on a one-for-one changed pair.
 * @param diff - The parsed diff.
 * @param width - Available width in columns.
 * @param options - Budgets, language, and highlighter.
 * @returns The rendered rows.
 */
export declare function renderUnified(diff: ParsedDiff, width: number, options?: DiffRenderOptions): string[];
/**
 * Render a diff side by side, old on the left and new on the right. Falls back
 * to {@link renderUnified} whenever the width or the row shapes make the split
 * unreadable ({@link shouldUseSplit}), so a caller can always ask for it.
 * @param diff - The parsed diff.
 * @param width - Available width in columns; below {@link SPLIT_MIN_WIDTH} this delegates.
 * @param options - Budgets, language, and highlighter.
 * @returns The rendered rows.
 */
export declare function renderSplit(diff: ParsedDiff, width: number, options?: DiffRenderOptions): string[];
/**
 * Render a diff in whichever layout the width supports: split at
 * {@link SPLIT_MIN_WIDTH} columns and above, unified below it.
 * @param diff - The parsed diff.
 * @param width - Available width in columns.
 * @param options - Budgets, language, and highlighter.
 * @returns The rendered rows.
 */
export declare function renderDiff(diff: ParsedDiff, width: number, options?: DiffRenderOptions): string[];

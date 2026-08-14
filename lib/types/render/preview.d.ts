/**
 * Collapsed output previews, ported from pi-claude-code-ui: the "first N lines
 * plus a `+N more lines` marker" body a tool card shows while collapsed.
 *
 * The upstream version read its budgets from a settings file; here every budget
 * is a parameter default, so a preview is a pure function of its inputs. Only
 * the lines that will actually be displayed are styled — the upstream comment is
 * worth keeping: mapping a color over the whole output array first made the cost
 * scale with total tool output even when eight rows were shown.
 * @module @deepseek-ai/dsh-tui/render/preview
 */
/** Style one line of previewed output; the default is the recessed status tone. */
export type LineStyler = (line: string) => string;
/** Budgets and styling for {@link buildPreviewText}. */
export interface PreviewOptions {
    /** Whether the card is expanded; an expanded card uses {@link PreviewOptions.expandedLines}. */
    readonly expanded?: boolean;
    /** Rows shown while collapsed. */
    readonly previewLines?: number;
    /** Row cap while expanded; beyond it the body is still clipped and says so. */
    readonly expandedLines?: number;
    /** Total rows the output has, when `lines` is already a window into it. */
    readonly totalLineCount?: number;
    /** Styles each displayed body row. */
    readonly styleLine?: LineStyler;
    /** Trailing hint appended to the `more lines` marker (e.g. `ctrl+o to toggle`). */
    readonly toggleHint?: string;
}
/**
 * Build a collapsed preview body: the leading rows, then a `... (N more lines)`
 * marker, then an expanded-cap warning when even the expanded view clipped.
 * @param lines - The output rows available to display.
 * @param options - Budgets and styling.
 * @returns The preview text, newline-separated; `(no output)` when there is nothing.
 */
export declare function buildPreviewText(lines: readonly string[], options?: PreviewOptions): string;

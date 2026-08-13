/**
 * Collapsed output previews, ported from pi-claude-code-ui: the "first N lines
 * plus a `+N more lines` marker" body a tool card shows while collapsed, and the
 * tail-window variant a running command streams into.
 *
 * The upstream version read its budgets from a settings file; here every budget
 * is a parameter default, so a preview is a pure function of its inputs. Only
 * the lines that will actually be displayed are styled — the upstream comment is
 * worth keeping: mapping a color over the whole output array first made the cost
 * scale with total tool output even when eight rows were shown.
 * @module @deepseek-ai/dsh-tui/render/preview
 */

import { withBranch } from './branch.ts'
import { CLAUDE_COLORS, fg } from './palette.ts'

/** Style one line of previewed output; the default is the recessed status tone. */
export type LineStyler = (line: string) => string

/** The default recessed tone for preview chrome and unstyled body rows. */
function muted(text: string): string {
  return fg(CLAUDE_COLORS.inactive, text)
}

/** Budgets and styling for {@link buildPreviewText}. */
export interface PreviewOptions {
  /** Whether the card is expanded; an expanded card uses {@link PreviewOptions.expandedLines}. */
  readonly expanded?: boolean
  /** Rows shown while collapsed. */
  readonly previewLines?: number
  /** Row cap while expanded; beyond it the body is still clipped and says so. */
  readonly expandedLines?: number
  /** Total rows the output has, when `lines` is already a window into it. */
  readonly totalLineCount?: number
  /** Styles each displayed body row. */
  readonly styleLine?: LineStyler
  /** Trailing hint appended to the `more lines` marker (e.g. `ctrl+o to toggle`). */
  readonly toggleHint?: string
}

/** Pluralized `N lines` label. */
export function lineCountLabel(count: number): string {
  return `${count} line${count === 1 ? '' : 's'}`
}

/**
 * Build a collapsed preview body: the leading rows, then a `... (N more lines)`
 * marker, then an expanded-cap warning when even the expanded view clipped.
 * @param lines - The output rows available to display.
 * @param options - Budgets and styling.
 * @returns The preview text, newline-separated; `(no output)` when there is nothing.
 */
export function buildPreviewText(lines: readonly string[], options: PreviewOptions = {}): string {
  const {
    expanded = false,
    previewLines = 8,
    expandedLines = 4000,
    totalLineCount = lines.length,
    styleLine,
    toggleHint = 'ctrl+o to toggle',
  } = options
  if (lines.length === 0 && totalLineCount === 0) return muted('(no output)')
  const maxLines = expanded ? expandedLines : previewLines
  const limit = Math.min(lines.length, maxLines)
  let text = ''
  for (let index = 0; index < limit; index += 1) {
    const raw = lines[index] ?? ''
    const line = styleLine ? styleLine(raw) : raw
    text += index === 0 ? line : `\n${line}`
  }
  const remaining = Math.max(0, totalLineCount - limit)
  if (remaining > 0) {
    const hint = toggleHint === '' ? '' : ` • ${toggleHint}`
    text += `${text === '' ? '' : '\n'}${muted(`... (${remaining} more lines${hint})`)}`
  }
  if (expanded && totalLineCount > maxLines) {
    text += `\n${fg(CLAUDE_COLORS.warning, `(display capped at ${maxLines} lines)`)}`
  }
  return text
}

/**
 * Split text into its non-blank lines, optionally keeping only the last
 * `tailLimit` of them. Single-pass and window-bounded, so streaming output does
 * not retain every line it ever produced.
 * @param text - Raw output text.
 * @param tailLimit - Rows to retain from the end; omit to retain all of them.
 * @returns The retained rows and the total non-blank row count.
 */
export function collectNonEmptyLines(
  text: string,
  tailLimit?: number,
): { lines: string[]; total: number } {
  const keepTail = tailLimit !== undefined && Number.isFinite(tailLimit)
  const limit = keepTail ? Math.max(0, Math.floor(tailLimit)) : 0
  const lines: string[] = []
  let total = 0
  let start = 0
  while (start <= text.length) {
    const newline = text.indexOf('\n', start)
    const end = newline === -1 ? text.length : newline
    const line = text.slice(start, end)
    if (line.trim().length > 0) {
      total += 1
      if (!keepTail) {
        lines.push(line)
      } else if (limit > 0) {
        if (lines.length === limit) lines.shift()
        lines.push(line)
      }
    }
    if (newline === -1) break
    start = newline + 1
  }
  return { lines, total }
}

/** Budgets and styling for {@link runningPreviewBlock}. */
export interface RunningPreviewOptions extends PreviewOptions {
  /** Preview the output's tail rather than its head; the shape a live command uses. */
  readonly tail?: boolean
  /** Rows shown while the call is still running. */
  readonly liveLines?: number
}

/**
 * The live output preview under a running tool card: a branch block holding the
 * last few non-blank rows, prefixed with an `earlier lines` count when the tail
 * window dropped rows.
 * @param text - Raw output collected so far.
 * @param options - Budgets and styling; `tail` defaults to on.
 * @returns A branch block ready for `renderBranchBlock`, or `''` when there is no output yet.
 */
export function runningPreviewBlock(text: string, options: RunningPreviewOptions = {}): string {
  const { expanded = false, tail = true, liveLines = 5, styleLine, toggleHint } = options
  if (liveLines <= 0) return ''
  const normalized = text.replaceAll('\r\n', '\n').trimEnd()
  const collected = collectNonEmptyLines(normalized, expanded ? undefined : liveLines)
  if (collected.total === 0) return ''
  const window = tail && !expanded && collected.lines.length > liveLines
    ? collected.lines.slice(-liveLines)
    : collected.lines
  // For a tail preview the `earlier lines` prefix owns the remaining count, so
  // the body is told its own length and does not also append a `more lines` row.
  const previewTotal = tail && !expanded ? window.length : collected.total
  let preview = buildPreviewText(window, {
    expanded,
    previewLines: liveLines,
    totalLineCount: previewTotal,
    styleLine: styleLine ?? (line => fg(CLAUDE_COLORS.inactive, line === '' ? ' ' : line)),
    ...toggleHint === undefined ? {} : { toggleHint },
  })
  if (tail && !expanded && collected.total > window.length) {
    preview = `${muted(`... (${collected.total - window.length} earlier lines)`)}\n${preview}`
  }
  return withBranch(preview)
}

/**
 * `/jobs` panel: the background work this session can still see, as the job
 * registry reports it.
 *
 * The rows are one `list()` result — kind, label, lifecycle state, whatever
 * detail the producer supplied, and how long the job has been running or how
 * long it ran. The registry is in this process, so the listing is synchronous:
 * unlike the skills catalog or the subagent directory, this panel has no
 * loading line and no read that can fail. What it does have is a clock — a
 * live row's elapsed time has to move while nothing else on screen does — so
 * the time is a function the caller ticks, never a value baked into a row.
 *
 * The keyboard is `ScrollablePanel`'s, not the filterable panels': a job list
 * is short by construction (the registry drops nothing while a session lives,
 * but a session does not start hundreds of them), and the reason to open it is
 * to see everything at once.
 * @module @deepseek-ai/dsh-tui/components/jobs-panel
 */

import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
} from '@earendil-works/pi-tui'
import type { JobRow, JobStatus } from '../chat/jobs.ts'
import { jobCounts, jobElapsed } from '../chat/jobs.ts'
import { displayInlineText } from './text.ts'
import type { Palette } from './theme.ts'
import { formatTurnDuration } from './transcript.ts'
import { plural, t } from '../i18n/index.ts'

/** The panel's heading, so the command and its view name the same thing. */
export const JOBS_PANEL_TITLE = '/jobs'

/**
 * Reported when no job registry serves this session: the panel is not opened at
 * all, because a profile without the registry has no background work to show.
 *
 * These are the English text of the message keys the panel renders, not a
 * second source of it — every rendering site looks its key up per frame, so
 * `/lang` moves the screen while the constants stay for the tests that quote
 * the shipped English wording.
 */
export const JOBS_UNAVAILABLE = t('jobs.unavailable', undefined, 'en')

/** Shown when the registry answers with no jobs at all. */
export const JOBS_EMPTY = t('jobs.empty', undefined, 'en')

/** Terminal rows the list state spends on its own chrome: blank, title, count, footer. */
const LIST_CHROME_ROWS = 4

/** Terminal rows a one-message state spends: blank, title, footer. */
const MESSAGE_CHROME_ROWS = 3

/**
 * The glyph each lifecycle state wears.
 *
 * A job's terminal state IS an outcome — it finished, it was killed, it broke —
 * so unlike the subagent tree's store-state dots these rows use the check and
 * the cross the rest of the transcript paints results with. `stopping` keeps a
 * live glyph of its own: the kill has been asked for and the producer has not
 * let go yet, which is neither running nor over.
 */
const JOB_GLYPHS: Readonly<Record<JobStatus, string>> = {
  running: '●',
  stopping: '◐',
  completed: '✔',
  killed: '◼',
  failed: '✗',
}

/** The painted glyph of one row. */
function statusMark(row: JobRow, palette: Palette): string {
  const glyph = JOB_GLYPHS[row.status]
  switch (row.status) {
    case 'running': return palette.accent(glyph)
    case 'stopping': return palette.warning(glyph)
    case 'completed': return palette.success(glyph)
    // Killed is a request that was honoured, not a failure: it shares the tone
    // a cancelled workflow run wears for the same reason.
    case 'killed': return palette.warning(glyph)
    case 'failed': return palette.error(glyph)
  }
}

/**
 * The state a row states, plus the producer's own detail when there is one.
 *
 * The detail never replaces the status word: `exit code: 3` says how a job
 * ended only to a reader who already knows it ended, and the two together are
 * one short clause.
 * @param row - one job.
 * @returns the status fragment.
 */
function secondaryText(row: JobRow): string {
  const status = t(`jobs.status.${row.status}`)
  return row.detail === undefined || row.detail === ''
    ? status
    : `${status} · ${displayInlineText(row.detail)}`
}

/**
 * The list's rows for one width.
 *
 * Exported for the same reason the panel is rendered directly in its tests: the
 * layout — the kind column, the label column, the state and the clock — is the
 * whole point of the view, and it is worth asserting without a terminal.
 * @param rows - the jobs to draw, already in the order they are read in.
 * @param palette - active role palette.
 * @param width - the content width the rows are laid out for.
 * @param now - current time in epoch ms, for the live rows' clocks.
 * @returns one line per job, truncated to `width`.
 */
export function renderJobRows(
  rows: readonly JobRow[],
  palette: Palette,
  width: number,
  now: number,
): string[] {
  // Two columns sized to their own content, so the states line up whatever the
  // longest command is: the kind is a short producer name, the label can be a
  // whole shell command and is capped at half the panel.
  const kinds = rows.map(row => displayInlineText(row.kind))
  const labels = rows.map(row => displayInlineText(row.label))
  const kindColumn = Math.max(1, ...kinds.map(visibleWidth))
  const labelColumn = Math.min(
    Math.max(1, ...labels.map(visibleWidth)),
    Math.max(8, Math.floor(width / 2)),
  )
  return rows.map((row, index) => {
    const kind = kinds[index] ?? ''
    const label = truncateToWidth(labels[index] ?? '', labelColumn, '…', true)
    const kindPad = ' '.repeat(Math.max(0, kindColumn - visibleWidth(kind)))
    const labelPad = ' '.repeat(Math.max(0, labelColumn - visibleWidth(label)))
    return truncateToWidth(
      `${statusMark(row, palette)} ${palette.dim(kind)}${kindPad}  ${palette.text(label)}${labelPad}  `
      + `${palette.dim(secondaryText(row))}  ${palette.dim(formatTurnDuration(jobElapsed(row, now)))}`,
      width,
      '',
    )
  })
}

/**
 * The background job list in the editor slot, filled by the caller.
 *
 * Keyboard-owned like {@link ./panel.ts | ScrollablePanel}. The caller owns the
 * registry, its change subscription, and the clock that moves the live rows;
 * the panel only shows what it is handed ({@link setJobs}).
 */
export class JobsPanel implements Component, Focusable {
  /** Set by the TUI on focus; this panel paints no cursor of its own. */
  focused = false
  /** First visible list row. */
  private offset = 0

  /**
   * @param jobs - the visible set, in the order it is read in.
   * @param rows - the panel's total row budget, read per render so a resize applies.
   * @param palette - active role palette.
   * @param now - the caller's clock, read per frame so live rows tick.
   * @param onClose - called on Esc or Ctrl+C; the caller closes the overlay.
   */
  constructor(
    private jobs: readonly JobRow[],
    private readonly rows: () => number,
    private readonly palette: Palette,
    private readonly now: () => number,
    private readonly onClose: () => void,
  ) {}

  invalidate(): void {
    // Rows are derived per render from (jobs, width, clock, locale), so there is
    // no cached wrap to drop; the method exists because the component contract
    // has it, and because the elapsed tick calls it to force the next frame.
  }

  /**
   * Replace the list with the visible set the registry now reports.
   * @param jobs - the new visible set, in the order it is read in.
   */
  setJobs(jobs: readonly JobRow[]): void {
    this.jobs = jobs
    this.invalidate()
  }

  /** Visible list rows, once the leading blank, title, count, and footer are paid for. */
  private viewport(): number {
    return Math.max(1, this.rows() - LIST_CHROME_ROWS)
  }

  private scrollBy(delta: number): void {
    // Clamped against the last rendered list in `render`, which runs after every
    // keystroke; a scroll past either end simply stops there.
    this.offset = Math.max(0, this.offset + delta)
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c'))) {
      this.onClose()
      return
    }
    if (matchesKey(data, Key.up)) this.scrollBy(-1)
    else if (matchesKey(data, Key.down)) this.scrollBy(1)
    else if (matchesKey(data, Key.pageUp)) this.scrollBy(-this.viewport())
    else if (matchesKey(data, Key.pageDown)) this.scrollBy(this.viewport())
    else if (data === 'g' || matchesKey(data, Key.home)) this.offset = 0
    else if (data === 'G' || matchesKey(data, Key.end)) this.scrollBy(Number.MAX_SAFE_INTEGER)
    // Anything else is deliberately dropped: the panel owns the keyboard while
    // it is open, so no keystroke leaks into the editor underneath it.
  }

  render(width: number): string[] {
    const contentWidth = Math.max(1, width - 2)
    const title = ` ${this.palette.dim(JOBS_PANEL_TITLE)}`
    if (this.jobs.length === 0) {
      const viewport = Math.max(1, this.rows() - MESSAGE_CHROME_ROWS)
      return [
        '',
        title,
        ...wrapTextWithAnsi(this.palette.dim(t('jobs.empty')), contentWidth)
          .slice(0, viewport)
          .map(line => ` ${line}`),
        ` ${this.palette.dim(t('panel.escClose'))}`,
      ]
    }
    const counts = jobCounts(this.jobs)
    const count = plural(counts.total, 'jobs.count', { ...counts })
    const rows = renderJobRows(this.jobs, this.palette, contentWidth, this.now())
    const viewport = this.viewport()
    // Re-clamped every frame: a resize, or a change that returned a shorter
    // list, must not leave the view past its own end.
    this.offset = Math.max(0, Math.min(this.offset, Math.max(0, rows.length - viewport)))
    const shown = rows.slice(this.offset, this.offset + viewport)
    const position = rows.length > viewport
      ? `  ·  ${t('panel.position', {
        first: this.offset + 1,
        last: this.offset + shown.length,
        total: rows.length,
      })}`
      : ''
    return [
      '',
      title,
      ` ${truncateToWidth(this.palette.dim(count), contentWidth, '')}`,
      ...shown.map(line => ` ${line}`),
      // The scrolling panel's own footer: this view answers the same keys, so
      // it says so in the same words rather than in a second copy of them.
      ` ${truncateToWidth(this.palette.dim(`${t('panel.hint')}${position}`), contentWidth, '')}`,
    ]
  }
}

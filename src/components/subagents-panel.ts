/**
 * `/subagents` panel: the delegation tree below this session, as the durable
 * subagent directory reports it.
 *
 * The rows are one `listDescendants()` result — label, one-shot or continuable,
 * live or only in persistence, and the child session id `/resume` takes. The
 * listing is asynchronous and can fail, so the panel owns both states itself
 * (see {@link ./skills-panel.ts | SkillsPanel}): it opens on its loading line
 * and is filled as answers land, rather than making the user close a panel to
 * read a notice about it.
 *
 * The keyboard is `ScrollablePanel`'s, not the filterable panels': a delegation
 * tree is read as a shape, and a filter that dropped a parent row would leave
 * its children hanging under nothing. Every keystroke is still consumed here.
 * @module @deepseek-ai/dsh-tui/components/subagents-panel
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
import type { SubagentDescendant } from '../chat/subagents.ts'
import { subagentCounts, subagentName } from '../chat/subagents.ts'
import { displayInlineText } from './text.ts'
import type { Palette } from './theme.ts'
import { plural, t } from '../i18n/index.ts'

/** The panel's heading, so the command and its view name the same thing. */
export const SUBAGENTS_PANEL_TITLE = '/subagents'

/**
 * Reported when no subagent registry serves this session: the panel is not
 * opened at all, because a profile without the registry has no tree to show.
 *
 * These are the English text of the message keys the panel renders, not a
 * second source of it — every rendering site looks its key up per frame, so
 * `/lang` moves the screen while the constants stay for the tests that quote
 * the shipped English wording.
 */
export const SUBAGENTS_UNAVAILABLE = t('subagents.unavailable', undefined, 'en')

/** Shown while the first directory read is in flight; the panel is already up. */
export const SUBAGENTS_LOADING = t('subagents.loading', undefined, 'en')

/** Shown when the registry answers with no children at all. */
export const SUBAGENTS_EMPTY = t('subagents.empty', undefined, 'en')

/** Terminal rows the tree state spends on its own chrome: blank, title, count, footer. */
const TREE_CHROME_ROWS = 4

/** Terminal rows a one-message state spends: blank, title, footer. */
const MESSAGE_CHROME_ROWS = 3

/** Two columns per level of delegation, the depth the directory reports. */
const INDENT_WIDTH = 2

/**
 * The status mark of one row.
 *
 * A live child and a settled one are the only two states the directory reports,
 * and neither is an outcome, so the marks stay a filled and a hollow dot rather
 * than borrowing the check-and-cross vocabulary results are painted in.
 * @param entry - one listing row.
 * @param palette - active role palette.
 * @returns the painted one-character mark.
 */
function statusMark(entry: SubagentDescendant, palette: Palette): string {
  if (entry.kind === 'diagnostic') return palette.error('!')
  return entry.activity === 'running' ? palette.accent('●') : palette.dim('○')
}

/** The mode and activity words a child row carries, or a diagnostic's reason. */
function secondaryText(entry: SubagentDescendant): string {
  if (entry.kind === 'diagnostic') return t(`subagents.diagnostic.${entry.reason}`)
  const mode = entry.mode === 'one-shot'
    ? t('subagents.mode.oneShot')
    : t('subagents.mode.continuable')
  return `${mode} · ${t(`subagents.activity.${entry.activity}`)}`
}

/**
 * The tree's rows for one width.
 *
 * Exported for the same reason the panel is rendered directly in its tests: the
 * layout — indentation by depth, the name column, the trailing session id — is
 * the whole point of the view, and it is worth asserting without a terminal.
 * @param entries - one descendant listing, in the directory's own pre-order.
 * @param palette - active role palette.
 * @param width - the content width the rows are laid out for.
 * @returns one line per entry, truncated to `width`.
 */
export function renderSubagentRows(
  entries: readonly SubagentDescendant[],
  palette: Palette,
  width: number,
): string[] {
  // The name column is sized to the widest indented name, but never past half
  // the panel: one deep branch, or one long delegation description, must not
  // push every mode word off the right edge.
  const names = entries.map(entry => ({
    indent: ' '.repeat(Math.max(0, entry.depth - 1) * INDENT_WIDTH),
    name: displayInlineText(subagentName(entry)),
  }))
  const nameColumn = Math.min(
    Math.max(1, ...names.map(({ indent, name }) => indent.length + visibleWidth(name))),
    Math.max(8, Math.floor(width / 2)),
  )
  return entries.map((entry, index) => {
    const { indent, name } = names[index] ?? { indent: '', name: '' }
    const painted = truncateToWidth(name, Math.max(1, nameColumn - indent.length), '…', true)
    const pad = ' '.repeat(Math.max(0, nameColumn - indent.length - visibleWidth(painted)))
    const secondary = displayInlineText(secondaryText(entry))
    // The id trails the row rather than leading it: it is what `/resume` takes,
    // but it is not how a reader recognizes the branch they are looking for.
    const id = displayInlineText(entry.id)
    return truncateToWidth(
      `${indent}${statusMark(entry, palette)} ${palette.text(painted)}${pad}  `
      + `${palette.dim(secondary)}  ${palette.dim(id)}`,
      width,
      '',
    )
  })
}

/**
 * The delegation tree in the editor slot, filled by the caller.
 *
 * Keyboard-owned like {@link ./panel.ts | ScrollablePanel}. The caller owns the
 * registry, the root session, the abort signal, and the lifecycle events that
 * make a listing stale; the panel only shows what it is handed
 * ({@link setEntries}, {@link setError}).
 */
export class SubagentsPanel implements Component, Focusable {
  /** Set by the TUI on focus; this panel paints no cursor of its own. */
  focused = false
  /** The tree, or `undefined` while the first listing is still in flight. */
  private entries: readonly SubagentDescendant[] | undefined
  /** The last failed listing, cleared by the next one that succeeds. */
  private error: string | undefined
  /** First visible tree row. */
  private offset = 0

  /**
   * @param entries - the tree when it is already known, `undefined` while it loads.
   * @param rows - the panel's total row budget, read per render so a resize applies.
   * @param palette - active role palette.
   * @param onClose - called on Esc or Ctrl+C; the caller closes the overlay.
   */
  constructor(
    entries: readonly SubagentDescendant[] | undefined,
    private readonly rows: () => number,
    private readonly palette: Palette,
    private readonly onClose: () => void,
  ) {
    this.entries = entries
  }

  invalidate(): void {
    // Rows are derived per render from (entries, width, locale), so there is no
    // cached wrap to drop; the method exists because the component contract has
    // it, and because a refresh calls it to force the next frame.
  }

  /**
   * Replace whatever is on screen with a listing that just landed.
   *
   * A successful read also clears a previous failure: the directory answered,
   * so the old error is no longer a fact about this tree.
   * @param entries - the descendant listing, in the directory's own order.
   */
  setEntries(entries: readonly SubagentDescendant[]): void {
    this.entries = entries
    this.error = undefined
    this.invalidate()
  }

  /**
   * Report a listing that failed.
   *
   * A failure after a good read does not throw the tree away — a refresh that
   * loses the network must not blank a panel the reader is using — so the
   * message is shown above rows that are merely older than they look.
   * @param message - the failure, shown verbatim.
   */
  setError(message: string): void {
    this.error = message
    this.invalidate()
  }

  /** Visible tree rows, once the leading blank, title, count, and footer are paid for. */
  private viewport(): number {
    return Math.max(1, this.rows() - TREE_CHROME_ROWS)
  }

  private scrollBy(delta: number): void {
    // Clamped against the last rendered tree in `render`, which runs after every
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

  /** The one-page states: a message and the way out, with no count line above them. */
  private renderMessage(title: string, message: string, width: number): string[] {
    const viewport = Math.max(1, this.rows() - MESSAGE_CHROME_ROWS)
    return [
      '',
      title,
      ...wrapTextWithAnsi(message, width).slice(0, viewport).map(line => ` ${line}`),
      ` ${this.palette.dim(t('panel.escClose'))}`,
    ]
  }

  render(width: number): string[] {
    const contentWidth = Math.max(1, width - 2)
    const title = ` ${this.palette.dim(SUBAGENTS_PANEL_TITLE)}`
    const entries = this.entries
    if (entries === undefined) {
      return this.error === undefined
        // "Not read yet" and "no children" are different facts, so the loading
        // line never borrows the empty tree's sentence.
        ? this.renderMessage(title, this.palette.dim(t('subagents.loading')), contentWidth)
        : this.renderMessage(title, this.palette.error(displayInlineText(this.error)), contentWidth)
    }
    if (entries.length === 0 && this.error === undefined) {
      return this.renderMessage(title, this.palette.dim(t('subagents.empty')), contentWidth)
    }
    const counts = subagentCounts(entries)
    const count = plural(counts.total, 'subagents.count', { ...counts })
    const rows = [
      ...this.error === undefined
        ? []
        : wrapTextWithAnsi(this.palette.error(displayInlineText(this.error)), contentWidth),
      ...renderSubagentRows(entries, this.palette, contentWidth),
    ]
    const viewport = this.viewport()
    // Re-clamped every frame: a resize, or a refresh that returned a shorter
    // tree, must not leave the view past its own end.
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

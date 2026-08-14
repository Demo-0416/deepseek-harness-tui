/**
 * `/search` panel: every message in this session, filtered as you type.
 *
 * An inline terminal prints its transcript into the terminal's own scrollback,
 * where nothing this process runs can scroll it or point at a line inside it.
 * So the search does not jump: it opens a panel over the input frame, lists the
 * messages the query hits with the hit shown in place, and gives one message its
 * whole page on Enter. Esc walks back out the way it came in — the page, then
 * the query, then the panel — which is the ladder every filterable surface here
 * already uses.
 * @module @deepseek-ai/dsh-tui/components/transcript-search
 */

import {
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
} from '@earendil-works/pi-tui'
import {
  highlightSegments,
  searchTranscript,
  type TranscriptEntry,
  type TranscriptEntryRole,
  type TranscriptMatch,
} from '../chat/transcript-search.ts'
import { displayInlineText, displayText } from './text.ts'
import type { Palette } from './theme.ts'
import { plural, t } from '../i18n/index.ts'

/** The panel's heading, so the command and its view name the same thing. */
export const TRANSCRIPT_SEARCH_TITLE = '/search'

/** Shown when the session has produced nothing readable yet, in English, for the docs suite. */
export const TRANSCRIPT_SEARCH_EMPTY = t('search.empty', undefined, 'en')

/** Shown when the query matches nothing; the messages themselves are still there. */
export const TRANSCRIPT_SEARCH_NO_MATCH = t('search.noMatch', undefined, 'en')

/** Terminal rows the panel spends on its own chrome: blank, title, query, count, footer. */
const PANEL_CHROME_ROWS = 5

/** Widest label column a row will give up to the message itself. */
const LABEL_COLUMN_MAX = 14

/**
 * Paint one row label in the role its message reads as.
 * @param role - the entry's origin.
 * @param label - the label text, already escaped.
 * @param palette - active role palette.
 * @returns the painted label.
 */
function paintLabel(role: TranscriptEntryRole, label: string, palette: Palette): string {
  if (role === 'user') return palette.accent(label)
  if (role === 'assistant') return palette.text(label)
  if (role === 'notice') return palette.warning(label)
  return palette.dim(label)
}

/**
 * Paint one line with the query's occurrences standing out.
 *
 * The hits are reverse video rather than a color: the row underneath is already
 * colored by role, and a second color would read as a third meaning.
 * @param text - the line to paint, already escaped for the terminal.
 * @param query - what the user typed, verbatim.
 * @param palette - active role palette.
 * @returns the line with every hit painted.
 */
function paintHits(text: string, query: string, palette: Palette): string {
  return highlightSegments(text, query)
    .map(segment => segment.hit ? palette.selected(segment.text) : segment.text)
    .join('')
}

/**
 * Full-text search over this session's messages, in the editor slot.
 *
 * Keyboard-owned like {@link ./plugins-panel.ts | PluginsPanel}: every keystroke
 * is consumed here — query box, selection, the open message — and none leaks
 * into the editor underneath. The caller closes the overlay through `onClose`.
 */
export class TranscriptSearchPanel implements Component, Focusable {
  /** Set by the TUI on focus; the query box owns the visible cursor. */
  focused = false
  private readonly query = new Input()
  /** Message the selection bar sits on; kept by key so filtering re-finds it. */
  private selectedKey: string | undefined
  /** The message whose whole text fills the panel, or `undefined` in the list. */
  private openKey: string | undefined
  /** First visible list row. */
  private offset = 0
  /** First visible row of the open message. */
  private detailOffset = 0

  /**
   * @param entries - this session's messages, in transcript order.
   * @param initialQuery - the `/search` argument, if the command carried one.
   * @param rows - the panel's total row budget, read per render so a resize applies.
   * @param palette - active role palette.
   * @param onClose - called on Esc (with an empty query) or Ctrl+C.
   */
  constructor(
    private readonly entries: readonly TranscriptEntry[],
    initialQuery: string,
    private readonly rows: () => number,
    private readonly palette: Palette,
    private readonly onClose: () => void,
  ) {
    // Typed in rather than assigned: `Input.setValue` leaves the caret where it
    // was, which for a fresh box is column zero — the next character the user
    // types would land in front of the query the command carried.
    for (const character of initialQuery) this.query.handleInput(character)
  }

  invalidate(): void {
    this.query.invalidate()
  }

  /** The messages the current query hits, in transcript order. */
  private matches(): TranscriptMatch[] {
    return searchTranscript(this.entries, this.query.getValue())
  }

  /** The selection bar's index within `visible`, falling back to the first row. */
  private selectedIndex(visible: readonly TranscriptMatch[]): number {
    const index = visible.findIndex(match => match.entry.key === this.selectedKey)
    return index === -1 ? 0 : index
  }

  private viewport(): number {
    return Math.max(1, this.rows() - PANEL_CHROME_ROWS)
  }

  private move(delta: number): void {
    const visible = this.matches()
    if (visible.length === 0) return
    const index = Math.max(0, Math.min(this.selectedIndex(visible) + delta, visible.length - 1))
    this.selectedKey = visible[index]?.entry.key
  }

  /** Re-derive the selection after the query box changed. */
  private refilter(): void {
    const visible = this.matches()
    if (!visible.some(match => match.entry.key === this.selectedKey)) {
      this.selectedKey = visible[0]?.entry.key
    }
    this.offset = 0
  }

  /** The message currently filling the panel, when one is open. */
  private opened(): TranscriptEntry | undefined {
    return this.entries.find(entry => entry.key === this.openKey)
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.ctrl('c'))) {
      this.onClose()
      return
    }
    if (this.openKey !== undefined) {
      this.handleDetailInput(data)
      return
    }
    if (matchesKey(data, Key.escape)) {
      // The Esc ladder every filterable surface here uses: a non-empty query is
      // cleared first, so backing out of a search is not losing the panel.
      if (this.query.getValue() === '') {
        this.onClose()
        return
      }
      this.query.setValue('')
      this.refilter()
      return
    }
    if (this.entries.length === 0) return
    if (matchesKey(data, Key.up)) { this.move(-1); return }
    if (matchesKey(data, Key.down)) { this.move(1); return }
    if (matchesKey(data, Key.pageUp)) { this.move(-this.viewport()); return }
    if (matchesKey(data, Key.pageDown)) { this.move(this.viewport()); return }
    if (matchesKey(data, Key.enter)) {
      const visible = this.matches()
      const selected = visible[this.selectedIndex(visible)]
      if (selected === undefined) return
      this.selectedKey = selected.entry.key
      this.openKey = selected.entry.key
      this.detailOffset = 0
      return
    }
    const previous = this.query.getValue()
    this.query.focused = true
    this.query.handleInput(data)
    if (this.query.getValue() !== previous) this.refilter()
    // Anything the query box ignored is still swallowed: the panel owns the
    // keyboard while it is open.
  }

  /** Keys while one message fills the panel: scrolling, and the way back. */
  private handleDetailInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      // One rung only: the query that found this message is still on screen
      // behind it, and closing the panel from here would throw it away.
      this.openKey = undefined
      this.detailOffset = 0
      return
    }
    const viewport = this.viewport()
    if (matchesKey(data, Key.up)) this.detailOffset -= 1
    else if (matchesKey(data, Key.down)) this.detailOffset += 1
    else if (matchesKey(data, Key.pageUp)) this.detailOffset -= viewport
    else if (matchesKey(data, Key.pageDown)) this.detailOffset += viewport
    else if (matchesKey(data, Key.home)) this.detailOffset = 0
    else if (matchesKey(data, Key.end)) this.detailOffset = Number.MAX_SAFE_INTEGER
    // Typing is swallowed rather than passed to the query box: the page on
    // screen would change under the reader without the list to explain why.
  }

  /** List body rows, plus the display-row index of the selection bar. */
  private listBody(visible: readonly TranscriptMatch[], width: number): { rows: string[]; selectedRow: number } {
    if (visible.length === 0) return { rows: [this.palette.dim(t('search.noMatch'))], selectedRow: 0 }
    const query = this.query.getValue()
    const labels = visible.map(match => truncateToWidth(displayInlineText(match.entry.label), LABEL_COLUMN_MAX, ''))
    // Padded by rendered width, not by character count: a label with a wide
    // character occupies two columns and would otherwise skew its own row.
    const column = Math.max(...labels.map(label => visibleWidth(label)))
    const selectedIndex = this.selectedIndex(visible)
    const rows = visible.map((match, index) => {
      /* v8 ignore next -- labels is built from `visible`, so the index always resolves. */
      const label = labels[index] ?? ''
      const bar = index === selectedIndex ? this.palette.accent('→ ') : '  '
      const painted = paintHits(displayInlineText(match.excerpt), query, this.palette)
      return truncateToWidth(
        `${bar}${paintLabel(match.entry.role, label, this.palette)}${' '.repeat(column - visibleWidth(label))}  ${painted}`,
        width,
        '',
      )
    })
    return { rows, selectedRow: selectedIndex }
  }

  /** The open message's body, wrapped to the panel and with its hits painted. */
  private detailBody(entry: TranscriptEntry, width: number): string[] {
    const query = this.query.getValue()
    return displayText(entry.text).split('\n').flatMap((line) => {
      if (line.trim() === '') return ['']
      return wrapTextWithAnsi(paintHits(line, query, this.palette), width)
    })
  }

  /**
   * Frame one body block into the panel: a window that follows the row it must
   * keep in view, and the readout that says where the window sits.
   * @param rows - every body row.
   * @param offset - the current first visible row.
   * @param keep - a row the window must contain, when one has to stay in view.
   * @returns the visible rows, the clamped offset, and the position readout.
   */
  private frame(rows: readonly string[], offset: number, keep?: number): {
    shown: readonly string[]
    offset: number
    position: string
  } {
    const viewport = this.viewport()
    let next = Math.max(0, Math.min(offset, Math.max(0, rows.length - viewport)))
    if (keep !== undefined) {
      if (keep < next) next = keep
      if (keep >= next + viewport) next = keep - viewport + 1
    }
    const shown = rows.slice(next, next + viewport)
    const position = rows.length > viewport
      // The same readout the scrollable panels print, through the same key.
      ? `  ·  ${t('panel.position', { first: next + 1, last: next + shown.length, total: rows.length })}`
      : ''
    return { shown, offset: next, position }
  }

  render(width: number): string[] {
    const contentWidth = Math.max(1, width - 2)
    const title = ` ${this.palette.dim(TRANSCRIPT_SEARCH_TITLE)}`
    if (this.entries.length === 0) {
      return [
        '',
        title,
        ...wrapTextWithAnsi(this.palette.dim(t('search.empty')), contentWidth).map(line => ` ${line}`),
        ` ${this.palette.dim(t('panel.escClose'))}`,
      ]
    }
    const open = this.opened()
    return open === undefined ? this.renderList(contentWidth, title) : this.renderDetail(open, contentWidth)
  }

  /** The list of hits, with the query box above it. */
  private renderList(contentWidth: number, title: string): string[] {
    const visible = this.matches()
    this.query.focused = true
    // The box brings its own `>` prompt, so the label carries no second colon.
    const queryLine = truncateToWidth(
      `${this.palette.dim(t('search.query'))} ${this.query.render(Math.max(1, contentWidth - 7)).join('')}`,
      contentWidth,
      '',
    )
    const count = plural(this.entries.length, 'search.count', {
      visible: visible.length,
      total: this.entries.length,
    })
    const { rows, selectedRow } = this.listBody(visible, contentWidth)
    const framed = this.frame(rows, this.offset, selectedRow)
    this.offset = framed.offset
    return [
      '',
      title,
      ` ${queryLine}`,
      ` ${truncateToWidth(this.palette.dim(count), contentWidth, '')}`,
      ...framed.shown.map(line => ` ${line}`),
      ` ${truncateToWidth(this.palette.dim(`${t('search.hint')}${framed.position}`), contentWidth, '')}`,
    ]
  }

  /** One message's whole text, paged. */
  private renderDetail(entry: TranscriptEntry, contentWidth: number): string[] {
    const query = this.query.getValue()
    const heading = `${TRANSCRIPT_SEARCH_TITLE} · ${displayInlineText(entry.label)}`
    const rows = this.detailBody(entry, contentWidth)
    const framed = this.frame(rows, this.detailOffset)
    this.detailOffset = framed.offset
    const subtitle = query === ''
      ? t('search.detail.whole')
      : t('search.detail.hits', { query: displayInlineText(query) })
    return [
      '',
      ` ${truncateToWidth(this.palette.dim(heading), contentWidth, '')}`,
      ` ${truncateToWidth(this.palette.dim(subtitle), contentWidth, '')}`,
      // The blank keeps the message clear of its own header, exactly as the
      // transcript spaces a card from the row above it.
      '',
      ...framed.shown.map(line => ` ${line}`),
      ` ${truncateToWidth(this.palette.dim(`${t('search.detailHint')}${framed.position}`), contentWidth, '')}`,
    ]
  }
}

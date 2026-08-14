/**
 * Read-only scrollable panel for command output that is a view of the session,
 * not a turn in it: `/help`, `/hotkeys`, `/palette`, `/status`.
 *
 * These commands used to dump their whole output into the transcript, which
 * pushed the conversation off screen every time a user asked what the session
 * was doing — and left the answer stranded in the log, above every later reply.
 * The panel is pi's selector shape instead: it takes over the editor slot, owns
 * the keyboard while it is open, and leaves nothing behind when it closes.
 *
 * Content arrives already rendered (ANSI allowed) and is soft-wrapped once per
 * width; the panel never re-derives it, so what a caller hands over is exactly
 * what the user reads.
 * @module @deepseek-ai/dsh-tui/components/panel
 */

import {
  Key,
  matchesKey,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
} from '@earendil-works/pi-tui'
import { displayText } from './text.ts'
import type { Palette } from './theme.ts'
import { t } from '../i18n/index.ts'

/** Terminal rows the panel spends on its own chrome: title, footer, and the blank above. */
const PANEL_CHROME_ROWS = 3

/**
 * One scrollable page of pre-rendered lines in the editor slot.
 *
 * The panel is inert except for its own scroll keys: ↑/↓ by a row, PgUp/PgDn by
 * a page, `g`/`G` (and Home/End) to either end, Esc or Ctrl+C to close. Every
 * other key is swallowed rather than forwarded, so a keystroke aimed at the
 * panel can never reach the editor behind it.
 */
export class ScrollablePanel implements Component, Focusable {
  /** Set by the TUI on focus; the panel shows no cursor, so it only tracks it. */
  focused = false
  /** First visible content row. */
  private offset = 0
  /** Wrapped content for {@link wrappedWidth}; recomputed when the width changes. */
  private wrapped: readonly string[] = []
  private wrappedWidth = -1

  /**
   * @param title - dim heading, shown above the content.
   * @param lines - pre-rendered content rows; ANSI is preserved, empty rows are kept.
   * @param rows - the panel's total row budget, read per render so a resize applies.
   * @param palette - active role palette.
   * @param onClose - called on Esc or Ctrl+C; the caller closes the overlay.
   */
  constructor(
    private readonly title: string,
    private readonly lines: readonly string[],
    private readonly rows: () => number,
    private readonly palette: Palette,
    private readonly onClose: () => void,
  ) {}

  invalidate(): void {
    // The wrap is a pure function of (lines, width), and `lines` is immutable,
    // so only a width change can invalidate it. Dropping the cached width here
    // keeps a theme change from serving a stale wrap anyway.
    this.wrappedWidth = -1
  }

  /** Content rows for `width`, wrapped once and reused until the width changes. */
  private content(width: number): readonly string[] {
    if (this.wrappedWidth === width) return this.wrapped
    this.wrapped = this.lines.flatMap(line => wrapTextWithAnsi(line, width))
    this.wrappedWidth = width
    return this.wrapped
  }

  /** Visible content rows, once the title, footer, and leading blank are paid for. */
  private viewport(): number {
    return Math.max(1, this.rows() - PANEL_CHROME_ROWS)
  }

  /** Last legal offset for the last measured width; zero while the content fits. */
  private maxOffset(): number {
    return Math.max(0, this.wrapped.length - this.viewport())
  }

  private scrollTo(offset: number): void {
    // Clamped against the last rendered wrap: input can only arrive at a
    // mounted, already-rendered panel, so the measurement is never missing.
    this.offset = Math.max(0, Math.min(offset, this.maxOffset()))
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c'))) {
      this.onClose()
      return
    }
    if (matchesKey(data, Key.up)) this.scrollTo(this.offset - 1)
    else if (matchesKey(data, Key.down)) this.scrollTo(this.offset + 1)
    else if (matchesKey(data, Key.pageUp)) this.scrollTo(this.offset - this.viewport())
    else if (matchesKey(data, Key.pageDown)) this.scrollTo(this.offset + this.viewport())
    else if (data === 'g' || matchesKey(data, Key.home)) this.scrollTo(0)
    else if (data === 'G' || matchesKey(data, Key.end)) this.scrollTo(this.maxOffset())
    // Anything else is deliberately dropped: the panel owns the keyboard while
    // it is open, so no keystroke leaks into the editor underneath it.
  }

  render(width: number): string[] {
    const contentWidth = Math.max(1, width - 2)
    const content = this.content(contentWidth)
    const viewport = this.viewport()
    // A resize can shrink the content or grow the viewport under a scrolled
    // panel, so the offset is re-clamped every frame, not only on input.
    this.scrollTo(this.offset)
    const visible = content.slice(this.offset, this.offset + viewport)
    const position = content.length > viewport
      ? `  ·  ${t('panel.position', {
        first: this.offset + 1,
        last: this.offset + visible.length,
        total: content.length,
      })}`
      : ''
    return [
      '',
      ` ${this.palette.dim(displayText(this.title))}`,
      ...visible.map(line => ` ${line}`),
      ` ${this.palette.dim(`${t('panel.hint')}${position}`)}`,
    ]
  }
}

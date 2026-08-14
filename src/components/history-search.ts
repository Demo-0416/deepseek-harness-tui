/**
 * Reverse incremental search over the prompt history (Ctrl+R), in the shape a
 * shell user already knows.
 *
 * Claude Code runs this search inside the input frame: the match is written into
 * the editor and the footer becomes `search prompts: <query>`. This terminal
 * cannot borrow that layout — the editor's text is the draft the search has to
 * be able to give back untouched, and pi-tui's editor owns its own keys the
 * moment it has focus — so the search takes the editor slot as a panel instead
 * and hands the accepted entry back on the way out. The semantics are Claude's,
 * key for key: Ctrl+R walks to older matches, Esc and Tab accept, Enter accepts
 * and submits, and only Ctrl+C (or a backspace over the empty query) restores
 * the draft the user was typing.
 * @module @deepseek-ai/dsh-tui/components/history-search
 */

import {
  Key,
  matchesKey,
  truncateToWidth,
  type Component,
  type Focusable,
} from '@earendil-works/pi-tui'
import { displayText } from './text.ts'
import type { Palette } from './theme.ts'

/** What accepting a match asks the caller to do with it. */
export type HistorySearchOutcome = 'accept' | 'submit'

/**
 * One page of reverse history search in the editor slot.
 *
 * Matching is a case-sensitive substring test against the entries in order,
 * newest first, exactly as Claude Code does it: a fuzzy match would make the
 * next Ctrl+R unpredictable, which is the one thing this key has to be.
 */
export class HistorySearchPanel implements Component, Focusable {
  /** Set by the TUI on focus; the panel draws its own caret, so it only tracks it. */
  focused = false
  private query = ''
  /** Index of the entry currently shown, or -1 before anything matched. */
  private matchIndex = -1
  /** Whether the last search ran off the end of the history without a match. */
  private failed = false

  /**
   * @param entries - Prompt history, newest first.
   * @param palette - Active role palette.
   * @param accept - Called with the entry to put back in the editor, and whether to send it.
   * @param cancel - Called when the search is abandoned; the caller restores the draft.
   */
  constructor(
    private readonly entries: readonly string[],
    private readonly palette: Palette,
    private readonly accept: (text: string, outcome: HistorySearchOutcome) => void,
    private readonly cancel: () => void,
  ) {}

  invalidate(): void {}

  /** The entry currently on screen, or `undefined` while nothing has matched. */
  private current(): string | undefined {
    return this.matchIndex < 0 ? undefined : this.entries[this.matchIndex]
  }

  /**
   * Search from `from` toward older entries and adopt the first match.
   *
   * A search that finds nothing keeps the previous match on screen and only
   * raises {@link HistorySearchPanel.failed}: Claude Code does the same, because
   * dropping back to nothing would throw away the entry the user is one keypress
   * away from accepting.
   * @param from - First index to test.
   */
  private search(from: number): void {
    if (this.query === '') {
      this.matchIndex = -1
      this.failed = false
      return
    }
    for (let index = Math.max(0, from); index < this.entries.length; index += 1) {
      if ((this.entries[index] ?? '').includes(this.query)) {
        this.matchIndex = index
        this.failed = false
        return
      }
    }
    this.failed = true
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.ctrl('c'))) {
      this.cancel()
      return
    }
    if (matchesKey(data, Key.ctrl('r'))) {
      // Only ever toward older prompts, which is what makes repeated presses a
      // walk rather than a loop.
      this.search(this.matchIndex + 1)
      return
    }
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.tab)) {
      const match = this.current()
      if (match === undefined) this.cancel()
      else this.accept(match, 'accept')
      return
    }
    if (matchesKey(data, Key.enter)) {
      const match = this.current()
      if (match === undefined) this.cancel()
      else this.accept(match, 'submit')
      return
    }
    if (matchesKey(data, Key.backspace) || matchesKey(data, Key.delete)) {
      // A backspace with nothing left to delete is the second way out, and it
      // restores the draft rather than accepting a match nobody asked for.
      if (this.query === '') this.cancel()
      else {
        this.query = this.query.slice(0, -1)
        this.search(0)
      }
      return
    }
    // Printable input only: an unmapped escape sequence must not become part of
    // the query, where it would match nothing and read as a broken keyboard.
    const printable = data !== '' && [...data].every((char) => {
      const code = char.codePointAt(0) ?? 0
      return code >= 0x20 && code !== 0x7F
    })
    if (printable) {
      this.query += data
      // Every query change restarts from the newest entry, so the match on
      // screen is always the most recent one the query describes.
      this.search(0)
    }
  }

  render(width: number): string[] {
    const contentWidth = Math.max(1, width - 2)
    const match = this.current()
    const label = this.failed ? 'no matching prompt: ' : 'search prompts: '
    const heading = `${label}${displayText(this.query)}`
    const body = match === undefined
      ? this.palette.dim('(type to search your prompt history)')
      : this.palette.accent(displayText(match.split('\n')[0] ?? ''))
    return [
      '',
      ` ${this.palette.dim(truncateToWidth(heading, contentWidth, '…'))}`,
      ` ${truncateToWidth(`❯ ${body}`, contentWidth, '…')}`,
      ` ${this.palette.dim(truncateToWidth('ctrl+r older · enter send · tab/esc accept · ctrl+c cancel', contentWidth, '…'))}`,
    ]
  }
}

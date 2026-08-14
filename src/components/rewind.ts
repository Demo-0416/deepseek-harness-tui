/**
 * The Rewind surface: jump back to an earlier prompt in this session.
 *
 * Claude Code's Rewind can restore files as well as conversation, because it
 * snapshots the working tree per message. dsh keeps no such snapshots, so this
 * panel says so on its own face and never implies otherwise — a rewind here
 * moves the conversation, and the files on disk stay exactly as the last turn
 * left them. Which of the two conversation outcomes is on offer depends on the
 * runtime: a host that can fork the session hands the transcript back to the
 * chosen point, and one that cannot only brings the prompt's text back to the
 * editor.
 * @module @deepseek-ai/dsh-tui/components/rewind
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

/** Rows the panel spends on its own chrome: blank, title, lead line, caveat, footer. */
const REWIND_CHROME_ROWS = 6

/** One earlier prompt this session can rewind to. */
export interface RewindTarget {
  /** Log sequence of the `user/message` event, which is where a fork cuts. */
  readonly seq: number
  /** Log time of that event. */
  readonly time: number
  /** The prompt text as it was sent. */
  readonly text: string
}

/**
 * Keyboard picker over this session's own prompts, newest last.
 *
 * The list is ordered the way the conversation reads (oldest first) and opens on
 * the most recent prompt, because "take that back" is the common case and it is
 * the row nearest the input frame.
 */
export class RewindPanel implements Component, Focusable {
  /** Set by the TUI on focus; the panel draws its own pointer, so it only tracks it. */
  focused = false
  private selectedIndex: number

  /**
   * @param targets - Selectable prompts, oldest first.
   * @param canFork - Whether the runtime can fork the session; decides the wording only.
   * @param rows - The panel's row budget, read per render so a resize applies.
   * @param palette - Active role palette.
   * @param done - Called with the chosen prompt.
   * @param cancel - Called on Esc or Ctrl+C.
   */
  constructor(
    private readonly targets: readonly RewindTarget[],
    private readonly canFork: boolean,
    private readonly rows: () => number,
    private readonly palette: Palette,
    private readonly done: (target: RewindTarget) => void,
    private readonly cancel: () => void,
  ) {
    this.selectedIndex = Math.max(0, targets.length - 1)
  }

  invalidate(): void {}

  /** Prompts visible at once, once the panel's own chrome is paid for. */
  private visibleCount(): number {
    return Math.max(1, Math.min(this.targets.length, this.rows() - REWIND_CHROME_ROWS))
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c'))) {
      this.cancel()
      return
    }
    if (this.targets.length === 0) {
      // Nothing to pick: Enter must not resolve with a target that is not there.
      if (matchesKey(data, Key.enter)) this.cancel()
      return
    }
    if (matchesKey(data, Key.up)) {
      this.selectedIndex = (this.selectedIndex + this.targets.length - 1) % this.targets.length
    } else if (matchesKey(data, Key.down)) {
      this.selectedIndex = (this.selectedIndex + 1) % this.targets.length
    } else if (matchesKey(data, Key.pageUp)) {
      this.selectedIndex = Math.max(0, this.selectedIndex - this.visibleCount())
    } else if (matchesKey(data, Key.pageDown)) {
      this.selectedIndex = Math.min(this.targets.length - 1, this.selectedIndex + this.visibleCount())
    } else if (matchesKey(data, Key.home)) {
      this.selectedIndex = 0
    } else if (matchesKey(data, Key.end)) {
      this.selectedIndex = this.targets.length - 1
    } else if (matchesKey(data, Key.enter)) {
      const target = this.targets[this.selectedIndex]
      if (target !== undefined) this.done(target)
    }
    // Every other key is swallowed: the panel owns the keyboard while it is
    // open, so nothing typed at it leaks into the editor underneath.
  }

  render(width: number): string[] {
    const contentWidth = Math.max(1, width - 2)
    const push = (line: string): string => ` ${truncateToWidth(line, contentWidth, '…')}`
    const lines: string[] = ['', push(this.palette.bold(this.palette.accent('Rewind')))]
    if (this.targets.length === 0) {
      lines.push(push('Nothing to rewind to yet.'), push(this.palette.dim('esc close')))
      return lines
    }
    lines.push(push(this.canFork
      ? 'Fork the conversation to the point before…'
      : 'Bring an earlier prompt back to the editor…'))
    const visible = this.visibleCount()
    const start = Math.max(0, Math.min(
      this.selectedIndex - Math.floor(visible / 2),
      this.targets.length - visible,
    ))
    for (let index = start; index < Math.min(this.targets.length, start + visible); index += 1) {
      const target = this.targets[index] as RewindTarget
      const active = index === this.selectedIndex
      // One row per prompt, first line only: a multi-line prompt would push the
      // rows the user is choosing between off the panel.
      const text = displayText((target.text.split('\n')[0] ?? '').trim())
      const row = `${active ? '❯' : ' '} ${text}`
      lines.push(push(active ? this.palette.bold(this.palette.accent(row)) : row))
    }
    lines.push(
      push(this.palette.dim('Files are never restored — dsh keeps no file checkpoints.')),
      push(this.palette.dim('↑/↓ navigate · enter rewind · esc close')),
    )
    return lines
  }
}

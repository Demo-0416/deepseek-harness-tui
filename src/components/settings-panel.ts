/**
 * `/config` panel: the handful of presentation choices this terminal owns, one
 * row each, changed in place.
 *
 * Claude Code's Config tab, reduced to what a terminal front door actually
 * decides: a switch reads as a switch (`on`/`off`), a choice cycles through its
 * values, a submenu row opens the selector that owns its vocabulary, and a row
 * this panel cannot change says who can (`/model`, `/lang`). Every value is
 * read through a getter rather than copied in at construction, so a Ctrl+O
 * press behind the panel — or a theme picked in the submenu it opened — shows
 * up on the row that names it.
 *
 * Keyboard-owned like {@link ./plugins-panel.ts | PluginsPanel}: while it is
 * open no keystroke reaches the editor underneath, and the caller closes the
 * overlay through `onClose`.
 * @module @deepseek-ai/dsh-tui/components/settings-panel
 */

import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
} from '@earendil-works/pi-tui'
import { displayInlineText } from './text.ts'
import type { Palette } from './theme.ts'
import { t } from '../i18n/index.ts'

/**
 * The panel's heading, so the command and its view name the same thing. Not a
 * message: it is the command a user types, which reads the same in every
 * locale.
 */
export const SETTINGS_PANEL_TITLE = '/config'

/** Terminal rows the panel spends on its own chrome: blank, title, footer. */
const PANEL_CHROME_ROWS = 3

/** Columns between the widest label and the value column. */
const VALUE_GAP = 2

/** A two-state setting; Enter flips it. */
export interface SettingsToggleEntry {
  kind: 'toggle'
  label: string
  value: () => boolean
  set: (next: boolean) => void
}

/** A setting with a closed set of values; Enter (or →) steps to the next one. */
export interface SettingsChoiceEntry {
  kind: 'choice'
  label: string
  options: readonly string[]
  value: () => string
  set: (next: string) => void
}

/** A setting whose values have a selector of their own; Enter opens it. */
export interface SettingsSubmenuEntry {
  kind: 'submenu'
  label: string
  value: () => string
  open: () => void
}

/** A setting this panel only reports, naming the command that does change it. */
export interface SettingsNoticeEntry {
  kind: 'notice'
  label: string
  value: () => string
  /** What to type instead, e.g. `/model`; shown dim beside the value. */
  hint: string
}

/** One row of the `/config` panel. */
export type SettingsEntry =
  | SettingsToggleEntry
  | SettingsChoiceEntry
  | SettingsSubmenuEntry
  | SettingsNoticeEntry

/** How a toggle's two states are worded, once, for every row that has them. */
function toggleLabel(value: boolean): string {
  return t(value ? 'settings.on' : 'settings.off')
}

/** The value column's text for one entry, without color. */
function entryValueText(entry: SettingsEntry): string {
  return entry.kind === 'toggle' ? toggleLabel(entry.value()) : displayInlineText(entry.value())
}

/** Settings list in the editor slot, one row per entry. */
export class SettingsPanel implements Component, Focusable {
  /** Set by the TUI on focus; the panel draws its own selection bar either way. */
  focused = false
  private selectedIndex = 0
  /** First visible row, moved only by a selection that would fall outside the viewport. */
  private offset = 0

  /**
   * @param entries - the rows, in display order; at least one.
   * @param rows - the panel's total row budget, read per render so a resize applies.
   * @param palette - active role palette.
   * @param onClose - called on Esc or Ctrl+C.
   */
  constructor(
    private readonly entries: readonly SettingsEntry[],
    private readonly rows: () => number,
    private readonly palette: Palette,
    private readonly onClose: () => void,
  ) {}

  invalidate(): void {
    // Nothing to drop: every row is rebuilt from the entries' getters on each
    // render, which is also what lets a change made elsewhere show up here.
  }

  private viewport(): number {
    return Math.max(1, this.rows() - PANEL_CHROME_ROWS)
  }

  private move(delta: number): void {
    if (this.entries.length === 0) return
    this.selectedIndex = Math.max(0, Math.min(this.selectedIndex + delta, this.entries.length - 1))
  }

  /** Step one choice entry, wrapping, in the direction the key asked for. */
  private step(entry: SettingsChoiceEntry, delta: number): void {
    const { options } = entry
    if (options.length === 0) return
    const index = options.indexOf(entry.value())
    // An unrecognized current value starts the cycle at its first option
    // rather than refusing to move: the row exists to change the value.
    const next = index === -1 ? 0 : (index + delta + options.length) % options.length
    entry.set(options[next] as string)
  }

  /** Apply the highlighted row's own idea of what Enter means. */
  private activate(): void {
    const entry = this.entries[this.selectedIndex]
    if (entry === undefined) return
    if (entry.kind === 'toggle') entry.set(!entry.value())
    else if (entry.kind === 'choice') this.step(entry, 1)
    else if (entry.kind === 'submenu') entry.open()
    // A notice row is a readout: Enter on it does nothing, rather than opening
    // something this panel does not own.
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c'))) { this.onClose(); return }
    if (matchesKey(data, Key.up)) { this.move(-1); return }
    if (matchesKey(data, Key.down)) { this.move(1); return }
    if (matchesKey(data, Key.enter)) { this.activate(); return }
    const entry = this.entries[this.selectedIndex]
    if (entry?.kind === 'choice') {
      // ←/→ read as "the value before/after this one" on a row that has a
      // closed set, which is the same relation Enter walks forwards.
      if (matchesKey(data, Key.left)) { this.step(entry, -1); return }
      if (matchesKey(data, Key.right)) { this.step(entry, 1); return }
    }
    // Everything else is swallowed: the panel owns the keyboard while it is open.
  }

  /** One row per entry: the selection bar, the label column, then the value. */
  private body(width: number): string[] {
    const labelColumn = Math.max(0, ...this.entries.map(entry => visibleWidth(displayInlineText(entry.label))))
    return this.entries.map((entry, index) => {
      const bar = index === this.selectedIndex ? this.palette.accent('→ ') : '  '
      const label = displayInlineText(entry.label)
      const padding = ' '.repeat(Math.max(0, labelColumn - visibleWidth(label) + VALUE_GAP))
      const value = entryValueText(entry)
      const painted = entry.kind === 'notice'
        ? this.palette.dim(`${value} ${entry.hint}`)
        // The value is the one thing on the row a reader is looking for, so it
        // carries the emphasis color while the label stays body text.
        : `${this.palette.accent(value)}${entry.kind === 'submenu' ? this.palette.dim(' ›') : ''}`
      return truncateToWidth(`${bar}${this.palette.text(label)}${padding}${painted}`, width, '')
    })
  }

  render(width: number): string[] {
    const contentWidth = Math.max(1, width - 2)
    const rows = this.body(contentWidth)
    const viewport = this.viewport()
    this.offset = Math.max(0, Math.min(this.offset, Math.max(0, rows.length - viewport)))
    if (this.selectedIndex < this.offset) this.offset = this.selectedIndex
    if (this.selectedIndex >= this.offset + viewport) this.offset = this.selectedIndex - viewport + 1
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
      ` ${this.palette.dim(SETTINGS_PANEL_TITLE)}`,
      ...shown.map(line => ` ${line}`),
      ` ${truncateToWidth(this.palette.dim(`${t('settings.hint')}${position}`), contentWidth, '')}`,
    ]
  }
}

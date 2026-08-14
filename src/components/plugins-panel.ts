/**
 * `/plugins` panel: the Cordis Loader's current entries, searchable and
 * inspectable row by row.
 *
 * The rows come from `ctx.get('pluginInventory')` — the `pluginInventory`
 * service of `@deepseek-ai/dsh-host-plugin-inventory`, whose `list()` reads the
 * Loader on every call. That plugin is a HOST mount (the Web settings tab is
 * its only other reader), so the TUI treats it as optional: a deployment
 * without it gets a one-line explanation rather than an empty panel.
 *
 * The interaction is the Web plugin tab's, translated to the keyboard: typing
 * filters by module name or entry id (case-insensitive substring), ↑/↓ move,
 * Enter opens one entry's detail (full entry id plus the two independent facts
 * the status word collapses), and Esc clears the filter before it closes the
 * panel. The gateway is a read-only projection — enable/disable lives in the
 * deployment's cordis.yml, not in any UI, Web included.
 * @module @deepseek-ai/dsh-tui/components/plugins-panel
 */

import {
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
} from '@earendil-works/pi-tui'
import type {
  PluginEntryId,
  PluginInventoryEntry,
  PluginInventorySnapshot,
} from '@deepseek-ai/dsh-host-plugin-inventory'
import { displayInlineText } from './text.ts'
import type { Palette } from './theme.ts'

/** The panel's heading, so the command and its view name the same thing. */
export const PLUGINS_PANEL_TITLE = '/plugins'

/**
 * The part of the `pluginInventory` service this panel reads.
 *
 * Declared structurally rather than as the gateway class: the service is
 * resolved through `ctx.get`, which is untyped for a key no package merges onto
 * `Context`, and a read-only panel has no business holding the Remote's
 * lifecycle surface.
 */
export interface PluginInventoryReader {
  /**
   * Read the Loader's current non-group entries.
   * @returns the entries in Loader order.
   */
  list(): PluginInventorySnapshot
}

/**
 * Shown instead of rows when the deployment did not mount
 * `@deepseek-ai/dsh-host-plugin-inventory`. It names the plugin rather than the
 * service key: the reader's next step is a config change, not a code change.
 */
export const PLUGINS_UNAVAILABLE =
  'Plugin inventory is not mounted. Add @deepseek-ai/dsh-host-plugin-inventory to this profile to list Loader entries.'

/** Shown when the inventory is mounted but the Loader reports no non-group entry. */
export const PLUGINS_EMPTY = 'The Loader reports no plugin entries.'

/** Shown when the filter matches nothing; the entries themselves still exist. */
export const PLUGINS_NO_MATCH = 'No entries match the filter.'

/** Terminal rows the panel spends on its own chrome: blank, title, filter, count, footer. */
const PANEL_CHROME_ROWS = 5

/** The key hints every ready panel ends with, before its position readout. */
const PANEL_HINT = 'type to filter · ↑↓ move · enter details · esc close'

/**
 * One entry's effective state, collapsing the two independent facts the
 * inventory carries (Loader enablement and root-Fiber phase) into the one word
 * a reader acts on.
 *
 * `disabled` wins over any phase: an entry disabled in config is off regardless
 * of what its Fiber last did. `inactive` is the honest name for `fiberPhase:
 * null` — enabled, but holding no live root Fiber.
 * @param entry - one Loader entry from the inventory snapshot.
 * @returns the status word shown in the panel's first column.
 */
export function pluginEntryStatus(entry: PluginInventoryEntry): string {
  if (!entry.enabled) return 'disabled'
  return entry.fiberPhase ?? 'inactive'
}

/** Paint one status word in the role that says what it means. */
function paintStatus(status: string, palette: Palette): string {
  if (status === 'active') return palette.success(status)
  if (status === 'failed') return palette.error(status)
  if (status === 'disabled' || status === 'inactive') return palette.dim(status)
  return palette.warning(status)
}

/**
 * Whether an entry matches the filter box, the Web tab's `matches` verbatim:
 * a case-insensitive substring over the module name and the Loader entry id.
 * @param entry - one Loader entry.
 * @param normalizedQuery - the query, already trimmed and lower-cased.
 * @returns true when the entry stays visible under this query.
 */
function matchesQuery(entry: PluginInventoryEntry, normalizedQuery: string): boolean {
  if (normalizedQuery.length === 0) return true
  return [entry.moduleName, String(entry.entryId)]
    .some(value => value.toLocaleLowerCase().includes(normalizedQuery))
}

/**
 * Searchable Loader-inventory panel in the editor slot.
 *
 * Keyboard-owned like {@link ./panel.ts | ScrollablePanel}: every keystroke is
 * consumed here — filter box, selection, expansion — and none leaks into the
 * editor underneath. The caller closes the overlay through `onClose`.
 */
export class PluginsPanel implements Component, Focusable {
  /** Set by the TUI on focus; the filter box owns the visible cursor. */
  focused = false
  private readonly filter = new Input()
  /** Loader entry the selection bar sits on; kept by id so filtering re-finds it. */
  private selectedId: PluginEntryId | undefined
  /** Loader entry whose detail block is open, one at a time like the Web tab. */
  private expandedId: PluginEntryId | undefined
  /** First visible body row. */
  private offset = 0

  /**
   * @param snapshot - the inventory's current entries, or `undefined` when the
   *   `pluginInventory` service is not mounted.
   * @param rows - the panel's total row budget, read per render so a resize applies.
   * @param palette - active role palette.
   * @param onClose - called on Esc (with an empty filter) or Ctrl+C.
   */
  constructor(
    private readonly snapshot: PluginInventorySnapshot | undefined,
    private readonly rows: () => number,
    private readonly palette: Palette,
    private readonly onClose: () => void,
  ) {}

  invalidate(): void {
    this.filter.invalidate()
  }

  /** Entries visible under the current filter, in Loader order. */
  private filtered(): PluginInventoryEntry[] {
    const query = this.filter.getValue().trim().toLocaleLowerCase()
    return (this.snapshot?.entries ?? []).filter(entry => matchesQuery(entry, query))
  }

  /** The selection bar's index within `visible`, falling back to the first row. */
  private selectedIndex(visible: readonly PluginInventoryEntry[]): number {
    const index = visible.findIndex(entry => entry.entryId === this.selectedId)
    return index === -1 ? 0 : index
  }

  private viewport(): number {
    return Math.max(1, this.rows() - PANEL_CHROME_ROWS)
  }

  private move(delta: number): void {
    const visible = this.filtered()
    if (visible.length === 0) return
    const index = Math.max(0, Math.min(this.selectedIndex(visible) + delta, visible.length - 1))
    this.selectedId = visible[index]?.entryId
  }

  private toggleExpanded(): void {
    const visible = this.filtered()
    const selected = visible[this.selectedIndex(visible)]
    if (selected === undefined) return
    this.selectedId = selected.entryId
    this.expandedId = this.expandedId === selected.entryId ? undefined : selected.entryId
  }

  /** Re-derive selection and expansion after the filter box changed. */
  private refilter(): void {
    const visible = this.filtered()
    if (!visible.some(entry => entry.entryId === this.selectedId)) {
      this.selectedId = visible[0]?.entryId
    }
    // The Web tab collapses a detail card its own filter hid; an expansion the
    // user can no longer see must not silently constrain later renders.
    if (!visible.some(entry => entry.entryId === this.expandedId)) {
      this.expandedId = undefined
    }
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.ctrl('c'))) {
      this.onClose()
      return
    }
    if (matchesKey(data, Key.escape)) {
      // The Esc ladder every filterable dialog here uses: a non-empty filter
      // is cleared first, so backing out of a search is not losing the panel.
      if (this.filter.getValue() === '') {
        this.onClose()
        return
      }
      this.filter.setValue('')
      this.refilter()
      return
    }
    if (this.snapshot === undefined || this.snapshot.entries.length === 0) return
    if (matchesKey(data, Key.up)) { this.move(-1); return }
    if (matchesKey(data, Key.down)) { this.move(1); return }
    if (matchesKey(data, Key.pageUp)) { this.move(-this.viewport()); return }
    if (matchesKey(data, Key.pageDown)) { this.move(this.viewport()); return }
    if (matchesKey(data, Key.enter)) { this.toggleExpanded(); return }
    const previous = this.filter.getValue()
    this.filter.focused = true
    this.filter.handleInput(data)
    if (this.filter.getValue() !== previous) this.refilter()
    // Anything the filter box ignored is still swallowed: the panel owns the
    // keyboard while it is open.
  }

  /** Body rows for the ready state, plus the display-row index of the selection bar. */
  private body(visible: readonly PluginInventoryEntry[], width: number): { rows: string[]; selectedRow: number } {
    if (visible.length === 0) return { rows: [this.palette.dim(PLUGINS_NO_MATCH)], selectedRow: 0 }
    const statuses = visible.map(entry => pluginEntryStatus(entry))
    const statusColumn = Math.max(...statuses.map(status => status.length))
    const selectedIndex = this.selectedIndex(visible)
    const rows: string[] = []
    let selectedRow = 0
    visible.forEach((entry, index) => {
      /* v8 ignore next -- statuses is built from `visible`, so the index always resolves. */
      const status = statuses[index] ?? ''
      const bar = index === selectedIndex ? this.palette.accent('→ ') : '  '
      if (index === selectedIndex) selectedRow = rows.length
      const name = displayInlineText(entry.moduleName)
      rows.push(truncateToWidth(
        `${bar}${paintStatus(status, this.palette)}${' '.repeat(statusColumn - status.length)}  ${this.palette.text(name)}`,
        width,
        '',
      ))
      if (entry.entryId !== this.expandedId) return
      // The detail block is the Web card's <dl>: the raw Loader entry id, then
      // the two facts the status word collapses — configuration always, the
      // Fiber phase only while enablement makes it meaningful.
      const detail: Array<readonly [string, string]> = [
        ['entry', displayInlineText(String(entry.entryId))],
        ['config', entry.enabled ? 'enabled' : 'disabled'],
        ...entry.enabled ? [['cordis', entry.fiberPhase ?? 'unobserved'] as const] : [],
      ]
      for (const [label, value] of detail) {
        rows.push(truncateToWidth(`      ${this.palette.dim(`${label.padEnd(6)} ${value}`)}`, width, ''))
      }
    })
    return { rows, selectedRow }
  }

  render(width: number): string[] {
    const contentWidth = Math.max(1, width - 2)
    const title = ` ${this.palette.dim(PLUGINS_PANEL_TITLE)}`
    if (this.snapshot === undefined || this.snapshot.entries.length === 0) {
      const reason = this.snapshot === undefined ? PLUGINS_UNAVAILABLE : PLUGINS_EMPTY
      return [
        '',
        title,
        ...wrapTextWithAnsi(this.palette.dim(reason), contentWidth).map(line => ` ${line}`),
        ` ${this.palette.dim('esc close')}`,
      ]
    }
    const visible = this.filtered()
    this.filter.focused = true
    const filterLine = truncateToWidth(
      `${this.palette.dim('filter:')} ${this.filter.render(Math.max(1, contentWidth - 8)).join('')}`,
      contentWidth,
      '',
    )
    const active = this.snapshot.entries.filter(entry => pluginEntryStatus(entry) === 'active').length
    const count = `${String(visible.length)}/${String(this.snapshot.entries.length)} entries · ${String(active)} active`
    const { rows, selectedRow } = this.body(visible, contentWidth)
    const viewport = this.viewport()
    // The selection bar stays in view: scrolling follows it, and a resize or a
    // collapse that shrank the body re-clamps the window every frame.
    this.offset = Math.max(0, Math.min(this.offset, Math.max(0, rows.length - viewport)))
    if (selectedRow < this.offset) this.offset = selectedRow
    if (selectedRow >= this.offset + viewport) this.offset = selectedRow - viewport + 1
    const shown = rows.slice(this.offset, this.offset + viewport)
    const position = rows.length > viewport
      ? `  ·  ${String(this.offset + 1)}–${String(this.offset + shown.length)} of ${String(rows.length)}`
      : ''
    return [
      '',
      title,
      ` ${filterLine}`,
      ` ${truncateToWidth(this.palette.dim(count), contentWidth, '')}`,
      ...shown.map(line => ` ${line}`),
      ` ${truncateToWidth(this.palette.dim(`${PANEL_HINT}${position}`), contentWidth, '')}`,
    ]
  }
}


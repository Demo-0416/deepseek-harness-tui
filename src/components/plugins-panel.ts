/**
 * `/plugins` panel content: the Cordis Loader's current entries, one row each.
 *
 * The rows come from `ctx.get('pluginInventory')` — the `pluginInventory`
 * service of `@deepseek-ai/dsh-host-plugin-inventory`, whose `list()` reads the
 * Loader on every call. That plugin is a HOST mount (the Web settings tab is
 * its only other reader), so the TUI treats it as optional: a deployment
 * without it gets a one-line explanation rather than an empty panel.
 *
 * This module only formats. Reading the service, opening the panel, and
 * registering the command are the entry point's.
 * @module @deepseek-ai/dsh-tui/components/plugins-panel
 */

import { visibleWidth } from '@earendil-works/pi-tui'
import type {
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
 * Render one inventory snapshot as panel rows.
 *
 * Loader order is preserved — it is the order the entries mount in, which is
 * what a reader diagnosing a failed dependency is looking for — and the status
 * and name columns are padded so all three columns align down the panel.
 * @param snapshot - the inventory's current entries, or `undefined` when the
 *   `pluginInventory` service is not mounted.
 * @param palette - active role palette.
 * @returns pre-rendered rows for {@link ./panel.ts | ScrollablePanel}.
 */
export function renderPluginInventory(
  snapshot: PluginInventorySnapshot | undefined,
  palette: Palette,
): string[] {
  if (snapshot === undefined) return [palette.dim(PLUGINS_UNAVAILABLE)]
  const entries = snapshot.entries
  if (entries.length === 0) return [palette.dim(PLUGINS_EMPTY)]
  const statuses = entries.map(entry => pluginEntryStatus(entry))
  const names = entries.map(entry => displayInlineText(entry.moduleName))
  // Both leading columns pad to their own widest cell, so the ids line up down
  // the panel instead of ending wherever each module name happens to.
  const statusColumn = Math.max(...statuses.map(status => status.length))
  const nameColumn = Math.max(...names.map(name => visibleWidth(name)))
  const rows = entries.map((entry, index) => {
    /* v8 ignore next 2 -- both arrays are built from `entries`, so the index always resolves. */
    const status = statuses[index] ?? ''
    const name = names[index] ?? ''
    const id = displayInlineText(String(entry.entryId))
    return [
      `${paintStatus(status, palette)}${' '.repeat(statusColumn - status.length)}`,
      `${palette.text(name)}${' '.repeat(nameColumn - visibleWidth(name))}`,
      palette.dim(id),
    ].join('  ')
  })
  const active = statuses.filter(status => status === 'active').length
  return [
    palette.dim(`${String(entries.length)} entries · ${String(active)} active`),
    '',
    ...rows,
  ]
}

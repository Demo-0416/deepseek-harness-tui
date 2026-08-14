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
import { type Component, type Focusable } from '@earendil-works/pi-tui';
import type { PluginInventoryEntry, PluginInventorySnapshot } from '@deepseek-ai/dsh-host-plugin-inventory';
import type { Palette } from './theme.ts';
/** The panel's heading, so the command and its view name the same thing. */
export declare const PLUGINS_PANEL_TITLE = "/plugins";
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
    list(): PluginInventorySnapshot;
}
/**
 * Shown instead of rows when the deployment did not mount
 * `@deepseek-ai/dsh-host-plugin-inventory`. It names the plugin rather than the
 * service key: the reader's next step is a config change, not a code change.
 *
 * These three are the English text of the message keys the panel renders, not a
 * second source of it: the panel itself looks the key up per frame, so `/lang`
 * moves it, while the constant stays for the parity fixtures that quote the
 * shipped English wording.
 */
export declare const PLUGINS_UNAVAILABLE: string;
/** Shown when the inventory is mounted but the Loader reports no non-group entry. */
export declare const PLUGINS_EMPTY: string;
/** Shown when the filter matches nothing; the entries themselves still exist. */
export declare const PLUGINS_NO_MATCH: string;
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
export declare function pluginEntryStatus(entry: PluginInventoryEntry): string;
/**
 * Searchable Loader-inventory panel in the editor slot.
 *
 * Keyboard-owned like {@link ./panel.ts | ScrollablePanel}: every keystroke is
 * consumed here — filter box, selection, expansion — and none leaks into the
 * editor underneath. The caller closes the overlay through `onClose`.
 */
export declare class PluginsPanel implements Component, Focusable {
    private readonly snapshot;
    private readonly rows;
    private readonly palette;
    private readonly onClose;
    /** Set by the TUI on focus; the filter box owns the visible cursor. */
    focused: boolean;
    private readonly filter;
    /** Loader entry the selection bar sits on; kept by id so filtering re-finds it. */
    private selectedId;
    /** Loader entry whose detail block is open, one at a time like the Web tab. */
    private expandedId;
    /** First visible body row. */
    private offset;
    /**
     * @param snapshot - the inventory's current entries, or `undefined` when the
     *   `pluginInventory` service is not mounted.
     * @param rows - the panel's total row budget, read per render so a resize applies.
     * @param palette - active role palette.
     * @param onClose - called on Esc (with an empty filter) or Ctrl+C.
     */
    constructor(snapshot: PluginInventorySnapshot | undefined, rows: () => number, palette: Palette, onClose: () => void);
    invalidate(): void;
    /** Entries visible under the current filter, in Loader order. */
    private filtered;
    /** The selection bar's index within `visible`, falling back to the first row. */
    private selectedIndex;
    private viewport;
    private move;
    private toggleExpanded;
    /** Re-derive selection and expansion after the filter box changed. */
    private refilter;
    handleInput(data: string): void;
    /** Body rows for the ready state, plus the display-row index of the selection bar. */
    private body;
    render(width: number): string[];
}

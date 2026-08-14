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
import { type Component, type Focusable } from '@earendil-works/pi-tui';
import type { Palette } from './theme.ts';
/**
 * The panel's heading, so the command and its view name the same thing. Not a
 * message: it is the command a user types, which reads the same in every
 * locale.
 */
export declare const SETTINGS_PANEL_TITLE = "/config";
/** A two-state setting; Enter flips it. */
export interface SettingsToggleEntry {
    kind: 'toggle';
    label: string;
    value: () => boolean;
    set: (next: boolean) => void;
}
/** A setting with a closed set of values; Enter (or →) steps to the next one. */
export interface SettingsChoiceEntry {
    kind: 'choice';
    label: string;
    options: readonly string[];
    value: () => string;
    set: (next: string) => void;
    /**
     * Words one option for the value column, when the ids are not themselves
     * user-facing. `set()` still takes the raw id, so the cycle is unaffected —
     * this is display only, which is what separates `collapsed`/`expanded`/
     * `hidden` (nothing takes them as input) from the theme ids (`/theme <id>`
     * does, so those are shown verbatim in every locale).
     */
    format?: (value: string) => string;
}
/** A setting whose values have a selector of their own; Enter opens it. */
export interface SettingsSubmenuEntry {
    kind: 'submenu';
    label: string;
    value: () => string;
    open: () => void;
}
/** A setting this panel only reports, naming the command that does change it. */
export interface SettingsNoticeEntry {
    kind: 'notice';
    label: string;
    value: () => string;
    /** What to type instead, e.g. `/model`; shown dim beside the value. */
    hint: string;
}
/** One row of the `/config` panel. */
export type SettingsEntry = SettingsToggleEntry | SettingsChoiceEntry | SettingsSubmenuEntry | SettingsNoticeEntry;
/** Settings list in the editor slot, one row per entry. */
export declare class SettingsPanel implements Component, Focusable {
    private readonly entries;
    private readonly rows;
    private readonly palette;
    private readonly onClose;
    /** Set by the TUI on focus; the panel draws its own selection bar either way. */
    focused: boolean;
    private selectedIndex;
    /** First visible row, moved only by a selection that would fall outside the viewport. */
    private offset;
    /**
     * @param entries - the rows, in display order; at least one.
     * @param rows - the panel's total row budget, read per render so a resize applies.
     * @param palette - active role palette.
     * @param onClose - called on Esc or Ctrl+C.
     */
    constructor(entries: readonly SettingsEntry[], rows: () => number, palette: Palette, onClose: () => void);
    invalidate(): void;
    private viewport;
    private move;
    /** Step one choice entry, wrapping, in the direction the key asked for. */
    private step;
    /** Apply the highlighted row's own idea of what Enter means. */
    private activate;
    handleInput(data: string): void;
    /** One row per entry: the selection bar, the label column, then the value. */
    private body;
    render(width: number): string[];
}

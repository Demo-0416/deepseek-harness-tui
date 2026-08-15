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
import { type Component, type Focusable } from '@earendil-works/pi-tui';
import type { SubagentDescendant } from '../chat/subagents.ts';
import type { Palette } from './theme.ts';
/** The panel's heading, so the command and its view name the same thing. */
export declare const SUBAGENTS_PANEL_TITLE = "/subagents";
/**
 * Reported when no subagent registry serves this session: the panel is not
 * opened at all, because a profile without the registry has no tree to show.
 *
 * These are the English text of the message keys the panel renders, not a
 * second source of it — every rendering site looks its key up per frame, so
 * `/lang` moves the screen while the constants stay for the tests that quote
 * the shipped English wording.
 */
export declare const SUBAGENTS_UNAVAILABLE: string;
/** Shown while the first directory read is in flight; the panel is already up. */
export declare const SUBAGENTS_LOADING: string;
/** Shown when the registry answers with no children at all. */
export declare const SUBAGENTS_EMPTY: string;
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
export declare function renderSubagentRows(entries: readonly SubagentDescendant[], palette: Palette, width: number): string[];
/**
 * The delegation tree in the editor slot, filled by the caller.
 *
 * Keyboard-owned like {@link ./panel.ts | ScrollablePanel}. The caller owns the
 * registry, the root session, the abort signal, and the lifecycle events that
 * make a listing stale; the panel only shows what it is handed
 * ({@link setEntries}, {@link setError}).
 */
export declare class SubagentsPanel implements Component, Focusable {
    private readonly rows;
    private readonly palette;
    private readonly onClose;
    /** Set by the TUI on focus; this panel paints no cursor of its own. */
    focused: boolean;
    /** The tree, or `undefined` while the first listing is still in flight. */
    private entries;
    /** The last failed listing, cleared by the next one that succeeds. */
    private error;
    /** First visible tree row. */
    private offset;
    /**
     * @param entries - the tree when it is already known, `undefined` while it loads.
     * @param rows - the panel's total row budget, read per render so a resize applies.
     * @param palette - active role palette.
     * @param onClose - called on Esc or Ctrl+C; the caller closes the overlay.
     */
    constructor(entries: readonly SubagentDescendant[] | undefined, rows: () => number, palette: Palette, onClose: () => void);
    invalidate(): void;
    /**
     * Replace whatever is on screen with a listing that just landed.
     *
     * A successful read also clears a previous failure: the directory answered,
     * so the old error is no longer a fact about this tree.
     * @param entries - the descendant listing, in the directory's own order.
     */
    setEntries(entries: readonly SubagentDescendant[]): void;
    /**
     * Report a listing that failed.
     *
     * A failure after a good read does not throw the tree away — a refresh that
     * loses the network must not blank a panel the reader is using — so the
     * message is shown above rows that are merely older than they look.
     * @param message - the failure, shown verbatim.
     */
    setError(message: string): void;
    /** Visible tree rows, once the leading blank, title, count, and footer are paid for. */
    private viewport;
    private scrollBy;
    handleInput(data: string): void;
    /** The one-page states: a message and the way out, with no count line above them. */
    private renderMessage;
    render(width: number): string[];
}

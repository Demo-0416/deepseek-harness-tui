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
import { type Component, type Focusable } from '@earendil-works/pi-tui';
import { type TranscriptEntry } from '../chat/transcript-search.ts';
import type { Palette } from './theme.ts';
/** The panel's heading, so the command and its view name the same thing. */
export declare const TRANSCRIPT_SEARCH_TITLE = "/search";
/** Shown when the session has produced nothing readable yet, in English, for the docs suite. */
export declare const TRANSCRIPT_SEARCH_EMPTY: string;
/** Shown when the query matches nothing; the messages themselves are still there. */
export declare const TRANSCRIPT_SEARCH_NO_MATCH: string;
/**
 * Full-text search over this session's messages, in the editor slot.
 *
 * Keyboard-owned like {@link ./plugins-panel.ts | PluginsPanel}: every keystroke
 * is consumed here — query box, selection, the open message — and none leaks
 * into the editor underneath. The caller closes the overlay through `onClose`.
 */
export declare class TranscriptSearchPanel implements Component, Focusable {
    private readonly entries;
    private readonly rows;
    private readonly palette;
    private readonly onClose;
    /** Set by the TUI on focus; the query box owns the visible cursor. */
    focused: boolean;
    private readonly query;
    /** Message the selection bar sits on; kept by key so filtering re-finds it. */
    private selectedKey;
    /** The message whose whole text fills the panel, or `undefined` in the list. */
    private openKey;
    /** First visible list row. */
    private offset;
    /** First visible row of the open message. */
    private detailOffset;
    /**
     * @param entries - this session's messages, in transcript order.
     * @param initialQuery - the `/search` argument, if the command carried one.
     * @param rows - the panel's total row budget, read per render so a resize applies.
     * @param palette - active role palette.
     * @param onClose - called on Esc (with an empty query) or Ctrl+C.
     */
    constructor(entries: readonly TranscriptEntry[], initialQuery: string, rows: () => number, palette: Palette, onClose: () => void);
    invalidate(): void;
    /** The messages the current query hits, in transcript order. */
    private matches;
    /** The selection bar's index within `visible`, falling back to the first row. */
    private selectedIndex;
    private viewport;
    private move;
    /** Re-derive the selection after the query box changed. */
    private refilter;
    /** The message currently filling the panel, when one is open. */
    private opened;
    handleInput(data: string): void;
    /** Keys while one message fills the panel: scrolling, and the way back. */
    private handleDetailInput;
    /** List body rows, plus the display-row index of the selection bar. */
    private listBody;
    /** The open message's body, wrapped to the panel and with its hits painted. */
    private detailBody;
    /**
     * Frame one body block into the panel: a window that follows the row it must
     * keep in view, and the readout that says where the window sits.
     * @param rows - every body row.
     * @param offset - the current first visible row.
     * @param keep - a row the window must contain, when one has to stay in view.
     * @returns the visible rows, the clamped offset, and the position readout.
     */
    private frame;
    render(width: number): string[];
    /** The list of hits, with the query box above it. */
    private renderList;
    /** One message's whole text, paged. */
    private renderDetail;
}

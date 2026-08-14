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
import { type Component, type Focusable } from '@earendil-works/pi-tui';
import type { Palette } from './theme.ts';
/** What accepting a match asks the caller to do with it. */
export type HistorySearchOutcome = 'accept' | 'submit';
/**
 * One page of reverse history search in the editor slot.
 *
 * Matching is a case-sensitive substring test against the entries in order,
 * newest first, exactly as Claude Code does it: a fuzzy match would make the
 * next Ctrl+R unpredictable, which is the one thing this key has to be.
 */
export declare class HistorySearchPanel implements Component, Focusable {
    private readonly entries;
    private readonly palette;
    private readonly accept;
    private readonly cancel;
    /** Set by the TUI on focus; the panel draws its own caret, so it only tracks it. */
    focused: boolean;
    private query;
    /** Index of the entry currently shown, or -1 before anything matched. */
    private matchIndex;
    /** Whether the last search ran off the end of the history without a match. */
    private failed;
    /**
     * @param entries - Prompt history, newest first.
     * @param palette - Active role palette.
     * @param accept - Called with the entry to put back in the editor, and whether to send it.
     * @param cancel - Called when the search is abandoned; the caller restores the draft.
     */
    constructor(entries: readonly string[], palette: Palette, accept: (text: string, outcome: HistorySearchOutcome) => void, cancel: () => void);
    invalidate(): void;
    /** The entry currently on screen, or `undefined` while nothing has matched. */
    private current;
    /**
     * Search from `from` toward older entries and adopt the first match.
     *
     * A search that finds nothing keeps the previous match on screen and only
     * raises {@link HistorySearchPanel.failed}: Claude Code does the same, because
     * dropping back to nothing would throw away the entry the user is one keypress
     * away from accepting.
     * @param from - First index to test.
     */
    private search;
    handleInput(data: string): void;
    render(width: number): string[];
}

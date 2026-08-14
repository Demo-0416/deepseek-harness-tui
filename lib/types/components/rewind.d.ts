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
import { type Component, type Focusable } from '@earendil-works/pi-tui';
import type { Palette } from './theme.ts';
/** One earlier prompt this session can rewind to. */
export interface RewindTarget {
    /** Log sequence of the `user/message` event, which is where a fork cuts. */
    readonly seq: number;
    /** Log time of that event. */
    readonly time: number;
    /** The prompt text as it was sent. */
    readonly text: string;
}
/**
 * Keyboard picker over this session's own prompts, newest last.
 *
 * The list is ordered the way the conversation reads (oldest first) and opens on
 * the most recent prompt, because "take that back" is the common case and it is
 * the row nearest the input frame.
 */
export declare class RewindPanel implements Component, Focusable {
    private readonly targets;
    private readonly canFork;
    private readonly rows;
    private readonly palette;
    private readonly done;
    private readonly cancel;
    /** Set by the TUI on focus; the panel draws its own pointer, so it only tracks it. */
    focused: boolean;
    private selectedIndex;
    /**
     * @param targets - Selectable prompts, oldest first.
     * @param canFork - Whether the runtime can fork the session; decides the wording only.
     * @param rows - The panel's row budget, read per render so a resize applies.
     * @param palette - Active role palette.
     * @param done - Called with the chosen prompt.
     * @param cancel - Called on Esc or Ctrl+C.
     */
    constructor(targets: readonly RewindTarget[], canFork: boolean, rows: () => number, palette: Palette, done: (target: RewindTarget) => void, cancel: () => void);
    invalidate(): void;
    /** Prompts visible at once, once the panel's own chrome is paid for. */
    private visibleCount;
    handleInput(data: string): void;
    render(width: number): string[];
}

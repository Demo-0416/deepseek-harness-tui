/**
 * `/jobs` panel: the background work this session can still see, as the job
 * registry reports it.
 *
 * The rows are one `list()` result — kind, label, lifecycle state, whatever
 * detail the producer supplied, and how long the job has been running or how
 * long it ran. The registry is in this process, so the listing is synchronous:
 * unlike the skills catalog or the subagent directory, this panel has no
 * loading line and no read that can fail. What it does have is a clock — a
 * live row's elapsed time has to move while nothing else on screen does — so
 * the time is a function the caller ticks, never a value baked into a row.
 *
 * The keyboard is `ScrollablePanel`'s, not the filterable panels': a job list
 * is short by construction (the registry drops nothing while a session lives,
 * but a session does not start hundreds of them), and the reason to open it is
 * to see everything at once.
 * @module @deepseek-ai/dsh-tui/components/jobs-panel
 */
import { type Component, type Focusable } from '@earendil-works/pi-tui';
import type { JobRow } from '../chat/jobs.ts';
import type { Palette } from './theme.ts';
/** The panel's heading, so the command and its view name the same thing. */
export declare const JOBS_PANEL_TITLE = "/jobs";
/**
 * Reported when no job registry serves this session: the panel is not opened at
 * all, because a profile without the registry has no background work to show.
 *
 * These are the English text of the message keys the panel renders, not a
 * second source of it — every rendering site looks its key up per frame, so
 * `/lang` moves the screen while the constants stay for the tests that quote
 * the shipped English wording.
 */
export declare const JOBS_UNAVAILABLE: string;
/** Shown when the registry answers with no jobs at all. */
export declare const JOBS_EMPTY: string;
/**
 * The list's rows for one width.
 *
 * Exported for the same reason the panel is rendered directly in its tests: the
 * layout — the kind column, the label column, the state and the clock — is the
 * whole point of the view, and it is worth asserting without a terminal.
 * @param rows - the jobs to draw, already in the order they are read in.
 * @param palette - active role palette.
 * @param width - the content width the rows are laid out for.
 * @param now - current time in epoch ms, for the live rows' clocks.
 * @returns one line per job, truncated to `width`.
 */
export declare function renderJobRows(rows: readonly JobRow[], palette: Palette, width: number, now: number): string[];
/**
 * The background job list in the editor slot, filled by the caller.
 *
 * Keyboard-owned like {@link ./panel.ts | ScrollablePanel}. The caller owns the
 * registry, its change subscription, and the clock that moves the live rows;
 * the panel only shows what it is handed ({@link setJobs}).
 */
export declare class JobsPanel implements Component, Focusable {
    private jobs;
    private readonly rows;
    private readonly palette;
    private readonly now;
    private readonly onClose;
    /** Set by the TUI on focus; this panel paints no cursor of its own. */
    focused: boolean;
    /** First visible list row. */
    private offset;
    /**
     * @param jobs - the visible set, in the order it is read in.
     * @param rows - the panel's total row budget, read per render so a resize applies.
     * @param palette - active role palette.
     * @param now - the caller's clock, read per frame so live rows tick.
     * @param onClose - called on Esc or Ctrl+C; the caller closes the overlay.
     */
    constructor(jobs: readonly JobRow[], rows: () => number, palette: Palette, now: () => number, onClose: () => void);
    invalidate(): void;
    /**
     * Replace the list with the visible set the registry now reports.
     * @param jobs - the new visible set, in the order it is read in.
     */
    setJobs(jobs: readonly JobRow[]): void;
    /** Visible list rows, once the leading blank, title, count, and footer are paid for. */
    private viewport;
    private scrollBy;
    handleInput(data: string): void;
    render(width: number): string[];
}

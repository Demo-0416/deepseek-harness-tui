/**
 * Per-step timing model and prompt-status glyph animation for the terminal
 * front door. Timing buckets are replayed from the session event stream; the
 * active glyph fades in when work starts, throbs while work runs, and fades out
 * when it ends.
 * @module @deepseek-ai/dsh-tui/chat/timing
 */
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type { Palette } from '../components/theme.ts';
/**
 * Render cadence of the status prompt while active, and while the glyph fades
 * out after work ends. ~20 fps so the truecolor glyph fade reads smoothly;
 * the same tick keeps the elapsed-time text (0.1 s resolution) current. Only
 * changed terminal cells are re-emitted, so the faster tick stays cheap.
 */
export declare const STATUS_ANIMATION_INTERVAL_MS = 50;
/**
 * Milliseconds over which the status glyph fades in when work starts and fades
 * out after it ends. The fade is an envelope over the active pulse:
 * inside it the glyph throbs (see {@link STATUS_PULSE_PERIOD_MS}).
 */
export declare const STATUS_FADE_MS = 300;
/** Milliseconds for one full brightness throb of the active status glyph. */
export declare const STATUS_PULSE_PERIOD_MS = 1400;
/**
 * Brightness floor of the status throb, as a fraction of the settled gray. At
 * 0 the pulse swells from the near-background trough up to full and back. The
 * trough is still rendered as the dimmest gray, not clipped to a blank, so the
 * cosine breathes symmetrically bold→dim→bold.
 */
export declare const STATUS_PULSE_FLOOR = 0;
/** The active phase of a running step, one bucket of accumulated wall time. */
export type TimingBucket = 'ttft' | 'thinking' | 'responding' | 'tools';
/** Turn/step coordinates of one assistant step. */
export type StepPosition = {
    turn: number;
    step: number;
};
/** Accumulated wall time per phase for one step or session slice. */
export interface TimingTotals {
    ttft: number;
    thinking: number;
    responding: number;
    tools: number;
}
/**
 * Incremental per-step timing accumulator shared by every step's timing footer
 * in one transcript. One forward pass over the append-only session log serves
 * all steps' totals: each query advances a cursor over the events appended
 * since the previous query, so a transcript of S steps costs O(events) in
 * total instead of the O(S × events) of replaying the whole log per footer
 * ([rationale](../../../../../.agents/notes/implemented/bug-fix/2026-08-03-tui-long-session-render-costs.md)).
 *
 * The log must be append-only with stable indices (the session `seq = log
 * length` contract). Event times are consumed as logged: a backward wall-clock
 * step clamps each bucket at zero rather than cutting the scan off at the
 * query clock. The open bucket is accumulated to the query clock at lookup,
 * never during the scan.
 */
export declare class StepTimingTracker {
    private scanned;
    private readonly steps;
    /**
     * Advance over events appended since the previous query, then return one
     * step's accumulated per-phase timing up to clock `at`.
     * @param events - Current session event log (append-only).
     * @param position - Turn/step coordinates of the queried step.
     * @param at - Render clock to accumulate the open bucket up to.
     * @returns The step's per-phase totals; empty when the step never started.
     */
    totalsAt(events: readonly SessionEvent[], position: StepPosition, at: number): TimingTotals;
}
/**
 * The turn index of the currently open turn, or `undefined` when none is open.
 * @param events - Session events to scan from the tail.
 * @returns The open turn index, or `undefined`.
 */
export declare function openTurn(events: readonly SessionEvent[]): number | undefined;
/**
 * Phase-specific status glyph, keyed by the running step's active timing bucket.
 * `ttft` is the pre-first-token wait a running turn falls back to between steps.
 */
export declare const TIMING_BUCKET_GLYPHS: Record<TimingBucket, string>;
/**
 * Derive the currently open step's active timing bucket, or `undefined` when no
 * step is open. The open step is the last `step/start` with no later matching
 * `step/end`; its bucket is replayed with the same rules as {@link StepTimingTracker}.
 * @param events - Session events to scan.
 * @returns The open step's active bucket, or `undefined`.
 */
export declare function openStepPhase(events: readonly SessionEvent[]): TimingBucket | undefined;
/**
 * The active status glyph, or `undefined` when idle. A running turn takes
 * precedence over standalone compaction and falls back to the pre-first-token
 * wait when no step is open. The caller applies the shared fade and throb
 * animation (see {@link fadeGlyph}).
 * @param events - Session events to derive the phase from.
 * @param running - Whether the agent is currently running.
 * @param compacting - Whether a live standalone compaction bracket is open.
 * @returns The active status glyph, or `undefined` when idle.
 */
export declare function runningPhaseGlyph(events: readonly SessionEvent[], running: boolean, compacting: boolean): string | undefined;
/**
 * The status throb's brightness at continuous clock `nowMs`: a cosine between
 * {@link STATUS_PULSE_FLOOR} and 1 over {@link STATUS_PULSE_PERIOD_MS}, so the
 * dim glyph breathes bold→dim→bold without ever blinking off. Multiplied by the
 * fade envelope, which alone drives appear/disappear at work boundaries.
 *
 * @param nowMs - Monotonic render clock in milliseconds.
 * @returns Brightness fraction in [{@link STATUS_PULSE_FLOOR}, 1].
 */
export declare function pulseLevel(nowMs: number): number;
/**
 * One frame of the status glyph at fade `opacity` (0 = near-background trough
 * gray, 1 = settled dim gray). The character and its width never change — only
 * the gray fades — so the prompt caret column stays fixed and the glyph reads as
 * the caret dimly breathing, never a colored indicator.
 *
 * With truecolor the glyph's 24-bit gray foreground interpolates continuously
 * between {@link STATUS_FADE_GRAY}'s trough and settled stops, so both the fade
 * and the status throb render as a smooth, symmetric brightness swing with no
 * hard cutoff to clip the trough into a blank. Without truecolor there is no
 * per-frame gray, so `visible` (driven by the fade envelope, not the opacity)
 * shows the glyph in the palette's muted role or leaves a blank column — a
 * single dim appear/disappear at fixed width, still dim rather than accent, and
 * no throb-driven blink. With color off entirely a visible glyph is bare,
 * holding the caret column on a monochrome terminal.
 *
 * @param glyph - The status glyph to paint.
 * @param palette - Active palette supplying the muted (dim gray) role.
 * @param colorEnabled - Whether ANSI is emitted at all.
 * @param truecolor - Whether the terminal accepts 24-bit foreground codes.
 * @param opacity - Brightness fraction in [0, 1] for the truecolor gray.
 * @param visible - Whether the non-truecolor fallback shows the glyph at all.
 * @returns The gray glyph at this opacity, or a single space when hidden.
 */
export declare function fadeGlyph(glyph: string, palette: Palette, colorEnabled: boolean, truecolor: boolean, opacity: number, visible: boolean): string;
/**
 * Format a non-negative elapsed span at 100 ms resolution.
 * @param elapsedMs - Elapsed milliseconds.
 * @returns The formatted duration (e.g. `1.5s`, `2m03.4s`).
 */
export declare function formatStatusDuration(elapsedMs: number): string;
/**
 * Format the non-zero timing buckets of one step as a middot-joined summary.
 * @param totals - Per-phase totals to format.
 * @param includeModelWait - Whether to always include the model-wait bucket.
 * @returns The formatted timing summary.
 */
export declare function formatTimingTotals(totals: TimingTotals, includeModelWait?: boolean): string;
/**
 * Format the queued-steering badge shown on the running status line.
 * @param queued - Number of queued steering messages.
 * @returns The badge text, or `undefined` when nothing is queued.
 */
export declare function formatQueuedStatus(queued: number): string | undefined;
/**
 * Format a completion timestamp as `YYYY-MM-DD HH:MM:SS` in local time.
 * @param time - Epoch milliseconds.
 * @returns The formatted local timestamp.
 */
export declare function formatCompletionTime(time: number): string;

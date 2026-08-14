/**
 * Keyed transcript reconciler: the only writer of the chat container's children.
 *
 * It takes a folded node list (see `core/nodes.ts`) and maintains one component
 * instance per node key. A node whose `version` it has already applied is left
 * untouched, so a burst of stream chunks re-renders one assistant step rather
 * than rebuilding the transcript; a node that stops rendering (a `/clear`
 * watermark, a palette reset, a withdrawn submission) drops its component.
 *
 * One placement is not a plain node→component map and lives here: a step's
 * timing footer trails the tool cards that step requested.
 * Process-local rows the entry appends (command output, notices, the status
 * card) are interleaved by the node count they were appended at, so they keep
 * their place in the conversation as the log grows.
 * @module @deepseek-ai/dsh-tui/components/reconciler
 */
import { Container, type Component } from '@earendil-works/pi-tui';
import type { MarkdownTheme, TerminalColorScheme } from '@earendil-works/pi-tui';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { ChatNode } from '../core/types.ts';
import type { StepTimingTracker } from '../chat/timing.ts';
import type { Palette } from './theme.ts';
import { type MarkdownPolicy, type ToolCardVisibility } from './transcript.ts';
/**
 * Transcript row standing in for one compacted range. The conversation the
 * compaction replaced stays rendered above it: the marker reports where the
 * model stopped seeing that history, not that the history is gone.
 *
 * The English form, for the docs suite and for tests; the row itself is read
 * from the message table per render, so `/lang` moves it.
 */
export declare const COMPACTION_MARKER: string;
/** Label above a prompt that was submitted into a running turn, in English. */
export declare const STEERING_BADGE: string;
/**
 * The status line one Ctrl+O phase reports.
 *
 * Only the expanded phase renders injected context at all (see
 * {@link TranscriptReconciler.reconcile}), so the collapsed sentence no longer
 * claims to be showing context cards: it names what each kind of card actually
 * does in that phase — including the read/search runs it reports as one row.
 * The hidden and expanded sentences are unchanged, because what they said was
 * already true.
 * @param visibility - The phase the cycle just entered.
 * @returns One sentence naming what that phase leaves on screen.
 */
export declare function cardPhaseNotice(visibility: ToolCardVisibility): string;
/** Everything the reconciler needs to build a component for a node. */
export interface TranscriptDeps {
    /** Active palette; mutated in place by a color-scheme change. */
    readonly palette: Palette;
    /** Active Markdown theme, likewise mutated in place. */
    readonly mdTheme: MarkdownTheme;
    /**
     * The terminal's reported color scheme, read per mount rather than captured:
     * the fills a component picks from it (the user block's background) are the
     * one thing the role palette cannot carry, and a scheme change remounts every
     * component through {@link TranscriptReconciler.reset} anyway.
     */
    readonly scheme: () => TerminalColorScheme;
    /** Preferred assistant-body renderer and its one-shot failure report. */
    readonly markdown: MarkdownPolicy;
    /** Collapsed-preview budget for card bodies. */
    readonly maxToolOutputLines: number;
    /** Edit-distance budget before a diff falls back to whole-side rows. */
    readonly maxDiffEditLength: number;
    /** The session log, read by each step's timing footer. */
    readonly events: () => readonly SessionEvent[];
    /** Shared per-step timing accumulator. */
    readonly tracker: StepTimingTracker;
    /** Render clock. */
    readonly now: () => number;
    /** Tool definition lookup, so a card can use the tool's own presenters. */
    readonly toolDefinition: (name: string) => ToolDefinition | undefined;
    /** Workspace directory a collapsed group's file hint is shortened against. */
    readonly cwd: string;
    /**
     * The label of the key that currently cycles tool cards, read per render.
     * `app.tools.cycle` is rebindable, so the two rows that offer to expand — the
     * collapsed group's hint and a card's folded XML body — have to name whatever
     * the manager resolved rather than the shipped default.
     */
    readonly expandKey: () => string;
}
/** The keyed reconciler over one chat container. */
export declare class TranscriptReconciler {
    private readonly chat;
    private readonly deps;
    private readonly views;
    /** Process-local row groups keyed by the node count they were appended after. */
    private readonly locals;
    /** Nodes before this index are not rendered (`/clear` hides history). */
    private hiddenBefore;
    /**
     * Steps `/clear` hid while they were still open, so the calls they request
     * after the cut are hidden with them. Read live: `toolCalls` keeps growing on
     * the same node object as the step runs on.
     */
    private hiddenSteps;
    /** The last reconciled node list, so a view-state change can re-place it. */
    private nodes;
    private nodeCount;
    private visibility;
    /** The deployment's master switch: false means no step ever renders thinking. */
    private readonly showReasoning;
    /** Ctrl+T: whether a finished step keeps its thinking block on screen. */
    private thinkingPinned;
    /** The open step's component, so an animation tick refreshes only that step. */
    private openStep;
    /**
     * The collapsed row whose thinking is still open, refreshed on the same tick:
     * its duration counts up against the clock, not against the node list, so no
     * snapshot is due while the model is thinking between two events.
     */
    private openGroup;
    /** Wall time of every turn in the log, for the per-turn completion row. */
    private readonly turnDurations;
    /**
     * One completion row per turn, built once the turn ends. Held rather than
     * rebuilt so the sampled verb — and with it the row's wording — stays put
     * across the re-renders every later snapshot triggers.
     */
    private readonly turnFooters;
    /**
     * The verb each turn's row was worded with, kept apart from the rows.
     *
     * A palette change remounts every row, and a re-sample there would reword
     * turns the user already read — the wording is a property of the turn, not of
     * the row that happens to be mounted for it.
     */
    private readonly turnVerbs;
    constructor(chat: Container, deps: TranscriptDeps, view: {
        readonly showReasoning: boolean;
        readonly visibility: ToolCardVisibility;
        readonly thinkingPinned?: boolean;
    });
    /**
     * Rebuild the chat container from a folded node list.
     * @param nodes - the snapshot's nodes, in log order.
     */
    reconcile(nodes: readonly ChatNode[]): void;
    /**
     * Append process-local rows (command output, notices, diagnostics) after the
     * transcript's current tail.
     *
     * The caller supplies a builder rather than components so the rows survive a
     * palette swap: {@link TranscriptReconciler.reset} re-runs it under the new
     * palette instead of dropping the answer the user is still reading. The
     * builder must therefore read the palette it paints with at call time (the
     * entry's palette object is mutated in place), not close over pre-styled text.
     * @param build - Builds this group's rows, in render order.
     */
    appendLocal(build: () => Component[]): void;
    /**
     * Hide every row rendered so far (`/clear`). The session log is unchanged, so
     * later nodes keep folding onto the same model; only this view is truncated.
     *
     * A step the cut hides takes its whole output with it, including the tool
     * cards it has not requested yet: those fold at indices below the cut and
     * would otherwise render with no message and no timing footer above them.
     * Only a step still open at the cut can do that — a closed step logged every
     * one of its calls before its `step/end`.
     */
    clearTranscript(): void;
    /**
     * Drop every mounted component so the next reconcile rebuilds them — the
     * palette and Markdown theme are captured at construction, so a color-scheme
     * change has to remount.
     *
     * Process-local rows are rebuilt here rather than dropped. They have no node
     * to be re-derived from, so clearing them (as this did) threw away every
     * command result and notice on screen the first time the terminal reported a
     * scheme — the answer to the command the user had just run disappeared, and
     * nothing brought it back. Each group's builder re-runs under the palette
     * that is current now, which is the same remount every other row gets.
     */
    reset(): void;
    /**
     * Set the Ctrl+O card visibility on every mounted card.
     *
     * A tool card and an assistant step both carry the phase — the step's
     * finished thinking and its timing footer are on screen only where the tool
     * bodies are. A context card has no collapsed form, so the reconcile below is
     * what mounts it on the expanded phase and drops it again on the other two.
     * @param visibility - hidden, collapsed preview, or full body.
     */
    setVisibility(visibility: ToolCardVisibility): void;
    /**
     * Pin or unpin thinking blocks on every mounted assistant step (Ctrl+T).
     *
     * Applied to the mounted components rather than through a remount, so the
     * open step keeps streaming into the same component and the rows above it
     * keep their positions while history gains or loses its asides.
     * @param pinned - whether a finished step keeps its thinking on screen.
     */
    setThinkingPinned(pinned: boolean): void;
    /**
     * Refresh the two rows whose text moves with the clock rather than with the
     * log — the open step's timing footer and the collapsed row of a group that
     * is still thinking — for the status animation tick. Only those components
     * are invalidated, so a long transcript is not re-rendered 20 times a second.
     */
    invalidateOpenStep(): void;
    /**
     * One turn's completion row, or `undefined` when that turn prints none.
     *
     * This is Claude Code's only timing report on the transcript: one dim
     * `✻ <verb> for <duration>` at the end of a turn, and only for a turn that
     * ran longer than {@link TURN_FOOTER_MIN_MS} — a turn the user watched
     * complete needs no receipt. It renders on every phase of the Ctrl+O cycle,
     * because unlike the per-step breakdown it is part of the conversation.
     * @param turn - The turn index to report.
     * @returns The mounted row, or `undefined` while the turn is open or short.
     */
    private turnFooter;
    /** Whether one call belongs to a step `/clear` hid while it was open. */
    private isHiddenCall;
    /** Palette role for a notice tone. */
    private tone;
    /** Mount or reuse a component that never updates after creation. */
    private plainView;
    /**
     * Build one user turn: the filled prompt block, under a `Steering` badge when
     * the turn interrupted a running one. Claude Code's block names no role, so
     * an ordinary prompt carries no label at all and the badge is the exception
     * that says this text reached the model mid-answer.
     */
    private userView;
    /** Mount or update one assistant step, keeping its streamed buffer in sync. */
    private assistantView;
    /**
     * Mount or update one collapsed read/search row. The row is a component
     * rather than a rebuilt text line so a running group's counts can be pushed
     * into it every snapshot without re-wrapping the rows it already computed.
     */
    private groupView;
    /**
     * Mount or update one tool card. The card captures its parsed arguments (its
     * presenter reads them), so a call whose raw arguments changed after the card
     * was built is remounted rather than patched.
     */
    private toolView;
}

/**
 * Claude Code's permission prompt: the dialog an interactive answerer shows when
 * the approval seam asks whether one tool call may run.
 *
 * The frame is Claude Code's own — a rounded TOP edge only
 * (`╭─ Permission required ─…─╮`) with no side rules, so the prompt reads as a
 * banner over the transcript rather than as a boxed form — painted in the fixed
 * permission tone (rgb(177,185,249)) the product uses for every permission
 * surface. The answer list is the `❯`-cursor Select shape the rest of the TUI
 * uses, with number shortcuts that answer immediately.
 *
 * The dialog decides nothing on its own: it reports one {@link ApprovalDecision}
 * and leaves closing the overlay, auditing, and the `'cancelled'`/`'unavailable'`
 * outcomes to the front door that opened it — along with the two answers the
 * approval protocol cannot express, remembering a session grant and delivering
 * rejection feedback to the agent.
 * @module @deepseek-ai/dsh-tui/components/approval
 */
import { type Component, type Focusable } from '@earendil-works/pi-tui';
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval';
import type { Palette } from './theme.ts';
/**
 * What the user answered, in the two outcomes a person can produce. The
 * remaining {@link ApprovalOutcome} members are decided without them:
 * `'cancelled'` when the request is withdrawn, `'unavailable'` when no answerer
 * ever saw it.
 *
 * Both extras are the dialog's alone to report and the front door's alone to
 * honour, because the approval seam carries neither: rc.6's vocabulary has no
 * `allow-always` and its `approval/decided` event has no room for user text
 * (`@deepseek-ai/dsh-user-approval` README, "Only one-shot grants exist"). A
 * remembered grant is therefore a terminal-side allow list, and feedback is a
 * user turn delivered beside the refusal — never a fifth outcome smuggled into
 * the protocol.
 */
export type ApprovalDecision = {
    readonly outcome: Extract<ApprovalOutcome, 'allowed-once'>;
    /** Whether every later ask about this tool in this session is granted too. */
    readonly remember: boolean;
} | {
    readonly outcome: Extract<ApprovalOutcome, 'rejected'>;
    /** What the user told the agent to do instead; absent for a bare refusal. */
    readonly feedback?: string;
};
/**
 * One pending decision as the dialog presents it: the request's presentation
 * fields only, so the component holds no live agent, session, or signal.
 */
export interface ApprovalPrompt {
    /** The tool the question is about. */
    readonly toolName: string;
    /** The exact tool call being decided, when the asker had one. */
    readonly callId?: string;
    /** The asker's human-readable explanation of why it is asking. */
    readonly reason?: string;
}
/**
 * Inline dialog for one approval request: a tool identity, the asker's reason,
 * and the four answers. `Esc` (and `Ctrl+C`) reject, because a permission prompt
 * that is dismissed must fail closed.
 *
 * The refusal-with-feedback row swaps the answer list for a one-line editor
 * rather than opening a second surface: the request is still unanswered while
 * the user types, so the prompt must keep owning the single inline slot the
 * front door gave it. `Esc` there goes back to the list — the only place in
 * this dialog where `Esc` does not refuse — because a user who opened the box
 * by mistake has not decided anything yet.
 */
export declare class ApprovalDialog implements Component, Focusable {
    private readonly prompt;
    private readonly palette;
    private readonly done;
    private selectedIndex;
    private decided;
    /** Whether the feedback editor has replaced the answer list. */
    private feedback;
    private readonly input;
    focused: boolean;
    constructor(prompt: ApprovalPrompt, palette: Palette, done: (decision: ApprovalDecision) => void);
    invalidate(): void;
    handleInput(data: string): void;
    render(width: number): string[];
    /** The answer list, cursor on the selected row. */
    private renderOptions;
    /** The feedback editor and its two keys, in place of the answer list. */
    private renderFeedback;
    /** Answer with the option at `index`; an out-of-range index cannot occur. */
    private choose;
    /** Report the decision exactly once: a settled dialog is already closing. */
    private settle;
}

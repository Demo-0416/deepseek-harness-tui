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
import type { FileDiff } from '@deepseek-ai/dsh-tools';
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
    /** How far past this one ask the grant reaches; absent grants only this ask. */
    readonly remember?: ApprovalGrant;
} | {
    readonly outcome: Extract<ApprovalOutcome, 'rejected'>;
    /** What the user told the agent to do instead; absent for a bare refusal. */
    readonly feedback?: string;
};
/**
 * How far a remembered grant reaches, in the two scopes the front door can
 * honour: this terminal's process, or this project across processes.
 *
 * The project scope is the durable one — it becomes a rule in
 * `$DSH_HOME/approvals.json` (`chat/approval-rules.ts`) that outlives the
 * window. With `prefix` present the rule is about matching COMMANDS rather
 * than the whole tool, which is the only durable grant a command carries: a
 * bare "allow every `bash` in this project forever" is the blanket Claude Code
 * refuses to write from a dialog, and so does this one.
 */
export type ApprovalGrant = 
/** Every later ask about this tool while this process lives. */
{
    readonly scope: 'session';
}
/** Every later ask about this tool, or about commands matching `prefix`, in this project. */
 | {
    readonly scope: 'project';
    readonly prefix?: string;
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
    /**
     * The command this call would run, when the tool presents itself as a
     * terminal. Present only for a shell: it is what the editable prefix row is
     * built from.
     */
    readonly command?: string;
    /**
     * Where that command would run, and only when it is NOT this project: the
     * directory is a call argument the model chooses, and `npm test` in a
     * repository the user never opened is a different program.
     */
    readonly commandCwd?: string;
    /**
     * The edits this call would make, when the tool presents itself as a diff.
     * Derived from the call's ARGUMENTS by the tool's own presenter, so this is
     * the pending change and never the file on disk.
     */
    readonly diffs?: readonly FileDiff[];
    /**
     * The sandbox mode this ask would widen to, when the request is an
     * escalation rather than an ordinary permission question. Named on the
     * durable row, because "don't ask again" then means "don't ask again about
     * running with THAT much of the machine".
     */
    readonly access?: string;
}
/** Rendering budgets the front door knows and the dialog does not. */
export interface ApprovalLimits {
    /** Changed-line budget for one file's comparison; beyond it the preview is approximate. */
    readonly maxDiffEditLength?: number;
    /** Rows the overlay will show before it clips; the preview shrinks to fit under it. */
    readonly maxHeight?: number;
}
/**
 * Inline dialog for one approval request: a tool identity, the asker's reason,
 * the change it would make when it makes one, the four answers, and the durable
 * grant under them. `Esc` (and `Ctrl+C`) reject, because a permission prompt
 * that is dismissed must fail closed.
 *
 * The refusal-with-feedback row and the editable command rule both swap the
 * answer list for a one-line editor rather than opening a second surface: the
 * request is still unanswered while the user types, so the prompt must keep
 * owning the single inline slot the front door gave it. `Esc` in either editor
 * goes back to the list — the only place in this dialog where `Esc` does not
 * refuse — because a user who opened the box by mistake has not decided
 * anything yet.
 */
export declare class ApprovalDialog implements Component, Focusable {
    private readonly prompt;
    private readonly palette;
    private readonly done;
    private readonly limits;
    private selectedIndex;
    private decided;
    /** Which surface owns the keyboard: the answer list, or one of the two editors. */
    private mode;
    private readonly input;
    /**
     * Last preview render, kept because parsing a diff is the one expensive thing
     * this dialog does and nothing but the geometry can change it: the prompt's
     * edits are fixed for the life of the prompt.
     */
    private diffCache;
    focused: boolean;
    constructor(prompt: ApprovalPrompt, palette: Palette, done: (decision: ApprovalDecision) => void, limits?: ApprovalLimits);
    invalidate(): void;
    handleInput(data: string): void;
    render(width: number): string[];
    /**
     * The rows this prompt offers: the four fixed answers, then the durable
     * grant — which for a shell is a command rule and for everything else is the
     * whole tool.
     *
     * The durable row is APPENDED rather than slotted next to its session
     * sibling on purpose. Digits answer a permission prompt, and a user who has
     * learned that `4` refuses must not find that a new row silently moved the
     * refusal under their finger.
     *
     * A shell gets no "allow every `bash` in this project" row at all: the
     * durable grant a terminal tool may have is about the COMMANDS it runs, and
     * a command an allow rule could never match — a compound line, a bare
     * wrapper — leaves the prompt with the four answers it has always had rather
     * than offering a rule that would be stored and never fire.
     *
     * That invariant is enforced by what the prompt KNOWS rather than by a list
     * of shell names. A whole-tool row is offered only where the request proved
     * it is about files (it carries the change it would make); a request that
     * proved nothing — a background command whose presenter drew a plain card,
     * a call this terminal never logged, arguments that would not parse — gets
     * no durable row at all. Guessing "not a shell" from the absence of a
     * command is how `bash` ends up with a permanent blanket grant that no
     * compound-command check ever sees again.
     * @returns the rows in display order; the index of each is its digit minus one.
     */
    private options;
    /**
     * The whole-tool row's label. An escalation names the access it would stop
     * asking about: "don't ask again for `edit` in this project" is a promise
     * about this repository, and the asks it would silence are the ones about
     * leaving it.
     * @param toolName - the tool the row is about, already display-safe.
     * @returns the row's text.
     */
    private projectLabel;
    /**
     * The command-rule row's label, naming the rule it would store and, for an
     * escalation, the access that rule is bound to.
     * @param suggestion - the rule the editor will open on.
     * @returns the row's text.
     */
    private prefixLabel;
    /**
     * The rule the editor opens on: the prefix this command suggests, or the
     * command itself when it names no useful one.
     *
     * The whole command is offered as an EXACT rule rather than widened into a
     * prefix — a wrapper (`sudo …`) or an environment assignment names nothing a
     * prefix could safely cover, and a rule that matches one line is still worth
     * storing.
     * @returns the pre-filled rule, or `undefined` when this call has none to offer.
     */
    private suggestion;
    /**
     * The pending edit, as the hunks it would apply — the one thing a written
     * file's permission prompt cannot ask about without showing: "allow `edit`?"
     * is not a question anybody can answer, and the answer only exists once the
     * old→new change is on screen.
     *
     * The change shown is the call's own (the tool derived it from the
     * arguments), so nothing here reads the disk, and a prompt that arrives
     * without one renders exactly as it did before there was a preview.
     * @param inner - Body width in columns.
     * @param headRows - Rows the heading and reason already spent.
     * @returns the preview rows, hunk rows marked `fitted`; empty when there is nothing to show.
     */
    private renderDiffPreview;
    /**
     * The preview, laid out inside a fixed number of screen rows.
     *
     * The first file gets the hunks and everything after it gets a name and a
     * count: a call that rewrites five files would otherwise spend the whole
     * prompt on the first of them, and what the user needs from the rest is the
     * fact that they are being changed at all. Files past what the height can
     * even name are counted in one line, so a ten-file call cannot push the
     * answers off screen either.
     * @param diffs - The pending changes.
     * @param inner - Body width in columns.
     * @param budget - Screen rows the whole preview may occupy.
     * @returns the preview rows, never more than `budget` of them.
     */
    private buildDiffPreview;
    /**
     * One file's change, in at most `budget` rows: its path, then its hunks, or
     * just its counts when the hunks do not fit or the body is too narrow to
     * carry the unified gutter.
     * @param diff - The file's pending change.
     * @param inner - Body width in columns.
     * @param budget - Screen rows this file may occupy.
     * @param maxEditLength - Changed-line budget for the comparison.
     * @returns the file's rows.
     */
    private renderFileDiff;
    /**
     * The hunks, fitted to a row count rather than a line count.
     *
     * The unified layout answers in SCREEN rows: one changed line becomes two or
     * three of them once it is longer than the code column, which is the normal
     * case on a wide terminal. So the render is re-costed and retried with fewer
     * lines until it fits — the alternative is a prompt whose answers the overlay
     * clipped away.
     * @param parsed - The file's parsed diff.
     * @param inner - Body width in columns.
     * @param budget - Screen rows the hunks may occupy.
     * @param language - Highlighting language for the file, when it has one.
     * @returns the hunk rows, or none when not even one line fits.
     */
    private renderHunks;
    /** One file's name, as its own row. */
    private pathRow;
    /** One file's change counts, as its own row. */
    private summaryRow;
    /**
     * Screen rows the preview can afford: whatever the overlay's height has left
     * once the frame, the reason, and the answers are paid for.
     *
     * The overlay clips from the BOTTOM, so a preview that overruns takes the
     * answer rows with it — a permission prompt nobody can answer. Without a
     * stated height (a component test, a caller that does not clip) the full
     * allowance applies.
     * @param headRows - Rows the heading, the reason, and the directory line already spent.
     * @returns the row budget, possibly zero.
     */
    private previewBudget;
    /** The answer list, or whichever editor has replaced it. */
    private renderBody;
    /** The answer list, cursor on the selected row. */
    private renderOptions;
    /** The feedback editor and its two keys, in place of the answer list. */
    private renderFeedback;
    /**
     * The rule editor, in place of the answer list. Same shape as the feedback
     * box, because it is the same bargain: one line, `Enter` commits, `Esc` puts
     * the answers back.
     */
    private renderPrefixEditor;
    /** Answer with the option at `index`; an out-of-range index cannot occur. */
    private choose;
    /** Report the decision exactly once: a settled dialog is already closing. */
    private settle;
}

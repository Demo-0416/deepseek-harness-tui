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

import {
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
} from '@earendil-works/pi-tui'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { displayInlineText, displayText } from './text.ts'
import type { Palette } from './theme.ts'
import { CLAUDE_COLORS, fg as paintFg } from '../render/palette.ts'

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
export type ApprovalDecision =
  | {
    readonly outcome: Extract<ApprovalOutcome, 'allowed-once'>
    /** Whether every later ask about this tool in this session is granted too. */
    readonly remember: boolean
  }
  | {
    readonly outcome: Extract<ApprovalOutcome, 'rejected'>
    /** What the user told the agent to do instead; absent for a bare refusal. */
    readonly feedback?: string
  }

/**
 * One pending decision as the dialog presents it: the request's presentation
 * fields only, so the component holds no live agent, session, or signal.
 */
export interface ApprovalPrompt {
  /** The tool the question is about. */
  readonly toolName: string
  /** The exact tool call being decided, when the asker had one. */
  readonly callId?: string
  /** The asker's human-readable explanation of why it is asking. */
  readonly reason?: string
}

/** What answering one row does, before the tool name is folded into its label. */
type ApprovalAction =
  /** Grant this request only. */
  | 'allow-once'
  /** Grant this request and every later ask about the same tool this session. */
  | 'allow-session'
  /** Refuse, then say what the agent should do instead. */
  | 'reject-with-feedback'
  /** Refuse and say nothing. */
  | 'reject'

/** One answer row: what it does and the label Claude Code gives it. */
interface ApprovalOption {
  readonly action: ApprovalAction
  /** Built per prompt because two rows name the tool they are about. */
  readonly label: (toolName: string) => string
}

/**
 * The answer rows, in Claude Code's order: allow once, allow for the session,
 * then the refusals — narrowest grant first, so the safe answer is the one the
 * cursor already sits on.
 *
 * Claude Code hides "and tell Claude what to do differently" behind `Tab` on
 * the refusal row. Here it is a row of its own: this terminal has no hover, no
 * placeholder text, and no second chance to advertise a modifier, so an
 * affordance that is not on the list is an affordance nobody finds.
 */
const APPROVAL_OPTIONS: readonly ApprovalOption[] = [
  { action: 'allow-once', label: () => 'Yes, allow once' },
  { action: 'allow-session', label: toolName => `Yes, and don't ask again for ${toolName} this session` },
  { action: 'reject-with-feedback', label: () => 'No, and tell the agent what to do differently' },
  { action: 'reject', label: () => 'No, reject' },
]

/** The label in the dialog's top edge. */
const APPROVAL_TITLE = 'Permission required'

/** The prompt above the feedback box, in the refusal's own words. */
const FEEDBACK_PROMPT = 'Tell the agent what to do differently:'

/**
 * Paint text in the fixed permission tone, or leave it bare when the palette has
 * color disabled. A colorless palette makes every role the identity function, so
 * `bold` carrying no escape is what tells the two apart.
 */
function permissionAccent(palette: Palette, text: string): string {
  return palette.bold('x') === 'x' ? text : paintFg(CLAUDE_COLORS.permission, text)
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
export class ApprovalDialog implements Component, Focusable {
  private selectedIndex = 0
  private decided = false
  /** Whether the feedback editor has replaced the answer list. */
  private feedback = false
  private readonly input = new Input()
  focused = false

  constructor(
    private readonly prompt: ApprovalPrompt,
    private readonly palette: Palette,
    private readonly done: (decision: ApprovalDecision) => void,
  ) {
    // An empty box submits a bare refusal instead of trapping the user in a
    // surface they can only leave by typing: the answer was already "no", and
    // the text is the optional part.
    this.input.onSubmit = (value) => {
      const text = value.trim()
      this.settle({ outcome: 'rejected', ...text === '' ? {} : { feedback: text } })
    }
    this.input.onEscape = () => {
      this.feedback = false
      this.input.setValue('')
    }
  }

  invalidate(): void {
    this.input.invalidate()
  }

  handleInput(data: string): void {
    // Fail closed from anywhere, editor included: `Ctrl+C` on a permission
    // prompt means "get me out", and the only safe exit is a refusal.
    if (matchesKey(data, Key.ctrl('c'))) {
      this.settle({ outcome: 'rejected' })
      return
    }
    if (this.feedback) {
      this.input.focused = this.focused
      this.input.handleInput(data)
      this.invalidate()
      return
    }
    if (matchesKey(data, Key.up)) {
      this.selectedIndex = this.selectedIndex === 0 ? APPROVAL_OPTIONS.length - 1 : this.selectedIndex - 1
      return
    }
    if (matchesKey(data, Key.down)) {
      this.selectedIndex = this.selectedIndex === APPROVAL_OPTIONS.length - 1 ? 0 : this.selectedIndex + 1
      return
    }
    if (matchesKey(data, Key.enter)) {
      this.choose(this.selectedIndex)
      return
    }
    if (matchesKey(data, Key.escape)) {
      this.settle({ outcome: 'rejected' })
      return
    }
    // Number shortcuts answer immediately, the way Claude Code's permission
    // prompt does: the list is short enough that a digit IS the decision.
    const shortcut = APPROVAL_OPTIONS.findIndex((_option, index) => data === String(index + 1))
    if (shortcut >= 0) {
      this.selectedIndex = shortcut
      this.choose(shortcut)
    }
  }

  render(width: number): string[] {
    const outer = Math.max(8, width)
    // Claude Code's permission frame draws its top edge only; the body is padded
    // by one column on each side instead of being ruled.
    const inner = Math.max(1, outer - 2)
    const head = `─ ${APPROVAL_TITLE} `
    const top = permissionAccent(
      this.palette,
      `╭${head}${'─'.repeat(Math.max(0, outer - 2 - visibleWidth(head)))}╮`,
    )
    const callId = this.prompt.callId
    const heading = `${this.palette.bold(displayInlineText(this.prompt.toolName))}${
      callId === undefined || callId === '' ? '' : ` ${this.palette.dim(displayInlineText(callId))}`}`
    const body: string[] = [...wrapTextWithAnsi(heading, inner)]
    const reason = this.prompt.reason
    if (reason !== undefined && reason !== '') {
      body.push(...wrapTextWithAnsi(this.palette.text(displayText(reason)), inner))
    }
    body.push('')
    for (const line of this.feedback ? this.renderFeedback(inner) : this.renderOptions()) body.push(line)
    return ['', top, ...body.map(row => row === '' ? '' : ` ${truncateToWidth(row, inner, '…')}`)]
  }

  /** The answer list, cursor on the selected row. */
  private renderOptions(): string[] {
    const toolName = displayInlineText(this.prompt.toolName)
    return APPROVAL_OPTIONS.map((option, index) => {
      const selected = index === this.selectedIndex
      // `Esc` is advertised on the row it performs, the way Claude Code marks
      // the refusal, so the shortcut needs no separate hint row.
      const suffix = option.action === 'reject' ? ' (esc)' : ''
      const row = `${selected ? '❯' : ' '} ${index + 1}. ${option.label(toolName)}${suffix}`
      return selected ? this.palette.bold(permissionAccent(this.palette, row)) : row
    })
  }

  /** The feedback editor and its two keys, in place of the answer list. */
  private renderFeedback(inner: number): string[] {
    this.input.focused = this.focused
    return [
      this.palette.text(FEEDBACK_PROMPT),
      ...this.input.render(inner),
      this.palette.dim('Enter reject with this feedback • Esc back to the answers'),
    ]
  }

  /** Answer with the option at `index`; an out-of-range index cannot occur. */
  private choose(index: number): void {
    const option = APPROVAL_OPTIONS[index]
    /* v8 ignore next -- every caller derives `index` from APPROVAL_OPTIONS itself. */
    if (option === undefined) return
    switch (option.action) {
      case 'allow-once': {
        this.settle({ outcome: 'allowed-once', remember: false })
        return
      }
      case 'allow-session': {
        this.settle({ outcome: 'allowed-once', remember: true })
        return
      }
      case 'reject-with-feedback': {
        this.feedback = true
        this.invalidate()
        return
      }
      case 'reject': {
        this.settle({ outcome: 'rejected' })
      }
    }
  }

  /** Report the decision exactly once: a settled dialog is already closing. */
  private settle(decision: ApprovalDecision): void {
    if (this.decided) return
    this.decided = true
    this.done(decision)
  }
}

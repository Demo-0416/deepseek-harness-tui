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
 * outcomes to the front door that opened it.
 * @module @deepseek-ai/dsh-tui/components/approval
 */

import {
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
 * The outcomes this dialog can produce. The remaining {@link ApprovalOutcome}
 * members are decided without the user: `'cancelled'` when the request is
 * withdrawn, `'unavailable'` when no answerer ever saw it.
 */
export type ApprovalDecision = Extract<ApprovalOutcome, 'allowed-once' | 'rejected'>

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

/** One answer row: its decision and the label Claude Code gives it. */
interface ApprovalOption {
  readonly decision: ApprovalDecision
  readonly label: string
}

/** The answer rows, in Claude Code's order: the grant first, the refusal second. */
const APPROVAL_OPTIONS: readonly ApprovalOption[] = [
  { decision: 'allowed-once', label: 'Yes, allow once' },
  { decision: 'rejected', label: 'No, reject' },
]

/** The label in the dialog's top edge. */
const APPROVAL_TITLE = 'Permission required'

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
 * and the two answers. `Esc` (and `Ctrl+C`) reject, because a permission prompt
 * that is dismissed must fail closed.
 */
export class ApprovalDialog implements Component, Focusable {
  private selectedIndex = 0
  private decided = false
  focused = false

  constructor(
    private readonly prompt: ApprovalPrompt,
    private readonly palette: Palette,
    private readonly done: (decision: ApprovalDecision) => void,
  ) {}

  invalidate(): void {}

  handleInput(data: string): void {
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
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c'))) {
      this.settle('rejected')
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
    for (const [index, option] of APPROVAL_OPTIONS.entries()) {
      const selected = index === this.selectedIndex
      // `Esc` is advertised on the row it performs, the way Claude Code marks
      // the refusal, so the shortcut needs no separate hint row.
      const suffix = option.decision === 'rejected' ? ' (esc)' : ''
      const row = `${selected ? '❯' : ' '} ${index + 1}. ${option.label}${suffix}`
      body.push(selected ? this.palette.bold(permissionAccent(this.palette, row)) : row)
    }
    return ['', top, ...body.map(row => row === '' ? '' : ` ${truncateToWidth(row, inner, '…')}`)]
  }

  /** Answer with the option at `index`; an out-of-range index cannot occur. */
  private choose(index: number): void {
    const option = APPROVAL_OPTIONS[index]
    /* v8 ignore next -- every caller derives `index` from APPROVAL_OPTIONS itself. */
    if (option === undefined) return
    this.settle(option.decision)
  }

  /** Report the decision exactly once: a settled dialog is already closing. */
  private settle(decision: ApprovalDecision): void {
    if (this.decided) return
    this.decided = true
    this.done(decision)
  }
}

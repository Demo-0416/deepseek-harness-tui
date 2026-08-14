/**
 * The step surface `/login` and `/provider add` share: one inline dialog whose
 * content is swapped as the flow advances, rather than one overlay per step.
 *
 * Swapping beats reopening for a reason the user can see: an overlay closing
 * and another opening in the editor slot flashes the transcript up and down on
 * every step, and a queued modal behind it would win the slot in between. One
 * dialog that outlives the whole flow also gives the flow one place to cancel
 * from, so Esc means the same thing on every step.
 * @module @deepseek-ai/dsh-tui/components/provider-dialog
 */

import {
  Key,
  matchesKey,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
} from '@earendil-works/pi-tui'
import {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  displayInlineText,
  displayText,
  sanitizePastedText,
} from './text.ts'
import { renderDialog } from './dialogs.ts'
import type { Palette } from './theme.ts'

/** One row a select or checklist step offers. */
export interface ProviderWizardItem {
  /** Value handed back when this row is taken. */
  readonly value: string
  /** Row label. */
  readonly label: string
  /** Right-hand detail, when the row has any. */
  readonly description?: string
  /** Group heading printed above this row; repeated headings print once. */
  readonly group?: string
}

/** Pick exactly one row. */
export interface ProviderWizardSelect {
  readonly kind: 'select'
  readonly title: string
  /** Context printed above the list. */
  readonly lines?: readonly string[]
  readonly items: readonly ProviderWizardItem[]
  /** Row selected when the step opens. */
  readonly initial?: string
  readonly onPick: (value: string) => void
}

/** Type one value. */
export interface ProviderWizardText {
  readonly kind: 'text'
  readonly title: string
  readonly lines?: readonly string[]
  /** What to type, in the imperative. */
  readonly prompt: string
  /** Whether the value is a secret, which decides whether it is ever echoed. */
  readonly secret?: boolean
  /** Value the field opens with. */
  readonly initial?: string
  /** Reject a value with a reason, or return undefined to accept it. */
  readonly refuse?: (value: string) => string | undefined
  readonly onSubmit: (value: string) => void
}

/** Tick any number of rows. */
export interface ProviderWizardChecklist {
  readonly kind: 'checklist'
  readonly title: string
  readonly lines?: readonly string[]
  readonly items: readonly ProviderWizardItem[]
  /** Rows ticked when the step opens. */
  readonly initial?: readonly string[]
  readonly onSubmit: (values: readonly string[]) => void
}

/** One step of a provider flow. */
export type ProviderWizardStep =
  | ProviderWizardSelect
  | ProviderWizardText
  | ProviderWizardChecklist

/** Longest run of dots an entry field draws, so a pasted key cannot wrap the dialog. */
const MAX_SECRET_DOTS = 32

/**
 * The step dialog both provider flows drive.
 *
 * The component owns presentation and key handling; every decision about what
 * comes next belongs to the controller that calls {@link setStep}. That split
 * is what lets the flows differ (one re-keys a route, the other builds one)
 * while looking and behaving identically.
 */
export class ProviderWizard implements Component, Focusable {
  private step: ProviderWizardStep
  private cursor = 0
  private ticked = new Set<string>()
  private value = ''
  private pasting = false
  private refusal = ''
  private status = ''
  private busy = false
  focused = false

  constructor(
    initial: ProviderWizardStep,
    private readonly maxVisible: number,
    private readonly palette: Palette,
    private readonly cancel: () => void,
    private readonly redraw: () => void,
  ) {
    this.step = initial
    this.adoptStep(initial)
  }

  /**
   * Show a different step.
   *
   * Every per-step state is reset here rather than by the caller, so a flow
   * cannot leak a half-typed value or a stale refusal into the next question.
   * @param step - the step to show.
   */
  setStep(step: ProviderWizardStep): void {
    this.step = step
    this.adoptStep(step)
    this.redraw()
  }

  /**
   * Hold the dialog while the flow waits on something slow.
   *
   * The step stays on screen underneath: a probe that replaced the form with a
   * spinner would leave the user unable to see what they had entered when it
   * failed.
   * @param message - what the flow is doing, in the present tense; empty clears it.
   */
  setStatus(message: string): void {
    this.status = message
    this.busy = message !== ''
    this.redraw()
  }

  /** Show a refusal above the control without disturbing what was typed. */
  setRefusal(message: string): void {
    this.refusal = message
    this.redraw()
  }

  private adoptStep(step: ProviderWizardStep): void {
    this.refusal = ''
    this.status = ''
    this.busy = false
    this.value = step.kind === 'text' ? step.initial ?? '' : ''
    this.ticked = new Set(step.kind === 'checklist' ? step.initial ?? [] : [])
    this.cursor = 0
    if (step.kind === 'select' && step.initial !== undefined) {
      const index = step.items.findIndex(item => item.value === step.initial)
      if (index >= 0) this.cursor = index
    }
  }

  invalidate(): void {
    // Every line is rebuilt from the step on each render, so there is nothing
    // cached to drop; the method is the Component contract's, not a no-op by
    // oversight.
  }

  handleInput(data: string): void {
    // Cancelling is answered even mid-probe: a flow waiting on an endpoint that
    // never answers must still be escapable, and the controller aborts the
    // probe rather than letting it write behind a closed dialog.
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c'))) {
      this.cancel()
      return
    }
    if (this.busy) return
    if (this.step.kind === 'text') {
      this.handleTextInput(data, this.step)
      return
    }
    this.handleListInput(data)
  }

  private handleTextInput(data: string, step: ProviderWizardText): void {
    if (data.includes(BRACKETED_PASTE_START)) this.pasting = true
    if (data.includes(BRACKETED_PASTE_END)) this.pasting = false
    const pasted = data.replaceAll(BRACKETED_PASTE_START, '').replaceAll(BRACKETED_PASTE_END, '')
    if (matchesKey(pasted, Key.enter)) {
      this.submitText(step)
      return
    }
    if (matchesKey(pasted, Key.backspace)) {
      this.value = this.value.slice(0, -1)
      this.refusal = ''
      this.redraw()
      return
    }
    if (matchesKey(pasted, Key.ctrl('u'))) {
      this.value = ''
      this.refusal = ''
      this.redraw()
      return
    }
    // A pasted key arrives as one chunk and often carries a trailing newline;
    // stripping controls rather than typing them is what keeps that from
    // submitting a value the user has not looked at yet.
    const typed = sanitizePastedText(pasted)
    if (typed === '') {
      if (this.pasting) this.redraw()
      return
    }
    this.value += typed
    this.refusal = ''
    this.redraw()
  }

  private submitText(step: ProviderWizardText): void {
    const value = step.secret === true ? this.value : this.value.trim()
    const refusal = step.refuse?.(value)
    if (refusal !== undefined) {
      this.setRefusal(refusal)
      return
    }
    step.onSubmit(value)
  }

  private handleListInput(data: string): void {
    const step = this.step
    /* v8 ignore next -- the text branch returns before this method is reached. */
    if (step.kind === 'text') return
    const count = step.items.length
    if (count === 0) return
    if (matchesKey(data, Key.up)) {
      this.cursor = this.cursor === 0 ? count - 1 : this.cursor - 1
      this.redraw()
      return
    }
    if (matchesKey(data, Key.down)) {
      this.cursor = this.cursor === count - 1 ? 0 : this.cursor + 1
      this.redraw()
      return
    }
    const current = step.items[this.cursor]
    if (current === undefined) return
    if (step.kind === 'checklist' && matchesKey(data, Key.space)) {
      if (this.ticked.has(current.value)) this.ticked.delete(current.value)
      else this.ticked.add(current.value)
      this.refusal = ''
      this.redraw()
      return
    }
    if (!matchesKey(data, Key.enter)) return
    if (step.kind === 'select') {
      step.onPick(current.value)
      return
    }
    step.onSubmit(step.items.filter(item => this.ticked.has(item.value)).map(item => item.value))
  }

  /** The slice of rows on screen, keeping the cursor inside it. */
  private windowed(count: number): { start: number; end: number } {
    const size = Math.max(1, Math.min(this.maxVisible, count))
    const start = Math.max(0, Math.min(this.cursor - Math.floor(size / 2), count - size))
    return { start, end: start + size }
  }

  render(width: number): string[] {
    const step = this.step
    const innerWidth = Math.max(1, width - 4)
    const body: string[] = []
    for (const line of step.lines ?? []) {
      body.push(...wrapTextWithAnsi(this.palette.dim(displayText(line)), innerWidth))
    }
    if (body.length > 0) body.push('')
    if (step.kind === 'text') body.push(...this.renderText(step, innerWidth))
    else body.push(...this.renderList(step, innerWidth))
    if (this.refusal !== '') {
      body.push('')
      body.push(...wrapTextWithAnsi(this.palette.error(displayText(this.refusal)), innerWidth))
    }
    if (this.status !== '') {
      body.push('')
      body.push(...wrapTextWithAnsi(this.palette.dim(displayText(this.status)), innerWidth))
    }
    body.push('')
    body.push(this.palette.dim(this.footer(step)))
    return renderDialog(step.title, body, width, this.palette)
  }

  private renderText(step: ProviderWizardText, innerWidth: number): string[] {
    const lines = wrapTextWithAnsi(this.palette.text(displayText(step.prompt)), innerWidth)
    // A secret is drawn as one dot per character and never as itself. Length is
    // the only feedback a paste needs, and it is the only feedback that cannot
    // be read off a shoulder or recovered from a scrollback buffer.
    const shown = step.secret === true
      ? '•'.repeat(Math.min(this.value.length, MAX_SECRET_DOTS))
      : displayInlineText(this.value)
    const caret = this.focused && !this.busy ? this.palette.accent('▏') : ''
    lines.push(`${this.palette.dim('> ')}${this.palette.text(shown)}${caret}`)
    return lines
  }

  private renderList(
    step: ProviderWizardSelect | ProviderWizardChecklist,
    innerWidth: number,
  ): string[] {
    if (step.items.length === 0) {
      return wrapTextWithAnsi(this.palette.dim('Nothing to choose from.'), innerWidth)
    }
    const lines: string[] = []
    const { start, end } = this.windowed(step.items.length)
    let printedGroup: string | undefined
    for (let index = start; index < end; index += 1) {
      const item = step.items[index]
      /* v8 ignore next -- the window is clamped to the item count. */
      if (item === undefined) continue
      if (item.group !== undefined && item.group !== printedGroup) {
        if (lines.length > 0) lines.push('')
        lines.push(this.palette.dim(displayInlineText(item.group)))
        printedGroup = item.group
      }
      lines.push(this.renderRow(step, item, index === this.cursor, innerWidth))
    }
    if (end - start < step.items.length) {
      lines.push(this.palette.dim(`  ${this.cursor + 1}/${step.items.length}`))
    }
    return lines
  }

  private renderRow(
    step: ProviderWizardSelect | ProviderWizardChecklist,
    item: ProviderWizardItem,
    active: boolean,
    innerWidth: number,
  ): string {
    const marker = step.kind === 'checklist'
      ? (this.ticked.has(item.value) ? '[x] ' : '[ ] ')
      : ''
    const pointer = active ? '❯ ' : '  '
    const label = `${pointer}${marker}${displayInlineText(item.label)}`
    const styled = active ? this.palette.accent(label) : this.palette.text(label)
    if (item.description === undefined) return styled
    const room = innerWidth - visibleWidth(label) - 2
    if (room < 8) return styled
    const detail = displayInlineText(item.description)
    const clipped = detail.length > room ? `${detail.slice(0, room - 1)}…` : detail
    return `${styled}  ${this.palette.dim(clipped)}`
  }

  private footer(step: ProviderWizardStep): string {
    if (this.busy) return 'Esc cancel'
    if (step.kind === 'text') return 'Enter continue · Ctrl+U clear · Esc cancel'
    if (step.kind === 'checklist') return '↑↓ move · Space tick · Enter continue · Esc cancel'
    return '↑↓ move · Enter select · Esc cancel'
  }
}

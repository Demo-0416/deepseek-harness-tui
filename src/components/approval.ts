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
import type { FileDiff } from '@deepseek-ai/dsh-tools'
import { displayInlineText, displayText } from './text.ts'
import type { Palette } from './theme.ts'
import { isCompoundCommand, suggestCommandPrefix } from '../chat/approval-rules.ts'
import { t } from '../i18n/index.ts'
import { BRAND_COLORS, fg as paintFg } from '../render/palette.ts'
import {
  diffLanguage,
  parseDiffBounded,
  renderUnified,
  summarizeDiff,
  type DiffLine,
  type ParsedDiff,
} from '../render/diff.ts'

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
    /** How far past this one ask the grant reaches; absent grants only this ask. */
    readonly remember?: ApprovalGrant
  }
  | {
    readonly outcome: Extract<ApprovalOutcome, 'rejected'>
    /** What the user told the agent to do instead; absent for a bare refusal. */
    readonly feedback?: string
  }

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
  | { readonly scope: 'session' }
  /** Every later ask about this tool, or about commands matching `prefix`, in this project. */
  | { readonly scope: 'project'; readonly prefix?: string }

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
  /**
   * The command this call would run, when the tool presents itself as a
   * terminal. Present only for a shell: it is what the editable prefix row is
   * built from.
   */
  readonly command?: string
  /**
   * Where that command would run, and only when it is NOT this project: the
   * directory is a call argument the model chooses, and `npm test` in a
   * repository the user never opened is a different program.
   */
  readonly commandCwd?: string
  /**
   * The edits this call would make, when the tool presents itself as a diff.
   * Derived from the call's ARGUMENTS by the tool's own presenter, so this is
   * the pending change and never the file on disk.
   */
  readonly diffs?: readonly FileDiff[]
  /**
   * The sandbox mode this ask would widen to, when the request is an
   * escalation rather than an ordinary permission question. Named on the
   * durable row, because "don't ask again" then means "don't ask again about
   * running with THAT much of the machine".
   */
  readonly access?: string
}

/** Rendering budgets the front door knows and the dialog does not. */
export interface ApprovalLimits {
  /** Changed-line budget for one file's comparison; beyond it the preview is approximate. */
  readonly maxDiffEditLength?: number
  /** Rows the overlay will show before it clips; the preview shrinks to fit under it. */
  readonly maxHeight?: number
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
  /** Grant this request and write a rule that outlives the process. */
  | 'allow-project'
  /** Open the editor on a command rule, then grant this request and store it. */
  | 'allow-prefix'

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
const ANSWER_OPTIONS: readonly ApprovalOption[] = [
  { action: 'allow-once', label: () => t('approval.allowOnce') },
  { action: 'allow-session', label: toolName => t('approval.allowSession', { tool: toolName }) },
  { action: 'reject-with-feedback', label: () => t('approval.rejectWithFeedback') },
  { action: 'reject', label: () => t('approval.reject') },
]

/**
 * Bracketed-paste framing. The editor pre-fills through the paste path because
 * that is the only entry point that leaves the caret after the text it just
 * inserted; `setValue` keeps the caret at column zero.
 */
const PASTE_START = '\u001b[200~'
const PASTE_END = '\u001b[201~'

/**
 * SCREEN rows the pending edit may spend — not diff lines. One changed line is
 * one row only while it fits the body: the unified layout soft-wraps a long
 * line into two rows past 120 columns and three past 180, so a budget counted
 * in diff lines is a budget that overruns exactly on the wide terminals it was
 * meant to serve. The preview is a reminder of what is about to change, not the
 * diff view — a reader who wants the whole change has the transcript card the
 * call draws once it runs.
 */
const DIFF_PREVIEW_MAX_ROWS = 12

/** Rows one file costs when it is only named and counted: its path and its summary. */
const FILE_SUMMARY_ROWS = 2

/** Rows the unified layout needs to show anything at all: its two rules and one hunk row. */
const MIN_UNIFIED_ROWS = 3

/**
 * Narrowest body a hunk row still fits in. The unified layout holds a minimum
 * code column open, so below this the gutter plus that column is wider than
 * the dialog — and a row wider than the body is a row the terminal re-wraps,
 * which is exactly how the answers get pushed off screen. Such a prompt shows
 * one summary line per file instead.
 */
const DIFF_PREVIEW_MIN_WIDTH = 30

/** The edit-distance budget assumed when the front door names none (`config.maxDiffEditLength`). */
const DEFAULT_MAX_DIFF_EDIT_LENGTH = 1000

/**
 * One row of the dialog's body. A plain string is text the frame clips to the
 * body width; a `fitted` row was built at that width already and carries its
 * own background fills and resets, so clipping it would cut a colour run in
 * half and bleed the fill across the rest of the line.
 */
type PreviewRow = string | { readonly fitted: string }

/**
 * Paint text in the fixed permission tone, or leave it bare when the palette has
 * color disabled. A colorless palette makes every role the identity function, so
 * `bold` carrying no escape is what tells the two apart.
 */
function permissionAccent(palette: Palette, text: string): string {
  return palette.bold('x') === 'x' ? text : paintFg(BRAND_COLORS.permission, text)
}

/**
 * A side's content lines under the terminator rule the diff cards also apply:
 * empty text is zero lines, a trailing newline terminates the last line, and an
 * interior blank line survives.
 */
function diffContentLines(text: string): string[] {
  if (text === '') return []
  const body = text.endsWith('\n') ? text.slice(0, -1) : text
  return body.split('\n')
}

/**
 * One file's pending change, parsed. A comparison past the edit-distance budget
 * falls back to whole-side rows (every old line removed, every new line added)
 * rather than stalling a permission prompt on a model-authored rewrite; the
 * caller labels that fallback, because its totals are not exact change counts.
 * The same shape the transcript's diff card uses, so the preview and the card
 * the call draws afterwards agree.
 * @param diff - The file's old and new text, as the tool's presenter derived them.
 * @param maxEditLength - Changed-line budget for the comparison.
 * @returns The parsed diff and whether it is the fallback.
 */
function parseFileDiff(diff: FileDiff, maxEditLength: number): { diff: ParsedDiff; approximate: boolean } {
  const oldText = displayText(diff.oldText ?? '')
  const newText = displayText(diff.newText)
  const parsed = parseDiffBounded(oldText, newText, maxEditLength)
  if (parsed !== undefined) return { diff: parsed, approximate: false }
  const oldLines = diffContentLines(oldText)
  const newLines = diffContentLines(newText)
  const lines: DiffLine[] = [
    ...oldLines.map((content, index): DiffLine => ({ type: 'del', oldNum: index + 1, newNum: null, content })),
    ...newLines.map((content, index): DiffLine => ({ type: 'add', oldNum: null, newNum: index + 1, content })),
  ]
  return {
    diff: { lines, added: newLines.length, removed: oldLines.length, chars: oldText.length + newText.length },
    approximate: true,
  }
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
export class ApprovalDialog implements Component, Focusable {
  private selectedIndex = 0
  private decided = false
  /** Which surface owns the keyboard: the answer list, or one of the two editors. */
  private mode: 'list' | 'feedback' | 'prefix' = 'list'
  private readonly input = new Input()
  /**
   * Last preview render, kept because parsing a diff is the one expensive thing
   * this dialog does and nothing but the geometry can change it: the prompt's
   * edits are fixed for the life of the prompt.
   */
  private diffCache: { width: number; budget: number; rows: PreviewRow[] } | undefined
  focused = false

  constructor(
    private readonly prompt: ApprovalPrompt,
    private readonly palette: Palette,
    private readonly done: (decision: ApprovalDecision) => void,
    private readonly limits: ApprovalLimits = {},
  ) {
    this.input.onSubmit = (value) => {
      const text = value.trim()
      if (this.mode === 'prefix') {
        // An emptied rule is the escape hatch from the editor that still
        // answers the question: allow this call and store nothing, rather than
        // writing a rule the user just deleted.
        this.settle({
          outcome: 'allowed-once',
          ...text === '' ? {} : { remember: { scope: 'project' as const, prefix: text } },
        })
        return
      }
      // An empty box submits a bare refusal instead of trapping the user in a
      // surface they can only leave by typing: the answer was already "no", and
      // the text is the optional part.
      this.settle({ outcome: 'rejected', ...text === '' ? {} : { feedback: text } })
    }
    this.input.onEscape = () => {
      this.mode = 'list'
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
    if (this.mode !== 'list') {
      this.input.focused = this.focused
      this.input.handleInput(data)
      this.invalidate()
      return
    }
    const options = this.options()
    if (matchesKey(data, Key.up)) {
      this.selectedIndex = this.selectedIndex === 0 ? options.length - 1 : this.selectedIndex - 1
      return
    }
    if (matchesKey(data, Key.down)) {
      this.selectedIndex = this.selectedIndex === options.length - 1 ? 0 : this.selectedIndex + 1
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
    const shortcut = options.findIndex((_option, index) => data === String(index + 1))
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
    const head = `─ ${t('approval.title')} `
    const top = permissionAccent(
      this.palette,
      `╭${head}${'─'.repeat(Math.max(0, outer - 2 - visibleWidth(head)))}╮`,
    )
    const callId = this.prompt.callId
    const heading = `${this.palette.bold(displayInlineText(this.prompt.toolName))}${
      callId === undefined || callId === '' ? '' : ` ${this.palette.dim(displayInlineText(callId))}`}`
    const body: PreviewRow[] = [...wrapTextWithAnsi(heading, inner)]
    const reason = this.prompt.reason
    if (reason !== undefined && reason !== '') {
      body.push(...wrapTextWithAnsi(this.palette.text(displayText(reason)), inner))
    }
    // A call that runs somewhere else says so before it is answered: the
    // directory is the difference between the command the user recognises and
    // the same words in a repository they have never seen.
    const commandCwd = this.prompt.commandCwd
    if (commandCwd !== undefined && commandCwd !== '') {
      body.push(...wrapTextWithAnsi(
        this.palette.dim(t('approval.commandCwd', { path: displayInlineText(commandCwd) })),
        inner,
      ))
    }
    // The preview sits between the reason and the answers, and is budgeted
    // against what those two have already spent: an edit is worth showing, but
    // never at the cost of the row the user has to press.
    for (const row of this.renderDiffPreview(inner, body.length)) body.push(row)
    body.push('')
    for (const line of this.renderBody(inner)) body.push(line)
    return ['', top, ...body.map((row) => {
      if (typeof row !== 'string') return ` ${row.fitted}`
      return row === '' ? '' : ` ${truncateToWidth(row, inner, '…')}`
    })]
  }

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
  private options(): readonly ApprovalOption[] {
    const command = this.prompt.command
    if (command !== undefined) {
      const suggestion = this.suggestion()
      if (suggestion === undefined) return ANSWER_OPTIONS
      return [
        ...ANSWER_OPTIONS,
        { action: 'allow-prefix', label: () => this.prefixLabel(suggestion) },
      ]
    }
    const diffs = this.prompt.diffs
    if (diffs === undefined || diffs.length === 0) return ANSWER_OPTIONS
    return [
      ...ANSWER_OPTIONS,
      { action: 'allow-project', label: toolName => this.projectLabel(toolName) },
    ]
  }

  /**
   * The whole-tool row's label. An escalation names the access it would stop
   * asking about: "don't ask again for `edit` in this project" is a promise
   * about this repository, and the asks it would silence are the ones about
   * leaving it.
   * @param toolName - the tool the row is about, already display-safe.
   * @returns the row's text.
   */
  private projectLabel(toolName: string): string {
    const access = this.prompt.access
    if (access === undefined) return t('approval.allowProject', { tool: toolName })
    return t('approval.allowProjectAccess', { tool: toolName, access: displayInlineText(access) })
  }

  /**
   * The command-rule row's label, naming the rule it would store and, for an
   * escalation, the access that rule is bound to.
   * @param suggestion - the rule the editor will open on.
   * @returns the row's text.
   */
  private prefixLabel(suggestion: string): string {
    const prefix = displayInlineText(suggestion)
    const access = this.prompt.access
    if (access === undefined) return t('approval.allowPrefix', { prefix })
    return t('approval.allowPrefixAccess', { prefix, access: displayInlineText(access) })
  }

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
  private suggestion(): string | undefined {
    const command = this.prompt.command
    if (command === undefined) return undefined
    const prefix = suggestCommandPrefix(command)
    if (prefix !== undefined) return prefix
    const exact = command.trim()
    // A compound line is the one case with no offer: no rule this store can
    // write will ever match it, so the row would be a promise the matcher
    // breaks.
    return exact === '' || isCompoundCommand(exact) ? undefined : exact
  }

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
  private renderDiffPreview(inner: number, headRows: number): readonly PreviewRow[] {
    const diffs = this.prompt.diffs
    if (diffs === undefined || diffs.length === 0) return []
    const budget = this.previewBudget(headRows)
    const cached = this.diffCache
    if (cached !== undefined && cached.width === inner && cached.budget === budget) return cached.rows
    const rows = this.buildDiffPreview(diffs, inner, budget)
    this.diffCache = { width: inner, budget, rows }
    return rows
  }

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
  private buildDiffPreview(diffs: readonly FileDiff[], inner: number, budget: number): PreviewRow[] {
    if (budget < FILE_SUMMARY_ROWS) return []
    const maxEditLength = this.limits.maxDiffEditLength ?? DEFAULT_MAX_DIFF_EDIT_LENGTH
    // How many files can be named individually and still leave the first one
    // its own path and summary.
    let named = diffs.length
    const tailRows = (): number => FILE_SUMMARY_ROWS * (named - 1) + (named < diffs.length ? 1 : 0)
    while (named > 1 && budget - tailRows() < FILE_SUMMARY_ROWS) named -= 1
    const tail: PreviewRow[] = []
    for (const diff of diffs.slice(1, named)) {
      const parsed = parseFileDiff(diff, maxEditLength)
      tail.push(this.pathRow(diff, inner), this.summaryRow(parsed.diff, inner))
    }
    const hidden = diffs.length - named
    if (hidden > 0) tail.push(this.palette.dim(t('approval.diffMoreFiles', { count: hidden })))
    const first = diffs[0]
    /* v8 ignore next -- a non-empty list has a first entry. */
    if (first === undefined) return []
    return [...this.renderFileDiff(first, inner, budget - tail.length, maxEditLength), ...tail]
  }

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
  private renderFileDiff(
    diff: FileDiff,
    inner: number,
    budget: number,
    maxEditLength: number,
  ): PreviewRow[] {
    const rows: PreviewRow[] = [this.pathRow(diff, inner)]
    if (budget < FILE_SUMMARY_ROWS) return rows
    const parsed = parseFileDiff(diff, maxEditLength)
    // The note about an approximate comparison is itself a row, and it comes
    // out of the preview's own allowance rather than out of the answers below.
    const note = parsed.approximate
      ? [this.palette.dim(t('approval.diffApproximate', { limit: maxEditLength }))]
      : []
    const forHunks = budget - 1 - note.length
    const hunks = inner < DIFF_PREVIEW_MIN_WIDTH || forHunks < MIN_UNIFIED_ROWS
      ? []
      : this.renderHunks(parsed.diff, inner, forHunks, diffLanguage(diff.path))
    if (hunks.length === 0) {
      // Room for the note only when the summary it explains fits beside it.
      if (budget - 1 >= FILE_SUMMARY_ROWS) rows.push(...note)
      rows.push(this.summaryRow(parsed.diff, inner))
      return rows
    }
    rows.push(...note, ...hunks)
    return rows
  }

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
  private renderHunks(
    parsed: ParsedDiff,
    inner: number,
    budget: number,
    language: string | undefined,
  ): PreviewRow[] {
    const total = parsed.lines.length
    let lines = Math.min(total, budget)
    while (lines >= 1) {
      const rendered = renderUnified(parsed, inner, {
        maxLines: lines,
        ...language === undefined ? {} : { language },
      })
      if (rendered.length === 0) return []
      const clipped = lines < total
      // The layout's own clip marker is English and mentions a fold this dialog
      // does not have; it is dropped for one this locale can read.
      const rows: PreviewRow[] = (clipped ? rendered.slice(0, -1) : rendered).map(row => ({ fitted: row }))
      if (clipped) rows.push(this.palette.dim(t('approval.diffClipped', { count: total - lines })))
      if (rows.length <= budget) return rows
      // Scale the retry by how far over it went rather than subtracting the
      // overrun: one line costs two or three rows at this width, so taking one
      // row off per row over would drop the preview to nothing on exactly the
      // terminals wide enough to show it well.
      lines = Math.min(lines - 1, Math.max(1, Math.floor((lines * budget) / rows.length)))
    }
    return []
  }

  /** One file's name, as its own row. */
  private pathRow(diff: FileDiff, inner: number): PreviewRow {
    return truncateToWidth(this.palette.bold(displayInlineText(diff.path)), inner, '…')
  }

  /** One file's change counts, as its own row. */
  private summaryRow(parsed: ParsedDiff, inner: number): PreviewRow {
    if (parsed.added === 0 && parsed.removed === 0) return this.palette.dim(t('approval.diffNoChanges'))
    return truncateToWidth(summarizeDiff(parsed.added, parsed.removed, inner), inner, '')
  }

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
  private previewBudget(headRows: number): number {
    const height = this.limits.maxHeight
    if (height === undefined) return DIFF_PREVIEW_MAX_ROWS
    // The frame's leading blank and its top edge, what the head already spent,
    // the blank above the answers, and the answers themselves.
    const spent = 2 + headRows + 1 + this.options().length
    return Math.max(0, Math.min(DIFF_PREVIEW_MAX_ROWS, height - spent))
  }

  /** The answer list, or whichever editor has replaced it. */
  private renderBody(inner: number): string[] {
    if (this.mode === 'feedback') return this.renderFeedback(inner)
    if (this.mode === 'prefix') return this.renderPrefixEditor(inner)
    return this.renderOptions()
  }

  /** The answer list, cursor on the selected row. */
  private renderOptions(): string[] {
    const toolName = displayInlineText(this.prompt.toolName)
    return this.options().map((option, index) => {
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
      this.palette.text(t('approval.feedbackPrompt')),
      ...this.input.render(inner),
      this.palette.dim(t('approval.feedbackHint')),
    ]
  }

  /**
   * The rule editor, in place of the answer list. Same shape as the feedback
   * box, because it is the same bargain: one line, `Enter` commits, `Esc` puts
   * the answers back.
   */
  private renderPrefixEditor(inner: number): string[] {
    this.input.focused = this.focused
    return [
      this.palette.text(t('approval.prefixPrompt')),
      ...this.input.render(inner),
      this.palette.dim(t('approval.prefixHint')),
    ]
  }

  /** Answer with the option at `index`; an out-of-range index cannot occur. */
  private choose(index: number): void {
    const option = this.options()[index]
    /* v8 ignore next -- every caller derives `index` from the same row list. */
    if (option === undefined) return
    switch (option.action) {
      case 'allow-once': {
        this.settle({ outcome: 'allowed-once' })
        return
      }
      case 'allow-session': {
        this.settle({ outcome: 'allowed-once', remember: { scope: 'session' } })
        return
      }
      case 'allow-project': {
        this.settle({ outcome: 'allowed-once', remember: { scope: 'project' } })
        return
      }
      case 'allow-prefix': {
        // The row is only offered when there is a suggestion to pre-fill, so
        // the editor never opens empty. Filled through the paste path rather
        // than `setValue`, which leaves the caret at column zero: this box is
        // opened to be edited, and a rule the user must walk to the end of
        // before they can trim it is a rule they retype instead.
        this.input.setValue('')
        this.input.handleInput(`${PASTE_START}${this.suggestion() ?? ''}${PASTE_END}`)
        this.mode = 'prefix'
        this.invalidate()
        return
      }
      case 'reject-with-feedback': {
        this.mode = 'feedback'
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

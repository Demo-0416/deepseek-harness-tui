/**
 * pi-tui transcript components: the startup banner, user/assistant messages,
 * per-step timing footer, streaming assistant buffer, tool cards, and the todo
 * panel. Each is a pure function of its inputs and the active palette.
 * @module @deepseek-ai/dsh-tui/components/transcript
 */

import {
  Container,
  Markdown,
  Spacer,
  Text,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type MarkdownTheme,
} from '@earendil-works/pi-tui'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue, SessionEvent, TodoItem } from '@deepseek-ai/dsh-session'
import type {
  TerminalCallView,
  ToolCallView,
  ToolDefinition,
  ToolResultView,
} from '@deepseek-ai/dsh-tools'
import type { FileDiff } from '@deepseek-ai/dsh-tools'
import { renderUnknownXml } from './xml-tool-output.ts'
import { displayInlineText, displayText } from './text.ts'
import { gradientText, type Palette } from './theme.ts'
import { contentText, type ParsedArguments } from './content.ts'
import {
  diffLanguage,
  parseDiffBounded,
  renderDiff,
  summarizeDiff,
  type DiffLine,
  type ParsedDiff,
} from '../render/diff.ts'
import { buildPreviewText } from '../render/preview.ts'
import { renderMarkdownAnsi, type MarkdownAnsiTheme } from '../render/markdown.ts'
import { bg as paintBg, CLAUDE_COLORS, fg as paintFg, type Rgb } from '../render/palette.ts'
import {
  formatCompletionTime,
  formatTimingTotals,
  type StepPosition,
  type StepTimingTracker,
} from '../chat/timing.ts'

/** Concatenate the text of every block of one type, separated by blank lines. */
function textBlocks(content: readonly ContentBlock[], type: 'text' | 'reasoning'): string {
  return content
    .filter((block): block is Extract<ContentBlock, { type: typeof type }> => block.type === type)
    .map(block => block.text)
    .join('\n\n')
}

/** Render a value as terminal-safe text: strings escaped, other values as pretty JSON. */
function pretty(value: unknown): string {
  if (typeof value === 'string') return displayText(value)
  // JSON.stringify is typed to return string but yields undefined for e.g. symbols.
  const serialized = JSON.stringify(value, null, 2) as string | undefined
  return displayText(serialized ?? String(value))
}

/**
 * A side's content lines under the terminator rule the Web DiffBlock also
 * applies: empty text is zero lines, a trailing newline terminates the last
 * line, and an interior blank line survives.
 */
function diffContentLines(text: string): string[] {
  if (text === '') return []
  const body = text.endsWith('\n') ? text.slice(0, -1) : text
  return body.split('\n')
}

/**
 * Whether the active palette emits ANSI at all. Every role wrapper is the
 * identity function when color is disabled, so a role that always carries an
 * escape (`bold`) tells the two apart — which is how the fixed truecolor Claude
 * accents below stay out of a `--no-color` transcript.
 */
function colorEnabled(palette: Palette): boolean {
  return palette.bold('x') !== 'x'
}

/**
 * Paint text in one of Claude Code's fixed brand colors, or leave it bare when
 * the palette has color disabled.
 */
function accent(palette: Palette, color: Rgb, text: string): string {
  return colorEnabled(palette) ? paintFg(color, text) : text
}

/** Drop every escape from `lines` when the palette has color disabled. */
function plainIfNoColor(palette: Palette, lines: string[]): string[] {
  return colorEnabled(palette) ? lines : lines.map(line => stripTerminalSequences(line))
}

/**
 * Which pipeline renders an assistant response body, plus the one-shot report
 * of a failure in the preferred one.
 *
 * The object is shared and mutable — like {@link Palette} and `MarkdownTheme`,
 * which a theme change also rewrites in place — so a single failing render
 * moves every mounted and future body onto the pi path at once, rather than
 * leaving the transcript split between two renderers.
 */
export interface MarkdownPolicy {
  /** Preferred body renderer; set to `pi` for good after a `claude` render throws. */
  mode: 'claude' | 'pi'
  /**
   * Styling for the claude pipeline, the counterpart of the `MarkdownTheme`
   * every component already takes for the pi one. Production passes
   * {@link ../render/markdown.ts | claudeMarkdownTheme}.
   */
  readonly theme: MarkdownAnsiTheme
  /**
   * Report the failure that demoted `claude` to `pi`. Invoked at most once per
   * policy object, at the moment {@link MarkdownPolicy.mode} flips.
   * @param error - the value the `claude` render threw.
   */
  readonly onError: (error: unknown) => void
}

/**
 * A markdown body rendered by {@link ../render/markdown.ts | renderMarkdownAnsi}
 * under Claude Code's own styling, with pi-tui's `Markdown` as the fallback.
 *
 * The rows come back already wrapped to the requested width, so the caller must
 * not re-flow them (`PrefixedComponent` only prefixes, which is safe). A throw
 * out of the claude path is contained here: the shared policy flips to `pi`,
 * the failure is reported once, and this render returns the pi rows instead —
 * and a throw out of *that* leaves the unparsed text on screen. A malformed
 * document can degrade the styling but never blank the transcript, and never
 * takes the frame down with it.
 */
export class MarkdownBodyComponent implements Component {
  /** The pi-tui document, built on demand: the claude path never constructs one. */
  private fallback: Markdown | undefined
  /** The last claude render, with the width it was wrapped to. */
  private cached: { width: number; rows: string[] } | undefined

  /**
   * @param text - the markdown source of one assistant response body.
   * @param palette - active role palette; also decides whether escapes survive.
   * @param mdTheme - pi-tui Markdown theme, used only on the fallback path.
   * @param policy - shared renderer choice and failure report.
   */
  constructor(
    private readonly text: string,
    private readonly palette: Palette,
    private readonly mdTheme: MarkdownTheme,
    private readonly policy: MarkdownPolicy,
  ) {}

  invalidate(): void {
    // The rows depend on state this component does not own — the palette and the
    // markdown theme are both mutated in place by a color-scheme change — so an
    // invalidation drops them alongside the pi document's own cache.
    this.cached = undefined
    this.fallback?.invalidate()
  }

  /** The pi-tui document for this text, built once and reused. */
  private piDocument(): Markdown {
    this.fallback ??= new Markdown(this.text, 0, 0, this.mdTheme, { color: value => this.palette.text(value) })
    return this.fallback
  }

  /** The fallback's rows, or the bare words when even the fallback cannot parse them. */
  private piRows(width: number): string[] {
    try {
      return this.piDocument().render(width)
    } catch {
      // pi's parser recurses once per nesting level and overflows the stack an
      // order of magnitude sooner than this port does, so a document that
      // demoted the renderer can be one the fallback cannot read either. Both
      // parsers failing is still not a reason to drop an answer off the screen.
      return wrapTextWithAnsi(this.text, Math.max(1, width))
    }
  }

  render(width: number): string[] {
    if (this.policy.mode === 'claude') {
      // `text` is fixed for the life of one component — a changed body is a new
      // component (see StreamingAssistantComponent.rebuild) — so the rows are a
      // pure function of the width, and caching them is what keeps a frame from
      // re-lexing every message in the transcript while one of them streams.
      if (this.cached?.width === width) return this.cached.rows
      try {
        const rows = plainIfNoColor(this.palette, renderMarkdownAnsi(this.text, width, this.policy.theme, {
          // OSC 8 is the only place a link's href survives, and the no-color
          // path strips it: without this the URL would vanish and the link
          // would read as its display text alone. Degrade to the bare URL
          // instead, which is upstream's own fallback.
          hyperlinks: colorEnabled(this.palette),
        }))
        this.cached = { width, rows }
        return rows
      } catch (error: unknown) {
        this.policy.mode = 'pi'
        this.policy.onError(error)
      }
    }
    return this.piRows(width)
  }
}

/**
 * Clip rows to a collapsed budget, replacing the remainder with the fold marker
 * that names the toggle (`… +N lines • ctrl+o to toggle`). A budget of zero
 * leaves only the marker, so a card can be reduced to its one-line summary.
 */
function foldRows(rows: readonly string[], limit: number, palette: Palette): string[] {
  if (rows.length <= limit) return [...rows]
  const hidden = rows.length - limit
  return [...rows.slice(0, limit), palette.dim(`… +${hidden} line${hidden === 1 ? '' : 's'} • ctrl+o to toggle`)]
}

/**
 * Wrap a child component's rows behind a fixed per-row prefix: a lead glyph on
 * the first row and an aligned indent on the rest. This is how an assistant
 * paragraph gets its ` ● ` bullet and a thinking block its ` ∴ ` without the
 * prefix entering the Markdown document (where it would be re-wrapped as text
 * and would land in a drag-select copy of the message).
 */
class PrefixedComponent implements Component {
  constructor(
    private readonly child: Component,
    private readonly lead: string,
    private readonly continuation: string,
  ) {}

  invalidate(): void {
    this.child.invalidate()
  }

  render(width: number): string[] {
    const rows = this.child.render(Math.max(1, width - visibleWidth(this.continuation)))
    return rows.map((row, index) => {
      // A blank body row keeps no prefix: trailing spaces would otherwise be
      // copied out of the transcript and read as stray whitespace.
      if (stripTerminalSequences(row).trim() === '') return index === 0 ? this.lead.trimEnd() : ''
      return `${index === 0 ? this.lead : this.continuation}${row}`
    })
  }
}

/**
 * A filled block around a child component, the shape Claude Code gives the
 * user's own message: no border at all, one column of padding on each side, and
 * every row filled edge to edge with the fixed rgb(55,55,55) fill. The fill is
 * what makes the user's turns scannable in a long transcript, and because it is
 * a background rather than a frame, a drag-select copies the prompt text alone.
 *
 * With color disabled the fill cannot be drawn, so the block degrades to the
 * same one-column padding with no escape on the row at all.
 */
class FilledBlockComponent implements Component {
  constructor(
    private readonly child: Component,
    private readonly palette: Palette,
  ) {}

  invalidate(): void {
    this.child.invalidate()
  }

  render(width: number): string[] {
    const inner = Math.max(1, width - 2)
    // Every row is padded to the same width so the fill is a rectangle rather
    // than a ragged right edge.
    const rows = this.child.render(inner).map(row => truncateToWidth(row, inner, '', true))
    if (!colorEnabled(this.palette)) {
      return rows.map(row => stripTerminalSequences(` ${row}`).trimEnd())
    }
    return rows.map(row => paintBg(CLAUDE_COLORS.userMessageBg, ` ${row} `))
  }
}

/** Label above the banner's skill summary. */
const SKILLS_LABEL = '[Skills]'

/** Rows of skill names the banner spends before it summarizes the rest. */
const SKILLS_MAX_ROWS = 4

/**
 * Pack skill names into comma-joined rows of at most `width` columns, spending
 * at most {@link SKILLS_MAX_ROWS} of them.
 *
 * What does not fit is counted into a trailing `+N more`, and the marker is
 * packed onto the last row like any other item: names are dropped from that row
 * until it fits, each dropped name raising the count the marker reports (on a
 * narrow banner every one of them can go, leaving the marker alone on its row).
 * That keeps the summary inside its budget at any width, and keeps the count
 * itself off the part a truncation would clip.
 * @param names - Skill names, in the order the entry supplied them.
 * @param width - Columns one row may occupy.
 * @returns The rows to render, without styling.
 */
function packSkillNames(names: readonly string[], width: number): string[] {
  if (names.length === 0) return []
  const joined = (parts: readonly string[]): string => parts.join(', ')
  const rows: string[] = []
  let row: string[] = []
  let placed = 0
  for (const name of names) {
    // The first name of a row is placed regardless: a name wider than the row is
    // still better rendered (and truncated) than dropped into the remainder.
    if (row.length === 0 || visibleWidth(joined([...row, name])) <= width) {
      row.push(name)
      placed += 1
      continue
    }
    if (rows.length + 1 === SKILLS_MAX_ROWS) break
    rows.push(joined(row))
    row = [name]
    placed += 1
  }
  let hidden = names.length - placed
  if (hidden > 0) {
    while (row.length > 0 && visibleWidth(joined([...row, `+${hidden} more`])) > width) {
      row.pop()
      hidden += 1
    }
    row.push(`+${hidden} more`)
  }
  rows.push(joined(row))
  return rows
}

/** What the startup banner reports about the session it opens. */
export interface HeaderInfo {
  /** This bundle's version, rendered next to the wordmark; omitted when unknown. */
  readonly version: string | undefined
  /** The route the next turn runs under, or `undefined` before one resolves. */
  readonly model: () => string | undefined
  /** The workspace, already shortened by the host's `formatCwd`. */
  readonly cwd: string
  /** Short form of the resumed session's id; `undefined` for a fresh session. */
  readonly resumed: string | undefined
  /** The session's logged title, once it has one. */
  readonly title: () => string | undefined
  /** Deployment-configured banner line; absent renders none. */
  readonly welcome?: string
  /**
   * Skill names available to this session, rendered as the banner's `[Skills]`
   * summary. Absent (or empty) renders no section at all: a deployment with no
   * skills must not spend a banner row saying so.
   */
  readonly skills?: readonly string[]
}

/**
 * Borderless startup banner, in Claude Code's shape: the wordmark and version on
 * one line, what this session is running as on the next, and then the input.
 *
 * ```text
 *  DEEPSEEK HARNESS v0.1.0
 *  deepseek-v4-pro · ~/src/project
 *  resumed 85d19568 · fix the ordering bug
 *
 *  [Skills]
 *  lark-doc, lark-base, meego-tech-story, +12 more
 * ```
 *
 * The session id is on the resumed line only. A fresh session's id is a uuid the
 * user did not choose and cannot act on, and printing it (as this banner did)
 * spent the first thing on screen saying nothing; a resumed one is exactly what
 * `--resume` takes back, so it is worth its line — with the logged title beside
 * it, which is why the title is no longer a transcript row of its own. Each line
 * renders as plain left-padded text, matching transcript notices, so it reads on
 * any theme.
 *
 * The skill summary is a section rather than another identity line, so it goes
 * last, under a blank row: which session this is (route, workspace, resume) is
 * one block, and what it can do is another. On a fresh session — the common
 * case, with no resume and no configured welcome — that puts it directly under
 * the workspace row.
 */
export class HeaderComponent implements Component {
  /** Columns of the wordmark currently revealed; `undefined` renders it whole. */
  private revealWidth: number | undefined

  constructor(
    private readonly info: HeaderInfo,
    private readonly palette: Palette,
    private readonly gradient: boolean,
  ) {}

  /**
   * Clip the wordmark to `width` columns (the sweep reveal); `undefined` restores it.
   *
   * Only the wordmark sweeps. The lines under it state where the session is
   * running, and wiping those in as well made the whole screen move at startup.
   * @param width - Revealed wordmark width in columns, or `undefined` for the whole row.
   */
  setRevealWidth(width: number | undefined): void {
    this.revealWidth = width
  }

  invalidate(): void {}

  render(width: number): string[] {
    const usable = Math.max(1, width - 2)
    const name = this.gradient
      ? this.palette.bold(gradientText('DEEPSEEK'))
      : this.palette.bold(this.palette.accent('DEEPSEEK'))
    const version = this.info.version
    const wordmark = `${name} ${this.palette.bold('HARNESS')}`
      + (version === undefined ? '' : ` ${this.palette.dim(`v${displayText(version)}`)}`)
    const model = this.info.model()
    const title = this.info.title()
    const welcome = this.info.welcome
    const cwd = displayText(this.info.cwd)
    // One dim detail row, wrapped to the usable width.
    const detail = (text: string): string[] =>
      wrapTextWithAnsi(this.palette.dim(text), usable).map(line => truncateToWidth(line, usable, ''))
    const lines = [
      // Only the wordmark is clipped by the reveal; the rest states where this
      // session runs and stays still.
      truncateToWidth(wordmark, this.revealWidth ?? usable, ''),
      ...detail(model === undefined ? cwd : `${displayText(model)} · ${cwd}`),
      ...this.info.resumed === undefined ? [] : detail(
        `resumed ${displayText(this.info.resumed)}${title === undefined ? '' : ` · ${displayText(title)}`}`,
      ),
      ...welcome === undefined ? [] : detail(displayText(welcome)),
      ...this.skillRows(usable),
    ]
    // A blank separator row keeps no padding: a row of spaces would be copied
    // out of the banner as stray whitespace.
    return lines.map(line => line === '' ? '' : ` ${line}`)
  }

  /**
   * The `[Skills]` section: its label row and the packed name rows, or nothing
   * when the entry supplied no skills.
   * @param usable - Columns a banner row may occupy.
   * @returns The section's rows, led by the blank row that separates it.
   */
  private skillRows(usable: number): string[] {
    // A blank entry would render as a stray `, ,` in the list, so the section is
    // built from the names that have something to show.
    const names = (this.info.skills ?? []).map(name => displayText(name).trim()).filter(name => name !== '')
    if (names.length === 0) return []
    return [
      '',
      this.palette.bold(this.palette.dim(SKILLS_LABEL)),
      ...packSkillNames(names, usable).map(row => truncateToWidth(this.palette.dim(row), usable, '')),
    ]
  }
}

/**
 * A user or steering prompt in the transcript, rendered as Claude Code's
 * borderless filled block: the prompt text on the fixed rgb(55,55,55) fill with
 * one column of padding, which is what marks the user's own turns in a long
 * transcript.
 *
 * `_label` is retained from the boxed frame this replaced (no caller ever passed
 * it): Claude Code's block names no role, so nothing is rendered for it.
 */
export class UserMessageComponent extends Container {
  constructor(text: string, palette: Palette, mdTheme: MarkdownTheme, _label = 'You') {
    super()
    const body = new Markdown(displayText(text), 0, 0, mdTheme, { color: value => palette.text(value) }, {
      preserveOrderedListMarkers: true,
      preserveBackslashEscapes: true,
    })
    this.addChild(new FilledBlockComponent(body, palette))
  }
}

/**
 * Children of a settled assistant message: optional reasoning block then the
 * response text. Both are Markdown documents behind a Claude Code prefix — an
 * orange ` ● ` bullet for the response, a dim ` ∴ ` for reasoning — so the
 * message needs no role header at all: the bullet IS the marker, and its color
 * says which of the two kinds of assistant text a block is.
 *
 * A step with nothing to show renders nothing, not even its leading gap: a step
 * that only calls tools is common, and its cards already open with a blank row
 * of their own.
 */
function assistantMessageChildren(
  content: readonly ContentBlock[],
  showReasoning: boolean,
  palette: Palette,
  mdTheme: MarkdownTheme,
  markdown: MarkdownPolicy,
): Component[] {
  const reasoning = displayText(textBlocks(content, 'reasoning').trim())
  const text = displayText(textBlocks(content, 'text').trim())
  const showsReasoning = reasoning !== '' && showReasoning
  if (!showsReasoning && text === '') return []
  const children: Component[] = [new Spacer(1)]
  if (showsReasoning) {
    // The whole thinking block is one recessed tone, marker included, so it
    // reads as an aside rather than as a second voice. The document's own
    // default style carries the dim tone, so the prefix adds no second wrapper:
    // SGR has no color stack, and an inner span's close would drop it anyway.
    const document = new Markdown(reasoning, 0, 0, mdTheme, { color: value => palette.dim(value), italic: true })
    children.push(new PrefixedComponent(document, palette.dim(' ∴ '), '   '))
  }
  if (text !== '') {
    // Only the response body moves to the claude pipeline. The thinking block
    // above stays a pi document under one recessed tone: its whole point is
    // that it is NOT typeset like an answer.
    const document = new MarkdownBodyComponent(text, palette, mdTheme, markdown)
    children.push(new PrefixedComponent(document, ` ${accent(palette, CLAUDE_COLORS.claude, '●')} `, '   '))
  }
  return children
}

/**
 * A step's timing summary, rendered as a self-refreshing footer that stays at
 * the tail of the step's output. Kept separate from the assistant message so
 * the timing line trails any tool cards the step appends after its message.
 */
class StepTimingComponent extends Container {
  private completionTime: number | undefined

  constructor(
    private readonly position: StepPosition,
    private readonly events: () => readonly SessionEvent[],
    private readonly tracker: StepTimingTracker,
    private readonly now: () => number,
    private readonly palette: Palette,
  ) {
    super()
    this.rebuild()
  }

  complete(time: number): void {
    this.completionTime = time
    this.rebuild()
  }

  override invalidate(): void {
    this.rebuild()
    super.invalidate()
  }

  private rebuild(): void {
    this.clear()
    const totals = this.tracker.totalsAt(this.events(), this.position, this.completionTime ?? this.now())
    const timing = formatTimingTotals(totals, true)
    const header = this.completionTime === undefined
      ? timing
      : `${timing} · Completed ${formatCompletionTime(this.completionTime)}`
    this.addChild(new Text(this.palette.dim(header), 0, 0))
  }
}

interface StreamingBlock {
  type: string
  text: string
}

/** A live assistant step: streamed reasoning/text blocks until the message settles. */
export class StreamingAssistantComponent extends Container {
  private readonly blocks = new Map<number, StreamingBlock>()
  private settledContent: readonly ContentBlock[] | undefined
  /** The last folded text applied through {@link setFoldedText}, for idempotence. */
  private foldedText: { text: string; reasoning: string; settled: boolean } | undefined
  /**
   * The step's timing footer. The renderer keeps it at the tail of the chat so
   * it trails any tool cards the step appends after this assistant message; it
   * is not a child of this component.
   */
  readonly timing: StepTimingComponent

  constructor(
    /** The step's turn/step coordinates, used to group steps into their turn. */
    readonly position: StepPosition,
    events: () => readonly SessionEvent[],
    tracker: StepTimingTracker,
    now: () => number,
    private showReasoning: boolean,
    private readonly palette: Palette,
    private readonly mdTheme: MarkdownTheme,
    private readonly markdown: MarkdownPolicy,
  ) {
    super()
    this.timing = new StepTimingComponent(position, events, tracker, now, palette)
    this.rebuild()
  }

  /**
   * Apply one step's folded text: the accumulated deltas while the step
   * streams, the settled message's text once it lands. Idempotent — an
   * unchanged triple rebuilds nothing — so a reconciler may call it for every
   * snapshot without re-rendering a step that did not move.
   * @param text - The step's response text so far, or its settled text.
   * @param reasoning - The step's reasoning text so far, or its settled reasoning.
   * @param settled - Whether the step's assistant message has landed.
   */
  setFoldedText(text: string, reasoning: string, settled: boolean): void {
    if (this.foldedText?.text === text
      && this.foldedText.reasoning === reasoning
      && this.foldedText.settled === settled) return
    this.foldedText = { text, reasoning, settled }
    // Reasoning first, then the response: the same order a step streams them,
    // which is the order the block indexes below preserve.
    const content: StreamingBlock[] = [
      ...reasoning === '' ? [] : [{ type: 'reasoning', text: reasoning }],
      ...text === '' ? [] : [{ type: 'text', text }],
    ]
    this.blocks.clear()
    if (settled) {
      this.settledContent = content.map((block): ContentBlock => block.type === 'reasoning'
        ? { type: 'reasoning', text: block.text }
        : { type: 'text', text: block.text })
    } else {
      this.settledContent = undefined
      for (const [index, block] of content.entries()) this.blocks.set(index, block)
    }
    this.rebuild()
  }

  /**
   * Pin the step's timing footer to its completion time.
   * @param time - Step completion time in epoch milliseconds.
   */
  complete(time: number): void {
    this.timing.complete(time)
  }

  override invalidate(): void {
    this.rebuild()
    this.timing.invalidate()
    super.invalidate()
  }

  /**
   * Toggle whether reasoning blocks render, then re-render.
   * @param show - Whether to show reasoning blocks.
   */
  setShowReasoning(show: boolean): void {
    this.showReasoning = show
    this.rebuild()
  }

  /** The settled content when available, otherwise the streamed blocks in model order. */
  private presentedContent(): readonly ContentBlock[] {
    return this.settledContent ?? [...this.blocks.entries()]
      .sort(([left], [right]) => left - right)
      .flatMap<ContentBlock>(([, block]) => {
        if (block.type === 'text') return [{ type: 'text', text: block.text }]
        if (block.type === 'reasoning') return [{ type: 'reasoning', text: block.text }]
        return []
      })
  }

  private rebuild(): void {
    this.clear()
    const children = assistantMessageChildren(
      this.presentedContent(),
      this.showReasoning,
      this.palette,
      this.mdTheme,
      this.markdown,
    )
    for (const child of children) this.addChild(child)
  }
}

/**
 * Claude Code's tool bullet. The product ships the heavy `⏺` and falls back to
 * the plain `●` off macOS, where the heavy glyph is commonly missing from the
 * terminal font and renders as a replacement box.
 */
const TOOL_BULLET = process.platform === 'darwin' ? '⏺' : '●'

/**
 * The lead-in of a tool card's result block: two columns of indent, Claude
 * Code's `⎿` result glyph, then two columns of gap. Continuation rows align
 * under the body with {@link RESULT_INDENT}, so a wrapped result reads as one
 * left-aligned block rather than as a tree.
 */
const RESULT_LEAD = '  ⎿  '

/** The continuation indent of a result block: {@link RESULT_LEAD}'s width in spaces. */
const RESULT_INDENT = ' '.repeat(RESULT_LEAD.length)

/** Columns a result row spends on its prefix, taken from the body width. */
const RESULT_PREFIX_WIDTH = RESULT_LEAD.length

/**
 * One block of a tool card's body: a terminal card's command echo, its output, a
 * diff. `fitted` rows are already wrapped to the body width (a rendered diff, a
 * rendered Markdown document) and MUST NOT be re-flowed — a diff row's
 * background fill would tear across a re-wrap.
 */
interface CardSection {
  readonly rows: readonly string[]
  readonly fitted: boolean
}

/** A diff card in either state; both carry the same `diffs` payload. */
type DiffCardView = Extract<ToolCallView | ToolResultView, { card: 'diff' }>

/** Drop leading and trailing blank rows, keeping interior ones. */
function trimBlankEdges(rows: readonly string[]): string[] {
  let start = 0
  let end = rows.length
  while (start < end && (rows[start] ?? '') === '') start += 1
  while (end > start && (rows[end - 1] ?? '') === '') end -= 1
  return rows.slice(start, end)
}

/**
 * Ctrl+O card-visibility cycle: `hidden` drops tool cards from the transcript,
 * `collapsed` previews the first body lines, `expanded` shows everything.
 */
export type ToolCardVisibility = 'hidden' | 'collapsed' | 'expanded'

/**
 * Transcript card with a width-keyed rendered-row cache. pi-tui re-renders
 * every component each frame and relies on per-component line caches (its own
 * `Text`/`Markdown` do this); a card that rebuilds rows inside `render(width)`
 * would re-wrap its output every frame
 * ([rationale](../../../../../.agents/notes/implemented/bug-fix/2026-08-03-tui-long-session-render-costs.md)).
 * Subclasses render through {@link renderLines} and call {@link dropLines}
 * from every state mutator; with `invalidate()` (pi-tui's tree-wide cascade)
 * also dropping, a state change always re-renders.
 */
abstract class CachedCardComponent implements Component {
  private cached: { width: number; lines: string[] } | undefined

  /** Discard the cached rows so the next render recomputes them. */
  protected dropLines(): void {
    this.cached = undefined
  }

  invalidate(): void {
    this.cached = undefined
  }

  render(width: number): string[] {
    if (this.cached?.width !== width) this.cached = { width, lines: this.renderLines(width) }
    return this.cached.lines
  }

  /**
   * Render the card's rows for `width` without caching.
   * @param width - Render width the rows are wrapped to.
   * @returns The card's rows.
   */
  protected abstract renderLines(width: number): string[]
}

/** A tool call and its result, rendered as a collapsible status card. */
export class ToolCardComponent extends CachedCardComponent {
  private result: { content: ContentBlock[]; isError: boolean; meta?: JsonValue } | undefined
  private visibility: ToolCardVisibility = 'collapsed'
  private callView: ToolCallView
  private resultView: ToolResultView | undefined
  private diffBodyCache: {
    view: DiffCardView
    width: number
    expanded: boolean
    section: CardSection
  } | undefined

  constructor(
    private readonly name: string,
    private readonly parsed: ParsedArguments,
    private readonly definition: ToolDefinition | undefined,
    private readonly maxOutputLines: number,
    private readonly maxDiffEditLength: number,
    private readonly palette: Palette,
    private readonly mdTheme: MarkdownTheme,
  ) {
    super()
    this.callView = this.presentCall()
  }

  private presentCall(): ToolCallView {
    if (this.parsed.valid && this.definition?.presentCall) {
      try {
        const view = this.definition.presentCall(this.parsed.value)
        if (view !== undefined) return view
      } catch (error: unknown) {
        return { card: 'generic', title: displayText(this.name), rawInput: `Presenter failed: ${String(error)}` }
      }
    }
    return { card: 'generic', title: displayText(this.name), rawInput: this.parsed.value }
  }

  /**
   * Record an already-projected tool result and derive its result view. Takes
   * the result rather than the event so a folded node can drive the card
   * without re-deriving the event payload.
   * @param result - The model-facing blocks, the failure flag, and the tool's `meta`.
   */
  setResult(result: { content: ContentBlock[]; isError: boolean; meta?: JsonValue }): void {
    this.diffBodyCache = undefined
    this.dropLines()
    this.result = { ...result }
    if (this.parsed.valid && this.definition?.presentResult) {
      try {
        const view = this.definition.presentResult(this.parsed.value, this.result)
        if (view !== undefined) this.resultView = view
      } catch (error: unknown) {
        this.resultView = { card: 'generic', content: [{ type: 'text', text: `Presenter failed: ${String(error)}` }] }
      }
    }
  }

  /**
   * Set the card's visibility state.
   * @param visibility - Hidden, collapsed preview, or full body.
   */
  setVisibility(visibility: ToolCardVisibility): void {
    this.visibility = visibility
    this.dropLines()
  }

  protected renderLines(width: number): string[] {
    // Hidden renders nothing — not even the leading gap — so the transcript
    // keeps only the conversation, the way Codex hides tool calls.
    if (this.visibility === 'hidden') return []
    const expanded = this.visibility === 'expanded'
    // The body is one left-aligned block under the header, so it loses exactly
    // the columns the `⎿` lead-in occupies.
    const inner = Math.max(20, width - RESULT_PREFIX_WIDTH)
    const rows: string[] = ['', this.headerRow(width)]
    // Claude Code marks a card's result once: the first body row of the whole
    // card carries `⎿`, and every later row — of this section or the next —
    // aligns under it. Sections remain separate only so a `fitted` one (a
    // rendered diff, whose background fills would tear) is never re-wrapped.
    let lead = true
    for (const section of this.bodySections(inner, expanded)) {
      const sectionRows = section.fitted
        ? section.rows
        : section.rows.flatMap(row => wrapTextWithAnsi(row, inner))
      for (const row of sectionRows) {
        if (lead) {
          lead = false
          rows.push(`${this.palette.dim(RESULT_LEAD)}${row}`)
          continue
        }
        // A blank body row keeps no indent: trailing spaces would otherwise be
        // copied out of the transcript and read as stray whitespace.
        rows.push(stripTerminalSequences(row).trim() === '' ? '' : `${RESULT_INDENT}${row}`)
      }
    }
    return plainIfNoColor(this.palette, rows)
  }

  /**
   * The card's one header row: `⏺ <tool>(<summary>)`. The bullet carries the
   * call's state as color (Claude Code's orange while the call is in flight,
   * green settled, red failed) and the tool name is bold, so a transcript scans
   * as a list of what ran; the parenthesized summary is the call's own one-line
   * detail (a command, an edited path) in the recessed tone.
   */
  private headerRow(width: number): string {
    const isError = this.result?.isError ?? false
    const status = this.result === undefined
      ? CLAUDE_COLORS.claude
      : isError ? CLAUDE_COLORS.error : CLAUDE_COLORS.success
    const bullet = this.palette.bold(accent(this.palette, status, TOOL_BULLET))
    const name = this.palette.bold(displayText(this.name))
    const summary = this.headerSummary()
    // The header is a single card row: collapse an embedded newline to an inline
    // escape so it cannot break onto extra rows and collide with the body below.
    const text = summary === undefined
      ? `${bullet} ${name}`
      : `${bullet} ${name}${this.palette.dim(`(${displayInlineText(summary)})`)}`
    return truncateToWidth(text, Math.max(1, width - 2), '')
  }

  /**
   * The header's trailing detail: a terminal card's description (or its command
   * when it has none), and otherwise the presenter's title — skipped when the
   * title only repeats the tool name, which the header already shows.
   */
  private headerSummary(): string | undefined {
    const pending = this.terminalPending()
    if (pending !== undefined) {
      const description = pending.description
      return description !== undefined && description !== '' ? description : pending.title
    }
    const title = this.resultView?.title ?? this.callView.title
    return title === displayText(this.name) ? undefined : title
  }

  /** The pending terminal call view, when this row is a terminal card. */
  private terminalPending(): TerminalCallView | undefined {
    return this.callView.card === 'terminal' ? this.callView : undefined
  }

  /**
   * The card's body, split into the blocks the branch tree hangs off.
   * @param inner - Width available to a body row, after the branch prefix.
   * @param expanded - Whether the full body is shown.
   */
  private bodySections(inner: number, expanded: boolean): CardSection[] {
    const view = this.resultView ?? this.callView
    if (view.card === 'terminal') return this.terminalSections(expanded)
    if (view.card === 'diff') return [this.diffSection(view, inner, expanded)]
    return this.genericSections(view, inner, expanded)
  }

  /**
   * A terminal card's body: the command echo and its cwd as one block, the
   * captured output and exit status as another. Both keep the pre-Claude-Code
   * behaviour; only the output's truncation now goes through the shared preview.
   */
  private terminalSections(expanded: boolean): CardSection[] {
    const pending = this.terminalPending()
    const sections: CardSection[] = []
    const prelude: string[] = []
    // The command shows as a $-line here whenever it is not the header: either a
    // description headlines the row (the command still belongs somewhere) or the
    // row is a pending undescribed call (the classic running-command echo). A
    // completed undescribed row keeps the command only in the header.
    // The command and cwd are each a single card row, so escape a multi-line
    // command inline (displayInlineText) — a real newline would break onto extra
    // rows and collide with the output below.
    const headlined = pending?.description !== undefined && pending.description !== ''
    const commandInBody = pending !== undefined && (headlined || this.result === undefined)
    if (commandInBody) prelude.push(this.palette.dim(`$ ${displayInlineText(pending.title)}`))
    if (pending?.cwd !== undefined && pending.cwd !== '') {
      prelude.push(this.palette.dim(displayInlineText(pending.cwd)))
    }
    if (prelude.length > 0) sections.push({ rows: prelude, fitted: false })
    const output: string[] = []
    const resultView = this.resultView
    if (resultView?.card === 'terminal') {
      if (resultView.output !== undefined && resultView.output !== '') {
        output.push(...this.previewOutput(resultView.output, expanded))
      }
      if (resultView.exitCode !== undefined) output.push(this.palette.dim(`[exit ${resultView.exitCode}]`))
      if (resultView.signal !== undefined) {
        output.push(this.palette.error(`[signal ${displayText(resultView.signal)}]`))
      }
    } else if (this.result !== undefined) {
      output.push(...this.previewOutput(contentText(this.result.content), expanded))
    }
    if (output.length > 0) sections.push({ rows: output, fitted: false })
    return sections
  }

  /**
   * A tool's own output text as dim rows under the collapsed preview budget —
   * the card's result-output color, which separates what the tool produced from
   * the card's own framing. A blank row stays the empty string so it reads as
   * blank rather than as an ANSI-wrapped value.
   */
  private previewOutput(text: string, expanded: boolean): string[] {
    return buildPreviewText(displayText(text).split('\n'), {
      expanded,
      previewLines: this.maxOutputLines,
      styleLine: line => line === '' ? line : this.palette.dim(line),
    }).split('\n')
  }

  /**
   * A diff card's body: each file's path, its rendered hunks, and one trailing
   * `+A -R` stat bar across every file. The rendered rows are already fitted to
   * the body width (they carry background fills that must not be re-wrapped), so
   * this section is marked `fitted` and the render is cached per width and fold
   * state — a diff is the one card body expensive enough to recompute.
   */
  private diffSection(
    view: DiffCardView,
    inner: number,
    expanded: boolean,
  ): CardSection {
    const cached = this.diffBodyCache
    if (cached?.view === view && cached.width === inner && cached.expanded === expanded) return cached.section
    const rows: string[] = []
    let added = 0
    let removed = 0
    let approximate = false
    for (const [index, diff] of view.diffs.entries()) {
      if (index > 0) rows.push('')
      rows.push(truncateToWidth(this.palette.bold(displayText(diff.path)), inner, ''))
      const parsed = this.parseFileDiff(diff)
      added += parsed.diff.added
      removed += parsed.diff.removed
      if (parsed.approximate) {
        approximate = true
        rows.push(this.palette.dim(`[exact line diff omitted: >${this.maxDiffEditLength} changed lines]`))
      }
      const language = diffLanguage(diff.path)
      rows.push(...renderDiff(parsed.diff, inner, {
        toggleHint: 'ctrl+o to toggle',
        ...expanded ? {} : { maxLines: Math.max(1, this.maxOutputLines) },
        ...language === undefined ? {} : { language },
      }))
    }
    const files = new Set(view.diffs.map(diff => diff.path)).size
    const trailer = `${files} file${files === 1 ? '' : 's'}${approximate ? ' · approximate' : ''}`
    rows.push(truncateToWidth(`${summarizeDiff(added, removed, inner)} ${this.palette.dim(`· ${trailer}`)}`, inner, ''))
    const section: CardSection = { rows, fitted: true }
    this.diffBodyCache = { view, width: inner, expanded, section }
    return section
  }

  /**
   * One file's parsed diff. A comparison beyond the edit-distance budget falls
   * back to whole-side rows (every old line removed, every new line added) so a
   * model-authored pending edit cannot stall the TUI; the caller labels that
   * fallback `approximate` because its totals are not exact change counts.
   */
  private parseFileDiff(diff: FileDiff): { diff: ParsedDiff; approximate: boolean } {
    const oldText = displayText(diff.oldText ?? '')
    const newText = displayText(diff.newText)
    const parsed = parseDiffBounded(oldText, newText, this.maxDiffEditLength)
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
   * Every other card's body. A generic card's own content, a read card's
   * `content` fallback (the envelope-stripped file text — the TUI has no
   * dedicated read rendering, so a read renders exactly as before the read card
   * existed), or a search/web card's fallback to the raw result content (neither
   * view carries a `content` copy) all render as one dim Markdown document, so
   * links/lists/headings keep the unified dim styling rather than reading as
   * bare text.
   */
  private genericSections(view: ToolCallView | ToolResultView, inner: number, expanded: boolean): CardSection[] {
    const markdownContent = view.card === 'generic' || view.card === 'read'
      ? view.content ?? this.result?.content
      : view.card === 'search'
        ? this.result?.content
        : view.card === 'web'
          // A web resultView is only assigned alongside this.result (the result
          // handler sets both) and the pending callView is never a web card, so
          // the optional-chain undefined side is unreachable here.
          /* v8 ignore next */
          ? this.result?.content
          : undefined
    const unknownXml = this.definition === undefined && markdownContent !== undefined
      ? renderUnknownXml(
        displayText(contentText(markdownContent)),
        this.maxOutputLines,
        expanded,
        displayText,
        text => this.palette.dim(text),
        text => this.palette.dim(text),
        /* v8 ignore next -- renderUnknownXml calls the collapsed summary only when hidden XML children exceed this card's limit. */
        count => this.palette.dim(`  … +${count} lines (Ctrl+O to expand)`),
      )
      : undefined
    // An XML tree owns its own fold, so it is not folded a second time here.
    if (unknownXml !== undefined) return [{ rows: unknownXml, fitted: false }]
    const lines: string[] = []
    if (markdownContent !== undefined) lines.push(...displayText(contentText(markdownContent)).split('\n'))
    const rawInput = this.result === undefined && this.callView.card === 'generic'
      ? this.callView.rawInput
      : undefined
    if (rawInput !== undefined) lines.push(...pretty(rawInput).split('\n'))
    // Interior blanks (a result's own paragraph break) survive; the body's
    // leading and trailing ones are dropped.
    const trimmed = trimBlankEdges(lines)
    if (trimmed.length === 0) return []
    const markdown = markdownContent !== undefined
    const rows = markdown ? this.dimBody(trimmed, inner) : trimmed
    return [{ rows: foldRows(rows, expanded ? rows.length : this.maxOutputLines, this.palette), fitted: markdown }]
  }

  /**
   * Render a card's result as one Markdown document under the dim body tone.
   * Rendering the body as one document preserves its own block spacing
   * (Markdown's blank row before a heading); dimming every row keeps the card
   * body one uniform tone, so only the header bullet carries status color.
   */
  private dimBody(lines: readonly string[], width: number): string[] {
    const rows = new Markdown(lines.join('\n'), 0, 0, this.mdTheme, {
      color: value => this.palette.text(value),
    }).render(width)
    // A whitespace-only row carries no output to dim; leaving it unwrapped keeps
    // Markdown's padding out of the styled ranges.
    return rows.map(row => row.trim() === '' ? row : this.palette.dim(row))
  }
}

/**
 * Matches a lone reminder-frame tag on its own line, capturing the element name.
 * Producers emit the frame as whole lines (`workspace-context`, `dsh-tool-skill`),
 * so anchoring the whole line keeps a tag mentioned inside prose from matching.
 */
const REMINDER_FRAME_LINE = /^<(\/?)([a-zA-Z][\w:.-]*)>$/u

/**
 * Drop a producer's outer reminder frame, keeping the instruction body verbatim.
 * The card header already names the source, so the frame lines carry nothing.
 * Only a matched open/close pair on the first and last lines is removed, so a
 * body that merely starts with a tag-like line is left intact.
 * @param text - Complete model-facing context text.
 * @returns The body without its outer frame lines, trimmed of the blank lines they leave.
 */
function stripReminderFrame(text: string): string {
  // A frame needs an open line and a distinct close line, so anything shorter than
  // two lines is already frameless.
  const [first = '', ...rest] = text.split('\n')
  const last = rest.at(-1)
  if (last === undefined) return text
  const open = REMINDER_FRAME_LINE.exec(first.trim())
  const close = REMINDER_FRAME_LINE.exec(last.trim())
  if (open?.[1] !== '' || close?.[1] !== '/' || open[2] !== close[2]) return text
  return rest.slice(0, -1).join('\n').replace(/^\n+|\n+$/gu, '')
}

/**
 * Injected context (plugin/goal source, e.g. `workspace-context`), rendered as a
 * dim card under a `Context · <label>` header, with a surrounding reminder frame
 * stripped because the source label already names the context.
 *
 * The card has one state, not two. It is mounted only by the expanded phase of
 * the Ctrl+O cycle ({@link ToolCardVisibility}), because this text was never
 * written for the user: it is the runtime snapshot and skill catalog the
 * producers hand the model on every request. Claude Code puts none of that in
 * the conversation, and the one-row `Context · <label> (ctrl+o)` placeholder
 * this card used to render collapsed still spent a row of every fresh screen —
 * and one per request thereafter — on traffic nobody reads. Ctrl+O is where a
 * user goes to see what the model was actually sent; until then the transcript
 * is the conversation and nothing else.
 *
 * Injected context is prose, not markup, so this card does not parse it. The
 * `<system-reminder>` frame is a prompting convention no model is trained on
 * ([envelope rationale](../../../../../.agents/notes/implemented/simplification/2026-07-20-unwrap-injected-content-envelopes.md)),
 * and instruction bodies legitimately contain a raw `&` or angle-bracket
 * placeholders (`packages/<group>/<pkg>/`, `-t <name>`) that are prose rather than
 * elements. Tree-rendering such a payload depended on whether it happened to be
 * well-formed XML, which made both the fold and the frame-line suppression
 * content-dependent.
 */
export class ContextCardComponent extends CachedCardComponent {
  constructor(
    private readonly label: string,
    private readonly text: string,
    private readonly palette: Palette,
  ) {
    super()
  }

  protected renderLines(width: number): string[] {
    const header = this.palette.dim(`Context · ${displayText(this.label)}`)
    // Emptiness is decided on the stripped text: styling a blank body would yield
    // one escape-only row, which reads as a stray blank line under the header.
    const stripped = stripReminderFrame(this.text)
    if (stripped === '') return [header]
    const body = stripped.split('\n')
      .map(line => line === '' ? line : this.palette.dim(displayText(line)))
    return [header, ...new Text(body.join('\n'), 0, 0).render(width)]
  }
}

/** The plan/todo panel rendered above the prompt. */
export class TodoComponent implements Component {
  private todos: readonly TodoItem[] = []

  constructor(private readonly palette: Palette) {}

  /**
   * Replace the rendered plan items.
   * @param todos - The current todo items.
   */
  update(todos: readonly TodoItem[]): void {
    this.todos = todos
  }

  invalidate(): void {}

  render(width: number): string[] {
    if (this.todos.length === 0) return []
    const lines: string[] = [this.palette.bold(this.palette.accent('Plan'))]
    for (const todo of this.todos) {
      // Claude Code's three-state box: a checked item, a filled box for the one
      // in flight (in the brand orange, the same accent the assistant bullet
      // uses), and a hollow box for what is still queued.
      const icon = todo.status === 'completed'
        ? accent(this.palette, CLAUDE_COLORS.success, '✔')
        : todo.status === 'in_progress'
          ? accent(this.palette, CLAUDE_COLORS.claude, '◼')
          : this.palette.dim('◻')
      const content = displayText(todo.content)
      // A finished item is struck through as well as recessed, so a glance at
      // the panel separates done from pending without reading the icons.
      const text: string = todo.status === 'completed'
        ? this.palette.strike(this.palette.dim(content))
        : content
      lines.push(truncateToWidth(`  ${icon} ${text}`, width, ''))
    }
    return plainIfNoColor(this.palette, ['', ...lines])
  }
}

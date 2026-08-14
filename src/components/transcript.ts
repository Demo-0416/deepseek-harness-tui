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
  type TerminalColorScheme,
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
import {
  formatCollapseHint,
  groupThinkingMs,
  type CollapsedGroup,
} from '../core/collapse.ts'
import { plural, t } from '../i18n/index.ts'
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
import {
  bg as paintBg,
  claudeSchemeColors,
  CLAUDE_COLORS,
  fg as paintFg,
  type Rgb,
} from '../render/palette.ts'
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
 * The transcript's left margin, and with it the column every gutter glyph sits
 * in: an assistant answer's `●`, a tool card's `⏺`, the `∴` of a thinking
 * block, and a turn's `✻`.
 *
 * Claude Code puts all four in the same two-column gutter at the left edge of
 * the message row (`<Box minWidth={2}>` in `AssistantTextMessage`,
 * `AssistantToolUseMessage`, `SystemTextMessage`), so they line up down the
 * whole transcript; this port indents every row one column further, and tool
 * cards were the one surface that never got that column — which put their
 * bullets a column left of every other bullet on screen. One constant now
 * carries the margin so the two cannot drift apart again.
 */
const GUTTER = ' '

/** Columns a gutter glyph and its trailing space occupy: {@link GUTTER} plus `● `. */
const GUTTER_WIDTH = GUTTER.length + 2

/** Continuation indent under a gutter glyph, so a wrapped body stays one block. */
const GUTTER_INDENT = ' '.repeat(GUTTER_WIDTH)

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

  /**
   * @param info - The identity lines this banner states.
   * @param palette - Active role palette, mutated in place by a repaint.
   * @param gradient - Whether the wordmark may carry truecolor brand art, read
   *   per render: the banner is mounted once, so a theme changed mid-session
   *   (`/theme no-color`) has no other way to reach it.
   */
  constructor(
    private readonly info: HeaderInfo,
    private readonly palette: Palette,
    private readonly gradient: () => boolean,
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
    const name = this.gradient()
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
        t('banner.resumed', { id: displayText(this.info.resumed) })
        + (title === undefined ? '' : ` · ${displayText(title)}`),
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
 * Claude Code's prompt pointer (`figures.pointer`), the only marker a user
 * message carries. It renders in the recessed tone, upstream's `subtle`
 * (`HighlightedThinkingText.tsx:91`).
 */
const PROMPT_POINTER = '❯'

/**
 * Characters of one prompt beyond which the block prints a middle instead
 * (`UserPromptMessage.tsx:28-30`): a pasted file is not worth scrolling past to
 * reach the answer it asked for.
 */
const MAX_PROMPT_CHARS = 10_000

/** Characters kept from each end when a prompt exceeds {@link MAX_PROMPT_CHARS}. */
const PROMPT_EDGE_CHARS = 2_500

/**
 * Clip an over-long prompt to its two ends, counting the lines the middle drops.
 * @param text - The prompt as submitted.
 * @returns The text to render, unchanged when it is inside the budget.
 */
function clipPrompt(text: string): string {
  if (text.length <= MAX_PROMPT_CHARS) return text
  const head = text.slice(0, PROMPT_EDGE_CHARS)
  const tail = text.slice(-PROMPT_EDGE_CHARS)
  const hidden = text.slice(PROMPT_EDGE_CHARS, -PROMPT_EDGE_CHARS).split('\n').length
  return `${head}\n… +${hidden} lines …\n${tail}`
}

/**
 * A user or steering prompt in the transcript, rendered as Claude Code's
 * borderless filled block: the `❯ ` pointer and then the prompt **as typed**, on
 * the theme's user-message fill with one column of padding, which is what marks
 * the user's own turns in a long transcript.
 *
 * The text is deliberately not a Markdown document. Upstream renders a user
 * message through `HighlightedThinkingText`, which is plain `<Text>` with the
 * pointer in front — only assistant output goes through `<Markdown>`. This port
 * used to typeset it with pi-tui's Markdown while the answer above it went
 * through the claude pipeline, so the same `$x^2$`, the same `*` and the same
 * `#` came out one way in the question and another in the answer, and a prompt
 * that quoted markup was rewritten before the user could check what they had
 * sent. Echoing the prompt verbatim also removes the second dialect from the
 * transcript entirely: one renderer, on assistant text alone.
 *
 * `_label` is retained from the boxed frame this replaced (no caller ever passed
 * it): Claude Code's block names no role, so nothing is rendered for it.
 */
export class UserMessageComponent implements Component {
  /** The pointer and body, already sanitized; wrapped per width at render. */
  private readonly text: string
  private readonly fill: Rgb
  private cached: { width: number; rows: string[] } | undefined

  /**
   * @param text - The prompt as submitted.
   * @param palette - Active role palette.
   * @param scheme - Terminal color scheme, which picks the fill.
   * @param _label - Unused role name; see the class note.
   */
  constructor(
    text: string,
    private readonly palette: Palette,
    scheme: TerminalColorScheme = 'dark',
    _label = 'You',
  ) {
    // The body carries no color of its own: upstream writes `color="text"`,
    // which is the theme's default foreground — on a light terminal black, on a
    // dark one white — and that is exactly what the fill above is chosen
    // against. The pointer is the one recessed span.
    this.text = `${palette.dim(PROMPT_POINTER)} ${palette.text(displayText(clipPrompt(text)))}`
    this.fill = claudeSchemeColors(scheme).userMessageBg
  }

  invalidate(): void {
    this.cached = undefined
  }

  render(width: number): string[] {
    if (this.cached?.width === width) return this.cached.rows
    // The block owns one column of padding on each side, so the text wraps to
    // what is left; the pointer is part of the wrapped run, which is what puts
    // a continuation row under the pointer rather than under the first word.
    const inner = Math.max(1, width - 2)
    const rows = wrapTextWithAnsi(this.text, inner).map(row => truncateToWidth(row, inner, '', true))
    const painted = colorEnabled(this.palette)
      ? rows.map(row => paintBg(this.fill, ` ${row} `))
      : rows.map(row => stripTerminalSequences(` ${row}`).trimEnd())
    this.cached = { width, rows: painted }
    return painted
  }
}

/**
 * Claude Code's thinking title: U+2234 and U+2026, dim and italic, on its own
 * row (`AssistantThinkingMessage.tsx:62`). The block's body is dim but NOT
 * italic and sits two columns in from the title, with one blank row between
 * them — the product renders the pair as a `gap={1}` column, and the italic run
 * is the title alone.
 */
const THINKING_TITLE = '∴ Thinking…'

/**
 * Indent of a thinking body: the transcript's own {@link GUTTER} plus Claude
 * Code's two columns (`<Box paddingLeft={2}>`), which also lands the body in the
 * same column as an answer's text under its ` ● ` bullet.
 */
const THINKING_INDENT = GUTTER_INDENT

/**
 * Children of a settled assistant message: the optional thinking block then the
 * response text. The response is a Markdown document behind Claude Code's
 * orange ` ● ` bullet, so the message needs no role header at all: the bullet IS
 * the marker. The thinking block is the product's own two-part shape — the
 * `∴ Thinking…` title, a blank row, and the indented dim body — so an aside
 * never reads as a second voice answering.
 *
 * A step with nothing to show renders nothing, not even its leading gap: a step
 * that only calls tools is common, and its cards already open with a blank row
 * of their own.
 * @param showThinking - Whether this step's thinking block renders at all;
 * {@link StreamingAssistantComponent.showsThinking} decides it from the
 * configured setting, the Ctrl+T pin, the step's lifecycle, and the Ctrl+O
 * phase.
 */
function assistantMessageChildren(
  content: readonly ContentBlock[],
  showThinking: boolean,
  palette: Palette,
  mdTheme: MarkdownTheme,
  markdown: MarkdownPolicy,
): Component[] {
  const reasoning = displayText(textBlocks(content, 'reasoning').trim())
  const text = displayText(textBlocks(content, 'text').trim())
  const showsThinking = reasoning !== '' && showThinking
  if (!showsThinking && text === '') return []
  const children: Component[] = [new Spacer(1)]
  if (showsThinking) {
    // The whole thinking block is one recessed tone, title included, so it
    // reads as an aside rather than as a second voice. The document's own
    // default style carries the dim tone, so the indent adds no second wrapper:
    // SGR has no color stack, and an inner span's close would drop it anyway.
    const document = new Markdown(reasoning, 0, 0, mdTheme, { color: value => palette.dim(value) })
    children.push(new Text(palette.italic(palette.dim(`${GUTTER}${THINKING_TITLE}`)), 0, 0))
    children.push(new Spacer(1))
    children.push(new PrefixedComponent(document, THINKING_INDENT, THINKING_INDENT))
  }
  if (text !== '') {
    // One blank row between the aside and the answer, the same gap Claude Code
    // gives every message block.
    if (showsThinking) children.push(new Spacer(1))
    // Only the response body moves to the claude pipeline. The thinking block
    // above stays a pi document under one recessed tone: its whole point is
    // that it is NOT typeset like an answer.
    const document = new MarkdownBodyComponent(text, palette, mdTheme, markdown)
    children.push(new PrefixedComponent(
      document,
      `${GUTTER}${accent(palette, CLAUDE_COLORS.claude, '●')} `,
      GUTTER_INDENT,
    ))
  }
  return children
}

/**
 * Claude Code's plan-mode badge (`PAUSE_ICON`, `constants/figures.ts:17`).
 */
const PLAN_MODE_ICON = '⏸'

/**
 * Claude Code's accept-edits badge (`permissionModeSymbol('acceptEdits')`,
 * `utils/permissions/PermissionMode.ts`).
 */
const AUTO_ACCEPT_ICON = '⏵⏵'

/**
 * One mode badge: the row Claude Code keeps at the left of the strip under its
 * input frame (`PromptInputFooterLeftSide.tsx:348-355`), in that mode's tone,
 * with the cycle key named after it in dim.
 *
 * Upstream's `<Text color={getModeColor(mode)}>{symbol} {title} on</Text>`
 * followed by a `dimColor` shortcut hint, with the hint dropped once the footer
 * carries two other pills. Nothing here counts pills, because nothing else
 * shares the row.
 * @param palette - Active role palette; decides whether the tone is emitted.
 * @param color - The mode's tone for the active scheme.
 * @param text - The badge sentence, already translated.
 * @param hint - The parenthesised cycle hint, or `undefined` to leave it off.
 * @returns The badge row, ready to render above the prompt.
 */
function modeRow(palette: Palette, color: Rgb, text: string, hint: string | undefined): string {
  const badge = accent(palette, color, `${GUTTER}${text}`)
  return hint === undefined ? badge : `${badge} ${palette.dim(hint)}`
}

/**
 * The one permanent sign that this session is in plan mode: the badge Claude
 * Code keeps at the left of the row under its input frame, in the theme's plan
 * tone.
 *
 * The mode reaches this terminal as a folded `plan/mode` event and nothing on
 * screen consumed it, so a session could sit in plan mode with the transcript
 * and the prompt looking exactly as they do outside it — the user found out
 * when the agent declined to edit. Upstream's badge is the whole visual
 * treatment, deliberately: the input border does NOT change color in plan mode
 * (`PromptInput.tsx:2214-2235` routes only bash and teammate colors), so a
 * colored frame here would be a signal the product does not have.
 *
 * Upstream's trailing `(shift+tab to cycle)` hint used to be dropped here,
 * because plan mode was only ever set through the session log and this terminal
 * bound no key that cycled modes. `app.mode.cycle` is that key, so the hint is
 * back — named from the installed keybinding manager by the caller, never
 * written out, so a deployment that rebinds the action gets its own key printed.
 * @param palette - Active role palette; decides whether the tone is emitted.
 * @param scheme - Terminal color scheme, which picks the plan tone.
 * @param hint - The cycle hint, already parenthesised and translated.
 * @returns The badge row, ready to render above the prompt.
 */
export function planModeRow(
  palette: Palette,
  scheme: TerminalColorScheme = 'dark',
  hint?: string,
): string {
  return modeRow(
    palette,
    claudeSchemeColors(scheme).planMode,
    `${PLAN_MODE_ICON} ${t('transcript.planModeBadge')}`,
    hint,
  )
}

/**
 * The sign that this session runs its tool calls without asking: the
 * auto-accept preset's badge, in upstream's electric violet.
 *
 * Named `auto-accept` rather than upstream's `accept edits`, because the state
 * behind it is wider than editing: the preset sets `approval/policy` to `never`,
 * so every tool this agent has runs unattended inside the workspace sandbox, not
 * just the file writers. A badge that promised only edits would understate what
 * the user just switched on.
 * @param palette - Active role palette; decides whether the tone is emitted.
 * @param scheme - Terminal color scheme, which picks the auto-accept tone.
 * @param hint - The cycle hint, already parenthesised and translated.
 * @returns The badge row, ready to render above the prompt.
 */
export function autoAcceptRow(
  palette: Palette,
  scheme: TerminalColorScheme = 'dark',
  hint?: string,
): string {
  return modeRow(
    palette,
    claudeSchemeColors(scheme).autoAccept,
    `${AUTO_ACCEPT_ICON} ${t('transcript.autoAcceptBadge')}`,
    hint,
  )
}

/**
 * Claude Code's past-tense turn verbs, copied from its
 * `src/constants/turnCompletionVerbs.ts`. One is sampled per turn and reads as
 * `<verb> for <duration>`.
 */
export const TURN_COMPLETION_VERBS: readonly string[] = [
  'Baked',
  'Brewed',
  'Churned',
  'Cogitated',
  'Cooked',
  'Crunched',
  'Sautéed',
  'Worked',
]

/**
 * Wall time a turn must exceed before it prints a completion row at all
 * (`REPL.tsx:2974` — `turnDurationMs > 30000`). Anything shorter says nothing:
 * the user watched it happen.
 */
export const TURN_FOOTER_MIN_MS = 30_000

/**
 * Claude Code's teardrop asterisk (`constants/figures.ts`), which the turn row
 * puts in a two-column gutter (`<Box minWidth={2}>`).
 */
const TURN_GLYPH = '✻'

/**
 * Format a turn's wall time the way Claude Code's `formatDuration` does: whole
 * seconds under a minute (`45s`), minutes and seconds above it (`1m 23s`), and
 * hours ahead of both for a run long enough to need them. A rounding carry
 * (59.6 s) is carried up rather than printed as `1m 60s`.
 * @param ms - Elapsed wall time in milliseconds.
 * @returns The formatted duration.
 */
export function formatTurnDuration(ms: number): string {
  const elapsed = Math.max(0, ms)
  if (elapsed < 60_000) return `${Math.floor(elapsed / 1000)}s`
  let seconds = Math.round((elapsed % 60_000) / 1000)
  let minutes = Math.floor((elapsed % 3_600_000) / 60_000)
  let hours = Math.floor(elapsed / 3_600_000)
  if (seconds === 60) {
    seconds = 0
    minutes += 1
  }
  if (minutes === 60) {
    minutes = 0
    hours += 1
  }
  return hours > 0 ? `${hours}h ${minutes}m ${seconds}s` : `${minutes}m ${seconds}s`
}

/**
 * One turn's verb, sampled uniformly like Claude Code's `sample()`. Sampled
 * once per turn by the caller and held for that turn's whole life, so the row
 * does not reword itself on a re-render.
 * @returns One of {@link TURN_COMPLETION_VERBS}.
 */
export function turnCompletionVerb(): string {
  return TURN_COMPLETION_VERBS[Math.floor(Math.random() * TURN_COMPLETION_VERBS.length)] ?? 'Worked'
}

/**
 * Claude Code's turn completion row — `✻ Worked for 45s`, dim, the glyph in the
 * two-column gutter the product gives it (`<Box minWidth={2}>`), which here is
 * the column the assistant bullet occupies: this transcript indents every row
 * one column further than the product does, and this row is part of the
 * conversation rather than a diagnostic under it.
 *
 * It is the only timing the default transcript reports. Claude Code has no
 * per-message timing line anywhere, and prints this one only for a turn that
 * ran longer than {@link TURN_FOOTER_MIN_MS}.
 * @param durationMs - The turn's wall time.
 * @param palette - Active palette; the row is entirely in the recessed tone.
 * @param verb - The turn's verb, sampled when omitted.
 * @returns The row's styled text.
 */
export function turnFooterRow(
  durationMs: number,
  palette: Palette,
  verb: string = turnCompletionVerb(),
): string {
  return palette.dim(`${GUTTER}${TURN_GLYPH} ${verb} for ${formatTurnDuration(durationMs)}`)
}

/**
 * A step's timing summary, rendered as a self-refreshing footer that stays at
 * the tail of the step's output. Kept separate from the assistant message so
 * the timing line trails any tool cards the step appends after its message.
 *
 * Claude Code has no per-step timing line at all, so this one renders only on
 * the expanded phase of the Ctrl+O cycle — the phase a user opens to inspect
 * the run. The default transcript keeps the per-turn row alone.
 */
class StepTimingComponent extends Container {
  private completionTime: number | undefined

  constructor(
    private readonly position: StepPosition,
    private readonly events: () => readonly SessionEvent[],
    private readonly tracker: StepTimingTracker,
    private readonly now: () => number,
    private readonly palette: Palette,
    private visibility: ToolCardVisibility,
  ) {
    super()
    this.rebuild()
  }

  complete(time: number): void {
    this.completionTime = time
    this.rebuild()
  }

  /**
   * Set the Ctrl+O phase this footer renders under.
   * @param visibility - Hidden, collapsed preview, or full body.
   */
  setVisibility(visibility: ToolCardVisibility): void {
    this.visibility = visibility
    this.rebuild()
  }

  override invalidate(): void {
    this.rebuild()
    super.invalidate()
  }

  private rebuild(): void {
    this.clear()
    // The per-step breakdown is an engineering detail the product does not
    // ship; it stays available where the rest of the run's traffic is.
    if (this.visibility !== 'expanded') return
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
  /** Whether this step's `assistant/message` has landed. */
  private settled = false
  /** Whether the step closed, including one a cancelled turn closed unsettled. */
  private closed = false
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
    private readonly showReasoning: boolean,
    private thinkingPinned: boolean,
    private visibility: ToolCardVisibility,
    private readonly palette: Palette,
    private readonly mdTheme: MarkdownTheme,
    private readonly markdown: MarkdownPolicy,
  ) {
    super()
    this.timing = new StepTimingComponent(position, events, tracker, now, palette, visibility)
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
    this.settled = settled
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
   * Pin the step's timing footer to its completion time, and close the step:
   * its thinking is history from here, so the default transcript drops it —
   * unless Ctrl+T pinned it, which is what that key is for.
   * @param time - Step completion time in epoch milliseconds.
   */
  complete(time: number): void {
    this.closed = true
    this.timing.complete(time)
    this.rebuild()
  }

  override invalidate(): void {
    this.rebuild()
    this.timing.invalidate()
    super.invalidate()
  }

  /**
   * Pin or unpin this step's thinking block (Ctrl+T), then re-render.
   * @param pinned - Whether a finished step keeps its thinking on screen.
   */
  setThinkingPinned(pinned: boolean): void {
    this.thinkingPinned = pinned
    this.rebuild()
  }

  /**
   * Set the Ctrl+O phase this step renders under: it decides whether a
   * finished step's thinking is on screen, and whether its timing footer is.
   * @param visibility - Hidden, collapsed preview, or full body.
   */
  setVisibility(visibility: ToolCardVisibility): void {
    this.visibility = visibility
    this.timing.setVisibility(visibility)
    this.rebuild()
  }

  /**
   * Whether this step's thinking block is on screen.
   *
   * Claude Code keeps thinking out of the default transcript entirely — a
   * finished message's thinking is `null`, with no summary row standing in for
   * it — and shows it only under ctrl+o (its transcript mode). The one window
   * where it is live is the step itself: while the model streams, the block is
   * what says work is happening, and this port keeps that text rather than the
   * product's spinner-only line. So the block is on screen while the step runs,
   * disappears with the step that produced it, and comes back whole on the
   * expanded phase.
   *
   * Ctrl+T pins that window open: with it on, every step's thinking stays on
   * screen — this turn's and every earlier one's — because the switch is over
   * the transcript rather than over the model, which thinks either way. It is
   * checked before the Ctrl+O phase and independently of it: the two are
   * separate switches over the same rows, and neither takes the other over.
   * Pinned thinking therefore survives the hidden phase, and expanded still
   * brings thinking back with the tool bodies while the pin is off.
   *
   * A configured `showReasoning: false` still means never, in any phase and
   * whatever the pin says: that setting predates the cycle and is a deployment
   * saying this transcript does not show reasoning at all.
   */
  private showsThinking(): boolean {
    if (!this.showReasoning) return false
    if (this.thinkingPinned) return true
    if (this.visibility === 'expanded') return true
    // A cancelled turn closes its step without settling the message, so both
    // ends of the step's life are checked: neither alone retires every step.
    return !this.settled && !this.closed
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
      this.showsThinking(),
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
 * The lead-in of a tool card's result block: Claude Code's `⎿` result glyph
 * under the card's own tool name, then two columns of gap. Continuation rows
 * align under the body with {@link RESULT_INDENT}, so a wrapped result reads as
 * one left-aligned block rather than as a tree.
 *
 * The glyph sits at {@link GUTTER_WIDTH} — the column the header's tool name
 * starts in — which is where Claude Code's `MessageResponse` prefix puts it
 * (`"  ⎿  "` against a bullet at column 0).
 */
const RESULT_LEAD = `${GUTTER_INDENT}⎿  `

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
 * Every phase, in the order Ctrl+O walks them: the two common reading modes
 * adjacent, then the conversation on its own. The `/config` row that sets the
 * default steps through this same list, so the two surfaces cannot end up
 * offering different words for the same three states.
 */
export const TOOL_CARD_PHASES: readonly ToolCardVisibility[] = ['collapsed', 'expanded', 'hidden']

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
      ? `${GUTTER}${bullet} ${name}`
      : `${GUTTER}${bullet} ${name}${this.palette.dim(`(${displayInlineText(summary)})`)}`
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

/** Capitalize a fragment when it opens the sentence, leave it alone otherwise. */
function opener(text: string, first: boolean): string {
  return first ? text.charAt(0).toUpperCase() + text.slice(1) : text
}

/**
 * Thinking a group has to have absorbed before its row says so.
 *
 * Under a second there is nothing to report: the duration prints as `0s`, and
 * `Thought for 0s, read 2 files` spends a clause on a pause the user could not
 * have noticed. The same floor applies while the thinking runs, so the fragment
 * appears when the counter has something to count rather than flickering in at
 * zero.
 */
export const COLLAPSE_THINKING_MIN_MS = 1_000

/**
 * Word one collapsed group's summary row.
 *
 * Present tense while the group runs (`Thinking for 4s, reading 1 file…`), past
 * tense once it settles (`Thought for 8s, searched for 2 patterns, read 1
 * file`). The first fragment opens with a capital, later ones do not, and each
 * fragment agrees with its own count.
 *
 * The thinking the run opened with leads the sentence, because that is the
 * order it happened in: the model thought, then it went looking. A group that
 * absorbed no thinking prints no such fragment and reads exactly as before.
 * While the thinking is still open the row is in progress by definition, so
 * `now` is what makes its counter move between two events — the group carries
 * the span's start, not its length (see `groupThinkingMs`).
 *
 * Each fragment is one message rather than a verb and a noun joined here, so a
 * locale can move the count, drop the plural, or reorder the clause; the
 * capitalization is a no-op in a script without letter case.
 * @param group - The planned group.
 * @param now - Render clock, for a group whose thinking is still running.
 * @returns The row's text, without the expand hint.
 */
export function collapsedSummary(group: CollapsedGroup, now?: number): string {
  const parts: string[] = []
  const phase = group.active ? 'active' : 'settled'
  const fragment = (kind: 'search' | 'read' | 'list', count: number): void => {
    parts.push(opener(plural(count, `collapse.${kind}.${phase}`), parts.length === 0))
  }
  const thinking = groupThinkingMs(group, now)
  if (thinking >= COLLAPSE_THINKING_MIN_MS) {
    parts.push(opener(t(`collapse.thinking.${phase}`, { duration: formatTurnDuration(thinking) }), true))
  }
  if (group.searchCount > 0) fragment('search', group.searchCount)
  if (group.readCount > 0) fragment('read', group.readCount)
  if (group.listCount > 0) fragment('list', group.listCount)
  if (group.mcpCallCount > 0) {
    // One call names the server alone; the count only earns its place when the
    // group actually queried more than once — which is the distinction the
    // `.one`/`.other` pair carries for these two rows.
    const server = group.mcpServers.length > 0 ? group.mcpServers.join(t('collapse.separator')) : 'MCP'
    parts.push(opener(plural(group.mcpCallCount, `collapse.mcp.${phase}`, { server }), parts.length === 0))
  }
  const text = parts.join(t('collapse.separator'))
  return group.active ? `${text}${t('collapse.ellipsis')}` : text
}

/**
 * One run of read-only calls, rendered as the single row that replaces their
 * cards on the collapsed phase — Claude Code's `CollapsedReadSearchContent`.
 *
 * The row is the transcript's default answer to "what has it been doing": a
 * sentence of counts (`Searched for 3 patterns, read 2 files`) rather than one
 * card per file. While the group runs it is present-tense, keeps a leading
 * bullet, and carries a `⎿` row naming the operation in flight; once every call
 * has settled the bullet goes and the whole row recedes, exactly as upstream.
 * The group's own cards come back on the expanded phase, where the reconciler
 * mounts them instead of this row.
 *
 * The one addition to upstream's row: a group that contains a failed call keeps
 * its bullet, in the error color, after it settles. A collapsed row is the only
 * thing on screen for those calls, and a failure that leaves no mark at all is
 * a failure the user never learns about.
 *
 * The row also opens with the thinking that led to the run (`Thought for 8s,
 * read 2 files`), which is where this transcript states a thinking duration at
 * all — the thinking block itself keeps its own rule and disappears with the
 * step. While that thinking is still open the row re-renders per frame, so its
 * counter moves with the clock rather than with the next event.
 */
export class CollapsedGroupComponent extends CachedCardComponent {
  /**
   * @param group - The planned group this row reports.
   * @param palette - Active role palette.
   * @param displayPath - Shortens an absolute path for the `⎿` hint.
   * @param expandKey - The label of whichever key currently cycles tool cards,
   *   read per render: `app.tools.cycle` is rebindable, and a row that named
   *   the default key after a deployment moved it would send every reader to a
   *   key that does nothing.
   * @param now - Render clock, read per render so a group still thinking counts
   *   up; a group whose thinking has closed never consults it. Injected rather
   *   than defaulted to `Date.now`, like every other clock in this bundle: a
   *   row that reads the process clock cannot be rendered from a test.
   */
  constructor(
    private group: CollapsedGroup,
    private readonly palette: Palette,
    private readonly displayPath: (path: string) => string,
    private readonly expandKey: () => string,
    private readonly now: () => number,
  ) {
    super()
  }

  /**
   * Apply the group's current counts; a running group re-seals on every
   * snapshot as its calls land.
   * @param group - The freshly planned group.
   */
  setGroup(group: CollapsedGroup): void {
    this.group = group
    this.dropLines()
  }

  protected renderLines(width: number): string[] {
    const group = this.group
    const summary = collapsedSummary(group, this.now())
    // A settled group renders no bullet at all: upstream reserves the gutter
    // (`<Box minWidth={2} />`) and lets the sentence recede into the margin.
    const bullet = group.active
      ? this.palette.bold(accent(this.palette, group.failed ? CLAUDE_COLORS.error : CLAUDE_COLORS.claude, TOOL_BULLET))
      : group.failed ? accent(this.palette, CLAUDE_COLORS.error, TOOL_BULLET) : ' '
    const text = group.active ? this.palette.text(summary) : this.palette.dim(summary)
    // The row wraps rather than truncating, unlike a card header: the key that
    // opens the group is the last thing on it, and a narrow terminal must not
    // be the reason the user never learns the row can be opened.
    // Lower-cased on this row alone, which is how the upstream transcript
    // prints it; `/help` and `/hotkeys` keep the registry's own capitalisation.
    const head = `${text} ${this.palette.dim(t('collapse.expandHint', { key: this.expandKey().toLowerCase() }))}`
    const rows = ['']
    let first = true
    for (const row of wrapTextWithAnsi(head, Math.max(20, width - GUTTER_WIDTH - 2))) {
      rows.push(first ? `${GUTTER}${bullet} ${row}` : `${GUTTER_INDENT}${row}`)
      first = false
    }
    // The hint names whatever is in flight — the call, or the thinking that has
    // not reached one yet — so it belongs only to a group still in progress: a
    // settled one has nothing left to report but its counts.
    if (group.active && group.hint !== undefined) {
      const inner = Math.max(20, width - RESULT_PREFIX_WIDTH)
      const hint = formatCollapseHint(group.hint, this.displayPath)
      let lead = true
      for (const line of displayText(hint).split('\n')) {
        for (const row of wrapTextWithAnsi(this.palette.dim(line), inner)) {
          rows.push(lead ? `${this.palette.dim(RESULT_LEAD)}${row}` : `${RESULT_INDENT}${row}`)
          lead = false
        }
      }
    }
    return plainIfNoColor(this.palette, rows)
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

/** Terminal rows the plan panel never grows past, matching Claude Code's own cap. */
const TODO_MAX_ROWS = 10

/**
 * Rows the screen owes the transcript, the prompt and the status line before the
 * plan panel may spend any: below this the panel shows its one-line summary
 * whatever the user asked for.
 */
const TODO_ROW_RESERVE = 14

/** Order the expanded panel drops items in when it cannot show them all. */
const TODO_PRIORITY: Record<TodoItem['status'], number> = { in_progress: 0, pending: 1, completed: 2 }

/**
 * The plan/todo panel rendered above the prompt, expanded or collapsed.
 *
 * The panel used to be unconditional: any session whose agent wrote a plan paid
 * for it on every frame, with no key that took it back down. Ctrl+N collapses it
 * to a single summary row — what is left to do and what is being done now —
 * which is the same trade Claude Code offers, and the same one a long plan on a
 * short terminal forces anyway.
 */
export class TodoComponent implements Component {
  private todos: readonly TodoItem[] = []
  private expanded = true

  /**
   * @param palette - Active role palette.
   * @param terminalRows - The terminal's current height, read per render so a
   *   resize re-budgets the panel; the default leaves the panel unbounded for
   *   callers (tests, snapshots) that measure it on its own.
   */
  constructor(
    private readonly palette: Palette,
    private readonly terminalRows: () => number = () => Number.MAX_SAFE_INTEGER,
  ) {}

  /**
   * Replace the rendered plan items.
   * @param todos - The current todo items.
   */
  update(todos: readonly TodoItem[]): void {
    this.todos = todos
  }

  /** Whether this session has a plan at all, which is what makes Ctrl+N meaningful. */
  hasTodos(): boolean {
    return this.todos.length > 0
  }

  /** Whether the panel is showing its items rather than its one-line summary. */
  isExpanded(): boolean {
    return this.expanded
  }

  /**
   * Show the items or the summary row.
   * @param expanded - `true` for the item list, `false` for the summary row.
   */
  setExpanded(expanded: boolean): void {
    this.expanded = expanded
  }

  invalidate(): void {}

  /**
   * Items in display order, most urgent first, so a truncated panel drops the
   * least interesting rows rather than whatever happens to sort last.
   * @returns The items, in-progress first and completed last.
   */
  private ordered(): readonly TodoItem[] {
    return [...this.todos]
      .map((todo, index) => ({ todo, index }))
      .sort((left, right) => TODO_PRIORITY[left.todo.status] - TODO_PRIORITY[right.todo.status]
        || left.index - right.index)
      .map(entry => entry.todo)
  }

  /**
   * How many items the expanded panel may show on this terminal.
   * @returns The item budget; zero on a terminal with no room to spare.
   */
  private itemBudget(): number {
    const rows = this.terminalRows()
    if (rows <= TODO_MAX_ROWS) return 0
    return Math.min(TODO_MAX_ROWS, Math.max(3, rows - TODO_ROW_RESERVE))
  }

  /** One item as its icon and text, already truncated to the width. */
  private renderItem(todo: TodoItem, width: number): string {
    // Claude Code's three-state box: a checked item, a filled box for the one
    // in flight (in the brand orange, the same accent the assistant bullet
    // uses), and a hollow box for what is still queued.
    const icon = todo.status === 'completed'
      ? accent(this.palette, CLAUDE_COLORS.success, '✔')
      : todo.status === 'in_progress'
        ? accent(this.palette, CLAUDE_COLORS.claude, '◼')
        : this.palette.dim('◻')
    const content = displayText(todo.content)
    // A finished item is struck through as well as recessed, and the one in
    // flight is bold, so a glance at the panel separates done from doing from
    // queued without reading the icons.
    const text: string = todo.status === 'completed'
      ? this.palette.strike(this.palette.dim(content))
      : todo.status === 'in_progress' ? this.palette.bold(content) : content
    return truncateToWidth(`  ${icon} ${text}`, width, '')
  }

  /** Counts of each status, for the summary and overflow rows. */
  private counts(todos: readonly TodoItem[]): { inProgress: number; pending: number; completed: number } {
    return {
      inProgress: todos.filter(todo => todo.status === 'in_progress').length,
      pending: todos.filter(todo => todo.status === 'pending').length,
      completed: todos.filter(todo => todo.status === 'completed').length,
    }
  }

  /**
   * The collapsed row: how much of the plan is done, and what is being worked
   * on now (or what comes next when nothing is in flight).
   * @param width - Render width.
   * @returns The single summary row.
   */
  private renderSummary(width: number): string {
    const { completed } = this.counts(this.todos)
    const active = this.todos.find(todo => todo.status === 'in_progress')
      ?? this.todos.find(todo => todo.status === 'pending')
    const next = active === undefined ? '' : ` · Next: ${displayText(active.content)}`
    const summary = `Plan ${String(completed)}/${String(this.todos.length)} done${next}`
    return truncateToWidth(this.palette.dim(`  ${summary}`), width, '…')
  }

  render(width: number): string[] {
    if (this.todos.length === 0) return []
    const budget = this.itemBudget()
    // A terminal with no rows to spare gets the summary whatever the toggle
    // says: Claude Code hides the panel entirely there, but a plan the user
    // cannot see and cannot ask about is worse than one dim row.
    if (!this.expanded || budget === 0) return plainIfNoColor(this.palette, ['', this.renderSummary(width)])
    const ordered = this.ordered()
    const shown = ordered.slice(0, budget)
    const hidden = this.counts(ordered.slice(budget))
    const lines: string[] = [this.palette.bold(this.palette.accent('Plan'))]
    for (const todo of shown) lines.push(this.renderItem(todo, width))
    const overflow = [
      hidden.inProgress === 0 ? undefined : `${String(hidden.inProgress)} in progress`,
      hidden.pending === 0 ? undefined : `${String(hidden.pending)} pending`,
      hidden.completed === 0 ? undefined : `${String(hidden.completed)} completed`,
    ].filter((part): part is string => part !== undefined)
    if (overflow.length > 0) {
      lines.push(truncateToWidth(this.palette.dim(`   … +${overflow.join(', ')}`), width, ''))
    }
    return plainIfNoColor(this.palette, ['', ...lines])
  }
}

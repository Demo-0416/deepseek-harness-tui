/**
 * Claude Code's markdown-to-ANSI pipeline, ported from `utils/markdown.ts`
 * (`formatToken`) and `components/Markdown.tsx` (block spacing, the table
 * exception, the no-syntax fast path) as a pure module: no React, no Ink, no
 * global `marked` mutation.
 *
 * Four deliberate departures from the upstream source:
 *
 * - Styling is injected. Upstream hard-codes `chalk` plus a theme lookup;
 *   here every visual decision is a {@link MarkdownAnsiTheme} function, and
 *   {@link claudeMarkdownTheme} reproduces the upstream choices on top of
 *   {@link ../render/palette.ts | CLAUDE_COLORS}.
 * - Rendering is synchronous and returns wrapped rows rather than one joined
 *   string, so a pi-tui component can render inside its own `render(width)`
 *   pass. Syntax highlighting is therefore not bundled: upstream resolves
 *   `cli-highlight` behind a React `Suspense` boundary and re-renders when it
 *   lands, which a synchronous `render(width)` has no equivalent of. A fenced
 *   block is styled as a block instead — indented and in Claude Code's own code
 *   tone, the same tone an inline codespan gets — and a host that wants real
 *   per-token highlighting injects a synchronous {@link MarkdownHighlighter}
 *   through {@link MarkdownRenderOptions.highlight}.
 * - Wrapping is delegated to pi-tui's `wrapTextWithAnsi`, which is ANSI-, OSC 8-
 *   and East-Asian-width-aware. Nothing here computes a column count by hand.
 * - Three upstream bugs are not reproduced: a task-list checkbox token used to
 *   contribute a bare indent (and no `[ ]` marker) to its list item; a `del`
 *   token is dropped by disabling the tokenizer on a *private* `Marked`
 *   instance instead of on the shared singleton; and the markdown sniff reads
 *   the whole string rather than its first 500 characters, which is the
 *   difference between rendering and not rendering a Chinese answer (see
 *   {@link hasMarkdownSyntax}).
 *
 * Tables are a monospace text block with the upstream React component's own
 * glyphs and column algorithm (`MarkdownTable.tsx`: box-drawing borders, `│`
 * walls, centered header): the widths are fitted to the render width and cell
 * content wraps inside its column, because a table padded to its widest cell
 * is re-wrapped by the caller the moment it is wider than the terminal, and a
 * re-wrapped table is a wall of stray glyphs.
 * @module @deepseek-ai/dsh-tui/render/markdown
 */

import { stripTerminalSequences, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui'
import { Marked, type Token, type Tokens } from 'marked'
import { CLAUDE_COLORS, dim, fg } from './palette.ts'

/**
 * Line separator. Always `\n` — `os.EOL` is `\r\n` on Windows and the stray
 * `\r` becomes a visible column in every width computation downstream.
 */
const EOL = '\n'

/** `▎` left one-quarter block: the bar prefixed to each blockquote line. */
const BLOCKQUOTE_BAR = '▎'

/** OSC 8 hyperlink open, `ESC ] 8 ; ;`. */
const OSC8_START = '\x1b]8;;'
/** OSC 8 terminator; BEL is accepted more widely than `ESC \`. */
const OSC8_END = '\x07'

/** Basic (non-truecolor) blue, the one color that survives a wrap inside OSC 8. */
const BLUE = '\x1b[34m'
/** Close a foreground span. */
const FG_DEFAULT = '\x1b[39m'

/**
 * Build a *nesting-safe* SGR attribute wrapper.
 *
 * A naive `open + text + close` breaks on nesting: `**a *b* c**` closes italic
 * in the middle and the terminal drops bold for `c` too, because bold and italic
 * share no state. Re-opening the attribute at every close already inside `text`
 * is what chalk does, and it is the only reason emphasis survives a heading or a
 * blockquote that contains its own emphasis.
 * @param open - The opening SGR sequence.
 * @param close - The matching closing sequence.
 * @returns A styling function safe to nest inside itself.
 */
function attribute(open: string, close: string): (text: string) => string {
  return text => `${open}${text.includes(close) ? text.replaceAll(close, open) : text}${close}`
}

/** Bold, nesting-safe. */
const bold = attribute('\x1b[1m', '\x1b[22m')
/** Italic, nesting-safe. */
const italic = attribute('\x1b[3m', '\x1b[23m')
/** Underline, nesting-safe. */
const underline = attribute('\x1b[4m', '\x1b[24m')

/**
 * Every visual decision the renderer makes, as a styling function.
 *
 * All slots are `(text: string) => string`; {@link MarkdownAnsiTheme.heading}
 * additionally receives the heading level, which a plain `string => string`
 * function may simply ignore.
 */
export interface MarkdownAnsiTheme {
  /**
   * A heading's text.
   * @param text - The already-formatted heading content.
   * @param depth - Heading level, 1–6.
   */
  readonly heading: (text: string, depth: number) => string
  /** `**strong**` emphasis. */
  readonly bold: (text: string) => string
  /** `*em*` emphasis, and the body of a blockquote line. */
  readonly italic: (text: string) => string
  /** An inline `` `codespan` ``. */
  readonly code: (text: string) => string
  /**
   * One line of a fenced code block that no highlighter covered. Applied per
   * line rather than per block so every wrapped row carries its own color: a
   * single span opened around a whole block ends at the first row break.
   */
  readonly codeBlock: (text: string) => string
  /** A link's display text (inside the OSC 8 sequence, when hyperlinks are on). */
  readonly link: (text: string) => string
  /** The `▎` bar prefixed to each blockquote line. */
  readonly quote: (text: string) => string
  /** A list marker: `-`, `1.`, `a.`, or `i.`. */
  readonly listBullet: (text: string) => string
  /** A thematic break. */
  readonly hr: (text: string) => string
}

/**
 * Claude Code's own styling, on {@link ../render/palette.ts | CLAUDE_COLORS}.
 *
 * `codeBlock` paints a fenced block in the same tone as an inline codespan.
 * Upstream leaves it unstyled because `cli-highlight` colors it token by token;
 * with no highlighter that fallback is *literally* indistinguishable from
 * prose, so the block keeps the one color the product already reads as code.
 * `listBullet` is intentionally identity — upstream renders a list marker at
 * plain text weight. `hr` is dimmed: a rule is chrome, and at full weight it
 * reads as content.
 */
export const claudeMarkdownTheme: MarkdownAnsiTheme = {
  heading: (text, depth) => (depth === 1 ? bold(italic(underline(text))) : bold(text)),
  bold: text => bold(text),
  italic: text => italic(text),
  code: text => fg(CLAUDE_COLORS.permission, text),
  codeBlock: text => fg(CLAUDE_COLORS.permission, text),
  link: text => `${BLUE}${text}${FG_DEFAULT}`,
  quote: text => dim(text),
  listBullet: text => text,
  hr: text => dim(text),
}

/**
 * A synchronous syntax highlighter for a fenced code block.
 * @param code - The block body, without its fences.
 * @param language - The fence's language id.
 * @returns The highlighted block, or `undefined` to render it plain.
 */
export type MarkdownHighlighter = (code: string, language: string) => string | undefined

/** Knobs that are not styling. */
export interface MarkdownRenderOptions {
  /**
   * Highlighter for fenced code blocks. With none — the default — a block is
   * styled line by line through {@link MarkdownAnsiTheme.codeBlock}. A
   * highlighter is only ever consulted for a fence that named its language.
   */
  readonly highlight?: MarkdownHighlighter
  /**
   * Emit OSC 8 hyperlinks for links. When `false`, a link degrades to its bare
   * URL — upstream's fallback on terminals without hyperlink support.
   * @defaultValue `true`
   */
  readonly hyperlinks?: boolean
}

// ---------------------------------------------------------------------------
// Lexing
// ---------------------------------------------------------------------------

/**
 * A private lexer. Strikethrough is disabled because the model writes `~` for
 * "approximately" (`~100ms`) far more often than it means struck-through text —
 * and doing it on an owned instance leaves the caller's `marked` singleton
 * untouched.
 */
const lexer = new Marked({
  tokenizer: {
    del: () => undefined,
  },
})

/**
 * Any markdown marker, or an ordered-list start at the beginning of a line.
 * One pass instead of ten `includes` scans.
 */
const MD_SYNTAX_RE = /[#*`|[>\-_~]|\n\n|^\d+\. |\n\d+\. /

/**
 * Whether `text` contains anything the lexer would treat as markdown.
 *
 * The whole string is scanned. Upstream samples the first 500 characters on the
 * theory that markdown announces itself early, but that theory is written for
 * English: a Chinese answer opens with a paragraph that carries no ASCII marker
 * at all, and the table or fence it ends with lands well past character 500.
 * The document then renders as one plain paragraph — raw pipes, raw fences —
 * and because the sniff is monotone in nothing, every streamed delta re-decides
 * the same way and the answer never converts. One `O(n)` regex pass against a
 * misrendered answer is not a trade; the render itself is cached per
 * `(text, width)` by the component that mounts it.
 * @param text - The candidate source.
 * @returns `true` when the full lexer is needed.
 */
export function hasMarkdownSyntax(text: string): boolean {
  return MD_SYNTAX_RE.test(text)
}

/**
 * Lex `text`, taking a fast path when it holds no markdown syntax at all.
 *
 * The fast path reconstructs the single paragraph token the lexer would have
 * produced, which is one allocation against a full GFM parse.
 * @param text - The markdown source.
 * @returns The top-level token list.
 */
function lexMarkdown(text: string): readonly Token[] {
  if (!hasMarkdownSyntax(text)) {
    const paragraph: Tokens.Paragraph = {
      type: 'paragraph',
      raw: text,
      text,
      tokens: [{ type: 'text', raw: text, text }],
    }
    return [paragraph]
  }
  return lexer.lexer(text)
}

// ---------------------------------------------------------------------------
// Fenced code blocks
// ---------------------------------------------------------------------------

/**
 * Columns a fenced block is indented by. Upstream indents by nothing and leans
 * on `cli-highlight` to tell code from prose; with the highlighter optional the
 * indent is what still reads as a block when the colors are stripped (a no-color
 * terminal, a piped transcript, a copy out of scrollback).
 */
const CODE_BLOCK_INDENT = '  '

/**
 * The highlighter's language id for a fence info string.
 *
 * A fence may carry metadata (` ```ts twoslash `), so only the first word is
 * the language.
 * @param lang - The fence info string, if any.
 * @returns A language id, or `undefined` for a bare fence.
 */
function normalizeLanguage(lang: string | undefined): string | undefined {
  const first = (lang ?? '').trim().split(/\s+/u)[0]
  if (first === undefined || first === '') return undefined
  return first.toLowerCase()
}

/**
 * Render a fenced code block: indented, and styled per line.
 *
 * The fence's language is passed to the highlighter and otherwise dropped — no
 * language label is drawn, which is upstream's own choice — and a highlighter's
 * output is indented but never re-styled, since it already carries its colors.
 * @param code - The `code` token.
 * @param ctx - Theme, highlighter, and hyperlink policy.
 * @returns The rendered block, ending in a newline.
 */
function formatCodeBlock(code: Tokens.Code, ctx: FormatContext): string {
  const language = normalizeLanguage(code.lang)
  const highlighted = language === undefined ? undefined : ctx.highlight?.(code.text, language)
  return (
    (highlighted ?? code.text)
      .split(EOL)
      .map(line => {
        // A blank line keeps no indent: trailing spaces are copied out of the
        // transcript and read as stray whitespace.
        if (stripTerminalSequences(line).trim() === '') return ''
        return CODE_BLOCK_INDENT + (highlighted === undefined ? ctx.theme.codeBlock(line) : line)
      })
      .join(EOL) + EOL
  )
}

// ---------------------------------------------------------------------------
// Token formatting
// ---------------------------------------------------------------------------

/** Everything the recursive formatter needs that does not change per token. */
interface FormatContext {
  readonly theme: MarkdownAnsiTheme
  /** Injected highlighter, or `undefined` to style fenced blocks by theme. */
  readonly highlight: MarkdownHighlighter | undefined
  readonly hyperlinks: boolean
  /**
   * Columns the caller will wrap the result to. Only a table reads it — every
   * other token wraps as prose, and only a table has to be laid out to a width
   * to keep its columns.
   */
  readonly width: number
}

/** A token's children, or an empty list — `Tokens.Generic` may carry none. */
function tokensOf(token: Token): readonly Token[] {
  return (token as { tokens?: Token[] }).tokens ?? []
}

/** A token's `text` field, or `''` when it has none. */
function textOf(token: Token): string {
  const value = (token as { text?: unknown }).text
  return typeof value === 'string' ? value : ''
}

/** Render a token's children at top level (no list context, no parent). */
function inner(token: Token, ctx: FormatContext): string {
  return tokensOf(token)
    .map(child => formatToken(child, ctx, 0, null, null))
    .join('')
}

/** Wrap `content` in an OSC 8 hyperlink, or degrade to the bare URL. */
function hyperlink(ctx: FormatContext, url: string, content?: string): string {
  if (!ctx.hyperlinks) return ctx.theme.link(url)
  const display = ctx.theme.link(content ?? url)
  return `${OSC8_START}${url}${OSC8_END}${display}${OSC8_START}${OSC8_END}`
}

/**
 * Render one marked token to an ANSI string.
 *
 * The returned string carries its own newlines — block tokens end with `\n`,
 * headings with two — so a caller concatenating siblings gets the upstream
 * spacing for free.
 * @param token - The token to render.
 * @param ctx - Theme, highlighter, and hyperlink policy.
 * @param listDepth - Nesting level inside lists; drives indent and marker style.
 * @param orderedListNumber - This item's number, or `null` in an unordered list.
 * @param parent - The enclosing token, which changes how `text` renders.
 * @returns The rendered fragment.
 */
function formatToken(
  token: Token,
  ctx: FormatContext,
  listDepth: number,
  orderedListNumber: number | null,
  parent: Token | null,
): string {
  switch (token.type) {
    case 'blockquote': {
      // Prefix each line with a bar. The text stays italic at normal
      // brightness — dimming it too is nearly invisible on dark themes.
      const bar = ctx.theme.quote(BLOCKQUOTE_BAR)
      return inner(token, ctx)
        .split(EOL)
        .map(line => (stripTerminalSequences(line).trim() === '' ? line : `${bar} ${ctx.theme.italic(line)}`))
        .join(EOL)
    }
    case 'code':
      return formatCodeBlock(token as Tokens.Code, ctx)
    case 'codespan':
      return ctx.theme.code(textOf(token))
    case 'em':
      return ctx.theme.italic(
        tokensOf(token)
          .map(child => formatToken(child, ctx, 0, null, parent))
          .join(''),
      )
    case 'strong':
      return ctx.theme.bold(
        tokensOf(token)
          .map(child => formatToken(child, ctx, 0, null, parent))
          .join(''),
      )
    case 'heading':
      return ctx.theme.heading(inner(token, ctx), (token as Tokens.Heading).depth) + EOL + EOL
    case 'hr':
      return ctx.theme.hr('---')
    case 'image':
      return (token as Tokens.Image).href
    case 'link': {
      const link = token as Tokens.Link
      // A mailto link is not worth making clickable — show the address.
      if (link.href.startsWith('mailto:')) return link.href.slice('mailto:'.length)
      const linkText = tokensOf(token)
        .map(child => formatToken(child, ctx, 0, null, token))
        .join('')
      const plainLinkText = stripTerminalSequences(linkText)
      // Meaningful display text becomes the clickable label; text that merely
      // repeats the URL (or is empty) would make the link read twice.
      if (plainLinkText !== '' && plainLinkText !== link.href) return hyperlink(ctx, link.href, linkText)
      return hyperlink(ctx, link.href)
    }
    case 'list': {
      const list = token as Tokens.List
      const start = typeof list.start === 'number' ? list.start : 1
      return list.items
        .map((item, index) => formatToken(item, ctx, listDepth, list.ordered ? start + index : null, list))
        .join('')
    }
    case 'list_item':
      // The indent is applied per child and a nested list's own items indent
      // again, so levels land on 0/2/6/14 columns rather than 0/2/4/6. That
      // compounding is upstream's; it is kept so nesting reads the same here.
      return tokensOf(token)
        .filter(child => child.type !== 'checkbox')
        .map(child => `${'  '.repeat(listDepth)}${formatToken(child, ctx, listDepth + 1, orderedListNumber, token)}`)
        .join('')
    case 'paragraph':
      return inner(token, ctx) + EOL
    case 'space':
    case 'br':
      return EOL
    case 'text': {
      if (parent?.type === 'link') {
        // Already inside a markdown link; the link case wraps this in OSC 8.
        return textOf(token)
      }
      if (parent?.type === 'list_item') {
        const item = parent as Tokens.ListItem
        const marker = orderedListNumber === null ? '-' : `${listNumber(listDepth, orderedListNumber)}.`
        const checkbox = item.task ? (item.checked === true ? '[x] ' : '[ ] ') : ''
        const body = tokensOf(token).length > 0 ? inner(token, ctx) : textOf(token)
        return `${ctx.theme.listBullet(marker)} ${checkbox}${body}${EOL}`
      }
      return textOf(token)
    }
    case 'table':
      return formatTable(token as Tokens.Table, ctx)
    case 'escape':
      // Markdown escape: `\)` → `)`, `\\` → `\`.
      return textOf(token)
    default:
      // `def`, `del`, `html`, `checkbox`, and any extension token render as
      // nothing, exactly as upstream does.
      return ''
  }
}

// ---------------------------------------------------------------------------
// Ordered-list markers
// ---------------------------------------------------------------------------

/** `1 → a`, `27 → aa`: a bijective base-26 label. */
function numberToLetter(value: number): string {
  let remaining = value
  let result = ''
  while (remaining > 0) {
    remaining -= 1
    result = String.fromCharCode(97 + (remaining % 26)) + result
    remaining = Math.floor(remaining / 26)
  }
  return result
}

const ROMAN_VALUES: ReadonlyArray<readonly [number, string]> = [
  [1000, 'm'],
  [900, 'cm'],
  [500, 'd'],
  [400, 'cd'],
  [100, 'c'],
  [90, 'xc'],
  [50, 'l'],
  [40, 'xl'],
  [10, 'x'],
  [9, 'ix'],
  [5, 'v'],
  [4, 'iv'],
  [1, 'i'],
]

/** `4 → iv`: lowercase Roman numerals. */
function numberToRoman(value: number): string {
  let remaining = value
  let result = ''
  for (const [amount, numeral] of ROMAN_VALUES) {
    while (remaining >= amount) {
      result += numeral
      remaining -= amount
    }
  }
  return result
}

/** An ordered item's label: digits, then letters, then Roman numerals by depth. */
function listNumber(listDepth: number, orderedListNumber: number): string {
  switch (listDepth) {
    case 2:
      return numberToLetter(orderedListNumber)
    case 3:
      return numberToRoman(orderedListNumber)
    default:
      return orderedListNumber.toString()
  }
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

/** Minimum rendered width of a table column. */
const MIN_COLUMN_WIDTH = 3

/**
 * Pad `content` to `targetWidth` according to alignment. `displayWidth` is the
 * visible width of `content`, computed by the caller so ANSI codes inside
 * `content` never affect the padding.
 */
function padAligned(
  content: string,
  displayWidth: number,
  targetWidth: number,
  align: 'left' | 'center' | 'right' | null,
): string {
  const padding = Math.max(0, targetWidth - displayWidth)
  if (align === 'center') {
    const leftPad = Math.floor(padding / 2)
    return ' '.repeat(leftPad) + content + ' '.repeat(padding - leftPad)
  }
  if (align === 'right') return ' '.repeat(padding) + content
  return content + ' '.repeat(padding)
}

/** Render one table cell's inline tokens. */
function cellContent(cell: Tokens.TableCell | undefined, ctx: FormatContext): string {
  if (cell === undefined) return ''
  return cell.tokens.map(child => formatToken(child, ctx, 0, null, null)).join('')
}

/** One table cell, measured for layout. */
interface MeasuredCell {
  /** The cell's inline tokens, already formatted. */
  readonly content: string
  /** Visible width of the whole cell on one line: the column's ideal width. */
  readonly width: number
  /** Visible width of the cell's longest word: the column's minimum width. */
  readonly wordWidth: number
}

/** Visible width of `content`, with any ANSI in it discounted. */
function displayWidth(content: string): number {
  return visibleWidth(stripTerminalSequences(content))
}

/**
 * The width of the longest run that cannot be broken across lines. A CJK cell
 * has no spaces at all, so this is the whole cell — which is exactly why a CJK
 * table has to fall through to the proportional path below.
 */
function longestWordWidth(plain: string): number {
  let widest = 0
  for (const word of plain.split(/\s+/u)) {
    if (word !== '') widest = Math.max(widest, visibleWidth(word))
  }
  return widest
}

/**
 * Chrome around the cells of an `n`-column row: the leading `│`, then a space,
 * the cell, and ` │` per column. `│ a │ b │` is 1 + 2×3 columns wide beyond
 * its cells.
 */
function tableChromeWidth(columns: number): number {
  return 1 + columns * 3
}

/**
 * Fit the columns into `available` cells' worth of space.
 *
 * Upstream's React table decides this and this port copies the decision: pay
 * every column its ideal width when the table fits, otherwise pay each its
 * minimum and split what is left in proportion to what each column asked for,
 * and when even the minimums do not fit, scale them down and let the cells
 * break mid-word.
 * @param ideal - Per column, the width that needs no wrapping.
 * @param minimum - Per column, the width that breaks no word.
 * @param available - Total cell width the row may use.
 * @returns One width per column.
 */
function fitColumns(ideal: readonly number[], minimum: readonly number[], available: number): number[] {
  const total = (widths: readonly number[]): number => widths.reduce((sum, width) => sum + width, 0)
  if (total(ideal) <= available) return [...ideal]
  if (total(minimum) <= available) {
    const overflow = ideal.map((width, index) => width - (minimum[index] ?? MIN_COLUMN_WIDTH))
    const totalOverflow = total(overflow)
    if (totalOverflow === 0) return [...minimum]
    const spare = available - total(minimum)
    return minimum.map((width, index) => width + Math.floor(((overflow[index] ?? 0) / totalOverflow) * spare))
  }
  const scale = available / total(minimum)
  const scaled = minimum.map(width => Math.max(MIN_COLUMN_WIDTH, Math.floor(width * scale)))
  // Scaling lands under `available`, but the floor on {@link MIN_COLUMN_WIDTH}
  // lifts the narrow columns back up and can put the row over it again — which
  // is the wall of stray pipes this whole layout exists to prevent. Take the
  // excess off the widest column each time, so the wide cells that caused the
  // scaling pay for it and no column drops below its floor. `available` is
  // never less than one floor per column, so this always terminates in range.
  for (let excess = total(scaled) - available; excess > 0; excess -= 1) {
    let widest = 0
    for (const [index, width] of scaled.entries()) {
      if (width > (scaled[widest] ?? 0)) widest = index
    }
    const current = scaled[widest] ?? MIN_COLUMN_WIDTH
    /* v8 ignore next -- `available >= columns * MIN_COLUMN_WIDTH`, so a row of floors always fits. */
    if (current <= MIN_COLUMN_WIDTH) break
    scaled[widest] = current - 1
  }
  return scaled
}

/** Wrap one cell to its column, as at least one line. */
function wrapCell(content: string, width: number): string[] {
  const lines = wrapTextWithAnsi(content.trimEnd(), Math.max(1, width)).filter(line => line !== '')
  return lines.length > 0 ? lines : ['']
}

/**
 * Render one table row, which may be several terminal rows tall when a cell
 * wrapped. A cell shorter than the tallest one is centered against it, which is
 * what keeps a one-word cell next to a wrapped paragraph readable.
 */
function formatRow(
  row: readonly MeasuredCell[],
  columnWidths: readonly number[],
  align: ReadonlyArray<'center' | 'left' | 'right' | null>,
  isHeader: boolean,
): string {
  const wrapped = row.map((cell, index) => wrapCell(cell.content, columnWidths[index] ?? MIN_COLUMN_WIDTH))
  const height = Math.max(1, ...wrapped.map(lines => lines.length))
  const offsets = wrapped.map(lines => Math.floor((height - lines.length) / 2))
  let output = ''
  for (let lineIndex = 0; lineIndex < height; lineIndex += 1) {
    let line = '│'
    wrapped.forEach((lines, index) => {
      const text = lines[lineIndex - (offsets[index] ?? 0)] ?? ''
      const width = columnWidths[index] ?? MIN_COLUMN_WIDTH
      // Upstream centers every header cell; only data cells read the source's
      // alignment markers.
      const cellAlign = isHeader ? 'center' : align[index] ?? null
      line += ` ${padAligned(text, displayWidth(text), width, cellAlign)} │`
    })
    output += line + EOL
  }
  return output
}

/**
 * Render a GFM table as a monospace-aligned text block, laid out to
 * {@link FormatContext.width}.
 *
 * Column widths are measured on the *visible* text, so a styled or CJK cell
 * still lines up, and a cell too wide for its column wraps inside it rather
 * than pushing the row past the terminal — a row that overflows is re-wrapped
 * by the caller, and a re-wrapped row loses every column boundary it had. The
 * one case that still overflows is a terminal too narrow for three columns per
 * cell, where there is nothing left to shrink.
 *
 * The glyphs are upstream's `MarkdownTable.tsx` verbatim: box-drawing borders
 * (`┌─┬─┐`, a `├─┼─┤` rule between every row, `└─┴─┘`), `│` cell walls, and a
 * centered header row. Alignment colons are consumed by the layout, never
 * echoed.
 * @param table - The table token.
 * @param ctx - Theme, highlighter, hyperlink policy, and render width.
 * @returns The rendered table, ending in a blank line.
 */
function formatTable(table: Tokens.Table, ctx: FormatContext): string {
  const columns = table.header.length
  if (columns === 0) return ''
  const rendered: MeasuredCell[][] = [table.header, ...table.rows].map(row =>
    table.header.map((_, index) => {
      const content = cellContent(row[index], ctx)
      const plain = stripTerminalSequences(content)
      return { content, width: visibleWidth(plain), wordWidth: longestWordWidth(plain) }
    }),
  )
  const ideal = table.header.map((_, index) =>
    Math.max(MIN_COLUMN_WIDTH, ...rendered.map(row => row[index]?.width ?? 0)),
  )
  const minimum = table.header.map((_, index) =>
    Math.max(MIN_COLUMN_WIDTH, ...rendered.map(row => row[index]?.wordWidth ?? 0)),
  )
  const available = Math.max(ctx.width - tableChromeWidth(columns), columns * MIN_COLUMN_WIDTH)
  const columnWidths = fitColumns(ideal, minimum, available)

  const border = (left: string, cross: string, right: string): string =>
    `${left}${columnWidths.map(width => '─'.repeat(width + 2)).join(cross)}${right}${EOL}`
  let output = border('┌', '┬', '┐')
  rendered.forEach((row, rowIndex) => {
    output += formatRow(row, columnWidths, table.align, rowIndex === 0)
    if (rowIndex < rendered.length - 1) output += border('├', '┼', '┤')
  })
  return output + border('└', '┴', '┘') + EOL
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Strip the blank lines around a block, but not the indent of its first line.
 *
 * A plain `trim()` would eat a fenced block's leading indent whenever the fence
 * opens the block, which is the common case: ``` ```ts ``` right after a
 * heading, or as the whole message.
 */
function trimBlankEdges(text: string): string {
  return text.replace(/^(?:[^\S\n]*\n)+/u, '').replace(/\s+$/u, '')
}

/**
 * Split `text` into rendered blocks.
 *
 * A table becomes its own block; every run of other tokens accumulates into one
 * block and is trimmed, which is what puts exactly one blank line either side of
 * a table while leaving the token-level spacing inside a run untouched.
 */
function buildBlocks(text: string, ctx: FormatContext): string[] {
  const blocks: string[] = []
  let pending = ''
  const flush = (): void => {
    const trimmed = trimBlankEdges(pending)
    if (trimmed !== '') blocks.push(trimmed)
    pending = ''
  }
  for (const token of lexMarkdown(text)) {
    if (token.type === 'table') {
      flush()
      const rendered = trimBlankEdges(formatToken(token, ctx, 0, null, null))
      if (rendered !== '') blocks.push(rendered)
      continue
    }
    pending += formatToken(token, ctx, 0, null, null)
  }
  flush()
  return blocks
}

/**
 * Render markdown to ANSI rows, already wrapped to `width`.
 *
 * Plain text with no markdown markers skips the parser entirely and is wrapped
 * as one paragraph.
 * @param text - The markdown source.
 * @param width - Terminal columns available; values below 1 are clamped.
 * @param theme - Styling functions; defaults to {@link claudeMarkdownTheme}.
 * @param options - Highlighter and hyperlink policy.
 * @returns One entry per terminal row, with a blank row between blocks. Empty
 * input renders as no rows at all.
 */
export function renderMarkdownAnsi(
  text: string,
  width: number,
  theme: MarkdownAnsiTheme = claudeMarkdownTheme,
  options: MarkdownRenderOptions = {},
): string[] {
  const usable = Math.max(1, Math.floor(width))
  const ctx: FormatContext = {
    theme,
    highlight: options.highlight,
    hyperlinks: options.hyperlinks ?? true,
    width: usable,
  }
  const rows: string[] = []
  for (const block of buildBlocks(text, ctx)) {
    if (rows.length > 0) rows.push('')
    rows.push(...wrapTextWithAnsi(block, usable))
  }
  return rows
}

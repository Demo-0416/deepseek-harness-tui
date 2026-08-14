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
 *   pass. Syntax highlighting is therefore a *pre-warmed* input, exactly as in
 *   {@link ../render/diff.ts | diff.ts}: {@link warmMarkdownHighlightCache} is
 *   awaited off the render path and {@link markdownHighlighter} reads its cache.
 * - Wrapping is delegated to pi-tui's `wrapTextWithAnsi`, which is ANSI-, OSC 8-
 *   and East-Asian-width-aware. Nothing here computes a column count by hand.
 * - Two upstream bugs are not reproduced: a task-list checkbox token used to
 *   contribute a bare indent (and no `[ ]` marker) to its list item, and a
 *   `del` token is dropped by disabling the tokenizer on a *private* `Marked`
 *   instance instead of on the shared singleton.
 *
 * Tables stay a monospace-aligned text block (upstream promotes them to a
 * flexbox React component); they are still split into their own block so the
 * blank-line rhythm around them matches.
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
  /** A fenced code block that no highlighter covered. */
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
 * `codeBlock` and `listBullet` are intentionally identity: upstream renders an
 * un-highlighted block and a list marker at plain text weight, and a code block
 * that arrives pre-highlighted already carries its own colors. `hr` is dimmed —
 * a rule is chrome, and at full weight it reads as content.
 */
export const claudeMarkdownTheme: MarkdownAnsiTheme = {
  heading: (text, depth) => (depth === 1 ? bold(italic(underline(text))) : bold(text)),
  bold: text => bold(text),
  italic: text => italic(text),
  code: text => fg(CLAUDE_COLORS.permission, text),
  codeBlock: text => text,
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
   * Highlighter for fenced code blocks. Defaults to the shared cache
   * {@link warmMarkdownHighlightCache} fills, which renders plain until warmed.
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

/** How much of a long string is sampled when sniffing for markdown syntax. */
const SYNTAX_SNIFF_CHARS = 500

/**
 * Whether `text` contains anything the lexer would treat as markdown.
 *
 * Only the first {@link SYNTAX_SNIFF_CHARS} characters are sampled: real
 * markdown announces itself early (a heading, a fence, a list), while a long
 * plain tail is exactly the case worth skipping the parse for.
 * @param text - The candidate source.
 * @returns `true` when the full lexer is needed.
 */
export function hasMarkdownSyntax(text: string): boolean {
  return MD_SYNTAX_RE.test(text.length > SYNTAX_SNIFF_CHARS ? text.slice(0, SYNTAX_SNIFF_CHARS) : text)
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
// Syntax highlighting (pre-warmed, optional)
// ---------------------------------------------------------------------------

/** Default shiki theme; only consulted when `@shikijs/cli` is installed. */
export const DEFAULT_MARKDOWN_SHIKI_THEME = 'github-dark'

/** Blocks longer than this are never highlighted. */
const MAX_HIGHLIGHT_CHARS = 100_000
/** Highlight cache capacity, in blocks. */
const HIGHLIGHT_CACHE_LIMIT = 200

const highlightCache = new Map<string, string>()

/** Cache key for one highlight request. */
function highlightKey(shikiTheme: string, language: string, code: string): string {
  return `${shikiTheme} ${language} ${code}`
}

/** Store a highlight result, evicting the oldest entries past the cache limit. */
function storeHighlight(key: string, value: string): void {
  highlightCache.delete(key)
  highlightCache.set(key, value)
  while (highlightCache.size > HIGHLIGHT_CACHE_LIMIT) {
    const oldest = highlightCache.keys().next().value
    if (oldest === undefined) break
    highlightCache.delete(oldest)
  }
}

/** Clear the highlight cache (a theme change invalidates every entry). */
export function clearMarkdownHighlightCache(): void {
  highlightCache.clear()
}

/**
 * The shiki language id for a fence info string.
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

/** Collect every fenced code block in a token tree, including nested ones. */
function collectCodeBlocks(tokens: readonly Token[], out: Array<{ code: string; language: string }>): void {
  for (const token of tokens) {
    if (token.type === 'code') {
      const language = normalizeLanguage((token as Tokens.Code).lang)
      if (language !== undefined) out.push({ code: (token as Tokens.Code).text, language })
    }
    if (token.type === 'list') {
      collectCodeBlocks((token as Tokens.List).items, out)
      continue
    }
    if (token.type === 'table') {
      const table = token as Tokens.Table
      collectCodeBlocks(table.header.flatMap(cell => cell.tokens), out)
      collectCodeBlocks(table.rows.flat().flatMap(cell => cell.tokens), out)
      continue
    }
    collectCodeBlocks(tokensOf(token), out)
  }
}

/**
 * Highlight one block off the render path.
 *
 * `@shikijs/cli` is an OPTIONAL dependency: the import is dynamic and every
 * failure path (package absent, unknown language, a throw inside shiki) leaves
 * the cache untouched, so the render falls back to plain text.
 */
async function warmOneBlock(code: string, language: string, shikiTheme: string): Promise<void> {
  if (code === '' || code.length > MAX_HIGHLIGHT_CHARS) return
  const key = highlightKey(shikiTheme, language, code)
  const hit = highlightCache.get(key)
  if (hit !== undefined) {
    storeHighlight(key, hit)
    return
  }
  try {
    // A non-literal specifier: the module is optional, so the compiler must not
    // try to resolve it and a missing package must stay a runtime fallback.
    const specifier = '@shikijs/cli'
    const loaded = (await import(specifier)) as unknown
    const codeToAnsi = (loaded as { codeToAnsi?: unknown }).codeToAnsi
    if (typeof codeToAnsi !== 'function') return
    const render = codeToAnsi as (source: string, lang: string, themeName: string) => Promise<string>
    const ansi = await render(code, language, shikiTheme)
    storeHighlight(key, ansi.endsWith('\n') ? ansi.slice(0, -1) : ansi)
  } catch {
    // Leave the block uncached; the synchronous render will emit it plain.
  }
}

/**
 * Highlight every fenced code block in `text` and cache the results, so a later
 * synchronous {@link renderMarkdownAnsi} picks them up.
 * @param text - The markdown source, exactly as it will be rendered.
 * @param shikiTheme - Shiki theme name.
 */
export async function warmMarkdownHighlightCache(
  text: string,
  shikiTheme = DEFAULT_MARKDOWN_SHIKI_THEME,
): Promise<void> {
  const blocks: Array<{ code: string; language: string }> = []
  collectCodeBlocks(lexMarkdown(text), blocks)
  for (const block of blocks) {
    await warmOneBlock(block.code, block.language, shikiTheme)
  }
}

/**
 * A synchronous highlighter reading {@link warmMarkdownHighlightCache}'s results.
 * @param shikiTheme - Shiki theme the cache was warmed with.
 * @returns A highlighter that returns `undefined` for anything not warmed yet.
 */
export function markdownHighlighter(shikiTheme = DEFAULT_MARKDOWN_SHIKI_THEME): MarkdownHighlighter {
  return (code, language) => highlightCache.get(highlightKey(shikiTheme, language, code))
}

const sharedHighlighter = markdownHighlighter()

// ---------------------------------------------------------------------------
// Token formatting
// ---------------------------------------------------------------------------

/** Everything the recursive formatter needs that does not change per token. */
interface FormatContext {
  readonly theme: MarkdownAnsiTheme
  readonly highlight: MarkdownHighlighter
  readonly hyperlinks: boolean
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
    case 'code': {
      const code = token as Tokens.Code
      const language = normalizeLanguage(code.lang)
      const highlighted = language === undefined ? undefined : ctx.highlight(code.text, language)
      return (highlighted ?? ctx.theme.codeBlock(code.text)) + EOL
    }
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

/**
 * Render a GFM table as a monospace-aligned text block.
 *
 * Column widths are measured on the *visible* text, so a styled or CJK cell
 * still lines up. Alignment colons are not echoed into the separator row.
 * @param table - The table token.
 * @param ctx - Theme, highlighter, and hyperlink policy.
 * @returns The rendered table, ending in a blank line.
 */
function formatTable(table: Tokens.Table, ctx: FormatContext): string {
  const rendered = [table.header, ...table.rows].map(row =>
    table.header.map((_, index) => {
      const content = cellContent(row[index], ctx)
      return { content, width: visibleWidth(stripTerminalSequences(content)) }
    }),
  )
  const columnWidths = table.header.map((_, index) =>
    Math.max(MIN_COLUMN_WIDTH, ...rendered.map(row => row[index]?.width ?? 0)),
  )

  let output = ''
  rendered.forEach((row, rowIndex) => {
    let line = '| '
    row.forEach((cell, index) => {
      const width = columnWidths[index] ?? MIN_COLUMN_WIDTH
      line += padAligned(cell.content, cell.width, width, table.align[index] ?? null) + ' | '
    })
    output += line.trimEnd() + EOL
    if (rowIndex === 0) {
      output += `|${columnWidths.map(width => '-'.repeat(width + 2)).join('|')}|${EOL}`
    }
  })
  return output + EOL
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

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
    const trimmed = pending.trim()
    if (trimmed !== '') blocks.push(trimmed)
    pending = ''
  }
  for (const token of lexMarkdown(text)) {
    if (token.type === 'table') {
      flush()
      const rendered = formatToken(token, ctx, 0, null, null).trim()
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
    highlight: options.highlight ?? sharedHighlighter,
    hyperlinks: options.hyperlinks ?? true,
  }
  const rows: string[] = []
  for (const block of buildBlocks(text, ctx)) {
    if (rows.length > 0) rows.push('')
    rows.push(...wrapTextWithAnsi(block, usable))
  }
  return rows
}

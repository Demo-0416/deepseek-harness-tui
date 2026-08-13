/**
 * Claude Code's inline diff renderer, ported from pi-claude-code-ui: a
 * `structuredPatch`-based parse, word-level intra-line highlighting, and two
 * layouts — a unified view, and a side-by-side split that only engages on a wide
 * enough terminal.
 *
 * Three deliberate departures from the upstream source:
 *
 * - The palette is the fixed Claude default (`_claudeStyleDefaults`), not a
 *   preset/settings system. A diff's meaning lives in its own greens and reds,
 *   so these are 24-bit constants rather than theme roles.
 * - Rendering is synchronous and returns rows rather than one joined string, so
 *   a pi-tui component can render inside its own `render(width)` pass. Syntax
 *   highlighting is therefore a *pre-warmed* input: {@link warmHighlightCache}
 *   is awaited off the render path and {@link shikiHighlighter} reads its cache.
 * - shiki is an optional peer: {@link warmHighlightCache} imports `@shikijs/cli`
 *   dynamically and falls back to plain, unhighlighted text when it is absent.
 *   The package is deliberately NOT a dependency.
 *
 * Every row a renderer emits owns its whole terminal line (it ends with a full
 * SGR reset), which is what lets background fills run to the right margin.
 * @module @deepseek-ai/dsh-tui/render/diff
 */

import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'
import { diffWords, structuredPatch } from 'diff'
import { bgAnsi, BG_DEFAULT, CLAUDE_COLORS, fgAnsi, RESET } from './palette.ts'

/** Split view engages only at this width or above; below it a diff renders unified. */
export const SPLIT_MIN_WIDTH = 150
/** Minimum per-side code width for the split view to stay readable. */
const SPLIT_MIN_CODE_WIDTH = 60
/** Split is abandoned when this share of visible rows would soft-wrap. */
const SPLIT_MAX_WRAP_RATIO = 0.2
/** Split is abandoned when this many visible rows would soft-wrap. */
const SPLIT_MAX_WRAP_LINES = 8
/** Default row budget for the split view. */
const MAX_PREVIEW_LINES = 60
/** Default row budget for the unified view, and the cap on highlightable rows. */
const MAX_RENDER_LINES = 150
/** Text beyond this size is never syntax-highlighted. */
const MAX_HL_CHARS = 32_000
/** Highlight cache entries retained (LRU). */
const CACHE_LIMIT = 48
/** Below this similarity a changed pair renders as whole-line add/remove, not a word diff. */
const WORD_DIFF_MIN_SIM = 0.15
/** Soft-wrap row budgets by terminal width. */
const MAX_WRAP_ROWS_WIDE = 3
const MAX_WRAP_ROWS_MED = 2
const MAX_WRAP_ROWS_NARROW = 1

/** Full SGR reset. Every diff row owns its line, so resetting all groups is safe. */
const D_RST = RESET
const D_BOLD = '\x1b[1m'
const D_DIM = '\x1b[2m'

const BG_ADD = bgAnsi(CLAUDE_COLORS.diffAddedBg)
const BG_DEL = bgAnsi(CLAUDE_COLORS.diffRemovedBg)
const BG_ADD_W = bgAnsi(CLAUDE_COLORS.diffAddedWordBg)
const BG_DEL_W = bgAnsi(CLAUDE_COLORS.diffRemovedWordBg)
// The gutter shares its row's fill: one continuous band from the sign column
// through the code, which is how the change reads as a single stripe.
const BG_GUTTER_ADD = BG_ADD
const BG_GUTTER_DEL = BG_DEL
/** Unfilled cells keep the terminal's own background. */
const BG_BASE = BG_DEFAULT
const BG_EMPTY = BG_DEFAULT

const FG_ADD = fgAnsi(CLAUDE_COLORS.diffAddedFg)
const FG_DEL = fgAnsi(CLAUDE_COLORS.diffRemovedFg)
const FG_DIM = fgAnsi(CLAUDE_COLORS.diffDim)
const FG_LNUM = fgAnsi(CLAUDE_COLORS.diffLineNumber)
const FG_RULE = fgAnsi(CLAUDE_COLORS.diffRule)
const FG_STRIPE = fgAnsi(CLAUDE_COLORS.diffStripe)
const FG_SAFE_MUTED = fgAnsi(CLAUDE_COLORS.diffSafeMuted)
const DIVIDER = `${FG_RULE}│${D_RST}`

/** One row of a parsed diff. `sep` is a collapsed-context marker, not file content. */
export interface DiffLine {
  type: 'add' | 'del' | 'ctx' | 'sep'
  /** 1-based line number on the old side, or `null` when the row has none. */
  oldNum: number | null
  /** 1-based line number on the new side; for a `sep` row, the skipped line count. */
  newNum: number | null
  content: string
}

/** A parsed diff: its rows and exact change totals. */
export interface ParsedDiff {
  lines: DiffLine[]
  added: number
  removed: number
  /** Combined input size, used to decide whether highlighting is affordable. */
  chars: number
}

/**
 * Highlight `code` for `language`, one entry per line. Returns `undefined` to
 * render plain — the shape a missing highlighter, an unknown language, or an
 * oversized block all take.
 */
export type DiffHighlighter = (code: string, language: string | undefined) => readonly string[] | undefined

/** Rendering budgets and inputs shared by both layouts. */
export interface DiffRenderOptions {
  /** Rows rendered before the body is clipped. */
  readonly maxLines?: number
  /** Language id for highlighting (a shiki id such as `typescript`). */
  readonly language?: string
  /** Pre-warmed highlighter; omit to render plain text. */
  readonly highlight?: DiffHighlighter
  /** Trailing hint on the clip marker. */
  readonly toggleHint?: string
}

/** Strip SGR sequences for width math. */
function diffStrip(value: string): string {
  return value.replaceAll(/\x1b\[[0-9;]*m/gu, '')
}

/** Render tabs as two spaces so a gutter-aligned layout stays aligned. */
function tabs(text: string): string {
  return text.replaceAll('\t', '  ')
}

/** Soft-wrap row budget for a width: wide terminals allow more continuation rows. */
function adaptiveWrapRows(width: number): number {
  if (width >= 180) return MAX_WRAP_ROWS_WIDE
  if (width >= 120) return MAX_WRAP_ROWS_MED
  return MAX_WRAP_ROWS_NARROW
}

/** Pad or clip an ANSI-carrying value to exactly `width` visible columns. */
function fit(value: string, width: number): string {
  if (width <= 0) return ''
  const plain = diffStrip(value)
  if (plain.length <= width) return value + ' '.repeat(width - plain.length)
  const showWidth = width > 2 ? width - 1 : width
  let visible = 0
  let index = 0
  while (index < value.length && visible < showWidth) {
    if (value[index] === '\x1b') {
      const end = value.indexOf('m', index)
      if (end !== -1) {
        index = end + 1
        continue
      }
    }
    visible += 1
    index += 1
  }
  return width > 2 ? `${value.slice(0, index)}${D_RST}${FG_DIM}›${D_RST}` : `${value.slice(0, index)}${D_RST}`
}

/** The foreground/background state a row ends in, replayed to open its next row. */
function ansiState(text: string): string {
  const matches = text.match(/\x1b\[[0-9;]*m/gu) ?? []
  let foreground = ''
  let background = ''
  for (const sequence of matches) {
    const params = sequence.slice(2, -1)
    if (params === '0') {
      foreground = ''
      background = ''
    } else if (params === '39') {
      foreground = ''
    } else if (params.startsWith('38;')) {
      foreground = sequence
    } else if (params.startsWith('48;')) {
      background = sequence
    }
  }
  return background + foreground
}

/**
 * Replace highlighted foregrounds too dark to read on a diff's own fill. Very
 * dark syntax colors vanish against the add/remove backgrounds, so they fall
 * back to one legible muted tone.
 * @param ansi - Highlighted text.
 * @returns The text with unreadable foregrounds swapped out.
 */
function normalizeShikiContrast(ansi: string): string {
  const darkFgThreshold = 72
  return ansi.replaceAll(/\x1b\[([0-9;]*)m/gu, (sequence: string, params: string) => {
    if (params === '30' || params === '90' || params === '38;5;0' || params === '38;5;8') return FG_SAFE_MUTED
    if (!params.startsWith('38;2;')) return sequence
    const parts = params.split(';').map(Number)
    if (parts.length !== 5 || parts.some(value => !Number.isFinite(value))) return sequence
    const [, , r = 0, g = 0, b = 0] = parts
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b
    return luminance < darkFgThreshold ? FG_SAFE_MUTED : sequence
  })
}

/**
 * Wrap ANSI text to `width`, padding each row with `fillBg` so a background fill
 * runs to the margin, and clipping with a `›` once `maxRows` is reached.
 */
function wrapAnsi(text: string, width: number, maxRows: number, fillBg = ''): string[] {
  if (width <= 0) return ['']
  const plain = diffStrip(text)
  if (plain.length <= width) {
    const pad = width - plain.length
    return pad > 0 ? [text + fillBg + ' '.repeat(pad) + (fillBg === '' ? '' : D_RST)] : [text]
  }

  const rows: string[] = []
  let row = ''
  let visible = 0
  let index = 0
  let onLastRow = false
  let effectiveWidth = width

  while (index < text.length) {
    if (!onLastRow && rows.length >= maxRows - 1) {
      onLastRow = true
      effectiveWidth = width > 2 ? width - 1 : width
    }
    if (text[index] === '\x1b') {
      const end = text.indexOf('m', index)
      if (end !== -1) {
        row += text.slice(index, end + 1)
        index = end + 1
        continue
      }
    }
    if (visible >= effectiveWidth) {
      if (onLastRow) {
        let hasMore = false
        for (let scan = index; scan < text.length; scan += 1) {
          if (text[scan] === '\x1b') {
            const end = text.indexOf('m', scan)
            if (end !== -1) {
              scan = end
              continue
            }
          }
          hasMore = true
          break
        }
        if (hasMore && width > 2) row += `${D_RST}${FG_DIM}›${D_RST}`
        else row += fillBg + ' '.repeat(Math.max(0, width - visible)) + D_RST
        rows.push(row)
        return rows
      }
      const state = ansiState(row)
      rows.push(row + D_RST)
      row = state + fillBg
      visible = 0
      if (rows.length >= maxRows - 1) {
        onLastRow = true
        effectiveWidth = width > 2 ? width - 1 : width
      }
    }
    row += text[index] ?? ''
    visible += 1
    index += 1
  }

  if (row.length > 0 || rows.length === 0) {
    rows.push(row + fillBg + ' '.repeat(Math.max(0, width - visible)) + D_RST)
  }
  return rows
}

/** A right-aligned gutter line number; the caller resets after the whole cell. */
function lnum(value: number | null, width: number, foreground = FG_LNUM): string {
  if (value === null) return ' '.repeat(width)
  const text = String(value)
  return `${foreground}${' '.repeat(Math.max(0, width - text.length))}${text}`
}

/** The `╱` fill marking a side that has no counterpart row. */
function stripes(width: number): string {
  return BG_BASE + FG_STRIPE + '╱'.repeat(width) + D_RST
}

/** A full-width horizontal rule framing a diff body. */
function diffRule(width: number): string {
  return `${BG_BASE}${FG_RULE}${'─'.repeat(width)}${D_RST}`
}

/**
 * The largest line number any row carries. Loop-based rather than
 * `Math.max(...spread)` so a huge diff cannot blow the call stack.
 */
function maxLineNumber(lines: readonly DiffLine[]): number {
  let max = 0
  for (const line of lines) {
    const value = line.oldNum ?? line.newNum ?? 0
    if (value > max) max = value
  }
  return max
}

/**
 * The add/remove proportion bar shown beside a change summary.
 * @param added - Added row count.
 * @param removed - Removed row count.
 * @param width - Available width; below 20 columns the bar is dropped.
 * @returns The bar, or `''` when there is nothing to show.
 */
export function renderDiffStatBar(added: number, removed: number, width = 80): string {
  const total = added + removed
  if (total === 0 || width < 20) return ''
  const slots = Math.max(8, Math.min(20, Math.floor(width / 14)))
  let addSlots = Math.max(0, Math.min(slots, Math.round((added / total) * slots)))
  if (added > 0 && addSlots === 0) addSlots = 1
  if (removed > 0 && addSlots >= slots) addSlots = slots - 1
  const removeSlots = Math.max(0, slots - addSlots)
  const addBar = addSlots > 0 ? `${FG_ADD}${'━'.repeat(addSlots)}${D_RST}` : ''
  const removeBar = removeSlots > 0 ? `${FG_DEL}${'━'.repeat(removeSlots)}${D_RST}` : ''
  return `${FG_DIM}[${D_RST}${addBar}${removeBar}${FG_DIM}]${D_RST}`
}

/**
 * A one-line change summary: `+A -R` followed by the proportion bar.
 * @param added - Added row count.
 * @param removed - Removed row count.
 * @param width - Available width, passed to {@link renderDiffStatBar}.
 * @returns The summary text.
 */
export function summarizeDiff(added: number, removed: number, width = 80): string {
  const parts: string[] = []
  if (added > 0) parts.push(`${FG_ADD}+${added}${D_RST}`)
  if (removed > 0) parts.push(`${FG_DEL}-${removed}${D_RST}`)
  if (parts.length === 0) return `${FG_DIM}no changes${D_RST}`
  const bar = renderDiffStatBar(added, removed, width)
  return bar === '' ? parts.join(' ') : `${parts.join(' ')} ${bar}`
}

/**
 * A change summary with hunk count and layout mode appended.
 * @param added - Added row count.
 * @param removed - Removed row count.
 * @param hunks - Hunk count; omitted from the summary when zero.
 * @param mode - Layout label (`unified`, `split`), or `''` to omit.
 * @param width - Available width, passed to {@link summarizeDiff}.
 * @returns The summary text.
 */
export function diffSummaryWithMeta(
  added: number,
  removed: number,
  hunks: number,
  mode: string,
  width = 80,
): string {
  const base = summarizeDiff(added, removed, width)
  const extras: string[] = []
  if (hunks > 0) extras.push(`${FG_DIM}${hunks} hunk${hunks === 1 ? '' : 's'}${D_RST}`)
  if (mode !== '') extras.push(`${FG_DIM}${mode}${D_RST}`)
  return extras.length > 0 ? `${base} ${FG_DIM}•${D_RST} ${extras.join(` ${FG_DIM}•${D_RST} `)}` : base
}

/**
 * The clip marker under a truncated diff, degrading through shorter phrasings
 * until one fits the available width.
 * @param remainingLines - Rows the render dropped.
 * @param hiddenHunks - Hunks the render dropped entirely.
 * @param width - Available width.
 * @param toggleHint - Key hint appended to the longest phrasing.
 * @returns The marker text, always within `width`.
 */
export function collapsedDiffHint(
  remainingLines: number,
  hiddenHunks: number,
  width = 80,
  toggleHint = 'ctrl+o to toggle',
): string {
  const candidates = [
    `… (${remainingLines} more diff lines${hiddenHunks > 0 ? ` • ${hiddenHunks} more hunks` : ''} • ${toggleHint})`,
    `… (${remainingLines} more lines${hiddenHunks > 0 ? ` • ${hiddenHunks} hunks` : ''})`,
    `… (+${remainingLines}${hiddenHunks > 0 ? ` • +${hiddenHunks}h` : ''})`,
    '…',
  ]
  for (const candidate of candidates) {
    if (visibleWidth(candidate) <= width) return candidate
  }
  return truncateToWidth('…', width, '')
}

/**
 * Whether a diff should render side-by-side at this width: wide enough for two
 * readable code columns, and few enough long rows that the split would not
 * degenerate into wrapped fragments.
 * @param diff - The parsed diff.
 * @param width - Available width.
 * @param maxRows - Row budget the caller will render.
 * @returns `true` when the split layout applies.
 */
export function shouldUseSplit(diff: ParsedDiff, width: number, maxRows = MAX_PREVIEW_LINES): boolean {
  if (diff.lines.length === 0) return false
  if (width < SPLIT_MIN_WIDTH) return false
  const numberWidth = Math.max(2, String(maxLineNumber(diff.lines)).length)
  const half = Math.floor((width - 1) / 2)
  const codeWidth = Math.max(12, half - (numberWidth + 5))
  if (codeWidth < SPLIT_MIN_CODE_WIDTH) return false
  let contentLines = 0
  let wrapCandidates = 0
  for (const line of diff.lines.slice(0, maxRows)) {
    if (line.type === 'sep') continue
    contentLines += 1
    if (tabs(line.content).length > codeWidth) wrapCandidates += 1
  }
  if (contentLines === 0) return true
  if (wrapCandidates >= SPLIT_MAX_WRAP_LINES) return false
  return wrapCandidates / contentLines < SPLIT_MAX_WRAP_RATIO
}

/** Shiki language ids keyed by lowercase file extension. */
const EXTENSION_LANGUAGES: Readonly<Record<string, string>> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  go: 'go',
  java: 'java',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  swift: 'swift',
  kt: 'kotlin',
  html: 'html',
  css: 'css',
  scss: 'scss',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  md: 'markdown',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  sql: 'sql',
  xml: 'xml',
  lua: 'lua',
  php: 'php',
  vue: 'vue',
  svelte: 'svelte',
  graphql: 'graphql',
}

/**
 * The syntax-highlighting language for a file path.
 * @param path - The file path.
 * @returns A shiki language id, or `undefined` when the extension maps to none.
 */
export function diffLanguage(path: string): string | undefined {
  const base = path.split('/').pop()?.toLowerCase() ?? ''
  if (base === 'dockerfile') return 'docker'
  if (base === 'makefile') return 'make'
  const extension = base.includes('.') ? base.split('.').pop() ?? '' : ''
  return EXTENSION_LANGUAGES[extension]
}

/** Default shiki theme; only consulted when `@shikijs/cli` is installed. */
export const DEFAULT_SHIKI_THEME = 'github-dark'

const highlightCache = new Map<string, readonly string[]>()

/** Store a highlight result, evicting the oldest entries past the cache limit. */
function touchCache(key: string, value: readonly string[]): readonly string[] {
  highlightCache.delete(key)
  highlightCache.set(key, value)
  while (highlightCache.size > CACHE_LIMIT) {
    const oldest = highlightCache.keys().next().value
    if (oldest === undefined) break
    highlightCache.delete(oldest)
  }
  return value
}

/** Cache key for one highlight request. */
function highlightKey(theme: string, language: string, code: string): string {
  return `${theme}\u0000${language}\u0000${code}`
}

/** Clear the highlight cache (a theme change invalidates every entry). */
export function clearHighlightCache(): void {
  highlightCache.clear()
}

/**
 * Highlight a block off the render path and cache the result, so a later
 * synchronous render can pick it up through {@link shikiHighlighter}.
 *
 * `@shikijs/cli` is an OPTIONAL dependency: the import is dynamic and every
 * failure path (package absent, unknown language, oversized block, a throw
 * inside shiki) resolves to the plain lines instead.
 * @param code - The block to highlight.
 * @param language - Shiki language id; `undefined` renders plain.
 * @param theme - Shiki theme name.
 * @returns One entry per line of `code`.
 */
export async function warmHighlightCache(
  code: string,
  language: string | undefined,
  theme = DEFAULT_SHIKI_THEME,
): Promise<readonly string[]> {
  if (code === '') return ['']
  if (language === undefined || code.length > MAX_HL_CHARS) return code.split('\n')
  const key = highlightKey(theme, language, code)
  const hit = highlightCache.get(key)
  if (hit !== undefined) return touchCache(key, hit)
  try {
    // A non-literal specifier: the module is optional, so the compiler must not
    // try to resolve it and a missing package must stay a runtime fallback.
    const specifier = '@shikijs/cli'
    const loaded = await import(specifier) as unknown
    const codeToAnsi = (loaded as { codeToAnsi?: unknown }).codeToAnsi
    if (typeof codeToAnsi !== 'function') return touchCache(key, code.split('\n'))
    const render = codeToAnsi as (source: string, lang: string, themeName: string) => Promise<string>
    const ansi = normalizeShikiContrast(await render(code, language, theme))
    const body = ansi.endsWith('\n') ? ansi.slice(0, -1) : ansi
    return touchCache(key, body.split('\n'))
  } catch {
    return touchCache(key, code.split('\n'))
  }
}

/**
 * A synchronous highlighter reading {@link warmHighlightCache}'s results.
 * @param theme - Shiki theme the cache was warmed with.
 * @returns A highlighter that returns `undefined` for anything not warmed yet.
 */
export function shikiHighlighter(theme = DEFAULT_SHIKI_THEME): DiffHighlighter {
  return (code, language) => {
    if (language === undefined) return undefined
    return highlightCache.get(highlightKey(theme, language, code))
  }
}

/**
 * Parse two file versions into diff rows with `contextLines` of context, with a
 * `sep` row standing in for each collapsed gap between hunks.
 * @param oldContent - The prior file text.
 * @param newContent - The new file text.
 * @param contextLines - Context rows kept around each change.
 * @returns The parsed diff and its exact totals.
 */
export function parseDiff(oldContent: string, newContent: string, contextLines = 3): ParsedDiff {
  const patch = structuredPatch('', '', oldContent, newContent, '', '', { context: contextLines })
  return fromPatch(patch.hunks, oldContent.length + newContent.length)
}

/**
 * {@link parseDiff} under an edit-distance budget: a comparison that would need
 * more than `maxEditLength` changed lines declines rather than stalling the UI
 * on a model-authored pending edit.
 * @param oldContent - The prior file text.
 * @param newContent - The new file text.
 * @param maxEditLength - Changed-line budget for the comparison.
 * @param contextLines - Context rows kept around each change.
 * @returns The parsed diff, or `undefined` when the comparison exceeded the budget.
 */
export function parseDiffBounded(
  oldContent: string,
  newContent: string,
  maxEditLength: number,
  contextLines = 3,
): ParsedDiff | undefined {
  const patch = structuredPatch('', '', oldContent, newContent, '', '', {
    context: contextLines,
    maxEditLength,
  })
  if (patch === undefined) return undefined
  return fromPatch(patch.hunks, oldContent.length + newContent.length)
}

/** Walk a structured patch's hunks into diff rows, inserting a `sep` per collapsed gap. */
function fromPatch(hunks: ReadonlyArray<{
  oldStart: number
  oldLines: number
  newStart: number
  lines: string[]
}>, chars: number): ParsedDiff {
  const lines: DiffLine[] = []
  let added = 0
  let removed = 0
  for (const [hunkIndex, hunk] of hunks.entries()) {
    const previous = hunkIndex > 0 ? hunks[hunkIndex - 1] : undefined
    if (previous !== undefined) {
      const gap = hunk.oldStart - (previous.oldStart + previous.oldLines)
      lines.push({ type: 'sep', oldNum: null, newNum: gap > 0 ? gap : null, content: '' })
    }
    let oldLine = hunk.oldStart
    let newLine = hunk.newStart
    for (const raw of hunk.lines) {
      if (raw === '\\ No newline at end of file') continue
      const marker = raw[0]
      const text = raw.slice(1)
      if (marker === '+') {
        lines.push({ type: 'add', oldNum: null, newNum: newLine, content: text })
        newLine += 1
        added += 1
      } else if (marker === '-') {
        lines.push({ type: 'del', oldNum: oldLine, newNum: null, content: text })
        oldLine += 1
        removed += 1
      } else {
        lines.push({ type: 'ctx', oldNum: oldLine, newNum: newLine, content: text })
        oldLine += 1
        newLine += 1
      }
    }
  }
  return { lines, added, removed, chars }
}

/**
 * Word-level comparison of a changed line pair: how similar the two sides are,
 * and the character ranges that actually differ on each side.
 * @param oldText - The removed line.
 * @param newText - The added line.
 * @returns Similarity in [0, 1] and the differing ranges per side.
 */
export function wordDiffAnalysis(
  oldText: string,
  newText: string,
): { similarity: number; oldRanges: Array<[number, number]>; newRanges: Array<[number, number]> } {
  if (oldText === '' && newText === '') return { similarity: 1, oldRanges: [], newRanges: [] }
  const parts = diffWords(oldText, newText)
  const oldRanges: Array<[number, number]> = []
  const newRanges: Array<[number, number]> = []
  let oldPos = 0
  let newPos = 0
  let same = 0
  for (const part of parts) {
    const length = part.value.length
    if (part.removed === true) {
      oldRanges.push([oldPos, oldPos + length])
      oldPos += length
    } else if (part.added === true) {
      newRanges.push([newPos, newPos + length])
      newPos += length
    } else {
      same += length
      oldPos += length
      newPos += length
    }
  }
  const maxLength = Math.max(oldText.length, newText.length)
  return { similarity: maxLength > 0 ? same / maxLength : 1, oldRanges, newRanges }
}

/**
 * Overlay a word-level background on already-highlighted text: the base fill
 * everywhere, the highlight fill inside `ranges`, re-applied after every reset
 * the highlighter emitted.
 */
function injectBg(
  ansiLine: string,
  ranges: ReadonlyArray<readonly [number, number]>,
  baseBg: string,
  highlightBg: string,
): string {
  if (ranges.length === 0) return baseBg + ansiLine + D_RST
  let out = baseBg
  let visible = 0
  let inHighlight = false
  let rangeIndex = 0
  let index = 0
  while (index < ansiLine.length) {
    if (ansiLine[index] === '\x1b') {
      const end = ansiLine.indexOf('m', index)
      if (end !== -1) {
        const sequence = ansiLine.slice(index, end + 1)
        out += sequence
        if (sequence === '\x1b[0m') out += inHighlight ? highlightBg : baseBg
        index = end + 1
        continue
      }
    }
    let range = ranges[rangeIndex]
    while (range !== undefined && visible >= range[1]) {
      rangeIndex += 1
      range = ranges[rangeIndex]
    }
    const want = range !== undefined && visible >= range[0] && visible < range[1]
    if (want !== inHighlight) {
      inHighlight = want
      out += inHighlight ? highlightBg : baseBg
    }
    out += ansiLine[index] ?? ''
    visible += 1
    index += 1
  }
  return out + D_RST
}

/** Word-level highlighting without a syntax highlighter: fills only, no code colors. */
function plainWordDiff(oldText: string, newText: string): { old: string; new: string } {
  const parts = diffWords(oldText, newText)
  let oldOut = ''
  let newOut = ''
  for (const part of parts) {
    if (part.removed === true) oldOut += `${BG_DEL_W}${part.value}${D_RST}${BG_DEL}`
    else if (part.added === true) newOut += `${BG_ADD_W}${part.value}${D_RST}${BG_ADD}`
    else {
      oldOut += part.value
      newOut += part.value
    }
  }
  return { old: oldOut, new: newOut }
}

/** Highlight one side's joined source, falling back to its plain lines. */
function highlightSide(
  source: readonly string[],
  options: DiffRenderOptions,
  enabled: boolean,
): readonly string[] {
  if (!enabled || options.highlight === undefined) return source
  return options.highlight(source.join('\n'), options.language) ?? source
}

/**
 * Render a diff as a unified view: one column, each changed row carrying its
 * sign, its gutter number, and a full-width background fill, with word-level
 * highlighting on a one-for-one changed pair.
 * @param diff - The parsed diff.
 * @param width - Available width in columns.
 * @param options - Budgets, language, and highlighter.
 * @returns The rendered rows.
 */
export function renderUnified(diff: ParsedDiff, width: number, options: DiffRenderOptions = {}): string[] {
  if (diff.lines.length === 0) return []
  const max = options.maxLines ?? MAX_RENDER_LINES
  const visible = diff.lines.slice(0, max)
  const numberWidth = Math.max(2, String(maxLineNumber(visible)).length)
  const codeWidth = Math.max(20, width - (numberWidth + 5))
  const wrapRows = adaptiveWrapRows(width)
  const canHighlight = diff.chars <= MAX_HL_CHARS && visible.length <= MAX_RENDER_LINES

  const oldSource: string[] = []
  const newSource: string[] = []
  for (const line of visible) {
    if (line.type === 'ctx' || line.type === 'del') oldSource.push(line.content)
    if (line.type === 'ctx' || line.type === 'add') newSource.push(line.content)
  }
  const oldHighlighted = highlightSide(oldSource, options, canHighlight)
  const newHighlighted = highlightSide(newSource, options, canHighlight)

  let oldIndex = 0
  let newIndex = 0
  let index = 0
  const out: string[] = [diffRule(width)]

  const emitRow = (
    num: number | null,
    sign: string,
    gutterBg: string,
    signFg: string,
    body: string,
    bodyBg = '',
  ): void => {
    const borderFg = sign === '-' ? FG_DEL : sign === '+' ? FG_ADD : ''
    const border = borderFg === '' ? `${BG_BASE} ` : `${borderFg}▌${D_RST}`
    const numberFg = borderFg === '' ? FG_LNUM : borderFg
    const gutter = `${border}${gutterBg}${lnum(num, numberWidth, numberFg)}${signFg}${sign} ${D_RST}${DIVIDER} `
    const continuation = `${border}${gutterBg}${' '.repeat(numberWidth + 2)}${D_RST}${DIVIDER} `
    const rows = wrapAnsi(tabs(body), codeWidth, wrapRows, bodyBg)
    out.push(`${gutter}${rows[0] ?? ''}${D_RST}`)
    for (const row of rows.slice(1)) out.push(`${continuation}${row}${D_RST}`)
  }

  while (index < visible.length) {
    const line = visible[index]
    if (line === undefined) break
    if (line.type === 'sep') {
      const gap = line.newNum
      const label = gap !== null && gap > 0 ? ` ${gap} unmodified lines ` : '···'
      const totalWidth = Math.min(width, 72)
      const pad = Math.max(0, totalWidth - label.length - 2)
      const half = Math.floor(pad / 2)
      out.push(`${BG_BASE}${FG_DIM}${'─'.repeat(half)}${label}${'─'.repeat(pad - half)}${D_RST}`)
      index += 1
      continue
    }
    if (line.type === 'ctx') {
      const highlighted = oldHighlighted[oldIndex] ?? line.content
      emitRow(line.newNum, ' ', BG_BASE, FG_DIM, `${BG_BASE}${D_DIM}${highlighted}`, BG_BASE)
      oldIndex += 1
      newIndex += 1
      index += 1
      continue
    }

    const removals: Array<{ line: DiffLine; highlighted: string }> = []
    while (index < visible.length) {
      const candidate = visible[index]
      if (candidate === undefined || candidate.type !== 'del') break
      removals.push({ line: candidate, highlighted: oldHighlighted[oldIndex] ?? candidate.content })
      oldIndex += 1
      index += 1
    }
    const additions: Array<{ line: DiffLine; highlighted: string }> = []
    while (index < visible.length) {
      const candidate = visible[index]
      if (candidate === undefined || candidate.type !== 'add') break
      additions.push({ line: candidate, highlighted: newHighlighted[newIndex] ?? candidate.content })
      newIndex += 1
      index += 1
    }

    const removal = removals.length === 1 ? removals[0] : undefined
    const addition = additions.length === 1 ? additions[0] : undefined
    const paired = removal !== undefined && addition !== undefined
      ? wordDiffAnalysis(removal.line.content, addition.line.content)
      : undefined
    if (removal !== undefined && addition !== undefined && paired !== undefined
      && paired.similarity >= WORD_DIFF_MIN_SIM) {
      if (canHighlight) {
        emitRow(removal.line.oldNum, '-', BG_GUTTER_DEL, `${FG_DEL}${D_BOLD}`, injectBg(removal.highlighted, paired.oldRanges, BG_DEL, BG_DEL_W), BG_DEL)
        emitRow(addition.line.newNum, '+', BG_GUTTER_ADD, `${FG_ADD}${D_BOLD}`, injectBg(addition.highlighted, paired.newRanges, BG_ADD, BG_ADD_W), BG_ADD)
      } else {
        const words = plainWordDiff(removal.line.content, addition.line.content)
        emitRow(removal.line.oldNum, '-', BG_GUTTER_DEL, `${FG_DEL}${D_BOLD}`, `${BG_DEL}${words.old}`, BG_DEL)
        emitRow(addition.line.newNum, '+', BG_GUTTER_ADD, `${FG_ADD}${D_BOLD}`, `${BG_ADD}${words.new}`, BG_ADD)
      }
      continue
    }
    for (const entry of removals) {
      const body = canHighlight ? entry.highlighted : entry.line.content
      emitRow(entry.line.oldNum, '-', BG_GUTTER_DEL, `${FG_DEL}${D_BOLD}`, `${BG_DEL}${body}`, BG_DEL)
    }
    for (const entry of additions) {
      const body = canHighlight ? entry.highlighted : entry.line.content
      emitRow(entry.line.newNum, '+', BG_GUTTER_ADD, `${FG_ADD}${D_BOLD}`, `${BG_ADD}${body}`, BG_ADD)
    }
  }

  out.push(diffRule(width))
  if (diff.lines.length > visible.length) {
    const hint = collapsedDiffHint(diff.lines.length - visible.length, 0, width, options.toggleHint)
    out.push(`${BG_BASE}${FG_DIM}  ${hint}${D_RST}`)
  }
  return out
}

/**
 * Render a diff side by side, old on the left and new on the right. Falls back
 * to {@link renderUnified} whenever the width or the row shapes make the split
 * unreadable ({@link shouldUseSplit}), so a caller can always ask for it.
 * @param diff - The parsed diff.
 * @param width - Available width in columns; below {@link SPLIT_MIN_WIDTH} this delegates.
 * @param options - Budgets, language, and highlighter.
 * @returns The rendered rows.
 */
export function renderSplit(diff: ParsedDiff, width: number, options: DiffRenderOptions = {}): string[] {
  const max = options.maxLines ?? MAX_PREVIEW_LINES
  if (!shouldUseSplit(diff, width, max)) return renderUnified(diff, width, options)
  if (diff.lines.length === 0) return []

  interface Row { left: DiffLine | null; right: DiffLine | null }
  const rows: Row[] = []
  let cursor = 0
  while (cursor < diff.lines.length) {
    const line = diff.lines[cursor]
    if (line === undefined) break
    if (line.type === 'sep' || line.type === 'ctx') {
      rows.push({ left: line, right: line })
      cursor += 1
      continue
    }
    const removals: DiffLine[] = []
    const additions: DiffLine[] = []
    while (cursor < diff.lines.length) {
      const candidate = diff.lines[cursor]
      if (candidate === undefined || candidate.type !== 'del') break
      removals.push(candidate)
      cursor += 1
    }
    while (cursor < diff.lines.length) {
      const candidate = diff.lines[cursor]
      if (candidate === undefined || candidate.type !== 'add') break
      additions.push(candidate)
      cursor += 1
    }
    for (let pair = 0; pair < Math.max(removals.length, additions.length); pair += 1) {
      rows.push({ left: removals[pair] ?? null, right: additions[pair] ?? null })
    }
  }

  const visible = rows.slice(0, max)
  const half = Math.floor((width - 1) / 2)
  const numberWidth = Math.max(2, String(maxLineNumber(diff.lines)).length)
  const codeWidth = Math.max(12, half - (numberWidth + 5))
  const wrapRows = adaptiveWrapRows(width)
  const canHighlight = diff.chars <= MAX_HL_CHARS

  const leftSource: string[] = []
  const rightSource: string[] = []
  for (const row of visible) {
    if (row.left !== null && row.left.type !== 'sep') leftSource.push(row.left.content)
    if (row.right !== null && row.right.type !== 'sep') rightSource.push(row.right.content)
  }
  const leftHighlighted = highlightSide(leftSource, options, canHighlight)
  const rightHighlighted = highlightSide(rightSource, options, canHighlight)

  let leftIndex = 0
  let rightIndex = 0

  interface HalfResult { gutter: string; contGutter: string; bodyRows: string[] }
  const halfBuild = (
    line: DiffLine | null,
    highlighted: string,
    ranges: ReadonlyArray<readonly [number, number]> | null,
    side: 'left' | 'right',
  ): HalfResult => {
    if (line === null) {
      const gutter = ` ${FG_STRIPE}${'╱'.repeat(numberWidth + 2)}${D_RST}${FG_RULE}│${D_RST} `
      return { gutter, contGutter: gutter, bodyRows: [stripes(codeWidth)] }
    }
    if (line.type === 'sep') {
      const gap = line.newNum
      const label = gap !== null && gap > 0 ? `··· ${gap} lines ···` : '···'
      const gutter = `${BG_BASE} ${FG_DIM}${fit('', numberWidth + 2)}${D_RST}${FG_RULE}│${D_RST} `
      return { gutter, contGutter: gutter, bodyRows: [`${BG_BASE}${FG_DIM}${fit(label, codeWidth)}${D_RST}`] }
    }
    const isDel = line.type === 'del'
    const isAdd = line.type === 'add'
    const gutterBg = isDel ? BG_GUTTER_DEL : isAdd ? BG_GUTTER_ADD : BG_BASE
    const bodyBg = isDel ? BG_DEL : isAdd ? BG_ADD : BG_BASE
    const signFg = isDel ? FG_DEL : isAdd ? FG_ADD : FG_DIM
    const sign = isDel ? '-' : isAdd ? '+' : ' '
    const num = isDel ? line.oldNum : isAdd ? line.newNum : side === 'left' ? line.oldNum : line.newNum
    const borderFg = isDel ? FG_DEL : isAdd ? FG_ADD : ''
    const border = borderFg === '' ? ` ${BG_BASE}` : `${borderFg}▌${D_RST}`
    const numberFg = borderFg === '' ? FG_LNUM : borderFg
    const body = ranges !== null && ranges.length > 0
      ? injectBg(highlighted, ranges, bodyBg, isDel ? BG_DEL_W : BG_ADD_W)
      : isDel || isAdd ? `${bodyBg}${highlighted}` : `${BG_BASE}${D_DIM}${highlighted}`
    const gutter = `${border}${gutterBg}${lnum(num, numberWidth, numberFg)}${signFg}${D_BOLD}${sign} ${D_RST}${FG_RULE}│${D_RST} `
    const contGutter = `${border}${gutterBg}${' '.repeat(numberWidth + 2)}${D_RST}${FG_RULE}│${D_RST} `
    return { gutter, contGutter, bodyRows: wrapAnsi(tabs(body), codeWidth, wrapRows, bodyBg) }
  }

  const out: string[] = []
  const headerOld = `${BG_BASE}${' '.repeat(Math.max(0, numberWidth - 2))}${FG_DEL}${D_DIM}old${D_RST}`
  const headerNew = `${BG_BASE}${' '.repeat(Math.max(0, numberWidth - 2))}${FG_ADD}${D_DIM}new${D_RST}`
  out.push(`${BG_BASE}${headerOld}${' '.repeat(Math.max(0, half - numberWidth - 1))}${FG_RULE}┊${D_RST}${headerNew}`)
  out.push(`${diffRule(half)}${FG_RULE}┊${D_RST}${diffRule(half)}`)

  for (const row of visible) {
    const { left, right } = row
    const paired = left !== null && right !== null && left.type === 'del' && right.type === 'add'
      ? wordDiffAnalysis(left.content, right.content)
      : undefined
    let leftResult: HalfResult
    let rightResult: HalfResult
    if (left !== null && right !== null && paired !== undefined && paired.similarity >= WORD_DIFF_MIN_SIM) {
      if (canHighlight) {
        leftResult = halfBuild(left, leftHighlighted[leftIndex] ?? left.content, paired.oldRanges, 'left')
        rightResult = halfBuild(right, rightHighlighted[rightIndex] ?? right.content, paired.newRanges, 'right')
      } else {
        const words = plainWordDiff(left.content, right.content)
        leftResult = halfBuild(left, words.old, null, 'left')
        rightResult = halfBuild(right, words.new, null, 'right')
      }
      leftIndex += 1
      rightIndex += 1
    } else {
      const leftBody = left !== null && left.type !== 'sep' ? leftHighlighted[leftIndex++] ?? left.content : ''
      const rightBody = right !== null && right.type !== 'sep' ? rightHighlighted[rightIndex++] ?? right.content : ''
      leftResult = halfBuild(left, leftBody, null, 'left')
      rightResult = halfBuild(right, rightBody, null, 'right')
    }
    const rowCount = Math.max(leftResult.bodyRows.length, rightResult.bodyRows.length)
    for (let bodyRow = 0; bodyRow < rowCount; bodyRow += 1) {
      const leftGutter = bodyRow === 0 ? leftResult.gutter : leftResult.contGutter
      const rightGutter = bodyRow === 0 ? rightResult.gutter : rightResult.contGutter
      const leftBody = leftResult.bodyRows[bodyRow]
        ?? (left === null ? stripes(codeWidth) : `${BG_EMPTY}${' '.repeat(codeWidth)}${D_RST}`)
      const rightBody = rightResult.bodyRows[bodyRow]
        ?? (right === null ? stripes(codeWidth) : `${BG_EMPTY}${' '.repeat(codeWidth)}${D_RST}`)
      out.push(`${leftGutter}${leftBody}${DIVIDER}${rightGutter}${rightBody}`)
    }
  }

  out.push(`${diffRule(half)}${FG_RULE}┊${D_RST}${diffRule(half)}`)
  if (rows.length > visible.length) {
    const hint = collapsedDiffHint(rows.length - visible.length, 0, width, options.toggleHint)
    out.push(`${BG_BASE}${FG_DIM}  ${hint}${D_RST}`)
  }
  return out
}

/**
 * Render a diff in whichever layout the width supports: split at
 * {@link SPLIT_MIN_WIDTH} columns and above, unified below it.
 * @param diff - The parsed diff.
 * @param width - Available width in columns.
 * @param options - Budgets, language, and highlighter.
 * @returns The rendered rows.
 */
export function renderDiff(diff: ParsedDiff, width: number, options: DiffRenderOptions = {}): string[] {
  return width >= SPLIT_MIN_WIDTH ? renderSplit(diff, width, options) : renderUnified(diff, width, options)
}

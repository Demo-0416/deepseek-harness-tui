/**
 * Branch connectors: the `├ └ │` tree that ties a tool card's result body to its
 * header row, ported from pi-claude-code-ui. A branch line carries an invisible
 * {@link WRAP_MARK} (U+E000) right after its prefix; {@link wrapMarkedLine} uses
 * it to re-align every soft-wrapped continuation under the body column instead
 * of under the glyph, which is what keeps a wrapped tool result readable.
 *
 * The connector color is a fixed gray (rgb(72,72,72)) rather than a theme role:
 * the tree is chrome that must sit visually *below* every body tone, and a
 * terminal-remapped "dim" is not reliably below the body text it frames.
 * @module @deepseek-ai/dsh-tui/render/branch
 */

import { stripTerminalSequences, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui'
import { CLAUDE_COLORS, FG_DEFAULT, fgAnsi, type Rgb } from './palette.ts'

/**
 * Private-use marker separating a line's structural prefix from its body. It is
 * a zero-information codepoint the terminal never receives: {@link wrapMarkedLine}
 * consumes it while splitting, so every rendered row is marker-free.
 */
export const WRAP_MARK = ''

/** Default connector color: a fixed gray, independent of the terminal theme. */
export const BRANCH_COLOR: Rgb = CLAUDE_COLORS.branch

/**
 * The escape that opens the connector color.
 * @param color - Connector color; defaults to {@link BRANCH_COLOR}.
 * @returns The foreground SGR open sequence.
 */
export function branchAnsi(color: Rgb = BRANCH_COLOR): string {
  return fgAnsi(color)
}

/**
 * A continuation row of a branch block, aligned under the glyph's body column.
 * @param text - The row's body text.
 * @param continued - Whether more sibling rows follow (draws `│`, else two spaces).
 * @param color - Connector color.
 * @returns The prefixed row, carrying a {@link WRAP_MARK}.
 */
export function branchIndent(text: string, continued = false, color: Rgb = BRANCH_COLOR): string {
  // Align under a bare `├ `/`└ ` — the rule glyph plus one space, or two spaces
  // once the block is closed.
  const prefix = continued ? `${branchAnsi(color)}│${FG_DEFAULT} ` : '  '
  return `${prefix}${WRAP_MARK}${text}`
}

/**
 * The first row of a branch block: a bare tee or corner, with no horizontal arm.
 * @param text - The row's body text.
 * @param continued - Whether more rows follow (`├` instead of `└`).
 * @param color - Connector color.
 * @returns The prefixed row, carrying a {@link WRAP_MARK}.
 */
export function branchLead(text: string, continued = false, color: Rgb = BRANCH_COLOR): string {
  return `${branchAnsi(color)}${continued ? '├' : '└'}${FG_DEFAULT} ${WRAP_MARK}${text}`
}

/**
 * Attach a block of content to the branch: a lead row plus aligned continuations.
 * Blank content yields the empty string so a card renders no orphan connector.
 * @param content - Newline-separated body text.
 * @param continued - Whether a sibling block follows this one.
 * @param color - Connector color.
 * @returns The branch block, or `''` when `content` is blank.
 */
export function withBranch(content: string, continued = false, color: Rgb = BRANCH_COLOR): string {
  if (content.trim() === '') return ''
  const lines = content.split('\n')
  const first = lines[0] ?? ''
  if (lines.length === 1) return branchLead(first, continued, color)
  const rest = lines.slice(1).map(line => branchIndent(line, continued, color))
  return [branchLead(first, continued, color), ...rest].join('\n')
}

/**
 * A branch block whose last row closes the tree with its own `└`: the shape used
 * when the block is the card's final section, so the tree visibly terminates.
 * @param content - Newline-separated body text.
 * @param color - Connector color.
 * @returns The branch block, or `''` when `content` is blank.
 */
export function withFinalBranchBlock(content: string, color: Rgb = BRANCH_COLOR): string {
  if (content.trim() === '') return ''
  const lines = content.split('\n')
  const first = lines[0] ?? ''
  if (lines.length === 1) return branchLead(first, false, color)
  const middle = lines.slice(1, -1).map(line => branchIndent(line, true, color))
  const last = lines.at(-1) ?? ''
  return [branchLead(first, true, color), ...middle, branchLead(last, false, color)].join('\n')
}

/**
 * Indent a rendered branch block by one column, the gap a card puts between its
 * header bullet and the tree below it. Blank rows stay blank so a drag-select
 * copies no trailing spaces.
 * @param block - A rendered branch block.
 * @returns The block indented by one space.
 */
export function indentBranchBlock(block: string): string {
  return block
    .split('\n')
    .map(line => line === '' ? line : ` ${line}`)
    .join('\n')
}

/**
 * The continuation prefix a soft-wrapped row gets: a branch lead becomes a `│`
 * of the same structural width, anything else becomes plain spaces.
 * @param prefix - The original row's prefix, ANSI included.
 * @returns The prefix continuation rows are indented with.
 */
export function markedContinuationPrefix(prefix: string): string {
  const plain = stripTerminalSequences(prefix)
  // Match bare leads (`├ `/`└ `/`│ `) and the armed forms (`├─ `/`└─ `/`│  `).
  const branchMatch = /^(\s*)(│ {2}|│ |├─ |└─ |├ |└ )/u.exec(plain)
  if (branchMatch !== null) {
    const indent = branchMatch[1] ?? ''
    const glyph = branchMatch[2] ?? ''
    // Keep the lead glyph's structural width so wrapped rows stay aligned.
    const pad = Math.max(0, visibleWidth(glyph) - 1)
    return `${indent}${branchAnsi()}│${FG_DEFAULT}${' '.repeat(pad)}`
  }
  return ' '.repeat(visibleWidth(prefix))
}

/**
 * Wrap one line to `width`, re-aligning continuations under its {@link WRAP_MARK}
 * split point. A line without the marker wraps exactly like plain pi-tui text.
 * @param line - The line to wrap; may carry a {@link WRAP_MARK}.
 * @param width - Target width in columns.
 * @returns The wrapped rows, marker-free.
 */
export function wrapMarkedLine(line: string, width: number): string[] {
  const markerIndex = line.indexOf(WRAP_MARK)
  if (markerIndex === -1) return wrapTextWithAnsi(line, width)
  const prefix = line.slice(0, markerIndex)
  const body = line.slice(markerIndex + WRAP_MARK.length)
  const bodyWidth = Math.max(1, width - visibleWidth(prefix))
  const wrapped = wrapTextWithAnsi(body, bodyWidth)
  const continuation = markedContinuationPrefix(prefix)
  return wrapped.map((part, index) => index === 0 ? `${prefix}${part}` : `${continuation}${part}`)
}

/**
 * Attach the branch tree to rows that are ALREADY fitted to the body width — a
 * rendered diff, whose rows carry background fills that must not be re-wrapped.
 * Unlike {@link renderBranchBlock} this never re-flows its input, so a row wider
 * than the body column overflows rather than wrapping.
 * @param rows - Pre-fitted body rows.
 * @param continued - Whether a sibling block follows this one.
 * @param color - Connector color.
 * @returns The prefixed rows, marker-free.
 */
export function attachBranch(
  rows: readonly string[],
  continued = false,
  color: Rgb = BRANCH_COLOR,
): string[] {
  return rows.map((row, index) => {
    const prefixed = index === 0 ? branchLead(row, continued, color) : branchIndent(row, continued, color)
    return prefixed.replace(WRAP_MARK, '')
  })
}

/**
 * Render a whole branch block to terminal rows at a given width.
 * @param block - A block produced by {@link withBranch} / {@link withFinalBranchBlock}.
 * @param width - Target width in columns.
 * @returns The wrapped rows; an empty block renders no rows.
 */
export function renderBranchBlock(block: string, width: number): string[] {
  if (block === '') return []
  return block.split('\n').flatMap(line => wrapMarkedLine(line, width))
}

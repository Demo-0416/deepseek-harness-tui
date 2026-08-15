/**
 * `/copy`'s pure half: which answers this session produced, and which one a
 * `/copy` argument is asking for.
 *
 * A module of its own rather than two closures in the entry point, because
 * "the Nth-latest answer" is the list a per-message copy would need too, and
 * that feature should not have to reach through a 5000-line entry point to get
 * the candidates.
 * @module @deepseek-ai/dsh-tui/chat/copy
 */

import { displayText } from '../components/text.ts'
import type { ChatNode } from '../core/types.ts'

/**
 * Every answer this session produced, newest first.
 *
 * Read from the store's own snapshot rather than the rendered rows: what the
 * user wants on their clipboard is the model's text, not the markdown the
 * terminal painted from it. Steps that produced only tool calls carry no text
 * and are skipped, so N counts answers that spoke — the same rule Claude
 * Code's `collectRecentAssistantTexts` applies. No lookback ceiling: the
 * candidates are already in memory, and a ceiling would make the "only N
 * answers here" refusal lie about how many there are.
 * @param nodes - the store snapshot's nodes, in log order.
 * @returns one entry per non-empty answer, newest first, already escaped.
 */
export function collectAnswerTexts(nodes: readonly ChatNode[]): string[] {
  const answers: string[] = []
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index]
    if (node?.kind !== 'assistant' || node.text.trim() === '') continue
    answers.push(displayText(node.text))
  }
  return answers
}

/** Which answer one `/copy` invocation is asking for. */
export type CopyRequest =
  | { readonly kind: 'latest' }
  | { readonly kind: 'nth'; readonly n: number }
  | { readonly kind: 'invalid'; readonly input: string }

/**
 * Parse the argument of `/copy [N]`.
 *
 * N starts at 1 and 1 is the last answer — the same numbering as Claude Code's
 * `age = n - 1`. Only decimal positive integers are taken: `1.5`, `-1`, `+1`,
 * `0x2`, and `two` all become `invalid`, so the caller can echo what it was
 * given instead of quietly treating it as 1.
 * @param rawInput - the text after the command name, leading space included.
 * @returns which answer this invocation copies.
 */
export function parseCopyArgument(rawInput: string): CopyRequest {
  const typed = rawInput.trim()
  if (typed === '') return { kind: 'latest' }
  if (!/^\d+$/u.test(typed)) return { kind: 'invalid', input: typed }
  const n = Number(typed)
  return n >= 1 ? { kind: 'nth', n } : { kind: 'invalid', input: typed }
}

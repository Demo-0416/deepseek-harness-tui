/**
 * TUI-side presentation fallbacks for tools whose definitions ship without
 * `presentCall`/`presentResult`. The reconciler consults this table when it
 * mounts a tool card, so a tool the harness renders as raw JSON can still get
 * a purpose-built card here without a harness release. Entries fill only the
 * presenter a definition is missing: a definition that grows its own presenter
 * wins over the fallback.
 * @module @deepseek-ai/dsh-tui/components/tool-presenters
 */

import type { ToolDefinition, ToolResult, ToolCallView, ToolResultView } from '@deepseek-ai/dsh-tools'
import { contentText } from './content.ts'

/** The subset of a tool definition the transcript's card actually reads. */
type PresenterPair = Required<Pick<ToolDefinition, 'presentCall' | 'presentResult'>>

/** One question as the ask_user_question schema exposes it to the model. */
interface AskQuestionArg {
  id?: string
  question?: string
  header?: string
}

/** One answer item as the ask_user_question output serializes it. */
interface AskAnswerItem {
  id?: string
  selected?: string[]
  custom?: string
}

/** The questions array from an ask_user_question call, or undefined off-shape. */
function askQuestions(args: unknown): AskQuestionArg[] | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const { questions } = args as { questions?: unknown }
  if (!Array.isArray(questions)) return undefined
  return questions.filter((q): q is AskQuestionArg => typeof q === 'object' && q !== null)
}

/**
 * Header summary for a pending ask: the first question's chip header (its
 * question text when it has none), with the question count when more follow.
 */
function askCallView(args: unknown): ToolCallView {
  const questions = askQuestions(args)
  const first = questions?.[0]
  const label = first?.header ?? first?.question
  const title = label === undefined
    ? 'question'
    : questions !== undefined && questions.length > 1
      ? `${label} (+${questions.length - 1} more)`
      : label
  // Deliberately no rawInput: the question dialog already showed every option,
  // so the card keeps only the one-line summary, the way Claude Code keeps
  // this tool out of the transcript entirely.
  return { card: 'generic', title }
}

/**
 * Completed ask: one `· question → answer` row per answer, the transcript
 * echo of what the user picked. A user-interrupted ask reads as a decline
 * rather than a failure; any unrecognized payload falls back to the raw card.
 */
function askResultView(args: unknown, result: ToolResult): ToolResultView | undefined {
  const text = contentText(result.content)
  if (result.isError) {
    if (!text.includes('interrupted before the user answered')) return undefined
    return { card: 'generic', content: [{ type: 'text', text: 'User declined to answer questions' }] }
  }
  const questions = askQuestions(args)
  let answers: AskAnswerItem[]
  try {
    const parsed: unknown = JSON.parse(text)
    const items = typeof parsed === 'object' && parsed !== null
      ? (parsed as { answers?: unknown }).answers
      : undefined
    if (!Array.isArray(items)) return undefined
    answers = items.filter((a): a is AskAnswerItem => typeof a === 'object' && a !== null)
  } catch {
    return undefined
  }
  const rows = answers.map((answer) => {
    const question = questions?.find(q => q.id === answer.id)
    const asked = question?.question ?? question?.header ?? answer.id ?? 'question'
    const picked = [
      ...answer.selected ?? [],
      ...answer.custom === undefined || answer.custom === '' ? [] : [answer.custom],
    ]
    return `· ${asked} → ${picked.length === 0 ? '(no answer)' : picked.join(', ')}`
  })
  if (rows.length === 0) return undefined
  return {
    card: 'generic',
    content: [{ type: 'text', text: ['User answered:', ...rows].join('\n') }],
  }
}

/** Fallback presenters, keyed by tool name. */
const FALLBACK_PRESENTERS: Record<string, PresenterPair> = {
  ask_user_question: { presentCall: askCallView, presentResult: askResultView },
}

/**
 * Fill a definition's missing presenters from the fallback table.
 * @param name - Tool name the card was mounted for.
 * @param definition - The registered definition, when the tool is known.
 * @returns The definition, with fallback presenters where it had none.
 */
export function withTuiPresenters(
  name: string,
  definition: ToolDefinition | undefined,
): ToolDefinition | undefined {
  const fallback = FALLBACK_PRESENTERS[name]
  if (fallback === undefined || definition === undefined) return definition
  if (definition.presentCall !== undefined && definition.presentResult !== undefined) return definition
  return {
    ...definition,
    ...definition.presentCall === undefined ? { presentCall: fallback.presentCall } : {},
    ...definition.presentResult === undefined ? { presentResult: fallback.presentResult } : {},
  }
}

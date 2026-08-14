/**
 * Text fragments the session's two status surfaces share: the `${goal}` prompt
 * value on the row above the editor, and the `/status` panel's own rows.
 *
 * Both read the same folded values, so a goal or a stats figure cannot say one
 * thing on the prompt row and another in the panel. Everything here is a pure
 * function of its inputs — reading `sessionProjections`, folding the goal, and
 * opening the panel belong to the entry point.
 * @module @deepseek-ai/dsh-tui/chat/session-summary
 */

import { stripTerminalSequences, truncateToWidth } from '@earendil-works/pi-tui'
import type { GoalSnapshot } from '@deepseek-ai/dsh-goal'
import type { SessionStatsProjection } from '@deepseek-ai/dsh-session-stats'
import { displayInlineText, displayText } from '../components/text.ts'
import { formatStatusDuration } from './timing.ts'
import { plural, t } from '../i18n/index.ts'

/**
 * Columns the prompt row spends on a goal objective.
 *
 * The prompt row already carries the workspace, branch, model, and context
 * meter; a goal is one more fragment on it, not the row's subject. Forty
 * columns is enough for a recognizable objective and short enough that the
 * fragments after it still fit an 80-column terminal. The `/status` panel shows
 * the objective in full.
 */
export const GOAL_PROMPT_MAX_WIDTH = 40

/**
 * The goal fragment for the `${goal}` prompt value.
 *
 * A completed goal is deliberately absent rather than rendered as done: the
 * prompt row reports what the next turn is working toward, and a finished goal
 * is not that. Phases that still steer a turn (`active`, `paused`, `blocked`)
 * carry their phase word, so a paused or blocked goal cannot read as a running
 * one.
 * @param goal - the session's current durable goal, when it has one.
 * @returns the fragment, or `undefined` when nothing should occupy the slot.
 */
export function formatGoalPrompt(goal: GoalSnapshot | undefined): string | undefined {
  if (goal === undefined || goal.phase === 'complete') return undefined
  // `truncateToWidth` brackets its ellipsis with SGR resets so a cut inside a
  // styled span cannot leak. The objective is plain text (`displayInlineText`
  // has already escaped every control), so those resets have nothing to close
  // and would instead close the `dim` the prompt wraps this fragment in.
  const objective = stripTerminalSequences(
    truncateToWidth(displayInlineText(goal.objective), GOAL_PROMPT_MAX_WIDTH, '…'),
  )
  return goal.phase === 'active' ? objective : `${objective} (${goal.phase})`
}

/**
 * The goal rows for the `/status` panel: the objective in full, then the
 * numbers the prompt row has no space for.
 * @param goal - the session's current durable goal, when it has one.
 * @param roundsStarted - highest admitted goal round, from the same fold.
 * @returns one label/value pair per row; empty when the session has no goal.
 */
export function goalStatusRows(
  goal: GoalSnapshot | undefined,
  roundsStarted: number,
): readonly (readonly [string, string])[] {
  if (goal === undefined) return []
  const detail = [
    goal.phase,
    `round ${String(roundsStarted)}/${String(goal.maxGoalRounds)}`,
    ...goal.blockedReason === undefined ? [] : [displayInlineText(goal.blockedReason.message)],
  ].join(' · ')
  return [
    [t('status.row.goal'), displayText(goal.objective)],
    [t('status.row.goalState'), detail],
  ]
}

/**
 * Mean milliseconds per sample, or `undefined` when nothing was sampled.
 * @param total - summed wall time.
 * @param samples - number of contributing samples.
 * @returns the mean, or `undefined` for an empty sample set.
 */
function mean(total: number, samples: number): number | undefined {
  return samples > 0 ? total / samples : undefined
}

/**
 * The `/status` row for the whole-log `sessionStats` projection.
 *
 * The panel already counts turns, steps, and tool calls off the in-memory log;
 * this row is the projection's own figures, which paging and compaction cannot
 * move, plus the wall times only it folds. Zero-sample averages are omitted
 * rather than printed as `0`, so a session that has not decoded a token says
 * nothing about its decode rate.
 * @param stats - the folded projection value.
 * @returns the formatted row.
 */
export function formatSessionStats(stats: SessionStatsProjection): string {
  const ttft = mean(stats.ttftMs, stats.ttftSteps)
  const decodeRate = stats.decodeMs > 0 ? stats.decodeTokens / (stats.decodeMs / 1000) : undefined
  return [
    plural(stats.turns, 'status.count.turn'),
    plural(stats.steps, 'status.count.step'),
    t('status.totals.model', { duration: formatStatusDuration(stats.llmMs) }),
    t('status.totals.tools', { duration: formatStatusDuration(stats.toolMs) }),
    ...ttft === undefined ? [] : [t('status.totals.ttft', { duration: formatStatusDuration(ttft) })],
    ...decodeRate === undefined ? [] : [t('status.totals.decode', { rate: decodeRate.toFixed(1) })],
  ].join(' · ')
}

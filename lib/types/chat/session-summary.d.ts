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
import type { GoalSnapshot } from '@deepseek-ai/dsh-goal';
import type { SessionStatsProjection } from '@deepseek-ai/dsh-session-stats';
/**
 * Columns the prompt row spends on a goal objective.
 *
 * The prompt row already carries the workspace, branch, model, and context
 * meter; a goal is one more fragment on it, not the row's subject. Forty
 * columns is enough for a recognizable objective and short enough that the
 * fragments after it still fit an 80-column terminal. The `/status` panel shows
 * the objective in full.
 */
export declare const GOAL_PROMPT_MAX_WIDTH = 40;
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
export declare function formatGoalPrompt(goal: GoalSnapshot | undefined): string | undefined;
/**
 * The goal rows for the `/status` panel: the objective in full, then the
 * numbers the prompt row has no space for.
 * @param goal - the session's current durable goal, when it has one.
 * @param roundsStarted - highest admitted goal round, from the same fold.
 * @returns one label/value pair per row; empty when the session has no goal.
 */
export declare function goalStatusRows(goal: GoalSnapshot | undefined, roundsStarted: number): readonly (readonly [string, string])[];
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
export declare function formatSessionStats(stats: SessionStatsProjection): string;

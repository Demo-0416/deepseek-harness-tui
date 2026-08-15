/**
 * Context-window pressure: how full the model's window is, which warning band
 * that lands in, and whether the band is new enough to be worth one row in the
 * transcript.
 *
 * Pure and i18n-free on purpose (like `./tokens.ts`): the terminal owns the
 * colour, the copy, and the frame budget; this module owns only the arithmetic
 * and the once-per-band bookkeeping, so both the prompt row and `/status` can
 * read the same numbers without a second measurement.
 * @module @deepseek-ai/dsh-tui/chat/context-pressure
 */

/** How full the window is, as three bands the UI paints differently. */
export type ContextPressureLevel = 'normal' | 'low' | 'critical'

/**
 * Remaining-window percent at or below which the row turns yellow.
 *
 * Chosen to fire BEFORE automatic compaction, not after it: the shipped
 * `thresholdRatio` of `@deepseek-ai/dsh-compaction-basic` is 0.8, so the engine
 * compacts at 20% remaining and a 25% warning is the last moment the user can
 * still choose `/compact` on their own terms.
 */
export const CONTEXT_LOW_REMAINING_PERCENT = 25

/**
 * Remaining-window percent at or below which the row turns red.
 *
 * Below automatic compaction's own trigger: reaching it means the engine is
 * absent, disabled, or has failed, and the next request is at risk of being
 * rejected by the provider.
 */
export const CONTEXT_CRITICAL_REMAINING_PERCENT = 10

/**
 * Remaining-window percent at which `@deepseek-ai/dsh-compaction-basic`
 * compacts under its shipped defaults. Documentation for the two constants
 * above; nothing branches on it.
 */
export const AUTO_COMPACT_REMAINING_PERCENT = 20

/**
 * How far back above a threshold the reading must come before that band is
 * armed again — the hysteresis on {@link nextContextAnnouncement}.
 *
 * A measurement is not monotonic: `@deepseek-ai/dsh-token-meter` reports a
 * provider-usage anchor plus a heuristic delta, so every landed anchor can
 * revise the number DOWN by more than a percentage point (10%+ on code and CJK
 * is ordinary), and a lost anchor re-estimates the whole thing. Without a band
 * of slack, one such revision across 25% re-arms the warning and the next tool
 * result writes the identical row again. The rows are appended transcript
 * history, not a recomputed live indicator, so repeats stay on screen.
 */
export const CONTEXT_REARM_MARGIN_PERCENT = 3

/** One measured reading of window pressure. */
export interface ContextPressure {
  /** Measured request pressure in tokens. */
  readonly used: number
  /** The routed model's context window in tokens. */
  readonly window: number
  /** Integer percent of the window consumed, clamped to [0, 100]. */
  readonly percentUsed: number
  /** Integer percent of the window left, `100 - percentUsed`. */
  readonly percentRemaining: number
  /** The band `percentRemaining` falls in. */
  readonly level: ContextPressureLevel
}

/**
 * Band one remaining-percentage falls in.
 * @param percentRemaining - integer percent of the window still free.
 * @returns the pressure band.
 */
export function pressureLevel(percentRemaining: number): ContextPressureLevel {
  if (percentRemaining <= CONTEXT_CRITICAL_REMAINING_PERCENT) return 'critical'
  if (percentRemaining <= CONTEXT_LOW_REMAINING_PERCENT) return 'low'
  return 'normal'
}

/**
 * Band a reading has to fall back to before the band above it counts as left.
 *
 * The same edges as {@link pressureLevel}, each widened by
 * {@link CONTEXT_REARM_MARGIN_PERCENT}: sitting one point over a threshold is
 * still inside that band as far as re-arming is concerned, so measurement noise
 * across the edge cannot produce a second copy of a row the session already
 * has.
 * @param percentRemaining - integer percent of the window still free.
 * @returns the band this reading re-arms down to.
 */
export function rearmLevel(percentRemaining: number): ContextPressureLevel {
  if (percentRemaining <= CONTEXT_CRITICAL_REMAINING_PERCENT + CONTEXT_REARM_MARGIN_PERCENT) return 'critical'
  if (percentRemaining <= CONTEXT_LOW_REMAINING_PERCENT + CONTEXT_REARM_MARGIN_PERCENT) return 'low'
  return 'normal'
}

/**
 * Order the bands so an escalation is a `>` comparison.
 * @param level - the band to rank.
 * @returns 0 for `normal`, 1 for `low`, 2 for `critical`.
 */
export function pressureRank(level: ContextPressureLevel): number {
  return level === 'critical' ? 2 : level === 'low' ? 1 : 0
}

/**
 * Measure window pressure, or report that it cannot be measured.
 *
 * Rounding matches the prompt row that shipped before this module
 * (`Math.round(used / window * 100)`), so the percentage a user already knows
 * does not move by a point the day the warning lands.
 * @param used - measured request pressure in tokens.
 * @param window - the routed model's window, or `undefined` before the adapter
 *   resolves it (a boot-order fact, not an error).
 * @returns the reading, or `undefined` when no usable window is known.
 */
export function contextPressure(used: number, window: number | undefined): ContextPressure | undefined {
  if (window === undefined || !Number.isFinite(window) || window <= 0) return undefined
  const safeUsed = Number.isFinite(used) ? Math.max(0, used) : 0
  const percentUsed = Math.min(100, Math.round(safeUsed / window * 100))
  const percentRemaining = 100 - percentUsed
  return { used: safeUsed, window, percentUsed, percentRemaining, level: pressureLevel(percentRemaining) }
}

/** Highest band already announced in this session. */
export interface ContextAnnouncementTracker {
  announced: ContextPressureLevel
}

/**
 * A tracker that has announced nothing.
 * @returns the fresh per-session tracker.
 */
export function createContextAnnouncementTracker(): ContextAnnouncementTracker {
  return { announced: 'normal' }
}

/**
 * Decide whether a band deserves a transcript row, and record the decision.
 *
 * One row per band per escalation: re-entering a band the session already
 * announced stays silent, and dropping CLEAR of a band (which is what a
 * successful compaction looks like) re-arms it. That is the whole debounce —
 * the caller runs this every frame and it writes at most twice per session per
 * compaction cycle.
 *
 * "Clear of" rather than "below", because the reading is noisy: a drop only
 * re-arms once it reaches {@link rearmLevel}, so a token count that revises
 * itself back and forth across a threshold cannot append the same warning
 * twice.
 * @param tracker - mutable per-session state; updated in place.
 * @param pressure - the reading measured now; both its band and its distance
 *   from the edge matter, so this takes the reading rather than the band.
 * @returns the band to announce, or `undefined` when nothing new happened.
 */
export function nextContextAnnouncement(
  tracker: ContextAnnouncementTracker,
  pressure: Pick<ContextPressure, 'level' | 'percentRemaining'>,
): Exclude<ContextPressureLevel, 'normal'> | undefined {
  const { level } = pressure
  const rank = pressureRank(level)
  const announced = pressureRank(tracker.announced)
  // Not news: either the band is one this session already announced, or the
  // reading fell without clearing the band's hysteresis. Re-arm only what the
  // reading is genuinely clear of.
  if (rank <= announced) {
    const rearmed = rearmLevel(pressure.percentRemaining)
    if (pressureRank(rearmed) < announced) tracker.announced = rearmed
    return undefined
  }
  tracker.announced = level
  /* v8 ignore next -- `normal` ranks lowest, so an escalation never lands on it. */
  return level === 'normal' ? undefined : level
}

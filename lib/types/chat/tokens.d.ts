/**
 * Running token accounting for the terminal footer. Usage is keyed per
 * turn/step so replayed or re-emitted usage replaces rather than double-counts.
 * @module @deepseek-ai/dsh-tui/chat/tokens
 */
import type { TokenUsage } from '@deepseek-ai/dsh-llm';
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';
/**
 * Running token totals for the footer, keyed per turn/step so replayed or
 * re-emitted usage replaces rather than double-counts; `input` is uncached
 * input, cache buckets are disjoint.
 */
export interface SessionTokenTotals {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    readonly byStep: Map<string, TokenUsage>;
}
/**
 * Fold one step's usage into the running totals, replacing any prior usage
 * logged for the same turn/step.
 * @param totals - Running totals mutated in place.
 * @param turn - Turn index of the usage.
 * @param step - Step index of the usage.
 * @param usage - The step's token usage.
 */
export declare function recordTokenUsage(totals: SessionTokenTotals, turn: number, step: number, usage: TokenUsage): void;
/**
 * Fold a usage-bearing session event into the running totals.
 * @param totals - Running totals mutated in place.
 * @param event - Session event; ignored when it carries no usage.
 */
export declare function recordEventUsage(totals: SessionTokenTotals, event: SessionEvent): void;
/**
 * Share of billed input (prompt) tokens served from the provider cache, as an
 * integer percent, or `undefined` before any input is billed (avoids 0/0 and a
 * meaningless rate on an empty session).
 * @param totals - Running totals to measure.
 * @returns The cache hit rate percent, or `undefined` when no input is billed.
 */
export declare function cacheHitRate(totals: SessionTokenTotals): number | undefined;
/**
 * Fold every usage-bearing event in a session into fresh totals.
 * @param session - Session whose events supply usage.
 * @returns The accumulated token totals.
 */
export declare function sessionTokens(session: Session): SessionTokenTotals;
/**
 * Format a token count with a compact k/m suffix for the footer.
 * @param value - Token count.
 * @returns The compact display string.
 */
export declare function formatTokens(value: number): string;

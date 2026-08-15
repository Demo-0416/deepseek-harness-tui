/**
 * Local `/compact`: one explicit reduction of this session's history, over the
 * backend-independent compaction seam.
 *
 * `@deepseek-ai/dsh-command-compact` registers the same name inside the agent
 * preset's compaction realm, and this command deliberately SHADOWS it: a
 * registration made through an agent-injected context wins over an enclosing
 * preset scope's (`CommandRuntime` merges global → ancestor scopes → nearest,
 * nearest first), and every string the preset command returns is English. This
 * terminal renders its own chrome from the message table, so the outcome of a
 * compaction has to be produced here — along with the pre-checks and the
 * cancellation the preset command has no terminal to offer.
 *
 * The seam is `compactNow(agent, signal, commandId)` and takes no custom
 * summarization instructions — the backend's summarizer prompt is fixed — so
 * unlike Claude Code's `/compact <instructions>` this command is argument-free
 * and says so rather than silently dropping what the user typed. If the seam
 * ever grows a custom-instructions parameter, this command has to open its
 * argument back up or stop shadowing the preset one.
 * @module @deepseek-ai/dsh-tui/chat/compact
 */

import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { errorChain } from '@deepseek-ai/dsh-llm'
import { plural, t } from '../i18n/index.ts'
import { formatTokens } from './tokens.ts'

/** The compaction result fields this command reports on. */
export interface CompactionOutcome {
  readonly shadowedSeqs: readonly number[]
  readonly shadowedTokenCount: number
  readonly summarySeq: number
}

/**
 * The slice of `ctx.compaction` a manual compaction uses.
 *
 * Structural rather than the imported `CompactionEngine` class: the engine a
 * preset realm mounts comes from the installed app's own copy of the package,
 * so this bundle must not depend on class identity — the same reason
 * {@link manualCompactionCode} reads `name` instead of using `instanceof`.
 */
export interface ManualCompactionEngine {
  /**
   * Compact this agent's older history into one summary node.
   * @param agent - the idle agent whose surface is replaced (a `ManualCompactAgentContext`).
   * @param signal - cancellation scoped to this request.
   * @param sourceCommandId - the invoking command's pairing id.
   * @returns the result, or `null` when no safe useful range exists.
   */
  compactNow(
    agent: unknown,
    signal: AbortSignal,
    sourceCommandId?: unknown,
  ): Promise<CompactionOutcome | null>
}

/** The closed failure taxonomy `ManualCompactionError` carries. */
export type ManualCompactionErrorCode =
  | 'busy'
  | 'cancelled'
  | 'changed'
  | 'summary'
  | 'commit'
  | 'persistence'

/** Every code the seam declares, for the duck-typed recognition below. */
const MANUAL_COMPACTION_CODES: ReadonlySet<string> = new Set<ManualCompactionErrorCode>([
  'busy', 'cancelled', 'changed', 'summary', 'commit', 'persistence',
])

/** Everything one manual compaction reads, resolved by the entry point. */
export interface CompactCommandDeps {
  /**
   * The engine serving THIS agent now, re-resolved per invocation.
   *
   * A function rather than a value: `/preset` re-links a blank session to
   * another composition, and an engine captured at mount would keep compacting
   * through a service this agent no longer has.
   * @returns the engine, or `undefined` when this session composes none.
   */
  readonly engine: () => ManualCompactionEngine | undefined
  /** The agent whose history is compacted; also the `ManualCompactAgentContext`. */
  readonly agent: { readonly status: string }
  /**
   * Label of the key that cycles tool cards, for the "where is the summary" hint.
   * @returns the key label, as the keybinding manager currently reports it.
   */
  readonly expandKey: () => string
}

/**
 * Recognize a `ManualCompactionError` across package copies.
 *
 * The engine is mounted by the installed dsh app and throws ITS copy's class,
 * while this bundle resolves its own `@deepseek-ai/dsh-compaction`; `instanceof`
 * is therefore false for a genuine failure and all six classified outcomes
 * would decay into the generic one. The class fixes `name` and `code`, which is
 * what this reads instead.
 * @param error - the rejection from `compactNow`.
 * @returns the failure class, or `undefined` when this is not one.
 */
export function manualCompactionCode(error: unknown): ManualCompactionErrorCode | undefined {
  if (!(error instanceof Error)) return undefined
  if (error.name !== 'ManualCompactionError') return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' && MANUAL_COMPACTION_CODES.has(code)
    ? code as ManualCompactionErrorCode
    : undefined
}

/**
 * The localized outcome for one classified failure.
 * @param code - the failure class the backend reported.
 * @returns the sentence to show, in the active locale.
 */
export function compactFailureText(code: ManualCompactionErrorCode): string {
  switch (code) {
    case 'busy':
      return t('compact.error.busy')
    case 'cancelled':
      return t('compact.cancelled')
    case 'changed':
      return t('compact.error.changed')
    case 'summary':
      return t('compact.error.summary')
    case 'commit':
      return t('compact.error.commit')
    /* v8 ignore next 2 -- the code set is closed; the default is a future-code backstop. */
    default:
      return t('compact.error.persistence')
  }
}

/**
 * Execute one argument-free manual compaction.
 *
 * The order of the checks is the contract: an argument is refused before any
 * backend is touched, a missing engine before the agent is inspected, and a
 * busy session before a maintenance slot is claimed — each refusal is cheaper
 * and more specific than the backend diagnostic it stands in for.
 * @param deps - engine lookup, agent, and key label.
 * @param rawInput - verbatim text after the command name.
 * @param signal - the dispatching UI's cancellation signal.
 * @param commandId - lifecycle pairing id, forwarded to the backend.
 * @returns the localized outcome; an expected failure is a result, not a throw.
 */
export async function runCompactCommand(
  deps: CompactCommandDeps,
  rawInput: string,
  signal: AbortSignal,
  commandId?: unknown,
): Promise<CommandResult> {
  if (rawInput.trim() !== '') return { kind: 'error', text: t('compact.usage') }
  const engine = deps.engine()
  if (engine === undefined) return { kind: 'error', text: t('compact.unavailable') }
  // The backend refuses a non-idle agent too, by throwing `busy` out of
  // `runMaintenance`. Answering it here names what the session is doing
  // instead, and costs the agent nothing. The status is NOT interpolated: it is
  // the closed `idle | running` enum, this branch only sees the running one,
  // and splicing that English token into a translated sentence is exactly what
  // the message table exists to prevent.
  if (deps.agent.status !== 'idle') return { kind: 'error', text: t('compact.busy') }
  try {
    const result = await engine.compactNow(deps.agent, signal, commandId)
    if (result === null) return { kind: 'success', text: t('compact.nothing') }
    return {
      kind: 'success',
      text: plural(result.shadowedSeqs.length, 'compact.done', {
        items: result.shadowedSeqs.length,
        tokens: formatTokens(result.shadowedTokenCount),
        key: deps.expandKey().toLowerCase(),
      }),
      // The summary node the backend appended owns the richer presentation:
      // the transcript already renders it, and this points a client at it.
      sourceEventSeq: result.summarySeq,
    }
  } catch (error: unknown) {
    // Cancellation outranks classification: an aborted request preserves its
    // own abort reason, which may or may not arrive as a classified failure.
    if (signal.aborted) return { kind: 'error', text: t('compact.cancelled') }
    const code = manualCompactionCode(error)
    if (code !== undefined) return { kind: 'error', text: compactFailureText(code) }
    return { kind: 'error', text: t('compact.failed', { error: errorChain(error) }) }
  }
}

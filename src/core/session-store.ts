/**
 * Per-session read model: subscribes to the dsh event bus, folds every event
 * through {@link foldEvent}, and publishes an immutable snapshot the renderer
 * reconciles against.
 *
 * The seeded log and the live stream take the same path — the constructor
 * replays `session.events` through the same fold the subscription uses — so a
 * resumed session and a live one cannot drift. High-frequency chunks are
 * coalesced into one snapshot per {@link BATCH_INTERVAL_MS} frame.
 *
 * The snapshot is the boundary: the node array is replaced wholesale per batch,
 * and each node carries a `version` the reconciler compares, so subscribers
 * never diff content. Per-process presentation state (spinners, stopwatches,
 * the queued-steering count) is deliberately not here; it belongs to the entry
 * point. The one exception is {@link SessionStore.appendOptimistic}: a
 * just-submitted message is a placeholder for a log entry that has not been
 * written yet, keyed so the entry replaces it, not a second read model.
 * @module dsh-tui/core/session-store
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { MessageId, UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
// Type imports load the SessionEventMap declaration merges.
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-compaction'
import type {} from '@deepseek-ai/dsh-plan-mode'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-user-approval'
import {
  appendOptimisticUserMessage,
  foldEvent,
  withdrawOptimisticUserMessage,
} from './nodes.ts'
import type { ChatNode, SessionSnapshot, UserMessageNode } from './types.ts'

/** One animation frame: bursts of stream chunks publish one snapshot. */
const BATCH_INTERVAL_MS = 16

const EMPTY_USAGE = { inputTokens: 0, outputTokens: 0 } as const

/** The snapshot's session aggregates, folded beside the node list. */
type SessionState = Omit<SessionSnapshot, 'nodes'>

/**
 * Fold the non-node aggregates (usage totals, route, plan mode, plan items,
 * title) from one event.
 * @param state - the mutable aggregate draft.
 * @param event - the session event to apply.
 * @returns true when an aggregate changed.
 */
function foldState(state: SessionState, event: SessionEvent): boolean {
  switch (event.type) {
    case 'assistant/message': {
      const usage = event.data.usage
      if (usage === undefined) return false
      state.lastUsage = usage
      state.totalUsage = {
        inputTokens: state.totalUsage.inputTokens + usage.inputTokens,
        outputTokens: state.totalUsage.outputTokens + usage.outputTokens,
        cacheReadTokens: (state.totalUsage.cacheReadTokens ?? 0) + (usage.cacheReadTokens ?? 0),
        cacheWriteTokens: (state.totalUsage.cacheWriteTokens ?? 0) + (usage.cacheWriteTokens ?? 0),
        reasoningTokens: (state.totalUsage.reasoningTokens ?? 0) + (usage.reasoningTokens ?? 0),
      }
      return true
    }
    case 'request/context': {
      const window = event.data.contextWindow
      if (window !== undefined) state.contextWindow = window
      state.model = `${event.data.provider}/${event.data.model}`
      return true
    }
    case 'plan/mode':
      state.planMode = event.data.active
      return true
    case 'todo/write':
      state.todos = [...event.data.todos]
      return true
    case 'turn/start':
      // Turn-scoped, exactly like the plan node: readable after the turn ends,
      // cleared when the next turn opens.
      if (state.todos === undefined || state.todos.length === 0) return false
      state.todos = []
      return true
    case 'turn/end':
      state.lastTurnEndReason = event.data.reason.kind
      return true
    case 'session/title':
      state.title = event.data.title
      return true
    default:
      return false
  }
}

/**
 * One live session's read model. Dispose to unsubscribe.
 */
export class SessionStore {
  private readonly nodes: ChatNode[] = []
  private readonly state: SessionState
  private snapshot: SessionSnapshot
  private readonly listeners = new Set<() => void>()
  private batchTimer: ReturnType<typeof setTimeout> | null = null
  private readonly offSessionEvent: () => void
  private readonly offAgentStatus: () => void

  constructor(ctx: Context, session: Session, agent: Agent) {
    this.state = {
      status: agent.status,
      totalUsage: { ...EMPTY_USAGE },
      planMode: false,
    }

    // Replay the seeded log: resume and fork seeds never fire `session/event`,
    // so this is the only place they enter, and they enter through the same fold.
    for (const event of session.events) {
      foldEvent(this.nodes, event)
      foldState(this.state, event)
    }
    this.snapshot = this.publish()

    this.offSessionEvent = ctx.on('session/event', (eventSession, event) => {
      if (eventSession.id !== session.id) return
      this.apply(event)
    })
    this.offAgentStatus = ctx.on('agent/status', ({ agent: eventAgent, status }) => {
      if (eventAgent.session.id !== session.id) return
      if (this.state.status === status) return
      this.state.status = status
      this.scheduleFlush()
    })
  }

  /**
   * Echo one just-submitted user message into the draft before any event
   * records it, so the prompt appears where it was sent rather than after the
   * answer it interrupted. The `user/message` event lands on the same node.
   * @param message - the message handed to the agent.
   * @param source - `steering` when a running turn was interrupted, else `user`.
   */
  appendOptimistic(message: UserMessage, source: UserMessageNode['source']): void {
    if (appendOptimisticUserMessage(this.nodes, message, source)) this.scheduleFlush()
  }

  /**
   * Withdraw the echo of a submission the agent's inbox discarded.
   * @param id - the discarded message's identity.
   */
  withdrawOptimistic(id: MessageId): void {
    if (withdrawOptimisticUserMessage(this.nodes, id)) this.scheduleFlush()
  }

  /** Apply one event to the draft and schedule a snapshot flush. */
  private apply(event: SessionEvent): void {
    const nodesChanged = foldEvent(this.nodes, event)
    const stateChanged = foldState(this.state, event)
    if (nodesChanged || stateChanged) this.scheduleFlush()
  }

  /** Build the immutable snapshot from the current draft. */
  private publish(): SessionSnapshot {
    return { ...this.state, nodes: [...this.nodes] }
  }

  /** Coalesce bursts of chunks into one snapshot per batch interval. */
  private scheduleFlush(): void {
    if (this.batchTimer !== null) return
    this.batchTimer = setTimeout(() => {
      this.batchTimer = null
      this.snapshot = this.publish()
      for (const listener of this.listeners) listener()
    }, BATCH_INTERVAL_MS)
  }

  /**
   * Subscribe to snapshot replacements.
   * @param listener - called after each published snapshot.
   * @returns the unsubscribe function.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * The current snapshot.
   * @returns the latest published snapshot.
   */
  getSnapshot(): SessionSnapshot {
    return this.snapshot
  }

  /** Unsubscribe from the event bus, publishing whatever the last batch held. */
  dispose(): void {
    if (this.batchTimer !== null) {
      clearTimeout(this.batchTimer)
      this.batchTimer = null
      // Flush before dropping the timer: a dispose that lands inside a batch
      // window would otherwise discard up to BATCH_INTERVAL_MS of folded
      // events, and the last frame before teardown is exactly the one a
      // resume handoff leaves on screen.
      this.snapshot = this.publish()
      for (const listener of this.listeners) listener()
    }
    this.listeners.clear()
    this.offSessionEvent()
    this.offAgentStatus()
  }
}

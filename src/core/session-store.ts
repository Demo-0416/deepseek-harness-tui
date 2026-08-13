/**
 * Per-session event-sourcing store: subscribes to the dsh event bus, folds
 * events into the view model, and exposes an immutable snapshot for React's
 * useSyncExternalStore. High-frequency chunks are batched into one snapshot
 * per animation frame (16ms).
 * @module dsh-tui/core/session-store
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
// Load the SessionEventMap declaration merges.
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-compaction'
import type {} from '@deepseek-ai/dsh-plan-mode'
import type {} from '@deepseek-ai/dsh-user-approval'
import { foldEvent } from './nodes.ts'
import type { ChatNode, SessionSnapshot } from './types.ts'

const BATCH_INTERVAL_MS = 16

const EMPTY_USAGE = { inputTokens: 0, outputTokens: 0 } as const

/** Fold non-node state (usage totals, plan mode, context window) from an event. */
function foldState(snapshot: SessionSnapshot, event: SessionEvent): void {
  switch (event.type) {
    case 'assistant/message': {
      const usage = event.data.usage
      if (usage !== undefined) {
        snapshot.lastUsage = usage
        snapshot.totalUsage = {
          inputTokens: snapshot.totalUsage.inputTokens + usage.inputTokens,
          outputTokens: snapshot.totalUsage.outputTokens + usage.outputTokens,
          cacheReadTokens: (snapshot.totalUsage.cacheReadTokens ?? 0) + (usage.cacheReadTokens ?? 0),
          cacheWriteTokens: (snapshot.totalUsage.cacheWriteTokens ?? 0) + (usage.cacheWriteTokens ?? 0),
          reasoningTokens: (snapshot.totalUsage.reasoningTokens ?? 0) + (usage.reasoningTokens ?? 0),
        }
      }
      break
    }
    case 'request/context': {
      const window = event.data.contextWindow
      if (window !== undefined) snapshot.contextWindow = window
      snapshot.model = `${event.data.provider}/${event.data.model}`
      break
    }
    case 'plan/mode': {
      snapshot.planMode = event.data.active
      break
    }
    case 'todo/write': {
      snapshot.todos = event.data.todos
      break
    }
    case 'turn/end': {
      snapshot.lastTurnEndReason = event.data.reason.kind
      break
    }
    default:
      break
  }
}

/**
 * One live session's read model. Dispose to unsubscribe; the draft nodes are
 * mutated between batches and the snapshot is replaced atomically.
 */
export class SessionStore {
  private nodes: ChatNode[] = []
  private snapshot: SessionSnapshot
  private readonly listeners = new Set<() => void>()
  private batchTimer: ReturnType<typeof setTimeout> | null = null
  private readonly offSessionEvent: () => void
  private readonly offAgentStatus: () => void

  constructor(ctx: Context, session: Session, agent: Agent) {
    this.snapshot = {
      nodes: [],
      status: agent.status,
      totalUsage: { ...EMPTY_USAGE },
      planMode: false,
    }

    // Replay the log (resume/fork seeds do not fire session/event).
    for (const event of session.events) {
      if (foldEvent(this.nodes, event)) this.snapshot.nodes = this.nodes
      foldState(this.snapshot, event)
    }
    this.snapshot.nodes = [...this.nodes]

    this.offSessionEvent = ctx.on('session/event', (eventSession, event) => {
      if (eventSession.id !== session.id) return
      this.apply(event)
    })
    this.offAgentStatus = ctx.on('agent/status', ({ agent: eventAgent, status }) => {
      if (eventAgent.session.id !== session.id) return
      if (this.snapshot.status === status) return
      this.snapshot = { ...this.snapshot, status }
      this.scheduleFlush()
    })
  }

  /** Apply one event to the draft and schedule a snapshot flush. */
  private apply(event: SessionEvent): void {
    const changed = foldEvent(this.nodes, event)
    foldState(this.snapshot, event)
    if (changed) this.snapshot.nodes = this.nodes
    this.scheduleFlush()
  }

  /** Coalesce bursts of chunks into one snapshot per batch interval. */
  private scheduleFlush(): void {
    if (this.batchTimer !== null) return
    this.batchTimer = setTimeout(() => {
      this.batchTimer = null
      this.snapshot = { ...this.snapshot, nodes: [...this.nodes] }
      for (const listener of this.listeners) listener()
    }, BATCH_INTERVAL_MS)
  }

  /** useSyncExternalStore subscription. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** useSyncExternalStore snapshot getter. */
  getSnapshot(): SessionSnapshot {
    return this.snapshot
  }

  /** Unsubscribe from the event bus. */
  dispose(): void {
    if (this.batchTimer !== null) {
      clearTimeout(this.batchTimer)
      this.batchTimer = null
    }
    this.listeners.clear()
    this.offSessionEvent()
    this.offAgentStatus()
  }
}

/**
 * The TUI view model: the chat nodes folded from the dsh session event log and
 * the session aggregates the prompt line, header, and plan strip read.
 *
 * Nodes are the renderer's only input. Each carries a stable {@link ChatNode.key}
 * (the reconciler maps it to one component instance) and a {@link ChatNode.version}
 * counter the fold bumps on every in-place mutation, so an unchanged node never
 * touches its component. The fold lives in `nodes.ts`; the store that batches
 * snapshots lives in `session-store.ts`.
 * @module dsh-tui/core/types
 */

import type { ContentBlock, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { JsonValue, TodoItem } from '@deepseek-ai/dsh-session'
import type { ParsedArguments } from '../components/content.ts'

export type { TokenUsage, TodoItem }

/** Lifecycle state of a folded node. */
export type NodeStatus = 'running' | 'complete' | 'error' | 'interrupted'

/** Fields every folded node carries. */
interface NodeBase {
  /**
   * Stable identity for the whole life of the node. Derived from the log
   * (`turn:step`, a tool `callId`, an event `seq`), never from array position,
   * so replaying a log twice yields the same keys.
   */
  readonly key: string
  /**
   * Change counter bumped on every in-place mutation. A reconciler that has
   * already applied this version can skip the node entirely.
   */
  version: number
  /** Log time of the event that created the node. */
  readonly time: number
}

/** A direct human prompt (or live steering), rendered as the filled user block. */
export interface UserMessageNode extends NodeBase {
  kind: 'user-message'
  text: string
  /** `user` is a typed prompt; `steering` is mid-run input from a steering source. */
  source: 'user' | 'steering'
}

/** Producer-injected context (a plugin/goal message), rendered as a dim card. */
export interface ContextCardNode extends NodeBase {
  kind: 'context'
  /** The producing plugin, or the raw source kind when it names no plugin. */
  label: string
  text: string
}

/** A session-reference attachment, rendered as its one-line label list. */
export interface ReferenceCardNode extends NodeBase {
  kind: 'reference'
  labels: string[]
}

/** One model step: its streamed or settled text, reasoning, and requested calls. */
export interface AssistantNode extends NodeBase {
  kind: 'assistant'
  turn: number
  step: number
  status: NodeStatus
  /** Accumulated text deltas, replaced by the settled message text. */
  text: string
  /** Accumulated reasoning deltas, replaced by the settled message reasoning. */
  reasoning: string
  /** Whether the settled `assistant/message` landed for this step. */
  settled: boolean
  /** Tool call ids this step requested, in request order. */
  toolCalls: string[]
  usage?: TokenUsage
  /** Log time the step closed; pins the timing footer. Absent while it runs. */
  completedAt?: number
}

/** A tool result, kept in the shape the tool's own presenter consumes. */
export interface ToolResultView {
  /** Model-facing result blocks, handed to `presentResult` verbatim. */
  content: ContentBlock[]
  isError: boolean
  /** Tool-private presentation payload (diffs, search hits, …). */
  meta?: JsonValue
  /** The result's text blocks joined, for consumers that render no card. */
  text: string
}

/** One tool invocation and, once it lands, its result. */
export interface ToolCallNode extends NodeBase {
  kind: 'tool-call'
  /** Provider-issued call id; the node key is derived from it. */
  callId: string
  name: string
  /** Raw arguments JSON exactly as the model produced it. */
  argsRaw: string
  /** Parsed arguments plus the validity flag the card presenter needs. */
  args: ParsedArguments
  /**
   * Whether `argsRaw` is the complete call. Streamed argument deltas leave it
   * false; the `tool/call` event (or an orphan result) completes it. A card
   * renders only for a complete call, matching what the loop actually ran.
   */
  argsComplete: boolean
  status: NodeStatus
  result?: ToolResultView
}

/** A system notice: turn outcomes, retries, compaction failures. */
export interface NoticeNode extends NodeBase {
  kind: 'notice'
  text: string
  tone: 'info' | 'error' | 'warning'
}

/**
 * A compaction transaction. The row renders only once the replacement landed
 * on the surface (`landed`), because an open or abandoned compaction marks no
 * boundary in the conversation — and a resumed log may carry a stale start.
 */
export interface CompactionNode extends NodeBase {
  kind: 'compaction'
  landed: boolean
  /** The summary text the compaction wrote, when it logged one. */
  summary: string
}

/**
 * The latest todo snapshot (last write wins, cleared when a turn opens). It is
 * a node so the fold owns every `todo/write`, but the plan strip renders above
 * the prompt rather than in the transcript, so the reconciler places no
 * component for it and the entry reads {@link SessionSnapshot.todos}.
 */
export interface TodoNode extends NodeBase {
  kind: 'todo'
  todos: TodoItem[]
}

/** Everything the chat surface folds, in log order. */
export type ChatNode =
  | UserMessageNode
  | ContextCardNode
  | ReferenceCardNode
  | AssistantNode
  | ToolCallNode
  | NoticeNode
  | CompactionNode
  | TodoNode

/** Agent lifecycle state mirrored from agent/status events. */
export type AgentStatus = 'idle' | 'running'

/** The snapshot the TUI renders: folded nodes plus session aggregates. */
export interface SessionSnapshot {
  /** Chat nodes in log order. */
  nodes: readonly ChatNode[]
  /** Current agent status. */
  status: AgentStatus
  /** Latest token usage for the last settled step, if any. */
  lastUsage?: TokenUsage
  /** Session tokens counted so far (sum of step usage). */
  totalUsage: TokenUsage
  /** Context window size from the latest request/context, when known. */
  contextWindow?: number
  /** The active model label (provider/model) from the latest request/context. */
  model?: string
  /** Plan mode on/off. */
  planMode: boolean
  /** Current plan items (latest todo/write in the open turn), when any. */
  todos?: TodoItem[]
  /** Latest folded session title, when one was written. */
  title?: string
  /** The active turn's end reason, when the last turn ended. */
  lastTurnEndReason?: string
}

/** A pending approval question routed to the TUI. */
export interface PendingApproval {
  id: number
  toolName: string
  callId?: string
  reason?: string
  /** Resolve with the outcome; the TUI calls this when the user answers. */
  resolve: (outcome: 'allowed-once' | 'rejected' | 'cancelled') => void
}

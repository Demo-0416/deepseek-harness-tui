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
  /**
   * Set while this node is the terminal's own echo of a submission no event has
   * recorded yet. The `user/message` event that lands replaces the node without
   * it. Absent on every folded log.
   */
  optimistic?: boolean
  /**
   * Set when the agent's inbox discarded the echoed submission: the model will
   * never see it, so the node renders nothing. It keeps its place rather than
   * leaving the list, because node positions anchor the `/clear` cut and the
   * entry's process-local rows.
   */
  withdrawn?: boolean
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
  /**
   * Wall time this step spent thinking, summed over the reasoning spans the
   * fold has already closed. Absent on a step that never streamed reasoning.
   *
   * A span opens at the step's first reasoning delta and closes at whatever
   * ends the thinking — the first text delta, the first tool call, the settled
   * message, the step's own end — so this is the log's own measure of the
   * phase, not a sample of it. The collapsed group row in `core/collapse.ts` is
   * what reports it; the thinking *block* is unaffected and still disappears
   * when the step finishes.
   */
  thinkingMs?: number
  /**
   * Log time the currently open reasoning span started, absent whenever the
   * step is not thinking.
   *
   * The fold reads no clock, so a running span is published as its start rather
   * than as an elapsed value: the renderer accumulates it against its own
   * clock, which is what lets a live row count up between two events.
   */
  thinkingSince?: number
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

/**
 * One member agent of a workflow run: the facts `tool-workflow/agent-start` and
 * `tool-workflow/agent-end` record about it, and nothing else.
 */
export interface WorkflowMemberEntry {
  /** The ordinal the workflow tool assigned; the stable per-run identity. */
  readonly seq: number
  readonly label: string
  /**
   * The phase the member was published under. An absent phase and an empty one
   * are two different identities, so this stays optional rather than defaulted.
   */
  readonly phase?: string
  /** The member's child session id — where its own transcript lives. */
  readonly childId: string
  /** Log time of `agent-start`; the renderer's clock derives the elapsed time. */
  readonly startedAt: number
  outcome?: 'completed' | 'failed' | 'cancelled'
  /** Log time of `agent-end`. Absent while the member is unsettled. */
  endedAt?: number
}

/**
 * One `workflow` tool run, folded from the four durable `tool-workflow/*`
 * events the tool writes into its calling session.
 *
 * The node stores only what the log states. Run status, phase grouping, and the
 * interrupted reading are derived in `workflow.ts`, so a live fold and a replay
 * of the same log cannot disagree about them.
 */
export interface WorkflowRunNode extends NodeBase {
  kind: 'workflow-run'
  readonly runId: string
  readonly name: string
  members: WorkflowMemberEntry[]
  /** Log time of `run-start`. */
  readonly startedAt: number
  /** `run-end`'s stop reason. Absent when the run never settled itself. */
  stopReason?: 'completed' | 'cancelled' | 'error'
  /**
   * When the run stopped being live: `run-end`'s time, or the time of the
   * `step/end` / `turn/end` that closed over a run still waiting for one. An
   * `endedAt` without a `stopReason` is exactly the interrupted state.
   */
  endedAt?: number
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
  | WorkflowRunNode

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

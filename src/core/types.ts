/**
 * The TUI view model: immutable chat nodes and session status, folded from the
 * dsh session event log. The fold lives in nodes.ts; React renders these.
 * @module dsh-tui/core/types
 */

import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { TodoItem } from '@deepseek-ai/dsh-session'

export type { TokenUsage, TodoItem }

/** Lifecycle state shared by streaming nodes. */
export type NodeStatus = 'running' | 'complete' | 'error' | 'interrupted'

/** A direct user message, injected context, or live steering. */
export interface UserMessageNode {
  kind: 'user-message'
  /** Event-seq-derived stable id. */
  id: string
  text: string
  /** 'user' is a direct prompt; 'steering' is mid-run input; 'context' is injected. */
  source: 'user' | 'steering' | 'context'
  time: number
}

/** One model turn step: its text, reasoning, and the tool calls it requested. */
export interface AssistantNode {
  kind: 'assistant'
  /** `${turn}:${step}` — one assistant node per step. */
  id: string
  turn: number
  step: number
  status: NodeStatus
  /** Accumulated text deltas; replaced by the final message on assistant/message. */
  text: string
  reasoning: string
  /** Tool call ids this step requested, in request order. */
  toolCalls: string[]
  usage?: TokenUsage
  time: number
}

/** Simplified tool result content for rendering. */
export interface ToolResultView {
  /** Text blocks joined, for the generic card. */
  text: string
  /** Whether the tool reported an error. */
  isError: boolean
}

/** One tool invocation, streamed then completed by its result. */
export interface ToolCallNode {
  kind: 'tool-call'
  /** The tool call id (callId). */
  id: string
  name: string
  /** Raw arguments JSON string exactly as the model produced it. */
  argsRaw: string
  /** Parsed arguments when the JSON is valid, else the raw string. */
  args: unknown
  status: NodeStatus
  result?: ToolResultView
  /** Tool-private presentation payload (diffs, search hits, …). */
  meta?: unknown
  time: number
}

/** A slash command executed through ctx.commands. */
export interface CommandNode {
  kind: 'command'
  id: string
  name: string
  args: string
  status: 'running' | 'done'
  time: number
}

/** A compaction boundary with its summary line. */
export interface CompactionNode {
  kind: 'compaction'
  id: string
  summary: string
  time: number
}

/** A system notice: turn errors, max-tokens, interrupts, retries. */
export interface NoticeNode {
  kind: 'notice'
  id: string
  text: string
  tone: 'info' | 'error' | 'warning'
  time: number
}

/** A todo list snapshot (last write wins). */
export interface TodoNode {
  kind: 'todo'
  id: string
  todos: TodoItem[]
  time: number
}

/** Everything the chat surface renders, in log order. */
export type ChatNode =
  | UserMessageNode
  | AssistantNode
  | ToolCallNode
  | CommandNode
  | CompactionNode
  | NoticeNode
  | TodoNode

/** Agent lifecycle state mirrored from agent/status events. */
export type AgentStatus = 'idle' | 'running'

/** The immutable snapshot the TUI renders. */
export interface SessionSnapshot {
  /** Chat nodes in log order. */
  nodes: ChatNode[]
  /** Current agent status. */
  status: AgentStatus
  /** Latest token usage for the active step, if any. */
  lastUsage?: TokenUsage
  /** Session tokens counted so far (sum of step usage). */
  totalUsage: TokenUsage
  /** Context window size from the latest request/context, when known. */
  contextWindow?: number
  /** The active model label (provider/model) from the latest request/context. */
  model?: string
  /** Plan mode on/off. */
  planMode: boolean
  /** Current todo list (latest todo/write), when any. */
  todos?: TodoItem[]
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

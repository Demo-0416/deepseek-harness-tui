/**
 * The event-to-node fold: turns dsh SessionEvents into renderable ChatNodes.
 *
 * `foldEvent` is a pure function of `(nodes, event)`: it reads nothing but its
 * arguments — no clock, no `process`, no `ctx`, no service lookup — so replaying
 * a resumed log and appending a live event take the exact same path, and folding
 * one event sequence twice yields identical nodes. Presentation state that is
 * genuinely per-process (the running spinner, a live compaction stopwatch,
 * pending steering) is deliberately absent: it belongs to the entry point, not
 * to the durable log.
 *
 * It mutates the draft array it is given (the store owns the draft and snapshots
 * it per batch) and returns whether anything visible changed. Every mutation
 * bumps the touched node's `version`, which is how the reconciler skips nodes
 * that did not change.
 * @module dsh-tui/core/nodes
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { isReplacementSurfaceEvent } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { isCompactCheckpointSource } from '@deepseek-ai/dsh-compaction'
// Type imports load the SessionEventMap declaration merges, so the switch below
// sees `compaction/*`, `llm/retry`, `plan/mode`, and `session/title`.
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-compaction'
import type {} from '@deepseek-ai/dsh-llm-retry'
import type {} from '@deepseek-ai/dsh-plan-mode'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-user-approval'
import { contentText, parseArguments } from '../components/content.ts'
import type {
  AssistantNode,
  ChatNode,
  CompactionNode,
  ContextCardNode,
  NoticeNode,
  ReferenceCardNode,
  TodoNode,
  ToolCallNode,
  UserMessageNode,
} from './types.ts'

/** Key prefixes keep one kind's ids from ever colliding with another's. */
const KEY = {
  assistant: (turn: number, step: number): string => `assistant:${turn}:${step}`,
  tool: (callId: string): string => `tool:${callId}`,
  user: (seq: number): string => `user:${seq}`,
  context: (seq: number): string => `context:${seq}`,
  reference: (seq: number): string => `reference:${seq}`,
  notice: (seq: number): string => `notice:${seq}`,
  compaction: (seq: number): string => `compaction:${seq}`,
  todo: 'todo',
} as const

/** Record an in-place mutation so the reconciler re-applies exactly this node. */
function touch(node: ChatNode): true {
  node.version += 1
  return true
}

/** Append a node to the draft. */
function push(nodes: ChatNode[], node: ChatNode): true {
  nodes.push(node)
  return true
}

/** The assistant node for one step, or undefined when the step folded none yet. */
function findAssistant(nodes: readonly ChatNode[], turn: number, step: number): AssistantNode | undefined {
  const key = KEY.assistant(turn, step)
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index]
    if (node?.kind === 'assistant' && node.key === key) return node
  }
  return undefined
}

/** The tool node for one call id, or undefined when the call folded none yet. */
function findToolCall(nodes: readonly ChatNode[], callId: string): ToolCallNode | undefined {
  const key = KEY.tool(callId)
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index]
    if (node?.kind === 'tool-call' && node.key === key) return node
  }
  return undefined
}

/** The singleton plan-strip node, or undefined before the first `todo/write`. */
function findTodo(nodes: readonly ChatNode[]): TodoNode | undefined {
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index]
    if (node?.kind === 'todo') return node
  }
  return undefined
}

/**
 * Concatenate one block type's text the way the transcript renders it: blocks
 * of the same kind are separate paragraphs, so they join on a blank line.
 */
function blocksText(content: readonly ContentBlock[], type: 'text' | 'reasoning'): string {
  return content
    .filter((block): block is Extract<ContentBlock, { type: typeof type }> => block.type === type)
    .map(block => block.text)
    .join('\n\n')
}

/**
 * Read a session-reference attachment's display labels from an event source.
 * The source shape is a durable/replay boundary, so every field is checked
 * rather than narrowed: a foreign or corrupt source is simply not a reference.
 * @param source - the message source to inspect.
 * @returns per-reference labels, or `undefined` when the source is not one.
 */
function referenceLabels(source: unknown): string[] | undefined {
  if (typeof source !== 'object' || source === null) return undefined
  const record = source as Record<string, unknown>
  if (record['kind'] !== 'session-reference' || !Array.isArray(record['references'])) return undefined
  const labels: string[] = []
  for (const reference of record['references'] as unknown[]) {
    if (typeof reference !== 'object' || reference === null) return undefined
    const entry = reference as Record<string, unknown>
    const sessionId = entry['sessionId']
    const label = entry['label']
    if (typeof sessionId !== 'string' || typeof label !== 'string') return undefined
    labels.push(label === sessionId ? sessionId : `${label} (${sessionId})`)
  }
  return labels
}

/**
 * A producer-injected context card's label: the plugin name when the source
 * names one, else its `kind`. The union is merge-extensible and the log is a
 * replay boundary, so this reads the fields without narrowing on `kind`.
 */
function contextLabel(source: unknown): string {
  const record = source as { kind?: unknown; plugin?: unknown }
  if (typeof record.plugin === 'string') return record.plugin
  if (typeof record.kind === 'string') return record.kind
  /* v8 ignore next -- every logged source carries at least a string kind. */
  return 'context'
}

/**
 * Append a notice, dropping one that merely repeats the notice before it. The
 * fold is the single source of transcript notices, so a turn that reports the
 * same outcome twice (a failure recorded and then closed) states it once.
 */
function pushNotice(
  nodes: ChatNode[],
  seq: number,
  time: number,
  text: string,
  tone: NoticeNode['tone'],
): boolean {
  const last = nodes[nodes.length - 1]
  if (last?.kind === 'notice' && last.text === text && last.tone === tone) return false
  const node: NoticeNode = { kind: 'notice', key: KEY.notice(seq), version: 0, time, text, tone }
  return push(nodes, node)
}

/** Mark the compaction whose replacement just landed, or record a bare marker. */
function landCompaction(nodes: ChatNode[], seq: number, time: number): boolean {
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index]
    if (node?.kind === 'compaction' && !node.landed) {
      node.landed = true
      return touch(node)
    }
  }
  // A resumed log may start after its own `compaction/start`; the checkpoint
  // still marks where the model stopped seeing the history above it.
  const node: CompactionNode = {
    kind: 'compaction',
    key: KEY.compaction(seq),
    version: 0,
    time,
    landed: true,
    summary: '',
  }
  return push(nodes, node)
}

/** Open the tool node for one call id, creating it when the call is new. */
function openToolCall(nodes: ChatNode[], callId: string, name: string, time: number): ToolCallNode {
  const existing = findToolCall(nodes, callId)
  if (existing !== undefined) return existing
  const node: ToolCallNode = {
    kind: 'tool-call',
    key: KEY.tool(callId),
    version: 0,
    time,
    callId,
    name,
    argsRaw: '',
    args: { value: {}, valid: true },
    argsComplete: false,
    status: 'running',
  }
  push(nodes, node)
  return node
}

/** Open the assistant node for one step, creating it when the step is new. */
function openAssistant(nodes: ChatNode[], turn: number, step: number, time: number): AssistantNode {
  const existing = findAssistant(nodes, turn, step)
  if (existing !== undefined) return existing
  const node: AssistantNode = {
    kind: 'assistant',
    key: KEY.assistant(turn, step),
    version: 0,
    time,
    turn,
    step,
    status: 'running',
    text: '',
    reasoning: '',
    settled: false,
    toolCalls: [],
  }
  push(nodes, node)
  return node
}

/**
 * Fold one session event into the draft node list.
 *
 * Pure: the result depends only on `nodes` and `event`, which is what lets a
 * resumed log and a live append share this one path.
 * @param nodes - the mutable draft node list.
 * @param event - the session event to apply.
 * @returns true when the rendered node list changed.
 */
export function foldEvent(nodes: ChatNode[], event: SessionEvent): boolean {
  const time = event.time
  const seq = event.seq
  // A replacement rewrites the model surface, never the human transcript: the
  // conversation it shadowed stays rendered above, and a landed compaction
  // contributes only its boundary marker at its own log position.
  if (isReplacementSurfaceEvent(event)) {
    if (event.type !== 'user/message' || !isCompactCheckpointSource(event.data.source)) return false
    return landCompaction(nodes, seq, time)
  }
  switch (event.type) {
    case 'user/message': {
      const message = event.data
      const source: { kind?: unknown } = message.source
      const labels = referenceLabels(source)
      if (labels !== undefined) {
        const node: ReferenceCardNode = {
          kind: 'reference',
          key: KEY.reference(seq),
          version: 0,
          time,
          labels,
        }
        return push(nodes, node)
      }
      const text = contentText(message.content).trim()
      if (text === '') return false
      if (source.kind === 'user' || source.kind === 'steering') {
        const node: UserMessageNode = {
          kind: 'user-message',
          key: KEY.user(seq),
          version: 0,
          time,
          text,
          source: source.kind === 'steering' ? 'steering' : 'user',
        }
        return push(nodes, node)
      }
      const node: ContextCardNode = {
        kind: 'context',
        key: KEY.context(seq),
        version: 0,
        time,
        label: contextLabel(source),
        text,
      }
      return push(nodes, node)
    }
    case 'step/start': {
      const { turn, step } = event.data
      if (findAssistant(nodes, turn, step) !== undefined) return false
      openAssistant(nodes, turn, step, time)
      return true
    }
    case 'assistant/chunk': {
      const { turn, step, chunk } = event.data
      const node = openAssistant(nodes, turn, step, time)
      switch (chunk.type) {
        case 'text-delta':
          node.text += chunk.text
          return touch(node)
        case 'reasoning-delta':
          node.reasoning += chunk.text
          return touch(node)
        case 'tool-call-delta': {
          const tool = openToolCall(nodes, chunk.id, chunk.name ?? '', time)
          if (chunk.name !== undefined && tool.name === '') tool.name = chunk.name
          tool.argsRaw += chunk.argumentsDelta
          tool.args = parseArguments(tool.argsRaw)
          touch(tool)
          if (!node.toolCalls.includes(tool.callId)) {
            node.toolCalls.push(tool.callId)
            touch(node)
          }
          return true
        }
        default:
          // Block boundaries, usage, and finish carry no transcript content of
          // their own; the deltas around them already did.
          return false
      }
    }
    case 'assistant/message': {
      const { turn, step, message, usage } = event.data
      const node = openAssistant(nodes, turn, step, time)
      // The settled message replaces the streamed buffer wholesale — except an
      // empty one, which exists only to host usage and would otherwise erase
      // the step's own output.
      if (message.content.length > 0) {
        node.text = blocksText(message.content, 'text')
        node.reasoning = blocksText(message.content, 'reasoning')
        node.settled = true
        node.status = 'complete'
      }
      if (usage !== undefined) node.usage = usage
      for (const block of message.content) {
        if (block.type === 'tool-call' && !node.toolCalls.includes(block.id)) node.toolCalls.push(block.id)
      }
      return touch(node)
    }
    case 'step/end': {
      const { turn, step } = event.data
      const node = openAssistant(nodes, turn, step, time)
      node.completedAt = time
      if (node.status === 'running') node.status = 'complete'
      return touch(node)
    }
    case 'tool/call': {
      const { callId, name, arguments: argsRaw, turn, step } = event.data
      const tool = openToolCall(nodes, callId, name, time)
      tool.name = name
      tool.argsRaw = argsRaw
      tool.args = parseArguments(argsRaw)
      tool.argsComplete = true
      touch(tool)
      const assistant = findAssistant(nodes, turn, step)
      if (assistant !== undefined && !assistant.toolCalls.includes(callId)) {
        assistant.toolCalls.push(callId)
        touch(assistant)
      }
      return true
    }
    case 'tool/result': {
      const { message, error, meta } = event.data
      const block = message.content[0]
      const callId = block.toolCallId
      // An orphan result (its call never reached the log, or a compaction cut
      // it away) still has a result to show, so it gets a fallback card.
      const tool = findToolCall(nodes, callId) ?? openToolCall(nodes, callId, 'tool', time)
      tool.argsComplete = true
      const text = contentText(block.content)
      const isError = block.isError === true || error !== undefined
      tool.result = {
        content: [...block.content],
        isError,
        text: error === undefined ? text : `${error.code}: ${text}`,
        ...meta === undefined ? {} : { meta },
      }
      tool.status = isError ? 'error' : 'complete'
      return touch(tool)
    }
    case 'todo/write': {
      const todos = [...event.data.todos]
      const existing = findTodo(nodes)
      if (existing === undefined) {
        const node: TodoNode = { kind: 'todo', key: KEY.todo, version: 0, time, todos }
        return push(nodes, node)
      }
      existing.todos = todos
      return touch(existing)
    }
    case 'turn/start': {
      // The plan strip is turn-scoped: it stays readable after the turn ends
      // and clears when the next one opens.
      const existing = findTodo(nodes)
      if (existing === undefined || existing.todos.length === 0) return false
      existing.todos = []
      return touch(existing)
    }
    case 'compaction/start': {
      const node: CompactionNode = {
        kind: 'compaction',
        key: KEY.compaction(seq),
        version: 0,
        time,
        landed: false,
        summary: '',
      }
      // Log-only history: the marker renders once its replacement lands, so an
      // open (or orphaned) compaction contributes no row.
      return push(nodes, node)
    }
    case 'compaction/summary': {
      for (let index = nodes.length - 1; index >= 0; index -= 1) {
        const node = nodes[index]
        if (node?.kind === 'compaction' && !node.landed) {
          node.summary = blocksText(event.data.summary, 'text')
          return touch(node)
        }
      }
      return false
    }
    case 'compaction/end': {
      const failure = event.data.error
      if (failure === undefined) return false
      return pushNotice(nodes, seq, time, `Compaction failed: ${failure}`, 'warning')
    }
    case 'llm/retry': {
      const data = event.data
      const limit = data.mode === 'always' ? '∞' : String(data.maxRetries)
      // The failed attempt's partial output is withdrawn: the retry replays the
      // same step, so its node is reset rather than duplicated.
      const node = findAssistant(nodes, data.turn, data.step)
      let changed = false
      if (node !== undefined && (node.text !== '' || node.reasoning !== '' || node.toolCalls.length > 0)) {
        node.text = ''
        node.reasoning = ''
        node.toolCalls = []
        node.settled = false
        node.status = 'running'
        changed = touch(node)
      }
      return pushNotice(
        nodes,
        seq,
        time,
        `Retrying model request (${data.retry}/${limit}) in ${data.delayMs}ms: ${data.failure.message}`,
        'warning',
      ) || changed
    }
    case 'turn/end': {
      const reason = event.data.reason
      let changed = false
      // Close the turn's open step: its footer pins at the turn's end time, and
      // its status names why the output stops where it does.
      for (let index = nodes.length - 1; index >= 0; index -= 1) {
        const node = nodes[index]
        if (node?.kind !== 'assistant' || node.turn !== event.data.turn) continue
        if (node.status !== 'running') break
        node.status = reason.kind === 'error' ? 'error'
          : reason.kind === 'completed' ? 'complete' : 'interrupted'
        node.completedAt ??= time
        changed = touch(node)
        break
      }
      switch (reason.kind) {
        case 'completed':
          // The settled message and its Completed footer already say so.
          return changed
        case 'error':
          return pushNotice(nodes, seq, time, reason.error.message, 'error') || changed
        case 'aborted':
          return pushNotice(nodes, seq, time, 'Turn cancelled.', 'warning') || changed
        case 'blocked':
          return pushNotice(nodes, seq, time, 'Turn blocked before it could run.', 'warning') || changed
        case 'max-tokens':
          return pushNotice(nodes, seq, time, 'The model reached its output-token limit.', 'warning') || changed
        case 'interrupted':
          return pushNotice(nodes, seq, time, 'The previous process ended during this turn.', 'warning') || changed
        default:
          // TurnEndReasonMap is merge-extensible: a plugin-added outcome still
          // names why the agent stopped rather than ending silently.
          return pushNotice(nodes, seq, time, `Turn ended: ${(reason as { kind: string }).kind}.`, 'warning') || changed
      }
    }
    default:
      return false
  }
}

/**
 * Fold a whole event log into a fresh node list (resume, replay, and tests).
 * @param events - the events to fold, in log order.
 * @returns the folded nodes.
 */
export function foldEvents(events: readonly SessionEvent[]): ChatNode[] {
  const nodes: ChatNode[] = []
  for (const event of events) foldEvent(nodes, event)
  return nodes
}

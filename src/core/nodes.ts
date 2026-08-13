/**
 * The event-to-node fold: turns dsh SessionEvents into renderable ChatNodes.
 * Pure-ish: foldEvent mutates the draft array it is given (the store owns the
 * draft and snapshots it per batch), and returns whether anything changed.
 * @module dsh-tui/core/nodes
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
// Load the SessionEventMap declaration merges so the switch sees every event.
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-compaction'
import type {} from '@deepseek-ai/dsh-plan-mode'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {
  AssistantNode,
  ChatNode,
  CompactionNode,
  CommandNode,
  NoticeNode,
  ToolCallNode,
  TodoNode,
  UserMessageNode,
} from './types.ts'

/** Find the assistant node for a step, or undefined. */
function findAssistant(nodes: ChatNode[], turn: number, step: number): AssistantNode | undefined {
  const id = `${turn}:${step}`
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i]
    if (node?.kind === 'assistant' && node.id === id) return node
  }
  return undefined
}

/** Find a tool call node by callId. */
function findToolCall(nodes: ChatNode[], callId: string): ToolCallNode | undefined {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i]
    if (node?.kind === 'tool-call' && node.id === callId) return node
  }
  return undefined
}

/** Extract plain text from a user/assistant message content. */
function messageText(content: readonly { type: string; text?: string }[]): string {
  let out = ''
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') out += block.text
  }
  return out
}

/** Extract reasoning text from an assistant message content. */
function reasoningText(content: readonly { type: string; text?: string }[]): string {
  let out = ''
  for (const block of content) {
    if (block.type === 'reasoning' && typeof block.text === 'string') out += block.text
  }
  return out
}

/** Classify a user message source for rendering. */
function userSource(kind: string | undefined): UserMessageNode['source'] {
  if (kind === 'user') return 'user'
  if (kind === 'steering') return 'steering'
  return 'context'
}

/** Push a notice node, deduplicating consecutive identical notices. */
function pushNotice(nodes: ChatNode[], text: string, tone: NoticeNode['tone'], time: number): void {
  const last = nodes[nodes.length - 1]
  if (last?.kind === 'notice' && last.text === text && last.tone === tone) return
  const node: NoticeNode = { kind: 'notice', id: `notice-${nodes.length}`, text, tone, time }
  nodes.push(node)
}

/** Parse tool arguments defensively; the model's JSON is not guaranteed valid. */
function parseArgs(argsRaw: string): unknown {
  try {
    return JSON.parse(argsRaw) as unknown
  } catch {
    return argsRaw
  }
}

/**
 * Fold one session event into the draft node list.
 * @param nodes - the mutable draft node list.
 * @param event - the session event to apply.
 * @returns true when the visible node list changed.
 */
export function foldEvent(nodes: ChatNode[], event: SessionEvent): boolean {
  const time = event.time
  switch (event.type) {
    case 'user/message': {
      const msg = event.data
      const node: UserMessageNode = {
        kind: 'user-message',
        id: `user-${event.seq}`,
        text: messageText(msg.content),
        source: userSource(msg.source.kind),
        time,
      }
      nodes.push(node)
      return true
    }
    case 'assistant/chunk': {
      const { turn, step, chunk } = event.data
      let node = findAssistant(nodes, turn, step)
      if (node === undefined) {
        node = {
          kind: 'assistant',
          id: `${turn}:${step}`,
          turn,
          step,
          status: 'running',
          text: '',
          reasoning: '',
          toolCalls: [],
          time,
        }
        nodes.push(node)
      }
      switch (chunk.type) {
        case 'text-delta':
          node.text += chunk.text
          return true
        case 'reasoning-delta':
          node.reasoning += chunk.text
          return true
        case 'tool-call-delta': {
          let tool = findToolCall(nodes, chunk.id)
          if (tool === undefined) {
            tool = {
              kind: 'tool-call',
              id: chunk.id,
              name: chunk.name ?? '',
              argsRaw: '',
              args: '',
              status: 'running',
              time,
            }
            nodes.push(tool)
            node.toolCalls.push(tool.id)
          }
          if (chunk.name !== undefined && tool.name === '') tool.name = chunk.name
          tool.argsRaw += chunk.argumentsDelta
          tool.args = parseArgs(tool.argsRaw)
          return true
        }
        default:
          return false
      }
    }
    case 'assistant/message': {
      const { turn, step, message, usage } = event.data
      let node = findAssistant(nodes, turn, step)
      if (node === undefined) {
        // A finalized message without preceding chunks (replay, resume).
        node = {
          kind: 'assistant',
          id: `${turn}:${step}`,
          turn,
          step,
          status: 'complete',
          text: '',
          reasoning: '',
          toolCalls: [],
          time,
        }
        nodes.push(node)
      }
      const text = messageText(message.content)
      const reasoning = reasoningText(message.content)
      if (text !== '') node.text = text
      if (reasoning !== '') node.reasoning = reasoning
      if (usage !== undefined) node.usage = usage
      node.status = 'complete'
      return true
    }
    case 'tool/call': {
      const { callId, name, arguments: argsRaw } = event.data
      let tool = findToolCall(nodes, callId)
      if (tool === undefined) {
        tool = {
          kind: 'tool-call',
          id: callId,
          name,
          argsRaw,
          args: parseArgs(argsRaw),
          status: 'running',
          time,
        }
        nodes.push(tool)
        const assistant = findAssistant(nodes, event.data.turn, event.data.step)
        assistant?.toolCalls.push(callId)
      } else {
        tool.name = name
        tool.argsRaw = argsRaw
        tool.args = parseArgs(argsRaw)
      }
      return true
    }
    case 'tool/result': {
      const { message, error, meta } = event.data
      const block = message.content[0]
      if (block === undefined) return false
      const tool = findToolCall(nodes, block.toolCallId)
      if (tool === undefined) return false
      const text = block.content
        .filter(b => b.type === 'text')
        .map(b => ('text' in b ? String(b.text) : ''))
        .join('')
      const isError = block.isError === true || error !== undefined
      tool.result = {
        text: error === undefined ? text : `${error.code}: ${text}`,
        isError,
      }
      tool.status = isError ? 'error' : 'complete'
      if (meta !== undefined) tool.meta = meta
      return true
    }
    case 'command/run': {
      const data = event.data as { commandId?: string; name?: string; args?: string }
      const node: CommandNode = {
        kind: 'command',
        id: data.commandId ?? `cmd-${event.seq}`,
        name: data.name ?? '',
        args: data.args ?? '',
        status: 'running',
        time,
      }
      nodes.push(node)
      return true
    }
    case 'command/done': {
      const data = event.data as { commandId?: string }
      const id = data.commandId
      if (id === undefined) return false
      for (let i = nodes.length - 1; i >= 0; i--) {
        const node = nodes[i]
        if (node?.kind === 'command' && node.id === id) {
          node.status = 'done'
          return true
        }
      }
      return false
    }
    case 'todo/write': {
      const node: TodoNode = { kind: 'todo', id: `todo-${event.seq}`, todos: event.data.todos, time }
      nodes.push(node)
      return true
    }
    case 'compaction/start': {
      const node: CompactionNode = { kind: 'compaction', id: `compact-${event.seq}`, summary: '', time }
      nodes.push(node)
      return true
    }
    case 'compaction/summary': {
      const last = nodes[nodes.length - 1]
      if (last?.kind === 'compaction') {
        last.summary = String((event.data as { summary?: unknown }).summary ?? '')
        return true
      }
      return false
    }
    case 'turn/end': {
      const reason = event.data.reason
      if (reason.kind === 'completed' || reason.kind === 'blocked') return false
      // Mark the last running assistant node as interrupted/errored.
      for (let i = nodes.length - 1; i >= 0; i--) {
        const node = nodes[i]
        if (node?.kind === 'assistant' && node.status === 'running') {
          node.status = reason.kind === 'error' ? 'error' : 'interrupted'
          break
        }
      }
      if (reason.kind === 'error') {
        pushNotice(nodes, `error: ${reason.error.message}`, 'error', time)
      } else if (reason.kind === 'max-tokens') {
        pushNotice(nodes, 'reached the output token limit', 'warning', time)
      } else if (reason.kind === 'interrupted') {
        pushNotice(nodes, 'the previous turn was interrupted', 'info', time)
      } else if (reason.kind === 'aborted') {
        pushNotice(nodes, 'canceled', 'info', time)
      }
      return true
    }
    default:
      return false
  }
}

/** Fold a whole event log into a fresh node list (used on resume/replay). */
export function foldEvents(events: readonly SessionEvent[]): ChatNode[] {
  const nodes: ChatNode[] = []
  for (const event of events) foldEvent(nodes, event)
  return nodes
}

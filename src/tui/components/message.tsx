/**
 * Chat node renderers: one component per ChatNode kind.
 * @module dsh-tui/tui/components/message
 */

import React from 'react'
import { Box, Text } from 'ink'
import type {
  AssistantNode,
  ChatNode,
  CommandNode,
  CompactionNode,
  NoticeNode,
  TodoNode,
  ToolCallNode,
  UserMessageNode,
} from '../../core/types.ts'
import { symbols } from '../theme.ts'
import { ThemedText, useTheme } from '../primitives/themed.tsx'
import { Markdown } from '../primitives/markdown.tsx'
import { Spinner } from '../primitives/spinner.tsx'

/** Compact one-line argument preview for tool call headers. */
function argsPreview(node: ToolCallNode): string {
  if (node.argsRaw === '') return ''
  if (typeof node.args === 'object' && node.args !== null) {
    const entries = Object.entries(node.args as Record<string, unknown>)
    const first = entries[0]
    if (first !== undefined) {
      const value = typeof first[1] === 'string' ? first[1] : JSON.stringify(first[1])
      const truncated = value.length > 60 ? `${value.slice(0, 60)}…` : value
      return entries.length === 1 ? truncated : `${first[0]}=${truncated}…`
    }
  }
  return node.argsRaw.length > 60 ? `${node.argsRaw.slice(0, 60)}…` : node.argsRaw
}

function UserMessage({ node }: { node: UserMessageNode }): React.ReactElement {
  const theme = useTheme()
  if (node.source === 'context') {
    return (
      <Box>
        <Text color={theme.dim} italic>{symbols.treeVertical} {node.text.split('\n')[0]}</Text>
      </Box>
    )
  }
  return (
    <Box>
      <Text color={theme.brand} bold>{symbols.userPrompt} </Text>
      <Box backgroundColor={theme.userBubble} paddingX={1}>
        <Text>{node.text}</Text>
      </Box>
    </Box>
  )
}

function AssistantMessage({ node }: { node: AssistantNode }): React.ReactElement {
  const theme = useTheme()
  const running = node.status === 'running'

  return (
    <Box flexDirection="column">
      {node.reasoning !== '' && (
        <Box>
          <Text color={theme.reasoning} dimColor>
            {symbols.thinking} Thinking{running ? '…' : ''}
          </Text>
        </Box>
      )}
      {node.reasoning !== '' && (
        <Box marginLeft={2}>
          <Text color={theme.reasoning} dimColor>
            {node.reasoning.length > 300 ? `${node.reasoning.slice(0, 300)}…` : node.reasoning}
          </Text>
        </Box>
      )}
      {node.text !== '' && <Markdown text={node.text} />}
      {running && node.text === '' && node.reasoning === '' && <Spinner label="thinking" />}
      {node.status === 'interrupted' && (
        <Text color={theme.warning} italic>interrupted</Text>
      )}
      {node.status === 'error' && (
        <Text color={theme.error} italic>error</Text>
      )}
    </Box>
  )
}

function ToolCall({ node }: { node: ToolCallNode }): React.ReactElement {
  const theme = useTheme()
  const running = node.status === 'running'
  const bg = running ? theme.toolPending : node.status === 'error' ? theme.toolError : theme.toolSuccess
  const preview = argsPreview(node)

  return (
    <Box flexDirection="column">
      <Box>
        <Box backgroundColor={bg} paddingX={1}>
          {running ? <Spinner label={node.name} /> : (
            <Text>
              <Text color={node.status === 'error' ? theme.error : theme.success} bold>
                {node.status === 'error' ? symbols.statusError : symbols.statusOk}
              </Text>
              <Text bold> {node.name}</Text>
              {preview !== '' && <Text color={theme.muted}> {preview}</Text>}
            </Text>
          )}
        </Box>
      </Box>
      {node.result !== undefined && node.result.text !== '' && (
        <Box marginLeft={2}>
          <Text color={theme.muted}>{symbols.toolResult} </Text>
          <Text color={node.result.isError ? theme.error : theme.muted}>
            {node.result.text.length > 500
              ? `${node.result.text.slice(0, 500)}…`
              : node.result.text}
          </Text>
        </Box>
      )}
    </Box>
  )
}

function CommandMessage({ node }: { node: CommandNode }): React.ReactElement {
  const theme = useTheme()
  return (
    <Box>
      <Text color={theme.plan} bold>/{node.name}</Text>
      {node.args !== '' && <Text color={theme.muted}> {node.args}</Text>}
      {node.status === 'running' && <Text color={theme.dim}> …</Text>}
    </Box>
  )
}

function CompactionMessage({ node }: { node: CompactionNode }): React.ReactElement {
  const theme = useTheme()
  return (
    <Box>
      <Text color={theme.plan}>─ compacted ─</Text>
      {node.summary !== '' && <Text color={theme.muted}> {node.summary}</Text>}
    </Box>
  )
}

function NoticeMessage({ node }: { node: NoticeNode }): React.ReactElement {
  const color = node.tone === 'error' ? 'error' : node.tone === 'warning' ? 'warning' : 'dim'
  return (
    <Box>
      <ThemedText token={color} italic>{node.text}</ThemedText>
    </Box>
  )
}

function TodoMessage({ node }: { node: TodoNode }): React.ReactElement {
  const theme = useTheme()
  return (
    <Box flexDirection="column" borderStyle="single" borderColor={theme.border} paddingX={1}>
      <ThemedText token="muted" bold>todo</ThemedText>
      {node.todos.map((todo, i) => (
        <Box key={i}>
          <Text color={todo.status === 'completed' ? theme.success : todo.status === 'in_progress' ? theme.brand : theme.muted}>
            {todo.status === 'completed' ? symbols.statusOk : todo.status === 'in_progress' ? '▶' : '○'}
          </Text>
          <Text color={todo.status === 'completed' ? theme.dim : theme.text}>
            {todo.status === 'completed' ? ' ~~' : ' '}{todo.content}{todo.status === 'completed' ? '~~' : ''}
          </Text>
        </Box>
      ))}
    </Box>
  )
}

export function ChatNodeView({ node }: { node: ChatNode }): React.ReactElement | null {
  switch (node.kind) {
    case 'user-message': return <UserMessage node={node} />
    case 'assistant': return <AssistantMessage node={node} />
    case 'tool-call': return <ToolCall node={node} />
    case 'command': return <CommandMessage node={node} />
    case 'compaction': return <CompactionMessage node={node} />
    case 'notice': return <NoticeMessage node={node} />
    case 'todo': return <TodoMessage node={node} />
    default: return null
  }
}

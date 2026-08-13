/**
 * Transcript search: live case-insensitive filter over the session's chat
 * nodes. Typing edits the query; Esc returns to the chat screen.
 * @module dsh-tui/tui/screens/search
 */

import React, { useState } from 'react'
import { Box, Text, useInput } from 'ink'
import type { TuiController } from '../../core/controller.ts'
import type { ChatNode } from '../../core/types.ts'
import { useTheme } from '../primitives/themed.tsx'

/** Maximum rendered matches. */
const LIMIT = 20

/** The searchable text of one node. */
function nodeText(node: ChatNode): string {
  switch (node.kind) {
    case 'user-message': return node.text
    case 'assistant': return `${node.text}\n${node.reasoning}`
    case 'tool-call': return `${node.name} ${node.argsRaw} ${node.result?.text ?? ''}`
    case 'command': return `/${node.name} ${node.args}`
    case 'compaction': return node.summary
    case 'notice': return node.text
    case 'todo': return node.todos.map(t => t.content).join(' ')
    default: return ''
  }
}

export function SearchScreen({ controller }: { controller: TuiController }): React.ReactElement {
  const theme = useTheme()
  const [query, setQuery] = useState('')
  const nodes = controller.sessionStore?.getSnapshot().nodes ?? []

  useInput((input, key) => {
    if (key.escape) {
      controller.setScreen('chat')
      return
    }
    if (key.backspace || key.delete) {
      setQuery(q => q.slice(0, -1))
      return
    }
    if (input.length > 0 && !key.ctrl && !key.meta && !key.return) {
      setQuery(q => q + input)
    }
  })

  const needle = query.trim().toLowerCase()
  const matches = needle === ''
    ? []
    : nodes
        .map((node, index) => ({ node, index }))
        .filter(({ node }) => nodeText(node).toLowerCase().includes(needle))

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box>
        <Text color={theme.brand} bold>search </Text>
        <Text>{query}</Text>
        <Text inverse> </Text>
        <Text color={theme.dim}>  type to filter · esc back</Text>
      </Box>
      {needle !== '' && matches.length === 0 && <Text color={theme.muted}>no matches</Text>}
      {matches.slice(-LIMIT).map(({ node, index }) => {
        const text = nodeText(node).replace(/\s+/g, ' ').trim()
        const at = Math.max(0, text.toLowerCase().indexOf(needle) - 30)
        return (
          <Box key={index}>
            <Text color={theme.plan}>{`#${index}`.padEnd(6)}</Text>
            <Text color={theme.heading}>{node.kind.padEnd(14)}</Text>
            <Text color={theme.muted}>{text.slice(at, at + 100)}</Text>
          </Box>
        )
      })}
      {matches.length > LIMIT && (
        <Text color={theme.dim}>… {matches.length - LIMIT} more matches above</Text>
      )}
    </Box>
  )
}

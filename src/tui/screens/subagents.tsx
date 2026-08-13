/**
 * Subagents screen: persisted sessions with `origin: 'subagent'` (delegation
 * children), resumable for inspection. Esc returns to the chat screen.
 * @module dsh-tui/tui/screens/subagents
 */

import React, { useEffect, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import type { TuiController } from '../../core/controller.ts'
import { useTheme } from '../primitives/themed.tsx'

/** Visible rows in the list window. */
const PAGE = 15

export function SubagentsScreen({ controller }: { controller: TuiController }): React.ReactElement {
  const theme = useTheme()
  const [children, setChildren] = useState<SessionHeader[] | undefined>(undefined)
  const [cursor, setCursor] = useState(0)

  useEffect(() => {
    void controller.listSessions().then(list => {
      setChildren(list.filter(s => s.origin === 'subagent'))
    })
  }, [controller])

  useInput((_input, key) => {
    if (key.escape) {
      controller.setScreen('chat')
      return
    }
    if (children === undefined || children.length === 0) return
    if (key.upArrow) setCursor(c => Math.max(0, c - 1))
    else if (key.downArrow) setCursor(c => Math.min(children.length - 1, c + 1))
    else if (key.return) {
      const target = children[cursor]
      if (target !== undefined) void controller.resumeSession(target.id)
    }
  })

  const start = Math.max(0, Math.min(cursor - Math.floor(PAGE / 2), (children?.length ?? 0) - PAGE))
  const visible = children?.slice(start, start + PAGE) ?? []

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box>
        <Text color={theme.brand} bold>subagents</Text>
        <Text color={theme.dim}>  ↑↓ move · enter open · esc back</Text>
      </Box>
      {children === undefined && <Text color={theme.muted}>loading…</Text>}
      {children !== undefined && children.length === 0 && (
        <Text color={theme.muted}>no subagent sessions recorded</Text>
      )}
      {visible.map((session, i) => {
        const index = start + i
        const active = index === cursor
        return (
          <Box key={session.id}>
            <Text color={active ? theme.brand : theme.dim}>{active ? '❯ ' : '  '}</Text>
            <Text color={active ? theme.text : theme.muted}>{session.id.slice(0, 24).padEnd(26)}</Text>
            <Text color={theme.dim}>
              depth {session.delegationDepth ?? 1}
              {session.parentSession !== undefined ? ` · parent ${session.parentSession.slice(0, 20)}` : ''}
            </Text>
          </Box>
        )
      })}
    </Box>
  )
}

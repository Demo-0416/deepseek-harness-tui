/**
 * Session picker: lists persisted sessions newest first, resumes the
 * selection, or starts a fresh session. Esc returns to the chat screen.
 * @module dsh-tui/tui/screens/sessions
 */

import React, { useEffect, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import type { TuiController } from '../../core/controller.ts'
import { useTheme } from '../primitives/themed.tsx'

/** Visible rows in the picker window. */
const PAGE = 15

export function SessionPicker({ controller }: { controller: TuiController }): React.ReactElement {
  const theme = useTheme()
  const [sessions, setSessions] = useState<SessionHeader[] | undefined>(undefined)
  const [cursor, setCursor] = useState(0)
  const activeId = controller.getState().sessionId

  useEffect(() => {
    void controller.listSessions().then(list => {
      setSessions(list.filter(s => s.origin !== 'subagent'))
    })
  }, [controller])

  useInput((input, key) => {
    if (key.escape) {
      controller.setScreen('chat')
      return
    }
    if (sessions === undefined || sessions.length === 0) {
      if (input === 'n') void controller.newSession()
      return
    }
    if (key.upArrow) setCursor(c => Math.max(0, c - 1))
    else if (key.downArrow) setCursor(c => Math.min(sessions.length - 1, c + 1))
    else if (key.return) {
      const target = sessions[cursor]
      if (target !== undefined && target.id !== activeId) void controller.resumeSession(target.id)
      else controller.setScreen('chat')
    } else if (input === 'n') {
      void controller.newSession()
    }
  })

  const start = Math.max(0, Math.min(cursor - Math.floor(PAGE / 2), (sessions?.length ?? 0) - PAGE))
  const visible = sessions?.slice(start, start + PAGE) ?? []

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box>
        <Text color={theme.brand} bold>sessions</Text>
        <Text color={theme.dim}>  ↑↓ move · enter resume · n new · esc back</Text>
      </Box>
      {sessions === undefined && <Text color={theme.muted}>loading…</Text>}
      {sessions !== undefined && sessions.length === 0 && (
        <Text color={theme.muted}>no persisted sessions — press n to start one</Text>
      )}
      {visible.map((session, i) => {
        const index = start + i
        const active = index === cursor
        const isCurrent = session.id === activeId
        const when = new Date(session.createdAt).toLocaleString()
        return (
          <Box key={session.id}>
            <Text color={active ? theme.brand : theme.dim}>{active ? '❯ ' : '  '}</Text>
            <Text color={active ? theme.text : theme.muted} bold={isCurrent}>
              {session.id.slice(0, 24).padEnd(26)}
            </Text>
            <Text color={theme.dim}>{when}</Text>
            {session.cwd !== undefined && <Text color={theme.dim}>  {session.cwd}</Text>}
            {isCurrent && <Text color={theme.success}>  ● current</Text>}
          </Box>
        )
      })}
      {sessions !== undefined && sessions.length > PAGE && (
        <Text color={theme.dim}>{start + 1}-{Math.min(start + PAGE, sessions.length)} of {sessions.length}</Text>
      )}
    </Box>
  )
}

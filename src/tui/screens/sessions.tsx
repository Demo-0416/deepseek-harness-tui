/**
 * The session picker screen: lists persisted sessions (newest first) with a
 * type-to-filter search. Up/Down moves the selection, Enter resumes the
 * selected session, Esc returns to chat.
 * @module dsh-tui/tui/screens/sessions
 */

import React, { useEffect, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { homedir } from 'node:os'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import type { TuiController } from '../../core/controller.ts'
import { ThemedText, useTheme } from '../primitives/themed.tsx'

export interface SessionPickerProps {
  controller: TuiController
}

/** Abbreviate a cwd by replacing the home prefix with ~. */
function shortCwd(cwd: string | undefined): string {
  if (cwd === undefined || cwd === '') return '~'
  const home = homedir()
  if (cwd === home) return '~'
  if (cwd.startsWith(`${home}/`)) return `~${cwd.slice(home.length)}`
  return cwd
}

/** Format an epoch-ms timestamp as HH:MM. */
function formatTime(epochMs: number): string {
  const d = new Date(epochMs)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

export function SessionPicker({ controller }: SessionPickerProps): React.ReactElement {
  const theme = useTheme()
  const [sessions, setSessions] = useState<SessionHeader[] | undefined>(undefined)
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState(0)

  useEffect(() => {
    let cancelled = false
    controller.listSessions()
      .then(list => { if (!cancelled) setSessions(list) })
      .catch(() => { if (!cancelled) setSessions([]) })
    return () => { cancelled = true }
  }, [controller])

  const query = filter.toLowerCase()
  const filtered = (sessions ?? []).filter(s =>
    query === ''
    || s.id.toLowerCase().includes(query)
    || (s.cwd ?? '').toLowerCase().includes(query),
  )
  const clamped = Math.min(selected, Math.max(0, filtered.length - 1))

  useInput((input, key) => {
    if (key.escape) {
      controller.setScreen('chat')
      return
    }
    if (key.return) {
      const target = filtered[clamped]
      if (target !== undefined) void controller.resumeSession(target.id)
      return
    }
    if (key.upArrow) {
      setSelected(Math.max(0, clamped - 1))
      return
    }
    if (key.downArrow) {
      setSelected(Math.min(filtered.length - 1, clamped + 1))
      return
    }
    if (key.backspace || key.delete) {
      setFilter(prev => prev.slice(0, -1))
      setSelected(0)
      return
    }
    if (input.length > 0 && !key.meta && !key.ctrl) {
      setFilter(prev => prev + input)
      setSelected(0)
    }
  })

  return (
    <Box flexDirection="column" padding={1}>
      <Box justifyContent="space-between">
        <ThemedText token="brand" bold>sessions</ThemedText>
        <ThemedText token="muted">
          {sessions === undefined ? 'loading…' : `${filtered.length}/${sessions.length}`}
        </ThemedText>
      </Box>

      <Box marginTop={1}>
        <Text color={theme.muted}>❯ </Text>
        <Text>
          <Text>{filter}</Text>
          <Text inverse> </Text>
        </Text>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        {sessions !== undefined && filtered.length === 0 ? (
          <ThemedText token="muted">no sessions yet</ThemedText>
        ) : (
          filtered.map((s, i) => {
            const isSelected = i === clamped
            return (
              <Box key={s.id}>
                <Text color={isSelected ? theme.brand : theme.muted} bold={isSelected}>
                  {isSelected ? '❯' : ' '}
                </Text>
                <Text color={isSelected ? theme.brand : theme.text} bold={isSelected}>
                  {' '}{shortCwd(s.cwd)}
                </Text>
                <Text color={theme.muted}>{'  '}{formatTime(s.createdAt)}</Text>
                <Text color={theme.dim}>{'  '}{s.id.slice(0, 8)}</Text>
              </Box>
            )
          })
        )}
      </Box>

      <Box marginTop={1}>
        <Text color={theme.dim}>↑↓ select · enter resume · esc back</Text>
      </Box>
    </Box>
  )
}

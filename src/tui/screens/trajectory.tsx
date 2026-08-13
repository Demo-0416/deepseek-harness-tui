/**
 * The trajectory screen: a reverse-chronological ledger of the session's raw
 * events for debugging the agent's event stream. Shows the last 100 events,
 * newest first; ↑/↓ scroll, esc returns to chat.
 * @module dsh-tui/tui/screens/trajectory
 */

import React, { useMemo, useState, useSyncExternalStore } from 'react'
import { Box, Text, useInput } from 'ink'
import type { TuiController } from '../../core/controller.ts'
import { ThemedText, useTheme } from '../primitives/themed.tsx'

/** How many trailing events the ledger shows. */
const WINDOW = 100
/** Max length of the data summary per row. */
const SUMMARY_MAX = 80
/** How many data fields the summary includes. */
const SUMMARY_FIELDS = 3

/** Theme token for an event type, per the screen's color rules. */
function typeToken(type: string): 'dim' | 'text' | 'brand' | 'error' | 'muted' {
  if (type.startsWith('turn') || type.startsWith('step')) return 'dim'
  if (type.startsWith('user') || type.startsWith('assistant')) return 'text'
  if (type.startsWith('tool')) return 'brand'
  if (type === 'error' || type.startsWith('error/') || type.endsWith('/error')) return 'error'
  return 'muted'
}

/** Format an epoch-ms timestamp as HH:MM:SS. */
function formatTime(time: number): string {
  const date = new Date(time)
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  const ss = String(date.getSeconds()).padStart(2, '0')
  return `${hh}:${mm}:${ss}`
}

/** Truncate a summary to the max length with an ellipsis. */
function truncate(text: string): string {
  return text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX)}…` : text
}

/** Render one data value as a short string. */
function renderValue(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return ''
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/** Summarize an event's data payload as `key=value` pairs, truncated. */
function summarizeData(data: unknown): string {
  if (data === null || data === undefined) return ''
  if (typeof data !== 'object') return truncate(renderValue(data))
  const parts: string[] = []
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    const rendered = renderValue(value)
    if (rendered === '') continue
    parts.push(`${key}=${rendered}`)
    if (parts.length >= SUMMARY_FIELDS) break
  }
  return truncate(parts.join(' '))
}

export interface TrajectoryScreenProps {
  controller: TuiController
}

export function TrajectoryScreen({ controller }: TrajectoryScreenProps): React.ReactElement {
  const theme = useTheme()
  const [offset, setOffset] = useState(0)

  // Re-render as new events stream in: the store flushes on a batch timer.
  const store = controller.sessionStore
  useSyncExternalStore(
    useMemo(() => (store === undefined ? (() => () => {}) : store.subscribe.bind(store)), [store]),
    useMemo(() => (() => controller.sessionEvents().length), [controller]),
  )

  const events = controller.sessionEvents()
  const total = events.length
  const shown = Math.min(WINDOW, total)
  const rows = events.slice(-WINDOW).reverse()
  const maxOffset = Math.max(0, rows.length - 1)
  const scroll = Math.min(offset, maxOffset)
  const visible = rows.slice(scroll)

  useInput((_input, key) => {
    if (key.escape) {
      controller.setScreen('chat')
      return
    }
    if (key.upArrow) {
      setOffset(prev => Math.min(prev + 1, maxOffset))
      return
    }
    if (key.downArrow) {
      setOffset(prev => Math.max(prev - 1, 0))
    }
  })

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box>
        <ThemedText token="brand" bold>trajectory</ThemedText>
        <ThemedText token="muted">  showing last {shown} of {total}</ThemedText>
      </Box>
      <Box>
        <ThemedText token="dim">↑/↓ scroll · esc back to chat</ThemedText>
      </Box>
      {total === 0 && (
        <Box>
          <ThemedText token="muted">no events yet</ThemedText>
        </Box>
      )}
      {scroll > 0 && (
        <Box>
          <Text color={theme.dim}>── ↑ {scroll} older ──</Text>
        </Box>
      )}
      {visible.map(event => (
        <Box key={event.seq}>
          <Text color={theme.dim}>{String(event.seq).padStart(5, ' ')}</Text>
          <Text color={theme.muted}> {formatTime(event.time)} </Text>
          <ThemedText token={typeToken(event.type)} bold>{event.type}</ThemedText>
          <Text color={theme.muted}> {summarizeData(event.data)}</Text>
        </Box>
      ))}
    </Box>
  )
}

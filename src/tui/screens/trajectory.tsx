/**
 * Trajectory screen: the raw session event log, newest at the bottom, with
 * simple scroll. Esc returns to the chat screen.
 * @module dsh-tui/tui/screens/trajectory
 */

import React, { useState } from 'react'
import { Box, Text, useInput } from 'ink'
import type { TuiController } from '../../core/controller.ts'
import { useTheme } from '../primitives/themed.tsx'

/** Visible rows per page. */
const PAGE = 25

export function TrajectoryScreen({ controller }: { controller: TuiController }): React.ReactElement {
  const theme = useTheme()
  const events = controller.sessionEvents()
  // Offset from the tail: 0 shows the newest page.
  const [offset, setOffset] = useState(0)
  const maxOffset = Math.max(0, events.length - PAGE)

  useInput((input, key) => {
    if (key.escape) {
      controller.setScreen('chat')
      return
    }
    if (key.upArrow || input === 'k') setOffset(o => Math.min(maxOffset, o + 1))
    else if (key.downArrow || input === 'j') setOffset(o => Math.max(0, o - 1))
    else if (key.pageUp) setOffset(o => Math.min(maxOffset, o + PAGE))
    else if (key.pageDown) setOffset(o => Math.max(0, o - PAGE))
    else if (input === 'g') setOffset(maxOffset)
    else if (input === 'G') setOffset(0)
  })

  const end = events.length - offset
  const start = Math.max(0, end - PAGE)
  const visible = events.slice(start, end)

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box>
        <Text color={theme.brand} bold>trajectory</Text>
        <Text color={theme.dim}>
          {'  '}{events.length} events · showing {start + 1}-{end} · ↑↓/jk scroll · g/G ends · esc back
        </Text>
      </Box>
      {visible.map((event, i) => {
        let preview = ''
        try {
          preview = JSON.stringify((event as { data?: unknown }).data ?? {})
        } catch {
          // Cyclic or non-serializable payloads only lose their preview.
          preview = '<unserializable>'
        }
        return (
          <Box key={start + i}>
            <Text color={theme.dim}>{String(start + i).padStart(5)} </Text>
            <Text color={theme.plan}>{event.type.padEnd(22)}</Text>
            <Text color={theme.muted}>{preview.length > 110 ? `${preview.slice(0, 110)}…` : preview}</Text>
          </Box>
        )
      })}
    </Box>
  )
}

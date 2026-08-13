/**
 * Settings screen: theme and approval-policy toggles over controller state.
 * Esc returns to the chat screen.
 * @module dsh-tui/tui/screens/settings
 */

import React, { useState } from 'react'
import { Box, Text, useInput } from 'ink'
import type { TuiController } from '../../core/controller.ts'
import { useTheme } from '../primitives/themed.tsx'

const ROWS = ['theme', 'approvals'] as const

export function SettingsScreen({ controller }: { controller: TuiController }): React.ReactElement {
  const theme = useTheme()
  const [cursor, setCursor] = useState(0)
  const state = controller.getState()

  useInput((input, key) => {
    if (key.escape) {
      controller.setScreen('chat')
      return
    }
    if (key.upArrow) setCursor(c => Math.max(0, c - 1))
    else if (key.downArrow) setCursor(c => Math.min(ROWS.length - 1, c + 1))
    else if (key.return || input === ' ') {
      const row = ROWS[cursor]
      if (row === 'theme') controller.setTheme(state.theme === 'dark' ? 'light' : 'dark')
      else if (row === 'approvals') controller.setApprovalAsks(!state.approvalAsks)
    }
  })

  const rows: { label: string; value: string }[] = [
    { label: 'theme', value: state.theme },
    { label: 'approvals', value: state.approvalAsks ? 'ask before tool use' : 'auto-approve' },
  ]

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box>
        <Text color={theme.brand} bold>settings</Text>
        <Text color={theme.dim}>  ↑↓ move · enter/space toggle · esc back</Text>
      </Box>
      {rows.map((row, i) => (
        <Box key={row.label}>
          <Text color={i === cursor ? theme.brand : theme.dim}>{i === cursor ? '❯ ' : '  '}</Text>
          <Text color={i === cursor ? theme.text : theme.muted}>{row.label.padEnd(12)}</Text>
          <Text color={theme.plan}>{row.value}</Text>
        </Box>
      ))}
    </Box>
  )
}

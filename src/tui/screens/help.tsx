/**
 * Help screen: keyboard shortcuts and the agent's registered slash commands.
 * Esc returns to the chat screen.
 * @module dsh-tui/tui/screens/help
 */

import React, { useMemo } from 'react'
import { Box, Text, useInput } from 'ink'
import type { TuiController } from '../../core/controller.ts'
import { useTheme } from '../primitives/themed.tsx'

const SHORTCUTS: readonly [string, string][] = [
  ['enter', 'send message'],
  ['ctrl+j', 'insert newline'],
  ['ctrl+c', 'cancel running turn / quit when idle'],
  ['↑ / ↓', 'input history'],
  ['ctrl+s', 'session picker'],
  ['ctrl+t', 'trajectory (raw events)'],
  ['ctrl+f', 'search transcript'],
  ['ctrl+p', 'plugins'],
  ['ctrl+b', 'subagents'],
  ['ctrl+,', 'settings'],
  ['?', 'this help'],
  ['esc', 'back to chat (from any screen)'],
]

export function HelpScreen({ controller }: { controller: TuiController }): React.ReactElement {
  const theme = useTheme()
  const commands = useMemo(() => controller.listCommands(), [controller])

  useInput((_input, key) => {
    if (key.escape || key.return) controller.setScreen('chat')
  })

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text color={theme.brand} bold>help</Text>
      <Box flexDirection="column" marginTop={1}>
        <Text color={theme.heading} bold>keyboard</Text>
        {SHORTCUTS.map(([keys, what]) => (
          <Box key={keys}>
            <Text color={theme.plan}>{keys.padEnd(10)}</Text>
            <Text color={theme.muted}>{what}</Text>
          </Box>
        ))}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        <Text color={theme.heading} bold>slash commands</Text>
        {commands.length === 0 && <Text color={theme.muted}>none registered</Text>}
        {commands.map(command => (
          <Box key={command.name}>
            <Text color={theme.plan}>/{command.name.padEnd(16)}</Text>
            <Text color={theme.muted}>{command.description}</Text>
          </Box>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text color={theme.dim}>esc back</Text>
      </Box>
    </Box>
  )
}

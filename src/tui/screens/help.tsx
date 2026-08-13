/**
 * The help screen: keybinding reference and the agent's slash commands.
 * Read-only — any key (Esc included) returns to chat.
 * @module dsh-tui/tui/screens/help
 */

import React from 'react'
import { Box, Text, useInput } from 'ink'
import type { TuiController } from '../../core/controller.ts'
import { useTheme } from '../primitives/themed.tsx'

const KEYBINDINGS: { key: string; description: string }[] = [
  { key: 'Enter', description: 'send message' },
  { key: 'Ctrl+J', description: 'new line' },
  { key: 'Ctrl+C', description: 'cancel turn / quit' },
  { key: 'Esc', description: 'back' },
  { key: '↑ / ↓', description: 'history' },
  { key: 'Ctrl+K', description: 'kill to end of line' },
  { key: 'Ctrl+U', description: 'kill to start of line' },
  { key: 'Alt+B / Alt+F', description: 'word back / forward' },
]

export interface HelpScreenProps {
  controller: TuiController
}

export function HelpScreen({ controller }: HelpScreenProps): React.ReactElement {
  const theme = useTheme()
  const commands = controller.listCommands()
  const keyWidth = Math.max(...KEYBINDINGS.map(binding => binding.key.length))
  const commandWidth = commands.length === 0
    ? 0
    : Math.max(...commands.map(command => command.name.length))

  useInput(() => {
    controller.setScreen('chat')
  })

  return (
    <Box flexDirection="column" padding={1}>
      <Text color={theme.heading} bold>Help</Text>

      <Box flexDirection="column" marginTop={1}>
        <Text color={theme.heading} bold>Keybindings</Text>
        {KEYBINDINGS.map(binding => (
          <Box key={binding.key}>
            <Text color={theme.code}>{binding.key.padEnd(keyWidth + 2)}</Text>
            <Text color={theme.muted}>{binding.description}</Text>
          </Box>
        ))}
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <Text color={theme.heading} bold>Commands</Text>
        {commands.length === 0 ? (
          <Text color={theme.dim}>no commands registered</Text>
        ) : (
          commands.map(command => (
            <Box key={command.name}>
              <Text color={theme.plan}>{`/${command.name}`.padEnd(commandWidth + 3)}</Text>
              <Text color={theme.muted}>{command.description}</Text>
            </Box>
          ))
        )}
      </Box>

      <Box marginTop={1}>
        <Text color={theme.dim}>press any key to go back</Text>
      </Box>
    </Box>
  )
}

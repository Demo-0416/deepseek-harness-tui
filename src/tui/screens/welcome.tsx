import React from 'react'
import { Box, Text, useInput } from 'ink'
import { ThemedText, useTheme } from '../primitives/themed.tsx'

export interface WelcomeProps {
  version: string
  onExit: () => void
}

/** Boot screen shown while the agent session is starting. */
export function Welcome({ version, onExit }: WelcomeProps): React.ReactElement {
  const theme = useTheme()
  useInput((input, key) => {
    if (input === 'q' || key.escape) onExit()
  })

  return (
    <Box flexDirection="column" padding={1}>
      <Text color={theme.brand} bold>dsh-tui {version}</Text>
      <ThemedText token="muted">terminal UI for deepseek-harness</ThemedText>
      <Box marginTop={1}>
        <ThemedText token="dim">starting session… (q to abort)</ThemedText>
      </Box>
    </Box>
  )
}

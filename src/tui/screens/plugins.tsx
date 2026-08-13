/**
 * The plugins screen: a read-only table of loaded plugins and their lifecycle
 * status. Esc returns to the chat screen.
 * @module dsh-tui/tui/screens/plugins
 */

import React, { useMemo } from 'react'
import { Box, Text, useInput } from 'ink'
import type { TuiController } from '../../core/controller.ts'
import { ThemedText, useTheme } from '../primitives/themed.tsx'

export interface PluginsScreenProps {
  controller: TuiController
}

type StatusToken = 'success' | 'warning' | 'error' | 'muted'

/** Map a raw plugin status string to a theme token. */
function statusToken(status: string): StatusToken {
  const s = status.toLowerCase()
  if (s === 'active' || s === 'loaded') return 'success'
  if (s === 'pending') return 'warning'
  if (s === 'error') return 'error'
  return 'muted'
}

export function PluginsScreen({ controller }: PluginsScreenProps): React.ReactElement {
  const theme = useTheme()
  const plugins = useMemo(() => controller.listPlugins(), [controller])

  useInput((_input, key) => {
    if (key.escape) controller.setScreen('chat')
  })

  return (
    <Box flexDirection="column" padding={1}>
      <Box justifyContent="space-between">
        <ThemedText token="brand" bold>plugins</ThemedText>
        <ThemedText token="muted">{plugins.length} total</ThemedText>
      </Box>

      <Box marginTop={1} justifyContent="space-between">
        <ThemedText token="dim">NAME</ThemedText>
        <ThemedText token="dim">STATUS</ThemedText>
      </Box>

      {plugins.length === 0 ? (
        <Box marginTop={1}>
          <ThemedText token="muted">no plugins loaded</ThemedText>
        </Box>
      ) : (
        <Box flexDirection="column">
          {plugins.map(plugin => (
            <Box key={plugin.name} justifyContent="space-between">
              <ThemedText token="text">{plugin.name}</ThemedText>
              <ThemedText token={statusToken(plugin.status)}>{plugin.status}</ThemedText>
            </Box>
          ))}
        </Box>
      )}

      <Box marginTop={1}>
        <Text color={theme.dim}>esc back</Text>
      </Box>
    </Box>
  )
}

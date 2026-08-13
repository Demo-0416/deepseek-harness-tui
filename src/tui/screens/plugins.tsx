/**
 * Plugins screen: the loaded cordis plugin registry with fiber status.
 * Esc returns to the chat screen.
 * @module dsh-tui/tui/screens/plugins
 */

import React, { useMemo } from 'react'
import { Box, Text, useInput } from 'ink'
import type { TuiController } from '../../core/controller.ts'
import { useTheme } from '../primitives/themed.tsx'

export function PluginsScreen({ controller }: { controller: TuiController }): React.ReactElement {
  const theme = useTheme()
  const plugins = useMemo(() => controller.listPlugins(), [controller])

  useInput((_input, key) => {
    if (key.escape || key.return) controller.setScreen('chat')
  })

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box>
        <Text color={theme.brand} bold>plugins</Text>
        <Text color={theme.dim}>  {plugins.length} loaded · esc back</Text>
      </Box>
      {plugins.length === 0 && <Text color={theme.muted}>plugin registry unavailable</Text>}
      {plugins.map(plugin => (
        <Box key={plugin.name}>
          <Text color={theme.muted}>{plugin.name.padEnd(48)}</Text>
          <Text color={plugin.status === 'active' ? theme.success : theme.dim}>{plugin.status}</Text>
        </Box>
      ))}
    </Box>
  )
}

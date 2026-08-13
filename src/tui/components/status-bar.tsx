/**
 * Bottom status bar: cwd, model, token usage, context pressure, and agent
 * state. Modeled on pi's two-line footer, condensed to one.
 * @module dsh-tui/tui/components/status-bar
 */

import React from 'react'
import { Box, Text } from 'ink'
import type { SessionSnapshot } from '../../core/types.ts'
import { useTheme } from '../primitives/themed.tsx'

export interface StatusBarProps {
  snapshot: SessionSnapshot
  model: string
  cwd: string
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

export function StatusBar({ snapshot, model, cwd }: StatusBarProps): React.ReactElement {
  const theme = useTheme()
  const usage = snapshot.totalUsage
  const used = usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0)
  const pressure = snapshot.contextWindow === undefined ? undefined : used / snapshot.contextWindow
  const pressureColor = pressure === undefined
    ? theme.muted
    : pressure > 0.9 ? theme.error : pressure > 0.7 ? theme.warning : theme.muted

  const shortCwd = cwd.replace(process.env.HOME ?? '~', '~')

  return (
    <Box>
      <Text color={theme.dim}>{shortCwd}</Text>
      <Text color={theme.dim}> │ </Text>
      <Text color={theme.brand}>{model}</Text>
      <Text color={theme.dim}> │ </Text>
      <Text color={theme.muted}>
        ↑{formatTokens(usage.inputTokens)} ↓{formatTokens(usage.outputTokens)}
        {(usage.cacheReadTokens ?? 0) > 0 && ` R${formatTokens(usage.cacheReadTokens ?? 0)}`}
      </Text>
      {pressure !== undefined && (
        <>
          <Text color={theme.dim}> │ </Text>
          <Text color={pressureColor}>{(pressure * 100).toFixed(0)}%</Text>
        </>
      )}
      <Text color={theme.dim}> │ </Text>
      <Text color={snapshot.status === 'running' ? theme.success : theme.dim}>
        {snapshot.status === 'running' ? '● working' : '○ idle'}
      </Text>
      {snapshot.planMode && (
        <>
          <Text color={theme.dim}> │ </Text>
          <Text color={theme.plan}>plan</Text>
        </>
      )}
    </Box>
  )
}

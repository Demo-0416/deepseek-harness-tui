/**
 * Approval dialog: shown when the agent asks for permission to run a tool.
 * Renders as an overlay above the composer; y allows once, n rejects, Esc
 * cancels.
 * @module dsh-tui/tui/components/approval-dialog
 */

import React from 'react'
import { Box, Text, useInput } from 'ink'
import type { PendingApproval } from '../../core/types.ts'
import { symbols } from '../theme.ts'
import { ThemedText, useTheme } from '../primitives/themed.tsx'

export interface ApprovalDialogProps {
  approval: PendingApproval
  onAnswer: (id: number, outcome: 'allowed-once' | 'rejected' | 'cancelled') => void
}

export function ApprovalDialog({ approval, onAnswer }: ApprovalDialogProps): React.ReactElement {
  const theme = useTheme()

  useInput((input, key) => {
    if (input === 'y' || input === 'Y') onAnswer(approval.id, 'allowed-once')
    else if (input === 'n' || input === 'N') onAnswer(approval.id, 'rejected')
    else if (key.escape) onAnswer(approval.id, 'cancelled')
  })

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.approval} paddingX={1}>
      <ThemedText token="approval" bold>
        {symbols.overlayTop} permission request
      </ThemedText>
      <Box marginTop={1}>
        <Text>
          <Text bold>{approval.toolName}</Text>
          {approval.callId !== undefined && <Text color={theme.dim}> ({approval.callId})</Text>}
        </Text>
      </Box>
      {approval.reason !== undefined && (
        <Box>
          <ThemedText token="muted">{approval.reason}</ThemedText>
        </Box>
      )}
      <Box marginTop={1}>
        <Text color={theme.muted}>
          <Text color={theme.success} bold>y</Text> allow once  <Text color={theme.error} bold>n</Text> reject  <Text bold>esc</Text> cancel
        </Text>
      </Box>
    </Box>
  )
}

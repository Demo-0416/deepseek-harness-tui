/**
 * The settings screen: theme and approval policy toggles plus a read-only
 * model readout. Up/down to move, Enter or Left/Right to change a value,
 * Esc to return to chat.
 * @module dsh-tui/tui/screens/settings
 */

import React, { useMemo, useState, useSyncExternalStore } from 'react'
import { Box, Text, useInput } from 'ink'
import type { TuiController } from '../../core/controller.ts'
import type { SessionStore } from '../../core/session-store.ts'
import type { SessionSnapshot } from '../../core/types.ts'
import { symbols } from '../theme.ts'
import { ThemedText, useTheme } from '../primitives/themed.tsx'

/** Subscribe to the active session's read model (mirrors chat.tsx). */
function useSnapshot(store: SessionStore | undefined): SessionSnapshot | undefined {
  return useSyncExternalStore(
    useMemo(() => (store === undefined ? (() => () => {}) : store.subscribe.bind(store)), [store]),
    useMemo(() => (store === undefined ? (() => undefined) : store.getSnapshot.bind(store)), [store]),
  )
}

export interface SettingsScreenProps {
  controller: TuiController
}

/** One settings row: selection marker and label on the left, value right. */
function SettingRow({ selected, label, children }: {
  selected: boolean
  label: string
  children: React.ReactNode
}): React.ReactElement {
  return (
    <Box justifyContent="space-between">
      <ThemedText token={selected ? 'brand' : 'text'} bold={selected}>
        {selected ? symbols.inputPrefix : ' '} {label}
      </ThemedText>
      {children}
    </Box>
  )
}

/** "dark / light" style value: the active option is highlighted. */
function ToggleValue({ options, active }: {
  options: readonly string[]
  active: string
}): React.ReactElement {
  const theme = useTheme()
  return (
    <Text>
      {options.map((option, i) => (
        <Text
          key={option}
          color={option === active ? theme.brand : theme.dim}
          bold={option === active}
        >
          {i > 0 ? ' / ' : ''}{option}
        </Text>
      ))}
    </Text>
  )
}

const ROW_IDS = ['theme', 'approval', 'model'] as const
type RowId = (typeof ROW_IDS)[number]

export function SettingsScreen({ controller }: SettingsScreenProps): React.ReactElement {
  const state = useSyncExternalStore(
    controller.subscribe.bind(controller),
    controller.getState.bind(controller),
  )
  const snapshot = useSnapshot(controller.sessionStore)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const selected: RowId = ROW_IDS[selectedIndex] ?? 'theme'

  useInput((_input, key) => {
    if (key.escape) {
      controller.setScreen('chat')
      return
    }
    if (key.upArrow) {
      setSelectedIndex(i => (i + ROW_IDS.length - 1) % ROW_IDS.length)
      return
    }
    if (key.downArrow) {
      setSelectedIndex(i => (i + 1) % ROW_IDS.length)
      return
    }
    if (key.return || key.leftArrow || key.rightArrow) {
      if (selected === 'theme') {
        controller.setTheme(state.theme === 'dark' ? 'light' : 'dark')
      } else if (selected === 'approval') {
        controller.setApprovalAsks(!state.approvalAsks)
      }
      // The model row is read-only.
    }
  })

  const model = snapshot?.model ?? 'default'

  return (
    <Box flexDirection="column" paddingX={1}>
      <ThemedText token="brand" bold>Settings</ThemedText>
      <Box flexDirection="column" marginTop={1}>
        <SettingRow selected={selected === 'theme'} label="Theme">
          <ToggleValue options={['dark', 'light']} active={state.theme} />
        </SettingRow>
        <SettingRow selected={selected === 'approval'} label="Approval policy">
          <ToggleValue options={['ask', 'never']} active={state.approvalAsks ? 'ask' : 'never'} />
        </SettingRow>
        <SettingRow selected={selected === 'model'} label="Model">
          <ThemedText token={selected === 'model' ? 'text' : 'muted'}>{model}</ThemedText>
        </SettingRow>
      </Box>
      <Box marginTop={1}>
        <ThemedText token="dim">↑/↓ move · ←/→ or enter change · esc back</ThemedText>
      </Box>
    </Box>
  )
}

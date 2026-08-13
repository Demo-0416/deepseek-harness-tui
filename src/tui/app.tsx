/**
 * Root component: subscribes to the controller and routes between screens.
 * Global screen-switching keys are handled here, active only on the chat
 * screen; other screens own their input.
 * @module dsh-tui/tui/app
 */

import React, { useSyncExternalStore } from 'react'
import { Box, Text, render, useInput, type Instance } from 'ink'
import type { TuiController } from '../core/controller.ts'
import { ThemeProvider, useTheme } from './primitives/themed.tsx'
import { darkTheme, lightTheme } from './theme.ts'
import { ChatScreen } from './screens/chat.tsx'
import { Welcome } from './screens/welcome.tsx'
import { SessionPicker } from './screens/sessions.tsx'
import { SettingsScreen } from './screens/settings.tsx'
import { HelpScreen } from './screens/help.tsx'
import { SearchScreen } from './screens/search.tsx'
import { TrajectoryScreen } from './screens/trajectory.tsx'
import { PluginsScreen } from './screens/plugins.tsx'
import { SubagentsScreen } from './screens/subagents.tsx'

export interface AppHandle {
  unmount: () => void
  waitUntilExit: () => Promise<void>
}

export interface AppProps {
  controller: TuiController
  version: string
  model: string
  onExit: () => void
}

function ScreenRouter({ controller, version, model, onExit }: AppProps): React.ReactElement {
  const theme = useTheme()
  const state = useSyncExternalStore(
    controller.subscribe.bind(controller),
    controller.getState.bind(controller),
  )

  // Global screen-switching keys, active only on the chat screen.
  useInput((input, key) => {
    if (state.screen !== 'chat') return
    if (key.ctrl && input === 's') controller.setScreen('sessions')
    else if (key.ctrl && input === 'p') controller.setScreen('plugins')
    else if (key.ctrl && input === 'f') controller.setScreen('search')
    else if (key.ctrl && input === 't') controller.setScreen('trajectory')
    else if (key.ctrl && input === 'b') controller.setScreen('subagents')
    else if (key.ctrl && input === ',') controller.setScreen('settings')
    else if (input === '?' || (key.ctrl && input === 'h')) controller.setScreen('help')
  })

  if (state.error !== undefined) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color={theme.error} bold>dsh-tui: {state.error}</Text>
        <Text color={theme.dim}>press any key to exit</Text>
      </Box>
    )
  }

  if (state.sessionId === undefined) {
    return <Welcome version={version} onExit={onExit} />
  }

  switch (state.screen) {
    case 'chat':
      return <ChatScreen controller={controller} model={model} />
    case 'sessions':
      return <SessionPicker controller={controller} />
    case 'settings':
      return <SettingsScreen controller={controller} />
    case 'help':
      return <HelpScreen controller={controller} />
    case 'search':
      return <SearchScreen controller={controller} />
    case 'trajectory':
      return <TrajectoryScreen controller={controller} />
    case 'plugins':
      return <PluginsScreen controller={controller} />
    case 'subagents':
      return <SubagentsScreen controller={controller} />
    default:
      return (
        <Box flexDirection="column" padding={1}>
          <Text color={theme.muted}>unknown screen</Text>
        </Box>
      )
  }
}

export function App(props: AppProps): React.ReactElement {
  const theme = useSyncExternalStore(
    props.controller.subscribe.bind(props.controller),
    props.controller.getState.bind(props.controller),
  ).theme
  return (
    <ThemeProvider theme={theme === 'light' ? lightTheme : darkTheme}>
      <ScreenRouter {...props} />
    </ThemeProvider>
  )
}

/**
 * Mount the Ink application and return its handle.
 * @param controller - the TUI controller.
 * @param version - this package's version.
 * @param model - the active model label for the status bar.
 * @param onExit - called when the user quits, before unmount.
 */
export function renderApp(controller: TuiController, version: string, model: string, onExit: () => void): AppHandle {
  const app: Instance = render(
    <App controller={controller} version={version} model={model} onExit={onExit} />,
    { exitOnCtrlC: false },
  )
  return {
    unmount: () => app.unmount(),
    waitUntilExit: async () => {
      await app.waitUntilExit()
    },
  }
}

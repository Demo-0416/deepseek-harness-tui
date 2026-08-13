/**
 * Theme-aware primitives: every component reads the active theme through
 * React context instead of hardcoding colors.
 * @module dsh-tui/tui/primitives/themed
 */

import React, { createContext, useContext } from 'react'
import { Box, Text, type BoxProps, type TextProps } from 'ink'
import { darkTheme, type Theme } from '../theme.ts'

const ThemeContext = createContext<Theme>(darkTheme)

export interface ThemeProviderProps {
  theme: Theme
  children: React.ReactNode
}

export function ThemeProvider({ theme, children }: ThemeProviderProps): React.ReactElement {
  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>
}

export function useTheme(): Theme {
  return useContext(ThemeContext)
}

type ColorKey = keyof Pick<Theme,
  'brand' | 'text' | 'muted' | 'dim' | 'success' | 'error' | 'warning'
  | 'approval' | 'plan' | 'heading' | 'link' | 'code' | 'reasoning'>

export interface ThemedTextProps extends Omit<TextProps, 'color'> {
  /** Theme token to use as the text color. */
  token?: ColorKey
  children: React.ReactNode
}

export function ThemedText({ token = 'text', ...props }: ThemedTextProps): React.ReactElement {
  const theme = useTheme()
  return <Text color={theme[token]} {...props} />
}

export interface ThemedBoxProps extends Omit<BoxProps, 'borderColor'> {
  /** Theme token to use as the border color. */
  borderToken?: ColorKey | 'border'
  children?: React.ReactNode
}

export function ThemedBox({ borderToken, ...props }: ThemedBoxProps): React.ReactElement {
  const theme = useTheme()
  const color = borderToken === undefined ? undefined : theme[borderToken]
  return <Box borderColor={color} {...props} />
}

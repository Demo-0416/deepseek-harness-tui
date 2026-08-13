/**
 * Animated spinner with an optional status line, cc-style.
 * @module dsh-tui/tui/primitives/spinner
 */

import React, { useEffect, useState } from 'react'
import { Text } from 'ink'
import { useTheme } from './themed.tsx'
import { symbols } from '../theme.ts'

export interface SpinnerProps {
  /** Label shown after the spinner frame. */
  label?: string
  /** Frame interval in ms. */
  interval?: number
}

export function Spinner({ label, interval = 80 }: SpinnerProps): React.ReactElement {
  const theme = useTheme()
  const [frame, setFrame] = useState(0)

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame(f => (f + 1) % symbols.spinner.length)
    }, interval)
    return () => clearInterval(timer)
  }, [interval])

  return (
    <Text>
      <Text color={theme.brand} bold>{symbols.spinner[frame]}</Text>
      {label !== undefined && <Text color={theme.muted}> {label}</Text>}
    </Text>
  )
}

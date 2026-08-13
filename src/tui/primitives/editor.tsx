/**
 * Multi-line terminal editor for the composer: text editing, history,
 * kill-ring basics, and word navigation. Enter submits; Ctrl+J inserts a
 * newline. The cursor is rendered as an inverted block (raw mode hides the
 * real terminal cursor).
 * @module dsh-tui/tui/primitives/editor
 */

import React, { useCallback, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { useTheme } from './themed.tsx'

export interface EditorProps {
  /** Called when the user presses Enter with non-empty text. */
  onSubmit: (text: string) => void
  /** Previous inputs for history navigation (oldest first). */
  history?: readonly string[]
  /** Placeholder shown when empty. */
  placeholder?: string
  /** Whether the editor accepts input (false while the agent is running). */
  disabled?: boolean
  /** Called when the user presses Ctrl+C. */
  onCancel?: () => void
  /** Slash commands offered by the autocomplete menu. */
  commands?: readonly { name: string; description: string }[]
}

/** Visible rows in the command autocomplete menu. */
const MENU_PAGE = 8

interface Cursor {
  row: number
  col: number
}

/** Split text into lines, always at least one. */
function toLines(text: string): string[] {
  const lines = text.split('\n')
  return lines.length === 0 ? [''] : lines
}

export function Editor({ onSubmit, history = [], placeholder, disabled = false, onCancel, commands = [] }: EditorProps): React.ReactElement {
  const theme = useTheme()
  const [lines, setLines] = useState<string[]>([''])
  const [cursor, setCursor] = useState<Cursor>({ row: 0, col: 0 })
  const [historyIndex, setHistoryIndex] = useState<number | undefined>(undefined)
  const [menuIndex, setMenuIndex] = useState(0)
  const [menuSuppressed, setMenuSuppressed] = useState(false)

  // The command menu is offered while the input is one line, starts with '/',
  // and has no arguments yet (no space typed).
  const firstLine = lines[0] ?? ''
  const menuQuery = lines.length === 1 && firstLine.startsWith('/') && !firstLine.includes(' ')
    ? firstLine.slice(1).toLowerCase()
    : undefined
  const menuItems = menuQuery === undefined || menuSuppressed
    ? []
    : commands.filter(c => c.name.toLowerCase().startsWith(menuQuery))
  const menuOpen = menuItems.length > 0
  const selected = menuItems[Math.min(menuIndex, menuItems.length - 1)]

  const update = useCallback((newLines: string[], newCursor: Cursor) => {
    setLines(newLines)
    setCursor(newCursor)
  }, [])

  const insertText = useCallback((insert: string) => {
    setMenuSuppressed(false)
    setMenuIndex(0)
    setLines(prev => {
      const next = [...prev]
      const line = next[cursor.row] ?? ''
      next[cursor.row] = line.slice(0, cursor.col) + insert + line.slice(cursor.col)
      const newLines = toLines(next.join('\n'))
      const inserted = toLines(insert)
      const lastInserted = inserted[inserted.length - 1] ?? ''
      const newCursor: Cursor = inserted.length === 1
        ? { row: cursor.row, col: cursor.col + insert.length }
        : { row: cursor.row + inserted.length - 1, col: lastInserted.length }
      setCursor(newCursor)
      return newLines
    })
  }, [cursor])

  const submit = useCallback(() => {
    const value = lines.join('\n').trim()
    if (value === '') return
    onSubmit(value)
    setLines([''])
    setCursor({ row: 0, col: 0 })
    setHistoryIndex(undefined)
  }, [lines, onSubmit])

  useInput((input, key) => {
    if (disabled) return

    // The command menu owns navigation/accept keys while visible.
    if (menuOpen) {
      if (key.upArrow) {
        setMenuIndex(i => (i + menuItems.length - 1) % menuItems.length)
        return
      }
      if (key.downArrow) {
        setMenuIndex(i => (i + 1) % menuItems.length)
        return
      }
      if (key.tab) {
        if (selected !== undefined) {
          const text = `/${selected.name} `
          setLines([text])
          setCursor({ row: 0, col: text.length })
          setMenuIndex(0)
        }
        return
      }
      if (key.return) {
        if (selected !== undefined) {
          onSubmit(`/${selected.name}`)
          setLines([''])
          setCursor({ row: 0, col: 0 })
          setHistoryIndex(undefined)
          setMenuIndex(0)
        }
        return
      }
      if (key.escape) {
        setMenuSuppressed(true)
        return
      }
    }

    if (key.return) {
      submit()
      return
    }
    if (key.ctrl && input === 'j') {
      insertText('\n')
      return
    }
    if (key.ctrl && input === 'c') {
      onCancel?.()
      return
    }
    if (key.ctrl && input === 'k') {
      // Kill to end of line.
      setLines(prev => {
        const next = [...prev]
        const line = next[cursor.row] ?? ''
        next[cursor.row] = line.slice(0, cursor.col)
        return next
      })
      return
    }
    if (key.ctrl && input === 'u') {
      // Kill to start of line.
      setLines(prev => {
        const next = [...prev]
        const line = next[cursor.row] ?? ''
        next[cursor.row] = line.slice(cursor.col)
        return next
      })
      setCursor({ ...cursor, col: 0 })
      return
    }
    if (key.ctrl && (input === 'b' || input === 'f')) {
      // Word left/right.
      setCursor(prev => {
        const line = lines[prev.row] ?? ''
        let col = prev.col
        if (input === 'b') {
          while (col > 0 && line[col - 1] === ' ') col--
          while (col > 0 && line[col - 1] !== ' ') col--
        } else {
          while (col < line.length && line[col] === ' ') col++
          while (col < line.length && line[col] !== ' ') col++
        }
        return { ...prev, col }
      })
      return
    }
    if (key.upArrow) {
      if (history.length === 0) return
      const idx = historyIndex === undefined ? history.length - 1 : Math.max(0, historyIndex - 1)
      setHistoryIndex(idx)
      const value = history[idx] ?? ''
      const newLines = toLines(value)
      update(newLines, { row: newLines.length - 1, col: newLines[newLines.length - 1]?.length ?? 0 })
      return
    }
    if (key.downArrow) {
      if (historyIndex === undefined) return
      const idx = historyIndex + 1
      if (idx >= history.length) {
        setHistoryIndex(undefined)
        update([''], { row: 0, col: 0 })
      } else {
        setHistoryIndex(idx)
        const value = history[idx] ?? ''
        const newLines = toLines(value)
        update(newLines, { row: newLines.length - 1, col: newLines[newLines.length - 1]?.length ?? 0 })
      }
      return
    }
    if (key.leftArrow) {
      setCursor(prev => {
        if (prev.col > 0) return { ...prev, col: prev.col - 1 }
        if (prev.row > 0) {
          const prevLine = lines[prev.row - 1] ?? ''
          return { row: prev.row - 1, col: prevLine.length }
        }
        return prev
      })
      return
    }
    if (key.rightArrow) {
      setCursor(prev => {
        const line = lines[prev.row] ?? ''
        if (prev.col < line.length) return { ...prev, col: prev.col + 1 }
        if (prev.row < lines.length - 1) return { row: prev.row + 1, col: 0 }
        return prev
      })
      return
    }
    if (key.backspace || key.delete) {
      setMenuSuppressed(false)
      setMenuIndex(0)
      setLines(prev => {
        if (cursor.col === 0 && cursor.row === 0) return prev
        const next = [...prev]
        if (cursor.col === 0) {
          const prevLine = next[cursor.row - 1] ?? ''
          const thisLine = next[cursor.row] ?? ''
          next[cursor.row - 1] = prevLine + thisLine
          next.splice(cursor.row, 1)
          setCursor({ row: cursor.row - 1, col: prevLine.length })
        } else {
          const line = next[cursor.row] ?? ''
          next[cursor.row] = line.slice(0, cursor.col - 1) + line.slice(cursor.col)
          setCursor({ ...cursor, col: cursor.col - 1 })
        }
        return next
      })
      return
    }
    if (key.escape) return
    // Printable input (paste and typing).
    if (input.length > 0 && !key.meta && !key.ctrl) {
      insertText(input)
    }
  })

  const isEmpty = lines.length === 1 && lines[0] === ''
  const visibleLines = isEmpty && placeholder !== undefined
    ? [[{ text: placeholder, dim: true }]]
    : lines.map((line, row) => {
        const isCursorRow = row === cursor.row
        if (!isCursorRow) return [{ text: line || ' ', dim: false }]
        const before = line.slice(0, cursor.col)
        const at = line[cursor.col] ?? ' '
        const after = line.slice(cursor.col + 1)
        return [
          { text: before, dim: false },
          { text: at, dim: false, cursor: true },
          { text: after, dim: false },
        ]
      })

  const menuStart = Math.max(0, Math.min(menuIndex - Math.floor(MENU_PAGE / 2), menuItems.length - MENU_PAGE))
  const menuVisible = menuItems.slice(menuStart, menuStart + MENU_PAGE)

  return (
    <Box flexDirection="column">
      {visibleLines.map((segments, row) => (
        <Box key={row}>
          <Text color={theme.muted}>{row === 0 ? '❯ ' : '  '}</Text>
          <Text>
            {segments.map((seg, i) => (
              <Text
                key={i}
                {...(seg.dim ? { color: theme.dim } : {})}
                inverse={seg.cursor === true}
              >
                {seg.text}
              </Text>
            ))}
          </Text>
        </Box>
      ))}
      {menuOpen && (
        <Box flexDirection="column">
          {menuVisible.map((item, i) => {
            const index = menuStart + i
            const active = index === Math.min(menuIndex, menuItems.length - 1)
            return (
              <Box key={item.name}>
                <Text color={active ? theme.brand : theme.dim}>{active ? '❯ ' : '  '}</Text>
                <Text color={active ? theme.brand : theme.text} bold={active}>
                  /{item.name.padEnd(18)}
                </Text>
                <Text color={theme.dim}>{item.description}</Text>
              </Box>
            )
          })}
          {menuItems.length > MENU_PAGE && (
            <Text color={theme.dim}>  … {menuItems.length} commands · ↑↓ move · tab complete · enter run</Text>
          )}
        </Box>
      )}
    </Box>
  )
}

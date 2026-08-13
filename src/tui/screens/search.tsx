/**
 * The search screen: live in-session search over the chat nodes. Type to
 * filter user messages, assistant text, tool calls, and notices; arrows move
 * through the matches; Esc returns to chat.
 * @module dsh-tui/tui/screens/search
 */

import React, { useMemo, useSyncExternalStore, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import type { TuiController } from '../../core/controller.ts'
import type { SessionStore } from '../../core/session-store.ts'
import type { ChatNode, SessionSnapshot } from '../../core/types.ts'
import { symbols } from '../theme.ts'
import { ThemedText, useTheme } from '../primitives/themed.tsx'

/** How many matches to render at once (window around the selection). */
const WINDOW = 20
/** Max characters of a matched line before truncation. */
const MAX_LINE = 100

function useSnapshot(store: SessionStore | undefined): SessionSnapshot | undefined {
  return useSyncExternalStore(
    useMemo(() => (store === undefined ? (() => () => {}) : store.subscribe.bind(store)), [store]),
    useMemo(() => (store === undefined ? (() => undefined) : store.getSnapshot.bind(store)), [store]),
  )
}

interface SearchMatch {
  node: ChatNode
  /** The node's position in the session. */
  index: number
  /** The single line that matched, trimmed and truncated. */
  line: string
}

type BadgeToken = 'brand' | 'text' | 'code' | 'error' | 'warning' | 'muted'

/** The text searched per node kind. */
function searchableText(node: ChatNode): string {
  switch (node.kind) {
    case 'user-message':
      return node.text
    case 'assistant':
      return node.text
    case 'tool-call':
      return `${node.name} ${node.argsRaw}`
    case 'notice':
      return node.text
    default:
      return ''
  }
}

/** Icon + color for a searchable node kind. */
function badgeFor(node: ChatNode): { icon: string; token: BadgeToken } {
  switch (node.kind) {
    case 'user-message':
      return { icon: symbols.userPrompt, token: 'brand' }
    case 'assistant':
      return { icon: symbols.thinking, token: 'text' }
    case 'tool-call':
      return { icon: symbols.toolResult, token: 'code' }
    case 'notice':
      return node.tone === 'error'
        ? { icon: symbols.statusError, token: 'error' }
        : node.tone === 'warning'
          ? { icon: symbols.statusWarn, token: 'warning' }
          : { icon: symbols.statusInfo, token: 'muted' }
    default:
      return { icon: symbols.statusInfo, token: 'muted' }
  }
}

function truncate(line: string): string {
  return line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}…` : line
}

/** Case-insensitive match; returns the trimmed line containing the hit. */
function matchLine(node: ChatNode, index: number, query: string): SearchMatch | undefined {
  const haystack = searchableText(node)
  if (haystack === '') return undefined
  const pos = haystack.toLowerCase().indexOf(query)
  if (pos < 0) return undefined
  const lineStart = haystack.lastIndexOf('\n', pos - 1) + 1
  const nextBreak = haystack.indexOf('\n', pos)
  const lineEnd = nextBreak < 0 ? haystack.length : nextBreak
  const line = haystack.slice(lineStart, lineEnd).trim()
  if (line === '') return undefined
  return { node, index, line: truncate(line) }
}

export interface SearchScreenProps {
  controller: TuiController
}

export function SearchScreen({ controller }: SearchScreenProps): React.ReactElement {
  const theme = useTheme()
  const snapshot = useSnapshot(controller.sessionStore)
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const [selected, setSelected] = useState(0)

  const matches = useMemo<SearchMatch[]>(() => {
    if (snapshot === undefined || query.trim() === '') return []
    const q = query.toLowerCase()
    const out: SearchMatch[] = []
    snapshot.nodes.forEach((node, index) => {
      const match = matchLine(node, index, q)
      if (match !== undefined) out.push(match)
    })
    return out
  }, [snapshot, query])

  const selectedIndex = Math.min(selected, Math.max(0, matches.length - 1))
  const windowStart = Math.min(
    Math.max(0, selectedIndex - WINDOW + 1),
    Math.max(0, matches.length - WINDOW),
  )
  const visible = matches.slice(windowStart, windowStart + WINDOW)

  useInput((input, key) => {
    if (key.escape) {
      controller.setScreen('chat')
      return
    }
    if (matches.length > 0 && key.upArrow) {
      setSelected(s => Math.max(0, s - 1))
      return
    }
    if (matches.length > 0 && key.downArrow) {
      setSelected(s => Math.min(matches.length - 1, s + 1))
      return
    }
    if (key.leftArrow) {
      setCursor(c => Math.max(0, c - 1))
      return
    }
    if (key.rightArrow) {
      setCursor(c => Math.min(query.length, c + 1))
      return
    }
    if (key.backspace || key.delete) {
      if (cursor > 0) {
        setQuery(q => q.slice(0, cursor - 1) + q.slice(cursor))
        setCursor(c => c - 1)
        setSelected(0)
      }
      return
    }
    if (input.length > 0 && !key.meta && !key.ctrl) {
      setQuery(q => q.slice(0, cursor) + input + q.slice(cursor))
      setCursor(c => c + input.length)
      setSelected(0)
    }
  })

  if (snapshot === undefined) {
    return (
      <Box padding={1}>
        <ThemedText token="muted">no active session</ThemedText>
      </Box>
    )
  }

  const before = query.slice(0, cursor)
  const at = query[cursor] ?? ' '
  const after = query.slice(cursor + 1)
  const isEmptyQuery = query.trim() === ''

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box>
        <ThemedText token="brand" bold>search</ThemedText>
        <ThemedText token="muted">  type to filter · ↑↓ navigate · esc to close</ThemedText>
      </Box>

      <Box marginTop={1}>
        <Text color={theme.muted}>{symbols.inputPrefix} </Text>
        <Text>
          <Text>{before}</Text>
          <Text inverse>{at}</Text>
          <Text>{after}</Text>
        </Text>
      </Box>

      {isEmptyQuery ? (
        <Box marginTop={1}>
          <ThemedText token="dim">type to search this session</ThemedText>
        </Box>
      ) : matches.length === 0 ? (
        <Box marginTop={1}>
          <ThemedText token="dim">no matches</ThemedText>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {visible.map((match, i) => {
            const isSelected = windowStart + i === selectedIndex
            const badge = badgeFor(match.node)
            return (
              <Box key={`${match.node.kind}-${match.index}`}>
                <Text color={isSelected ? theme.brand : theme.dim}>
                  {isSelected ? symbols.inputPrefix : ' '}
                </Text>
                <ThemedText token={badge.token}>{badge.icon}</ThemedText>
                <Text color={isSelected ? theme.text : theme.muted}> {match.line}</Text>
                <Text color={theme.dim}> #{match.index}</Text>
              </Box>
            )
          })}
          <Box>
            <ThemedText token="dim">{selectedIndex + 1}/{matches.length}</ThemedText>
          </Box>
        </Box>
      )}
    </Box>
  )
}

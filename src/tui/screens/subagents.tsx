/**
 * The subagents screen: a read-only tree of subagent lifecycle events
 * (`subagent/*`) folded from the session event log. Esc returns to chat.
 *
 * The `subagent/*` payload shape is not asserted by the TUI, so every field
 * is read defensively (optional chaining + string coercion) and unknown
 * verbs degrade to a plain status label.
 * @module dsh-tui/tui/screens/subagents
 */

import React, { useMemo, useSyncExternalStore } from 'react'
import { Box, useInput } from 'ink'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { TuiController } from '../../core/controller.ts'
import { symbols } from '../theme.ts'
import { ThemedText } from '../primitives/themed.tsx'

/** Loose shape of a `subagent/*` event payload; fields are best-effort. */
interface SubagentEventData {
  subagentId?: unknown
  id?: unknown
  sessionId?: unknown
  name?: unknown
  label?: unknown
  parentSessionId?: unknown
  parentId?: unknown
  parentSession?: unknown
  error?: unknown
}

/** One folded subagent row, ready to render as a tree line. */
interface SubagentRow {
  id: string
  name: string
  parentId: string | undefined
  depth: number
  /** Ancestor continuation glyphs plus this row's branch glyph. */
  prefix: string
  startedAt: number
  endedAt: number | undefined
  /** Last lifecycle verb seen ('start', 'end', or the raw suffix). */
  verb: string
  errored: boolean
}

/** Coerce an unknown payload field to a string, or undefined. */
function asString(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return undefined
}

/** Truncate long ids for the trailing dim label. */
function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** Format an epoch-ms timestamp as HH:MM:SS. */
function formatTime(ms: number): string {
  if (!Number.isFinite(ms)) return ''
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** Human-readable duration between two epoch-ms timestamps. */
function formatDuration(start: number, end: number): string {
  const ms = end - start
  if (!Number.isFinite(ms) || ms < 0) return ''
  if (ms < 1000) return `${Math.round(ms)}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m${Math.round(seconds % 60)}s`
}

/**
 * Fold `subagent/*` events into display rows: one row per subagent id,
 * ordered depth-first by parent/child relationships inferred from
 * `parentSessionId`-style payload fields.
 */
function foldSubagents(events: readonly SessionEvent[]): SubagentRow[] {
  interface Acc {
    name: string
    parentId: string | undefined
    startedAt: number
    endedAt: number | undefined
    verb: string
    errored: boolean
    order: number
  }

  const byId = new Map<string, Acc>()
  events.forEach((event, index) => {
    const data = (event.data ?? {}) as unknown as SubagentEventData
    const id = asString(data.subagentId)
      ?? asString(data.id)
      ?? asString(data.sessionId)
      ?? `subagent-${event.seq}`
    const verb = event.type.slice('subagent/'.length)

    let acc = byId.get(id)
    if (acc === undefined) {
      acc = {
        name: asString(data.name) ?? asString(data.label) ?? id,
        parentId: asString(data.parentSessionId) ?? asString(data.parentId) ?? asString(data.parentSession),
        startedAt: event.time,
        endedAt: undefined,
        verb,
        errored: asString(data.error) !== undefined,
        order: index,
      }
      byId.set(id, acc)
    }
    acc.verb = verb
    if (verb === 'start') acc.startedAt = event.time
    if (verb === 'end' || verb === 'error' || verb === 'failed') {
      acc.endedAt = event.time
      if (verb !== 'end') acc.errored = true
    }
    const name = asString(data.name) ?? asString(data.label)
    if (name !== undefined) acc.name = name
    const parent = asString(data.parentSessionId) ?? asString(data.parentId) ?? asString(data.parentSession)
    if (parent !== undefined) acc.parentId = parent
    if (asString(data.error) !== undefined) acc.errored = true
  })

  // Group children under known parents; unknown parents become roots.
  const childrenOf = new Map<string, string[]>()
  const roots: string[] = []
  for (const [id, acc] of byId) {
    if (acc.parentId !== undefined && byId.has(acc.parentId)) {
      const list = childrenOf.get(acc.parentId) ?? []
      list.push(id)
      childrenOf.set(acc.parentId, list)
    } else {
      roots.push(id)
    }
  }
  const byOrder = (a: string, b: string): number => (byId.get(a)?.order ?? 0) - (byId.get(b)?.order ?? 0)
  roots.sort(byOrder)
  for (const list of childrenOf.values()) list.sort(byOrder)

  const rows: SubagentRow[] = []
  const visit = (id: string, ancestorPrefix: string, isLast: boolean, depth: number): void => {
    const acc = byId.get(id)
    if (acc === undefined) return
    const branch = depth === 0 ? '' : `${isLast ? symbols.treeLast : symbols.treeBranch} `
    rows.push({
      id,
      name: acc.name,
      parentId: acc.parentId,
      depth,
      prefix: ancestorPrefix + branch,
      startedAt: acc.startedAt,
      endedAt: acc.endedAt,
      verb: acc.verb,
      errored: acc.errored,
    })
    const children = childrenOf.get(id) ?? []
    const childPrefix = depth === 0
      ? ''
      : ancestorPrefix + (isLast ? '    ' : `${symbols.treeVertical}   `)
    children.forEach((childId, i) => {
      visit(childId, childPrefix, i === children.length - 1, depth + 1)
    })
  }
  roots.forEach((id, i) => {
    visit(id, '', i === roots.length - 1, 0)
  })
  return rows
}

/** Status label and theme token for a folded row. */
function statusOf(row: SubagentRow): { label: string; token: 'error' | 'brand' | 'success' | 'muted' } {
  if (row.errored) return { label: 'error', token: 'error' }
  if (row.endedAt !== undefined) return { label: 'done', token: 'success' }
  if (row.verb === 'start') return { label: 'running', token: 'brand' }
  return { label: row.verb, token: 'muted' }
}

function SubagentRowView({ row }: { row: SubagentRow }): React.ReactElement {
  const status = statusOf(row)
  return (
    <Box>
      <ThemedText token="dim">{row.prefix}</ThemedText>
      <ThemedText token="text" bold={row.depth === 0}>{clip(row.name, 48)}</ThemedText>
      {row.name !== row.id && <ThemedText token="dim"> ({clip(row.id, 24)})</ThemedText>}
      <ThemedText token="dim"> [</ThemedText>
      <ThemedText token={status.token}>{status.label}</ThemedText>
      <ThemedText token="dim">]</ThemedText>
      <ThemedText token="muted"> {formatTime(row.startedAt)}</ThemedText>
      {row.endedAt !== undefined && (
        <ThemedText token="muted">
          {' → '}{formatTime(row.endedAt)}{' '}({formatDuration(row.startedAt, row.endedAt)})
        </ThemedText>
      )}
    </Box>
  )
}

export interface SubagentsScreenProps {
  controller: TuiController
}

/** Read-only subagent tree for the active session; Esc returns to chat. */
export function SubagentsScreen({ controller }: SubagentsScreenProps): React.ReactElement {
  const store = controller.sessionStore
  // Re-render on every event-batch flush so the tree stays live.
  useSyncExternalStore(
    useMemo(() => (store === undefined ? (() => () => {}) : store.subscribe.bind(store)), [store]),
    useMemo(() => (store === undefined ? (() => null) : store.getSnapshot.bind(store)), [store]),
  )

  useInput((_input, key) => {
    if (key.escape) controller.setScreen('chat')
  })

  // session.events is a stable array mutated in place, so filter and fold on
  // every render (store flushes above drive the updates).
  const rows = foldSubagents(
    controller.sessionEvents().filter(event => event.type.startsWith('subagent/')),
  )

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box>
        <ThemedText token="brand" bold>subagents</ThemedText>
        <ThemedText token="muted">
          {'  '}{rows.length} subagent{rows.length === 1 ? '' : 's'} in this session
        </ThemedText>
      </Box>
      <Box>
        <ThemedText token="dim">esc to go back</ThemedText>
      </Box>
      {rows.length === 0 ? (
        <Box marginTop={1}>
          <ThemedText token="muted">no subagents in this session</ThemedText>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {rows.map(row => <SubagentRowView key={row.id} row={row} />)}
        </Box>
      )}
    </Box>
  )
}

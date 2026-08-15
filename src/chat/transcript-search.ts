/**
 * What "search this session" reads, and what a hit looks like: the folded chat
 * nodes flattened into searchable entries, the case-insensitive substring pass
 * over them, and the excerpt/highlight pair a row is drawn from.
 *
 * This terminal renders inline, so the transcript above the prompt belongs to
 * the terminal's own scrollback: nothing here can scroll it, and no hit can be
 * pointed at where it was printed. The search is therefore a panel over the
 * session's messages rather than a jump through the transcript — which makes
 * every rule below a pure function of the node list, shared by the panel and
 * its tests.
 * @module @deepseek-ai/dsh-tui/chat/transcript-search
 */

import type { ChatNode } from '../core/types.ts'
import { t } from '../i18n/index.ts'

/** Which surface an entry was folded from; decides its row's tone and label. */
export type TranscriptEntryRole =
  | 'user'
  | 'assistant'
  | 'tool'
  | 'notice'
  | 'context'
  | 'reference'
  | 'compaction'
  | 'workflow'

/** One searchable message: everything one node contributes, as plain text. */
export interface TranscriptEntry {
  /** The node's own key, so a selection survives a re-filter. */
  readonly key: string
  readonly role: TranscriptEntryRole
  /** The row's left column: `You`, `Assistant`, a tool name, a plugin label. */
  readonly label: string
  /** Log time of the node, for the detail header. */
  readonly time: number
  /** The searchable body, newline separated in reading order. */
  readonly text: string
}

/** One entry the query hit, with the line the panel shows for it. */
export interface TranscriptMatch {
  readonly entry: TranscriptEntry
  /** The first hit line, windowed so the hit itself is inside the excerpt. */
  readonly excerpt: string
  /** How many of the entry's lines the query hits; 0 for an empty query. */
  readonly hitLines: number
}

/** One run of an excerpt, split at the query's occurrences. */
export interface HighlightSegment {
  readonly text: string
  /** Whether this run is the query itself, which the panel paints. */
  readonly hit: boolean
}

/**
 * The row label for a role that does not carry one of its own.
 *
 * Read through {@link t} per call rather than held in a module-level table: a
 * table built at import time would freeze the locale the module was first
 * loaded under, and `/lang` would leave these labels behind in English.
 * @param role - the entry's origin.
 * @returns the label in the active locale.
 */
function roleLabel(role: TranscriptEntryRole): string {
  return t(`search.role.${role}`)
}

/** Characters an excerpt keeps; a row is truncated to the panel's width anyway. */
const EXCERPT_MAX = 160

/** Characters kept before the hit when the line is windowed, for context. */
const EXCERPT_LEAD = 24

/**
 * Cut text to a budget, marking the cut.
 * @param text - the text to clip.
 * @param max - characters the result may occupy, ellipsis included.
 * @returns the text, or its head with a trailing ellipsis.
 */
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`
}

/**
 * A tool call's one-line detail, derived from its arguments alone.
 *
 * The transcript's own header summary comes from the tool's presenter, which
 * needs the tool definition and the registry that owns it. A search runs over a
 * folded snapshot with neither, so it reads the arguments directly: the scalar
 * fields, in the order the model wrote them, which is where a command, a path,
 * or a pattern actually is.
 * @param args - the node's parsed arguments.
 * @returns the summary, or the empty string when nothing scalar survives.
 */
function toolArgumentsSummary(args: { value: unknown; valid: boolean }): string {
  if (!args.valid) return typeof args.value === 'string' ? args.value : ''
  const value = args.value
  if (value === null || typeof value !== 'object') return value === undefined ? '' : String(value)
  return Object.entries(value as Record<string, unknown>)
    .filter(([, field]) => typeof field === 'string' || typeof field === 'number' || typeof field === 'boolean')
    .map(([name, field]) => `${name}: ${String(field)}`)
    .join(' · ')
}

/**
 * The searchable text one node contributes, or `undefined` when it has none.
 * @param node - one folded chat node.
 * @returns the entry's role, label, and body.
 */
function entryOf(node: ChatNode): Pick<TranscriptEntry, 'role' | 'label' | 'text'> | undefined {
  switch (node.kind) {
    case 'user-message':
      // A withdrawn echo is a message the model will never see; it renders
      // nothing in the transcript, so it is not in this session's messages.
      return node.withdrawn === true ? undefined : { role: 'user', label: roleLabel('user'), text: node.text }
    case 'assistant':
      // Text only: reasoning is an aside the transcript recesses, and folding it
      // in would return hits for words the answer never said.
      return { role: 'assistant', label: roleLabel('assistant'), text: node.text }
    case 'tool-call': {
      const summary = toolArgumentsSummary(node.args)
      const header = summary === '' ? node.name : `${node.name}(${summary})`
      // The result is part of the card on screen, so it is part of what a user
      // means by "find where that error was".
      const result = node.result?.text ?? ''
      return { role: 'tool', label: node.name, text: result === '' ? header : `${header}\n${result}` }
    }
    case 'notice':
      return { role: 'notice', label: roleLabel('notice'), text: node.text }
    case 'context':
      return { role: 'context', label: node.label, text: node.text }
    case 'reference':
      return { role: 'reference', label: roleLabel('reference'), text: node.labels.join('\n') }
    case 'compaction':
      return node.landed ? { role: 'compaction', label: roleLabel('compaction'), text: node.summary } : undefined
    case 'workflow-run':
      // The run's name and its members' labels are the whole of what its rows
      // say in words; the statuses and durations are derived at render time and
      // change while the search panel is open, so they are not searchable text.
      return {
        role: 'workflow',
        label: roleLabel('workflow'),
        text: [node.name, ...node.members.map(member => member.label)].join('\n'),
      }
    default:
      // The plan snapshot is a node the transcript never places a row for.
      return undefined
  }
}

/**
 * Flatten a snapshot's nodes into the entries a search runs over.
 *
 * Order is the transcript's own, and an entry with nothing to read is dropped:
 * a row that matched on emptiness would open a panel page with nothing on it.
 * @param nodes - the store snapshot's nodes, in log order.
 * @returns one entry per readable node.
 */
export function transcriptEntries(nodes: readonly ChatNode[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = []
  for (const node of nodes) {
    const entry = entryOf(node)
    if (entry === undefined || entry.text.trim() === '') continue
    entries.push({ key: node.key, time: node.time, ...entry })
  }
  return entries
}

/**
 * The lower-case form used for matching, and whether it may be sliced by index.
 *
 * Case folding can change a string's length (`İ` lowers to two code units), and
 * an index taken from the folded text would then cut the original in the wrong
 * place. Where that happens the search stays case-sensitive for that text rather
 * than reporting a highlight that lands on the wrong characters.
 * @param text - the text to fold.
 * @returns the searchable form, or the original when folding is not index-safe.
 */
function foldCase(text: string): string {
  const lowered = text.toLocaleLowerCase()
  return lowered.length === text.length ? lowered : text
}

/**
 * The excerpt shown for one hit line: trimmed, and windowed when the hit sits
 * past the point a row can show.
 * @param line - the matching line, as folded.
 * @param needle - the query, already case-folded; empty for "no query".
 * @returns a single line, at most {@link EXCERPT_MAX} characters.
 */
function excerptFor(line: string, needle: string): string {
  const trimmed = line.trim()
  if (needle === '') return clip(trimmed, EXCERPT_MAX)
  const index = foldCase(trimmed).indexOf(needle)
  if (index <= EXCERPT_LEAD) return clip(trimmed, EXCERPT_MAX)
  // The leading ellipsis is what tells the reader the row starts mid-line.
  return `…${clip(trimmed.slice(index - EXCERPT_LEAD), EXCERPT_MAX - 1)}`
}

/**
 * Every entry the query hits, in transcript order.
 *
 * The test is a case-insensitive substring, the same one the `/plugins` filter
 * and the model picker use: a fuzzy match would return rows whose relation to
 * what was typed the user cannot see, and this panel's whole job is to show it.
 * An empty query matches everything, so the panel opens on the session rather
 * than on an empty page.
 * @param entries - the flattened transcript.
 * @param query - what the user typed, verbatim.
 * @returns one match per hit entry.
 */
export function searchTranscript(
  entries: readonly TranscriptEntry[],
  query: string,
): TranscriptMatch[] {
  const needle = foldCase(query)
  const matches: TranscriptMatch[] = []
  for (const entry of entries) {
    const lines = entry.text.split('\n')
    if (needle === '') {
      const lead = lines.find(line => line.trim() !== '') ?? ''
      matches.push({ entry, excerpt: excerptFor(lead, ''), hitLines: 0 })
      continue
    }
    let first: string | undefined
    let hitLines = 0
    for (const line of lines) {
      if (!foldCase(line).includes(needle)) continue
      hitLines += 1
      first ??= line
    }
    if (first === undefined) continue
    matches.push({ entry, excerpt: excerptFor(first, needle), hitLines })
  }
  return matches
}

/**
 * Split one line at the query's occurrences, so the panel can paint them.
 *
 * The segments carry the original text, not the folded one: a highlight that
 * lower-cased what it drew would rewrite the message under the reader's eyes.
 * @param text - the line to split.
 * @param query - what the user typed, verbatim.
 * @returns the runs in order; empty for empty text.
 */
export function highlightSegments(text: string, query: string): HighlightSegment[] {
  if (text === '') return []
  const needle = foldCase(query)
  if (needle === '') return [{ text, hit: false }]
  const haystack = foldCase(text)
  const segments: HighlightSegment[] = []
  let cursor = 0
  for (;;) {
    const index = haystack.indexOf(needle, cursor)
    if (index === -1) break
    if (index > cursor) segments.push({ text: text.slice(cursor, index), hit: false })
    segments.push({ text: text.slice(index, index + needle.length), hit: true })
    cursor = index + needle.length
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), hit: false })
  return segments
}

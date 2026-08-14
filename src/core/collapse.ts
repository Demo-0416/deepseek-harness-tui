/**
 * Read/search collapse: the classification and grouping behind the transcript's
 * one-row summary of a run of read-only calls (`Searched for 3 patterns, read
 * 2 files`), ported from Claude Code's `utils/collapseReadSearch.ts`.
 *
 * Everything here is a pure function of the folded node list — no clock, no
 * `process`, no service lookup — for the same reason `foldEvent` is: a resumed
 * log and a live stream have to produce the same rows. It is a *derivation*
 * over the fold's output rather than a step inside it, because group membership
 * is retroactive: the call that breaks a group arrives after the group's own
 * nodes are folded, and the calls a group absorbs keep arriving while it runs.
 * Rewriting the node array to hold an aggregate node would therefore have to
 * delete and re-key nodes as events land, and the node array's indices are
 * anchors elsewhere (the `/clear` cut, the process-local rows the reconciler
 * interleaves by node count). The upstream does exactly the same thing:
 * `collapseReadSearchGroups(messages, tools)` runs at render time over the
 * message list, not at message-construction time.
 *
 * The renderer asks {@link collapseToolGroups} for the group plan and looks up
 * each node index in it; `collapsedSummary`, in the transcript component, words
 * the row. The wording lives there rather than here because it is the only
 * locale-dependent part of collapse: this module stays a pure derivation over
 * the node list, with no message table behind it, exactly like the rest of
 * `src/core`.
 * @module dsh-tui/core/collapse
 */

import type { ChatNode, ToolCallNode } from './types.ts'

/**
 * Cap on a `⎿` hint, in characters (~5 rows of ~60 columns). Generous and
 * static, exactly as upstream: the renderer wraps what fits.
 */
export const MAX_HINT_CHARS = 300

/** Shell words that make a command a search (upstream's `BASH_SEARCH_COMMANDS`). */
const BASH_SEARCH_COMMANDS = new Set(['find', 'grep', 'rg', 'ag', 'ack', 'locate', 'which', 'whereis'])

/**
 * Shell words that make a command a read: the viewers, the analysers, and the
 * text processors a pipeline uses to pick a file apart.
 */
const BASH_READ_COMMANDS = new Set([
  'cat', 'head', 'tail', 'less', 'more',
  // Analysis commands.
  'wc', 'stat', 'file', 'strings',
  // Data processing — commonly used to parse/transform file content in pipes.
  'jq', 'awk', 'cut', 'sort', 'uniq', 'tr',
])

/**
 * Shell words that list a directory. Split from {@link BASH_READ_COMMANDS} so
 * the summary says `Listed 2 directories` rather than the false `Read 2 files`.
 */
const BASH_LIST_COMMANDS = new Set(['ls', 'tree', 'du'])

/**
 * Shell words that are semantically neutral in any position: pure output or
 * status, so they do not change what a pipeline is. `ls src && echo --- && ls
 * tests` is still a listing.
 */
const BASH_NEUTRAL_COMMANDS = new Set(['echo', 'printf', 'true', 'false', ':'])

/** Operator tokens whose right-hand side is a redirect target, not a command. */
const REDIRECT_OPERATORS = new Set(['>', '>>', '>&', '2>', '2>>', '<'])

/** Operator tokens that merely separate commands. */
const SEPARATOR_OPERATORS = new Set(['|', '||', '&&', ';', '&'])

/** The prefix an MCP tool name carries: `mcp__<server>__<raw>`. */
const MCP_PREFIX = 'mcp__'

/**
 * Leading verbs that make an MCP tool a query.
 *
 * Upstream keys this off a 600-entry allowlist of tool names it has seen; a
 * port cannot keep that list current, so this reads the tool's own verb
 * instead. It stays conservative in the same direction — an unrecognised verb
 * (`send_message`, `create_issue`, `update_page`) is not read-only and breaks
 * the group, which is what matters.
 */
const MCP_READ_VERBS = new Set([
  'search', 'find', 'get', 'list', 'read', 'fetch', 'query',
  'describe', 'view', 'lookup', 'browse', 'inspect', 'show',
])

/** One kind of read-only operation a collapsed group counts. */
export type CollapseKind = 'search' | 'read' | 'list' | 'mcp'

/** The last operation in a group, as the `⎿` row wants to show it. */
export interface CollapseHint {
  /** A file path (shown relative to the workspace), a pattern, or a command. */
  readonly kind: 'path' | 'pattern' | 'command'
  readonly value: string
}

/** One tool call's read-only classification, or `undefined` when it writes. */
export interface CollapseClassification {
  readonly kind: CollapseKind
  /** The MCP server this call went to, when `kind` is `mcp`. */
  readonly server?: string
  /** File path this call read, when it names one. */
  readonly path?: string
  /** What the `⎿` row shows for this call. */
  readonly hint?: CollapseHint
}

/** One run of consecutive read-only calls, as the collapsed row reports it. */
export interface CollapsedGroup {
  /** Node index of the first member: where the summary row renders. */
  readonly index: number
  /** Node keys of every member, in log order (the expanded phase's cards). */
  readonly keys: readonly string[]
  /** Search operations, counted per call. */
  readonly searchCount: number
  /**
   * Files read: distinct `file_path`s when any call named one, else the number
   * of path-less read operations (a `cat` in a shell command). Never the sum —
   * `read(a.ts)` then `wc -l a.ts` is one file, not two.
   */
  readonly readCount: number
  /** Directory listings, counted per call. */
  readonly listCount: number
  /** MCP queries, counted per call. */
  readonly mcpCallCount: number
  /** Distinct MCP servers queried, in first-seen order. */
  readonly mcpServers: readonly string[]
  /** Whether any member call is still running: the row is present-tense. */
  readonly active: boolean
  /** Whether any member call failed. */
  readonly failed: boolean
  /** The most recent operation, for the `⎿` row under a running group. */
  readonly hint?: CollapseHint
}

/**
 * Split a shell command into command segments and the operator tokens between
 * them, the way upstream's `splitCommandWithOperators` does — enough structure
 * to read each segment's leading word and to skip redirect targets.
 *
 * Quoting is honoured so `grep "a | b" file` stays one segment. An unbalanced
 * quote is unparseable, and an unparseable command is not read-only.
 * @param command - The raw command line.
 * @returns Segments and operators in order, or `undefined` when unparseable.
 */
function splitCommandWithOperators(command: string): string[] | undefined {
  const parts: string[] = []
  let current = ''
  let quote: string | undefined
  let index = 0
  const flush = (): void => {
    const trimmed = current.trim()
    if (trimmed !== '') parts.push(trimmed)
    current = ''
  }
  while (index < command.length) {
    const char = command[index] as string
    if (quote !== undefined) {
      current += char
      if (char === quote) quote = undefined
      index += 1
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      current += char
      index += 1
      continue
    }
    if (char === '\\' && index + 1 < command.length) {
      current += char + (command[index + 1] as string)
      index += 2
      continue
    }
    const pair = command.slice(index, index + 2)
    if (pair === '||' || pair === '&&' || pair === '>>' || pair === '>&' || pair === '2>') {
      flush()
      parts.push(pair)
      index += 2
      continue
    }
    if (char === '|' || char === ';' || char === '&' || char === '>' || char === '<' || char === '\n') {
      flush()
      parts.push(char)
      index += 1
      continue
    }
    current += char
    index += 1
  }
  if (quote !== undefined) return undefined
  flush()
  return parts
}

/**
 * Classify a shell command as search, read, or listing.
 *
 * Every non-neutral segment of a pipeline has to be one of the three: `cat
 * file | jq .` is a read, `cat file > out` is not (the redirect target is
 * skipped, but a segment that writes anywhere else disqualifies the whole
 * command). A command of nothing but neutral words (`echo hi`) is not
 * collapsible either — it read nothing.
 * @param command - The raw command line.
 * @returns Which of the three kinds the command performs, all false when none.
 */
export function classifyShellCommand(command: string): {
  isSearch: boolean
  isRead: boolean
  isList: boolean
} {
  const none = { isSearch: false, isRead: false, isList: false }
  const parts = splitCommandWithOperators(command)
  if (parts === undefined || parts.length === 0) return none
  let hasSearch = false
  let hasRead = false
  let hasList = false
  let hasCommand = false
  let skipRedirectTarget = false
  for (const part of parts) {
    if (skipRedirectTarget) {
      skipRedirectTarget = false
      continue
    }
    if (REDIRECT_OPERATORS.has(part)) {
      skipRedirectTarget = true
      continue
    }
    if (SEPARATOR_OPERATORS.has(part)) continue
    const base = part.split(/\s+/)[0]
    if (base === undefined || base === '') continue
    if (BASH_NEUTRAL_COMMANDS.has(base)) continue
    hasCommand = true
    const isSearch = BASH_SEARCH_COMMANDS.has(base)
    const isRead = BASH_READ_COMMANDS.has(base)
    const isList = BASH_LIST_COMMANDS.has(base)
    if (!isSearch && !isRead && !isList) return none
    if (isSearch) hasSearch = true
    if (isRead) hasRead = true
    if (isList) hasList = true
  }
  if (!hasCommand) return none
  return { isSearch: hasSearch, isRead: hasRead, isList: hasList }
}

/**
 * Compact a command for the `⎿` row: blank lines dropped, runs of inline
 * whitespace squeezed, newlines kept so the renderer can indent continuations.
 * @param command - The raw command line.
 * @returns The compacted command, without its `$ ` lead-in.
 */
function compactCommand(command: string): string {
  return command
    .split('\n')
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(line => line !== '')
    .join('\n')
}

/** Read one string field off a tool call's parsed arguments. */
function argString(args: unknown, key: string): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const value = (args as Record<string, unknown>)[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * The MCP server one tool name names, or `undefined` when it is not an MCP
 * tool. `mcp__<server>__<raw>` is the registry's own qualified form.
 */
function mcpParts(name: string): { server: string; raw: string } | undefined {
  if (!name.startsWith(MCP_PREFIX)) return undefined
  const rest = name.slice(MCP_PREFIX.length)
  const separator = rest.indexOf('__')
  if (separator <= 0) return undefined
  return { server: rest.slice(0, separator), raw: rest.slice(separator + 2) }
}

/** Whether an MCP tool's own name reads as a query rather than a mutation. */
function isMcpQuery(raw: string): boolean {
  const verb = raw
    .replace(/([a-z\d])([A-Z])/g, '$1_$2')
    .replace(/-/g, '_')
    .toLowerCase()
    .split('_')
    .filter(part => part !== '')
  // A server that namespaces its tools (`slack_search_public`) puts the verb
  // second; one that does not (`search_files`) puts it first.
  return verb.slice(0, 2).some(part => MCP_READ_VERBS.has(part))
}

/**
 * Classify one tool call as a read-only operation.
 *
 * The tool set is this harness's own: `read`/`read_image` read, `grep`/`glob`
 * search, `str_replace_editor` reads only under its `view` command, and
 * `bash`/`pwsh` are whatever their command line says they are. Everything else
 * — edits, writes, web calls, task tools — is not collapsible and breaks the
 * group it lands in.
 * @param name - The tool's registered name.
 * @param args - The call's parsed arguments.
 * @returns The classification, or `undefined` when the call is not read-only.
 */
export function classifyToolCall(name: string, args: unknown): CollapseClassification | undefined {
  const mcp = mcpParts(name)
  if (mcp !== undefined) {
    if (!isMcpQuery(mcp.raw)) return undefined
    const query = argString(args, 'query') ?? argString(args, 'pattern')
    return {
      kind: 'mcp',
      server: mcp.server,
      ...query === undefined ? {} : { hint: { kind: 'pattern', value: query } as const },
    }
  }
  switch (name) {
    case 'read':
    case 'read_image': {
      const path = argString(args, 'file_path')
      return {
        kind: 'read',
        ...path === undefined ? {} : { path, hint: { kind: 'path', value: path } as const },
      }
    }
    case 'grep':
    case 'glob': {
      const pattern = argString(args, 'pattern')
      return {
        kind: 'search',
        ...pattern === undefined ? {} : { hint: { kind: 'pattern', value: pattern } as const },
      }
    }
    case 'str_replace_editor': {
      // The editor is one tool with four commands; only `view` reads.
      if (argString(args, 'command') !== 'view') return undefined
      const path = argString(args, 'path')
      return {
        kind: 'read',
        ...path === undefined ? {} : { path, hint: { kind: 'path', value: path } as const },
      }
    }
    case 'bash':
    case 'pwsh': {
      const command = argString(args, 'command')
      if (command === undefined) return undefined
      const { isSearch, isRead, isList } = classifyShellCommand(command)
      if (!isSearch && !isRead && !isList) return undefined
      // A command that does more than one of the three is named by the widest
      // claim it makes, in the order upstream reports them.
      const kind: CollapseKind = isSearch ? 'search' : isList && !isRead ? 'list' : 'read'
      return { kind, hint: { kind: 'command', value: compactCommand(command) } }
    }
    default:
      return undefined
  }
}

/** A group under construction, before it is frozen into a {@link CollapsedGroup}. */
interface GroupDraft {
  index: number
  keys: string[]
  searchCount: number
  readPaths: Set<string>
  readOperations: number
  listCount: number
  mcpCallCount: number
  mcpServers: string[]
  active: boolean
  failed: boolean
  hint: CollapseHint | undefined
}

/** Freeze a draft into the group the renderer reads. */
function sealGroup(draft: GroupDraft): CollapsedGroup {
  return {
    index: draft.index,
    keys: draft.keys,
    searchCount: draft.searchCount,
    // Distinct paths win outright: a file read twice is one file, and mixing
    // the path-less fallback in on top would count it a second time.
    readCount: draft.readPaths.size > 0 ? draft.readPaths.size : draft.readOperations,
    listCount: draft.listCount,
    mcpCallCount: draft.mcpCallCount,
    mcpServers: draft.mcpServers,
    active: draft.active,
    failed: draft.failed,
    ...draft.hint === undefined ? {} : { hint: draft.hint },
  }
}

/**
 * Whether a node ends the run of read-only calls above it.
 *
 * Assistant prose and a non-read-only call are the two breaks upstream keeps: a
 * sentence the model wrote, or work that changed something, is where one
 * stretch of looking around ends. A new prompt and a compaction boundary break
 * it here as well, because both are the conversation moving on. Everything else
 * (thinking with no text, an injected context card, a notice, the plan) is
 * carried over the group rather than ending it.
 */
function breaksGroup(node: ChatNode): boolean {
  switch (node.kind) {
    case 'assistant':
      return node.text.trim() !== ''
    case 'user-message':
      return node.withdrawn !== true
    case 'compaction':
      return node.landed
    case 'reference':
      return true
    default:
      return false
  }
}

/** Options narrowing which nodes {@link collapseToolGroups} may absorb. */
export interface CollapseOptions {
  /** First node index to consider; earlier nodes are off the transcript. */
  readonly from?: number
  /** Reports a call the transcript is not rendering (a `/clear`ed step's). */
  readonly isHidden?: (callId: string) => boolean
}

/**
 * Plan the collapsed groups over a folded node list.
 *
 * @param nodes - The snapshot's nodes, in log order.
 * @param options - Range and per-call exclusions.
 * @returns A map from node index to the group that index belongs to. Every
 *   member index maps to the same object, whose `index` names the member the
 *   summary row replaces.
 */
export function collapseToolGroups(
  nodes: readonly ChatNode[],
  options: CollapseOptions = {},
): Map<number, CollapsedGroup> {
  const groups = new Map<number, CollapsedGroup>()
  const from = options.from ?? 0
  let draft: GroupDraft | undefined
  let members: number[] = []
  const flush = (): void => {
    if (draft !== undefined) {
      const group = sealGroup(draft)
      for (const index of members) groups.set(index, group)
    }
    draft = undefined
    members = []
  }
  for (let index = Math.max(0, from); index < nodes.length; index += 1) {
    const node = nodes[index]
    /* v8 ignore next -- the loop bound keeps the index inside the array. */
    if (node === undefined) continue
    if (node.kind === 'tool-call') {
      // An incomplete call has no arguments to classify yet and renders no
      // card, so it neither joins the group nor ends it.
      if (!node.argsComplete) continue
      if (options.isHidden?.(node.callId) === true) continue
      const classification = classifyToolCall(node.name, node.args.value)
      if (classification === undefined) {
        flush()
        continue
      }
      draft ??= {
        index,
        keys: [],
        searchCount: 0,
        readPaths: new Set(),
        readOperations: 0,
        listCount: 0,
        mcpCallCount: 0,
        mcpServers: [],
        active: false,
        failed: false,
        hint: undefined,
      }
      absorb(draft, node, classification)
      members.push(index)
      continue
    }
    if (breaksGroup(node)) flush()
  }
  flush()
  return groups
}

/** Fold one classified call into the group it joins. */
function absorb(draft: GroupDraft, node: ToolCallNode, classification: CollapseClassification): void {
  draft.keys.push(node.key)
  if (node.status === 'running') draft.active = true
  if (node.status === 'error') draft.failed = true
  switch (classification.kind) {
    case 'search':
      draft.searchCount += 1
      break
    case 'list':
      draft.listCount += 1
      break
    case 'mcp':
      draft.mcpCallCount += 1
      if (classification.server !== undefined && !draft.mcpServers.includes(classification.server)) {
        draft.mcpServers.push(classification.server)
      }
      break
    default:
      if (classification.path !== undefined) draft.readPaths.add(classification.path)
      // A read with no path of its own (a shell `cat`) is counted as an
      // operation, and only ever consulted when no call named a path.
      else draft.readOperations += 1
      break
  }
  if (classification.hint !== undefined) draft.hint = classification.hint
}

/**
 * Render a group's `⎿` hint: the file's workspace-relative path, the quoted
 * pattern, or the `$ `-prefixed command, capped at {@link MAX_HINT_CHARS}.
 * @param hint - The group's latest operation.
 * @param displayPath - Shortens an absolute path for display.
 * @returns The hint row's text.
 */
export function formatCollapseHint(hint: CollapseHint, displayPath: (path: string) => string): string {
  const text = hint.kind === 'path'
    ? displayPath(hint.value)
    : hint.kind === 'pattern' ? `"${hint.value}"` : `$ ${hint.value}`
  return text.length > MAX_HINT_CHARS ? `${text.slice(0, MAX_HINT_CHARS - 1)}…` : text
}

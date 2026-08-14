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
 *
 * ## Thinking is part of the group
 *
 * A run of calls opens with the model thinking about what to look at, so the
 * group absorbs that thinking and reports it as its own first fragment
 * (`Thought for 8s, searched for 3 patterns, read 2 files`). The fold measures
 * the span ({@link ChatNode} → `AssistantNode.thinkingMs`/`thinkingSince`) and
 * this module attributes it to the run it is *adjacent* to: the run still open
 * above the step, or — when no run is open — the run the step goes on to open.
 *
 * Adjacency rather than "forward, always" because attribution has to hold still
 * while the step streams. A step that thinks and then writes prose starts out
 * indistinguishable from a step that thinks and then calls a tool (its text is
 * empty either way), so a rule that reads the finished step would move the
 * thinking off the row that had already been counting it up: the user watches
 * `Thinking for 12s, read 2 files…` become `Read 2 files` the moment the answer
 * starts arriving. The row a duration appeared on is the row that keeps it.
 *
 * That leaves three timing surfaces in the transcript, and they do not overlap:
 *
 * - **This row** — the thinking behind one run of read-only calls, on the
 *   collapsed phase of the Ctrl+O cycle. It is the only place a default
 *   transcript states a thinking duration at all, which is why the thinking
 *   *block* itself needs no timer and keeps its own rule: it disappears when
 *   the step finishes (Ctrl+T pins it, Ctrl+O expanded brings it back).
 * - **The per-step timing footer** — every bucket of one step, `Thinking` among
 *   them, on the expanded phase only. It never shares a screen with this row,
 *   because expanded shows the group's own cards instead of the row.
 * - **The turn footer** (`✻ Worked for 45s`, over 30 s only) — the whole turn's
 *   wall time, on every phase. Different quantity, not a second opinion on this
 *   one: a turn contains the thinking, the calls, and the gaps between them.
 * @module dsh-tui/core/collapse
 */

import type { AssistantNode, ChatNode, ToolCallNode } from './types.ts'

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
const REDIRECT_OPERATORS = new Set(['>', '>>', '>&', '2>', '2>>', '2>&', '<'])

/**
 * The redirects that put bytes somewhere. A command carrying one of these is
 * not read-only, whatever its verb says — `cat a > b` writes `b`.
 */
const WRITE_REDIRECT_OPERATORS = new Set(['>', '>>', '>&', '2>', '2>>', '2>&'])

/** The redirects whose target may be a file descriptor rather than a path. */
const FD_DUP_OPERATORS = new Set(['>&', '2>&'])

/** The sink that is not a file: writing here loses the bytes on purpose. */
const NULL_DEVICE = '/dev/null'

/**
 * `find` predicates that act on what they match. `find` is otherwise the
 * archetypal read-only search, which is exactly what makes `-delete` worth
 * naming: it turns the same command into a bulk removal.
 */
const FIND_MUTATING_FLAGS = new Set(['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprintf'])

/**
 * Shell syntax that runs a second command this classifier never sees.
 *
 * `cat $(rm -rf build)`, ``cat `rm -rf build` `` and `cat <(rm x)` all read as
 * a bare `cat` once split into segments, because the inner command is an
 * argument, a quoted-looking word, or a redirect target rather than a segment
 * of its own. Nothing here parses those, and a command this module cannot parse
 * is not read-only — the same stance {@link splitCommandWithOperators} already
 * takes for an unbalanced quote.
 */
const COMMAND_SUBSTITUTION = /\$\(|`|<\(/u

/**
 * Whether a whitelisted verb writes a file through its own arguments rather
 * than through a shell redirect.
 *
 * `sort` and `uniq` are in {@link BASH_READ_COMMANDS} because a pipeline uses
 * them to pick text apart, but both also take an output path — `sort -o out in`
 * truncates `out`, and `uniq in out` writes `out`. Neither carries a redirect,
 * so the redirect analysis never sees them, and the write folds into the
 * transcript's `Read 1 file` row with no card behind it.
 * @param base - The segment's leading word.
 * @param words - Every whitespace-separated word of the segment, `base` first.
 * @returns Whether this invocation writes a file through its arguments.
 */
function writesThroughArguments(base: string, words: readonly string[]): boolean {
  const args = words.slice(1)
  if (base === 'sort') {
    // `-o out`, `--output out`, `--output=out`, and the short-flag clusters
    // that end in `o` (`sort -no out`) all name an output path.
    return args.some(word => word.startsWith('--output') || /^-[a-zA-Z]*o$/u.test(word))
  }
  if (base === 'uniq') {
    // `uniq [OPTION]... [INPUT [OUTPUT]]`: a second operand is the output file.
    // The three options that take a value are skipped so their value is not
    // miscounted as an operand.
    const valued = new Set(['-f', '-s', '-w', '--skip-fields', '--skip-chars', '--check-chars'])
    let operands = 0
    for (let index = 0; index < args.length; index += 1) {
      const word = args[index] as string
      if (valued.has(word)) {
        index += 1
        continue
      }
      if (word.startsWith('-') && word !== '-') continue
      operands += 1
    }
    return operands >= 2
  }
  return false
}

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

/**
 * Leading verbs that make an MCP tool a mutation, whatever its object is.
 *
 * The two-token window below exists for servers that namespace their tools
 * (`slack_search_public`), and it is what let `delete_search_index`,
 * `create_search_filter` and `save_search` read as queries: their object
 * happens to be a query. A first token in this set settles the question before
 * the window is consulted.
 */
const MCP_WRITE_VERBS = new Set([
  'create', 'update', 'delete', 'remove', 'write', 'set', 'add', 'send',
  'post', 'patch', 'save', 'clear', 'drop', 'move', 'rename', 'upload',
  'insert', 'edit', 'append', 'archive', 'close', 'cancel', 'run', 'execute',
])

/** One kind of read-only operation a collapsed group counts. */
export type CollapseKind = 'search' | 'read' | 'list' | 'mcp'

/** The last operation in a group, as the `⎿` row wants to show it. */
export interface CollapseHint {
  /**
   * A file path (shown relative to the workspace), a pattern, a command, or —
   * only until the group's first operation names one of those — the latest line
   * of the thinking that led to the group.
   */
  readonly kind: 'path' | 'pattern' | 'command' | 'thinking'
  readonly value: string
}

/**
 * The thinking one step contributes to the group it leads to: what the fold has
 * already measured, the open span it has not, and the line to show while that
 * span is the newest thing that happened.
 */
interface ThinkingSpan {
  /** Closed thinking time, in milliseconds. */
  readonly ms: number
  /** Log time of the open span, when the step is thinking right now. */
  readonly since: number | undefined
  /** Latest line of the thinking text, whitespace squeezed. */
  readonly line: string | undefined
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
  /**
   * Node index of the **last** member: where the summary row renders.
   *
   * The last rather than the first, because a group carries non-breaking nodes
   * over itself (a notice, a process-local row anchored mid-run) and those
   * render at their own index. A row at the first member's index therefore
   * printed `Read 2 files` *above* the notice that arrived between the two
   * reads, claiming both files before the second one happened. At the last
   * member's index the summary can never precede content it already counts.
   */
  readonly index: number
  /** Node keys of every member, in log order (the expanded phase's cards). */
  readonly keys: readonly string[]
  /** Search operations, counted per call. */
  readonly searchCount: number
  /**
   * Files read: distinct `file_path`s, plus one per read that named no path of
   * its own (a `cat` inside a shell command). The same file read twice through
   * `read` counts once; a shell read counts as one more, because nothing here
   * knows which file it opened. Over- rather than under-reporting is the
   * deliberate direction — the previous rule dropped path-less reads entirely
   * whenever any call named a path, so `read(a)` + `cat b` + `read(c)` said
   * "Read 2 files" about three.
   */
  readonly readCount: number
  /** Directory listings, counted per call. */
  readonly listCount: number
  /** MCP queries, counted per call. */
  readonly mcpCallCount: number
  /** Distinct MCP servers queried, in first-seen order. */
  readonly mcpServers: readonly string[]
  /**
   * Thinking time the group absorbed: every closed reasoning span of the steps
   * adjacent to this run of calls, summed.
   *
   * A step that thought while this run was still open adds to it, whatever the
   * step goes on to do — another read, or the sentence that ends the run. A
   * step that thought with no run open belongs to the run it opens next, which
   * is the shape a turn starts with (think, then go looking).
   *
   * The open span is not in here — see {@link CollapsedGroup.thinkingSince} —
   * so a caller that wants the live total asks {@link groupThinkingMs}.
   */
  readonly thinkingMs: number
  /**
   * Log time of the group's open thinking span, when the model is thinking
   * right now. Present is what makes the row read as in progress even after
   * every call it counts has settled.
   */
  readonly thinkingSince?: number
  /**
   * Whether any member call is still running.
   *
   * Kept apart from {@link CollapsedGroup.active} because it is what the
   * *counts* agree with: a group whose calls have all landed read 2 files, and
   * says so in the past tense, even while the model thinks about what it found.
   */
  readonly running: boolean
  /**
   * Whether the group is still in progress: any member call running, or the
   * thinking it absorbed still open. The row keeps its bullet and its ellipsis
   * while it is, because something in it is still going.
   */
  readonly active: boolean
  /** Whether any member call failed. */
  readonly failed: boolean
  /** The most recent operation, for the `⎿` row under a running group. */
  readonly hint?: CollapseHint
}

/**
 * A group's thinking time at render clock `now`: what the fold measured plus
 * whatever the open span has run since it opened.
 *
 * The clock is the caller's because this module holds none — the same reason
 * the fold publishes a span's start rather than its length. Called without one
 * (a settled row, a test), it reports the closed total alone.
 * @param group - The planned group.
 * @param now - Render clock, in epoch milliseconds.
 * @returns Thinking time in milliseconds.
 */
export function groupThinkingMs(group: CollapsedGroup, now?: number): number {
  const open = group.thinkingSince === undefined || now === undefined
    ? 0
    : Math.max(0, now - group.thinkingSince)
  return group.thinkingMs + open
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
    // Three characters first, or `2>&1` splits into `2>` + `&` + `1` and the
    // `1` reads as a command name — which used to disqualify every `rg … 2>&1`.
    const triple = command.slice(index, index + 3)
    if (triple === '2>>' || triple === '2>&') {
      flush()
      parts.push(triple)
      index += 3
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
 * file | jq .` is a read, and `cat file > out` is not a read at all — it is a
 * write, so the whole command is disqualified. A redirect is judged by where it
 * points rather than skipped: `< in` only names an input, `2>&1` and `2>` to
 * {@link NULL_DEVICE} throw bytes away, and everything else creates or
 * truncates a file the user would want to see reported. Skipping the target
 * instead — which is what this did — folded a real file write into the
 * transcript's `Read 1 file` row, with no card and no command text behind it.
 *
 * The same reasoning disqualifies a command that runs another one out of this
 * classifier's sight ({@link COMMAND_SUBSTITUTION}) or writes through an
 * argument instead of a redirect ({@link writesThroughArguments}): the leading
 * word says `cat`, and the line still deletes a tree or truncates a file.
 *
 * A command of nothing but neutral words (`echo hi`) is not collapsible either
 * — it read nothing.
 * @param command - The raw command line.
 * @returns Which of the three kinds the command performs, all false when none.
 */
export function classifyShellCommand(command: string): {
  isSearch: boolean
  isRead: boolean
  isList: boolean
} {
  const none = { isSearch: false, isRead: false, isList: false }
  // Checked on the raw line rather than per segment: a substitution can sit
  // inside a quoted word, which never becomes a segment of its own.
  if (COMMAND_SUBSTITUTION.test(command)) return none
  const parts = splitCommandWithOperators(command)
  if (parts === undefined || parts.length === 0) return none
  let hasSearch = false
  let hasRead = false
  let hasList = false
  let hasCommand = false
  let redirect: string | undefined
  for (const part of parts) {
    if (redirect !== undefined) {
      const operator = redirect
      redirect = undefined
      if (!WRITE_REDIRECT_OPERATORS.has(operator)) continue
      const target = part.split(/\s+/)[0] ?? ''
      // `2>&1` names a descriptor, not a file, and `/dev/null` is the bit
      // bucket: neither leaves anything behind for the user to have missed.
      if (FD_DUP_OPERATORS.has(operator) && /^\d+-?$/u.test(target)) continue
      if (target === NULL_DEVICE) continue
      return none
    }
    if (REDIRECT_OPERATORS.has(part)) {
      redirect = part
      continue
    }
    if (SEPARATOR_OPERATORS.has(part)) continue
    const words = part.split(/\s+/)
    const base = words[0]
    if (base === undefined || base === '') continue
    if (BASH_NEUTRAL_COMMANDS.has(base)) continue
    hasCommand = true
    const isSearch = BASH_SEARCH_COMMANDS.has(base)
    const isRead = BASH_READ_COMMANDS.has(base)
    const isList = BASH_LIST_COMMANDS.has(base)
    if (!isSearch && !isRead && !isList) return none
    // `find` is the one search command that ships its own mutations.
    if (base === 'find' && words.some(word => FIND_MUTATING_FLAGS.has(word))) return none
    // And `sort`/`uniq` are the two readers that ship their own file sink.
    if (writesThroughArguments(base, words)) return none
    if (isSearch) hasSearch = true
    if (isRead) hasRead = true
    if (isList) hasList = true
  }
  // A trailing redirect with no target (`cat a >`) is an unfinished command
  // line, and an unfinished command line is not a read.
  if (redirect !== undefined && WRITE_REDIRECT_OPERATORS.has(redirect)) return none
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
  // A mutation names itself first, and its object may well be a query:
  // `delete_search_index` is not a search, however the window reads it.
  if (verb[0] !== undefined && MCP_WRITE_VERBS.has(verb[0])) return false
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
  thinkingMs: number
  thinkingSince: number | undefined
  running: boolean
  failed: boolean
  hint: CollapseHint | undefined
}

/** Freeze a draft into the group the renderer reads. */
function sealGroup(draft: GroupDraft): CollapsedGroup {
  return {
    index: draft.index,
    keys: draft.keys,
    searchCount: draft.searchCount,
    // Distinct named paths, plus the reads that named none. A file read twice
    // through `read` is one file; a shell `cat` is one more, since its argument
    // was never parsed and dropping it silently under-reports the group.
    readCount: draft.readPaths.size + draft.readOperations,
    listCount: draft.listCount,
    mcpCallCount: draft.mcpCallCount,
    mcpServers: draft.mcpServers,
    thinkingMs: draft.thinkingMs,
    running: draft.running,
    // Thinking counts as work in progress: a run whose calls have all settled
    // is still going somewhere while the model is thinking about what to do
    // next, and a row that went past-tense there would freeze its own counter
    // one second into the thought. What that does *not* change is the tense of
    // the counts — see `running`.
    active: draft.running || draft.thinkingSince !== undefined,
    failed: draft.failed,
    ...draft.thinkingSince === undefined ? {} : { thinkingSince: draft.thinkingSince },
    ...draft.hint === undefined ? {} : { hint: draft.hint },
  }
}

/**
 * The latest line of one step's thinking, with runs of whitespace squeezed to a
 * single space so a wrapped paragraph reads as one line.
 *
 * The *latest* rather than the first: while the model is thinking, the last
 * line it wrote is the closest thing there is to "what it is doing right now",
 * which is exactly what the `⎿` row under a running group answers.
 * @param reasoning - The step's reasoning text so far.
 * @returns The line, or `undefined` when the text is blank.
 */
function latestThinkingLine(reasoning: string): string | undefined {
  const lines = reasoning.split('\n')
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = (lines[index] as string).replace(/\s+/gu, ' ').trim()
    if (line !== '') return line
  }
  return undefined
}

/** One step's thinking, or `undefined` when the step never thought. */
function stepThinking(node: AssistantNode): ThinkingSpan | undefined {
  const ms = node.thinkingMs ?? 0
  const since = node.thinkingSince
  if (ms === 0 && since === undefined) return undefined
  return { ms, since, line: latestThinkingLine(node.reasoning) }
}

/**
 * Add one step's thinking to a group under construction.
 * @param draft - The group under construction.
 * @param thinking - The step's span.
 * @param quoteLine - Whether this deployment may put reasoning text on screen.
 */
function absorbThinking(draft: GroupDraft, thinking: ThinkingSpan, quoteLine: boolean): void {
  draft.thinkingMs += thinking.ms
  if (thinking.since !== undefined) draft.thinkingSince = thinking.since
  // The thinking's own last line stands in as the `⎿` hint only until the
  // group's first operation names a file, a pattern or a command, and never
  // takes the row back afterwards: once there is work to point at, pointing at
  // the reasoning instead would read as the group going backwards.
  if (quoteLine && draft.hint === undefined && thinking.line !== undefined) {
    draft.hint = { kind: 'thinking', value: thinking.line }
  }
}

/** Merge two thinking spans that reach the same group, in log order. */
function mergeThinking(carried: ThinkingSpan | undefined, next: ThinkingSpan): ThinkingSpan {
  if (carried === undefined) return next
  return {
    ms: carried.ms + next.ms,
    since: next.since ?? carried.since,
    line: next.line ?? carried.line,
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
  /**
   * Whether the deployment shows reasoning at all (`showReasoning`), default
   * true.
   *
   * False keeps the model's own words off the row: the group still reports how
   * long it thought — a duration quotes nothing — but its `⎿` hint never falls
   * back to a line of reasoning, because the one transcript that promised never
   * to print reasoning must not print it on a summary row either.
   */
  readonly showReasoning?: boolean
}

/**
 * Plan the collapsed groups over a folded node list.
 *
 * A run of one is not a run: a lone `read` keeps its card, because the summary
 * row it would become names no file, no pattern and no command (the `⎿` hint
 * only shows while the group is running), and "Read 1 file" is strictly less
 * than the `Read(src/a.ts)` card it replaced. The row earns its place from two
 * members up, which is where it starts saving rows instead of spending them.
 * Absorbed thinking does not lower that threshold — `Thought for 8s, read 1
 * file` still drops the path the card names — so a group's thinking is only
 * ever reported next to two or more calls, and its thinking hint stands only
 * until the first of those calls names something of its own.
 *
 * @param nodes - The snapshot's nodes, in log order.
 * @param options - Range and per-call exclusions.
 * @returns A map from node index to the group that index belongs to. Every
 *   member index maps to the same object, whose `index` names the last member —
 *   the one whose place the summary row takes. Indices of a single-member run
 *   are absent, so the caller renders their card.
 */
export function collapseToolGroups(
  nodes: readonly ChatNode[],
  options: CollapseOptions = {},
): Map<number, CollapsedGroup> {
  const groups = new Map<number, CollapsedGroup>()
  const from = options.from ?? 0
  const quoteThinking = options.showReasoning !== false
  let draft: GroupDraft | undefined
  let members: number[] = []
  /**
   * Thinking seen with no group open yet. A step thinks *before* it calls
   * anything, so its reasoning reaches the run it opens by being carried here
   * until that run's first member arrives.
   */
  let carried: ThinkingSpan | undefined
  const flush = (): void => {
    // One member is not a run: leaving it out of the map is what sends it back
    // to its own tool card, which names the file the summary row would not.
    if (draft !== undefined && draft.keys.length > 1) {
      const group = sealGroup(draft)
      for (const index of members) groups.set(index, group)
    }
    draft = undefined
    members = []
    // Thinking that reached no group dies with it: the run it led to is over,
    // and the next run has its own thinking to report.
    carried = undefined
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
      if (draft === undefined) {
        draft = {
          index,
          keys: [],
          searchCount: 0,
          readPaths: new Set(),
          readOperations: 0,
          listCount: 0,
          mcpCallCount: 0,
          mcpServers: [],
          thinkingMs: 0,
          thinkingSince: undefined,
          running: false,
          failed: false,
          hint: undefined,
        }
        // Whatever the model thought on its way here belongs to this run.
        if (carried !== undefined) absorbThinking(draft, carried, quoteThinking)
        carried = undefined
      }
      absorb(draft, node, classification)
      // The summary row renders at the member that arrived last; see
      // `CollapsedGroup.index`.
      draft.index = index
      members.push(index)
      continue
    }
    if (node.kind === 'assistant') {
      const thinking = stepThinking(node)
      if (draft !== undefined) {
        // A step that thought while this run was open extends that run —
        // settled *before* the prose flush, because the row has been counting
        // this span up since the first reasoning delta and the step's first
        // text delta must not take it back off the screen.
        if (thinking !== undefined) absorbThinking(draft, thinking, quoteThinking)
        if (breaksGroup(node)) flush()
        continue
      }
      // With no run open, the thinking is what the next run opens with.
      if (breaksGroup(node)) flush()
      if (thinking !== undefined) carried = mergeThinking(carried, thinking)
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
  if (node.status === 'running') draft.running = true
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
      // A read with no path of its own (a shell `cat`) is counted as one more
      // read, since its argument was never parsed: `sealGroup` adds these to
      // the distinct named paths rather than choosing between the two.
      else draft.readOperations += 1
      break
  }
  if (classification.hint !== undefined) draft.hint = classification.hint
}

/**
 * Render a group's `⎿` hint: the file's workspace-relative path, the quoted
 * pattern, the `$ `-prefixed command, or — before the group's first operation —
 * the bare line of thinking, all capped at {@link MAX_HINT_CHARS}.
 * @param hint - The group's latest operation.
 * @param displayPath - Shortens an absolute path for display.
 * @returns The hint row's text.
 */
export function formatCollapseHint(hint: CollapseHint, displayPath: (path: string) => string): string {
  const text = hint.kind === 'path'
    ? displayPath(hint.value)
    // Thinking is prose: it takes neither the quotes a pattern gets nor the
    // prompt a command gets, because it is not something the user could run.
    : hint.kind === 'thinking' ? hint.value
      : hint.kind === 'pattern' ? `"${hint.value}"` : `$ ${hint.value}`
  return text.length > MAX_HINT_CHARS ? `${text.slice(0, MAX_HINT_CHARS - 1)}…` : text
}

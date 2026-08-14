/**
 * Unit tests for read/search collapse: what counts as a read-only call, where a
 * run of them ends, how the row that replaces their cards is worded, and what
 * the three Ctrl+O phases do with the group.
 *
 * The classification and grouping are pure functions of the folded node list,
 * so these drive them with node literals rather than a session — the fold's own
 * contract is covered by `nodes.test.ts`, and what is under test here is the
 * derivation over whatever it produced.
 * @module dsh-tui/tests/unit/collapse
 */

import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import { describe, it } from 'node:test'
import { Container } from '@earendil-works/pi-tui'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { StepTimingTracker } from '../../src/chat/timing.ts'
import {
  classifyShellCommand,
  classifyToolCall,
  collapseToolGroups,
  formatCollapseHint,
  MAX_HINT_CHARS,
  type CollapsedGroup,
} from '../../src/core/collapse.ts'
// The row's wording lives in the transcript component, not in the core
// derivation: it is the only locale-dependent part of collapse.
import { collapsedSummary } from '../../src/components/transcript.ts'
import { setLocale } from '../../src/i18n/index.ts'
import { displayPath } from '../../src/chat/helpers.ts'
import { TranscriptReconciler, type TranscriptDeps } from '../../src/components/reconciler.ts'
import { createPalette, markdownTheme } from '../../src/components/theme.ts'
import type { MarkdownPolicy, ToolCardVisibility } from '../../src/components/transcript.ts'
import { claudeMarkdownTheme } from '../../src/render/markdown.ts'
import { parseArguments } from '../../src/components/content.ts'
import type {
  AssistantNode,
  ChatNode,
  NodeStatus,
  ToolCallNode,
} from '../../src/core/types.ts'

/** Columns the transcript renders into; wide enough that no row under test wraps. */
const WIDTH = 90

/** Epoch of the fabricated nodes. */
const START = 1_700_000_000_000

/** One tool call node, complete and settled unless told otherwise. */
function call(
  name: string,
  args: unknown,
  overrides: { id?: string; status?: NodeStatus; argsComplete?: boolean } = {},
): ToolCallNode {
  const id = overrides.id ?? `${name}-${JSON.stringify(args)}`
  const argsRaw = JSON.stringify(args)
  return {
    kind: 'tool-call',
    key: `tool:${id}`,
    version: 0,
    time: START,
    callId: id,
    name,
    argsRaw,
    args: parseArguments(argsRaw),
    argsComplete: overrides.argsComplete ?? true,
    status: overrides.status ?? 'complete',
  }
}

/** One assistant step, with prose only when the case needs a breaker. */
function step(text: string, overrides: Partial<AssistantNode> = {}): AssistantNode {
  return {
    kind: 'assistant',
    key: `assistant:1:${overrides.step ?? 1}`,
    version: 0,
    time: START,
    turn: 1,
    step: 1,
    status: 'complete',
    text,
    reasoning: '',
    settled: true,
    completedAt: START,
    toolCalls: [],
    ...overrides,
  }
}

/** The distinct groups a node list plans, in first-member order. */
function groupsOf(nodes: readonly ChatNode[]): CollapsedGroup[] {
  const planned = collapseToolGroups(nodes)
  const seen = new Set<CollapsedGroup>()
  const groups: CollapsedGroup[] = []
  for (let index = 0; index < nodes.length; index += 1) {
    const group = planned.get(index)
    if (group === undefined || seen.has(group)) continue
    seen.add(group)
    groups.push(group)
  }
  return groups
}

/** The one group a node list is expected to plan. */
function onlyGroup(nodes: readonly ChatNode[]): CollapsedGroup {
  const groups = groupsOf(nodes)
  assert.equal(groups.length, 1, `expected exactly one group, got ${groups.length}`)
  return groups[0] as CollapsedGroup
}

/** A reconciler over its own chat container, plus the rows it renders. */
function mountReconciler(visibility: ToolCardVisibility): {
  reconciler: TranscriptReconciler
  rows: () => string[]
} {
  const palette = createPalette(false)
  const markdown: MarkdownPolicy = {
    mode: 'claude',
    theme: claudeMarkdownTheme,
    onError: error => assert.fail(`the claude renderer threw: ${String(error)}`),
  }
  const events: readonly SessionEvent[] = []
  const deps: TranscriptDeps = {
    palette,
    mdTheme: markdownTheme(palette),
    scheme: () => 'dark',
    markdown,
    maxToolOutputLines: 6,
    maxDiffEditLength: 2_000,
    events: () => events,
    tracker: new StepTimingTracker(),
    now: () => START,
    toolDefinition: () => undefined,
    cwd: '/workspace',
  }
  const chat = new Container()
  const reconciler = new TranscriptReconciler(chat, deps, { showReasoning: true, visibility })
  return { reconciler, rows: () => chat.render(WIDTH).map(row => row.trimEnd()) }
}

describe('shell command classification', () => {
  it('sorts the three read-only shapes apart', () => {
    assert.deepEqual(classifyShellCommand('rg TODO src'), { isSearch: true, isRead: false, isList: false })
    assert.deepEqual(classifyShellCommand('cat README.md'), { isSearch: false, isRead: true, isList: false })
    assert.deepEqual(classifyShellCommand('ls -la src'), { isSearch: false, isRead: false, isList: true })
    assert.deepEqual(classifyShellCommand('tree src'), { isSearch: false, isRead: false, isList: true })
  })

  it('requires every non-neutral part of a pipeline to be read-only', () => {
    assert.equal(classifyShellCommand('cat pkg.json | jq .name').isRead, true)
    // One writing part disqualifies the whole line, however read-only the rest is.
    assert.deepEqual(classifyShellCommand('cat a.txt | tee b.txt'), {
      isSearch: false,
      isRead: false,
      isList: false,
    })
    assert.deepEqual(classifyShellCommand('rm -rf build'), { isSearch: false, isRead: false, isList: false })
  })

  it('skips redirect targets and semantically neutral words', () => {
    // `> out.txt` names a file, not a command, so it is not read against the sets.
    assert.equal(classifyShellCommand('ls src > out.txt').isList, true)
    assert.equal(classifyShellCommand('ls src && echo --- && ls tests').isList, true)
    // Nothing but neutral words read nothing at all.
    assert.deepEqual(classifyShellCommand('echo hello'), { isSearch: false, isRead: false, isList: false })
  })

  it('reads a quoted operator as text, and refuses an unbalanced quote', () => {
    assert.equal(classifyShellCommand('grep "a | b" src').isSearch, true)
    assert.deepEqual(classifyShellCommand('cat "unterminated'), {
      isSearch: false,
      isRead: false,
      isList: false,
    })
  })
})

describe('tool call classification', () => {
  it('classifies this harness\'s own read-only tools', () => {
    assert.equal(classifyToolCall('read', { file_path: '/workspace/a.ts' })?.kind, 'read')
    assert.equal(classifyToolCall('read_image', { file_path: '/workspace/a.png' })?.kind, 'read')
    assert.equal(classifyToolCall('grep', { pattern: 'TODO' })?.kind, 'search')
    assert.equal(classifyToolCall('glob', { pattern: '**/*.ts' })?.kind, 'search')
    assert.equal(classifyToolCall('bash', { command: 'ls src' })?.kind, 'list')
    assert.equal(classifyToolCall('bash', { command: 'head -n 5 a.ts' })?.kind, 'read')
  })

  it('collapses the editor only under its viewing command', () => {
    assert.equal(classifyToolCall('str_replace_editor', { command: 'view', path: '/workspace/a.ts' })?.kind, 'read')
    assert.equal(classifyToolCall('str_replace_editor', { command: 'create', path: '/workspace/a.ts' }), undefined)
  })

  it('leaves writing tools uncollapsible', () => {
    assert.equal(classifyToolCall('edit', { file_path: '/workspace/a.ts' }), undefined)
    assert.equal(classifyToolCall('write', { file_path: '/workspace/a.ts' }), undefined)
    assert.equal(classifyToolCall('bash', { command: 'git commit -m x' }), undefined)
    assert.equal(classifyToolCall('web_fetch', { url: 'https://example.com' }), undefined)
  })

  it('reads an MCP call\'s server off its qualified name, and its verb off the rest', () => {
    const query = classifyToolCall('mcp__slack__slack_search_public', { query: 'deploy' })
    assert.equal(query?.kind, 'mcp')
    assert.equal(query?.server, 'slack')
    assert.deepEqual(query?.hint, { kind: 'pattern', value: 'deploy' })
    // camelCase and kebab-case name the same verb.
    assert.equal(classifyToolCall('mcp__linear__searchIssues', {})?.kind, 'mcp')
    assert.equal(classifyToolCall('mcp__notion__fetch-page', {})?.kind, 'mcp')
    // A mutation is not a query, and neither is a name that is not MCP-qualified.
    assert.equal(classifyToolCall('mcp__slack__send_message', {}), undefined)
    assert.equal(classifyToolCall('mcp__jira__create_issue', {}), undefined)
    assert.equal(classifyToolCall('mcp__broken', {}), undefined)
  })
})

describe('collapse grouping', () => {
  it('folds a run of consecutive read-only calls into one group', () => {
    const nodes: ChatNode[] = [
      step(''),
      call('grep', { pattern: 'TODO' }),
      call('read', { file_path: '/workspace/a.ts' }),
      call('bash', { command: 'ls src' }),
    ]
    const group = onlyGroup(nodes)
    assert.equal(group.index, 1)
    assert.equal(group.keys.length, 3)
    assert.equal(collapsedSummary(group), 'Searched for 1 pattern, read 1 file, listed 1 directory')
  })

  it('breaks on assistant prose', () => {
    const nodes: ChatNode[] = [
      call('read', { file_path: '/workspace/a.ts' }),
      step('Now let me check the tests.', { step: 2 }),
      call('read', { file_path: '/workspace/b.ts' }),
    ]
    const groups = groupsOf(nodes)
    assert.equal(groups.length, 2, 'a sentence the model wrote ends the run above it')
    assert.equal(groups[0]?.readCount, 1)
    assert.equal(groups[1]?.readCount, 1)
  })

  it('breaks on a call that is not read-only', () => {
    const nodes: ChatNode[] = [
      call('read', { file_path: '/workspace/a.ts' }),
      call('edit', { file_path: '/workspace/a.ts' }),
      call('read', { file_path: '/workspace/b.ts' }),
    ]
    assert.equal(groupsOf(nodes).length, 2)
  })

  it('breaks on a new prompt, and on a landed compaction', () => {
    const prompt: ChatNode = {
      kind: 'user-message',
      key: 'user:1',
      version: 0,
      time: START,
      text: 'and now?',
      source: 'user',
    }
    assert.equal(groupsOf([
      call('read', { file_path: '/workspace/a.ts' }),
      prompt,
      call('read', { file_path: '/workspace/b.ts' }),
    ]).length, 2)
    assert.equal(groupsOf([
      call('read', { file_path: '/workspace/a.ts' }),
      { kind: 'compaction', key: 'compaction:1', version: 0, time: START, landed: true, summary: '' },
      call('read', { file_path: '/workspace/b.ts' }),
    ]).length, 2)
  })

  it('carries thinking, notices, context and the plan over the group', () => {
    const nodes: ChatNode[] = [
      call('read', { file_path: '/workspace/a.ts' }),
      // A step that only thought carries no prose and ends nothing.
      step('', { step: 2, reasoning: 'thinking about it' }),
      { kind: 'notice', key: 'notice:1', version: 0, time: START, text: 'Retrying', tone: 'warning' },
      { kind: 'context', key: 'context:1', version: 0, time: START, label: 'workspace', text: 'files' },
      { kind: 'todo', key: 'todo', version: 0, time: START, todos: [] },
      call('read', { file_path: '/workspace/b.ts' }),
    ]
    const group = onlyGroup(nodes)
    assert.equal(group.readCount, 2, 'the run survives everything that is not the conversation')
  })

  it('neither joins nor breaks on a call whose arguments are still streaming', () => {
    const nodes: ChatNode[] = [
      call('read', { file_path: '/workspace/a.ts' }),
      call('edit', {}, { id: 'streaming', argsComplete: false }),
      call('read', { file_path: '/workspace/b.ts' }),
    ]
    const group = onlyGroup(nodes)
    assert.equal(group.readCount, 2)
    assert.equal(group.keys.length, 2, 'an incomplete call renders no card and joins no group')
  })

  it('leaves out a call the transcript is not rendering', () => {
    const nodes: ChatNode[] = [
      call('read', { file_path: '/workspace/a.ts' }, { id: 'cleared' }),
      call('read', { file_path: '/workspace/b.ts' }, { id: 'kept' }),
    ]
    const planned = collapseToolGroups(nodes, { isHidden: id => id === 'cleared' })
    const group = planned.get(1)
    assert.ok(group !== undefined, 'the visible call still groups')
    assert.equal(group.index, 1)
    assert.equal(group.readCount, 1)
    assert.equal(planned.get(0), undefined)
  })

  it('starts at the range it is given, so a /clear cut takes its groups with it', () => {
    const nodes: ChatNode[] = [
      call('read', { file_path: '/workspace/a.ts' }),
      call('read', { file_path: '/workspace/b.ts' }),
    ]
    const planned = collapseToolGroups(nodes, { from: 1 })
    assert.equal(planned.get(0), undefined)
    assert.equal(planned.get(1)?.readCount, 1)
  })
})

describe('collapse counting', () => {
  it('counts a file read twice as one file', () => {
    const group = onlyGroup([
      call('read', { file_path: '/workspace/a.ts' }, { id: 'first' }),
      call('read', { file_path: '/workspace/a.ts' }, { id: 'second' }),
      call('read', { file_path: '/workspace/b.ts' }),
    ])
    assert.equal(group.readCount, 2)
  })

  it('falls back to operations only when no call named a path', () => {
    const shellOnly = onlyGroup([
      call('bash', { command: 'cat a.ts' }, { id: 'one' }),
      call('bash', { command: 'wc -l b.ts' }, { id: 'two' }),
    ])
    assert.equal(shellOnly.readCount, 2, 'a shell read has no path, so operations are all there is')
    // Mixed: the paths win outright rather than adding the shell reads on top,
    // because `read(a.ts)` then `wc -l a.ts` is one file, not two.
    const mixed = onlyGroup([
      call('read', { file_path: '/workspace/a.ts' }),
      call('bash', { command: 'wc -l /workspace/a.ts' }),
    ])
    assert.equal(mixed.readCount, 1)
  })

  it('counts searches and listings per call, and MCP queries per server', () => {
    const group = onlyGroup([
      call('grep', { pattern: 'a' }),
      call('grep', { pattern: 'b' }),
      call('bash', { command: 'ls src' }),
      call('mcp__slack__search_messages', { query: 'x' }, { id: 'm1' }),
      call('mcp__slack__get_channel', {}, { id: 'm2' }),
    ])
    assert.equal(group.searchCount, 2)
    assert.equal(group.listCount, 1)
    assert.equal(group.mcpCallCount, 2)
    assert.deepEqual(group.mcpServers, ['slack'])
  })

  it('reports a group as running while any of its calls is', () => {
    const settled = onlyGroup([call('read', { file_path: '/workspace/a.ts' })])
    assert.equal(settled.active, false)
    const running = onlyGroup([
      call('read', { file_path: '/workspace/a.ts' }, { id: 'done' }),
      call('read', { file_path: '/workspace/b.ts' }, { id: 'open', status: 'running' }),
    ])
    assert.equal(running.active, true)
    const failed = onlyGroup([call('read', { file_path: '/workspace/a.ts' }, { status: 'error' })])
    assert.equal(failed.failed, true)
  })
})

describe('collapsed summary wording', () => {
  it('uses the present tense while the run is open and the past tense after it', () => {
    const nodes: ChatNode[] = [
      call('grep', { pattern: 'TODO' }),
      call('read', { file_path: '/workspace/a.ts' }, { status: 'running' }),
    ]
    assert.equal(collapsedSummary(onlyGroup(nodes)), 'Searching for 1 pattern, reading 1 file…')
    const settled: ChatNode[] = [
      call('grep', { pattern: 'TODO' }),
      call('read', { file_path: '/workspace/a.ts' }),
    ]
    assert.equal(collapsedSummary(onlyGroup(settled)), 'Searched for 1 pattern, read 1 file')
  })

  it('capitalizes only the first fragment', () => {
    const group = onlyGroup([
      call('read', { file_path: '/workspace/a.ts' }),
      call('bash', { command: 'ls src' }),
    ])
    assert.equal(collapsedSummary(group), 'Read 1 file, listed 1 directory')
  })

  it('agrees each noun with its own count', () => {
    const group = onlyGroup([
      call('grep', { pattern: 'a' }, { id: 'g1' }),
      call('grep', { pattern: 'b' }, { id: 'g2' }),
      call('read', { file_path: '/workspace/a.ts' }, { id: 'r1' }),
      call('read', { file_path: '/workspace/b.ts' }, { id: 'r2' }),
      call('bash', { command: 'ls src' }, { id: 'l1' }),
      call('bash', { command: 'ls tests' }, { id: 'l2' }),
    ])
    assert.equal(collapsedSummary(group), 'Searched for 2 patterns, read 2 files, listed 2 directories')
  })

  it('names an MCP server once, and counts only when it was queried more than once', () => {
    const single = onlyGroup([call('mcp__slack__search_messages', { query: 'x' })])
    assert.equal(collapsedSummary(single), 'Queried slack')
    const many = onlyGroup([
      call('mcp__slack__search_messages', { query: 'x' }, { id: 'm1' }),
      call('mcp__slack__get_channel', {}, { id: 'm2' }),
      call('mcp__github__search_code', {}, { id: 'm3' }),
    ])
    assert.equal(collapsedSummary(many), 'Queried slack, github 3 times')
  })

  it('words the whole row in the active locale, punctuation included', () => {
    const group = onlyGroup([
      call('grep', { pattern: 'TODO' }),
      call('read', { file_path: '/workspace/a.ts' }),
      call('bash', { command: 'ls src' }),
    ])
    const running = onlyGroup([call('read', { file_path: '/workspace/a.ts' }, { status: 'running' })])
    const mcp = onlyGroup([
      call('mcp__slack__search_messages', { query: 'x' }, { id: 'm1' }),
      call('mcp__slack__get_channel', {}, { id: 'm2' }),
    ])
    setLocale('zh')
    try {
      // The full-width comma is the point: the separator is a translated row,
      // not a literal, so a locale sets its own list punctuation.
      assert.equal(collapsedSummary(group), '搜索了 1 个 pattern，读取了 1 个文件，列出了 1 个目录')
      assert.equal(collapsedSummary(running), '正在读取 1 个文件…')
      // The MCP pair carries "name the server" vs "count the calls" rather than
      // a plural, so both halves have to survive translation.
      assert.equal(collapsedSummary(mcp), '查询了 slack 2 次')
    } finally {
      setLocale('en')
    }
    assert.equal(collapsedSummary(group), 'Searched for 1 pattern, read 1 file, listed 1 directory')
  })
})

describe('collapsed hint', () => {
  it('keeps the latest operation, in the shape that operation has', () => {
    const read = onlyGroup([
      call('grep', { pattern: 'TODO' }),
      call('read', { file_path: '/workspace/src/a.ts' }, { status: 'running' }),
    ])
    assert.deepEqual(read.hint, { kind: 'path', value: '/workspace/src/a.ts' })
    assert.equal(formatCollapseHint(read.hint!, path => displayPath(path, '/workspace')), 'src/a.ts')

    const search = onlyGroup([call('grep', { pattern: 'TODO' })])
    assert.equal(formatCollapseHint(search.hint!, path => path), '"TODO"')

    const shell = onlyGroup([call('bash', { command: 'ls src' })])
    assert.equal(formatCollapseHint(shell.hint!, path => path), '$ ls src')
  })

  it('squeezes a command\'s whitespace and caps a long one', () => {
    const group = onlyGroup([call('bash', { command: 'cat  a.ts   \n\n   | jq   .name' })])
    assert.equal(formatCollapseHint(group.hint!, path => path), '$ cat a.ts\n| jq .name')

    const long = onlyGroup([call('bash', { command: `cat ${'x'.repeat(MAX_HINT_CHARS * 2)}` })])
    const rendered = formatCollapseHint(long.hint!, path => path)
    assert.equal(rendered.length, MAX_HINT_CHARS)
    assert.ok(rendered.endsWith('…'), rendered)
  })

  it('shows a path outside the workspace as it is, and a home path with a tilde', () => {
    assert.equal(displayPath('/elsewhere/a.ts', '/workspace'), '/elsewhere/a.ts')
    assert.equal(displayPath('relative/a.ts', '/workspace'), 'relative/a.ts')
    // A file under home but outside the workspace reads as the user would type it.
    assert.equal(displayPath(join(homedir(), 'notes.md'), '/workspace'), `~${sep}notes.md`)
  })
})

describe('collapsed groups on the Ctrl+O cycle', () => {
  const nodes: ChatNode[] = [
    step('Looking around.'),
    call('read', { file_path: '/workspace/src/a.ts' }, { id: 'r1' }),
    call('grep', { pattern: 'TODO' }, { id: 'r2' }),
  ]

  it('renders one summary row on the collapsed phase, in place of the cards', () => {
    const { reconciler, rows } = mountReconciler('collapsed')
    reconciler.reconcile(nodes)
    const rendered = rows().join('\n')
    assert.match(rendered, /Searched for 1 pattern, read 1 file/, rendered)
    assert.match(rendered, /\(ctrl\+o to expand\)/, rendered)
    assert.ok(!rendered.includes('grep('), `the group's own cards are off screen:\n${rendered}`)
  })

  it('renders every card on the expanded phase, and none on the hidden one', () => {
    const { reconciler, rows } = mountReconciler('collapsed')
    reconciler.reconcile(nodes)
    reconciler.setVisibility('expanded')
    const expanded = rows().join('\n')
    assert.ok(!expanded.includes('Searched for 1 pattern'), `the summary gives way to the cards:\n${expanded}`)
    assert.match(expanded, /read/, expanded)
    assert.match(expanded, /grep/, expanded)

    reconciler.setVisibility('hidden')
    const hidden = rows().join('\n')
    assert.ok(!hidden.includes('Searched for 1 pattern'), `hidden hides the summary too:\n${hidden}`)
    assert.ok(!hidden.includes('grep'), `and every card:\n${hidden}`)
    assert.match(hidden, /Looking around\./, 'the conversation stays')

    reconciler.setVisibility('collapsed')
    assert.match(rows().join('\n'), /Searched for 1 pattern, read 1 file/)
  })

  it('names the operation in flight under a running group, and stops once it settles', () => {
    const { reconciler, rows } = mountReconciler('collapsed')
    const running: ChatNode[] = [
      step('Looking around.'),
      call('read', { file_path: '/workspace/src/a.ts' }, { id: 'r1', status: 'running' }),
    ]
    reconciler.reconcile(running)
    const live = rows().join('\n')
    assert.match(live, /Reading 1 file…/, live)
    assert.match(live, /⎿ {2}src\/a\.ts/, live)

    reconciler.reconcile([running[0] as ChatNode, call('read', { file_path: '/workspace/src/a.ts' }, { id: 'r1' })])
    const settled = rows().join('\n')
    assert.match(settled, /Read 1 file/, settled)
    assert.ok(!settled.includes('src/a.ts'), `a settled group reports its counts alone:\n${settled}`)
  })

  it('grows its counts in place as the run continues', () => {
    const { reconciler, rows } = mountReconciler('collapsed')
    reconciler.reconcile([call('read', { file_path: '/workspace/a.ts' }, { id: 'r1', status: 'running' })])
    assert.match(rows().join('\n'), /Reading 1 file…/)
    reconciler.reconcile([
      call('read', { file_path: '/workspace/a.ts' }, { id: 'r1' }),
      call('read', { file_path: '/workspace/b.ts' }, { id: 'r2', status: 'running' }),
    ])
    assert.match(rows().join('\n'), /Reading 2 files…/)
  })
})

/**
 * `/subagents`: the delegation-tree panel, the directory seam that fills it,
 * and the entry-side wiring that keeps it current.
 *
 * The panel is asserted directly (loading, empty, the tree layout, a listing
 * that failed before and after a good one), and the command end to end over a
 * fake directory — including the two things that are easy to get wrong and
 * invisible on screen: that `subagent/start` makes the open panel read again,
 * and that closing it unsubscribes, so a delegation after Esc costs nothing.
 * @module dsh-tui/tests/unit/subagents-panel
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { stripTerminalSequences } from '@earendil-works/pi-tui'
import { SessionId } from '@deepseek-ai/dsh-session'
// Declaration-merges `subagent/start` and `subagent/end` onto `Events`, so the
// cases below emit them by name rather than through a cast.
import type {} from '@deepseek-ai/dsh-subagent'
import {
  subagentCounts,
  subagentDirectory,
  subagentName,
  type SubagentDescendant,
} from '../../src/chat/subagents.ts'
import {
  SUBAGENTS_EMPTY,
  SUBAGENTS_LOADING,
  SUBAGENTS_UNAVAILABLE,
  SubagentsPanel,
  renderSubagentRows,
} from '../../src/components/subagents-panel.ts'
import { createPalette } from '../../src/components/theme.ts'
import { setLocale } from '../../src/i18n/index.ts'
import {
  createTuiTestHarness,
  disposeTuiTestHarness,
  tuiEntryAvailable,
  type TuiHarness,
  type TuiHarnessOptions,
} from '../harness.ts'
import { HeadlessTerminal } from '../headless-terminal.ts'

const palette = createPalette(false)

/** `src/index.ts` is landed by a separate port; without it the end-to-end suite cannot run. */
const entryAvailable = await tuiEntryAvailable()
const skipWithoutEntry = entryAvailable
  ? false
  : 'requires src/index.ts to export createTuiChat(ctx, config, runtime)'

/** A command on a fiber plus one directory read: outwait both. */
const SETTLE_MS = 60

/** The panel's debounce is 200 ms; a refresh case has to outwait it. */
const REFRESH_SETTLE_MS = 400

/** One interpreted child, with only the fields a row reads spelled out. */
function child(
  id: string,
  depth: number,
  fields: Partial<Omit<SubagentDescendant, 'kind' | 'id' | 'depth'>> = {},
): SubagentDescendant {
  return {
    kind: 'child',
    id: SessionId(id),
    parentId: SessionId('root'),
    depth,
    activity: 'running',
    hasChildren: false,
    mode: 'one-shot',
    ...fields,
  } as SubagentDescendant
}

/** A candidate the directory could not interpret. */
function diagnostic(id: string, reason: 'corrupt' | 'unsupported' | 'unavailable'): SubagentDescendant {
  return {
    kind: 'diagnostic',
    id: SessionId(id),
    parentId: SessionId('root'),
    depth: 1,
    reason,
  }
}

/** A parent, its two children, and one unreadable candidate beside them. */
const SAMPLE_TREE: readonly SubagentDescendant[] = [
  child('ses-reviewer', 1, { mode: 'continuable', label: 'reviewer', hasChildren: true }),
  child('ses-lint', 2, { label: 'worker: lint' }),
  child('ses-docs', 2, { label: 'worker: docs', activity: 'inactive' }),
  diagnostic('ses-broken', 'corrupt'),
]

/** Mount the panel over a fixed 20-row budget, with a close spy. */
function subagentsPanel(entries: readonly SubagentDescendant[] | undefined): {
  panel: SubagentsPanel
  closed: () => number
} {
  let closes = 0
  const panel = new SubagentsPanel(entries, () => 20, palette, () => { closes += 1 })
  return { panel, closed: () => closes }
}

/** The panel's rows at 80 columns, styling stripped, right-trimmed. */
function panelRows(panel: SubagentsPanel): string[] {
  return panel.render(80).map(line => stripTerminalSequences(line).trimEnd())
}

describe('subagent directory seam', () => {
  it('answers undefined for every shape that is not a directory', () => {
    assert.equal(subagentDirectory({ get: () => undefined }), undefined)
    // A profile can provide something under the name without providing this
    // contract; a nominal check would not have caught it, and calling a missing
    // method would have thrown inside the command instead.
    assert.equal(subagentDirectory({ get: () => 'subagents' }), undefined)
    assert.equal(subagentDirectory({ get: () => ({ listChildren: () => [] }) }), undefined)
  })

  it('takes any object that can list descendants', () => {
    const service = { listDescendants: () => Promise.resolve([]) }
    assert.equal(subagentDirectory({ get: () => service }), service)
  })

  it('counts live children only, and diagnostics only in the total', () => {
    assert.deepEqual(subagentCounts(SAMPLE_TREE), { running: 2, total: 4 })
    assert.deepEqual(subagentCounts([]), { running: 0, total: 0 })
    // A diagnostic is a session that exists: dropping it from the total would
    // make `/status` disagree with the panel it points at.
    assert.deepEqual(subagentCounts([diagnostic('ses-x', 'unavailable')]), { running: 0, total: 1 })
  })

  it('falls back to the session id when a one-shot child has no label', () => {
    assert.equal(subagentName(child('ses-lint', 1, { label: 'worker: lint' })), 'worker: lint')
    assert.equal(subagentName(child('ses-anon', 1)), 'ses-anon')
    // An empty label names nothing, so it is not a name either.
    assert.equal(subagentName(child('ses-empty', 1, { label: '' })), 'ses-empty')
    assert.equal(subagentName(diagnostic('ses-broken', 'corrupt')), 'ses-broken')
  })
})

describe('subagents panel', () => {
  it('waits on its own line instead of claiming an empty tree', () => {
    const { panel } = subagentsPanel(undefined)
    const rows = panelRows(panel)
    assert.equal(rows[1], ' /subagents')
    assert.equal(rows[2], ` ${SUBAGENTS_LOADING}`)
    assert.ok(!rows.includes(` ${SUBAGENTS_EMPTY}`))
  })

  it('reports an empty tree as an answer, and closes on Esc', () => {
    const { panel, closed } = subagentsPanel([])
    const rows = panelRows(panel)
    assert.ok(rows.includes(` ${SUBAGENTS_EMPTY}`), rows.join('\n'))
    assert.equal(rows.at(-1), ' esc close')
    panel.handleInput('\x1b')
    assert.equal(closed(), 1)
  })

  it('draws the tree by depth, with each row\'s mode, activity, and id', () => {
    const { panel } = subagentsPanel(SAMPLE_TREE)
    const rows = panelRows(panel)
    assert.equal(rows[2], ' 4 subagents · 2 running')
    // Two columns per level of delegation, one name column sized to the widest
    // indented name, then the mode and activity words and the trailing id.
    assert.deepEqual(rows.slice(3, 7), [
      ' ● reviewer        continuable · running  ses-reviewer',
      '   ● worker: lint  one-shot · running  ses-lint',
      '   ○ worker: docs  one-shot · inactive  ses-docs',
      ' ! ses-broken      unreadable entry  ses-broken',
    ])
    assert.equal(rows.at(-1), ' ↑↓ scroll · esc close')
  })

  it('marks a live child and a settled one differently', () => {
    const rows = renderSubagentRows(
      [child('ses-a', 1, { label: 'live' }), child('ses-b', 1, { label: 'cold', activity: 'inactive' })],
      palette,
      60,
    ).map(line => stripTerminalSequences(line))
    // Two store states, not two outcomes: neither mark borrows the check or
    // the cross a result would be painted with.
    assert.ok(rows[0]?.startsWith('● live'), rows.join('\n'))
    assert.ok(rows[1]?.startsWith('○ cold'), rows.join('\n'))
  })

  it('shows a first listing that failed instead of an endless loading line', () => {
    const { panel, closed } = subagentsPanel(undefined)
    panel.setError('The subagent directory could not be read: EACCES')
    const rows = panelRows(panel)
    assert.ok(rows.some(row => row.includes('EACCES')), rows.join('\n'))
    assert.ok(!rows.includes(` ${SUBAGENTS_LOADING}`))
    assert.equal(closed(), 0)
  })

  it('keeps the tree on screen when a refresh fails, and clears the failure on the next one', () => {
    const { panel } = subagentsPanel(SAMPLE_TREE)
    panel.setError('The subagent directory could not be read: ETIMEDOUT')
    let rows = panelRows(panel)
    assert.ok(rows.some(row => row.includes('ETIMEDOUT')), rows.join('\n'))
    // A refresh that lost the directory must not blank a tree the reader is
    // still looking at: the rows are merely older than they look.
    assert.ok(rows.some(row => row.includes('reviewer')), rows.join('\n'))

    panel.setEntries([child('ses-lint', 1, { label: 'worker: lint' })])
    rows = panelRows(panel)
    assert.ok(!rows.some(row => row.includes('ETIMEDOUT')), rows.join('\n'))
    assert.equal(rows[2], ' 1 subagent · 1 running')
  })

  it('scrolls a tree taller than the panel and stops at both ends', () => {
    const many = Array.from({ length: 40 }, (_, index) => child(`ses-${String(index)}`, 1, {
      label: `worker ${String(index)}`,
    }))
    const { panel } = subagentsPanel(many)
    assert.ok(panelRows(panel).some(row => row.includes('worker 0')))
    panel.handleInput('G')
    let rows = panelRows(panel)
    assert.ok(rows.some(row => row.includes('worker 39')), rows.join('\n'))
    assert.ok(!rows.some(row => row.includes('worker 0 ')), rows.join('\n'))
    assert.ok(rows.at(-1)?.includes('40'), `the footer states the position:\n${rows.join('\n')}`)
    panel.handleInput('g')
    assert.ok(panelRows(panel).some(row => row.includes('worker 0')))
  })

  it('swallows every other keystroke while it is open', () => {
    const { panel, closed } = subagentsPanel(SAMPLE_TREE)
    for (const key of ['a', '\r', '\t', 'x']) panel.handleInput(key)
    assert.equal(closed(), 0)
    assert.equal(panelRows(panel)[2], ' 4 subagents · 2 running')
    panel.handleInput('\x03')
    assert.equal(closed(), 1)
  })

  it('renders its own chrome in the active locale, and the tree verbatim', () => {
    const { panel } = subagentsPanel(SAMPLE_TREE)
    setLocale('zh')
    try {
      const rows = panelRows(panel)
      assert.equal(rows[2], ' 4 个子代理 · 2 个运行中')
      assert.ok(rows.some(row => row.includes('可继续 · 运行中')), rows.join('\n'))
      // The labels and ids are the directory's own text, never translated.
      assert.ok(rows.some(row => row.includes('worker: lint')), rows.join('\n'))
      assert.equal(rows.at(-1), ' ↑↓ 滚动 · esc 关闭')
    } finally {
      setLocale('en')
    }
    // The lookup is per frame, so the switch back repaints without remounting.
    assert.equal(panelRows(panel)[2], ' 4 subagents · 2 running')
  })
})

type SubagentsHarness = TuiHarness<HeadlessTerminal, (code: number) => void>

interface SubmitHandle {
  submit(text: string): void
}

/** A `subagents` service over a fixed tree, counting the listings it served. */
function directoryService(entries: readonly SubagentDescendant[]): {
  service: unknown
  reads: () => number
} {
  let reads = 0
  return {
    service: {
      listDescendants: () => {
        reads += 1
        return Promise.resolve([...entries])
      },
    },
    reads: () => reads,
  }
}

/**
 * A `subagents` service whose listings settle when the test says so, in
 * whatever order it says so — the shape a real directory takes when one read
 * walks a cold subtree and the next answers off the warmed projection cache.
 */
function deferredDirectoryService(): {
  service: unknown
  pending: () => number
  settle(index: number, entries: readonly SubagentDescendant[]): void
  fail(index: number, error: Error): void
} {
  const deferred: { resolve: (entries: readonly SubagentDescendant[]) => void; reject: (error: Error) => void }[] = []
  return {
    service: {
      listDescendants: async () => new Promise<readonly SubagentDescendant[]>((resolve, reject) => {
        deferred.push({ resolve, reject })
      }),
    },
    pending: () => deferred.length,
    settle: (index, entries) => { deferred[index]?.resolve([...entries]) },
    fail: (index, error) => { deferred[index]?.reject(error) },
  }
}

/** The tree an in-flight read enumerated before the newest delegation existed. */
const STALE_TREE: readonly SubagentDescendant[] = [
  child('ses-reviewer', 1, { mode: 'continuable', label: 'reviewer', hasChildren: true }),
  child('ses-lint', 2, { label: 'worker: lint' }),
]

/** The same tree with the child that triggered the refresh in it. */
const FRESH_TREE: readonly SubagentDescendant[] = [
  ...STALE_TREE,
  child('ses-docs', 2, { label: 'worker: docs' }),
]

/** One delegation edge, the only thing the events are used for. */
function startDelegation(harness: SubagentsHarness, id: string): void {
  harness.ctx.emit('subagent/start', {
    runId: 'run-1' as never,
    provider: 'in-process',
    id: SessionId(id),
    local: true,
  })
}

async function mount(options: TuiHarnessOptions = {}): Promise<SubagentsHarness> {
  const terminal = new HeadlessTerminal(100, 40)
  const before = terminal.frames
  const harness = await createTuiTestHarness(terminal, () => {}, {
    cwd: '/workspace/project',
    ...options,
    config: {
      title: 'DSH subagents',
      ...options.config,
      theme: { color: false, inputPrompt: 'subagents> ', ...options.config?.theme },
    },
  })
  await terminal.waitForFrame(before)
  return harness
}

async function unmount(harness: SubagentsHarness): Promise<void> {
  await disposeTuiTestHarness(harness)
  await harness.terminal.dispose()
}

describe('TUI /subagents', { skip: skipWithoutEntry }, () => {
  it('registers the command whether or not a registry answers for it', async () => {
    const harness = await mount()
    try {
      await delay(SETTLE_MS)
      const names = harness.ctx.commands.list(harness.agent).map(command => command.name)
      assert.ok(names.includes('subagents'), `/subagents must be registered: ${names.join(', ')}`)
    } finally {
      await unmount(harness)
    }
  })

  it('opens the tree the directory reports', async () => {
    const directory = directoryService(SAMPLE_TREE)
    const harness = await mount({ services: { subagents: directory.service } })
    try {
      await delay(SETTLE_MS)
      ;(harness.controller as unknown as SubmitHandle).submit('/subagents')
      await delay(SETTLE_MS)
      const frame = harness.terminal.text()
      assert.match(frame, /\/subagents/, `the panel is titled with the command:\n${frame}`)
      assert.match(frame, /4 subagents · 2 running/)
      assert.match(frame, /worker: lint/)
      assert.match(frame, /continuable · running/)
      assert.match(frame, /unreadable entry/)
      assert.equal(directory.reads(), 1)
    } finally {
      await unmount(harness)
    }
  })

  it('re-reads the directory when a delegation starts, and stops once closed', async () => {
    const directory = directoryService(SAMPLE_TREE)
    const harness = await mount({ services: { subagents: directory.service } })
    try {
      await delay(SETTLE_MS)
      ;(harness.controller as unknown as SubmitHandle).submit('/subagents')
      await delay(SETTLE_MS)
      assert.equal(directory.reads(), 1)

      // The events carry no label, mode, or parent, so they are only the edge
      // that makes the listing stale; the facts still come from the directory.
      harness.ctx.emit('subagent/start', {
        runId: 'run-1' as never,
        provider: 'in-process',
        id: SessionId('ses-lint'),
        local: true,
      })
      harness.ctx.emit('subagent/end', {
        runId: 'run-1' as never,
        provider: 'in-process',
        id: SessionId('ses-lint'),
        local: true,
        stopReason: 'completed',
      })
      await delay(REFRESH_SETTLE_MS)
      // Both edges landed inside one debounce window, so the burst cost one
      // directory pass rather than one per event.
      assert.equal(directory.reads(), 2)

      harness.terminal.send('\x1b')
      await delay(SETTLE_MS)
      harness.ctx.emit('subagent/start', {
        runId: 'run-2' as never,
        provider: 'in-process',
        id: SessionId('ses-docs'),
        local: true,
      })
      await delay(REFRESH_SETTLE_MS)
      // A closed panel has nothing to invalidate: the listeners came off with it.
      assert.equal(directory.reads(), 2)
    } finally {
      await unmount(harness)
    }
  })

  it('keeps the newest tree when an older read answers after it', async () => {
    // The debounce coalesces the starts of a burst, not the listings already in
    // flight: the read that began first can be the one that finishes last, with
    // a corpus enumerated before the child that triggered the second read even
    // existed. Committing it would rewind the panel to a tree the user already
    // watched grow, and nothing re-reads until the next delegation edge.
    const directory = deferredDirectoryService()
    const harness = await mount({ services: { subagents: directory.service } })
    try {
      await delay(SETTLE_MS)
      ;(harness.controller as unknown as SubmitHandle).submit('/subagents')
      await delay(SETTLE_MS)
      assert.equal(directory.pending(), 1, 'the panel reads the directory when it opens')

      startDelegation(harness, 'ses-docs')
      await delay(REFRESH_SETTLE_MS)
      assert.equal(directory.pending(), 2, 'the delegation edge starts a second read')

      // The newer read answers first, off the cache the first read warmed.
      directory.settle(1, FRESH_TREE)
      await delay(SETTLE_MS)
      assert.match(harness.terminal.text(), /worker: docs/, harness.terminal.text())

      directory.settle(0, STALE_TREE)
      await delay(SETTLE_MS)
      const frame = harness.terminal.text()
      assert.match(frame, /worker: docs/, `the older listing does not rewind the tree:\n${frame}`)
      assert.match(frame, /3 subagents · 3 running/, `nor the count it is read from:\n${frame}`)
    } finally {
      await unmount(harness)
    }
  })

  it('does not paint a stale failure over a tree that was read successfully', async () => {
    const directory = deferredDirectoryService()
    const harness = await mount({ services: { subagents: directory.service } })
    try {
      await delay(SETTLE_MS)
      ;(harness.controller as unknown as SubmitHandle).submit('/subagents')
      await delay(SETTLE_MS)
      startDelegation(harness, 'ses-docs')
      await delay(REFRESH_SETTLE_MS)
      assert.equal(directory.pending(), 2)

      directory.settle(1, FRESH_TREE)
      await delay(SETTLE_MS)
      // The first read fails slowly — one persistence inspection threw. The
      // banner it would raise describes a listing two reads out of date.
      directory.fail(0, new Error('projection registry is not mounted'))
      await delay(SETTLE_MS)
      const frame = harness.terminal.text()
      assert.doesNotMatch(frame, /could not be read/, `a superseded failure says nothing:\n${frame}`)
      assert.match(frame, /worker: docs/, `and leaves the tree that answered:\n${frame}`)
    } finally {
      await unmount(harness)
    }
  })

  it('says the registry is not mounted rather than opening an empty tree', async () => {
    const harness = await mount()
    try {
      await delay(SETTLE_MS)
      ;(harness.controller as unknown as SubmitHandle).submit('/subagents')
      await delay(SETTLE_MS)
      const frame = harness.terminal.text()
      assert.ok(frame.includes(SUBAGENTS_UNAVAILABLE), `a registry-less profile is told so:\n${frame}`)
      assert.ok(!frame.includes('subagents · '), 'no tree panel is opened')
    } finally {
      await unmount(harness)
    }
  })

  it('reports a directory that will not answer inside the panel that asked', async () => {
    const harness = await mount({
      services: {
        subagents: { listDescendants: () => Promise.reject(new Error('projection registry is not mounted')) },
      },
    })
    try {
      await delay(SETTLE_MS)
      ;(harness.controller as unknown as SubmitHandle).submit('/subagents')
      await delay(SETTLE_MS)
      const frame = harness.terminal.text()
      assert.match(frame, /could not be read/, `the failure is shown where it was asked for:\n${frame}`)
      assert.match(frame, /projection registry is not mounted/)
    } finally {
      await unmount(harness)
    }
  })
})

describe('TUI /status subagents row', { skip: skipWithoutEntry }, () => {
  it('states the tree in one row and points at the panel', async () => {
    const harness = await mount({ services: { subagents: directoryService(SAMPLE_TREE).service } })
    try {
      await delay(SETTLE_MS)
      ;(harness.controller as unknown as SubmitHandle).submit('/status')
      await delay(SETTLE_MS)
      const frame = harness.terminal.text()
      assert.match(frame, /Subagents/, `the row is present when a registry answered:\n${frame}`)
      assert.match(frame, /2 running · 4 total/)
    } finally {
      await unmount(harness)
    }
  })

  it('omits the row on a profile with no registry, and when the listing fails', async () => {
    const bare = await mount()
    try {
      await delay(SETTLE_MS)
      ;(bare.controller as unknown as SubmitHandle).submit('/status')
      await delay(SETTLE_MS)
      const frame = bare.terminal.text()
      assert.match(frame, /Session status/)
      assert.doesNotMatch(frame, /Subagents/)
    } finally {
      await unmount(bare)
    }

    const broken = await mount({
      services: { subagents: { listDescendants: () => Promise.reject(new Error('unreadable')) } },
    })
    try {
      await delay(SETTLE_MS)
      ;(broken.controller as unknown as SubmitHandle).submit('/status')
      await delay(SETTLE_MS)
      const frame = broken.terminal.text()
      // A diagnostic panel does not fail over one unreadable directory, and it
      // does not invent a zero for it either.
      assert.match(frame, /Session status/)
      assert.doesNotMatch(frame, /Subagents/)
    } finally {
      await unmount(broken)
    }
  })
})

/**
 * `/jobs`: the background-work panel, the registry seam that fills it, and the
 * entry-side wiring around it — the prompt badge, the `/status` row, and the
 * one subscription all three share.
 *
 * The panel is asserted directly (empty, the row layout, the marks each
 * lifecycle state wears, the clock on a live row), and the command end to end
 * over a fake registry — including the two things that are easy to get wrong
 * and invisible on screen: that a change to the visible set reaches the open
 * panel AND the badge from one read, and that closing the panel leaves the
 * badge subscribed, because the badge outlives the view.
 * @module dsh-tui/tests/unit/jobs-panel
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { stripTerminalSequences } from '@earendil-works/pi-tui'
import {
  jobCounts,
  jobElapsed,
  jobsRegistry,
  sortJobRows,
  type JobRow,
} from '../../src/chat/jobs.ts'
import {
  JOBS_EMPTY,
  JOBS_UNAVAILABLE,
  JobsPanel,
  renderJobRows,
} from '../../src/components/jobs-panel.ts'
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

/** A command on a fiber plus one frame: outwait both. */
const SETTLE_MS = 60

/** The fixed clock the frame cases read elapsed times against. */
const NOW = 1_700_000_060_000

/** One job, with only the fields a row reads spelled out. */
function job(id: string, fields: Partial<Omit<JobRow, 'id'>> = {}): JobRow {
  return {
    id,
    kind: id.replace(/-\d+$/u, ''),
    label: id,
    status: 'running',
    startedAt: NOW - 60_000,
    ...fields,
  }
}

/** One live job, one that finished, one that broke — in registration order. */
const SAMPLE_JOBS: readonly JobRow[] = [
  job('bash-1', { label: 'pnpm test', startedAt: NOW - 62_000 }),
  job('subagent-2', {
    label: 'review the diff',
    status: 'failed',
    detail: 'exit code: 1',
    startedAt: NOW - 300_000,
    finishedAt: NOW - 240_000,
  }),
  job('bash-3', { label: 'tsc --watch', startedAt: NOW - 5_000 }),
]

/** Mount the panel over a fixed 20-row budget and clock, with a close spy. */
function jobsPanel(rows: readonly JobRow[]): { panel: JobsPanel; closed: () => number } {
  let closes = 0
  const panel = new JobsPanel(rows, () => 20, palette, () => NOW, () => { closes += 1 })
  return { panel, closed: () => closes }
}

/** The panel's rows at 80 columns, styling stripped, right-trimmed. */
function panelRows(panel: JobsPanel): string[] {
  return panel.render(80).map(line => stripTerminalSequences(line).trimEnd())
}

describe('job registry seam', () => {
  it('answers undefined for every shape that is not a registry', () => {
    assert.equal(jobsRegistry({ get: () => undefined }), undefined)
    // A profile can provide something under the name without providing this
    // contract; a nominal check would not have caught it, and calling a missing
    // method would have thrown inside the command instead.
    assert.equal(jobsRegistry({ get: () => 'jobs' }), undefined)
    assert.equal(jobsRegistry({ get: () => ({ list: () => [] }) }), undefined)
    assert.equal(jobsRegistry({ get: () => ({ onJobsChanged: () => () => {} }) }), undefined)
  })

  it('takes any object that can list and be subscribed to', () => {
    const service = { list: () => [], onJobsChanged: () => () => {} }
    assert.equal(jobsRegistry({ get: () => service }), service)
  })

  it('counts a job being stopped as live, and a settled one only in the total', () => {
    assert.deepEqual(jobCounts(SAMPLE_JOBS), { live: 2, total: 3 })
    assert.deepEqual(jobCounts([]), { live: 0, total: 0 })
    // `stopping` is a kill that has been asked for and not honoured yet: the
    // producer still holds its resources, so the badge still counts it.
    assert.deepEqual(jobCounts([job('bash-9', { status: 'stopping' })]), { live: 1, total: 1 })
    assert.deepEqual(jobCounts([job('bash-9', { status: 'killed', finishedAt: NOW })]), { live: 0, total: 1 })
  })

  it('reads live work oldest first, then finished work newest first', () => {
    const ordered = sortJobRows(SAMPLE_JOBS).map(row => row.id)
    assert.deepEqual(ordered, ['bash-1', 'bash-3', 'subagent-2'])

    const settled = sortJobRows([
      job('bash-1', { status: 'completed', finishedAt: NOW - 1_000 }),
      job('bash-2', { status: 'completed', finishedAt: NOW - 9_000 }),
    ]).map(row => row.id)
    assert.deepEqual(settled, ['bash-1', 'bash-2'])

    // A settled row the registry never stamped still lands in a defined place —
    // it sorts as though it ended when it started — rather than at whichever end
    // an undefined comparison happened to leave it. The ids are chosen to
    // disagree with the times: without the fallback the subtraction is NaN, the
    // comparator falls through to the id tiebreak, and the answer would be the
    // other one.
    const stampless = sortJobRows([
      job('aaa-2', { status: 'completed', startedAt: NOW - 8_000 }),
      job('zzz-1', { status: 'completed', startedAt: NOW - 2_000, finishedAt: NOW - 4_000 }),
    ]).map(row => row.id)
    assert.deepEqual(stampless, ['zzz-1', 'aaa-2'])
  })

  it('leaves its input alone and breaks ties by id', () => {
    const input: readonly JobRow[] = [job('bash-2'), job('bash-1')]
    const sorted = sortJobRows(input)
    assert.deepEqual(sorted.map(row => row.id), ['bash-1', 'bash-2'])
    assert.deepEqual(input.map(row => row.id), ['bash-2', 'bash-1'])
  })

  it('runs a live job\'s clock and freezes a settled one\'s', () => {
    assert.equal(jobElapsed(job('bash-1', { startedAt: NOW - 3_000 }), NOW), 3_000)
    assert.equal(
      jobElapsed(job('bash-1', { startedAt: NOW - 9_000, finishedAt: NOW - 4_000 }), NOW),
      5_000,
    )
    // A clock that ran backwards (a corrected system time) reads as zero rather
    // than as a negative duration.
    assert.equal(jobElapsed(job('bash-1', { startedAt: NOW + 5_000 }), NOW), 0)
  })
})

describe('jobs panel', () => {
  it('says the background is idle rather than drawing an empty list, and closes on Esc', () => {
    const { panel, closed } = jobsPanel([])
    const rows = panelRows(panel)
    assert.equal(rows[1], ' /jobs')
    assert.ok(rows.includes(` ${JOBS_EMPTY}`), rows.join('\n'))
    assert.equal(rows.at(-1), ' esc close')
    panel.handleInput('\x1b')
    assert.equal(closed(), 1)
  })

  it('draws each job\'s kind, label, state, detail, and elapsed time', () => {
    const { panel } = jobsPanel(sortJobRows(SAMPLE_JOBS))
    const rows = panelRows(panel)
    assert.equal(rows[2], ' 3 jobs · 2 running')
    assert.deepEqual(rows.slice(3, 6), [
      ' ● bash      pnpm test        running  1m 2s',
      ' ● bash      tsc --watch      running  5s',
      // The producer's detail joins the state word rather than replacing it:
      // "exit code: 1" says how a job ended to a reader who knows it ended.
      ' ✗ subagent  review the diff  failed · exit code: 1  1m 0s',
    ])
    assert.equal(rows.at(-1), ' ↑↓ scroll · esc close')
  })

  it('marks the five lifecycle states apart', () => {
    const rows = renderJobRows(
      [
        job('bash-1', { status: 'running' }),
        job('bash-2', { status: 'stopping' }),
        job('bash-3', { status: 'completed', finishedAt: NOW }),
        job('bash-4', { status: 'killed', finishedAt: NOW }),
        job('bash-5', { status: 'failed', finishedAt: NOW }),
      ],
      palette,
      60,
      NOW,
    ).map(line => stripTerminalSequences(line))
    // A terminal state IS an outcome here, unlike the subagent tree's store
    // states, so these rows use the check and the cross results are painted in.
    assert.deepEqual(rows.map(row => row.slice(0, 1)), ['●', '◐', '✔', '◼', '✗'])
  })

  it('moves a live row\'s clock and leaves a settled row\'s where the log left it', () => {
    let clock = NOW
    const panel = new JobsPanel(
      [job('bash-1', { startedAt: NOW - 1_000 }), job('bash-2', {
        status: 'completed',
        startedAt: NOW - 4_000,
        finishedAt: NOW - 2_000,
      })],
      () => 20,
      palette,
      () => clock,
      () => {},
    )
    let rows = panelRows(panel)
    assert.ok(rows[3]?.endsWith('running  1s'), rows.join('\n'))
    assert.ok(rows[4]?.endsWith('completed  2s'), rows.join('\n'))
    clock = NOW + 9_000
    panel.invalidate()
    rows = panelRows(panel)
    assert.ok(rows[3]?.endsWith('running  10s'), rows.join('\n'))
    assert.ok(rows[4]?.endsWith('completed  2s'), rows.join('\n'))
  })

  it('scrolls a list taller than the panel and stops at both ends', () => {
    const many = Array.from({ length: 40 }, (_, index) => job(`bash-${String(index)}`, {
      label: `command ${String(index)}`,
      startedAt: NOW - index,
    }))
    const { panel } = jobsPanel(many)
    assert.ok(panelRows(panel).some(row => row.includes('command 0')))
    panel.handleInput('G')
    let rows = panelRows(panel)
    assert.ok(rows.some(row => row.includes('command 39')), rows.join('\n'))
    assert.ok(rows.at(-1)?.includes('40'), `the footer states the position:\n${rows.join('\n')}`)
    panel.handleInput('g')
    rows = panelRows(panel)
    assert.ok(rows.some(row => row.includes('command 0')), rows.join('\n'))
  })

  it('swallows every other keystroke while it is open', () => {
    const { panel, closed } = jobsPanel(SAMPLE_JOBS)
    for (const key of ['a', '\r', '\t', 'x']) panel.handleInput(key)
    assert.equal(closed(), 0)
    assert.equal(panelRows(panel)[2], ' 3 jobs · 2 running')
    panel.handleInput('\x03')
    assert.equal(closed(), 1)
  })

  it('replaces its list when the registry reports a change', () => {
    const { panel } = jobsPanel(SAMPLE_JOBS)
    panel.setJobs([job('bash-1', { label: 'pnpm test', status: 'completed', finishedAt: NOW })])
    const rows = panelRows(panel)
    assert.equal(rows[2], ' 1 job · 0 running')
    assert.ok(!rows.some(row => row.includes('review the diff')), rows.join('\n'))
  })

  it('renders its own chrome in the active locale, and the labels verbatim', () => {
    const { panel } = jobsPanel(sortJobRows(SAMPLE_JOBS))
    setLocale('zh')
    try {
      const rows = panelRows(panel)
      assert.equal(rows[2], ' 3 个任务 · 2 个运行中')
      assert.ok(rows.some(row => row.includes('失败 · exit code: 1')), rows.join('\n'))
      // The kinds and labels are the producer's own text, never translated.
      assert.ok(rows.some(row => row.includes('bash      pnpm test')), rows.join('\n'))
      assert.equal(rows.at(-1), ' ↑↓ 滚动 · esc 关闭')
    } finally {
      setLocale('en')
    }
    // The lookup is per frame, so the switch back repaints without remounting.
    assert.equal(panelRows(panel)[2], ' 3 jobs · 2 running')
  })
})

type JobsHarness = TuiHarness<HeadlessTerminal, (code: number) => void>

interface SubmitHandle {
  submit(text: string): void
}

/** A `jobs` service over a mutable visible set, with its listeners exposed. */
function registryService(initial: readonly JobRow[]): {
  service: unknown
  set(rows: readonly JobRow[]): void
  listeners: () => number
  reads: () => number
} {
  let rows = initial
  let reads = 0
  const listeners = new Set<() => void>()
  return {
    service: {
      list: () => {
        reads += 1
        return [...rows]
      },
      onJobsChanged: (listener: () => void) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
    set: (next: readonly JobRow[]) => {
      rows = next
      for (const listener of [...listeners]) listener()
    },
    listeners: () => listeners.size,
    reads: () => reads,
  }
}

async function mount(options: TuiHarnessOptions = {}): Promise<JobsHarness> {
  const terminal = new HeadlessTerminal(100, 40)
  const before = terminal.frames
  const harness = await createTuiTestHarness(terminal, () => {}, {
    cwd: '/workspace/project',
    now: () => NOW,
    ...options,
    config: {
      title: 'DSH jobs',
      ...options.config,
      theme: { color: false, inputPrompt: 'jobs> ', ...options.config?.theme },
    },
  })
  await terminal.waitForFrame(before)
  return harness
}

async function unmount(harness: JobsHarness): Promise<void> {
  await disposeTuiTestHarness(harness)
  await harness.terminal.dispose()
}

describe('TUI /jobs', { skip: skipWithoutEntry }, () => {
  it('registers the command whether or not a registry answers for it', async () => {
    const harness = await mount()
    try {
      await delay(SETTLE_MS)
      const names = harness.ctx.commands.list(harness.agent).map(command => command.name)
      assert.ok(names.includes('jobs'), `/jobs must be registered: ${names.join(', ')}`)
    } finally {
      await unmount(harness)
    }
  })

  it('opens the list the registry reports', async () => {
    const registry = registryService(SAMPLE_JOBS)
    const harness = await mount({ services: { jobs: registry.service } })
    try {
      await delay(SETTLE_MS)
      ;(harness.controller as unknown as SubmitHandle).submit('/jobs')
      await delay(SETTLE_MS)
      const frame = harness.terminal.text()
      assert.match(frame, /\/jobs/, `the panel is titled with the command:\n${frame}`)
      assert.match(frame, /3 jobs · 2 running/)
      assert.match(frame, /pnpm test/)
      assert.match(frame, /failed · exit code: 1/)
    } finally {
      await unmount(harness)
    }
  })

  it('moves the open panel and the badge on one read of the same change', async () => {
    const registry = registryService(SAMPLE_JOBS)
    const harness = await mount({ services: { jobs: registry.service } })
    try {
      await delay(SETTLE_MS)
      ;(harness.controller as unknown as SubmitHandle).submit('/jobs')
      await delay(SETTLE_MS)
      const before = registry.reads()
      registry.set([job('bash-1', {
        label: 'pnpm test',
        status: 'completed',
        startedAt: NOW - 62_000,
        finishedAt: NOW,
      })])
      await delay(SETTLE_MS)
      const frame = harness.terminal.text()
      assert.match(frame, /1 job · 0 running/, `the panel followed the change:\n${frame}`)
      assert.ok(!frame.includes('review the diff'), `a removed job leaves the list:\n${frame}`)
      // One listing per change, not one per observer: the badge and the panel
      // are two readers of the same read, so they cannot disagree about it.
      assert.equal(registry.reads() - before, 1)
      assert.doesNotMatch(frame, /job(s)? running/, `the badge goes with the last live job:\n${frame}`)
    } finally {
      await unmount(harness)
    }
  })

  it('counts live jobs on the prompt row, and says nothing when none are', async () => {
    const registry = registryService([job('bash-1', { label: 'pnpm test' })])
    const harness = await mount({ services: { jobs: registry.service } })
    try {
      await delay(SETTLE_MS)
      assert.match(harness.terminal.text(), /1 job running/, harness.terminal.text())
      registry.set([job('bash-1', { label: 'pnpm test' }), job('bash-2', { label: 'tsc' })])
      await delay(SETTLE_MS)
      assert.match(harness.terminal.text(), /2 jobs running/, harness.terminal.text())
      registry.set([])
      await delay(SETTLE_MS)
      assert.doesNotMatch(harness.terminal.text(), /job(s)? running/, harness.terminal.text())
    } finally {
      await unmount(harness)
    }
  })

  it('leaves the second panel following the registry when it replaced the first', async () => {
    const registry = registryService(SAMPLE_JOBS)
    const harness = await mount({ services: { jobs: registry.service } })
    try {
      await delay(SETTLE_MS)
      ;(harness.controller as unknown as SubmitHandle).submit('/jobs')
      await delay(SETTLE_MS)
      // The first panel's close lands after the second has opened, so a hook
      // cleared unconditionally there would strand the panel on screen.
      ;(harness.controller as unknown as SubmitHandle).submit('/jobs')
      await delay(SETTLE_MS)
      registry.set([job('bash-7', { label: 'cargo build' })])
      await delay(SETTLE_MS)
      const frame = harness.terminal.text()
      assert.match(frame, /cargo build/, `the open panel followed the change:\n${frame}`)
      assert.match(frame, /1 job · 1 running/, frame)
    } finally {
      await unmount(harness)
    }
  })

  it('keeps the badge subscribed after the panel that showed the list is closed', async () => {
    const registry = registryService([])
    const harness = await mount({ services: { jobs: registry.service } })
    try {
      await delay(SETTLE_MS)
      ;(harness.controller as unknown as SubmitHandle).submit('/jobs')
      await delay(SETTLE_MS)
      assert.match(harness.terminal.text(), new RegExp(JOBS_EMPTY.replace(/\./gu, '\\.')))
      harness.terminal.send('\x1b')
      await delay(SETTLE_MS)
      // The subscription belongs to the terminal, not to the view: work that
      // starts after the panel is closed still reaches the prompt row.
      registry.set([job('bash-1', { label: 'pnpm test' })])
      await delay(SETTLE_MS)
      assert.match(harness.terminal.text(), /1 job running/, harness.terminal.text())
    } finally {
      await unmount(harness)
    }
  })

  it('moves a live row\'s clock while the panel is open, and stops on a settled list', async () => {
    // The panel's whole reason for owning a timer: between two registry edges
    // nothing else on screen moves, so a live row's elapsed column is the only
    // thing telling the reader the job is still going. A settled list must not
    // pay for that — an interval repainting a still picture once a second is
    // just as invisible to a frozen-clock test as a missing one.
    let clock = NOW
    const registry = registryService([job('bash-1', { label: 'pnpm test', startedAt: NOW - 5_000 })])
    const harness = await mount({ services: { jobs: registry.service }, now: () => clock })
    try {
      await delay(SETTLE_MS)
      ;(harness.controller as unknown as SubmitHandle).submit('/jobs')
      await delay(SETTLE_MS)
      const row = (): string | undefined =>
        harness.terminal.text().split('\n').find(line => line.includes('pnpm test'))?.trim()
      const before = row()
      assert.ok(before?.endsWith('running  5s') === true, `the live row states its age:\n${String(before)}`)
      clock = NOW + 60_000
      // Long enough for one tick of the panel's own 1 s clock, which is the only
      // thing that can repaint the row without a registry change.
      await delay(1_400)
      assert.ok(row()?.endsWith('running  1m 5s') === true, `and keeps it current: ${String(row())}`)

      // The same job, settled: the row freezes and so does the timer behind it.
      registry.set([job('bash-1', {
        label: 'pnpm test',
        status: 'completed',
        startedAt: NOW - 5_000,
        finishedAt: clock,
      })])
      await delay(SETTLE_MS)
      const frames = harness.terminal.frames
      await delay(1_400)
      assert.equal(harness.terminal.frames, frames, 'a settled list schedules no repaints')
    } finally {
      await unmount(harness)
    }
  })

  it('follows a registry that mounts after the terminal did', async () => {
    // Nothing sequences a job producer against this terminal: an embedder can
    // provide the registry around `createTuiChat`, and a reload of the plugin
    // that owns it replaces the instance under a running terminal. A badge and
    // a panel bound to whatever answered at mount would stay at zero forever.
    const registry = registryService([job('bash-1', { label: 'pnpm test' })])
    const harness = await mount()
    try {
      await delay(SETTLE_MS)
      assert.doesNotMatch(harness.terminal.text(), /job(s)? running/, harness.terminal.text())

      harness.ctx.provide('jobs', registry.service as never)
      await delay(SETTLE_MS)
      assert.match(harness.terminal.text(), /1 job running/, harness.terminal.text())

      ;(harness.controller as unknown as SubmitHandle).submit('/jobs')
      await delay(SETTLE_MS)
      assert.match(harness.terminal.text(), /1 job · 1 running/, harness.terminal.text())

      // And the late registry's edges reach both readers, like any other.
      registry.set([job('bash-1', { label: 'pnpm test' }), job('bash-2', { label: 'tsc' })])
      await delay(SETTLE_MS)
      const frame = harness.terminal.text()
      assert.match(frame, /2 jobs · 2 running/, `the open panel followed it:\n${frame}`)
      assert.match(frame, /2 jobs running/, `and so did the badge:\n${frame}`)
    } finally {
      await unmount(harness)
    }
  })

  it('drops its subscription with the terminal', async () => {
    const registry = registryService([job('bash-1', { label: 'pnpm test' })])
    const harness = await mount({ services: { jobs: registry.service } })
    await delay(SETTLE_MS)
    assert.equal(registry.listeners(), 1)
    await unmount(harness)
    assert.equal(registry.listeners(), 0)
  })

  it('says the registry is not mounted rather than opening an empty list', async () => {
    const harness = await mount()
    try {
      await delay(SETTLE_MS)
      ;(harness.controller as unknown as SubmitHandle).submit('/jobs')
      await delay(SETTLE_MS)
      const frame = harness.terminal.text()
      assert.ok(frame.includes(JOBS_UNAVAILABLE), `a registry-less profile is told so:\n${frame}`)
      assert.ok(!frame.includes('esc close'), `no panel is opened:\n${frame}`)
      assert.doesNotMatch(frame, /job(s)? running/, `and no badge is painted:\n${frame}`)
    } finally {
      await unmount(harness)
    }
  })
})

describe('TUI /status jobs row', { skip: skipWithoutEntry }, () => {
  it('states the background work in one row and points at the panel', async () => {
    const harness = await mount({ services: { jobs: registryService(SAMPLE_JOBS).service } })
    try {
      await delay(SETTLE_MS)
      ;(harness.controller as unknown as SubmitHandle).submit('/status')
      await delay(SETTLE_MS)
      const frame = harness.terminal.text()
      assert.match(frame, /Background jobs/, `the row is present when a registry answered:\n${frame}`)
      assert.match(frame, /2 running · 3 total/)
    } finally {
      await unmount(harness)
    }
  })

  it('omits the row on a profile with no registry', async () => {
    const harness = await mount()
    try {
      await delay(SETTLE_MS)
      ;(harness.controller as unknown as SubmitHandle).submit('/status')
      await delay(SETTLE_MS)
      const frame = harness.terminal.text()
      assert.match(frame, /Session status/)
      assert.doesNotMatch(frame, /Background jobs/)
    } finally {
      await unmount(harness)
    }
  })
})

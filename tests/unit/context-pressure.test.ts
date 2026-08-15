/**
 * Context-window pressure: the arithmetic that decides when the prompt row
 * stops reporting how much is used and starts reporting how much is left, and
 * the once-per-band rule that keeps the transcript from repeating itself.
 *
 * The pure half pins the band edges — including the guardrail that the warning
 * has to fire BEFORE automatic compaction, which is the whole reason the
 * numbers are what they are. The mounted half pins what a user sees: one row
 * per escalation, an action clause that names a command this session actually
 * has, and nothing at all while the window is unknown or a compaction is
 * already fixing the problem.
 * @module dsh-tui/tests/unit/context-pressure
 */

import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { compactCheckpointSource, CompactionId } from '@deepseek-ai/dsh-compaction'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import {
  appendAssistant,
  createTuiTestHarness,
  disposeTuiTestHarness,
  tuiEntryAvailable,
  type TuiHarness,
  type TuiHarnessOptions,
} from '../harness.ts'
import { HeadlessTerminal } from '../headless-terminal.ts'
import {
  contextPressure,
  createContextAnnouncementTracker,
  nextContextAnnouncement,
  pressureLevel,
  pressureRank,
  AUTO_COMPACT_REMAINING_PERCENT,
  CONTEXT_CRITICAL_REMAINING_PERCENT,
  CONTEXT_LOW_REMAINING_PERCENT,
} from '../../src/chat/context-pressure.ts'
import { setLocale } from '../../src/i18n/index.ts'

describe('context pressure arithmetic', () => {
  it('reports nothing while no usable window is known', () => {
    assert.equal(contextPressure(1_000, undefined), undefined)
    assert.equal(contextPressure(1_000, 0), undefined)
    assert.equal(contextPressure(1_000, -1), undefined)
    assert.equal(contextPressure(1_000, Number.NaN), undefined)
  })

  it('leaves an ordinary session in the normal band', () => {
    const pressure = contextPressure(64_000, 128_000)
    assert.equal(pressure?.percentUsed, 50)
    assert.equal(pressure?.percentRemaining, 50)
    assert.equal(pressure?.level, 'normal')
  })

  it('turns yellow at the boundary, not one point past it', () => {
    const at = contextPressure(96_000, 128_000)
    assert.equal(at?.percentRemaining, 25)
    assert.equal(at?.level, 'low')
    const below = contextPressure(95_000, 128_000)
    assert.equal(below?.percentRemaining, 26)
    assert.equal(below?.level, 'normal')
  })

  it('turns red at the boundary, not one point past it', () => {
    const at = contextPressure(115_200, 128_000)
    assert.equal(at?.percentRemaining, 10)
    assert.equal(at?.level, 'critical')
    const below = contextPressure(114_000, 128_000)
    assert.equal(below?.percentRemaining, 11)
    assert.equal(below?.level, 'low')
  })

  it('clamps a reading the window cannot hold', () => {
    const over = contextPressure(200_000, 128_000)
    assert.equal(over?.percentUsed, 100)
    assert.equal(over?.percentRemaining, 0)
    assert.equal(over?.level, 'critical')
    const under = contextPressure(-5, 128_000)
    assert.equal(under?.used, 0)
    assert.equal(under?.percentUsed, 0)
    assert.equal(under?.level, 'normal')
  })

  it('rounds exactly the way the prompt row already did', () => {
    // The percentage a user already knows must not move by a point the day the
    // warning lands; these are the readings the row printed before it existed.
    for (const [used, window] of [[1, 128_000], [7_777, 100_000], [64_501, 128_000],
      [99_999, 128_000], [128_000, 128_000]] as const) {
      assert.equal(contextPressure(used, window)?.percentUsed, Math.min(100, Math.round(used / window * 100)))
    }
  })

  it('warns before automatic compaction acts, and turns red only below it', () => {
    // The design intent, as an assertion: the yellow row is the last moment a
    // user can still choose `/compact` themselves, and red means the automatic
    // path is absent, off, or failing. Moving a threshold past this breaks here.
    assert.ok(CONTEXT_LOW_REMAINING_PERCENT > AUTO_COMPACT_REMAINING_PERCENT)
    assert.ok(AUTO_COMPACT_REMAINING_PERCENT > CONTEXT_CRITICAL_REMAINING_PERCENT)
    assert.equal(pressureLevel(AUTO_COMPACT_REMAINING_PERCENT), 'low')
    assert.deepEqual(
      [pressureRank('normal'), pressureRank('low'), pressureRank('critical')],
      [0, 1, 2],
    )
  })

  it('announces each band once as the window tightens', () => {
    const tracker = createContextAnnouncementTracker()
    assert.equal(nextContextAnnouncement(tracker, 'normal'), undefined)
    assert.equal(nextContextAnnouncement(tracker, 'low'), 'low')
    assert.equal(nextContextAnnouncement(tracker, 'low'), undefined)
    assert.equal(nextContextAnnouncement(tracker, 'critical'), 'critical')
    assert.equal(nextContextAnnouncement(tracker, 'critical'), undefined)
  })

  it('re-arms a band the session dropped out of', () => {
    const tracker = createContextAnnouncementTracker()
    nextContextAnnouncement(tracker, 'critical')
    // What a successful compaction looks like from here: the band falls, which
    // is not news, and the band above it becomes news again.
    assert.equal(nextContextAnnouncement(tracker, 'low'), undefined)
    assert.equal(tracker.announced, 'low')
    assert.equal(nextContextAnnouncement(tracker, 'critical'), 'critical')
  })

  it('re-arms the first band once the window is comfortable again', () => {
    const tracker = createContextAnnouncementTracker()
    nextContextAnnouncement(tracker, 'low')
    assert.equal(nextContextAnnouncement(tracker, 'normal'), undefined)
    assert.equal(tracker.announced, 'normal')
    assert.equal(nextContextAnnouncement(tracker, 'low'), 'low')
  })
})

/** `src/index.ts` is landed by a separate port; without it the end-to-end suite cannot run. */
const entryAvailable = await tuiEntryAvailable()
const skipWithoutEntry = entryAvailable
  ? false
  : 'requires src/index.ts to export createTuiChat(ctx, config, runtime)'

/** Literal editor prefix, so a frame assertion never depends on prompt-value registrations. */
const INPUT_PROMPT = 'dsh> '

/** Frames, notices, and catalog reads settle across a few awaits; outwait them. */
const SETTLE_MS = 60

/** The window every mounted case measures against, so the arithmetic stays readable. */
const WINDOW = 128_000

type Harness = TuiHarness<HeadlessTerminal, (code: number) => void>

/** One mounted terminal whose measured pressure the test moves. */
interface PressureHarness {
  harness: Harness
  /** Set the tokens the meter reports for the next measurement. */
  set(measured: number): void
}

async function mount(options: TuiHarnessOptions = {}, initial = 0): Promise<PressureHarness> {
  let measured = initial
  const terminal = new HeadlessTerminal(110, 32)
  const before = terminal.frames
  const harness = await createTuiTestHarness(terminal, () => {}, {
    cwd: '/workspace/project',
    contextWindow: WINDOW,
    ...options,
    services: {
      // The measurement is memoized on the log's length, so a test moves this
      // number and then appends an event to make the row read it again.
      tokenMeter: { measure: () => ({ totalTokens: measured }) },
      ...options.services,
    },
    config: {
      title: 'DSH context',
      welcome: 'ready.',
      ...options.config,
      theme: { color: false, inputPrompt: INPUT_PROMPT, ...options.config?.theme },
    },
  })
  await terminal.waitForFrame(before)
  return { harness, set: (next: number) => { measured = next } }
}

async function unmount(mounted: PressureHarness): Promise<void> {
  await disposeTuiTestHarness(mounted.harness)
  await mounted.harness.terminal.dispose()
}

/** How many times one line appears in a frame. */
function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

/**
 * Move the measured pressure and grow the log so the row reads it again.
 * @param mounted - the terminal under test.
 * @param measured - the new token count the meter reports.
 */
async function bump(mounted: PressureHarness, measured: number): Promise<void> {
  mounted.set(measured)
  appendAssistant(mounted.harness.session, [{ type: 'text', text: '.' }])
  await delay(SETTLE_MS)
}

/** Append the events one landed compaction writes, so the fold sees a real one. */
function landCompaction(session: Session, id: string): void {
  const compactionId = CompactionId(id)
  const replaced = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'earlier prompt' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('compaction/start', { compactionId, turn: null })
  session.append('compaction/summary', {
    compactionId,
    summary: [{ type: 'text', text: 'what was said before' }],
    shadowedRange: { start: replaced.seq, end: replaced.seq },
    shadowedSeqs: [replaced.seq],
    shadowedTokenCount: 90_000,
    provider: 'mock',
    model: 'test-model',
  })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'summary of earlier conversation' }],
    source: compactCheckpointSource(compactionId),
  }), {
    surfaceOp: { op: 'replace', start: replaced.seq, end: replaced.seq },
    sourceEventSeqs: [replaced.seq],
  })
  session.append('compaction/end', { compactionId, turn: null })
}

/** A compaction service, so the warning has an action worth naming. */
const COMPACTION_SERVICE = { compactNow: () => Promise.resolve(null) }

describe('context low warning', { skip: skipWithoutEntry }, () => {
  afterEach(() => { setLocale('en') })

  it('leaves a comfortable window reporting what it has used', async () => {
    const mounted = await mount({}, 20_000)
    try {
      await delay(SETTLE_MS)
      const frame = mounted.harness.terminal.text()
      assert.match(frame, /16% context/u, frame)
      assert.ok(!frame.includes('context left'), `nothing counts down yet:\n${frame}`)
      assert.ok(!frame.includes('Context low'), `and nothing is announced:\n${frame}`)
    } finally {
      await unmount(mounted)
    }
  })

  it('counts down once the window is tight, and says it once', async () => {
    const mounted = await mount({}, 20_000)
    try {
      await bump(mounted, 100_000)
      const frame = mounted.harness.terminal.text()
      assert.match(frame, /22% context left/u, frame)
      assert.ok(!frame.includes('78% context'), `the row switches what it reports rather than adding a second:\n${frame}`)
      assert.equal(countOf(frame, 'Context low'), 1, frame)

      // A redraw and another event inside the same band are not news.
      mounted.harness.terminal.send('hello')
      await bump(mounted, 101_000)
      assert.equal(countOf(mounted.harness.terminal.text(), 'Context low'), 1,
        mounted.harness.terminal.text())
    } finally {
      await unmount(mounted)
    }
  })

  it('names /compact when this session has something to compact with', async () => {
    const mounted = await mount({ services: { compaction: COMPACTION_SERVICE } }, 20_000)
    try {
      await bump(mounted, 100_000)
      const frame = mounted.harness.terminal.text()
      assert.match(frame, /Run \/compact to summarize/u, frame)
      assert.match(frame, /100,000 \/ 128,000 tokens/u, frame)
    } finally {
      await unmount(mounted)
    }
  })

  it('offers the fallback when the preset composes no compaction', async () => {
    // `/compact` is registered either way — `/help` and the README table have to
    // be stable — so a warning that read the command list would send this user
    // to a refusal instead of to a way out.
    const mounted = await mount({}, 20_000)
    try {
      await bump(mounted, 100_000)
      const frame = mounted.harness.terminal.text()
      assert.match(frame, /composes no compaction service/u, frame)
      assert.match(frame, /\/new/u, frame)
      assert.ok(!frame.includes('Run /compact'), `and never sends them to a command that cannot help:\n${frame}`)
    } finally {
      await unmount(mounted)
    }
  })

  it('escalates to a second, stronger row rather than repeating the first', async () => {
    const mounted = await mount({}, 20_000)
    try {
      await bump(mounted, 100_000)
      await bump(mounted, 120_000)
      const frame = mounted.harness.terminal.text()
      assert.match(frame, /6% context left/u, frame)
      // The first row is history, not a live indicator: it stays where it was
      // written, and the escalation is a new row under it.
      assert.equal(countOf(frame, 'Context low'), 1, frame)
      assert.equal(countOf(frame, 'Context nearly full'), 1, frame)
    } finally {
      await unmount(mounted)
    }
  })

  it('goes quiet while a compaction is running', async () => {
    const mounted = await mount({}, 20_000)
    try {
      await bump(mounted, 100_000)
      mounted.harness.session.append('compaction/start', {
        compactionId: CompactionId('compact-live'),
        turn: null,
      })
      // A live compaction is already the answer to the warning: escalating into
      // it would announce a problem that is being fixed.
      await bump(mounted, 120_000)
      const frame = mounted.harness.terminal.text()
      assert.equal(countOf(frame, 'Context nearly full'), 0, frame)
    } finally {
      await unmount(mounted)
    }
  })

  it('re-arms after a compaction drops the pressure', async () => {
    const mounted = await mount({}, 20_000)
    try {
      await bump(mounted, 100_000)
      assert.equal(countOf(mounted.harness.terminal.text(), 'Context low'), 1)

      mounted.set(20_000)
      landCompaction(mounted.harness.session, 'compact-relief')
      await delay(SETTLE_MS)
      const relieved = mounted.harness.terminal.text()
      assert.match(relieved, /16% context/u, relieved)
      assert.ok(!relieved.includes('16% context left'), `and back to the used-percentage:\n${relieved}`)

      await bump(mounted, 100_000)
      assert.equal(countOf(mounted.harness.terminal.text(), 'Context low'), 2,
        mounted.harness.terminal.text())
    } finally {
      await unmount(mounted)
    }
  })

  it('stays silent for a route whose window has not resolved', async () => {
    const mounted = await mount({
      catalog: {
        providers: [{ id: 'deepseek-official', name: 'DeepSeek' }],
        models: [{ provider: 'deepseek-official', id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }],
        // Shaped like the host's LlmError, but built here: the two packages come
        // from different installations, so the class identity never matches.
        resolveModelInfo: () => Promise.reject(
          Object.assign(new Error('no adapter registered'), { code: 'NO_ADAPTER' }),
        ),
      },
    }, 120_000)
    try {
      await delay(SETTLE_MS)
      const frame = mounted.harness.terminal.text()
      assert.ok(!frame.includes('% context'), `no window, no percentage:\n${frame}`)
      assert.ok(!frame.includes('context left'), `and no countdown either:\n${frame}`)
      assert.ok(!frame.includes('Context low'), `and nothing announced:\n${frame}`)
    } finally {
      await unmount(mounted)
    }
  })

  it('reads both rows out of the message table', async () => {
    setLocale('zh')
    const mounted = await mount({}, 20_000)
    try {
      await bump(mounted, 100_000)
      const frame = mounted.harness.terminal.text()
      assert.match(frame, /上下文剩 22%/u, frame)
      assert.match(frame, /上下文快满了/u, frame)
    } finally {
      await unmount(mounted)
    }
  })
})

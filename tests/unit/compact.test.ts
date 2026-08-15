/**
 * `/compact`: one explicit reduction of this session's history.
 *
 * Two halves, for two different risks. The pure half pins the order of the
 * refusals — an argument is turned away before any backend is touched, and a
 * classified backend failure has to be recognized across package copies, where
 * `instanceof` is false. The mounted half pins what the user actually gets: the
 * seam receives the live agent, Esc stops a running compaction, and the summary
 * the compaction wrote is reachable from the transcript instead of being folded
 * and thrown away.
 * @module dsh-tui/tests/unit/compact
 */

import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { compactCheckpointSource, CompactionId } from '@deepseek-ai/dsh-compaction'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import {
  createTuiTestHarness,
  disposeTuiTestHarness,
  setAgentStatus,
  tuiEntryAvailable,
  type TuiHarness,
  type TuiHarnessOptions,
} from '../harness.ts'
import { HeadlessTerminal } from '../headless-terminal.ts'
import {
  compactFailureText,
  manualCompactionCode,
  runCompactCommand,
  type CompactCommandDeps,
  type CompactionOutcome,
  type ManualCompactionErrorCode,
} from '../../src/chat/compact.ts'
import { setLocale, t } from '../../src/i18n/index.ts'

/** `src/index.ts` is landed by a separate port; without it the end-to-end suite cannot run. */
const entryAvailable = await tuiEntryAvailable()
const skipWithoutEntry = entryAvailable
  ? false
  : 'requires src/index.ts to export createTuiChat(ctx, config, runtime)'

/** Literal editor prefix, so a frame assertion never depends on prompt-value registrations. */
const INPUT_PROMPT = 'dsh> '

/** A command on a fiber and the notice it appends: outwait both. */
const SETTLE_MS = 60

/** One engine whose every call is recorded, so a refusal can be shown to be local. */
interface FakeEngine {
  compactNow(agent: unknown, signal: AbortSignal, commandId?: unknown): Promise<CompactionOutcome | null>
  /** Every call, in order. */
  readonly calls: { agent: unknown; signal: AbortSignal; commandId: unknown }[]
}

/**
 * Build an engine whose result the test supplies.
 * @param respond - what one `compactNow` does; the recorded call is passed through.
 * @returns the engine and its call log.
 */
function fakeEngine(
  respond: (call: { agent: unknown; signal: AbortSignal; commandId: unknown }) =>
  Promise<CompactionOutcome | null>,
): FakeEngine {
  const calls: FakeEngine['calls'] = []
  return {
    calls,
    compactNow(agent, signal, commandId) {
      const call = { agent, signal, commandId }
      calls.push(call)
      return respond(call)
    },
  }
}

/** A successful outcome with the shape the seam documents. */
const OUTCOME: CompactionOutcome = { shadowedSeqs: [1, 2, 3], shadowedTokenCount: 4_210, summarySeq: 9 }

/**
 * Assemble the deps one call needs.
 * @param engine - the engine to serve, or `undefined` for a session that mounts none.
 * @param status - the agent lifecycle state the pre-check reads.
 * @returns the deps object.
 */
function deps(engine: FakeEngine | undefined, status = 'idle'): CompactCommandDeps {
  return { engine: () => engine, agent: { status }, expandKey: () => 'Ctrl+O' }
}

/** The classified failure a backend from another package copy throws. */
function foreignFailure(code: ManualCompactionErrorCode): Error {
  // Deliberately NOT a `ManualCompactionError` instance: the engine is mounted
  // by the installed app and throws its own copy's class, so `instanceof` is
  // false for a genuine failure and the duck type is the only thing that holds.
  return Object.assign(new Error(`backend diagnostic: ${code}`), { name: 'ManualCompactionError', code })
}

describe('runCompactCommand', () => {
  afterEach(() => { setLocale('en') })

  it('refuses an argument before any backend is touched', async () => {
    const engine = fakeEngine(() => Promise.resolve(OUTCOME))
    const result = await runCompactCommand(deps(engine), ' make it short', new AbortController().signal)
    assert.equal(result.kind, 'error')
    assert.equal(result.text, t('compact.usage'))
    assert.equal(engine.calls.length, 0, 'the seam takes no instructions, so nothing is sent to it')
  })

  it('reports a session that composes no compaction service', async () => {
    const result = await runCompactCommand(deps(undefined), '', new AbortController().signal)
    assert.equal(result.kind, 'error')
    assert.equal(result.text, t('compact.unavailable'))
  })

  it('names what a busy session is doing instead of claiming a maintenance slot', async () => {
    const engine = fakeEngine(() => Promise.resolve(OUTCOME))
    const result = await runCompactCommand(deps(engine, 'running'), '', new AbortController().signal)
    assert.equal(result.kind, 'error')
    assert.match(result.text, /running/u)
    assert.equal(engine.calls.length, 0, 'the agent is never asked to run maintenance')
  })

  it('reports a session with nothing safe to stop showing the model', async () => {
    const engine = fakeEngine(() => Promise.resolve(null))
    const result = await runCompactCommand(deps(engine), '', new AbortController().signal)
    assert.equal(result.kind, 'success')
    assert.equal(result.text, t('compact.nothing'))
  })

  it('reports what was compacted and where the summary is', async () => {
    const engine = fakeEngine(() => Promise.resolve(OUTCOME))
    const result = await runCompactCommand(deps(engine), '', new AbortController().signal, 'cmd-1')
    assert.equal(result.kind, 'success')
    assert.ok(result.text !== undefined)
    assert.match(result.text, /3 history items/u)
    assert.match(result.text, /4\.2k tokens/u)
    assert.match(result.text, /ctrl\+o/u)
    assert.equal(result.kind === 'success' ? result.sourceEventSeq : undefined, 9,
      'the summary event owns the richer presentation')
    assert.equal(engine.calls[0]?.commandId, 'cmd-1', 'the pairing id reaches the backend')
  })

  it('counts one shadowed item in the singular', async () => {
    const engine = fakeEngine(() => Promise.resolve({ shadowedSeqs: [4], shadowedTokenCount: 900, summarySeq: 5 }))
    const result = await runCompactCommand(deps(engine), '', new AbortController().signal)
    assert.ok(result.text !== undefined)
    assert.match(result.text, /1 history item \(/u)
  })

  it('classifies every backend failure across package copies', async () => {
    const cases: [ManualCompactionErrorCode, string][] = [
      ['busy', t('compact.error.busy')],
      ['cancelled', t('compact.cancelled')],
      ['changed', t('compact.error.changed')],
      ['summary', t('compact.error.summary')],
      ['commit', t('compact.error.commit')],
      ['persistence', t('compact.error.persistence')],
    ]
    for (const [code, expected] of cases) {
      const error = foreignFailure(code)
      assert.equal(error instanceof Error, true)
      assert.equal(manualCompactionCode(error), code, `a foreign ${code} is still recognized`)
      assert.equal(compactFailureText(code), expected)
      const engine = fakeEngine(() => Promise.reject(error))
      const result = await runCompactCommand(deps(engine), '', new AbortController().signal)
      assert.equal(result.kind, 'error')
      assert.equal(result.text, expected)
    }
  })

  it('ignores a name or a code that is not the seam\'s', () => {
    assert.equal(manualCompactionCode(new Error('plain')), undefined)
    assert.equal(manualCompactionCode('not an error'), undefined)
    assert.equal(
      manualCompactionCode(Object.assign(new Error('x'), { name: 'ManualCompactionError', code: 'invented' })),
      undefined,
    )
  })

  it('answers a cancelled request as cancelled, whatever the backend threw', async () => {
    const controller = new AbortController()
    const engine = fakeEngine(() => {
      controller.abort(new Error('cancelled by the user'))
      return Promise.reject(foreignFailure('commit'))
    })
    const result = await runCompactCommand(deps(engine), '', controller.signal)
    assert.equal(result.kind, 'error')
    assert.equal(result.text, t('compact.cancelled'))
  })

  it('carries an unexpected failure through verbatim', async () => {
    const engine = fakeEngine(() => Promise.reject(new Error('boom')))
    const result = await runCompactCommand(deps(engine), '', new AbortController().signal)
    assert.equal(result.kind, 'error')
    assert.match(result.text, /boom/u)
    assert.equal(result.text, t('compact.failed', { error: 'boom' }), 'framed by the table, not by a literal')
  })

  it('renders its outcome from the message table, not from English literals', async () => {
    setLocale('zh')
    const engine = fakeEngine(() => Promise.resolve(OUTCOME))
    const result = await runCompactCommand(deps(engine), '', new AbortController().signal)
    assert.equal(result.kind, 'success')
    assert.ok(result.text !== undefined)
    assert.match(result.text, /已压缩 3 条历史/u)
    const refused = await runCompactCommand(deps(engine), 'x', new AbortController().signal)
    assert.match(refused.text ?? '', /不接受参数/u)
  })
})

type Harness = TuiHarness<HeadlessTerminal, (code: number) => void>

async function mount(options: TuiHarnessOptions = {}): Promise<Harness> {
  const terminal = new HeadlessTerminal(100, 32)
  const before = terminal.frames
  const harness = await createTuiTestHarness(terminal, () => {}, {
    cwd: '/workspace/project',
    ...options,
    config: {
      title: 'DSH compact',
      welcome: 'ready.',
      ...options.config,
      theme: { color: false, inputPrompt: INPUT_PROMPT, ...options.config?.theme },
    },
  })
  await terminal.waitForFrame(before)
  return harness
}

async function unmount(harness: Harness): Promise<void> {
  await disposeTuiTestHarness(harness)
  await harness.terminal.dispose()
}

/** Run one slash command through the registry the editor submits into. */
async function run(harness: Harness, line: string): Promise<string | undefined> {
  const execution = await harness.ctx.commands.execute(harness.agent, line, AbortSignal.timeout(5_000))
  return execution?.result.text
}

/** `TuiController.submit` is the typed-line path; the harness handle only declares disposal. */
interface SubmitHandle {
  submit(text: string): void
}

describe('TUI /compact', { skip: skipWithoutEntry }, () => {
  afterEach(() => { setLocale('en') })

  it('registers into the same list /help and autocomplete read', async () => {
    // Tall enough for the whole `/help` page: the command table sits below the
    // shortcut table, and a scrolled panel would make this a scrolling test.
    const terminal = new HeadlessTerminal(120, 80)
    const before = terminal.frames
    const harness = await createTuiTestHarness(terminal, () => {}, {
      cwd: '/workspace/project',
      services: { compaction: fakeEngine(() => Promise.resolve(OUTCOME)) },
      config: { title: 'DSH compact', welcome: 'ready.', theme: { color: false, inputPrompt: INPUT_PROMPT } },
    })
    await terminal.waitForFrame(before)
    try {
      const names = harness.ctx.commands.list(harness.agent).map(command => command.name)
      assert.ok(names.includes('compact'), `the command list carries it: ${names.join(', ')}`)
      // `/help` renders the description through the message table, so `/lang`
      // moves it; the registry keeps its one English copy for other clients.
      setLocale('zh')
      ;(harness.controller as unknown as SubmitHandle).submit('/help')
      await delay(SETTLE_MS)
      const frame = terminal.text()
      assert.match(frame, /\/compact/u, frame)
      assert.match(frame, /把更早的对话历史压缩成一段摘要/u, frame)
    } finally {
      await disposeTuiTestHarness(harness)
      await terminal.dispose()
    }
  })

  it('hands the live agent and a pairing id to the compaction seam', async () => {
    const engine = fakeEngine(() => Promise.resolve(OUTCOME))
    const harness = await mount({ services: { compaction: engine } })
    try {
      await run(harness, '/compact')
      assert.equal(engine.calls.length, 1)
      // The seam requires a `ManualCompactAgentContext`: the agent itself, not
      // a projection of it, because the backend claims its idle slot.
      assert.equal(engine.calls[0]?.agent, harness.agent)
      assert.equal(typeof engine.calls[0]?.commandId, 'string')
    } finally {
      await unmount(harness)
    }
  })

  it('shows the stopwatch while it runs and the outcome when it lands', async () => {
    const compactionId = CompactionId('compact-run')
    let settle: ((outcome: CompactionOutcome) => void) | undefined
    const engine = fakeEngine(() => new Promise<CompactionOutcome>((resolve) => { settle = resolve }))
    const harness = await mount({ services: { compaction: engine } })
    try {
      // Typed, not dispatched: the outcome reaches the transcript through the
      // editor's own command path, which is the only one that appends a notice.
      ;(harness.controller as unknown as SubmitHandle).submit('/compact')
      await delay(SETTLE_MS)
      harness.session.append('compaction/start', { compactionId, turn: null })
      await delay(SETTLE_MS)
      assert.match(harness.terminal.text(), /Context being compacted/u, harness.terminal.text())

      harness.session.append('compaction/end', { compactionId, turn: null })
      settle?.({ shadowedSeqs: [1, 2], shadowedTokenCount: 1_200, summarySeq: 7 })
      await delay(SETTLE_MS)
      const frame = harness.terminal.text()
      assert.ok(!frame.includes('Context being compacted'), `the stopwatch clears:\n${frame}`)
      assert.match(frame, /Compacted 2 history items/u, frame)
      assert.match(frame, /ctrl\+o/u, frame)
    } finally {
      await unmount(harness)
    }
  })

  it('cancels a running compaction on Esc and says so', async () => {
    let seen: AbortSignal | undefined
    const engine = fakeEngine(call => new Promise<CompactionOutcome>((_resolve, reject) => {
      seen = call.signal
      call.signal.addEventListener('abort', () => { reject(call.signal.reason as Error) }, { once: true })
    }))
    const harness = await mount({ services: { compaction: engine } })
    try {
      // Idle throughout: a manual compaction only runs while the agent is idle,
      // which is what keeps this rung clear of the turn-cancel one above it.
      setAgentStatus(harness.agent, 'idle')
      const running = run(harness, '/compact')
      await delay(SETTLE_MS)
      harness.terminal.send('\x1b')
      const text = await running
      await delay(SETTLE_MS)
      assert.equal(seen?.aborted, true, 'the backend request is the thing that stops')
      assert.equal(text, t('compact.cancelled'))
      assert.match(harness.terminal.text(), /Cancelling the compaction/u, harness.terminal.text())
    } finally {
      await unmount(harness)
    }
  })

  it('answers Esc with one sentence, in one language', async () => {
    // The backend closes an aborted transaction by appending `compaction/end`
    // with the abort reason on it. That is a diagnostic for the log, not a
    // second answer for the user: the command already said what happened, so a
    // raw "Compaction failed: compaction cancelled by the user" beside it would
    // contradict it — and in English, under a Chinese terminal.
    const compactionId = CompactionId('compact-esc')
    const engine = fakeEngine(call => new Promise<CompactionOutcome>((_resolve, reject) => {
      call.signal.addEventListener('abort', () => { reject(call.signal.reason as Error) }, { once: true })
    }))
    const harness = await mount({ services: { compaction: engine } })
    try {
      setLocale('zh')
      setAgentStatus(harness.agent, 'idle')
      // Typed rather than dispatched: the transcript only carries the outcome
      // of a command the editor submitted.
      ;(harness.controller as unknown as SubmitHandle).submit('/compact')
      await delay(SETTLE_MS)
      const sourceCommandId = engine.calls[0]?.commandId as CommandId
      assert.ok(sourceCommandId !== undefined, 'the seam was given a pairing id')
      harness.session.append('compaction/start', { compactionId, sourceCommandId, turn: null })
      await delay(SETTLE_MS)

      harness.terminal.send('\x1b')
      await delay(SETTLE_MS)
      harness.session.append('compaction/end', {
        compactionId,
        sourceCommandId,
        turn: null,
        error: 'compaction cancelled by the user',
      })
      await delay(SETTLE_MS)

      const frame = harness.terminal.text()
      assert.match(frame.replace(/\s+/gu, ' '), /已取消压缩/u, frame)
      assert.doesNotMatch(frame, /Compaction failed|cancelled by the user/u)
    } finally {
      setLocale('en')
      await unmount(harness)
    }
  })

  it('refuses a second compaction locally while one of ours is in flight', async () => {
    let settle: ((outcome: CompactionOutcome) => void) | undefined
    const engine = fakeEngine(() => new Promise<CompactionOutcome>((resolve) => { settle = resolve }))
    const harness = await mount({ services: { compaction: engine } })
    try {
      const running = run(harness, '/compact')
      await delay(SETTLE_MS)
      assert.equal(await run(harness, '/compact'), t('compact.inFlight'))
      assert.equal(engine.calls.length, 1, 'the backend never sees the second one')
      settle?.(OUTCOME)
      await running
    } finally {
      await unmount(harness)
    }
  })
})

/**
 * Append the five events one landed compaction writes.
 * @param session - the session to write into.
 * @param id - this transaction's identity.
 * @param summary - the summary text the backend produced, or '' for a resumed
 *   log that starts after its own `compaction/summary`.
 */
function landCompaction(session: Session, id: string, summary: string): void {
  const compactionId = CompactionId(id)
  const first = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'FIRST-PROMPT' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  const second = session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'FIRST-ANSWER' }],
      source: { kind: 'model', provider: 'mock', model: 'test-model' },
    }),
  }, { surfaceOp: 'append' })
  session.append('compaction/start', { compactionId, turn: null })
  if (summary !== '') {
    session.append('compaction/summary', {
      compactionId,
      summary: [{ type: 'text', text: summary }],
      shadowedRange: { start: first.seq, end: second.seq },
      shadowedSeqs: [first.seq, second.seq],
      shadowedTokenCount: 42,
      provider: 'mock',
      model: 'test-model',
    })
  }
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'summary of earlier conversation' }],
    source: compactCheckpointSource(compactionId),
  }), {
    surfaceOp: { op: 'replace', start: first.seq, end: second.seq },
    sourceEventSeqs: [first.seq, second.seq],
  })
  session.append('compaction/end', { compactionId, turn: null })
}

describe('compaction summary in the transcript', { skip: skipWithoutEntry }, () => {
  it('keeps the summary behind Ctrl+O and says which key opens it', async () => {
    const harness = await mount({
      beforeMount(session) { landCompaction(session, 'compact-view', 'SUMMARY-BODY-LINE') },
    })
    try {
      await delay(SETTLE_MS)
      const collapsed = harness.terminal.text()
      assert.match(collapsed, /earlier context was compacted/u, collapsed)
      assert.match(collapsed, /\(ctrl\+o to expand\)/u, collapsed)
      assert.ok(!collapsed.includes('Compaction summary'), `no summary card by default:\n${collapsed}`)
      assert.ok(!collapsed.includes('SUMMARY-BODY-LINE'), `and none of its body:\n${collapsed}`)

      // Expanded is where a user goes to see what the model was actually sent,
      // and the summary is exactly that: it opens under its own marker.
      harness.terminal.send('\x0f')
      await delay(SETTLE_MS)
      const rows = harness.terminal.text().split('\n').map(row => row.trimEnd())
      const frame = rows.join('\n')
      const at = (needle: string): number => rows.findIndex(row => row.includes(needle))
      assert.ok(at('Compaction summary') > at('earlier context was compacted'),
        `the card opens under the marker:\n${frame}`)
      assert.ok(at('SUMMARY-BODY-LINE') > at('Compaction summary'), `body under header:\n${frame}`)
      assert.ok(!frame.includes('to expand'),
        `and the marker stops advertising a key that is already pressed:\n${frame}`)

      // Hidden drops the card with the rest of the traffic; the marker is a
      // conversation boundary and stays in every phase.
      harness.terminal.send('\x0f')
      await delay(SETTLE_MS)
      const hidden = harness.terminal.text()
      assert.ok(!hidden.includes('Compaction summary'), `hidden drops the card:\n${hidden}`)
      assert.match(hidden, /earlier context was compacted/u, hidden)

      // And back to the phase the session opened on: the marker is keyed per
      // phase, so a stale cached row would surface here as the wrong text.
      harness.terminal.send('\x0f')
      await delay(SETTLE_MS)
      const restored = harness.terminal.text()
      assert.ok(!restored.includes('Compaction summary'), `collapsed shows no card:\n${restored}`)
      assert.match(restored, /\(ctrl\+o to expand\)/u, restored)

      // A second lap has to build the open phase again rather than reuse the
      // closed row the cache is still holding under the node's own key.
      harness.terminal.send('\x0f')
      await delay(SETTLE_MS)
      const reopened = harness.terminal.text()
      assert.match(reopened, /Compaction summary/u, reopened)
      assert.match(reopened, /SUMMARY-BODY-LINE/u, reopened)
      assert.ok(!reopened.includes('to expand'), `and the hint stays off while it is open:\n${reopened}`)
    } finally {
      await unmount(harness)
    }
  })

  it('offers no key for a compaction whose summary this log never carried', async () => {
    const harness = await mount({
      beforeMount(session) { landCompaction(session, 'compact-bare', '') },
    })
    try {
      await delay(SETTLE_MS)
      const collapsed = harness.terminal.text()
      assert.match(collapsed, /earlier context was compacted/u, collapsed)
      assert.ok(!collapsed.includes('to expand'), `nothing to expand, so no hint:\n${collapsed}`)

      harness.terminal.send('\x0f')
      await delay(SETTLE_MS)
      const expanded = harness.terminal.text()
      assert.ok(!expanded.includes('Compaction summary'), `and no empty card either:\n${expanded}`)
      assert.match(expanded, /earlier context was compacted/u, expanded)
    } finally {
      await unmount(harness)
    }
  })
})

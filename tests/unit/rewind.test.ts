/**
 * Rewind: which prompts a session can go back to, where a fork of it is allowed
 * to cut, and what the two runtimes — one that can fork, one that cannot — do
 * with the prompt the user picked.
 *
 * The one rule every case here defends: a rewind moves the conversation and
 * never the working tree. dsh keeps no file snapshots, so nothing this surface
 * says or does may suggest a file will be restored.
 * @module dsh-tui/tests/unit/rewind
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { Context } from '@deepseek-ai/cordis'
import {
  appendUser,
  createTuiTestHarness,
  disposeTuiTestHarness,
  tuiEntryAvailable,
  type TuiHarness,
  type TuiHarnessOptions,
} from '../harness.ts'
import { HeadlessTerminal } from '../headless-terminal.ts'
import { forkSeedLength, hasRewindTarget, rewindTargets } from '../../src/chat/rewind.ts'
import type { TuiForkRequest } from '../../src/runtime.ts'

/** Literal editor prefix, so a frame assertion never depends on prompt-value registrations. */
const INPUT_PROMPT = 'rewind> '

const ESC = '\x1b'
const ENTER = '\r'
const UP = '\x1b[A'

/** Notices and the fork call settle across a few awaits; outwait them. */
const SETTLE_MS = 40

/** `src/index.ts` is landed by a separate port; without it the end-to-end suite cannot run. */
const entryAvailable = await tuiEntryAvailable()
const skipWithoutEntry = entryAvailable
  ? false
  : 'requires src/index.ts to export createTuiChat(ctx, config, runtime)'

/**
 * Build a session log by hand: two complete turns around three prompts, one of
 * which was sent inside a turn that never ended.
 * @returns the live session, for its events.
 */
async function seededSession(): Promise<Session> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const session = ctx.sessions.create(SessionId('rewind-fixture'), { meta: { cwd: '/workspace' } })
  const answer = (turn: number): void => {
    session.append('assistant/message', {
      turn,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: `answer ${String(turn)}` }],
        source: { kind: 'model', provider: 'mock', model: 'deepseek-v4-flash' },
      }),
    }, { surfaceOp: 'append' })
  }
  const prompt = (text: string): void => {
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
  }
  session.append('turn/start', { turn: 1 })
  prompt('first prompt')
  answer(1)
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  session.append('turn/start', { turn: 2 })
  prompt('second prompt')
  answer(2)
  session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
  session.append('turn/start', { turn: 3 })
  prompt('third prompt')
  return session
}

/** The event log's types, for readable cut assertions. */
function types(events: readonly SessionEvent[]): string[] {
  return events.map(event => event.type)
}

describe('rewind targets', () => {
  it('lists the prompts a person typed, and nothing else', async () => {
    const session = await seededSession()
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'injected workspace snapshot' }],
      // Producer context is a `user/message` too; offering it as a rewind
      // target would put text in the editor that no human wrote.
      source: { kind: 'plugin', plugin: 'workspace', form: 'relay' },
    }), { surfaceOp: 'append' })

    assert.deepEqual(
      rewindTargets(session.events).map(target => target.text),
      ['first prompt', 'second prompt', 'third prompt'],
    )
  })
})

describe('the cheap "is there anything to rewind to" check', () => {
  it('agrees with the full list, both ways', async () => {
    const session = await seededSession()
    assert.equal(hasRewindTarget(session.events), true)
    assert.equal(hasRewindTarget(session.events.filter(event => event.type !== 'user/message')), false)
  })
})

describe('fork boundaries', () => {
  it('cuts after the last completed turn before the chosen prompt', async () => {
    const session = await seededSession()
    const targets = rewindTargets(session.events)
    const second = targets[1]
    assert.ok(second !== undefined)

    const length = forkSeedLength(session.events, second.seq)
    assert.ok(length !== undefined)
    const seed = session.events.slice(0, length)
    // A seed must contain no open turn: the last event is the `turn/end` that
    // closed the turn before the prompt being rewound to.
    assert.equal(types(seed).at(-1), 'turn/end')
    assert.equal(seed.filter(event => event.type === 'turn/start').length, 1)
  })

  it('cuts at the log head for the first prompt, an empty but legal seed', async () => {
    const session = await seededSession()
    const first = rewindTargets(session.events)[0]
    assert.ok(first !== undefined)

    // The fixture's log opens with the first prompt's own `turn/start`, so
    // nothing before the prompt may survive the cut — and an empty prefix is
    // exactly what `SessionStore.fork` accepts as "fork an empty child".
    assert.equal(forkSeedLength(session.events, first.seq), 0)
  })

  it('keeps between-turn events after the closed turn in the seed', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('rewind-between'), { meta: { cwd: '/workspace' } })
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'first prompt' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    // Producer context relayed between turns: legal at a fork boundary, so a
    // cut before the next turn must keep it rather than retreat to `turn/end`.
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'injected between turns' }],
      source: { kind: 'plugin', plugin: 'workspace', form: 'relay' },
    }), { surfaceOp: 'append' })
    session.append('turn/start', { turn: 2 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'second prompt' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })

    const second = rewindTargets(session.events).at(-1)
    assert.ok(second !== undefined)
    const length = forkSeedLength(session.events, second.seq)
    const seed = session.events.slice(0, length)
    assert.equal(types(seed).at(-1), 'user/message')
    assert.ok(!seed.some(event => event.type === 'turn/start' && event.data.turn === 2))
  })

  it('never cuts inside a turn that was left open', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('rewind-open'), { meta: { cwd: '/workspace' } })
    // Turn 1 never ends — the shape a crash leaves behind.
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'first prompt' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('turn/start', { turn: 2 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'second prompt' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })

    const second = rewindTargets(session.events).at(-1)
    assert.ok(second !== undefined)
    // No `turn/end` was ever written, so the only safe boundary is the log head.
    assert.equal(forkSeedLength(session.events, second.seq), 0)
  })

  it('drops the turn the chosen prompt belongs to, whatever came after it', async () => {
    const session = await seededSession()
    const third = rewindTargets(session.events)[2]
    assert.ok(third !== undefined)

    const length = forkSeedLength(session.events, third.seq)
    assert.ok(length !== undefined)
    const seed = session.events.slice(0, length)
    assert.equal(seed.filter(event => event.type === 'turn/end').length, 2)
    assert.ok(!seed.some(event => event.seq >= third.seq))
  })
})

type RewindHarness = TuiHarness<HeadlessTerminal, (code: number) => void>

async function mount(options: TuiHarnessOptions = {}): Promise<RewindHarness> {
  const terminal = new HeadlessTerminal(96, 32)
  const before = terminal.frames
  const harness = await createTuiTestHarness(terminal, () => {}, {
    cwd: '/workspace/project',
    ...options,
    config: {
      title: 'DSH rewind',
      welcome: 'ready.',
      ...options.config,
      theme: { color: false, inputPrompt: INPUT_PROMPT, ...options.config?.theme },
    },
  })
  await terminal.waitForFrame(before)
  return harness
}

async function unmount(harness: RewindHarness): Promise<void> {
  await disposeTuiTestHarness(harness)
  await harness.terminal.dispose()
}

async function press(harness: RewindHarness, data: string): Promise<string> {
  const before = harness.terminal.frames
  harness.terminal.send(data)
  await harness.terminal.waitForFrame(before)
  return harness.terminal.text()
}

/** The frame with its own line wrapping collapsed, so a sentence reads as a sentence. */
function unwrapped(frame: string): string {
  return frame.replace(/\s+/gu, ' ')
}

/** Seed two prompts around a completed turn, which is the shape a fork needs. */
function seedTwoTurns(session: Session): void {
  session.append('turn/start', { turn: 1 })
  appendUser(session, 'the first thing I asked')
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'the first answer' }],
      source: { kind: 'model', provider: 'mock', model: 'deepseek-v4-flash' },
    }),
  }, { surfaceOp: 'append' })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  session.append('turn/start', { turn: 2 })
  appendUser(session, 'the second thing I asked')
}

describe('the Rewind panel', { skip: skipWithoutEntry }, () => {
  it('forks the session at the chosen prompt and carries its text into the fork', async () => {
    const forks: TuiForkRequest[] = []
    const harness = await mount({
      omitInitialLifecycle: true,
      beforeMount: seedTwoTurns,
      // A host that owns the agent handle: it never returns, exactly as the
      // real one does not.
      handoffFork: (fork) => {
        forks.push(fork)
        return new Promise<never>(() => {})
      },
    })
    try {
      await press(harness, '/rewind')
      const opened = await press(harness, ENTER)
      assert.match(unwrapped(opened), /Rewind/u)
      assert.match(unwrapped(opened), /Fork the conversation to the point before…/u)

      await press(harness, ENTER)
      await delay(SETTLE_MS)

      assert.equal(forks.length, 1)
      const fork = forks[0]
      assert.ok(fork !== undefined)
      // The newest prompt is preselected, and the seed ends on the completed
      // turn before it — never inside the turn it belonged to.
      assert.equal(fork.draft, 'the second thing I asked')
      assert.equal(types(fork.seed).at(-1), 'turn/end')
      assert.equal(fork.parentSession, harness.session.id)
      // The source session is untouched: a rewind branches, it does not edit.
      assert.ok(harness.session.events.length > fork.seed.length)
      assert.match(unwrapped(harness.terminal.text()), /the original stays resumable/u)
    } finally {
      await unmount(harness)
    }
  })

  it('picks the older prompt when the user moves up the list', async () => {
    const forks: TuiForkRequest[] = []
    const harness = await mount({
      omitInitialLifecycle: true,
      beforeMount: seedTwoTurns,
      handoffFork: (fork) => {
        forks.push(fork)
        return new Promise<never>(() => {})
      },
    })
    try {
      await press(harness, '/rewind')
      await press(harness, ENTER)
      await press(harness, UP)
      await press(harness, ENTER)
      await delay(SETTLE_MS)

      // The first prompt has no completed turn before it, so the fork's seed
      // is the log head: an empty prefix, which is a legal fork of the session
      // back to before anything was asked.
      assert.equal(forks.length, 1)
      const fork = forks[0]
      assert.ok(fork !== undefined)
      assert.equal(fork.draft, 'the first thing I asked')
      assert.equal(fork.seed.length, 0)
      assert.match(unwrapped(harness.terminal.text()), /the original stays resumable/u)
    } finally {
      await unmount(harness)
    }
  })

  it('degrades to the editor, and says so, on a runtime that cannot fork', async () => {
    const harness = await mount({ omitInitialLifecycle: true, beforeMount: seedTwoTurns })
    try {
      await press(harness, '/rewind')
      const opened = await press(harness, ENTER)
      // The wording never promises the conversation will move on a runtime
      // where it cannot.
      assert.match(unwrapped(opened), /Bring an earlier prompt back to the editor…/u)
      assert.match(unwrapped(opened), /Files are never restored — dsh keeps no file checkpoints\./u)

      await press(harness, ENTER)
      await delay(SETTLE_MS)

      const frame = unwrapped(harness.terminal.text())
      assert.match(frame, /This runtime cannot fork a session, so the conversation above it is unchanged\./u)
      assert.match(frame, /rewind> the second thing I asked/u)
    } finally {
      await unmount(harness)
    }
  })

  it('explains itself on a session with nothing to rewind to', async () => {
    const harness = await mount()
    try {
      await press(harness, '/rewind')
      const opened = await press(harness, ENTER)
      assert.match(unwrapped(opened), /Nothing to rewind to yet\./u)

      const closed = await press(harness, ESC)
      assert.doesNotMatch(unwrapped(closed), /Nothing to rewind to yet\./u)
    } finally {
      await unmount(harness)
    }
  })
})

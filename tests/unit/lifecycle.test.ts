/**
 * Lifecycle safety: the ways a session ends, and the ways it refuses to.
 *
 * Every case here pins a state the terminal must be able to leave — a turn that
 * ignores its cancel, an unsent draft under Ctrl+D, an agent that left the
 * registry, a `--resume` that names nothing, a mount whose agent never arrives —
 * plus the two ordering rules that keep a submission from going somewhere the
 * user did not aim it (a leading space before a slash, a startup skill that has
 * not been sent yet).
 * @module dsh-tui/tests/unit/lifecycle
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import type { SkillDefinition, SkillSummary } from '@deepseek-ai/dsh-skill'
import type { Terminal } from '@earendil-works/pi-tui'
import {
  createTuiTestContext,
  createTuiTestHarness,
  disposeTuiTestHarness,
  messageText,
  setAgentStatus,
  tuiEntryAvailable,
  type TuiHarness,
  type TuiHarnessOptions,
} from '../harness.ts'
import { HeadlessTerminal } from '../headless-terminal.ts'
import { AGENT_START_TIMEOUT_MS, whenIdleOrTimeout } from '../../src/chat/lifecycle.ts'
import { mountTui, startupFailureMessage } from '../../src/index.ts'

/** `src/index.ts` is landed by a separate port; without it the end-to-end suite cannot run. */
const entryAvailable = await tuiEntryAvailable()
const skipWithoutEntry = entryAvailable
  ? false
  : 'requires src/index.ts to export createTuiChat(ctx, config, runtime)'

/** Literal editor prefix, so "the editor is on screen" needs no prompt registrations. */
const INPUT_PROMPT = 'dsh> '

/** Ctrl+C and Ctrl+D as the terminal delivers them. */
const CTRL_C = '\x03'
const CTRL_D = '\x04'

/** Shutdown, notices, and the exit hook settle across a few awaits; outwait them. */
const SETTLE_MS = 60

type LifecycleHarness = TuiHarness<HeadlessTerminal, (code: number) => void>

async function mount(
  options: TuiHarnessOptions = {},
  exit: (code: number) => void = () => {},
): Promise<LifecycleHarness> {
  const terminal = new HeadlessTerminal(100, 28)
  const before = terminal.frames
  const harness = await createTuiTestHarness(terminal, exit, {
    cwd: '/workspace/project',
    ...options,
    config: {
      title: 'DSH lifecycle',
      welcome: 'ready.',
      ...options.config,
      theme: { color: false, inputPrompt: INPUT_PROMPT, ...options.config?.theme },
    },
  })
  await terminal.waitForFrame(before)
  return harness
}

async function unmount(harness: LifecycleHarness): Promise<void> {
  await disposeTuiTestHarness(harness)
  await harness.terminal.dispose()
}

/**
 * Collapse the frame's own line wrapping, so a sentence can be asserted as the
 * sentence it is rather than as whatever the terminal width cut it into.
 * @param frame - the rendered screen.
 * @returns the same text on one line, with runs of whitespace collapsed.
 */
function unwrapped(frame: string): string {
  return frame.replace(/\s+/gu, ' ')
}

/** Every prompt the fake agent was handed, however it was routed. */
function delivered(harness: LifecycleHarness): string[] {
  return [
    ...harness.agent.sent.map(delivery => delivery.message),
    ...harness.agent.followups,
    ...harness.agent.steered,
  ].map(messageText)
}

describe('bounded idle wait', () => {
  it('reports the idle that arrived', async () => {
    assert.equal(await whenIdleOrTimeout(Promise.resolve(), 1_000), 'idle')
  })

  it('stops waiting on a turn that never reaches idle', async () => {
    // The exit path's whole reason for existing: an unbounded wait on a driver
    // that ignores its cancel never settles, and the session it was leaving
    // stays open forever.
    assert.equal(await whenIdleOrTimeout(new Promise<void>(() => {}), 5), 'timeout')
  })

  it('treats a rejected wait as settled, so a failure cannot strand the exit', async () => {
    assert.equal(await whenIdleOrTimeout(Promise.reject(new Error('agent detached')), 1_000), 'idle')
  })
})

describe('startup failure reporting', () => {
  it('names the session --resume could not open, and the way to start without it', () => {
    const message = startupFailureMessage({
      model: undefined,
      preset: undefined,
      resume: 'session-typo',
      continueLatest: false,
      print: undefined,
      initialPrompt: undefined,
    }, new Error('session "session-typo" not found'))
    assert.match(message, /cannot resume session "session-typo"/)
    assert.match(message, /session "session-typo" not found/)
    assert.match(message, /--resume/, 'the message names the flag to drop')
    assert.ok(message.endsWith('\n'), 'the line is terminated for a raw terminal write')
  })

  it('answers --continue in its own terms', () => {
    const message = startupFailureMessage({
      model: undefined,
      preset: undefined,
      resume: undefined,
      continueLatest: true,
      print: undefined,
      initialPrompt: undefined,
    }, new Error('no persisted session'))
    assert.match(message, /cannot continue the most recent session/)
    assert.doesNotMatch(message, /--resume/)
  })

  it('falls back to a plain start failure when no session was selected', () => {
    const message = startupFailureMessage({
      model: undefined,
      preset: undefined,
      resume: undefined,
      continueLatest: false,
      print: undefined,
      initialPrompt: undefined,
    }, new Error('registry unavailable'))
    assert.match(message, /cannot start a session: registry unavailable/)
  })
})

describe('mountTui stall', () => {
  it('gives up on an agent that is never created, instead of waiting forever', async (t) => {
    // A provider that deadlocks while initializing emits neither `agent/created`
    // nor `agent-loop/config-start-failed`, and the mount used to wait on both
    // with no bound: no UI, no output, no exit.
    const { ctx } = await createTuiTestContext()
    const writes: string[] = []
    const exits: number[] = []
    const terminal = { write(text: string): void { writes.push(text) } } as unknown as Terminal
    t.mock.timers.enable({ apis: ['setTimeout'] })
    try {
      mountTui(ctx, { sessionId: 'never-created' }, { terminal, exit: (code) => { exits.push(code) } })
      t.mock.timers.tick(AGENT_START_TIMEOUT_MS)

      assert.deepEqual(exits, [1])
      const report = writes.join('')
      assert.match(report, /session "never-created" failed to start/)
      assert.match(report, /no agent was created within/, `the report says what stalled:\n${report}`)
    } finally {
      t.mock.timers.reset()
      await ctx.fiber.dispose()
    }
  })
})

describe('TUI exit ladder', { skip: skipWithoutEntry }, () => {
  it('escalates to leaving when the turn will not cancel', async () => {
    const exits: number[] = []
    const harness = await mount({}, (code) => { exits.push(code) })
    try {
      setAgentStatus(harness.agent, 'running')
      harness.terminal.send(CTRL_C)
      await delay(SETTLE_MS)
      assert.deepEqual(exits, [], 'the first press is a cancel, as it is in Claude Code')

      harness.terminal.send(CTRL_C)
      await delay(SETTLE_MS)
      assert.deepEqual(exits, [], 'the second press repeats the cancel and only arms the way out')
      assert.match(
        harness.terminal.text(),
        /Press ctrl\+c again to exit without waiting for the turn\./,
        `the escape hatch names itself before it is used:\n${harness.terminal.text()}`,
      )
      assert.deepEqual(
        harness.agent.cancelled.map(record => record.cause),
        [{ kind: 'user' }, { kind: 'user' }],
      )

      harness.terminal.send(CTRL_C)
      await delay(SETTLE_MS)
      assert.deepEqual(exits, [0], 'the third press leaves without the turn that would not end')
    } finally {
      await unmount(harness)
    }
  })

  it('does not inherit an exit armed while idle into the next turn', async () => {
    const exits: number[] = []
    const harness = await mount({}, (code) => { exits.push(code) })
    try {
      // Armed at an empty prompt, then a turn starts before the second press:
      // that press means "cancel this", and treating it as the armed half of an
      // exit would end the session on a keystroke aimed at the turn.
      harness.terminal.send(CTRL_C)
      await delay(SETTLE_MS)
      setAgentStatus(harness.agent, 'running')
      harness.terminal.send(CTRL_C)
      await delay(SETTLE_MS)

      assert.deepEqual(exits, [])
      assert.deepEqual(harness.agent.cancelled.map(record => record.cause), [{ kind: 'user' }])
      assert.doesNotMatch(harness.terminal.text(), /again to exit/)
    } finally {
      await unmount(harness)
    }
  })

  it('holds the event loop open with nothing of its own after the exit', async () => {
    // The observable symptom this pins: in a PTY the two presses printed the
    // goodbye and the resume line, and then the process sat there for up to two
    // more seconds. Nothing was wrong with the shutdown — a startup query had
    // armed a two-second timer to answer a question nobody was listening for,
    // and a referenced timer is a reason for Node to stay alive whether or not
    // anything still wants it. Counting live timers rather than naming the
    // culprit keeps this true of the next one as well.
    const liveTimers = (): number =>
      process.getActiveResourcesInfo().filter(name => name === 'Timeout').length
    const before = liveTimers()
    const exits: number[] = []
    const harness = await mount({}, (code) => { exits.push(code) })
    try {
      harness.terminal.send(CTRL_C)
      await delay(SETTLE_MS)
      harness.terminal.send(CTRL_C)
      await delay(SETTLE_MS)
      assert.deepEqual(exits, [0], 'the two presses did leave')
      assert.ok(
        liveTimers() <= before,
        `the exited terminal holds no timer of its own: ${String(liveTimers())} live, ${String(before)} before it mounted`,
      )
    } finally {
      await unmount(harness)
    }
  })

  it('starts the ladder over once the turn does end', async () => {
    const exits: number[] = []
    const harness = await mount({}, (code) => { exits.push(code) })
    try {
      setAgentStatus(harness.agent, 'running')
      harness.terminal.send(CTRL_C)
      await delay(SETTLE_MS)
      setAgentStatus(harness.agent, 'idle')
      // A cancel that worked leaves nothing to escalate: this press is the
      // first half of the ordinary idle exit, not the escape hatch's second.
      harness.terminal.send(CTRL_C)
      await delay(SETTLE_MS)

      assert.deepEqual(exits, [])
      assert.match(harness.terminal.text(), /Press ctrl\+c again to exit\./)
    } finally {
      await unmount(harness)
    }
  })
})

describe('TUI ctrl+d', { skip: skipWithoutEntry }, () => {
  it('keeps an unsent draft instead of ending the session on top of it', async () => {
    const exits: number[] = []
    const harness = await mount({}, (code) => { exits.push(code) })
    try {
      harness.terminal.send('half a thought')
      await delay(SETTLE_MS)
      harness.terminal.send(CTRL_D)
      await delay(SETTLE_MS)

      assert.deepEqual(exits, [], 'Ctrl+D is the empty-prompt EOF it is in every shell')
      const frame = harness.terminal.text()
      assert.match(frame, /half a thought/, `the draft is still there:\n${frame}`)
      assert.match(frame, /clear it with ctrl\+c to exit/, `and the row says how to leave:\n${frame}`)

      // Clearing it is the deliberate second step, and then Ctrl+D means what
      // it always did.
      harness.terminal.send(CTRL_C)
      await delay(SETTLE_MS)
      harness.terminal.send(CTRL_D)
      await delay(SETTLE_MS)
      assert.deepEqual(exits, [0])
    } finally {
      await unmount(harness)
    }
  })
})

describe('TUI disposed agent', { skip: skipWithoutEntry }, () => {
  it('reports the way out, and keeps painting so the report is readable', async () => {
    const harness = await mount()
    try {
      agentEvents(harness.ctx, harness.agent).emit('agent/disposed', {})
      await delay(SETTLE_MS)

      const disposedFrame = harness.terminal.text()
      assert.match(unwrapped(disposedFrame), /was disposed; this session can no longer run a turn/)
      assert.match(
        unwrapped(disposedFrame),
        // The key is read from the manager, so the sentence names whatever is
        // bound rather than the literal it used to carry.
        /Run \/resume to open another session, or press Ctrl\+D to exit\./,
        `a dead session must name its exits:\n${disposedFrame}`,
      )

      // The refusal is a rendered row, not a silent append: marking the whole
      // terminal disposed here froze the screen that had to show it.
      harness.terminal.send('are you there')
      harness.terminal.send('\r')
      await delay(SETTLE_MS)
      const refused = harness.terminal.text()
      assert.match(
        unwrapped(refused),
        /is disposed\. Run \/resume to open another session/,
        `the refusal is on screen:\n${refused}`,
      )
      assert.deepEqual(delivered(harness), [], 'and nothing reached the retired agent')
    } finally {
      await unmount(harness)
    }
  })
})

describe('TUI submission routing', { skip: skipWithoutEntry }, () => {
  it('runs a slash command that was typed with a leading space', async () => {
    const harness = await mount()
    try {
      harness.terminal.send('  /definitely-not-a-command')
      harness.terminal.send('\r')
      await delay(SETTLE_MS)

      // The untrimmed check sent this to the model as chat: a request the user
      // paid for, could not undo, and never meant to make.
      assert.deepEqual(delivered(harness), [])
      assert.match(harness.terminal.text(), /Unknown command: \/definitely-not-a-command/)
    } finally {
      await unmount(harness)
    }
  })
})

/** One discovered skill, with only the fields the entry reads spelled out. */
function summary(name: string): SkillSummary {
  return {
    name,
    description: `does ${name}`,
    invocation: { modelInvocable: true, userInvocable: true },
    source: 'user-dsh',
    provider: 'test',
  }
}

/** The loaded definition `/skill:<name>` renders into the first user turn. */
function definition(name: string): SkillDefinition {
  return { ...summary(name), content: `body of ${name}` }
}

describe('TUI startup skill ordering', { skip: skipWithoutEntry }, () => {
  it('holds a prompt typed during the seeded skill lookup, then sends both in order', async () => {
    let releaseLookup = (): void => {}
    const lookup = new Promise<void>((resolve) => { releaseLookup = () => { resolve() } })
    const skills = {
      list: async () => { await lookup; return [summary('migrate')] },
      snapshot: () => Promise.resolve({ skills: [summary('migrate')], complete: true }),
      get: () => Promise.resolve(definition('migrate')),
    }
    const harness = await mount({
      config: { initialSkill: 'migrate' },
      services: { skills },
    })
    try {
      harness.terminal.send('and also fix the tests')
      harness.terminal.send('\r')
      await delay(SETTLE_MS)

      // The launcher seeded this session's first turn; a prompt that overtook
      // the lookup made the model answer before it had the instructions.
      assert.deepEqual(delivered(harness), [], 'nothing is sent while the seeded skill is still loading')
      assert.match(harness.terminal.text(), /Queued until the startup skill has been sent\./)

      releaseLookup()
      await delay(SETTLE_MS)

      const sent = delivered(harness)
      assert.equal(sent.length, 2, `both turns land once the skill resolves:\n${sent.join('\n---\n')}`)
      assert.match(sent[0] ?? '', /<skill name="migrate">/, 'the seeded skill goes first')
      assert.equal(sent[1], 'and also fix the tests', 'and the held prompt follows it, unchanged')
    } finally {
      await unmount(harness)
    }
  })

  it('releases the queue when the seeded skill does not exist', async () => {
    const skills = {
      list: () => Promise.resolve([]),
      snapshot: () => Promise.resolve({ skills: [], complete: true }),
      get: () => Promise.resolve(undefined),
    }
    const harness = await mount({
      config: { initialSkill: 'not-installed' },
      services: { skills },
    })
    try {
      harness.terminal.send('hello')
      harness.terminal.send('\r')
      await delay(SETTLE_MS)

      // A lookup that produced nothing must not strand what the user typed
      // while it ran.
      assert.deepEqual(delivered(harness), ['hello'])
      assert.match(harness.terminal.text(), /Unknown skill: not-installed/)
    } finally {
      await unmount(harness)
    }
  })
})

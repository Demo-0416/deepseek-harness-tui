/**
 * What Enter does with a prompt typed while a turn is already running: steer
 * that turn, or queue for the turn after it.
 *
 * The choice is a stored preference, a `/config` row, and a one-off inversion
 * on Ctrl+Enter, and the two settings have to agree with everything the queue
 * already offers — the badge, the pending echo, and the refund a cancel owes.
 * Each case therefore asserts through the agent's own routing calls and inbox
 * rather than through the row that set it.
 * @module dsh-tui/tests/unit/busy-enter
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { encodeSessionReferenceUri } from '@deepseek-ai/dsh-session-reference'
import { openTuiPreferences, type TuiPreferences } from '../../src/chat/preferences.ts'
import {
  createTuiTestHarness,
  disposeTuiTestHarness,
  messageText,
  setAgentStatus,
  tuiEntryAvailable,
  type TuiHarness,
  type TuiHarnessOptions,
} from '../harness.ts'
import { HeadlessTerminal } from '../headless-terminal.ts'
import type { Context } from '@deepseek-ai/cordis'

/** Literal editor prefix, so a frame assertion never depends on prompt-value registrations. */
const INPUT_PROMPT = 'busy> '

/** Keys as the terminal delivers them. */
const ENTER = '\r'
const ESC = '\x1b'
const ARROW_DOWN = '\x1b[B'
const ARROW_RIGHT = '\x1b[C'
/** Ctrl+Enter in CSI-u form, which only a Kitty-protocol terminal can send. */
const CTRL_ENTER = '\x1b[13;5u'

/** Echoes, inbox notifications and settings writes settle across a few awaits. */
const SETTLE_MS = 80

/** `src/index.ts` is landed by a separate port; without it the end-to-end suite cannot run. */
const entryAvailable = await tuiEntryAvailable()
const skipWithoutEntry = entryAvailable
  ? false
  : 'requires src/index.ts to export createTuiChat(ctx, config, runtime)'

/** `TuiController.submit` is the typed-line path; the harness handle only declares disposal. */
interface SubmitHandle {
  submit(text: string): void
}

type BusyHarness = TuiHarness<HeadlessTerminal, (code: number) => void>

/**
 * A settings provider answering from one raw section and recording its writes,
 * so a preference the panel changes can be asserted where it lands.
 */
class RecordingSettings {
  /** Every patch the store sent, in order. */
  readonly writes: object[] = []

  constructor(private section: Record<string, unknown> = {}) {}

  register(): void {}

  get(): unknown {
    return this.section
  }

  update(_namespace: string, patch: object): Promise<void> {
    this.writes.push(patch)
    this.section = { ...this.section, ...patch }
    return Promise.resolve()
  }
}

async function mount(options: TuiHarnessOptions = {}, rows = 32): Promise<BusyHarness> {
  const terminal = new HeadlessTerminal(96, rows)
  const before = terminal.frames
  const harness = await createTuiTestHarness(terminal, () => {}, {
    cwd: '/workspace/project',
    ...options,
    config: {
      title: 'DSH busy enter',
      welcome: 'ready.',
      ...options.config,
      theme: { color: false, inputPrompt: INPUT_PROMPT, ...options.config?.theme },
    },
  })
  await terminal.waitForFrame(before)
  return harness
}

async function unmount(harness: BusyHarness): Promise<void> {
  await disposeTuiTestHarness(harness)
  await harness.terminal.dispose()
}

/** Send one chunk and wait for the frame it produces. */
async function press(harness: BusyHarness, data: string): Promise<string> {
  const before = harness.terminal.frames
  harness.terminal.send(data)
  await harness.terminal.waitForFrame(before)
  return harness.terminal.text()
}

/** Type one prompt and send it with the key given, letting its echo land. */
async function submitWith(harness: BusyHarness, text: string, key: string): Promise<void> {
  await press(harness, text)
  await press(harness, key)
  await delay(SETTLE_MS)
}

/** The frame's non-empty rows, so an assertion failure prints something readable. */
function lines(frame: string): string[] {
  return frame.split('\n').map(row => row.trimEnd()).filter(row => row !== '')
}

/**
 * A session-reference resolver that answers every reference with one snapshot,
 * so the pairing between a prompt and the context it was sent with can be
 * asserted without a second session to recall from.
 */
function fakeSessionReferences(): unknown {
  return {
    prepare(_agent: unknown, content: ContentBlock[]) {
      return Promise.resolve({
        content,
        additionalContext: createUserMessage({
          content: [{ type: 'text', text: 'RECALL-SNAPSHOT' }],
          source: { kind: 'session-reference', form: 'recall', version: 1, references: [] },
        }),
      })
    },
  }
}

/** A context carrying (or not carrying) one settings provider, for the store cases. */
function contextWith(provider: unknown): Context {
  return { get: (name: string) => name === 'settings' ? provider : undefined } as unknown as Context
}

function refuseErrors(message: string): never {
  throw new Error(`unexpected preference error: ${message}`)
}

describe('the busy-Enter preference', () => {
  it('defaults to steering, which is what this terminal has always done', () => {
    const store = openTuiPreferences(contextWith(undefined), {}, refuseErrors)
    assert.equal(store.current().busyEnter, 'steer')
  })

  it('reads back a stored choice, and refuses one the document got wrong', () => {
    const stored = openTuiPreferences(
      contextWith({ register: () => {}, get: () => ({ busyEnter: 'queue' }), update: () => Promise.resolve() }),
      {},
      refuseErrors,
    )
    assert.equal(stored.current().busyEnter, 'queue')

    // The kind of thing a hand-edited settings.yaml carries: the word the badge
    // uses rather than the value the schema names. This one decides where a
    // typed prompt goes, so it is refused rather than guessed at.
    const wrong = openTuiPreferences(
      contextWith({ register: () => {}, get: () => ({ busyEnter: 'steering' }), update: () => Promise.resolve() }),
      {},
      refuseErrors,
    )
    assert.equal(wrong.current().busyEnter, 'steer')
  })

  it('lets a deployment default it the other way', () => {
    const store = openTuiPreferences(contextWith(undefined), { busyEnter: 'queue' }, refuseErrors)
    assert.equal(store.current().busyEnter, 'queue' satisfies TuiPreferences['busyEnter'])
  })
})

describe('Enter under a running turn', { skip: skipWithoutEntry }, () => {
  it('steers by default, leaving the queued path unused', async () => {
    const harness = await mount()
    try {
      setAgentStatus(harness.agent, 'running')
      await delay(SETTLE_MS)
      await submitWith(harness, 'INTERRUPT-THIS-STEP', ENTER)

      assert.deepEqual(harness.agent.steered.map(messageText), ['INTERRUPT-THIS-STEP'])
      assert.deepEqual(harness.agent.followups.map(messageText), [], 'nothing was parked for a later turn')
      assert.deepEqual(harness.agent.inbox.nextStep.map(messageText), ['INTERRUPT-THIS-STEP'])
      const frame = harness.terminal.text()
      assert.match(frame, /Steering · pending/u, `the echo says it is unread:\n${lines(frame).join('\n')}`)
      assert.match(frame, /1 queued/u)
    } finally {
      await unmount(harness)
    }
  })

  it('queues for the next turn when the preference says so', async () => {
    const harness = await mount({ services: { settings: new RecordingSettings({ busyEnter: 'queue' }) } })
    try {
      setAgentStatus(harness.agent, 'running')
      await delay(SETTLE_MS)
      await submitWith(harness, 'ASK-AFTER-THIS-TURN', ENTER)

      // The turn in flight is left alone: nothing was steered into it, and the
      // prompt waits on the next-turn boundary instead.
      assert.deepEqual(harness.agent.steered.map(messageText), [], 'the running turn is undisturbed')
      assert.deepEqual(harness.agent.followups.map(messageText), ['ASK-AFTER-THIS-TURN'])
      assert.deepEqual(harness.agent.inbox.nextTurn.map(messageText), ['ASK-AFTER-THIS-TURN'])
      const frame = harness.terminal.text()
      assert.match(frame, /Queued/u, `the echo says which queue holds it:\n${lines(frame).join('\n')}`)
      assert.doesNotMatch(frame, /Steering/u, 'and does not claim to have interrupted anything')
      assert.match(frame, /1 queued/u, 'the badge counts it like any other pending prompt')
    } finally {
      await unmount(harness)
    }
  })

  it('opens a turn with a prompt typed while nothing runs, whatever the preference says', async () => {
    const harness = await mount({ services: { settings: new RecordingSettings({ busyEnter: 'queue' }) } })
    try {
      await submitWith(harness, 'A PLAIN PROMPT', ENTER)

      // An idle agent has no turn to interrupt, so both behaviours mean the
      // same call and the echo is an ordinary prompt row rather than a badged
      // one waiting to be claimed.
      assert.deepEqual(harness.agent.followups.map(messageText), ['A PLAIN PROMPT'])
      assert.deepEqual(harness.agent.steered.map(messageText), [])
      const frame = harness.terminal.text()
      assert.doesNotMatch(frame, /Queued/u, `an idle prompt is not queued behind anything:\n${lines(frame).join('\n')}`)
      assert.doesNotMatch(frame, /queued/u, 'and there is no badge to count')
    } finally {
      await unmount(harness)
    }
  })
})

describe('Ctrl+Enter, the one-off inverse', { skip: skipWithoutEntry }, () => {
  it('queues one prompt while the preference still steers', async () => {
    const harness = await mount()
    try {
      setAgentStatus(harness.agent, 'running')
      await delay(SETTLE_MS)
      await submitWith(harness, 'ASK-AFTER-THIS-TURN', CTRL_ENTER)

      assert.deepEqual(harness.agent.followups.map(messageText), ['ASK-AFTER-THIS-TURN'])
      assert.deepEqual(harness.agent.steered.map(messageText), [], 'the gesture took the other branch')

      // And it is one send, not a mode: the next plain Enter steers again.
      await submitWith(harness, 'INTERRUPT-THIS-STEP', ENTER)
      assert.deepEqual(harness.agent.steered.map(messageText), ['INTERRUPT-THIS-STEP'])
      assert.deepEqual(harness.agent.followups.map(messageText), ['ASK-AFTER-THIS-TURN'])
    } finally {
      await unmount(harness)
    }
  })

  it('steers one prompt while the preference queues', async () => {
    const harness = await mount({ services: { settings: new RecordingSettings({ busyEnter: 'queue' }) } })
    try {
      setAgentStatus(harness.agent, 'running')
      await delay(SETTLE_MS)
      await submitWith(harness, 'INTERRUPT-THIS-STEP', CTRL_ENTER)

      assert.deepEqual(harness.agent.steered.map(messageText), ['INTERRUPT-THIS-STEP'])
      assert.deepEqual(harness.agent.followups.map(messageText), [])
      assert.match(harness.terminal.text(), /Steering · pending/u)
    } finally {
      await unmount(harness)
    }
  })

  it('sends nothing on an empty prompt, and leaves no inversion armed', async () => {
    const harness = await mount()
    try {
      setAgentStatus(harness.agent, 'running')
      await delay(SETTLE_MS)

      harness.terminal.send(CTRL_ENTER)
      await delay(SETTLE_MS)
      await harness.terminal.flush()
      assert.deepEqual(harness.agent.followups.map(messageText), [], 'an empty draft is not a prompt')
      assert.deepEqual(harness.agent.steered.map(messageText), [])

      // The gesture a swallowed press armed must not decide the next real one:
      // a plain Enter after it still follows the stored preference.
      await submitWith(harness, 'INTERRUPT-THIS-STEP', ENTER)
      assert.deepEqual(harness.agent.steered.map(messageText), ['INTERRUPT-THIS-STEP'])
      assert.deepEqual(harness.agent.followups.map(messageText), [])
    } finally {
      await unmount(harness)
    }
  })

  it('arms nothing when the editor answers the key with a newline instead', async () => {
    const harness = await mount()
    try {
      setAgentStatus(harness.agent, 'running')
      await delay(SETTLE_MS)

      // A trailing backslash is how pi-tui types a newline on a terminal that
      // cannot send Shift+Enter: the editor deletes the backslash and breaks
      // the line rather than submitting. Nothing is sent, so nothing may be
      // armed — an inversion left over from here would silently take the NEXT
      // plain Enter to the wrong side of the preference.
      await press(harness, 'FIRST-LINE\\')
      harness.terminal.send(CTRL_ENTER)
      await delay(SETTLE_MS)
      await harness.terminal.flush()
      assert.deepEqual(harness.agent.followups.map(messageText), [], 'the press submitted nothing')
      assert.deepEqual(harness.agent.steered.map(messageText), [])

      await submitWith(harness, 'SECOND-LINE', ENTER)
      assert.deepEqual(
        harness.agent.steered.map(messageText),
        ['FIRST-LINE\nSECOND-LINE'],
        'a plain Enter under the steering default steers, whatever the key before it did',
      )
      assert.deepEqual(harness.agent.followups.map(messageText), [])
    } finally {
      await unmount(harness)
    }
  })

  it('leaves the key to an open completion menu', async () => {
    const harness = await mount()
    try {
      setAgentStatus(harness.agent, 'running')
      await delay(SETTLE_MS)

      // The menu takes Enter to accept the highlighted entry. A key that both
      // accepted a completion and sent the line would make the popup dangerous
      // to open: one press would run a command the user never finished reading.
      await press(harness, '/mod')
      harness.terminal.send(CTRL_ENTER)
      await delay(SETTLE_MS)
      await harness.terminal.flush()
      const frame = harness.terminal.text()
      assert.match(
        frame,
        new RegExp(`${INPUT_PROMPT}/mod`, 'u'),
        `the draft is exactly as it was typed:\n${lines(frame).join('\n')}`,
      )
      assert.deepEqual(harness.agent.steered.map(messageText), [], 'and nothing was sent')
      assert.deepEqual(harness.agent.followups.map(messageText), [])
    } finally {
      await unmount(harness)
    }
  })
})

describe('a queued-mode prompt in the surfaces the queue owns', { skip: skipWithoutEntry }, () => {
  it('is listed by /status on the next-turn boundary', async () => {
    const harness = await mount({ services: { settings: new RecordingSettings({ busyEnter: 'queue' }) } }, 48)
    try {
      setAgentStatus(harness.agent, 'running')
      await delay(SETTLE_MS)
      await submitWith(harness, 'ASK-AFTER-THIS-TURN', ENTER)

      ;(harness.controller as unknown as SubmitHandle).submit('/status')
      await delay(SETTLE_MS)
      // The section sits under the status card, which fills the panel's first
      // screen on a terminal this size; the panel scrolls rather than truncates.
      const frame = await press(harness, '\x1b[6~')
      const rows = lines(frame)
      assert.ok(
        rows.some(row => row.includes('1. [next turn] ASK-AFTER-THIS-TURN')),
        `the listing names the boundary that holds it:\n${rows.join('\n')}`,
      )
    } finally {
      await unmount(harness)
    }
  })

  it('keeps its badge and its refund across the turn boundary it is waiting for', async () => {
    const harness = await mount({ services: { settings: new RecordingSettings({ busyEnter: 'queue' }) } })
    try {
      setAgentStatus(harness.agent, 'running')
      await delay(SETTLE_MS)
      await submitWith(harness, 'ASK-AFTER-THIS-TURN', ENTER)

      // The turn it was queued behind ends and the next one starts, with the
      // inbox untouched: a next-turn prompt outlives turns by definition, so
      // neither the count nor the text a cancel owes may be dropped with the
      // turn that happened to be running when it was typed.
      setAgentStatus(harness.agent, 'idle')
      await delay(SETTLE_MS)
      setAgentStatus(harness.agent, 'running')
      await delay(SETTLE_MS)
      await harness.terminal.flush()
      assert.match(harness.terminal.text(), /1 queued/u, 'the prompt outlived the turn it was typed under')

      const cancelled = await press(harness, ESC)
      assert.match(
        cancelled,
        new RegExp(`${INPUT_PROMPT}ASK-AFTER-THIS-TURN`, 'u'),
        `and its text is still owed back:\n${lines(cancelled).join('\n')}`,
      )
    } finally {
      await unmount(harness)
    }
  })

  it('becomes an ordinary prompt row once the agent claims it', async () => {
    const harness = await mount({ services: { settings: new RecordingSettings({ busyEnter: 'queue' }) } })
    try {
      setAgentStatus(harness.agent, 'running')
      await delay(SETTLE_MS)
      await submitWith(harness, 'ASK-AFTER-THIS-TURN', ENTER)
      assert.match(harness.terminal.text(), /Queued/u)

      // What a driver does when it gets to the turn this prompt was waiting
      // for. The badge said "not read yet", so reading it has to take the badge
      // away: it opened a turn of its own, which is what a plain prompt row is.
      const claimed = harness.agent.inbox.claim('next-turn', 2)
      for (const message of claimed) {
        harness.session.append('user/message', message, { surfaceOp: 'append' })
      }
      await delay(SETTLE_MS)
      await harness.terminal.flush()
      const frame = harness.terminal.text()
      assert.match(frame, /ASK-AFTER-THIS-TURN/u, `the prompt is still on screen:\n${lines(frame).join('\n')}`)
      assert.doesNotMatch(frame, /Queued/u, 'without a badge claiming it is still waiting')
      assert.doesNotMatch(frame, /queued/u, 'and the badge counts nothing')
    } finally {
      await unmount(harness)
    }
  })

  it('comes back to the editor when the turn is cancelled', async () => {
    const harness = await mount({ services: { settings: new RecordingSettings({ busyEnter: 'queue' }) } })
    try {
      setAgentStatus(harness.agent, 'running')
      await delay(SETTLE_MS)
      await submitWith(harness, 'ASK-AFTER-THIS-TURN', ENTER)

      // Cancelling empties the inbox, next-turn included, so a queued prompt is
      // owed its text back exactly as a steered one is.
      const cancelled = await press(harness, ESC)
      assert.equal(harness.agent.cancelled.length, 1)
      assert.match(
        cancelled,
        new RegExp(`${INPUT_PROMPT}ASK-AFTER-THIS-TURN`, 'u'),
        `the text is back in the editor:\n${lines(cancelled).join('\n')}`,
      )
    } finally {
      await unmount(harness)
    }
  })

  it('is taken back by Up like any other pending prompt', async () => {
    const harness = await mount({ services: { settings: new RecordingSettings({ busyEnter: 'queue' }) } })
    try {
      setAgentStatus(harness.agent, 'running')
      await delay(SETTLE_MS)
      await submitWith(harness, 'ASK-AFTER-THIS-TURN', ENTER)

      const recalled = await press(harness, '\x1b[A')
      assert.match(
        recalled,
        new RegExp(`${INPUT_PROMPT}ASK-AFTER-THIS-TURN`, 'u'),
        `Up reaches the next-turn queue too:\n${lines(recalled).join('\n')}`,
      )
      assert.deepEqual(harness.agent.inbox.nextTurn.map(messageText), [], 'and it left the inbox')
    } finally {
      await unmount(harness)
    }
  })
})

describe('a queued prompt that recalls another session', { skip: skipWithoutEntry }, () => {
  it('keeps its snapshot with it, out of the turn it was queued behind', async () => {
    const harness = await mount({
      services: {
        settings: new RecordingSettings({ busyEnter: 'queue' }),
        sessionReferenceResolver: fakeSessionReferences(),
      },
    })
    try {
      setAgentStatus(harness.agent, 'running')
      await delay(SETTLE_MS)
      await press(harness, `recap ${encodeSessionReferenceUri(SessionId('sess-abc-123'))} please`)
      await press(harness, ENTER)
      // The resolver is asynchronous, and the prompt is delivered by its
      // continuation rather than by the key.
      await delay(SETTLE_MS * 2)

      // Injected context takes the nearest step boundary, which belongs to the
      // turn in flight — the very turn queueing promised not to disturb. Sent
      // now, the recall dump would be read into an answer it has nothing to do
      // with, and the queued prompt would open its own turn without the
      // material it was asking about.
      assert.deepEqual(harness.agent.injected.map(messageText), [], 'the turn in flight is left alone')
      assert.deepEqual(harness.agent.inbox.nextStep.map(messageText), [])
      assert.deepEqual(harness.agent.inbox.nextTurn.map(messageText), ['recap @sess-abc-123 please'])

      // The turn the prompt was waiting for opens and claims it. The step that
      // claims it is the step that carries the snapshot, ahead of the prompt —
      // the position injecting it would have given it.
      const claimed = harness.agent.inbox.claim('next-turn', 2)
      const request = await harness.ctx.waterfall('agent/pre-step', {
        agent: harness.agent,
        messages: claimed,
        turn: 2,
        step: 1,
        signal: new AbortController().signal,
      }, () => Promise.resolve({ kind: 'enter' as const, messages: claimed }))
      assert.equal(request.kind, 'enter')
      assert.deepEqual(
        request.kind === 'enter' ? request.messages.map(messageText) : [],
        ['RECALL-SNAPSHOT', 'recap @sess-abc-123 please'],
      )
    } finally {
      await unmount(harness)
    }
  })
})

describe('the /config row that sets it', { skip: skipWithoutEntry }, () => {
  it('names both behaviours and persists the one chosen', async () => {
    const settings = new RecordingSettings()
    const harness = await mount({ services: { settings } })
    try {
      ;(harness.controller as unknown as SubmitHandle).submit('/config')
      await delay(SETTLE_MS)
      const open = harness.terminal.text()
      assert.match(open, /Enter while running\s+Steer the current turn/u, `the row reports the default:\n${open}`)

      // Down twice to reach it — thinking pin, tool cards, this — then right to
      // step the choice.
      harness.terminal.send(ARROW_DOWN)
      harness.terminal.send(ARROW_DOWN)
      const moved = await press(harness, ARROW_RIGHT)
      assert.match(moved, /Enter while running\s+Queue for the next turn/u, `the row flips in place:\n${moved}`)
      await delay(SETTLE_MS)
      assert.deepEqual(settings.writes, [{ busyEnter: 'queue' }], 'and the row saves the field it changed')
    } finally {
      await unmount(harness)
    }
  })

  it('opens on the stored choice and routes the next prompt by it', async () => {
    const harness = await mount({ services: { settings: new RecordingSettings({ busyEnter: 'queue' }) } })
    try {
      ;(harness.controller as unknown as SubmitHandle).submit('/config')
      await delay(SETTLE_MS)
      assert.match(harness.terminal.text(), /Enter while running\s+Queue for the next turn/u)
      await press(harness, ESC)

      setAgentStatus(harness.agent, 'running')
      await delay(SETTLE_MS)
      await submitWith(harness, 'ASK-AFTER-THIS-TURN', ENTER)
      assert.deepEqual(harness.agent.followups.map(messageText), ['ASK-AFTER-THIS-TURN'])
    } finally {
      await unmount(harness)
    }
  })
})

/**
 * The queue of prompts the agent has been handed and has not read yet: the
 * projection it is derived from, the badge that counts it, the pending marker
 * on each unclaimed echo, the `/status` listing, and the two keys that hand it
 * back to the editor.
 *
 * The count is asserted through the agent's own inbox rather than through this
 * terminal's bookkeeping, because the inbox is what the driver will consume:
 * anything the two disagree about is a lie told to the user in one direction
 * or the other.
 * @module dsh-tui/tests/unit/steering-queue
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { Container } from '@earendil-works/pi-tui'
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { encodeSessionReferenceUri } from '@deepseek-ai/dsh-session-reference'
import type { SessionEvent, UserMessage } from '@deepseek-ai/dsh-session'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { pendingUserQueue, queueItemPreview } from '../../src/chat/queue.ts'
import { StepTimingTracker } from '../../src/chat/timing.ts'
import { TranscriptReconciler, type TranscriptDeps } from '../../src/components/reconciler.ts'
import { createPalette, markdownTheme } from '../../src/components/theme.ts'
import type { MarkdownPolicy } from '../../src/components/transcript.ts'
import type { UserMessageNode } from '../../src/core/types.ts'
import { claudeMarkdownTheme } from '../../src/render/markdown.ts'
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

/** Literal editor prefix, so a frame assertion never depends on prompt-value registrations. */
const INPUT_PROMPT = 'queue> '

/** Keys as the terminal delivers them. */
const ENTER = '\r'
const ESC = '\x1b'
const CTRL_C = '\x03'
const PAGE_DOWN = '\x1b[6~'
const UP = '\x1b[A'
const DOWN = '\x1b[B'
/** Shift+Ctrl+D, which only a Kitty-protocol terminal can express. */
const SHIFT_CTRL_D = '\x1b[100;6u'
/** One Up held under the Kitty protocol: press, two auto-repeats, release. */
const KITTY_UP_HELD = ['\x1b[A', '\x1b[1;1:2A', '\x1b[1;1:2A', '\x1b[1;1:3A']

/** The placeholder a running turn shows when it has nothing else to say. */
const RUNNING_PLACEHOLDER = 'press enter to steer and esc to cancel'
/** The placeholder that teaches the key this suite is about. */
const QUEUE_HINT = 'press up to edit queued messages'

/** Echoes, inbox notifications and panels settle across a few awaits. */
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

type QueueHarness = TuiHarness<HeadlessTerminal, (code: number) => void>

async function mount(options: TuiHarnessOptions = {}, rows = 32): Promise<QueueHarness> {
  const terminal = new HeadlessTerminal(96, rows)
  const before = terminal.frames
  const harness = await createTuiTestHarness(terminal, () => {}, {
    cwd: '/workspace/project',
    ...options,
    config: {
      title: 'DSH queue',
      welcome: 'ready.',
      ...options.config,
      // `rightPrompt` is left at its default: the queued badge hangs off it.
      theme: { color: false, inputPrompt: INPUT_PROMPT, ...options.config?.theme },
    },
  })
  await terminal.waitForFrame(before)
  return harness
}

async function unmount(harness: QueueHarness): Promise<void> {
  await disposeTuiTestHarness(harness)
  await harness.terminal.dispose()
}

/** Send one chunk and wait for the frame it produces. */
async function press(harness: QueueHarness, data: string): Promise<string> {
  const before = harness.terminal.frames
  harness.terminal.send(data)
  await harness.terminal.waitForFrame(before)
  return harness.terminal.text()
}

/** Type one prompt into the running turn and let its echo land. */
async function submit(harness: QueueHarness, text: string): Promise<void> {
  await press(harness, text)
  await press(harness, ENTER)
  await delay(SETTLE_MS)
}

/**
 * A settings provider that answers from one raw section and records what was
 * written to it, so a preference the terminal writes on its own — nobody types
 * the hint counter — can be asserted where it lands.
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

/** The fail-closed tail of the approval chain, standing in for the service's default. */
function chainDefault(): Promise<ApprovalOutcome> {
  return Promise.resolve('unavailable')
}

/** One user prompt from somewhere that is not this terminal. */
function userMessage(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

/** One bracketed paste, exactly as a terminal wraps it. */
function bracketed(body: string): string {
  return `\x1b[200~${body}\x1b[201~`
}

/**
 * A session-reference resolver answering every reference with one snapshot, so
 * the pairing between a queued prompt and the context it was sent with can be
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

/** One context message a plugin injected beside a prompt. */
function contextMessage(text: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'dsh-session-reference', form: 'snapshot', sections: [] },
  })
}

/** The frame's non-empty rows, so an assertion failure prints something readable. */
function lines(frame: string): string[] {
  return frame.split('\n').map(row => row.trimEnd()).filter(row => row !== '')
}

describe('the pending-queue projection', () => {
  it('lists user prompts in claim order and leaves injected context out', async () => {
    const { ctx, agent } = await createTuiTestContext({ cwd: '/workspace/project' })
    try {
      agent.followup(userMessage('ASK-NEXT-TURN'))
      agent.steer(userMessage('INTERRUPT-THIS-STEP'))
      // `agent.inject()` parks a reference snapshot on the same next-step
      // boundary. It is context the terminal delivered on the user's behalf,
      // not a prompt anyone is waiting to see answered.
      agent.inject(contextMessage('REFERENCE-SNAPSHOT'))

      const queue = pendingUserQueue(agent.inbox)
      assert.deepEqual(
        queue.map(item => [item.placement, messageText(item.message)]),
        [['steering', 'INTERRUPT-THIS-STEP'], ['queued', 'ASK-NEXT-TURN']],
        'next-step input comes first, because the running driver claims it first',
      )
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('previews one queued prompt as a single elided line', () => {
    const wrapped = userMessage('first line\n\n   second   line\t')
    assert.equal(queueItemPreview(wrapped), 'first line second line')
    const long = userMessage('x'.repeat(400))
    const preview = queueItemPreview(long)
    assert.equal(preview.length, 201, `a pasted page is cut to one bounded line: ${preview}`)
    assert.ok(preview.endsWith('…'), 'and says that it was cut')
  })
})

describe('the queued-prompt badge', { skip: skipWithoutEntry }, () => {
  it('counts the agent inbox, including prompts this terminal never sent', async () => {
    const harness = await mount()
    try {
      setAgentStatus(harness.agent, 'running')
      await delay(SETTLE_MS)
      await submit(harness, 'FIRST-QUEUED')
      await submit(harness, 'SECOND-QUEUED')
      assert.match(harness.terminal.text(), /2 queued/u)

      // A second host steering into the same session is queued work too, and
      // the old count — this terminal's own submissions — could not see it.
      harness.agent.inbox.append('next-step', userMessage('FROM-ANOTHER-HOST'))
      await delay(SETTLE_MS)
      await harness.terminal.flush()
      const counted = harness.terminal.text()
      assert.match(counted, /3 queued/u, `an insert from elsewhere counts:\n${lines(counted).join('\n')}`)

      // Both numbers of the debug panel's reconciliation row, which is where a
      // disagreement between ledger and inbox has to be visible.
      assert.match(await press(harness, SHIFT_CTRL_D), /pending steering 2 · inbox queue 3/u)
      await press(harness, ESC)

      harness.agent.inbox.clear()
      await delay(SETTLE_MS)
      await harness.terminal.flush()
      assert.doesNotMatch(harness.terminal.text(), /queued/u, 'a drained inbox counts nothing')
    } finally {
      await unmount(harness)
    }
  })

  it('keeps counting a queue the turn left behind, and still refunds it', async () => {
    const harness = await mount()
    try {
      setAgentStatus(harness.agent, 'running')
      await delay(SETTLE_MS)
      await submit(harness, 'FIRST-QUEUED')
      await submit(harness, 'SECOND-QUEUED')

      // A status flap with the inbox untouched: the prompts are still pending,
      // so the ledger that would refund them must survive it. Blindly emptying
      // the ledger here used to lose the text of every prompt still queued.
      setAgentStatus(harness.agent, 'idle')
      await delay(SETTLE_MS)
      setAgentStatus(harness.agent, 'running')
      await delay(SETTLE_MS)
      await harness.terminal.flush()
      assert.match(harness.terminal.text(), /2 queued/u, 'the queue outlived the flap')

      const cancelled = await press(harness, ESC)
      assert.equal(harness.agent.cancelled.length, 1)
      assert.match(cancelled, /FIRST-QUEUED/u, `and its text comes back:\n${lines(cancelled).join('\n')}`)
      assert.match(cancelled, /SECOND-QUEUED/u)
    } finally {
      await unmount(harness)
    }
  })

  it('hands the queue back on Ctrl+C, exactly as Esc does', async () => {
    const harness = await mount()
    try {
      setAgentStatus(harness.agent, 'running')
      await delay(SETTLE_MS)
      await submit(harness, 'FIRST-QUEUED')
      await submit(harness, 'SECOND-QUEUED')

      // Both keys mean "cancel this turn", and cancelling empties the inbox.
      // Ctrl+C used to drop the queued text on the floor while Esc handed it
      // back, so which key the user reached for decided whether their typing
      // survived.
      const cancelled = await press(harness, CTRL_C)
      assert.equal(harness.agent.cancelled.length, 1)
      assert.match(cancelled, /FIRST-QUEUED/u, `the queue is back in the editor:\n${lines(cancelled).join('\n')}`)
      assert.match(cancelled, /SECOND-QUEUED/u)
    } finally {
      await unmount(harness)
    }
  })

  it('hands it back on the repeat press too, when the first cancel did not take', async () => {
    const harness = await mount()
    try {
      setAgentStatus(harness.agent, 'running')
      await delay(SETTLE_MS)
      await submit(harness, 'FIRST-TRY')

      // A turn that does not stop is exactly why the ladder has a second rung.
      await press(harness, CTRL_C)
      harness.agent.inbox.clear()
      await delay(SETTLE_MS)
      // The refunded draft goes back in — the user tried again — and the turn
      // is still running, so the second press is another cancel and owes the
      // same refund the first one made.
      await press(harness, ENTER)
      await delay(SETTLE_MS)
      assert.deepEqual(harness.agent.inbox.nextStep.map(messageText), ['FIRST-TRY'], 'it really is queued again')

      const again = await press(harness, CTRL_C)
      assert.equal(harness.agent.cancelled.length, 2, 'the repeat press cancels again')
      assert.match(
        again,
        new RegExp(`${INPUT_PROMPT}FIRST-TRY`, 'u'),
        `and hands the queue back again:\n${lines(again).join('\n')}`,
      )
    } finally {
      await unmount(harness)
    }
  })

  it('stores the refunded draft in the history before a later press discards it', async () => {
    const harness = await mount()
    try {
      setAgentStatus(harness.agent, 'running')
      await delay(SETTLE_MS)
      await submit(harness, 'FIRST-QUEUED')
      await submit(harness, 'SECOND-QUEUED')

      await press(harness, CTRL_C)
      // What a real cancel does to the inbox: the echoes are withdrawn with it,
      // so from here the prompts exist only as the refunded draft.
      harness.agent.inbox.clear()
      setAgentStatus(harness.agent, 'idle')
      await delay(SETTLE_MS)

      // The ladder invites a second press ("if it did not stop, press again"),
      // and a cancel that settles fast turns that press into the idle rung,
      // which clears the draft outright. What it clears is the queue the press
      // before it just handed back, so it has to be recoverable.
      const cleared = await press(harness, CTRL_C)
      assert.doesNotMatch(cleared, /FIRST-QUEUED/u, `the draft is gone:\n${lines(cleared).join('\n')}`)

      const recalled = await press(harness, UP)
      assert.match(
        recalled,
        new RegExp(`${INPUT_PROMPT}FIRST-QUEUED`, 'u'),
        `and Ctrl+R or Up gets it back, whole:\n${lines(recalled).join('\n')}`,
      )
      assert.match(recalled, /SECOND-QUEUED/u, 'both prompts, in the order they were typed')
    } finally {
      await unmount(harness)
    }
  })

  it('hands back a draft holding a paste marker without losing the pasted text', async () => {
    const harness = await mount()
    try {
      setAgentStatus(harness.agent, 'running')
      await delay(SETTLE_MS)
      await submit(harness, 'QUEUED-ONE')

      // A paste over ten lines is kept out of the draft: the editor shows a
      // marker and holds the text in its own paste map. Merging the queue into
      // the draft rewrites the draft, and a rewrite empties that map — so the
      // merge has to expand the marker first, or the model gets the marker.
      const pasted = Array.from({ length: 12 }, (_, index) => `PASTED-LINE-${String(index + 1)}`).join('\n')
      await press(harness, bracketed(pasted))
      assert.match(harness.terminal.text(), /\[paste #1 \+12 lines\]/u)

      await press(harness, CTRL_C)
      await press(harness, ENTER)
      await delay(SETTLE_MS)
      const sent = harness.agent.steered.map(messageText).at(-1) ?? ''
      assert.ok(sent.includes('QUEUED-ONE'), `the refunded prompt is in it:\n${sent}`)
      assert.ok(sent.includes('PASTED-LINE-12'), `and so is the pasted text:\n${sent}`)
      assert.ok(!sent.includes('[paste #'), `rather than a marker pointing at nothing:\n${sent}`)
    } finally {
      await unmount(harness)
    }
  })
})

describe('a queue the terminal mounted onto', { skip: skipWithoutEntry }, () => {
  it('counts what was already pending before the first frame', async () => {
    // Attaching to an agent that is already mid-turn: the prompts were queued
    // by whoever was driving it before, and no insertion notification is coming
    // to announce them. What the first frame reads is all the user gets.
    const harness = await mount({
      status: 'running',
      beforeChat: (agent) => {
        agent.inbox.append('next-step', userMessage('ALREADY-STEERED'))
        agent.inbox.append('next-turn', userMessage('ALREADY-QUEUED'))
      },
    })
    try {
      await delay(SETTLE_MS)
      await harness.terminal.flush()
      const frame = harness.terminal.text()
      assert.match(frame, /2 queued/u, `the badge counts the inherited queue:\n${lines(frame).join('\n')}`)
    } finally {
      await unmount(harness)
    }
  })
})

describe('the /status queue section', { skip: skipWithoutEntry }, () => {
  it('lists what is queued, in claim order, naming each boundary', async () => {
    const harness = await mount({}, 48)
    try {
      setAgentStatus(harness.agent, 'running')
      await delay(SETTLE_MS)
      await submit(harness, 'INTERRUPT-THIS-STEP')
      harness.agent.inbox.append('next-turn', userMessage('ASK-AFTER-THIS-TURN'))
      await delay(SETTLE_MS)

      ;(harness.controller as unknown as SubmitHandle).submit('/status')
      await delay(SETTLE_MS)
      // The section sits under the status card, which fills the panel's first
      // screen on a terminal this size; the panel scrolls rather than truncates.
      const frame = await press(harness, PAGE_DOWN)
      const rows = lines(frame)
      assert.match(frame, /Queued messages/u, `the panel has a queue section:\n${rows.join('\n')}`)
      const steering = rows.findIndex(row => row.includes('1. [steering] INTERRUPT-THIS-STEP'))
      const nextTurn = rows.findIndex(row => row.includes('2. [next turn] ASK-AFTER-THIS-TURN'))
      assert.ok(steering >= 0, `the steered prompt is listed first:\n${rows.join('\n')}`)
      assert.ok(nextTurn > steering, `and the queued turn after it:\n${rows.join('\n')}`)
    } finally {
      await unmount(harness)
    }
  })

  it('says nothing about a queue that is empty', async () => {
    const harness = await mount({}, 48)
    try {
      await delay(SETTLE_MS)
      ;(harness.controller as unknown as SubmitHandle).submit('/status')
      await delay(SETTLE_MS)
      const frame = harness.terminal.text()
      assert.match(frame, /Session status/u)
      assert.doesNotMatch(frame, /Queued messages/u, `an idle agent has no queue section:\n${frame}`)
    } finally {
      await unmount(harness)
    }
  })
})

describe('editing a queued prompt with Up', { skip: skipWithoutEntry }, () => {
  it('takes the newest queued prompt back, and sends the edit to the back of the queue', async () => {
    const harness = await mount()
    try {
      setAgentStatus(harness.agent, 'running')
      await delay(SETTLE_MS)
      await submit(harness, 'FIRST-QUEUED')
      await submit(harness, 'SECOND-QUEUED')

      // The newest prompt is the one furthest from being claimed, so taking it
      // back disturbs the running turn least — and it is the one a user who
      // typed one prompt too many is reaching for.
      const recalled = await press(harness, UP)
      assert.match(
        recalled,
        new RegExp(`${INPUT_PROMPT}SECOND-QUEUED`, 'u'),
        `Up puts the newest queued prompt in the editor:\n${lines(recalled).join('\n')}`,
      )
      assert.deepEqual(
        harness.agent.inbox.nextStep.map(messageText),
        ['FIRST-QUEUED'],
        'it really left the inbox, rather than being copied out of it',
      )
      assert.match(recalled, /1 queued/u, 'and the badge counts what is still queued')
      await delay(SETTLE_MS)
      await harness.terminal.flush()
      const withdrawn = harness.terminal.text()
      assert.equal(
        lines(withdrawn).filter(row => row.includes('SECOND-QUEUED')).length,
        1,
        `the withdrawn echo is gone; the prompt survives only as the draft:\n${lines(withdrawn).join('\n')}`,
      )

      // From here it is an ordinary draft: Enter sends it the way anything else
      // is sent, which puts it at the back of the queue rather than in its old
      // place — the copy that held that place is gone.
      await press(harness, '-EDITED')
      await press(harness, ENTER)
      await delay(SETTLE_MS)
      assert.deepEqual(
        harness.agent.inbox.nextStep.map(messageText),
        ['FIRST-QUEUED', 'SECOND-QUEUED-EDITED'],
      )
      assert.match(harness.terminal.text(), /2 queued/u)
    } finally {
      await unmount(harness)
    }
  })

  it('takes exactly one prompt per press, release and repeats included', async () => {
    const harness = await mount()
    try {
      setAgentStatus(harness.agent, 'running')
      await delay(SETTLE_MS)
      await submit(harness, 'TYPED-HERE')
      // Newest, and from somewhere that is not the prompt history — so a tail
      // event reaching the editor would visibly replace it with what was typed.
      harness.agent.inbox.append('next-step', userMessage('FROM-ANOTHER-HOST'))
      await delay(SETTLE_MS)

      // Under the Kitty protocol one physical press arrives several times. The
      // press takes the prompt and closes the gate behind itself, so its own
      // auto-repeats would fall through to the editor — which walks the draft's
      // cursor to the start of the row and then recalls prompt history over it.
      for (const event of KITTY_UP_HELD) {
        harness.terminal.send(event)
        await delay(SETTLE_MS)
      }
      await harness.terminal.flush()
      const frame = harness.terminal.text()
      assert.match(
        frame,
        new RegExp(`${INPUT_PROMPT}FROM-ANOTHER-HOST`, 'u'),
        `one press, one prompt, and nothing typed over it:\n${lines(frame).join('\n')}`,
      )
      assert.deepEqual(harness.agent.inbox.nextStep.map(messageText), ['TYPED-HERE'])
    } finally {
      await unmount(harness)
    }
  })

  it('takes the snapshot a recalling prompt was sent with back too', async () => {
    const harness = await mount({ services: { sessionReferenceResolver: fakeSessionReferences() } })
    try {
      setAgentStatus(harness.agent, 'running')
      await delay(SETTLE_MS)
      await press(harness, `recap ${encodeSessionReferenceUri(SessionId('sess-abc-123'))} please`)
      await press(harness, ENTER)
      // The resolver is asynchronous; the prompt is delivered by its
      // continuation rather than by the key.
      await delay(SETTLE_MS * 2)
      assert.deepEqual(
        harness.agent.inbox.nextStep.map(messageText),
        ['RECALL-SNAPSHOT', 'recap @sess-abc-123 please'],
        'the snapshot was steered in front of the prompt that asked for it',
      )

      // Both halves are one submission. Left behind, the snapshot is claimed on
      // its own: a dump of another session with no question attached, read into
      // the running turn while the question sits in the editor.
      const recalled = await press(harness, UP)
      assert.match(
        recalled,
        new RegExp(`${INPUT_PROMPT}recap @sess-abc-123 please`, 'u'),
        `the prompt is back in the editor:\n${lines(recalled).join('\n')}`,
      )
      assert.deepEqual(harness.agent.inbox.nextStep.map(messageText), [], 'and nothing of it is left queued')
    } finally {
      await unmount(harness)
    }
  })

  it('leaves Up to an open completion menu', async () => {
    const harness = await mount()
    try {
      setAgentStatus(harness.agent, 'running')
      await delay(SETTLE_MS)
      await submit(harness, 'FIRST-QUEUED')

      // Typing a slash opens the command menu, whose own arrows walk the list.
      await press(harness, '/')
      harness.terminal.send(UP)
      await delay(SETTLE_MS)
      await harness.terminal.flush()
      const frame = harness.terminal.text()
      // Up walked the menu's own list, which wraps to its last entry.
      assert.match(frame, /→ theme/u, `the menu took the key:\n${lines(frame).join('\n')}`)
      assert.match(frame, new RegExp(`${INPUT_PROMPT}/`, 'u'), 'and the slash is still the draft')
      assert.deepEqual(harness.agent.inbox.nextStep.map(messageText), ['FIRST-QUEUED'], 'the queue is untouched')
    } finally {
      await unmount(harness)
    }
  })

  it('leaves Up to the editor while a draft is being typed', async () => {
    const harness = await mount()
    try {
      setAgentStatus(harness.agent, 'running')
      await delay(SETTLE_MS)
      await submit(harness, 'FIRST-QUEUED')

      // A draft is typing the user has not sent yet. Taking a queued prompt
      // into the editor would have to overwrite it or merge into it, and both
      // lose something the user wrote, so the queue does not get the key.
      await press(harness, 'half a thought')
      harness.terminal.send(UP)
      await delay(SETTLE_MS)
      await harness.terminal.flush()
      const frame = harness.terminal.text()
      assert.match(frame, new RegExp(`${INPUT_PROMPT}half a thought`, 'u'), `the draft is untouched:\n${lines(frame).join('\n')}`)
      assert.deepEqual(harness.agent.inbox.nextStep.map(messageText), ['FIRST-QUEUED'], 'and the queue is untouched')
    } finally {
      await unmount(harness)
    }
  })

  it('leaves Up to the prompt history when nothing is queued', async () => {
    const harness = await mount()
    try {
      await press(harness, 'a plain prompt')
      await press(harness, ENTER)
      await delay(SETTLE_MS)
      // What a driver does with a prompt sent to an idle agent: it wakes and
      // claims it. The fake agent has no driver, so the claim is made here.
      harness.agent.inbox.claim('next-turn', 1)
      setAgentStatus(harness.agent, 'running')
      await delay(SETTLE_MS)

      const recalled = await press(harness, UP)
      assert.match(
        recalled,
        new RegExp(`${INPUT_PROMPT}a plain prompt`, 'u'),
        `an empty queue leaves history navigation exactly as it was:\n${lines(recalled).join('\n')}`,
      )
    } finally {
      await unmount(harness)
    }
  })

  it('leaves Up to the prompt history while no turn is running', async () => {
    const harness = await mount()
    try {
      await press(harness, 'a plain prompt')
      await press(harness, ENTER)
      await delay(SETTLE_MS)
      harness.agent.inbox.claim('next-turn', 1)
      // Parked for a turn that has not started. Nothing on screen says it is
      // there — the badge counts a queue only under a running turn — so Up must
      // not quietly mean something else here either.
      harness.agent.inbox.append('next-turn', userMessage('FROM-ANOTHER-HOST'))
      await delay(SETTLE_MS)

      const recalled = await press(harness, UP)
      assert.match(
        recalled,
        new RegExp(`${INPUT_PROMPT}a plain prompt`, 'u'),
        `an idle prompt navigates history:\n${lines(recalled).join('\n')}`,
      )
      assert.deepEqual(harness.agent.inbox.nextTurn.map(messageText), ['FROM-ANOTHER-HOST'], 'and the queue is untouched')
    } finally {
      await unmount(harness)
    }
  })

  it('leaves Up to an inline permission dialog', async () => {
    const harness = await mount()
    try {
      setAgentStatus(harness.agent, 'running')
      await delay(SETTLE_MS)
      await submit(harness, 'FIRST-QUEUED')

      // The permission dialog draws in the inline slot, under a prompt row that
      // stays visible and over a queue that is not empty. Up is how its rows are
      // chosen, so the queue must not take the key out from under it.
      const asked = harness.terminal.frames
      const decision = harness.ctx.waterfall('approval/request', {
        agent: harness.agent,
        toolName: 'bash',
        reason: 'Deleting files needs confirmation',
      }, chainDefault)
      await harness.terminal.waitForFrame(asked)

      assert.match(await press(harness, DOWN), /❯ 2\. Yes, and don't ask again/u)
      const moved = await press(harness, UP)
      assert.match(moved, /❯ 1\. Yes, allow once/u, `Up moves the dialog's own cursor:\n${lines(moved).join('\n')}`)
      assert.deepEqual(harness.agent.inbox.nextStep.map(messageText), ['FIRST-QUEUED'], 'and the queue is untouched')
      assert.doesNotMatch(moved, new RegExp(`${INPUT_PROMPT}FIRST-QUEUED`, 'u'), 'nothing was pulled into the editor')

      harness.terminal.send('4')
      assert.equal(await decision, 'rejected')
    } finally {
      await unmount(harness)
    }
  })
})

describe('the hint that teaches the Up key', { skip: skipWithoutEntry }, () => {
  it('offers the key once per queue and remembers having offered it', async () => {
    const settings = new RecordingSettings()
    const harness = await mount({ services: { settings } })
    try {
      setAgentStatus(harness.agent, 'running')
      await delay(SETTLE_MS)
      await submit(harness, 'FIRST-QUEUED')
      assert.match(
        harness.terminal.text(),
        new RegExp(QUEUE_HINT, 'u'),
        `a queue that exists offers the key that edits it:\n${lines(harness.terminal.text()).join('\n')}`,
      )
      await delay(SETTLE_MS)
      assert.deepEqual(settings.writes, [{ queueUpHintSeen: 1 }], 'and the offer is counted across sessions')

      // A queue that grows is still the same queue: the lesson is the row being
      // there while the user waits, not each prompt they add to it.
      await submit(harness, 'SECOND-QUEUED')
      await delay(SETTLE_MS)
      assert.deepEqual(settings.writes, [{ queueUpHintSeen: 1 }], 'one queue, one offer')

      // Using the key ends the lesson outright: counting to three would go on
      // telling someone what they already do.
      await press(harness, UP)
      await delay(SETTLE_MS)
      assert.deepEqual(settings.writes, [{ queueUpHintSeen: 1 }, { queueUpHintSeen: 3 }])
    } finally {
      await unmount(harness)
    }
  })

  it('stops offering the key to a user who has just used it', async () => {
    const settings = new RecordingSettings()
    const harness = await mount({ services: { settings } })
    try {
      setAgentStatus(harness.agent, 'running')
      await delay(SETTLE_MS)
      await submit(harness, 'FIRST-QUEUED')
      await submit(harness, 'SECOND-QUEUED')
      assert.match(harness.terminal.text(), new RegExp(QUEUE_HINT, 'u'))

      // Take one prompt back and send it again: the queue never reaches zero,
      // so nothing else ends the lesson. The user has demonstrably learned it,
      // and the row belongs to the deployment's own placeholder again.
      await press(harness, UP)
      await press(harness, ENTER)
      await delay(SETTLE_MS)
      await harness.terminal.flush()
      const frame = harness.terminal.text()
      assert.match(frame, /2 queued/u, 'the queue is still there')
      assert.doesNotMatch(frame, new RegExp(QUEUE_HINT, 'u'), `and the lesson is over:\n${lines(frame).join('\n')}`)
      assert.match(frame, new RegExp(RUNNING_PLACEHOLDER, 'u'), 'so the running placeholder has the row back')
    } finally {
      await unmount(harness)
    }
  })

  it('teaches each new queue, up to the limit', async () => {
    const settings = new RecordingSettings()
    const harness = await mount({ services: { settings } })
    try {
      setAgentStatus(harness.agent, 'running')
      await delay(SETTLE_MS)
      await submit(harness, 'FIRST-QUEUED')
      await delay(SETTLE_MS)
      assert.deepEqual(settings.writes, [{ queueUpHintSeen: 1 }])

      // The driver claims it: the queue is empty, and the next one the user
      // fills is a new occasion to teach — the lesson is three showings, not
      // three sessions.
      harness.agent.inbox.claim('next-step', 1)
      await delay(SETTLE_MS)
      await submit(harness, 'SECOND-QUEUED')
      await delay(SETTLE_MS)
      assert.deepEqual(settings.writes, [{ queueUpHintSeen: 1 }, { queueUpHintSeen: 2 }])
      assert.match(
        harness.terminal.text(),
        new RegExp(QUEUE_HINT, 'u'),
        `and the row is back on screen for it:\n${lines(harness.terminal.text()).join('\n')}`,
      )
    } finally {
      await unmount(harness)
    }
  })

  it('spends nothing on ordinary prompts typed at an idle agent', async () => {
    const settings = new RecordingSettings()
    const harness = await mount({ services: { settings } })
    try {
      // What the loop does with a plain prompt: the inbox takes it, the status
      // flips to running, and only then does the driver claim it. For that tick
      // there is a prompt in the queue under a running turn — which is not a
      // queue the user is waiting through, and teaching there would spend the
      // whole lesson on the first three prompts of a first session.
      for (const turn of [1, 2, 3]) {
        await press(harness, `PLAIN-PROMPT-${String(turn)}`)
        await press(harness, ENTER)
        setAgentStatus(harness.agent, 'running')
        await delay(SETTLE_MS)
        harness.agent.inbox.claim('next-turn', turn)
        setAgentStatus(harness.agent, 'idle')
        await delay(SETTLE_MS)
      }
      assert.deepEqual(settings.writes, [], 'nothing was taught, so nothing was counted')

      // And the lesson is still there for the first real queue.
      setAgentStatus(harness.agent, 'running')
      await delay(SETTLE_MS)
      await submit(harness, 'FIRST-QUEUED')
      await delay(SETTLE_MS)
      assert.deepEqual(settings.writes, [{ queueUpHintSeen: 1 }])
      assert.match(harness.terminal.text(), new RegExp(QUEUE_HINT, 'u'))
    } finally {
      await unmount(harness)
    }
  })

  it('says nothing to a user who already knows, and still hands the prompt back', async () => {
    const settings = new RecordingSettings({ queueUpHintSeen: 3 })
    const harness = await mount({ services: { settings } })
    try {
      setAgentStatus(harness.agent, 'running')
      await delay(SETTLE_MS)
      await submit(harness, 'FIRST-QUEUED')

      const taught = harness.terminal.text()
      assert.doesNotMatch(taught, new RegExp(QUEUE_HINT, 'u'), `the lesson is over:\n${lines(taught).join('\n')}`)
      assert.match(taught, new RegExp(RUNNING_PLACEHOLDER, 'u'), 'and the running placeholder has the row back')

      // Only the teaching stopped; the key itself is exactly as it was.
      const recalled = await press(harness, UP)
      assert.match(recalled, new RegExp(`${INPUT_PROMPT}FIRST-QUEUED`, 'u'), `the key still works:\n${lines(recalled).join('\n')}`)
      await delay(SETTLE_MS)
      assert.deepEqual(settings.writes, [], 'a count already at its limit is not written again')
    } finally {
      await unmount(harness)
    }
  })
})

describe('the badge above a queued prompt', () => {
  /** A reconciler over its own chat container, plus the rows it renders. */
  function mountReconciler(): { reconciler: TranscriptReconciler; rows: () => string[] } {
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
      now: () => 0,
      toolDefinition: () => undefined,
      cwd: '/workspace',
      expandKey: () => 'Ctrl+O',
    }
    const chat = new Container()
    const reconciler = new TranscriptReconciler(chat, deps, { showReasoning: true, visibility: 'collapsed' })
    return { reconciler, rows: () => chat.render(96).map(row => row.trimEnd()) }
  }

  /** One user node, as the store builds it for each way a prompt was routed. */
  function userNode(overrides: Partial<UserMessageNode>): UserMessageNode {
    return { kind: 'user-message', key: 'user:1', version: 0, time: 0, text: 'PROMPT-TEXT', source: 'user', ...overrides }
  }

  function badgeRows(node: UserMessageNode): string[] {
    const mounted = mountReconciler()
    mounted.reconciler.reconcile([node])
    return mounted.rows().map(row => row.trim()).filter(row => row !== '' && !row.includes('PROMPT-TEXT'))
  }

  it('marks an echo the inbox has not claimed, and drops the mark once it has', () => {
    assert.deepEqual(badgeRows(userNode({ source: 'steering', optimistic: true })), ['Steering · pending'])
    // The logged message replaces the echo without `optimistic`, so the marker
    // settles by itself: nothing has to invalidate it.
    assert.deepEqual(badgeRows(userNode({ source: 'steering' })), ['Steering'])
  })

  it('names a prompt parked for a turn of its own, and badges an ordinary one not at all', () => {
    assert.deepEqual(badgeRows(userNode({ source: 'queued', optimistic: true })), ['Queued'])
    assert.deepEqual(badgeRows(userNode({})), [])
  })
})

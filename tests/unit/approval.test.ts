/**
 * Approval smoke tests: dispatch the `approval/request` waterfall at a mounted
 * TUI and assert the terminal answers it — the permission dialog reaches the
 * frame, a number shortcut settles the outcome, a withdrawn request takes the
 * dialog back down, and a question for another agent falls through the chain.
 * @module dsh-tui/tests/unit/approval
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import {
  createTuiTestHarness,
  disposeTuiTestHarness,
  tuiEntryAvailable,
  type TuiHarness,
  type TuiHarnessOptions,
} from '../harness.ts'
import { HeadlessTerminal } from '../headless-terminal.ts'

/** Literal editor prefix, so a frame assertion never depends on prompt-value registrations. */
const INPUT_PROMPT = 'smoke> '

/** `src/index.ts` is landed by a separate port; without it the end-to-end suite cannot run. */
const entryAvailable = await tuiEntryAvailable()
const skipWithoutEntry = entryAvailable
  ? false
  : 'requires src/index.ts to export createTuiChat(ctx, config, runtime)'

type SmokeHarness = TuiHarness<HeadlessTerminal, (code: number) => void>

/** `TuiController.submit` is the typed-line path; the harness handle only declares disposal. */
interface SubmitHandle {
  submit(text: string): void
}

/** A command handler settles through its own promise chain before the panel opens; outwait it. */
const SETTLE_MS = 60

/** The fail-closed tail of the answerer chain, standing in for the approval service's default. */
function chainDefault(): Promise<ApprovalOutcome> {
  return Promise.resolve('unavailable')
}

/** Mount the TUI on a headless terminal and wait for its first completed frame. */
async function mount(options: TuiHarnessOptions = {}): Promise<SmokeHarness> {
  const terminal = new HeadlessTerminal(96, 32)
  const before = terminal.frames
  const harness = await createTuiTestHarness(terminal, () => {}, {
    cwd: '/workspace/project',
    ...options,
    config: {
      title: 'DSH approval',
      ...options.config,
      theme: { color: false, inputPrompt: INPUT_PROMPT, ...options.config?.theme },
    },
  })
  await terminal.waitForFrame(before)
  return harness
}

async function unmount(harness: SmokeHarness): Promise<void> {
  await disposeTuiTestHarness(harness)
  await harness.terminal.dispose()
}

describe('TUI approval', { skip: skipWithoutEntry }, () => {
  it('shows the permission dialog and answers allowed-once on the number shortcut', async () => {
    const harness = await mount()
    try {
      const before = harness.terminal.frames
      const decision = harness.ctx.waterfall('approval/request', {
        agent: harness.agent,
        toolName: 'bash',
        reason: 'Deleting files needs confirmation',
      }, chainDefault)
      await harness.terminal.waitForFrame(before)

      const frame = harness.terminal.text()
      assert.match(frame, /Permission required/)
      assert.match(frame, /bash/)
      assert.match(frame, /Deleting files needs confirmation/)
      assert.match(frame, /1\. Yes, allow once/)
      assert.match(frame, /2\. Yes, and don't ask again for bash this session/)
      assert.match(frame, /3\. No, and tell the agent what to do differently/)
      assert.match(frame, /4\. No, reject/)
      // The prompt row stays reachable underneath, so the dialog is inline chrome
      // rather than a takeover screen.
      assert.ok(frame.includes(INPUT_PROMPT), `editor prompt must stay visible:\n${frame}`)
      assert.match(frame, /❯ 1\. Yes, allow once/)

      // Arrow navigation redraws the cursor, so the list is usable without the
      // number shortcuts.
      const moved = harness.terminal.frames
      harness.terminal.send('\x1b[B')
      await harness.terminal.waitForFrame(moved)
      assert.match(harness.terminal.text(), /❯ 2\. Yes, and don't ask again/)

      const shown = harness.terminal.frames
      harness.terminal.send('1')
      assert.equal(await decision, 'allowed-once')
      await harness.terminal.waitForFrame(shown)
      assert.doesNotMatch(harness.terminal.text(), /Permission required/)
    } finally {
      await unmount(harness)
    }
  })

  it('stops asking about a tool the user granted for the session, and says so', async () => {
    // rc.6 grants are one-shot: the seam has no `allow-always`, so "don't ask
    // again" only exists if the terminal remembers it and answers the later
    // asks itself.
    const harness = await mount()
    try {
      const before = harness.terminal.frames
      const first = harness.ctx.waterfall('approval/request', {
        agent: harness.agent,
        toolName: 'bash',
      }, chainDefault)
      await harness.terminal.waitForFrame(before)

      const granted = harness.terminal.frames
      harness.terminal.send('2')
      assert.equal(await first, 'allowed-once')
      await harness.terminal.waitForFrame(granted)
      const notice = harness.terminal.text()
      assert.match(notice, /Allowing bash for the rest of this session/, `the scope is disclosed:\n${notice}`)
      assert.doesNotMatch(notice, /Permission required/)

      // The second ask is answered without drawing anything: no dialog, and the
      // outcome is the same one-shot grant the user would have given by hand.
      const second = harness.ctx.waterfall('approval/request', {
        agent: harness.agent,
        toolName: 'bash',
      }, chainDefault)
      assert.equal(await second, 'allowed-once')
      await harness.terminal.flush()
      assert.doesNotMatch(harness.terminal.text(), /Permission required/)

      // The grant is per tool, not a blanket policy.
      const other = harness.terminal.frames
      const third = harness.ctx.waterfall('approval/request', {
        agent: harness.agent,
        toolName: 'edit',
      }, chainDefault)
      await harness.terminal.waitForFrame(other)
      assert.match(harness.terminal.text(), /Permission required/)
      harness.terminal.send('4')
      assert.equal(await third, 'rejected')
    } finally {
      await unmount(harness)
    }
  })

  it('rejects with the feedback the user typed, delivered as a steered turn', async () => {
    // The approval seam carries an outcome and nothing else, so the only way
    // the model hears "do it this way instead" is a user turn beside the denial.
    const harness = await mount({ status: 'running' })
    try {
      const before = harness.terminal.frames
      const decision = harness.ctx.waterfall('approval/request', {
        agent: harness.agent,
        toolName: 'bash',
      }, chainDefault)
      await harness.terminal.waitForFrame(before)

      const opened = harness.terminal.frames
      harness.terminal.send('3')
      await harness.terminal.waitForFrame(opened)
      const editor = harness.terminal.text()
      assert.match(editor, /Tell the agent what to do differently/, `the box replaces the list:\n${editor}`)
      assert.doesNotMatch(editor, /1\. Yes, allow once/)

      const typed = harness.terminal.frames
      harness.terminal.send('use rg instead')
      await harness.terminal.waitForFrame(typed)
      harness.terminal.send('\r')
      assert.equal(await decision, 'rejected')
      await delay(SETTLE_MS)
      assert.deepEqual(
        harness.agent.steered.map(message => message.content.map(block => block.type === 'text' ? block.text : '').join('')),
        ['use rg instead'],
        'the instruction reaches the running driver at its next step',
      )
    } finally {
      await unmount(harness)
    }
  })

  it('returns to the answers on Esc in the feedback box, and fails closed on Ctrl+C', async () => {
    const harness = await mount()
    try {
      const before = harness.terminal.frames
      const decision = harness.ctx.waterfall('approval/request', {
        agent: harness.agent,
        toolName: 'bash',
      }, chainDefault)
      await harness.terminal.waitForFrame(before)

      const opened = harness.terminal.frames
      harness.terminal.send('3')
      await harness.terminal.waitForFrame(opened)
      assert.match(harness.terminal.text(), /Tell the agent what to do differently/)

      // Esc is the one place in this dialog that does not refuse: opening the
      // box by mistake has decided nothing.
      const back = harness.terminal.frames
      harness.terminal.send('\x1b')
      await harness.terminal.waitForFrame(back)
      const list = harness.terminal.text()
      assert.match(list, /1\. Yes, allow once/, `the answers come back:\n${list}`)
      assert.doesNotMatch(list, /Tell the agent what to do differently:/)

      harness.terminal.send('3')
      await harness.terminal.flush()
      harness.terminal.send('\x03')
      assert.equal(await decision, 'rejected')
      assert.deepEqual(harness.agent.steered, [], 'an abandoned box sends no instruction')
    } finally {
      await unmount(harness)
    }
  })

  it('answers rejected when the dialog is dismissed with Esc', async () => {
    const harness = await mount()
    try {
      const before = harness.terminal.frames
      const decision = harness.ctx.waterfall('approval/request', {
        agent: harness.agent,
        toolName: 'edit',
      }, chainDefault)
      await harness.terminal.waitForFrame(before)
      assert.match(harness.terminal.text(), /Permission required/)

      harness.terminal.send('\x1b')
      assert.equal(await decision, 'rejected')
    } finally {
      await unmount(harness)
    }
  })

  it('withdraws the dialog and answers cancelled when the request aborts', async () => {
    const harness = await mount()
    try {
      const controller = new AbortController()
      const before = harness.terminal.frames
      const decision = harness.ctx.waterfall('approval/request', {
        agent: harness.agent,
        toolName: 'bash',
        signal: controller.signal,
      }, chainDefault)
      await harness.terminal.waitForFrame(before)
      assert.match(harness.terminal.text(), /Permission required/)

      const shown = harness.terminal.frames
      controller.abort()
      assert.equal(await decision, 'cancelled')
      await harness.terminal.waitForFrame(shown)
      assert.doesNotMatch(harness.terminal.text(), /Permission required/)
    } finally {
      await unmount(harness)
    }
  })

  it('waits for an active user question instead of stacking a second dialog', async () => {
    const harness = await mount()
    try {
      const before = harness.terminal.frames
      const answer = harness.ctx.userQuestions.ask({
        questions: [{ id: 'q1', question: 'Which branch?', options: [{ label: 'main' }, { label: 'staging' }] }],
      })
      await harness.terminal.waitForFrame(before)
      assert.match(harness.terminal.text(), /Which branch\?/)

      const decision = harness.ctx.waterfall('approval/request', {
        agent: harness.agent,
        toolName: 'bash',
      }, chainDefault)
      // The question owns the single inline slot, so the queued permission
      // prompt draws nothing at all — there is no frame to wait for, only the
      // writes already in flight.
      await harness.terminal.flush()
      const queued = harness.terminal.text()
      assert.match(queued, /Which branch\?/)
      assert.doesNotMatch(queued, /Permission required/)

      const answered = harness.terminal.frames
      harness.terminal.send('\r')
      assert.deepEqual((await answer).answers, [{ id: 'q1', selected: ['main'] }])
      await harness.terminal.waitForFrame(answered)
      assert.match(harness.terminal.text(), /Permission required/)

      harness.terminal.send('4')
      assert.equal(await decision, 'rejected')
    } finally {
      await unmount(harness)
    }
  })

  it('takes an open panel down so the permission prompt is answerable', async () => {
    const harness = await mount()
    try {
      // A panel is what the user is most likely to have left open while the
      // agent works: `/hotkeys` here stands for `/status`, `/help`, `/palette`.
      ;(harness.controller as unknown as SubmitHandle).submit('/hotkeys')
      await delay(SETTLE_MS)
      assert.match(harness.terminal.text(), /Enter send/, 'the panel is open before the request arrives')

      const before = harness.terminal.frames
      const decision = harness.ctx.waterfall('approval/request', {
        agent: harness.agent,
        toolName: 'bash',
      }, chainDefault)
      await harness.terminal.waitForFrame(before)

      // Without this the panel kept the single inline slot, the prompt drew
      // nothing, and the turn waited on a decision no one could see.
      const frame = harness.terminal.text()
      assert.match(frame, /Permission required/, `the prompt replaces the panel:\n${frame}`)
      assert.doesNotMatch(frame, /Enter send/, `and the panel is gone, not stacked under it:\n${frame}`)

      harness.terminal.send('4')
      assert.equal(await decision, 'rejected')
    } finally {
      await unmount(harness)
    }
  })

  it('takes the model selector down as well: a picker holds nothing open', async () => {
    const harness = await mount()
    try {
      // The selector is opened by its own controller, which receives the
      // overlay manager rather than a per-request flag — so this is the case
      // that fails if the marking view around that manager stops marking.
      ;(harness.controller as unknown as SubmitHandle).submit('/model')
      await delay(SETTLE_MS)
      assert.match(harness.terminal.text(), /Select model/, 'the selector is open before the request arrives')

      const before = harness.terminal.frames
      const decision = harness.ctx.waterfall('approval/request', {
        agent: harness.agent,
        toolName: 'bash',
      }, chainDefault)
      await harness.terminal.waitForFrame(before)

      const frame = harness.terminal.text()
      assert.match(frame, /Permission required/, `the prompt replaces the selector:\n${frame}`)
      assert.doesNotMatch(frame, /Select model/, `and the selector is gone, not stacked under it:\n${frame}`)

      harness.terminal.send('4')
      assert.equal(await decision, 'rejected')
    } finally {
      await unmount(harness)
    }
  })

  it('takes an open panel down for a question too, and gives the editor its focus back', async () => {
    const harness = await mount()
    try {
      ;(harness.controller as unknown as SubmitHandle).submit('/hotkeys')
      await delay(SETTLE_MS)
      assert.match(harness.terminal.text(), /Enter send/)

      const before = harness.terminal.frames
      const answer = harness.ctx.userQuestions.ask({
        questions: [{ id: 'q1', question: 'Which branch?', options: [{ label: 'main' }, { label: 'staging' }] }],
      })
      await harness.terminal.waitForFrame(before)
      const asked = harness.terminal.text()
      assert.match(asked, /Which branch\?/, `the question replaces the panel:\n${asked}`)
      assert.doesNotMatch(asked, /Enter send/)

      const answered = harness.terminal.frames
      harness.terminal.send('\r')
      assert.deepEqual((await answer).answers, [{ id: 'q1', selected: ['main'] }])
      await harness.terminal.waitForFrame(answered)

      // The dismissed panel does not come back, and the keyboard belongs to the
      // editor again rather than to a surface that is no longer on screen.
      const restored = harness.terminal.frames
      harness.terminal.send('zz')
      await harness.terminal.waitForFrame(restored)
      const after = harness.terminal.text()
      assert.ok(after.includes('zz'), `typing reaches the editor again:\n${after}`)
      assert.doesNotMatch(after, /Enter send/)
    } finally {
      await unmount(harness)
    }
  })

  it('passes a request for another agent down the answerer chain', async () => {
    const harness = await mount()
    try {
      let chainCalls = 0
      const decision = await harness.ctx.waterfall('approval/request', {
        // Only the session identity is read before the request is handed on.
        agent: { session: { id: SessionId('other-session') } } as Agent,
        toolName: 'bash',
      }, () => {
        chainCalls += 1
        return chainDefault()
      })
      assert.equal(decision, 'unavailable')
      assert.equal(chainCalls, 1)
      assert.doesNotMatch(harness.terminal.text(), /Permission required/)
    } finally {
      await unmount(harness)
    }
  })
})

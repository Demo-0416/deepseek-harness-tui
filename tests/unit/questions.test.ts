/**
 * Ask-user-question dialog at the terminal boundary: how a user leaves it, and
 * whether the screen tells them how to reach the answer they want to type.
 *
 * Both cases are about the custom-answer mode, which trades the option list for
 * a one-line editor: an editor that claims every key it is handed can strand the
 * turn behind a question nobody can withdraw, and a mode nobody is told about is
 * one nobody enters.
 * @module dsh-tui/tests/unit/questions
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  createTuiTestHarness,
  disposeTuiTestHarness,
  tuiEntryAvailable,
  type TuiHarness,
  type TuiHarnessOptions,
} from '../harness.ts'
import { HeadlessTerminal } from '../headless-terminal.ts'

/** Literal editor prefix, so a frame assertion never depends on prompt-value registrations. */
const INPUT_PROMPT = 'ask> '

/** `src/index.ts` is landed by a separate port; without it the end-to-end suite cannot run. */
const entryAvailable = await tuiEntryAvailable()
const skipWithoutEntry = entryAvailable
  ? false
  : 'requires src/index.ts to export createTuiChat(ctx, config, runtime)'

type QuestionHarness = TuiHarness<HeadlessTerminal, (code: number) => void>

async function mount(options: TuiHarnessOptions = {}): Promise<QuestionHarness> {
  const terminal = new HeadlessTerminal(96, 32)
  const before = terminal.frames
  const harness = await createTuiTestHarness(terminal, () => {}, {
    cwd: '/workspace/project',
    ...options,
    config: {
      title: 'DSH questions',
      ...options.config,
      theme: { color: false, inputPrompt: INPUT_PROMPT, ...options.config?.theme },
    },
  })
  await terminal.waitForFrame(before)
  return harness
}

async function unmount(harness: QuestionHarness): Promise<void> {
  await disposeTuiTestHarness(harness)
  await harness.terminal.dispose()
}

/**
 * Ask one two-option question and wait for the dialog to reach the frame.
 *
 * The pending ask is handed back inside a wrapper because an `async` function
 * that returns a promise adopts it: returned bare, the helper would wait for the
 * very answer the test has not given yet.
 */
async function ask(harness: QuestionHarness): Promise<{ answer: Promise<unknown> }> {
  const before = harness.terminal.frames
  const answer = harness.ctx.userQuestions.ask({
    questions: [{ id: 'q1', question: 'Which branch?', options: [{ label: 'main' }, { label: 'staging' }] }],
  })
  await harness.terminal.waitForFrame(before)
  assert.match(harness.terminal.text(), /Which branch\?/)
  return { answer }
}

describe('TUI questions', { skip: skipWithoutEntry }, () => {
  it('cancels from the custom editor on Ctrl+C', async () => {
    const harness = await mount()
    try {
      const { answer } = await ask(harness)

      const custom = harness.terminal.frames
      harness.terminal.send('c')
      await harness.terminal.waitForFrame(custom)
      assert.match(harness.terminal.text(), /Enter submit/, 'the editor has replaced the option list')

      // Without this the editor typed the control character and the question
      // stayed on screen: `Esc` there only walks back to the options, so the
      // dialog had no exit at all once custom mode was entered.
      const closed = harness.terminal.frames
      harness.terminal.send('\x03')
      await assert.rejects(answer, /interrupted before the user answered/)
      await harness.terminal.waitForFrame(closed)
      assert.doesNotMatch(harness.terminal.text(), /Which branch\?/)
    } finally {
      await unmount(harness)
    }
  })

  it('advertises both keys that open the custom editor', async () => {
    const harness = await mount()
    try {
      const { answer } = await ask(harness)
      // `c` has been bound as long as `Tab` has; only the footer was silent
      // about it, which made it a shortcut for readers of the source.
      assert.match(harness.terminal.text(), /Tab\/c custom answer/)

      const custom = harness.terminal.frames
      harness.terminal.send('c')
      await harness.terminal.waitForFrame(custom)
      assert.match(harness.terminal.text(), /Esc options/, 'the advertised key really opens the editor')

      harness.terminal.send('\x03')
      await assert.rejects(answer, /interrupted before the user answered/)
    } finally {
      await unmount(harness)
    }
  })
})

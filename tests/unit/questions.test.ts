/**
 * Ask-user-question dialog at the terminal boundary: the Claude-Code-style
 * answer surface (numbered options with a trailing "Type something." row) and
 * how a user leaves it.
 *
 * The custom answer is a list row that becomes a one-line editor when focused:
 * an editor that claims every key it is handed can strand the turn behind a
 * question nobody can withdraw, so the interrupt and the number-key shortcuts
 * are asserted on the mounted terminal, where the keys actually arrive.
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
  it('renders numbered options with the trailing custom-answer row', async () => {
    const harness = await mount()
    try {
      const { answer } = await ask(harness)
      const text = harness.terminal.text()
      assert.match(text, /❯ 1\. main/, 'the focused option carries the pointer')
      assert.match(text, /2\. staging/)
      assert.match(text, /3\. Type something\./, 'the custom answer is a numbered list row')
      assert.match(text, /Enter to select · ↑\/↓ to navigate · Esc to cancel/)

      harness.terminal.send('\x1b')
      await assert.rejects(answer, /interrupted before the user answered/)
    } finally {
      await unmount(harness)
    }
  })

  it('answers straight away from a number key', async () => {
    const harness = await mount()
    try {
      const { answer } = await ask(harness)
      const closed = harness.terminal.frames
      harness.terminal.send('2')
      assert.deepEqual(await answer, { answers: [{ id: 'q1', selected: ['staging'] }] })
      await harness.terminal.waitForFrame(closed)
      assert.doesNotMatch(harness.terminal.text(), /Which branch\?/)
    } finally {
      await unmount(harness)
    }
  })

  it('cancels from the custom-answer row on Ctrl+C', async () => {
    const harness = await mount()
    try {
      const { answer } = await ask(harness)

      const custom = harness.terminal.frames
      harness.terminal.send('3')
      harness.terminal.send('zz')
      await harness.terminal.waitForFrame(custom)
      assert.match(harness.terminal.text(), /zz/, 'the focused row types like an editor')

      // Without this the editor typed the control character and the question
      // stayed on screen: every key the editor does not claim is a character
      // it types, so the interrupt has to be handled before the editor is.
      const closed = harness.terminal.frames
      harness.terminal.send('\x03')
      await assert.rejects(answer, /interrupted before the user answered/)
      await harness.terminal.waitForFrame(closed)
      assert.doesNotMatch(harness.terminal.text(), /Which branch\?/)
    } finally {
      await unmount(harness)
    }
  })

  it('submits the typed row as the custom answer', async () => {
    const harness = await mount()
    try {
      const { answer } = await ask(harness)
      harness.terminal.send('3')
      harness.terminal.send('release-2.4')
      harness.terminal.send('\r')
      assert.deepEqual(await answer, { answers: [{ id: 'q1', selected: [], custom: 'release-2.4' }] })
    } finally {
      await unmount(harness)
    }
  })
})

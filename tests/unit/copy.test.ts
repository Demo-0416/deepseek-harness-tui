/**
 * `/copy` and Ctrl+X at the mounted TUI: which text the terminal copies, what
 * it writes to the terminal to finish the job, and what it tells the user
 * afterwards. The clipboard port's own three paths are covered by the
 * clipboard suite; this is only the wiring around it.
 *
 * Every case runs the OSC 52 path, forced through the environment: with
 * `SSH_CONNECTION` set and `TMUX` absent the port launches no subprocess at
 * all, so the suite never touches the real clipboard of the machine it runs on.
 * @module dsh-tui/tests/unit/copy
 */

import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { after, before, describe, it } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { CallId } from '@deepseek-ai/dsh-llm'
import {
  appendAssistant,
  createTuiTestHarness,
  disposeTuiTestHarness,
  tuiEntryAvailable,
  type TuiHarness,
  type TuiHarnessOptions,
} from '../harness.ts'
import { HeadlessTerminal } from '../headless-terminal.ts'

/** Literal editor prefix, so a frame assertion never depends on prompt-value registrations. */
const INPUT_PROMPT = 'copy> '

/** Ctrl+X as the terminal delivers it. */
const CTRL_X = '\x18'

/** The copy resolves through the port's own awaits; outwait them. */
const SETTLE_MS = 60

/** `src/index.ts` is landed by a separate port; without it the end-to-end suite cannot run. */
const entryAvailable = await tuiEntryAvailable()
const skipWithoutEntry = entryAvailable
  ? false
  : 'requires src/index.ts to export createTuiChat(ctx, config, runtime)'

type CopyHarness = TuiHarness<HeadlessTerminal, (code: number) => void> & {
  /** Every raw chunk written to the terminal, frames included. */
  readonly writes: string[]
}

const savedEnv = { ssh: process.env['SSH_CONNECTION'], tmux: process.env['TMUX'] }

before(() => {
  process.env['SSH_CONNECTION'] = '1.2.3.4 5 6.7.8.9 22'
  delete process.env['TMUX']
})

after(() => {
  if (savedEnv.ssh === undefined) delete process.env['SSH_CONNECTION']
  else process.env['SSH_CONNECTION'] = savedEnv.ssh
  if (savedEnv.tmux !== undefined) process.env['TMUX'] = savedEnv.tmux
})

/** Mount the TUI on a headless terminal that also records every raw write. */
async function mount(options: TuiHarnessOptions = {}): Promise<CopyHarness> {
  const terminal = new HeadlessTerminal(96, 32)
  const writes: string[] = []
  const emulate = terminal.write.bind(terminal)
  terminal.write = (data: string) => {
    writes.push(data)
    emulate(data)
  }
  const before_ = terminal.frames
  const harness = await createTuiTestHarness(terminal, () => {}, {
    cwd: '/workspace/project',
    ...options,
    config: {
      title: 'DSH copy',
      ...options.config,
      theme: { color: false, inputPrompt: INPUT_PROMPT, ...options.config?.theme },
    },
  })
  await terminal.waitForFrame(before_)
  return Object.assign(harness, { writes })
}

async function unmount(harness: CopyHarness): Promise<void> {
  await disposeTuiTestHarness(harness)
  await harness.terminal.dispose()
}

/** The one chunk carrying an OSC 52 clipboard write, or `undefined`. */
function clipboardWrite(writes: readonly string[]): string | undefined {
  return writes.find(chunk => chunk.includes('\x1b]52;c;'))
}

describe('TUI copy', { skip: skipWithoutEntry }, () => {
  it('copies the last answer on Ctrl+X and names the path it took', async () => {
    const harness = await mount({
      beforeMount(session) {
        appendAssistant(session, [{ type: 'text', text: 'first answer' }], undefined, { turn: 1, step: 1 })
        appendAssistant(session, [{ type: 'text', text: 'the latest answer' }], undefined, { turn: 1, step: 2 })
      },
    })
    try {
      const before_ = harness.terminal.frames
      harness.terminal.send(CTRL_X)
      await harness.terminal.waitForFrame(before_)

      const sequence = clipboardWrite(harness.writes)
      assert.ok(sequence !== undefined, `Ctrl+X writes the clipboard sequence:\n${harness.writes.join('|')}`)
      // The newest answer, not the first one, and the model's own text rather
      // than the markdown the transcript painted from it.
      assert.equal(sequence, `\x1b]52;c;${Buffer.from('the latest answer', 'utf8').toString('base64')}\x07`)
      // Written outside the frame's synchronized update: it is an instruction
      // to the terminal emulator, not a cell pi-tui may redraw over.
      assert.doesNotMatch(sequence, /\x1b\[\?2026[hl]/u)
      assert.match(harness.terminal.text(), /Sent to clipboard via OSC 52\./)
    } finally {
      await unmount(harness)
    }
  })

  it('copies from /copy through the same action', async () => {
    const harness = await mount({
      beforeMount(session) {
        appendAssistant(session, [{ type: 'text', text: 'answer via command' }])
      },
    })
    try {
      ;(harness.controller as unknown as { submit(text: string): void }).submit('/copy')
      await delay(SETTLE_MS)

      assert.equal(
        clipboardWrite(harness.writes),
        `\x1b]52;c;${Buffer.from('answer via command', 'utf8').toString('base64')}\x07`,
      )
      assert.match(harness.terminal.text(), /Sent to clipboard via OSC 52\./)
      // The confirmation is a status-row flash, not a transcript row: a copy
      // says something about the screen, not about the conversation.
      assert.doesNotMatch(harness.terminal.text(), /● Sent to clipboard/)
    } finally {
      await unmount(harness)
    }
  })

  it('says so instead of copying nothing when the session has no answer yet', async () => {
    const harness = await mount()
    try {
      const before_ = harness.terminal.frames
      harness.terminal.send(CTRL_X)
      await harness.terminal.waitForFrame(before_)

      assert.match(harness.terminal.text(), /Nothing to copy yet\./)
      assert.equal(clipboardWrite(harness.writes), undefined, 'and no clipboard write goes out')
    } finally {
      await unmount(harness)
    }
  })

  it('skips a step that produced only tool calls and copies the last text answer', async () => {
    const harness = await mount({
      beforeMount(session) {
        appendAssistant(session, [{ type: 'text', text: 'the spoken answer' }], undefined, { turn: 1, step: 1 })
        appendAssistant(session, [{
          type: 'tool-call',
          id: CallId('call-1'),
          name: 'read',
          arguments: JSON.stringify({ path: 'README.md' }),
        }], undefined, { turn: 1, step: 2 })
      },
    })
    try {
      const before_ = harness.terminal.frames
      harness.terminal.send(CTRL_X)
      await harness.terminal.waitForFrame(before_)

      assert.equal(
        clipboardWrite(harness.writes),
        `\x1b]52;c;${Buffer.from('the spoken answer', 'utf8').toString('base64')}\x07`,
      )
    } finally {
      await unmount(harness)
    }
  })
})

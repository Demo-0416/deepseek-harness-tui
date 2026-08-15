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
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { CallId } from '@deepseek-ai/dsh-llm'
import { collectAnswerTexts, parseCopyArgument } from '../../src/chat/copy.ts'
import type { ChatNode } from '../../src/core/types.ts'
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

/** Run one slash command through the registry the editor submits into. */
async function run(harness: CopyHarness, line: string): Promise<CommandResult | undefined> {
  const execution = await harness.ctx.commands.execute(harness.agent, line, AbortSignal.timeout(5_000))
  return execution?.result
}

/** The text a clipboard write carried, decoded back out of its OSC 52 payload. */
function clipboardText(writes: readonly string[]): string | undefined {
  const sequence = clipboardWrite(writes)
  if (sequence === undefined) return undefined
  const payload = /\x1b\]52;c;([^\x07]*)\x07/u.exec(sequence)?.[1] ?? ''
  return Buffer.from(payload, 'base64').toString('utf8')
}

/** Seed three answers, so `/copy 2` has a middle one to land on. */
function threeAnswers(): TuiHarnessOptions {
  return {
    beforeMount(session) {
      appendAssistant(session, [{ type: 'text', text: 'first answer' }], undefined, { turn: 1, step: 1 })
      appendAssistant(session, [{ type: 'text', text: 'second answer' }], undefined, { turn: 1, step: 2 })
      appendAssistant(session, [{ type: 'text', text: 'third answer' }], undefined, { turn: 1, step: 3 })
    },
  }
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

describe('/copy N', { skip: skipWithoutEntry }, () => {
  it('copies the Nth-latest answer and says which one it took', async () => {
    const harness = await mount(threeAnswers())
    try {
      const result = await run(harness, '/copy 2')
      await delay(SETTLE_MS)

      assert.equal(result?.kind, 'success')
      assert.equal(result?.text, undefined, 'the status row already said it; no transcript line follows')
      assert.equal(clipboardText(harness.writes), 'second answer')
      // The number counts back from the newest answer — `/copy 2` of three took
      // the second one in time — so the row has to name the direction, or the
      // reader checks the wrong end of the transcript for what they copied.
      assert.match(harness.terminal.text(), /Answer 2 of 3, newest first/u, harness.terminal.text())
    } finally {
      await unmount(harness)
    }
  })

  it('numbers 1 as the last answer, and still reports the position', async () => {
    const harness = await mount(threeAnswers())
    try {
      await run(harness, '/copy 1')
      await delay(SETTLE_MS)

      assert.equal(clipboardText(harness.writes), 'third answer')
      assert.match(harness.terminal.text(), /Answer 1 of 3, newest first/u, harness.terminal.text())
    } finally {
      await unmount(harness)
    }
  })

  it('leaves a bare /copy saying nothing about position', async () => {
    const harness = await mount(threeAnswers())
    try {
      await run(harness, '/copy')
      await delay(SETTLE_MS)

      assert.equal(clipboardText(harness.writes), 'third answer')
      const frame = harness.terminal.text()
      assert.match(frame, /Sent to clipboard via OSC 52\./u, frame)
      // `/copy` already means "the last one": a position on it would answer a
      // question nobody asked.
      assert.doesNotMatch(frame, /Answer 1 of 3/u, frame)
    } finally {
      await unmount(harness)
    }
  })

  it('refuses anything that is not a whole number, and echoes what it was given', async () => {
    const harness = await mount({
      beforeMount(session) { appendAssistant(session, [{ type: 'text', text: 'only answer' }]) },
    })
    try {
      for (const argument of ['0', '-1', '1.5', 'two']) {
        const result = await run(harness, `/copy ${argument}`)
        assert.equal(result?.kind, 'error', argument)
        assert.match(result?.text ?? '', /takes a whole number/u, argument)
        assert.ok((result?.text ?? '').includes(argument), `the refusal quotes ${argument}: ${result?.text ?? ''}`)
      }
      await delay(SETTLE_MS)
      assert.equal(clipboardWrite(harness.writes), undefined, 'and nothing reached the clipboard')
    } finally {
      await unmount(harness)
    }
  })

  it('names how many answers there are when N is past the end', async () => {
    const harness = await mount({
      beforeMount(session) {
        appendAssistant(session, [{ type: 'text', text: 'first answer' }], undefined, { turn: 1, step: 1 })
        appendAssistant(session, [{ type: 'text', text: 'second answer' }], undefined, { turn: 1, step: 2 })
      },
    })
    try {
      const result = await run(harness, '/copy 5')
      await delay(SETTLE_MS)

      assert.equal(result?.kind, 'error')
      assert.equal(result?.text, 'This session has only 2 answers to copy.')
      assert.equal(clipboardWrite(harness.writes), undefined)
    } finally {
      await unmount(harness)
    }
  })

  it('counts one answer in the singular', async () => {
    const harness = await mount({
      beforeMount(session) { appendAssistant(session, [{ type: 'text', text: 'only answer' }]) },
    })
    try {
      const result = await run(harness, '/copy 9')
      assert.equal(result?.text, 'This session has only 1 answer to copy.')
    } finally {
      await unmount(harness)
    }
  })

  it('keeps the refusal on screen when N is asked of a session with no answers', async () => {
    const harness = await mount()
    try {
      const result = await run(harness, '/copy 1')
      await delay(SETTLE_MS)

      // Unlike the bare `/copy`, which flashes: an argument that could not be
      // served is something the user comes back to read.
      assert.equal(result?.kind, 'error')
      assert.equal(result?.text, 'Nothing to copy yet.')
      assert.equal(clipboardWrite(harness.writes), undefined)
    } finally {
      await unmount(harness)
    }
  })

  it('numbers only the steps that spoke', async () => {
    const harness = await mount({
      beforeMount(session) {
        appendAssistant(session, [{ type: 'text', text: 'the spoken answer' }], undefined, { turn: 1, step: 1 })
        appendAssistant(session, [{
          type: 'tool-call',
          id: CallId('call-1'),
          name: 'read',
          arguments: JSON.stringify({ path: 'README.md' }),
        }], undefined, { turn: 1, step: 2 })
        appendAssistant(session, [{ type: 'text', text: 'a later answer' }], undefined, { turn: 1, step: 3 })
      },
    })
    try {
      await run(harness, '/copy 2')
      await delay(SETTLE_MS)

      assert.equal(clipboardText(harness.writes), 'the spoken answer')
    } finally {
      await unmount(harness)
    }
  })
})

describe('copy argument parsing', () => {
  it('treats no argument as the latest answer', () => {
    assert.deepEqual(parseCopyArgument(''), { kind: 'latest' })
    assert.deepEqual(parseCopyArgument('   '), { kind: 'latest' })
  })

  it('reads a decimal ordinal, padding included', () => {
    assert.deepEqual(parseCopyArgument(' 3 '), { kind: 'nth', n: 3 })
    assert.deepEqual(parseCopyArgument('007'), { kind: 'nth', n: 7 })
  })

  it('refuses everything else rather than quietly reading it as 1', () => {
    for (const input of ['0', '-1', '1.5', '+1', 'two', '1 2']) {
      assert.deepEqual(parseCopyArgument(` ${input} `), { kind: 'invalid', input }, input)
    }
  })
})

describe('collectAnswerTexts', () => {
  /** The smallest node the collector reads: a kind and a body. */
  function assistantNode(text: string): ChatNode {
    return { kind: 'assistant', key: `a-${text}`, time: 0, text } as unknown as ChatNode
  }

  it('returns the answers newest first and drops the ones with nothing in them', () => {
    const nodes = [
      assistantNode('oldest'),
      { kind: 'notice', key: 'n', time: 0, text: 'a notice' } as unknown as ChatNode,
      assistantNode('   '),
      assistantNode('newest'),
    ]
    assert.deepEqual(collectAnswerTexts(nodes), ['newest', 'oldest'])
  })

  it('escapes terminal controls on the way out, exactly as the transcript does', () => {
    assert.deepEqual(collectAnswerTexts([assistantNode('bell\u0007here')]), ['bell\\x07here'])
  })
})

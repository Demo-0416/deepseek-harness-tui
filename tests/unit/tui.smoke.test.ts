/**
 * TUI smoke tests: mount the real `createTuiChat` on a fake agent and a headless
 * ANSI terminal, then assert on rendered cells rather than escape sequences.
 *
 * The case selection mirrors the upstream suite's load-bearing checks — mount
 * lifecycle, first-frame header/transcript/editor, typed input, prompt
 * submission routing, theme-agnostic output, and disposal — without importing
 * its 7k-line spec.
 * @module dsh-tui/tests/unit/tui.smoke
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  appendAssistant,
  appendUser,
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
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Text, TuiMainScreen } from '@earendil-works/pi-tui'

/** Literal editor prefix, so "the editor is on screen" does not depend on prompt-value registrations. */
const INPUT_PROMPT = 'smoke> '

/** `src/index.ts` is landed by a separate port; without it the end-to-end suite cannot run. */
const entryAvailable = await tuiEntryAvailable()
const skipWithoutEntry = entryAvailable
  ? false
  : 'requires src/index.ts to export createTuiChat(ctx, config, runtime)'

type SmokeHarness = TuiHarness<HeadlessTerminal, (code: number) => void>

/** Mount the TUI on a headless terminal and wait for its first completed frame. */
async function mount(
  options: TuiHarnessOptions = {},
  size: { columns?: number; rows?: number } = {},
): Promise<SmokeHarness> {
  const terminal = new HeadlessTerminal(size.columns ?? 96, size.rows ?? 32)
  const before = terminal.frames
  const harness = await createTuiTestHarness(terminal, () => {}, {
    cwd: '/workspace/project',
    ...options,
    config: {
      title: 'DSH smoke',
      ...options.config,
      theme: { color: false, inputPrompt: INPUT_PROMPT, ...options.config?.theme },
    },
  })
  await terminal.waitForFrame(before)
  return harness
}

/** Run `action`, then settle the frame it triggers. */
async function renderAfter(harness: SmokeHarness, action: () => void): Promise<void> {
  const before = harness.terminal.frames
  action()
  await harness.terminal.waitForFrame(before)
}

async function unmount(harness: SmokeHarness): Promise<void> {
  await disposeTuiTestHarness(harness)
  await harness.terminal.dispose()
}

describe('TUI harness boundaries', () => {
  it('registers a fake agent whose routing calls project into a real inbox', async () => {
    const { ctx, session, agent } = await createTuiTestContext({ cwd: '/workspace/project' })
    try {
      assert.equal(ctx.agents.get(agent.id), agent)
      assert.equal(agent.session, session)
      assert.equal(agent.status, 'idle')
      assert.equal(session.header.cwd, '/workspace/project')
      // The harness seeds one open turn and step, as a live session would have.
      assert.deepEqual(session.events.map(event => event.type), ['turn/start', 'step/start'])

      const prompt = createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })
      agent.send(prompt, 'next-turn', true)
      assert.deepEqual(agent.sent.map(delivery => ({
        text: messageText(delivery.message),
        target: delivery.target,
        wakeup: delivery.wakeup,
      })), [{ text: 'hi', target: 'next-turn', wakeup: true }])
      assert.equal(agent.inbox.nextTurn.length, 1)

      agent.steer(createUserMessage({ content: [{ type: 'text', text: 'go left' }], source: { kind: 'user' } }))
      assert.deepEqual(agent.steered.map(messageText), ['go left'])
      assert.equal(agent.inbox.nextStep.length, 1)

      agent.cancel({ kind: 'user' })
      assert.deepEqual(agent.cancelled.map(record => record.cause), [{ kind: 'user' }])

      setAgentStatus(agent, 'running')
      assert.equal(agent.status, 'running')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('parses ANSI into cells and counts synchronized frames', async () => {
    const terminal = new HeadlessTerminal(24, 4)
    try {
      terminal.start(() => {}, () => {})
      terminal.write('\x1b[?2026hplain\r\n\x1b[31mred\x1b[0m\x1b[?2026l')
      await terminal.waitForFrame(0)

      assert.equal(terminal.frames, 1)
      assert.equal(terminal.started, 1)
      assert.deepEqual(terminal.text().split('\n'), ['plain', 'red', '', ''])
      // A 4-bit ANSI color is theme-agnostic; a 24-bit one is not.
      assert.deepEqual(terminal.themeViolations(), [])

      terminal.write('\x1b[?2026h\x1b[38;2;77;107;254mbrand\x1b[0m\x1b[?2026l')
      await terminal.waitForFrame(1)
      assert.equal(terminal.frames, 2)
      assert.ok(terminal.themeViolations().every(entry => entry.endsWith('rgb-fg')))
      assert.ok(terminal.themeViolations().length > 0)
    } finally {
      await terminal.dispose()
    }
  })

  it('drives a real pi-tui render loop end to end', async () => {
    // Pins the frame contract the whole suite waits on: pi-tui 0.84.1 wraps each
    // render in a synchronized update, so one `\x1b[?2026l` means one settled frame.
    const terminal = new HeadlessTerminal(40, 6)
    const ui = new TuiMainScreen(terminal, false)
    const line = new Text('first frame', 0, 0)
    const seen: string[] = []
    ui.addChild(line)
    try {
      ui.addInputListener((data) => {
        seen.push(data)
        return { consume: true }
      })
      ui.start()
      await terminal.waitForFrame(0)
      assert.equal(terminal.frames, 1)
      assert.equal(terminal.text().split('\n')[0]?.trimEnd(), 'first frame')

      const before = terminal.frames
      line.setText('second frame')
      ui.requestRender()
      await terminal.waitForFrame(before)
      assert.equal(terminal.frames, 2)
      assert.equal(terminal.text().split('\n')[0]?.trimEnd(), 'second frame')

      terminal.send('hi')
      assert.deepEqual(seen, ['hi'])
    } finally {
      ui.stop()
      await terminal.dispose()
    }
    assert.equal(terminal.stopped, 1)
  })
})

describe('TUI smoke', { skip: skipWithoutEntry }, () => {
  it('starts the terminal and renders header, transcript, and editor in its first frame', async () => {
    const harness = await mount({
      beforeMount(session) {
        appendUser(session, 'restored prompt')
        appendAssistant(session, [{ type: 'text', text: 'restored answer' }], {
          inputTokens: 1_250,
          outputTokens: 42,
        })
      },
    })
    try {
      const frame = harness.terminal.text()
      assert.equal(harness.terminal.started, 1)
      assert.equal(harness.terminal.stopped, 0)
      // Header: the window title and the banner subtitle the harness configures.
      assert.equal(harness.terminal.title, 'DSH smoke')
      assert.match(frame, /Coding agent ready\./)
      // Transcript: the replayed turn is on screen before any input arrives.
      assert.match(frame, /restored prompt/)
      assert.match(frame, /restored answer/)
      // Editor: its configured first-line prefix is the last interactive row.
      assert.ok(frame.includes(INPUT_PROMPT), `first frame must show the editor prompt:\n${frame}`)
      // `theme.color: false` must keep every cell inheriting the user's palette.
      assert.deepEqual(harness.terminal.themeViolations(), [])
    } finally {
      await unmount(harness)
    }
  })

  it('echoes typed input into the editor and redraws the frame', async () => {
    const harness = await mount()
    try {
      const before = harness.terminal.text()
      assert.ok(!before.includes('hello42'))

      await renderAfter(harness, () => { harness.terminal.send('hello42') })

      // The input prompt renders on its own line above the editor (pi-tui
      // 0.84.1 has no first-line prompt prefix), so typed text and prompt are
      // asserted independently.
      const after = harness.terminal.text()
      assert.notEqual(after, before)
      assert.ok(after.includes(INPUT_PROMPT), `prompt line must stay visible:\n${after}`)
      assert.ok(after.includes('hello42'), `typed input must reach the editor:\n${after}`)
    } finally {
      await unmount(harness)
    }
  })

  it('routes a submitted prompt to the agent and clears the editor', async () => {
    const harness = await mount()
    try {
      await renderAfter(harness, () => { harness.terminal.send('hi') })
      await renderAfter(harness, () => { harness.terminal.send('\r') })

      // rc.6 splits delivery across send/followup/steer; a submitted prompt is
      // whichever the mounted TUI chose, so accept any identified delivery.
      const delivered = [
        ...harness.agent.sent.map(delivery => delivery.message),
        ...harness.agent.followups,
        ...harness.agent.steered,
      ].map(messageText)
      assert.deepEqual(delivered, ['hi'])
      assert.ok(!harness.terminal.text().includes(`${INPUT_PROMPT}hi`))
    } finally {
      await unmount(harness)
    }
  })

  it('redraws when the agent starts running', async () => {
    const harness = await mount()
    try {
      const before = harness.terminal.text()
      await renderAfter(harness, () => { setAgentStatus(harness.agent, 'running') })
      assert.notEqual(harness.terminal.text(), before)
    } finally {
      await unmount(harness)
    }
  })

  it('stops the terminal on dispose', async () => {
    const harness = await mount()
    await unmount(harness)
    assert.equal(harness.terminal.stopped, 1)
  })
})

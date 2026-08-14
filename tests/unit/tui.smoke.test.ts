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
import { setTimeout as delay } from 'node:timers/promises'
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
// Type import declaration-merges `session/title` onto the session event map so
// the resumed-banner case can log a title the way the title service does.
import type {} from '@deepseek-ai/dsh-session-title'
import { Text, TuiMainScreen } from '@earendil-works/pi-tui'

/** Literal editor prefix, so "the editor is on screen" does not depend on prompt-value registrations. */
const INPUT_PROMPT = 'smoke> '

/** Ctrl+C as the terminal delivers it. */
const CTRL_C = '\x03'

/** Shutdown and the exit hook settle across a few awaits; outwait them. */
const SETTLE_MS = 60

/**
 * The status row's ordinary flash window (`STATUS_FLASH_MS` in the entry): how
 * long a view-state confirmation stays up. The Ctrl+C ask is not one of those,
 * which is what the case below pins.
 */
const DEFAULT_FLASH_MS = 1_500

/** `src/index.ts` is landed by a separate port; without it the end-to-end suite cannot run. */
const entryAvailable = await tuiEntryAvailable()
const skipWithoutEntry = entryAvailable
  ? false
  : 'requires src/index.ts to export createTuiChat(ctx, config, runtime)'

type SmokeHarness = TuiHarness<HeadlessTerminal, (code: number) => void>

/**
 * The editor frame's first content row and the rule above it.
 *
 * The prompt is rendered inside the input frame (Claude's inline `❯ `), not on
 * a row of its own, so "the prompt is on screen" is an assertion about where in
 * the frame it landed: directly under the top rule, ahead of the editor's own
 * padding column.
 * @param frame - the whole rendered screen.
 * @returns the prompt row and the row above it, both right-trimmed.
 */
function editorPromptRow(frame: string): { readonly above: string; readonly row: string } {
  const rows = frame.split('\n')
  // Matched against the padded row, trimmed only on the way out: the prompt
  // ends in the gap before the text column, which `trimEnd` would eat on an
  // empty input frame.
  const index = rows.findIndex(row => row.includes(INPUT_PROMPT))
  assert.ok(index > 0, `the input frame must carry the prompt:\n${frame}`)
  return { above: (rows[index - 1] ?? '').trimEnd(), row: (rows[index] ?? '').trimEnd() }
}

/** Mount the TUI on a headless terminal and wait for its first completed frame. */
async function mount(
  options: TuiHarnessOptions = {},
  size: { columns?: number; rows?: number } = {},
  exit: (code: number) => void = () => {},
): Promise<SmokeHarness> {
  const terminal = new HeadlessTerminal(size.columns ?? 96, size.rows ?? 32)
  const before = terminal.frames
  const harness = await createTuiTestHarness(terminal, exit, {
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
      // Editor: the configured prompt opens the frame's first content row,
      // inside the border rather than on a row above it.
      const prompt = editorPromptRow(frame)
      assert.ok(prompt.row.startsWith(INPUT_PROMPT.trimEnd()), `the prompt opens the content row: ${JSON.stringify(prompt.row)}`)
      assert.match(prompt.above, /^─+$/u, `and the row above it is the frame's top rule: ${JSON.stringify(prompt.above)}`)
      // `theme.color: false` must keep every cell inheriting the user's palette.
      assert.deepEqual(harness.terminal.themeViolations(), [])
    } finally {
      await unmount(harness)
    }
  })

  it('opens on the wordmark, the route, and the workspace — and no session id', async () => {
    const harness = await mount()
    try {
      const rows = harness.terminal.text().split('\n').map(row => row.trimEnd())
      assert.match(rows[0] ?? '', /^ DEEPSEEK HARNESS v\d+\.\d+\.\d+$/, `banner row:\n${rows.slice(0, 4).join('\n')}`)
      // The route the next turn runs under, then the workspace: what Claude Code
      // puts under its own wordmark.
      assert.equal(rows[1], ' deepseek-v4-flash · /workspace/project')
      const frame = harness.terminal.text()
      // A fresh session's id is a uuid the user did not choose and cannot act
      // on; only a resumed one is worth naming.
      assert.ok(!frame.includes('main-session'), `a new session prints no id:\n${frame}`)
      assert.ok(!frame.includes('resumed'), `and reports no resume:\n${frame}`)
    } finally {
      await unmount(harness)
    }
  })

  it('names the session it resumed, with the title that session logged', async () => {
    const harness = await mount({
      config: { sessionId: 'session-85d19568-5bbc-4347-a601-2f2588fd4832' },
      beforeMount(session) {
        appendUser(session, 'earlier prompt')
        session.append('session/title', {
          title: 'ordering bug',
          messageSeqs: [0],
          source: { kind: 'fallback' },
        })
      },
    })
    try {
      const rows = harness.terminal.text().split('\n').map(row => row.trimEnd())
      // The short id is exactly what `--resume` takes back, and the title says
      // which conversation it is — so neither needs a transcript row of its own.
      assert.equal(rows[2], ' resumed 85d19568 · ordering bug')
      assert.ok(
        !harness.terminal.text().includes('5bbc-4347'),
        `the full uuid stays off the banner:\n${harness.terminal.text()}`,
      )
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

      // The prompt and the draft share one row, separated by exactly the gap the
      // prompt itself ends with: the editor's own padding column is spent by
      // that gap rather than added to it, which is where Claude Code's single
      // space after `❯` comes from.
      const after = harness.terminal.text()
      assert.notEqual(after, before)
      assert.equal(
        editorPromptRow(after).row,
        `${INPUT_PROMPT}hello42`,
        `typed input must land on the prompt row:\n${after}`,
      )
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
      // The submitted line left the input frame: its content row is the prompt
      // and the padding column, with nothing after them.
      assert.equal(editorPromptRow(harness.terminal.text()).row, INPUT_PROMPT.trimEnd())
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

describe('TUI ctrl+c', { skip: skipWithoutEntry }, () => {
  it('asks for a second press before it ends an idle session', async () => {
    const exits: number[] = []
    const harness = await mount({}, {}, (code) => { exits.push(code) })
    try {
      await renderAfter(harness, () => { harness.terminal.send(CTRL_C) })
      // The first press only arms the second: an accidental Ctrl+C at an empty
      // prompt must not take a live conversation down with it.
      assert.match(harness.terminal.text(), /Press ctrl\+c again to exit\./)
      assert.deepEqual(exits, [])

      harness.terminal.send(CTRL_C)
      await delay(SETTLE_MS)
      assert.deepEqual(exits, [0], 'the second press inside the window exits')
    } finally {
      await unmount(harness)
    }
  })

  it('holds the ask on screen past the status row’s ordinary flash', async () => {
    const harness = await mount()
    try {
      await renderAfter(harness, () => { harness.terminal.send(CTRL_C) })
      await delay(DEFAULT_FLASH_MS + 120)

      // A view-state confirmation may fade after a beat; this one names a key
      // that is still armed, so it must not. Letting it expire on the shared
      // flash timer left the exit live with an empty status row above it —
      // the second press then read as a first one and ended the session.
      assert.match(
        harness.terminal.text(),
        /Press ctrl\+c again to exit\./,
        'the ask outlives the default flash because the armed window does',
      )
    } finally {
      await unmount(harness)
    }
  })

  it('clears a draft on the first press and arms nothing', async () => {
    const exits: number[] = []
    const harness = await mount({}, {}, (code) => { exits.push(code) })
    try {
      await renderAfter(harness, () => { harness.terminal.send('draft') })
      await renderAfter(harness, () => { harness.terminal.send(CTRL_C) })
      const cleared = harness.terminal.text()
      assert.equal(editorPromptRow(cleared).row, INPUT_PROMPT.trimEnd(), `the draft is gone:\n${cleared}`)
      // Clearing is its own outcome, so the press that did it cannot be half of
      // an exit: the next one starts the two-press sequence from the beginning.
      assert.doesNotMatch(cleared, /Press ctrl\+c again to exit\./)

      harness.terminal.send(CTRL_C)
      await delay(SETTLE_MS)
      assert.deepEqual(exits, [], 'the press after a clear only arms the exit')
      assert.match(harness.terminal.text(), /Press ctrl\+c again to exit\./)
    } finally {
      await unmount(harness)
    }
  })

  it('cancels the active turn while running, and exits neither time', async () => {
    const exits: number[] = []
    const harness = await mount({}, {}, (code) => { exits.push(code) })
    try {
      await renderAfter(harness, () => { setAgentStatus(harness.agent, 'running') })
      harness.terminal.send(CTRL_C)
      harness.terminal.send(CTRL_C)
      await delay(SETTLE_MS)

      assert.deepEqual(harness.agent.cancelled.map(record => record.cause), [{ kind: 'user' }, { kind: 'user' }])
      assert.deepEqual(exits, [], 'a running turn keeps Ctrl+C as cancel, however many times it is pressed')
      assert.doesNotMatch(harness.terminal.text(), /Press ctrl\+c again to exit\./)
    } finally {
      await unmount(harness)
    }
  })
})

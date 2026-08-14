/**
 * The keys the mounted terminal binds for itself: the plan toggle, the prompt
 * history search, the Esc ladder, the `?` help, the debug panel, and the fact
 * that a deployment can move any of them.
 *
 * Every case drives real bytes through the terminal, because that is the only
 * boundary where "the key works" means anything: the same press has to survive
 * pi-tui's key parsing, this bundle's input listener, the keybinding registry,
 * and whichever overlay happens to own the screen.
 * @module dsh-tui/tests/unit/keys
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import {
  appendUser,
  createTuiTestHarness,
  disposeTuiTestHarness,
  setAgentStatus,
  tuiEntryAvailable,
  type TuiHarness,
  type TuiHarnessOptions,
} from '../harness.ts'
import { HeadlessTerminal } from '../headless-terminal.ts'

/** Literal editor prefix, so a frame assertion never depends on prompt-value registrations. */
const INPUT_PROMPT = 'keys> '

/** Keys as the terminal delivers them. */
const CTRL_C = '\x03'
const CTRL_R = '\x12'
const CTRL_T = '\x14'
const CTRL_B = '\x02'
const ESC = '\x1b'
const ENTER = '\r'
const TAB = '\t'
/** Shift+Ctrl+D, which only a Kitty-protocol terminal can express. */
const SHIFT_CTRL_D = '\x1b[100;6u'

/** Notices and cancellations settle across a few awaits; outwait them. */
const SETTLE_MS = 40

/** Longer than the Esc double-press window, for the case that must let it expire. */
const ESC_WINDOW_MS = 900

/** `src/index.ts` is landed by a separate port; without it the end-to-end suite cannot run. */
const entryAvailable = await tuiEntryAvailable()
const skipWithoutEntry = entryAvailable
  ? false
  : 'requires src/index.ts to export createTuiChat(ctx, config, runtime)'

type KeysHarness = TuiHarness<HeadlessTerminal, (code: number) => void>

async function mount(options: TuiHarnessOptions = {}): Promise<KeysHarness> {
  const terminal = new HeadlessTerminal(96, 32)
  const before = terminal.frames
  const harness = await createTuiTestHarness(terminal, () => {}, {
    cwd: '/workspace/project',
    ...options,
    config: {
      title: 'DSH keys',
      welcome: 'ready.',
      ...options.config,
      theme: { color: false, inputPrompt: INPUT_PROMPT, ...options.config?.theme },
    },
  })
  await terminal.waitForFrame(before)
  return harness
}

async function unmount(harness: KeysHarness): Promise<void> {
  await disposeTuiTestHarness(harness)
  await harness.terminal.dispose()
}

/** Send one chunk and wait for the frame it produces. */
async function press(harness: KeysHarness, data: string): Promise<string> {
  const before = harness.terminal.frames
  harness.terminal.send(data)
  await harness.terminal.waitForFrame(before)
  return harness.terminal.text()
}

/**
 * Send one chunk that is expected to change nothing, and settle.
 *
 * A key the terminal deliberately ignores paints no frame, so waiting for one
 * would time out on exactly the behavior being asserted.
 * @param harness - the mounted terminal.
 * @param data - the bytes to deliver.
 * @returns the screen after the press.
 */
async function pressQuietly(harness: KeysHarness, data: string): Promise<string> {
  harness.terminal.send(data)
  await delay(SETTLE_MS)
  await harness.terminal.flush()
  return harness.terminal.text()
}

/** The frame with its own line wrapping collapsed, so a sentence reads as a sentence. */
function unwrapped(frame: string): string {
  return frame.replace(/\s+/gu, ' ')
}

/** Submit one prompt, so the session has history and a message to rewind to. */
async function submit(harness: KeysHarness, text: string): Promise<void> {
  await press(harness, text)
  await press(harness, ENTER)
  await delay(SETTLE_MS)
}

describe('plan toggle', { skip: skipWithoutEntry }, () => {
  it('collapses the plan to one row on Ctrl+T and expands it again', async () => {
    const harness = await mount({
      beforeMount(session) {
        session.append('todo/write', {
          todos: [
            { content: 'read the spec', status: 'completed' },
            { content: 'write the code', status: 'in_progress' },
            { content: 'run the tests', status: 'pending' },
          ],
        })
      },
    })
    try {
      assert.match(harness.terminal.text(), /write the code/u)

      const collapsed = await press(harness, CTRL_T)
      // The summary keeps the two facts the panel was carrying: progress, and
      // what is being worked on now.
      assert.match(unwrapped(collapsed), /Plan 1\/3 done · Next: write the code/u)
      assert.doesNotMatch(collapsed, /run the tests/u)

      const expanded = await press(harness, CTRL_T)
      assert.match(expanded, /run the tests/u)
    } finally {
      await unmount(harness)
    }
  })

  it('says so rather than toggling nothing when the session has no plan', async () => {
    const harness = await mount()
    try {
      assert.match(unwrapped(await press(harness, CTRL_T)), /No plan in this session yet\./u)
    } finally {
      await unmount(harness)
    }
  })
})

describe('prompt history search', { skip: skipWithoutEntry }, () => {
  it('walks backwards through matches and accepts one into the editor', async () => {
    const harness = await mount()
    try {
      await submit(harness, 'fix the parser bug')
      await submit(harness, 'write the parser tests')
      await submit(harness, 'unrelated errand')

      const opened = await press(harness, CTRL_R)
      assert.match(unwrapped(opened), /search prompts:/u)

      const typed = await press(harness, 'parser')
      // Newest match first, which is the entry a shell user expects.
      assert.match(unwrapped(typed), /search prompts: parser/u)
      assert.match(typed, /write the parser tests/u)

      const older = await press(harness, CTRL_R)
      assert.match(older, /fix the parser bug/u)

      // Tab accepts, exactly as Esc does: the match lands in the editor unsent.
      const accepted = await press(harness, TAB)
      assert.doesNotMatch(unwrapped(accepted), /search prompts:/u)
      assert.match(accepted, /fix the parser bug/u)
      assert.deepEqual(harness.agent.followups.map(message => message.content), [
        [{ type: 'text', text: 'fix the parser bug' }],
        [{ type: 'text', text: 'write the parser tests' }],
        [{ type: 'text', text: 'unrelated errand' }],
      ])
    } finally {
      await unmount(harness)
    }
  })

  it('restores the draft the search interrupted when it is cancelled', async () => {
    const harness = await mount()
    try {
      await submit(harness, 'an earlier prompt')
      await press(harness, 'half a thought')

      await press(harness, CTRL_R)
      await press(harness, 'earlier')
      assert.match(harness.terminal.text(), /an earlier prompt/u)

      const cancelled = await press(harness, CTRL_C)
      assert.doesNotMatch(unwrapped(cancelled), /search prompts:/u)
      assert.match(cancelled, /half a thought/u)
    } finally {
      await unmount(harness)
    }
  })

  it('reports a query nothing matches without losing the last match', async () => {
    const harness = await mount()
    try {
      await submit(harness, 'the only prompt')
      await press(harness, CTRL_R)
      await press(harness, 'only')
      const failed = await press(harness, 'zzz')

      assert.match(unwrapped(failed), /no matching prompt: onlyzzz/u)
      assert.match(failed, /the only prompt/u)
    } finally {
      await unmount(harness)
    }
  })

  it('says there is nothing to search before the session has any history', async () => {
    const harness = await mount()
    try {
      assert.match(unwrapped(await press(harness, CTRL_R)), /No prompt history in this session yet\./u)
    } finally {
      await unmount(harness)
    }
  })
})

describe('the Esc ladder', { skip: skipWithoutEntry }, () => {
  it('asks once, then clears the draft and keeps it in the history', async () => {
    const harness = await mount()
    try {
      await press(harness, 'a draft worth keeping')
      const armed = await press(harness, ESC)
      assert.match(unwrapped(armed), /Press esc again to clear the draft\./u)
      assert.match(armed, /a draft worth keeping/u)

      const cleared = await press(harness, ESC)
      assert.doesNotMatch(cleared, /a draft worth keeping/u)
      assert.equal(harness.agent.followups.length, 0)

      // Cleared, not lost: the draft went into the history the search reads.
      await press(harness, CTRL_R)
      assert.match(await press(harness, 'worth'), /a draft worth keeping/u)
    } finally {
      await unmount(harness)
    }
  })

  it('lets the window expire, so a later Esc asks again instead of clearing', async () => {
    const harness = await mount()
    try {
      await press(harness, 'still typing')
      await press(harness, ESC)
      await delay(ESC_WINDOW_MS)

      const armedAgain = await press(harness, ESC)
      assert.match(unwrapped(armedAgain), /Press esc again to clear the draft\./u)
      assert.match(armedAgain, /still typing/u)
    } finally {
      await unmount(harness)
    }
  })

  it('cancels a running turn on the first press and hands back what was queued behind it', async () => {
    const harness = await mount({ status: 'idle' })
    try {
      setAgentStatus(harness.agent, 'running')
      harness.ctx.emit('agent/status', { agent: harness.agent, status: 'running' })
      await press(harness, 'steer the turn this way')
      await press(harness, ENTER)
      await delay(SETTLE_MS)
      assert.equal(harness.agent.steered.length, 1)

      const cancelled = await press(harness, ESC)
      assert.equal(harness.agent.cancelled.length, 1)
      // Claude Code's rule: a prompt queued behind a cancelled turn goes back to
      // the input frame rather than disappearing with the turn.
      assert.match(cancelled, /steer the turn this way/u)
    } finally {
      await unmount(harness)
    }
  })

  it('stays quiet at an empty prompt while the session has nothing to rewind to', async () => {
    const harness = await mount()
    try {
      // Arming a key that would open an empty panel teaches the wrong thing
      // about it, so the first press does nothing at all.
      const quiet = await pressQuietly(harness, ESC)
      assert.doesNotMatch(unwrapped(quiet), /Press esc again to rewind/u)
    } finally {
      await unmount(harness)
    }
  })

  it('opens Rewind on a double Esc at an empty prompt', async () => {
    const harness = await mount({
      beforeMount(session) { appendUser(session, 'the first thing I asked') },
    })
    try {
      const armed = await press(harness, ESC)
      assert.match(unwrapped(armed), /Press esc again to rewind to an earlier prompt\./u)

      const rewind = await press(harness, ESC)
      assert.match(rewind, /Rewind/u)
      assert.match(rewind, /the first thing I asked/u)
      // The panel must never imply a capability this terminal does not have.
      assert.match(unwrapped(rewind), /Files are never restored/u)

      const closed = await press(harness, ESC)
      assert.doesNotMatch(closed, /Files are never restored/u)
    } finally {
      await unmount(harness)
    }
  })
})

describe('the help and debug surfaces', { skip: skipWithoutEntry }, () => {
  it('opens the shortcut list on `?` at an empty prompt, without typing it', async () => {
    const harness = await mount()
    try {
      const help = await press(harness, '?')
      assert.match(unwrapped(help), /\/hotkeys/u)
      assert.match(unwrapped(help), /Ctrl\+R search prompt history backwards/u)
      assert.match(unwrapped(help), /Ctrl\+T expand or collapse the plan/u)
      // The character itself never lands in the draft.
      assert.doesNotMatch(unwrapped(help), /keys> \?/u)
    } finally {
      await unmount(harness)
    }
  })

  it('leaves a `?` typed inside a sentence alone', async () => {
    const harness = await mount()
    try {
      const typed = await press(harness, 'what now?')
      assert.match(typed, /what now\?/u)
      assert.doesNotMatch(unwrapped(typed), /\/hotkeys/u)
    } finally {
      await unmount(harness)
    }
  })

  it('answers Shift+Ctrl+D with the session debug panel', async () => {
    const harness = await mount()
    try {
      const debug = await press(harness, SHIFT_CTRL_D)
      assert.match(unwrapped(debug), /debug \(shift\+ctrl\+d\)/u)
      assert.match(unwrapped(debug), /app\.history\.search → Ctrl\+R/u)
      assert.match(unwrapped(debug), /agent idle/u)
    } finally {
      await unmount(harness)
    }
  })
})

describe('rebound keys', { skip: skipWithoutEntry }, () => {
  it('answers the key a deployment bound, and no longer answers the default', async () => {
    const harness = await mount({
      config: { keybindings: { 'app.todos.toggle': 'ctrl+b' } },
      beforeMount(session) {
        session.append('todo/write', { todos: [{ content: 'write the code', status: 'in_progress' }] })
      },
    })
    try {
      const rebound = await press(harness, CTRL_B)
      assert.match(unwrapped(rebound), /Plan 0\/1 done · Next: write the code/u)

      // The old key is a plain keystroke again, so it reaches the editor rather
      // than the toggle it used to drive.
      const oldKey = await press(harness, CTRL_T)
      assert.match(unwrapped(oldKey), /Plan 0\/1 done/u)

      // And the help names the key that works, not the one that no longer does.
      assert.match(unwrapped(await press(harness, '?')), /Ctrl\+B expand or collapse the plan/u)
    } finally {
      await unmount(harness)
    }
  })
})

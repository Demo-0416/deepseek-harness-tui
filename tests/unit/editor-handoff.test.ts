/**
 * Alt+E and `/editor` at the mounted terminal: the draft that goes out, the
 * text that comes back, and the terminal being handed over and taken back
 * around a real child process.
 *
 * The editors are shell scripts and the choice is made through `externalEditor`
 * rather than through `process.env`, so a case never depends on what the
 * developer running it happens to export — except the one case that is about
 * finding nothing, which clears the environment itself.
 * @module dsh-tui/tests/unit/editor-handoff
 */

import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
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
const INPUT_PROMPT = 'edit> '

/** Keys as the terminal delivers them. */
const ALT_E = '\x1be'
const CTRL_J = '\n'
const ESC = '\x1b'

/** A key the terminal deliberately ignores paints no frame; outwait it instead. */
const SETTLE_MS = 200

/**
 * Longest a case waits for the child editor to run and the screen to be
 * repainted. Generous because it is a real `spawn` under the test runner, which
 * on a loaded machine is the better part of a second before the script's own
 * first line runs.
 */
const EDITOR_TIMEOUT_MS = 5_000

/** `src/index.ts` is landed by a separate port; without it the end-to-end suite cannot run. */
const entryAvailable = await tuiEntryAvailable()
const skipWithoutEntry = entryAvailable
  ? false
  : 'requires src/index.ts to export createTuiChat(ctx, config, runtime)'
const skip = process.platform === 'win32' ? 'POSIX shell fixtures' : skipWithoutEntry

/** Where the fixture editors live. */
let scripts = ''

/** Write one executable shell script and hand back its absolute path. */
async function script(name: string, body: string): Promise<string> {
  const file = join(scripts, name)
  await writeFile(file, `#!/bin/sh\n${body}\n`, { encoding: 'utf8', mode: 0o755 })
  await chmod(file, 0o755)
  return file
}

before(async () => {
  scripts = await mkdtemp(join(tmpdir(), 'dsh-editor-handoff-'))
  await script('write.sh', 'printf \'text the editor saved\\n\' > "$1"')
  await script('question.sh', 'printf \'?\\n\' > "$1"')
  await script('noop.sh', 'exit 0')
  await script('fail.sh', 'exit 3')
  await script('capture.sh', 'cp "$1" "$TUI_HANDOFF_CAPTURE"')
  // Holds the terminal until the case says so, which is the window a request
  // from the agent has to arrive in.
  await script(
    'gated.sh',
    'while [ ! -f "$TUI_HANDOFF_GATE" ]; do sleep 0.05; done\n'
    + 'printf \'text the editor saved\\n\' > "$1"',
  )
})

after(async () => {
  await rm(scripts, { recursive: true, force: true })
})

type EditorHarness = TuiHarness<HeadlessTerminal, (code: number) => void>

/** `TuiController.submit` is the typed-line path; the harness handle only declares disposal. */
interface SubmitHandle {
  submit(text: string): void
}

async function mount(options: TuiHarnessOptions = {}): Promise<EditorHarness> {
  const terminal = new HeadlessTerminal(96, 32)
  const before_ = terminal.frames
  const harness = await createTuiTestHarness(terminal, () => {}, {
    cwd: '/workspace/project',
    ...options,
    config: {
      title: 'DSH editor',
      welcome: 'ready.',
      ...options.config,
      theme: { color: false, inputPrompt: INPUT_PROMPT, ...options.config?.theme },
    },
  })
  await terminal.waitForFrame(before_)
  return harness
}

async function unmount(harness: EditorHarness): Promise<void> {
  await disposeTuiTestHarness(harness)
  await harness.terminal.dispose()
}

/** Send one chunk and wait for the frame it produces. */
async function press(harness: EditorHarness, data: string): Promise<string> {
  const before_ = harness.terminal.frames
  harness.terminal.send(data)
  await harness.terminal.waitForFrame(before_)
  return harness.terminal.text()
}

/**
 * Send one chunk that is expected to change nothing, and settle.
 * @param harness - the mounted terminal.
 * @param data - the bytes to deliver.
 * @returns the screen after the press.
 */
async function pressQuietly(harness: EditorHarness, data: string): Promise<string> {
  harness.terminal.send(data)
  await delay(SETTLE_MS)
  await harness.terminal.flush()
  return harness.terminal.text()
}

/** The frame with its own line wrapping collapsed, so a sentence reads as a sentence. */
function unwrapped(frame: string): string {
  return frame.replace(/\s+/gu, ' ')
}

/**
 * Wait until the screen says something, or give up and let the assertion read
 * the last frame.
 * @param harness - the mounted terminal.
 * @param pattern - what the finished round trip puts on screen.
 * @returns the frame it stopped on.
 */
async function waitForScreen(harness: EditorHarness, pattern: RegExp): Promise<string> {
  const deadline = Date.now() + EDITOR_TIMEOUT_MS
  for (;;) {
    await harness.terminal.flush()
    const frame = harness.terminal.text()
    if (pattern.test(unwrapped(frame)) || Date.now() > deadline) return frame
    await delay(25)
  }
}

/**
 * Wait until the terminal has been released and taken back, which is what a
 * finished round trip ends with even when it announces nothing.
 * @param harness - the mounted terminal.
 */
async function waitForTerminalBack(harness: EditorHarness): Promise<void> {
  const deadline = Date.now() + EDITOR_TIMEOUT_MS
  while (harness.terminal.started < 2 && Date.now() < deadline) await delay(25)
  await harness.terminal.flush()
}

/**
 * Wait until a file the fixture editor writes exists and has content.
 * @param path - the capture file.
 * @returns its content, or the empty string when it never appeared.
 */
async function waitForFile(path: string): Promise<string> {
  const deadline = Date.now() + EDITOR_TIMEOUT_MS
  for (;;) {
    try {
      const content = await readFile(path, 'utf8')
      if (content !== '') return content
    } catch (_notYet: unknown) {
      // The editor has not been reached yet.
    }
    if (Date.now() > deadline) return ''
    await delay(25)
  }
}

describe('the draft goes to $EDITOR', { skip }, () => {
  it('replaces the draft with what the editor saved, and takes the terminal back', async () => {
    const harness = await mount({ config: { externalEditor: join(scripts, 'write.sh') } })
    try {
      await press(harness, 'draft text')
      harness.terminal.send(ALT_E)

      assert.match(await waitForScreen(harness, /text the editor saved/u), /text the editor saved/u)
      assert.equal(harness.terminal.stopped, 1, 'the terminal was released once')
      assert.equal(harness.terminal.started, 2, 'and taken back after the child exited')
    } finally {
      await unmount(harness)
    }
  })

  it('takes back a draft saved as a single `?` instead of opening the shortcut list', async () => {
    // `setText` runs `onChange` synchronously, and `?` is a keystroke rule: a
    // file saved with nothing but a question mark in it was saved on purpose,
    // and answering it with `/hotkeys` would drop the save without a word.
    const harness = await mount({ config: { externalEditor: join(scripts, 'question.sh') } })
    try {
      await press(harness, 'what is this')
      harness.terminal.send(ALT_E)
      await waitForTerminalBack(harness)
      const frame = unwrapped(await waitForScreen(harness, /edit> \?/u))

      assert.match(frame, /edit> \?/u, 'the saved draft is in the prompt')
      assert.doesNotMatch(frame, /\/hotkeys/u, 'no panel took the draft away')
      assert.doesNotMatch(frame, /what is this/u, 'and the old draft was replaced')
    } finally {
      await unmount(harness)
    }
  })

  it('hands over exactly what was being typed', async () => {
    const captured = join(scripts, 'captured.txt')
    const previous = process.env['TUI_HANDOFF_CAPTURE']
    process.env['TUI_HANDOFF_CAPTURE'] = captured
    const harness = await mount({ config: { externalEditor: join(scripts, 'capture.sh') } })
    try {
      await press(harness, 'the draft as typed')
      harness.terminal.send(ALT_E)

      assert.equal(await waitForFile(captured), 'the draft as typed')
    } finally {
      await unmount(harness)
      if (previous === undefined) delete process.env['TUI_HANDOFF_CAPTURE']
      else process.env['TUI_HANDOFF_CAPTURE'] = previous
      await rm(captured, { force: true })
    }
  })

  it('still answers the keyboard afterwards', async () => {
    const harness = await mount({ config: { externalEditor: join(scripts, 'write.sh') } })
    try {
      await press(harness, 'before')
      harness.terminal.send(ALT_E)
      await waitForScreen(harness, /text the editor saved/u)

      // A key answered after the round trip proves `ui.start()` re-armed both
      // the stdin handler and this bundle's own input listener.
      assert.match(await press(harness, ' and more typing'), /and more typing/u)
    } finally {
      await unmount(harness)
    }
  })

  it('keeps the draft and says so when the editor exits non-zero', async () => {
    const harness = await mount({ config: { externalEditor: join(scripts, 'fail.sh') } })
    try {
      await press(harness, 'draft worth keeping')
      harness.terminal.send(ALT_E)

      const frame = await waitForScreen(harness, /exited with code 3/u)
      assert.match(frame, /draft worth keeping/u)
      assert.match(unwrapped(frame), /exited with code 3/u)
    } finally {
      await unmount(harness)
    }
  })

  it('says nothing at all when the editor changed nothing', async () => {
    const harness = await mount({ config: { externalEditor: join(scripts, 'noop.sh') } })
    try {
      await press(harness, 'unchanged draft')
      harness.terminal.send(ALT_E)
      // Nothing is announced, so there is nothing to wait for: wait for the
      // terminal to come back instead, which is what the round trip ends with.
      await waitForTerminalBack(harness)

      const frame = harness.terminal.text()
      assert.match(frame, /unchanged draft/u)
      assert.doesNotMatch(unwrapped(frame), /exited with code|External editor/u)
    } finally {
      await unmount(harness)
    }
  })

  it('refuses without spawning anything when the deployment turned it off', async () => {
    const harness = await mount({ config: { externalEditor: '' } })
    try {
      harness.terminal.send(ALT_E)
      await delay(SETTLE_MS)
      await harness.terminal.flush()

      assert.match(unwrapped(harness.terminal.text()), /external editor is off/u)
      assert.equal(harness.terminal.stopped, 0, 'the terminal was never released')
    } finally {
      await unmount(harness)
    }
  })

  it('says there is none when nothing is configured, exported, or on PATH', async () => {
    const saved = {
      editor: process.env['EDITOR'],
      visual: process.env['VISUAL'],
      path: process.env['PATH'],
    }
    const nowhere = await mkdtemp(join(tmpdir(), 'dsh-editor-nowhere-'))
    delete process.env['EDITOR']
    delete process.env['VISUAL']
    process.env['PATH'] = nowhere
    const harness = await mount()
    try {
      harness.terminal.send(ALT_E)
      await delay(SETTLE_MS)
      await harness.terminal.flush()

      assert.match(unwrapped(harness.terminal.text()), /No external editor found/u)
      assert.equal(harness.terminal.stopped, 0, 'the terminal was never released')
    } finally {
      await unmount(harness)
      if (saved.editor === undefined) delete process.env['EDITOR']
      else process.env['EDITOR'] = saved.editor
      if (saved.visual === undefined) delete process.env['VISUAL']
      else process.env['VISUAL'] = saved.visual
      if (saved.path === undefined) delete process.env['PATH']
      else process.env['PATH'] = saved.path
      await rm(nowhere, { recursive: true, force: true })
    }
  })

  it('does the same thing from /editor, for a terminal that cannot send Alt', async () => {
    const harness = await mount({ config: { externalEditor: join(scripts, 'write.sh') } })
    try {
      ;(harness.controller as unknown as SubmitHandle).submit('/editor')

      assert.match(await waitForScreen(harness, /text the editor saved/u), /text the editor saved/u)
      assert.equal(harness.terminal.stopped, 1)
    } finally {
      await unmount(harness)
    }
  })

  it('offers the key once, the first time a draft grows a second line', async () => {
    const harness = await mount({ config: { externalEditor: join(scripts, 'write.sh') } })
    try {
      await press(harness, 'a')
      const hinted = await press(harness, CTRL_J)
      assert.match(unwrapped(hinted), /Alt\+E to edit this prompt in write\.sh/u)

      // A double Esc drops the draft and takes the status row back, so a second
      // hint would have somewhere visible to appear. It does not: the offer is
      // made once, and a hint that kept coming back is one already declined.
      await press(harness, ESC)
      const cleared = await press(harness, ESC)
      assert.doesNotMatch(unwrapped(cleared), /Alt\+E to edit this prompt/u)

      await press(harness, 'b')
      const again = await pressQuietly(harness, CTRL_J)
      assert.doesNotMatch(unwrapped(again), /Alt\+E to edit this prompt/u)
    } finally {
      await unmount(harness)
    }
  })

  it('gives the keyboard to a dialog that arrived while the editor had the terminal', async () => {
    // An inline dialog is a child of the question slot, not a pi-tui overlay,
    // so pi-tui's "focus fell off a visible overlay" repair never covers it:
    // taking focus back for the prompt here left the permission panel on
    // screen and unanswerable, with the tool call behind it blocked for good.
    const gate = join(scripts, 'handoff-gate')
    const previous = process.env['TUI_HANDOFF_GATE']
    process.env['TUI_HANDOFF_GATE'] = gate
    await rm(gate, { force: true })
    const harness = await mount({ config: { externalEditor: join(scripts, 'gated.sh') } })
    try {
      await press(harness, 'draft')
      harness.terminal.send(ALT_E)
      const released = Date.now() + EDITOR_TIMEOUT_MS
      while (harness.terminal.stopped < 1 && Date.now() < released) await delay(25)
      assert.equal(harness.terminal.stopped, 1, 'the child has the terminal')

      const decision = harness.ctx.waterfall('approval/request', {
        agent: harness.agent,
        toolName: 'bash',
        reason: 'Deleting files needs confirmation',
      }, () => Promise.resolve<ApprovalOutcome>('unavailable'))
      await delay(SETTLE_MS)
      await writeFile(gate, '')
      await waitForTerminalBack(harness)

      const frame = await waitForScreen(harness, /Permission required/u)
      assert.match(frame, /Permission required/u, frame)
      harness.terminal.send('1')
      const answered = await Promise.race([
        decision,
        delay(EDITOR_TIMEOUT_MS).then(() => 'never answered'),
      ])
      assert.equal(answered, 'allowed-once')
      // …and the key that answered it never reached the draft.
      await harness.terminal.flush()
      assert.doesNotMatch(harness.terminal.text(), /text the editor saved1/u)
    } finally {
      await unmount(harness)
      if (previous === undefined) delete process.env['TUI_HANDOFF_GATE']
      else process.env['TUI_HANDOFF_GATE'] = previous
      await rm(gate, { force: true })
    }
  })

  it('does nothing while a panel owns the keyboard', async () => {
    const harness = await mount({ config: { externalEditor: join(scripts, 'write.sh') } })
    try {
      ;(harness.controller as unknown as SubmitHandle).submit('/hotkeys')
      await delay(SETTLE_MS)
      await harness.terminal.flush()

      const before_ = harness.terminal.text()
      assert.equal(await pressQuietly(harness, ALT_E), before_)
      assert.equal(harness.terminal.stopped, 0)
    } finally {
      await unmount(harness)
    }
  })
})

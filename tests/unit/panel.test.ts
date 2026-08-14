/**
 * The command panel: the editor-slot surface `/help`, `/hotkeys`, `/palette`,
 * and `/status` render into instead of dumping their output into the
 * transcript.
 *
 * Two levels, because the contract has two halves. The component cases pin the
 * scroll arithmetic against a fixed row budget; the mounted case pins what the
 * panel is for — a command answer that owns the keyboard while it is open and
 * leaves the conversation exactly as it found it.
 * @module dsh-tui/tests/unit/panel
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { ScrollablePanel } from '../../src/components/panel.ts'
import { createPalette } from '../../src/components/theme.ts'
import {
  appendAssistant,
  appendUser,
  createTuiTestHarness,
  disposeTuiTestHarness,
  tuiEntryAvailable,
  type TuiHarness,
  type TuiHarnessOptions,
} from '../harness.ts'
import { HeadlessTerminal } from '../headless-terminal.ts'

/** Literal editor prefix, so a frame assertion never depends on prompt-value registrations. */
const INPUT_PROMPT = 'panel> '

/** `src/index.ts` is landed by a separate port; without it the end-to-end suite cannot run. */
const entryAvailable = await tuiEntryAvailable()
const skipWithoutEntry = entryAvailable
  ? false
  : 'requires src/index.ts to export createTuiChat(ctx, config, runtime)'

/** A command handler awaits its own assembly before the panel opens; outwait it. */
const SETTLE_MS = 60

type PanelHarness = TuiHarness<HeadlessTerminal, (code: number) => void>

/** `TuiController.submit` is the typed-line path; the harness handle only declares disposal. */
interface SubmitHandle {
  submit(text: string): void
}

const ESC = '\x1b'
const ARROW_DOWN = `${ESC}[B`
const ARROW_UP = `${ESC}[A`
const PAGE_DOWN = `${ESC}[6~`

const palette = createPalette(false)

/** Plain rows of the panel frame, with the leading indent removed. */
function rows(panel: ScrollablePanel, width: number): string[] {
  return panel.render(width).map(line => line.trimEnd().replace(/^ /u, ''))
}

/** Freeze the open step's live stopwatch, so two frames compare on everything else. */
function settleClock(frame: string): string {
  return frame.replace(/\d+\.\d+s/gu, 'Ns')
}

/** A panel over `count` numbered rows with a fixed row budget. */
function fixture(count: number, budget: number, onClose: () => void = () => {}): ScrollablePanel {
  const lines = Array.from({ length: count }, (_, index) => `line ${String(index + 1)}`)
  return new ScrollablePanel('Test panel', lines, () => budget, palette, onClose)
}

async function mount(options: TuiHarnessOptions = {}): Promise<PanelHarness> {
  // Tall enough that an open panel never pushes the banner into scrollback:
  // this suite compares whole frames, and a scrolled viewport is a terminal
  // fact rather than a transcript change.
  const terminal = new HeadlessTerminal(100, 60)
  const before = terminal.frames
  const harness = await createTuiTestHarness(terminal, () => {}, {
    cwd: '/workspace/project',
    ...options,
    config: {
      title: 'DSH panel',
      ...options.config,
      theme: { color: false, inputPrompt: INPUT_PROMPT, ...options.config?.theme },
    },
  })
  await terminal.waitForFrame(before)
  return harness
}

async function unmount(harness: PanelHarness): Promise<void> {
  await disposeTuiTestHarness(harness)
  await harness.terminal.dispose()
}

describe('ScrollablePanel', () => {
  it('spends its row budget on a title, one page of content, and the hint', () => {
    const panel = fixture(30, 8)
    const frame = rows(panel, 40)
    // One blank, the title, five content rows, the hint: the whole budget.
    assert.equal(frame.length, 8)
    assert.equal(frame[0], '')
    assert.equal(frame[1], 'Test panel')
    assert.deepEqual(frame.slice(2, 7), ['line 1', 'line 2', 'line 3', 'line 4', 'line 5'])
    assert.equal(frame[7], '↑↓ scroll · esc close  ·  1–5 of 30')
  })

  it('scrolls by row, by page, and to either end, and stops at both', () => {
    const panel = fixture(30, 8)
    panel.render(40)

    panel.handleInput(ARROW_DOWN)
    assert.equal(rows(panel, 40)[2], 'line 2')
    panel.handleInput(PAGE_DOWN)
    assert.equal(rows(panel, 40)[2], 'line 7')
    panel.handleInput('G')
    // The last page ends on the last row rather than scrolling past it.
    assert.deepEqual(rows(panel, 40).slice(2, 7), ['line 26', 'line 27', 'line 28', 'line 29', 'line 30'])
    assert.equal(rows(panel, 40)[7], '↑↓ scroll · esc close  ·  26–30 of 30')

    panel.handleInput(ARROW_DOWN)
    assert.equal(rows(panel, 40)[2], 'line 26', 'the bottom is a floor, not a wrap')
    panel.handleInput('g')
    assert.equal(rows(panel, 40)[2], 'line 1')
    panel.handleInput(ARROW_UP)
    assert.equal(rows(panel, 40)[2], 'line 1', 'and the top is a ceiling')
  })

  it('omits the position readout while the content fits', () => {
    const panel = fixture(3, 8)
    const frame = rows(panel, 40)
    // Nothing to scroll: the panel is as tall as its content, no more.
    assert.deepEqual(frame, ['', 'Test panel', 'line 1', 'line 2', 'line 3', '↑↓ scroll · esc close'])
  })

  it('wraps content to the panel width and scrolls the wrapped rows', () => {
    const panel = new ScrollablePanel(
      'Wrapped',
      ['aaaa bbbb cccc dddd', '', 'tail'],
      () => 6,
      palette,
      () => {},
    )
    // Width 12 leaves 10 content columns, so the long line becomes two rows and
    // the blank one survives as a row of its own: four rows over a three-row
    // viewport.
    assert.deepEqual(rows(panel, 12), [
      '',
      'Wrapped',
      'aaaa bbbb',
      'cccc dddd',
      '',
      '↑↓ scroll · esc close  ·  1–3 of 4',
    ])
    panel.handleInput('G')
    assert.deepEqual(rows(panel, 12).slice(2, 5), ['cccc dddd', '', 'tail'])
  })

  it('closes on Esc and on Ctrl+C, and swallows every other key', () => {
    let closed = 0
    const panel = fixture(30, 8, () => { closed += 1 })
    panel.render(40)

    panel.handleInput('q')
    panel.handleInput('\r')
    assert.equal(closed, 0)
    assert.equal(rows(panel, 40)[2], 'line 1', 'stray keys must not scroll the panel either')

    panel.handleInput(ESC)
    assert.equal(closed, 1)
    panel.handleInput('\x03')
    assert.equal(closed, 2)
  })
})

describe('TUI command panels', { skip: skipWithoutEntry }, () => {
  it('answers /status in a panel and leaves the transcript untouched', async () => {
    const harness = await mount({
      beforeMount(session) {
        appendUser(session, 'restored prompt')
        appendAssistant(session, [{ type: 'text', text: 'restored answer' }])
      },
    })
    try {
      const before = harness.terminal.text()
      assert.match(before, /restored answer/)
      assert.doesNotMatch(before, /Session status/)

      ;(harness.controller as unknown as SubmitHandle).submit('/status')
      await delay(SETTLE_MS)

      const panel = harness.terminal.text()
      assert.match(panel, /Session status/, `the status card opens in a panel:\n${panel}`)
      assert.match(panel, /esc close/)
      // The conversation is still the conversation: the panel took the editor
      // slot, not the transcript.
      assert.match(panel, /restored answer/)

      // The panel owns the keyboard while it is open.
      harness.terminal.send('zz')
      await delay(SETTLE_MS)
      assert.ok(
        !harness.terminal.text().includes('zz'),
        `a keystroke must not reach the editor behind the panel:\n${harness.terminal.text()}`,
      )

      const closing = harness.terminal.frames
      harness.terminal.send(ESC)
      await harness.terminal.waitForFrame(closing)
      const closed = harness.terminal.text()
      // Nothing the command produced survives the panel: the transcript has the
      // same rows it had before, and the status output is gone entirely.
      assert.doesNotMatch(closed, /Session status/)
      assert.doesNotMatch(closed, /Registered tools/)
      // Byte-for-byte the screen it opened over, modulo the live stopwatch the
      // open step keeps counting: a panel adds no transcript row.
      assert.equal(
        settleClock(closed),
        settleClock(before),
        `closing a panel restores the screen it opened over:\n${closed}`,
      )

      // Esc restored focus to the editor, so typing lands in the prompt again.
      const restored = harness.terminal.frames
      harness.terminal.send('zz')
      await harness.terminal.waitForFrame(restored)
      assert.ok(
        harness.terminal.text().includes('zz'),
        `Esc must hand focus back to the editor:\n${harness.terminal.text()}`,
      )
    } finally {
      await unmount(harness)
    }
  })

  it('replaces an open panel instead of stacking a second one', async () => {
    const harness = await mount()
    try {
      const submit = (harness.controller as unknown as SubmitHandle).submit.bind(harness.controller)
      submit('/hotkeys')
      await delay(SETTLE_MS)
      assert.match(harness.terminal.text(), /Enter send/)

      submit('/palette')
      await delay(SETTLE_MS)
      const frame = harness.terminal.text()
      assert.match(frame, /Palette/)
      assert.doesNotMatch(frame, /Enter send/, `the second panel replaces the first:\n${frame}`)

      const closing = harness.terminal.frames
      harness.terminal.send(ESC)
      await harness.terminal.waitForFrame(closing)
      assert.doesNotMatch(harness.terminal.text(), /Palette/)
    } finally {
      await unmount(harness)
    }
  })
})

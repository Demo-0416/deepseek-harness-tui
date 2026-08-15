/**
 * The length rule a submitted prompt obeys: the pure cut itself, and the whole
 * paste-to-turn path around it — bracketed paste into the editor, marker
 * expansion on Enter, the middle dropped, the notice that says how much.
 *
 * The end-to-end cases assert what reached the agent rather than what reached
 * the screen: the transcript has a display clip of its own at the same default
 * threshold, so a frame assertion would be reading the wrong layer's ellipsis.
 * @module dsh-tui/tests/unit/prompt-truncation
 */

import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import {
  createTuiTestHarness,
  disposeTuiTestHarness,
  messageText,
  tuiEntryAvailable,
  type TuiHarness,
  type TuiHarnessOptions,
} from '../harness.ts'
import { HeadlessTerminal } from '../headless-terminal.ts'
import { setLocale } from '../../src/i18n/index.ts'
import { DEFAULT_MAX_PROMPT_CHARS, truncatePrompt } from '../../src/chat/prompt-truncation.ts'

/** Literal editor prefix, so a frame assertion never depends on prompt-value registrations. */
const INPUT_PROMPT = 'cut> '

/** Keys as the terminal delivers them. */
const ENTER = '\r'
const CTRL_R = '\x12'
const TAB = '\t'

/** A submission settles across a few awaits; outwait it. */
const SETTLE_MS = 80

/** One bracketed paste, exactly as a terminal wraps it. */
function bracketed(body: string): string {
  return `\x1b[200~${body}\x1b[201~`
}

/** `src/index.ts` is landed by a separate port; without it the end-to-end suite cannot run. */
const entryAvailable = await tuiEntryAvailable()
const skipWithoutEntry = entryAvailable
  ? false
  : 'requires src/index.ts to export createTuiChat(ctx, config, runtime)'

type CutHarness = TuiHarness<HeadlessTerminal, (code: number) => void>

async function mount(options: TuiHarnessOptions = {}): Promise<CutHarness> {
  const terminal = new HeadlessTerminal(96, 32)
  const before = terminal.frames
  const harness = await createTuiTestHarness(terminal, () => {}, {
    cwd: '/workspace/project',
    ...options,
    config: {
      title: 'DSH cut',
      welcome: 'ready.',
      ...options.config,
      theme: { color: false, inputPrompt: INPUT_PROMPT, ...options.config?.theme },
    },
  })
  await terminal.waitForFrame(before)
  return harness
}

async function unmount(harness: CutHarness): Promise<void> {
  await disposeTuiTestHarness(harness)
  await harness.terminal.dispose()
}

/** Send one chunk and wait for the frame it produces. */
async function press(harness: CutHarness, data: string): Promise<string> {
  const before = harness.terminal.frames
  harness.terminal.send(data)
  await harness.terminal.waitForFrame(before)
  return harness.terminal.text()
}

/** The frame with its own line wrapping collapsed, so a sentence reads as a sentence. */
function unwrapped(frame: string): string {
  return frame.replace(/\s+/gu, ' ')
}

describe('truncatePrompt', () => {
  it('returns a prompt inside the budget untouched', () => {
    assert.deepEqual(truncatePrompt('hello', 10), { text: 'hello', original: 5, removed: 0 })
  })

  it('leaves a prompt of exactly the budget alone', () => {
    const text = 'x'.repeat(100)
    const result = truncatePrompt(text, 100)
    assert.equal(result.removed, 0)
    assert.equal(result.text, text)
  })

  it('cuts an over-long prompt to exactly the budget', () => {
    const result = truncatePrompt('x'.repeat(30_000), DEFAULT_MAX_PROMPT_CHARS)
    assert.equal(result.text.length, DEFAULT_MAX_PROMPT_CHARS)
    assert.equal(result.original, 30_000)
  })

  it('keeps the head and the tail, and drops only the middle', () => {
    const result = truncatePrompt(`HEAD${'x'.repeat(30_000)}TAIL`, DEFAULT_MAX_PROMPT_CHARS)
    assert.ok(result.text.startsWith('HEAD'), result.text.slice(0, 20))
    assert.ok(result.text.endsWith('TAIL'), result.text.slice(-20))
  })

  it('prints a marker whose count agrees with what it reports', () => {
    const result = truncatePrompt('x'.repeat(30_000), DEFAULT_MAX_PROMPT_CHARS)
    const marker = /\n\n\.\.\. \[(\d+) characters truncated\] \.\.\.\n\n/u.exec(result.text)
    assert.ok(marker !== null, `the result carries the marker:\n${result.text.slice(0, 200)}`)
    assert.equal(Number(marker[1]), result.removed)
    // The marker is paid for out of the budget, not added on top.
    assert.equal(result.original - result.removed, DEFAULT_MAX_PROMPT_CHARS - marker[0].length)
  })

  it('states the count it reports even when the cut stepped off a surrogate pair', () => {
    // The head lands inside the emoji, so both edges give back a character the
    // marker's own arithmetic had already spent: the number printed in the text
    // and the number the notice prints come from the same cut or they disagree
    // on screen about a single truncation.
    const result = truncatePrompt(`${'a'.repeat(4_979)}😀${'b'.repeat(30_000)}`, DEFAULT_MAX_PROMPT_CHARS)
    const marker = /\n\n\.\.\. \[(\d+) characters truncated\] \.\.\.\n\n/u.exec(result.text)
    assert.ok(marker !== null, `the result carries the marker:\n${result.text.slice(0, 200)}`)
    assert.ok(result.text.slice(0, marker.index).endsWith('a'), 'the head stopped before the pair')
    assert.equal(Number(marker[1]), result.removed)
    assert.ok(
      result.text.length <= DEFAULT_MAX_PROMPT_CHARS,
      `${result.text.length} <= ${DEFAULT_MAX_PROMPT_CHARS}`,
    )
    assert.doesNotMatch(result.text, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u)
  })

  it('changes nothing on a second pass, so a re-submitted prompt is not cut twice', () => {
    const once = truncatePrompt('x'.repeat(30_000), DEFAULT_MAX_PROMPT_CHARS)
    const twice = truncatePrompt(once.text, DEFAULT_MAX_PROMPT_CHARS)
    assert.equal(twice.removed, 0)
    assert.equal(twice.text, once.text)
  })

  it('sends every prompt whole when the budget is zero or negative', () => {
    const huge = 'x'.repeat(1_000_000)
    for (const limit of [0, -1]) {
      const result = truncatePrompt(huge, limit)
      assert.equal(result.removed, 0)
      assert.equal(result.text.length, 1_000_000)
    }
  })

  it('never cuts between the halves of a surrogate pair', () => {
    // Both parities of the head offset: the odd one is the cut that would have
    // left a lone high surrogate behind, which is what breaks JSON encoding.
    for (const limit of [DEFAULT_MAX_PROMPT_CHARS, DEFAULT_MAX_PROMPT_CHARS + 1]) {
      const result = truncatePrompt('😀'.repeat(20_000), limit)
      assert.doesNotMatch(result.text, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u)
      assert.doesNotMatch(result.text, /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u)
      assert.ok(result.text.length <= limit, `${result.text.length} <= ${limit}`)
    }
  })

  it('keeps the head alone when the budget cannot seat the marker', () => {
    const result = truncatePrompt('abcdefghij', 4)
    assert.equal(result.text, 'abcd')
    assert.equal(result.removed, 6)
    assert.doesNotMatch(result.text, /characters truncated/u)
  })

  it('keeps the pair whole on that head, so a tiny budget cannot emit a lone surrogate', () => {
    // A budget under ~39 characters takes the marker-less path; it owes the
    // request body the same guarantee, since a lone surrogate is what JSON
    // encoding cannot carry.
    const result = truncatePrompt('😀'.repeat(50), 5)
    assert.doesNotMatch(result.text, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u)
    assert.equal(result.text, '😀😀')
    assert.equal(result.original, 100)
    assert.equal(result.removed, 96)
  })
})

describe('a pasted file at the prompt', { skip: skipWithoutEntry }, () => {
  afterEach(() => { setLocale('en') })

  it('reaches the model cut to the default budget, and says how long it was', async () => {
    const harness = await mount()
    try {
      const pasted = await press(harness, bracketed('x'.repeat(30_000)))
      // pi-tui folds the paste into a marker, so the line buffer stays small.
      assert.match(pasted, /\[paste #1 30000 chars\]/u)
      await press(harness, ENTER)
      await delay(SETTLE_MS)

      const sent = harness.agent.followups[0]
      assert.ok(sent !== undefined, 'the prompt became a turn')
      const text = messageText(sent)
      assert.equal(text.length, DEFAULT_MAX_PROMPT_CHARS)
      assert.match(text, /\.\.\. \[\d+ characters truncated\] \.\.\./u)
      // What the notice says is asserted on the configured-budget case instead:
      // a 10,000-character echo is a hundred rows, and the notice above it has
      // scrolled off a 32-row screen by the time the turn is sent.
    } finally {
      await unmount(harness)
    }
  })

  it('obeys the budget a deployment configures', async () => {
    const harness = await mount({ config: { maxPromptChars: 100 } })
    try {
      await press(harness, bracketed('y'.repeat(500)))
      await press(harness, ENTER)
      await delay(SETTLE_MS)

      const sent = harness.agent.followups[0]
      assert.ok(sent !== undefined, 'the prompt became a turn')
      assert.equal(messageText(sent).length, 100)
      const frame = unwrapped(harness.terminal.text())
      assert.match(frame, /500 characters/u)
      assert.match(frame, /limit is 100/u)
    } finally {
      await unmount(harness)
    }
  })

  it('sends the whole thing when the budget is turned off', async () => {
    const harness = await mount({ config: { maxPromptChars: 0 } })
    try {
      await press(harness, bracketed('z'.repeat(30_000)))
      await press(harness, ENTER)
      await delay(SETTLE_MS)

      const sent = harness.agent.followups[0]
      assert.ok(sent !== undefined, 'the prompt became a turn')
      assert.equal(messageText(sent).length, 30_000)
      assert.doesNotMatch(unwrapped(harness.terminal.text()), /characters truncated/u)
    } finally {
      await unmount(harness)
    }
  })

  it('leaves an ordinary prompt exactly as it was typed', async () => {
    const harness = await mount()
    try {
      await press(harness, 'write the tests')
      await press(harness, ENTER)
      await delay(SETTLE_MS)

      const sent = harness.agent.followups[0]
      assert.ok(sent !== undefined, 'the prompt became a turn')
      assert.equal(messageText(sent), 'write the tests')
      assert.doesNotMatch(unwrapped(harness.terminal.text()), /characters truncated/u)
    } finally {
      await unmount(harness)
    }
  })

  it('stores the text it sent in the history, and re-sending it cuts nothing further', async () => {
    // A small budget, so the echo and the search panel both fit a 32-row screen.
    const harness = await mount({ config: { maxPromptChars: 120 } })
    try {
      await press(harness, bracketed(`HEAD${'q'.repeat(500)}TAIL`))
      await press(harness, ENTER)
      await delay(SETTLE_MS)

      // The history holds what was sent, not the 500 the user pasted: an entry
      // the search restores goes straight back into the line buffer. The query
      // is a word only the marker carries, so a hit proves which text was kept.
      await press(harness, CTRL_R)
      const found = await press(harness, 'truncated')
      assert.doesNotMatch(unwrapped(found), /no matching prompt/u)
      await press(harness, TAB)
      await press(harness, ENTER)
      await delay(SETTLE_MS)

      const first = harness.agent.followups[0]
      const second = harness.agent.followups[1]
      assert.ok(first !== undefined && second !== undefined, 'both prompts became turns')
      assert.equal(messageText(second), messageText(first))
      assert.equal(messageText(second).match(/characters truncated/gu)?.length, 1)
    } finally {
      await unmount(harness)
    }
  })

  it('says it in Chinese when the interface is Chinese', async () => {
    setLocale('zh')
    const harness = await mount({ config: { maxPromptChars: 100 } })
    try {
      await press(harness, bracketed('w'.repeat(500)))
      await press(harness, ENTER)
      await delay(SETTLE_MS)
      assert.match(unwrapped(harness.terminal.text()), /已丢弃中间/u)
    } finally {
      await unmount(harness)
    }
  })
})

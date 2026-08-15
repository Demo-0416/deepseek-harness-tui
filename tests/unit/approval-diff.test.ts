/**
 * The change a file-writing permission prompt shows before it asks: the
 * old→new hunks inline in the dialog, the budget that keeps them from pushing
 * the answers off screen, and every way a prompt without a readable change
 * falls back to the plain question.
 *
 * Two levels. The component cases pin the frame: which rows the preview adds,
 * what a clipped diff says, and that a hunk row reaches the terminal exactly as
 * the diff renderer built it. The mounted cases pin the wiring: the pending
 * call's own presenter is what the dialog draws, and arguments nobody can parse
 * draw the dialog that existed before there was a preview.
 * @module dsh-tui/tests/unit/approval-diff
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { stripTerminalSequences } from '@earendil-works/pi-tui'
import { CallId } from '@deepseek-ai/dsh-llm'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { ApprovalDialog, type ApprovalLimits, type ApprovalPrompt } from '../../src/components/approval.ts'
import { createPalette } from '../../src/components/theme.ts'
import { setLocale } from '../../src/i18n/index.ts'
import { parseDiffBounded, renderUnified } from '../../src/render/diff.ts'
import {
  createTuiTestHarness,
  disposeTuiTestHarness,
  tuiEntryAvailable,
  type TuiHarness,
  type TuiHarnessOptions,
} from '../harness.ts'
import { HeadlessTerminal } from '../headless-terminal.ts'

/** Literal editor prefix, so a frame assertion never depends on prompt-value registrations. */
const INPUT_PROMPT = 'smoke> '

/** `src/index.ts` is landed by a separate port; without it the mounted cases cannot run. */
const entryAvailable = await tuiEntryAvailable()
const skipWithoutEntry = entryAvailable
  ? false
  : 'requires src/index.ts to export createTuiChat(ctx, config, runtime)'

/** A logged tool call reaches the terminal's own listener across a few awaits. */
const SETTLE_MS = 60

/** The overlay height the front door opens a permission prompt with (`questionDialogMaxHeight`). */
const DIALOG_MAX_HEIGHT = 20

const palette = createPalette(false)

type SmokeHarness = TuiHarness<HeadlessTerminal, (code: number) => void>

/** The fail-closed tail of the answerer chain, standing in for the approval service's default. */
function chainDefault(): Promise<ApprovalOutcome> {
  return Promise.resolve('unavailable')
}

/** One dialog, driven by raw key data. */
function fixture(prompt: ApprovalPrompt, limits: ApprovalLimits = {}): ApprovalDialog {
  const dialog = new ApprovalDialog(prompt, palette, () => {}, limits)
  dialog.focused = true
  return dialog
}

/**
 * The dialog's rows with their escapes removed. The diff renderer paints
 * regardless of the palette — background fills are how a hunk reads — so a
 * frame assertion has to look at the text underneath.
 */
function rows(dialog: ApprovalDialog, width = 96): string[] {
  return dialog.render(width).map(row => stripTerminalSequences(row))
}

/** The dialog's frame as one string, the way a terminal shows it. */
function screen(dialog: ApprovalDialog, width = 96): string {
  return rows(dialog, width).join('\n')
}

/** An editor whose presenter reports the change its arguments would make. */
function editTool(): ToolDefinition {
  return defineTool({
    name: 'edit',
    description: 'edit fixture',
    parameters: {
      path: { type: 'string', required: true },
      text: { type: 'string', required: true },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: () => Promise.resolve('done'),
    presentCall: (args) => {
      const call = args as { path: string; text: string }
      return {
        card: 'diff',
        title: `Write ${call.path}`,
        diffs: [{ path: call.path, oldText: null, newText: call.text }],
      }
    },
  })
}

/** An editor whose presenter is broken, standing in for every presenter that throws. */
function brokenTool(): ToolDefinition {
  return defineTool({
    name: 'edit',
    description: 'broken fixture',
    parameters: { path: { type: 'string', required: true } },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: () => Promise.resolve('done'),
    presentCall: () => {
      throw new Error('presenter fixture failure')
    },
  })
}

/** Mount the TUI on a headless terminal and wait for its first completed frame. */
async function mount(options: TuiHarnessOptions = {}): Promise<SmokeHarness> {
  const terminal = new HeadlessTerminal(96, 32)
  const before = terminal.frames
  const harness = await createTuiTestHarness(terminal, () => {}, {
    cwd: '/workspace/project',
    tools: { edit: editTool() },
    ...options,
    config: {
      title: 'DSH approval diff',
      ...options.config,
      theme: { color: false, inputPrompt: INPUT_PROMPT, ...options.config?.theme },
    },
  })
  await terminal.waitForFrame(before)
  return harness
}

async function unmount(harness: SmokeHarness): Promise<void> {
  await disposeTuiTestHarness(harness)
  await harness.terminal.dispose()
}

/** Log the call the request is about, the way a driver logs it before executing. */
async function logCall(harness: SmokeHarness, id: string, args: string): Promise<void> {
  harness.session.append('tool/call', {
    turn: 1,
    step: 1,
    callId: CallId(id),
    name: 'edit',
    arguments: args,
  })
  await delay(SETTLE_MS)
}

/**
 * Just the permission prompt out of a whole screen. The pending call draws its
 * own diff card in the transcript above, so a frame assertion that does not cut
 * the prompt out would pass on the card alone.
 */
function dialogOf(harness: SmokeHarness): string {
  const lines = harness.terminal.text().split('\n')
  const start = lines.findIndex(line => line.includes('Permission required'))
  assert.ok(start >= 0, `the prompt is on screen:\n${lines.join('\n')}`)
  return lines.slice(start).join('\n')
}

/** Ask the answerer chain about one logged call. */
function ask(harness: SmokeHarness, id: string): Promise<ApprovalOutcome> {
  return harness.ctx.waterfall('approval/request', {
    agent: harness.agent,
    toolName: 'edit',
    callId: CallId(id),
  }, chainDefault)
}

describe('ApprovalDialog change preview', () => {
  it('shows the old and new lines of the change it is asking about', () => {
    const frame = screen(fixture({
      toolName: 'edit',
      reason: 'the file is outside the workspace',
      diffs: [{ path: 'src/a.ts', oldText: 'const a = 1\n', newText: 'const a = 2\n' }],
    }))
    assert.match(frame, /src\/a\.ts/, `the file is named:\n${frame}`)
    assert.match(frame, /1-\s*│ const a = 1/, `the line it replaces is shown:\n${frame}`)
    assert.match(frame, /1\+\s*│ const a = 2/, `and the line it writes:\n${frame}`)
    // The preview is worth nothing if it costs the row that answers the question.
    assert.match(frame, /1\. Yes, allow once/)
    assert.match(frame, /4\. No, reject/)
  })

  it('leaves a prompt with no change exactly as it was', () => {
    const frame = screen(fixture({ toolName: 'bash', reason: 'running a command' }))
    assert.doesNotMatch(frame, /│/u, `nothing diff-shaped is drawn:\n${frame}`)
    assert.match(frame, /1\. Yes, allow once/)
  })

  it('renders a new file as additions with nothing removed', () => {
    const frame = screen(fixture({
      toolName: 'write',
      diffs: [{ path: 'notes.txt', oldText: null, newText: 'hello\nworld\n' }],
    }))
    assert.match(frame, /1\+\s*│ hello/, `a create is all additions:\n${frame}`)
    assert.match(frame, /2\+\s*│ world/)
    assert.doesNotMatch(frame, /\d-\s*│/u, `and removes nothing:\n${frame}`)
  })

  it('clips a huge change instead of pushing the answers off the overlay', () => {
    const newText = `${Array.from({ length: 500 }, (_value, index) => `line ${index}`).join('\n')}\n`
    const dialog = fixture(
      { toolName: 'write', reason: 'rewriting the file', diffs: [{ path: 'src/big.ts', oldText: null, newText }] },
      { maxHeight: DIALOG_MAX_HEIGHT, maxDiffEditLength: 1000 },
    )
    const frame = rows(dialog)
    // The overlay clips from the bottom, so a preview that overruns takes the
    // answers with it: the whole frame has to fit the height it was opened at.
    assert.ok(
      frame.length <= DIALOG_MAX_HEIGHT,
      `the prompt fits the overlay it opened in (${frame.length} rows):\n${frame.join('\n')}`,
    )
    assert.match(frame.join('\n'), /more diff lines • rest not shown/, `the clip says so:\n${frame.join('\n')}`)
    assert.match(frame.join('\n'), /5\. Yes, and don't ask again for write in this project/, 'every answer survives')
  })

  it('keeps the answers on screen on a wide terminal, where every row soft-wraps', () => {
    // The unified layout wraps one long line into two rows past 120 columns and
    // three past 180, and the overlay clips from the bottom — so a budget
    // counted in diff LINES overruns exactly where the dialog is widest. The
    // permission prompt has to fit at every width it can be opened at.
    const long = (mark: string): string => `${Array.from(
      { length: 6 },
      (_value, index) => `${mark} ${index} ${'x'.repeat(200)}`,
    ).join('\n')}\n`
    for (const width of [80, 96, 120, 122, 140, 200]) {
      const dialog = fixture(
        {
          toolName: 'edit',
          reason: 'the file is outside the workspace',
          diffs: [{ path: 'README.md', oldText: long('old'), newText: long('new') }],
        },
        { maxHeight: DIALOG_MAX_HEIGHT, maxDiffEditLength: 1000 },
      )
      const frame = rows(dialog, width)
      const shown = frame.slice(0, DIALOG_MAX_HEIGHT).join('\n')
      assert.ok(
        frame.length <= DIALOG_MAX_HEIGHT,
        `at ${width} columns the prompt fits its overlay (${frame.length} rows):\n${frame.join('\n')}`,
      )
      assert.match(shown, /1\. Yes, allow once/, `at ${width} columns the answers are visible:\n${shown}`)
      assert.match(shown, /4\. No, reject/, `at ${width} columns the refusal is visible:\n${shown}`)
    }
  })

  it('fits however many files the call would touch', () => {
    // Every extra file costs a name and a count, and a budget that only ever
    // subtracted them from the hunks would let the seventh file push the last
    // answer off the overlay.
    for (const count of [1, 2, 3, 4, 6, 10]) {
      const diffs = Array.from({ length: count }, (_value, index) => ({
        path: `src/file-${index}.ts`,
        oldText: 'a\n',
        newText: 'b\n',
      }))
      const dialog = fixture({ toolName: 'edit', reason: 'rewriting the tree', diffs }, { maxHeight: DIALOG_MAX_HEIGHT })
      const frame = rows(dialog)
      assert.ok(
        frame.length <= DIALOG_MAX_HEIGHT,
        `${count} files fit the overlay (${frame.length} rows):\n${frame.join('\n')}`,
      )
      const shown = frame.join('\n')
      assert.match(shown, /1\. Yes, allow once/, `${count} files leave the answers on screen:\n${shown}`)
      assert.match(shown, /5\. Yes, and don't ask again/, `including the durable one:\n${shown}`)
      assert.match(shown, /src\/file-0\.ts/, 'and the first file is always named')
    }
    // Past what the height can name one by one, the rest are counted in a line.
    const many = Array.from({ length: 10 }, (_value, index) => ({
      path: `src/file-${index}.ts`,
      oldText: 'a\n',
      newText: 'b\n',
    }))
    const frame = screen(fixture({ toolName: 'edit', diffs: many }, { maxHeight: DIALOG_MAX_HEIGHT }))
    assert.match(frame, /more files this call would change/, `the rest are counted:\n${frame}`)
  })

  it('says the clip and the counts in the language the dialog is speaking', () => {
    const newText = `${Array.from({ length: 40 }, (_value, index) => `line ${index}`).join('\n')}\n`
    setLocale('zh')
    try {
      const frame = screen(fixture(
        {
          toolName: 'edit',
          diffs: [
            { path: 'src/a.ts', oldText: null, newText },
            { path: 'src/unchanged.ts', oldText: 'same\n', newText: 'same\n' },
          ],
        },
        { maxHeight: DIALOG_MAX_HEIGHT },
      ))
      assert.match(frame, /其余未显示/, `the clip marker is translated:\n${frame}`)
      assert.doesNotMatch(frame, /more diff lines/, 'rather than half of it staying English')
      assert.match(frame, /无改动/, `and so is a file with nothing in it:\n${frame}`)
      assert.doesNotMatch(frame, /no changes/)
    } finally {
      setLocale('en')
    }
  })

  it('says so when the change is too large to compare exactly', () => {
    const oldText = `${Array.from({ length: 200 }, (_value, index) => `old ${index}`).join('\n')}\n`
    const newText = `${Array.from({ length: 200 }, (_value, index) => `new ${index}`).join('\n')}\n`
    const dialog = fixture(
      { toolName: 'write', diffs: [{ path: 'src/big.ts', oldText, newText }] },
      { maxHeight: DIALOG_MAX_HEIGHT, maxDiffEditLength: 2 },
    )
    const frame = rows(dialog)
    assert.match(
      frame.join('\n'),
      /exact line diff omitted: more than 2 changed lines/,
      `the approximation is disclosed:\n${frame.join('\n')}`,
    )
    assert.ok(frame.length <= DIALOG_MAX_HEIGHT, `and the note comes out of the diff's own budget (${frame.length})`)
    assert.match(frame.join('\n'), /1\. Yes, allow once/)
  })

  it('spends the hunks on the first file and names the rest', () => {
    const frame = screen(fixture({
      toolName: 'edit',
      diffs: [
        { path: 'first.ts', oldText: 'a\n', newText: 'b\n' },
        { path: 'second.ts', oldText: null, newText: 'brand new\n' },
      ],
    }, { maxHeight: DIALOG_MAX_HEIGHT }))
    assert.match(frame, /1\+\s*│ b/, `the first file gets its hunks:\n${frame}`)
    assert.match(frame, /second\.ts/, 'the second is named')
    assert.doesNotMatch(frame, /brand new/, `but summarised rather than drawn:\n${frame}`)
    assert.match(frame, /\+1/, 'with its change count')
  })

  it('summarises rather than draws when the dialog is too narrow for a gutter', () => {
    const frame = screen(fixture({
      toolName: 'edit',
      diffs: [{ path: 'a.ts', oldText: 'x\n', newText: 'y\n' }],
    }), 28)
    assert.match(frame, /a\.ts/, `the file is still named:\n${frame}`)
    assert.match(frame, /\+1 -1/, 'and the change counted')
    assert.doesNotMatch(frame, /│ y/u, `but a row wider than the body is never emitted:\n${frame}`)
  })

  it('keeps the change on screen while the feedback editor is open', () => {
    const dialog = fixture({
      toolName: 'edit',
      diffs: [{ path: 'src/a.ts', oldText: 'const a = 1\n', newText: 'const a = 2\n' }],
    })
    dialog.handleInput('3')
    const frame = screen(dialog)
    assert.match(frame, /Tell the agent what to do differently/, `the editor replaced the answers:\n${frame}`)
    assert.match(frame, /1\+\s*│ const a = 2/, `the change it is about is still there:\n${frame}`)
  })

  it('emits a hunk row exactly as the diff renderer built it', () => {
    // A row of wide characters is wider in columns than the renderer's own
    // character count says, so the frame's clip would cut it — and cut the
    // background fill and reset it carries with it. The row goes through whole.
    const wide = `${'中'.repeat(60)}\n`
    const frame = rows(fixture({ toolName: 'edit', diffs: [{ path: 'a.ts', oldText: 'x\n', newText: wide }] }))
    const hunk = frame.find(row => row.includes('中'))
    assert.ok(hunk !== undefined, `the wide line is rendered:\n${frame.join('\n')}`)
    assert.doesNotMatch(hunk, /…$/u, `and reaches the terminal unclipped:\n${JSON.stringify(hunk)}`)
    assert.ok(hunk.includes('中'.repeat(50)), 'with its content intact')
  })
})

describe('TUI approval change preview', { skip: skipWithoutEntry }, () => {
  it('draws the pending edit the call would make', async () => {
    const harness = await mount()
    try {
      await logCall(harness, 'call-edit', JSON.stringify({ path: 'src/hello.ts', text: 'next\n' }))
      const before = harness.terminal.frames
      const decision = ask(harness, 'call-edit')
      await harness.terminal.waitForFrame(before)
      const frame = dialogOf(harness)
      assert.match(frame, /src\/hello\.ts/, `the prompt names the file:\n${frame}`)
      assert.match(frame, /1\+\s*│ next/, `and shows what it would write:\n${frame}`)
      harness.terminal.send('4')
      assert.equal(await decision, 'rejected')
    } finally {
      await unmount(harness)
    }
  })

  it('asks the plain question when the call behind it cannot be read', async () => {
    const harness = await mount()
    try {
      // Arguments the presenter can never be given: the prompt is the one it
      // was before there was a preview, and nothing throws on the way there.
      await logCall(harness, 'call-broken', 'not json at all')
      const before = harness.terminal.frames
      const decision = ask(harness, 'call-broken')
      await harness.terminal.waitForFrame(before)
      const frame = dialogOf(harness)
      assert.match(frame, /1\. Yes, allow once/, `answers intact:\n${frame}`)
      assert.match(frame, /4\. No, reject/)
      // A request that could not say what it is about gets no durable row: a
      // permanent grant is offered on what the prompt SHOWED, never on a tool
      // name it could not look behind.
      assert.doesNotMatch(frame, /5\./, `nothing permanent is offered blind:\n${frame}`)
      assert.doesNotMatch(frame, /│/u, `and no diff is invented:\n${frame}`)
      harness.terminal.send('4')
      assert.equal(await decision, 'rejected')
    } finally {
      await unmount(harness)
    }
  })

  it('asks the plain question when the tool cannot present its own call', async () => {
    const harness = await mount({ tools: { edit: brokenTool() } })
    try {
      await logCall(harness, 'call-throws', JSON.stringify({ path: 'src/hello.ts' }))
      const before = harness.terminal.frames
      const decision = ask(harness, 'call-throws')
      await harness.terminal.waitForFrame(before)
      const frame = dialogOf(harness)
      assert.match(frame, /1\. Yes, allow once/, `a broken presenter is not a broken prompt:\n${frame}`)
      assert.doesNotMatch(frame, /5\./, `and offers nothing permanent about a call it cannot read:\n${frame}`)
      assert.doesNotMatch(frame, /│/u)
      harness.terminal.send('4')
      assert.equal(await decision, 'rejected')
    } finally {
      await unmount(harness)
    }
  })
})

describe('diff rendering budgets', () => {
  it('declines a comparison past its edit budget', () => {
    const oldText = `${Array.from({ length: 40 }, (_value, index) => `old ${index}`).join('\n')}\n`
    const newText = `${Array.from({ length: 40 }, (_value, index) => `new ${index}`).join('\n')}\n`
    assert.equal(parseDiffBounded(oldText, newText, 2), undefined, 'a rewrite past the budget declines')
    assert.notEqual(parseDiffBounded(oldText, newText, 1000), undefined, 'and lands inside a generous one')
  })

  it('marks a clipped render with the hint its caller gave it', () => {
    const parsed = parseDiffBounded('', `${Array.from({ length: 20 }, (_value, index) => `line ${index}`).join('\n')}\n`, 1000)
    assert.ok(parsed !== undefined)
    const clipped = renderUnified(parsed, 60, { maxLines: 4, toggleHint: 'rest not shown' }).map(stripTerminalSequences)
    assert.equal(clipped.filter(row => /│ line/u.test(row)).length, 4, `only the budget is drawn:\n${clipped.join('\n')}`)
    assert.match(clipped.join('\n'), /… \(16 more diff lines • rest not shown\)/)
  })
})

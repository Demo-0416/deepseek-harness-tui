/**
 * Transcript reconciliation, end to end: the mounted TUI is driven by appending
 * to its session, so these cases cover the whole `session/event → fold →
 * snapshot → keyed reconciler → pi-tui` path rather than any one link.
 *
 * They exist because the fold's unit tests cannot see placement: a card that is
 * folded correctly can still land in the wrong place, survive a `/clear`, or
 * ignore the Ctrl+O cycle. The one exception is the phase notice, which is a
 * pure function of the phase and is asserted directly.
 * @module dsh-tui/tests/unit/transcript
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { CallId, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import {
  appendAssistant,
  appendUser,
  createTuiTestHarness,
  disposeTuiTestHarness,
  setAgentStatus,
  tuiEntryAvailable,
  type TuiHarness,
} from '../harness.ts'
import { HeadlessTerminal } from '../headless-terminal.ts'
import { cardPhaseNotice } from '../../src/components/reconciler.ts'
import { TodoComponent } from '../../src/components/transcript.ts'
import { createPalette } from '../../src/components/theme.ts'

/** `src/index.ts` is landed by a separate port; without it this suite cannot run. */
const entryAvailable = await tuiEntryAvailable()
const skipWithoutEntry = entryAvailable
  ? false
  : 'requires src/index.ts to export createTuiChat(ctx, config, runtime)'

/** Literal editor prefix, so "the editor is on screen" needs no prompt registrations. */
const INPUT_PROMPT = 'dsh> '

/**
 * The store publishes one snapshot per 16 ms frame, so a test settles by
 * outwaiting that batch rather than by counting frames.
 */
const SETTLE_MS = 60

type Harness = TuiHarness<HeadlessTerminal, (code: number) => void>

async function mount(): Promise<Harness> {
  const terminal = new HeadlessTerminal(100, 40)
  const harness = await createTuiTestHarness(terminal, () => {}, {
    cwd: '/workspace/project',
    config: {
      title: 'DSH transcript',
      welcome: 'ready.',
      theme: { color: false, inputPrompt: INPUT_PROMPT },
    },
  })
  await delay(SETTLE_MS)
  return harness
}

async function unmount(harness: Harness): Promise<void> {
  await disposeTuiTestHarness(harness)
  await harness.terminal.dispose()
}

/** Append one complete assistant step that calls a tool and reads its result. */
function appendToolStep(session: Session, id: string, command: string, output: string): void {
  const callId = CallId(id)
  const position = { turn: 1, step: 2 }
  session.append('step/start', position)
  session.append('assistant/chunk', {
    ...position,
    chunk: { type: 'text-delta', index: 0, text: `Running ${command}` },
  })
  appendAssistant(session, [
    { type: 'text', text: `Running ${command}` },
    { type: 'tool-call', id: callId, name: 'bash', arguments: JSON.stringify({ command }) },
  ], undefined, position)
  session.append('tool/call', { ...position, callId, name: 'bash', arguments: JSON.stringify({ command }) })
  session.append('tool/result', {
    ...position,
    message: createToolResultMessage({ callId, content: [{ type: 'text', text: output }], isError: false }),
  }, { surfaceOp: 'append' })
  session.append('step/end', position)
}

/** Settle the open step and land one tool card under it, closing the step. */
function appendToolTail(session: Session, position: { turn: number; step: number }, callId: CallId): void {
  const args = JSON.stringify({ command: 'ls' })
  appendAssistant(session, [
    { type: 'text', text: 'answering' },
    { type: 'tool-call', id: callId, name: 'bash', arguments: args },
  ], undefined, position)
  session.append('tool/call', { ...position, callId, name: 'bash', arguments: args })
  session.append('tool/result', {
    ...position,
    message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'CARD-OUTPUT' }], isError: false }),
  }, { surfaceOp: 'append' })
  session.append('step/end', position)
}

describe('Ctrl+O phase notice', () => {
  it('names what each phase leaves on screen, and claims context only where it renders', () => {
    // The collapsed phase no longer shows context cards, so the sentence it
    // flashes cannot keep saying it does; the other two already matched what
    // the reconciler does with each kind of card.
    assert.equal(cardPhaseNotice('collapsed'), 'Tool cards collapsed; context hidden.')
    assert.equal(cardPhaseNotice('expanded'), 'Tool and context cards expanded.')
    assert.equal(cardPhaseNotice('hidden'), 'Tool cards hidden.')
  })
})

describe('the plan panel', () => {
  /** Six items, so every budget case has something to drop. */
  const TODOS = [
    { content: 'first item', status: 'completed' as const },
    { content: 'second item', status: 'in_progress' as const },
    { content: 'third item', status: 'pending' as const },
    { content: 'fourth item', status: 'pending' as const },
    { content: 'fifth item', status: 'pending' as const },
    { content: 'sixth item', status: 'pending' as const },
  ]

  /**
   * Build a panel over a fixed terminal height.
   * @param rows - The terminal's row count.
   * @returns The panel, already carrying {@link TODOS}.
   */
  function panel(rows: number): TodoComponent {
    const component = new TodoComponent(createPalette(false), () => rows)
    component.update(TODOS)
    return component
  }

  it('shows the whole plan on a terminal with room for it', () => {
    const lines = panel(40).render(60).join('\n')

    assert.match(lines, /Plan/u)
    assert.match(lines, /sixth item/u)
    assert.doesNotMatch(lines, /\+/u)
  })

  it('drops the least urgent items and counts what it dropped', () => {
    // 18 rows budget 4 items, so two pending items fall off the end.
    const lines = panel(18).render(60).join('\n')

    assert.match(lines, /second item/u)
    assert.doesNotMatch(lines, /sixth item/u)
    // In-progress first, then pending, then completed: the item being worked on
    // is never the one a short panel drops, and the finished one goes first.
    assert.match(lines, /… \+1 pending, 1 completed/u)
  })

  it('falls back to the summary row on a terminal with no rows to spare', () => {
    const lines = panel(8).render(60).join('\n')

    assert.match(lines, /Plan 1\/6 done · Next: second item/u)
    assert.doesNotMatch(lines, /third item/u)
  })

  it('summarizes a finished plan without naming a next item', () => {
    const component = new TodoComponent(createPalette(false), () => 40)
    component.update([{ content: 'the only item', status: 'completed' }])
    component.setExpanded(false)

    assert.match(component.render(60).join('\n'), /Plan 1\/1 done$/u)
  })

  it('renders nothing at all until the session has a plan', () => {
    assert.deepEqual(new TodoComponent(createPalette(false), () => 40).render(60), [])
  })
})

describe('transcript reconciliation', { skip: skipWithoutEntry }, () => {
  it('renders a live turn and trails the step timing under its tool card', async () => {
    const harness = await mount()
    try {
      appendUser(harness.session, 'list the files')
      appendToolStep(harness.session, 'call-1', 'ls', 'README.md')
      await delay(SETTLE_MS)

      const rows = harness.terminal.text().split('\n').map(row => row.trimEnd())
      const prompt = rows.findIndex(row => row.includes('list the files'))
      const answer = rows.findIndex(row => row.includes('Running ls'))
      const card = rows.findIndex(row => row.includes('bash'))
      const output = rows.findIndex(row => row.includes('README.md'))
      assert.ok(prompt >= 0 && answer > prompt, `prompt then answer expected:\n${rows.join('\n')}`)
      assert.ok(card > answer, `the tool card follows its step's message:\n${rows.join('\n')}`)
      assert.ok(output > card, `the result body follows the card header:\n${rows.join('\n')}`)
      // Claude Code prints no per-step timing at all, so the default transcript
      // carries none either: this turn ran in milliseconds and reports nothing.
      assert.ok(
        !rows.some(row => row.includes('Completed ') || row.includes('Model wait')),
        `the default transcript carries no per-step timing line:\n${rows.join('\n')}`,
      )

      // Ctrl+O (expanded) is where the run's own traffic lives, and there the
      // breakdown is back — still at the tail of the step's output, after the
      // tool cards that step requested.
      harness.terminal.send('\x0f')
      await delay(SETTLE_MS)
      const opened = harness.terminal.text().split('\n').map(row => row.trimEnd())
      const timing = opened.findIndex(row => row.includes('Completed '))
      const body = opened.findIndex(row => row.includes('README.md'))
      assert.ok(body >= 0 && timing > body, `the timing footer trails the tool card:\n${opened.join('\n')}`)
    } finally {
      await unmount(harness)
    }
  })

  it('keeps injected context off the transcript until Ctrl+O expands it, in log order', async () => {
    // Replay of session-85d19568 (`how are you doing`): the terminal echoes the
    // prompt, and only then does the agent log `step/start`, the claimed prompt,
    // the two context snapshots the request was assembled from, and the answer.
    // No seeded lifecycle, so the step opens exactly where the real log opens it.
    const terminal = new HeadlessTerminal(100, 40)
    const harness = await createTuiTestHarness(terminal, () => {}, {
      cwd: '/workspace/project',
      omitInitialLifecycle: true,
      config: { title: 'DSH transcript', welcome: 'ready.', theme: { color: false, inputPrompt: INPUT_PROMPT } },
    })
    try {
      await delay(SETTLE_MS)
      terminal.send('how are you doing')
      terminal.send('\r')
      await delay(SETTLE_MS)
      const submitted = [...harness.agent.sent.map(delivery => delivery.message), ...harness.agent.followups][0]
      assert.ok(submitted !== undefined, 'the prompt reached the agent')

      const position = { turn: 1, step: 1 }
      harness.session.append('turn/start', { turn: 1 })
      harness.session.append('step/start', position)
      harness.session.append('user/message', submitted, { surfaceOp: 'append' })
      harness.session.append('user/message', createUserMessage({
        content: [{
          type: 'text',
          text: 'Current runtime context. This snapshot supersedes earlier ones.\nSANDBOX-POLICY',
        }],
        source: {
          kind: 'plugin',
          plugin: 'dsh-system-prompt',
          form: 'snapshot',
          sections: [{ name: 'sandbox:policy', text: 'SANDBOX-POLICY' }],
        },
      }), { surfaceOp: 'append' })
      harness.session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: '<system-reminder>\nSKILL-CATALOG-BODY\n</system-reminder>' }],
        // The kind the recorded log carries; this checkout declares no such
        // source, which is exactly the merge-extensible boundary the fold reads.
        source: { kind: 'skill-catalog', form: 'catalog' } as never,
      }), { surfaceOp: 'append' })
      harness.session.append('assistant/chunk', {
        ...position,
        chunk: { type: 'text-delta', index: 0, text: 'ANSWER-TEXT' },
      })
      appendAssistant(harness.session, [{ type: 'text', text: 'ANSWER-TEXT' }], undefined, position)
      harness.session.append('step/end', position)
      await delay(SETTLE_MS)

      const rows = terminal.text().split('\n').map(row => row.trimEnd())
      const at = (needle: string): number => rows.findIndex(row => row.includes(needle))
      const prompt = at('how are you doing')
      const answer = at('ANSWER-TEXT')
      const frame = rows.join('\n')
      assert.ok(prompt >= 0, `the prompt is on screen:\n${frame}`)
      // Collapsed is the default phase every session opens on, and injected
      // context is traffic between the harness and the model rather than part of
      // the conversation: neither card is on screen at all — no body, and no
      // one-row placeholder standing in for one either.
      assert.ok(!frame.includes('Context ·'), `no context card renders by default:\n${frame}`)
      assert.ok(!frame.includes('SANDBOX-POLICY'), `and none of its body:\n${frame}`)
      assert.ok(!frame.includes('SKILL-CATALOG-BODY'), `for either card:\n${frame}`)
      assert.ok(answer > prompt, `the answer follows the prompt with nothing between them:\n${frame}`)
      // The per-step breakdown is traffic too: the default transcript is the
      // conversation and nothing else.
      assert.ok(!frame.includes('Completed '), `and no timing line trails it:\n${frame}`)

      // Ctrl+O (expanded) is where a user goes to see what the model was sent,
      // and there the cards open where the log recorded them: after the prompt
      // they were sent with, in log order, above the answer they produced.
      terminal.send('\x0f')
      await delay(SETTLE_MS)
      const expanded = terminal.text().split('\n').map(row => row.trimEnd())
      const opened = (needle: string): number => expanded.findIndex(row => row.includes(needle))
      const runtimeCard = opened('Context · dsh-system-prompt')
      const skillCard = opened('Context · skill-catalog')
      assert.ok(runtimeCard > opened('how are you doing'),
        `an expanded card opens under its prompt:\n${expanded.join('\n')}`)
      assert.ok(skillCard > runtimeCard, `and keeps the log's order between cards:\n${expanded.join('\n')}`)
      assert.ok(opened('SANDBOX-POLICY') > runtimeCard,
        `each body renders under its own header:\n${expanded.join('\n')}`)
      const skillBody = opened('SKILL-CATALOG-BODY')
      assert.ok(skillBody > skillCard && skillBody < opened('ANSWER-TEXT'),
        `and still above the answer:\n${expanded.join('\n')}`)
      assert.ok(opened('Completed ') > opened('ANSWER-TEXT'),
        `and the step's timing breakdown trails the answer here:\n${expanded.join('\n')}`)

      // Ctrl+O again (hidden) takes context back off with the tool traffic.
      terminal.send('\x0f')
      await delay(SETTLE_MS)
      const hidden = terminal.text()
      assert.ok(!hidden.includes('Context ·'), `the hidden phase drops context too:\n${hidden}`)
      assert.ok(!hidden.includes('SANDBOX-POLICY'), `body and all:\n${hidden}`)
      assert.ok(hidden.includes('ANSWER-TEXT'), `while the conversation stays:\n${hidden}`)

      // And once more (collapsed) returns to the phase it opened on, where the
      // cards are still absent rather than folded to a row.
      terminal.send('\x0f')
      await delay(SETTLE_MS)
      const restored = terminal.text()
      assert.ok(!restored.includes('Context ·'), `collapsed shows no context card:\n${restored}`)
      assert.ok(!restored.includes('SKILL-CATALOG-BODY'), `and no body:\n${restored}`)
      assert.ok(restored.includes('how are you doing'), `the conversation is untouched:\n${restored}`)
    } finally {
      await disposeTuiTestHarness(harness)
      await terminal.dispose()
    }
  })

  it('drops tool cards on the hidden phase of the Ctrl+O cycle and restores them', async () => {
    const harness = await mount()
    try {
      appendUser(harness.session, 'list the files')
      appendToolStep(harness.session, 'call-2', 'ls', 'README.md')
      await delay(SETTLE_MS)

      // collapsed -> expanded -> hidden
      harness.terminal.send('\x0f')
      await delay(SETTLE_MS)
      harness.terminal.send('\x0f')
      await delay(SETTLE_MS)
      const hidden = harness.terminal.text()
      assert.ok(hidden.includes('Tool cards hidden.'), `the cycle reports its phase:\n${hidden}`)
      assert.ok(!hidden.includes('README.md'), `hidden drops the tool body:\n${hidden}`)
      // Hiding tool traffic keeps the conversation, which is the point of the phase.
      assert.ok(hidden.includes('list the files'), `hidden keeps the prompt:\n${hidden}`)
      assert.ok(hidden.includes('Running ls'), `hidden keeps the answer:\n${hidden}`)

      harness.terminal.send('\x0f')
      await delay(SETTLE_MS)
      const restored = harness.terminal.text()
      assert.ok(restored.includes('README.md'), `the card comes back collapsed:\n${restored}`)
    } finally {
      await unmount(harness)
    }
  })

  it('keeps a streamed step in place while it grows', async () => {
    const harness = await mount()
    try {
      const position = { turn: 1, step: 2 }
      harness.session.append('step/start', position)
      harness.session.append('assistant/chunk', { ...position, chunk: { type: 'text-delta', index: 0, text: 'one' } })
      await delay(SETTLE_MS)
      assert.ok(harness.terminal.text().includes('one'))

      harness.session.append('assistant/chunk', { ...position, chunk: { type: 'text-delta', index: 0, text: ' two' } })
      await delay(SETTLE_MS)
      const frame = harness.terminal.text()
      // One node per step: the second delta extends the same row rather than
      // appending a second assistant message.
      assert.ok(frame.includes('one two'), `deltas accumulate in place:\n${frame}`)
      assert.equal(frame.split('one').length - 1, 1, `the step renders once:\n${frame}`)
    } finally {
      await unmount(harness)
    }
  })

  it('hides history on /clear without losing later turns', async () => {
    const harness = await mount()
    try {
      appendUser(harness.session, 'first prompt')
      await delay(SETTLE_MS)
      assert.ok(harness.terminal.text().includes('first prompt'))

      harness.terminal.send('/clear')
      harness.terminal.send('\r')
      await delay(SETTLE_MS)
      assert.ok(!harness.terminal.text().includes('first prompt'), 'cleared rows stay off screen')

      appendUser(harness.session, 'second prompt')
      await delay(SETTLE_MS)
      const frame = harness.terminal.text()
      assert.ok(frame.includes('second prompt'), `later turns still render:\n${frame}`)
      // The session log is untouched, so the cleared rows must not reappear.
      assert.ok(!frame.includes('first prompt'), `cleared rows stay cleared:\n${frame}`)
    } finally {
      await unmount(harness)
    }
  })

  it('takes an open step\'s later tool cards with it on /clear', async () => {
    const harness = await mount()
    try {
      const position = { turn: 1, step: 2 }
      const callId = CallId('call-clear')
      appendUser(harness.session, 'old prompt')
      harness.session.append('step/start', position)
      harness.session.append('assistant/chunk', { ...position, chunk: { type: 'text-delta', index: 0, text: 'answering' } })
      await delay(SETTLE_MS)

      harness.terminal.send('/clear')
      harness.terminal.send('\r')
      await delay(SETTLE_MS)

      // The turn keeps running: its message settles and it requests a tool.
      appendToolTail(harness.session, position, callId)
      await delay(SETTLE_MS)
      const frame = harness.terminal.text()
      assert.ok(!frame.includes('old prompt'), `history stays cleared:\n${frame}`)
      assert.ok(!frame.includes('answering'), `the hidden step stays hidden:\n${frame}`)
      // The card folds below the cut, so only the step it belongs to keeps it
      // off screen; otherwise it would render with no message and no footer.
      assert.ok(!frame.includes('CARD-OUTPUT'), `its card is hidden with it:\n${frame}`)

      // A step that opens after the cut renders in full.
      const next = { turn: 1, step: 3 }
      harness.session.append('step/start', next)
      appendToolTail(harness.session, next, CallId('call-after'))
      await delay(SETTLE_MS)
      const after = harness.terminal.text()
      assert.ok(after.includes('CARD-OUTPUT'), `later steps render their cards:\n${after}`)
    } finally {
      await unmount(harness)
    }
  })

  it('keeps the open step\'s timing footer moving while its tool runs', async () => {
    // No seeded lifecycle: the only open step must be the one this drives, or a
    // stale seeded step would carry the animation and hide a frozen footer.
    const terminal = new HeadlessTerminal(100, 40)
    const harness = await createTuiTestHarness(terminal, () => {}, {
      cwd: '/workspace/project',
      omitInitialLifecycle: true,
      config: { title: 'DSH transcript', welcome: 'ready.', theme: { color: false, inputPrompt: INPUT_PROMPT } },
    })
    try {
      await delay(SETTLE_MS)
      const position = { turn: 1, step: 1 }
      const callId = CallId('call-slow')
      const args = JSON.stringify({ command: 'sleep' })
      setAgentStatus(harness.agent, 'running')
      harness.session.append('turn/start', { turn: 1 })
      harness.session.append('step/start', position)
      // The step's message settles, then its tool runs: `step/end` has not
      // landed, so this step is still open and still owns the live footer.
      appendAssistant(harness.session, [
        { type: 'text', text: 'working' },
        { type: 'tool-call', id: callId, name: 'bash', arguments: args },
      ], undefined, position)
      harness.session.append('tool/call', { ...position, callId, name: 'bash', arguments: args })
      await delay(SETTLE_MS)
      const footer = (): string | undefined =>
        terminal.text().split('\n').find(row => row.includes('Model wait'))?.trim()
      // The breakdown lives on the expanded phase now, so that is where a live
      // step's elapsed time has to keep moving.
      assert.equal(footer(), undefined, 'the default phase shows no per-step timing')
      terminal.send('\x0f')
      await delay(SETTLE_MS)
      const before = footer()
      await delay(700)
      const after = footer()
      assert.ok(before !== undefined, 'the open step renders a timing footer')
      assert.notEqual(after, before, `the footer keeps counting while the tool runs: ${String(before)}`)
    } finally {
      await disposeTuiTestHarness(harness)
      await terminal.dispose()
    }
  })

  it('shows a mid-answer submission where it was sent, and lands the logged message there', async () => {
    const harness = await mount()
    try {
      const position = { turn: 1, step: 2 }
      setAgentStatus(harness.agent, 'running')
      harness.session.append('step/start', position)
      harness.session.append('assistant/chunk', {
        ...position,
        chunk: { type: 'text-delta', index: 0, text: 'ANSWER-SO-FAR' },
      })
      await delay(SETTLE_MS)

      harness.terminal.send('STEER-PROMPT')
      harness.terminal.send('\r')
      await delay(SETTLE_MS)

      const rows = harness.terminal.text().split('\n').map(row => row.trimEnd())
      const answer = rows.findIndex(row => row.includes('ANSWER-SO-FAR'))
      const prompt = rows.findIndex(row => row.includes('STEER-PROMPT'))
      const badge = rows.findIndex(row => row.trim() === 'Steering')
      assert.ok(answer >= 0 && prompt > answer, `the submission is on screen at once:\n${rows.join('\n')}`)
      assert.ok(badge >= 0 && badge < prompt, `a mid-run prompt is badged:\n${rows.join('\n')}`)

      // The driver claims it at its next step boundary and the log records it —
      // long after the answer above it started rendering.
      const steered = harness.agent.steered[0]
      assert.ok(steered !== undefined, 'a running agent is steered, not queued')
      harness.session.append('user/message', steered, { surfaceOp: 'append' })
      await delay(SETTLE_MS)

      const after = harness.terminal.text()
      assert.equal(
        after.split('STEER-PROMPT').length - 1,
        1,
        `the logged message lands on the echo instead of repeating it:\n${after}`,
      )
      const settled = after.split('\n').map(row => row.trimEnd())
      assert.ok(
        settled.findIndex(row => row.includes('STEER-PROMPT'))
          > settled.findIndex(row => row.includes('ANSWER-SO-FAR')),
        `and keeps the position it was submitted at:\n${after}`,
      )
    } finally {
      await unmount(harness)
    }
  })

  it('withdraws a submission the inbox discarded', async () => {
    const harness = await mount()
    try {
      setAgentStatus(harness.agent, 'running')
      await delay(SETTLE_MS)
      harness.terminal.send('DISCARDED-PROMPT')
      harness.terminal.send('\r')
      await delay(SETTLE_MS)
      assert.match(harness.terminal.text(), /DISCARDED-PROMPT/)

      // Cancelling a turn clears the inbox, so this message is never recorded.
      harness.agent.inbox.clear()
      await delay(SETTLE_MS)
      const frame = harness.terminal.text()
      assert.ok(
        !frame.includes('DISCARDED-PROMPT'),
        `a prompt the model never saw must not stay on screen:\n${frame}`,
      )
    } finally {
      await unmount(harness)
    }
  })

  it('cycles the card phase once per physical Ctrl+O and keeps its confirmation off the transcript', async () => {
    const harness = await mount()
    try {
      appendUser(harness.session, 'list the files')
      appendToolStep(harness.session, 'call-kitty', 'ls', 'README.md')
      await delay(SETTLE_MS)
      const before = harness.terminal.text()

      // Under the Kitty keyboard protocol one physical Ctrl+O arrives as press,
      // repeat, and release — all three match `ctrl+o`.
      harness.terminal.send('\x1b[111;5u')
      harness.terminal.send('\x1b[111;5:2u')
      harness.terminal.send('\x1b[111;5:3u')
      await delay(SETTLE_MS)

      const cycled = harness.terminal.text()
      assert.ok(
        cycled.includes('Tool and context cards expanded.'),
        `one press advances exactly one phase:\n${cycled}`,
      )
      assert.ok(!cycled.includes('Tool cards hidden.'), `and not three:\n${cycled}`)

      // The confirmation is a transient status row, not a transcript node: it
      // clears itself and leaves the conversation exactly as it was. Compared
      // over a full round of the cycle, because a phase legitimately changes
      // what the transcript renders (the expanded phase adds the step's timing
      // breakdown) while the confirmation must change nothing at all.
      harness.terminal.send('\x0f')
      await delay(SETTLE_MS)
      harness.terminal.send('\x0f')
      await delay(1_700)
      const settled = harness.terminal.text()
      assert.ok(!settled.includes('Tool and context cards'), `the confirmation is transient:\n${settled}`)
      assert.match(settled, /list the files/)
      assert.equal(settled, before, `and adds no transcript row:\n${settled}`)
    } finally {
      await unmount(harness)
    }
  })

  it('flashes the notice the reconciler defines, for every phase of the cycle', async () => {
    const harness = await mount()
    try {
      appendUser(harness.session, 'list the files')
      appendToolStep(harness.session, 'call-kitty', 'ls', 'README.md')
      await delay(SETTLE_MS)
      // One sentence per phase, and it is the reconciler's — an entry point
      // holding its own copy is how the collapsed phase came to keep announcing
      // context cards it had stopped rendering.
      for (const phase of ['expanded', 'hidden', 'collapsed'] as const) {
        harness.terminal.send('\x0f')
        await delay(SETTLE_MS)
        const frame = harness.terminal.text()
        assert.ok(frame.includes(cardPhaseNotice(phase)), `the ${phase} phase flashes its own notice:\n${frame}`)
      }
    } finally {
      await unmount(harness)
    }
  })

  it('reports a failed turn once', async () => {
    const harness = await mount()
    try {
      harness.session.append('turn/end', {
        turn: 1,
        reason: { kind: 'error', error: { message: 'provider refused the request', code: 'transport' } },
      })
      await delay(SETTLE_MS)
      const frame = harness.terminal.text()
      const occurrences = frame.split('provider refused the request').length - 1
      assert.equal(occurrences, 1, `one failure row, not a live/durable pair:\n${frame}`)
    } finally {
      await unmount(harness)
    }
  })
})

/**
 * Workflow run blocks, end to end: the mounted TUI is driven by appending the
 * four `tool-workflow/*` records to its session, so these cases cover the whole
 * `session/event → fold → snapshot → reconciler → pi-tui` path.
 *
 * What the fold's own tests cannot see is exactly what is asserted here: which
 * of the three levels is on screen. That is decided by the run's state and by
 * the Ctrl+O phase, not by the log, so it only shows up in a frame.
 * @module dsh-tui/tests/unit/workflow
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { CallId, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import { WorkflowRunId } from '@deepseek-ai/dsh-workflow/types'
// The type import loads the `tool-workflow/*` SessionEventMap merge.
import type {} from '@deepseek-ai/dsh-tool-workflow/types'
import {
  appendAssistant,
  createTuiTestHarness,
  disposeTuiTestHarness,
  setAgentStatus,
  tuiEntryAvailable,
  type TuiHarness,
  type TuiHarnessOptions,
} from '../harness.ts'
import { HeadlessTerminal } from '../headless-terminal.ts'
import { WorkflowRunComponent } from '../../src/components/transcript.ts'
import { createPalette } from '../../src/components/theme.ts'
import type { WorkflowRunNode } from '../../src/core/types.ts'

/** `src/index.ts` is landed by a separate port; without it this suite cannot run. */
const entryAvailable = await tuiEntryAvailable()
const skipWithoutEntry = entryAvailable
  ? false
  : 'requires src/index.ts to export createTuiChat(ctx, config, runtime)'

/** The store publishes one snapshot per 16 ms frame; a test outwaits the batch. */
const SETTLE_MS = 60

/** Ctrl+O, the one key that cycles card phases (`app.tools.cycle`). */
const CTRL_O = '\x0f'

const RUN = WorkflowRunId('wf-1')

type Harness = TuiHarness<HeadlessTerminal, (code: number) => void>

async function mount(
  beforeMount?: (session: Session) => void,
  options: TuiHarnessOptions = {},
): Promise<Harness> {
  const terminal = new HeadlessTerminal(100, 40)
  const harness = await createTuiTestHarness(terminal, () => {}, {
    cwd: '/workspace/project',
    ...beforeMount === undefined ? {} : { beforeMount },
    ...options,
    config: { welcome: 'ready.', theme: { color: false, inputPrompt: 'dsh> ' }, ...options.config },
  })
  await delay(SETTLE_MS)
  return harness
}

async function unmount(harness: Harness): Promise<void> {
  await disposeTuiTestHarness(harness)
  await harness.terminal.dispose()
}

/** Open a run and publish two members of one phase. */
function startRun(session: Session): void {
  session.append('tool-workflow/run-start', { runId: RUN, name: 'release-check' })
  session.append('tool-workflow/agent-start', {
    runId: RUN,
    seq: 1,
    label: 'lint',
    phase: 'checks',
    childId: SessionId('child-1'),
  })
  session.append('tool-workflow/agent-start', {
    runId: RUN,
    seq: 2,
    label: 'tests',
    phase: 'checks',
    childId: SessionId('child-2'),
  })
}

/** Settle both members and the run itself, all clean. */
function settleRun(session: Session): void {
  session.append('tool-workflow/agent-end', { runId: RUN, seq: 1, outcome: 'completed' })
  session.append('tool-workflow/agent-end', { runId: RUN, seq: 2, outcome: 'completed' })
  session.append('tool-workflow/run-end', { runId: RUN, stopReason: 'completed' })
}

describe('WorkflowRunComponent', () => {
  const START = 1_700_000_000_000

  /** One run, rendered under a color-free palette at a fixed clock. */
  function rows(node: WorkflowRunNode, now = START + 90_000): string[] {
    const component = new WorkflowRunComponent(node, 'collapsed', createPalette(false), () => 'Ctrl+O', () => now)
    return component.render(100)
  }

  it('names an absent phase and an empty phase name apart', () => {
    const text = rows({
      kind: 'workflow-run',
      key: 'workflow:wf-1',
      version: 1,
      time: START,
      runId: 'wf-1',
      name: 'release-check',
      startedAt: START,
      members: [
        { seq: 1, label: 'deploy', childId: 'child-1', startedAt: START },
        { seq: 2, label: '', phase: '', childId: 'child-2', startedAt: START },
      ],
    }).join('\n')
    assert.match(text, /\(no phase\)/u, `a member with no phase at all is its own group:\n${text}`)
    assert.match(text, /\(unnamed phase\)/u, `and an empty phase name is another:\n${text}`)
    assert.match(text, /\(unnamed member\)/u, `an empty label still gets a readable row:\n${text}`)
  })

  it('names what got done beside what was interrupted', () => {
    // The mixed case is the one worth spelling out: "part of it finished, the
    // rest stopped" is invisible if the header reports only the interruption.
    const text = rows({
      kind: 'workflow-run',
      key: 'workflow:wf-1',
      version: 1,
      time: START,
      runId: 'wf-1',
      name: 'release-check',
      startedAt: START,
      endedAt: START + 60_000,
      members: [
        { seq: 1, label: 'lint', phase: 'checks', childId: 'child-1', startedAt: START, outcome: 'completed',
          endedAt: START + 12_000 },
        { seq: 2, label: 'tests', phase: 'checks', childId: 'child-2', startedAt: START },
      ],
    }).join('\n')
    assert.match(text, /completed 1/u, `the header counts what finished:\n${text}`)
    assert.match(text, /interrupted 1/u, `and what did not:\n${text}`)
    // A settled member freezes at the time the log recorded; the unsettled one
    // stops where the run did rather than following the render clock.
    assert.match(text, /lint · completed 12s/u, `a settled member keeps its own span:\n${text}`)
    assert.match(text, /tests · interrupted 1m 0s/u, `an unsettled one stops where the run did:\n${text}`)
  })
})

describe('workflow run rows', { skip: skipWithoutEntry }, () => {
  it('holds a live run open, then recedes to one row once it finishes clean', async () => {
    const harness = await mount()
    try {
      startRun(harness.session)
      await delay(SETTLE_MS)

      const live = harness.terminal.text()
      assert.match(live, /workflow release-check/u, `the run names itself while it is live:\n${live}`)
      assert.match(live, /2 members/u, `the run counts its members:\n${live}`)
      assert.match(live, /checks/u, `the phase gets a header of its own:\n${live}`)
      assert.match(live, /lint/u, `an unsettled member keeps its row:\n${live}`)
      assert.match(live, /tests/u, `every unsettled member keeps its row:\n${live}`)

      settleRun(harness.session)
      await delay(SETTLE_MS)

      const settled = harness.terminal.text()
      assert.match(settled, /workflow release-check/u, `the run still reports itself:\n${settled}`)
      assert.doesNotMatch(settled, /lint/u, `a clean run drops its member rows:\n${settled}`)
      assert.match(settled, /\(ctrl\+o to expand\)/u, `and offers the key that brings them back:\n${settled}`)
    } finally {
      await unmount(harness)
    }
  })

  it('opens every level on the expanded phase and keeps only the run row on the hidden one', async () => {
    const harness = await mount()
    try {
      startRun(harness.session)
      settleRun(harness.session)
      await delay(SETTLE_MS)

      harness.terminal.send(CTRL_O)
      await delay(SETTLE_MS)
      const expanded = harness.terminal.text()
      assert.match(expanded, /checks/u, `the expanded phase prints every phase:\n${expanded}`)
      assert.match(expanded, /lint/u, `and every member:\n${expanded}`)
      assert.match(expanded, /tests/u, `and every member:\n${expanded}`)
      assert.doesNotMatch(expanded, /to expand/u, `with no hint, being already open:\n${expanded}`)

      harness.terminal.send(CTRL_O)
      await delay(SETTLE_MS)
      const hidden = harness.terminal.text()
      // A run is conversation structure rather than tool noise, so the hidden
      // phase recesses it instead of removing it.
      assert.match(hidden, /workflow release-check/u, `the hidden phase keeps the run row:\n${hidden}`)
      assert.doesNotMatch(hidden, /checks/u, `and nothing under it:\n${hidden}`)
      assert.doesNotMatch(hidden, /to expand/u, `and no hint, one press from the collapsed phase:\n${hidden}`)
    } finally {
      await unmount(harness)
    }
  })

  it('keeps a failed member on screen after the run settles', async () => {
    const harness = await mount()
    try {
      startRun(harness.session)
      harness.session.append('tool-workflow/agent-end', { runId: RUN, seq: 1, outcome: 'completed' })
      harness.session.append('tool-workflow/agent-end', { runId: RUN, seq: 2, outcome: 'failed' })
      harness.session.append('tool-workflow/run-end', { runId: RUN, stopReason: 'error' })
      await delay(SETTLE_MS)

      const frame = harness.terminal.text()
      assert.match(frame, /failed/u, `the run reports the failure:\n${frame}`)
      assert.match(frame, /tests/u, `and the member that failed keeps its row:\n${frame}`)
      assert.match(frame, /completed 1/u, `alongside what did get done:\n${frame}`)
    } finally {
      await unmount(harness)
    }
  })

  it('reads a run whose turn ended without settling it as interrupted', async () => {
    const harness = await mount()
    try {
      startRun(harness.session)
      harness.session.append('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })
      await delay(SETTLE_MS)

      const frame = harness.terminal.text()
      assert.match(frame, /interrupted/u, `the run says why it stopped reporting:\n${frame}`)
      assert.match(frame, /lint/u, `and its unsettled members stay on screen:\n${frame}`)
    } finally {
      await unmount(harness)
    }
  })

  it('renders inside the step that called the tool, above that step\'s timing footer', async () => {
    // A run is logged between the workflow tool's card and whatever the same
    // step does next, and the step's timing footer belongs at the tail of that
    // step's output. A block that flushed the footer on its way in would print
    // the timing line mid-step, with the step's remaining cards below it.
    const terminal = new HeadlessTerminal(100, 40)
    const harness = await createTuiTestHarness(terminal, () => {}, {
      cwd: '/workspace/project',
      omitInitialLifecycle: true,
      config: { welcome: 'ready.', theme: { color: false, inputPrompt: 'dsh> ' } },
    })
    try {
      await delay(SETTLE_MS)
      const position = { turn: 1, step: 1 }
      const workflowCall = CallId('call-workflow')
      const bashCall = CallId('call-bash')
      const workflowArgs = JSON.stringify({ name: 'release-check' })
      const bashArgs = JSON.stringify({ command: 'npm test' })
      harness.session.append('turn/start', { turn: 1 })
      harness.session.append('step/start', position)
      appendAssistant(harness.session, [
        { type: 'text', text: 'orchestrating' },
        { type: 'tool-call', id: workflowCall, name: 'workflow', arguments: workflowArgs },
        { type: 'tool-call', id: bashCall, name: 'bash', arguments: bashArgs },
      ], undefined, position)
      harness.session.append('tool/call', {
        ...position,
        callId: workflowCall,
        name: 'workflow',
        arguments: workflowArgs,
      })
      startRun(harness.session)
      settleRun(harness.session)
      harness.session.append('tool/result', {
        ...position,
        message: createToolResultMessage({
          callId: workflowCall,
          content: [{ type: 'text', text: 'WORKFLOW-OUTPUT' }],
          isError: false,
        }),
      }, { surfaceOp: 'append' })
      harness.session.append('tool/call', { ...position, callId: bashCall, name: 'bash', arguments: bashArgs })
      harness.session.append('tool/result', {
        ...position,
        message: createToolResultMessage({
          callId: bashCall,
          content: [{ type: 'text', text: 'BASH-OUTPUT' }],
          isError: false,
        }),
      }, { surfaceOp: 'append' })
      harness.session.append('step/end', position)
      await delay(SETTLE_MS)
      // The breakdown lives on the expanded phase, so that is the only phase
      // where the footer's placement is observable at all.
      terminal.send(CTRL_O)
      await delay(SETTLE_MS)

      const frame = terminal.text()
      const rows = frame.split('\n')
      const at = (needle: string): number => rows.findIndex(row => row.includes(needle))
      const card = at('WORKFLOW-OUTPUT')
      const block = at('workflow release-check')
      const bash = at('BASH-OUTPUT')
      const footer = at('Model wait')
      assert.ok(card >= 0 && block >= 0 && bash >= 0 && footer >= 0, `every row of the step is on screen:\n${frame}`)
      assert.ok(card < block, `the run block follows the card that asked for it:\n${frame}`)
      assert.ok(block < bash, `and precedes what the same step did next:\n${frame}`)
      assert.ok(bash < footer, `the step's timing footer stays at the tail of its output:\n${frame}`)
    } finally {
      await disposeTuiTestHarness(harness)
      await terminal.dispose()
    }
  })

  it('keeps a live run\'s elapsed time moving between log events', async () => {
    // The block is a cached card, so its `running Ns` only moves when something
    // invalidates it. Nothing in the log does: the run's next event may be
    // minutes away, and the row a user watches to see the run is alive is
    // exactly the one that would freeze.
    // Started from the wall clock the session stamps its events with, so the
    // run's own `startedAt` and this terminal's clock measure the same span.
    let clock = Date.now()
    const harness = await mount(undefined, { now: () => clock })
    try {
      startRun(harness.session)
      // The animation tick belongs to a running turn, which is what a live run
      // implies: the workflow tool has not returned yet.
      setAgentStatus(harness.agent, 'running')
      await delay(SETTLE_MS)
      const runRow = (): string | undefined =>
        harness.terminal.text().split('\n').find(row => row.includes('workflow release-check'))?.trim()
      const before = runRow()
      assert.ok(before !== undefined, `the live run is on screen:\n${harness.terminal.text()}`)
      assert.match(before, /running/u, `and reports itself as running:\n${before}`)
      clock += 65_000
      await delay(400)
      const after = runRow()
      assert.notEqual(after, before, `the run row counts up with no new event: ${String(before)}`)
      assert.match(String(after), /running 1m \d+s/u, `by the clock the terminal was given: ${String(after)}`)
    } finally {
      await unmount(harness)
    }
  })

  it('folds a resumed log to the same block the live one reached', async () => {
    const harness = await mount((session) => {
      startRun(session)
      settleRun(session)
    })
    try {
      const frame = harness.terminal.text()
      assert.match(frame, /workflow release-check/u, `the replayed run reports itself:\n${frame}`)
      assert.match(frame, /2 members/u, `with its member count:\n${frame}`)
      assert.doesNotMatch(frame, /lint/u, `and the same clean-run collapse the live path reached:\n${frame}`)
    } finally {
      await unmount(harness)
    }
  })
})

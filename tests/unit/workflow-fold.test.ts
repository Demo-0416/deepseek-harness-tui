/**
 * Unit tests for the workflow-run fold and its derivations.
 *
 * Like `nodes.test.ts`, events go through a REAL session: the four
 * `tool-workflow/*` records are durable log entries, so their seqs and times
 * come from the same `Session.append` the workflow tool writes through, and the
 * interrupted reading — which is derived from a closing event's own time — is
 * exercised on the times the log actually holds.
 * @module dsh-tui/tests/unit/workflow-fold
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import { WorkflowRunId } from '@deepseek-ai/dsh-workflow/types'
// The type import loads the `tool-workflow/*` SessionEventMap merge the
// fixtures below append through.
import type {} from '@deepseek-ai/dsh-tool-workflow/types'
import { foldEvent, foldEvents } from '../../src/core/nodes.ts'
import {
  groupWorkflowPhases,
  workflowMemberStatus,
  workflowNeedsAttention,
  workflowRunStatus,
  workflowStatusCounts,
} from '../../src/core/workflow.ts'
import type { ChatNode, WorkflowRunNode } from '../../src/core/types.ts'

let sessionCounter = 0

/** Run `body` against a fresh, empty session and always dispose its context. */
async function withSession(body: (session: Session) => void | Promise<void>): Promise<void> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  sessionCounter += 1
  const session = ctx.sessions.create(SessionId(`workflow-${sessionCounter}`), { meta: { cwd: '/workspace' } })
  try {
    await body(session)
  } finally {
    await ctx.fiber.dispose()
  }
}

const RUN = WorkflowRunId('wf-1')

/** Open one run record. */
function runStart(session: Session, name = 'release-check', runId = RUN): void {
  session.append('tool-workflow/run-start', { runId, name })
}

/** Publish one member of a run. */
function agentStart(
  session: Session,
  seq: number,
  label: string,
  phase?: string,
  runId = RUN,
): void {
  session.append('tool-workflow/agent-start', {
    runId,
    seq,
    label,
    ...phase === undefined ? {} : { phase },
    childId: SessionId(`child-${seq}`),
  })
}

/** Settle one member of a run. */
function agentEnd(
  session: Session,
  seq: number,
  outcome: 'completed' | 'failed' | 'cancelled',
  runId = RUN,
): void {
  session.append('tool-workflow/agent-end', { runId, seq, outcome })
}

/** Settle one run. */
function runEnd(session: Session, stopReason: 'completed' | 'cancelled' | 'error', runId = RUN): void {
  session.append('tool-workflow/run-end', { runId, stopReason })
}

/** The single workflow node in a folded list. */
function onlyRun(nodes: readonly ChatNode[]): WorkflowRunNode {
  const runs = nodes.filter((node): node is WorkflowRunNode => node.kind === 'workflow-run')
  assert.equal(runs.length, 1, `expected exactly one workflow node, got ${runs.length}`)
  return runs[0] as WorkflowRunNode
}

describe('workflow fold', () => {
  it('opens one node per run, keyed by the run id', async () => {
    await withSession((session) => {
      runStart(session)
      const nodes = foldEvents(session.events)
      const node = onlyRun(nodes)
      assert.equal(node.key, 'workflow:wf-1')
      assert.equal(node.runId, 'wf-1')
      assert.equal(node.name, 'release-check')
      assert.deepEqual(node.members, [])
      assert.equal(node.startedAt, session.events[0]?.time)
      assert.equal(node.stopReason, undefined)
      assert.equal(node.endedAt, undefined)
      assert.equal(workflowRunStatus(node), 'running')
    })
  })

  it('keeps two concurrent runs apart', async () => {
    await withSession((session) => {
      const other = WorkflowRunId('wf-2')
      runStart(session)
      runStart(session, 'docs', other)
      agentStart(session, 1, 'lint')
      agentStart(session, 1, 'spellcheck', undefined, other)
      const nodes = foldEvents(session.events).filter((node) => node.kind === 'workflow-run')
      assert.equal(nodes.length, 2)
      assert.deepEqual(
        nodes.map((node) => (node as WorkflowRunNode).members.map((member) => member.label)),
        [['lint'], ['spellcheck']],
      )
    })
  })

  it('appends members in arrival order and keeps an absent phase distinct from an empty one', async () => {
    await withSession((session) => {
      runStart(session)
      agentStart(session, 1, 'lint', 'checks')
      agentStart(session, 2, 'tests', 'checks')
      agentStart(session, 3, 'deploy')
      agentStart(session, 4, 'notify', '')
      const node = onlyRun(foldEvents(session.events))
      assert.deepEqual(node.members.map((member) => member.label), ['lint', 'tests', 'deploy', 'notify'])
      assert.equal(node.members[2]?.phase, undefined)
      assert.equal(node.members[3]?.phase, '')
      assert.equal(node.members[0]?.childId, 'child-1')
      const phases = groupWorkflowPhases(node)
      // Groups come out in first-appearance order, and the two empty identities
      // are two groups rather than one.
      assert.deepEqual(phases.map((group) => group.phase), ['checks', undefined, ''])
      assert.deepEqual(phases[0]?.members.map((member) => member.label), ['lint', 'tests'])
      assert.deepEqual(phases[1]?.members.map((member) => member.label), ['deploy'])
      assert.deepEqual(phases[2]?.members.map((member) => member.label), ['notify'])
    })
  })

  it('settles a member by seq and leaves an unknown seq alone', async () => {
    await withSession((session) => {
      runStart(session)
      agentStart(session, 1, 'lint', 'checks')
      const nodes = foldEvents(session.events)
      const node = onlyRun(nodes)
      const before = node.version
      const settled = session.append('tool-workflow/agent-end', { runId: RUN, seq: 1, outcome: 'failed' })
      assert.equal(foldEvent(nodes, settled), true)
      assert.equal(node.members[0]?.outcome, 'failed')
      assert.equal(node.members[0]?.endedAt, settled.time)
      assert.ok(node.version > before, 'settling a member bumps the node version')
      assert.equal(workflowMemberStatus(node, node.members[0] as never), 'failed')

      const stale = node.version
      const unknown = session.append('tool-workflow/agent-end', { runId: RUN, seq: 9, outcome: 'completed' })
      assert.equal(foldEvent(nodes, unknown), false)
      assert.equal(node.members.length, 1)
      assert.equal(node.version, stale)
    })
  })

  it('maps every stop reason onto a run status', async () => {
    const expected: Record<string, string> = { completed: 'completed', cancelled: 'cancelled', error: 'failed' }
    for (const stopReason of ['completed', 'cancelled', 'error'] as const) {
      await withSession((session) => {
        runStart(session)
        runEnd(session, stopReason)
        const node = onlyRun(foldEvents(session.events))
        assert.equal(node.stopReason, stopReason)
        assert.equal(node.endedAt, session.events[1]?.time)
        assert.equal(workflowRunStatus(node), expected[stopReason])
      })
    }
  })

  it('reads a run the step closed over as interrupted, with its unsettled members', async () => {
    await withSession((session) => {
      runStart(session)
      agentStart(session, 1, 'lint', 'checks')
      agentStart(session, 2, 'tests', 'checks')
      agentEnd(session, 1, 'completed')
      const closing = session.append('step/end', { turn: 1, step: 1 })
      const node = onlyRun(foldEvents(session.events))
      assert.equal(node.stopReason, undefined, 'nothing settled the run itself')
      assert.equal(node.endedAt, closing.time, 'the closing event\'s own time, never a clock')
      assert.equal(workflowRunStatus(node), 'interrupted')
      // The settled member keeps its outcome; only the open one is interrupted.
      assert.equal(workflowMemberStatus(node, node.members[0] as never), 'completed')
      assert.equal(workflowMemberStatus(node, node.members[1] as never), 'interrupted')
      assert.deepEqual(workflowStatusCounts(node, node.members), {
        running: 0,
        completed: 1,
        failed: 0,
        cancelled: 0,
        interrupted: 1,
      })
      assert.equal(workflowNeedsAttention(node, node.members), true)
    })
  })

  it('closes an unsettled run on turn/end alone', async () => {
    await withSession((session) => {
      session.append('turn/start', { turn: 1 })
      runStart(session)
      agentStart(session, 1, 'lint')
      const closing = session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      const node = onlyRun(foldEvents(session.events))
      assert.equal(node.endedAt, closing.time)
      assert.equal(workflowRunStatus(node), 'interrupted')
    })
  })

  it('closes a run left open by a dead process when the next turn starts', async () => {
    await withSession((session) => {
      runStart(session)
      agentStart(session, 1, 'lint')
      const next = session.append('turn/start', { turn: 2 })
      const node = onlyRun(foldEvents(session.events))
      assert.equal(node.endedAt, next.time)
      assert.equal(workflowRunStatus(node), 'interrupted')
    })
  })

  it('leaves a settled run untouched when the step around it closes', async () => {
    await withSession((session) => {
      runStart(session)
      agentStart(session, 1, 'lint')
      agentEnd(session, 1, 'completed')
      runEnd(session, 'completed')
      const nodes = foldEvents(session.events)
      const node = onlyRun(nodes)
      const settledAt = node.endedAt
      const version = node.version
      foldEvent(nodes, session.append('step/end', { turn: 1, step: 1 }))
      assert.equal(node.endedAt, settledAt, 'the run keeps the time it settled itself')
      assert.equal(node.version, version)
      assert.equal(workflowRunStatus(node), 'completed')
      assert.equal(workflowNeedsAttention(node, node.members), false)
    })
  })

  it('ignores members and ends whose run never opened', async () => {
    await withSession((session) => {
      const nodes: ChatNode[] = []
      assert.equal(
        foldEvent(nodes, session.append('tool-workflow/agent-start', {
          runId: RUN,
          seq: 1,
          label: 'lint',
          childId: SessionId('child-1'),
        })),
        false,
      )
      assert.equal(
        foldEvent(nodes, session.append('tool-workflow/agent-end', { runId: RUN, seq: 1, outcome: 'completed' })),
        false,
      )
      assert.equal(
        foldEvent(nodes, session.append('tool-workflow/run-end', { runId: RUN, stopReason: 'completed' })),
        false,
      )
      assert.deepEqual(nodes, [])
    })
  })

  it('folds the same nodes live and on replay, interruption included', async () => {
    await withSession((session) => {
      session.append('turn/start', { turn: 1 })
      runStart(session)
      agentStart(session, 1, 'lint', 'checks')
      agentStart(session, 2, 'tests', 'checks')
      agentEnd(session, 1, 'completed')
      session.append('step/end', { turn: 1, step: 1 })
      session.append('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })

      const live: ChatNode[] = []
      for (const event of session.events) foldEvent(live, event)
      const replayed = foldEvents(session.events)
      assert.deepEqual(replayed, live)
      assert.equal(workflowRunStatus(onlyRun(replayed)), 'interrupted')
    })
  })
})

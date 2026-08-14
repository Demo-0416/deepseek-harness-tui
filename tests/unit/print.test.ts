/**
 * `--print`: one task, one answer on stdout, no terminal.
 *
 * The cases here drive the runner against a scripted agent rather than a model,
 * because what is being checked is not what a model says: it is which interval
 * of the log the answer is read from, what the exit code says about the turn,
 * and that a run with nobody to ask never leaves a tool call waiting for a
 * human who is not there.
 * @module dsh-tui/tests/unit/print
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { createMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { runPrintTask, startPrintRun, summarizePrintRun, type PrintIo } from '../../src/print.ts'

/** Everything one run wrote and asked for. */
interface CapturedIo extends PrintIo {
  readonly out: string[]
  readonly err: string[]
  readonly codes: number[]
}

function captureIo(): CapturedIo {
  const out: string[] = []
  const err: string[] = []
  const codes: number[] = []
  return {
    out,
    err,
    codes,
    stdout: { write: (chunk: string) => out.push(chunk) },
    stderr: { write: (chunk: string) => err.push(chunk) },
    exit: (code: number) => { codes.push(code) },
  }
}

/** Append one assistant message to a session, as the loop records one. */
function answer(session: Session, text: string, turn = 1): void {
  session.append('assistant/message', {
    turn,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text }],
      source: { kind: 'model', provider: 'mock', model: 'deepseek-v4-flash' },
    }),
  }, { surfaceOp: 'append' })
}

/** How a scripted agent answers the task it is handed. */
type Script = (session: Session) => void

/**
 * A driverless agent whose whole turn is one scripted append.
 *
 * The runner only ever asks this for quiescence, the session, and delivery, so
 * the script stands in for the loop: it writes the turn the runner then reads
 * back out of the log, which is where a real run's answer also comes from.
 * @param session - the session the run owns.
 * @param script - what the delivered task produces.
 * @returns the handle the runner opens.
 */
function scriptedAgent(session: Session, script: Script): AgentHandle {
  const agent = {
    id: session.id,
    session,
    whenIdle: () => Promise.resolve(),
    followup: () => { script(session) },
  } as unknown as Agent
  return { agent, dispose: () => Promise.resolve() }
}

/**
 * A context with a real session store and one session in it.
 * @param id - the session id.
 * @returns the context and the live session.
 */
async function world(id: string): Promise<{ ctx: Context; session: Session }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const session = ctx.sessions.create(SessionId(id), { meta: { cwd: '/workspace' } })
  return { ctx, session }
}

describe('print run summary', () => {
  it('takes the last non-empty assistant text of the interval it owns', async () => {
    const { ctx, session } = await world('summary-session')
    // History from a resumed session: the answer to THIS task starts later.
    session.append('turn/start', { turn: 1 })
    answer(session, 'an older answer')
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const firstSeq = session.seq
    session.append('turn/start', { turn: 2 })
    answer(session, 'the first half', 2)
    answer(session, '', 2)
    answer(session, 'the answer', 2)
    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })

    const outcome = summarizePrintRun(session.events, firstSeq)
    assert.equal(outcome.text, 'the answer')
    assert.deepEqual(outcome.reason, { kind: 'completed' })
    await ctx.fiber.dispose()
  })

  it('reports no reason at all when no turn ended inside the interval', async () => {
    const { ctx, session } = await world('unfinished-session')
    session.append('turn/start', { turn: 1 })
    answer(session, 'streamed, never closed')
    assert.deepEqual(summarizePrintRun(session.events, 0), { text: 'streamed, never closed', reason: undefined })
    await ctx.fiber.dispose()
  })
})

describe('--print', () => {
  it('writes the answer on stdout and exits 0 on a completed turn', async () => {
    const { ctx, session } = await world('print-session')
    const io = captureIo()
    await runPrintTask(ctx, 'run the tests', {
      openAgent: () => Promise.resolve(scriptedAgent(session, (target) => {
        target.append('turn/start', { turn: 1 })
        answer(target, 'the tests pass')
        target.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      })),
    }, io)

    assert.deepEqual(io.out, ['the tests pass\n'])
    assert.deepEqual(io.err, [])
    assert.deepEqual(io.codes, [0])
    await ctx.fiber.dispose()
  })

  it('pins approvals to never before the task is delivered', async () => {
    const { ctx, session } = await world('policy-session')
    const io = captureIo()
    const seen: string[] = []
    await runPrintTask(ctx, 'delete everything', {
      openAgent: () => Promise.resolve(scriptedAgent(session, (target) => {
        seen.push(...target.events.map(event => event.type))
        target.append('turn/start', { turn: 1 })
        answer(target, 'refused')
        target.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      })),
    }, io)

    // A one-shot run has no surface to ask a human on. `never` is stated once,
    // in the system prompt, instead of every tool call resolving fail-closed
    // and telling the model a channel exists but does not work.
    assert.deepEqual(seen, ['approval/policy'])
    const policy = session.events.find(event => event.type === 'approval/policy')
    assert.deepEqual(policy?.data, { policy: 'never' })
    await ctx.fiber.dispose()
  })

  it('reports a failed turn on stderr and exits 1', async () => {
    const { ctx, session } = await world('failed-session')
    const io = captureIo()
    await runPrintTask(ctx, 'run the tests', {
      openAgent: () => Promise.resolve(scriptedAgent(session, (target) => {
        target.append('turn/start', { turn: 1 })
        answer(target, 'partial answer')
        target.append('turn/end', {
          turn: 1,
          reason: { kind: 'error', error: { code: 'PROVIDER_ERROR', message: 'upstream refused' } },
        })
      })),
    }, io)

    // The partial answer still goes to stdout: a caller piping the run gets
    // whatever the model did produce, and the verdict on the other stream.
    assert.deepEqual(io.out, ['partial answer\n'])
    assert.deepEqual(io.err, ['dsh-tui: PROVIDER_ERROR: upstream refused\n'])
    assert.deepEqual(io.codes, [1])
    await ctx.fiber.dispose()
  })

  it('exits 1 when the turn was cancelled rather than completed', async () => {
    const { ctx, session } = await world('aborted-session')
    const io = captureIo()
    await runPrintTask(ctx, 'run the tests', {
      openAgent: () => Promise.resolve(scriptedAgent(session, (target) => {
        target.append('turn/start', { turn: 1 })
        target.append('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })
      })),
    }, io)

    assert.deepEqual(io.out, ['\n'])
    assert.deepEqual(io.codes, [1])
    await ctx.fiber.dispose()
  })

  it('crosses the durability barrier before reading the log back', async () => {
    const { ctx, session } = await world('flush-session')
    const io = captureIo()
    const flushed: string[] = []
    const offFlush = ctx.on('session/flush', (target: Session) => { flushed.push(target.id) })
    await runPrintTask(ctx, 'run the tests', {
      openAgent: () => Promise.resolve(scriptedAgent(session, (target) => {
        target.append('turn/start', { turn: 1 })
        answer(target, 'done')
        target.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      })),
    }, io)

    assert.deepEqual(flushed, ['flush-session'])
    offFlush()
    await ctx.fiber.dispose()
  })

  it('reports a run that could not open its session, instead of exiting silently', async () => {
    const { ctx } = await world('unopened-session')
    const io = captureIo()
    startPrintRun(ctx, 'run the tests', {
      openAgent: () => Promise.reject(new Error('no persisted session for this workspace')),
    }, io)
    // The rejection settles on a later microtask; the run owns its own failure
    // reporting, so nothing here may be an unhandled rejection.
    await new Promise(resolve => setTimeout(resolve, 10))

    assert.deepEqual(io.out, [])
    assert.match(io.err[0] ?? '', /no persisted session for this workspace/u)
    assert.deepEqual(io.codes, [1])
    await ctx.fiber.dispose()
  })
})

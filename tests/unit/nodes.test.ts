/**
 * Unit tests for the event-to-node fold.
 *
 * Events are appended to a REAL session rather than hand-built literals: the
 * fold's contract is "whatever the durable log holds", so seqs, times, and
 * surface metadata come from the same `Session.append` production writes
 * through — including its replacement validation, which is what makes the
 * compaction cases meaningful.
 * @module dsh-tui/tests/unit/nodes
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import {
  CallId,
  createMessage,
  createToolResultMessage,
  createUserMessage,
  type ContentBlock,
  type UserMessage,
} from '@deepseek-ai/dsh-llm'
import { compactCheckpointSource, CompactionId } from '@deepseek-ai/dsh-compaction'
import { RetryId } from '@deepseek-ai/dsh-llm-retry'
// Type imports load the session-event and message-source declaration merges the
// fixtures below use (`llm/retry`, `compaction/*`, `session-reference`).
import type {} from '@deepseek-ai/dsh-session-reference'
import {
  appendOptimisticUserMessage,
  foldEvent,
  foldEvents,
  withdrawOptimisticUserMessage,
} from '../../src/core/nodes.ts'
import type { ChatNode } from '../../src/core/types.ts'

let sessionCounter = 0

/** A real, empty session plus the context that owns it. */
async function openSession(): Promise<{ ctx: Context; session: Session }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  sessionCounter += 1
  const session = ctx.sessions.create(SessionId(`fold-${sessionCounter}`), { meta: { cwd: '/workspace' } })
  return { ctx, session }
}

/** Run `body` against a fresh session and always dispose its context. */
async function withSession(body: (session: Session) => void | Promise<void>): Promise<void> {
  const { ctx, session } = await openSession()
  try {
    await body(session)
  } finally {
    await ctx.fiber.dispose()
  }
}

/** Assert a node exists at `index` and carries `kind`, then narrow it. */
function nodeOf<K extends ChatNode['kind']>(
  nodes: readonly ChatNode[],
  index: number,
  kind: K,
): Extract<ChatNode, { kind: K }> {
  const node = nodes[index]
  assert.ok(node !== undefined, `expected a node at index ${index}, got ${nodes.length} nodes`)
  assert.equal(node.kind, kind, `expected node ${index} to be ${kind}, got ${node.kind}`)
  return node as Extract<ChatNode, { kind: K }>
}

/** The rendered node kinds, for order assertions. */
function kinds(nodes: readonly ChatNode[]): string[] {
  return nodes.map(node => node.kind)
}

/** Append a plain human prompt. */
function appendUser(session: Session, text: string): SessionEvent {
  return session.append(
    'user/message',
    createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
    { surfaceOp: 'append' },
  )
}

/** Append an already-built prompt, the way a claimed inbox message is logged. */
function appendUserMessage(session: Session, message: UserMessage): SessionEvent {
  return session.append('user/message', message, { surfaceOp: 'append' })
}

/** One prompt exactly as the terminal hands it to the agent. */
function submission(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

/** Append a settled assistant message for one step. */
function appendAssistant(
  session: Session,
  content: ContentBlock[],
  position = { turn: 1, step: 1 },
): SessionEvent {
  return session.append('assistant/message', {
    ...position,
    message: createMessage({
      role: 'assistant',
      content,
      source: { kind: 'model', provider: 'mock', model: 'test-model' },
    }),
    usage: { inputTokens: 100, outputTokens: 50 },
  }, { surfaceOp: 'append' })
}

describe('foldEvent', () => {
  it('folds a typed prompt into a node keyed by its message id', async () => {
    await withSession((session) => {
      const message = submission('hello')
      appendUserMessage(session, message)
      const nodes = foldEvents(session.events)
      assert.equal(nodes.length, 1)
      const node = nodeOf(nodes, 0, 'user-message')
      assert.equal(node.text, 'hello')
      assert.equal(node.source, 'user')
      // The MessageId, not the log position: it is the identity the terminal's
      // optimistic echo shares with the event that records the same message.
      assert.equal(node.key, `user:${message.id}`)
      assert.equal(node.optimistic, undefined)
    })
  })

  it('keys a user message by its log position when it carries no id', () => {
    // A durable/replay boundary: a foreign or truncated log entry still has to
    // key stably, so the fold falls back to the event's own position.
    const nodes: ChatNode[] = []
    const event = {
      type: 'user/message',
      seq: 7,
      time: 1,
      surfaceOp: 'append',
      data: { role: 'user', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } },
    } as unknown as SessionEvent
    assert.equal(foldEvent(nodes, event), true)
    assert.equal(nodeOf(nodes, 0, 'user-message').key, 'user:7')
  })

  it('separates injected context from a human turn', async () => {
    await withSession((session) => {
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: '<workspace-context>\nrepo notes\n</workspace-context>' }],
        source: { kind: 'plugin', plugin: 'workspace-context', form: 'instructions' },
      }), { surfaceOp: 'append' })
      const node = nodeOf(foldEvents(session.events), 0, 'context')
      assert.equal(node.label, 'workspace-context')
      assert.match(node.text, /repo notes/)
    })
  })

  it('renders a session-reference attachment as its label list', async () => {
    await withSession((session) => {
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'referenced conversation' }],
        source: {
          kind: 'session-reference',
          form: 'recall',
          version: 1,
          references: [{
            sessionId: 'session-7',
            label: 'earlier work',
            capturedThroughSeq: null,
            compacted: false,
            originalMessages: 2,
            retainedMessages: 2,
            omittedMessages: 0,
            omittedBytes: 0,
            truncated: false,
            inputIndex: 0,
          }],
        },
      }), { surfaceOp: 'append' })
      const node = nodeOf(foldEvents(session.events), 0, 'reference')
      assert.deepEqual(node.labels, ['earlier work (session-7)'])
    })
  })

  it('folds streaming chunks into one node per step', async () => {
    await withSession((session) => {
      session.append('step/start', { turn: 1, step: 1 })
      session.append('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'block-start', index: 0, blockType: 'text' } })
      session.append('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'Hello' } })
      session.append('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: ' world' } })
      session.append('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 1, text: 'thinking' } })
      const nodes = foldEvents(session.events)
      assert.equal(nodes.length, 1)
      const node = nodeOf(nodes, 0, 'assistant')
      assert.equal(node.key, 'assistant:1:1')
      assert.equal(node.text, 'Hello world')
      assert.equal(node.reasoning, 'thinking')
      assert.equal(node.status, 'running')
      assert.equal(node.settled, false)
      // Every delta is one in-place change, so the reconciler re-renders once.
      assert.equal(node.version, 3)
    })
  })

  it('settles the step on assistant/message and pins it on step/end', async () => {
    await withSession((session) => {
      session.append('step/start', { turn: 1, step: 1 })
      session.append('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'partial' } })
      appendAssistant(session, [{ type: 'text', text: 'final answer' }])
      const end = session.append('step/end', { turn: 1, step: 1 })
      const nodes = foldEvents(session.events)
      assert.equal(nodes.length, 1)
      const node = nodeOf(nodes, 0, 'assistant')
      assert.equal(node.text, 'final answer')
      assert.equal(node.settled, true)
      assert.equal(node.status, 'complete')
      assert.equal(node.completedAt, end.time)
      assert.deepEqual(node.usage, { inputTokens: 100, outputTokens: 50 })
    })
  })

  it('pairs a tool call with its result and parses its arguments', async () => {
    await withSession((session) => {
      const callId = CallId('call-1')
      session.append('step/start', { turn: 1, step: 1 })
      appendAssistant(session, [{ type: 'tool-call', id: callId, name: 'bash', arguments: '{"command":"ls"}' }])
      session.append('tool/call', {
        turn: 1,
        step: 1,
        callId,
        name: 'bash',
        arguments: '{"command":"ls"}',
      })
      const nodes = foldEvents(session.events)
      assert.deepEqual(kinds(nodes), ['assistant', 'tool-call'])
      const assistant = nodeOf(nodes, 0, 'assistant')
      assert.deepEqual(assistant.toolCalls, ['call-1'])
      const tool = nodeOf(nodes, 1, 'tool-call')
      assert.equal(tool.key, 'tool:call-1')
      assert.equal(tool.name, 'bash')
      assert.equal(tool.argsComplete, true)
      assert.deepEqual(tool.args, { value: { command: 'ls' }, valid: true })
      assert.equal(tool.status, 'running')

      session.append('tool/result', {
        turn: 1,
        step: 1,
        message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'file1.txt' }], isError: false }),
      }, { surfaceOp: 'append' })
      const settled = nodeOf(foldEvents(session.events), 1, 'tool-call')
      assert.equal(settled.status, 'complete')
      assert.equal(settled.result?.isError, false)
      assert.equal(settled.result?.text, 'file1.txt')
      assert.deepEqual(settled.result?.content, [{ type: 'text', text: 'file1.txt' }])
    })
  })

  it('leaves a card unrendered while its arguments still stream', async () => {
    await withSession((session) => {
      session.append('step/start', { turn: 1, step: 1 })
      session.append('assistant/chunk', {
        turn: 1,
        step: 1,
        chunk: { type: 'tool-call-delta', index: 0, id: CallId('call-2'), name: 'read', argumentsDelta: '{"path":' },
      })
      const nodes = foldEvents(session.events)
      const tool = nodeOf(nodes, 1, 'tool-call')
      assert.equal(tool.name, 'read')
      assert.equal(tool.argsComplete, false)
      assert.equal(tool.args.valid, false)
      // The step advertises the call even before its arguments complete.
      assert.deepEqual(nodeOf(nodes, 0, 'assistant').toolCalls, ['call-2'])
    })
  })

  it('builds a fallback card for an orphan tool result', async () => {
    await withSession((session) => {
      const callId = CallId('orphan-1')
      session.append('tool/result', {
        turn: 4,
        step: 2,
        message: createToolResultMessage({
          callId,
          content: [{ type: 'text', text: 'boom' }],
          isError: true,
        }),
        error: { name: 'ToolError', code: 'EFAIL' },
      }, { surfaceOp: 'append' })
      const nodes = foldEvents(session.events)
      assert.equal(nodes.length, 1)
      const tool = nodeOf(nodes, 0, 'tool-call')
      assert.equal(tool.key, 'tool:orphan-1')
      assert.equal(tool.name, 'tool')
      assert.equal(tool.argsComplete, true)
      assert.equal(tool.status, 'error')
      assert.equal(tool.result?.text, 'EFAIL: boom')
      assert.equal(tool.result?.isError, true)
    })
  })

  it('withdraws a retried step and reports the retry once', async () => {
    await withSession((session) => {
      session.append('step/start', { turn: 1, step: 1 })
      session.append('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'half a se' } })
      session.append('llm/retry', {
        retryId: RetryId('retry-1'),
        turn: 1,
        step: 1,
        provider: 'mock',
        mode: 'normal',
        policyKey: 'default',
        retry: 1,
        maxRetries: 3,
        delayMs: 250,
        failure: { message: 'stream closed', code: 'transport' },
      })
      const nodes = foldEvents(session.events)
      assert.deepEqual(kinds(nodes), ['assistant', 'notice'])
      const step = nodeOf(nodes, 0, 'assistant')
      assert.equal(step.text, '')
      assert.equal(step.status, 'running')
      const notice = nodeOf(nodes, 1, 'notice')
      assert.equal(notice.tone, 'warning')
      assert.equal(notice.text, 'Retrying model request (1/3) in 250ms: stream closed')

      // The retried attempt refills the same step node rather than a new one.
      session.append('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'complete answer' } })
      const retried = foldEvents(session.events)
      assert.deepEqual(kinds(retried), ['assistant', 'notice'])
      assert.equal(nodeOf(retried, 0, 'assistant').text, 'complete answer')
    })
  })

  it('marks the compaction boundary only once its replacement lands', async () => {
    await withSession((session) => {
      const compactionId = CompactionId('compact-1')
      const first = appendUser(session, 'first prompt')
      const second = appendAssistant(session, [{ type: 'text', text: 'first answer' }])
      session.append('compaction/start', { compactionId, turn: null })
      // An open compaction contributes no row: the conversation it will replace
      // is still exactly what the user sees.
      assert.deepEqual(kinds(foldEvents(session.events)), ['user-message', 'assistant', 'compaction'])
      assert.equal(nodeOf(foldEvents(session.events), 2, 'compaction').landed, false)

      session.append('compaction/summary', {
        compactionId,
        summary: [{ type: 'text', text: 'they said hello' }],
        shadowedRange: { start: first.seq, end: second.seq },
        shadowedSeqs: [first.seq, second.seq],
        shadowedTokenCount: 42,
        provider: 'mock',
        model: 'test-model',
      })
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'summary of earlier conversation' }],
        source: compactCheckpointSource(compactionId),
      }), {
        surfaceOp: { op: 'replace', start: first.seq, end: second.seq },
        sourceEventSeqs: [first.seq, second.seq],
      })
      session.append('compaction/end', { compactionId, turn: null })

      const nodes = foldEvents(session.events)
      // The replaced conversation stays rendered; the checkpoint adds a marker
      // rather than a second user turn.
      assert.deepEqual(kinds(nodes), ['user-message', 'assistant', 'compaction'])
      const marker = nodeOf(nodes, 2, 'compaction')
      assert.equal(marker.landed, true)
      assert.equal(marker.summary, 'they said hello')
    })
  })

  it('reports a failed compaction as a notice', async () => {
    await withSession((session) => {
      const compactionId = CompactionId('compact-2')
      session.append('compaction/start', { compactionId, turn: null })
      session.append('compaction/end', { compactionId, turn: null, error: 'summary request failed' })
      const nodes = foldEvents(session.events)
      assert.deepEqual(kinds(nodes), ['compaction', 'notice'])
      assert.equal(nodeOf(nodes, 0, 'compaction').landed, false)
      assert.equal(nodeOf(nodes, 1, 'notice').text, 'Compaction failed: summary request failed')
    })
  })

  it('closes the open step and reports why the turn ended', async () => {
    await withSession((session) => {
      session.append('turn/start', { turn: 1 })
      session.append('step/start', { turn: 1, step: 1 })
      session.append('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'partial' } })
      const end = session.append('turn/end', {
        turn: 1,
        reason: { kind: 'error', error: { message: 'boom', code: 'transport' } },
      })
      const nodes = foldEvents(session.events)
      assert.deepEqual(kinds(nodes), ['assistant', 'notice'])
      const step = nodeOf(nodes, 0, 'assistant')
      // The partial answer stays on screen, marked as the failure it ended in.
      assert.equal(step.text, 'partial')
      assert.equal(step.status, 'error')
      assert.equal(step.completedAt, end.time)
      const notice = nodeOf(nodes, 1, 'notice')
      assert.equal(notice.tone, 'error')
      assert.equal(notice.text, 'boom')
    })
  })

  it('states a repeated outcome once', async () => {
    await withSession((session) => {
      session.append('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })
      session.append('turn/end', { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } })
      const nodes = foldEvents(session.events)
      assert.deepEqual(kinds(nodes), ['notice'])
      assert.equal(nodeOf(nodes, 0, 'notice').text, 'Turn cancelled.')
    })
  })

  it('keeps the plan strip as one node the next turn clears', async () => {
    await withSession((session) => {
      session.append('todo/write', { todos: [{ content: 'task 1', status: 'in_progress' }] })
      session.append('todo/write', {
        todos: [
          { content: 'task 1', status: 'completed' },
          { content: 'task 2', status: 'pending' },
        ],
      })
      const written = foldEvents(session.events)
      assert.equal(written.length, 1)
      const todo = nodeOf(written, 0, 'todo')
      assert.equal(todo.key, 'todo')
      assert.equal(todo.todos.length, 2)

      session.append('turn/start', { turn: 2 })
      assert.deepEqual(nodeOf(foldEvents(session.events), 0, 'todo').todos, [])
    })
  })

  it('keeps a turn in log order: the prompt, its context, then the step that used them', async () => {
    // Replay of session-85d19568 (`how are you doing`), whose log opens the step
    // BEFORE recording the claimed prompt and the two context snapshots the
    // request was assembled from. Opening the step's node on `step/start` put it
    // above all three, so the runtime-context and skill-catalog cards rendered
    // under the answer and its timing footer instead of above it.
    await withSession((session) => {
      session.append('turn/start', { turn: 1 })
      session.append('step/start', { turn: 1, step: 1 })
      appendUser(session, 'how are you doing')
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'Current runtime context. This snapshot supersedes earlier snapshots.' }],
        source: {
          kind: 'plugin',
          plugin: '@deepseek-ai/dsh-system-prompt',
          form: 'snapshot',
          sections: [{ name: 'sandbox:policy', text: 'Current DSH file policy: workspace-write.' }],
        },
      }), { surfaceOp: 'append' })
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: '<system-reminder>\nskills\n</system-reminder>' }],
        // The recorded kind of the skill service this log came from. Message
        // sources are a merge-extensible durable boundary, so the fold reads
        // them without narrowing — and this checkout declares no such kind.
        source: { kind: 'skill-catalog', form: 'catalog' } as never,
      }), { surfaceOp: 'append' })
      session.append('assistant/chunk', {
        turn: 1,
        step: 1,
        chunk: { type: 'block-start', index: 0, blockType: 'text' },
      })
      session.append('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'doing well' } })
      session.append('step/end', { turn: 1, step: 1 })

      const nodes = foldEvents(session.events)
      assert.deepEqual(kinds(nodes), ['user-message', 'context', 'context', 'assistant'])
      assert.equal(nodeOf(nodes, 1, 'context').label, '@deepseek-ai/dsh-system-prompt')
      assert.equal(nodeOf(nodes, 2, 'context').label, 'skill-catalog')
      assert.equal(nodeOf(nodes, 3, 'assistant').text, 'doing well')
    })
  })

  it('opens a step\'s node at its first content, not at step/start', async () => {
    await withSession((session) => {
      // `step/start` alone shows nothing: a step with no output yet has no row,
      // and a node here would anchor every later message below it.
      assert.equal(foldEvent([], session.append('step/start', { turn: 1, step: 1 })), false)
      // Nor does a chunk that carries no content of its own.
      const nodes: ChatNode[] = []
      assert.equal(foldEvent(nodes, session.append('assistant/chunk', {
        turn: 1,
        step: 1,
        chunk: { type: 'block-start', index: 0, blockType: 'text' },
      })), false)
      assert.deepEqual(nodes, [])
      // A step that produces nothing at all still gets its footer when it ends.
      assert.equal(foldEvent(nodes, session.append('step/end', { turn: 1, step: 1 })), true)
      assert.deepEqual(kinds(nodes), ['assistant'])
    })
  })

  it('ignores a replacement that marks no conversation boundary', async () => {
    await withSession((session) => {
      const prompt = appendUser(session, 'first prompt')
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'rewritten prompt' }],
        source: { kind: 'plugin', plugin: 'rewriter' },
      }), {
        surfaceOp: { op: 'replace', start: prompt.seq, end: prompt.seq },
        sourceEventSeqs: [prompt.seq],
      })
      const nodes = foldEvents(session.events)
      assert.deepEqual(kinds(nodes), ['user-message'])
      assert.equal(nodeOf(nodes, 0, 'user-message').text, 'first prompt')
    })
  })
})

describe('appendOptimisticUserMessage', () => {
  it('shows a submission before the log records it, and lands it in place', async () => {
    await withSession((session) => {
      // A turn is already answering when the user submits again.
      session.append('step/start', { turn: 1, step: 1 })
      session.append('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'answering' } })
      const nodes = foldEvents(session.events)
      const message = submission('and also fix the lint')

      assert.equal(appendOptimisticUserMessage(nodes, message, 'steering'), true)
      assert.deepEqual(kinds(nodes), ['assistant', 'user-message'])
      const echo = nodeOf(nodes, 1, 'user-message')
      assert.equal(echo.text, 'and also fix the lint')
      assert.equal(echo.source, 'steering')
      assert.equal(echo.optimistic, true)

      // The driver claims it at its next step boundary, well after the answer
      // above it started streaming.
      session.append('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: ' more' } })
      foldEvent(nodes, session.events[session.events.length - 1]!)
      const claimed = appendUserMessage(session, message)
      assert.equal(foldEvent(nodes, claimed), true)

      // One node, still where the submission happened — not appended below the
      // answer it interrupted.
      assert.deepEqual(kinds(nodes), ['assistant', 'user-message'])
      const landed = nodeOf(nodes, 1, 'user-message')
      assert.equal(landed.key, echo.key)
      assert.equal(landed.text, 'and also fix the lint')
      assert.equal(landed.time, claimed.time)
      assert.equal(landed.optimistic, undefined)
      // rc.6 logs steering as a plain user message, so only the echo knows.
      assert.equal(landed.source, 'steering')
    })
  })

  it('echoes one node per submission', async () => {
    await withSession(() => {
      const nodes: ChatNode[] = []
      const message = submission('hello')
      assert.equal(appendOptimisticUserMessage(nodes, message, 'user'), true)
      assert.equal(appendOptimisticUserMessage(nodes, message, 'user'), false)
      assert.equal(appendOptimisticUserMessage(nodes, submission('   '), 'user'), false)
      assert.equal(nodes.length, 1)
    })
  })

  it('withdraws the echo of a discarded submission and keeps a recorded one', async () => {
    await withSession((session) => {
      const nodes: ChatNode[] = []
      const cancelled = submission('never delivered')
      const recorded = submission('delivered')
      appendOptimisticUserMessage(nodes, cancelled, 'steering')
      appendOptimisticUserMessage(nodes, recorded, 'steering')
      foldEvent(nodes, appendUserMessage(session, recorded))

      assert.equal(withdrawOptimisticUserMessage(nodes, cancelled.id), true)
      // A message the log already recorded is history, not an echo.
      assert.equal(withdrawOptimisticUserMessage(nodes, recorded.id), false)
      // The withdrawn node keeps its place — positions anchor the /clear cut —
      // and the renderer skips it.
      assert.equal(nodes.length, 2)
      assert.equal(nodeOf(nodes, 0, 'user-message').withdrawn, true)
      assert.equal(nodeOf(nodes, 1, 'user-message').withdrawn, undefined)
    })
  })
})

describe('foldEvents', () => {
  /** A log covering every folded event family, for the replay checks below. */
  function seedLog(session: Session): void {
    const callId = CallId('call-replay')
    session.append('turn/start', { turn: 1 })
    appendUser(session, 'run the tests')
    session.append('step/start', { turn: 1, step: 1 })
    session.append('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'sure' } })
    appendAssistant(session, [
      { type: 'text', text: 'sure' },
      { type: 'tool-call', id: callId, name: 'bash', arguments: '{"command":"pnpm test"}' },
    ])
    session.append('tool/call', { turn: 1, step: 1, callId, name: 'bash', arguments: '{"command":"pnpm test"}' })
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'ok' }], isError: false }),
    }, { surfaceOp: 'append' })
    session.append('todo/write', { todos: [{ content: 'ship it', status: 'pending' }] })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  }

  it('folds a whole log in order', async () => {
    await withSession((session) => {
      seedLog(session)
      const nodes = foldEvents(session.events)
      assert.deepEqual(kinds(nodes), ['user-message', 'assistant', 'tool-call', 'todo'])
      assert.equal(nodeOf(nodes, 1, 'assistant').status, 'complete')
      assert.equal(nodeOf(nodes, 2, 'tool-call').status, 'complete')
    })
  })

  it('replays a resumed log exactly as the live appends folded it', async () => {
    await withSession((session) => {
      // Live: one event at a time, as `session/event` delivers them.
      const live: ChatNode[] = []
      const changes: boolean[] = []
      seedLog(session)
      for (const event of session.events) changes.push(foldEvent(live, event))
      // Resume: the same log replayed in one pass.
      const replayed = foldEvents(session.events)
      assert.deepEqual(replayed, live)
      // Folding the same sequence again yields the same nodes and the same
      // change decisions, so a replay never reports phantom updates.
      const second: ChatNode[] = []
      const secondChanges = session.events.map(event => foldEvent(second, event))
      assert.deepEqual(second, live)
      assert.deepEqual(secondChanges, changes)
    })
  })

  it('reports no change for events the transcript does not show', async () => {
    await withSession((session) => {
      const nodes: ChatNode[] = []
      assert.equal(foldEvent(nodes, session.append('request/context', {
        provider: 'mock',
        model: 'test-model',
        contextWindow: 128_000,
      })), false)
      assert.equal(foldEvent(nodes, session.append('turn/start', { turn: 1 })), false)
      assert.equal(foldEvent(nodes, session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })), false)
      assert.equal(nodes.length, 0)
    })
  })
})

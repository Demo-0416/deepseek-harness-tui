/**
 * Unit tests for the event-to-node fold.
 * @module dsh-tui/tests/unit/nodes
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { foldEvent, foldEvents } from '../../src/core/nodes.ts'
import type { ChatNode } from '../../src/core/types.ts'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

function event(partial: Partial<SessionEvent> & { type: string; data: unknown }): SessionEvent {
  return {
    seq: 0,
    time: 0,
    type: partial.type as SessionEvent['type'],
    data: partial.data as SessionEvent['data'],
  } as SessionEvent
}

describe('foldEvent', () => {
  it('folds a user message', () => {
    const nodes: ChatNode[] = []
    const changed = foldEvent(nodes, event({
      type: 'user/message',
      data: {
        id: 'm1',
        role: 'user',
        content: [{ type: 'text', text: 'hello' }],
        source: { kind: 'user' },
      },
    }))
    assert.equal(changed, true)
    assert.equal(nodes.length, 1)
    assert.equal(nodes[0]?.kind, 'user-message')
    if (nodes[0]?.kind === 'user-message') {
      assert.equal(nodes[0].text, 'hello')
      assert.equal(nodes[0].source, 'user')
    }
  })

  it('folds streaming assistant chunks into one node per step', () => {
    const nodes: ChatNode[] = []
    foldEvent(nodes, event({
      type: 'assistant/chunk',
      data: {
        turn: 1,
        step: 0,
        chunk: { type: 'block-start', index: 0, blockType: 'text' },
      },
    }))
    foldEvent(nodes, event({
      type: 'assistant/chunk',
      data: {
        turn: 1,
        step: 0,
        chunk: { type: 'text-delta', index: 0, text: 'Hello' },
      },
    }))
    foldEvent(nodes, event({
      type: 'assistant/chunk',
      data: {
        turn: 1,
        step: 0,
        chunk: { type: 'text-delta', index: 0, text: ' world' },
      },
    }))
    assert.equal(nodes.length, 1)
    assert.equal(nodes[0]?.kind, 'assistant')
    if (nodes[0]?.kind === 'assistant') {
      assert.equal(nodes[0].text, 'Hello world')
      assert.equal(nodes[0].status, 'running')
    }
  })

  it('finalizes an assistant node on assistant/message', () => {
    const nodes: ChatNode[] = []
    foldEvent(nodes, event({
      type: 'assistant/chunk',
      data: {
        turn: 1,
        step: 0,
        chunk: { type: 'text-delta', index: 0, text: 'partial' },
      },
    }))
    foldEvent(nodes, event({
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 0,
        message: {
          id: 'a1',
          role: 'assistant',
          content: [{ type: 'text', text: 'final answer' }],
          source: { kind: 'model' },
        },
        usage: { inputTokens: 100, outputTokens: 50 },
      },
    }))
    assert.equal(nodes.length, 1)
    if (nodes[0]?.kind === 'assistant') {
      assert.equal(nodes[0].text, 'final answer')
      assert.equal(nodes[0].status, 'complete')
      assert.deepEqual(nodes[0].usage, { inputTokens: 100, outputTokens: 50 })
    }
  })

  it('folds tool call and result', () => {
    const nodes: ChatNode[] = []
    foldEvent(nodes, event({
      type: 'tool/call',
      data: {
        turn: 1,
        step: 0,
        callId: 'c1',
        name: 'bash',
        arguments: '{"command":"ls"}',
      },
    }))
    assert.equal(nodes.length, 1)
    assert.equal(nodes[0]?.kind, 'tool-call')
    if (nodes[0]?.kind === 'tool-call') {
      assert.equal(nodes[0].name, 'bash')
      assert.equal(nodes[0].status, 'running')
      assert.deepEqual(nodes[0].args, { command: 'ls' })
    }
    foldEvent(nodes, event({
      type: 'tool/result',
      data: {
        turn: 1,
        step: 0,
        message: {
          id: 'r1',
          role: 'user',
          content: [{
            type: 'tool-result',
            toolCallId: 'c1',
            content: [{ type: 'text', text: 'file1.txt' }],
          }],
          source: { kind: 'tool', toolCallId: 'c1', toolName: 'bash' },
        },
      },
    }))
    if (nodes[0]?.kind === 'tool-call') {
      assert.equal(nodes[0].status, 'complete')
      assert.equal(nodes[0].result?.text, 'file1.txt')
      assert.equal(nodes[0].result?.isError, false)
    }
  })

  it('pushes a notice on turn error', () => {
    const nodes: ChatNode[] = []
    foldEvent(nodes, event({
      type: 'turn/end',
      data: {
        turn: 1,
        reason: { kind: 'error', error: { message: 'boom', code: 'E' } },
      },
    }))
    assert.equal(nodes.length, 1)
    assert.equal(nodes[0]?.kind, 'notice')
    if (nodes[0]?.kind === 'notice') {
      assert.equal(nodes[0].tone, 'error')
      assert.match(nodes[0].text, /boom/)
    }
  })

  it('folds todo snapshots', () => {
    const nodes: ChatNode[] = []
    foldEvent(nodes, event({
      type: 'todo/write',
      data: { todos: [{ content: 'task 1', status: 'in_progress' }] },
    }))
    assert.equal(nodes.length, 1)
    assert.equal(nodes[0]?.kind, 'todo')
  })
})

describe('foldEvents', () => {
  it('folds a full event log', () => {
    const events = [
      event({
        type: 'user/message',
        data: {
          id: 'm1',
          role: 'user',
          content: [{ type: 'text', text: 'hi' }],
          source: { kind: 'user' },
        },
      }),
      event({
        type: 'assistant/message',
        data: {
          turn: 1,
          step: 0,
          message: {
            id: 'a1',
            role: 'assistant',
            content: [{ type: 'text', text: 'hello' }],
            source: { kind: 'model' },
          },
        },
      }),
    ]
    const nodes = foldEvents(events)
    assert.equal(nodes.length, 2)
    assert.equal(nodes[0]?.kind, 'user-message')
    assert.equal(nodes[1]?.kind, 'assistant')
  })
})

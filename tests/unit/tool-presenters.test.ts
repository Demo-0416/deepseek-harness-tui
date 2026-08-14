/**
 * TUI-side presenter fallbacks: the ask_user_question card must never show raw
 * JSON — a pending call shows the question's short label, a completed one the
 * `· question → answer` echo, and a user interrupt reads as a decline rather
 * than a failure. Anything off-shape falls back to the harness rendering.
 * @module dsh-tui/tests/unit/tool-presenters
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { withTuiPresenters } from '../../src/components/tool-presenters.ts'

/** A registered definition without presenters, as tool-ask-user ships today. */
const BARE_DEFINITION = { name: 'ask_user_question' } as ToolDefinition

/** The call arguments the model sends, in the tool's own snake_case schema. */
const ARGS = {
  questions: [
    {
      id: 'q1',
      question: 'Which branch?',
      header: 'Branch',
      options: [{ label: 'main' }, { label: 'staging' }],
    },
  ],
}

function presenters(): Required<Pick<ToolDefinition, 'presentCall' | 'presentResult'>> {
  const definition = withTuiPresenters('ask_user_question', BARE_DEFINITION)
  assert.ok(definition?.presentCall !== undefined && definition.presentResult !== undefined)
  return definition as Required<Pick<ToolDefinition, 'presentCall' | 'presentResult'>>
}

describe('withTuiPresenters', () => {
  it('leaves unknown tools and missing definitions alone', () => {
    assert.equal(withTuiPresenters('bash', BARE_DEFINITION), BARE_DEFINITION)
    assert.equal(withTuiPresenters('ask_user_question', undefined), undefined)
  })

  it('keeps a definition that already presents itself', () => {
    const presenting = {
      ...BARE_DEFINITION,
      presentCall: () => ({ card: 'generic', title: 'own' }),
      presentResult: () => undefined,
    } as ToolDefinition
    assert.equal(withTuiPresenters('ask_user_question', presenting), presenting)
  })

  it('summarizes a pending ask without echoing the raw input', () => {
    const view = presenters().presentCall(ARGS)
    assert.deepEqual(view, { card: 'generic', title: 'Branch' })
  })

  it('counts the questions that follow the first', () => {
    const view = presenters().presentCall({
      questions: [{ question: 'Which branch?' }, { question: 'Deploy now?' }],
    })
    assert.deepEqual(view, { card: 'generic', title: 'Which branch? (+1 more)' })
  })

  it('echoes answers as question → answer rows', () => {
    const view = presenters().presentResult(ARGS, {
      content: [{ type: 'text', text: '{"answers":[{"id":"q1","selected":["main"],"custom":"and rebase"}]}' }],
      isError: false,
    })
    assert.deepEqual(view, {
      card: 'generic',
      content: [{ type: 'text', text: 'User answered:\n· Which branch? → main, and rebase' }],
    })
  })

  it('reads a user interrupt as a decline, not a failure', () => {
    const view = presenters().presentResult(ARGS, {
      content: [{ type: 'text', text: 'Error: ask_user_question was interrupted before the user answered' }],
      isError: true,
    })
    assert.deepEqual(view, {
      card: 'generic',
      content: [{ type: 'text', text: 'User declined to answer questions' }],
    })
  })

  it('keeps a real failure and an off-shape payload on the raw card', () => {
    const pair = presenters()
    assert.equal(pair.presentResult(ARGS, {
      content: [{ type: 'text', text: 'Error: ask_user_question TUI failed: boom' }],
      isError: true,
    }), undefined)
    assert.equal(pair.presentResult(ARGS, {
      content: [{ type: 'text', text: 'not json' }],
      isError: false,
    }), undefined)
  })
})

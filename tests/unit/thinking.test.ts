/**
 * Thinking blocks and turn timing, asserted straight against the reconciler.
 *
 * Both behaviours are decided by facts a mounted TUI cannot fake: how long a
 * turn took (real log timestamps) and where a step is in its lifecycle. Driving
 * the reconciler directly lets one case fabricate a 45-second turn and the next
 * one a 30-second turn without sleeping through either, which is why these live
 * here rather than in the harness-driven transcript suite.
 * @module dsh-tui/tests/unit/thinking
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Container } from '@earendil-works/pi-tui'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { StepTimingTracker } from '../../src/chat/timing.ts'
import { TranscriptReconciler, type TranscriptDeps } from '../../src/components/reconciler.ts'
import { createPalette, markdownTheme } from '../../src/components/theme.ts'
import {
  formatTurnDuration,
  TURN_COMPLETION_VERBS,
  TURN_FOOTER_MIN_MS,
  type MarkdownPolicy,
  type ToolCardVisibility,
} from '../../src/components/transcript.ts'
import { claudeMarkdownTheme } from '../../src/render/markdown.ts'
import type { AssistantNode, UserMessageNode } from '../../src/core/types.ts'

/** Columns the transcript renders into; wide enough that nothing under test wraps. */
const WIDTH = 90

/** Epoch of the fabricated logs, so a turn's wall time is exactly what a case sets. */
const START = 1_700_000_000_000

/** The thinking title Claude Code renders (U+2234, U+2026). */
const TITLE = '∴ Thinking…'

/** Body of every fabricated reasoning block. */
const THOUGHT = 'WEIGHING-THE-OPTIONS'

/** Body of every fabricated response. */
const ANSWER = 'ANSWER-TEXT'

/** One turn's bracket, optionally still open. */
function turnEvents(turn: number, elapsedMs: number | undefined, at = START): SessionEvent[] {
  const start: SessionEvent = { type: 'turn/start', seq: turn * 2, time: at, data: { turn } }
  if (elapsedMs === undefined) return [start]
  return [start, {
    type: 'turn/end',
    seq: turn * 2 + 1,
    time: at + elapsedMs,
    data: { turn, reason: { kind: 'completed' } },
  }]
}

/** One assistant step, live by default. */
function assistantNode(overrides: Partial<AssistantNode> = {}): AssistantNode {
  const turn = overrides.turn ?? 1
  const step = overrides.step ?? 1
  return {
    kind: 'assistant',
    key: `assistant:${turn}:${step}`,
    version: 0,
    time: START,
    turn,
    step,
    status: 'running',
    text: ANSWER,
    reasoning: THOUGHT,
    settled: false,
    toolCalls: [],
    ...overrides,
  }
}

/** One typed prompt. */
function userNode(text: string, key: string): UserMessageNode {
  return { kind: 'user-message', key, version: 0, time: START, text, source: 'user' }
}

/** A reconciler over its own chat container, plus the rows it currently renders. */
function mount(
  events: readonly SessionEvent[],
  view: { showReasoning?: boolean; visibility?: ToolCardVisibility } = {},
): {
  reconciler: TranscriptReconciler
  rows: () => string[]
  frame: () => string
} {
  const palette = createPalette(false)
  const markdown: MarkdownPolicy = {
    mode: 'claude',
    theme: claudeMarkdownTheme,
    onError: error => assert.fail(`the claude renderer threw: ${String(error)}`),
  }
  const deps: TranscriptDeps = {
    palette,
    mdTheme: markdownTheme(palette),
    markdown,
    maxToolOutputLines: 6,
    maxDiffEditLength: 2_000,
    events: () => events,
    tracker: new StepTimingTracker(),
    // Every fabricated turn is over before it is rendered, so the clock only
    // has to be past the log.
    now: () => START + 10_000_000,
    toolDefinition: () => undefined,
  }
  const chat = new Container()
  const reconciler = new TranscriptReconciler(chat, deps, {
    showReasoning: view.showReasoning ?? true,
    visibility: view.visibility ?? 'collapsed',
  })
  const rows = (): string[] => chat.render(WIDTH).map(row => row.trimEnd())
  return { reconciler, rows, frame: () => rows().join('\n') }
}

/** Close a node in place the way the fold does, so the reconciler applies it. */
function settle(node: AssistantNode, completedAt?: number): void {
  node.settled = true
  node.status = 'complete'
  if (completedAt !== undefined) node.completedAt = completedAt
  node.version += 1
}

describe('thinking visibility across the Ctrl+O phases', () => {
  it('shows a streaming step\'s thinking as a titled, indented block', () => {
    const mounted = mount(turnEvents(1, undefined))
    mounted.reconciler.reconcile([assistantNode()])
    const rows = mounted.rows()

    const title = rows.findIndex(row => row.includes(TITLE))
    const body = rows.findIndex(row => row.includes(THOUGHT))
    const answer = rows.findIndex(row => row.includes(ANSWER))
    assert.ok(title >= 0, `a live step titles its thinking:\n${rows.join('\n')}`)
    // Claude Code's shape: title, one blank row, then the body two columns in
    // (three here, counting the transcript's own left margin).
    assert.equal(rows[title], ` ${TITLE}`)
    assert.equal(rows[title + 1], '')
    assert.equal(body, title + 2, `the body opens right under the gap:\n${rows.join('\n')}`)
    assert.equal(rows[body], `   ${THOUGHT}`)
    assert.ok(answer > body, `and the answer follows the aside:\n${rows.join('\n')}`)
  })

  it('takes a finished step\'s thinking off the transcript, leaving no summary row', () => {
    const mounted = mount(turnEvents(1, undefined))
    const node = assistantNode()
    mounted.reconciler.reconcile([node])
    assert.ok(mounted.frame().includes(THOUGHT), 'the block is on screen while the step streams')

    settle(node)
    mounted.reconciler.reconcile([node])
    const frame = mounted.frame()
    // Claude Code renders `null` for a past thinking block: no body, and no
    // "✻ Thought for 5s" line standing in for one either.
    assert.ok(!frame.includes(THOUGHT), `a settled step drops its thinking body:\n${frame}`)
    assert.ok(!frame.includes(TITLE), `and its title with it:\n${frame}`)
    assert.ok(!frame.includes('Thought for'), `leaving no summary row behind:\n${frame}`)
    assert.ok(frame.includes(ANSWER), `while the answer stays:\n${frame}`)
  })

  it('drops the thinking of a step a cancelled turn closed unsettled', () => {
    const mounted = mount(turnEvents(1, undefined))
    const node = assistantNode()
    mounted.reconciler.reconcile([node])

    // `turn/end` on a cancelled turn closes the step without settling its
    // message: the step is over, so its thinking is history either way.
    node.status = 'interrupted'
    node.completedAt = START + 5_000
    node.version += 1
    mounted.reconciler.reconcile([node])
    const frame = mounted.frame()
    assert.ok(!frame.includes(THOUGHT), `an interrupted step drops its thinking:\n${frame}`)
    assert.ok(!frame.includes(TITLE), `title included:\n${frame}`)
  })

  it('keeps it off the hidden phase and brings it back whole on the expanded one', () => {
    const mounted = mount(turnEvents(1, undefined))
    const node = assistantNode()
    settle(node, START + 5_000)
    mounted.reconciler.reconcile([node])
    assert.ok(!mounted.frame().includes(THOUGHT), 'collapsed hides a finished step\'s thinking')

    mounted.reconciler.setVisibility('expanded')
    const expanded = mounted.rows()
    const title = expanded.findIndex(row => row.includes(TITLE))
    assert.ok(title >= 0, `the expanded phase renders the block:\n${expanded.join('\n')}`)
    assert.equal(expanded[title], ` ${TITLE}`)
    assert.equal(expanded[title + 1], '')
    assert.equal(expanded[title + 2], `   ${THOUGHT}`)

    mounted.reconciler.setVisibility('hidden')
    const hidden = mounted.frame()
    assert.ok(!hidden.includes(THOUGHT), `and the hidden phase drops it again:\n${hidden}`)
    assert.ok(hidden.includes(ANSWER), `without touching the answer:\n${hidden}`)
  })

  it('honours showReasoning: false in every phase, streaming included', () => {
    const mounted = mount(turnEvents(1, undefined), { showReasoning: false })
    const node = assistantNode()
    mounted.reconciler.reconcile([node])
    const live = mounted.frame()
    // The setting predates the cycle and means this transcript does not show
    // reasoning at all — not even the title, and not even while it streams.
    assert.ok(!live.includes(THOUGHT), `a live step shows no reasoning:\n${live}`)
    assert.ok(!live.includes(TITLE), `and no title:\n${live}`)
    assert.ok(live.includes(ANSWER), `the answer is unaffected:\n${live}`)

    mounted.reconciler.setVisibility('expanded')
    const expanded = mounted.frame()
    assert.ok(!expanded.includes(THOUGHT), `and the expanded phase adds none:\n${expanded}`)
    assert.ok(!expanded.includes(TITLE), `title included:\n${expanded}`)
  })
})

describe('turn completion row', () => {
  /** The `✻ <verb> for <duration>` row, when the transcript has one. */
  function completionRow(rows: readonly string[]): string | undefined {
    return rows.find(row => row.startsWith(' ✻ '))
  }

  it('says nothing for a turn short enough to have been watched', () => {
    const mounted = mount(turnEvents(1, TURN_FOOTER_MIN_MS))
    const node = assistantNode()
    settle(node, START + TURN_FOOTER_MIN_MS)
    mounted.reconciler.reconcile([node])
    const rows = mounted.rows()
    // Claude Code's threshold is exclusive (`turnDurationMs > 30000`), so a turn
    // that lands exactly on it still prints nothing.
    assert.equal(completionRow(rows), undefined, `a 30s turn reports nothing:\n${rows.join('\n')}`)
  })

  it('says nothing while the turn is still running', () => {
    const mounted = mount(turnEvents(1, undefined))
    mounted.reconciler.reconcile([assistantNode()])
    const rows = mounted.rows()
    assert.equal(completionRow(rows), undefined, `an open turn reports nothing:\n${rows.join('\n')}`)
  })

  it('reports one dim ✻ row at the tail of a turn that ran over 30s', () => {
    const mounted = mount(turnEvents(1, 45_000))
    const node = assistantNode()
    settle(node, START + 45_000)
    mounted.reconciler.reconcile([node])
    const rows = mounted.rows()

    const row = completionRow(rows)
    assert.ok(row !== undefined, `a long turn reports its wall time:\n${rows.join('\n')}`)
    const verbs = TURN_COMPLETION_VERBS.join('|')
    assert.match(row, new RegExp(`^ ✻ (?:${verbs}) for 45s$`, 'u'))
    // It is the turn's row, so it trails everything that turn rendered.
    assert.ok(
      rows.indexOf(row) > rows.findIndex(entry => entry.includes(ANSWER)),
      `and trails the answer:\n${rows.join('\n')}`,
    )
    assert.equal(rows.filter(entry => entry.startsWith(' ✻ ')).length, 1, 'exactly one row per turn')
  })

  it('keeps its verb across re-renders and closes each turn where that turn ends', () => {
    const events = [...turnEvents(1, 45_000), ...turnEvents(2, undefined, START + 60_000)]
    const mounted = mount(events)
    const first = assistantNode({ turn: 1, step: 1, text: 'FIRST-ANSWER' })
    settle(first, START + 45_000)
    mounted.reconciler.reconcile([first])
    const wording = completionRow(mounted.rows())
    assert.ok(wording !== undefined, 'the finished turn reports')

    // The next turn opens: its prompt is where the previous turn's row is due,
    // and a re-render must not reword the row it already printed.
    const prompt = userNode('SECOND-PROMPT', 'user:2')
    const second = assistantNode({ turn: 2, step: 1, key: 'assistant:2:1', text: 'SECOND-ANSWER' })
    mounted.reconciler.reconcile([first, prompt, second])
    const rows = mounted.rows()
    assert.equal(completionRow(rows), wording, 'the sampled verb is held for the life of the turn')
    const row = rows.indexOf(wording)
    assert.ok(row > rows.findIndex(entry => entry.includes('FIRST-ANSWER')),
      `the row closes the turn it measured:\n${rows.join('\n')}`)
    assert.ok(row < rows.findIndex(entry => entry.includes('SECOND-PROMPT')),
      `and stays above the next turn's prompt:\n${rows.join('\n')}`)
    assert.equal(rows.filter(entry => entry.startsWith(' ✻ ')).length, 1,
      `the open turn adds none of its own:\n${rows.join('\n')}`)
  })

  it('keeps its verb through the remount a color-scheme change forces', () => {
    // `reset()` drops every row so the new palette is picked up. The verb is a
    // property of the turn, not of the row mounted for it: re-sampling here
    // reworded turns the user had already read, on nothing but a theme switch.
    const mounted = mount(turnEvents(1, 45_000))
    const node = assistantNode()
    settle(node, START + 45_000)
    mounted.reconciler.reconcile([node])
    const wording = completionRow(mounted.rows())
    assert.ok(wording !== undefined, 'the finished turn reports')

    for (let remount = 0; remount < 20; remount += 1) {
      mounted.reconciler.reset()
      mounted.reconciler.reconcile([node])
      assert.equal(completionRow(mounted.rows()), wording, 'a remount rebuilds the row with the same verb')
    }
  })

  it('renders on every phase, unlike the per-step breakdown', () => {
    const mounted = mount(turnEvents(1, 45_000))
    const node = assistantNode()
    settle(node, START + 45_000)
    mounted.reconciler.reconcile([node])
    for (const phase of ['collapsed', 'expanded', 'hidden'] as const) {
      mounted.reconciler.setVisibility(phase)
      const rows = mounted.rows()
      assert.ok(completionRow(rows) !== undefined, `the ${phase} phase keeps the turn row:\n${rows.join('\n')}`)
      // The step's own breakdown is the engineering detail, and it is on the
      // expanded phase alone.
      const breakdown = rows.some(row => row.includes('Model wait') && row.includes('Completed '))
      assert.equal(breakdown, phase === 'expanded', `the ${phase} phase's breakdown:\n${rows.join('\n')}`)
    }
  })
})

describe('turn duration formatting', () => {
  it('matches Claude Code\'s formatDuration', () => {
    assert.equal(formatTurnDuration(45_000), '45s')
    assert.equal(formatTurnDuration(30_001), '30s')
    assert.equal(formatTurnDuration(59_999), '59s')
    assert.equal(formatTurnDuration(60_000), '1m 0s')
    assert.equal(formatTurnDuration(83_000), '1m 23s')
    // 119.6 s rounds up into the next minute rather than printing `1m 60s`.
    assert.equal(formatTurnDuration(119_600), '2m 0s')
    assert.equal(formatTurnDuration(3_723_000), '1h 2m 3s')
    // A backward clock is clamped rather than reported as a negative turn.
    assert.equal(formatTurnDuration(-1), '0s')
  })
})

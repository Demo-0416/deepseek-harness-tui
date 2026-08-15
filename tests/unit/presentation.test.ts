/**
 * The presentation layer's own contracts: the gutter every message glyph sits
 * in, the user block's verbatim echo and theme-aware fill, the plan-mode badge,
 * the survival of process-local rows across a palette swap, and where an inline
 * surface opens relative to the input.
 *
 * These are all "what does the screen look like" claims, so each is asserted at
 * the lowest layer that can still be wrong: the reconciler for anything driven
 * by nodes, the component for anything driven by width, and the mounted
 * terminal for the two facts that are decided by the mount order alone.
 * @module dsh-tui/tests/unit/presentation
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { Container, visibleWidth, type Component } from '@earendil-works/pi-tui'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { DEFAULT_MAX_PROMPT_CHARS, truncatePrompt } from '../../src/chat/prompt-truncation.ts'
import { StepTimingTracker } from '../../src/chat/timing.ts'
import { TranscriptReconciler, type TranscriptDeps } from '../../src/components/reconciler.ts'
import { createPalette, markdownTheme, type Palette } from '../../src/components/theme.ts'
import {
  MarkdownBodyComponent,
  planModeRow,
  turnFooterRow,
  UserMessageComponent,
  type MarkdownPolicy,
} from '../../src/components/transcript.ts'
import { StatusCardComponent, type StatusCardRow } from '../../src/components/dialogs.ts'
import { setLocale, t } from '../../src/i18n/index.ts'
import { claudeMarkdownTheme } from '../../src/render/markdown.ts'
import { brandSchemeColors } from '../../src/render/palette.ts'
import type { AssistantNode, ChatNode, ToolCallNode, UserMessageNode } from '../../src/core/types.ts'
import {
  createTuiTestHarness,
  disposeTuiTestHarness,
  tuiEntryAvailable,
  type TuiHarnessOptions,
} from '../harness.ts'
import { HeadlessTerminal } from '../headless-terminal.ts'

/** Columns the transcript renders into; wide enough that nothing under test wraps. */
const WIDTH = 90

/** Epoch of the fabricated logs. */
const START = 1_700_000_000_000

/** Literal editor prefix, so a frame assertion never depends on prompt-value registrations. */
const INPUT_PROMPT = 'look> '

/** A panel is assembled across a few awaits; outwait them. */
const SETTLE_MS = 60

/** `src/index.ts` is landed by a separate port; without it the end-to-end suite cannot run. */
const entryAvailable = await tuiEntryAvailable()
const skipWithoutEntry = entryAvailable
  ? false
  : 'requires src/index.ts to export createTuiChat(ctx, config, runtime)'

/** `TuiController.submit` is the typed-line path; the harness handle only declares disposal. */
interface SubmitHandle {
  submit(text: string): void
}

/** A reconciler over its own chat container, plus the rows it renders. */
function mountReconciler(options: { palette?: Palette; scheme?: 'dark' | 'light' } = {}): {
  reconciler: TranscriptReconciler
  rows: () => string[]
} {
  const palette = options.palette ?? createPalette(false)
  const markdown: MarkdownPolicy = {
    mode: 'claude',
    theme: claudeMarkdownTheme,
    onError: error => assert.fail(`the claude renderer threw: ${String(error)}`),
  }
  const events: readonly SessionEvent[] = []
  const deps: TranscriptDeps = {
    palette,
    mdTheme: markdownTheme(palette),
    scheme: () => options.scheme ?? 'dark',
    markdown,
    maxToolOutputLines: 6,
    maxDiffEditLength: 2_000,
    events: () => events,
    tracker: new StepTimingTracker(),
    now: () => START,
    toolDefinition: () => undefined,
    cwd: '/workspace',
    expandKey: () => 'Ctrl+O',
  }
  const chat = new Container()
  const reconciler = new TranscriptReconciler(chat, deps, { showReasoning: true, visibility: 'collapsed' })
  return { reconciler, rows: () => chat.render(WIDTH).map(row => row.trimEnd()) }
}

/** One settled assistant step that requested one tool call. */
function assistantNode(overrides: Partial<AssistantNode> = {}): AssistantNode {
  return {
    kind: 'assistant',
    key: 'assistant:1:1',
    version: 0,
    time: START,
    turn: 1,
    step: 1,
    status: 'complete',
    text: 'ANSWER-TEXT',
    reasoning: '',
    settled: true,
    completedAt: START,
    toolCalls: [],
    ...overrides,
  }
}

/**
 * One complete tool call, with no result yet. The tool writes (`edit`) rather
 * than reads on purpose: a read-only call is folded into a collapsed group row
 * on this phase, and these cases are about the card itself.
 */
function toolNode(): ToolCallNode {
  return {
    kind: 'tool-call',
    key: 'tool:call-1',
    version: 0,
    time: START,
    callId: 'call-1',
    name: 'edit',
    argsRaw: '{}',
    args: { valid: true, value: {} },
    argsComplete: true,
    status: 'running',
  }
}

/** One typed prompt. */
function userNode(text: string): UserMessageNode {
  return { kind: 'user-message', key: 'user:1', version: 0, time: START, text, source: 'user' }
}

/** The column a glyph starts in, or -1 when the rows never carry it. */
function glyphColumn(rows: readonly string[], glyph: string): number {
  for (const row of rows) {
    const index = row.indexOf(glyph)
    if (index >= 0) return index
  }
  return -1
}

describe('transcript gutter', () => {
  it('puts the assistant bullet, the tool bullet and the turn row in one column', () => {
    const { reconciler, rows } = mountReconciler()
    const step = assistantNode({ toolCalls: ['call-1'] })
    const nodes: ChatNode[] = [step, toolNode()]
    reconciler.reconcile(nodes)
    const rendered = rows()

    const assistant = glyphColumn(rendered, '●')
    const tool = glyphColumn(rendered, process.platform === 'darwin' ? '⏺' : '●')
    assert.ok(assistant >= 0, `the answer renders its bullet:\n${rendered.join('\n')}`)
    assert.ok(tool >= 0, `the card renders its bullet:\n${rendered.join('\n')}`)
    // Claude Code gives every message glyph the same gutter; a card whose
    // bullet sat one column left of the answer's was the visible symptom.
    assert.equal(tool, assistant, `both bullets share the gutter:\n${rendered.join('\n')}`)
    // The turn row's ✻ and a thinking block's ∴ are in that same column.
    assert.equal(turnFooterRow(45_000, createPalette(false), 'Worked').indexOf('✻'), assistant)
  })

  it('aligns a result block under the tool name it belongs to', () => {
    const { reconciler, rows } = mountReconciler()
    const call = toolNode()
    reconciler.reconcile([assistantNode({ toolCalls: ['call-1'] }), {
      ...call,
      version: 1,
      status: 'complete',
      result: { content: [{ type: 'text', text: 'RESULT-ROW' }], isError: false, text: 'RESULT-ROW' },
    }])
    const rendered = rows()
    const header = rendered.find(row => row.includes('edit'))
    const result = rendered.find(row => row.includes('⎿'))
    assert.ok(header !== undefined && result !== undefined, `both rows render:\n${rendered.join('\n')}`)
    // Upstream's `MessageResponse` prefix lands the `⎿` in the column the tool
    // name starts in, so the card reads as one left-aligned block.
    assert.equal(result.indexOf('⎿'), header.indexOf('edit'))
  })
})

describe('user message block', () => {
  it('echoes the prompt verbatim behind the pointer, with no markdown pass', () => {
    const component = new UserMessageComponent('# not a heading *and* `not code`', createPalette(false))
    const rendered = component.render(WIDTH).map(row => row.trimEnd())
    const joined = rendered.join('\n')
    // The one dialect rule: only assistant text is typeset. A prompt that
    // quotes markup has to come back exactly as it was sent, or the user
    // cannot check what they asked for.
    assert.match(joined, /❯ # not a heading \*and\* `not code`/, joined)
  })

  it('wraps under the pointer and keeps every row the same width', () => {
    const words = Array.from({ length: 40 }, (_, index) => `word${String(index)}`).join(' ')
    const rendered = new UserMessageComponent(words, createPalette(false)).render(40)
    assert.ok(rendered.length > 1, 'a long prompt wraps')
    assert.ok(rendered.every(row => row.length <= 40), 'no row overflows the block')
  })

  it('clips a pasted wall of text to its two ends', () => {
    const long = `HEAD${'x\n'.repeat(9_000)}TAIL`
    const rendered = new UserMessageComponent(long, createPalette(false)).render(WIDTH).join('\n')
    assert.match(rendered, /HEAD/)
    assert.match(rendered, /TAIL/)
    assert.match(rendered, /… \+\d+ lines …/, 'the middle is reported rather than printed')
  })

  it('clips the longest prompt that can reach it, which is one cut to the send budget', () => {
    // Submission cuts a pasted file to exactly the send budget, so a display
    // threshold equal to that budget would never fire and the block would echo
    // the whole hundred rows the paste became.
    const submitted = truncatePrompt(`HEAD${'x\n'.repeat(20_000)}TAIL`, DEFAULT_MAX_PROMPT_CHARS)
    assert.equal(submitted.text.length, DEFAULT_MAX_PROMPT_CHARS)
    const rendered = new UserMessageComponent(submitted.text, createPalette(false)).render(WIDTH)
    const joined = rendered.join('\n')
    assert.match(joined, /HEAD/)
    assert.match(joined, /TAIL/)
    assert.match(joined, /… \+\d+ lines …/, 'the middle is reported rather than printed')
  })

  it('fills with the scheme\'s own background, not a fixed dark bar', () => {
    const palette = createPalette(true)
    const dark = new UserMessageComponent('prompt', palette, 'dark').render(WIDTH).join('')
    const light = new UserMessageComponent('prompt', palette, 'light').render(WIDTH).join('')
    const darkFill = brandSchemeColors('dark').userMessageBg
    const lightFill = brandSchemeColors('light').userMessageBg
    assert.ok(dark.includes(`48;2;${String(darkFill.r)};${String(darkFill.g)};${String(darkFill.b)}m`), dark)
    assert.ok(light.includes(`48;2;${String(lightFill.r)};${String(lightFill.g)};${String(lightFill.b)}m`), light)
    // A white terminal draws black text; upstream's light fill is near-white,
    // and the dark one would bury that text.
    assert.notEqual(lightFill.r, darkFill.r)
  })

  it('degrades to plain padded rows when color is disabled', () => {
    const rendered = new UserMessageComponent('prompt', createPalette(false)).render(WIDTH)
    assert.equal(rendered.length, 1)
    assert.doesNotMatch(rendered[0] ?? '', /\x1b/u, 'a --no-color transcript carries no fill')
  })

  it('reads the reported scheme when the reconciler mounts it', () => {
    const palette = createPalette(true)
    const { reconciler, rows } = mountReconciler({ palette, scheme: 'light' })
    reconciler.reconcile([userNode('prompt')])
    const fill = brandSchemeColors('light').userMessageBg
    assert.ok(
      rows().join('').includes(`48;2;${String(fill.r)};${String(fill.g)};${String(fill.b)}m`),
      'the block is filled for the terminal the user is actually on',
    )
  })
})

describe('status card', () => {
  it('measures its label column in display columns, so a CJK label neither clips nor skews', () => {
    setLocale('zh')
    try {
      // Built inside the locale switch: the labels are what `/status` passes,
      // and they are only Chinese once the locale moved.
      const groups: readonly (readonly StatusCardRow[])[] = [[
        [t('status.row.session'), 'sess-01HZ'],
        [t('status.row.preset'), 'default'],
        [t('status.row.kvCache'), 'n/a (0 read + 0 write)'],
        [t('status.row.sessionTotals'), '2 turns · 5 steps · model 1.2s and a long tail that must wrap here'],
      ]]
      const rows = new StatusCardComponent(groups, createPalette(true)).render(70)
      const widths = new Set(rows.map(row => visibleWidth(row)))
      assert.equal(widths.size, 1, `every row of the card is one width:\n${rows.join('\n')}`)
      // The colon survives: a label column sized in code units cut `KV 缓存:`
      // down to `KV 缓存` and `会话累计:` down to `会话累`.
      for (const label of [t('status.row.session'), t('status.row.preset'), t('status.row.kvCache'), t('status.row.sessionTotals')]) {
        assert.ok(
          rows.some(row => row.includes(`${label}:`)),
          `the card prints "${label}:" in full:\n${rows.join('\n')}`,
        )
      }
      assert.ok(
        rows[0]?.includes(t('status.card.title')) === true,
        `the card's own title is translated too:\n${rows.join('\n')}`,
      )
    } finally {
      setLocale('en')
    }
  })
})

describe('plan mode indicator', () => {
  it('names the mode in the plan tone of the active scheme', () => {
    const palette = createPalette(true)
    const dark = planModeRow(palette, 'dark')
    const light = planModeRow(palette, 'light')
    assert.match(dark, /⏸ plan mode on/)
    const darkTone = brandSchemeColors('dark').planMode
    const lightTone = brandSchemeColors('light').planMode
    assert.ok(dark.includes(`38;2;${String(darkTone.r)};${String(darkTone.g)};${String(darkTone.b)}m`), dark)
    assert.ok(light.includes(`38;2;${String(lightTone.r)};${String(lightTone.g)};${String(lightTone.b)}m`), light)
  })

  it('carries no escape when color is disabled', () => {
    assert.doesNotMatch(planModeRow(createPalette(false)), /\x1b/u)
  })

  it('says the mode commits at the next step while pending', () => {
    // The cycle hint slot stays empty here: the badge's own words are what a
    // queued selection changes, not the key it names.
    const row = planModeRow(createPalette(true), 'dark', undefined, true)
    assert.match(row, /⏸ plan mode on \(next step\)/)
  })
})

describe('process-local rows', () => {
  it('rebuilds a notice under the new palette instead of dropping it', () => {
    const { reconciler, rows } = mountReconciler()
    let builds = 0
    const build = (): Component[] => {
      builds += 1
      return [{ invalidate: () => {}, render: () => [`LOCAL-ROW-${String(builds)}`] }]
    }
    reconciler.reconcile([])
    reconciler.appendLocal(build)
    assert.equal(builds, 1)
    assert.ok(rows().includes('LOCAL-ROW-1'))

    // A color-scheme change remounts every row; a local row has no node to be
    // rebuilt from, so the reconciler has to rebuild it from its own recipe.
    reconciler.reset()
    reconciler.reconcile([])
    assert.equal(builds, 2, 'the row was rebuilt, not reused')
    assert.ok(rows().includes('LOCAL-ROW-2'), `the answer survives the swap:\n${rows().join('\n')}`)
  })

  it('still drops local rows on /clear, which hides everything above it', () => {
    const { reconciler, rows } = mountReconciler()
    reconciler.reconcile([])
    reconciler.appendLocal(() => [{ invalidate: () => {}, render: () => ['LOCAL-ROW'] }])
    reconciler.clearTranscript()
    reconciler.reconcile([])
    assert.ok(!rows().includes('LOCAL-ROW'))
  })
})

describe('markdown fallback', () => {
  it('reports the demotion once and keeps the answer on screen', () => {
    const palette = createPalette(false)
    const reported: unknown[] = []
    const policy: MarkdownPolicy = {
      mode: 'claude',
      // A theme that throws is the cheapest stand-in for a document the port
      // mishandles; the component cannot tell the two apart.
      theme: { ...claudeMarkdownTheme, bold: () => { throw new Error('boom') } },
      onError: error => reported.push(error),
    }
    const first = new MarkdownBodyComponent('**bold**', palette, markdownTheme(palette), policy)
    const rows = first.render(WIDTH).join('\n')
    assert.equal(policy.mode, 'pi', 'the whole process moves to the fallback renderer')
    assert.equal(reported.length, 1, 'the failure is reported, which is what puts a notice on screen')
    assert.match(rows, /bold/, 'the answer is still readable')

    // Every later body is already on the fallback, so the report — and the row
    // it produces — happens once per process, not once per message.
    const second = new MarkdownBodyComponent('**more**', palette, markdownTheme(palette), policy)
    assert.match(second.render(WIDTH).join('\n'), /more/)
    assert.equal(reported.length, 1)
  })
})

describe('plan mode on screen', { skip: skipWithoutEntry }, () => {
  it('shows the badge above the prompt while the log says plan mode is on', async () => {
    const terminal = new HeadlessTerminal(100, 40)
    const before = terminal.frames
    const harness = await createTuiTestHarness(terminal, () => {}, {
      cwd: '/workspace/project',
      config: { title: 'DSH plan', theme: { color: false, inputPrompt: INPUT_PROMPT } },
      beforeMount(session) {
        session.append('plan/mode', { active: true })
      },
    } satisfies TuiHarnessOptions)
    await terminal.waitForFrame(before)
    try {
      const lines = harness.terminal.text().split('\n')
      const badge = lines.findIndex(line => line.includes('plan mode on'))
      const prompt = lines.findIndex(line => line.includes(INPUT_PROMPT))
      assert.ok(badge >= 0, `the session says so on screen:\n${lines.join('\n')}`)
      assert.ok(prompt > badge, 'the badge sits with the prompt chrome, above the input')

      // Leaving plan mode takes the badge with it: the row is the state, not a
      // one-off announcement.
      const off = harness.terminal.frames
      harness.session.append('plan/mode', { active: false })
      await harness.terminal.waitForFrame(off)
      assert.ok(!harness.terminal.text().includes('plan mode on'))
    } finally {
      await disposeTuiTestHarness(harness)
      await harness.terminal.dispose()
    }
  })
})

describe('inline surfaces', { skip: skipWithoutEntry }, () => {
  it('opens a panel below the input, not between the conversation and it', async () => {
    const terminal = new HeadlessTerminal(100, 44)
    const before = terminal.frames
    const harness = await createTuiTestHarness(terminal, () => {}, {
      cwd: '/workspace/project',
      config: { title: 'DSH look', theme: { color: false, inputPrompt: INPUT_PROMPT } },
    } satisfies TuiHarnessOptions)
    await terminal.waitForFrame(before)
    try {
      ;(harness.controller as unknown as SubmitHandle).submit('/hotkeys')
      await delay(SETTLE_MS)
      const lines = harness.terminal.text().split('\n')
      const prompt = lines.findIndex(line => line.includes(INPUT_PROMPT))
      const panel = lines.findIndex(line => line.includes('/hotkeys'))
      assert.ok(prompt >= 0, `the prompt is on screen:\n${lines.join('\n')}`)
      assert.ok(panel >= 0, `the panel is on screen:\n${lines.join('\n')}`)
      // Claude Code opens a slash command's surface in the input's own place,
      // under the line the user typed it on — never above the prompt, where it
      // would read as part of the transcript.
      assert.ok(panel > prompt, `the panel opens below the input:\n${lines.join('\n')}`)
    } finally {
      await disposeTuiTestHarness(harness)
      await harness.terminal.dispose()
    }
  })
})

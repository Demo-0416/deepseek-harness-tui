/**
 * The capability surfaces the Web client already had and the terminal did not:
 * the Claude markdown pipeline behind assistant bodies, the `/plugins` Loader
 * view, the goal and whole-log figures on `/status`, and a `/export` that
 * actually delivers a file.
 *
 * The `/export` cases carry a finding: the shipped
 * `@deepseek-ai/dsh-session-log-export` plugin is Web-only — its host half
 * returns a fixed sentence and the archive is produced by an HTTP endpoint and
 * saved by a browser plugin. Both halves are pinned here, the upstream one so
 * the reason the TUI owns its own command stays visible.
 * @module dsh-tui/tests/unit/web-parity
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import { GoalId, type GoalChangeMeta } from '@deepseek-ai/dsh-goal'
import type { PluginEntryId, PluginInventorySnapshot } from '@deepseek-ai/dsh-host-plugin-inventory'
import type { SessionStatsProjection } from '@deepseek-ai/dsh-session-stats'
import type { Session } from '@deepseek-ai/dsh-session'
import * as sessionLogDownload from '@deepseek-ai/dsh-session-log-export'
import { MarkdownBodyComponent, type MarkdownPolicy } from '../../src/components/transcript.ts'
import { claudeMarkdownTheme, type MarkdownAnsiTheme } from '../../src/render/markdown.ts'
import {
  PLUGINS_EMPTY,
  PLUGINS_NO_MATCH,
  PLUGINS_UNAVAILABLE,
  PluginsPanel,
} from '../../src/components/plugins-panel.ts'
import { createPalette, markdownTheme } from '../../src/components/theme.ts'
import { formatGoalPrompt, formatSessionStats, GOAL_PROMPT_MAX_WIDTH } from '../../src/chat/session-summary.ts'
import { exportSessionLog } from '../../src/chat/export.ts'
import {
  appendAssistant,
  createTuiTestContext,
  createTuiTestHarness,
  disposeTuiTestHarness,
  tuiEntryAvailable,
  type TuiHarness,
  type TuiHarnessOptions,
} from '../harness.ts'
import { HeadlessTerminal } from '../headless-terminal.ts'

/** Literal editor prefix, so a frame assertion never depends on prompt-value registrations. */
const INPUT_PROMPT = 'parity> '

/** `src/index.ts` is landed by a separate port; without it the end-to-end suite cannot run. */
const entryAvailable = await tuiEntryAvailable()
const skipWithoutEntry = entryAvailable
  ? false
  : 'requires src/index.ts to export createTuiChat(ctx, config, runtime)'

/** A command registered on a fiber, and a panel awaiting its own assembly: outwait both. */
const SETTLE_MS = 60

const palette = createPalette(false)

type ParityHarness = TuiHarness<HeadlessTerminal, (code: number) => void>

/** `TuiController.submit` is the typed-line path; the harness handle only declares disposal. */
interface SubmitHandle {
  submit(text: string): void
}

/**
 * One markdown document exercising the construct the pipelines disagree on:
 * pi draws a `│` quote bar, the claude port a `▎` bar (both draw box tables,
 * so the quote bar is what names the renderer).
 */
const RENDERER_PROBE = '> quoted line\n\n| a | b |\n| - | - |\n| 1 | 2 |'

async function mount(options: TuiHarnessOptions = {}): Promise<ParityHarness> {
  const terminal = new HeadlessTerminal(100, 60)
  const before = terminal.frames
  const harness = await createTuiTestHarness(terminal, () => {}, {
    cwd: '/workspace/project',
    ...options,
    config: {
      title: 'DSH parity',
      ...options.config,
      theme: { color: false, inputPrompt: INPUT_PROMPT, ...options.config?.theme },
    },
  })
  await terminal.waitForFrame(before)
  return harness
}

async function unmount(harness: ParityHarness): Promise<void> {
  await disposeTuiTestHarness(harness)
  await harness.terminal.dispose()
}

/** Run one slash command through the registry the editor submits into. */
async function run(harness: ParityHarness, line: string): Promise<string | undefined> {
  const execution = await harness.ctx.commands.execute(harness.agent, line, AbortSignal.timeout(5_000))
  return execution?.result.text
}

/** Append a `create` goal change, exactly as the goal service commits one. */
function appendGoal(session: Session, objective: string, at = 1_000): void {
  const change: GoalChangeMeta = {
    kind: 'goal/change',
    version: 1,
    operation: 'create',
    goal: { id: GoalId('goal-1'), revision: 1, objective, phase: 'active', maxGoalRounds: 12 },
    roundsStarted: 0,
    createdAt: at,
    updatedAt: at,
  }
  session.append('goal/change', change)
}

const SAMPLE_STATS: SessionStatsProjection = {
  turns: 7,
  steps: 19,
  llmMs: 42_000,
  toolMs: 3_500,
  ttftMs: 2_400,
  ttftSteps: 3,
  decodeMs: 4_000,
  decodeTokens: 480,
}

/** The gateway brands its ids at the Loader boundary and exports no brander. */
function entryId(value: string): PluginEntryId {
  return value as PluginEntryId
}

const SAMPLE_INVENTORY: PluginInventorySnapshot = {
  entries: [
    { entryId: entryId('aaa111'), moduleName: '@deepseek-ai/dsh-agent-loop', enabled: true, fiberPhase: 'active' },
    { entryId: entryId('bbb222'), moduleName: '@deepseek-ai/dsh-web-search', enabled: false, fiberPhase: null },
    { entryId: entryId('ccc333'), moduleName: '@deepseek-ai/dsh-broken', enabled: true, fiberPhase: 'failed' },
  ],
}

describe('assistant body markdown renderer', () => {
  it('falls back to pi and reports the failure exactly once', () => {
    const reported: unknown[] = []
    // A styling function that throws is the port bug this fallback exists for:
    // the pipeline is a hand-port of Claude Code's formatter, and every visual
    // decision in it is one of these functions.
    const broken: MarkdownAnsiTheme = {
      ...claudeMarkdownTheme,
      heading: () => { throw new Error('port bug') },
    }
    const policy: MarkdownPolicy = { mode: 'claude', theme: broken, onError: error => { reported.push(error) } }
    const body = new MarkdownBodyComponent('# Title\n\nanswer body', palette, markdownTheme(palette), policy)

    const rows = body.render(40).join('\n')
    assert.equal(policy.mode, 'pi', 'one failure demotes every later body')
    assert.deepEqual(reported.map(error => (error as Error).message), ['port bug'])
    assert.match(rows, /Title/, 'the body still renders through pi')
    assert.match(rows, /answer body/)

    // The policy is shared, so a body built after the demotion never retries
    // the failing path — and no later render reports a second time.
    const later = new MarkdownBodyComponent('# Later\n\nplain text', palette, markdownTheme(palette), policy)
    assert.match(later.render(40).join('\n'), /plain text/)
    body.render(40)
    assert.equal(reported.length, 1)
  })

  it('renders through the claude pipeline while the policy holds', () => {
    const policy: MarkdownPolicy = {
      mode: 'claude',
      theme: claudeMarkdownTheme,
      onError: () => { assert.fail('the claude pipeline must not fail on ordinary markdown') },
    }
    const body = new MarkdownBodyComponent(RENDERER_PROBE, palette, markdownTheme(palette), policy)
    const frame = body.render(40).join('\n')
    assert.match(frame, /▎ quoted line/)
    // Upstream's MarkdownTable draws box borders with a centered header row.
    assert.match(frame, /┌─────┬─────┐/)
    assert.match(frame, /│ {2}a {2}│ {2}b {2}│/)
  })
})

describe('assistant body renderer selection', { skip: skipWithoutEntry }, () => {
  it('defaults to the claude pipeline', async () => {
    const harness = await mount({
      beforeMount(session) { appendAssistant(session, [{ type: 'text', text: RENDERER_PROBE }]) },
    })
    try {
      const frame = harness.terminal.text()
      assert.match(frame, /▎ quoted line/, `the claude quote bar must reach the transcript:\n${frame}`)
      assert.doesNotMatch(frame, /│ quoted line/, `and pi's quote bar must not:\n${frame}`)
    } finally {
      await unmount(harness)
    }
  })

  it('uses pi when the deployment configures it', async () => {
    const harness = await mount({
      config: { markdownRenderer: 'pi' },
      beforeMount(session) { appendAssistant(session, [{ type: 'text', text: RENDERER_PROBE }]) },
    })
    try {
      const frame = harness.terminal.text()
      assert.match(frame, /│ quoted line/, `markdownRenderer: 'pi' must select pi:\n${frame}`)
      assert.doesNotMatch(frame, /▎ quoted line/)
    } finally {
      await unmount(harness)
    }
  })
})

/** Mount the panel over a fixed 20-row budget and a close spy. */
function pluginsPanel(snapshot: PluginInventorySnapshot | undefined): { panel: PluginsPanel; closed: () => number } {
  let closes = 0
  const panel = new PluginsPanel(snapshot, () => 20, palette, () => { closes += 1 })
  return { panel, closed: () => closes }
}

/** The panel's rows at 80 columns, cursor markers stripped, right-trimmed. */
function panelRows(panel: PluginsPanel): string[] {
  return panel.render(80).map(line => stripTerminalSequences(line).trimEnd())
}

describe('plugin inventory panel', () => {
  it('names the plugin to mount when the inventory is absent', () => {
    const { panel, closed } = pluginsPanel(undefined)
    const rows = panelRows(panel)
    assert.equal(rows[1], ' /plugins')
    assert.equal(rows.at(-1), ' esc close')
    // The message soft-wraps to the panel width, so it is compared re-joined.
    const body = rows.slice(2, -1).map(row => row.trim()).join(' ')
    assert.equal(body, PLUGINS_UNAVAILABLE)
    panel.handleInput('\x1b')
    assert.equal(closed(), 1)
  })

  it('reports no entries as an answer, not as an empty page', () => {
    const { panel } = pluginsPanel({ entries: [] })
    assert.ok(panelRows(panel).includes(` ${PLUGINS_EMPTY}`))
  })

  it('lists every entry in Loader order behind a filter box and a count', () => {
    const { panel } = pluginsPanel(SAMPLE_INVENTORY)
    const rows = panelRows(panel)
    assert.ok(rows[2]?.startsWith(' filter:'), `the Web tab's search box, keyboard-shaped:\n${rows.join('\n')}`)
    assert.equal(rows[3], ' 3/3 entries · 1 active')
    // A disabled entry reports `disabled` whatever its Fiber last did, and an
    // enabled one holding no root Fiber is `inactive` rather than blank; the
    // selection bar opens on the first row.
    assert.deepEqual(rows.slice(4, 7), [
      ' → active    @deepseek-ai/dsh-agent-loop',
      '   disabled  @deepseek-ai/dsh-web-search',
      '   failed    @deepseek-ai/dsh-broken',
    ])
  })

  it('filters by module name or entry id, case-insensitively', () => {
    const { panel } = pluginsPanel(SAMPLE_INVENTORY)
    for (const char of 'WEB') panel.handleInput(char.toLowerCase())
    let rows = panelRows(panel)
    assert.equal(rows[3], ' 1/3 entries · 1 active')
    assert.ok(rows.some(row => row.includes('dsh-web-search')))
    assert.ok(!rows.some(row => row.includes('dsh-agent-loop')))

    // Entry ids match too — that is what the Web tab's search covers.
    panel.handleInput('\x1b')
    for (const char of 'ccc3') panel.handleInput(char)
    rows = panelRows(panel)
    assert.equal(rows[3], ' 1/3 entries · 1 active')
    assert.ok(rows.some(row => row.includes('dsh-broken')))

    panel.handleInput('\x1b')
    for (const char of 'nothing-here') panel.handleInput(char)
    assert.ok(panelRows(panel).includes(` ${PLUGINS_NO_MATCH}`))
  })

  it('opens one entry\'s detail on Enter and collapses it when filtered away', () => {
    const { panel } = pluginsPanel(SAMPLE_INVENTORY)
    panel.handleInput('\r')
    let rows = panelRows(panel)
    // The detail block is the Web card's <dl>: raw entry id, configuration,
    // and the Fiber phase the status word collapsed.
    assert.deepEqual(rows.slice(5, 8), [
      '       entry  aaa111',
      '       config enabled',
      '       cordis active',
    ])

    // A disabled entry's detail has no Fiber phase to report.
    panel.handleInput('\r')
    panel.handleInput('\x1b[B')
    panel.handleInput('\r')
    rows = panelRows(panel)
    assert.ok(rows.some(row => row.includes('config disabled')))
    assert.ok(!rows.some(row => row.includes('cordis')))

    // Filtering the expanded row away collapses it, exactly like the Web tab.
    for (const char of 'loop') panel.handleInput(char)
    panel.handleInput('\x1b')
    rows = panelRows(panel)
    assert.ok(!rows.some(row => row.includes('config disabled')), `the hidden detail must not survive the filter:\n${rows.join('\n')}`)
  })

  it('clears the filter on the first Esc and closes on the second', () => {
    const { panel, closed } = pluginsPanel(SAMPLE_INVENTORY)
    for (const char of 'web') panel.handleInput(char)
    panel.handleInput('\x1b')
    assert.equal(closed(), 0)
    assert.equal(panelRows(panel)[3], ' 3/3 entries · 1 active')
    panel.handleInput('\x1b')
    assert.equal(closed(), 1)
  })
})

describe('TUI /plugins', { skip: skipWithoutEntry }, () => {
  it('registers the command into the same list /help and autocomplete read', async () => {
    const harness = await mount()
    try {
      await delay(SETTLE_MS)
      const names = harness.ctx.commands.list(harness.agent).map(command => command.name)
      assert.ok(names.includes('plugins'), `/plugins must be a registered command: ${names.join(', ')}`)
    } finally {
      await unmount(harness)
    }
  })

  it('opens the Loader entries in a panel', async () => {
    const harness = await mount({
      services: { pluginInventory: { list: (): PluginInventorySnapshot => SAMPLE_INVENTORY } },
    })
    try {
      await delay(SETTLE_MS)
      ;(harness.controller as unknown as SubmitHandle).submit('/plugins')
      await delay(SETTLE_MS)

      const frame = harness.terminal.text()
      assert.match(frame, /\/plugins/, `the panel is titled with the command:\n${frame}`)
      assert.match(frame, /3\/3 entries · 1 active/)
      assert.match(frame, /@deepseek-ai\/dsh-web-search/)
      assert.match(frame, /esc close/)

      // The panel holds the keyboard: typing reaches its filter box, not the
      // editor, and the Esc ladder clears the filter before closing the panel.
      harness.terminal.send('web')
      await delay(SETTLE_MS)
      const filtered = harness.terminal.text()
      assert.match(filtered, /1\/3 entries · 1 active/)
      // The banner's own `[Plugins]` summary sits above the panel and lists the
      // whole inventory, so the filter is asserted on the panel's region only.
      const panel = filtered.slice(filtered.indexOf('/plugins'))
      assert.ok(!panel.includes('dsh-agent-loop'), `the filter must hide non-matches:\n${filtered}`)

      harness.terminal.send('\x1b')
      await delay(SETTLE_MS)
      assert.match(harness.terminal.text(), /3\/3 entries · 1 active/)
      harness.terminal.send('\x1b')
      await delay(SETTLE_MS)
      assert.ok(!harness.terminal.text().includes('entries · 1 active'), 'the second Esc closes the panel')
    } finally {
      await unmount(harness)
    }
  })

  it('explains its own absence instead of opening an empty page', async () => {
    const harness = await mount()
    try {
      await delay(SETTLE_MS)
      ;(harness.controller as unknown as SubmitHandle).submit('/plugins')
      await delay(SETTLE_MS)
      assert.match(harness.terminal.text(), /Plugin inventory is not mounted/)
    } finally {
      await unmount(harness)
    }
  })
})

describe('session summary fragments', () => {
  it('truncates the prompt goal and keeps a non-active phase visible', () => {
    const long = 'ship the terminal parity work end to end before the release train leaves'
    const fragment = formatGoalPrompt({
      id: GoalId('g'), revision: 1, objective: long, phase: 'active', maxGoalRounds: 4,
    })
    assert.ok(fragment !== undefined)
    assert.equal(visibleWidth(fragment), GOAL_PROMPT_MAX_WIDTH)
    assert.ok(fragment.endsWith('…'))
    // No stray escapes: the prompt row wraps this fragment in `dim`, and a
    // reset inside it would end the dim halfway through the row.
    assert.equal(stripTerminalSequences(fragment), fragment)

    assert.equal(formatGoalPrompt({
      id: GoalId('g'), revision: 2, objective: 'short one', phase: 'paused', maxGoalRounds: 4,
    }), 'short one (paused)')
    // A finished goal is not what the next turn is working toward, so the slot
    // empties rather than reporting `complete` forever.
    assert.equal(formatGoalPrompt({
      id: GoalId('g'), revision: 3, objective: 'short one', phase: 'complete', maxGoalRounds: 4,
    }), undefined)
    assert.equal(formatGoalPrompt(undefined), undefined)
  })

  it('formats whole-log figures and omits averages it has no samples for', () => {
    assert.equal(
      formatSessionStats(SAMPLE_STATS),
      '7 turns · 19 steps · model 42.0s · tools 3.5s · ttft 0.8s avg · 120.0 tok/s decode',
    )
    assert.equal(
      formatSessionStats({ ...SAMPLE_STATS, turns: 1, steps: 1, ttftSteps: 0, ttftMs: 0, decodeMs: 0 }),
      '1 turn · 1 step · model 42.0s · tools 3.5s',
    )
  })
})

describe('TUI /status extras', { skip: skipWithoutEntry }, () => {
  it('shows the session goal and the whole-log projection figures', async () => {
    const harness = await mount({
      beforeMount(session) { appendGoal(session, 'land the terminal parity work') },
      services: {
        sessionProjections: {
          snapshot: () => ({ asOfSeq: 3, values: { sessionStats: SAMPLE_STATS } }),
        },
      },
    })
    try {
      await delay(SETTLE_MS)
      ;(harness.controller as unknown as SubmitHandle).submit('/status')
      await delay(SETTLE_MS)

      const frame = harness.terminal.text()
      assert.match(frame, /land the terminal parity work/, `the panel shows the goal in full:\n${frame}`)
      assert.match(frame, /active · round 0\/12/)
      assert.match(frame, /7 turns · 19 steps/, `and the projection's own totals:\n${frame}`)
    } finally {
      await unmount(harness)
    }
  })

  it('omits both rows when the session has no goal and no projection', async () => {
    const harness = await mount()
    try {
      await delay(SETTLE_MS)
      ;(harness.controller as unknown as SubmitHandle).submit('/status')
      await delay(SETTLE_MS)
      const frame = harness.terminal.text()
      assert.match(frame, /Session status/)
      assert.doesNotMatch(frame, /Goal state/)
      assert.doesNotMatch(frame, /Session totals/)
      // No permission service is mounted here, so the preset row says nothing
      // rather than inventing a policy this deployment does not enforce.
      assert.doesNotMatch(frame, /Permission:/)
    } finally {
      await unmount(harness)
    }
  })

  it('names the permission preset the session decides tool calls under', async () => {
    const harness = await mount({
      services: {
        approval: {
          config: { policy: 'ask' },
          // The session's own logged override is what an ask resolves under, so
          // it is what the panel reports — not the deployment default beneath it.
          overrideOf: () => 'never',
        },
      },
    })
    try {
      await delay(SETTLE_MS)
      ;(harness.controller as unknown as SubmitHandle).submit('/status')
      await delay(SETTLE_MS)
      assert.match(harness.terminal.text(), /Permission:\s+never/, `the preset row:\n${harness.terminal.text()}`)
    } finally {
      await unmount(harness)
    }
  })

  it('falls back to the deployment default when the session never switched', async () => {
    const harness = await mount({
      services: { approval: { config: { policy: 'ask' }, overrideOf: () => undefined } },
    })
    try {
      await delay(SETTLE_MS)
      ;(harness.controller as unknown as SubmitHandle).submit('/status')
      await delay(SETTLE_MS)
      assert.match(harness.terminal.text(), /Permission:\s+ask/)
    } finally {
      await unmount(harness)
    }
  })

  it('prints no row for a permission service that reports no preset at all', async () => {
    // A service from another version: the reader shape-checks rather than
    // trusting the seam, so an unreadable preset degrades to silence.
    const harness = await mount({ services: { approval: { policyOf: () => 'ask' } } })
    try {
      await delay(SETTLE_MS)
      ;(harness.controller as unknown as SubmitHandle).submit('/status')
      await delay(SETTLE_MS)
      assert.match(harness.terminal.text(), /Session status/)
      assert.doesNotMatch(harness.terminal.text(), /Permission:/)
    } finally {
      await unmount(harness)
    }
  })
})

describe('upstream session-log-export is Web-only', () => {
  it('acknowledges /export without producing anything a terminal can open', async () => {
    const { ctx, agent } = await createTuiTestContext({ cwd: '/workspace/project' })
    try {
      await ctx.plugin(sessionLogDownload)
      const execution = await ctx.commands.execute(agent, '/export', AbortSignal.timeout(5_000))
      // The whole host half of that plugin: a sentence. The ZIP comes from
      // `GET /api/session.export` in @deepseek-ai/dsh-host-apiproxy, and a
      // browser plugin watching this result is what saves it — neither exists
      // in a terminal, so nothing lands and no path is reported.
      assert.equal(execution?.result.kind, 'success')
      assert.equal(execution?.result.text, 'Session log download requested.')
      assert.doesNotMatch(execution?.result.text ?? '', /[/\\]/, 'the Web result carries no path at all')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('cannot share a profile with a second global /export', async () => {
    const { ctx, agent } = await createTuiTestContext({ cwd: '/workspace/project' })
    try {
      ctx.commands.register({
        name: 'export',
        description: 'local export',
        handler: () => ({ kind: 'success', text: 'local' }),
      })
      // The registry refuses a duplicate global name outright. This is why the
      // bundle patch mounts exactly one `/export`: the TUI's, which delivers a
      // file. Only a plugin mounted under an agent's own context may shadow.
      await assert.rejects(
        async () => { await ctx.plugin(sessionLogDownload) },
        /command "export" is already registered/,
      )
      const execution = await ctx.commands.execute(agent, '/export', AbortSignal.timeout(5_000))
      assert.equal(execution?.result.text, 'local')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('TUI /export', { skip: skipWithoutEntry }, () => {
  it('writes the session log and reports the absolute path it landed on', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-tui-export-'))
    const harness = await mount({
      cwd: workspace,
      config: { sessionId: 'export-session' },
      beforeMount(session) { appendAssistant(session, [{ type: 'text', text: 'exported answer' }]) },
    })
    try {
      await delay(SETTLE_MS)
      const text = await run(harness, '/export')
      const expected = join(workspace, 'dsh-session-export-session.jsonl')
      assert.equal(text, `Session log exported to ${expected}`)

      const lines = (await readFile(expected, 'utf8')).trimEnd().split('\n')
      const header = JSON.parse(lines[0] ?? '') as { type: string; id: string }
      assert.equal(header.type, 'session')
      assert.equal(header.id, 'export-session')
      const types = lines.slice(1).map(line => (JSON.parse(line) as { type: string }).type)
      // `command/run` is the registry's own lifecycle append, written before
      // the handler ran — the export carries the log as it stood, not a
      // curated view of it.
      assert.deepEqual(types, ['turn/start', 'step/start', 'assistant/message', 'command/run'])
    } finally {
      await unmount(harness)
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('accepts a destination and prefers the backend\'s verbatim artifact', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-tui-export-'))
    const harness = await mount({
      cwd: workspace,
      services: {
        sessionPersistence: {
          supportsRawArtifacts: true,
          readRaw: () => Promise.resolve({ filename: 'backend.jsonl', content: 'verbatim backend bytes\n' }),
        },
      },
    })
    const flushed: string[] = []
    const offFlush = harness.ctx.on('session/flush', (session: Session) => { flushed.push(session.id) })
    try {
      await delay(SETTLE_MS)
      // A relative destination resolves against the workspace, never the
      // process cwd, so `/export` writes where the session lives.
      const missingDir = await run(harness, '/export logs/copy.jsonl')
      assert.match(missingDir ?? '', /^Session log export failed: /)
      assert.match(missingDir ?? '', new RegExp(join(workspace, 'logs/copy.jsonl').replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')))

      const accepted = await run(harness, '/export copy.jsonl')
      const expected = join(workspace, 'copy.jsonl')
      assert.equal(accepted, `Session log exported to ${expected}`)
      // The backend's own bytes, not a re-serialization of the live log.
      assert.equal(await readFile(expected, 'utf8'), 'verbatim backend bytes\n')
      assert.equal(flushed.length, 2, 'each export crosses the durability barrier before reading')
    } finally {
      offFlush()
      await unmount(harness)
      await rm(workspace, { recursive: true, force: true })
    }
  })
})

describe('TUI /export over an existing file', { skip: skipWithoutEntry }, () => {
  /** Enter, which takes the highlighted option of a question dialog. */
  const ENTER = '\r'
  /** Esc, which cancels a question dialog without answering it. */
  const ESC = '\x1b'

  /**
   * Export onto a path that already has a file, and answer the confirmation
   * with one key.
   *
   * The command promise cannot be awaited before the key is sent: the handler
   * is blocked on the dialog, which is the behavior under test.
   * @param harness - the mounted terminal.
   * @param line - the `/export` line to run.
   * @param key - the key to answer the confirmation with.
   * @returns the notice text the command settled with.
   */
  async function exportAnswering(
    harness: ParityHarness,
    line: string,
    key: string,
  ): Promise<string | undefined> {
    const pending = run(harness, line)
    await delay(SETTLE_MS)
    // Collapsed: the path is long enough to wrap, and where it wraps is the
    // dialog's business.
    const frame = harness.terminal.text().replace(/\s+/gu, ' ')
    assert.match(frame, /already exists\. Replace it\?/u, frame)
    harness.terminal.send(key)
    return await pending
  }

  it('asks before replacing a file and writes only after a yes', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-tui-export-'))
    const harness = await mount({
      cwd: workspace,
      config: { sessionId: 'overwrite-session' },
      beforeMount(session) { appendAssistant(session, [{ type: 'text', text: 'first answer' }]) },
    })
    const destination = join(workspace, 'dsh-session-overwrite-session.jsonl')
    try {
      await delay(SETTLE_MS)
      assert.equal(await run(harness, '/export'), `Session log exported to ${destination}`)
      const first = await readFile(destination, 'utf8')

      // The default destination is one path per session, so the second export
      // of a session always lands on the first one's file: the common case for
      // this command, and the one where a silent write loses a file.
      const replaced = await exportAnswering(harness, '/export', ENTER)
      assert.equal(replaced, `Session log exported to ${destination} (replaced)`)
      const second = await readFile(destination, 'utf8')
      assert.notEqual(second, first, 'the confirmed write really replaced the file')
    } finally {
      await unmount(harness)
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('leaves the file alone when the confirmation is cancelled', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-tui-export-'))
    const harness = await mount({ cwd: workspace, config: { sessionId: 'keep-session' } })
    const destination = join(workspace, 'keep.jsonl')
    try {
      await delay(SETTLE_MS)
      await writeFile(destination, 'not a session log\n', 'utf8')
      const cancelled = await exportAnswering(harness, '/export keep.jsonl', ESC)
      assert.equal(cancelled, `Session log export cancelled; ${destination} was left unchanged.`)
      assert.equal(await readFile(destination, 'utf8'), 'not a session log\n')
    } finally {
      await unmount(harness)
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('refuses rather than replacing when nothing can ask', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-tui-export-'))
    const destination = join(workspace, 'kept.jsonl')
    try {
      await writeFile(destination, 'not a session log\n', 'utf8')
      const { ctx, session } = await createTuiTestContext({ cwd: workspace })
      // An embedder with no surface to ask on: consent is absent, and absent
      // consent is a no.
      const result = await exportSessionLog(
        { persistence: undefined, sessions: undefined, cwd: workspace },
        session,
        'kept.jsonl',
        AbortSignal.timeout(5_000),
      )
      assert.equal(result.kind, 'error')
      assert.match(result.text ?? '', /already exists and nothing here can ask/u)
      assert.equal(await readFile(destination, 'utf8'), 'not a session log\n')
      await ctx.fiber.dispose()
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })
})

describe('session rename and fork', { skip: skipWithoutEntry }, () => {
  it('has no command to bind: they exist only as ApiProxy RPC methods', async () => {
    const harness = await mount()
    try {
      await delay(SETTLE_MS)
      const names = harness.ctx.commands.list(harness.agent).map(command => command.name)
      // `sessions.rename` and `sessions.fork` live in
      // @deepseek-ai/dsh-host-apiproxy as Remote methods the Web client calls;
      // no package registers them on `ctx.commands`. A TUI binding would have
      // to reach the ApiProxy, which a terminal profile does not mount.
      assert.ok(!names.includes('rename'), `nothing registers /rename: ${names.join(', ')}`)
      assert.ok(!names.includes('fork'), `nothing registers /fork: ${names.join(', ')}`)
    } finally {
      await unmount(harness)
    }
  })
})

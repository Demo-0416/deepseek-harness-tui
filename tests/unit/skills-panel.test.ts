/**
 * `/skills`: the searchable catalog panel and the entry-side wiring that fills
 * it.
 *
 * The panel is asserted directly (filter, empty catalog, the detail view's
 * loading and failure states), and the command is asserted end to end over the
 * same layered registry `/skill:` reads — the pair that makes the panel name
 * what this agent actually composes rather than what it composed at mount.
 * @module dsh-tui/tests/unit/skills-panel
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { stripTerminalSequences } from '@earendil-works/pi-tui'
import type { SkillDefinition, SkillSummary } from '@deepseek-ai/dsh-skill'
import {
  SKILL_MODEL_ONLY,
  SKILLS_EMPTY,
  SKILLS_LOADING,
  SKILLS_NO_MATCH,
  SKILLS_UNAVAILABLE,
  SkillsPanel,
  skillBodyTruncated,
  type SkillDetailState,
} from '../../src/components/skills-panel.ts'
import { createPalette } from '../../src/components/theme.ts'
import {
  createTuiTestHarness,
  disposeTuiTestHarness,
  tuiEntryAvailable,
  type TuiHarness,
  type TuiHarnessOptions,
} from '../harness.ts'
import { HeadlessTerminal } from '../headless-terminal.ts'

const palette = createPalette(false)

/** `src/index.ts` is landed by a separate port; without it the end-to-end suite cannot run. */
const entryAvailable = await tuiEntryAvailable()
const skipWithoutEntry = entryAvailable
  ? false
  : 'requires src/index.ts to export createTuiChat(ctx, config, runtime)'

/** A command registered on a fiber, plus one provider read: outwait both. */
const SETTLE_MS = 60

/** One discovered skill, with only the fields the panel reads spelled out. */
function summary(name: string, description: string, userInvocable = true): SkillSummary {
  return {
    name,
    description,
    invocation: { modelInvocable: true, userInvocable },
    source: 'user-dsh',
    provider: 'filesystem',
  }
}

/** The catalog every panel case below filters, in the order the caller supplies. */
const SAMPLE_SKILLS: readonly SkillSummary[] = [
  summary('lark-doc', 'Read and edit Feishu documents'),
  summary('meego-tech-story', 'Create a technical story in Meego'),
  summary('trace-router', 'Route a trace to its owning service', false),
]

/** Mount the panel over a fixed 20-row budget, with spies for both callbacks. */
function skillsPanel(skills: readonly SkillSummary[] | undefined): {
  panel: SkillsPanel
  closed: () => number
  opened: () => readonly string[]
} {
  let closes = 0
  const opens: string[] = []
  const panel = new SkillsPanel(
    skills,
    () => 20,
    palette,
    (name) => { opens.push(name) },
    () => { closes += 1 },
  )
  return { panel, closed: () => closes, opened: () => opens }
}

/** The panel's rows at 80 columns, cursor markers stripped, right-trimmed. */
function panelRows(panel: SkillsPanel): string[] {
  return panel.render(80).map(line => stripTerminalSequences(line).trimEnd())
}

/** Type one string into the panel, one keystroke at a time. */
function type(panel: SkillsPanel, text: string): void {
  for (const char of text) panel.handleInput(char)
}

describe('skills panel', () => {
  it('waits on its own line instead of claiming an empty catalog', () => {
    const { panel } = skillsPanel(undefined)
    const rows = panelRows(panel)
    assert.equal(rows[1], ' /skills')
    assert.equal(rows[2], ` ${SKILLS_LOADING}`)
    // A still-loading panel must not answer with the empty catalog's sentence:
    // "no skills" and "not yet read" are different facts.
    assert.ok(!rows.includes(` ${SKILLS_EMPTY}`))
  })

  it('reports an empty catalog as an answer, not as an empty page', () => {
    const { panel, closed } = skillsPanel([])
    const rows = panelRows(panel)
    assert.ok(rows.includes(` ${SKILLS_EMPTY}`), rows.join('\n'))
    assert.equal(rows.at(-1), ' esc close')
    panel.handleInput('\x1b')
    assert.equal(closed(), 1)
  })

  it('lists every skill behind a filter box and a count', () => {
    const { panel } = skillsPanel(SAMPLE_SKILLS)
    const rows = panelRows(panel)
    assert.ok(rows[2]?.startsWith(' filter:'), `the catalog is searchable:\n${rows.join('\n')}`)
    assert.equal(rows[3], ' 3/3 skills · 2 user invocable')
    // Name column, then the routing description; a skill the user cannot
    // invoke says so, because `/skill:` will refuse it.
    assert.deepEqual(rows.slice(4, 7), [
      ' → lark-doc          Read and edit Feishu documents',
      '   meego-tech-story  Create a technical story in Meego',
      `   trace-router      Route a trace to its owning service  ${SKILL_MODEL_ONLY}`,
    ])
  })

  it('filters by name or description, case-insensitively', () => {
    const { panel } = skillsPanel(SAMPLE_SKILLS)
    type(panel, 'MEE')
    let rows = panelRows(panel)
    assert.equal(rows[3], ' 1/3 skills · 2 user invocable')
    assert.ok(rows.some(row => row.includes('meego-tech-story')))
    assert.ok(!rows.some(row => row.includes('lark-doc')))

    // The description is on screen, so it is searchable too — a user looking
    // for "the Feishu one" does not have to know the skill's name.
    panel.handleInput('\x1b')
    type(panel, 'feishu')
    rows = panelRows(panel)
    assert.equal(rows[3], ' 1/3 skills · 2 user invocable')
    assert.ok(rows.some(row => row.includes('lark-doc')))

    panel.handleInput('\x1b')
    type(panel, 'nothing-here')
    assert.ok(panelRows(panel).includes(` ${SKILLS_NO_MATCH}`))
  })

  it('clears the filter on the first Esc and closes on the second', () => {
    const { panel, closed } = skillsPanel(SAMPLE_SKILLS)
    type(panel, 'mee')
    panel.handleInput('\x1b')
    assert.equal(closed(), 0)
    assert.equal(panelRows(panel)[3], ' 3/3 skills · 2 user invocable')
    panel.handleInput('\x1b')
    assert.equal(closed(), 1)
  })

  it('asks for the selected skill\'s body on Enter and shows it', () => {
    const { panel, opened } = skillsPanel(SAMPLE_SKILLS)
    panel.handleInput('\x1b[B')
    panel.handleInput('\r')
    assert.deepEqual(opened(), ['meego-tech-story'])
    // Until the body lands the detail view says what it is doing; the list's
    // count line is gone, so the reader is unambiguously somewhere else.
    let rows = panelRows(panel)
    assert.equal(rows[2], ' Loading skill…')
    assert.ok(!rows.some(row => row.includes('3/3 skills')))

    panel.setDetail('meego-tech-story', {
      kind: 'ready',
      skill: {
        ...summary('meego-tech-story', 'Create a technical story in Meego'),
        content: '# Meego\n\nFill the required fields first.',
      },
    })
    rows = panelRows(panel)
    assert.equal(rows[2], ' meego-tech-story')
    assert.ok(rows.includes(' user-dsh · filesystem · user invocable'), rows.join('\n'))
    assert.ok(rows.includes(' Fill the required fields first.'), rows.join('\n'))
    assert.equal(rows.at(-1), ' ↑↓ scroll · esc back')

    // Esc leaves the skill, not the panel: the search that found it is still
    // there when the reader comes back.
    panel.handleInput('\x1b')
    assert.equal(panelRows(panel)[3], ' 3/3 skills · 2 user invocable')
  })

  it('shows a failed body load in place, without closing the panel', () => {
    const { panel, closed } = skillsPanel(SAMPLE_SKILLS)
    panel.handleInput('\r')
    const failure: SkillDetailState = {
      kind: 'failed',
      message: 'Skill "lark-doc" failed to load: ENOENT: no such file',
    }
    panel.setDetail('lark-doc', failure)
    const rows = panelRows(panel)
    assert.ok(
      rows.some(row => row.includes('Skill "lark-doc" failed to load: ENOENT: no such file')),
      `a lookup failure is the detail view's own state:\n${rows.join('\n')}`,
    )
    assert.equal(closed(), 0)
    // And it is still only one Esc from the catalog it was opened from.
    panel.handleInput('\x1b')
    assert.equal(panelRows(panel)[3], ' 3/3 skills · 2 user invocable')
  })

  it('drops a body that arrives for a skill the reader already left', () => {
    const { panel } = skillsPanel(SAMPLE_SKILLS)
    panel.handleInput('\r')
    panel.handleInput('\x1b')
    panel.setDetail('lark-doc', {
      kind: 'ready',
      skill: { ...summary('lark-doc', 'Read and edit Feishu documents'), content: 'late body' },
    })
    // The reader is back on the list; a settled read from the view they closed
    // must not paint itself over it.
    assert.equal(panelRows(panel)[3], ' 3/3 skills · 2 user invocable')
  })

  it('cuts an oversized body and says how much it kept', () => {
    const lines = Array.from({ length: 900 }, (_, index) => `line ${String(index + 1)}`)
    const { panel } = skillsPanel(SAMPLE_SKILLS)
    panel.handleInput('\r')
    panel.setDetail('lark-doc', {
      kind: 'ready',
      skill: {
        ...summary('lark-doc', 'Read and edit Feishu documents'),
        content: lines.join('\n'),
        path: '/workspace/.dsh/skills/lark-doc/SKILL.md',
      },
    })
    // `G` reaches the notice, not line 900: the panel is a place to recognize
    // a skill, and it names the file that holds the rest.
    panel.handleInput('G')
    const rows = panelRows(panel)
    // The notice soft-wraps to the panel width, so it is compared re-joined.
    const body = rows.map(row => row.trim()).join(' ')
    assert.ok(
      body.includes(skillBodyTruncated(900, '/workspace/.dsh/skills/lark-doc/SKILL.md')),
      rows.join('\n'),
    )
    assert.ok(!rows.some(row => row.trim() === 'line 500'))
  })
})

type SkillsHarness = TuiHarness<HeadlessTerminal, (code: number) => void>

interface SubmitHandle {
  submit(text: string): void
}

/** A `skills` service over a fixed catalog, with a per-name body outcome. */
function skillsService(
  skills: readonly SkillSummary[],
  body: (name: string) => Promise<SkillDefinition | undefined>,
): unknown {
  return {
    list: () => Promise.resolve([...skills]),
    snapshot: () => Promise.resolve({ skills: [...skills], complete: true }),
    get: (name: string) => body(name),
  }
}

async function mount(options: TuiHarnessOptions = {}): Promise<SkillsHarness> {
  const terminal = new HeadlessTerminal(100, 40)
  const before = terminal.frames
  const harness = await createTuiTestHarness(terminal, () => {}, {
    cwd: '/workspace/project',
    ...options,
    config: {
      title: 'DSH skills',
      ...options.config,
      theme: { color: false, inputPrompt: 'skills> ', ...options.config?.theme },
    },
  })
  await terminal.waitForFrame(before)
  return harness
}

async function unmount(harness: SkillsHarness): Promise<void> {
  await disposeTuiTestHarness(harness)
  await harness.terminal.dispose()
}

describe('TUI /skills', { skip: skipWithoutEntry }, () => {
  it('registers the command into the same list /help and autocomplete read', async () => {
    const harness = await mount({ services: { skills: skillsService(SAMPLE_SKILLS, () => Promise.resolve(undefined)) } })
    try {
      await delay(SETTLE_MS)
      const names = harness.ctx.commands.list(harness.agent).map(command => command.name)
      assert.ok(names.includes('skills'), `/skills must be a registered command: ${names.join(', ')}`)
    } finally {
      await unmount(harness)
    }
  })

  it('opens the catalog and reads one skill\'s body', async () => {
    const harness = await mount({
      services: {
        skills: skillsService(SAMPLE_SKILLS, name => Promise.resolve({
          ...summary(name, 'Read and edit Feishu documents'),
          content: 'The body only the detail view loads.',
        })),
      },
    })
    try {
      await delay(SETTLE_MS)
      ;(harness.controller as unknown as SubmitHandle).submit('/skills')
      await delay(SETTLE_MS)
      let frame = harness.terminal.text()
      assert.match(frame, /\/skills/, `the panel is titled with the command:\n${frame}`)
      assert.match(frame, /3\/3 skills · 2 user invocable/)
      assert.match(frame, /meego-tech-story/)

      // The panel holds the keyboard: typing reaches its filter box, and Enter
      // asks the registry for the selected skill's body.
      harness.terminal.send('lark')
      await delay(SETTLE_MS)
      assert.match(harness.terminal.text(), /1\/3 skills/)
      harness.terminal.send('\r')
      await delay(SETTLE_MS)
      frame = harness.terminal.text()
      assert.match(frame, /The body only the detail view loads\./, `the loaded body reaches the screen:\n${frame}`)
    } finally {
      await unmount(harness)
    }
  })

  it('reports a body that will not load, in the panel that asked for it', async () => {
    const harness = await mount({
      services: {
        skills: skillsService(SAMPLE_SKILLS, () => Promise.reject(new Error('provider is offline'))),
      },
    })
    try {
      await delay(SETTLE_MS)
      ;(harness.controller as unknown as SubmitHandle).submit('/skills')
      await delay(SETTLE_MS)
      harness.terminal.send('\r')
      await delay(SETTLE_MS)
      const frame = harness.terminal.text()
      assert.match(frame, /failed to load/, `the failure is shown where it was asked for:\n${frame}`)
      assert.match(frame, /provider is offline/)
    } finally {
      await unmount(harness)
    }
  })

  it('says skills are unavailable rather than opening an empty panel', async () => {
    const harness = await mount()
    try {
      await delay(SETTLE_MS)
      ;(harness.controller as unknown as SubmitHandle).submit('/skills')
      await delay(SETTLE_MS)
      const frame = harness.terminal.text()
      assert.ok(frame.includes(SKILLS_UNAVAILABLE), `a skill-less deployment is told so:\n${frame}`)
      assert.ok(!frame.includes('user invocable'), 'no catalog panel is opened')
    } finally {
      await unmount(harness)
    }
  })
})

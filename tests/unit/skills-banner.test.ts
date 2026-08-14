/**
 * Entry-side wiring of the banner's skill list: the one skill scan that feeds
 * slash-command autocomplete also fills what the header renders.
 *
 * The banner's own rendering is covered by the header suite; what is asserted
 * here is only what the entry decides — that the list is the user-invocable
 * skills, that it reaches a banner already on screen (discovery is
 * asynchronous while the header renders from mount), and that the header is
 * handed the whole catalog, which is what makes its `+N more` true.
 * @module dsh-tui/tests/unit/skills-banner
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import type { SkillSummary } from '@deepseek-ai/dsh-skill'
import {
  createTuiTestHarness,
  disposeTuiTestHarness,
  tuiEntryAvailable,
  type TuiHarness,
  type TuiHarnessOptions,
} from '../harness.ts'
import { HeadlessTerminal } from '../headless-terminal.ts'

/** `src/index.ts` is landed by a separate port; without it the end-to-end suite cannot run. */
const entryAvailable = await tuiEntryAvailable()
const skipWithoutEntry = entryAvailable
  ? false
  : 'requires src/index.ts to export createTuiChat(ctx, config, runtime)'

/** Skill discovery settles after the first frame; outwait it. */
const SETTLE_MS = 60

/** A catalog far larger than any banner row budget, so a remainder is certain. */
const CATALOG_SKILLS = 80

type BannerHarness = TuiHarness<HeadlessTerminal, (code: number) => void>

/** One discovered skill, with only the fields the entry reads spelled out. */
function summary(name: string, userInvocable = true): SkillSummary {
  return {
    name,
    description: `does ${name}`,
    invocation: { modelInvocable: true, userInvocable },
    source: 'user-dsh',
    provider: 'test',
  }
}

/** A `skills` service whose catalog is fixed and complete. */
function skillsService(skills: readonly SkillSummary[]): unknown {
  return {
    list: () => Promise.resolve([...skills]),
    snapshot: () => Promise.resolve({ skills: [...skills], complete: true }),
    get: (name: string) => Promise.resolve(
      skills.some(skill => skill.name === name)
        ? { ...summary(name), content: `body of ${name}` }
        : undefined,
    ),
  }
}

/**
 * An `agentPresets` roster whose standing skill mount differs per preset, which
 * is the composition a `/preset` switch actually walks into: `serviceFor`
 * returns the value of whichever mount the agent's scope points at when it is
 * called, so a caller that resolved once at mount keeps reading the preset the
 * session opened on.
 * @param catalogs - one skill catalog per preset id.
 * @param initial - the preset the session opens on.
 * @returns the service to provide, and a reader for the preset it now serves.
 */
function presetRoster(
  catalogs: Readonly<Record<string, readonly SkillSummary[]>>,
  initial: string,
): { service: unknown; current: () => string } {
  let current = initial
  const row = (id: string): { id: string; path: string } => ({
    id,
    path: `/deployment/agent-presets/${id}/agent.cordis.yml`,
  })
  const service = {
    get defaultId(): string {
      return initial
    },
    get authorable(): boolean {
      return false
    },
    list: () => Promise.resolve(Object.keys(catalogs).map(id => row(id))),
    resolve: (id?: string) => Promise.resolve(row(id ?? current)),
    mount: (_agentCtx: unknown, id?: string) => Promise.resolve(row(id ?? current)),
    recompose: (_agentCtx: unknown, id: string) => {
      current = id
      return Promise.resolve(row(id))
    },
    serviceFor: (_agent: unknown, service_: string) => service_ === 'skills'
      ? skillsService(catalogs[current] ?? [])
      : undefined,
  }
  return { service, current: () => current }
}

async function mount(options: TuiHarnessOptions = {}): Promise<BannerHarness> {
  const terminal = new HeadlessTerminal(100, 32)
  const before = terminal.frames
  const harness = await createTuiTestHarness(terminal, () => {}, {
    cwd: '/workspace/project',
    ...options,
    config: {
      title: 'DSH banner',
      ...options.config,
      theme: { color: false, inputPrompt: 'banner> ', ...options.config?.theme },
    },
  })
  await terminal.waitForFrame(before)
  return harness
}

describe('banner skill list', { skip: skipWithoutEntry }, () => {
  it('lists the user-invocable skills once discovery settles', async () => {
    const harness = await mount({
      services: {
        skills: skillsService([
          summary('lark-doc'),
          summary('meego-tech-story'),
          summary('internal-only', false),
        ]),
      },
    })
    try {
      await delay(SETTLE_MS)
      const frame = harness.terminal.text()
      assert.match(frame, /lark-doc/, `a settled scan reaches the mounted banner:\n${frame}`)
      assert.match(frame, /meego-tech-story/)
      // The banner is a menu of what the user can invoke; a model-only skill is
      // not on it, exactly as it is not in slash-command autocomplete.
      assert.doesNotMatch(frame, /internal-only/)
    } finally {
      await disposeTuiTestHarness(harness)
      await harness.terminal.dispose()
    }
  })

  it('counts every skill it left out, so `+N more` is the whole catalog', async () => {
    const skills = Array.from(
      { length: CATALOG_SKILLS },
      (_, index) => summary(`skill-${String(index + 1).padStart(2, '0')}`),
    )
    const harness = await mount({ services: { skills: skillsService(skills) } })
    try {
      await delay(SETTLE_MS)
      const frame = harness.terminal.text()
      assert.match(frame, /skill-01/)
      // The banner packs what fits its own row budget and counts the rest. The
      // entry hands it the whole catalog: a cut on the way in made the header
      // count a remainder against a list it had already been trimmed to, so a
      // workspace with 80 skills was told 20 of them did not exist.
      const listed = [...frame.matchAll(/skill-\d\d/gu)].length
      const remainder = Number(/\+(\d+) more/u.exec(frame)?.[1] ?? '0')
      assert.ok(listed < CATALOG_SKILLS, `the banner is an opening line, not a catalog:\n${frame}`)
      assert.equal(
        listed + remainder,
        CATALOG_SKILLS,
        `packed ${String(listed)} and claimed ${String(remainder)} more of ${String(CATALOG_SKILLS)}:\n${frame}`,
      )
    } finally {
      await disposeTuiTestHarness(harness)
      await harness.terminal.dispose()
    }
  })
})

describe('skills after a preset switch', { skip: skipWithoutEntry }, () => {
  const CATALOGS = {
    standard: [summary('standard-only')],
    code: [summary('code-only')],
  }

  /**
   * A blank session on the `standard` preset, over a roster that serves a
   * different skill catalog per preset.
   * @returns the mounted terminal and the roster's current-preset reader.
   */
  async function mountOnStandard(): Promise<{ harness: BannerHarness; current: () => string }> {
    const roster = presetRoster(CATALOGS, 'standard')
    const harness = await mount({
      // Blank: `/preset` only re-links a session that has not started a turn.
      omitInitialLifecycle: true,
      services: { agentPresets: roster.service },
    })
    await delay(SETTLE_MS)
    return { harness, current: roster.current }
  }

  it('lists the newly selected preset\'s skills, not the one the session opened on', async () => {
    const { harness, current } = await mountOnStandard()
    try {
      assert.match(harness.terminal.text(), /standard-only/u)
      await harness.ctx.commands.execute(harness.agent, '/preset code', AbortSignal.timeout(5_000))
      await delay(SETTLE_MS)
      assert.equal(current(), 'code', 'the roster re-linked the agent scope')
      const frame = harness.terminal.text()
      // `serviceFor` hands back the value of the standing mount at call time,
      // so a registry captured once at mount keeps serving the old preset, and
      // the menu names skills this agent does not compose.
      assert.match(frame, /code-only/u, `the banner names the new preset's skills:\n${frame}`)
      assert.doesNotMatch(frame, /standard-only/u, `the old preset's skills are gone:\n${frame}`)
    } finally {
      await disposeTuiTestHarness(harness)
      await harness.terminal.dispose()
    }
  })

  it('invokes a skill of the preset the session now runs', async () => {
    const { harness } = await mountOnStandard()
    const submit = harness.controller as unknown as { submit(text: string): void }
    try {
      await harness.ctx.commands.execute(harness.agent, '/preset code', AbortSignal.timeout(5_000))
      await delay(SETTLE_MS)
      submit.submit('/skill:code-only')
      await delay(SETTLE_MS)
      // The lookup, not just the menu: a stale registry answers this with
      // "Unknown skill" for a skill the running preset does supply.
      const text = (messages: readonly { content: readonly { type: string; text?: string }[] }[]): string[] =>
        messages.map(message => message.content
          .map(block => block.type === 'text' ? block.text ?? '' : '')
          .join(''))
      const delivered = text(harness.agent.followups)
      assert.equal(delivered.length, 1, `the skill was delivered as a turn:\n${harness.terminal.text()}`)
      assert.equal(delivered[0], '/skill:code-only', 'the turn is the command-line echo')
      const injected = text(harness.agent.injected)
      assert.match(injected[0] ?? '', /<skill_content name="code-only">/u)
      assert.match(injected[0] ?? '', /body of code-only/u)
    } finally {
      await disposeTuiTestHarness(harness)
      await harness.terminal.dispose()
    }
  })
})

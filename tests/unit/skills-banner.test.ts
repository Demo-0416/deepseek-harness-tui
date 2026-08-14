/**
 * Entry-side wiring of the banner's skill list: the one skill scan that feeds
 * slash-command autocomplete also fills what the header renders.
 *
 * The banner's own rendering is covered by the header suite; what is asserted
 * here is only what the entry decides — that the list is the user-invocable
 * skills, that it reaches a banner already on screen (discovery is
 * asynchronous while the header renders from mount), and that a catalog too
 * long to open a session with is cut off.
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

/** The entry's own cap on how many skill names the banner is handed. */
const MAX_BANNER_SKILLS = 60

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
    get: () => Promise.resolve(undefined),
  }
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

  it('truncates a catalog too long to open a session with', async () => {
    const skills = Array.from({ length: 80 }, (_, index) => summary(`skill-${String(index + 1).padStart(2, '0')}`))
    const harness = await mount({ services: { skills: skillsService(skills) } })
    try {
      await delay(SETTLE_MS)
      const frame = harness.terminal.text()
      assert.match(frame, /skill-01/)
      assert.doesNotMatch(frame, /skill-61/, `nothing past the cut may reach the banner:\n${frame}`)
      // The banner counts the remainder from what it was handed, so the names
      // on screen plus the remainder are the cut, not the catalog — whatever
      // width-dependent packing the banner chose.
      const listed = [...frame.matchAll(/skill-\d\d/gu)].length
      const remainder = Number(/\+(\d+) more/u.exec(frame)?.[1] ?? '0')
      assert.equal(listed + remainder, MAX_BANNER_SKILLS, `packed ${String(listed)} of a 60-name cut:\n${frame}`)
    } finally {
      await disposeTuiTestHarness(harness)
      await harness.terminal.dispose()
    }
  })
})

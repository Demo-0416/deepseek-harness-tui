/**
 * The Shift+Tab mode cycle: the ladder's arithmetic, the badges it lights, and
 * the scopes it must stay out of.
 *
 * The cycle is a composition of two harness services this bundle does not own,
 * so the cases come in two shapes. The pure ones drive {@link nextMode} over
 * fabricated axes, which is where the ladder's order and its two holes
 * (`danger-full-access` is not a rung; a missing service collapses its rung)
 * are decided. The mounted ones press the real key through a real terminal
 * against fake services, which is the only boundary where "the key works"
 * means anything: the bytes have to survive pi-tui's parser, the app's input
 * listener, and whichever overlay owns the screen.
 * @module dsh-tui/tests/unit/modes
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import {
  createTuiTestHarness,
  disposeTuiTestHarness,
  tuiEntryAvailable,
  type TuiHarness,
  type TuiHarnessOptions,
} from '../harness.ts'
import { HeadlessTerminal } from '../headless-terminal.ts'
import {
  AUTO_ACCEPT_PRESET,
  currentMode,
  nextMode,
  NORMAL_PRESET,
  type ModeAxes,
} from '../../src/chat/modes.ts'
import { autoAcceptRow, planModeRow } from '../../src/components/transcript.ts'
import { createPalette } from '../../src/components/theme.ts'
import { claudeSchemeColors } from '../../src/render/palette.ts'

/** The four presets this bundle's `cordis.patch.yml` configures. */
const PRESETS = ['read-only', NORMAL_PRESET, AUTO_ACCEPT_PRESET, 'danger-full-access'] as const

/** Shift+Tab as every terminal sends it (`CSI Z`). */
const SHIFT_TAB = '\x1b[Z'

/** Notices and flushes settle across a few awaits; outwait them. */
const SETTLE_MS = 60

/** `src/index.ts` is landed by a separate port; without it the end-to-end suite cannot run. */
const entryAvailable = await tuiEntryAvailable()
const skipWithoutEntry = entryAvailable
  ? false
  : 'requires src/index.ts to export createTuiChat(ctx, config, runtime)'

/** Axes with everything mounted, overridden one fact at a time. */
function axes(overrides: Partial<ModeAxes> = {}): ModeAxes {
  return {
    planActive: false,
    planAvailable: true,
    preset: NORMAL_PRESET,
    presets: PRESETS,
    ...overrides,
  }
}

describe('the mode ladder', () => {
  it('walks normal → auto-accept → plan → normal', () => {
    const first = nextMode(axes())
    assert.deepEqual(first, { mode: 'auto-accept', preset: AUTO_ACCEPT_PRESET })

    // Entering plan mode hands the permission axis back: plan mode is not an
    // auto-accepting mode upstream either.
    const second = nextMode(axes({ preset: AUTO_ACCEPT_PRESET }))
    assert.deepEqual(second, { mode: 'plan', plan: true, preset: NORMAL_PRESET })

    const third = nextMode(axes({ planActive: true }))
    assert.deepEqual(third, { mode: 'normal', plan: false })
  })

  it('names the mode each pair of axis values composes to', () => {
    assert.equal(currentMode(axes()), 'normal')
    assert.equal(currentMode(axes({ preset: AUTO_ACCEPT_PRESET })), 'auto-accept')
    // Plan mode wins the label: it is the axis that changes what the agent may
    // do next, whatever the preset underneath says.
    assert.equal(currentMode(axes({ planActive: true, preset: AUTO_ACCEPT_PRESET })), 'plan')
    assert.equal(currentMode(axes({ preset: 'danger-full-access' })), 'other')
    // The service's derived not-a-preset value is an ordinary name here: the
    // cycle does not own it, so it is left alone like any other.
    assert.equal(currentMode(axes({ preset: 'custom' })), 'other')
    // No preset service reports nothing rather than an invented preset.
    assert.equal(currentMode(axes({ preset: undefined })), 'normal')
  })

  it('leaves a preset outside the ladder exactly where the user put it', () => {
    // danger-full-access is reached with `/permission` and kept: the key moves
    // the only axis it may move, and moves it back the same way.
    const entered = nextMode(axes({ preset: 'danger-full-access' }))
    assert.deepEqual(entered, { mode: 'plan', plan: true })
    const left = nextMode(axes({ planActive: true, preset: 'danger-full-access' }))
    assert.deepEqual(left, { mode: 'other', plan: false })
  })

  it('drops the rung a deployment does not mount instead of failing the press', () => {
    // No auto-accept entry in the table: the ladder is normal ↔ plan.
    const noAccept = { presets: ['read-only', NORMAL_PRESET] }
    assert.deepEqual(nextMode(axes(noAccept)), { mode: 'plan', plan: true })
    assert.deepEqual(nextMode(axes({ ...noAccept, planActive: true })), { mode: 'normal', plan: false })

    // No plan mode: the ladder is normal ↔ auto-accept.
    assert.deepEqual(nextMode(axes({ planAvailable: false })), {
      mode: 'auto-accept',
      preset: AUTO_ACCEPT_PRESET,
    })
    assert.deepEqual(nextMode(axes({ planAvailable: false, preset: AUTO_ACCEPT_PRESET })), {
      mode: 'normal',
      preset: NORMAL_PRESET,
    })
  })

  it('has nothing to do when neither axis is mounted', () => {
    assert.equal(nextMode(axes({ planAvailable: false, preset: undefined, presets: [] })), undefined)
    // A table without either of the cycle's own presets is the same case.
    assert.equal(
      nextMode(axes({ planAvailable: false, preset: 'read-only', presets: ['read-only'] })),
      undefined,
    )
  })
})

describe('mode badges', () => {
  it('names each mode in its own tone, and the key that cycles it in dim', () => {
    const palette = createPalette(true)
    const plan = planModeRow(palette, 'dark', '(Shift+Tab to cycle)')
    const accept = autoAcceptRow(palette, 'dark', '(Shift+Tab to cycle)')
    const plain = (row: string): string => row.replace(/\x1b\[[\d;]*m/gu, '')
    assert.match(plain(plan), /⏸ plan mode on \(Shift\+Tab to cycle\)/u)
    assert.match(plain(accept), /⏵⏵ auto-accept on \(Shift\+Tab to cycle\)/u)
    // The hint is recessed, the way upstream's `dimColor` shortcut hint is.
    assert.match(plan, /\x1b\[2[;m][^\x1b]*\(Shift\+Tab to cycle\)/u)
    assert.match(accept, /\x1b\[2[;m][^\x1b]*\(Shift\+Tab to cycle\)/u)

    const planTone = claudeSchemeColors('dark').planMode
    const acceptTone = claudeSchemeColors('dark').autoAccept
    assert.ok(plan.includes(`38;2;${String(planTone.r)};${String(planTone.g)};${String(planTone.b)}m`), plan)
    assert.ok(accept.includes(`38;2;${String(acceptTone.r)};${String(acceptTone.g)};${String(acceptTone.b)}m`), accept)
  })

  it('darkens the auto-accept tone for a light terminal', () => {
    const palette = createPalette(true)
    const light = claudeSchemeColors('light').autoAccept
    const row = autoAcceptRow(palette, 'light')
    assert.ok(row.includes(`38;2;${String(light.r)};${String(light.g)};${String(light.b)}m`), row)
    // The hint is optional: an unbound action prints the badge alone rather
    // than pointing at a key that answers nothing.
    assert.doesNotMatch(row, /cycle/u)
  })

  it('carries no escape when color is disabled', () => {
    assert.doesNotMatch(autoAcceptRow(createPalette(false), 'dark', '(Shift+Tab to cycle)'), /\x1b/u)
  })
})

type ModesHarness = TuiHarness<HeadlessTerminal, (code: number) => void>

/** A preset table that behaves like `ctx.permissionPresets` over the four configured names. */
function fakePermissionPresets(names: readonly string[] = PRESETS): {
  names: readonly string[]
  current: () => string
  set: (session: Session, name: string) => void
  switches: string[]
} {
  let selected = NORMAL_PRESET
  const switches: string[] = []
  return {
    names,
    current: () => selected,
    set(session, name) {
      if (!names.includes(name)) throw new Error(`unknown preset "${name}"`)
      switches.push(name)
      selected = name
      // The real service records the selection and then writes whichever knob
      // changed; the approval knob is the one this terminal can see typed.
      session.append('approval/policy', { policy: name === AUTO_ACCEPT_PRESET ? 'never' : 'ask' })
    },
    switches,
  }
}

/** A plan-mode service that logs the flip, like the real one does between turns. */
function fakePlanMode(): {
  get: () => { active: boolean }
  set: (agent: Agent, active: boolean) => string
  flips: boolean[]
} {
  let active = false
  const flips: boolean[] = []
  return {
    get: () => ({ active }),
    set(agent, next) {
      if (next === active) return 'noop'
      flips.push(next)
      active = next
      agent.session.append('plan/mode', { active: next })
      return 'committed'
    },
    flips,
  }
}

async function mount(options: TuiHarnessOptions = {}): Promise<ModesHarness> {
  const terminal = new HeadlessTerminal(110, 32)
  const before = terminal.frames
  const harness = await createTuiTestHarness(terminal, () => {}, {
    cwd: '/workspace/project',
    ...options,
    config: {
      title: 'DSH modes',
      welcome: 'ready.',
      ...options.config,
      theme: { color: false, ...options.config?.theme },
    },
  })
  await terminal.waitForFrame(before)
  return harness
}

async function unmount(harness: ModesHarness): Promise<void> {
  await disposeTuiTestHarness(harness)
  await harness.terminal.dispose()
}

/** Press one chunk and settle: a mode switch repaints on the store's own batch. */
async function press(harness: ModesHarness, data: string): Promise<string> {
  harness.terminal.send(data)
  await delay(SETTLE_MS)
  await harness.terminal.flush()
  return harness.terminal.text().replace(/\s+/gu, ' ')
}

describe('Shift+Tab', { skip: skipWithoutEntry }, () => {
  it('cycles the two services and reports each mode it reaches', async () => {
    const presets = fakePermissionPresets()
    const plan = fakePlanMode()
    const harness = await mount({ services: { permissionPresets: presets, planMode: plan } })
    try {
      const accepting = await press(harness, SHIFT_TAB)
      assert.deepEqual(presets.switches, [AUTO_ACCEPT_PRESET])
      assert.match(accepting, /⏵⏵ auto-accept on \(Shift\+Tab to cycle\)/u)
      assert.match(accepting, /Mode: auto-accept/u)

      const planning = await press(harness, SHIFT_TAB)
      assert.deepEqual(plan.flips, [true])
      // The permission axis went back to workspace-write with the same press,
      // so the auto-accept badge is gone and only the plan badge is up.
      assert.deepEqual(presets.switches, [AUTO_ACCEPT_PRESET, NORMAL_PRESET])
      assert.match(planning, /⏸ plan mode on \(Shift\+Tab to cycle\)/u)
      assert.doesNotMatch(planning, /auto-accept on/u)

      const normal = await press(harness, SHIFT_TAB)
      assert.deepEqual(plan.flips, [true, false])
      assert.doesNotMatch(normal, /plan mode on/u)
      assert.doesNotMatch(normal, /auto-accept on/u)
      assert.match(normal, /Mode: normal/u)
    } finally {
      await unmount(harness)
    }
  })

  it('lights the badge for a switch this terminal did not make', async () => {
    const presets = fakePermissionPresets()
    const harness = await mount({ services: { permissionPresets: presets } })
    try {
      assert.doesNotMatch(harness.terminal.text(), /auto-accept on/u)
      // What `/permission auto-accept`, another client, or a resumed log does:
      // the terminal folds the knob event and re-reads the service.
      presets.set(harness.session, AUTO_ACCEPT_PRESET)
      await delay(SETTLE_MS)
      await harness.terminal.flush()
      assert.match(harness.terminal.text().replace(/\s+/gu, ' '), /⏵⏵ auto-accept on/u)
    } finally {
      await unmount(harness)
    }
  })

  it('cycles plan mode alone on a preset the ladder does not own', async () => {
    const presets = fakePermissionPresets()
    presets.set = (session, name) => {
      throw new Error(`the cycle must not switch away from danger-full-access (tried "${name}", ${session.id})`)
    }
    presets.current = () => 'danger-full-access'
    const plan = fakePlanMode()
    const harness = await mount({ services: { permissionPresets: presets, planMode: plan } })
    try {
      assert.match(await press(harness, SHIFT_TAB), /⏸ plan mode on/u)
      assert.deepEqual(plan.flips, [true])
      const left = await press(harness, SHIFT_TAB)
      assert.deepEqual(plan.flips, [true, false])
      assert.doesNotMatch(left, /plan mode on/u)
      assert.match(left, /Plan mode off; the permission preset is unchanged\./u)
    } finally {
      await unmount(harness)
    }
  })

  it('says so rather than doing nothing when the ladder has no rung to move to', async () => {
    const harness = await mount()
    try {
      // Worded from the rungs the cycle looked for, not from the services: a
      // preset table with no auto-accept entry reaches this same flash, and
      // "no presets are mounted" would be a lie there.
      assert.match(
        await press(harness, SHIFT_TAB),
        /Nothing to cycle in this deployment: no auto-accept preset, and no plan mode\./u,
      )
    } finally {
      await unmount(harness)
    }
  })

  it('carries the key hint once when both axes are on', async () => {
    // Plan and auto-accept can be on at once (`/permission auto-accept` plus
    // `/plan`), and one key cycles both: the hint rides the last badge, because
    // the same hint on two stacked rows reads as two keys to press.
    const presets = fakePermissionPresets()
    const plan = fakePlanMode()
    const harness = await mount({ services: { permissionPresets: presets, planMode: plan } })
    try {
      presets.set(harness.session, AUTO_ACCEPT_PRESET)
      plan.set(harness.agent as unknown as Agent, true)
      await delay(SETTLE_MS)
      await harness.terminal.flush()
      const frame = harness.terminal.text().replace(/\s+/gu, ' ')
      assert.match(frame, /⏸ plan mode on/u, frame)
      assert.match(frame, /⏵⏵ auto-accept on/u, frame)
      assert.equal(frame.match(/Shift\+Tab to cycle/gu)?.length, 1, frame)
    } finally {
      await unmount(harness)
    }
  })

  it('keeps the badge strip off the per-frame path while a turn streams', async () => {
    // Every rebuild re-derives both axes from the whole session log, and the
    // store publishes a snapshot per 16 ms batch: rebuilding per snapshot is a
    // full-log fold ~60 times a second, which is what the strip's event-driven
    // repaint exists to avoid.
    const presets = fakePermissionPresets()
    let reads = 0
    const counted = { ...presets, current: (): string => { reads += 1; return presets.current() } }
    const harness = await mount({ services: { permissionPresets: counted } })
    try {
      await delay(SETTLE_MS)
      const painted = reads
      for (let index = 0; index < 120; index += 1) {
        harness.session.append('assistant/chunk', {
          turn: 1,
          step: 1,
          chunk: { type: 'text-delta', index: 0, text: `chunk ${String(index)} ` },
        })
        if (index % 20 === 19) await delay(20)
      }
      await delay(SETTLE_MS)
      await harness.terminal.flush()
      assert.equal(reads, painted, `no axis re-derivation per published snapshot (was ${String(reads - painted)})`)
      // …and the strip still lights up for the event that does move an axis.
      counted.set(harness.session, AUTO_ACCEPT_PRESET)
      await delay(SETTLE_MS)
      await harness.terminal.flush()
      assert.match(harness.terminal.text().replace(/\s+/gu, ' '), /⏵⏵ auto-accept on/u)
    } finally {
      await unmount(harness)
    }
  })

  it('names the preset, not the bare policy, on the /status Permission row', async () => {
    const presets = fakePermissionPresets()
    const harness = await mount({
      // Both services mounted, which is the shipped composition: the row must
      // speak the preset table's vocabulary rather than the knob's.
      services: { permissionPresets: presets, approval: { config: { policy: 'ask' }, overrideOf: () => 'never' } },
    })
    try {
      presets.set(harness.session, AUTO_ACCEPT_PRESET)
      ;(harness.controller as unknown as { submit(text: string): void }).submit('/status')
      await delay(SETTLE_MS)
      assert.match(harness.terminal.text(), /Permission:\s+auto-accept/u, harness.terminal.text())
    } finally {
      await unmount(harness)
    }
  })

  it('leaves the key to the model picker while the picker owns the screen', async () => {
    const presets = fakePermissionPresets()
    const plan = fakePlanMode()
    const harness = await mount({
      config: { modelDialogWidth: 96 },
      catalog: {
        providers: [{ id: 'deepseek-official', name: 'DeepSeek' }],
        models: [{ provider: 'deepseek-official', id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }],
        resolveModelInfo: async () => ({
          context: { contextWindow: 128_000 },
          reasoning: {
            efforts: [
              { id: ReasoningEffortId('low'), name: 'Low' },
              { id: ReasoningEffortId('high'), name: 'High' },
            ],
            defaultEffort: ReasoningEffortId('low'),
          },
        }),
      },
      services: { permissionPresets: presets, planMode: plan },
    })
    try {
      harness.terminal.send('/model')
      harness.terminal.send('\r')
      await delay(SETTLE_MS)
      assert.match(harness.terminal.text(), /Select model/u)

      const adjusted = await press(harness, SHIFT_TAB)
      // The dialog's own Shift+Tab, unchanged: it steps the reasoning effort.
      assert.match(adjusted, /High effort/u)
      // And the app's cycle never ran — no service was touched, no badge lit.
      assert.deepEqual(presets.switches, [])
      assert.deepEqual(plan.flips, [])
      assert.doesNotMatch(adjusted, /auto-accept on/u)
    } finally {
      await unmount(harness)
    }
  })
})

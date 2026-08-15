/**
 * `/config` and `/theme`: the settings a terminal keeps, the palette they pick,
 * and the surfaces that change them.
 *
 * Four levels, because the feature has four halves. The store cases pin what a
 * settings document resolves to and what a write puts back in it; the theme
 * cases pin the four values against the palette they actually produce; the
 * component cases pin the two keyboards; and the mounted cases pin the wiring —
 * that the commands exist, that `/details` no longer does, and that a theme
 * typed on the command line reaches the settings document.
 * @module dsh-tui/tests/unit/settings
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import type { Context } from '@deepseek-ai/cordis'
import {
  openTuiPreferences,
  TUI_PREFERENCES_SCHEMA,
  TUI_SETTINGS_NAMESPACE,
  type TuiPreferences,
} from '../../src/chat/preferences.ts'
import { ThemeDialog } from '../../src/components/dialogs.ts'
import { SettingsPanel, type SettingsEntry } from '../../src/components/settings-panel.ts'
import {
  createPalette,
  resolveThemeAppearance,
  THEME_PREFERENCES,
  type ThemePreferenceId,
} from '../../src/components/theme.ts'
import {
  createTuiTestHarness,
  disposeTuiTestHarness,
  tuiEntryAvailable,
  type TuiHarness,
} from '../harness.ts'
import { HeadlessTerminal } from '../headless-terminal.ts'

/** `src/index.ts` is landed by a separate port; without it the mounted cases cannot run. */
const entryAvailable = await tuiEntryAvailable()
const skipWithoutEntry = entryAvailable
  ? false
  : 'requires src/index.ts to export createTuiChat(ctx, config, runtime)'

/** A command handler runs off the keystroke; outwait it before reading the screen. */
const SETTLE_MS = 60

const ESC = '\x1b'
const ARROW_DOWN = `${ESC}[B`
const ARROW_RIGHT = `${ESC}[C`
const ARROW_LEFT = `${ESC}[D`
const ENTER = '\r'
const CTRL_T = '\x14'

const palette = createPalette(false)

/**
 * A settings provider with the three methods this bundle uses, resolving the
 * layers the real one does: schema defaults, the registrant's `base`, then the
 * stored user section.
 */
class FakeSettings {
  /** Every patch `save` sent, in order. */
  readonly writes: object[] = []
  /** The section name the store registered, so the document's shape is pinned too. */
  namespace: string | undefined
  private readonly registered = new Set<string>()
  private base: Record<string, unknown> = {}

  constructor(private section: Record<string, unknown> | undefined = undefined) {}

  register(namespace: string, _schema: unknown, options?: { base?: object }): void {
    if (this.registered.has(namespace)) {
      throw new Error(`settings namespace "${namespace}" is already registered`)
    }
    this.registered.add(namespace)
    this.namespace = namespace
    this.base = { ...options?.base }
  }

  get(namespace: string): unknown {
    if (!this.registered.has(namespace)) return undefined
    return resolveSection({ ...this.base, ...this.section })
  }

  update(namespace: string, patch: object): Promise<void> {
    if (!this.registered.has(namespace)) return Promise.reject(new Error('not registered'))
    this.writes.push(patch)
    this.section = { ...this.section, ...patch }
    return Promise.resolve()
  }
}

/**
 * Resolve one raw section the way a provider does. The schema's call signature
 * takes a complete value; a stored document is by definition partial and may be
 * wrong, which is exactly what it is being asked to fix.
 */
function resolveSection(section: unknown): TuiPreferences {
  return (TUI_PREFERENCES_SCHEMA as unknown as (input: unknown) => TuiPreferences)(section)
}

/** A context stub with exactly the one accessor the store reads. */
function contextWith(settings: unknown): Context {
  return { get: (name: string) => name === 'settings' ? settings : undefined } as unknown as Context
}

/** Reject every error the store reports, so a silent failure cannot pass. */
function refuseErrors(message: string): never {
  throw new Error(`unexpected preference error: ${message}`)
}

/** Plain rows of a component frame, with the leading indent removed. */
function rows(component: { render(width: number): string[] }, width: number): string[] {
  return component.render(width).map(line => line.trimEnd().replace(/^ /u, ''))
}

describe('terminal preferences', () => {
  it('layers the stored section over the deployment config over the defaults', () => {
    const settings = new FakeSettings({ theme: 'dark' })
    const store = openTuiPreferences(contextWith(settings), { toolCards: 'expanded' }, refuseErrors)
    assert.equal(settings.namespace, TUI_SETTINGS_NAMESPACE)
    assert.deepEqual(store.current(), {
      // The stored value wins, the config value shows through where the
      // document says nothing, and the schema answers for the rest.
      thinkingPinned: false,
      toolCards: 'expanded',
      theme: 'dark',
      queueUpHintSeen: 0,
      busyEnter: 'steer',
    } satisfies TuiPreferences)
  })

  it('writes one field at a time and reads its own write back', async () => {
    const settings = new FakeSettings()
    const store = openTuiPreferences(contextWith(settings), {}, refuseErrors)
    store.save({ theme: 'no-color' })
    store.save({ toolCards: 'expanded' })
    store.save({ thinkingPinned: true })
    store.save({ queueUpHintSeen: 1 })
    store.save({ busyEnter: 'queue' })
    // Every write is fire-and-forget: the value is already live on screen, so
    // the document catches up on the microtask queue rather than in the keystroke.
    await delay(SETTLE_MS)
    assert.deepEqual(settings.writes, [
      { theme: 'no-color' },
      { toolCards: 'expanded' },
      { thinkingPinned: true },
      { queueUpHintSeen: 1 },
      { busyEnter: 'queue' },
    ], 'each row saves the field it changed, not the whole section')
    assert.deepEqual(store.current(), {
      thinkingPinned: true,
      toolCards: 'expanded',
      theme: 'no-color',
      queueUpHintSeen: 1,
      busyEnter: 'queue',
    } satisfies TuiPreferences)
  })

  it('keeps every switch working, for this session only, without a provider', () => {
    const store = openTuiPreferences(contextWith(undefined), { thinkingPinned: true }, refuseErrors)
    assert.equal(store.current().thinkingPinned, true)
    store.save({ theme: 'light' })
    // No provider, no write to wait for: the stand-in answers from memory.
    assert.equal(store.current().theme, 'light', 'the session still honours the choice it was given')
  })

  it('falls back to the default for a value the document got wrong', () => {
    // The kind of thing a hand-edited settings.yaml carries: a plausible theme
    // name that is not one of the four, and a phase spelled as a boolean.
    const settings = new FakeSettings({ theme: 'solarized', toolCards: true, busyEnter: 'steering' })
    const store = openTuiPreferences(contextWith(settings), {}, refuseErrors)
    assert.deepEqual(store.current(), {
      thinkingPinned: false,
      toolCards: 'collapsed',
      theme: 'auto',
      queueUpHintSeen: 0,
      busyEnter: 'steer',
    } satisfies TuiPreferences)
  })

  it('clamps a teaching count the document put out of range', () => {
    // The counter is written by the terminal, so a document carrying 12.5 was
    // edited by hand or by an older build. Either way it says "this user has
    // been told", and the shape check is what turns that into a usable number
    // rather than dropping the whole section over it.
    const stored = { thinkingPinned: false, toolCards: 'collapsed', theme: 'auto', queueUpHintSeen: 12.5 }
    const provider = { register: () => {}, get: () => stored, update: () => Promise.resolve() }
    const store = openTuiPreferences(contextWith(provider), {}, refuseErrors)
    assert.equal(store.current().queueUpHintSeen, 3)

    const negative = { ...stored, queueUpHintSeen: -1 }
    const belowZero = openTuiPreferences(
      contextWith({ register: () => {}, get: () => negative, update: () => Promise.resolve() }),
      {},
      refuseErrors,
    )
    assert.equal(belowZero.current().queueUpHintSeen, 0, 'a count below zero is no count at all')
  })

  it('says so when the section was refused, and stays silent on a second mount', () => {
    const settings = new FakeSettings()
    const reported: string[] = []
    // Two mounts over one context is what a session handoff does; only the
    // first owns the registration, and the second must not report that.
    openTuiPreferences(contextWith(settings), {}, message => { reported.push(message) })
    openTuiPreferences(contextWith(settings), {}, message => { reported.push(message) })
    assert.equal(reported.length, 0, 'a handoff mount reports nothing')

    const refusing = {
      register: () => { throw new Error('theme: expected auto|light|dark|no-color') },
      get: () => undefined,
      update: () => Promise.resolve(),
    }
    openTuiPreferences(contextWith(refusing), {}, message => { reported.push(message) })
    assert.equal(reported.length, 1)
    assert.match(reported[0] ?? '', /Stored terminal settings were refused/u)
  })

  it('reports a rejected write instead of throwing into the keystroke', async () => {
    const reported: string[] = []
    const failing = {
      register: () => {},
      get: () => resolveSection({}),
      update: () => Promise.reject(new Error('settings.yaml is read-only')),
    }
    const store = openTuiPreferences(contextWith(failing), {}, message => { reported.push(message) })
    store.save({ theme: 'dark' })
    await delay(SETTLE_MS)
    assert.equal(reported.length, 1)
    assert.match(reported[0] ?? '', /read-only/u)
  })
})

describe('theme appearance', () => {
  it('resolves each of the four values against the terminal\'s own report', () => {
    // `auto` is the only value that moves with the terminal.
    assert.deepEqual(resolveThemeAppearance('auto', 'light', true), { color: true, scheme: 'light' })
    assert.deepEqual(resolveThemeAppearance('auto', 'dark', true), { color: true, scheme: 'dark' })
    assert.deepEqual(resolveThemeAppearance('light', 'dark', true), { color: true, scheme: 'light' })
    assert.deepEqual(resolveThemeAppearance('dark', 'light', true), { color: true, scheme: 'dark' })
    assert.deepEqual(resolveThemeAppearance('no-color', 'light', true), { color: false, scheme: 'light' })
  })

  it('leaves a deployment that disabled color with no color to re-enable', () => {
    for (const preference of THEME_PREFERENCES) {
      assert.equal(
        resolveThemeAppearance(preference, 'dark', false).color,
        false,
        `${preference} must not put escapes back into a colorless deployment`,
      )
    }
  })

  it('paints what each value asks for', () => {
    const sample = 'code'
    const dark = resolveThemeAppearance('dark', 'light', true)
    const light = resolveThemeAppearance('light', 'dark', true)
    const none = resolveThemeAppearance('no-color', 'dark', true)
    // The `code` role is the one tone that differs between the schemes: cyan on
    // dark, blue on light, and nothing at all without color.
    assert.match(createPalette(dark.color, dark.scheme).code(sample), /\x1b\[36m/u)
    assert.match(createPalette(light.color, light.scheme).code(sample), /\x1b\[34m/u)
    assert.equal(createPalette(none.color, none.scheme).code(sample), sample)
  })
})

describe('SettingsPanel', () => {
  /** One panel over a switch, a cycle, a submenu, and a readout. */
  function fixture(onClose: () => void = () => {}): {
    panel: SettingsPanel
    state: { thinking: boolean; cards: string; opened: number }
  } {
    const state = { thinking: true, cards: 'collapsed', opened: 0 }
    const entries: SettingsEntry[] = [
      { kind: 'toggle', label: 'Thinking display', value: () => state.thinking, set: (next) => { state.thinking = next } },
      {
        kind: 'choice',
        label: 'Tool cards default',
        options: ['collapsed', 'expanded', 'hidden'],
        value: () => state.cards,
        set: (next) => { state.cards = next },
      },
      { kind: 'submenu', label: 'Theme', value: () => 'auto', open: () => { state.opened += 1 } },
      { kind: 'notice', label: 'Model', value: () => 'deepseek/deepseek-v4', hint: '(/model)' },
    ]
    return { panel: new SettingsPanel(entries, () => 12, palette, onClose), state }
  }

  it('shows one row per setting, its value, and who changes the ones it cannot', () => {
    const { panel } = fixture()
    assert.deepEqual(rows(panel, 60), [
      '',
      '/config',
      '→ Thinking display    on',
      '  Tool cards default  collapsed',
      '  Theme               auto ›',
      '  Model               deepseek/deepseek-v4 (/model)',
      '↑↓ move · enter change · esc close',
    ])
  })

  it('flips a switch, cycles a choice both ways, and opens a submenu', () => {
    const { panel, state } = fixture()
    panel.handleInput(ENTER)
    assert.equal(state.thinking, false)
    assert.equal(rows(panel, 60)[2], '→ Thinking display    off', 'the row re-reads the value it just set')

    panel.handleInput(ARROW_DOWN)
    panel.handleInput(ENTER)
    assert.equal(state.cards, 'expanded')
    panel.handleInput(ARROW_RIGHT)
    assert.equal(state.cards, 'hidden')
    panel.handleInput(ARROW_RIGHT)
    assert.equal(state.cards, 'collapsed', 'the cycle wraps rather than stopping at the end')
    panel.handleInput(ARROW_LEFT)
    assert.equal(state.cards, 'hidden', 'and runs backwards from the other key')

    panel.handleInput(ARROW_DOWN)
    panel.handleInput(ENTER)
    assert.equal(state.opened, 1)
  })

  it('does nothing on a readout row, and swallows every other key', () => {
    let closed = 0
    const { panel, state } = fixture(() => { closed += 1 })
    for (let step = 0; step < 3; step += 1) panel.handleInput(ARROW_DOWN)
    panel.handleInput(ENTER)
    panel.handleInput(ARROW_RIGHT)
    assert.deepEqual({ ...state }, { thinking: true, cards: 'collapsed', opened: 0 })

    panel.handleInput('q')
    assert.equal(closed, 0, 'a stray key must not close a panel that owns the keyboard')
    panel.handleInput(ESC)
    assert.equal(closed, 1)
    panel.handleInput('\x03')
    assert.equal(closed, 2)
  })

  it('stops the selection at both ends of the list', () => {
    const { panel, state } = fixture()
    for (let step = 0; step < 9; step += 1) panel.handleInput(ARROW_DOWN)
    for (let step = 0; step < 9; step += 1) panel.handleInput(`${ESC}[A`)
    panel.handleInput(ENTER)
    assert.equal(state.thinking, false, 'the walk ends back on the first row')
  })
})

describe('ThemeDialog', () => {
  /** One dialog over the four themes, recording what it painted and what it kept. */
  function fixture(current: ThemePreferenceId = 'auto'): {
    dialog: ThemeDialog
    applied: ThemePreferenceId[]
    committed: ThemePreferenceId[]
    closed: () => number
  } {
    const applied: ThemePreferenceId[] = []
    const committed: ThemePreferenceId[] = []
    let closes = 0
    const dialog = new ThemeDialog(
      current,
      palette,
      theme => applied.push(theme),
      theme => committed.push(theme),
      () => { closes += 1 },
    )
    return { dialog, applied, committed, closed: () => closes }
  }

  it('lists every theme with its sentence, starting on the one in force', () => {
    const { dialog } = fixture('dark')
    // Wide enough that the list's primary column leaves every sentence whole.
    const frame = dialog.render(110).join('\n')
    for (const id of THEME_PREFERENCES) assert.match(frame, new RegExp(id, 'u'))
    assert.match(frame, /Follow the color scheme the terminal reports/u)
    assert.match(frame, /Enter select/u)
  })

  it('paints while the highlight moves and keeps the theme Enter lands on', () => {
    const { dialog, applied, committed, closed } = fixture()
    dialog.handleInput(ARROW_DOWN)
    assert.deepEqual(applied, ['light'], 'the screen behind the dialog is the preview')
    assert.deepEqual(committed, [], 'moving is not choosing')
    dialog.handleInput(ARROW_DOWN)
    dialog.handleInput(ENTER)
    assert.deepEqual(applied, ['light', 'dark'])
    assert.deepEqual(committed, ['dark'])
    assert.equal(closed(), 1)
  })

  it('puts the theme it opened on back when the picker is cancelled', () => {
    const { dialog, applied, committed, closed } = fixture('auto')
    dialog.handleInput(ARROW_DOWN)
    dialog.handleInput(ESC)
    assert.deepEqual(applied, ['light', 'auto'])
    assert.deepEqual(committed, [], 'a preview the user backed out of was never a choice')
    assert.equal(closed(), 1)
  })
})

describe('the mounted /config and /theme', { skip: skipWithoutEntry }, () => {
  interface SubmitHandle { submit(text: string): void }

  async function mount(settings?: FakeSettings): Promise<TuiHarness<HeadlessTerminal, (code: number) => void>> {
    const terminal = new HeadlessTerminal(96, 40)
    const before = terminal.frames
    const harness = await createTuiTestHarness(terminal, () => {}, {
      cwd: '/workspace/project',
      config: {
        title: 'DSH settings',
        welcome: 'ready.',
        theme: { color: false, inputPrompt: 'dsh> ' },
      },
      ...settings === undefined ? {} : { services: { settings } },
    })
    await terminal.waitForFrame(before)
    return harness
  }

  it('registers /config and /theme, and no longer registers /details', async () => {
    const harness = await mount()
    try {
      const names = harness.ctx.commands.list(harness.agent).map(command => command.name)
      assert.ok(names.includes('config'), `/config should be registered:\n${names.join(', ')}`)
      assert.ok(names.includes('theme'), `/theme should be registered:\n${names.join(', ')}`)
      // Retired: its two settings are a `/config` row and the Ctrl+O cycle.
      assert.ok(!names.includes('details'), '/details should be gone')
    } finally {
      await disposeTuiTestHarness(harness)
      await harness.terminal.dispose()
    }
  })

  it('opens the settings panel under the conversation and closes it on Esc', async () => {
    const harness = await mount()
    try {
      ;(harness.controller as unknown as SubmitHandle).submit('/config')
      await delay(SETTLE_MS)
      const open = harness.terminal.text()
      assert.match(open, /Thinking display/u, `the panel should list its rows:\n${open}`)
      assert.match(open, /Tool cards default/u)
      assert.match(open, /\(\/model\)/u, 'the model row names the command that changes it')
      assert.match(open, /esc close/u)

      harness.terminal.send(ESC)
      await delay(SETTLE_MS)
      await harness.terminal.flush()
      assert.doesNotMatch(harness.terminal.text(), /Thinking display/u)
    } finally {
      await disposeTuiTestHarness(harness)
      await harness.terminal.dispose()
    }
  })

  it('enters the theme picker from the panel\'s Theme row', async () => {
    const settings = new FakeSettings()
    const harness = await mount(settings)
    try {
      ;(harness.controller as unknown as SubmitHandle).submit('/config')
      await delay(SETTLE_MS)
      // Down to the Theme row, then Enter: the picker takes the inline slot the
      // panel was holding, which is what every other surface here does with it.
      harness.terminal.send(ARROW_DOWN)
      harness.terminal.send(ARROW_DOWN)
      harness.terminal.send(ARROW_DOWN)
      harness.terminal.send(ENTER)
      await delay(SETTLE_MS)
      await harness.terminal.flush()
      const picker = harness.terminal.text()
      assert.match(picker, /Select theme/u, `the Theme row should open the picker:\n${picker}`)
      assert.doesNotMatch(picker, /Thinking display/u, 'one surface at a time in the editor slot')

      harness.terminal.send(ARROW_DOWN)
      harness.terminal.send(ENTER)
      await delay(SETTLE_MS)
      assert.deepEqual(settings.writes, [{ theme: 'light' }])
    } finally {
      await disposeTuiTestHarness(harness)
      await harness.terminal.dispose()
    }
  })

  it('puts the previewed theme back when another surface takes the slot', async () => {
    const settings = new FakeSettings()
    const harness = await mount(settings)
    try {
      ;(harness.controller as unknown as SubmitHandle).submit('/theme')
      await delay(SETTLE_MS)
      // One move down previews `light` on the screen behind the dialog.
      harness.terminal.send(ARROW_DOWN)
      await delay(SETTLE_MS)
      // A dismissable surface is closed outright when an inline one arrives —
      // no key reaches the dialog, so the dialog cannot undo its own preview.
      ;(harness.controller as unknown as SubmitHandle).submit('/config')
      await delay(SETTLE_MS)
      await harness.terminal.flush()
      const panel = harness.terminal.text()
      assert.match(panel, /Thinking display/u, `the panel took the slot:\n${panel}`)
      // The preference the panel reports is the one the selector opened on: a
      // preview nobody confirmed must not outlive the surface that painted it.
      assert.match(panel, /Theme\s+auto/u, `the preview was rolled back:\n${panel}`)
      assert.deepEqual(settings.writes, [], 'and nothing was persisted')
    } finally {
      await disposeTuiTestHarness(harness)
      await harness.terminal.dispose()
    }
  })

  it('applies a theme typed on the command line and writes it to the settings document', async () => {
    const settings = new FakeSettings()
    const harness = await mount(settings)
    try {
      ;(harness.controller as unknown as SubmitHandle).submit('/theme dark')
      await delay(SETTLE_MS)
      assert.deepEqual(settings.writes, [{ theme: 'dark' }])
      assert.match(harness.terminal.text(), /Theme: dark\./u)

      ;(harness.controller as unknown as SubmitHandle).submit('/theme solarized')
      await delay(SETTLE_MS)
      const refused = harness.terminal.text()
      assert.match(refused, /Unknown theme "solarized"/u, `the refusal names the four values:\n${refused}`)
      assert.deepEqual(settings.writes, [{ theme: 'dark' }], 'a refused theme writes nothing')
    } finally {
      await disposeTuiTestHarness(harness)
      await harness.terminal.dispose()
    }
  })

  it('is the same thinking switch Ctrl+T flips, and the row is the half that writes', async () => {
    const settings = new FakeSettings()
    const harness = await mount(settings)
    try {
      // Ctrl+T is "show me now": the transcript changes, the document does not.
      harness.terminal.send(CTRL_T)
      await delay(SETTLE_MS)
      assert.deepEqual(settings.writes, [], 'the key moves this session alone')

      ;(harness.controller as unknown as SubmitHandle).submit('/config')
      await delay(SETTLE_MS)
      const open = harness.terminal.text()
      assert.match(open, /Thinking display\s+on/u, `the row reports the key's state:\n${open}`)

      // Enter on the row is "from now on": the same switch, written down.
      harness.terminal.send(ENTER)
      await delay(SETTLE_MS)
      await harness.terminal.flush()
      const flipped = harness.terminal.text()
      assert.match(flipped, /Thinking display\s+off/u, `the row flips in place:\n${flipped}`)
      assert.deepEqual(settings.writes, [{ thinkingPinned: false }])
    } finally {
      await disposeTuiTestHarness(harness)
      await harness.terminal.dispose()
    }
  })

  it('paints nothing at all under a stored no-color, on a truecolor terminal', async () => {
    // The regression this pins: three surfaces read the deployment's
    // `theme.color` rather than the resolved appearance, so a `no-color`
    // preference still shipped 24-bit escapes — the banner's gradient wordmark,
    // the status caret's fade, and the extension brand role.
    const terminal = new HeadlessTerminal(96, 40)
    const before = terminal.frames
    const harness = await createTuiTestHarness(terminal, () => {}, {
      cwd: '/workspace/project',
      config: {
        title: 'DSH settings',
        welcome: 'ready.',
        // Color fully available: the preference, not the deployment, is what
        // has to turn it off.
        theme: { color: true, truecolor: true, inputPrompt: 'dsh> ' },
      },
      services: { settings: new FakeSettings({ theme: 'no-color' }) },
    })
    try {
      await terminal.waitForFrame(before)
      await delay(SETTLE_MS)
      // The one cell that stays styled is the editor's software cursor block
      // (SGR 7): that is the cursor, not the palette, and pi-tui draws it in
      // every theme whenever the hardware cursor is off.
      const painted = terminal.paintedCells().filter(entry => !entry.endsWith(' inverse'))
      assert.deepEqual(painted, [], `no-color emits no SGR:\n${painted.slice(0, 20).join('\n')}`)
      // And the banner is on screen, so the emptiness is not an empty screen.
      assert.match(terminal.text(), /DEEPSEEK HARNESS/u)
    } finally {
      await disposeTuiTestHarness(harness)
      await harness.terminal.dispose()
    }
  })

  it('opens on the stored theme and phase a previous session saved', async () => {
    const settings = new FakeSettings({ theme: 'no-color', toolCards: 'expanded', thinkingPinned: true })
    const harness = await mount(settings)
    try {
      ;(harness.controller as unknown as SubmitHandle).submit('/config')
      await delay(SETTLE_MS)
      const open = harness.terminal.text()
      assert.match(open, /Thinking display\s+on/u, `the stored section decides the first frame:\n${open}`)
      assert.match(open, /Tool cards default\s+expanded/u)
      assert.match(open, /Theme\s+no-color/u)
    } finally {
      await disposeTuiTestHarness(harness)
      await harness.terminal.dispose()
    }
  })
})

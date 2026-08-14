/**
 * Agent presets at the terminal boundary: which composition a session is opened
 * under, and what `/preset` may still change about it.
 *
 * The rules pinned here are the Web host's, restated for a surface that owns its
 * own agent lifecycle. Two of them are only visible at boot, before any terminal
 * exists — the creation header records the preset a session STARTED with, and a
 * resumed session is rebuilt from the preset its own LOG records — so those
 * cases drive `openStartupAgent` against a recording agent registry rather than
 * through the mounted chat. The rest are `/preset` itself: a blank session
 * switches and says so in its log, a started one cannot and saves the pick as
 * the default instead, and a profile that composes no roster answers with one
 * sentence rather than an empty picker.
 * @module dsh-tui/tests/unit/preset
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import type {
  Agent,
  AgentOptions,
  CreateAgentOptions,
  ResumeAgentOptions,
} from '@deepseek-ai/dsh-agent'
import { SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import {
  createTuiTestHarness,
  disposeTuiTestHarness,
  tuiEntryAvailable,
  type TuiHarness,
  type TuiHarnessOptions,
} from '../harness.ts'
import { HeadlessTerminal } from '../headless-terminal.ts'
import { PRESETS_UNAVAILABLE, sessionAgentPreset } from '../../src/chat/preset-command.ts'
import { openStartupAgent } from '../../src/index.ts'
import type { TuiStartupValues } from '../../src/startup.ts'

/** `src/index.ts` is landed by a separate port; without it the end-to-end suite cannot run. */
const entryAvailable = await tuiEntryAvailable()
const skipWithoutEntry = entryAvailable
  ? false
  : 'requires src/index.ts to export createTuiChat(ctx, config, runtime)'

/** Literal editor prefix, so "the editor is on screen" needs no prompt registrations. */
const INPUT_PROMPT = 'dsh> '

/** A command runs on its own fiber and its notice lands a frame later; outwait both. */
const SETTLE_MS = 80

/** The roster every case here composes from, in the order the host would list it. */
const ROSTER: readonly PresetRow[] = [
  { id: 'standard', trust: 'system', name: 'Standard', description: 'The everyday composition.' },
  { id: 'code', trust: 'system', name: 'Code', description: 'Editing and running code.' },
  { id: 'mine', trust: 'user', name: 'Mine' },
  { id: 'stale', trust: 'user', broken: 'composition file is unreadable' },
]

/** One roster row, exactly the fields `AgentPresets.list()` reports. */
interface PresetRow {
  id: string
  trust: 'system' | 'user'
  path?: string
  name?: string
  description?: string
  broken?: string
}

/**
 * The roster package's `UnknownPresetError`, restated.
 *
 * Shape matters, not identity: the boot path must surface the message the
 * package writes — including the ids that DO exist — rather than replacing it.
 */
class UnknownPreset extends Error {
  constructor(readonly presetId: string, readonly available: readonly string[]) {
    super(`agent-presets: preset "${presetId}" not found (available: ${available.join(', ')})`)
  }
}

/** The roster package's `PresetExistsError`, restated; `/preset copy` matches it by name. */
class PresetExistsError extends Error {
  constructor(readonly presetId: string) {
    super(`agent-presets: preset "${presetId}" already exists`)
  }
}

/**
 * The roster package's `PresetMountError`, restated.
 *
 * Every mounting path refuses a broken preset AFTER resolving it, which is why
 * the fake below rejects inside `mount`/`recompose` rather than filtering the
 * row out of `list()`: the row exists, and refusing it is the roster's job.
 */
class PresetMountError extends Error {
  constructor(readonly presetId: string, readonly reason: string) {
    super(`agent-presets: preset "${presetId}" failed to mount: ${reason}`)
  }
}

/** Everything a test asserts about a fake roster after driving it. */
interface RosterCalls {
  /** Preset ids passed to `mount()`, in call order. */
  readonly mounted: string[]
  /** Preset ids passed to `recompose()`, in call order. */
  readonly recomposed: string[]
  /** `copy()` arguments, in call order. */
  readonly copied: { from: string; id: string }[]
}

/** A stand-in `agentPresets` service, recording what the surface under test asked it. */
function fakeRoster(options: {
  rows?: readonly PresetRow[]
  defaultId?: string
  copyFails?: unknown
} = {}): { service: unknown; calls: RosterCalls } {
  const rows = options.rows ?? ROSTER
  const calls: RosterCalls = { mounted: [], recomposed: [], copied: [] }
  const defaultId = options.defaultId ?? 'standard'
  const resolve = (id?: string): PresetRow => {
    const wanted = id ?? defaultId
    const found = rows.find(row => row.id === wanted)
    if (found === undefined) throw new UnknownPreset(wanted, rows.map(row => row.id))
    return { path: `/deployment/agent-presets/${found.id}/agent.cordis.yml`, ...found }
  }
  /** Resolution as the mounting paths do it: a broken preset resolves, then is refused. */
  const resolveMountable = (id?: string): PresetRow => {
    const preset = resolve(id)
    if (preset.broken !== undefined) throw new PresetMountError(preset.id, preset.broken)
    return preset
  }
  const service = {
    get defaultId(): string {
      return defaultId
    },
    get authorable(): boolean {
      return true
    },
    list: () => Promise.resolve(rows.map(row => ({ ...row }))),
    resolve: (id?: string) => Promise.resolve(resolve(id)),
    mount: (_agentCtx: unknown, id?: string) => {
      const preset = resolveMountable(id)
      calls.mounted.push(preset.id)
      return Promise.resolve(preset)
    },
    recompose: (_agentCtx: unknown, id: string) => {
      const preset = resolveMountable(id)
      calls.recomposed.push(preset.id)
      return Promise.resolve(preset)
    },
    copy: (from: string, id: string) => {
      if (options.copyFails !== undefined) return Promise.reject(options.copyFails)
      calls.copied.push({ from, id })
      return Promise.resolve()
    },
  }
  return { service, calls }
}

/** Startup values with nothing selected, so each case states only what it exercises. */
function startup(overrides: Partial<TuiStartupValues> = {}): TuiStartupValues {
  return {
    model: undefined,
    preset: undefined,
    resume: undefined,
    continueLatest: false,
    print: undefined,
    initialPrompt: undefined,
    ...overrides,
  }
}

/** What one boot recorded: the registry calls, and the presets their setup mounted. */
interface BootWorld {
  ctx: Context
  created: CreateAgentOptions[]
  resumed: ResumeAgentOptions[]
  calls: RosterCalls
}

/**
 * A context carrying only what the boot path reads: a recording agent registry,
 * optionally a roster, optionally a persisted session to inspect.
 *
 * The registry runs each call's `setup` against a context, which is the whole
 * point — a preset that is named on the header but never mounted composes
 * nothing, and only invoking setup can tell the two apart.
 */
function bootWorld(options: {
  roster?: { service: unknown; calls: RosterCalls }
  persisted?: { meta: Partial<SessionHeader>; events: readonly SessionEvent[] }
} = {}): BootWorld {
  const ctx = new Context()
  const created: CreateAgentOptions[] = []
  const resumed: ResumeAgentOptions[] = []
  const handleFor = (sessionId: string): { agent: Agent; dispose: () => Promise<void> } => ({
    agent: { id: SessionId(sessionId) } as Agent,
    dispose: () => Promise.resolve(),
  })
  ctx.provide('agents', {
    async create(createOptions: CreateAgentOptions) {
      created.push(createOptions)
      await createOptions.setup?.(ctx)
      return handleFor(createOptions.sessionId)
    },
    async resume(resumeOptions: ResumeAgentOptions) {
      resumed.push(resumeOptions)
      await resumeOptions.setup?.(ctx)
      return handleFor(resumeOptions.resumeSessionId)
    },
  } as never)
  if (options.roster !== undefined) ctx.provide('agentPresets', options.roster.service as never)
  if (options.persisted !== undefined) {
    const { meta, events } = options.persisted
    ctx.provide('sessionPersistence', {
      list: () => Promise.resolve([{ id: SessionId('persisted'), createdAt: 1, cwd: process.cwd(), ...meta }]),
      inspect: () => Promise.resolve({
        meta: { id: SessionId('persisted'), createdAt: 1, cwd: process.cwd(), ...meta },
        events,
      }),
    } as never)
  }
  return { ctx, created, resumed, calls: options.roster?.calls ?? { mounted: [], recomposed: [], copied: [] } }
}

type PresetHarness = TuiHarness<HeadlessTerminal, (code: number) => void>

async function mount(options: TuiHarnessOptions = {}): Promise<PresetHarness> {
  const terminal = new HeadlessTerminal(100, 30)
  const before = terminal.frames
  const harness = await createTuiTestHarness(terminal, () => {}, {
    cwd: '/workspace/project',
    ...options,
    config: {
      title: 'DSH presets',
      welcome: 'ready.',
      ...options.config,
      theme: { color: false, inputPrompt: INPUT_PROMPT, ...options.config?.theme },
    },
  })
  await terminal.waitForFrame(before)
  return harness
}

async function unmount(harness: PresetHarness): Promise<void> {
  await disposeTuiTestHarness(harness)
  await harness.terminal.dispose()
}

/** Run one line through the same command registry a typed submission reaches. */
async function run(harness: PresetHarness, line: string): Promise<string> {
  await harness.ctx.commands.execute(harness.agent, line, AbortSignal.timeout(5_000))
  await delay(SETTLE_MS)
  return harness.terminal.text()
}

describe('agent preset at boot', () => {
  it('records the composed preset on the creation header AND mounts it in setup', async () => {
    // Both halves or neither: a header naming a preset whose composition was
    // never mounted describes capabilities the session does not have, and a
    // mount the header does not record is lost on the next resume.
    const roster = fakeRoster()
    const world = bootWorld({ roster })
    await openStartupAgent(world.ctx, startup(), undefined)

    assert.equal(world.created.length, 1)
    assert.equal(world.created[0]?.meta?.agentPreset, 'standard', 'the resolved id is a creation fact')
    assert.deepEqual(world.calls.mounted, ['standard'], 'setup joined the agent to that composition')
    assert.equal(world.created[0]?.meta?.cwd, process.cwd(), 'the project directory still travels with it')
  })

  it('composes --preset instead of the roster default', async () => {
    const roster = fakeRoster()
    const world = bootWorld({ roster })
    await openStartupAgent(world.ctx, startup({ preset: 'code' }), undefined)

    assert.equal(world.created[0]?.meta?.agentPreset, 'code')
    assert.deepEqual(world.calls.mounted, ['code'])
  })

  it('fails the start on an unknown --preset, carrying the ids that do exist', async () => {
    // Resolution happens before the session exists, so a typo costs a refusal
    // rather than a published session composed from the wrong preset. The
    // roster's own message is the diagnostic: it names the alternatives.
    const roster = fakeRoster()
    const world = bootWorld({ roster })
    await assert.rejects(
      () => openStartupAgent(world.ctx, startup({ preset: 'kode' }), undefined),
      (error: Error) => {
        assert.match(error.message, /preset "kode" not found/)
        assert.match(error.message, /standard, code, mine, stale/)
        return true
      },
    )
    assert.deepEqual(world.created, [], 'nothing was created')
  })

  it('resumes under the preset the log records, not the one the header does', async () => {
    // A session that switched while blank ran every turn under the newer
    // composition; rebuilding it from the header would restore that history
    // under a tool set the model no longer has.
    const roster = fakeRoster()
    const world = bootWorld({
      roster,
      persisted: {
        meta: { agentPreset: 'standard' },
        events: [{ type: 'agent-preset/selected', data: { agentPreset: 'code' } } as unknown as SessionEvent],
      },
    })
    await openStartupAgent(world.ctx, startup({ resume: 'persisted' }), undefined)

    assert.equal(world.resumed.length, 1)
    assert.deepEqual(world.calls.mounted, ['code'], 'the logged switch wins over the creation header')
    assert.equal('meta' in (world.resumed[0] ?? {}), false, 'a resume records no new creation fact')
  })

  it('falls back to the roster default for a session that recorded no preset', async () => {
    const roster = fakeRoster()
    const world = bootWorld({ roster, persisted: { meta: {}, events: [] } })
    await openStartupAgent(world.ctx, startup({ resume: 'persisted' }), undefined)

    assert.deepEqual(world.calls.mounted, ['standard'])
  })

  it('composes nothing at all when the profile mounts no roster', async () => {
    // The shape this bundle had before presets existed: no header fact, no
    // setup hook, and every session sharing the host composition.
    const world = bootWorld()
    await openStartupAgent(world.ctx, startup(), { provider: 'p', model: 'm' } satisfies AgentOptions)

    assert.equal(world.created[0]?.meta?.agentPreset, undefined)
    assert.equal(world.created[0]?.setup, undefined)
    assert.deepEqual(world.created[0]?.agentOptions, { provider: 'p', model: 'm' })
  })
})

describe('/preset', { skip: skipWithoutEntry }, () => {
  it('registers into the same list /help and autocomplete read', async () => {
    const harness = await mount()
    try {
      await delay(SETTLE_MS)
      const names = harness.ctx.commands.list(harness.agent).map(command => command.name)
      assert.ok(names.includes('preset'), `/preset must be a registered command: ${names.join(', ')}`)
    } finally {
      await unmount(harness)
    }
  })

  it('lists the roster with its current, default, and built-in badges', async () => {
    const { service } = fakeRoster({ defaultId: 'code' })
    const harness = await mount({
      omitInitialLifecycle: true,
      services: { agentPresets: service },
      beforeMount: (session) => {
        session.append('agent-preset/selected', { agentPreset: 'standard' } as never)
      },
    })
    try {
      const frame = await run(harness, '/preset')
      assert.match(frame, /Select agent preset/)
      assert.match(frame, /standard/)
      // Badges lead the description column so truncation cannot eat the two
      // facts the picker exists to answer.
      assert.match(frame, /current/, 'the session\'s own preset is badged')
      assert.match(frame, /default/, 'the preset a new session would get is badged')
      assert.match(frame, /built-in/, 'a shipped preset says so')
      assert.match(frame, /local/, 'and a locally authored one says the opposite')
      // A broken preset stays on the list — its directory is occupying the id —
      // and states the reason rather than being silently filtered out.
      // The reason is truncated to the column, so only its start is asserted.
      assert.match(frame, /unavailable: composition file/)
    } finally {
      await unmount(harness)
    }
  })

  it('switches a blank session and records the switch in its log', async () => {
    // Blank is the whole licence: nothing has been produced under the old
    // composition, so swapping it strands no logged tool call.
    const { service, calls } = fakeRoster()
    const harness = await mount({
      omitInitialLifecycle: true,
      services: { agentPresets: service },
    })
    try {
      const frame = await run(harness, '/preset code')
      assert.deepEqual(calls.recomposed, ['code'], 'the live agent scope was re-linked')
      const selections = harness.session.events.filter(event => event.type === 'agent-preset/selected')
      assert.equal(selections.length, 1, 'the switch is in the durable log, not only in memory')
      assert.deepEqual((selections[0] as { data: { agentPreset: string } } | undefined)?.data, { agentPreset: 'code' })
      assert.match(frame, /Preset selected: code\. This session now runs it\./)
    } finally {
      await unmount(harness)
    }
  })

  it('says so and changes nothing when the session already runs that preset', async () => {
    const { service, calls } = fakeRoster()
    const harness = await mount({
      omitInitialLifecycle: true,
      services: { agentPresets: service },
      beforeMount: (session) => {
        session.append('agent-preset/selected', { agentPreset: 'code' } as never)
      },
    })
    try {
      const frame = await run(harness, '/preset code')
      assert.deepEqual(calls.recomposed, [], 'a no-op switch re-links nothing')
      assert.equal(
        harness.session.events.filter(event => event.type === 'agent-preset/selected').length,
        1,
        'and appends no second event, so the log keeps saying one thing',
      )
      assert.match(frame, /Preset is already code\./)
    } finally {
      await unmount(harness)
    }
  })

  it('saves the pick as the default once the session has started', async () => {
    // The default harness seeds a turn, so the conversation has begun: its
    // history was produced under this composition and cannot be recomposed.
    const { service, calls } = fakeRoster()
    const written: { namespace: string; patch: object }[] = []
    const harness = await mount({
      services: {
        agentPresets: service,
        settings: {
          update: (namespace: string, patch: object) => {
            written.push({ namespace, patch })
            return Promise.resolve()
          },
        },
      },
    })
    try {
      const frame = await run(harness, '/preset code')
      assert.deepEqual(calls.recomposed, [], 'a started session is never recomposed')
      assert.deepEqual(written, [{ namespace: 'agent-presets', patch: { default: 'code' } }])
      assert.match(frame, /already started/)
      assert.match(frame, /Preset saved as the default\. New sessions will use code\./)
    } finally {
      await unmount(harness)
    }
  })

  it('reports a default it could not save instead of claiming it did', async () => {
    const { service } = fakeRoster()
    const harness = await mount({ services: { agentPresets: service } })
    try {
      const frame = await run(harness, '/preset code')
      assert.match(frame, /could not be saved as the default/)
      assert.ok(!frame.includes('New sessions will use'), `nothing may claim the write landed:\n${frame}`)
    } finally {
      await unmount(harness)
    }
  })

  it('refuses a broken preset with the reason discovery reported', async () => {
    const { service, calls } = fakeRoster()
    const harness = await mount({
      omitInitialLifecycle: true,
      services: { agentPresets: service },
    })
    try {
      const frame = await run(harness, '/preset stale')
      assert.deepEqual(calls.recomposed, [], 'an unusable composition is never installed')
      assert.match(frame, /Could not select preset "stale"/)
      // Wrapped across the notice column, so the assertion takes a fragment
      // that cannot straddle the break.
      assert.match(frame, /failed to mount/, 'the roster\'s own refusal reaches the screen')
      assert.equal(
        harness.session.events.filter(event => event.type === 'agent-preset/selected').length,
        0,
        'a refused swap records nothing: the log states what the agent runs',
      )
    } finally {
      await unmount(harness)
    }
  })

  it('copies a preset and names where the copy landed', async () => {
    const { service, calls } = fakeRoster({
      rows: [...ROSTER, { id: 'derived', trust: 'user', path: '/home/dsh/.agent-presets/derived/agent.cordis.yml' }],
    })
    const harness = await mount({ services: { agentPresets: service } })
    try {
      const frame = await run(harness, '/preset copy standard derived')
      assert.deepEqual(calls.copied, [{ from: 'standard', id: 'derived' }])
      assert.match(frame, /Preset "derived" created from "standard"/)
      assert.match(frame, /home\/dsh\/\.agent-presets\/derived/, 'the confirmation names the directory')
    } finally {
      await unmount(harness)
    }
  })

  it('explains a refused copy in a sentence rather than an error class name', async () => {
    const { service } = fakeRoster({ copyFails: new PresetExistsError('code') })
    const harness = await mount({ services: { agentPresets: service } })
    try {
      const frame = await run(harness, '/preset copy standard code')
      assert.match(frame, /already exists/)
      assert.match(frame, /choose another id/)
    } finally {
      await unmount(harness)
    }
  })

  it('rejects a copy that names the wrong number of arguments', async () => {
    const { service } = fakeRoster()
    const harness = await mount({ services: { agentPresets: service } })
    try {
      assert.match(await run(harness, '/preset copy standard'), /Usage: \/preset copy/)
    } finally {
      await unmount(harness)
    }
  })

  it('explains its own absence instead of opening an empty picker', async () => {
    const harness = await mount()
    try {
      const frame = await run(harness, '/preset')
      assert.match(frame, /Agent presets are not mounted/)
      assert.ok(
        PRESETS_UNAVAILABLE.includes('@deepseek-ai/dsh-agent-presets'),
        'the sentence names the package a deployment would add',
      )
    } finally {
      await unmount(harness)
    }
  })
})

describe('/status preset row', { skip: skipWithoutEntry }, () => {
  it('names the composition the session runs, resolved from the log', async () => {
    const { service } = fakeRoster()
    const harness = await mount({
      services: { agentPresets: service },
      beforeMount: (session) => {
        session.append('agent-preset/selected', { agentPreset: 'code' } as never)
      },
    })
    try {
      assert.match(await run(harness, '/status'), /Preset:\s+code/)
    } finally {
      await unmount(harness)
    }
  })

  it('prints no row at all when the profile composes no roster', async () => {
    const harness = await mount({
      beforeMount: (session) => {
        session.append('agent-preset/selected', { agentPreset: 'code' } as never)
      },
    })
    try {
      const frame = await run(harness, '/status')
      assert.match(frame, /Session/, 'the status card still rendered')
      assert.ok(!/Preset:\s+code/.test(frame), `a preset nothing mounts must not be named:\n${frame}`)
    } finally {
      await unmount(harness)
    }
  })
})

describe('sessionAgentPreset', () => {
  it('prefers the newest logged selection over the creation header', () => {
    const header = { agentPreset: 'standard' } as SessionHeader
    const events = [
      { type: 'agent-preset/selected', data: { agentPreset: 'code' } },
      { type: 'agent-preset/selected', data: { agentPreset: 'mine' } },
    ] as unknown as SessionEvent[]
    assert.equal(sessionAgentPreset({ header, events }), 'mine')
  })

  it('falls back to the header, and to nothing at all', () => {
    const header = { agentPreset: 'standard' } as SessionHeader
    assert.equal(sessionAgentPreset({ header, events: [] }), 'standard')
    assert.equal(sessionAgentPreset({ header: {} as SessionHeader, events: [] }), undefined)
  })
})

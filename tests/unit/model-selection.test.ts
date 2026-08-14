/**
 * Model routing at the terminal boundary: which route the prompt reports, and
 * what the screen does while the LLM topology is still coming up.
 *
 * Both cases are startup-ordering bugs the fold cannot see: the default-model
 * service reads settings asynchronously, and adapter plugins register after the
 * TUI mounts, so anything the mount captures or reports is captured too early.
 * @module dsh-tui/tests/unit/model-selection
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId, type LlmCallConfig } from '@deepseek-ai/dsh-llm'
import {
  createTuiTestHarness,
  disposeTuiTestHarness,
  tuiEntryAvailable,
  type TuiHarness,
  type TuiHarnessOptions,
} from '../harness.ts'
import { HeadlessTerminal } from '../headless-terminal.ts'

/** `src/index.ts` is landed by a separate port; without it this suite cannot run. */
const entryAvailable = await tuiEntryAvailable()
const skipWithoutEntry = entryAvailable
  ? false
  : 'requires src/index.ts to export createTuiChat(ctx, config, runtime)'

/** Literal editor prefix, so "the editor is on screen" needs no prompt registrations. */
const INPUT_PROMPT = 'dsh> '

/** The store publishes one snapshot per 16 ms frame; settle by outwaiting it. */
const SETTLE_MS = 60

type Harness = TuiHarness<HeadlessTerminal, (code: number) => void>

async function mount(options: TuiHarnessOptions = {}): Promise<Harness> {
  const terminal = new HeadlessTerminal(100, 20)
  const harness = await createTuiTestHarness(terminal, () => {}, {
    cwd: '/workspace/project',
    ...options,
    config: {
      title: 'DSH models',
      welcome: 'ready.',
      theme: { color: false, inputPrompt: INPUT_PROMPT },
      ...options.config,
    },
  })
  await delay(SETTLE_MS)
  return harness
}

async function unmount(harness: Harness): Promise<void> {
  await disposeTuiTestHarness(harness)
  await harness.terminal.dispose()
}

/**
 * Announce an adapter-registry commit and settle the frame it triggers — the
 * signal a settings load actually produces, and the one that repaints a prompt
 * whose route is read live.
 */
async function adaptersUpdated(harness: Harness): Promise<string> {
  harness.ctx.emit('llm/adapters-updated')
  await delay(SETTLE_MS)
  return harness.terminal.text()
}

/** The route the harness catalog advertises alongside the seeded default. */
const OTHER_ROUTE = 'deepseek-official/deepseek-v4-pro'

/** The route the seeded default-model service reports, so a switch is a real change. */
const SEEDED: ModelSelection = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }

/** Type the `/model <route>` command into the editor and let it settle. */
async function runModelCommand(harness: Harness, argument: string): Promise<string> {
  harness.terminal.send(`/model ${argument}`)
  harness.terminal.send('\r')
  await delay(SETTLE_MS)
  return harness.terminal.text()
}

describe('model selection persistence', { skip: skipWithoutEntry }, () => {
  it('saves the picked route, reasoning effort included, as the new default', async () => {
    // Without this the pick lived only in this process: the next start re-read
    // the service and landed back on the configured default.
    const saved: ModelSelection[] = []
    const harness = await mount({
      catalog: {
        providers: [{ id: 'deepseek-official', name: 'DeepSeek' }],
        models: [
          { provider: 'deepseek-official', id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
          { provider: 'deepseek-official', id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
        ],
        resolveModelInfo: async () => ({
          context: { contextWindow: 128_000 },
          reasoning: {
            efforts: [{ id: ReasoningEffortId('high'), name: 'High' }],
            defaultEffort: ReasoningEffortId('high'),
          },
        }),
      },
      services: {
        agentDefaultModel: {
          currentSelection: () => SEEDED,
          saveSelection: async (next: ModelSelection) => { saved.push(next) },
        },
      },
    })
    try {
      await runModelCommand(harness, OTHER_ROUTE)
      assert.deepEqual(saved, [{
        provider: 'deepseek-official',
        model: 'deepseek-v4-pro',
        reasoningEffort: 'high',
      }], 'the whole selection is persisted, not just the route')
    } finally {
      await unmount(harness)
    }
  })

  it('selects normally when no default-model service is mounted', async () => {
    // An embedder may mount the TUI without the service; persistence is the
    // only thing it should lose.
    const harness = await mount()
    try {
      const frame = await runModelCommand(harness, OTHER_ROUTE)
      assert.match(frame, /Model selected/)
      assert.ok(
        !frame.includes('could not be saved'),
        `an absent service is not a failed save:\n${frame}`,
      )
    } finally {
      await unmount(harness)
    }
  })

  it('warns but keeps the selection when the save is rejected', async () => {
    const harness = await mount({
      services: {
        agentDefaultModel: {
          currentSelection: () => SEEDED,
          saveSelection: async () => { throw new Error('settings file is read-only') },
        },
      },
    })
    try {
      const frame = await runModelCommand(harness, OTHER_ROUTE)
      assert.match(frame, /could not be saved/)
      assert.match(frame, /settings file is read-only/)
      // The route the next step runs under moved regardless: what failed is
      // the durability of the choice, not the choice.
      assert.match(frame, /deepseek-v4-pro/)
    } finally {
      await unmount(harness)
    }
  })

  it('writes nothing when the picked model is already selected', async () => {
    const saved: ModelSelection[] = []
    const harness = await mount({
      services: {
        agentDefaultModel: {
          currentSelection: () => SEEDED,
          saveSelection: async (next: ModelSelection) => { saved.push(next) },
        },
      },
    })
    try {
      const frame = await runModelCommand(harness, 'deepseek-official/deepseek-v4-flash')
      assert.match(frame, /already/)
      assert.deepEqual(saved, [], 'the early return changed nothing to persist')
    } finally {
      await unmount(harness)
    }
  })
})

/**
 * The catalog the picker tests open: two routes, one with a reasoning ladder.
 *
 * The dialog is widened past its 76-column default because these assertions are
 * about what the row SAYS; at the default width the description column is
 * narrower than the sentence and the test would be measuring truncation.
 */
const PICKER_OPTIONS: TuiHarnessOptions = {
  config: { modelDialogWidth: 96 },
  catalog: {
    providers: [{ id: 'deepseek-official', name: 'DeepSeek' }],
    models: [
      { provider: 'deepseek-official', id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', description: 'Quick answers' },
      { provider: 'deepseek-official', id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', description: 'Complex work' },
    ],
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
}

/** Open the `/model` picker and settle the catalog read it waits on. */
async function openPicker(harness: Harness): Promise<string> {
  harness.terminal.send('/model')
  harness.terminal.send('\r')
  await delay(SETTLE_MS)
  const frame = harness.terminal.text()
  assert.match(frame, /Select model/, `the picker is open:\n${frame}`)
  return frame
}

describe('model selector', { skip: skipWithoutEntry }, () => {
  it('lists numbered routes with their descriptions and an adjustable effort row', async () => {
    const harness = await mount({
      ...PICKER_OPTIONS,
      services: { agentDefaultModel: { currentSelection: () => SEEDED } },
    })
    try {
      const frame = await openPicker(harness)
      // Claude Code's picker shape: an ordinal per row, the provider's own
      // sentence beside it, and the effort on a line of its own.
      // The route survives the column it sits in: it is the identity
      // `/model <route>` takes, so a truncated one names nothing.
      assert.match(frame, /1\. deepseek-official\/deepseek-v4-flash/)
      assert.match(frame, /2\. deepseek-official\/deepseek-v4-pro/)
      assert.match(frame, /current — DeepSeek V4 Flash/, 'the running route is badged, in the description column')
      assert.match(frame, /DeepSeek V4 Pro — Complex work/)
      assert.match(frame, /Low effort \(default\)/)
      assert.match(frame, /←\/→ to adjust/)
      // Both writes are named where the keys that perform them are.
      assert.match(frame, /Enter save as default/)
      assert.match(frame, /Ctrl\+S this session only/)

      const adjusted = harness.terminal.frames
      harness.terminal.send('\x1b[C')
      await harness.terminal.waitForFrame(adjusted)
      assert.match(harness.terminal.text(), /High effort/, 'the arrow moves the focused row\'s effort')
    } finally {
      await unmount(harness)
    }
  })

  it('saves the default on Enter and says which layer moved', async () => {
    const saved: ModelSelection[] = []
    const harness = await mount({
      ...PICKER_OPTIONS,
      services: {
        agentDefaultModel: {
          currentSelection: () => SEEDED,
          saveSelection: async (next: ModelSelection) => { saved.push(next) },
        },
      },
    })
    try {
      await openPicker(harness)
      harness.terminal.send('\x1b[B')
      harness.terminal.send('\r')
      await delay(SETTLE_MS)
      const frame = harness.terminal.text()
      assert.match(frame, /Saved as your default/, `the global write is disclosed:\n${frame}`)
      assert.deepEqual(saved.map(selection => selection.model), ['deepseek-v4-pro'])
    } finally {
      await unmount(harness)
    }
  })

  it('applies a Ctrl+S pick to this session without touching the default', async () => {
    // The picker used to have one commit key, and it always wrote the user
    // settings layer: trying a model for one task changed every future session.
    const saved: ModelSelection[] = []
    const harness = await mount({
      ...PICKER_OPTIONS,
      services: {
        agentDefaultModel: {
          currentSelection: () => SEEDED,
          saveSelection: async (next: ModelSelection) => { saved.push(next) },
        },
      },
    })
    try {
      await openPicker(harness)
      harness.terminal.send('\x1b[B')
      harness.terminal.send('\x13')
      await delay(SETTLE_MS)
      const frame = harness.terminal.text()
      assert.match(frame, /This session only/)
      assert.deepEqual(saved, [], 'a session-scoped pick writes no settings layer')
      // The route still moved for the steps that follow.
      assert.match(frame, /deepseek-v4-pro/)
    } finally {
      await unmount(harness)
    }
  })

  it('closes on Ctrl+C, filter or no filter', async () => {
    const harness = await mount({
      ...PICKER_OPTIONS,
      services: { agentDefaultModel: { currentSelection: () => SEEDED } },
    })
    try {
      await openPicker(harness)
      harness.terminal.send('pro')
      await delay(SETTLE_MS)
      const closed = harness.terminal.frames
      harness.terminal.send('\x03')
      await harness.terminal.waitForFrame(closed)
      const frame = harness.terminal.text()
      assert.doesNotMatch(frame, /Select model/, `Ctrl+C closes outright, unlike Esc:\n${frame}`)
    } finally {
      await unmount(harness)
    }
  })
})

describe('model selection', { skip: skipWithoutEntry }, () => {
  it('follows the default-model service instead of the route captured at mount', async () => {
    // The service's user layer arrives with an asynchronous settings load, so
    // its answer changes after the TUI is already on screen.
    let selection: ModelSelection = { provider: 'bundled', model: 'inline-default-model' }
    const harness = await mount({
      services: { agentDefaultModel: { currentSelection: () => selection } },
    })
    try {
      assert.match(harness.terminal.text(), /inline-default-model/)

      selection = { provider: 'settings', model: 'user-chosen-model' }
      const frame = await adaptersUpdated(harness)
      assert.match(frame, /user-chosen-model/)
      assert.ok(!frame.includes('inline-default-model'), `the captured route must not survive:\n${frame}`)
    } finally {
      await unmount(harness)
    }
  })

  it('keeps an explicit --model fixed against a changing default', async () => {
    let selection: ModelSelection = { provider: 'settings', model: 'user-chosen-model' }
    const harness = await mount({
      services: {
        agentDefaultModel: { currentSelection: () => selection },
        tuiStartup: {
          model: 'flagged/explicit-model',
          resume: undefined,
          continueLatest: false,
          print: undefined,
          initialPrompt: undefined,
        },
      },
    })
    try {
      assert.match(harness.terminal.text(), /explicit-model/)
      selection = { provider: 'settings', model: 'later-default-model' }
      const frame = await adaptersUpdated(harness)
      assert.match(frame, /explicit-model/)
      assert.ok(!frame.includes('later-default-model'), `an explicit -m wins over the default:\n${frame}`)
    } finally {
      await unmount(harness)
    }
  })

  it('degrades silently while no adapter is registered, then resolves on the adapter commit', async () => {
    let registered = false
    const harness = await mount({
      contextWindow: 200_000,
      catalog: {
        providers: [{ id: 'traex', name: 'TraeX Relay' }],
        models: [{ provider: 'traex', id: 'traex-Seed-2.1-Pro', name: 'Seed 2.1 Pro' }],
        resolveModelInfo: async () => {
          if (!registered) {
            // Shaped like the host's LlmError, but built here: the TUI and the
            // runtime that mounts it load `dsh-llm` from different
            // installations, so the class identity never matches.
            throw Object.assign(new Error('no adapter registered for provider "traex"'), { code: 'NO_ADAPTER' })
          }
          return { context: { contextWindow: 200_000 } }
        },
      },
      services: {
        agentDefaultModel: {
          currentSelection: () => ({ provider: 'traex', model: 'traex-Seed-2.1-Pro' }),
        },
      },
    })
    try {
      const booted = harness.terminal.text()
      assert.ok(
        !booted.includes('Could not resolve model context'),
        `a boot-order failure must not reach the transcript:\n${booted}`,
      )
      // The prompt still names the model; only the context percentage waits.
      assert.match(booted, /traex-Seed-2\.1-Pro/)
      assert.ok(!booted.includes('% context'), `nothing to report until the adapter lands:\n${booted}`)

      registered = true
      const resolved = await adaptersUpdated(harness)
      assert.match(resolved, /% context/)
      assert.ok(
        !resolved.includes('Could not resolve model context'),
        `the retry stays silent too:\n${resolved}`,
      )
    } finally {
      await unmount(harness)
    }
  })
})

describe('subagent route fallback', { skip: skipWithoutEntry }, () => {
  /**
   * Resolve one `agent/request` waterfall the way a child agent's loop does,
   * seeded with the config its own (possibly empty) options propose.
   */
  const resolveRequest = (harness: Harness, seed: LlmCallConfig): Promise<LlmCallConfig> =>
    harness.ctx.waterfall(
      'agent/request',
      { turn: 1, step: 1, signal: new AbortController().signal },
      () => Promise.resolve(seed),
    )

  it('fills a routeless child request with the chat\'s live selection', async () => {
    // A subagent/workflow child mints its own scope and inherits only
    // `AgentOptions` — which this TUI leaves empty so the live default stays
    // live. Without the fallback its loop throws "has no provider/model" and
    // the child dies before its first step.
    const harness = await mount({
      services: { agentDefaultModel: { currentSelection: () => SEEDED } },
    })
    try {
      // The loop proposes `options.provider ?? ''`, so an absent route arrives
      // as empty strings, not undefined.
      const resolved = await resolveRequest(harness, { provider: '', model: '' })
      assert.equal(resolved.provider, SEEDED.provider)
      assert.equal(resolved.model, SEEDED.model)
    } finally {
      await unmount(harness)
    }
  })

  it('leaves an explicitly routed child request untouched', async () => {
    const harness = await mount({
      services: { agentDefaultModel: { currentSelection: () => SEEDED } },
    })
    try {
      // A workflow's per-child provider/model option must win over the chat's
      // own selection: explicit overrides are the documented escape hatch.
      const resolved = await resolveRequest(harness, { provider: 'other-provider', model: 'other-model' })
      assert.equal(resolved.provider, 'other-provider')
      assert.equal(resolved.model, 'other-model')
    } finally {
      await unmount(harness)
    }
  })

  it('passes a routeless request through when nothing is selected anywhere', async () => {
    // No default-model service, and an agent created without options: the
    // fallback has nothing honest to offer, so the loop's own loud
    // "has no provider/model" error stays the outcome.
    const harness = await mount({ agentOptions: {} as never })
    try {
      const resolved = await resolveRequest(harness, { provider: '', model: '' })
      assert.equal(resolved.provider, '')
      assert.equal(resolved.model, '')
    } finally {
      await unmount(harness)
    }
  })
})

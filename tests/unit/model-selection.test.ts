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

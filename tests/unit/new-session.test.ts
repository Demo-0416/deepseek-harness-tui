/**
 * `/new`: starting over without ending anything.
 *
 * The rule every case here defends is that the session being left is kept. No
 * service below this UI can truncate a session log, so "start with an empty
 * context" can only mean a second session — and a command that emptied the
 * screen while leaving the model's context full would be the one outcome a user
 * cannot see and cannot undo.
 * @module dsh-tui/tests/unit/new-session
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import {
  appendAssistant,
  appendUser,
  createTuiTestHarness,
  disposeTuiTestHarness,
  setAgentStatus,
  tuiEntryAvailable,
  type TuiHarness,
  type TuiHarnessOptions,
} from '../harness.ts'
import { HeadlessTerminal } from '../headless-terminal.ts'

/** Literal editor prefix, so a frame assertion never depends on prompt-value registrations. */
const INPUT_PROMPT = 'new> '

/** A command registered on a fiber, and the notice it appends: outwait both. */
const SETTLE_MS = 60

/** `src/index.ts` is landed by a separate port; without it the end-to-end suite cannot run. */
const entryAvailable = await tuiEntryAvailable()
const skipWithoutEntry = entryAvailable
  ? false
  : 'requires src/index.ts to export createTuiChat(ctx, config, runtime)'

type NewHarness = TuiHarness<HeadlessTerminal, (code: number) => void>

async function mount(options: TuiHarnessOptions = {}): Promise<NewHarness> {
  const terminal = new HeadlessTerminal(100, 32)
  const before = terminal.frames
  const harness = await createTuiTestHarness(terminal, () => {}, {
    cwd: '/workspace/project',
    ...options,
    config: {
      title: 'DSH new',
      ...options.config,
      theme: { color: false, inputPrompt: INPUT_PROMPT, ...options.config?.theme },
    },
  })
  await terminal.waitForFrame(before)
  return harness
}

async function unmount(harness: NewHarness): Promise<void> {
  await disposeTuiTestHarness(harness)
  await harness.terminal.dispose()
}

/** Run one slash command through the registry the editor submits into. */
async function run(harness: NewHarness, line: string): Promise<string | undefined> {
  const execution = await harness.ctx.commands.execute(harness.agent, line, AbortSignal.timeout(5_000))
  return execution?.result.text
}

describe('TUI /new', { skip: skipWithoutEntry }, () => {
  it('asks the host for a blank session and keeps this one whole', async () => {
    let handoffs = 0
    const harness = await mount({
      // A host that owns the agent handle never returns, exactly as the real
      // one does not: the replacement chat owns the terminal from there.
      handoffNew: () => {
        handoffs += 1
        return new Promise<never>(() => {})
      },
      beforeMount(session) {
        appendUser(session, 'the thing I asked')
        appendAssistant(session, [{ type: 'text', text: 'the answer' }])
      },
    })
    const before = harness.session.events.map(event => event.type)
    try {
      await delay(SETTLE_MS)
      assert.equal(await run(harness, '/new'), undefined)
      await delay(SETTLE_MS)
      assert.equal(handoffs, 1)
      // Nothing was truncated, dropped, or rewritten: the log the user is
      // leaving is the log `/resume` will bring back. It grows only by the
      // command registry's own lifecycle appends, which record that `/new` ran
      // rather than `/new` editing the log.
      const after = harness.session.events.map(event => event.type)
      assert.deepEqual(after.slice(0, before.length), before)
      assert.deepEqual(after.slice(before.length), ['command/run', 'command/done'])
      const frame = harness.terminal.text().replace(/\s+/gu, ' ')
      assert.match(frame, /keeps its history/u, frame)
    } finally {
      await unmount(harness)
    }
  })

  it('refuses on a runtime that cannot replace the mounted session', async () => {
    const harness = await mount()
    try {
      await delay(SETTLE_MS)
      // An embedder that mounted the chat over an agent it owns cannot have it
      // swapped underneath; saying so beats clearing the screen and leaving the
      // model's context exactly as full as it was.
      assert.match(await run(harness, '/new') ?? '', /cannot open a new session in place/u)
    } finally {
      await unmount(harness)
    }
  })

  it('refuses while a turn is running, as /resume does', async () => {
    let handoffs = 0
    const harness = await mount({
      handoffNew: () => {
        handoffs += 1
        return new Promise<never>(() => {})
      },
    })
    try {
      await delay(SETTLE_MS)
      setAgentStatus(harness.agent, 'running')
      assert.match(await run(harness, '/new') ?? '', /needs an idle agent \(status: running\)/u)
      assert.equal(handoffs, 0, 'a running turn is writing to the log this teardown would release')
    } finally {
      await unmount(harness)
    }
  })
})

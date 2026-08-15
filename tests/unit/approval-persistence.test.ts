/**
 * Durable-grant tests: the fifth answer row writes a rule the next terminal
 * reads, keyed to the project it was given in — and, when the home refuses the
 * write, still holds for the session that gave it.
 *
 * The other half of the file is what the row must NOT be offered for. A
 * whole-tool grant is written on what the prompt could show; a request whose
 * call this terminal could not read, and a shell in particular, gets the four
 * answers it has always had, because "never ask about `bash` here again" is a
 * grant no compound-command check ever sees.
 * @module dsh-tui/tests/unit/approval-persistence
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { CallId } from '@deepseek-ai/dsh-llm'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import {
  createTuiTestHarness,
  disposeTuiTestHarness,
  tuiEntryAvailable,
  type TuiHarness,
  type TuiHarnessOptions,
} from '../harness.ts'
import { HeadlessTerminal } from '../headless-terminal.ts'

/** Literal editor prefix, so a frame assertion never depends on prompt-value registrations. */
const INPUT_PROMPT = 'smoke> '

/** `src/index.ts` is landed by a separate port; without it the end-to-end suite cannot run. */
const entryAvailable = await tuiEntryAvailable()
const skipWithoutEntry = entryAvailable
  ? false
  : 'requires src/index.ts to export createTuiChat(ctx, config, runtime)'

/** A grant is written fire-and-forget; the file catches up a few ticks later. */
const WRITE_TIMEOUT_MS = 2_000

/** A logged tool call reaches the terminal's own listener across a few awaits. */
const SETTLE_MS = 60

type SmokeHarness = TuiHarness<HeadlessTerminal, (code: number) => void>

/** The fail-closed tail of the answerer chain, standing in for the approval service's default. */
function chainDefault(): Promise<ApprovalOutcome> {
  return Promise.resolve('unavailable')
}

/**
 * An editor whose presenter reports the change its arguments would make — the
 * one shape a whole-tool grant is offered on, because it is the one where the
 * prompt showed what it was asking about.
 */
function editTool(): ToolDefinition {
  return defineTool({
    name: 'edit',
    description: 'edit fixture',
    parameters: {
      path: { type: 'string', required: true },
      text: { type: 'string', required: true },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: () => Promise.resolve('done'),
    presentCall: (args) => {
      const call = args as { path: string; text: string }
      return {
        card: 'diff',
        title: `Write ${call.path}`,
        diffs: [{ path: call.path, oldText: null, newText: call.text }],
      }
    },
  })
}

/** Point `$DSH_HOME` at a directory of this case's own, and put it back afterwards. */
async function inTempHome(run: (home: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-tui-approval-home-'))
  const previous = process.env['DSH_HOME']
  process.env['DSH_HOME'] = root
  try {
    await run(root)
  } finally {
    if (previous === undefined) delete process.env['DSH_HOME']
    else process.env['DSH_HOME'] = previous
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
  }
}

/** Mount the TUI on a headless terminal and wait for its first completed frame. */
async function mount(options: TuiHarnessOptions = {}): Promise<SmokeHarness> {
  const terminal = new HeadlessTerminal(96, 32)
  const before = terminal.frames
  const harness = await createTuiTestHarness(terminal, () => {}, {
    cwd: '/workspace/project',
    tools: { edit: editTool() },
    ...options,
    config: {
      title: 'DSH approval',
      ...options.config,
      theme: { color: false, inputPrompt: INPUT_PROMPT, ...options.config?.theme },
    },
  })
  await terminal.waitForFrame(before)
  return harness
}

async function unmount(harness: SmokeHarness): Promise<void> {
  await disposeTuiTestHarness(harness)
  await harness.terminal.dispose()
}

/** Log the call the request is about, the way a driver logs it before executing. */
async function logEdit(harness: SmokeHarness, id: string, path: string): Promise<void> {
  harness.session.append('tool/call', {
    turn: 1,
    step: 1,
    callId: CallId(id),
    name: 'edit',
    arguments: JSON.stringify({ path, text: 'next\n' }),
  })
  await delay(SETTLE_MS)
}

/** Ask the answerer chain about one logged edit. */
function askEdit(harness: SmokeHarness, id: string, reason?: string): Promise<ApprovalOutcome> {
  return harness.ctx.waterfall('approval/request', {
    agent: harness.agent,
    toolName: 'edit',
    callId: CallId(id),
    ...reason === undefined ? {} : { reason },
  }, chainDefault)
}

/** Wait for a fire-and-forget write to land, rather than sleeping a fixed time. */
async function eventually(check: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + WRITE_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (await check()) return
    await delay(10)
  }
  assert.fail(`timed out waiting for ${what}`)
}

/** The allow list one project holds under `home`, or `undefined` while it has none. */
async function storedRules(home: string, cwd: string): Promise<string[] | undefined> {
  try {
    const document = JSON.parse(await readFile(join(home, 'approvals.json'), 'utf8')) as {
      projects?: Record<string, { allow?: string[] } | undefined>
    }
    return document.projects?.[cwd]?.allow
  } catch (_notWrittenYet: unknown) {
    return undefined
  }
}

describe('TUI approval persistence', { skip: skipWithoutEntry }, () => {
  it('writes an allow rule and honours it in a terminal mounted afterwards', async () => {
    await inTempHome(async (home) => {
      const cwd = '/workspace/kept'
      const granting = await mount({ cwd })
      try {
        await logEdit(granting, 'call-one', 'src/a.ts')
        const before = granting.terminal.frames
        const first = askEdit(granting, 'call-one')
        await granting.terminal.waitForFrame(before)
        const asked = granting.terminal.text()
        assert.match(asked, /5\. Yes, and don't ask again for edit in this project/, `the durable row is offered:\n${asked}`)

        const granted = granting.terminal.frames
        granting.terminal.send('5')
        assert.equal(await first, 'allowed-once')
        await granting.terminal.waitForFrame(granted)
        const notice = granting.terminal.text()
        assert.match(notice, /Allowing edit in this project/, `the scope is disclosed:\n${notice}`)
        assert.match(notice, /approvals\.json/, `and so is the file that can revoke it:\n${notice}`)
        assert.doesNotMatch(notice, /Permission required/)

        await eventually(async () => (await storedRules(home, cwd)) !== undefined, 'the rule to reach the file')
        assert.deepEqual(await storedRules(home, cwd), ['edit'])
      } finally {
        await unmount(granting)
      }

      // The point of the whole feature: a terminal that never saw the answer.
      const resumed = await mount({ cwd })
      try {
        await logEdit(resumed, 'call-two', 'src/b.ts')
        const second = askEdit(resumed, 'call-two')
        assert.equal(await second, 'allowed-once')
        // Nothing is drawn for a grant that is already given, so there is no
        // frame to wait for — only the writes already in flight.
        await resumed.terminal.flush()
        assert.doesNotMatch(resumed.terminal.text(), /Permission required/)
      } finally {
        await unmount(resumed)
      }
    })
  })

  it('scopes the stored rule to the project it was granted in', async () => {
    await inTempHome(async (home) => {
      const granting = await mount({ cwd: '/workspace/one' })
      try {
        await logEdit(granting, 'call-one', 'src/a.ts')
        const before = granting.terminal.frames
        const first = askEdit(granting, 'call-one')
        await granting.terminal.waitForFrame(before)
        granting.terminal.send('5')
        assert.equal(await first, 'allowed-once')
        await eventually(async () => (await storedRules(home, '/workspace/one')) !== undefined, 'the rule to reach the file')
      } finally {
        await unmount(granting)
      }

      const elsewhere = await mount({ cwd: '/workspace/two' })
      try {
        await logEdit(elsewhere, 'call-two', 'src/a.ts')
        const before = elsewhere.terminal.frames
        const second = askEdit(elsewhere, 'call-two')
        await elsewhere.terminal.waitForFrame(before)
        const frame = elsewhere.terminal.text()
        assert.match(frame, /Permission required/, `another repository asks for itself:\n${frame}`)
        elsewhere.terminal.send('4')
        assert.equal(await second, 'rejected')
      } finally {
        await unmount(elsewhere)
      }
    })
  })

  it('binds the grant to the sandbox access it was given at', async () => {
    await inTempHome(async (home) => {
      const cwd = '/workspace/escalating'
      const harness = await mount({ cwd })
      try {
        // The ask a host raises when a call was refused by its sandbox: same
        // tool, a reason that names the mode it wants.
        await logEdit(harness, 'call-one', 'src/a.ts')
        const before = harness.terminal.frames
        const first = askEdit(harness, 'call-one', 'escalate sandbox to workspace-write: writes a lock file')
        await harness.terminal.waitForFrame(before)
        const asked = harness.terminal.text()
        assert.match(
          asked,
          /5\. Yes, and don't ask again for edit at workspace-write access in this project/,
          `the row says what it would stop asking about:\n${asked}`,
        )

        const granted = harness.terminal.frames
        harness.terminal.send('5')
        assert.equal(await first, 'allowed-once')
        await harness.terminal.waitForFrame(granted)
        assert.match(harness.terminal.text(), /at workspace-write access/, 'and so does the notice')
        await eventually(async () => (await storedRules(home, cwd)) !== undefined, 'the rule to reach the file')
        assert.deepEqual(await storedRules(home, cwd), ['edit [workspace-write]'])

        // The same call again, asking for more of the machine: a grant for one
        // sandbox is not a grant for a wider one, and this is a NEW call id —
        // which is how a host retries an escalation.
        await logEdit(harness, 'call-two', 'src/a.ts')
        const wider = harness.terminal.frames
        const second = askEdit(harness, 'call-two', 'escalate sandbox to danger-full-access: needs the network')
        await harness.terminal.waitForFrame(wider)
        const frame = harness.terminal.text()
        assert.match(frame, /Permission required/, `full access is its own question:\n${frame}`)
        harness.terminal.send('4')
        assert.equal(await second, 'rejected')

        // And the ask it WAS granted for is still answered without a prompt.
        await logEdit(harness, 'call-three', 'src/a.ts')
        const third = askEdit(harness, 'call-three', 'escalate sandbox to workspace-write: writes a lock file')
        assert.equal(await third, 'allowed-once')
        await harness.terminal.flush()
        assert.doesNotMatch(harness.terminal.text(), /Permission required/)
      } finally {
        await unmount(harness)
      }
    })
  })

  it('offers no permanent grant for a request it could not look behind', async () => {
    await inTempHome(async (home) => {
      const cwd = '/workspace/degraded'
      const harness = await mount({ cwd })
      try {
        // A background shell presents a plain card, so the prompt has no
        // command — and a whole-tool `bash` rule would be a blanket grant that
        // the compound-command check never sees again. There is deliberately no
        // row for it.
        const before = harness.terminal.frames
        const first = harness.ctx.waterfall('approval/request', {
          agent: harness.agent,
          toolName: 'bash',
          reason: 'run the build in the background',
        }, chainDefault)
        await harness.terminal.waitForFrame(before)
        const frame = harness.terminal.text()
        assert.match(frame, /Permission required/)
        assert.match(frame, /4\. No, reject/, `the four answers are all there:\n${frame}`)
        assert.doesNotMatch(frame, /5\./, `and none of them is a blanket bash grant:\n${frame}`)
        assert.doesNotMatch(frame, /don't ask again for bash in this project/)
        harness.terminal.send('4')
        assert.equal(await first, 'rejected')
        await harness.terminal.flush()
        assert.equal(await storedRules(home, cwd), undefined, 'nothing was written')
      } finally {
        await unmount(harness)
      }
    })
  })

  it('keeps the grant for this session when the rules file cannot be written', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-tui-approval-blocked-'))
    const previous = process.env['DSH_HOME']
    // A regular file where the home directory would have to be: unwritable for
    // any user, so every write under it fails and the grant has only memory.
    await writeFile(join(root, 'blocked'), '', 'utf8')
    process.env['DSH_HOME'] = join(root, 'blocked', 'home')
    const harness = await mount({ cwd: '/workspace/unwritable' })
    try {
      await logEdit(harness, 'call-one', 'src/a.ts')
      const before = harness.terminal.frames
      const first = askEdit(harness, 'call-one')
      await harness.terminal.waitForFrame(before)

      const granted = harness.terminal.frames
      harness.terminal.send('5')
      assert.equal(await first, 'allowed-once', 'the answer is honoured whatever the disk says')
      await harness.terminal.waitForFrame(granted)

      await logEdit(harness, 'call-two', 'src/b.ts')
      const second = askEdit(harness, 'call-two')
      assert.equal(await second, 'allowed-once')
      await harness.terminal.flush()
      const frame = harness.terminal.text()
      assert.doesNotMatch(frame, /Permission required/, `the grant still holds in memory:\n${frame}`)
      // The failure is a log line, never a dialog: a user answering a
      // permission prompt is not the person who can fix a read-only home.
      assert.doesNotMatch(frame, /ENOTDIR|ENOENT/, `and it is not shouted at the user:\n${frame}`)
    } finally {
      await unmount(harness)
      if (previous === undefined) delete process.env['DSH_HOME']
      else process.env['DSH_HOME'] = previous
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
    }
  })

  it('stores a grant made on a machine whose harness home does not exist yet', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-tui-approval-fresh-'))
    const previous = process.env['DSH_HOME']
    // A first run: nothing has created `$DSH_HOME`, and the rules file is the
    // first thing under it. The grant has to make its own bed.
    const home = join(root, 'never-made', 'home')
    process.env['DSH_HOME'] = home
    const cwd = '/workspace/first-run'
    const harness = await mount({ cwd })
    let mounted = true
    try {
      await logEdit(harness, 'call-one', 'src/a.ts')
      const before = harness.terminal.frames
      const first = askEdit(harness, 'call-one')
      await harness.terminal.waitForFrame(before)
      harness.terminal.send('5')
      assert.equal(await first, 'allowed-once')
      // Leaving is where a fire-and-forget write is lost, so the terminal waits
      // for it on the way out: after the dispose there is nothing left to poll
      // for, and the file is either there or the grant was a lie.
      await unmount(harness)
      mounted = false
      assert.deepEqual(await storedRules(home, cwd), ['edit'], 'the grant outlived the process that gave it')
    } finally {
      if (mounted) await unmount(harness)
      if (previous === undefined) delete process.env['DSH_HOME']
      else process.env['DSH_HOME'] = previous
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
    }
  })
})

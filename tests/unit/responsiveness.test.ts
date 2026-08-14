/**
 * Work the terminal must not repeat, and waits it must not hide: which tool
 * results drop the `@` workspace index, how often the context meter re-folds a
 * session, and what the status row says while an asynchronous command is
 * assembling its answer.
 * @module dsh-tui/tests/unit/responsiveness
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { CallId, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import {
  appendAssistant,
  createTuiTestHarness,
  disposeTuiTestHarness,
  tuiEntryAvailable,
  type TuiHarness,
  type TuiHarnessOptions,
} from '../harness.ts'
import { HeadlessTerminal } from '../headless-terminal.ts'
import { toolCallTouchesFiles, WorkspaceFileSearch } from '../../src/chat/file-autocomplete.ts'

/** `src/index.ts` is landed by a separate port; without it the end-to-end suite cannot run. */
const entryAvailable = await tuiEntryAvailable()
const skipWithoutEntry = entryAvailable
  ? false
  : 'requires src/index.ts to export createTuiChat(ctx, config, runtime)'

/** Literal editor prefix, so "the editor is on screen" needs no prompt registrations. */
const INPUT_PROMPT = 'dsh> '

/** Frames, notices, and catalog reads settle across a few awaits; outwait them. */
const SETTLE_MS = 60

type Harness = TuiHarness<HeadlessTerminal, (code: number) => void>

async function mount(options: TuiHarnessOptions = {}): Promise<Harness> {
  const terminal = new HeadlessTerminal(100, 28)
  const before = terminal.frames
  const harness = await createTuiTestHarness(terminal, () => {}, {
    cwd: '/workspace/project',
    ...options,
    config: {
      title: 'DSH responsiveness',
      welcome: 'ready.',
      ...options.config,
      theme: { color: false, inputPrompt: INPUT_PROMPT, ...options.config?.theme },
    },
  })
  await terminal.waitForFrame(before)
  return harness
}

async function unmount(harness: Harness): Promise<void> {
  await disposeTuiTestHarness(harness)
  await harness.terminal.dispose()
}

/** A tool whose only interesting property is the render intent it declares. */
function toolWithIntent(name: string, presentCall: ToolDefinition['presentCall']): ToolDefinition {
  return defineTool({
    name,
    description: `${name} fixture`,
    parameters: { path: { type: 'string', required: true } },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: () => Promise.resolve('done'),
    ...presentCall === undefined ? {} : { presentCall },
  })
}

/** Log one completed tool call, the way a driver logs it around an execution. */
function logToolCall(session: Session, id: string, name: string, args: string): void {
  const callId = CallId(id)
  session.append('tool/call', { turn: 1, step: 1, callId, name, arguments: args })
  session.append('tool/result', {
    turn: 1,
    step: 1,
    message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'ok' }], isError: false }),
  }, { surfaceOp: 'append' })
}

describe('file-index invalidation policy', () => {
  it('keeps the index for calls whose declared intent cannot move a file', () => {
    const read = toolWithIntent('read', () => ({ card: 'generic', title: 'read', kind: 'read' }))
    const grep = toolWithIntent('grep', () => ({ card: 'generic', title: 'grep', kind: 'search' }))
    const fetch = toolWithIntent('web_fetch', () => ({ card: 'generic', title: 'fetch', kind: 'fetch' }))
    const todo = toolWithIntent('todo_write', () => ({ card: 'generic', title: 'todos', kind: 'other' }))

    // Dropping a 10k-path traversal because a web search came back is the
    // rebuild the next `@` pays for, during the interaction `@` is used in.
    assert.equal(toolCallTouchesFiles(read, '{"path":"a.ts"}'), false)
    assert.equal(toolCallTouchesFiles(grep, '{"path":"a.ts"}'), false)
    assert.equal(toolCallTouchesFiles(fetch, '{"path":"a.ts"}'), false)
    assert.equal(toolCallTouchesFiles(todo, '{"path":"a.ts"}'), false)
  })

  it('drops it for a mutation, a shell, and any intent that is not read-only', () => {
    const write = toolWithIntent('write', args => ({
      card: 'diff',
      title: 'write',
      diffs: [{ path: (args as { path: string }).path, oldText: null, newText: 'next' }],
    }))
    const bash = toolWithIntent('bash', () => ({ card: 'terminal', title: 'rm -rf build' }))
    const move = toolWithIntent('move', () => ({ card: 'generic', title: 'move', kind: 'move' }))

    assert.equal(toolCallTouchesFiles(write, '{"path":"a.ts"}'), true)
    // A shell's side effects are unknowable from its arguments, so it counts as
    // a write rather than as an unknown.
    assert.equal(toolCallTouchesFiles(bash, '{"path":"a.ts"}'), true)
    assert.equal(toolCallTouchesFiles(move, '{"path":"a.ts"}'), true)
  })

  it('assumes a write for anything it cannot classify', () => {
    const unpresented = toolWithIntent('mystery', undefined)
    const undeclared = toolWithIntent('shy', () => undefined)
    const thrower = toolWithIntent('broken', () => { throw new Error('presenter is wrong') })
    const untyped = toolWithIntent('untyped', () => ({ card: 'generic', title: 'untyped' }))

    // A stale completion list is a wrong answer; a redundant rescan is only
    // slow. Unknown therefore resolves to "rebuild", never to "keep".
    assert.equal(toolCallTouchesFiles(undefined, '{"path":"a.ts"}'), true)
    assert.equal(toolCallTouchesFiles(unpresented, '{"path":"a.ts"}'), true)
    assert.equal(toolCallTouchesFiles(undeclared, '{"path":"a.ts"}'), true)
    assert.equal(toolCallTouchesFiles(thrower, '{"path":"a.ts"}'), true)
    assert.equal(toolCallTouchesFiles(untyped, '{"path":"a.ts"}'), true)
    assert.equal(toolCallTouchesFiles(untyped, 'not json at all'), true)
  })
})

describe('file index and the session log', { skip: skipWithoutEntry }, () => {
  it('rebuilds only after the tool results that could have changed the tree', async () => {
    const invalidations: number[] = []
    const original = WorkspaceFileSearch.prototype.invalidate
    // The index is channel-private, so the count is taken where it happens.
    WorkspaceFileSearch.prototype.invalidate = function patched(this: WorkspaceFileSearch): void {
      invalidations.push(1)
      original.call(this)
    }
    let harness: Harness | undefined
    try {
      harness = await mount({
        tools: {
          grep: toolWithIntent('grep', () => ({ card: 'generic', title: 'grep', kind: 'search' })),
          write: toolWithIntent('write', args => ({
            card: 'diff',
            title: 'write',
            diffs: [{ path: (args as { path: string }).path, oldText: null, newText: 'next' }],
          })),
        },
      })
      const before = invalidations.length

      logToolCall(harness.session, 'call-grep', 'grep', '{"path":"src"}')
      await delay(SETTLE_MS)
      assert.equal(invalidations.length, before, 'a search leaves the workspace exactly as it found it')

      logToolCall(harness.session, 'call-write', 'write', '{"path":"src/new.ts"}')
      await delay(SETTLE_MS)
      assert.equal(invalidations.length, before + 1, 'a write is what the index has to be rebuilt for')

      // An orphaned result — its call compacted away, or the TUI mounted
      // mid-turn — names no tool, so it is treated as a write.
      harness.session.append('tool/result', {
        turn: 1,
        step: 1,
        message: createToolResultMessage({
          callId: CallId('call-orphan'),
          content: [{ type: 'text', text: 'ok' }],
          isError: false,
        }),
      }, { surfaceOp: 'append' })
      await delay(SETTLE_MS)
      assert.equal(invalidations.length, before + 2)
    } finally {
      WorkspaceFileSearch.prototype.invalidate = original
      if (harness !== undefined) await unmount(harness)
    }
  })
})

describe('context meter', { skip: skipWithoutEntry }, () => {
  it('re-folds the session only when the log has grown', async () => {
    let measures = 0
    const harness = await mount({
      services: {
        tokenMeter: {
          measure() {
            measures += 1
            return { totalTokens: 1_000 }
          },
        },
      },
    })
    try {
      await delay(SETTLE_MS)
      const afterMount = measures
      assert.ok(afterMount > 0, 'the prompt row asks for a measurement once the context window resolves')

      // Every keystroke repaints the prompt row, and the measurement folds the
      // whole log: on a long session, per-frame measuring is per-frame O(events).
      harness.terminal.send('typing a long prompt')
      await delay(SETTLE_MS)
      assert.equal(measures, afterMount, 'redraws reuse the measurement of an unchanged log')

      appendAssistant(harness.session, [{ type: 'text', text: 'an answer' }], {
        inputTokens: 10,
        outputTokens: 5,
      })
      await delay(SETTLE_MS)
      assert.ok(measures > afterMount, 'and a longer log is measured again')
    } finally {
      await unmount(harness)
    }
  })
})

describe('pending-command hints', { skip: skipWithoutEntry }, () => {
  it('says /model is loading while the provider catalog is being read', async () => {
    let releaseCatalog = (): void => {}
    const catalogRead = new Promise<void>((resolve) => { releaseCatalog = () => { resolve() } })
    const harness = await mount({
      catalog: {
        providers: [{ id: 'deepseek-official', name: 'DeepSeek' }],
        models: [{ provider: 'deepseek-official', id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }],
        listModels: async () => {
          await catalogRead
          return [{ provider: 'deepseek-official', id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }]
        },
      },
    })
    try {
      harness.terminal.send('/model')
      harness.terminal.send('\r')
      await delay(SETTLE_MS)

      // A slow adapter used to swallow the key press entirely: no selector, no
      // row, nothing that said the command had been accepted.
      assert.match(harness.terminal.text(), /Loading models…/)

      releaseCatalog()
      await delay(SETTLE_MS)
      const opened = harness.terminal.text()
      assert.doesNotMatch(opened, /Loading models…/, `the hint goes down with the wait:\n${opened}`)
      assert.match(opened, /deepseek-v4-flash/, `and the selector is what replaced it:\n${opened}`)
    } finally {
      await unmount(harness)
    }
  })

  it('says /status is collecting while the system prompt assembles', async () => {
    const harness = await mount()
    let releaseAssembly = (): void => {}
    const assembling = new Promise<void>((resolve) => { releaseAssembly = () => { resolve() } })
    // The documented extension seam: a waterfall handler holds the assembly the
    // way a section that reads a cold file would.
    const stopHolding = harness.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      await assembling
      return next()
    })
    try {
      harness.terminal.send('/status')
      harness.terminal.send('\r')
      await delay(SETTLE_MS)
      assert.match(harness.terminal.text(), /Collecting session status…/)

      releaseAssembly()
      await delay(SETTLE_MS)
      const panel = harness.terminal.text()
      assert.doesNotMatch(panel, /Collecting session status…/, `the hint ends with the work:\n${panel}`)
      assert.match(panel, /Session status/, `and the panel is what replaced it:\n${panel}`)
    } finally {
      stopHolding()
      await unmount(harness)
    }
  })
})

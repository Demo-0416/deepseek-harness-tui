/**
 * `/export clipboard`: the Markdown a session renders into, the keyword that
 * asks for it, the argument menu that names the keyword, and the wiring that
 * puts the result on the system clipboard.
 *
 * The file half of `/export` is covered by the parity suite and is untouched
 * here beyond one regression case. Like `copy.test.ts`, every mounted case runs
 * the OSC 52 path, forced through the environment, so the suite never touches
 * the real clipboard of the machine it runs on.
 * @module dsh-tui/tests/unit/export-clipboard
 */

import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, afterEach, before, describe, it } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { CallId, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import {
  copyArgumentCompletions,
  exportArgumentCompletions,
} from '../../src/chat/command-completions.ts'
import {
  clipSessionMarkdown,
  isClipboardExportTarget,
  MARKDOWN_MAX_CHARS,
  renderSessionMarkdown,
} from '../../src/chat/export.ts'
import type { TranscriptEntry } from '../../src/chat/transcript-search.ts'
import { setLocale } from '../../src/i18n/index.ts'
import {
  appendAssistant,
  appendUser,
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

/** The clipboard write resolves through the port's own awaits; outwait them. */
const SETTLE_MS = 60

/** A fixed export clock, so the header's ISO stamp is an assertable literal. */
const EXPORTED_AT = 1_755_216_000_000

const savedEnv = { ssh: process.env['SSH_CONNECTION'], tmux: process.env['TMUX'] }

before(() => {
  process.env['SSH_CONNECTION'] = '1.2.3.4 5 6.7.8.9 22'
  delete process.env['TMUX']
})

after(() => {
  if (savedEnv.ssh === undefined) delete process.env['SSH_CONNECTION']
  else process.env['SSH_CONNECTION'] = savedEnv.ssh
  if (savedEnv.tmux !== undefined) process.env['TMUX'] = savedEnv.tmux
})

afterEach(() => { setLocale('en') })

/** One flattened entry, with the fields no assertion here reads filled in. */
function entry(role: TranscriptEntry['role'], label: string, text: string): TranscriptEntry {
  return { key: `${role}-${label}`, role, label, time: 0, text }
}

describe('renderSessionMarkdown', () => {
  const conversation = [
    entry('user', 'You', 'hello there'),
    entry('assistant', 'Assistant', 'hi **back**'),
  ]

  it('heads the document with the session title and the facts under it', () => {
    const markdown = renderSessionMarkdown(conversation, {
      sessionId: 's-1',
      title: 'My session',
      cwd: '/workspace/project',
      model: 'mock/deepseek-v4-flash',
      exportedAt: EXPORTED_AT,
    })

    assert.ok(markdown.startsWith('# My session\n'), markdown)
    assert.ok(markdown.includes('- Session: s-1'), markdown)
    assert.ok(markdown.includes('- Directory: /workspace/project'), markdown)
    assert.ok(markdown.includes('- Model: mock/deepseek-v4-flash'), markdown)
    assert.ok(markdown.includes('- Exported: 2025-08-15T00:00:00.000Z'), markdown)
  })

  it('falls back to the session id when no title was ever folded', () => {
    const markdown = renderSessionMarkdown(conversation, { sessionId: 's-1', exportedAt: EXPORTED_AT })
    assert.ok(markdown.startsWith('# Session s-1\n'), markdown)
  })

  it('omits the facts this session has no answer for', () => {
    const markdown = renderSessionMarkdown(conversation, { sessionId: 's-1', exportedAt: EXPORTED_AT })
    assert.ok(!markdown.includes('Directory:'), markdown)
    assert.ok(!markdown.includes('Model:'), markdown)
  })

  it('writes one heading per entry, bodies verbatim, one blank line between blocks', () => {
    const markdown = renderSessionMarkdown(conversation, { sessionId: 's-1', exportedAt: EXPORTED_AT })

    assert.ok(markdown.includes('## You\n\nhello there\n\n## Assistant\n\nhi **back**'), markdown)
    assert.ok(markdown.endsWith('\n'), 'the document is newline terminated')
    assert.ok(!markdown.endsWith('\n\n'), 'and terminated exactly once')
  })

  it('fences a tool entry and clips a body that would swamp the payload', () => {
    const markdown = renderSessionMarkdown(
      [entry('tool', 'read', `read(path: a)\n${'x'.repeat(1000)}`)],
      { sessionId: 's-1', exportedAt: EXPORTED_AT },
    )

    const block = /```\n([\s\S]*?)\n```/u.exec(markdown)?.[1]
    assert.ok(block !== undefined, markdown)
    assert.ok(block.length <= 400, `the tool body is clipped: ${block.length}`)
    assert.ok(block.endsWith('…'), 'and says that it was')
    assert.ok(!markdown.includes('x'.repeat(400)), 'nothing past the clip survives')
  })

  it('widens the fence past any backtick run inside the body', () => {
    const markdown = renderSessionMarkdown(
      [entry('tool', 'read', 'read(path: a)\n````not a fence````')],
      { sessionId: 's-1', exportedAt: EXPORTED_AT },
    )

    assert.ok(markdown.includes('`````\nread(path: a)\n````not a fence````\n`````'), markdown)
  })

  it('renders a reference entry as a bullet list', () => {
    const markdown = renderSessionMarkdown(
      [entry('reference', 'Sessions', 'session-a\nsession-b')],
      { sessionId: 's-1', exportedAt: EXPORTED_AT },
    )

    assert.ok(markdown.includes('- session-a\n- session-b'), markdown)
  })

  it('escapes terminal controls out of every body it renders', () => {
    const markdown = renderSessionMarkdown(
      [entry('assistant', 'Assistant', 'before]52;c;xafter')],
      { sessionId: 's-1', exportedAt: EXPORTED_AT },
    )

    assert.ok(!markdown.includes(''), 'no bare escape reaches the clipboard')
    assert.ok(markdown.includes('\\x1b'), markdown)
  })

  it('follows the active locale, like every other line this terminal shows', () => {
    setLocale('zh')
    const markdown = renderSessionMarkdown(
      [entry('assistant', '助手', 'hi')],
      { sessionId: 's-1', exportedAt: EXPORTED_AT },
    )

    assert.ok(markdown.includes('## 助手'), markdown)
    assert.ok(markdown.includes('- 会话: s-1'), markdown)
    assert.ok(markdown.includes('- 导出时间: '), markdown)
  })
})

describe('clipSessionMarkdown', () => {
  it('leaves a document that fits exactly as it was rendered', () => {
    const document = renderSessionMarkdown(
      [entry('assistant', 'Assistant', 'x'.repeat(1000))],
      { sessionId: 's-1', exportedAt: EXPORTED_AT },
    )

    assert.deepEqual(clipSessionMarkdown(document), { text: document, truncated: false })
  })

  it('holds a long session to the budget and marks what it cut', () => {
    // The whole document is one OSC 52 write: clipping only tool bodies still
    // let a long conversation render hundreds of kilobytes into one sequence,
    // which terminals drop in silence.
    const document = renderSessionMarkdown(
      [entry('assistant', 'Assistant', 'y'.repeat(MARKDOWN_MAX_CHARS * 2))],
      { sessionId: 's-1', exportedAt: EXPORTED_AT },
    )
    const clipped = clipSessionMarkdown(document)

    assert.equal(clipped.truncated, true)
    assert.ok(clipped.text.length <= MARKDOWN_MAX_CHARS, `${clipped.text.length} characters went out`)
    assert.ok(clipped.text.startsWith('# Session s-1\n'), 'the head of the document survives')
    assert.match(clipped.text, /… export truncated at 100000 characters …\n$/u, 'and says where it stops')
  })

  it('never ends on half of a surrogate pair, which the UTF-8 encoding would eat', () => {
    // Every budget in the sweep cuts the emoji run at a different offset, so
    // half of them land between the two halves of a pair.
    for (let max = 60; max < 70; max += 1) {
      const clipped = clipSessionMarkdown('😀'.repeat(200), max)
      assert.equal(clipped.truncated, true)
      assert.doesNotMatch(clipped.text, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u, `budget ${max}: ${clipped.text}`)
    }
  })

  it('keeps the marker even where the budget cannot hold it, because saying so is the point', () => {
    const clipped = clipSessionMarkdown('z'.repeat(100), 10)

    assert.equal(clipped.truncated, true)
    assert.match(clipped.text, /export truncated at 10 characters/u)
    assert.ok(!clipped.text.includes('z'), 'nothing of the document survives a budget that small')
  })
})

describe('isClipboardExportTarget', () => {
  it('takes the bare keyword, in any case and with any padding', () => {
    for (const input of ['clipboard', ' Clipboard ', 'CLIPBOARD']) {
      assert.equal(isClipboardExportTarget(input), true, input)
    }
  })

  it('leaves anything that could be a path to the file export', () => {
    for (const input of ['', './clipboard', 'clipboard.md', 'clipboard extra', 'notes.jsonl']) {
      assert.equal(isClipboardExportTarget(input), false, input)
    }
  })
})

describe('export and copy argument completions', () => {
  it('names the one /export value that is not a path', () => {
    const rows = exportArgumentCompletions('')
    assert.equal(rows?.length, 1)
    assert.equal(rows?.[0]?.value, 'clipboard')
    assert.notEqual(rows?.[0]?.description, '')
    assert.equal(exportArgumentCompletions('cli')?.length, 1)
  })

  it('opens no menu once the argument can only be a path', () => {
    assert.equal(exportArgumentCompletions('notes.jsonl'), null)
  })

  it('numbers the answers and shows what each one leads with', () => {
    const rows = copyArgumentCompletions(['newest', 'older'], '', 8)
    assert.deepEqual(rows?.map(row => row.value), ['1', '2'])
    assert.match(rows?.[0]?.description ?? '', /newest/u)
    assert.match(rows?.[1]?.description ?? '', /older/u)
  })

  it('narrows to the ordinal being typed, and stops at the limit', () => {
    assert.deepEqual(copyArgumentCompletions(['newest', 'older'], '2', 8)?.map(row => row.value), ['2'])
    assert.equal(copyArgumentCompletions(['newest', 'older'], '', 1)?.length, 1)
  })

  it('opens no menu for a session with no answers', () => {
    assert.equal(copyArgumentCompletions([], '', 8), null)
  })
})

type ExportHarness = TuiHarness<HeadlessTerminal, (code: number) => void> & {
  /** Every raw chunk written to the terminal, frames included. */
  readonly writes: string[]
}

/** Mount the TUI on a headless terminal that also records every raw write. */
async function mount(options: TuiHarnessOptions = {}): Promise<ExportHarness> {
  const terminal = new HeadlessTerminal(96, 32)
  const writes: string[] = []
  const emulate = terminal.write.bind(terminal)
  terminal.write = (data: string) => {
    writes.push(data)
    emulate(data)
  }
  const before_ = terminal.frames
  const harness = await createTuiTestHarness(terminal, () => {}, {
    cwd: '/workspace/project',
    now: () => EXPORTED_AT,
    ...options,
    config: {
      title: 'DSH export',
      ...options.config,
      theme: { color: false, inputPrompt: 'dsh> ', ...options.config?.theme },
    },
  })
  await terminal.waitForFrame(before_)
  return Object.assign(harness, { writes })
}

async function unmount(harness: ExportHarness): Promise<void> {
  await disposeTuiTestHarness(harness)
  await harness.terminal.dispose()
}

/** Run one slash command through the registry the editor submits into. */
async function run(harness: ExportHarness, line: string): Promise<CommandResult | undefined> {
  const execution = await harness.ctx.commands.execute(harness.agent, line, AbortSignal.timeout(5_000))
  return execution?.result
}

/** The one chunk carrying an OSC 52 clipboard write, or `undefined`. */
function clipboardWrite(writes: readonly string[]): string | undefined {
  return writes.find(chunk => chunk.includes('\x1b]52;c;'))
}

/** The text a clipboard write carried, decoded back out of its OSC 52 payload. */
function clipboardText(writes: readonly string[]): string | undefined {
  const sequence = clipboardWrite(writes)
  if (sequence === undefined) return undefined
  const payload = /\x1b\]52;c;([^\x07]*)\x07/u.exec(sequence)?.[1] ?? ''
  return Buffer.from(payload, 'base64').toString('utf8')
}

/** A session with one exchange in it, which is what a Markdown export is of. */
function oneExchange(): TuiHarnessOptions {
  return {
    beforeMount(session) {
      appendUser(session, 'hello there')
      appendAssistant(session, [{ type: 'text', text: 'hi **back**' }])
    },
  }
}

/** One complete tool step, so the session has an entry that is not a message. */
function appendToolStep(session: Session, id: string, command: string, output: string): void {
  const callId = CallId(id)
  const position = { turn: 1, step: 2 }
  const args = JSON.stringify({ command })
  session.append('step/start', position)
  appendAssistant(session, [{ type: 'tool-call', id: callId, name: 'bash', arguments: args }], undefined, position)
  session.append('tool/call', { ...position, callId, name: 'bash', arguments: args })
  session.append('tool/result', {
    ...position,
    message: createToolResultMessage({ callId, content: [{ type: 'text', text: output }], isError: false }),
  }, { surfaceOp: 'append' })
  session.append('step/end', position)
}

describe('/export clipboard', { skip: skipWithoutEntry }, () => {
  it('puts the session on the clipboard as Markdown', async () => {
    const harness = await mount(oneExchange())
    try {
      const result = await run(harness, '/export clipboard')
      await delay(SETTLE_MS)

      assert.equal(result?.kind, 'success')
      assert.match(result?.text ?? '', /^Exported \d+ entr(?:y|ies) as Markdown\. Sent to clipboard via OSC 52\.$/u)
      const markdown = clipboardText(harness.writes)
      assert.ok(markdown !== undefined, 'a clipboard write went out')
      assert.ok(markdown.startsWith('# '), markdown)
      assert.ok(markdown.includes('## You'), markdown)
      assert.ok(markdown.includes('hello there'), markdown)
      assert.ok(markdown.includes('## Assistant'), markdown)
      assert.ok(markdown.includes('hi **back**'), markdown)
      assert.ok(markdown.includes('- Exported: 2025-08-15T'), markdown)
      assert.ok(!markdown.includes(''), 'and nothing in it can drive the terminal')
      // Written outside the frame's synchronized update, like every other
      // clipboard sequence this terminal emits.
      assert.doesNotMatch(clipboardWrite(harness.writes) ?? '', /\x1b\[\?2026[hl]/u)
    } finally {
      await unmount(harness)
    }
  })

  it('counts entries, not messages: a tool card is in the document and in the count', async () => {
    const harness = await mount({
      beforeMount(session) {
        appendUser(session, 'run the tests')
        appendToolStep(session, 'call-1', 'npm test', '780 passing')
        appendAssistant(session, [{ type: 'text', text: 'all green' }])
      },
    })
    try {
      const result = await run(harness, '/export clipboard')
      await delay(SETTLE_MS)

      const markdown = clipboardText(harness.writes) ?? ''
      const headings = markdown.match(/^## /gmu)?.length ?? 0
      assert.ok(markdown.includes('## bash'), `the tool card is one of the exported entries: ${markdown}`)
      // What is counted is what `/search` flattens, which is what the document
      // is made of — three headings here, and only two of them are messages.
      assert.equal(headings, 3, markdown)
      assert.equal(result?.text, `Exported ${headings} entries as Markdown. Sent to clipboard via OSC 52.`)
    } finally {
      await unmount(harness)
    }
  })

  it('cuts a session past the one-write budget and says so instead of reporting a clean success', async () => {
    const harness = await mount({
      beforeMount(session) {
        appendUser(session, 'paste the file back to me')
        appendAssistant(session, [{ type: 'text', text: 'x'.repeat(MARKDOWN_MAX_CHARS + 5_000) }])
      },
    })
    try {
      const result = await run(harness, '/export clipboard')
      await delay(SETTLE_MS)

      const markdown = clipboardText(harness.writes) ?? ''
      assert.ok(markdown.length <= MARKDOWN_MAX_CHARS, `${markdown.length} characters reached the terminal`)
      assert.match(markdown, /export truncated at 100000 characters …\n$/u, 'the document says it is partial')
      assert.equal(result?.kind, 'success')
      assert.equal(
        result?.text,
        'Exported 2 entries as Markdown, truncated to 100000 characters. Sent to clipboard via OSC 52.',
      )
    } finally {
      await unmount(harness)
    }
  })

  it('spends that budget only where it exists: a piped clipboard path gets the whole document', async () => {
    // `tmux load-buffer -` (like `pbcopy` and `wl-copy`) is fed through a pipe
    // with no per-write ceiling, so the OSC 52 budget must not reach it — a
    // clipped document there would drop text the clipboard would have taken
    // whole. `tmux` itself is kept off PATH: the assertion is about which
    // document was handed over, and no test may start a tmux server.
    const savedPath = process.env['PATH']
    process.env['TMUX'] = '/tmp/dsh-export-test,1,0'
    process.env['PATH'] = ''
    const body = 'x'.repeat(MARKDOWN_MAX_CHARS + 5_000)
    const harness = await mount({
      beforeMount(session) {
        appendUser(session, 'paste the file back to me')
        appendAssistant(session, [{ type: 'text', text: body }])
      },
    })
    try {
      const result = await run(harness, '/export clipboard')
      await delay(SETTLE_MS)

      const markdown = clipboardText(harness.writes) ?? ''
      assert.ok(markdown.includes(body), `the answer went out whole: ${markdown.length} characters`)
      assert.doesNotMatch(markdown, /export truncated at/u, 'and carries no truncation marker')
      assert.equal(result?.kind, 'success')
      assert.equal(result?.text, 'Exported 2 entries as Markdown. Copied to tmux buffer (prefix+] to paste).')
    } finally {
      delete process.env['TMUX']
      if (savedPath === undefined) delete process.env['PATH']
      else process.env['PATH'] = savedPath
      await unmount(harness)
    }
  })

  it('reads the keyword whatever case and padding it arrives in', async () => {
    const harness = await mount(oneExchange())
    try {
      const result = await run(harness, '/export  CLIPBOARD ')
      await delay(SETTLE_MS)

      assert.equal(result?.kind, 'success')
      assert.ok(clipboardWrite(harness.writes) !== undefined, 'the keyword still reached the clipboard path')
    } finally {
      await unmount(harness)
    }
  })

  it('refuses an empty session rather than copying a header with nothing under it', async () => {
    const harness = await mount({ omitInitialLifecycle: true })
    try {
      const result = await run(harness, '/export clipboard')
      await delay(SETTLE_MS)

      assert.equal(result?.kind, 'error')
      assert.equal(result?.text, 'Nothing to export yet: this session has no messages.')
      assert.equal(clipboardWrite(harness.writes), undefined)
    } finally {
      await unmount(harness)
    }
  })

  it('treats ./clipboard as a path, because only the bare word is the keyword', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-tui-export-'))
    const harness = await mount({ ...oneExchange(), cwd: workspace })
    try {
      const result = await run(harness, '/export ./clipboard')
      await delay(SETTLE_MS)

      assert.match(result?.text ?? '', /^Session log exported to /u)
      const written = await readFile(join(workspace, 'clipboard'), 'utf8')
      assert.match(written.split('\n')[0] ?? '', /^\{"type":"session"/u)
      assert.equal(clipboardWrite(harness.writes), undefined, 'and nothing reached the clipboard')
    } finally {
      await unmount(harness)
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('leaves the argument-less /export writing its default file', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-tui-export-'))
    const harness = await mount({
      ...oneExchange(),
      cwd: workspace,
      config: { sessionId: 'plain-export' },
    })
    try {
      const result = await run(harness, '/export')
      await delay(SETTLE_MS)

      assert.match(result?.text ?? '', /^Session log exported to /u)
      const written = await readFile(join(workspace, 'dsh-session-plain-export.jsonl'), 'utf8')
      assert.notEqual(written, '')
      assert.equal(clipboardWrite(harness.writes), undefined)
    } finally {
      await unmount(harness)
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('advertises both arguments, which is what /help prints', async () => {
    const harness = await mount(oneExchange())
    try {
      const commands = harness.ctx.commands.list(harness.agent)
      assert.equal(commands.find(command => command.name === 'export')?.input?.hint, '[path | clipboard]')
      assert.equal(commands.find(command => command.name === 'copy')?.input?.hint, '[N]')
    } finally {
      await unmount(harness)
    }
  })
})

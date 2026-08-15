/**
 * The prompt history that outlives the process: the jsonl store itself — order,
 * deduplication, workspace filter, externalized bodies, corrupt lines,
 * compaction — and the mounted terminal that seeds its editor from it.
 *
 * Every store case writes to a directory of its own, and every mounted case
 * points `$DSH_HOME` at one, so a run never reads the history of the machine it
 * runs on and two cases never see each other's prompts.
 * @module dsh-tui/tests/unit/prompt-history
 */

import assert from 'node:assert/strict'
import { existsSync, statSync } from 'node:fs'
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import {
  appendUser,
  createTuiTestHarness,
  disposeTuiTestHarness,
  tuiEntryAvailable,
  type TuiHarness,
  type TuiHarnessOptions,
} from '../harness.ts'
import { HeadlessTerminal } from '../headless-terminal.ts'
import {
  compactPromptHistory,
  openPromptHistory,
  PROMPT_HISTORY_BODY_DIR,
  PROMPT_HISTORY_FILE_NAME,
  SKIP_PROMPT_HISTORY_ENV,
  type PromptHistoryRecord,
  type PromptHistoryStore,
} from '../../src/chat/prompt-history.ts'

/** Literal editor prefix, so a frame assertion never depends on prompt-value registrations. */
const INPUT_PROMPT = 'hist> '

/** Keys as the terminal delivers them. */
const CTRL_R = '\x12'
const ENTER = '\r'
const ESC = '\x1b'
const UP = '\x1b[A'

/** One bracketed paste, exactly as a terminal wraps it. */
function bracketed(body: string): string {
  return `\x1b[200~${body}\x1b[201~`
}

/** A submission and the write behind it settle across a few awaits; outwait them. */
const SETTLE_MS = 80

/** `src/index.ts` is landed by a separate port; without it the end-to-end suite cannot run. */
const entryAvailable = await tuiEntryAvailable()
const skipWithoutEntry = entryAvailable
  ? false
  : 'requires src/index.ts to export createTuiChat(ctx, config, runtime)'

/** Run one case against a temporary directory, whatever it does with it. */
async function inTempDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-prompt-history-'))
  try {
    await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

/** Open one store on a fixed path, with the workspace and session a case cares about. */
function store(
  path: string,
  overrides: { cwd?: string; sessionId?: string; windowBytes?: number } = {},
): PromptHistoryStore {
  return openPromptHistory({
    cwd: overrides.cwd ?? '/workspace/project',
    sessionId: overrides.sessionId ?? 'session-a',
    ...overrides.windowBytes === undefined ? {} : { windowBytes: overrides.windowBytes },
    path,
  })
}

/** The file's non-empty lines, parsed. */
async function records(path: string): Promise<PromptHistoryRecord[]> {
  const raw = await readFile(path, 'utf8')
  return raw.split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line) as PromptHistoryRecord)
}

describe('the prompt history file', () => {
  it('reads back a prompt the last process recorded', async () => {
    await inTempDirectory(async (directory) => {
      const path = join(directory, PROMPT_HISTORY_FILE_NAME)
      const writer = store(path)
      writer.append('alpha')
      await writer.flush()

      assert.deepEqual(store(path).load(), ['alpha'])
      const [entry] = await records(path)
      assert.ok(entry !== undefined, 'the file has exactly one line')
      assert.equal(entry.display, 'alpha')
      assert.equal(entry.cwd, '/workspace/project')
      assert.equal(entry.sessionId, 'session-a')
      assert.equal(typeof entry.timestamp, 'number')
    })
  })

  it('keeps only the entries typed in this workspace', async () => {
    await inTempDirectory(async (directory) => {
      const path = join(directory, PROMPT_HISTORY_FILE_NAME)
      const here = store(path, { cwd: '/a' })
      const elsewhere = store(path, { cwd: '/b' })
      here.append('typed in a')
      elsewhere.append('typed in b')
      await Promise.all([here.flush(), elsewhere.flush()])

      assert.deepEqual(store(path, { cwd: '/a' }).load(), ['typed in a'])
      assert.deepEqual(store(path, { cwd: '/b' }).load(), ['typed in b'])
    })
  })

  it('puts this session\'s own prompts first, both groups newest first', async () => {
    await inTempDirectory(async (directory) => {
      const path = join(directory, PROMPT_HISTORY_FILE_NAME)
      const a = store(path, { sessionId: 'session-a' })
      const b = store(path, { sessionId: 'session-b' })
      // Interleaved, so the answer cannot come out right by file order alone.
      a.append('a1')
      await a.flush()
      b.append('b1')
      await b.flush()
      a.append('a2')
      await a.flush()
      b.append('b2')
      await b.flush()

      assert.deepEqual(store(path, { sessionId: 'session-b' }).load(), ['b2', 'b1', 'a2', 'a1'])
    })
  })

  it('keeps one copy of a repeated prompt, and counts the limit after that', async () => {
    await inTempDirectory(async (directory) => {
      const path = join(directory, PROMPT_HISTORY_FILE_NAME)
      const writer = store(path)
      for (const text of ['x', 'y', 'x']) {
        writer.append(text)
        await writer.flush()
      }
      assert.deepEqual(store(path).load(), ['x', 'y'])

      const many = store(join(directory, 'many.jsonl'))
      for (let index = 0; index < 120; index++) {
        many.append(`prompt ${index}`)
        await many.flush()
      }
      const loaded = store(join(directory, 'many.jsonl')).load()
      assert.equal(loaded.length, 100)
      assert.equal(loaded[0], 'prompt 119')
    })
  })

  it('does not write the same prompt twice in a row', async () => {
    await inTempDirectory(async (directory) => {
      const path = join(directory, PROMPT_HISTORY_FILE_NAME)
      const writer = store(path)
      writer.append('same')
      writer.append('same')
      writer.append('same')
      await writer.flush()

      assert.equal((await records(path)).length, 1)
    })
  })

  it('skips a corrupt line without touching the ones beside it', async () => {
    await inTempDirectory(async (directory) => {
      const path = join(directory, PROMPT_HISTORY_FILE_NAME)
      const line = (display: string): string => JSON.stringify({
        display,
        timestamp: Date.now(),
        cwd: '/workspace/project',
        sessionId: 'session-a',
      })
      await writeFile(path, [
        line('first'),
        'not json at all',
        '{"display":123,"timestamp":1,"cwd":"/workspace/project","sessionId":"session-a"}',
        '',
        line('second'),
      ].join('\n') + '\n', 'utf8')

      assert.deepEqual(store(path).load(), ['second', 'first'])
    })
  })

  it('drops the line the tail window cut in half rather than reading half a prompt', async () => {
    await inTempDirectory(async (directory) => {
      const path = join(directory, PROMPT_HISTORY_FILE_NAME)
      const writer = store(path)
      for (const text of ['oldest one', 'middle one', 'newest one']) {
        writer.append(text)
        await writer.flush()
      }
      // A window that lands mid-file: only whole lines inside it come back, and
      // nothing partial does.
      const loaded = store(path, { windowBytes: 200 }).load()
      assert.ok(loaded.length < 3, `the window excluded something: ${JSON.stringify(loaded)}`)
      assert.equal(loaded[0], 'newest one')
      for (const text of loaded) {
        assert.ok(['oldest one', 'middle one', 'newest one'].includes(text), `whole prompt: ${text}`)
      }
    })
  })

  it('moves a long prompt to a body file and reads the whole thing back', async () => {
    await inTempDirectory(async (directory) => {
      const path = join(directory, PROMPT_HISTORY_FILE_NAME)
      const long = 'x'.repeat(5_000)
      const writer = store(path)
      writer.append(long)
      await writer.flush()

      const [entry] = await records(path)
      assert.ok(entry !== undefined, 'the file has a line')
      assert.match(entry.bodyHash ?? '', /^[0-9a-f]{16}$/u)
      assert.equal(entry.bodyLength, 5_000)
      assert.equal(entry.display.length, 200)
      const body = join(directory, PROMPT_HISTORY_BODY_DIR, `${entry.bodyHash ?? ''}.txt`)
      assert.equal(await readFile(body, 'utf8'), long)
      assert.deepEqual(store(path).load(), [long])
    })
  })

  it('drops an entry whose body is gone instead of offering the preview', async () => {
    await inTempDirectory(async (directory) => {
      const path = join(directory, PROMPT_HISTORY_FILE_NAME)
      const long = 'y'.repeat(5_000)
      const writer = store(path)
      writer.append(long)
      await writer.flush()
      const [entry] = await records(path)
      assert.ok(entry !== undefined, 'the file has a line')
      await rm(join(directory, PROMPT_HISTORY_BODY_DIR, `${entry.bodyHash ?? ''}.txt`))

      assert.deepEqual(store(path).load(), [])
    })
  })

  it('does not persist a prompt past the ceiling at all', async () => {
    await inTempDirectory(async (directory) => {
      const path = join(directory, PROMPT_HISTORY_FILE_NAME)
      const writer = store(path)
      writer.append('z'.repeat(200_000))
      await writer.flush()

      assert.equal(existsSync(path), false)
      assert.deepEqual(store(path).load(), [])
    })
  })

  it('stops writing but keeps reading when the environment says so', async () => {
    await inTempDirectory(async (directory) => {
      const path = join(directory, PROMPT_HISTORY_FILE_NAME)
      const writer = store(path)
      writer.append('recorded before')
      await writer.flush()

      const previous = process.env[SKIP_PROMPT_HISTORY_ENV]
      process.env[SKIP_PROMPT_HISTORY_ENV] = '1'
      try {
        const quiet = store(path)
        quiet.append('recorded after')
        await quiet.flush()
        assert.equal((await records(path)).length, 1)
        assert.deepEqual(quiet.load(), ['recorded before'])
      } finally {
        if (previous === undefined) delete process.env[SKIP_PROMPT_HISTORY_ENV]
        else process.env[SKIP_PROMPT_HISTORY_ENV] = previous
      }
    })
  })

  it('loses nothing when two stores write the same file at once', async () => {
    await inTempDirectory(async (directory) => {
      const path = join(directory, PROMPT_HISTORY_FILE_NAME)
      const one = store(path, { sessionId: 'session-one' })
      const two = store(path, { sessionId: 'session-two' })
      for (let index = 0; index < 3; index++) {
        one.append(`one ${index}`)
        two.append(`two ${index}`)
      }
      await Promise.all([one.flush(), two.flush()])

      assert.equal((await records(path)).length, 6)
      assert.equal(store(path).load().length, 6)
    })
  })

  it('creates the directory it was pointed at, and keeps the file to its owner', async () => {
    await inTempDirectory(async (directory) => {
      const path = join(directory, 'nested', 'deeper', PROMPT_HISTORY_FILE_NAME)
      const writer = store(path)
      writer.append('into a directory that did not exist')
      await writer.flush()

      assert.equal(existsSync(path), true)
      if (process.platform !== 'win32') {
        assert.equal(statSync(path).mode & 0o777, 0o600)
      }
    })
  })

  it('reads an absent file as an empty history', async () => {
    await inTempDirectory(async (directory) => {
      assert.deepEqual(store(join(directory, PROMPT_HISTORY_FILE_NAME)).load(), [])
    })
  })

  it('compacts to the newest entries and sweeps the bodies nothing points at', async () => {
    await inTempDirectory(async (directory) => {
      const path = join(directory, PROMPT_HISTORY_FILE_NAME)
      const writer = store(path)
      for (let index = 0; index < 1_200; index++) {
        writer.append(`prompt ${index}`)
      }
      writer.append('w'.repeat(2_000))
      await writer.flush()
      const bodies = join(directory, PROMPT_HISTORY_BODY_DIR)
      const referenced = (await records(path)).map(entry => entry.bodyHash).find(hash => hash !== undefined)
      assert.ok(referenced !== undefined, 'the long prompt was externalized')
      // Two orphans beside the body the kept entry names: one old enough to
      // sweep, one young enough that another process may still be about to
      // write the line pointing at it.
      const stale = join(bodies, `${'0'.repeat(16)}.txt`)
      const fresh = join(bodies, `${'1'.repeat(16)}.txt`)
      await writeFile(stale, 'nobody points at this any more', 'utf8')
      await writeFile(fresh, 'a line for this may still be coming', 'utf8')
      const ancient = new Date(Date.now() - 60 * 60_000)
      await utimes(stale, ancient, ancient)

      const kept = await compactPromptHistory(path, { keep: 10, bodyTtlMs: 60_000 })
      assert.equal(kept, 10)
      const remaining = await records(path)
      assert.equal(remaining.length, 10)
      assert.equal(remaining.at(-1)?.bodyHash, referenced)
      assert.equal(existsSync(join(bodies, `${referenced}.txt`)), true)
      assert.equal(existsSync(stale), false)
      assert.equal(existsSync(fresh), true)
    })
  })

  it('leaves a file already inside the budget alone', async () => {
    await inTempDirectory(async (directory) => {
      const path = join(directory, PROMPT_HISTORY_FILE_NAME)
      const writer = store(path)
      writer.append('one')
      await writer.flush()

      assert.equal(await compactPromptHistory(path, { keep: 10 }), undefined)
      assert.equal((await records(path)).length, 1)
    })
  })
})

type HistoryHarness = TuiHarness<HeadlessTerminal, (code: number) => void>

/** Point `$DSH_HOME` at a directory of this case's own, and put it back afterwards. */
async function inTempHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-tui-history-home-'))
  const previous = process.env['DSH_HOME']
  process.env['DSH_HOME'] = home
  try {
    await run(home)
  } finally {
    if (previous === undefined) delete process.env['DSH_HOME']
    else process.env['DSH_HOME'] = previous
    await rm(home, { recursive: true, force: true })
  }
}

async function mount(options: TuiHarnessOptions = {}): Promise<HistoryHarness> {
  const terminal = new HeadlessTerminal(96, 32)
  const before = terminal.frames
  const harness = await createTuiTestHarness(terminal, () => {}, {
    cwd: '/workspace/project',
    ...options,
    config: {
      title: 'DSH history',
      welcome: 'ready.',
      ...options.config,
      theme: { color: false, inputPrompt: INPUT_PROMPT, ...options.config?.theme },
    },
  })
  await terminal.waitForFrame(before)
  return harness
}

async function unmount(harness: HistoryHarness): Promise<void> {
  await disposeTuiTestHarness(harness)
  await harness.terminal.dispose()
}

/** Send one chunk and wait for the frame it produces. */
async function press(harness: HistoryHarness, data: string): Promise<string> {
  const before = harness.terminal.frames
  harness.terminal.send(data)
  await harness.terminal.waitForFrame(before)
  return harness.terminal.text()
}

/** Submit one prompt and let the write behind it land. */
async function submit(harness: HistoryHarness, text: string): Promise<void> {
  await press(harness, text)
  await press(harness, ENTER)
  await delay(SETTLE_MS)
}

/** The frame with its own line wrapping collapsed, so a sentence reads as a sentence. */
function unwrapped(frame: string): string {
  return frame.replace(/\s+/gu, ' ')
}

describe('a terminal that remembers the last one', { skip: skipWithoutEntry }, () => {
  it('finds a prompt the previous session typed, with Ctrl+R', async () => {
    await inTempHome(async () => {
      const first = await mount({ config: { sessionId: 'session-first' } })
      await submit(first, 'fix the parser bug')
      await unmount(first)

      const second = await mount({ config: { sessionId: 'session-second' } })
      try {
        await press(second, CTRL_R)
        assert.match(await press(second, 'parser'), /fix the parser bug/u)
      } finally {
        await unmount(second)
      }
    })
  })

  it('finds it with the up arrow too', async () => {
    await inTempHome(async () => {
      const first = await mount({ config: { sessionId: 'session-first' } })
      await submit(first, 'run the migration')
      await unmount(first)

      const second = await mount({ config: { sessionId: 'session-second' } })
      try {
        assert.match(await press(second, UP), /run the migration/u)
      } finally {
        await unmount(second)
      }
    })
  })

  it('offers this session\'s prompt before the stored one', async () => {
    await inTempHome(async () => {
      const first = await mount({ config: { sessionId: 'session-first' } })
      await submit(first, 'alpha')
      await unmount(first)

      const second = await mount({ config: { sessionId: 'session-second' } })
      try {
        await submit(second, 'beta')
        assert.match(await press(second, UP), /beta/u)
        assert.match(await press(second, UP), /alpha/u)
      } finally {
        await unmount(second)
      }
    })
  })

  it('does not write a replayed prompt back out', async () => {
    await inTempHome(async (home) => {
      const harness = await mount({
        beforeMount(session) { appendUser(session, 'replayed prompt') },
      })
      try {
        // The replay is in the editor's history…
        await press(harness, CTRL_R)
        assert.match(await press(harness, 'replayed'), /replayed prompt/u)
      } finally {
        await unmount(harness)
      }
      // …and nowhere on disk: the process that first took it already wrote it.
      assert.equal(existsSync(join(home, PROMPT_HISTORY_FILE_NAME)), false)
    })
  })

  it('shows nothing from another workspace', async () => {
    await inTempHome(async () => {
      const first = await mount({ cwd: '/workspace/a', config: { sessionId: 'session-first' } })
      await submit(first, 'only relevant in a')
      await unmount(first)

      const second = await mount({ cwd: '/workspace/b', config: { sessionId: 'session-second' } })
      try {
        assert.match(unwrapped(await press(second, CTRL_R)), /No prompt history yet\./u)
      } finally {
        await unmount(second)
      }
    })
  })

  it('records a discarded draft with its pasted text, not the marker standing for it', async () => {
    // The marker is a handle on the editor's own paste map: it names nothing
    // once this process is gone, and a session that recalled it would send
    // `[paste #1 +12 lines]` to the model with the pasted code missing.
    const pasted = Array.from({ length: 12 }, (_unused, index) => `line ${index}`).join('\n')
    await inTempHome(async (home) => {
      const first = await mount({ config: { sessionId: 'session-first' } })
      await press(first, 'review this ')
      const folded = await press(first, bracketed(pasted))
      assert.match(folded, /\[paste #1 \+12 lines\]/u, folded)
      // Esc, Esc: the draft is dropped, and stored on the way out.
      await press(first, ESC)
      await press(first, ESC)
      await delay(SETTLE_MS)
      await unmount(first)

      const written = await readFile(join(home, PROMPT_HISTORY_FILE_NAME), 'utf8')
      assert.doesNotMatch(written, /\[paste #/u, written)
      assert.match(written, /line 11/u, written)

      const second = await mount({ config: { sessionId: 'session-second' } })
      try {
        // The recalled draft is the pasted text itself — too tall for the
        // prompt's window, which is exactly what a marker never looks like.
        const recalled = await press(second, UP)
        assert.doesNotMatch(recalled, /\[paste #/u, recalled)
        assert.match(recalled, /review this line 0/u, recalled)
        assert.match(unwrapped(recalled), /↓ 3 more/u, recalled)
      } finally {
        await unmount(second)
      }
    })
  })

  it('flushes the last prompt before it leaves', async () => {
    await inTempHome(async (home) => {
      const harness = await mount()
      await press(harness, 'the very last thing typed')
      await press(harness, ENTER)
      // No settle: disposal is what has to get this on disk.
      await unmount(harness)

      const path = join(home, PROMPT_HISTORY_FILE_NAME)
      assert.equal(existsSync(path), true)
      const written = await readFile(path, 'utf8')
      assert.match(written, /the very last thing typed/u)
    })
  })
})

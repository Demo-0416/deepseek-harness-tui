/**
 * The prompts this user has typed, kept past the process that took them.
 *
 * pi-tui's editor history lives and dies with the editor, so every new terminal
 * used to open on an empty Up arrow and an empty Ctrl+R — the one thing a shell
 * has done for forty years. This module is the file behind it:
 * `$DSH_HOME/history.jsonl`, one JSON object per line, appended by every
 * submission and read back at mount.
 *
 * Three rules the read side owes the write side, all of them ported from Claude
 * Code's `src/history.ts`:
 *
 * - Newest first, and this session's own prompts before any other session's
 *   (`history.ts:190-217`), because the prompt a user reaches for first is
 *   almost always the one they just typed.
 * - Entries are filtered by working directory (`entry.project` there, `cwd`
 *   here): a prompt about another repository is noise in this one.
 * - A line that will not parse is skipped rather than fatal
 *   (`history.ts:131-134`). A history file is not worth a failed mount, and a
 *   torn line costs exactly one prompt.
 *
 * Long prompts do not sit in the jsonl: past 1024 characters the body moves to
 * a content-addressed file under `history-cache/`, which is upstream's
 * `pasteStore` trick (`utils/pasteStore.ts`) and keeps the line-reverse scan
 * cheap. A body that has been swept leaves its entry unreadable, and an
 * unreadable entry is dropped whole — never rendered from the preview, because
 * quietly putting a truncated prompt back in someone's editor is worse than
 * losing it.
 * @module @deepseek-ai/dsh-tui/chat/prompt-history
 */

import { createHash } from 'node:crypto'
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { appendFile, mkdir, readdir, readFile, stat, unlink } from 'node:fs/promises'
import { Buffer } from 'node:buffer'
import { dirname, join } from 'node:path'
import { writeFileAtomic, withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { errorChain } from '@deepseek-ai/dsh-llm'

/** Entries one `load()` returns by default; pi-tui's own editor history is the same size. */
const MAX_HISTORY_ENTRIES = 100
/** Past this length a prompt stops being inlined into the jsonl and moves to a body file. */
const MAX_INLINE_LENGTH = 1024
/** Past this length a prompt is not persisted at all; it still lives in this session's memory. */
const MAX_PERSISTED_LENGTH = 100_000
/** Readable prefix an externalized entry keeps in the jsonl; for a human reading the file, never used as content. */
const PREVIEW_LENGTH = 200
/** Byte window read back from the tail of the file at mount; anything older than that is invisible. */
const READ_WINDOW_BYTES = 512 * 1024
/** Past this size the file is compacted once, after the terminal is up. */
const COMPACT_THRESHOLD_BYTES = 1024 * 1024
/** Entries a compaction keeps. */
const COMPACT_KEEP_ENTRIES = 1000
/** Youngest an unreferenced body may be and still be swept; younger ones may belong to a write in flight. */
const BODY_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** File under the harness home this history is kept in. */
export const PROMPT_HISTORY_FILE_NAME = 'history.jsonl'
/** Directory beside it holding the externalized bodies. */
export const PROMPT_HISTORY_BODY_DIR = 'history-cache'
/** Truthy stops writes and only writes; reads keep working. Upstream's `CLAUDE_CODE_SKIP_PROMPT_HISTORY`. */
export const SKIP_PROMPT_HISTORY_ENV = 'DSH_SKIP_PROMPT_HISTORY'

/**
 * Longest the exit path waits for a queued history write.
 *
 * A prompt is worth a moment on the way out and no more: a disk that is not
 * answering must not be what keeps a terminal on screen after goodbye.
 */
export const PROMPT_HISTORY_FLUSH_TIMEOUT_MS = 1_000

/**
 * One line of `$DSH_HOME/history.jsonl`.
 *
 * Unknown fields are ignored rather than refused, which is what lets a later
 * version add `pastes`/`mode` without this one dropping every entry it wrote.
 * A line missing one of the four required fields is treated as corrupt.
 */
export interface PromptHistoryRecord {
  /** The submitted prompt; when `bodyHash` is set this is a 200-character preview and not the content. */
  display: string
  /** `Date.now()` at the moment it was written. */
  timestamp: number
  /** The workspace it was typed in; reads filter on it. */
  cwd: string
  /** The session that submitted it; reads sort this session's own entries first. */
  sessionId: string
  /** Content hash (sha256, first 16 hex) when the body lives in `history-cache/<hash>.txt`. */
  bodyHash?: string
  /** Character length of the externalized body, for a human reading the file. */
  bodyLength?: number
  /** Reserved for the input mode a bash-prefixed line would carry. Never written today; ignored when read. */
  mode?: string
}

/** How one prompt history is opened. */
export interface PromptHistoryOptions {
  /** The workspace; reads keep only entries whose `cwd` is exactly this. */
  readonly cwd: string
  /** This session's id; its entries come back before any other session's. */
  readonly sessionId: string
  /** Failure report, one finished sentence. The caller logs it; nothing reaches the screen. */
  readonly reportError?: (message: string) => void
  /** Override the path under `$DSH_HOME`; tests only. */
  readonly path?: string
  /** Override the tail window; tests only. */
  readonly windowBytes?: number
}

/** A read/write handle on one cross-session prompt history. */
export interface PromptHistoryStore {
  /** Absolute path of the history file, for diagnostics. */
  readonly path: string
  /**
   * Read the history back: newest first, this session first, deduplicated by text.
   *
   * Never throws — an IO or parse failure returns whatever was read before it.
   * @param limit - most entries to return; defaults to 100.
   * @returns the prompts, newest first.
   */
  load(limit?: number): string[]
  /**
   * Record one prompt. Fire-and-forget, serialized in-process, never throws.
   * @param text - the submitted prompt.
   */
  append(text: string): void
  /**
   * Wait for every queued write to land; called on the way out.
   * @returns a promise that settles when the queue is empty.
   */
  flush(): Promise<void>
}

/** Environment truthiness the way upstream's `envUtils.ts:32-37` reads it. */
function isTruthy(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((value ?? '').trim().toLowerCase())
}

/**
 * Read the complete lines inside the tail window of a file.
 *
 * When the window does not start at byte zero its first line is cut somewhere
 * in the middle — possibly inside a multi-byte UTF-8 sequence, which would
 * decode to U+FFFD and make that line's JSON unparseable anyway — so the whole
 * first line is dropped. It is the only line a window boundary can affect.
 * @param path - the history file.
 * @param windowBytes - how much of the tail to read.
 * @returns the lines in file order (oldest first); an unreadable file reads as empty.
 */
function readTailLines(path: string, windowBytes: number): string[] {
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch (_noHistoryYet: unknown) {
    return []
  }
  try {
    const size = statSync(path).size
    const start = Math.max(0, size - windowBytes)
    const length = size - start
    if (length <= 0) return []
    const buffer = Buffer.alloc(length)
    readSync(fd, buffer, 0, length, start)
    const lines = buffer.toString('utf8').split('\n')
    if (start > 0) lines.shift()
    return lines
  } catch (_unreadable: unknown) {
    /* v8 ignore next -- a file that opened and then failed to read is a disk fault. */
    return []
  } finally {
    closeSync(fd)
  }
}

/**
 * Parse one line into a record, field by field.
 *
 * Only the fields this version knows are checked: a stricter allow-list would
 * refuse every line a later version wrote.
 * @param line - one raw line of the jsonl.
 * @returns the record, or `undefined` when the line is corrupt.
 */
function parseRecord(line: string): PromptHistoryRecord | undefined {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch (_corruptLine: unknown) {
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Partial<Record<keyof PromptHistoryRecord, unknown>>
  if (typeof record.display !== 'string') return undefined
  if (typeof record.timestamp !== 'number') return undefined
  if (typeof record.cwd !== 'string') return undefined
  if (typeof record.sessionId !== 'string') return undefined
  const bodyHash = record.bodyHash
  if (bodyHash !== undefined && !(typeof bodyHash === 'string' && /^[0-9a-f]{16}$/u.test(bodyHash))) {
    return undefined
  }
  return {
    display: record.display,
    timestamp: record.timestamp,
    cwd: record.cwd,
    sessionId: record.sessionId,
    ...bodyHash === undefined ? {} : { bodyHash },
    ...typeof record.bodyLength === 'number' ? { bodyLength: record.bodyLength } : {},
    ...typeof record.mode === 'string' ? { mode: record.mode } : {},
  }
}

/** Content address of one body, as the body file is named. */
function bodyHashOf(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

/**
 * Compact one history file: keep the newest entries, drop the bodies nothing
 * references any more.
 *
 * Held under the writer lock, because this is the one operation that rewrites
 * the file rather than appending to it. Plain appends stay lock-free on
 * purpose — see the module's own note on why a stuck lock must not be able to
 * block every future prompt.
 * @param path - the history file.
 * @param options - how many entries to keep and how old an orphan body must be.
 * @returns the number of entries kept, or `undefined` when nothing was compacted.
 */
export async function compactPromptHistory(
  path: string,
  options: { readonly keep?: number; readonly bodyTtlMs?: number } = {},
): Promise<number | undefined> {
  const keep = options.keep ?? COMPACT_KEEP_ENTRIES
  const bodyTtlMs = options.bodyTtlMs ?? BODY_TTL_MS
  return await withFileLock(path, async () => {
    const before = (await stat(path)).size
    const raw = await readFile(path, 'utf8')
    const lines = raw.split('\n').filter(line => line.trim() !== '' && parseRecord(line) !== undefined)
    if (lines.length <= keep) return undefined
    const kept = lines.slice(-keep)
    // Nothing stops another process appending between the read and the write,
    // since ordinary appends take no lock: carry that tail across by hand.
    const after = (await stat(path)).size
    const tail = after > before ? await readBytes(path, before, after) : ''
    await writeFileAtomic(path, `${kept.join('\n')}\n${tail}`, { mode: 0o600, dirMode: 0o700 })
    const referenced = new Set<string>()
    for (const line of [...kept, ...tail.split('\n')]) {
      const hash = parseRecord(line)?.bodyHash
      if (hash !== undefined) referenced.add(hash)
    }
    await sweepBodies(join(dirname(path), PROMPT_HISTORY_BODY_DIR), referenced, bodyTtlMs)
    return kept.length
  })
}

/**
 * Read one byte range of a file.
 * @param path - the file to read.
 * @param start - first byte.
 * @param end - one past the last byte.
 * @returns the decoded range, or the empty string when it cannot be read.
 */
async function readBytes(path: string, start: number, end: number): Promise<string> {
  const length = end - start
  if (length <= 0) return ''
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch (_gone: unknown) {
    /* v8 ignore next -- the file was just stat'ed under the lock. */
    return ''
  }
  try {
    const buffer = Buffer.alloc(length)
    readSync(fd, buffer, 0, length, start)
    return buffer.toString('utf8')
  } finally {
    closeSync(fd)
  }
}

/**
 * Delete the body files nothing references any more.
 *
 * An orphan younger than `ttlMs` is left alone: it may belong to another
 * process that has written the body and not yet appended the line pointing at
 * it. Individual failures are ignored, the way upstream's own sweep does it.
 * @param directory - the body directory.
 * @param referenced - hashes still named by a kept entry.
 * @param ttlMs - youngest an orphan may be and still be deleted.
 */
async function sweepBodies(directory: string, referenced: ReadonlySet<string>, ttlMs: number): Promise<void> {
  let names: string[]
  try {
    names = await readdir(directory)
  } catch (_noBodies: unknown) {
    return
  }
  const cutoff = Date.now() - ttlMs
  for (const name of names) {
    if (!name.endsWith('.txt')) continue
    if (referenced.has(name.slice(0, -4))) continue
    const file = join(directory, name)
    try {
      if ((await stat(file)).mtimeMs >= cutoff) continue
      await unlink(file)
    } catch (_raced: unknown) {
      // Another process may have swept it first; either way it is gone or it stays.
    }
  }
}

/**
 * Open `$DSH_HOME/history.jsonl` (or `options.path`). Never throws.
 * @param options - workspace, session, and the test overrides.
 * @returns the handle the editor's history is seeded from and appended to.
 */
export function openPromptHistory(options: PromptHistoryOptions): PromptHistoryStore {
  // Resolved once. `dshHomePath` reads `process.env` on every call, but a
  // `DSH_HOME` that moves mid-session is not a case this terminal serves.
  const path = options.path ?? dshHomePath(PROMPT_HISTORY_FILE_NAME)
  const bodyDirectory = join(dirname(path), PROMPT_HISTORY_BODY_DIR)
  const windowBytes = options.windowBytes ?? READ_WINDOW_BYTES
  /** The last text handed to {@link append}, for pi-tui's own consecutive-duplicate rule. */
  let lastAppended: string | undefined
  /** Whether the parent directory has been created in this process. */
  let directoryReady = false
  /** Serializes this process's writes, so two prompts can never interleave in one line. */
  let queue: Promise<void> = Promise.resolve()

  const report = (message: string): void => { options.reportError?.(message) }

  /** Resolve one record's text, or `undefined` when the entry is unusable. */
  const resolveText = (record: PromptHistoryRecord): string | undefined => {
    if (record.bodyHash === undefined) {
      const inline = record.display.trim()
      return inline === '' ? undefined : inline
    }
    try {
      const body = readFileSync(join(bodyDirectory, `${record.bodyHash}.txt`), 'utf8').trim()
      return body === '' ? undefined : body
    } catch (_sweptOrCorrupt: unknown) {
      // Deliberately not falling back to `display`: that is a 200-character
      // preview, and putting it in the editor would look like the prompt.
      return undefined
    }
  }

  const writeEntry = async (text: string): Promise<void> => {
    if (!directoryReady) {
      await mkdir(dirname(path), { recursive: true })
      directoryReady = true
    }
    let record: PromptHistoryRecord = {
      display: text,
      timestamp: Date.now(),
      cwd: options.cwd,
      sessionId: options.sessionId,
    }
    if (text.length > MAX_INLINE_LENGTH) {
      const hash = bodyHashOf(text)
      // The body lands first: a line that pointed at a body still being
      // written would be readable and wrong for as long as the write took.
      await writeFileAtomic(join(bodyDirectory, `${hash}.txt`), text, { mode: 0o600, dirMode: 0o700 })
      record = {
        display: text.slice(0, PREVIEW_LENGTH),
        timestamp: record.timestamp,
        cwd: record.cwd,
        sessionId: record.sessionId,
        bodyHash: hash,
        bodyLength: text.length,
      }
    }
    await appendFile(path, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: 'a' })
  }

  const store: PromptHistoryStore = {
    path,
    load(limit = MAX_HISTORY_ENTRIES): string[] {
      const lines = readTailLines(path, windowBytes)
      const seen = new Set<string>()
      const current: string[] = []
      const others: string[] = []
      // Tail to head is newest to oldest, which is the order both groups keep.
      for (let index = lines.length - 1; index >= 0; index--) {
        if (current.length + others.length >= limit) break
        const line = lines[index]
        if (line === undefined || line.trim() === '') continue
        const record = parseRecord(line)
        if (record === undefined) continue
        if (record.cwd !== options.cwd) continue
        const text = resolveText(record)
        if (text === undefined || seen.has(text)) continue
        seen.add(text)
        ;(record.sessionId === options.sessionId ? current : others).push(text)
      }
      return [...current, ...others]
    },
    append(text: string): void {
      const trimmed = text.trim()
      if (trimmed === '') return
      // Consecutive duplicates never land, which is pi-tui's own rule and also
      // what absorbs the initial-skill queue replaying a line it already stored.
      if (trimmed === lastAppended) return
      if (trimmed.length > MAX_PERSISTED_LENGTH) {
        lastAppended = trimmed
        return
      }
      if (isTruthy(process.env[SKIP_PROMPT_HISTORY_ENV])) return
      lastAppended = trimmed
      queue = queue.then(async () => { await writeEntry(trimmed) }).catch((error: unknown) => {
        report(`prompt history write failed: ${errorChain(error)}`)
      })
    },
    flush(): Promise<void> {
      return queue
    },
  }

  // One compaction per process, and only when the file has grown enough to be
  // worth it. Unreferenced so a slow rewrite never holds the process open.
  try {
    if (statSync(path).size > COMPACT_THRESHOLD_BYTES) {
      setTimeout(() => {
        void compactPromptHistory(path).catch((error: unknown) => {
          report(`prompt history compaction failed: ${errorChain(error)}`)
        })
      }, 0).unref()
    }
  } catch (_noHistoryYet: unknown) {
    // No file, nothing to compact.
  }
  return store
}

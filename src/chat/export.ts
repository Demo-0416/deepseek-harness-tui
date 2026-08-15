/**
 * Local `/export`: write this session's log to a file in the workspace and
 * report the path.
 *
 * `@deepseek-ai/dsh-session-log-export` is the Web command of the same name and
 * is not usable here: its host half only returns the text
 * `Session log download requested.`, and the archive is produced by
 * `@deepseek-ai/dsh-host-apiproxy` at `GET /api/session.export` and saved by a
 * browser plugin watching for that result. A terminal has no browser download
 * manager and a TUI profile mounts no webserver, so mounting that plugin here
 * would leave a command that reports success and produces nothing.
 *
 * This is the terminal's own implementation: same intent, local delivery. A
 * profile mounts exactly one `/export` — the command registry rejects a
 * duplicate global name outright — so the TUI bundle patch leaves the Web
 * plugin out rather than layering over it.
 *
 * The archive is a single file rather than the Web ZIP because the two things
 * the ZIP bundles — descendant sessions and image attachments — come from
 * `sessionQuery` and `attachments`, neither of which a TUI profile mounts.
 *
 * `/export clipboard` is the second delivery this module renders for: the file
 * carries the log, which is written for a machine, while the clipboard carries
 * a Markdown transcript, which is written to be pasted into another window for
 * a person to read.
 * @module @deepseek-ai/dsh-tui/chat/export
 */

import { writeFile } from 'node:fs/promises'
import { isAbsolute, resolve as resolvePath } from 'node:path'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import { errorChain } from '@deepseek-ai/dsh-llm'
import { displayInlineText, displayText } from '../components/text.ts'
import { t } from '../i18n/index.ts'
import type { TranscriptEntry } from './transcript-search.ts'

/** Extension of the written artifact: one JSON record per line. */
const LOG_EXTENSION = '.jsonl'

/**
 * The part of `ctx.sessionPersistence` an export reads.
 *
 * Structural, and resolved through `ctx.get`: persistence is optional in a TUI
 * profile, and an export that needed it would fail on the profiles that keep
 * the whole session in memory.
 */
export interface SessionArtifactReader {
  /** Whether this backend exposes one verbatim raw artifact per session. */
  readonly supportsRawArtifacts: boolean
  /**
   * Read a session's backend-owned artifact text verbatim.
   * @param id - the persisted session to read.
   * @param signal - cancellation for the backend read.
   * @returns the artifact, or `undefined` when the session has none materialized.
   */
  readRaw(id: SessionId, signal?: AbortSignal): Promise<{ filename: string; content: string } | undefined>
}

/**
 * The part of `ctx.sessions` an export uses: the durability barrier, so the
 * artifact on disk includes the turn that just finished.
 */
export interface SessionFlusher {
  /**
   * Run the awaited durability checkpoint for one session.
   * @param session - the session to flush.
   * @returns whether anything was written.
   */
  flush(session: Session): Promise<boolean>
}

/** Everything the export reads, resolved by the entry point. */
export interface SessionLogExportDeps {
  /** Durable backend, when the profile mounts one. */
  readonly persistence: SessionArtifactReader | undefined
  /** Live-session store, used only for the pre-read flush. */
  readonly sessions: SessionFlusher | undefined
  /** Workspace a relative destination resolves against. */
  readonly cwd: string
  /**
   * Ask the user whether an existing file may be replaced.
   *
   * Optional, and its absence means "never replace one": an embedder that has
   * no surface to ask on must not lose a file on the user's behalf. The default
   * destination is stable per session, so the second `/export` of one session
   * lands on the first one's file — this is the common case, not a corner one.
   * @param destination - the absolute path that already has a file on it.
   * @returns whether to write over it.
   */
  readonly confirmOverwrite?: (destination: string) => Promise<boolean>
}

/**
 * Whether a failed exclusive create failed because the path was taken.
 *
 * Structural rather than typed: `writeFile` rejects with a plain `Error`
 * carrying a `code`, and every other failure (a directory in the way, a
 * read-only volume) has to keep travelling to the error result.
 * @param error - the rejection from an exclusive write.
 * @returns true when the destination already exists.
 */
function destinationExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'EEXIST'
}

/**
 * Collapse an untrusted session id into one safe filename segment — the same
 * convention the Web endpoint's own filename uses, so the two exports of one
 * session are recognizably the same file.
 * @param id - the session's durable id.
 * @returns the sanitized segment.
 */
export function sessionLogBasename(id: string): string {
  return `dsh-session-${id.replace(/[^A-Za-z0-9_-]/g, '_')}`
}

/**
 * Serialize a live session as JSONL: the header record, then one event per
 * line — the same line-per-record layout the JSONL backend writes.
 *
 * This is the fallback path. When the backend exposes a raw artifact, the
 * export copies those exact bytes instead, because only they preserve the
 * backend's own serialization (chunk packing, key order).
 * @param session - the live session to serialize.
 * @returns the artifact text, newline-terminated.
 */
export function serializeSessionLog(session: Session): string {
  const records: unknown[] = [{ type: 'session', ...session.header }, ...session.events]
  return `${records.map(record => JSON.stringify(record)).join('\n')}\n`
}

/**
 * Write this session's log and report where it landed.
 *
 * A path argument is taken as written (resolved against the workspace when
 * relative); without one the file is `dsh-session-<id>.jsonl` in the workspace,
 * or the backend's own artifact name when it has one.
 *
 * An existing file is never written over unsaid. The write is attempted
 * exclusively first, so "does this path exist" is answered by the write itself
 * rather than by a check another process can invalidate between the two calls;
 * only an `EEXIST` asks, and only a yes writes again without the flag.
 * @param deps - persistence, session store, workspace, and overwrite consent.
 * @param session - the session to export.
 * @param rawInput - the command's argument text; empty selects the default path.
 * @param signal - cancellation owned by the dispatching command.
 * @returns a success result naming the absolute path, or an error result.
 */
export async function exportSessionLog(
  deps: SessionLogExportDeps,
  session: Session,
  rawInput: string,
  signal: AbortSignal,
): Promise<CommandResult> {
  const requested = rawInput.trim()
  try {
    signal.throwIfAborted()
    // Flush first: the durable artifact is only worth preferring when it
    // already contains the turn the user just watched finish.
    await deps.sessions?.flush(session)
    signal.throwIfAborted()
    const raw = deps.persistence?.supportsRawArtifacts === true
      ? await deps.persistence.readRaw(session.id, signal)
      : undefined
    signal.throwIfAborted()
    const content = raw?.content ?? serializeSessionLog(session)
    const basename = raw?.filename ?? `${sessionLogBasename(session.id)}${LOG_EXTENSION}`
    const destination = requested === ''
      ? resolvePath(deps.cwd, basename)
      : isAbsolute(requested) ? requested : resolvePath(deps.cwd, requested)
    try {
      await writeFile(destination, content, { encoding: 'utf8', flag: 'wx' })
    } catch (error: unknown) {
      if (!destinationExists(error)) throw error
      // No asker means no consent. The file stays and the refusal names the
      // path, so the next `/export` can be given another one.
      if (deps.confirmOverwrite === undefined) {
        return {
          kind: 'error',
          text: `Session log export refused: ${displayInlineText(destination)} already exists`
            + ' and nothing here can ask whether to replace it. Pass another path.',
        }
      }
      const approved = await deps.confirmOverwrite(destination)
      if (!approved) {
        return {
          kind: 'success',
          text: `Session log export cancelled; ${displayInlineText(destination)} was left unchanged.`,
        }
      }
      signal.throwIfAborted()
      await writeFile(destination, content, 'utf8')
      return { kind: 'success', text: `Session log exported to ${displayInlineText(destination)} (replaced)` }
    }
    return { kind: 'success', text: `Session log exported to ${displayInlineText(destination)}` }
  } catch (error: unknown) {
    return { kind: 'error', text: `Session log export failed: ${displayInlineText(errorChain(error))}` }
  }
}

/** The keyword that sends `/export` to the clipboard instead of to a file. */
const CLIPBOARD_TARGET = 'clipboard'

/**
 * Whether this `/export` asks for the clipboard rather than for a file.
 *
 * Only the bare word counts, so a file actually named `clipboard` is still
 * exportable as `./clipboard`. Matched case-insensitively because the keyword
 * is a word the user says, not a path the filesystem owns.
 * @param rawInput - the text after the command name.
 * @returns true when this export goes to the clipboard.
 */
export function isClipboardExportTarget(rawInput: string): boolean {
  return rawInput.trim().toLowerCase() === CLIPBOARD_TARGET
}

/** The header facts of a Markdown export, read by the entry point from the snapshot and the header. */
export interface SessionMarkdownMeta {
  /** The session's durable id. */
  readonly sessionId: string
  /** The folded session title, when one was written. */
  readonly title?: string
  /** The session's workspace. */
  readonly cwd?: string
  /** The model label from the latest request context. */
  readonly model?: string
  /** When the export ran, in milliseconds, from the entry point's own clock. */
  readonly exportedAt: number
}

/** How much of a tool entry survives into the Markdown. */
const TOOL_BODY_MAX = 400

/**
 * How much of the whole document survives.
 *
 * The same reason as {@link TOOL_BODY_MAX}, one level up, and for the same one
 * path: when the export leaves this process as a single OSC 52 write, base64
 * makes the sequence a third larger again — clipping only tool bodies still let
 * a long session render hundreds of kilobytes of answers into one sequence. It
 * is the caller's job not to spend this budget on the clipboard routes that pipe
 * the document into a utility instead (`pbcopy`, `wl-copy`, `tmux load-buffer`),
 * which have no per-write ceiling to respect. No budget can promise
 * delivery (every terminal has a ceiling of its own, and the usual failure is
 * to drop the oversized sequence in silence), so this one is deliberately
 * generous: it bounds the write, and it is what makes the receipt able to say
 * the document was cut instead of reporting an unqualified success for a
 * clipboard that may have received nothing.
 */
export const MARKDOWN_MAX_CHARS = 100_000

/** A rendered document after the whole-document budget was applied. */
export interface ClippedMarkdown {
  /** The document to hand to the clipboard, marked when it was cut. */
  readonly text: string
  /** Whether anything had to be dropped. */
  readonly truncated: boolean
}

/**
 * Hold one rendered document to the budget, marking it when it did not fit.
 *
 * Separate from {@link renderSessionMarkdown} so rendering stays a pure
 * function of the entries: what a session looks like as Markdown is not a
 * function of how much of it one terminal will take.
 * @param markdown - the rendered document.
 * @param max - the character budget; defaults to {@link MARKDOWN_MAX_CHARS}.
 * @returns the document to write, and whether it was cut.
 */
export function clipSessionMarkdown(markdown: string, max: number = MARKDOWN_MAX_CHARS): ClippedMarkdown {
  if (markdown.length <= max) return { text: markdown, truncated: false }
  const marker = `\n\n${t('export.markdown.truncated', { limit: max })}\n`
  const room = Math.max(0, max - marker.length)
  // Never end on the high half of a surrogate pair: the payload is encoded as
  // UTF-8 before base64, and a lone surrogate would go out as a replacement
  // character in the middle of what the user pastes.
  const kept = /[\uD800-\uDBFF]$/u.test(markdown.slice(0, room)) ? room - 1 : room
  return { text: `${markdown.slice(0, kept)}${marker}`, truncated: true }
}

/**
 * Clip and mark: the OSC 52 payload is written to the terminal in one go, and a
 * single five-megabyte file read must not stretch the export until the terminal
 * drops it.
 * @param text - the body to clip.
 * @param max - the maximum number of characters kept.
 * @returns the body, ellipsized when it had to be cut.
 */
function clipBody(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`
}

/**
 * The fence for one body: one backtick longer than the longest run inside it,
 * and never shorter than three.
 * @param text - the body the fence has to close over.
 * @returns the fence string.
 */
function fenceFor(text: string): string {
  let longest = 0
  for (const run of text.match(/`+/gu) ?? []) longest = Math.max(longest, run.length)
  return '`'.repeat(Math.max(3, longest + 1))
}

/**
 * Render this session as a Markdown transcript.
 *
 * The entries come from `transcriptEntries`, so order, emptiness, and "a
 * rewound echo is not a message" are decided exactly as `/search` decides them
 * — the exported session and the searchable one are the same session. Headings
 * use each entry's own localized label, and the fact list reuses the `/status`
 * card's row names.
 * @param entries - the flattened session entries, in log order.
 * @param meta - the session identity and export time for the header.
 * @returns a Markdown document ending in exactly one newline.
 */
export function renderSessionMarkdown(
  entries: readonly TranscriptEntry[],
  meta: SessionMarkdownMeta,
): string {
  const heading = meta.title === undefined || meta.title.trim() === ''
    ? `${t('status.row.session')} ${meta.sessionId}`
    : meta.title
  const blocks: string[] = [`# ${displayInlineText(heading)}`]
  const facts: string[] = [`- ${t('status.row.session')}: ${displayInlineText(meta.sessionId)}`]
  if (meta.cwd !== undefined) facts.push(`- ${t('status.row.directory')}: ${displayInlineText(meta.cwd)}`)
  if (meta.model !== undefined) facts.push(`- ${t('status.row.model')}: ${displayInlineText(meta.model)}`)
  facts.push(`- ${t('export.markdown.exported')}: ${new Date(meta.exportedAt).toISOString()}`)
  blocks.push(facts.join('\n'))
  for (const entry of entries) {
    blocks.push(`## ${displayInlineText(entry.label)}`)
    if (entry.role === 'tool') {
      const body = clipBody(displayText(entry.text), TOOL_BODY_MAX)
      const fence = fenceFor(body)
      blocks.push(`${fence}\n${body}\n${fence}`)
      continue
    }
    if (entry.role === 'reference') {
      blocks.push(entry.text.split('\n').map(label => `- ${displayInlineText(label)}`).join('\n'))
      continue
    }
    blocks.push(displayText(entry.text))
  }
  return `${blocks.join('\n\n')}\n`
}

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
 * @module @deepseek-ai/dsh-tui/chat/export
 */
import type { CommandResult } from '@deepseek-ai/dsh-commands';
import type { Session, SessionId } from '@deepseek-ai/dsh-session';
/**
 * The part of `ctx.sessionPersistence` an export reads.
 *
 * Structural, and resolved through `ctx.get`: persistence is optional in a TUI
 * profile, and an export that needed it would fail on the profiles that keep
 * the whole session in memory.
 */
export interface SessionArtifactReader {
    /** Whether this backend exposes one verbatim raw artifact per session. */
    readonly supportsRawArtifacts: boolean;
    /**
     * Read a session's backend-owned artifact text verbatim.
     * @param id - the persisted session to read.
     * @param signal - cancellation for the backend read.
     * @returns the artifact, or `undefined` when the session has none materialized.
     */
    readRaw(id: SessionId, signal?: AbortSignal): Promise<{
        filename: string;
        content: string;
    } | undefined>;
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
    flush(session: Session): Promise<boolean>;
}
/** Everything the export reads, resolved by the entry point. */
export interface SessionLogExportDeps {
    /** Durable backend, when the profile mounts one. */
    readonly persistence: SessionArtifactReader | undefined;
    /** Live-session store, used only for the pre-read flush. */
    readonly sessions: SessionFlusher | undefined;
    /** Workspace a relative destination resolves against. */
    readonly cwd: string;
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
    readonly confirmOverwrite?: (destination: string) => Promise<boolean>;
}
/**
 * Collapse an untrusted session id into one safe filename segment — the same
 * convention the Web endpoint's own filename uses, so the two exports of one
 * session are recognizably the same file.
 * @param id - the session's durable id.
 * @returns the sanitized segment.
 */
export declare function sessionLogBasename(id: string): string;
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
export declare function serializeSessionLog(session: Session): string;
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
export declare function exportSessionLog(deps: SessionLogExportDeps, session: Session, rawInput: string, signal: AbortSignal): Promise<CommandResult>;

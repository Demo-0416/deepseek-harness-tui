/**
 * `/rename` — give this session a title of the user's own, or (with no
 * argument) have the title service generate one again.
 *
 * A title in dsh is the log-only `session/title` event rather than a header
 * field, and `ctx.sessionTitle` is its only writer. A user rename is written
 * with `source: { kind: 'user' }`, and the service pins the title on that by
 * itself — its `onUserMessage` returns early for a user-sourced title, so
 * automatic generation stops scheduling. There is therefore no suppression
 * state for this command to keep.
 *
 * Without an argument the command calls `refresh()`, the service's own
 * "regenerate, and hand the title back to automatic maintenance" entry: it runs
 * the registered provider (this bundle mounts the first-prompt LLM namer) and
 * degrades to the deterministic fallback when there is none. It is the
 * counterpart of Claude Code's `generateSessionName`, differing only in that
 * the result is not user-sourced — so the confirmation says that out loud
 * rather than letting the user believe they just pinned a name.
 *
 * Nothing here forces a durability checkpoint. Persistence observes the title
 * event eagerly and drains on the ordinary lifecycle checkpoints; turning one
 * log-only append into a synchronous disk write would fight that policy to buy
 * only the `kill -9` case.
 * @module @deepseek-ai/dsh-tui/chat/rename
 */
import type { CommandResult } from '@deepseek-ai/dsh-commands';
import type { Session } from '@deepseek-ai/dsh-session';
import type { SessionTitleSnapshot } from '@deepseek-ai/dsh-session-title';
/**
 * The slice of `ctx.sessionTitle` `/rename` writes through.
 *
 * Structural rather than the service class: `ctx.get` answers `any`, and this
 * bundle resolves its own `@deepseek-ai/dsh-session-title` while the host that
 * mounts it resolves another, so a narrow interface is what makes the command
 * both testable and correct across installations — the same reason
 * `SessionArtifactReader` is declared this way in `chat/export.ts`.
 */
export interface SessionTitleWriter {
    /** Accept one explicit user title, appending `session/title` and pinning it. */
    rename(session: Session, title: string): SessionTitleSnapshot;
    /** Re-run title generation explicitly; `undefined` when there is no text to name. */
    refresh(session: Session, signal?: AbortSignal): Promise<SessionTitleSnapshot | undefined>;
}
/** What `/rename` takes from the terminal around it. */
export interface RenameCommandDeps {
    /** The title service, or `undefined` on a profile that mounts none. */
    readonly titles: SessionTitleWriter | undefined;
    /**
     * Say so before an asynchronous generation starts.
     *
     * Optional because only an interactive terminal has somewhere to say it. A
     * generation runs one auxiliary LLM request — this bundle configures a 60 s
     * timeout for it — and a command that goes silent for a minute is far worse
     * than one extra line.
     */
    readonly announceGenerating?: () => void;
}
/**
 * Whether a failure means the name itself was unusable.
 *
 * Matched on `name`, never with `instanceof SessionTitleInvalidError`: this
 * bundle resolves `@deepseek-ai/dsh-session-title` from its own installation
 * while the host resolves its own, so the two classes are different objects and
 * the guard would be false for the very error it exists to recognize. Same
 * reason `chat/doctor.ts`'s `isMissingAdapter` matches on `code`.
 * @param error - the rejection from `rename()`.
 * @returns true when the title normalized to empty.
 */
export declare function isInvalidTitleError(error: unknown): boolean;
/**
 * Whether a failed generation was cancelled in favour of a newer one.
 *
 * A supersession is not a failure: the operation that caused it owns the title
 * now and prints its own receipt, so the overtaken call has nothing to add.
 * @param error - the rejection from `refresh()`.
 * @returns true when a newer title operation aborted this one.
 */
export declare function isSupersededTitleError(error: unknown): boolean;
/**
 * Run one `/rename` invocation.
 *
 * `rename()` is synchronous, so the argument branch is never interrupted by the
 * signal; only `refresh()` takes one. Both confirmations name the title the
 * service accepted rather than the text the user typed, because a name past the
 * byte ceiling is stored truncated and the receipt has to show what landed.
 * @param deps - the title service and the generating notice.
 * @param session - the current session, live in this process's store.
 * @param rawInput - the text after the command name; empty means "regenerate".
 * @param signal - cancellation owned by the dispatching command.
 * @returns the command result the caller prints.
 */
export declare function runRenameCommand(deps: RenameCommandDeps, session: Session, rawInput: string, signal: AbortSignal): Promise<CommandResult>;

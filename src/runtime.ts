/**
 * Host and process boundary the interactive TUI runs against: the resume-handoff
 * host and the {@link TuiRuntime} the shipped CLI supplies (terminal, process
 * exit, clock, and optional prompt/git overrides). These are plain interfaces so
 * tests can drive the channel with a fake terminal.
 * @module @deepseek-ai/dsh-tui/runtime
 */

import type { Terminal } from '@earendil-works/pi-tui'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'

/** Process-lifecycle owner used by the shipped CLI for an atomic resume handoff. */
export interface TuiResumeHost {
  /**
   * Dispose the current app and replace it with a runtime for `sessionId` in
   * `cwd`. Success does not return. A host may reject before it commits
   * teardown; after commit it owns fatal reporting and process exit.
   * @param sessionId - validated persisted session selected by the user.
   * @param cwd - the selected session's own workspace, which the replacement
   *   process must run in: process cwd, not the restored session header, is what
   *   filesystem and shell tools resolve against. It may differ from the current
   *   workspace, so a host that cannot enter it must reject before committing
   *   teardown.
   */
  handoff(sessionId: SessionId, cwd: string): Promise<never>
}

/** What a rewind asks the host to build: a fork of this session, cut short. */
export interface TuiForkRequest {
  /** The parent's log prefix the fork starts from; ends on a completed turn. */
  readonly seed: readonly SessionEvent[]
  /** The session this fork descends from, recorded as the fork's lineage. */
  readonly parentSession: SessionId
  /** Workspace the fork runs in; the parent's, since a rewind never moves it. */
  readonly cwd: string
  /** Text placed in the forked chat's editor, unsent, for the user to edit and send. */
  readonly draft?: string
}

/** Runtime boundary used by the interactive TUI. */
export interface TuiRuntime {
  /** Terminal implementation; production uses pi-tui's `ProcessTerminal`. */
  terminal: Terminal
  /** Exit hook used by terminal shutdown or a target-agent startup failure. */
  exit(code: number): void
  /**
   * Override the prompt's logical working-directory label without changing the session directory used by tools.
   * @param cwd - Operational working directory from the session header.
   * @returns Unescaped label; the TUI makes terminal controls visible.
   */
  formatCwd?: (cwd: string | undefined) => string
  /**
   * Override the Git branch shown in the prompt context line; production resolves it once at mount.
   * @param cwd - Operational working directory from the session header.
   * @returns Unescaped branch name, or `undefined` outside a Git worktree.
   */
  gitBranch?: (cwd: string) => string | undefined
  /** Monotonic-enough wall clock for elapsed status rendering. Defaults to `Date.now`. */
  now?(): number
  /** Host-owned process handoff; absent leaves the session selectable but not resumable in place. */
  handoffResume?: TuiResumeHost['handoff']
  /**
   * Host-owned fork handoff: create a session seeded with the request's log
   * prefix and mount a chat over it, leaving the source session untouched.
   * Success does not return, exactly as {@link TuiRuntime.handoffResume}.
   *
   * Absent leaves Rewind able to bring an earlier prompt back to the editor but
   * not to move the conversation back with it — only a host that owns the agent
   * handle can replace the mounted session.
   * @param fork - The seed, lineage, workspace, and draft the new chat opens with.
   */
  handoffFork?: (fork: TuiForkRequest) => Promise<never>
  /**
   * Host-owned blank-session handoff: create a session with no history in this
   * workspace and mount a chat over it. Success does not return, exactly as
   * {@link TuiRuntime.handoffResume}.
   *
   * The session being left is not ended and not edited — it is flushed and
   * released, and stays resumable — because there is no "clear this session"
   * anywhere below this UI: the log is append-only, and starting over means a
   * new log, not a truncated one.
   *
   * Absent leaves `/new` refusing rather than pretending: only a host that owns
   * the agent handle can replace the mounted session.
   */
  handoffNew?: () => Promise<never>
  /**
   * Line the host wants printed once the terminal is released on exit, such as
   * the command that resumes this session. Absent prints nothing. The host owns
   * the wording; the TUI owns rendering and escapes terminal controls, so
   * embedded ANSI is shown literally rather than applied.
   */
  goodbyeMessage?: string
}

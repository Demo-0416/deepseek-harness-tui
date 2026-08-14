/**
 * Bounded waits the interactive channel's lifecycle paths run on: the exit that
 * cancels a turn before it leaves, and the mount that waits for its agent to
 * exist. Both bounds live here rather than inline so the timing contract can be
 * exercised without a mounted terminal.
 * @module @deepseek-ai/dsh-tui/chat/lifecycle
 */
/**
 * How long a graceful exit waits for a cancelled turn to reach idle before it
 * leaves anyway.
 *
 * Long enough that an ordinary cancel — the driver finishing its in-flight tool
 * call and closing the turn — completes inside it, short enough that a user who
 * has already asked to quit is not left watching a terminal they can only kill
 * from somewhere else.
 */
export declare const EXIT_IDLE_TIMEOUT_MS = 5000;
/**
 * How long {@link ../index.ts | mountTui} waits for its configured agent to be
 * created before it reports the stall and exits.
 *
 * The agent is created by another plugin (a provider adapter, a session
 * restore), so this bound covers work the TUI cannot see: a provider whose
 * initialization deadlocks emits neither `agent/created` nor
 * `agent-loop/config-start-failed`, and every second past this one is a black
 * screen with no explanation in it.
 */
export declare const AGENT_START_TIMEOUT_MS = 30000;
/**
 * Settle when `idle` settles or when `timeoutMs` elapses, whichever is first.
 *
 * The exit path cancels the running turn and waits for the agent to report
 * idle, so a session is never torn down mid-write. That wait is only as good as
 * the driver's cancellation: an unbounded tool loop, or a stream that stalled
 * without erroring, never reaches idle, and the wait then holds a terminal its
 * user has already told to quit. Bounding it turns "wait for the turn" into
 * "wait for the turn, but leave regardless", which is the only version of the
 * promise the TUI can keep.
 *
 * A rejected `idle` counts as settled: the caller is leaving either way, and by
 * then it has no surface left to report a failure on. The timer is unref'd
 * because it exists to bound a wait, not to keep a process alive for one.
 * @param idle - the agent's idle promise, already started by the caller.
 * @param timeoutMs - how long the caller is willing to wait for it.
 * @returns which of the two settled first.
 */
export declare function whenIdleOrTimeout(idle: Promise<void>, timeoutMs: number): Promise<'idle' | 'timeout'>;

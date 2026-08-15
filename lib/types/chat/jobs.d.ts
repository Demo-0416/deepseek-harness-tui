/**
 * `/jobs` — the background work this session started, read from the job
 * registry the host mounts rather than from the transcript.
 *
 * A job outlives the tool call that started it: `bash` with `run_in_background`
 * and a delegated one-shot subagent both return to the model at once and keep
 * running, so the only place their current state exists is `ctx.jobs`. The
 * registry is in this process — the Web UI mirrors it across a socket, this
 * terminal simply holds it — so a listing is a synchronous read of memory and
 * needs no signal, no cache, and no loading state.
 *
 * The service is read structurally rather than as `JobRegistry`: `ctx.get`
 * answers `any`, and this bundle resolves its own `@deepseek-ai/dsh-jobs` while
 * the host that mounts the registry resolves another, so a nominal handle would
 * be a lie about identity (the reasoning `chat/rename.ts` records for
 * `SessionTitleWriter`, and `chat/subagents.ts` for the subagent directory).
 * Nothing here calls `instanceof`.
 *
 * `JobSnapshot` carries three more fields than any row shows —
 * `outputLimitBytes`, `ownerSession`, and the `reported` delivery bit — and the
 * mirror below drops them, exactly as the Web `JobView` contract does: they are
 * facts about how the registry notifies, not about what is running.
 * @module @deepseek-ai/dsh-tui/chat/jobs
 */
/**
 * One job's lifecycle state, as the registry reports it.
 *
 * `stopping` is a live state, not a terminal one: a kill has been requested and
 * the producer has not released its resources yet.
 */
export type JobStatus = 'running' | 'stopping' | 'completed' | 'killed' | 'failed';
/**
 * One job, cut down to what a reader needs.
 *
 * `kind` is left a bare string on purpose: the registry's kind map is extended
 * by declaration merging (`bash` and `subagent` ship with it, a producer plugin
 * adds its own), so a closed union here would be wrong about a profile this
 * terminal has never seen.
 */
export interface JobRow {
    /** The registry-issued id (`<kind>-N`). */
    readonly id: string;
    /** The producer kind, also the id's prefix. */
    readonly kind: string;
    /** The producer's one-line label: the command, or the delegation description. */
    readonly label: string;
    readonly status: JobStatus;
    /** Kind-specific detail the producer supplied, usually on the terminal state. */
    readonly detail?: string;
    /** Epoch ms when the job was registered. */
    readonly startedAt: number;
    /** Epoch ms when the job settled; absent while it is live. */
    readonly finishedAt?: number;
}
/**
 * The slice of `ctx.jobs` this terminal reads.
 *
 * Read-only: starting or killing a job is the model's business, and a terminal
 * that offered a kill would be racing the tool that owns the producer.
 */
export interface JobsRegistry {
    /**
     * The jobs one caller may see: its own, plus every unowned one.
     * @param caller - the reading agent; anything else sees only unowned jobs.
     * @returns fresh snapshots, in registration order.
     */
    list(caller?: unknown): readonly JobRow[];
    /**
     * Observe changes to what {@link list} would return.
     *
     * Owner-granular rather than job-granular, because a change may be a removal,
     * which no per-job record can express — so a listener re-reads the whole
     * visible set instead of accumulating deltas.
     * @param listener - called after each committed change, with the owner whose
     *   visible set moved (`undefined` when an unowned job changed and every
     *   caller's set moved with it).
     * @returns a disposer that removes the listener.
     */
    onJobsChanged(listener: (owner?: unknown) => void): () => void;
}
/** The shape of `ctx` this module needs: one optional-service lookup. */
export interface JobsRegistryHost {
    get(name: string): unknown;
}
/**
 * The job registry this session can read, when one is mounted.
 *
 * Resolved per call rather than captured once: the registry is a deployment
 * choice that a profile may mount after the terminal is already up, and a
 * command that answered "not mounted" forever would be wrong about it.
 * @param ctx - the runner context the TUI holds.
 * @returns the registry, or `undefined` on a profile that mounts none.
 */
export declare function jobsRegistry(ctx: JobsRegistryHost): JobsRegistry | undefined;
/**
 * Whether a job is still work in progress.
 *
 * A job being stopped counts as live: the producer still holds its resources,
 * and the row still has a clock running.
 * @param row - one job.
 * @returns `true` while the job has not settled.
 */
export declare function isLiveJob(row: JobRow): boolean;
/** The two numbers `/status` and the prompt badge state about background work. */
export interface JobCounts {
    /** Jobs still running or being stopped. */
    readonly live: number;
    /** Every job the registry still remembers, settled ones included. */
    readonly total: number;
}
/**
 * Count one listing the way the badge and `/status` report it.
 * @param rows - one visible set.
 * @returns the live and total counts.
 */
export declare function jobCounts(rows: readonly JobRow[]): JobCounts;
/**
 * Order one listing for reading: live jobs first, oldest first, then settled
 * ones, newest first.
 *
 * The registry answers in registration order, which buries a job that just
 * started under every job that ever finished. Live work is what a reader came
 * for and it is ordered by how long it has been waiting; finished work is
 * history, and history is read from its most recent end. Ties fall back to the
 * id so the list cannot reshuffle between two frames of the same second.
 * @param rows - one visible set, in any order.
 * @returns a new array; the input is left alone.
 */
export declare function sortJobRows(rows: readonly JobRow[]): JobRow[];
/**
 * How long one job has been running, or how long it ran.
 *
 * The clock is the caller's, not `Date.now`: the same discipline every elapsed
 * reading in this terminal follows, so a test can state a duration instead of
 * waiting for one.
 * @param row - one job.
 * @param now - the current time, in epoch ms.
 * @returns the elapsed span in ms, never negative.
 */
export declare function jobElapsed(row: JobRow, now: number): number;

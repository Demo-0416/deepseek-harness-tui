/**
 * `--print`: run one task to quiescence and write its answer on stdout, with no
 * terminal anywhere in the process.
 *
 * The flag asks for the opposite of what the rest of this bundle does — text on
 * a pipe instead of a screen — so the run never mounts the chat, never claims
 * the TTY, and never registers an answerer: a question nobody can see is a
 * process that hangs, and a full-screen UI over a redirected stdout is the one
 * thing the caller said they did not want.
 *
 * The driver mirrors `@deepseek-ai/dsh-headless`, which is the reference
 * one-shot runner: open one agent, wait for quiescence, deliver the task, wait
 * again, flush, and print the last assistant text of the interval the run owns.
 * Only the opening differs — this app opens its agent through the same startup
 * path the interactive run uses, so `--model`, `--preset`, `--resume`, and
 * `--continue` mean the same thing with `--print` as without it.
 * @module @deepseek-ai/dsh-tui/print
 */
import type { Context } from '@deepseek-ai/cordis';
import type { AgentHandle } from '@deepseek-ai/dsh-agent';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
/** Process-facing effects of one print run: the two output streams and the exit request. */
export interface PrintIo {
    stdout: {
        write(chunk: string): unknown;
    };
    stderr: {
        write(chunk: string): unknown;
    };
    /** Request process exit with `code`; the launcher disposes the tree behind it. */
    exit(code: number): void;
}
/** What one owned run interval produced. */
export interface PrintOutcome {
    /** The last non-empty assistant text of the interval, without a trailing newline. */
    text: string;
    /** Why the turn ended, or `undefined` when no turn ended inside the interval. */
    reason: SessionEvent<'turn/end'>['data']['reason'] | undefined;
}
/**
 * The answer and the verdict of one run interval.
 *
 * Read from the session log rather than from a stream subscription because the
 * log is the durable record: a run that printed what it streamed and a run that
 * printed what it stored could disagree, and only one of the two is what
 * `/resume` will show. Events before `firstSeq` belong to a resumed session's
 * history and are not this run's answer.
 * @param events - the whole session log, in order.
 * @param firstSeq - the first sequence number this run owns.
 * @returns the last non-empty assistant text and the turn's end reason.
 */
export declare function summarizePrintRun(events: readonly SessionEvent[], firstSeq: number): PrintOutcome;
/** What a print run needs from its host beyond the context's own services. */
export interface PrintRunDeps {
    /**
     * Open the agent this run drives.
     *
     * Supplied by the caller rather than created here, so the one-shot path and
     * the interactive one open their session through the same code and the
     * command line keeps one meaning.
     * @returns the owned agent handle.
     */
    openAgent(): Promise<AgentHandle>;
}
/**
 * Run one task through a freshly opened agent, print its answer, and request
 * the matching exit code.
 *
 * Approvals are pinned to `never` before the task is delivered. A one-shot run
 * has no surface to ask a human on, and the alternative is worse than a refusal
 * the model can read: an unanswerable request resolves fail-closed as
 * `unavailable` and the model is told a channel exists but is broken, twice per
 * tool call, with two audit events each time. `never` states the rule once, up
 * front, in the system prompt the model already reads.
 * @param ctx - the runner context, carrying `sessions` and optionally the loader.
 * @param task - the one-shot task text.
 * @param deps - how this run opens its agent.
 * @param io - the streams to write on and the exit to request.
 */
export declare function runPrintTask(ctx: Context, task: string, deps: PrintRunDeps, io: PrintIo): Promise<void>;
/**
 * Drive a print run and report anything it could not survive.
 *
 * Every failure lands here rather than on an unhandled rejection: a one-shot
 * run's whole product is one line on one stream and one exit code, and a run
 * that dies without printing either is indistinguishable from a hang.
 * @param ctx - the runner context.
 * @param task - the one-shot task text.
 * @param deps - how this run opens its agent.
 * @param io - the streams to write on and the exit to request.
 */
export declare function startPrintRun(ctx: Context, task: string, deps: PrintRunDeps, io: PrintIo): void;

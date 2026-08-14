/**
 * What "rewind to an earlier prompt" is, read off the session log: the prompts
 * that can be rewound to, and the seed a fork of the session would be built
 * from.
 *
 * Both are pure functions of the event log, so the panel, the fork, and their
 * tests all read the same rules. Nothing here touches the filesystem: dsh keeps
 * no per-message file snapshots, and a rewind never claims to restore any.
 * @module @deepseek-ai/dsh-tui/chat/rewind
 */
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type { RewindTarget } from '../components/rewind.ts';
export type { RewindTarget };
/**
 * The prompts this session can be rewound to, oldest first.
 *
 * Only messages the user actually typed qualify: producer-injected context and
 * compaction checkpoints are also `user/message` events, and offering them as
 * rewind targets would put text in the editor that no human ever wrote.
 * @param events - The session's event log.
 * @returns One target per typed prompt, in log order.
 */
export declare function rewindTargets(events: readonly SessionEvent[]): RewindTarget[];
/**
 * Whether this session has any prompt to rewind to.
 *
 * Scanned from the end and stopped at the first hit, because this answers a
 * keystroke: the Esc ladder asks it on every press at an empty prompt, and
 * folding the whole log each time would make the key slower the longer the
 * session gets.
 * @param events - The session's event log.
 * @returns `true` once one typed prompt is in the log.
 */
export declare function hasRewindTarget(events: readonly SessionEvent[]): boolean;
/**
 * How many leading events a fork placed before `seq` may keep.
 *
 * A seed must be a prefix that does not end inside an open turn
 * (`SessionStore.fork` rejects anything else), so the cut lands on the last
 * safe position before the prompt: after the last closed turn, plus any
 * between-turn events (headers, lifecycle) that follow it. For the first
 * prompt that is the pre-turn prefix — possibly empty, which is a legal seed.
 * A turn left open by a crash is never entered: the cut stays before its
 * `turn/start`, exactly as the API's own fork boundary requires.
 * @param events - The session's event log.
 * @param seq - Sequence of the `user/message` being rewound to.
 * @returns The seed length.
 */
export declare function forkSeedLength(events: readonly SessionEvent[], seq: number): number;

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
 * A seed must be a prefix that contains no open turn, step, or tool call
 * (`AgentRegistry.create` rejects anything else), so the only legal cut is
 * immediately after a completed turn — the same rule the API's own fork applies.
 * The cut lands on the last such boundary before the prompt, which is why a
 * prompt sent during a turn that never completed cannot be rewound to.
 * @param events - The session's event log.
 * @param seq - Sequence of the `user/message` being rewound to.
 * @returns The seed length, or `undefined` when no completed turn precedes it.
 */
export declare function forkSeedLength(events: readonly SessionEvent[], seq: number): number | undefined;

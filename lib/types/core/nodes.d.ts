/**
 * The event-to-node fold: turns dsh SessionEvents into renderable ChatNodes.
 *
 * `foldEvent` is a pure function of `(nodes, event)`: it reads nothing but its
 * arguments — no clock, no `process`, no `ctx`, no service lookup — so replaying
 * a resumed log and appending a live event take the exact same path, and folding
 * one event sequence twice yields identical nodes. Presentation state that is
 * genuinely per-process (the running spinner, a live compaction stopwatch,
 * pending steering) is deliberately absent: it belongs to the entry point, not
 * to the durable log.
 *
 * It mutates the draft array it is given (the store owns the draft and snapshots
 * it per batch) and returns whether anything visible changed. Every mutation
 * bumps the touched node's `version`, which is how the reconciler skips nodes
 * that did not change.
 *
 * {@link appendOptimisticUserMessage} is the one entry that does not come from
 * an event: the terminal echoes a message it just handed to the agent, because
 * the log records that message only when the agent claims it. It is keyed by
 * MessageId, so the event that eventually records the message lands on the same
 * node — the echo is a placeholder for a log entry, never a second source of
 * truth, and a replay (which never calls it) folds exactly the same list.
 * @module dsh-tui/core/nodes
 */
import type { MessageId, UserMessage } from '@deepseek-ai/dsh-llm';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type { ChatNode, UserMessageNode } from './types.ts';
/**
 * Echo one just-submitted user message, before any event records it.
 *
 * The only non-event entry into the node list. A message the terminal hands to
 * a running agent is claimed at that agent's next step boundary, so its
 * `user/message` event lands after the answer it interrupts has already
 * streamed rows onto the screen; without an echo the prompt would appear below
 * the reply it came before. Keyed by MessageId, so {@link foldEvent} lands the
 * logged message on this exact node.
 * @param nodes - the mutable draft node list.
 * @param message - the message handed to the agent.
 * @param source - `steering` when a running turn was interrupted, else `user`.
 * @returns true when a node was appended.
 */
export declare function appendOptimisticUserMessage(nodes: ChatNode[], message: UserMessage, source: UserMessageNode['source']): boolean;
/**
 * Withdraw the echo of a submission the agent's inbox discarded (cancelling a
 * turn clears every pending message), so a message the model will never see
 * does not stay on screen. Only an echo is withdrawn: once the log recorded the
 * message, the node is history.
 *
 * The node keeps its place and renders nothing, the way an unlanded compaction
 * already does, rather than leaving the array: positions in this list are
 * anchors — the `/clear` cut and the entry's process-local rows are both stored
 * as node indices — and shifting them would hide or misplace what follows.
 * @param nodes - the mutable draft node list.
 * @param id - the discarded message's identity.
 * @returns true when an echo was withdrawn.
 */
export declare function withdrawOptimisticUserMessage(nodes: ChatNode[], id: MessageId): boolean;
/**
 * Fold one session event into the draft node list.
 *
 * Pure: the result depends only on `nodes` and `event`, which is what lets a
 * resumed log and a live append share this one path.
 * @param nodes - the mutable draft node list.
 * @param event - the session event to apply.
 * @returns true when the rendered node list changed.
 */
export declare function foldEvent(nodes: ChatNode[], event: SessionEvent): boolean;
/**
 * Fold a whole event log into a fresh node list (resume, replay, and tests).
 * @param events - the events to fold, in log order.
 * @returns the folded nodes.
 */
export declare function foldEvents(events: readonly SessionEvent[]): ChatNode[];

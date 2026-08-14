/**
 * Per-session read model: subscribes to the dsh event bus, folds every event
 * through {@link foldEvent}, and publishes an immutable snapshot the renderer
 * reconciles against.
 *
 * The seeded log and the live stream take the same path — the constructor
 * replays `session.events` through the same fold the subscription uses — so a
 * resumed session and a live one cannot drift. High-frequency chunks are
 * coalesced into one snapshot per {@link BATCH_INTERVAL_MS} frame.
 *
 * The snapshot is the boundary: the node array is replaced wholesale per batch,
 * and each node carries a `version` the reconciler compares, so subscribers
 * never diff content. Per-process presentation state (spinners, stopwatches,
 * the queued-steering count) is deliberately not here; it belongs to the entry
 * point. The one exception is {@link SessionStore.appendOptimistic}: a
 * just-submitted message is a placeholder for a log entry that has not been
 * written yet, keyed so the entry replaces it, not a second read model.
 * @module dsh-tui/core/session-store
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { MessageId, UserMessage } from '@deepseek-ai/dsh-llm';
import type { Session } from '@deepseek-ai/dsh-session';
import type { SessionSnapshot, UserMessageNode } from './types.ts';
/**
 * One live session's read model. Dispose to unsubscribe.
 */
export declare class SessionStore {
    private readonly nodes;
    private readonly state;
    private snapshot;
    private readonly listeners;
    private batchTimer;
    private readonly offSessionEvent;
    private readonly offAgentStatus;
    constructor(ctx: Context, session: Session, agent: Agent);
    /**
     * Echo one just-submitted user message into the draft before any event
     * records it, so the prompt appears where it was sent rather than after the
     * answer it interrupted. The `user/message` event lands on the same node.
     * @param message - the message handed to the agent.
     * @param source - `steering` when a running turn was interrupted, else `user`.
     */
    appendOptimistic(message: UserMessage, source: UserMessageNode['source']): void;
    /**
     * Withdraw the echo of a submission the agent's inbox discarded.
     * @param id - the discarded message's identity.
     */
    withdrawOptimistic(id: MessageId): void;
    /** Apply one event to the draft and schedule a snapshot flush. */
    private apply;
    /** Build the immutable snapshot from the current draft. */
    private publish;
    /** Coalesce bursts of chunks into one snapshot per batch interval. */
    private scheduleFlush;
    /**
     * Subscribe to snapshot replacements.
     * @param listener - called after each published snapshot.
     * @returns the unsubscribe function.
     */
    subscribe(listener: () => void): () => void;
    /**
     * The current snapshot.
     * @returns the latest published snapshot.
     */
    getSnapshot(): SessionSnapshot;
    /** Unsubscribe from the event bus, publishing whatever the last batch held. */
    dispose(): void;
}

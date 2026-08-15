/**
 * `/subagents` — the delegation tree below this session, read from the durable
 * subagent directory rather than reconstructed from the transcript.
 *
 * `subagent/start` and `subagent/end` are cordis events, not session events, and
 * they carry only `runId` / `provider` / the child's session id / `local`. The
 * facts a tree wants — a child's label, whether it is one-shot or continuable,
 * where it hangs in the tree — live in the child's own log, and
 * `ctx.subagents.listDescendants()` is the one reader that already merges the
 * live store with persistence and resolves each identity through the registered
 * `subagent` projection. So the events are used only as an invalidation edge,
 * and every fact on screen comes from one listing. That is the same split the
 * Web catalog action makes.
 *
 * The service is read structurally rather than as `SubagentRuntime`: `ctx.get`
 * answers `any`, and this bundle resolves its own `@deepseek-ai/dsh-subagent`
 * while the host that mounts the registry resolves another, so a nominal handle
 * would be a lie about identity (the reasoning `chat/rename.ts` records for
 * `SessionTitleWriter`). Nothing here calls `instanceof`.
 *
 * A directory listing is a snapshot: a child that was spawned but has not
 * appended its descriptor yet is deliberately omitted by the service (the
 * creation window), so a freshly delegated agent can be one refresh late. That
 * is the service's contract, not a gap this module papers over.
 * @module @deepseek-ai/dsh-tui/chat/subagents
 */
import type { SessionId } from '@deepseek-ai/dsh-session';
/**
 * One interpreted child of the tree: what the directory could say about a
 * session whose durable header carries `origin: 'subagent'`.
 *
 * `activity` is a store fact, not an outcome — `running` means the child's
 * record is live in `ctx.sessions`, `inactive` that it exists only in
 * persistence — so no row here claims a child succeeded or failed.
 */
export interface SubagentChildEntry {
    readonly kind: 'child';
    /** The durable child session id; what `/resume` would take. */
    readonly id: SessionId;
    readonly activity: 'running' | 'inactive';
    /** Whether this child has origin-classified children of its own. */
    readonly hasChildren: boolean;
    /** A one-shot delegation, or a conversation that can be resumed. */
    readonly mode: 'one-shot' | 'continuable';
    /** The child's durable creation label; a one-shot child may carry none. */
    readonly label?: string;
}
/**
 * A candidate the directory could not interpret. Listed rather than dropped:
 * a session that exists but cannot be read is a fact about this tree, and
 * hiding it would make the count disagree with the store.
 */
export interface SubagentDiagnosticEntry {
    readonly kind: 'diagnostic';
    readonly id: SessionId;
    readonly reason: 'corrupt' | 'unsupported' | 'unavailable';
}
/** One row of a listing, before the tree position is added. */
export type SubagentEntry = SubagentChildEntry | SubagentDiagnosticEntry;
/** One row of a descendant listing: an entry plus where it hangs in the tree. */
export type SubagentDescendant = SubagentEntry & {
    /** The durable direct parent of this candidate. */
    readonly parentId: SessionId;
    /** Edge distance from the requested root; direct children are `1`. */
    readonly depth: number;
};
/**
 * The slice of `ctx.subagents` this terminal reads.
 *
 * Only the descendant listing: a TUI panel shows the whole tree at once rather
 * than expanding it a level at a time, so the per-parent `listChildren` the Web
 * catalog pages through has no caller here.
 */
export interface SubagentDirectory {
    /**
     * Enumerate every session-backed subagent below one root, in pre-order.
     * @param rootSessionId - the session whose descendants are listed.
     * @param signal - caller-owned cancellation, observed around persistence reads.
     * @returns the interpreted tree, ordered by creation time within each parent.
     */
    listDescendants(rootSessionId: SessionId, signal?: AbortSignal): Promise<readonly SubagentDescendant[]>;
}
/** The shape of `ctx` this module needs: one optional-service lookup. */
export interface SubagentDirectoryHost {
    get(name: string): unknown;
}
/**
 * The subagent registry this session can read, when one is mounted.
 *
 * Resolved per call rather than captured once: the registry is a deployment
 * choice that a profile may mount after the terminal is already up, and a
 * command that answered "not mounted" forever would be wrong about it.
 * @param ctx - the runner context the TUI holds.
 * @returns the directory, or `undefined` on a profile that mounts none.
 */
export declare function subagentDirectory(ctx: SubagentDirectoryHost): SubagentDirectory | undefined;
/** The two numbers `/status` states about a delegation tree. */
export interface SubagentCounts {
    /** Children whose record is live in the store right now. */
    readonly running: number;
    /** Every row the listing produced, diagnostics included. */
    readonly total: number;
}
/**
 * Count one listing the way `/status` reports it.
 *
 * A diagnostic counts toward the total and never toward `running`: it is a
 * session that exists, so leaving it out would make the row disagree with the
 * panel, but nothing about it says it is live.
 * @param entries - one descendant listing.
 * @returns the running and total counts.
 */
export declare function subagentCounts(entries: readonly SubagentDescendant[]): SubagentCounts;
/**
 * What a row calls a child.
 *
 * A one-shot child may have no durable label, and the tree still has to name
 * the row: the session id is what `/resume` takes anyway, so it stands in
 * rather than an invented placeholder.
 * @param entry - one listing row.
 * @returns the label, or the session id when there is none.
 */
export declare function subagentName(entry: SubagentDescendant): string;

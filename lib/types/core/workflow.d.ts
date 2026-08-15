/**
 * Derivations over a folded {@link WorkflowRunNode}: run status, member status,
 * and the phase grouping the collapsed rows render.
 *
 * The fold stores only the facts the log states (`stopReason`, `outcome`,
 * `endedAt`); everything a reader calls a "status" is computed here, from the
 * node alone. That split is what keeps live folding and replay in agreement:
 * an interrupted run is not a stored flag someone could set at a different
 * moment in the two paths, it is the reading of "the run stopped being live
 * without ever settling itself".
 *
 * Pure and locale-free, like the rest of `core/`: wording lives in the
 * components layer.
 * @module dsh-tui/core/workflow
 */
import type { WorkflowMemberEntry, WorkflowRunNode } from './types.ts';
/** How a workflow run or one of its members reads right now. */
export type WorkflowRunStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
/**
 * The status of one run.
 *
 * `stopReason` maps straight through (`error` is what a reader calls failed).
 * Without one, the run is interrupted when something already closed it —
 * a `run-end` can no longer arrive — and running otherwise.
 * @param node - the folded run.
 * @returns the derived status.
 */
export declare function workflowRunStatus(node: WorkflowRunNode): WorkflowRunStatus;
/**
 * The status of one member of a run.
 *
 * A settled member keeps its own outcome whatever happened to the run around
 * it; an unsettled one is interrupted exactly when its run is, because the same
 * closing event proves no `agent-end` can follow either.
 * @param node - the run the member belongs to.
 * @param member - the member entry.
 * @returns the derived status.
 */
export declare function workflowMemberStatus(node: WorkflowRunNode, member: WorkflowMemberEntry): WorkflowRunStatus;
/** One phase of a run, with the members published under it, in arrival order. */
export interface WorkflowPhaseGroup {
    /** The phase name as logged. `undefined` means the member carried no phase. */
    readonly phase: string | undefined;
    readonly members: readonly WorkflowMemberEntry[];
}
/**
 * Group a run's members by phase.
 *
 * Phases come out in the order their first member appeared, and an absent phase
 * is its own group rather than being merged into the empty-string one: the two
 * are different identities in the log, and a run can legitimately produce both.
 * @param node - the folded run.
 * @returns the phase groups, in first-appearance order.
 */
export declare function groupWorkflowPhases(node: WorkflowRunNode): WorkflowPhaseGroup[];
/** How many members of one group sit in each status. */
export type WorkflowStatusCounts = Readonly<Record<WorkflowRunStatus, number>>;
/**
 * Count the statuses of a set of members.
 * @param node - the run the members belong to.
 * @param members - the members to count.
 * @returns one count per status.
 */
export declare function workflowStatusCounts(node: WorkflowRunNode, members: readonly WorkflowMemberEntry[]): WorkflowStatusCounts;
/**
 * Whether a set of members still wants the reader's attention: anything that is
 * not plainly completed keeps its rows on screen.
 * @param node - the run the members belong to.
 * @param members - the members to inspect.
 * @returns true when at least one member is not completed.
 */
export declare function workflowNeedsAttention(node: WorkflowRunNode, members: readonly WorkflowMemberEntry[]): boolean;

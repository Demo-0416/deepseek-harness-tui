/**
 * What "search this session" reads, and what a hit looks like: the folded chat
 * nodes flattened into searchable entries, the case-insensitive substring pass
 * over them, and the excerpt/highlight pair a row is drawn from.
 *
 * This terminal renders inline, so the transcript above the prompt belongs to
 * the terminal's own scrollback: nothing here can scroll it, and no hit can be
 * pointed at where it was printed. The search is therefore a panel over the
 * session's messages rather than a jump through the transcript — which makes
 * every rule below a pure function of the node list, shared by the panel and
 * its tests.
 * @module @deepseek-ai/dsh-tui/chat/transcript-search
 */
import type { ChatNode } from '../core/types.ts';
/** Which surface an entry was folded from; decides its row's tone and label. */
export type TranscriptEntryRole = 'user' | 'assistant' | 'tool' | 'notice' | 'context' | 'reference' | 'compaction' | 'workflow';
/** One searchable message: everything one node contributes, as plain text. */
export interface TranscriptEntry {
    /** The node's own key, so a selection survives a re-filter. */
    readonly key: string;
    readonly role: TranscriptEntryRole;
    /** The row's left column: `You`, `Assistant`, a tool name, a plugin label. */
    readonly label: string;
    /** Log time of the node, for the detail header. */
    readonly time: number;
    /** The searchable body, newline separated in reading order. */
    readonly text: string;
}
/** One entry the query hit, with the line the panel shows for it. */
export interface TranscriptMatch {
    readonly entry: TranscriptEntry;
    /** The first hit line, windowed so the hit itself is inside the excerpt. */
    readonly excerpt: string;
    /** How many of the entry's lines the query hits; 0 for an empty query. */
    readonly hitLines: number;
}
/** One run of an excerpt, split at the query's occurrences. */
export interface HighlightSegment {
    readonly text: string;
    /** Whether this run is the query itself, which the panel paints. */
    readonly hit: boolean;
}
/**
 * Flatten a snapshot's nodes into the entries a search runs over.
 *
 * Order is the transcript's own, and an entry with nothing to read is dropped:
 * a row that matched on emptiness would open a panel page with nothing on it.
 * @param nodes - the store snapshot's nodes, in log order.
 * @returns one entry per readable node.
 */
export declare function transcriptEntries(nodes: readonly ChatNode[]): TranscriptEntry[];
/**
 * Every entry the query hits, in transcript order.
 *
 * The test is a case-insensitive substring, the same one the `/plugins` filter
 * and the model picker use: a fuzzy match would return rows whose relation to
 * what was typed the user cannot see, and this panel's whole job is to show it.
 * An empty query matches everything, so the panel opens on the session rather
 * than on an empty page.
 * @param entries - the flattened transcript.
 * @param query - what the user typed, verbatim.
 * @returns one match per hit entry.
 */
export declare function searchTranscript(entries: readonly TranscriptEntry[], query: string): TranscriptMatch[];
/**
 * Split one line at the query's occurrences, so the panel can paint them.
 *
 * The segments carry the original text, not the folded one: a highlight that
 * lower-cased what it drew would rewrite the message under the reader's eyes.
 * @param text - the line to split.
 * @param query - what the user typed, verbatim.
 * @returns the runs in order; empty for empty text.
 */
export declare function highlightSegments(text: string, query: string): HighlightSegment[];

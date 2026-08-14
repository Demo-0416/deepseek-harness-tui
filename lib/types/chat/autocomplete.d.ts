/**
 * Editor autocomplete provider merging path-only file candidates and optional
 * session-reference snapshots with the base slash-command completions.
 * @module @deepseek-ai/dsh-tui/chat/autocomplete
 */
import { CombinedAutocompleteProvider, type AutocompleteItem, type AutocompleteProvider, type AutocompleteSuggestions } from '@earendil-works/pi-tui';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { type SessionReferenceResolver } from '@deepseek-ai/dsh-session-reference';
import { WorkspaceFileSearch } from './file-autocomplete.ts';
/** Merge path-only file candidates and optional session snapshots with commands. */
export declare class ReferenceAutocompleteProvider implements AutocompleteProvider {
    private readonly base;
    private readonly files;
    private readonly sessions;
    private readonly agent;
    /**
     * @param base - pi's provider, which also answers `@` when it was given an `fd` path.
     * @param files - the in-process walker, or `undefined` when `fd` answers `@` instead.
     *   The two are alternatives, never both: pi's provider and this one produce
     *   the same paths from the same token, so running them together would put
     *   every file in the menu twice.
     * @param sessions - the optional session-reference resolver.
     * @param agent - the agent whose session references are offered.
     */
    constructor(base: CombinedAutocompleteProvider, files: WorkspaceFileSearch | undefined, sessions: SessionReferenceResolver | undefined, agent: Agent);
    getSuggestions(lines: string[], cursorLine: number, cursorCol: number, options: {
        signal: AbortSignal;
        force?: boolean;
    }): Promise<AutocompleteSuggestions | null>;
    applyCompletion(lines: string[], cursorLine: number, cursorCol: number, item: AutocompleteItem, prefix: string): {
        lines: string[];
        cursorLine: number;
        cursorCol: number;
    };
    shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean;
}

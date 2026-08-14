/**
 * Argument-level completion sources for this terminal's own slash commands.
 *
 * pi's `CombinedAutocompleteProvider` asks a command for these the moment the
 * user types a character after `/name ` — the command's `argumentHint` only
 * says what an argument would look like, while these say which ones exist here
 * and now. The menu is therefore the same answer the corresponding picker
 * would have shown, without leaving the editor.
 *
 * Three contracts shape every function below:
 *
 * 1. The value replaces the WHOLE argument text, not the token at the cursor
 *    (pi `autocomplete.ts` slash-argument branch), so a grammar with several
 *    tokens has to re-emit the tokens it is not completing.
 * 2. A label ending in `/` is treated as a directory and pulls the cursor back
 *    one column, so labels are stripped of a trailing slash.
 * 3. There is no `AbortSignal`. A source that waits on I/O holds up the menu
 *    for that keystroke, so these read what a service already has in memory
 *    and never open a session log.
 *
 * Returning `null` — never an empty array with a note in it — is how a source
 * says "no menu", which is what the provider then reports upward.
 *
 * @module @deepseek-ai/dsh-tui/chat/command-completions
 */
import type { AutocompleteItem } from '@earendil-works/pi-tui';
/** One advertised route, as the LLM service lists it. */
export interface CompletableModel {
    /** Model id, as it is written after `provider/`. */
    id: string;
    /** Human-facing model name, when the provider advertises one. */
    name?: string;
    /** One-line model description, when the provider advertises one. */
    description?: string;
}
/** The slice of the LLM service `/model` completion reads. */
export interface ModelRouteSource {
    /** Registered providers, in registration order. */
    listProviders(): readonly {
        id: string;
    }[];
    /** Routes one provider advertises. */
    listModels(provider: string): Promise<readonly CompletableModel[]>;
}
/** One preset the roster can compose, as `/preset` completion needs it. */
export interface CompletablePreset {
    id: string;
    name?: string;
    description?: string;
    /** Why the preset cannot compose a session; the row stays, the reason shows. */
    broken?: string;
}
/** The slice of the preset roster `/preset` completion reads. */
export interface PresetSource {
    list(): Promise<readonly CompletablePreset[]>;
    /** Preset id a session composes when it names none. */
    readonly defaultId: string;
}
/** One resumable session, reduced to what a completion row can show. */
export interface CompletableSession {
    /** Session id, which is what the argument carries. */
    id: string;
    /** Workspace the session ran in, absent for a log that recorded none. */
    cwd?: string;
    /** Creation time, used to order rows when nothing else distinguishes them. */
    createdAt: number;
    /** Already-live sessions cannot be resumed into this process. */
    live: boolean;
    /** Folded session title, when one is already in memory; never read from a log. */
    title?: string;
}
/** The slice of the session store `/resume` completion reads. */
export interface ResumeSessionSource {
    /** Every known session, unordered; the completion sorts and scopes them. */
    list(): Promise<readonly CompletableSession[]>;
    /** The session this terminal is running, which cannot be resumed into itself. */
    readonly currentSessionId: string;
    /** This session's workspace, which is the scope the picker opens in. */
    readonly cwd: string | undefined;
}
/**
 * Reuse one asynchronous listing across the keystrokes of a single argument.
 *
 * The slash-argument path has no debounce and no `AbortSignal`: pi's editor
 * issues the request on the keystroke, so a source that lists a provider
 * catalog or a session store would pay one listing per character and the menu
 * would trail the text. One short window collapses a burst of typing into a
 * single read while still noticing what appeared while the terminal was idle.
 * A rejection is never retained — the next keystroke gets a fresh attempt.
 * @param read - the listing to reuse, keyed for sources listed per subject.
 * @param ttlMs - how long one listing stays valid.
 * @param now - clock, injectable so a test does not have to wait out the window.
 * @returns the memoized listing.
 */
export declare function memoizeListing<Value>(read: (key: string) => Promise<Value>, ttlMs: number, now?: () => number): (key: string) => Promise<Value>;
/**
 * Complete `/model [[provider/]model]` with every advertised route.
 *
 * Values are always fully qualified `provider/model`, even when the user typed
 * a bare model name: the command resolves an unqualified name against the
 * registered providers, and a menu that inserts the ambiguous form would make
 * the terminal answer a question the user just answered.
 * @param source - the LLM service.
 * @param argumentPrefix - argument text typed so far.
 * @param limit - maximum rows offered.
 * @returns the routes still matching, or `null` for no menu.
 */
export declare function modelArgumentCompletions(source: ModelRouteSource, argumentPrefix: string, limit: number): Promise<AutocompleteItem[] | null>;
/**
 * Complete `/preset [<preset> | copy <preset> <new-id>]` with the roster's ids.
 *
 * The `copy` form's third token is a name the user is inventing, so only its
 * source preset is completed; the verb itself is offered while the first token
 * is still being typed.
 * @param source - the preset roster.
 * @param argumentPrefix - argument text typed so far.
 * @param limit - maximum rows offered.
 * @returns the presets still matching, or `null` for no menu.
 */
export declare function presetArgumentCompletions(source: PresetSource, argumentPrefix: string, limit: number): Promise<AutocompleteItem[] | null>;
/**
 * Complete `/theme [auto|light|dark|no-color]`.
 *
 * One slot with four values, each carrying the sentence the selector shows
 * beside it, so the menu and the picker answer the same question the same way.
 * @param argumentPrefix - argument text typed so far.
 * @returns the matching themes, or `null` for no menu.
 */
export declare function themeArgumentCompletions(argumentPrefix: string): AutocompleteItem[] | null;
/**
 * Complete `/lang [en|zh]` with the locales this terminal ships.
 *
 * The active one is marked rather than hidden: the menu is also how a user
 * checks what the language currently is, and a list that dropped the answer
 * would make them run the command to find out.
 * @param argumentPrefix - argument text typed so far.
 * @returns the matching locales, or `null` for no menu.
 */
export declare function langArgumentCompletions(argumentPrefix: string): AutocompleteItem[] | null;
/**
 * Complete `/resume [session]` with this workspace's resumable sessions.
 *
 * Scoped to the current workspace because that is the scope the picker opens
 * in: an id from another directory would insert a query whose only match is
 * hidden until the user widens the scope by hand. Ordered newest first by
 * creation time — the picker orders by last activity, which costs one `stat`
 * per session, and a menu that renders between two keystrokes cannot pay that.
 * @param source - the session store, reduced to metadata already in memory.
 * @param argumentPrefix - argument text typed so far.
 * @param limit - maximum rows offered.
 * @returns the matching sessions, or `null` for no menu.
 */
export declare function resumeArgumentCompletions(source: ResumeSessionSource, argumentPrefix: string, limit: number): Promise<AutocompleteItem[] | null>;

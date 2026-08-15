/**
 * The handful of presentation choices `/config` and `/theme` write, and the
 * user-settings section they outlive the process in.
 *
 * Storage is the harness's own settings document (`$DSH_HOME/settings.yaml`),
 * reached exactly the way `/model` reaches the default-model layer: through the
 * optional `settings` service, shape-checked rather than typed, because
 * `@deepseek-ai/dsh-settings` is a host mount this bundle never requires. An
 * embedder without it keeps every switch working for the session and simply
 * forgets it afterwards, which is what a terminal without a home directory
 * should do.
 * @module @deepseek-ai/dsh-tui/chat/preferences
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { type ThemePreferenceId } from '../components/theme.ts';
import type { ToolCardVisibility } from '../components/transcript.ts';
/**
 * Section of the user settings document these preferences live in, named for
 * this bundle's short name the way every other section is (`agent-default-model`,
 * `llm-deepseek`).
 */
export declare const TUI_SETTINGS_NAMESPACE = "tui";
/**
 * How many times the empty input row may teach the Up key before it stops.
 *
 * Claude Code shows its own version of this hint three times; here the count is
 * really written, so a user who has seen the lesson (or used the key) gets the
 * running placeholder back instead of being taught forever.
 */
export declare const QUEUE_UP_HINT_LIMIT = 3;
/**
 * What Enter does with a prompt typed while a turn is running.
 *
 * `steer` hands it to the running driver, which reads it at its next step
 * boundary — the interruption this terminal has always performed. `queue` parks
 * it for a turn of its own, so the answer in flight is left alone.
 */
export declare const BUSY_ENTER_BEHAVIORS: readonly ["steer", "queue"];
/** One of {@link BUSY_ENTER_BEHAVIORS}. */
export type BusyEnterBehavior = typeof BUSY_ENTER_BEHAVIORS[number];
/** Everything `/config` writes, resolved over config and schema defaults. */
export interface TuiPreferences {
    /**
     * Whether a finished step keeps its thinking block on screen — the Ctrl+T pin,
     * remembered. Off by default: thinking streams while the step runs and goes
     * with the step that produced it, and a deployment that sets
     * `showReasoning: false` takes the blocks away whatever this says.
     */
    thinkingPinned: boolean;
    /** The tool-card phase a session opens on, which the Ctrl+O cycle then moves. */
    toolCards: ToolCardVisibility;
    /** The palette this terminal paints with; `auto` follows the terminal's report. */
    theme: ThemePreferenceId;
    /**
     * How many times this user has been shown that Up edits a queued prompt,
     * capped at {@link QUEUE_UP_HINT_LIMIT}. A teaching counter rather than a
     * switch: it is written by the terminal, not by `/config`, and it is stored
     * because a lesson repeated in every new session is not a lesson.
     */
    queueUpHintSeen: number;
    /**
     * What Enter means while a turn runs: `steer` interrupts it, `queue` waits
     * for it.
     *
     * `steer` by default, which is what this terminal has always done and what
     * its running placeholder, its steering badge and its cancel-hands-the-text-
     * back behaviour were all built around. The harness's web chat calls the same
     * choice `busyEnter` in its own `ui-conversation` section and defaults it the
     * other way; the two are deliberately separate documents — a browser tab with
     * a visible queue dock and a terminal are not the same room — but the name is
     * shared so a future unification has something to join on.
     */
    busyEnter: BusyEnterBehavior;
}
/**
 * Schema of the `tui` settings section.
 *
 * Declared even though every read here is shape-checked anyway: the provider
 * validates a stored section against it, so a hand-edited document says which
 * value it got wrong instead of silently resolving to a default, and a
 * configuration UI has something to render.
 */
export declare const TUI_PREFERENCES_SCHEMA: z<TuiPreferences>;
/** Reads and writes of one preference section. */
export interface TuiPreferenceStore {
    /** The stored preferences, over this deployment's config, over the defaults. */
    current(): TuiPreferences;
    /**
     * Persist one changed preference. Fire-and-forget: the value is already live
     * on screen, so nothing waits on a settings write to acknowledge it, and a
     * rejected write is reported as a warning — what failed is the durability of
     * the choice, not the choice.
     * @param patch - the fields that changed.
     */
    save(patch: Partial<TuiPreferences>): void;
}
/**
 * Open this terminal's preference section, or an in-memory stand-in for it.
 *
 * @param ctx - the runner context, which may or may not carry a `settings` provider.
 * @param base - the deployment's own config values, layered under the user's.
 * @param reportError - how a failed read or write reaches the screen; called
 *   with a finished sentence.
 * @returns the store `/config` and `/theme` read and write.
 */
export declare function openTuiPreferences(ctx: Context, base: Partial<TuiPreferences>, reportError: (message: string) => void): TuiPreferenceStore;

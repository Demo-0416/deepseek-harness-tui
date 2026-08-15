/**
 * The keys this terminal binds for itself, as a pi-tui keybinding registry.
 *
 * pi-tui resolves every key through one process-global {@link KeybindingsManager}
 * (`Editor.handleInput` reads it on its first line), so an app that wants its own
 * keys rebindable has to own that singleton: the registry below is pi-tui's own
 * table plus this terminal's actions, and {@link installKeybindings} publishes it
 * before any component is constructed. Omitting `TUI_KEYBINDINGS` would silently
 * unbind the editor's own keys — `matches()` answers `false` for an id the
 * manager does not know — so the spread is not optional.
 *
 * Ctrl+C is deliberately absent: it is the one key a terminal must always answer
 * (cancel, then leave), and a user who rebinds it away has no way back.
 * @module @deepseek-ai/dsh-tui/keybindings
 */
import { KeybindingsManager, type KeybindingDefinitions, type KeybindingsConfig } from '@earendil-works/pi-tui';
/** The actions this terminal binds, merged into pi-tui's global registry. */
export interface AppKeybindings {
    'app.mode.cycle': true;
    'app.tools.cycle': true;
    'app.history.search': true;
    'app.transcript.search': true;
    'app.todos.toggle': true;
    'app.thinking.toggle': true;
    'app.message.copy': true;
    'app.draft.edit': true;
    'app.screen.redraw': true;
    'app.cancel': true;
    'app.exit': true;
}
declare module '@earendil-works/pi-tui' {
    interface Keybindings extends AppKeybindings {
    }
}
/** One action this terminal binds. */
export type AppKeybinding = keyof AppKeybindings;
/**
 * This terminal's own actions and their default keys.
 *
 * The descriptions are user-facing: `/hotkeys` and `/help` render them beside
 * whichever key is bound, so a rebound key never leaves the help lying.
 */
export declare const APP_KEYBINDINGS: {
    readonly 'app.mode.cycle': {
        readonly defaultKeys: "shift+tab";
        readonly description: "Cycle mode: normal, auto-accept, plan";
    };
    readonly 'app.tools.cycle': {
        readonly defaultKeys: "ctrl+o";
        readonly description: "Cycle tool cards: preview, full, hidden";
    };
    readonly 'app.history.search': {
        readonly defaultKeys: "ctrl+r";
        readonly description: "Search prompt history backwards";
    };
    readonly 'app.transcript.search': {
        readonly defaultKeys: "ctrl+g";
        readonly description: "Search this session's messages";
    };
    readonly 'app.todos.toggle': {
        readonly defaultKeys: "ctrl+n";
        readonly description: "Expand or collapse the plan";
    };
    readonly 'app.thinking.toggle': {
        readonly defaultKeys: "ctrl+t";
        readonly description: "Show or hide thinking blocks";
    };
    readonly 'app.message.copy': {
        readonly defaultKeys: "ctrl+x";
        readonly description: "Copy the last answer";
    };
    readonly 'app.draft.edit': {
        readonly defaultKeys: "alt+e";
        readonly description: "Edit the draft in $EDITOR";
    };
    readonly 'app.screen.redraw': {
        readonly defaultKeys: "ctrl+l";
        readonly description: "Redraw the screen";
    };
    readonly 'app.cancel': {
        readonly defaultKeys: "escape";
        readonly description: "Cancel the turn; twice to clear the draft or rewind";
    };
    readonly 'app.exit': {
        readonly defaultKeys: "ctrl+d";
        readonly description: "Exit on an empty prompt";
    };
};
/** pi-tui's own bindings plus this terminal's, which is what the manager is built from. */
export declare const KEYBINDINGS: KeybindingDefinitions;
/**
 * Keep only the entries a keybinding config can express.
 *
 * Configuration reaches this from a deployment file, so a value of the wrong
 * shape is dropped rather than trusted: an unbindable entry that reached the
 * manager would take its action's default away and bind nothing in its place.
 * @param bindings - The deployment's `keybindings` map, if any.
 * @returns The usable subset, in the manager's own shape.
 */
export declare function toKeybindingsConfig(bindings: Record<string, string | string[]> | undefined): KeybindingsConfig;
/**
 * Publish this terminal's registry as pi-tui's process-global one.
 *
 * Must run before the editor and every other pi-tui component is constructed;
 * they read the singleton at construction and on every keystroke.
 * @param bindings - User overrides, keyed by action id.
 * @returns The manager, for the resolved keys the help panels render.
 */
export declare function installKeybindings(bindings: Record<string, string | string[]> | undefined): KeybindingsManager;
/** One key claimed by an `app.*` action and by a pi-tui action at the same time. */
export interface KeybindingCollision {
    /** The contested key id, e.g. `ctrl+y`. */
    readonly key: string;
    /** The `app.*` action that wins it. */
    readonly action: string;
    /** The pi-tui actions it shadows. */
    readonly shadowed: readonly string[];
}
/**
 * Keys an `app.*` action takes away from pi-tui.
 *
 * `KeybindingsManager.getConflicts()` only compares *user overrides* against
 * each other, so a default that collides with a pi-tui default is invisible to
 * it — and the collision is silent at runtime too, because the app's input
 * listener runs before the focused component and answers with `consume: true`,
 * so the editor never sees the key at all. This is the check that names it:
 * resolved keys, not declared ones, so a deployment that rebinds *into* a
 * pi-tui key is reported as well.
 * @param manager - The installed manager, read for resolved keys.
 * @returns One entry per contested key, minus {@link ACCEPTED_COLLISIONS}.
 */
export declare function keybindingCollisions(manager: KeybindingsManager): KeybindingCollision[];
/**
 * Render one key id the way the help panels name keys.
 * @param key - A pi-tui key id such as `shift+ctrl+d`.
 * @returns The display form, such as `Shift+Ctrl+D`.
 */
export declare function formatKeyId(key: string): string;
/**
 * The keys an action is currently bound to, as one label.
 *
 * Read from the manager rather than from {@link APP_KEYBINDINGS}, so a
 * deployment that rebinds an action gets help text that names its key.
 * @param manager - The installed manager.
 * @param action - The action to name.
 * @returns The bound keys joined by `/`, or `unbound` when the user removed them all.
 */
export declare function keyLabel(manager: KeybindingsManager, action: AppKeybinding): string;

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

import {
  KeybindingsManager,
  TUI_KEYBINDINGS,
  setKeybindings,
  type KeybindingDefinitions,
  type KeybindingsConfig,
  type KeyId,
} from '@earendil-works/pi-tui'

/** The actions this terminal binds, merged into pi-tui's global registry. */
export interface AppKeybindings {
  'app.tools.cycle': true
  'app.history.search': true
  'app.todos.toggle': true
  'app.thinking.toggle': true
  'app.message.copy': true
  'app.screen.redraw': true
  'app.cancel': true
  'app.exit': true
}

declare module '@earendil-works/pi-tui' {
  interface Keybindings extends AppKeybindings {}
}

/** One action this terminal binds. */
export type AppKeybinding = keyof AppKeybindings

/**
 * This terminal's own actions and their default keys.
 *
 * The descriptions are user-facing: `/hotkeys` and `/help` render them beside
 * whichever key is bound, so a rebound key never leaves the help lying.
 */
export const APP_KEYBINDINGS = {
  'app.tools.cycle': { defaultKeys: 'ctrl+o', description: 'Cycle tool cards: preview, full, hidden' },
  'app.history.search': { defaultKeys: 'ctrl+r', description: 'Search prompt history backwards' },
  // Claude Code gives Ctrl+T to the plan and has no thinking switch at all;
  // pi gives it to thinking. This terminal has both, so the collision is real
  // and was decided for thinking: it is the key a user reaches for mid-answer,
  // and Ctrl+Y is free and adjacent for the plan.
  'app.todos.toggle': { defaultKeys: 'ctrl+y', description: 'Expand or collapse the plan' },
  'app.thinking.toggle': { defaultKeys: 'ctrl+t', description: 'Show or hide thinking blocks' },
  'app.message.copy': { defaultKeys: 'ctrl+x', description: 'Copy the last answer' },
  'app.screen.redraw': { defaultKeys: 'ctrl+l', description: 'Redraw the screen' },
  'app.cancel': { defaultKeys: 'escape', description: 'Cancel the turn; twice to clear the draft or rewind' },
  'app.exit': { defaultKeys: 'ctrl+d', description: 'Exit on an empty prompt' },
} as const satisfies KeybindingDefinitions

/** pi-tui's own bindings plus this terminal's, which is what the manager is built from. */
export const KEYBINDINGS: KeybindingDefinitions = { ...TUI_KEYBINDINGS, ...APP_KEYBINDINGS }

/**
 * Keep only the entries a keybinding config can express.
 *
 * Configuration reaches this from a deployment file, so a value of the wrong
 * shape is dropped rather than trusted: an unbindable entry that reached the
 * manager would take its action's default away and bind nothing in its place.
 * @param bindings - The deployment's `keybindings` map, if any.
 * @returns The usable subset, in the manager's own shape.
 */
export function toKeybindingsConfig(bindings: Record<string, string | string[]> | undefined): KeybindingsConfig {
  const config: KeybindingsConfig = {}
  for (const [action, keys] of Object.entries(bindings ?? {})) {
    if (typeof keys === 'string') config[action] = keys as KeyId
    else if (Array.isArray(keys) && keys.every(key => typeof key === 'string')) config[action] = keys as KeyId[]
  }
  return config
}

/**
 * Publish this terminal's registry as pi-tui's process-global one.
 *
 * Must run before the editor and every other pi-tui component is constructed;
 * they read the singleton at construction and on every keystroke.
 * @param bindings - User overrides, keyed by action id.
 * @returns The manager, for the resolved keys the help panels render.
 */
export function installKeybindings(bindings: Record<string, string | string[]> | undefined): KeybindingsManager {
  const manager = new KeybindingsManager(KEYBINDINGS, toKeybindingsConfig(bindings))
  setKeybindings(manager)
  return manager
}

/** How a key id's parts are shown to the user: `ctrl+o` reads as `Ctrl+O`. */
const KEY_LABELS: Record<string, string> = {
  ctrl: 'Ctrl',
  alt: 'Alt',
  shift: 'Shift',
  escape: 'Esc',
  enter: 'Enter',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Delete',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  pageUp: 'PgUp',
  pageDown: 'PgDn',
  home: 'Home',
  end: 'End',
  space: 'Space',
}

/**
 * Render one key id the way the help panels name keys.
 * @param key - A pi-tui key id such as `shift+ctrl+d`.
 * @returns The display form, such as `Shift+Ctrl+D`.
 */
export function formatKeyId(key: string): string {
  return key.split('+').map(part => KEY_LABELS[part] ?? (part.length === 1 ? part.toUpperCase() : part)).join('+')
}

/**
 * The keys an action is currently bound to, as one label.
 *
 * Read from the manager rather than from {@link APP_KEYBINDINGS}, so a
 * deployment that rebinds an action gets help text that names its key.
 * @param manager - The installed manager.
 * @param action - The action to name.
 * @returns The bound keys joined by `/`, or `unbound` when the user removed them all.
 */
export function keyLabel(manager: KeybindingsManager, action: AppKeybinding): string {
  const keys = manager.getKeys(action)
  return keys.length === 0 ? 'unbound' : keys.map(key => formatKeyId(key)).join('/')
}

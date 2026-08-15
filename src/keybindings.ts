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
  type Keybinding,
  type KeybindingDefinitions,
  type KeybindingsConfig,
  type KeyId,
} from '@earendil-works/pi-tui'

/** The actions this terminal binds, merged into pi-tui's global registry. */
export interface AppKeybindings {
  'app.mode.cycle': true
  'app.tools.cycle': true
  'app.history.search': true
  'app.transcript.search': true
  'app.todos.toggle': true
  'app.thinking.toggle': true
  'app.message.copy': true
  'app.draft.edit': true
  'app.screen.redraw': true
  'app.submit.opposite': true
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
  // The one key Claude Code users reach for without reading anything, and the
  // reason it is safe to take: pi-tui binds `tab` (`tui.input.tab`) and nothing
  // else in the Tab family — `shift+tab` appears in its key parser and in no
  // binding, and its editor recognises no Shift+Tab of its own (the hardcoded
  // shift keys are `shift+backspace`, `shift+delete`, `shift+space`,
  // `shift+enter`). So this binding shadows no editor action; `keybindingCollisions`
  // reports it if that ever changes. The `/model` picker's own Shift+Tab (step
  // the reasoning effort) is untouched, because it is read inside the dialog and
  // the app's listener returns before its first branch while an overlay is open.
  'app.mode.cycle': { defaultKeys: 'shift+tab', description: 'Cycle mode: normal, auto-accept, plan' },
  'app.tools.cycle': { defaultKeys: 'ctrl+o', description: 'Cycle tool cards: preview, full, hidden' },
  'app.history.search': { defaultKeys: 'ctrl+r', description: 'Search prompt history backwards' },
  // Not Ctrl+F, the key a reader expects for "find": pi-tui binds it as the
  // editor's forward-char (`tui.editor.cursorRight`), and an app binding is
  // answered before the editor sees the key, so taking it would silently break
  // an emacs habit the editor already serves. Ctrl+G is bound by nothing here
  // or in pi-tui, and reaches the process on every terminal — unlike Ctrl+S,
  // which a multiplexer or an ssh line may still swallow as flow control.
  'app.transcript.search': { defaultKeys: 'ctrl+g', description: 'Search this session\'s messages' },
  // Claude Code gives Ctrl+T to the plan and has no thinking switch at all;
  // pi gives it to thinking. This terminal has both, so the collision is real
  // and was decided for thinking: it is the key a user reaches for mid-answer.
  // The plan therefore needs a key of its own, and it is Ctrl+N — not Ctrl+Y,
  // which pi-tui binds as the editor's kill-ring paste (`tui.editor.yank`,
  // paired with ctrl+k/ctrl+u/ctrl+w): taking it would leave text cut with
  // those three unrecoverable, the same trap that kept `/search` off Ctrl+F.
  // pi-tui leaves `ctrl+n`/`ctrl+p` unbound (`tui.editor.historyNext` and
  // `historyPrevious` ship with empty `defaultKeys`), and this terminal drives
  // prompt history from the arrow keys and Ctrl+R.
  'app.todos.toggle': { defaultKeys: 'ctrl+n', description: 'Expand or collapse the plan' },
  'app.thinking.toggle': { defaultKeys: 'ctrl+t', description: 'Show or hide thinking blocks' },
  'app.message.copy': { defaultKeys: 'ctrl+x', description: 'Copy the last answer' },
  // Claude Code puts this on Ctrl+G and on the readline chord Ctrl+X Ctrl+E
  // (`keybindings/defaultBindings.ts:83-84`). Neither is available here: Ctrl+G
  // is this terminal's session search, Ctrl+X is `app.message.copy` — and a
  // chord is not expressible at all, because pi-tui's `KeyId` is one key
  // combination and `matches()` is answered from a single input chunk, so a
  // prefix key would have to stall the copy it already performs. Alt+E is free
  // in both tables, reads as "editor", and sits in the family pi-tui already
  // uses for editing (alt+b/f/d/y). A terminal that sends Option as a composed
  // character rather than Meta cannot deliver it; `/editor` is the entry that
  // always works, and `keybindings` moves the key.
  'app.draft.edit': { defaultKeys: 'alt+e', description: 'Edit the draft in $EDITOR' },
  'app.screen.redraw': { defaultKeys: 'ctrl+l', description: 'Redraw the screen' },
  // The one-off inverse of the `/config` busy-Enter choice, the way the
  // harness's web chat spells it. Safe to bind: pi-tui's own tables hold no
  // Ctrl+Enter, and its editor recognises Enter, Shift+Enter and Alt+Enter
  // only. It is also the one binding here that a terminal may be unable to
  // deliver: without the Kitty keyboard protocol or xterm's modifyOtherKeys,
  // Ctrl+Enter reaches the process as a bare `\r` that no code can tell from
  // Enter, so the gesture degrades to a plain send rather than misfiring.
  'app.submit.opposite': { defaultKeys: 'ctrl+enter', description: 'Send with the opposite busy-Enter behavior' },
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

/**
 * The keys this terminal knowingly takes off pi-tui, and the editor action each
 * one shadows.
 *
 * Both are load-bearing terminal conventions the editor cannot outrank: Ctrl+D
 * is EOF on an empty prompt (it shadows `tui.editor.deleteCharForward`, whose
 * job the Delete key still does), and Esc cancels the turn (it shadows the
 * select widget's own cancel, which never coexists with the input listener
 * anyway, since an open overlay returns before this listener's first branch).
 * Everything *not* listed here is a bug — see {@link keybindingCollisions}.
 */
const ACCEPTED_COLLISIONS: Readonly<Record<string, readonly string[]>> = {
  'ctrl+d': ['tui.editor.deleteCharForward'],
  escape: ['tui.select.cancel'],
}

/** One key claimed by an `app.*` action and by a pi-tui action at the same time. */
export interface KeybindingCollision {
  /** The contested key id, e.g. `ctrl+y`. */
  readonly key: string
  /** The `app.*` action that wins it. */
  readonly action: string
  /** The pi-tui actions it shadows. */
  readonly shadowed: readonly string[]
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
export function keybindingCollisions(manager: KeybindingsManager): KeybindingCollision[] {
  const collisions: KeybindingCollision[] = []
  for (const action of Object.keys(APP_KEYBINDINGS)) {
    for (const key of manager.getKeys(action as Keybinding)) {
      const shadowed = Object.keys(TUI_KEYBINDINGS)
        .filter(other => manager.getKeys(other as Keybinding).includes(key))
        .filter(other => !(ACCEPTED_COLLISIONS[key] ?? []).includes(other))
      if (shadowed.length > 0) collisions.push({ key, action, shadowed })
    }
  }
  return collisions
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

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

import type { Context } from '@deepseek-ai/cordis'
import { errorChain } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'
import { isThemePreference, type ThemePreferenceId } from '../components/theme.ts'
import type { ToolCardVisibility } from '../components/transcript.ts'

/**
 * Section of the user settings document these preferences live in, named for
 * this bundle's short name the way every other section is (`agent-default-model`,
 * `llm-deepseek`).
 */
export const TUI_SETTINGS_NAMESPACE = 'tui'

/** Everything `/config` writes, resolved over config and schema defaults. */
export interface TuiPreferences {
  /** Whether reasoning blocks stay on screen. */
  showReasoning: boolean
  /** The tool-card phase a session opens on, which the Ctrl+O cycle then moves. */
  toolCards: ToolCardVisibility
  /** The palette this terminal paints with; `auto` follows the terminal's report. */
  theme: ThemePreferenceId
}

/**
 * Schema of the `tui` settings section.
 *
 * Declared even though every read here is shape-checked anyway: the provider
 * validates a stored section against it, so a hand-edited document says which
 * value it got wrong instead of silently resolving to a default, and a
 * configuration UI has something to render.
 */
export const TUI_PREFERENCES_SCHEMA: z<TuiPreferences> = z.object({
  showReasoning: z.boolean().default(true),
  toolCards: z.union(['collapsed', 'expanded', 'hidden'] as const).default('collapsed'),
  theme: z.union(['auto', 'light', 'dark', 'no-color'] as const).default('auto'),
})

/** Reads and writes of one preference section. */
export interface TuiPreferenceStore {
  /** The stored preferences, over this deployment's config, over the defaults. */
  current(): TuiPreferences
  /**
   * Persist one changed preference. Fire-and-forget: the value is already live
   * on screen, so nothing waits on a settings write to acknowledge it, and a
   * rejected write is reported as a warning — what failed is the durability of
   * the choice, not the choice.
   * @param patch - the fields that changed.
   */
  save(patch: Partial<TuiPreferences>): void
}

/**
 * The part of the `settings` service this module uses.
 *
 * Namespace-addressed rather than scope-addressed on purpose: this terminal
 * mounts a fresh chat per session handoff, and only the first mount can own the
 * registration, so later mounts read and write the namespace the first one
 * registered.
 */
interface SettingsProviderLike {
  register(namespace: string, schema: unknown, options?: { base?: object }): unknown
  get(namespace: string): unknown
  update(namespace: string, patch: object): Promise<void>
}

/** Shape-check one stored section, field by field, over a fallback. */
function normalize(value: unknown, fallback: TuiPreferences): TuiPreferences {
  if (typeof value !== 'object' || value === null) return fallback
  const section = value as Partial<Record<keyof TuiPreferences, unknown>>
  const toolCards = section.toolCards
  const theme = section.theme
  return {
    showReasoning: typeof section.showReasoning === 'boolean' ? section.showReasoning : fallback.showReasoning,
    toolCards: toolCards === 'collapsed' || toolCards === 'expanded' || toolCards === 'hidden'
      ? toolCards
      : fallback.toolCards,
    theme: typeof theme === 'string' && isThemePreference(theme) ? theme : fallback.theme,
  }
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
export function openTuiPreferences(
  ctx: Context,
  base: Partial<TuiPreferences>,
  reportError: (message: string) => void,
): TuiPreferenceStore {
  // Schema defaults with the deployment's config over them: what a document
  // with no `tui` section resolves to, and what every shape check falls back on.
  const defaults: TuiPreferences = { ...TUI_PREFERENCES_SCHEMA(), ...base }
  const provider = ctx.get('settings') as SettingsProviderLike | undefined
  if (provider === undefined || typeof provider.register !== 'function') {
    let memory = defaults
    return {
      current: () => memory,
      save: (patch) => { memory = { ...memory, ...patch } },
    }
  }
  // Never throws: a provider out of contract must not take the terminal down
  // over a preference, and an unregistered namespace reads as `undefined`,
  // which is the same answer as "no section stored".
  const resolved = (): unknown => {
    try {
      return provider.get(TUI_SETTINGS_NAMESPACE)
    } catch {
      /* v8 ignore next -- only an out-of-contract provider reaches here. */
      return undefined
    }
  }
  try {
    provider.register(TUI_SETTINGS_NAMESPACE, TUI_PREFERENCES_SCHEMA, { base })
  } catch (error) {
    // Two ways here. A second mount in this process — a session handoff builds
    // a fresh chat over the same context — finds the first mount's registration
    // still owning the namespace, and every read and write below still
    // addresses it, so that one is silent. A stored section this schema refuses
    // leaves the namespace unregistered instead: reads fall back to the
    // defaults and writes reject, which is worth the sentence. An unregistered
    // namespace is what tells the two apart.
    if (resolved() === undefined) {
      reportError(`Stored terminal settings were refused; this session uses the defaults: ${errorChain(error)}`)
    }
  }
  const read = (): TuiPreferences => normalize(resolved(), defaults)
  return {
    current: read,
    save: (patch) => {
      void Promise.resolve()
        .then(async () => { await provider.update(TUI_SETTINGS_NAMESPACE, patch) })
        .catch((error: unknown) => {
          reportError(`Setting could not be saved: ${errorChain(error)}`)
        })
    },
  }
}

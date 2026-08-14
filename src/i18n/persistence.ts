/**
 * Where `/lang` keeps the language it was told, so the next process starts on
 * it.
 *
 * Two stores, in this order:
 *
 * 1. **The harness settings document.** The Host owns a `locale` namespace with
 *    one `preference` field (`@deepseek-ai/dsh-client-locale`), which is where
 *    the web client's language switch already writes. When a settings provider
 *    is mounted AND that namespace is registered, `/lang` writes there and the
 *    two front doors agree about the language without either of them owning it.
 * 2. **This bundle's own file**, `<dsh home>/tui-locale.json`. A terminal-only
 *    deployment mounts neither the settings provider nor the locale plugin, and
 *    a preference that survives only until exit is not a preference.
 *
 * The settings namespace is deliberately never registered from here. It belongs
 * to the plugin that declares its schema; registering it as a side effect of
 * opening a terminal would take the namespace away from its owner on the next
 * mount and fail loud when both are present.
 * @module @deepseek-ai/dsh-tui/i18n/persistence
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { isLocaleId, type LocaleId } from './index.ts'

/** Settings namespace the Host's locale plugin owns; shared with the web client. */
export const LOCALE_SETTINGS_NAMESPACE = 'locale'

/** Field inside that namespace carrying an explicit selection. */
export const LOCALE_PREFERENCE_FIELD = 'preference'

/** Basename of the fallback document, under the harness home. */
export const LOCALE_FILE_NAME = 'tui-locale.json'

/**
 * The part of `ctx.settings` this bundle reads.
 *
 * Structural rather than the service class: `@deepseek-ai/dsh-settings` is not
 * one of this bundle's dependencies (a deployment can run with no settings seam
 * at all), so the service is resolved through the non-throwing accessor and
 * shape-checked rather than typed.
 */
interface SettingsReader {
  /** Resolved value of one namespace, or `undefined` while unregistered. */
  get?: (ns: string) => unknown
  /** Merge a patch into one namespace's user layer and persist it. */
  update?: (ns: string, patch: object) => Promise<void>
}

/** Where a locale preference is read from and written back to. */
export interface LocaleStore {
  /** Which backing store answered; `/lang` says so when a write fails. */
  readonly origin: 'settings' | 'file'
  /**
   * The stored preference, or `undefined` when nothing was ever chosen.
   *
   * Synchronous because it runs once, before the first frame: the language the
   * banner and the header paint in is decided before they are built, and an
   * awaited read would paint English first and repaint.
   */
  load(): LocaleId | undefined
  /**
   * Durably store a preference.
   * @param locale - the locale the user just chose.
   */
  save(locale: LocaleId): Promise<void>
}

/**
 * Absolute path of the fallback document.
 *
 * `$DSH_HOME` then `~/.dsh`, the harness's own precedence, so a deployment that
 * relocated its home keeps every user file in one place. A blank override is
 * treated as unset rather than resolving to the working directory.
 * @returns the absolute document path.
 */
export function localeFilePath(): string {
  const configured = process.env['DSH_HOME']?.trim()
  const home = configured === undefined || configured === '' ? join(homedir(), '.dsh') : configured
  return resolve(join(home, LOCALE_FILE_NAME))
}

/**
 * Read and write the preference as one small JSON document.
 *
 * Failures are swallowed on the read side and reported on the write side: a
 * home directory that cannot be read is a terminal that starts in English,
 * which is recoverable, while a `/lang` that silently failed to save would
 * promise something it did not do.
 * @param path - absolute document path.
 * @returns the file-backed store.
 */
export function fileLocaleStore(path: string): LocaleStore {
  return {
    origin: 'file',
    load: () => {
      let raw: string
      try {
        raw = readFileSync(path, 'utf8')
      } catch (_neverWrittenOrUnreadable) {
        return undefined
      }
      try {
        const parsed: unknown = JSON.parse(raw)
        if (typeof parsed !== 'object' || parsed === null) return undefined
        const value = (parsed as Record<string, unknown>)['locale']
        return isLocaleId(value) ? value : undefined
      } catch (_malformedDocument) {
        // A hand-edited document that no longer parses is not worth failing a
        // terminal over; the next `/lang` rewrites it.
        return undefined
      }
    },
    save: async (locale) => {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, `${JSON.stringify({ locale }, undefined, 2)}\n`, 'utf8')
      await Promise.resolve()
    },
  }
}

/**
 * Read and write the preference through the Host's `locale` settings namespace.
 * @param settings - the shape-checked settings service.
 * @returns the settings-backed store.
 */
function settingsLocaleStore(settings: Required<SettingsReader>): LocaleStore {
  return {
    origin: 'settings',
    load: () => {
      const section = settings.get(LOCALE_SETTINGS_NAMESPACE)
      if (typeof section !== 'object' || section === null) return undefined
      const value = (section as Record<string, unknown>)[LOCALE_PREFERENCE_FIELD]
      return isLocaleId(value) ? value : undefined
    },
    // Called as a member so the service keeps its `this`.
    save: async (locale) => { await settings.update(LOCALE_SETTINGS_NAMESPACE, { [LOCALE_PREFERENCE_FIELD]: locale }) },
  }
}

/**
 * Pick the store this deployment can actually keep a preference in.
 *
 * The settings service wins only when the `locale` namespace is registered —
 * `get` answers `undefined` for a namespace nobody owns, and `update` on one
 * throws — so a settings provider mounted without the locale plugin still lands
 * on the file rather than on a write that always fails.
 * @param ctx - the runner context.
 * @returns the store `/lang` reads and writes.
 */
export function resolveLocaleStore(ctx: Context): LocaleStore {
  const settings = ctx.get('settings') as SettingsReader | undefined
  if (typeof settings?.get === 'function' && typeof settings.update === 'function'
    && settings.get(LOCALE_SETTINGS_NAMESPACE) !== undefined) {
    return settingsLocaleStore(settings as Required<SettingsReader>)
  }
  return fileLocaleStore(localeFilePath())
}

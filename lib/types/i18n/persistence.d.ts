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
import type { Context } from '@deepseek-ai/cordis';
import { type LocaleId } from './index.ts';
/** Settings namespace the Host's locale plugin owns; shared with the web client. */
export declare const LOCALE_SETTINGS_NAMESPACE = "locale";
/** Field inside that namespace carrying an explicit selection. */
export declare const LOCALE_PREFERENCE_FIELD = "preference";
/** Basename of the fallback document, under the harness home. */
export declare const LOCALE_FILE_NAME = "tui-locale.json";
/** Where a locale preference is read from and written back to. */
export interface LocaleStore {
    /** Which backing store answered; `/lang` says so when a write fails. */
    readonly origin: 'settings' | 'file';
    /**
     * The stored preference, or `undefined` when nothing was ever chosen.
     *
     * Synchronous because it runs once, before the first frame: the language the
     * banner and the header paint in is decided before they are built, and an
     * awaited read would paint English first and repaint.
     */
    load(): LocaleId | undefined;
    /**
     * Durably store a preference.
     * @param locale - the locale the user just chose.
     */
    save(locale: LocaleId): Promise<void>;
}
/**
 * Absolute path of the fallback document.
 *
 * `$DSH_HOME` then `~/.dsh`, the harness's own precedence, so a deployment that
 * relocated its home keeps every user file in one place. A blank override is
 * treated as unset rather than resolving to the working directory.
 * @returns the absolute document path.
 */
export declare function localeFilePath(): string;
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
export declare function fileLocaleStore(path: string): LocaleStore;
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
export declare function resolveLocaleStore(ctx: Context): LocaleStore;

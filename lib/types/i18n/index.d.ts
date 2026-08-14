/**
 * This terminal's message layer: one process-wide locale, two message tables,
 * and a lookup every rendering surface calls at render time.
 *
 * Deliberately tiny and dependency-free. The alternative — a real i18n runtime —
 * buys plural categories and date formats this UI does not have, and costs a
 * runtime dependency in a bundle that ships none.
 *
 * Two rules make locale switching work at all:
 *
 * 1. **Look up late.** {@link t} is called from `render`, from a command
 *    handler, from a getter — never from a module-level `const`, which would
 *    freeze the first locale into the module graph. A string captured at import
 *    time survives `/lang` and lies for the rest of the process.
 * 2. **Repaint after.** {@link setLocale} notifies {@link onLocaleChange}
 *    observers; the TUI's observer is `requestRender`, so a switch redraws every
 *    surface that is already on screen.
 * @module @deepseek-ai/dsh-tui/i18n
 */
import { EN_MESSAGES } from './messages.ts';
export { EN_MESSAGES, ZH_MESSAGES } from './messages.ts';
/** The locales this terminal ships, in the order `/lang` lists them. */
export declare const LOCALE_IDS: readonly ["en", "zh"];
/** One shipped locale id. */
export type LocaleId = typeof LOCALE_IDS[number];
/**
 * Every message this terminal can render, keyed by dotted path.
 *
 * Closed over the English table on purpose: English is the base layer, so a key
 * missing there is a typo the compiler rejects rather than a string that renders
 * as its own key at runtime.
 */
export type MessageKey = keyof typeof EN_MESSAGES;
/** Values substituted into a message's `{name}` placeholders. */
export type MessageParams = Readonly<Record<string, string | number>>;
/** Strip the `.one` half of a plural pair, which is how {@link plural} is keyed. */
type PluralStem<Key> = Key extends `${infer Stem}.one` ? Stem : never;
/** A message keyed as a `.one`/`.other` pair rather than as one string. */
export type PluralKey = PluralStem<MessageKey>;
/**
 * Whether a raw string names a shipped locale, which is what `/lang <value>`
 * and a stored preference both have to decide.
 * @param value - a candidate locale id.
 * @returns true when the value is one this terminal ships.
 */
export declare function isLocaleId(value: unknown): value is LocaleId;
/**
 * The locale every surface is currently rendering in.
 * @returns the active locale id.
 */
export declare function currentLocale(): LocaleId;
/**
 * Switch the locale and notify observers.
 *
 * Notification is skipped when the locale did not move, so re-applying a stored
 * preference at startup costs no repaint.
 *
 * An observer that throws is contained: the locale is already committed by the
 * time they run, and one broken repaint must not leave the rest of the screen
 * on the previous language.
 * @param next - the locale to render in from now on.
 * @returns whether the active locale actually changed.
 */
export declare function setLocale(next: LocaleId): boolean;
/**
 * Observe committed locale changes — in this bundle, to repaint.
 * @param listener - invoked after the active locale changes.
 * @returns the disposer removing this observer.
 */
export declare function onLocaleChange(listener: () => void): () => void;
/**
 * Read one message in the active locale.
 * @param key - the dotted message key.
 * @param params - values for the message's `{name}` placeholders.
 * @param locale - render in this locale instead of the active one; used by the
 *   English constants the docs suite holds the README to.
 * @returns the interpolated message text.
 */
export declare function t(key: MessageKey, params?: MessageParams, locale?: LocaleId): string;
/**
 * Read one count-dependent message.
 *
 * English is the only shipped locale with a plural distinction, and it has
 * exactly two forms, so the pair is `<key>.one` / `<key>.other` rather than a
 * CLDR category set. Chinese fills both halves with the same sentence, which is
 * what "no plural" looks like in a table that has to answer for both.
 *
 * `count` is passed through as `{count}` so a message can name it without the
 * caller repeating itself.
 * @param count - how many things the message is about.
 * @param key - the pair's shared prefix.
 * @param params - values for the message's other placeholders.
 * @returns the interpolated message text for this count.
 */
export declare function plural(count: number, key: PluralKey, params?: MessageParams): string;
/**
 * The language's own name, as `/lang` prints it.
 * @param locale - the locale to name.
 * @returns the endonym, in the active locale's table.
 */
export declare function localeName(locale: LocaleId): string;
/**
 * One command's description in the active locale, falling back to whatever the
 * registry holds.
 *
 * Command descriptions are registered once, in English, because the command
 * registry is a service other front doors read; this terminal translates them
 * on the way to the screen instead. A command registered by another plugin has
 * no key here and keeps its own text.
 * @param name - the registered command name.
 * @param registered - the description the registry carries.
 * @returns the text to show for this command.
 */
export declare function commandDescription(name: string, registered: string): string;

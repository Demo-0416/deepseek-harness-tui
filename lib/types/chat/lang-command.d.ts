/**
 * `/lang` — read or switch the language this terminal renders its own chrome
 * in, and remember the choice for the next process.
 *
 * The command is deliberately synchronous in its visible half: the locale moves
 * before the handler returns, so the confirmation is already printed in the
 * language it announces, and the durable write is fire-and-forget behind it.
 * What a failed write costs is the NEXT session's language, not this one's, so
 * it is reported as a warning rather than as a failed command.
 * @module @deepseek-ai/dsh-tui/chat/lang-command
 */
import type { CommandResult } from '@deepseek-ai/dsh-commands';
import { type LocaleId } from '../i18n/index.ts';
import type { LocaleStore } from '../i18n/persistence.ts';
/** What `/lang` needs from the terminal around it. */
export interface LangCommandDeps {
    /** Where the preference is kept for the next process. */
    readonly store: LocaleStore;
    /**
     * Report a failed durable write. Separate from the command result because it
     * arrives after the handler returned — the switch itself already succeeded.
     */
    readonly reportSaveFailure: (message: string) => void;
}
/**
 * Fold the spellings a user reasonably types into a shipped locale id.
 *
 * Region and script suffixes are dropped (`zh-CN`, `zh_Hans`, `en-US`) because
 * this terminal ships one table per language and refusing `zh-CN` would be
 * refusing the value the surrounding system already calls it.
 * @param raw - the argument as typed.
 * @returns the locale it names, or `undefined` when it names none.
 */
export declare function normalizeLocaleInput(raw: string): LocaleId | undefined;
/**
 * Run one `/lang` invocation.
 *
 * Without an argument it reports the current language and what else is on
 * offer; with one it switches, repaints (through the locale observers), and
 * saves.
 * @param rawInput - the argument text, exactly as typed.
 * @param deps - the store and the warning sink.
 * @returns the command result whose text the caller prints.
 */
export declare function runLangCommand(rawInput: string, deps: LangCommandDeps): CommandResult;

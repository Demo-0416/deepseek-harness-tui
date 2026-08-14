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

import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { errorChain } from '@deepseek-ai/dsh-llm'
import { displayInlineText } from '../components/text.ts'
import {
  currentLocale,
  isLocaleId,
  localeName,
  LOCALE_IDS,
  setLocale,
  t,
  type LocaleId,
} from '../i18n/index.ts'
import type { LocaleStore } from '../i18n/persistence.ts'

/** What `/lang` needs from the terminal around it. */
export interface LangCommandDeps {
  /** Where the preference is kept for the next process. */
  readonly store: LocaleStore
  /**
   * Report a failed durable write. Separate from the command result because it
   * arrives after the handler returned — the switch itself already succeeded.
   */
  readonly reportSaveFailure: (message: string) => void
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
export function normalizeLocaleInput(raw: string): LocaleId | undefined {
  const base = raw.trim().toLowerCase().split(/[-_.]/u)[0] ?? ''
  return isLocaleId(base) ? base : undefined
}

/** The locales `/lang` offers, as one list for the messages that name them. */
function localeOptions(): string {
  return LOCALE_IDS.join(', ')
}

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
export function runLangCommand(rawInput: string, deps: LangCommandDeps): CommandResult {
  const typed = rawInput.trim()
  if (typed === '') {
    const active = currentLocale()
    return {
      kind: 'success',
      text: t('lang.current', { name: localeName(active), id: active, options: localeOptions() }),
    }
  }
  const next = normalizeLocaleInput(typed)
  if (next === undefined) {
    return {
      kind: 'error',
      text: t('lang.unknown', { value: displayInlineText(typed), options: localeOptions() }),
    }
  }
  if (!setLocale(next)) {
    return { kind: 'success', text: t('lang.unchanged', { name: localeName(next), id: next }) }
  }
  // Fire-and-forget, like the model picker's default write: the language is
  // already live, so the screen must not wait on a settings file to acknowledge
  // it, and a rejection is a durability failure rather than a refused switch.
  void deps.store.save(next).catch((error: unknown) => {
    deps.reportSaveFailure(t('lang.saveFailed', { error: errorChain(error) }))
  })
  return { kind: 'success', text: t('lang.switched', { name: localeName(next), id: next }) }
}

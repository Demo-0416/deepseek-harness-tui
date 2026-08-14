/**
 * Unit tests for the message layer: what {@link t} answers, what a partial
 * Chinese table falls back to, what a switch notifies, and where `/lang` keeps
 * the answer between processes.
 *
 * Every test restores the locale it found, because the locale is process-wide
 * by design and the rest of the suite renders its fixtures in English.
 * @module dsh-tui/tests/unit/i18n
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import {
  createTuiTestHarness,
  disposeTuiTestHarness,
  tuiEntryAvailable,
} from '../harness.ts'
import { HeadlessTerminal } from '../headless-terminal.ts'
import {
  commandDescription,
  currentLocale,
  EN_MESSAGES,
  isLocaleId,
  localeName,
  LOCALE_IDS,
  onLocaleChange,
  plural,
  setLocale,
  t,
  ZH_MESSAGES,
} from '../../src/i18n/index.ts'
import {
  fileLocaleStore,
  localeFilePath,
  LOCALE_PREFERENCE_FIELD,
  LOCALE_SETTINGS_NAMESPACE,
  resolveLocaleStore,
  type LocaleStore,
} from '../../src/i18n/persistence.ts'
import { normalizeLocaleInput, runLangCommand } from '../../src/chat/lang-command.ts'
import { langArgumentCompletions } from '../../src/chat/command-completions.ts'

afterEach(() => { setLocale('en') })

/** A store that keeps the preference in memory, so a test never touches a home directory. */
function memoryStore(initial?: 'en' | 'zh'): LocaleStore & { saved: string[] } {
  let stored = initial
  return {
    origin: 'file',
    saved: [],
    load: () => stored,
    save: async function save(this: { saved: string[] }, locale) {
      stored = locale
      this.saved.push(locale)
      await Promise.resolve()
    },
  }
}

describe('message lookup', () => {
  it('answers in the active locale and falls back to English for an untranslated key', () => {
    assert.equal(t('rewind.title'), 'Rewind')
    setLocale('zh')
    assert.equal(t('rewind.empty'), '还没有可以回退到的提问。')
    // Never translated: the key exists in English only, and a fallback is what
    // keeps the row from rendering empty.
    assert.equal(t('status.systemPrompt'), EN_MESSAGES['status.systemPrompt'])
  })

  it('substitutes named parameters and leaves an unfilled placeholder standing', () => {
    assert.equal(
      t('dialog.resume.titleCounted', { position: 2, total: 7 }),
      'Resume session (2 of 7)',
    )
    // A missing parameter is a bug in the caller; the placeholder names it
    // instead of leaving a gap that only reads as a bad sentence.
    assert.equal(t('dialog.resume.titleCounted', { position: 2 }), 'Resume session (2 of {total})')
  })

  it('renders one message in an explicit locale without moving the active one', () => {
    assert.equal(t('rewind.title', undefined, 'zh'), 'Rewind')
    assert.equal(t('rewind.empty', undefined, 'zh'), '还没有可以回退到的提问。')
    assert.equal(currentLocale(), 'en')
  })

  it('picks the plural form English needs and the single form Chinese has', () => {
    assert.equal(plural(1, 'plugins.count', { visible: 1, total: 1, active: 1 }), '1/1 entry · 1 active')
    assert.equal(plural(4, 'plugins.count', { visible: 2, total: 4, active: 3 }), '2/4 entries · 3 active')
    // Zero is "other" in English, which is the form that reads correctly.
    assert.equal(plural(0, 'plugins.count', { visible: 0, total: 0, active: 0 }), '0/0 entries · 0 active')
    setLocale('zh')
    assert.equal(plural(1, 'plugins.count', { visible: 1, total: 1, active: 1 }), '1/1 个条目 · 1 个运行中')
  })

  it('translates only the commands this bundle registers', () => {
    setLocale('zh')
    assert.equal(commandDescription('help', 'Show keyboard shortcuts and commands'), '显示快捷键与命令列表')
    // Another plugin's command has no key here and keeps its own text.
    assert.equal(commandDescription('todo', 'Manage the todo list'), 'Manage the todo list')
  })

  it('names every shipped locale in its own language', () => {
    assert.deepEqual([...LOCALE_IDS], ['en', 'zh'])
    assert.equal(localeName('zh'), '中文')
    setLocale('zh')
    assert.equal(localeName('en'), 'English')
  })

  it('accepts only shipped locale ids', () => {
    assert.equal(isLocaleId('zh'), true)
    assert.equal(isLocaleId('fr'), false)
    assert.equal(isLocaleId(undefined), false)
  })

  it('keeps the Chinese table inside the English key space', () => {
    const unknown = Object.keys(ZH_MESSAGES).filter(key => !(key in EN_MESSAGES))
    assert.deepEqual(unknown, [], 'every zh key answers an en key')
  })
})

describe('locale switching', () => {
  it('notifies observers once per committed change and not on a no-op', () => {
    const seen: string[] = []
    const dispose = onLocaleChange(() => { seen.push(currentLocale()) })
    assert.equal(setLocale('zh'), true)
    assert.equal(setLocale('zh'), false)
    assert.equal(setLocale('en'), true)
    dispose()
    assert.equal(setLocale('zh'), true)
    assert.deepEqual(seen, ['zh', 'en'])
  })

  it('keeps notifying the other observers when one throws', () => {
    let reached = false
    const disposeThrower = onLocaleChange(() => { throw new Error('observer failed') })
    const disposeReader = onLocaleChange(() => { reached = true })
    setLocale('zh')
    disposeThrower()
    disposeReader()
    assert.equal(reached, true)
    assert.equal(currentLocale(), 'zh')
  })
})

describe('/lang', () => {
  it('reports the current language and the alternatives without an argument', () => {
    const result = runLangCommand('', { store: memoryStore(), reportSaveFailure: () => {} })
    assert.equal(result.kind, 'success')
    assert.equal(result.text, 'Language: English (en). Available: en, zh.')
    assert.equal(currentLocale(), 'en')
  })

  it('switches, confirms in the new language, and persists the choice', async () => {
    const store = memoryStore()
    const result = runLangCommand(' ZH ', { store, reportSaveFailure: () => {} })
    assert.equal(result.kind, 'success')
    assert.equal(result.text, '语言已切换为 中文（zh）。')
    assert.equal(currentLocale(), 'zh')
    await Promise.resolve()
    assert.deepEqual(store.saved, ['zh'])
    assert.equal(store.load(), 'zh')
  })

  it('says so rather than rewriting the file when the language did not move', () => {
    const store = memoryStore()
    const result = runLangCommand('en', { store, reportSaveFailure: () => {} })
    assert.equal(result.text, 'Language is already English (en).')
    assert.deepEqual(store.saved, [])
  })

  it('refuses a language it does not ship', () => {
    const result = runLangCommand('fr', { store: memoryStore(), reportSaveFailure: () => {} })
    assert.equal(result.kind, 'error')
    assert.equal(result.text, 'Unknown language "fr". Available: en, zh.')
    assert.equal(currentLocale(), 'en')
  })

  it('reports a failed write as a warning, after the switch it did not undo', async () => {
    const failures: string[] = []
    const store: LocaleStore = {
      origin: 'file',
      load: () => undefined,
      save: () => Promise.reject(new Error('read-only home')),
    }
    const result = runLangCommand('zh', { store, reportSaveFailure: message => { failures.push(message) } })
    assert.equal(result.kind, 'success')
    assert.equal(currentLocale(), 'zh')
    await Promise.resolve()
    await Promise.resolve()
    assert.equal(failures.length, 1)
    assert.match(failures[0] ?? '', /read-only home/u)
  })

  it('folds region suffixes onto the language they name', () => {
    assert.equal(normalizeLocaleInput('zh-CN'), 'zh')
    assert.equal(normalizeLocaleInput('en_US'), 'en')
    assert.equal(normalizeLocaleInput('zh-Hans'), 'zh')
    assert.equal(normalizeLocaleInput('de'), undefined)
  })

  it('offers both locales in the argument menu and marks the active one', () => {
    const items = langArgumentCompletions('') ?? []
    assert.deepEqual(items.map(item => item.value), ['en', 'zh'])
    assert.equal(items[0]?.description, 'English · current')
    assert.equal(items[1]?.description, '中文')
    assert.deepEqual((langArgumentCompletions('z') ?? []).map(item => item.value), ['zh'])
  })
})

describe('locale persistence', () => {
  it('round-trips the preference through the fallback document', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-tui-locale-'))
    try {
      const path = join(dir, 'nested', 'tui-locale.json')
      const store = fileLocaleStore(path)
      assert.equal(store.load(), undefined, 'nothing chosen yet reads as nothing')
      await store.save('zh')
      assert.equal(store.load(), 'zh')
      assert.equal(fileLocaleStore(path).load(), 'zh', 'a fresh process reads what the last one wrote')
      assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { locale: 'zh' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('ignores a document that is malformed or names an unknown language', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-tui-locale-'))
    try {
      const path = join(dir, 'tui-locale.json')
      await writeFile(path, '{ not json', 'utf8')
      assert.equal(fileLocaleStore(path).load(), undefined)
      await writeFile(path, JSON.stringify({ locale: 'fr' }), 'utf8')
      assert.equal(fileLocaleStore(path).load(), undefined)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('keeps the fallback document under the configured harness home', () => {
    const previous = process.env['DSH_HOME']
    try {
      process.env['DSH_HOME'] = join(tmpdir(), 'dsh-home-fixture')
      assert.equal(localeFilePath(), join(tmpdir(), 'dsh-home-fixture', 'tui-locale.json'))
      process.env['DSH_HOME'] = '   '
      assert.match(localeFilePath(), /\.dsh[/\\]tui-locale\.json$/u)
    } finally {
      if (previous === undefined) delete process.env['DSH_HOME']
      else process.env['DSH_HOME'] = previous
    }
  })

  it('writes through the Host locale namespace when one is registered', async () => {
    const patches: object[] = []
    const ctx = {
      get: (name: string) => name !== 'settings' ? undefined : {
        get: (ns: string) => ns === LOCALE_SETTINGS_NAMESPACE ? { [LOCALE_PREFERENCE_FIELD]: 'zh' } : undefined,
        update: async (ns: string, patch: object) => {
          assert.equal(ns, LOCALE_SETTINGS_NAMESPACE)
          patches.push(patch)
          await Promise.resolve()
        },
      },
    }
    const store = resolveLocaleStore(ctx as never)
    assert.equal(store.origin, 'settings')
    assert.equal(store.load(), 'zh')
    await store.save('en')
    assert.deepEqual(patches, [{ [LOCALE_PREFERENCE_FIELD]: 'en' }])
  })

  it('falls back to the document when the settings seam cannot answer for the namespace', () => {
    const withoutService = resolveLocaleStore({ get: () => undefined } as never)
    assert.equal(withoutService.origin, 'file')
    // A settings provider is mounted, but nobody registered `locale`: writing
    // there would throw on every `/lang`.
    const unregistered = resolveLocaleStore({
      get: (name: string) => name !== 'settings' ? undefined : {
        get: () => undefined,
        update: () => Promise.resolve(),
      },
    } as never)
    assert.equal(unregistered.origin, 'file')
  })
})

/** `src/index.ts` is landed by a separate port; without it the mounted suite cannot run. */
const skipWithoutEntry = await tuiEntryAvailable()
  ? false
  : 'requires src/index.ts to export createTuiChat(ctx, config, runtime)'

describe('a mounted terminal answers /lang', { skip: skipWithoutEntry }, () => {
  /** A command result and the repaint behind it settle across a few awaits. */
  const SETTLE_MS = 60
  const ESC = '\x1b'

  it('switches the language of the surfaces that are still to be opened', async () => {
    // The command persists, so the write is pointed at a temporary home rather
    // than at the developer's own.
    const home = await mkdtemp(join(tmpdir(), 'dsh-tui-home-'))
    const previousHome = process.env['DSH_HOME']
    process.env['DSH_HOME'] = home
    const terminal = new HeadlessTerminal(120, 40)
    const before = terminal.frames
    const harness = await createTuiTestHarness(terminal, () => {}, {
      config: { title: 'DSH i18n', welcome: 'ready.', theme: { color: false } },
    })
    await terminal.waitForFrame(before)
    try {
      const execution = await harness.ctx.commands.execute(harness.agent, '/lang zh', AbortSignal.timeout(5_000))
      assert.equal(execution?.result.text, '语言已切换为 中文（zh）。')
      await delay(SETTLE_MS)
      await harness.ctx.commands.execute(harness.agent, '/hotkeys', AbortSignal.timeout(5_000))
      await delay(SETTLE_MS)
      const frame = terminal.text().replace(/\s+/gu, ' ')
      assert.match(frame, /Enter 发送/u, `the shortcut panel is Chinese now:\n${frame}`)
      assert.match(frame, /esc 关闭/u)
      terminal.send(ESC)
      await delay(SETTLE_MS)
      assert.equal(fileLocaleStore(join(home, 'tui-locale.json')).load(), 'zh')
    } finally {
      await disposeTuiTestHarness(harness)
      await terminal.dispose()
      if (previousHome === undefined) delete process.env['DSH_HOME']
      else process.env['DSH_HOME'] = previousHome
      await rm(home, { recursive: true, force: true })
    }
  })
})

/**
 * The README as an interface, checked against the code it describes.
 *
 * Documentation drifts silently: nothing fails when a key is rebound, a command
 * is renamed, or a config field is added, so the file that tells a user what
 * this terminal does is the one artifact in the repository with no way of being
 * wrong out loud. These cases give it one — every key, flag, command, and config
 * key the README states is read back out of it and matched against the registry,
 * the parser, the command runtime, and the schema that own the truth.
 *
 * The tables are parsed rather than compared whole on purpose: the prose around
 * them is free to change, and a case that broke on wording would be turned off
 * within a week.
 * @module dsh-tui/tests/unit/docs
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { KeybindingsManager } from '@earendil-works/pi-tui'
import { Config } from '../../src/config.ts'
import { CUSTOM_ANSWER_HINT } from '../../src/components/dialogs.ts'
import {
  APP_KEYBINDINGS,
  KEYBINDINGS,
  formatKeyId,
  keybindingCollisions,
  type AppKeybinding,
} from '../../src/keybindings.ts'
import { startupRefusal } from '../../src/index.ts'
import type { TuiStartupValues } from '../../src/startup.ts'
import { tuiCommand } from '../../src/startup.ts'
import {
  createTuiTestHarness,
  disposeTuiTestHarness,
  tuiEntryAvailable,
  type TuiHarnessOptions,
} from '../harness.ts'
import { HeadlessTerminal } from '../headless-terminal.ts'

const README = readFileSync(new URL('../../README.md', import.meta.url), 'utf8')

/** `src/index.ts` is landed by a separate port; without it the end-to-end suite cannot run. */
const entryAvailable = await tuiEntryAvailable()
const skipWithoutEntry = entryAvailable
  ? false
  : 'requires src/index.ts to export createTuiChat(ctx, config, runtime)'

/**
 * Every table row under one heading, as its cells.
 *
 * Cells are split on unescaped pipes only: a command's own `[a|b|c]` argument
 * list is written `\|` inside a cell, and a plain split would cut one argument
 * list into three columns.
 * @param heading - The heading text to read under, without its `#` marks.
 * @returns One entry per body row; the header and separator rows are dropped.
 */
function tableUnder(heading: string): string[][] {
  const lines = README.split('\n')
  const start = lines.findIndex(line => line.startsWith('#') && line.replace(/^#+\s*/u, '') === heading)
  assert.notEqual(start, -1, `README has a "${heading}" section`)
  const rows: string[][] = []
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('#')) break
    if (!line.startsWith('|')) continue
    if (/^\|[\s:|-]+\|$/u.test(line)) continue
    const cells = line.split(/(?<!\\)\|/u).slice(1, -1).map(cell => cell.replaceAll('\\|', '|').trim())
    rows.push(cells)
  }
  assert.ok(rows.length > 1, `the "${heading}" section has a table`)
  // The header row is the first one; every table here is keyed by its first column.
  return rows.slice(1)
}

/** Every long flag named in one cell, as the parser spells them. */
function longFlags(text: string): string[] {
  return text.match(/--[a-z][a-z-]*/gu) ?? []
}

/** This bundle's action ids, typed as the keybinding manager takes them. */
const APP_ACTIONS = Object.keys(APP_KEYBINDINGS) as AppKeybinding[]

/** Every action the merged registry knows, pi-tui's own included. */
const ALL_ACTIONS = Object.keys(KEYBINDINGS) as AppKeybinding[]

/** The first column of every body row, which is what each of these tables is keyed by. */
function keysOf(heading: string): string[] {
  return tableUnder(heading).map(row => (row[0] ?? '').replaceAll('`', '').trim())
}

/** A parsed command line with nothing set, for the flags one case at a time. */
function startup(overrides: Partial<TuiStartupValues> = {}): TuiStartupValues {
  return {
    model: undefined,
    preset: undefined,
    resume: undefined,
    continueLatest: false,
    print: undefined,
    initialPrompt: undefined,
    ...overrides,
  }
}

describe('README key table', () => {
  it('names the key every action is actually bound to', () => {
    // Read through a manager rather than out of the constant, because that is
    // where the running terminal reads them: a default that moves moves here.
    const manager = new KeybindingsManager(KEYBINDINGS, {})
    const documented = new Set(keysOf('Keys').flatMap(cell => cell.split(' / ')))
    for (const action of APP_ACTIONS) {
      const keys = manager.getKeys(action).map(key => formatKeyId(key))
      assert.ok(keys.length > 0, `${action} still has a default key`)
      for (const key of keys) {
        assert.ok(documented.has(key), `README documents ${key} (${action}); it documents ${[...documented].join(', ')}`)
      }
    }
  })

  it('claims no key that nothing answers', () => {
    const manager = new KeybindingsManager(KEYBINDINGS, {})
    const bound = new Set(ALL_ACTIONS.flatMap(action => manager.getKeys(action).map(key => formatKeyId(key))))
    // Keys with no action id behind them: the ones the composer reads as text
    // (`@`, `/`, `?`), the newline forms pi-tui's editor recognises directly,
    // Ctrl+C — deliberately unbindable, so it can never be taken away — and the
    // debug key pi-tui dispatches ahead of focus.
    const unbindable = new Set(['@', '/', '?', 'Ctrl+C', 'Ctrl+J', 'Alt+Enter', 'Shift+Ctrl+D'])
    for (const cell of keysOf('Keys')) {
      for (const key of cell.split(' / ')) {
        assert.ok(bound.has(key) || unbindable.has(key), `README's "${key}" is a key something answers`)
      }
    }
  })

  it('takes no key off pi-tui that the editor still needs', () => {
    // The app's input listener runs before the focused component and answers
    // `consume: true`, so an `app.*` default that lands on a pi-tui default
    // deletes the editor's action outright — silently, since
    // `KeybindingsManager.getConflicts()` only compares user overrides.
    const manager = new KeybindingsManager(KEYBINDINGS, {})
    assert.deepEqual(keybindingCollisions(manager), [])
  })

  it('reports a deployment that rebinds an action onto an editor key', () => {
    const manager = new KeybindingsManager(KEYBINDINGS, { 'app.todos.toggle': 'ctrl+y' })
    assert.deepEqual(keybindingCollisions(manager), [
      { key: 'ctrl+y', action: 'app.todos.toggle', shadowed: ['tui.editor.yank'] },
    ])
  })
})

describe('README usage table', () => {
  it('lists exactly the flags the command line parses', () => {
    // `--help` is declared through `.helpOption()`, which commander keeps out of
    // `options`; it is a flag the parser answers all the same.
    const declared = ['--help', ...tuiCommand().options
      .map(option => option.long)
      .filter((long): long is string => long !== undefined)]
    const documented = keysOf('Usage')
    for (const long of declared) {
      assert.ok(
        documented.some(cell => longFlags(cell).includes(long)),
        `README documents ${long}; it documents ${documented.join(' / ')}`,
      )
    }
    for (const cell of documented) {
      for (const long of longFlags(cell)) {
        assert.ok(declared.includes(long), `README's ${long} is a flag the parser declares`)
      }
    }
  })

  it('serves --print rather than refusing it, and refuses only an empty task', () => {
    // The flag runs a task without a UI; only a task that is not a task is
    // refused, and it is refused on the command line rather than by sending the
    // model an empty turn and printing a blank line.
    assert.equal(startupRefusal(startup({ print: 'run the tests' })), undefined)
    assert.equal(startupRefusal(startup({ initialPrompt: 'fix the tests' })), undefined)
    assert.match(startupRefusal(startup({ print: '   ' })) ?? '', /--print needs a task/u)
    // Two tasks in one command line: the positional prompt only ever reaches
    // the interactive path, which `--print` does not open.
    assert.match(
      startupRefusal(startup({ print: 'run the tests', initialPrompt: 'fix them' })) ?? '',
      /would be ignored/u,
    )
    const printRow = tableUnder('Usage').find(row => (row[0] ?? '').includes('--print'))
    assert.ok(printRow !== undefined, 'the README documents --print')
    assert.doesNotMatch(printRow[1] ?? '', /not implemented/u)
  })
})

describe('README configuration table', () => {
  it('documents every key the schema accepts', () => {
    const fields = Config.dict ?? {}
    const theme = fields['theme']
    assert.ok(theme !== undefined, 'the schema still groups the theme settings')
    const documented = new Set(keysOf('Configuration'))
    for (const key of Object.keys(fields)) {
      if (key === 'theme') continue
      assert.ok(documented.has(key), `README documents "${key}"`)
    }
    for (const key of Object.keys(theme.dict ?? {})) {
      assert.ok(documented.has(`theme.${key}`), `README documents "theme.${key}"`)
    }
  })

  it('claims no key the schema would drop', () => {
    const fields = Config.dict ?? {}
    const accepted = new Set([
      ...Object.keys(fields),
      ...Object.keys(fields['theme']?.dict ?? {}).map(key => `theme.${key}`),
    ])
    for (const key of keysOf('Configuration')) {
      assert.ok(accepted.has(key), `README's "${key}" is a key the schema accepts`)
    }
  })
})

describe('Config.welcome', () => {
  it('is optional, because its absence is what starts the banner sweep', () => {
    // The JSDoc promises a behavior for "no welcome key at all"; a schema that
    // required the field, or defaulted it to the empty string, would delete that
    // behavior and leave the promise standing.
    assert.equal('welcome' in Config({}), false)
    assert.equal(Config({ welcome: '' }).welcome, '')
    assert.equal(Config({ welcome: 'ready.' }).welcome, 'ready.')
  })

  it('leaves the experimental commands off unless a deployment asks for them', () => {
    assert.equal(Config({}).experimentalCommands, false)
    assert.equal(Config({ experimentalCommands: true }).experimentalCommands, true)
  })
})

describe('one shortcut table, three surfaces', { skip: skipWithoutEntry }, () => {
  /** A panel answer settles across a few awaits; outwait it. */
  const SETTLE_MS = 60
  const ESC = '\x1b'

  /** `TuiController.submit` is the typed-line path; the harness handle only declares disposal. */
  interface SubmitHandle {
    submit(text: string): void
  }

  /**
   * What `/hotkeys`, `/help`, and `?` each put on screen, from one session.
   *
   * All three read the same generated table, so the only way to see that they
   * still do is to open all three and compare what a user would read. Each
   * surface is dismissed before the next opens, because a panel owns the
   * keyboard while it is up.
   * @param config - deployment settings under test, such as a rebound key.
   * @returns the frame each surface produced, whitespace collapsed.
   */
  async function shortcutSurfaces(config: TuiHarnessOptions['config'] = {}): Promise<Record<string, string>> {
    const terminal = new HeadlessTerminal(120, 40)
    const before = terminal.frames
    const harness = await createTuiTestHarness(terminal, () => {}, {
      config: { title: 'DSH docs', welcome: 'ready.', ...config, theme: { color: false } },
    })
    await terminal.waitForFrame(before)
    const submit = harness.controller as unknown as SubmitHandle
    const read = async (open: () => void): Promise<string> => {
      open()
      await delay(SETTLE_MS)
      const text = terminal.text().replace(/\s+/gu, ' ')
      terminal.send(ESC)
      await delay(SETTLE_MS)
      return text
    }
    try {
      return {
        '/hotkeys': await read(() => { submit.submit('/hotkeys') }),
        '/help': await read(() => { submit.submit('/help') }),
        '?': await read(() => { terminal.send('?') }),
      }
    } finally {
      await disposeTuiTestHarness(harness)
      await terminal.dispose()
    }
  }

  it('prints the same keys on all three', async () => {
    const surfaces = await shortcutSurfaces()
    const manager = new KeybindingsManager(KEYBINDINGS, {})
    for (const [surface, text] of Object.entries(surfaces)) {
      for (const action of APP_ACTIONS) {
        for (const key of manager.getKeys(action).map(id => formatKeyId(id))) {
          assert.ok(text.includes(key), `${surface} names ${key} (${action}):\n${text}`)
        }
      }
    }
  })

  it('names the question dialog\'s own two keys the way the dialog names them', async () => {
    // `c` belongs to no registry action, so the case above cannot see it: the
    // key is bound inside the question dialog and spelled out by hand in four
    // places. Three of them read one constant; this holds the fourth, the
    // README, to the same words, which is what "one shortcut table" has to mean
    // for a key the registry does not own.
    const surfaces = await shortcutSurfaces()
    for (const [surface, text] of Object.entries(surfaces)) {
      assert.ok(text.includes(CUSTOM_ANSWER_HINT), `${surface} names ${CUSTOM_ANSWER_HINT}:\n${text}`)
    }
    const questionRow = tableUnder('While a surface holds the keyboard')
      .find(row => (row[0] ?? '') === 'Question')
    assert.ok(questionRow !== undefined, 'the README documents the question surface')
    assert.ok(
      (questionRow[1] ?? '').includes(CUSTOM_ANSWER_HINT),
      `the README's question row names "${CUSTOM_ANSWER_HINT}": ${questionRow[1] ?? ''}`,
    )
  })

  it('renames a rebound key on all three at once', async () => {
    // The table is generated from the installed manager for exactly this case:
    // a help page that kept naming the default after a deployment moved it is
    // worse than no help page.
    const surfaces = await shortcutSurfaces({ keybindings: { 'app.history.search': 'ctrl+g' } })
    for (const [surface, text] of Object.entries(surfaces)) {
      assert.ok(text.includes('Ctrl+G'), `${surface} names the rebound key:\n${text}`)
      assert.ok(!text.includes('Ctrl+R'), `${surface} no longer names the default:\n${text}`)
    }
  })
})

describe('README command table', { skip: skipWithoutEntry }, () => {
  /** Command names the README's table states, `/skill:<name>` excluded: it is a family, not a command. */
  function documentedCommands(): string[] {
    return tableUnder('Commands')
      .flatMap(row => (row[0] ?? '').match(/\/[a-z][a-z-]*/gu) ?? [])
      .map(name => name.slice(1))
      .filter(name => name !== 'skill')
      .sort()
  }

  /** The names one mounted terminal actually registers. */
  async function registeredCommands(options: TuiHarnessOptions = {}): Promise<string[]> {
    const terminal = new HeadlessTerminal(96, 32)
    const before = terminal.frames
    const harness = await createTuiTestHarness(terminal, () => {}, {
      ...options,
      config: { title: 'DSH docs', welcome: 'ready.', ...options.config, theme: { color: false } },
    })
    await terminal.waitForFrame(before)
    try {
      return harness.ctx.commands.list(harness.agent).map(command => command.name).sort()
    } finally {
      await disposeTuiTestHarness(harness)
      await terminal.dispose()
    }
  }

  it('lists exactly what a developer session registers', async () => {
    const registered = await registeredCommands({ config: { experimentalCommands: true } })
    assert.deepEqual(documentedCommands(), registered)
  })

  it('marks /reload as the one command a plain session does not have', async () => {
    const registered = await registeredCommands()
    assert.ok(!registered.includes('reload'), `a default session has no /reload: ${registered.join(', ')}`)
    assert.deepEqual(documentedCommands().filter(name => name !== 'reload'), registered)
    const reloadRow = tableUnder('Commands').find(row => (row[0] ?? '').includes('/reload'))
    assert.ok(reloadRow !== undefined, 'the README documents /reload')
    assert.match(reloadRow[1] ?? '', /experimentalCommands/u)
  })
})

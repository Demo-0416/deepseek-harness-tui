/**
 * Unit tests for what the editor offers while the user is still typing: which
 * binary answers `@`, which paths the fallback walker is willing to name, and
 * which values each slash command's argument menu contains.
 *
 * The fd probe is exercised against real temporary directories rather than a
 * mocked `fs`, because the question it answers — "is this an executable file on
 * this host" — is exactly the one a mock would define away. Everything else is
 * pure: the completion sources take the store, roster, and catalog as plain
 * suppliers, so a menu can be asserted without mounting a terminal.
 * @module dsh-tui/tests/unit/completion
 */

import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { CombinedAutocompleteProvider } from '@earendil-works/pi-tui'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  createTuiTestHarness,
  disposeTuiTestHarness,
  tuiEntryAvailable,
  type TuiHarness,
} from '../harness.ts'
import { HeadlessTerminal } from '../headless-terminal.ts'
import { resolveFileSearchCommand } from '../../src/chat/fd.ts'
import {
  DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES,
  WorkspaceFileSearch,
} from '../../src/chat/file-autocomplete.ts'
import { ReferenceAutocompleteProvider } from '../../src/chat/autocomplete.ts'
import {
  memoizeListing,
  modelArgumentCompletions,
  presetArgumentCompletions,
  resumeArgumentCompletions,
  themeArgumentCompletions,
  type CompletableModel,
  type CompletableSession,
} from '../../src/chat/command-completions.ts'

/** `src/index.ts` is landed by a separate port; without it the mounted case cannot run. */
const entryAvailable = await tuiEntryAvailable()
const skipWithoutEntry = entryAvailable
  ? false
  : 'requires src/index.ts to export createTuiChat(ctx, config, runtime)'

/** The menu is painted a frame or two after the keystroke; outwait it. */
const SETTLE_MS = 60

/** A workspace or a fake `PATH` entry, removed whatever the assertion did. */
async function withTempDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-tui-completion-'))
  try {
    await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

/** Write one file, creating the directories above it. */
async function writeAt(root: string, path: string, contents = ''): Promise<void> {
  const absolute = join(root, path)
  await mkdir(join(absolute, '..'), { recursive: true })
  await writeFile(absolute, contents)
}

/** Path text of every candidate, in the order the menu would show them. */
async function paths(search: WorkspaceFileSearch, query: string): Promise<string[]> {
  const candidates = await search.list(query, new AbortController().signal)
  return candidates.map(candidate => candidate.path)
}

/** A walker over one workspace with this bundle's shipped defaults. */
function walkerFor(root: string): WorkspaceFileSearch {
  return new WorkspaceFileSearch(root, {
    maxResults: 20,
    maxEntries: 1_000,
    excludedDirectories: [...DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES],
  })
}

describe('gitignore-aware file search discovery', () => {
  it('finds the first known command name on PATH', async () => {
    await withTempDirectory(async (bin) => {
      await writeFile(join(bin, 'fdfind'), '')
      await chmod(join(bin, 'fdfind'), 0o755)
      assert.equal(
        resolveFileSearchCommand(undefined, { PATH: bin }),
        join(bin, 'fdfind'),
        'the Debian package name is the same binary under a name that was already taken',
      )
      await writeFile(join(bin, 'fd'), '')
      await chmod(join(bin, 'fd'), 0o755)
      assert.equal(resolveFileSearchCommand(undefined, { PATH: bin }), join(bin, 'fd'))
    })
  })

  it('ignores a PATH entry that cannot be spawned', async () => {
    await withTempDirectory(async (bin) => {
      // A directory named `fd`, and a file without the executable bit: both
      // are names on PATH, neither is a program.
      await mkdir(join(bin, 'fd'))
      await writeFile(join(bin, 'fdfind'), '')
      await chmod(join(bin, 'fdfind'), 0o644)
      assert.equal(resolveFileSearchCommand(undefined, { PATH: bin }), undefined)
      assert.equal(resolveFileSearchCommand(undefined, {}), undefined, 'an empty environment has no PATH to search')
    })
  })

  it('never runs a workspace-local binary through an empty PATH entry', async () => {
    await withTempDirectory(async (workspace) => {
      await writeFile(join(workspace, 'fd'), '')
      await chmod(join(workspace, 'fd'), 0o755)
      const previous = process.cwd()
      process.chdir(workspace)
      try {
        assert.equal(resolveFileSearchCommand(undefined, { PATH: ':' }), undefined)
      } finally {
        process.chdir(previous)
      }
    })
  })

  it('honors the deployment setting in both directions', async () => {
    await withTempDirectory(async (bin) => {
      await writeFile(join(bin, 'fd'), '')
      await chmod(join(bin, 'fd'), 0o755)
      const env = { PATH: bin }
      assert.equal(resolveFileSearchCommand('', env), undefined, 'the empty string asks for the in-process walker')
      assert.equal(resolveFileSearchCommand('  ', env), undefined)
      assert.equal(resolveFileSearchCommand(join(bin, 'fd'), env), join(bin, 'fd'))
      assert.equal(
        resolveFileSearchCommand(join(bin, 'missing'), env),
        undefined,
        'a pinned path that is wrong stays wrong; falling back would hide the typo',
      )
      assert.equal(resolveFileSearchCommand('fd', env), join(bin, 'fd'), 'a bare name is still a PATH lookup')
    })
  })
})

describe('fallback walker exclusions', () => {
  it('leaves build output and logs out of a query that named neither', async () => {
    await withTempDirectory(async (workspace) => {
      await writeAt(workspace, 'src/report.ts')
      await writeAt(workspace, 'dist/report.js')
      await writeAt(workspace, 'coverage/report.html')
      await writeAt(workspace, 'node_modules/report/index.js')
      await writeAt(workspace, 'report.log')
      const search = walkerFor(workspace)
      try {
        const matched = await paths(search, 'report')
        assert.deepEqual(matched, ['src/report.ts'])
        // The log is reachable the moment the query names an extension, which
        // is the only way a user asks for one on purpose.
        assert.deepEqual(await paths(search, 'report.l'), ['report.log'])
      } finally {
        search.dispose()
      }
    })
  })

  it('applies the same exclusions while listing one directory', async () => {
    await withTempDirectory(async (workspace) => {
      await writeAt(workspace, 'keep.ts')
      await writeAt(workspace, 'debug.log')
      await writeAt(workspace, 'dist/bundle.js')
      await writeAt(workspace, 'src/main.ts')
      const search = walkerFor(workspace)
      try {
        assert.deepEqual(await paths(search, ''), ['src', 'keep.ts'])
        assert.deepEqual(await paths(search, 'debug.'), ['debug.log'])
      } finally {
        search.dispose()
      }
    })
  })
})

describe('one file source at a time', () => {
  it('does not consult the walker when fd answers `@` for the base provider', async () => {
    await withTempDirectory(async (workspace) => {
      await writeAt(workspace, 'notes.md')
      const base = new CombinedAutocompleteProvider([], workspace, null)
      const provider = new ReferenceAutocompleteProvider(
        base,
        // What `index.ts` passes once a host has fd: the walker is built for
        // invalidation bookkeeping but must not add a second copy of every path.
        undefined,
        undefined,
        {} as unknown as Agent,
      )
      const suggestions = await provider.getSuggestions(['@notes'], 0, 6, { signal: new AbortController().signal })
      assert.equal(
        suggestions,
        null,
        'the base provider has no fd path here, so an empty menu proves the walker stayed out of it',
      )
    })
  })

  it('names fd\'s rows the way it names the walker\'s', async () => {
    await withTempDirectory(async (workspace) => {
      const base = new CombinedAutocompleteProvider([], workspace, null)
      // Stands in for the rows fd produces on a host that has it, which no
      // test may depend on being installed.
      base.getSuggestions = () => Promise.resolve({
        items: [
          { value: '@src/', label: 'src/', description: 'src' },
          { value: '@notes.md', label: 'notes.md', description: 'notes.md' },
        ],
        prefix: '@',
      })
      const provider = new ReferenceAutocompleteProvider(base, undefined, undefined, {} as unknown as Agent)
      const suggestions = await provider.getSuggestions(['@'], 0, 1, { signal: new AbortController().signal })
      assert.deepEqual(suggestions?.items.map(item => item.label), ['Folder · src/', 'File · notes.md'])
      assert.deepEqual(suggestions?.items.map(item => item.value), ['@src/', '@notes.md'])
    })
  })
})

/** A catalog of two providers, one of which cannot be reached. */
const routeSource = {
  listProviders: () => [{ id: 'deepseek' }, { id: 'offline' }],
  listModels: (provider: string): Promise<readonly CompletableModel[]> => provider === 'offline'
    ? Promise.reject(new Error('provider is unreachable'))
    : Promise.resolve([
      { id: 'deepseek-chat', name: 'DeepSeek Chat', description: 'general purpose' },
      { id: 'deepseek-reasoner', name: 'deepseek-reasoner' },
    ]),
}

describe('/model argument completions', () => {
  it('offers fully qualified routes and survives a provider that cannot list', async () => {
    const items = await modelArgumentCompletions(routeSource, 'reason', 10)
    assert.deepEqual(items, [{
      value: 'deepseek/deepseek-reasoner',
      label: 'deepseek/deepseek-reasoner',
    }], 'a bare model name still completes to the route the command resolves')
    const all = await modelArgumentCompletions(routeSource, '', 10)
    assert.deepEqual(all?.map(item => item.value), [
      'deepseek/deepseek-chat',
      'deepseek/deepseek-reasoner',
    ])
    assert.equal(all?.[0]?.description, 'general purpose')
  })

  it('stops at the row budget and opens no empty menu', async () => {
    const capped = await modelArgumentCompletions(routeSource, '', 1)
    assert.equal(capped?.length, 1)
    assert.equal(await modelArgumentCompletions(routeSource, 'gpt', 10), null)
  })
})

describe('/theme argument completions', () => {
  it('offers every theme, narrows to what was typed, and opens no empty menu', () => {
    const first = themeArgumentCompletions('')
    assert.deepEqual(first?.map(item => item.value), ['auto', 'light', 'dark', 'no-color'])
    // The sentence beside each value is the selector's own, so the menu and the
    // picker answer the same question the same way.
    assert.equal(first?.[0]?.description, 'Follow the color scheme the terminal reports')
    assert.deepEqual(themeArgumentCompletions('li')?.map(item => item.value), ['light'])
    assert.deepEqual(themeArgumentCompletions('no')?.map(item => item.value), ['no-color'])
    assert.equal(themeArgumentCompletions('solarized'), null)
  })
})

describe('/preset argument completions', () => {
  const source = {
    defaultId: 'general',
    list: () => Promise.resolve([
      { id: 'general', description: 'the default composition' },
      { id: 'review', name: 'Code review' },
      { id: 'broken-one', broken: 'missing agent file' },
    ]),
  }

  it('offers preset ids, the copy verb, and why a preset cannot compose', async () => {
    const items = await presetArgumentCompletions(source, '', 10)
    assert.deepEqual(items?.map(item => item.value), ['copy ', 'general', 'review', 'broken-one'])
    assert.equal(items?.[1]?.description, 'default · the default composition')
    assert.equal(items?.[3]?.description, 'unusable: missing agent file')
  })

  it('completes only the source preset of a copy, and nothing past the grammar', async () => {
    assert.deepEqual(
      (await presetArgumentCompletions(source, 'copy rev', 10))?.map(item => item.value),
      ['copy review'],
    )
    assert.equal(await presetArgumentCompletions(source, 'copy review new-', 10), null)
  })
})

describe('/resume argument completions', () => {
  const sessions: CompletableSession[] = [
    { id: 'older', cwd: '/workspace', createdAt: 1_000, live: false, title: 'Ported the walker' },
    { id: 'newer', cwd: '/workspace', createdAt: 2_000, live: false },
    { id: 'current', cwd: '/workspace', createdAt: 3_000, live: true },
    { id: 'elsewhere', cwd: '/other', createdAt: 4_000, live: false },
    { id: 'homeless', createdAt: 5_000, live: false },
  ]
  const source = {
    list: () => Promise.resolve(sessions),
    currentSessionId: 'current',
    cwd: '/workspace',
  }

  it('lists this workspace\'s resumable sessions, newest first', async () => {
    const items = await resumeArgumentCompletions(source, '', 10)
    assert.deepEqual(items?.map(item => item.value), ['newer', 'older'])
    assert.equal(items?.[1]?.label, 'Ported the walker', 'an in-memory title reads better than an id')
    assert.equal(items?.[0]?.label, 'newer', 'a session with no cached title falls back to what the argument carries')
  })

  it('matches on the id and on the title, and offers nothing outside the scope', async () => {
    assert.deepEqual((await resumeArgumentCompletions(source, 'walker', 10))?.map(item => item.value), ['older'])
    assert.deepEqual((await resumeArgumentCompletions(source, 'new', 10))?.map(item => item.value), ['newer'])
    assert.equal(await resumeArgumentCompletions(source, 'elsewhere', 10), null)
    assert.equal(await resumeArgumentCompletions({ ...source, cwd: undefined }, '', 10), null)
  })
})

describe('the mounted editor asks for argument completions', { skip: skipWithoutEntry }, () => {
  it('opens the menu for a registered command\'s argument slot', async () => {
    const terminal = new HeadlessTerminal(96, 30)
    const before = terminal.frames
    const harness: TuiHarness<HeadlessTerminal, (code: number) => void> = await createTuiTestHarness(
      terminal,
      () => {},
      {
        cwd: '/workspace/project',
        config: { title: 'DSH completion', welcome: 'ready.', theme: { color: false, inputPrompt: 'dsh> ' } },
      },
    )
    await terminal.waitForFrame(before)
    try {
      // Typed byte by byte, because the trigger is a character insertion in a
      // slash context: pasting the whole line or typing the space alone opens
      // nothing, which is the wiring this case exists to catch.
      for (const character of '/theme li') {
        terminal.send(character)
        await delay(SETTLE_MS)
      }
      await terminal.flush()
      const screen = terminal.text()
      // The description, not the token: `light` also appears in the command's
      // own argument hint, so matching it alone would pass against a provider
      // that was never given an argument source.
      assert.ok(
        screen.includes('Always paint the light-background palette'),
        `the argument menu should offer the theme values:\n${screen}`,
      )
    } finally {
      await disposeTuiTestHarness(harness)
      await terminal.dispose()
    }
  })
})

describe('listing reuse across a burst of keystrokes', () => {
  it('reads once per window, re-reads after it, and never keeps a failure', async () => {
    let reads = 0
    let clock = 0
    let failing = true
    const listing = memoizeListing(
      async (key: string): Promise<string> => {
        reads += 1
        if (failing) throw new Error(`no listing for ${key}`)
        return `${key}:${String(reads)}`
      },
      1_000,
      () => clock,
    )
    await assert.rejects(listing('sessions'))
    assert.equal(reads, 1)
    failing = false
    // The rejection was dropped, so the next keystroke tries again rather than
    // re-throwing a failure the user has already moved past.
    assert.equal(await listing('sessions'), 'sessions:2')
    assert.equal(await listing('sessions'), 'sessions:2', 'a burst of typing is one listing')
    assert.equal(await listing('other'), 'other:3', 'each subject is listed on its own')
    clock = 1_001
    assert.equal(await listing('sessions'), 'sessions:4')
  })
})

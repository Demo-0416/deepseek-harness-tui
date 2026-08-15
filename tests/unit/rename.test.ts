/**
 * `/rename`: which of the title service's two entries a given argument reaches,
 * what each of them reports back, and where a renamed session shows up on
 * screen afterwards.
 *
 * The command owns no storage — a title is the log-only `session/title` event
 * and `ctx.sessionTitle` is its only writer — so the pure half here is about
 * routing and wording, and the mounted half is about the fold path a real
 * append travels: store snapshot, banner, terminal title, `/status`.
 * @module dsh-tui/tests/unit/rename
 */

import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import type { Session } from '@deepseek-ai/dsh-session'
import { SessionId, type SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionTitleSnapshot } from '@deepseek-ai/dsh-session-title'
import {
  isInvalidTitleError,
  runRenameCommand,
  type SessionTitleWriter,
} from '../../src/chat/rename.ts'
import { setLocale, t } from '../../src/i18n/index.ts'
import {
  appendUser,
  createTuiTestHarness,
  disposeTuiTestHarness,
  tuiEntryAvailable,
  type TuiHarness,
  type TuiHarnessOptions,
} from '../harness.ts'
import { HeadlessTerminal } from '../headless-terminal.ts'

/** `src/index.ts` is landed by a separate port; without it the end-to-end suite cannot run. */
const entryAvailable = await tuiEntryAvailable()
const skipWithoutEntry = entryAvailable
  ? false
  : 'requires src/index.ts to export createTuiChat(ctx, config, runtime)'

/** The snapshot batches at 16 ms and the command resolves across a few awaits; outwait both. */
const SETTLE_MS = 60

/** The session the pure cases pass through; nothing here reads it. */
const SESSION = {} as Session

afterEach(() => { setLocale('en') })

/** A snapshot shaped like the one the service returns for an accepted title. */
function snapshotOf(title: string, kind: 'user' | 'fallback' = 'user'): SessionTitleSnapshot {
  return { title, messageSeqs: [], source: { kind }, eventSeq: 7, updatedAt: 1_755_216_000_000 }
}

/** One recorded call, so a case can assert which entry the argument reached. */
interface TitleCalls {
  readonly renamed: string[]
  readonly refreshed: (AbortSignal | undefined)[]
}

/** A title service whose two entries are scripted per case. */
function fakeTitles(
  calls: TitleCalls,
  script: {
    rename?: (title: string) => SessionTitleSnapshot
    refresh?: () => Promise<SessionTitleSnapshot | undefined>
  } = {},
): SessionTitleWriter {
  return {
    rename(_session, title) {
      calls.renamed.push(title)
      return (script.rename ?? (accepted => snapshotOf(accepted)))(title)
    },
    refresh(_session, signal) {
      calls.refreshed.push(signal)
      return (script.refresh ?? (() => Promise.resolve(snapshotOf('generated title', 'fallback'))))()
    },
  }
}

function noCalls(): TitleCalls {
  return { renamed: [], refreshed: [] }
}

describe('/rename with a name', () => {
  it('hands the typed text to rename() and reports the title the service accepted', async () => {
    const calls = noCalls()
    let announced = 0
    const result = await runRenameCommand(
      {
        // The service normalizes what it stores, so the receipt has to come
        // from the return value rather than from what the user typed.
        titles: fakeTitles(calls, { rename: () => snapshotOf('Ordering bug') }),
        announceGenerating: () => { announced += 1 },
      },
      SESSION,
      'ordering  bug',
      AbortSignal.timeout(1_000),
    )

    assert.deepEqual(calls.renamed, ['ordering  bug'])
    assert.equal(result.kind, 'success')
    assert.equal(result.text, t('rename.done', { title: 'Ordering bug' }))
    assert.equal(announced, 0, 'nothing is generated, so nothing announces a generation')
  })

  it('trims the argument before the service sees it', async () => {
    const calls = noCalls()
    await runRenameCommand({ titles: fakeTitles(calls) }, SESSION, '  spaced  ', AbortSignal.timeout(1_000))
    assert.deepEqual(calls.renamed, ['spaced'])
  })

  it('blames the name, not the session, when it normalizes to nothing', async () => {
    const invalid = Object.assign(new Error('normalized to empty at byte 0'), {
      name: 'SessionTitleInvalidError',
    })
    const result = await runRenameCommand(
      { titles: fakeTitles(noCalls(), { rename: () => { throw invalid } }) },
      SESSION,
      '​',
      AbortSignal.timeout(1_000),
    )

    assert.equal(result.kind, 'error')
    assert.equal(result.text, t('rename.invalid'))
    assert.doesNotMatch(result.text ?? '', /normalized to empty/u, 'the service message is not pasted in')
  })

  it('carries the reason through for every other failure', async () => {
    const result = await runRenameCommand(
      {
        titles: fakeTitles(noCalls(), {
          rename: () => { throw new Error('session "x" is not live in this store') },
        }),
      },
      SESSION,
      'a name',
      AbortSignal.timeout(1_000),
    )

    assert.equal(result.kind, 'error')
    assert.match(result.text ?? '', /not live in this store/u)
  })

  it('explains a deployment that mounts no title service instead of throwing', async () => {
    let announced = 0
    const result = await runRenameCommand(
      { titles: undefined, announceGenerating: () => { announced += 1 } },
      SESSION,
      'a name',
      AbortSignal.timeout(1_000),
    )

    assert.equal(result.kind, 'error')
    assert.equal(result.text, t('rename.unavailable'))
    assert.equal(announced, 0)
  })
})

describe('/rename with no argument', () => {
  it('regenerates through refresh() rather than pinning a title of its own', async () => {
    const calls = noCalls()
    const signal = AbortSignal.timeout(1_000)
    let announced = 0
    await runRenameCommand(
      { titles: fakeTitles(calls), announceGenerating: () => { announced += 1 } },
      SESSION,
      '   ',
      signal,
    )

    assert.deepEqual(calls.renamed, [], 'no user-sourced title is written')
    assert.equal(calls.refreshed.length, 1)
    assert.equal(calls.refreshed[0], signal, 'the dispatching signal reaches the generation')
    assert.equal(announced, 1, 'a generation that may take a minute says so first')
  })

  it('says the title stays automatic, which is what an unpinned refresh means', async () => {
    const result = await runRenameCommand(
      { titles: fakeTitles(noCalls(), { refresh: () => Promise.resolve(snapshotOf('five word summary', 'fallback')) }) },
      SESSION,
      '',
      AbortSignal.timeout(1_000),
    )

    assert.equal(result.kind, 'success')
    assert.equal(result.text, t('rename.generated', { title: 'five word summary' }))
    assert.notEqual(result.text, t('rename.done', { title: 'five word summary' }))
  })

  it('refuses a session with nothing a title could come from', async () => {
    const result = await runRenameCommand(
      { titles: fakeTitles(noCalls(), { refresh: () => Promise.resolve(undefined) }) },
      SESSION,
      '',
      AbortSignal.timeout(1_000),
    )

    assert.equal(result.kind, 'error')
    assert.equal(result.text, t('rename.noContext'))
  })

  it('reports a failed generation rather than degrading into a silent success', async () => {
    const result = await runRenameCommand(
      {
        titles: fakeTitles(noCalls(), {
          refresh: () => Promise.reject(new Error('user rename superseded automatic title generation')),
        }),
      },
      SESSION,
      '',
      AbortSignal.timeout(1_000),
    )

    assert.equal(result.kind, 'error')
    assert.match(result.text ?? '', /superseded/u)
  })
})

describe('isInvalidTitleError', () => {
  it('matches on the name, so a class from another installation is still recognized', () => {
    // Deliberately not an instance of the shipped class: this bundle and the
    // host that mounts it resolve their own copies of the package.
    assert.equal(isInvalidTitleError({ name: 'SessionTitleInvalidError' }), true)
    assert.equal(isInvalidTitleError(new Error('nope')), false)
    assert.equal(isInvalidTitleError(null), false)
    assert.equal(isInvalidTitleError('SessionTitleInvalidError'), false)
  })
})

type RenameHarness = TuiHarness<HeadlessTerminal, (code: number) => void>

/** A title service that really appends, so the fold path runs for the assertions. */
function liveTitles(): SessionTitleWriter {
  return {
    rename(session, title) {
      session.append('session/title', { title, messageSeqs: [], source: { kind: 'user' } })
      return { title, messageSeqs: [], source: { kind: 'user' }, eventSeq: 0, updatedAt: Date.now() }
    },
    refresh: () => Promise.resolve(undefined),
  }
}

async function mount(options: TuiHarnessOptions = {}): Promise<RenameHarness> {
  const terminal = new HeadlessTerminal(110, 30)
  const before = terminal.frames
  const harness = await createTuiTestHarness(terminal, () => {}, {
    cwd: '/workspace/project',
    ...options,
    config: {
      title: 'DSH rename',
      welcome: 'ready.',
      ...options.config,
      theme: { color: false, inputPrompt: 'dsh> ', ...options.config?.theme },
    },
  })
  await terminal.waitForFrame(before)
  return harness
}

async function unmount(harness: RenameHarness): Promise<void> {
  await disposeTuiTestHarness(harness)
  await harness.terminal.dispose()
}

/** Submit a line through the editor, which is the path that prints a result. */
function submit(harness: RenameHarness, line: string): void {
  ;(harness.controller as unknown as { submit(text: string): void }).submit(line)
}

/** Every page of the open panel, joined, so a row below the fold is still readable. */
async function readPanel(harness: RenameHarness, pages = 4): Promise<string> {
  const seen: string[] = [harness.terminal.text()]
  for (let page = 0; page < pages; page += 1) {
    harness.terminal.send('\x1b[6~')
    await delay(SETTLE_MS)
    seen.push(harness.terminal.text())
  }
  return seen.join('\n')
}

describe('mounted /rename', { skip: skipWithoutEntry }, () => {
  it('registers the command with its optional-name hint', async () => {
    const harness = await mount({ services: { sessionTitle: liveTitles() } })
    try {
      const command = harness.ctx.commands.list(harness.agent).find(entry => entry.name === 'rename')
      assert.ok(command !== undefined, 'the terminal registers /rename')
      assert.equal(command.input?.hint, '[name]')
    } finally {
      await unmount(harness)
    }
  })

  it('puts the new title in the terminal title and the transcript receipt', async () => {
    const harness = await mount({ services: { sessionTitle: liveTitles() } })
    try {
      // Submitted rather than executed: the receipt reaches the transcript
      // through the editor's own command path, which is what prints a result.
      submit(harness, '/rename Ordering bug')
      await delay(SETTLE_MS)

      assert.equal(harness.terminal.title, 'Ordering bug — DSH rename')
      assert.match(harness.terminal.text(), /Session renamed to: Ordering bug/u, harness.terminal.text())
    } finally {
      await unmount(harness)
    }
  })

  it('shows the new title on the banner of a session that has a conversation', async () => {
    const harness = await mount({
      services: { sessionTitle: liveTitles() },
      // The banner only carries a title beside a resumed id, and the id is only
      // shown once the log holds a user message.
      beforeMount(session) { appendUser(session, 'the first prompt') },
    })
    try {
      await harness.ctx.commands.execute(harness.agent, '/rename Ordering bug', AbortSignal.timeout(5_000))
      await delay(SETTLE_MS)

      const frame = harness.terminal.text()
      assert.match(frame, /resumed /u, frame)
      assert.match(frame, /Ordering bug/u, frame)
    } finally {
      await unmount(harness)
    }
  })

  it('reads the same title back on the /status card', async () => {
    const harness = await mount({ services: { sessionTitle: liveTitles() } })
    try {
      await harness.ctx.commands.execute(harness.agent, '/rename Ordering bug', AbortSignal.timeout(5_000))
      await delay(SETTLE_MS)
      await harness.ctx.commands.execute(harness.agent, '/status', AbortSignal.timeout(5_000))
      await delay(SETTLE_MS)

      assert.match(harness.terminal.text(), /Title:\s+Ordering bug/u, harness.terminal.text())
    } finally {
      await unmount(harness)
    }
  })

  it('lists itself in /help with the localized description', async () => {
    const harness = await mount({ services: { sessionTitle: liveTitles() } })
    try {
      await harness.ctx.commands.execute(harness.agent, '/help', AbortSignal.timeout(5_000))
      await delay(SETTLE_MS)
      // The page is taller than the terminal, so the row is read by paging
      // through it rather than from whichever page opened first.
      const pages = await readPanel(harness)

      assert.match(pages, /\/rename \[name\]/u, pages)
      assert.match(pages, /Name this session yourself/u, pages)
    } finally {
      await unmount(harness)
    }
  })

  it('gives a readable refusal, not a crash, where no title service is mounted', async () => {
    const harness = await mount()
    try {
      const execution = await harness.ctx.commands.execute(
        harness.agent,
        '/rename anything',
        AbortSignal.timeout(5_000),
      )
      await delay(SETTLE_MS)

      assert.equal(execution?.result.kind, 'error')
      assert.equal(execution?.result.text, t('rename.unavailable'))
      assert.notEqual(harness.terminal.text().trim(), '', 'and the terminal keeps rendering')
    } finally {
      await unmount(harness)
    }
  })
})

describe('a renamed session after a resume', { skip: skipWithoutEntry }, () => {
  it('takes the seeded user title on the very first frame', async () => {
    const harness = await mount({
      beforeMount(session) {
        appendUser(session, 'the first prompt')
        session.append('session/title', {
          title: 'Kept across resume',
          messageSeqs: [],
          source: { kind: 'user' },
        })
      },
    })
    try {
      assert.equal(harness.terminal.title, 'Kept across resume — DSH rename')
      assert.match(harness.terminal.text(), /Kept across resume/u, harness.terminal.text())
    } finally {
      await unmount(harness)
    }
  })

  it('lets the later user title win over an earlier automatic one', async () => {
    const harness = await mount({
      beforeMount(session) {
        appendUser(session, 'the first prompt')
        // Priority between sources is the service's business on the way in; the
        // fold here is plain last-wins, and the UI must not second-guess it.
        session.append('session/title', {
          title: 'first prompt words',
          messageSeqs: [1],
          source: { kind: 'fallback' },
        })
        session.append('session/title', {
          title: 'Renamed by hand',
          messageSeqs: [],
          source: { kind: 'user' },
        })
      },
    })
    try {
      assert.equal(harness.terminal.title, 'Renamed by hand — DSH rename')
      const frame = harness.terminal.text()
      assert.match(frame, /Renamed by hand/u, frame)
      assert.doesNotMatch(frame, /first prompt words/u, frame)
    } finally {
      await unmount(harness)
    }
  })

  it('shows the user title on the /resume row of another session', async () => {
    const header = {
      version: 1,
      id: SessionId('archived-session'),
      createdAt: Date.now() - 3_600_000,
      cwd: '/workspace/project',
    } as SessionHeader
    const harness = await mount({
      sessionPersistence: {
        list: () => Promise.resolve([header]),
        locate: () => undefined,
        load: () => Promise.resolve({
          meta: header,
          events: [{
            seq: 1,
            time: Date.now(),
            type: 'session/title',
            data: { title: 'Named before the restart', messageSeqs: [], source: { kind: 'user' } },
          }],
        }),
      },
    })
    try {
      await harness.ctx.commands.execute(harness.agent, '/resume', AbortSignal.timeout(5_000))
      await delay(SETTLE_MS)

      const frame = harness.terminal.text()
      assert.match(frame, /Resume session/u, frame)
      // The projection cache is absent here, so the row falls back to reading
      // the title events out of the loaded log.
      assert.match(frame, /Named before the restart/u, frame)
      harness.terminal.send('\x1b')
      await delay(SETTLE_MS)
    } finally {
      await unmount(harness)
    }
  })
})

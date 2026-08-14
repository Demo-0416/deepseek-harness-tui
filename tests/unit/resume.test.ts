/**
 * The `/resume` selector: what a row says about a session, what it deliberately
 * does not say, and the line the terminal prints on the way out so the session
 * can be reached again.
 *
 * The rows are the point. A list of ISO timestamps and uuids is a database
 * dump; the questions a person actually opens this list with are "which one was
 * I in" and "how much work is in it", so a row answers those two and stops.
 * @module dsh-tui/tests/unit/resume
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { SessionId, type SessionHeader } from '@deepseek-ai/dsh-session'
import {
  formatResumeAge,
  formatResumeSize,
  ResumePicker,
  summarizeResumeCandidate,
  type ResumeCandidate,
} from '../../src/components/dialogs.ts'
import { createPalette } from '../../src/components/theme.ts'
import { launchProfileName, resumeCommandLine } from '../../src/chat/helpers.ts'
import { setLocale } from '../../src/i18n/index.ts'
import {
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

/** The overlay, its scan, and the exit hook each settle across a few awaits; outwait them. */
const SETTLE_MS = 80

/** Escape and Ctrl+D, as the terminal delivers them. */
const ESC = '\x1b'
const CTRL_D = '\x04'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const palette = createPalette(false)

afterEach(() => { setLocale('en') })

/** A persisted, resumable record in the workspace the picker is scoped to. */
function candidate(
  title: string,
  ageMs: number,
  sizeBytes?: number,
  now = Date.now(),
): ResumeCandidate {
  const header = {
    version: 1,
    id: SessionId(`session-${title.toLowerCase().replace(/\s+/gu, '-')}`),
    createdAt: now - ageMs,
    cwd: '/workspace/project',
  } as SessionHeader
  return {
    record: { header, live: false, persisted: true },
    title,
    lastActivityAt: now - ageMs,
    ...sizeBytes === undefined ? {} : { sizeBytes },
    currentWorkspace: true,
    workspaceLabel: '~/project',
  }
}

/** Render the picker at a fixed size, with the trailing padding removed. */
function rows(picker: ResumePicker, width = 60): string[] {
  return picker.render(width).map(line => line.trimEnd())
}

/** A picker over `candidates`, wired to callbacks the render cases never reach. */
function picker(candidates: readonly ResumeCandidate[] | undefined): ResumePicker {
  return new ResumePicker(candidates, 10, '~/project', () => 30, palette, () => {}, () => {})
}

describe('resume row age', () => {
  const now = Date.parse('2026-08-14T12:00:00Z')

  it('reads in the coarsest unit that still says something', () => {
    assert.equal(formatResumeAge(now - 5_000, now), 'just now')
    assert.equal(formatResumeAge(now - MINUTE, now), '1 minute ago')
    assert.equal(formatResumeAge(now - 42 * MINUTE, now), '42 minutes ago')
    assert.equal(formatResumeAge(now - HOUR, now), '1 hour ago')
    assert.equal(formatResumeAge(now - 5 * HOUR - 59 * MINUTE, now), '5 hours ago')
    assert.equal(formatResumeAge(now - DAY, now), '1 day ago')
    assert.equal(formatResumeAge(now - 6 * DAY, now), '6 days ago')
  })

  it('switches to a calendar date once counting days stops helping', () => {
    // "23 days ago" is not a date anyone navigates by; the local day is.
    const old = now - 23 * DAY
    const date = new Date(old)
    const expected = `${String(date.getFullYear())}-`
      + `${String(date.getMonth() + 1).padStart(2, '0')}-`
      + `${String(date.getDate()).padStart(2, '0')}`
    assert.equal(formatResumeAge(old, now), expected)
    assert.match(formatResumeAge(old, now), /^\d{4}-\d{2}-\d{2}$/u)
  })

  it('reads a clock that ran backwards as the present, not as a negative age', () => {
    // A file touched by another machine, or a corrected system clock: the row
    // must not print "-3 minutes ago".
    assert.equal(formatResumeAge(now + 5 * MINUTE, now), 'just now')
  })

  it('answers in the active language', () => {
    setLocale('zh')
    assert.equal(formatResumeAge(now - 30_000, now), '刚刚')
    assert.equal(formatResumeAge(now - 2 * HOUR, now), '2 小时前')
    assert.equal(formatResumeAge(now - 3 * DAY, now), '3 天前')
  })
})

describe('resume row size', () => {
  it('scales to the unit that keeps the number readable', () => {
    assert.equal(formatResumeSize(0), '0B')
    assert.equal(formatResumeSize(900), '900B')
    assert.equal(formatResumeSize(2048), '2KB')
    assert.equal(formatResumeSize(362_598), '354.1KB')
    assert.equal(formatResumeSize(5 * 1024 * 1024), '5MB')
    assert.equal(formatResumeSize(3.5 * 1024 * 1024 * 1024), '3.5GB')
  })
})

describe('resume candidate summary', () => {
  const header = {
    version: 1,
    id: SessionId('session-archived'),
    createdAt: 1_700_000_000_000,
    cwd: '/workspace/project',
  } as SessionHeader

  it('carries the scanned size through and falls back to created-at for the age', () => {
    const summary = summarizeResumeCandidate(
      { header, live: false, persisted: true },
      'Ordering bug',
      { lastActivityAt: 1_700_000_500_000, sizeBytes: 4096 },
      '/workspace/project',
      () => '~/project',
    )
    assert.equal(summary.title, 'Ordering bug')
    assert.equal(summary.lastActivityAt, 1_700_000_500_000)
    assert.equal(summary.sizeBytes, 4096)
    assert.equal(summary.currentWorkspace, true)
    assert.equal(summary.disabledReason, undefined)

    const bare = summarizeResumeCandidate(
      { header, live: false, persisted: true },
      undefined,
      {},
      '/elsewhere',
      () => '~/project',
    )
    assert.equal(bare.title, 'Untitled session')
    assert.equal(bare.lastActivityAt, header.createdAt)
    assert.equal(bare.sizeBytes, undefined, 'a session with no artifact has no size to show')
    assert.equal(bare.currentWorkspace, false)
  })

  it('keeps a reason only for a session that genuinely cannot be resumed', () => {
    // The session being browsed from is filtered out before it ever reaches
    // here, so "current session" is not one of the reasons a row can carry.
    const live = summarizeResumeCandidate(
      { header, live: true, persisted: true },
      'Live twin',
      {},
      '/workspace/project',
      () => '~/project',
    )
    assert.equal(live.disabledReason, 'session is already live in this runtime')

    const headless = { version: 1, id: SessionId('session-homeless'), createdAt: header.createdAt } as SessionHeader
    const homeless = summarizeResumeCandidate(
      { header: headless, live: false, persisted: true },
      'No workspace',
      {},
      '/workspace/project',
      () => 'cwd unset',
    )
    assert.equal(homeless.disabledReason, 'session has no recorded workspace')
  })
})

describe('resume picker rows', () => {
  it('says the age and the size, and nothing the eye has no use for', () => {
    const lines = rows(picker([candidate('Ordering bug', 2 * HOUR, 362_598)]))
    const title = lines.findIndex(line => line.includes('Ordering bug'))
    assert.ok(title > 0, `a row for the session:\n${lines.join('\n')}`)
    assert.equal(lines[title], '  ❯ Ordering bug')
    assert.equal(lines[title + 1], '    2 hours ago · 354.1KB')
    const frame = lines.join('\n')
    assert.doesNotMatch(frame, /session-ordering-bug/u, 'the id belongs in the search box, not on the row')
    assert.doesNotMatch(frame, /persisted|live/u, 'storage bookkeeping is not a thing to choose by')
    assert.doesNotMatch(frame, /\d{4}-\d{2}-\d{2}T/u, 'no ISO timestamp survives')
  })

  it('omits the size for a session with no artifact to measure', () => {
    const lines = rows(picker([candidate('Memory only', 3 * DAY)]))
    const title = lines.findIndex(line => line.includes('Memory only'))
    assert.equal(lines[title + 1], '    3 days ago', 'no trailing separator with nothing after it')
  })

  it('puts a blank line between rows so titles scan as a list', () => {
    const lines = rows(picker([
      candidate('First session', HOUR, 1024),
      candidate('Second session', 2 * DAY, 2048),
    ]))
    const first = lines.findIndex(line => line.includes('First session'))
    const second = lines.findIndex(line => line.includes('Second session'))
    assert.equal(second, first + 3, 'title, metadata, gap, next title')
    assert.equal(lines[first + 2], '')
  })

  it('still warns about a row that cannot be resumed', () => {
    const disabled = { ...candidate('Live twin', HOUR, 1024), disabledReason: 'session is already live in this runtime' }
    const frame = rows(picker([disabled])).join('\n')
    assert.match(frame, /unavailable: session is already live in this runtime/u)
  })

  it('offers a placeholder in the empty search box and drops it on the first keystroke', () => {
    const open = picker([candidate('Ordering bug', HOUR, 1024)])
    assert.match(rows(open).join('\n'), /Search…/u)
    open.handleInput('o')
    const typed = rows(open).join('\n')
    assert.doesNotMatch(typed, /Search…/u)
    assert.match(typed, /⌕ o/u)
    // Clearing the box brings the hint back rather than leaving it blank.
    open.handleInput(ESC)
    assert.match(rows(open).join('\n'), /Search…/u)
  })

  it('separates "nowhere else to go" from "your search missed"', () => {
    // The scan leaves the browsing session out, so the only session in a
    // workspace opens `/resume` on an empty list with an empty search box.
    const alone = picker([])
    assert.match(rows(alone).join('\n'), /No other session to resume\./u)
    assert.doesNotMatch(rows(alone).join('\n'), /No matching sessions/u)
    // A query that matches nothing is still the old message.
    const searched = picker([candidate('Ordering bug', HOUR, 1024)])
    searched.setQuery('nothing like this')
    assert.match(rows(searched).join('\n'), /No matching sessions\./u)
    setLocale('zh')
    assert.match(rows(alone).join('\n'), /没有其他可恢复的会话。/u)
  })

  it('matches a pasted session id even though no row prints one', () => {
    const open = picker([candidate('Ordering bug', HOUR, 1024), candidate('Other work', HOUR, 1024)])
    open.setQuery('session-ordering-bug')
    const frame = rows(open).join('\n')
    assert.match(frame, /Ordering bug/u)
    assert.doesNotMatch(frame, /Other work/u)
  })
})

describe('resume command line', () => {
  it('reads the profile back off the launcher flags, in both spellings', () => {
    assert.equal(launchProfileName(['node', 'dsh', '--profile', 'tui', '--resume', 'x']), 'tui')
    assert.equal(launchProfileName(['node', 'dsh', '--profile=tui']), 'tui')
    assert.equal(launchProfileName(['node', 'dsh']), undefined)
    // A flag that named nothing is not a profile called "--resume".
    assert.equal(launchProfileName(['node', 'dsh', '--profile', '--resume']), undefined)
    assert.equal(launchProfileName(['node', 'dsh', '--profile']), undefined)
  })

  it('drops the flag rather than inventing a profile that does not exist', () => {
    assert.equal(resumeCommandLine('session-42', 'tui'), 'dsh --profile tui --resume session-42')
    assert.equal(resumeCommandLine('session-42', undefined), 'dsh --resume session-42')
  })
})

type ResumeHarness = TuiHarness<HeadlessTerminal, (code: number) => void>

async function mount(
  options: TuiHarnessOptions = {},
  exit: (code: number) => void = () => {},
): Promise<ResumeHarness> {
  const terminal = new HeadlessTerminal(110, 30)
  const before = terminal.frames
  const harness = await createTuiTestHarness(terminal, exit, {
    cwd: '/workspace/project',
    ...options,
    config: {
      title: 'DSH resume',
      welcome: 'ready.',
      ...options.config,
      theme: { color: false, inputPrompt: 'dsh> ', ...options.config?.theme },
    },
  })
  await terminal.waitForFrame(before)
  return harness
}

async function unmount(harness: ResumeHarness): Promise<void> {
  await disposeTuiTestHarness(harness)
  await harness.terminal.dispose()
}

describe('mounted /resume', { skip: skipWithoutEntry }, () => {
  it('lists the other session with its age and size, and leaves the current one out', async () => {
    const store = await mkdtemp(join(tmpdir(), 'dsh-tui-resume-'))
    const artifact = join(store, 'archived.jsonl')
    await writeFile(artifact, 'x'.repeat(2048), 'utf8')
    const touched = new Date(Date.now() - 2 * HOUR)
    await utimes(artifact, touched, touched)
    const header = {
      version: 1,
      id: SessionId('archived-session'),
      createdAt: Date.now() - 3 * DAY,
      cwd: '/workspace/project',
    } as SessionHeader
    const harness = await mount({
      sessionPersistence: {
        list: () => Promise.resolve([header]),
        locate: meta => (meta.id === header.id ? { kind: 'jsonl', path: artifact } : undefined),
        load: () => Promise.resolve({ meta: header, events: [] }),
      },
    })
    try {
      await harness.ctx.commands.execute(harness.agent, '/resume', AbortSignal.timeout(5_000))
      await delay(SETTLE_MS)
      const frame = harness.terminal.text()
      // One row, not two: the session this picker was opened from is not a
      // place to resume into, so it is absent rather than present-and-refused.
      assert.match(frame, /Resume session \(1 of 1\)/u, frame)
      assert.match(frame, /2 hours ago · 2KB/u, frame)
      assert.doesNotMatch(frame, /archived-session/u, 'the row shows no id')
      assert.doesNotMatch(frame, /unavailable/u, 'no row is disabled, so no warning is painted')
      harness.terminal.send(ESC)
      await delay(SETTLE_MS)
    } finally {
      await unmount(harness)
      await rm(store, { recursive: true, force: true })
    }
  })
})

describe('exit resume hint', { skip: skipWithoutEntry }, () => {
  it('prints the command that brings this session back', async () => {
    const exits: number[] = []
    const harness = await mount({
      config: { sessionId: 'exiting-session' },
      sessionPersistence: { list: () => Promise.resolve([]) },
    }, (code) => { exits.push(code) })
    try {
      // Ctrl+D on an empty prompt is the plain way out; the goodbye output is
      // written after the UI released the terminal.
      harness.terminal.send(CTRL_D)
      await delay(SETTLE_MS)
      assert.deepEqual(exits, [0])
      const printed = harness.terminal.text({ includeScrollback: true }).replace(/\s+/gu, ' ')
      // The profile depends on how this process itself was launched; the
      // session id does not.
      assert.match(printed, /Resume this session: dsh (--profile \S+ )?--resume exiting-session/u, printed)
    } finally {
      await unmount(harness)
    }
  })

  it('says nothing about resuming a session that will not outlive the process', async () => {
    const exits: number[] = []
    const harness = await mount({ config: { sessionId: 'ephemeral-session' } }, (code) => { exits.push(code) })
    try {
      harness.terminal.send(CTRL_D)
      await delay(SETTLE_MS)
      assert.deepEqual(exits, [0])
      const printed = harness.terminal.text({ includeScrollback: true })
      assert.doesNotMatch(printed, /Resume this session/u, 'no persistence, nothing to come back to')
    } finally {
      await unmount(harness)
    }
  })
})

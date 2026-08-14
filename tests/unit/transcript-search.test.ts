/**
 * Session search: what a message contributes to it, what a query hits, and what
 * the panel does with the hits.
 *
 * Three levels, because the feature has three. The fold cases pin which nodes
 * are searchable at all; the query cases pin the one matching rule (a
 * case-insensitive substring) and the excerpt/highlight pair a row is drawn
 * from; the panel cases pin the surface — filter, selection, the opened
 * message, and the Esc ladder that walks back out of them. One mounted case
 * holds the wiring: the key and the command open the same panel over the
 * session actually on screen.
 * @module dsh-tui/tests/unit/transcript-search
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { stripTerminalSequences } from '@earendil-works/pi-tui'
import {
  highlightSegments,
  searchTranscript,
  transcriptEntries,
} from '../../src/chat/transcript-search.ts'
import {
  TRANSCRIPT_SEARCH_EMPTY,
  TRANSCRIPT_SEARCH_NO_MATCH,
  TranscriptSearchPanel,
} from '../../src/components/transcript-search.ts'
import { createPalette } from '../../src/components/theme.ts'
import type { ChatNode } from '../../src/core/types.ts'
import {
  appendAssistant,
  appendUser,
  createTuiTestHarness,
  disposeTuiTestHarness,
  tuiEntryAvailable,
  type TuiHarness,
  type TuiHarnessOptions,
} from '../harness.ts'
import { HeadlessTerminal } from '../headless-terminal.ts'

/** Literal editor prefix, so a frame assertion never depends on prompt-value registrations. */
const INPUT_PROMPT = 'search> '

const ESC = '\x1b'
const ENTER = '\r'
const ARROW_DOWN = `${ESC}[B`
/** Ctrl+G, as the terminal delivers it: the transcript-search key. */
const CTRL_G = '\x07'

/** A panel answer settles across a few awaits; outwait it. */
const SETTLE_MS = 60

/** `src/index.ts` is landed by a separate port; without it the end-to-end suite cannot run. */
const entryAvailable = await tuiEntryAvailable()
const skipWithoutEntry = entryAvailable
  ? false
  : 'requires src/index.ts to export createTuiChat(ctx, config, runtime)'

const palette = createPalette(false)

/** A user node, in the shape the fold produces. */
function userNode(key: string, text: string, extra: Partial<ChatNode> = {}): ChatNode {
  return { kind: 'user-message', key, version: 1, time: 1, text, source: 'user', ...extra } as ChatNode
}

/** An assistant node carrying settled text and reasoning. */
function assistantNode(key: string, text: string, reasoning = ''): ChatNode {
  return {
    kind: 'assistant',
    key,
    version: 1,
    time: 2,
    turn: 1,
    step: 1,
    status: 'complete',
    text,
    reasoning,
    settled: true,
    toolCalls: [],
  }
}

/** A tool-call node with parsed arguments and, optionally, its result. */
function toolNode(key: string, name: string, args: Record<string, unknown>, resultText?: string): ChatNode {
  return {
    kind: 'tool-call',
    key,
    version: 1,
    time: 3,
    callId: key,
    name,
    argsRaw: JSON.stringify(args),
    args: { value: args, valid: true },
    argsComplete: true,
    status: 'complete',
    ...resultText === undefined ? {} : {
      result: { content: [{ type: 'text', text: resultText }], isError: false, text: resultText },
    },
  } as ChatNode
}

/** A small session: one prompt, one answer, one tool call with output. */
function fixtureNodes(): ChatNode[] {
  return [
    userNode('u1', 'Where does the Banner sweep start?'),
    assistantNode('a1', 'The sweep starts in helpers.ts.', 'private thoughts about ripgrep'),
    toolNode('t1', 'read', { path: 'src/chat/helpers.ts', limit: 20 }, 'export const BANNER_REVEAL_INTERVAL_MS = 15'),
    userNode('u2', 'thanks'),
  ]
}

describe('transcriptEntries', () => {
  it('reads the transcript the user can see, in its own order', () => {
    const entries = transcriptEntries(fixtureNodes())
    assert.deepEqual(entries.map(entry => entry.key), ['u1', 'a1', 't1', 'u2'])
    assert.deepEqual(entries.map(entry => entry.role), ['user', 'assistant', 'tool', 'user'])
    assert.deepEqual(entries.map(entry => entry.label), ['You', 'Assistant', 'read', 'You'])
  })

  it('folds a tool card into its header summary and its output', () => {
    const [entry] = transcriptEntries([toolNode('t1', 'read', { path: 'src/index.ts' }, 'first line')])
    assert.equal(entry?.text, 'read(path: src/index.ts)\nfirst line')
  })

  it('leaves reasoning out of the answer, so a hit is a word the answer said', () => {
    const [entry] = transcriptEntries([assistantNode('a1', 'the answer', 'the thinking')])
    assert.equal(entry?.text, 'the answer')
  })

  it('drops what the transcript itself renders nothing for', () => {
    const nodes: ChatNode[] = [
      userNode('withdrawn', 'discarded prompt', { withdrawn: true }),
      userNode('blank', '   '),
      assistantNode('empty', ''),
      { kind: 'todo', key: 'todo', version: 1, time: 4, todos: [] },
      { kind: 'compaction', key: 'open', version: 1, time: 5, landed: false, summary: 'not yet' },
      { kind: 'compaction', key: 'landed', version: 1, time: 6, landed: true, summary: 'compacted history' },
    ]
    assert.deepEqual(transcriptEntries(nodes).map(entry => entry.key), ['landed'])
  })
})

describe('searchTranscript', () => {
  const entries = transcriptEntries(fixtureNodes())

  it('matches a substring regardless of case', () => {
    const lower = searchTranscript(entries, 'banner')
    const upper = searchTranscript(entries, 'BANNER')
    assert.deepEqual(lower.map(match => match.entry.key), ['u1', 't1'])
    assert.deepEqual(upper.map(match => match.entry.key), lower.map(match => match.entry.key))
  })

  it('opens on the whole session when nothing is typed yet', () => {
    const all = searchTranscript(entries, '')
    assert.equal(all.length, entries.length)
    assert.equal(all[0]?.excerpt, 'Where does the Banner sweep start?')
    assert.equal(all[0]?.hitLines, 0)
  })

  it('returns nothing for a query no message holds', () => {
    assert.deepEqual(searchTranscript(entries, 'kubernetes'), [])
  })

  it('counts the lines a query hits and excerpts the first of them', () => {
    const [match] = searchTranscript(
      [{ key: 'n', role: 'notice', label: 'Notice', time: 1, text: 'alpha\nbeta hit\ngamma\ndelta hit' }],
      'hit',
    )
    assert.equal(match?.hitLines, 2)
    assert.equal(match?.excerpt, 'beta hit')
  })

  it('windows a hit that sits past the start of a long line', () => {
    const filler = 'x'.repeat(120)
    const [match] = searchTranscript(
      [{ key: 'n', role: 'notice', label: 'Notice', time: 1, text: `${filler} needle tail` }],
      'needle',
    )
    // The row is useless if the hit is off the end of it: the excerpt starts
    // mid-line, says so, and still contains what was typed.
    assert.ok(match !== undefined)
    assert.ok(match.excerpt.startsWith('…'), match.excerpt)
    assert.ok(match.excerpt.includes('needle'), match.excerpt)
    assert.ok(match.excerpt.length <= 160, `excerpt is bounded: ${String(match.excerpt.length)}`)
  })
})

describe('highlightSegments', () => {
  it('splits every occurrence out, keeping the text exactly as written', () => {
    const segments = highlightSegments('Banner and banner', 'BANNER')
    assert.deepEqual(segments, [
      { text: 'Banner', hit: true },
      { text: ' and ', hit: false },
      { text: 'banner', hit: true },
    ])
    assert.equal(segments.map(segment => segment.text).join(''), 'Banner and banner')
  })

  it('marks the head and tail around a hit', () => {
    assert.deepEqual(highlightSegments('a hit b', 'hit'), [
      { text: 'a ', hit: false },
      { text: 'hit', hit: true },
      { text: ' b', hit: false },
    ])
  })

  it('paints nothing without a query, and nothing that did not match', () => {
    assert.deepEqual(highlightSegments('plain row', ''), [{ text: 'plain row', hit: false }])
    assert.deepEqual(highlightSegments('plain row', 'zzz'), [{ text: 'plain row', hit: false }])
    assert.deepEqual(highlightSegments('', 'zzz'), [])
  })
})

describe('TranscriptSearchPanel', () => {
  /**
   * Plain rows of the panel frame: the query box's cursor marker and the
   * palette's escapes are the TUI's business, not this suite's.
   */
  function rows(panel: TranscriptSearchPanel, width = 60): string[] {
    return panel.render(width)
      .map(line => stripTerminalSequences(line).trimEnd().replace(/^ /u, ''))
  }

  function fixture(query = '', onClose: () => void = () => {}): TranscriptSearchPanel {
    return new TranscriptSearchPanel(transcriptEntries(fixtureNodes()), query, () => 12, palette, onClose)
  }

  it('opens on the whole session, with the first message selected', () => {
    const frame = rows(fixture())
    assert.equal(frame[1], '/search')
    assert.match(frame[3] ?? '', /^4\/4 messages/u)
    assert.match(frame[4] ?? '', /^→ You\s+Where does the Banner sweep start\?/u)
    assert.match(frame.at(-1) ?? '', /type to search · ↑↓ move · enter open · esc close/u)
  })

  it('filters as the query is typed, and says so when nothing matches', () => {
    const panel = fixture()
    panel.render(60)
    for (const char of 'banner') panel.handleInput(char)
    const filtered = rows(panel)
    assert.match(filtered[2] ?? '', /^search > banner/u)
    assert.match(filtered[3] ?? '', /^2\/4 messages/u)
    // The row shows the line the query hit — inside the tool card that is its
    // output, not the header — and the hit is case-insensitive on both.
    assert.deepEqual(
      filtered.slice(4, 6).map(row => row.trim().replace(/\s+/gu, ' ')),
      ['→ You Where does the Banner sweep start?', 'read export const BANNER_REVEAL_INTERVAL_MS = 15'],
    )

    for (const char of 'zzz') panel.handleInput(char)
    const empty = rows(panel)
    assert.match(empty[3] ?? '', /^0\/4 messages/u)
    assert.equal(empty[4], TRANSCRIPT_SEARCH_NO_MATCH)
  })

  it('opens the panel on a query the command carried, ready to be extended', () => {
    const panel = fixture('sweep')
    const frame = rows(panel)
    assert.match(frame[2] ?? '', /^search > sweep/u)
    assert.match(frame[3] ?? '', /^2\/4 messages/u)
    // The caret sits after the argument, not in front of it: a prefilled box
    // whose next keystroke lands at column zero is a box that lied.
    panel.handleInput('s')
    assert.match(rows(panel)[2] ?? '', /^search > sweeps/u)
  })

  it('gives one message its own page, and walks back out one rung at a time', () => {
    let closed = 0
    const panel = fixture('banner', () => { closed += 1 })
    panel.render(60)

    panel.handleInput(ARROW_DOWN)
    panel.handleInput(ENTER)
    const detail = rows(panel)
    assert.equal(detail[1], '/search · read')
    assert.match(detail[2] ?? '', /hits for "banner" are highlighted/u)
    assert.ok(
      detail.some(row => row.includes('BANNER_REVEAL_INTERVAL_MS')),
      `the whole card is on the page:\n${detail.join('\n')}`,
    )
    assert.match(detail.at(-1) ?? '', /↑↓ scroll · PgUp\/PgDn page · esc back/u)

    // Esc leaves the message for the list that found it, query intact…
    panel.handleInput(ESC)
    const list = rows(panel)
    assert.match(list[2] ?? '', /^search > banner/u)
    assert.equal(closed, 0)

    // …then clears the query, and only then closes the panel.
    panel.handleInput(ESC)
    assert.match(rows(panel)[2] ?? '', /^search >$/u)
    assert.equal(closed, 0)
    panel.handleInput(ESC)
    assert.equal(closed, 1)
    panel.handleInput('\x03')
    assert.equal(closed, 2)
  })

  it('pages a message longer than the panel', () => {
    const lines = Array.from({ length: 40 }, (_, index) => `line ${String(index + 1)}`)
    const panel = new TranscriptSearchPanel(
      [{ key: 'a', role: 'assistant', label: 'Assistant', time: 1, text: lines.join('\n') }],
      '',
      () => 12,
      palette,
      () => {},
    )
    panel.render(60)
    panel.handleInput(ENTER)
    const first = rows(panel)
    assert.equal(first[4], 'line 1')
    assert.match(first.at(-1) ?? '', /1–7 of 40/u)
    panel.handleInput(`${ESC}[6~`)
    assert.match(rows(panel).at(-1) ?? '', /8–14 of 40/u)
    panel.handleInput(`${ESC}[F`)
    assert.match(rows(panel).at(-1) ?? '', /34–40 of 40/u)
  })

  it('explains itself rather than opening an empty page', () => {
    const panel = new TranscriptSearchPanel([], '', () => 12, palette, () => {})
    assert.deepEqual(rows(panel), ['', '/search', TRANSCRIPT_SEARCH_EMPTY, 'esc close'])
  })
})

describe('/search and its key', { skip: skipWithoutEntry }, () => {
  type SearchHarness = TuiHarness<HeadlessTerminal, (code: number) => void>

  /** `TuiController.submit` is the typed-line path; the harness handle only declares disposal. */
  interface SubmitHandle {
    submit(text: string): void
  }

  async function mount(options: TuiHarnessOptions = {}): Promise<SearchHarness> {
    const terminal = new HeadlessTerminal(96, 32)
    const before = terminal.frames
    const harness = await createTuiTestHarness(terminal, () => {}, {
      cwd: '/workspace/project',
      ...options,
      beforeMount(session) {
        appendUser(session, 'where does the banner sweep start?')
        appendAssistant(session, [{ type: 'text', text: 'in helpers.ts, one column per frame' }])
      },
      config: {
        title: 'DSH search',
        welcome: 'ready.',
        ...options.config,
        theme: { color: false, inputPrompt: INPUT_PROMPT, ...options.config?.theme },
      },
    })
    await terminal.waitForFrame(before)
    return harness
  }

  it('opens on the key and on the command, over the session on screen', async () => {
    const harness = await mount()
    try {
      harness.terminal.send(CTRL_G)
      await delay(SETTLE_MS)
      const opened = harness.terminal.text()
      assert.match(opened, /\/search/u, `the key opens the panel:\n${opened}`)
      assert.match(opened, /2\/2 messages/u)
      // The key never lands in the draft.
      assert.doesNotMatch(opened, new RegExp(`${INPUT_PROMPT}\\S`, 'u'))

      harness.terminal.send(ESC)
      await delay(SETTLE_MS)
      assert.doesNotMatch(harness.terminal.text(), /2\/2 messages/u)

      ;(harness.controller as unknown as SubmitHandle).submit('/search helpers')
      await delay(SETTLE_MS)
      const filtered = harness.terminal.text()
      assert.match(filtered, /search > helpers/u, `the command prefills its argument:\n${filtered}`)
      assert.match(filtered, /1\/2 messages/u)
    } finally {
      await disposeTuiTestHarness(harness)
      await harness.terminal.dispose()
    }
  })
})

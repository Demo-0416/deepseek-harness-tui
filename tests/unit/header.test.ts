/**
 * Startup banner rendering, at the component boundary rather than through a
 * mounted TUI: the `[Skills]` summary is filled by asynchronous skill discovery
 * the entry drives, and what it does with a list — the four-row budget, the
 * `+N more` remainder, and the width it stays inside — is a pure function of
 * that list and the render width.
 * @module dsh-tui/tests/unit/header
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { visibleWidth } from '@earendil-works/pi-tui'
import { HeaderComponent, type HeaderInfo } from '../../src/components/transcript.ts'
import { BANNER_REVEAL_STEPS, bannerRevealWidth } from '../../src/chat/helpers.ts'
import { createPalette } from '../../src/components/theme.ts'

/** Color disabled: every assertion here is about text, not escapes. */
const palette = createPalette(false)

/** Banner width used by the fixed-shape cases, wide enough for the identity rows. */
const WIDE = 60

/**
 * The boxed identity block every wide banner opens with: the whale art beside
 * the wordmark, route, and workspace, inside a rounded frame that hugs its
 * widest line (the 23-column wordmark, plus 16 interior chrome columns).
 */
const IDENTITY_ROWS = [
  ` ╭${'─'.repeat(39)}╮`,
  ' │  ▄███▄  █▄█▄  DEEPSEEK HARNESS v0.1.0 │',
  ' │ ▐▀▀██▙▟▙▄▀▀   deepseek-v4-flash       │',
  ' │ ▜▖  ▝█▙█▛     /workspace/project      │',
  ' │  ▀▙▟█▄▛▀                              │',
  ` ╰${'─'.repeat(39)}╯`,
]

/**
 * Render the banner, with or without a skill or plugin list.
 * @param skills - Skill names, or `undefined` for an entry that supplies none.
 * @param width - Render width in columns.
 * @param plugins - Plugin module names, or `undefined` for none.
 * @returns The rendered rows, right-trimmed.
 */
function bannerRows(
  skills: readonly string[] | undefined,
  width = WIDE,
  plugins?: readonly string[],
): string[] {
  const info: HeaderInfo = {
    version: '0.1.0',
    model: () => 'deepseek-v4-flash',
    cwd: '/workspace/project',
    resumed: undefined,
    title: () => undefined,
    ...skills === undefined ? {} : { skills },
    ...plugins === undefined ? {} : { plugins: () => plugins },
  }
  return new HeaderComponent(info, palette, false).render(width).map(row => row.trimEnd())
}

/** The skill-name rows of a banner: everything under the `[Skills]` label. */
function skillRows(rows: readonly string[]): string[] {
  const label = rows.indexOf(' [Skills]')
  assert.ok(label >= 0, `the banner has a skills section:\n${rows.join('\n')}`)
  return rows.slice(label + 1)
}

/** Names a rendered summary accounts for: the ones it prints, plus its remainder. */
function accountedNames(rows: readonly string[]): number {
  let counted = 0
  for (const row of rows) {
    for (const item of row.trim().split(', ')) {
      const remainder = /^\+(\d+) more$/u.exec(item)
      counted += remainder === null ? 1 : Number(remainder[1])
    }
  }
  return counted
}

describe('startup banner', () => {
  it('renders no skills section when the entry supplies none', () => {
    // Absent and empty are the same deployment fact — nothing to list — and a
    // banner row that said so would be a row spent on nothing.
    assert.deepEqual(bannerRows(undefined), IDENTITY_ROWS)
    assert.deepEqual(bannerRows([]), IDENTITY_ROWS)
    // A list of blank names is an empty list: the section would render a label
    // over a row of commas.
    assert.deepEqual(bannerRows(['', '  ']), IDENTITY_ROWS)
  })

  it('lists the skills under a labelled section below the workspace row', () => {
    assert.deepEqual(bannerRows(['lark-doc', 'lark-base', 'meego-tech-story']), [
      ...IDENTITY_ROWS,
      // A blank row separates the identity block from the capability section.
      '',
      ' [Skills]',
      ' lark-doc, lark-base, meego-tech-story',
    ])
  })

  it('wraps a long catalog to four rows and counts the rest into the remainder', () => {
    const names = Array.from({ length: 40 }, (_value, index) => `skill-${String(index).padStart(2, '0')}`)
    const rows = skillRows(bannerRows(names))
    assert.equal(rows.length, 4, `the summary spends at most four rows:\n${rows.join('\n')}`)
    assert.match(rows.at(-1) ?? '', /\+\d+ more$/u, `and ends on its remainder:\n${rows.join('\n')}`)
    // Every name is either printed or counted: the remainder is a count of the
    // catalog, not of what happened to be left over on the last row.
    assert.equal(accountedNames(rows), names.length, `all 40 names are accounted for:\n${rows.join('\n')}`)
    for (const row of rows) {
      assert.ok(visibleWidth(row) <= WIDE, `no row overflows the banner: "${row}"`)
    }
  })

  it('keeps the whole list when it fits inside the budget', () => {
    const names = Array.from({ length: 6 }, (_value, index) => `skill-${index}`)
    const rows = skillRows(bannerRows(names))
    assert.ok(rows.length <= 4, `a short list needs no folding:\n${rows.join('\n')}`)
    assert.ok(!rows.join('\n').includes('more'), `and reports no remainder:\n${rows.join('\n')}`)
    assert.equal(accountedNames(rows), names.length)
  })

  it('reports a bigger remainder rather than overflowing a narrow banner', () => {
    // 20 columns leaves 18 usable, so one name per row: the count moves to its
    // own row instead of being clipped off the end of the last one.
    const names = Array.from({ length: 10 }, (_value, index) => `skill-name-${index}`)
    const rows = skillRows(bannerRows(names, 20))
    assert.ok(rows.length <= 4, `the budget holds on a narrow banner:\n${rows.join('\n')}`)
    assert.equal(accountedNames(rows), names.length, `and still accounts for every name:\n${rows.join('\n')}`)
    for (const row of rows) {
      assert.ok(visibleWidth(row) <= 20, `no row overflows the banner: "${row}"`)
    }
  })

  it('lists plugins in their own section under the skills', () => {
    assert.deepEqual(bannerRows(['lark-doc'], WIDE, ['pi-subagents', 'plan-mode']).slice(IDENTITY_ROWS.length), [
      '',
      ' [Skills]',
      ' lark-doc',
      '',
      ' [Plugins]',
      ' pi-subagents, plan-mode',
    ])
    // An inventory that has not answered yet (or answered empty) spends no rows.
    assert.deepEqual(bannerRows(undefined, WIDE, []), IDENTITY_ROWS)
  })

  it('reads the list at render time, so late discovery reaches the banner', () => {
    // The entry mounts before skill discovery finishes and fills the array it
    // handed the header in place; a banner that captured the list at
    // construction would open empty and stay empty.
    const skills: string[] = []
    const header = new HeaderComponent({
      version: '0.1.0',
      model: () => 'deepseek-v4-flash',
      cwd: '/workspace/project',
      resumed: undefined,
      title: () => undefined,
      skills,
    }, palette, false)
    assert.deepEqual(header.render(WIDE).map(row => row.trimEnd()), IDENTITY_ROWS)

    skills.push('lark-doc')
    assert.deepEqual(header.render(WIDE).map(row => row.trimEnd()), [...IDENTITY_ROWS, '', ' [Skills]', ' lark-doc'])
  })
})

describe('full welcome box', () => {
  it('splits into two columns with the wordmark riding the top border', () => {
    const rows = bannerRows(['lark-doc', 'lark-base'], 100)
    assert.match(rows[0] ?? '', /^ ╭─ DEEPSEEK HARNESS v0\.1\.0 ─+╮$/u, `titled border:\n${rows.join('\n')}`)
    assert.match(rows.at(-1) ?? '', /^ ╰─+┴─+╯$/u, `the bottom border closes both panels:\n${rows.join('\n')}`)
    // Every interior row is three-walled: the outer borders and the panel split.
    for (const row of rows.slice(1, -1)) {
      assert.equal([...row].filter(ch => ch === '│').length, 3, `three walls: "${row}"`)
    }
    // Identity in the left panel, the skill section in the right.
    assert.ok(rows.some(row => /│ +deepseek-v4-flash +│/u.test(row)), `route:\n${rows.join('\n')}`)
    assert.ok(rows.some(row => /│ \[Skills\] +│$/u.test(row)), `skills header:\n${rows.join('\n')}`)
    assert.ok(rows.some(row => /lark-doc, lark-base/u.test(row)), `skill names:\n${rows.join('\n')}`)
    for (const row of rows) {
      assert.ok(visibleWidth(row) <= 100, `no row overflows the banner: "${row}"`)
    }
  })

  it('gives the plugins their own right-panel section', () => {
    const rows = bannerRows(['lark-doc'], 100, ['pi-subagents', 'plan-mode'])
    assert.ok(rows.some(row => /│ \[Plugins\] +│$/u.test(row)), `plugins header:\n${rows.join('\n')}`)
    assert.ok(rows.some(row => /pi-subagents, plan-mode/u.test(row)), `plugin names:\n${rows.join('\n')}`)
  })

  it('keeps the badge shape when the entry supplies no skill list', () => {
    // With nothing to spend a right panel on, the two-column frame says the
    // same thing in three times the rows; the badge is the honest size.
    const rows = bannerRows(undefined, 100)
    assert.match(rows[0] ?? '', /^ ╭─+╮$/u, `plain badge border:\n${rows.join('\n')}`)
    assert.ok(!rows.some(row => row.includes('┴')), `no panel split:\n${rows.join('\n')}`)
  })
})

describe('banner sweep reveal', () => {
  it('uncovers the same fraction of whatever width it is asked about', () => {
    // The property a resize depends on: half the frames, half the width, at any
    // terminal size. A sweep that captured its width at the start instead would
    // keep wiping toward a frame that is no longer there.
    const half = Math.ceil(BANNER_REVEAL_STEPS / 2)

    assert.equal(bannerRevealWidth(half, 80) / 80 > 0.45, true)
    assert.equal(bannerRevealWidth(half, 160) / 160 > 0.45, true)
    assert.ok(bannerRevealWidth(half, 160) > bannerRevealWidth(half, 80))
  })

  it('finishes at the width, never past it', () => {
    assert.equal(bannerRevealWidth(BANNER_REVEAL_STEPS, 80), 80)
    assert.equal(bannerRevealWidth(BANNER_REVEAL_STEPS * 4, 80), 80)
    // A terminal narrowed mid-sweep finishes on the next frame rather than
    // spending the frames the wider one had left.
    assert.equal(bannerRevealWidth(BANNER_REVEAL_STEPS, 4), 4)
  })

  it('reveals at least one column on the first frame, at any width', () => {
    assert.equal(bannerRevealWidth(1, 1), 1)
    assert.ok(bannerRevealWidth(1, 200) >= 1)
  })
})

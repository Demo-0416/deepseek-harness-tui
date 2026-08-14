/**
 * Unit tests for the markdown-to-ANSI pipeline.
 *
 * Structure is asserted through a sentinel theme (`H1<…>`, `U<->`, `C<…>`)
 * rather than through escape sequences: what the port has to get right is which
 * slot each token reaches and how blocks, indents and wraps line up, and a
 * sentinel makes a wrong slot fail loudly instead of hiding inside an escape.
 * The escape sequences themselves are checked separately against
 * {@link claudeMarkdownTheme}, which is the only place they are decided.
 *
 * The last group covers the component that mounts this pipeline in a transcript:
 * what it caches, what it degrades to without color, and what it leaves on
 * screen when neither renderer can parse a body.
 * @module dsh-tui/tests/unit/markdown
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import {
  claudeMarkdownTheme,
  clearMarkdownHighlightCache,
  hasMarkdownSyntax,
  markdownHighlighter,
  renderMarkdownAnsi,
  warmMarkdownHighlightCache,
  type MarkdownAnsiTheme,
} from '../../src/render/markdown.ts'
import { MarkdownBodyComponent, type MarkdownPolicy } from '../../src/components/transcript.ts'
import { createPalette, markdownTheme } from '../../src/components/theme.ts'

/** A theme that names the slot it was called from, so a mis-routed token fails. */
const sentinel: MarkdownAnsiTheme = {
  heading: (text, depth) => `H${depth}<${text}>`,
  bold: text => `B<${text}>`,
  italic: text => `I<${text}>`,
  code: text => `C<${text}>`,
  codeBlock: text => `K<${text}>`,
  link: text => `L<${text}>`,
  quote: text => `Q<${text}>`,
  listBullet: text => `U<${text}>`,
  hr: text => `R<${text}>`,
}

/** Render with the sentinel theme and hyperlinks off (a bare URL is easier to read). */
function plain(source: string, width = 60): string[] {
  return renderMarkdownAnsi(source, width, sentinel, { hyperlinks: false })
}

describe('markdown headings', () => {
  it('routes each level through the heading slot with its depth', () => {
    assert.deepEqual(plain('# One\n\n## Two\n\n### Three'), [
      'H1<One>',
      '',
      '',
      'H2<Two>',
      '',
      '',
      'H3<Three>',
    ])
  })

  it('gives h1 bold+italic+underline and h2 bold alone', () => {
    const [h1 = ''] = renderMarkdownAnsi('# One', 40, claudeMarkdownTheme)
    const [h2 = ''] = renderMarkdownAnsi('## Two', 40, claudeMarkdownTheme)
    assert.equal(h1, '\x1b[1m\x1b[3m\x1b[4mOne\x1b[24m\x1b[23m\x1b[22m')
    assert.equal(h2, '\x1b[1mTwo\x1b[22m')
  })

  it('formats inline tokens inside a heading before styling it', () => {
    assert.deepEqual(plain('## Run `dsh` now'), ['H2<Run C<dsh> now>'])
  })

  it('accepts a depth-blind `string => string` heading slot', () => {
    // Every theme slot is usable as a plain `string => string`; the heading's
    // second argument is there for a theme that wants it, never required.
    const flat: MarkdownAnsiTheme = { ...sentinel, heading: (text: string) => `H<${text}>` }
    assert.deepEqual(renderMarkdownAnsi('# One', 40, flat), ['H<One>'])
  })
})

describe('markdown lists', () => {
  it('indents nested unordered items and marks each with a bullet', () => {
    assert.deepEqual(plain('- alpha\n- beta\n  - nested\n    - deeper\n'), [
      'U<-> alpha',
      'U<-> beta',
      '  U<-> nested',
      '      U<-> deeper',
    ])
  })

  it('switches an ordered marker from digits to letters to roman by depth', () => {
    assert.deepEqual(plain('1. one\n   1. a\n      1. i\n'), ['U<1.> one', '  U<a.> a', '      U<i.> i'])
  })

  it('honours an ordered list that does not start at one', () => {
    assert.deepEqual(plain('3. three\n4. four\n'), ['U<3.> three', 'U<4.> four'])
  })

  it('keeps a task list checkbox and does not leak its indent', () => {
    assert.deepEqual(plain('- [ ] todo\n- [x] done\n'), ['U<-> [ ] todo', 'U<-> [x] done'])
  })

  it('formats inline tokens inside an item', () => {
    assert.deepEqual(plain('- run `dsh` and **stop**'), ['U<-> run C<dsh> and B<stop>'])
  })
})

describe('markdown inline spans', () => {
  it('routes an inline codespan through the code slot', () => {
    assert.deepEqual(plain('use `npm run build` here'), ['use C<npm run build> here'])
  })

  it('re-opens an outer attribute that a nested one closed', () => {
    // A heading is bold, and `**strong**` inside it emits the same bold close.
    // Without the rewrite that close would end the heading's own bold and the
    // trailing text would render at normal weight.
    const [line = ''] = renderMarkdownAnsi('# Title **strong** tail', 60, claudeMarkdownTheme)
    assert.equal(line, '\x1b[1m\x1b[3m\x1b[4mTitle \x1b[1mstrong\x1b[1m tail\x1b[24m\x1b[23m\x1b[22m')
  })

  it('leaves a nested span alone when its close belongs to another group', () => {
    const [line = ''] = renderMarkdownAnsi('**bold with *em* tail**', 60, claudeMarkdownTheme)
    assert.equal(line, '\x1b[1mbold with \x1b[3mem\x1b[23m tail\x1b[22m')
  })

  it('drops strikethrough so a "~100" approximation survives verbatim', () => {
    assert.deepEqual(plain('about ~100~ ms'), ['about ~100~ ms'])
  })
})

describe('markdown code blocks', () => {
  it('falls back to the codeBlock slot when nothing highlighted it', () => {
    assert.deepEqual(plain('before\n\n```ts\nconst a = 1\nconst b = 2\n```\n\nafter'), [
      'before',
      '',
      'K<const a = 1',
      'const b = 2>',
      '',
      'after',
    ])
  })

  it('uses an injected highlighter, and passes it the fence language', () => {
    const seen: Array<[string, string]> = []
    const rows = renderMarkdownAnsi('```python\nx = 1\n```', 60, sentinel, {
      highlight: (code, language) => {
        seen.push([code, language])
        return `HL<${code}>`
      },
    })
    assert.deepEqual(seen, [['x = 1', 'python']])
    assert.deepEqual(rows, ['HL<x = 1>'])
  })

  it('renders plain and never consults the highlighter for a bare fence', () => {
    let calls = 0
    const rows = renderMarkdownAnsi('```\nraw\n```', 60, sentinel, {
      highlight: () => {
        calls += 1
        return 'NEVER'
      },
    })
    assert.equal(calls, 0)
    assert.deepEqual(rows, ['K<raw>'])
  })

  it('reads the shared cache, which stays empty when shiki is absent', async () => {
    clearMarkdownHighlightCache()
    // `@shikijs/cli` is an optional peer that this repo does not install, so
    // warming must resolve quietly and leave the render plain.
    await warmMarkdownHighlightCache('```ts\nconst a = 1\n```')
    assert.equal(markdownHighlighter()('const a = 1', 'ts'), undefined)
    assert.deepEqual(plain('```ts\nconst a = 1\n```'), ['K<const a = 1>'])
  })
})

describe('markdown blockquotes', () => {
  it('prefixes every non-empty line with a bar and italicises the body', () => {
    assert.deepEqual(plain('> hello there\n> second line\n\nafter'), [
      'Q<▎> I<hello there>',
      'Q<▎> I<second line>',
      '',
      'after',
    ])
  })

  it('uses a dim U+258E bar with the default theme', () => {
    const [line = ''] = renderMarkdownAnsi('> quoted', 40, claudeMarkdownTheme)
    assert.ok(line.startsWith('\x1b[2m▎\x1b[22m '), line)
    assert.equal(stripTerminalSequences(line), '▎ quoted')
  })
})

describe('markdown links', () => {
  it('wraps display text in an OSC 8 hyperlink', () => {
    assert.deepEqual(renderMarkdownAnsi('see [docs](https://example.com/a)', 60, sentinel), [
      'see \x1b]8;;https://example.com/a\x07L<docs>\x1b]8;;\x07',
    ])
  })

  it('shows the URL once when the display text merely repeats it', () => {
    assert.deepEqual(renderMarkdownAnsi('<https://bare.example>', 60, sentinel), [
      '\x1b]8;;https://bare.example\x07L<https://bare.example>\x1b]8;;\x07',
    ])
  })

  it('degrades to the bare URL when hyperlinks are off', () => {
    assert.deepEqual(plain('see [docs](https://example.com/a)'), ['see L<https://example.com/a>'])
  })

  it('renders a mailto link as the plain address', () => {
    assert.deepEqual(plain('mail [me](mailto:a@b.example)'), ['mail a@b.example'])
  })
})

describe('markdown wrapping', () => {
  it('counts a CJK character as two columns', () => {
    assert.deepEqual(plain('中文测试中文测试中文测试中文测试中文测试中文测试', 20), [
      '中文测试中文测试中文',
      '测试中文测试中文测试',
      '中文测试',
    ])
  })

  it('keeps every wrapped row inside the width when the text is styled', () => {
    const source = '**强调的中文文本需要折行处理** 与 `code span` 混排的一段较长文字'
    for (const row of renderMarkdownAnsi(source, 24, claudeMarkdownTheme)) {
      assert.ok(visibleWidth(row) <= 24, `${visibleWidth(row)} > 24: ${JSON.stringify(row)}`)
    }
  })

  it('clamps a non-positive width instead of looping', () => {
    assert.deepEqual(plain('ab cd', 0), ['a', 'b', 'c', 'd'])
  })
})

describe('markdown fast path', () => {
  it('recognises prose with no markdown markers', () => {
    assert.equal(hasMarkdownSyntax('just a plain sentence with no syntax'), false)
    assert.equal(hasMarkdownSyntax('a **bold** claim'), true)
    assert.equal(hasMarkdownSyntax('two\n\nparagraphs'), true)
    assert.equal(hasMarkdownSyntax('1. a numbered start'), true)
  })

  it('renders plain prose as one wrapped block, keeping its soft newline', () => {
    assert.deepEqual(plain('just a plain sentence\nand a soft break', 20), [
      'just a plain',
      'sentence',
      'and a soft break',
    ])
  })

  it('leaves text that only looks like syntax far into a long string alone', () => {
    // The sniff samples the first 500 characters, so a marker past that point
    // never triggers the full parse.
    const source = `${'x'.repeat(600)} **not bold**`
    assert.equal(hasMarkdownSyntax(source), false)
    assert.equal(plain(source, 1000).join(''), source)
  })
})

describe('markdown tables', () => {
  it('renders a table as its own block, padded to the widest visible cell', () => {
    assert.deepEqual(plain('intro\n\n| name | qty |\n|---|---:|\n| 中文 | 12 |\n| b | 3 |\n\nend'), [
      'intro',
      '',
      '| name | qty |',
      '|------|-----|',
      '| 中文 |  12 |',
      '| b    |   3 |',
      '',
      'end',
    ])
  })

  it('pads a column to the three-character minimum', () => {
    assert.deepEqual(plain('| a | b |\n|---|---|\n| 1 | 2 |'), ['| a   | b   |', '|-----|-----|', '| 1   | 2   |'])
  })
})

describe('markdown body component', () => {
  /** A body under a fresh policy, plus the failures that policy recorded. */
  function body(text: string, color = true): { component: MarkdownBodyComponent; errors: unknown[] } {
    const errors: unknown[] = []
    const palette = createPalette(color)
    const policy: MarkdownPolicy = {
      mode: 'claude',
      theme: claudeMarkdownTheme,
      onError: (error: unknown) => { errors.push(error) },
    }
    return { component: new MarkdownBodyComponent(text, palette, markdownTheme(palette), policy), errors }
  }

  it('renders one width once and re-renders after an invalidation', () => {
    // The transcript re-renders every mounted body on every frame, so a body
    // that re-lexes per frame makes a long conversation quadratic while one
    // message streams. The rows are a pure function of the width here: a
    // changed body arrives as a new component.
    const { component } = body('# Title\n\nSome **bold** prose.')
    const first = component.render(40)
    assert.equal(component.render(40), first, 'the same width returns the same array')
    assert.notEqual(component.render(30), first, 'a new width re-renders')
    component.invalidate()
    assert.notEqual(component.render(40), first, 'and an invalidation drops what a theme change invalidated')
  })

  it('keeps a link readable without color by degrading to the bare URL', () => {
    // OSC 8 is the only place the href lives, and the no-color path strips every
    // escape: emitting the hyperlink anyway would delete the URL outright.
    const { component } = body('see [the docs](https://example.com/guide)', false)
    assert.deepEqual(component.render(60), ['see https://example.com/guide'])
  })

  it('leaves the words on screen when neither renderer can parse the body', () => {
    // pi's parser overflows the stack around 36 levels of nesting and this port
    // around 1500, so a deep enough document defeats both. Losing the styling is
    // the cost; losing the answer, or the frame, is not.
    const source = `${'>'.repeat(3_000)} still readable`
    const { component, errors } = body(source, false)
    const rows = component.render(40)
    assert.equal(errors.length, 1, 'the demotion is reported exactly once')
    assert.ok(rows.join('').includes('still readable'), `the text survives both failures:\n${rows.join('\n')}`)
  })
})

describe('markdown edges', () => {
  it('renders empty and whitespace-only input as no rows', () => {
    assert.deepEqual(plain(''), [])
    assert.deepEqual(plain('   \n\n  '), [])
  })

  it('routes a thematic break through the hr slot', () => {
    assert.deepEqual(plain('a\n\n---\n\nb'), ['a', '', 'R<--->', 'b'])
  })

  it('renders an image as its URL and drops raw HTML', () => {
    assert.deepEqual(plain('![alt](https://example.com/i.png)'), ['https://example.com/i.png'])
    assert.deepEqual(plain('<div>hidden</div>'), [])
  })

  it('unescapes a markdown escape', () => {
    assert.deepEqual(plain('a \\* b'), ['a * b'])
  })
})

/**
 * The input frame's inline prompt, at the component boundary rather than through
 * a mounted TUI: what {@link HintEditor} owns is a pure function of the render
 * width, the prompt text and the editor's own content.
 *
 * Half of these cases are deliberately about pi-tui's private render shape —
 * row 0 is the top rule, content starts at row 1, every content row opens with
 * the editor's padding. `HintEditor` reads that shape to place the prompt and
 * the placeholder, so a pi-tui upgrade that rearranges it has to fail here
 * rather than on someone's screen.
 * @module dsh-tui/tests/unit/editor-prompt
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  CURSOR_MARKER,
  type EditorTheme,
  type TUI,
  stripTerminalSequences,
  visibleWidth,
} from '@earendil-works/pi-tui'
import { HintEditor } from '../../src/chat/helpers.ts'
import { createPalette, selectTheme } from '../../src/components/theme.ts'
import { resolveTuiConfig } from '../../src/config.ts'
import { parseTuiPromptTemplate, renderTuiPromptTemplate } from '../../src/prompt.ts'

/** Color off: every assertion here is about columns and text, not escapes. */
const palette = createPalette(false)

/** The mounted editor's theme, with the frame rule left uncolored. */
const EDITOR_THEME: EditorTheme = {
  borderColor: (text: string) => text,
  selectList: selectTheme(palette),
}

/** The prompt this UI ships: `❯` is one column, its gap the second. */
const PROMPT = '❯ '

/** Render width used by the fixed-shape cases. */
const WIDTH = 40

/**
 * Build an unmounted editor over a fake TUI: `render` reads only the terminal's
 * row count (its visible-line budget), and edits only ask for a redraw.
 * @param options - Terminal rows and editor padding to construct with.
 * @returns The editor, focused off until a case turns it on.
 */
function mountEditor(options: { readonly rows?: number; readonly paddingX?: number } = {}): HintEditor {
  const tui = {
    terminal: { rows: options.rows ?? 32 },
    requestRender: () => {},
  } as unknown as TUI
  return new HintEditor(tui, EDITOR_THEME, { paddingX: options.paddingX ?? 1 })
}

/** The rendered rows with escapes removed, which is what reaches the screen. */
function plain(lines: readonly string[]): string[] {
  return lines.map(line => stripTerminalSequences(line))
}

/**
 * Assert every rendered row occupies exactly the render width.
 * @param lines - Rendered rows.
 * @param width - Columns the frame was rendered at.
 */
function assertFullWidth(lines: readonly string[], width: number): void {
  for (const [index, line] of lines.entries()) {
    assert.equal(visibleWidth(line), width, `row ${index} spans the frame: ${JSON.stringify(stripTerminalSequences(line))}`)
  }
}

describe('pi-tui editor frame shape', () => {
  it('rules row 0 and the last row, and starts content at row 1', () => {
    const editor = mountEditor()
    editor.setText('hello')
    const rows = plain(editor.render(WIDTH))

    assert.equal(rows.length, 3)
    assert.equal(rows[0], '─'.repeat(WIDTH))
    assert.equal(rows[2], '─'.repeat(WIDTH))
    assert.equal(rows[1], ` hello${' '.repeat(WIDTH - 7)} `)
  })

  it('opens every content row with the editor padding, which is how rules are told apart', () => {
    const editor = mountEditor()
    // Dashes typed into the editor: they only stay distinguishable from a rule
    // because the content row keeps its leading padding column.
    editor.setText('────')
    const rows = plain(editor.render(WIDTH))

    assert.ok(rows[1]?.startsWith(' '), `content row keeps its padding: ${JSON.stringify(rows[1])}`)
    assert.ok(!rows[1]?.startsWith('─'))
  })
})

describe('editor inline prompt', () => {
  it('puts the prompt on the first content row and leaves the rules whole', () => {
    const editor = mountEditor()
    editor.promptPrefix = PROMPT
    editor.setText('hello')
    const rows = plain(editor.render(WIDTH))

    assert.equal(rows[0], '─'.repeat(WIDTH))
    assert.equal(rows[2], '─'.repeat(WIDTH))
    assert.equal(rows[1], `${PROMPT}hello${' '.repeat(WIDTH - 7)}`)
    assertFullWidth(editor.render(WIDTH), WIDTH)
  })

  it('leaves exactly one column between the caret and the text, padding included', () => {
    // The gap the user sees is the whole point: `❯ ` plus pi-tui's own padding
    // column used to render two spaces where Claude Code renders one, on the
    // typed row and the placeholder row alike.
    const editor = mountEditor()
    editor.promptPrefix = PROMPT
    editor.hint = 'ask anything'
    const placeholder = plain(editor.render(WIDTH))[1] ?? ''
    editor.setText('typed')
    const typed = plain(editor.render(WIDTH))[1] ?? ''

    assert.equal(placeholder.indexOf('ask'), 2)
    assert.equal(typed.indexOf('typed'), 2)
    assert.ok(!typed.startsWith('❯  '), `one space after the caret: ${JSON.stringify(typed)}`)
  })

  it('keeps pi-tui\'s padding when the prompt supplies no gap of its own', () => {
    const editor = mountEditor()
    editor.promptPrefix = '>'
    editor.setText('typed')

    // Nothing to absorb: the padding column is the only separator there is.
    assert.equal(plain(editor.render(WIDTH))[1]?.indexOf('typed'), 2)
    assertFullWidth(editor.render(WIDTH), WIDTH)
  })

  it('indents continuation rows by the prompt width instead of repeating it', () => {
    const editor = mountEditor()
    editor.promptPrefix = PROMPT
    editor.setText('first\nsecond\nthird')
    const rows = plain(editor.render(WIDTH))

    assert.equal(rows.length, 5)
    assert.equal(rows[1], `${PROMPT}first${' '.repeat(WIDTH - 7)}`)
    assert.equal(rows[2], `  second${' '.repeat(WIDTH - 8)}`)
    assert.equal(rows[3], `  third${' '.repeat(WIDTH - 7)}`)
    // One text column for every row: the prompt shifts row 1 by exactly what
    // the indent shifts the rows under it.
    assert.deepEqual(
      [rows[1]?.indexOf('first'), rows[2]?.indexOf('second'), rows[3]?.indexOf('third')],
      [2, 2, 2],
    )
  })

  it('keeps the frame at the render width through wrapping, CJK and an ANSI prompt', () => {
    const editor = mountEditor()
    editor.promptPrefix = '\u001B[2m❯\u001B[0m '
    assert.equal(visibleWidth(editor.promptPrefix), 2)
    // Double-width text that cannot divide the remaining columns evenly, long
    // enough to wrap several times.
    editor.setText('中文输入换行测试'.repeat(6))
    const lines = editor.render(WIDTH)

    assert.ok(lines.length > 4, `the sample wraps: ${lines.length} rows`)
    assertFullWidth(lines, WIDTH)
    assert.equal(stripTerminalSequences(lines[0] ?? ''), '─'.repeat(WIDTH))
    assert.equal(stripTerminalSequences(lines.at(-1) ?? ''), '─'.repeat(WIDTH))
  })

  it('extends a scroll indicator rule to the full width', () => {
    // 10 rows budget 5 visible lines, so an 8-line draft scrolls.
    const editor = mountEditor({ rows: 10 })
    editor.promptPrefix = PROMPT
    editor.setText(Array.from({ length: 8 }, (_line, index) => `line ${index}`).join('\n'))
    const lines = editor.render(WIDTH)
    const rows = plain(lines)

    assert.ok(rows[0]?.startsWith('─── ↑ 3 more '), `row 0 is the scroll indicator: ${JSON.stringify(rows[0])}`)
    assert.ok(rows[0]?.endsWith('─'))
    assertFullWidth(lines, WIDTH)
  })

  it('renders bare when the width cannot seat the prompt and a text column', () => {
    const editor = mountEditor()
    editor.promptPrefix = PROMPT
    editor.setText('x')

    assertFullWidth(editor.render(2), 2)
    assert.equal(plain(editor.render(2))[0], '──')
  })
})

describe('editor cursor marker', () => {
  it('emits the marker after the prompt, so the hardware cursor moves with the text', () => {
    const editor = mountEditor()
    editor.focused = true
    editor.promptPrefix = PROMPT
    editor.setText('hi')
    const lines = editor.render(WIDTH)
    const row = lines[1] ?? ''
    const marker = row.indexOf(CURSOR_MARKER)

    assert.ok(marker > 0, 'the first content row carries the cursor marker')
    // What `TUI.extractCursorPosition` computes: prompt (2) + padding (1) + `hi`.
    assert.equal(visibleWidth(row.slice(0, marker)), 4)
    assert.ok(row.slice(0, marker).startsWith(PROMPT))
    assertFullWidth(lines, WIDTH)
  })
})

describe('editor placeholder', () => {
  it('lands on the first content row, prompt included, with both rules intact', () => {
    const editor = mountEditor()
    editor.promptPrefix = PROMPT
    editor.hint = 'press enter to steer and esc to cancel'
    const lines = editor.render(WIDTH)
    const rows = plain(lines)

    assert.equal(rows[0], '─'.repeat(WIDTH))
    assert.equal(rows[2], '─'.repeat(WIDTH))
    assert.ok(rows[1]?.startsWith(`${PROMPT}press enter to steer`), `placeholder row: ${JSON.stringify(rows[1])}`)
    assertFullWidth(lines, WIDTH)
  })

  it('truncates to the columns the prompt leaves rather than overflowing them', () => {
    const editor = mountEditor()
    editor.promptPrefix = PROMPT
    editor.hint = 'x'.repeat(WIDTH * 2)
    const lines = editor.render(WIDTH)

    assertFullWidth(lines, WIDTH)
    assert.equal(plain(lines)[1], `${PROMPT}${'x'.repeat(WIDTH - 2)}`)
  })

  it('gives way to typed text', () => {
    const editor = mountEditor()
    editor.promptPrefix = PROMPT
    editor.hint = 'placeholder'
    editor.setText('typed')

    assert.equal(plain(editor.render(WIDTH))[1], `${PROMPT}typed${' '.repeat(WIDTH - 7)}`)
  })
})

describe('editor history mirror', () => {
  it('keeps pi-tui\'s own rules, so Ctrl+R and the up arrow see one history', () => {
    const editor = mountEditor()
    editor.addToHistory('first prompt')
    editor.addToHistory('   ')
    editor.addToHistory('second prompt')
    editor.addToHistory('second prompt')
    editor.addToHistory('  third prompt  ')

    assert.deepEqual(editor.historyEntries(), ['third prompt', 'second prompt', 'first prompt'])
  })

  it('drops the oldest entry past pi-tui\'s own limit', () => {
    const editor = mountEditor()
    for (let index = 0; index < 105; index += 1) editor.addToHistory(`prompt ${String(index)}`)

    assert.equal(editor.historyEntries().length, 100)
    assert.equal(editor.historyEntries()[0], 'prompt 104')
    assert.equal(editor.historyEntries().at(-1), 'prompt 5')
  })
})

describe('default input prompt', () => {
  it('renders exactly the two-column caret with no prompt values registered', () => {
    const template = resolveTuiConfig(undefined).theme.inputPrompt
    const rendered = renderTuiPromptTemplate(parseTuiPromptTemplate(template), () => undefined)

    assert.equal(rendered, PROMPT)
    assert.equal(visibleWidth(rendered), 2)
  })

  it('stays a template a deployment can replace', () => {
    const template = resolveTuiConfig({ theme: { inputPrompt: '${symbol} ${indicator}' } }).theme.inputPrompt
    const rendered = renderTuiPromptTemplate(
      parseTuiPromptTemplate(template),
      name => (name === 'symbol' ? 'dsh' : '> '),
    )

    assert.equal(rendered, 'dsh > ')
  })
})

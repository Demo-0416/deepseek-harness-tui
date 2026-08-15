/**
 * The `$EDITOR` port on its own: which editor a host resolves to, how a
 * command line is split, and what one round trip through a temp file produces.
 *
 * The editors are shell scripts written into a temporary directory, so every
 * case exercises a real spawn — the discovery rules and the exit-code contract
 * are exactly the parts a mocked child process would not have tested.
 * @module dsh-tui/tests/unit/external-editor
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import {
  editTextExternally,
  parseEditorCommandLine,
  resolveExternalEditor,
  type ExternalEditorSpec,
} from '../../src/chat/external-editor.ts'

/** POSIX shell fixtures; the port itself is exercised on Windows only through the mounted suite. */
const skipOnWindows = process.platform === 'win32' ? 'POSIX shell fixtures' : false

/** Where the fixture editors and the fake `PATH` directories live. */
let root = ''
/** Directory holding the editor scripts. */
let scripts = ''
/** A `PATH` directory holding a `nano` and a `code`, for the discovery cases. */
let onPath = ''
/** A `PATH` directory holding nothing at all. */
let empty = ''

/** Write one executable shell script and hand back its absolute path. */
async function script(directory: string, name: string, body: string): Promise<string> {
  const file = join(directory, name)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `#!/bin/sh\n${body}\n`, { encoding: 'utf8', mode: 0o755 })
  await chmod(file, 0o755)
  return file
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-editor-'))
  scripts = join(root, 'scripts')
  onPath = join(root, 'bin')
  empty = join(root, 'empty')
  await mkdir(empty, { recursive: true })
  await script(scripts, 'write.sh', 'printf \'EDITED\\n\' > "$1"')
  await script(scripts, 'write2.sh', 'printf \'EDITED\\n\\n\' > "$1"')
  await script(scripts, 'noop.sh', 'exit 0')
  await script(scripts, 'blank.sh', ': > "$1"')
  await script(scripts, 'fail.sh', 'exit 3')
  await script(scripts, 'capture.sh', 'cp "$1" "$TUI_EDITOR_CAPTURE"\nprintf \'%s\' "$1" > "$TUI_EDITOR_PATH"')
  await script(onPath, 'nano', 'exit 0')
  await script(onPath, 'code', 'exit 0')
})

after(async () => {
  await rm(root, { recursive: true, force: true })
})

/** A spec pointing straight at one fixture, for the cases that skip resolution. */
function spec(command: string, args: readonly string[] = []): ExternalEditorSpec {
  return { command, args, name: 'fixture', source: 'config' }
}

describe('resolveExternalEditor', { skip: skipOnWindows }, () => {
  it('reads the empty string as "do not spawn one"', () => {
    assert.deepEqual(resolveExternalEditor(''), { kind: 'disabled' })
    assert.deepEqual(resolveExternalEditor('   '), { kind: 'disabled' })
  })

  it('prefers $VISUAL over $EDITOR', () => {
    const resolution = resolveExternalEditor(undefined, {
      VISUAL: join(scripts, 'write.sh'),
      EDITOR: join(scripts, 'fail.sh'),
    })
    assert.equal(resolution.kind, 'editor')
    assert.equal(resolution.kind === 'editor' ? resolution.editor.source : '', 'visual')
    assert.equal(resolution.kind === 'editor' ? resolution.editor.command : '', join(scripts, 'write.sh'))
  })

  it('falls back to $EDITOR when $VISUAL is unset', () => {
    const resolution = resolveExternalEditor(undefined, { EDITOR: join(scripts, 'write.sh') })
    assert.equal(resolution.kind === 'editor' ? resolution.editor.source : '', 'editor')
  })

  it('discovers a terminal editor on PATH when nothing is exported', () => {
    const resolution = resolveExternalEditor(undefined, { PATH: onPath })
    assert.equal(resolution.kind, 'editor')
    assert.equal(resolution.kind === 'editor' ? resolution.editor.source : '', 'fallback')
    assert.equal(resolution.kind === 'editor' ? resolution.editor.command : '', join(onPath, 'nano'))
  })

  it('reports that there is none when PATH answers nothing either', () => {
    assert.deepEqual(resolveExternalEditor(undefined, { PATH: empty }), { kind: 'unset' })
  })

  it('names a configured editor PATH does not answer, rather than substituting one', () => {
    assert.deepEqual(
      resolveExternalEditor('definitely-not-here', { PATH: onPath }),
      { kind: 'unresolved', command: 'definitely-not-here' },
    )
  })

  it('names a configured path that is not an executable file', () => {
    assert.deepEqual(
      resolveExternalEditor('./relative/missing', { PATH: onPath }),
      { kind: 'unresolved', command: './relative/missing' },
    )
  })

  it('adds a GUI editor\'s wait flag, and does not add it twice', () => {
    const added = resolveExternalEditor('code', { PATH: onPath })
    assert.deepEqual(added.kind === 'editor' ? added.editor.args : [], ['-w'])
    const already = resolveExternalEditor('code -w', { PATH: onPath })
    assert.deepEqual(already.kind === 'editor' ? already.editor.args : [], ['-w'])
  })
})

describe('parseEditorCommandLine', () => {
  it('keeps a quoted path with spaces in one piece', () => {
    assert.deepEqual(parseEditorCommandLine('"/pa th/ed" -w --flag'), {
      command: '/pa th/ed',
      args: ['-w', '--flag'],
    })
  })

  it('splits a plain command line on whitespace', () => {
    assert.deepEqual(parseEditorCommandLine('emacs  -nw'), { command: 'emacs', args: ['-nw'] })
  })

  it('answers an empty line with an empty command', () => {
    assert.deepEqual(parseEditorCommandLine(''), { command: '', args: [] })
  })
})

describe('editTextExternally', { skip: skipOnWindows }, () => {
  it('takes back what the editor saved, minus one trailing newline', async () => {
    assert.deepEqual(await editTextExternally('hello', spec(join(scripts, 'write.sh'))), {
      kind: 'edited',
      text: 'EDITED',
    })
  })

  it('leaves a deliberate blank last line alone', async () => {
    // Upstream's rule exactly (`promptEditor.ts:166`): one trailing newline is
    // the editor adding it, two are the user asking for a blank line.
    assert.deepEqual(await editTextExternally('hello', spec(join(scripts, 'write2.sh'))), {
      kind: 'edited',
      text: 'EDITED\n\n',
    })
  })

  it('gives the draft straight back when the editor saved nothing', async () => {
    assert.deepEqual(await editTextExternally('hello', spec(join(scripts, 'noop.sh'))), {
      kind: 'edited',
      text: 'hello',
    })
  })

  it('reads an emptied file as an emptied draft', async () => {
    assert.deepEqual(await editTextExternally('hello', spec(join(scripts, 'blank.sh'))), {
      kind: 'edited',
      text: '',
    })
  })

  it('reports a non-zero exit and does not claim any text', async () => {
    assert.deepEqual(await editTextExternally('hello', spec(join(scripts, 'fail.sh'))), {
      kind: 'exit',
      code: 3,
    })
  })

  it('reports a child that cannot be spawned at all', async () => {
    const result = await editTextExternally('hello', spec(join(scripts, 'no-such-editor.sh')))
    assert.equal(result.kind, 'failed')
    assert.match(result.kind === 'failed' ? result.error : '', /ENOENT/u)
  })

  it('hands the editor the draft verbatim, in a temp file it cleans up', async () => {
    const captured = join(root, 'captured.txt')
    const recorded = join(root, 'path.txt')
    const draft = 'first line\n[paste #1 +40 lines]\n  indented last line'
    const result = await editTextExternally('unused', spec(join(scripts, 'capture.sh')), {
      env: { ...process.env, TUI_EDITOR_CAPTURE: captured, TUI_EDITOR_PATH: recorded },
    })
    assert.equal(result.kind, 'edited')
    // The `capture.sh` copy is of the file as it was handed over.
    const handedOver = await editTextExternally(draft, spec(join(scripts, 'capture.sh')), {
      env: { ...process.env, TUI_EDITOR_CAPTURE: captured, TUI_EDITOR_PATH: recorded },
    })
    assert.equal(handedOver.kind, 'edited')
    assert.equal(await readFile(captured, 'utf8'), draft)

    const temp = await readFile(recorded, 'utf8')
    assert.equal(existsSync(temp), false, 'the temp file is removed on the way out')
    assert.ok(temp.startsWith(tmpdir()), `${temp} is under ${tmpdir()}`)
    assert.match(temp, /dsh-prompt-[0-9a-f-]+\.md$/u)
  })
})

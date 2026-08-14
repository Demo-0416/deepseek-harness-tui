/**
 * Clipboard-write unit tests: path selection from env state, the OSC 52
 * sequence shape, tmux passthrough wrapping, and which subprocesses each
 * path launches. The runner is injected, so no test touches the real
 * clipboard or spawns a process.
 * @module dsh-tui/tests/unit/clipboard
 */

import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'
import {
  _resetLinuxCopyCache,
  clipboardPath,
  copyToClipboard,
  type QuietRunner,
} from '../../src/chat/clipboard.ts'

const onDarwin = process.platform === 'darwin'

/** Records every launch; exit code comes from `codes` by command name (default 0). */
function recordingRunner(codes: Record<string, number> = {}): {
  run: QuietRunner
  launches: { file: string; args: readonly string[]; input: string }[]
} {
  const launches: { file: string; args: readonly string[]; input: string }[] = []
  return {
    launches,
    run: (file, args, input) => {
      launches.push({ file, args, input })
      return Promise.resolve(codes[file] ?? 0)
    },
  }
}

const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64')

beforeEach(() => { _resetLinuxCopyCache() })

describe('clipboardPath', () => {
  it('reports native on a local darwin session', { skip: !onDarwin }, () => {
    assert.equal(clipboardPath({}), 'native')
    // SSH_TTY alone must NOT flip the path: tmux panes keep a stale SSH_TTY
    // after local reattach, while SSH_CONNECTION clears.
    assert.equal(clipboardPath({ SSH_TTY: '/dev/ttys000' }), 'native')
  })

  it('prefers the tmux buffer over SSH, and OSC 52 with neither', () => {
    assert.equal(clipboardPath({ SSH_CONNECTION: '1.2.3.4 5 6.7.8.9 22', TMUX: '/tmp/t,1,0' }), 'tmux-buffer')
    assert.equal(clipboardPath({ SSH_CONNECTION: '1.2.3.4 5 6.7.8.9 22' }), 'osc52')
  })
})

describe('copyToClipboard', () => {
  it('returns raw OSC 52 outside tmux and pipes the text to the native tool', { skip: !onDarwin }, async () => {
    const { run, launches } = recordingRunner()
    const sequence = await copyToClipboard('hello ✓', {}, run)
    assert.equal(sequence, `\x1b]52;c;${b64('hello ✓')}\x07`)
    assert.deepEqual(launches.map(l => l.file), ['pbcopy'])
    assert.equal(launches[0]?.input, 'hello ✓')
  })

  it('terminates with ST instead of BEL on Kitty', { skip: !onDarwin }, async () => {
    const { run } = recordingRunner()
    const sequence = await copyToClipboard('x', { KITTY_WINDOW_ID: '1' }, run)
    assert.equal(sequence, `\x1b]52;c;${b64('x')}\x1b\\`)
  })

  it('skips the native tool over SSH — it would write the remote clipboard', async () => {
    const { run, launches } = recordingRunner()
    const sequence = await copyToClipboard('remote', { SSH_CONNECTION: 'a 1 b 22' }, run)
    assert.equal(sequence, `\x1b]52;c;${b64('remote')}\x07`)
    assert.deepEqual(launches, [])
  })

  it('loads the tmux buffer with -w and DCS-wraps the returned OSC 52', async () => {
    const { run, launches } = recordingRunner()
    const env = { SSH_CONNECTION: 'a 1 b 22', TMUX: '/tmp/t,1,0' }
    const sequence = await copyToClipboard('buf', env, run)
    assert.deepEqual(launches, [{ file: 'tmux', args: ['load-buffer', '-w', '-'], input: 'buf' }])
    // Passthrough: ESC P tmux ; <payload with ESC doubled> ESC backslash.
    assert.equal(sequence, `\x1bPtmux;\x1b\x1b]52;c;${b64('buf')}\x07\x1b\\`)
  })

  it('drops -w for iTerm2, whose sessions tmux OSC 52 emission crashes', async () => {
    const { run, launches } = recordingRunner()
    const env = { SSH_CONNECTION: 'a 1 b 22', TMUX: '/tmp/t,1,0', LC_TERMINAL: 'iTerm2' }
    await copyToClipboard('buf', env, run)
    assert.deepEqual(launches[0]?.args, ['load-buffer', '-'])
  })

  it('falls back to raw OSC 52 when tmux load-buffer fails', async () => {
    const { run } = recordingRunner({ tmux: 1 })
    const env = { SSH_CONNECTION: 'a 1 b 22', TMUX: '/tmp/t,1,0' }
    const sequence = await copyToClipboard('buf', env, run)
    assert.equal(sequence, `\x1b]52;c;${b64('buf')}\x07`)
  })
})

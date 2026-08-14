/**
 * System-clipboard writes for the TUI, ported from Claude Code's
 * `src/ink/termio/osc.ts` (`setClipboard` and its helpers). Three paths, in
 * order of confidence:
 *
 * - native: a local clipboard utility (pbcopy/wl-copy/xclip/xsel/clip.exe)
 *   always works locally, where OSC 52 depends on terminal settings (iTerm2
 *   ships with it disabled, VS Code prompts on first use).
 * - tmux buffer: inside tmux the paste buffer is always reachable — works
 *   over SSH, survives detach/reattach — and `-w` (tmux 3.2+) propagates to
 *   the outer terminal's clipboard through tmux's own OSC 52 emission.
 * - OSC 52: the escape sequence itself, for remote sessions with no tmux;
 *   best-effort by design.
 * @module @deepseek-ai/dsh-tui/chat/clipboard
 */

import { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'

const ESC = '\x1b'
const BEL = '\x07'
/** String Terminator (ESC \) — Kitty beeps on BEL-terminated OSC. */
const ST = `${ESC}\\`

/** Runs a command with text piped to stdin; resolves with its exit code, never rejects. */
export type QuietRunner = (file: string, args: readonly string[], input: string) => Promise<number>

/** `execFile` with stdin input and a 2s cap, collapsed to an exit code. */
const runQuietly: QuietRunner = (file, args, input) =>
  new Promise((resolve) => {
    const child = execFile(file, [...args], { timeout: 2000 }, (error) => {
      resolve(error === null ? 0 : typeof error.code === 'number' ? error.code : 1)
    })
    if (child.stdin === null) {
      child.kill()
      resolve(1)
      return
    }
    child.stdin.on('error', () => { /* EPIPE from a missing binary; the callback reports it */ })
    child.stdin.end(input)
  })

/**
 * Which path {@link copyToClipboard} will take, from env state alone.
 * Synchronous so the caller can flash an honest confirmation without
 * awaiting the copy.
 *
 * pbcopy gating uses SSH_CONNECTION specifically, not SSH_TTY — tmux panes
 * inherit SSH_TTY forever even after local reattach, but SSH_CONNECTION is
 * in tmux's default update-environment set and gets cleared.
 */
export type ClipboardPath = 'native' | 'tmux-buffer' | 'osc52'

export function clipboardPath(env: NodeJS.ProcessEnv = process.env): ClipboardPath {
  if (process.platform === 'darwin' && env['SSH_CONNECTION'] === undefined) return 'native'
  if (env['TMUX'] !== undefined) return 'tmux-buffer'
  return 'osc52'
}

/** OSC 52 clipboard write: ESC ] 52 ; c ; base64 — ST on Kitty (BEL beeps there), BEL elsewhere. */
function osc52(b64: string, env: NodeJS.ProcessEnv): string {
  const kitty = env['KITTY_WINDOW_ID'] !== undefined || (env['TERM'] ?? '').includes('kitty')
  return `${ESC}]52;c;${b64}${kitty ? ST : BEL}`
}

/**
 * tmux DCS passthrough: ESC P tmux ; payload ESC \ with inner ESCs doubled.
 * Needs `allow-passthrough on`; without it tmux silently drops the whole DCS
 * — no junk, no worse than an unwrapped OSC the multiplexer would eat.
 */
function tmuxPassthrough(payload: string): string {
  return `${ESC}Ptmux;${payload.replaceAll(ESC, ESC + ESC)}${ST}`
}

/**
 * Load text into tmux's paste buffer. `-w` also propagates to the outer
 * terminal's clipboard, but is dropped for iTerm2: tmux's own OSC 52
 * emission (empty selection param) crashes iTerm2 sessions over SSH.
 */
async function tmuxLoadBuffer(text: string, env: NodeJS.ProcessEnv, run: QuietRunner): Promise<boolean> {
  if (env['TMUX'] === undefined) return false
  const args = env['LC_TERMINAL'] === 'iTerm2' ? ['load-buffer', '-'] : ['load-buffer', '-w', '-']
  return await run('tmux', args, text) === 0
}

// Linux clipboard tool: undefined = not yet probed, null = none available.
// Probe order: wl-copy (Wayland) → xclip (X11) → xsel (X11 fallback);
// cached after the first attempt so repeated copies skip the probe chain.
let linuxCopy: 'wl-copy' | 'xclip' | 'xsel' | null | undefined

/** @internal test-only */
export function _resetLinuxCopyCache(): void {
  linuxCopy = undefined
}

const LINUX_ARGS = {
  'wl-copy': [] as readonly string[],
  'xclip': ['-selection', 'clipboard'] as readonly string[],
  'xsel': ['--clipboard', '--input'] as readonly string[],
} as const

/**
 * Shell out to a native clipboard utility. Fire-and-forget: failures are
 * silent, since the OSC 52 sequence the caller writes may still succeed.
 * Never called over SSH — there these would write the REMOTE clipboard.
 */
function copyNative(text: string, run: QuietRunner): void {
  switch (process.platform) {
    case 'darwin':
      void run('pbcopy', [], text)
      return
    case 'linux': {
      if (linuxCopy === null) return
      if (linuxCopy !== undefined) {
        void run(linuxCopy, LINUX_ARGS[linuxCopy], text)
        return
      }
      void (async () => {
        for (const tool of ['wl-copy', 'xclip', 'xsel'] as const) {
          if (await run(tool, LINUX_ARGS[tool], text) === 0) {
            linuxCopy = tool
            return
          }
        }
        linuxCopy = null
      })()
      return
    }
    case 'win32':
      // clip.exe is always present; system-locale Unicode is imperfect but
      // acceptable for a fallback path.
      void run('clip', [], text)
      return
  }
}

/**
 * Write `text` to the system clipboard and return the escape sequence the
 * caller must write to the terminal to finish the job.
 *
 * The native utility fires FIRST, before the tmux await — a quick
 * focus-switch right after copying must not beat pbcopy to the paste. When
 * the tmux buffer loads, the returned OSC 52 is DCS-wrapped so it tunnels to
 * the outer terminal; our sequence carries an explicit `c` selection, which
 * sidesteps the iTerm2 crash tmux's own empty-param variant triggers.
 * @param text - what to copy.
 * @param env - process env override for tests.
 * @param run - subprocess runner override for tests.
 * @returns the sequence to write to the terminal (raw OSC 52 outside tmux).
 */
export async function copyToClipboard(
  text: string,
  env: NodeJS.ProcessEnv = process.env,
  run: QuietRunner = runQuietly,
): Promise<string> {
  const b64 = Buffer.from(text, 'utf8').toString('base64')
  if (env['SSH_CONNECTION'] === undefined) copyNative(text, run)
  const tmuxBufferLoaded = await tmuxLoadBuffer(text, env, run)
  // The inner OSC uses BEL regardless of terminal: ST's ESC would need
  // doubling inside the passthrough too, and BEL works everywhere for OSC 52.
  if (tmuxBufferLoaded) return tmuxPassthrough(`${ESC}]52;c;${b64}${BEL}`)
  return osc52(b64, env)
}

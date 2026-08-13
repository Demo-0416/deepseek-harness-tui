/**
 * Zero-state helpers for the interactive chat channel: prompt-directory and
 * Git-branch formatting, the placeholder editor, and banner-reveal timing
 * constants. None of these close over channel state. Log-derived presentation
 * (transcript rows, compaction markers, reference cards) belongs to the fold in
 * `core/nodes.ts`, not here.
 * @module @deepseek-ai/dsh-tui/chat/helpers
 */

import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import {
  CURSOR_MARKER,
  Editor,
  truncateToWidth,
  visibleWidth,
} from '@earendil-works/pi-tui'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'

/** Editor that shows a placeholder without making it editable content. */
export class HintEditor extends Editor {
  /** Placeholder shown in the empty input row; `undefined` hides it. */
  hint: string | undefined
  /** Prompt text rendered before the placeholder, matching the live prompt width. */
  hintPrefix = ''

  override render(width: number): string[] {
    const lines = super.render(width)
    if (this.hint === undefined || this.getText() !== '') return lines
    const content = lines[0]
    /* v8 ignore next -- Editor always renders one content row. */
    if (content === undefined) return lines
    const padding = ' '.repeat(this.getPaddingX())
    /* v8 ignore next -- the mounted editor is focused whenever its empty-input hint is rendered. */
    const marker = this.focused ? CURSOR_MARKER : ''
    const available = Math.max(0, width - visibleWidth(padding) - visibleWidth(this.hintPrefix))
    const placeholder = truncateToWidth(this.hint, available, '')
    const used = visibleWidth(padding) + visibleWidth(this.hintPrefix) + visibleWidth(placeholder)
    lines[0] = `${padding}${this.hintPrefix}${marker}${placeholder}${' '.repeat(Math.max(0, width - used))}`
    return lines
  }
}

/**
 * Format the session working directory as a prompt label: `~` for home,
 * `~/rel` for a home-relative path, the raw path otherwise.
 * @param cwd - operational working directory from the session header.
 * @returns unescaped prompt label.
 */
export function formatCwd(cwd: string | undefined): string {
  if (cwd === undefined) return 'cwd unset'
  const home = homedir()
  const rel = relative(resolve(home), resolve(cwd))
  if (rel === '') return '~'
  /* v8 ignore next -- Windows cross-drive coverage; POSIX relative() cannot return an absolute path. */
  if (isAbsolute(rel)) return cwd
  if (rel !== '..' && !rel.startsWith(`..${sep}`)) return `~${sep}${rel}`
  return cwd
}

/**
 * Resolve the current Git branch for the prompt context line.
 * @param cwd - operational working directory to query.
 * @returns branch name, or `undefined` outside a worktree or on any failure.
 */
export function gitBranch(cwd: string): string | undefined {
  try {
    const branch = execFileSync('git', ['branch', '--show-current'], {
      cwd,
      encoding: 'utf8',
      env: scrubbedParentEnv(),
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1_000,
    }).trim()
    /* v8 ignore next -- detached-HEAD behavior is exercised by the runtime smoke, not the unit checkout. */
    return branch === '' ? undefined : branch
  } catch (_gitUnavailableOrOutsideWorktree) {
    return undefined
  }
}

/** Milliseconds between banner sweep-reveal frames (~60 fps). */
export const BANNER_REVEAL_INTERVAL_MS = 15

/** Number of sweep frames the banner reveal spreads the terminal width over. */
export const BANNER_REVEAL_STEPS = 24

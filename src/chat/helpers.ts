/**
 * Zero-state helpers for the interactive chat channel: prompt-directory and
 * Git-branch formatting, the placeholder editor, and banner-reveal timing
 * constants. None of these close over channel state. Log-derived presentation
 * (transcript rows, compaction markers, reference cards) belongs to the fold in
 * `core/nodes.ts`, not here.
 * @module @deepseek-ai/dsh-tui/chat/helpers
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CURSOR_MARKER,
  Editor,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
} from '@earendil-works/pi-tui'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'

/** The glyph pi-tui rules the editor's top and bottom frame rows with. */
const EDITOR_FRAME_GLYPH = '─'

/**
 * Editor that carries its prompt inside the frame and shows a placeholder
 * without making it editable content.
 *
 * Two pi-tui 0.84.1 render facts are load-bearing here, both pinned by
 * `tests/unit/editor-prompt.test.ts` so an upgrade that moves them fails loudly:
 *
 * - `Editor.render(width)` returns `[top frame, ...content rows, bottom frame,
 *   ...autocomplete rows]`. Row 0 is a rule (`─` repeated, or a `─── ↑ N more`
 *   scroll indicator), never text, so the first content row is row 1.
 * - Every content and autocomplete row opens with the editor's `paddingX`
 *   spaces. With `paddingX >= 1` — what the mounted editor is constructed with —
 *   a row whose first visible column is `─` can only be a frame row, which is
 *   how the two rules are found among rows this class has to indent instead.
 */
export class HintEditor extends Editor {
  /** Placeholder shown in the empty input row; `undefined` hides it. */
  hint: string | undefined
  /**
   * Prompt rendered at the start of the first content row (Claude's `❯ `), ANSI
   * allowed. Continuation rows and the autocomplete popup indent by its visible
   * width and both rules grow by the same amount, so the frame keeps the full
   * render width and the text column never moves between rows.
   */
  promptPrefix = ''

  override render(width: number): string[] {
    const prefixWidth = visibleWidth(this.promptPrefix)
    const inner = width - prefixWidth
    // A frame with no room for the prompt plus one text column renders bare
    // rather than overflowing; anything else lays the editor out inside what the
    // prompt leaves. Rendering at the full width and prepending afterwards would
    // push every filled row one column past the frame — a spurious second screen
    // line — and leave `lastWidth`, which cursor navigation wraps against, wrong.
    if (prefixWidth === 0 || inner < 1) return this.renderFrame(width)
    const lines = this.renderFrame(inner)
    const indent = ' '.repeat(prefixWidth)
    const fill = this.borderColor(EDITOR_FRAME_GLYPH.repeat(prefixWidth))
    return lines.map((line, index) => {
      if (index === 0 || stripTerminalSequences(line).startsWith(EDITOR_FRAME_GLYPH)) return `${line}${fill}`
      // The prompt lands ahead of pi-tui's zero-width cursor marker, and the TUI
      // reads the hardware cursor column as the visible width before that marker,
      // so the cursor follows the text right without any arithmetic here.
      return index === 1 ? `${this.promptPrefix}${line}` : `${indent}${line}`
    })
  }

  /**
   * Render the editor frame, replacing the sole content row with the placeholder
   * while the input is empty.
   * @param width - Columns the frame occupies, with the prompt already deducted.
   * @returns The rendered rows, prompt not yet applied.
   */
  private renderFrame(width: number): string[] {
    const lines = super.render(width)
    if (this.hint === undefined || this.getText() !== '') return lines
    const padding = ' '.repeat(this.getPaddingX())
    /* v8 ignore next -- the mounted editor is focused whenever its empty-input hint is rendered. */
    const marker = this.focused ? CURSOR_MARKER : ''
    const available = Math.max(0, width - visibleWidth(padding))
    const placeholder = truncateToWidth(this.hint, available, '')
    const used = visibleWidth(padding) + visibleWidth(placeholder)
    // Row 1, the first content row: row 0 is the top rule, and painting the
    // placeholder over it used to erase the frame's own top border.
    lines[1] = `${padding}${marker}${placeholder}${' '.repeat(Math.max(0, width - used))}`
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

/** Prefix the runner mints session ids with (`session-<uuid>`). */
const SESSION_ID_PREFIX = 'session-'

/** A minted session id's random part, the only ids worth shortening. */
const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu

/**
 * Shorten a session id for the resume banner line: `session-<uuid>` becomes the
 * uuid's first group, which is what a user types back into `--resume` and what
 * the session directory is named after. Any other identity (`main`, a launcher's
 * fixed name) is already short and is left exactly as it is.
 * @param id - the session identity.
 * @returns the display form of the id.
 */
export function shortSessionId(id: string): string {
  const bare = id.startsWith(SESSION_ID_PREFIX) ? id.slice(SESSION_ID_PREFIX.length) : id
  return SESSION_UUID.test(bare) ? bare.slice(0, 8) : bare
}

/** Directory levels searched upward for this bundle's own package.json. */
const PACKAGE_SEARCH_DEPTH = 4

/**
 * This bundle's version, for the startup banner.
 *
 * Read from the nearest package.json above the running module rather than
 * imported, because the two layouts this code runs in disagree on the relative
 * path: `src/chat/helpers.ts` under tsx, one bundled `lib/index.js` after
 * build. Neither layout has a package.json between the module and the package
 * root, so the first one found walking up is this package's. A version that
 * cannot be read is not an error — the banner simply omits it.
 * @param from - file the search starts from; defaults to this module.
 * @returns the semver string, or `undefined` when no package.json was readable.
 */
export function packageVersion(from: string = fileURLToPath(import.meta.url)): string | undefined {
  let directory = dirname(from)
  for (let level = 0; level < PACKAGE_SEARCH_DEPTH; level += 1) {
    try {
      const parsed = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as { version?: unknown }
      if (typeof parsed.version === 'string' && parsed.version !== '') return parsed.version
    } catch (_missingOrUnreadablePackage) {
      // Not this level's package.json; keep walking toward the package root.
    }
    const parent = dirname(directory)
    /* v8 ignore next -- the walk always finds this package before the filesystem root. */
    if (parent === directory) break
    directory = parent
  }
  /* v8 ignore next -- unreachable while the bundle ships its own package.json. */
  return undefined
}

/** Milliseconds between banner sweep-reveal frames (~60 fps). */
export const BANNER_REVEAL_INTERVAL_MS = 15

/** Number of sweep frames the banner reveal spreads the terminal width over. */
export const BANNER_REVEAL_STEPS = 24

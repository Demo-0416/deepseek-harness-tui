/**
 * `$VISUAL`/`$EDITOR` handoff for the input frame: which editor this host has,
 * and one round trip through a temp file.
 *
 * Ported from Claude Code's `src/utils/editor.ts` + `src/utils/promptEditor.ts`,
 * with two deliberate differences. The child is spawned by argv rather than
 * through a shell — the path is one this module invented, so a shell would only
 * add quoting bugs and an injection surface neither of us needs. And the
 * discovery fallback lists terminal editors only: a GUI editor that forks
 * returns before the user has typed anything, so the file comes back unchanged
 * and the draft looks like it was silently refused.
 * @module @deepseek-ai/dsh-tui/chat/external-editor
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, sep } from 'node:path'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { errorChain } from '@deepseek-ai/dsh-llm'
import { isExecutableFile, lookupOnPath } from './fd.ts'

/** One spawnable editor invocation. */
export interface ExternalEditorSpec {
  /** Absolute path of the binary, as `PATH` or the configuration answered it. */
  readonly command: string
  /** Arguments placed before the temp-file path, e.g. `['-w']` for VS Code. */
  readonly args: readonly string[]
  /** Name shown to the user: the command's basename. */
  readonly name: string
  /** Where the choice came from, so a refusal can name the reason. */
  readonly source: 'config' | 'visual' | 'editor' | 'fallback'
}

/** Why no editor can be launched, or which one will be. */
export type ExternalEditorResolution =
  | { readonly kind: 'editor'; readonly editor: ExternalEditorSpec }
  /** `externalEditor: ""` — the deployment said "do not spawn one". */
  | { readonly kind: 'disabled' }
  /** No configuration, no `$VISUAL`/`$EDITOR`, and no fallback on `PATH`. */
  | { readonly kind: 'unset' }
  /** A name was given and `PATH` (or the filesystem) does not answer it. */
  | { readonly kind: 'unresolved'; readonly command: string }

/** What one round trip through the editor produced. */
export type ExternalEditResult =
  /** The file as saved, with one trailing newline removed. */
  | { readonly kind: 'edited'; readonly text: string }
  /** A non-zero exit (`vim :cq`, a crash, a signal): the draft must not change. */
  | { readonly kind: 'exit'; readonly code: number }
  /** The child could not be spawned, or the temp file could not be read. */
  | { readonly kind: 'failed'; readonly error: string }

/** Editors that return immediately unless told to wait for the window to close. */
export const EDITOR_WAIT_FLAGS: Readonly<Record<string, readonly string[]>> = {
  'code': ['-w'],
  'code-insiders': ['-w'],
  'cursor': ['-w'],
  'windsurf': ['-w'],
  'codium': ['-w'],
  'subl': ['--wait'],
  'sublime_text': ['--wait'],
}

/** Terminal editors tried when nothing was configured, kindest first. */
export const FALLBACK_EDITORS: readonly string[] = process.platform === 'win32'
  ? ['notepad']
  : ['nano', 'vim', 'vi']

/** Prefix of the temp file each round trip is carried on. */
const TEMP_FILE_PREFIX = 'dsh-prompt-'

/**
 * Split an editor command line into a command word and its arguments.
 *
 * `$EDITOR` is a command line rather than a path in most of the shells that set
 * it (`code -w`, `emacs -nw`, `"/Applications/…/bin/x" -f`), so quoted paths
 * with spaces have to survive. Escapes are deliberately not interpreted: this
 * is not a shell and must not start looking like one.
 * @param value - the configured or exported command line.
 * @returns the command word and everything after it.
 */
export function parseEditorCommandLine(value: string): { command: string; args: string[] } {
  const parts: string[] = []
  let current = ''
  let quote: '"' | '\'' | undefined
  let quoted = false
  for (const character of value) {
    if (quote !== undefined) {
      if (character === quote) quote = undefined
      else current += character
      continue
    }
    if (character === '"' || character === '\'') {
      quote = character
      quoted = true
      continue
    }
    if (/\s/u.test(character)) {
      if (current !== '' || quoted) parts.push(current)
      current = ''
      quoted = false
      continue
    }
    current += character
  }
  if (current !== '' || quoted) parts.push(current)
  const [command = '', ...args] = parts
  return { command, args }
}

/**
 * Resolve one command word against the filesystem or `PATH`.
 * @param word - the command word, a bare name or a path.
 * @param env - environment whose `PATH` is searched.
 * @returns the absolute path, or `undefined` when nothing answers it.
 */
function resolveCommandWord(word: string, env: NodeJS.ProcessEnv): string | undefined {
  if (isAbsolute(word) || word.includes('/') || word.includes(sep)) {
    // A configured path is answered as configured: falling back to a different
    // binary found on `PATH` would hide the typo the pinned path exists to make
    // visible.
    return isExecutableFile(word) ? word : undefined
  }
  return lookupOnPath(word, env)
}

/**
 * Decide which editor this host hands a draft to.
 *
 * Never memoized, unlike upstream: a user who exports `$EDITOR` in another pane
 * and comes back to this one gets the editor they just set, and a test does not
 * have to defeat a cache to say what it means.
 * @param configured - the deployment's `externalEditor`; `''` disables the feature.
 * @param env - environment read for `$VISUAL`, `$EDITOR`, and `PATH`.
 * @returns the editor, or why there is none.
 */
export function resolveExternalEditor(
  configured: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ExternalEditorResolution {
  const candidates: { line: string; source: ExternalEditorSpec['source'] }[] = []
  if (configured !== undefined) {
    const setting = configured.trim()
    if (setting === '') return { kind: 'disabled' }
    candidates.push({ line: setting, source: 'config' })
  } else {
    const visual = env['VISUAL']?.trim() ?? ''
    const editor = env['EDITOR']?.trim() ?? ''
    if (visual !== '') candidates.push({ line: visual, source: 'visual' })
    else if (editor !== '') candidates.push({ line: editor, source: 'editor' })
    else for (const name of FALLBACK_EDITORS) candidates.push({ line: name, source: 'fallback' })
  }
  let firstWord: string | undefined
  for (const candidate of candidates) {
    const { command: word, args } = parseEditorCommandLine(candidate.line)
    firstWord ??= word
    if (word === '') continue
    const command = resolveCommandWord(word, env)
    // Discovery walks the whole fallback list; a name someone stated is
    // answered once, so a typo is reported rather than replaced.
    if (command === undefined) {
      if (candidate.source === 'fallback') continue
      return { kind: 'unresolved', command: word }
    }
    const name = basename(word)
    const waitFlag = EDITOR_WAIT_FLAGS[name] ?? []
    const missing = waitFlag.filter(flag => !args.includes(flag))
    return {
      kind: 'editor',
      editor: { command, args: [...missing, ...args], name, source: candidate.source },
    }
  }
  // Nothing on `PATH` when discovering; a configured blank word when not.
  return configured === undefined ? { kind: 'unset' } : { kind: 'unresolved', command: firstWord ?? '' }
}

/** Drop the one trailing newline an editor adds, and no more (upstream's `promptEditor.ts:166`). */
function trimOneTrailingNewline(text: string): string {
  return text.endsWith('\n') && !text.endsWith('\n\n') ? text.slice(0, -1) : text
}

/**
 * Run the editor on one file and report how it ended.
 * @param editor - the resolved invocation.
 * @param file - the temp file to open.
 * @param options - working directory and environment for the child.
 * @returns the exit code; a signal counts as 128, the way a shell reports one.
 */
function runEditor(
  editor: ExternalEditorSpec,
  file: string,
  options: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv } = {},
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    // No timeout: the user is editing, and an hour is a legitimate edit. Not
    // detached either, so Ctrl+C reaches the foreground process group and the
    // editor answers it rather than this terminal.
    // A workspace that no longer exists — a resumed session whose directory was
    // deleted — must not turn into an ENOENT that reads as "the editor is
    // missing". The edit is about the draft, not about the directory.
    const cwd = options.cwd !== undefined && existsSync(options.cwd) ? options.cwd : process.cwd()
    const child = spawn(editor.command, [...editor.args, file], {
      stdio: 'inherit',
      cwd,
      env: options.env ?? scrubbedParentEnv(),
      windowsHide: false,
    })
    child.on('error', reject)
    child.on('close', (code, signal) => { resolve(signal !== null ? 128 : code ?? 0) })
  })
}

/**
 * Hand `text` to an editor and take back what was saved.
 *
 * The file lives in the system temp directory rather than the workspace: a
 * draft in the working tree would be indexed by `@` completion and readable by
 * the agent's own file tools, which is not what someone typing into an input
 * frame is agreeing to. It is created `0600` and removed on both outcomes.
 * @param text - the draft to edit.
 * @param editor - the resolved invocation.
 * @param options - working directory and environment for the child.
 * @returns the saved text, the non-zero exit, or the failure.
 */
export async function editTextExternally(
  text: string,
  editor: ExternalEditorSpec,
  options: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv } = {},
): Promise<ExternalEditResult> {
  const file = join(tmpdir(), `${TEMP_FILE_PREFIX}${randomUUID()}.md`)
  try {
    await writeFile(file, text, { encoding: 'utf8', mode: 0o600 })
    const code = await runEditor(editor, file, options)
    if (code !== 0) return { kind: 'exit', code }
    return { kind: 'edited', text: trimOneTrailingNewline(await readFile(file, 'utf8')) }
  } catch (error: unknown) {
    return { kind: 'failed', error: errorChain(error) }
  } finally {
    await rm(file, { force: true }).catch(() => { /* the temp file outliving one edit is not worth a report */ })
  }
}

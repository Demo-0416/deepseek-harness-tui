/**
 * Runtime discovery of the `fd` binary Pi's `@` file search shells out to.
 *
 * `fd` is not a dependency and never will be: this bundle installs as a profile
 * into someone else's process, so it cannot add a platform binary to their
 * install. It is a capability of the host machine instead — present, and the
 * `@` menu inherits `fd`'s ignore-file semantics for free (`.gitignore`,
 * `.ignore`, `.fdignore`); absent, and completion falls back to this bundle's
 * own bounded walker.
 *
 * Discovery is a `PATH` lookup, not a probe subprocess: mounting a terminal
 * must not wait on a spawn, and an executable bit is the same answer `spawn`
 * would have reached one process later.
 *
 * @module @deepseek-ai/dsh-tui/chat/fd
 */

import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, isAbsolute, join, sep } from 'node:path'

/**
 * Command names searched on `PATH`, in order.
 *
 * Debian and Ubuntu ship the same binary as `fdfind` because `fd` was already
 * taken by another package, so a machine that has it under the distribution
 * name is not a machine without it.
 */
export const FILE_SEARCH_COMMAND_NAMES = ['fd', 'fdfind'] as const

/**
 * Whether one absolute path is an executable file this process can run.
 *
 * A directory named `fd` on `PATH` satisfies neither, and a permission error
 * is the same answer as a missing file: this host cannot run it.
 * @param candidate - absolute path to test.
 * @returns true when the path can be spawned.
 */
export function isExecutableFile(candidate: string): boolean {
  try {
    if (!statSync(candidate).isFile()) return false
    accessSync(candidate, constants.X_OK)
    return true
  } catch (_notExecutable: unknown) {
    return false
  }
}

/** What Windows searches for a name with no extension when `PATHEXT` is unset (`cmd.exe`'s own default). */
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD'

/**
 * Suffixes one command name is tried with, in order.
 *
 * On Windows a command word is a name without an extension — `notepad`, `code`
 * — and the executable behind it is `notepad.exe` or `code.cmd`. A lookup that
 * only stats the bare name finds neither, which is what made every Windows
 * fallback editor unresolvable. A name that already carries one of the
 * extensions is searched as written.
 * @param name - the command word.
 * @param env - environment whose `PATHEXT` is read.
 * @param platform - the host this lookup is for.
 * @returns the suffixes to append, always including the empty one.
 */
function executableSuffixes(name: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  if (platform !== 'win32') return ['']
  const extensions = (env['PATHEXT'] ?? DEFAULT_PATHEXT)
    .split(';')
    .map(extension => extension.trim())
    .filter(extension => extension.startsWith('.'))
  const lowered = name.toLowerCase()
  if (extensions.some(extension => lowered.endsWith(extension.toLowerCase()))) return ['']
  return ['', ...extensions]
}

/**
 * Resolve one command name against every `PATH` entry.
 * @param name - bare command name, without a directory part.
 * @param env - environment whose `PATH` (and, on Windows, `PATHEXT`) is searched.
 * @param platform - the host being resolved for; tests name it, callers do not.
 * @returns the absolute path of the first executable match, or `undefined`.
 */
export function lookupOnPath(
  name: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const search = env['PATH'] ?? ''
  const suffixes = executableSuffixes(name, env, platform)
  for (const directory of search.split(delimiter)) {
    // An empty `PATH` entry means the working directory on POSIX shells. This
    // deliberately does not honor that: a workspace-local `fd` is a file the
    // model may have just written, and completion must not run it.
    if (directory === '') continue
    for (const suffix of suffixes) {
      const candidate = join(directory, name + suffix)
      if (isExecutableFile(candidate)) return candidate
    }
  }
  return undefined
}

/**
 * Resolve the gitignore-aware file-search binary for this session.
 *
 * The configured value wins over discovery in both directions, because both
 * directions are real deployments: an image that ships `fd` outside `PATH`
 * pins its path, and a deployment that wants completion to see ignored build
 * output — or refuses to let the terminal spawn anything — sets the empty
 * string and gets the in-process walker.
 * @param configured - deployment setting: a path, a command name, or `''` to disable.
 * @param env - environment whose `PATH` is searched; defaults to this process's.
 * @returns a spawnable path, or `undefined` when the walker must serve `@` instead.
 */
export function resolveFileSearchCommand(
  configured: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (configured !== undefined) {
    const setting = configured.trim()
    if (setting === '') return undefined
    if (isAbsolute(setting) || setting.includes('/') || setting.includes(sep)) {
      // A configured path is answered as configured: silently falling back to
      // a different binary found on `PATH` would hide the typo that a pinned
      // path exists to make explicit.
      return isExecutableFile(setting) ? setting : undefined
    }
    return lookupOnPath(setting, env)
  }
  for (const name of FILE_SEARCH_COMMAND_NAMES) {
    const found = lookupOnPath(name, env)
    if (found !== undefined) return found
  }
  return undefined
}

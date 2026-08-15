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
/**
 * Command names searched on `PATH`, in order.
 *
 * Debian and Ubuntu ship the same binary as `fdfind` because `fd` was already
 * taken by another package, so a machine that has it under the distribution
 * name is not a machine without it.
 */
export declare const FILE_SEARCH_COMMAND_NAMES: readonly ["fd", "fdfind"];
/**
 * Whether one absolute path is an executable file this process can run.
 *
 * A directory named `fd` on `PATH` satisfies neither, and a permission error
 * is the same answer as a missing file: this host cannot run it.
 * @param candidate - absolute path to test.
 * @returns true when the path can be spawned.
 */
export declare function isExecutableFile(candidate: string): boolean;
/**
 * Resolve one command name against every `PATH` entry.
 * @param name - bare command name, without a directory part.
 * @param env - environment whose `PATH` is searched.
 * @returns the absolute path of the first executable match, or `undefined`.
 */
export declare function lookupOnPath(name: string, env: NodeJS.ProcessEnv): string | undefined;
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
export declare function resolveFileSearchCommand(configured: string | undefined, env?: NodeJS.ProcessEnv): string | undefined;

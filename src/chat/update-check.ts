/**
 * Whether a newer release of this bundle exists, asked once a day and never
 * answered out loud unless it does.
 *
 * Claude Code's `AutoUpdater` checks the registry and tells the user how to
 * install what it found; it does not install anything behind their back. This
 * module is that half — the check and the fact — and the mounted terminal owns
 * the sentence. Nothing here installs, spawns, or writes outside
 * `$DSH_HOME/update-check.json`.
 *
 * Three rules the whole module is built around, because an update check is the
 * least important thing a terminal does:
 *
 * - It never blocks. The caller starts it after the first frame and forgets it;
 *   the registry read carries its own five-second abort.
 * - It never speaks up to complain. Offline, a proxy that answers 403, a body
 *   that is not JSON, a home directory that is read-only — every one of them is
 *   `undefined`, because "we could not tell whether there is an update" is not
 *   news and a terminal that reported it would be worse than one that did not.
 * - It asks at most once a day. The answer is cached with the time it was
 *   taken, so a user who opens twenty terminals makes one request. A cache that
 *   will not parse is a cache that is not there.
 *
 * `fetchLatest` and `now` are injectable for the same reason the prompt
 * history's path is: a test must be able to drive this without a network and
 * without a clock.
 * @module @deepseek-ai/dsh-tui/chat/update-check
 */

import { readFile } from 'node:fs/promises'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

/** File under the harness home this check's last answer is kept in. */
export const UPDATE_CHECK_FILE_NAME = 'update-check.json'

/**
 * The npm package this bundle is published as, which is both what the registry
 * is asked about and what the upgrade line tells the user to install.
 */
export const UPDATE_CHECK_PACKAGE_NAME = 'deepseek-harness-tui'

/** How long one answer stands before the registry is asked again. */
export const UPDATE_CHECK_TTL_MS = 24 * 60 * 60 * 1000

/** How long the registry read may take before it is abandoned unanswered. */
export const UPDATE_CHECK_TIMEOUT_MS = 5_000

/** Registry the default {@link checkForUpdate} reads the published version from. */
export const NPM_REGISTRY_URL = 'https://registry.npmjs.org'

/**
 * A version this module can reason about: `1.2.3`, with an optional `-rc.1`
 * tail and an optional `+build` tail that semver says means nothing.
 */
const SEMVER_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u

/** Whether one prerelease identifier is the numeric kind, which sorts numerically. */
const NUMERIC_IDENTIFIER = /^\d+$/u

/** One version, split into the fields semver orders it by. */
interface ParsedVersion {
  readonly major: number
  readonly minor: number
  readonly patch: number
  /** Dot-separated prerelease identifiers; empty for a final release. */
  readonly prerelease: readonly string[]
}

/**
 * Split one version string, or refuse it.
 * @param value - the version as it was published or read.
 * @returns its fields, or `undefined` when this is not a version.
 */
function parseSemver(value: string): ParsedVersion | undefined {
  const match = SEMVER_PATTERN.exec(value.trim())
  if (match === null) return undefined
  const [, major = '', minor = '', patch = '', prerelease] = match
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: prerelease === undefined || prerelease === '' ? [] : prerelease.split('.'),
  }
}

/**
 * Order two prerelease tails, semver §11: a release outranks any prerelease of
 * the same numbers, a numeric identifier outranks nothing alphanumeric, and a
 * tail that ran out of identifiers first is the smaller one.
 * @param a - left tail, empty for a final release.
 * @param b - right tail, empty for a final release.
 * @returns negative when `a` sorts first, positive when `b` does, zero when equal.
 */
function comparePrerelease(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 0
  // 0.2.0 > 0.2.0-rc.1: the release is the finished thing.
  if (a.length === 0) return 1
  if (b.length === 0) return -1
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const left = a[index]
    const right = b[index]
    if (left === undefined) return -1
    if (right === undefined) return 1
    if (left === right) continue
    const leftNumeric = NUMERIC_IDENTIFIER.test(left)
    const rightNumeric = NUMERIC_IDENTIFIER.test(right)
    if (leftNumeric && rightNumeric) return Number(left) - Number(right)
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
    return left < right ? -1 : 1
  }
  /* v8 ignore next -- the loop returns on the first difference, and equal tails returned above. */
  return 0
}

/**
 * Order two versions.
 *
 * A version this module cannot parse compares equal to everything, which is the
 * conservative answer: an unrecognized string on either side means "no update",
 * never "update to a thing we do not understand".
 * @param a - left version.
 * @param b - right version.
 * @returns negative when `a` is older, positive when `a` is newer, zero when equal or unparseable.
 */
export function compareSemver(a: string, b: string): number {
  const left = parseSemver(a)
  const right = parseSemver(b)
  if (left === undefined || right === undefined) return 0
  if (left.major !== right.major) return left.major - right.major
  if (left.minor !== right.minor) return left.minor - right.minor
  if (left.patch !== right.patch) return left.patch - right.patch
  return comparePrerelease(left.prerelease, right.prerelease)
}

/** What one check found. */
export interface UpdateCheckResult {
  /** The newest published version, as the registry spells it. */
  readonly latest: string
  /** Whether {@link latest} is newer than the version that asked. */
  readonly hasUpdate: boolean
}

/** One `$DSH_HOME/update-check.json`: the answer and when it was taken. */
export interface UpdateCheckCache {
  /** `Date.now()` at the moment the registry answered. */
  readonly checkedAt: number
  /** The version it answered with. */
  readonly latest: string
}

/** Reads the newest published version of one package. Resolves `undefined` when it cannot. */
export type FetchLatestVersion = (name: string, signal: AbortSignal | undefined) => Promise<string | undefined>

/** How one check is run. */
export interface UpdateCheckOptions {
  /** Package name asked about, and named in the upgrade line the caller writes. */
  readonly name: string
  /** The version running now; the comparison is against this. */
  readonly currentVersion: string
  /** Override the cache path under `$DSH_HOME`; tests only. */
  readonly cachePath?: string
  /** How long a cached answer stands; defaults to {@link UPDATE_CHECK_TTL_MS}. */
  readonly ttlMs?: number
  /** Override the registry read; tests only. */
  readonly fetchLatest?: FetchLatestVersion
  /** Override the clock; tests only. */
  readonly now?: () => number
  /** Abort an in-flight read, e.g. because the terminal that wanted it is going away. */
  readonly signal?: AbortSignal
}

/**
 * Ask the npm registry which version is published as `latest`.
 *
 * `fetch` is read off the global at call time rather than captured, so a test
 * that replaces it is actually replacing what this uses. The timeout is the
 * read's own rather than the check's: five seconds is a property of talking to
 * a registry, not of asking the question.
 * @param name - the package to ask about.
 * @param signal - the caller's abort, folded together with the timeout.
 * @returns the published version, or `undefined` on any refusal.
 */
async function fetchLatestFromRegistry(name: string, signal: AbortSignal | undefined): Promise<string | undefined> {
  const timeout = AbortSignal.timeout(UPDATE_CHECK_TIMEOUT_MS)
  const composed = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
  const response = await fetch(`${NPM_REGISTRY_URL}/${encodeURIComponent(name)}/latest`, {
    signal: composed,
    headers: { accept: 'application/json' },
  })
  if (!response.ok) return undefined
  const body = await response.json() as { version?: unknown }
  return typeof body.version === 'string' && body.version !== '' ? body.version : undefined
}

/**
 * Read the cached answer.
 * @param path - the cache file.
 * @returns the cached answer, or `undefined` when there is none this version can read.
 */
async function readCache(path: string): Promise<UpdateCheckCache | undefined> {
  let value: unknown
  try {
    value = JSON.parse(await readFile(path, 'utf8'))
  } catch (_missingOrCorrupt: unknown) {
    // No file, a half-written file, a file someone edited by hand: all of them
    // mean the same thing here, which is that the registry gets asked.
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as { checkedAt?: unknown; latest?: unknown }
  if (typeof record.checkedAt !== 'number' || !Number.isFinite(record.checkedAt)) return undefined
  if (typeof record.latest !== 'string' || record.latest === '') return undefined
  return { checkedAt: record.checkedAt, latest: record.latest }
}

/**
 * Replace the cached answer. Never throws: a home directory that will not take
 * the write costs one day's throttling, not the check.
 * @param path - the cache file.
 * @param cache - the answer to keep.
 */
async function writeCache(path: string, cache: UpdateCheckCache): Promise<void> {
  try {
    // Atomic, like every other file this bundle keeps under `$DSH_HOME`: two
    // terminals starting together must not leave half a JSON object behind for
    // the third one to read.
    await writeFileAtomic(path, `${JSON.stringify(cache)}\n`, { mode: 0o600, dirMode: 0o700 })
  } catch (_unwritableHome: unknown) {
    // Ignored on purpose; see the module note on staying quiet.
  }
}

/**
 * Find out whether a newer version is published, at most once per `ttlMs`.
 *
 * Never throws and never rejects: every failure is `undefined`.
 * @param options - the package, the running version, and the test seams.
 * @returns what the registry (or the cache) said, or `undefined` when nothing could be learned.
 */
export async function checkForUpdate(options: UpdateCheckOptions): Promise<UpdateCheckResult | undefined> {
  try {
    const now = options.now ?? Date.now
    const ttlMs = options.ttlMs ?? UPDATE_CHECK_TTL_MS
    const cachePath = options.cachePath ?? dshHomePath(UPDATE_CHECK_FILE_NAME)
    const cached = await readCache(cachePath)
    if (cached !== undefined) {
      const age = now() - cached.checkedAt
      // A negative age is a clock that moved backwards (or a cache copied from
      // another machine); it is treated as expired rather than as valid
      // forever, which is what a plain `age < ttlMs` would have made it.
      if (age >= 0 && age < ttlMs) return resultFor(options.currentVersion, cached.latest)
    }
    if (options.signal?.aborted === true) return undefined
    const fetchLatest = options.fetchLatest ?? fetchLatestFromRegistry
    const latest = await fetchLatest(options.name, options.signal)
    if (latest === undefined || latest.trim() === '') return undefined
    await writeCache(cachePath, { checkedAt: now(), latest })
    return resultFor(options.currentVersion, latest)
  } catch (_offlineOrRefused: unknown) {
    return undefined
  }
}

/**
 * Pair one published version with the verdict about the running one.
 * @param currentVersion - the version running now.
 * @param latest - the newest published version.
 * @returns the result the caller reports from.
 */
function resultFor(currentVersion: string, latest: string): UpdateCheckResult {
  return { latest, hasUpdate: compareSemver(latest, currentVersion) > 0 }
}

/**
 * The command line the notice tells the user to run.
 * @param name - the package to install.
 * @returns the global install command, pinned to the `latest` tag.
 */
export function updateCommandLine(name: string = UPDATE_CHECK_PACKAGE_NAME): string {
  return `npm install -g ${name}@latest`
}

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
/** File under the harness home this check's last answer is kept in. */
export declare const UPDATE_CHECK_FILE_NAME = "update-check.json";
/**
 * The npm package this bundle is published as, which is both what the registry
 * is asked about and what the upgrade line tells the user to install.
 */
export declare const UPDATE_CHECK_PACKAGE_NAME = "deepseek-harness-tui";
/** How long one answer stands before the registry is asked again. */
export declare const UPDATE_CHECK_TTL_MS: number;
/** How long the registry read may take before it is abandoned unanswered. */
export declare const UPDATE_CHECK_TIMEOUT_MS = 5000;
/** Registry the default {@link checkForUpdate} reads the published version from. */
export declare const NPM_REGISTRY_URL = "https://registry.npmjs.org";
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
export declare function compareSemver(a: string, b: string): number;
/** What one check found. */
export interface UpdateCheckResult {
    /** The newest published version, as the registry spells it. */
    readonly latest: string;
    /** Whether {@link latest} is newer than the version that asked. */
    readonly hasUpdate: boolean;
}
/** One `$DSH_HOME/update-check.json`: the answer and when it was taken. */
export interface UpdateCheckCache {
    /** `Date.now()` at the moment the registry answered. */
    readonly checkedAt: number;
    /** The version it answered with. */
    readonly latest: string;
}
/** Reads the newest published version of one package. Resolves `undefined` when it cannot. */
export type FetchLatestVersion = (name: string, signal: AbortSignal | undefined) => Promise<string | undefined>;
/** How one check is run. */
export interface UpdateCheckOptions {
    /** Package name asked about, and named in the upgrade line the caller writes. */
    readonly name: string;
    /** The version running now; the comparison is against this. */
    readonly currentVersion: string;
    /** Override the cache path under `$DSH_HOME`; tests only. */
    readonly cachePath?: string;
    /** How long a cached answer stands; defaults to {@link UPDATE_CHECK_TTL_MS}. */
    readonly ttlMs?: number;
    /** Override the registry read; tests only. */
    readonly fetchLatest?: FetchLatestVersion;
    /** Override the clock; tests only. */
    readonly now?: () => number;
    /** Abort an in-flight read, e.g. because the terminal that wanted it is going away. */
    readonly signal?: AbortSignal;
}
/**
 * Find out whether a newer version is published, at most once per `ttlMs`.
 *
 * Never throws and never rejects: every failure is `undefined`.
 * @param options - the package, the running version, and the test seams.
 * @returns what the registry (or the cache) said, or `undefined` when nothing could be learned.
 */
export declare function checkForUpdate(options: UpdateCheckOptions): Promise<UpdateCheckResult | undefined>;
/**
 * The command line the notice tells the user to run.
 * @param name - the package to install.
 * @returns the global install command, pinned to the `latest` tag.
 */
export declare function updateCommandLine(name?: string): string;

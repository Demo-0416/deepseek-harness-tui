/**
 * Provider roster and credential storage behind `/login` and `/provider add`:
 * the list of providers those commands offer, the two host services a saved
 * provider is written through, and the masking rule every surface that prints
 * a key obeys.
 *
 * Why two writes rather than one: the pi-ai adapter's provider profile has no
 * `apiKey` field at all. It names an environment variable through `apiKeyEnv`,
 * and the secret itself belongs to the credential store, which keeps its own
 * 0600 file. Writing the key into the settings document instead would leave it
 * in plaintext in `~/.dsh/settings.yaml` — where nothing redacts it, because
 * redaction is driven by schema secret roles and that field declares none —
 * and the adapter would still never read it. So a saved login is a credential
 * write plus a profile write, and the profile only ever carries the variable's
 * name.
 * @module @deepseek-ai/dsh-tui/chat/provider-store
 */
import type { Context } from '@deepseek-ai/cordis';
/** One path-scoped edit of a settings section, as the host service accepts it. */
export type ProviderSettingsOp = {
    readonly op: 'set';
    readonly path: readonly string[];
    readonly value: unknown;
} | {
    readonly op: 'unset';
    readonly path: readonly string[];
};
/**
 * The slice of the harness settings service these commands use.
 *
 * `mutate` rather than `replace` is load-bearing: the section holds every
 * provider the user has, so replacing it to add one route would delete the
 * rest. Path ops are applied to the section as stored, so a route this
 * terminal never read survives the write.
 */
export interface ProviderSettingsService {
    /** Current resolved section for one namespace. */
    get(ns: string): unknown;
    /** Apply path-scoped edits to one namespace's user section. */
    mutate(ns: string, ops: readonly ProviderSettingsOp[]): Promise<void>;
    /** Registered namespaces and their declared effect timing. */
    describe?(options?: {
        redactSecrets?: boolean;
    }): readonly {
        ns: string;
        applies?: string;
    }[];
}
/** The slice of the harness credential service these commands use. */
export interface ProviderCredentialService {
    /** Store one secret under a shell-identifier reference. */
    set(ref: string, value: string): Promise<void>;
    /** Report where a reference currently resolves from, without disclosing the value. */
    describe?(ref: string): Promise<{
        source?: string;
        set?: boolean;
    }>;
}
/** One provider row `/login` offers, with the state that decides its flow. */
export interface ProviderRosterEntry {
    /** Route key the settings document stores this provider under. */
    readonly provider: string;
    /** Human-readable name, falling back to the route key. */
    readonly displayName: string;
    /** Namespace whose section configures this provider. */
    readonly settingsNs: string;
    /** Path from that section's root to this provider's profile object. */
    readonly settingsPath: readonly string[];
    /**
     * Whether a profile for this route is already stored.
     *
     * The two flows differ by exactly this: a configured route only needs a new
     * key, while a catalog route needs a profile generated for it first.
     */
    readonly configured: boolean;
    /** Endpoint the stored profile names, when it names one. */
    readonly baseURL?: string;
    /** Wire protocol the stored profile names, when it names one. */
    readonly api?: string;
    /** Environment variable the stored profile reads its key from, when set. */
    readonly apiKeyEnv?: string;
}
/**
 * The settings service, when this deployment has a writable one.
 * @param ctx - the fiber's context.
 * @returns the service, or undefined when settings are not mounted.
 */
export declare function providerSettings(ctx: Context): ProviderSettingsService | undefined;
/**
 * The credential service, when this deployment has one.
 * @param ctx - the fiber's context.
 * @returns the service, or undefined when credentials are not mounted.
 */
export declare function providerCredentials(ctx: Context): ProviderCredentialService | undefined;
/**
 * Render a key for display.
 *
 * Only the last four characters survive, and only when the key is long enough
 * that four characters are not most of it. Every surface that mentions a key —
 * the entry box, the confirmation notice, the transcript — goes through here,
 * so there is one rule to audit rather than one per call site.
 * @param key - the secret, never logged in full.
 * @returns a printable stand-in that discloses at most four characters.
 */
export declare function maskApiKey(key: string): string;
/** Why a typed key cannot be stored, or `undefined` when it can. */
export declare function apiKeyRefusal(key: string): string | undefined;
/** Why a typed route key cannot name a provider, or `undefined` when it can. */
export declare function routeKeyRefusal(route: string): string | undefined;
/** Why a typed environment variable name cannot hold a credential, or `undefined` when it can. */
export declare function credentialRefRefusal(ref: string): string | undefined;
/**
 * Name the environment variable a route's key is stored under.
 *
 * Derived from the route key so the settings document reads the way a
 * hand-written one does (`deepseek` → `DEEPSEEK_API_KEY`). Characters the
 * credential store refuses become underscores rather than failing the write,
 * because a route key may legally hold dots and dashes and a shell identifier
 * may not.
 * @param provider - the route key.
 * @returns a credential reference the store accepts.
 */
export declare function defaultCredentialRef(provider: string): string;
/**
 * Build the provider list `/login` offers.
 *
 * Three sources are merged, in this order of authority: the adapter's
 * configurable-provider directory, which is the only one that knows a
 * provider a fresh machine has never configured; the stored settings section,
 * which is the only one that knows the endpoint and credential a configured
 * route actually uses; and the live registration list, which supplies display
 * names for routes the directory reports by bare route key.
 *
 * The directory is what makes a brand-new machine usable: it lists every
 * provider the adapter can activate through configuration, already filtered to
 * the ones that authenticate with an API key, so DeepSeek's official endpoint
 * is offered before any provider exists in settings at all. Routes reachable
 * only by a browser handshake are absent from it by construction, which is why
 * this phase needs no OAuth filter of its own.
 * @param ctx - the fiber's context.
 * @returns one row per offerable provider, configured routes first, each group alphabetical.
 */
export declare function readProviderRoster(ctx: Context): readonly ProviderRosterEntry[];
/** The settings namespace a newly added route should be written to. */
export declare function defaultSettingsNamespace(ctx: Context): string;
/**
 * Whether a namespace's owner applies changes to a running process.
 *
 * Asked rather than assumed. The owner declares its own effect timing and the
 * settings service reports it, so a terminal that tells the user their new
 * provider is live can be telling the truth about this deployment rather than
 * about the one it was written against. An owner that declares nothing, or a
 * settings service too old to describe itself, leaves this `undefined` and the
 * caller says it cannot tell instead of guessing.
 *
 * `redactSecrets` is passed even though only the timing is read: the
 * unredacted descriptor carries every namespace's stored values, and a surface
 * that never holds a secret cannot leak one.
 * @param settings - the settings service.
 * @param ns - namespace to ask about.
 * @returns true when live, false when a restart is needed, undefined when unknown.
 */
export declare function namespaceAppliesLive(settings: ProviderSettingsService | undefined, ns: string): boolean | undefined;
/** What a save wrote, so the caller can report it without re-reading settings. */
export interface SavedProvider {
    /** Route key that now has a profile. */
    readonly provider: string;
    /** Environment variable the key was stored under. */
    readonly credentialRef: string;
    /** Whether the profile was created rather than only re-keyed. */
    readonly created: boolean;
    /** Whether the owning namespace applies changes live, when it says. */
    readonly appliesLive: boolean | undefined;
}
/** The profile fields a login flow may write; every one is optional to pi-ai. */
export interface ProviderProfileDraft {
    /** Endpoint, omitted for a catalog route that supplies its own. */
    readonly baseURL?: string;
    /** Wire protocol, omitted for a catalog route that supplies its own. */
    readonly api?: string;
    /** Display name, omitted when the route key reads well enough. */
    readonly displayName?: string;
    /** Model entries, omitted for a catalog route that serves the whole catalog. */
    readonly models?: readonly {
        readonly id: string;
        readonly name?: string;
    }[];
}
/**
 * Store one provider's key and profile.
 *
 * The credential is written first and the profile second, so a failure leaves
 * a stored secret with nothing pointing at it rather than a profile that names
 * a variable holding nothing: an unreferenced credential is inert, while a
 * dangling `apiKeyEnv` is a route that fails on its first request with an
 * error about the wrong thing.
 *
 * The profile is written with path ops rather than by replacing the section,
 * because the section holds every other provider the user has.
 * @param ctx - the fiber's context.
 * @param entry - the route being saved, with the namespace and path to write.
 * @param key - the secret; never logged, never returned.
 * @param draft - profile fields to write alongside the credential reference.
 * @param credentialRef - variable name to store under; derived from the route when absent.
 * @returns what was written, for the caller's notice.
 * @throws when either host service is missing, or either write is refused.
 */
export declare function saveProviderLogin(ctx: Context, entry: ProviderRosterEntry, key: string, draft?: ProviderProfileDraft, credentialRef?: string): Promise<SavedProvider>;

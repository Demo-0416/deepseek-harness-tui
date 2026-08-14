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

import type { Context } from '@deepseek-ai/cordis'
import type { LlmConfigurableProvider } from '@deepseek-ai/dsh-llm'
import { t } from '../i18n/index.ts'

/**
 * Namespace assumed when the adapter directory is empty.
 *
 * Every configurable-provider entry carries the namespace that configures it,
 * so the roster normally never guesses. A terminal mounted before any adapter
 * registered its directory has nothing to read it from, and refusing to write
 * at all would make `/provider add` useless in exactly the fresh-machine case
 * it exists for.
 */
const FALLBACK_SETTINGS_NAMESPACE = 'llm-pi-ai'

/** Suffix appended to a route key to name the environment variable holding its key. */
const CREDENTIAL_SUFFIX = '_API_KEY'

/** Shell-identifier rule the credential store enforces on every reference. */
const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u

/** Route keys the settings document accepts as a provider name. */
const ROUTE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u

/** Characters a key may not contain, mirroring what the LLM layer refuses as a header value. */
const ILLEGAL_KEY_PATTERN = /[\p{Cc}\p{Cf}\s]/u

/** How many trailing characters of a key any surface may show. */
const VISIBLE_KEY_TAIL = 4

/** One path-scoped edit of a settings section, as the host service accepts it. */
export type ProviderSettingsOp =
  | { readonly op: 'set'; readonly path: readonly string[]; readonly value: unknown }
  | { readonly op: 'unset'; readonly path: readonly string[] }

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
  get(ns: string): unknown
  /** Apply path-scoped edits to one namespace's user section. */
  mutate(ns: string, ops: readonly ProviderSettingsOp[]): Promise<void>
  /** Registered namespaces and their declared effect timing. */
  describe?(options?: { redactSecrets?: boolean }): readonly { ns: string; applies?: string }[]
}

/** The slice of the harness credential service these commands use. */
export interface ProviderCredentialService {
  /** Store one secret under a shell-identifier reference. */
  set(ref: string, value: string): Promise<void>
  /** Report where a reference currently resolves from, without disclosing the value. */
  describe?(ref: string): Promise<{ source?: string; set?: boolean }>
}

/** One provider row `/login` offers, with the state that decides its flow. */
export interface ProviderRosterEntry {
  /** Route key the settings document stores this provider under. */
  readonly provider: string
  /** Human-readable name, falling back to the route key. */
  readonly displayName: string
  /** Namespace whose section configures this provider. */
  readonly settingsNs: string
  /** Path from that section's root to this provider's profile object. */
  readonly settingsPath: readonly string[]
  /**
   * Whether a profile for this route is already stored.
   *
   * The two flows differ by exactly this: a configured route only needs a new
   * key, while a catalog route needs a profile generated for it first.
   */
  readonly configured: boolean
  /** Endpoint the stored profile names, when it names one. */
  readonly baseURL?: string
  /** Wire protocol the stored profile names, when it names one. */
  readonly api?: string
  /** Environment variable the stored profile reads its key from, when set. */
  readonly apiKeyEnv?: string
}

/**
 * Read a host-plane service this bundle deliberately does not depend on.
 *
 * `settings` and `credentials` are declared on `Context` by harness packages
 * that are not in this bundle's dependency table — they are host capabilities a
 * profile mounts, not something a terminal may require. That means their names
 * cannot be declaration-merged the way `sessionPersistence` is, and `ctx.get`
 * is typed `K extends keyof this`, which rejects a literal it has never heard
 * of. The cast is narrowed to the accessor call alone and every caller
 * shape-checks what comes back, so a deployment without the service degrades
 * with a message instead of throwing.
 * @param ctx - the fiber's context.
 * @param name - service name to read.
 * @returns the service, or undefined when nothing provides it.
 */
function hostService<T>(ctx: Context, name: string): T | undefined {
  const reader = ctx as unknown as { get(name: string): unknown }
  const service = reader.get(name)
  return service === null || service === undefined ? undefined : service as T
}

/**
 * The settings service, when this deployment has a writable one.
 * @param ctx - the fiber's context.
 * @returns the service, or undefined when settings are not mounted.
 */
export function providerSettings(ctx: Context): ProviderSettingsService | undefined {
  const service = hostService<Partial<ProviderSettingsService>>(ctx, 'settings')
  if (typeof service?.get !== 'function' || typeof service.mutate !== 'function') return undefined
  return service as ProviderSettingsService
}

/**
 * The credential service, when this deployment has one.
 * @param ctx - the fiber's context.
 * @returns the service, or undefined when credentials are not mounted.
 */
export function providerCredentials(ctx: Context): ProviderCredentialService | undefined {
  const service = hostService<Partial<ProviderCredentialService>>(ctx, 'credentials')
  if (typeof service?.set !== 'function') return undefined
  return service as ProviderCredentialService
}

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
export function maskApiKey(key: string): string {
  const dots = '•'.repeat(8)
  if (key.length <= VISIBLE_KEY_TAIL * 2) return dots
  return `${dots}${key.slice(-VISIBLE_KEY_TAIL)}`
}

/** Why a typed key cannot be stored, or `undefined` when it can. */
export function apiKeyRefusal(key: string): string | undefined {
  if (key === '') return t('login.refuse.keyEmpty')
  if (ILLEGAL_KEY_PATTERN.test(key)) return t('login.refuse.keyIllegal')
  return undefined
}

/** Why a typed route key cannot name a provider, or `undefined` when it can. */
export function routeKeyRefusal(route: string): string | undefined {
  if (route === '') return t('provider.refuse.routeEmpty')
  if (!ROUTE_KEY_PATTERN.test(route)) return t('provider.refuse.routeShape')
  return undefined
}

/** Why a typed environment variable name cannot hold a credential, or `undefined` when it can. */
export function credentialRefRefusal(ref: string): string | undefined {
  if (ref === '') return t('provider.refuse.credentialEmpty')
  if (!CREDENTIAL_REF_PATTERN.test(ref)) return t('provider.refuse.credentialShape')
  return undefined
}

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
export function defaultCredentialRef(provider: string): string {
  const upper = provider.toUpperCase().replaceAll(/[^A-Z0-9]/gu, '_')
  const prefixed = CREDENTIAL_REF_PATTERN.test(upper) ? upper : `P_${upper}`
  return `${prefixed}${CREDENTIAL_SUFFIX}`
}

/** One provider profile as the settings section stores it, read defensively. */
interface StoredProfile {
  readonly baseURL?: unknown
  readonly api?: unknown
  readonly apiKeyEnv?: unknown
  readonly displayName?: unknown
}

/**
 * Read one namespace's resolved section, absorbing the unregistered case.
 * @param settings - the settings service.
 * @param ns - namespace to read.
 * @returns the section, or undefined when nothing stores one.
 */
function readSection(settings: ProviderSettingsService | undefined, ns: string): unknown {
  if (settings === undefined) return undefined
  try {
    return settings.get(ns)
  } catch {
    // An unregistered namespace may throw rather than answering empty. That is
    // a deployment fact, not a user error: the roster still lists whatever the
    // adapter directory advertises, and the write path reports it for real.
    return undefined
  }
}

/**
 * Read the provider profiles one section's `providers` map stores.
 *
 * This is the pi-ai layout, where one namespace holds many routes. A namespace
 * whose directory entry declares another layout is read through
 * {@link profileAt} instead; this map only enumerates routes the directory
 * never mentioned, such as ones added by `/provider add`.
 * @param section - the namespace's resolved section.
 * @returns route key to stored profile, empty when the section holds none.
 */
function storedProfiles(section: unknown): ReadonlyMap<string, StoredProfile> {
  const profiles = new Map<string, StoredProfile>()
  if (typeof section !== 'object' || section === null) return profiles
  const declared = (section as { providers?: unknown }).providers
  if (typeof declared !== 'object' || declared === null) return profiles
  for (const [route, profile] of Object.entries(declared as Record<string, unknown>)) {
    if (typeof profile === 'object' && profile !== null) profiles.set(route, profile as StoredProfile)
  }
  return profiles
}

/** Narrow one stored profile field to a non-empty string, or drop it. */
function storedString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Read the profile object a directory entry's path points at.
 *
 * The path is the entry's own declaration, walked as declared: `[]` means the
 * namespace's section root IS the profile, which is how a single-route adapter
 * such as llm-deepseek registers itself — its `apiKeyEnv` lives at the root of
 * its own config, not under a `providers` map it does not have. Resolving the
 * path here rather than assuming the pi-ai layout is what makes `/login` write
 * where that adapter actually reads.
 * @param section - the namespace's resolved section.
 * @param path - the entry's declared path from the section root.
 * @returns the profile object, or undefined when the path leads nowhere.
 */
function profileAt(section: unknown, path: readonly string[]): StoredProfile | undefined {
  let cursor: unknown = section
  for (const segment of path) {
    if (typeof cursor !== 'object' || cursor === null) return undefined
    cursor = (cursor as Record<string, unknown>)[segment]
  }
  return typeof cursor === 'object' && cursor !== null ? cursor as StoredProfile : undefined
}

/** The LLM service surface the roster reads, kept to what it actually calls. */
interface ProviderRosterSource {
  listConfigurableProviders?: () => readonly LlmConfigurableProvider[]
  listProviders: () => readonly { id: string; name?: string }[]
}

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
export function readProviderRoster(ctx: Context): readonly ProviderRosterEntry[] {
  const llm = ctx.llm as unknown as ProviderRosterSource
  const settings = providerSettings(ctx)
  const directory = typeof llm.listConfigurableProviders === 'function'
    ? llm.listConfigurableProviders()
    : []
  const registered = new Map(llm.listProviders().map(provider => [provider.id, provider.name]))
  const namespaces = new Set(directory.map(entry => entry.settingsNs))
  if (namespaces.size === 0) namespaces.add(FALLBACK_SETTINGS_NAMESPACE)
  const sections = new Map([...namespaces].map(ns => [ns, readSection(settings, ns)] as const))

  const rows = new Map<string, ProviderRosterEntry>()

  for (const entry of directory) {
    // The entry's own declared path decides where its profile lives: `[]`
    // means the section root, the layout a single-route adapter registers.
    const profile = profileAt(sections.get(entry.settingsNs), entry.settingsPath)
    rows.set(entry.provider, {
      provider: entry.provider,
      displayName: registered.get(entry.provider) ?? entry.displayName,
      settingsNs: entry.settingsNs,
      settingsPath: entry.settingsPath,
      configured: profile !== undefined,
      ...profile === undefined ? {} : profileFacts(profile),
    })
  }
  for (const [ns, section] of sections) {
    for (const [route, profile] of storedProfiles(section)) {
      // A directory row wins: it read its stored facts through its own
      // declared path, while this enumeration assumes the pi-ai layout — in a
      // root-profile namespace a stray `providers` subtree is stale data, not
      // a route this terminal should offer to edit.
      if (rows.has(route)) continue
      rows.set(route, {
        provider: route,
        displayName: storedString(profile.displayName) ?? registered.get(route) ?? route,
        settingsNs: ns,
        settingsPath: ['providers', route],
        configured: true,
        ...profileFacts(profile),
      })
    }
  }
  return [...rows.values()].sort((left, right) => {
    if (left.configured !== right.configured) return left.configured ? -1 : 1
    return left.provider.localeCompare(right.provider)
  })
}

/** The three profile fields the login flows read back, omitted when unset. */
function profileFacts(profile: StoredProfile): Partial<ProviderRosterEntry> {
  const baseURL = storedString(profile.baseURL)
  const api = storedString(profile.api)
  const apiKeyEnv = storedString(profile.apiKeyEnv)
  return {
    ...baseURL === undefined ? {} : { baseURL },
    ...api === undefined ? {} : { api },
    ...apiKeyEnv === undefined ? {} : { apiKeyEnv },
  }
}

/** The settings namespace a newly added route should be written to. */
export function defaultSettingsNamespace(ctx: Context): string {
  const llm = ctx.llm as unknown as ProviderRosterSource
  const directory = typeof llm.listConfigurableProviders === 'function'
    ? llm.listConfigurableProviders()
    : []
  return directory[0]?.settingsNs ?? FALLBACK_SETTINGS_NAMESPACE
}

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
export function namespaceAppliesLive(
  settings: ProviderSettingsService | undefined,
  ns: string,
): boolean | undefined {
  if (typeof settings?.describe !== 'function') return undefined
  let descriptors: readonly { ns: string; applies?: string }[]
  try {
    descriptors = settings.describe({ redactSecrets: true })
  } catch {
    return undefined
  }
  const applies = descriptors.find(descriptor => descriptor.ns === ns)?.applies
  if (applies === 'live') return true
  if (applies === 'restart') return false
  return undefined
}

/** What a save wrote, so the caller can report it without re-reading settings. */
export interface SavedProvider {
  /** Route key that now has a profile. */
  readonly provider: string
  /** Environment variable the key was stored under. */
  readonly credentialRef: string
  /** Whether the profile was created rather than only re-keyed. */
  readonly created: boolean
  /** Whether the owning namespace applies changes live, when it says. */
  readonly appliesLive: boolean | undefined
}

/** The profile fields a login flow may write; every one is optional to pi-ai. */
export interface ProviderProfileDraft {
  /** Endpoint, omitted for a catalog route that supplies its own. */
  readonly baseURL?: string
  /** Wire protocol, omitted for a catalog route that supplies its own. */
  readonly api?: string
  /** Display name, omitted when the route key reads well enough. */
  readonly displayName?: string
  /** Model entries, omitted for a catalog route that serves the whole catalog. */
  readonly models?: readonly { readonly id: string; readonly name?: string }[]
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
export async function saveProviderLogin(
  ctx: Context,
  entry: ProviderRosterEntry,
  key: string,
  draft: ProviderProfileDraft = {},
  credentialRef: string = entry.apiKeyEnv ?? defaultCredentialRef(entry.provider),
): Promise<SavedProvider> {
  const credentials = providerCredentials(ctx)
  if (credentials === undefined) {
    throw new Error('this deployment has no credential store, so a key cannot be saved')
  }
  const settings = providerSettings(ctx)
  if (settings === undefined) {
    throw new Error('this deployment has no writable settings, so a provider cannot be saved')
  }
  await credentials.set(credentialRef, key)
  // The entry's declared path, taken as declared: `[]` addresses the section
  // root, where a single-route adapter like llm-deepseek reads `apiKeyEnv`.
  // Substituting a `providers.<route>` subtree here would store the reference
  // where no adapter looks, which is exactly the login that "worked" and then
  // failed its first request with a missing-credential error.
  const path = entry.settingsPath
  const ops: ProviderSettingsOp[] = [{ op: 'set', path: [...path, 'apiKeyEnv'], value: credentialRef }]
  for (const [field, value] of Object.entries(draft)) {
    if (value === undefined) continue
    ops.push({ op: 'set', path: [...path, field], value })
  }
  await settings.mutate(entry.settingsNs, ops)
  return {
    provider: entry.provider,
    credentialRef,
    created: !entry.configured,
    appliesLive: namespaceAppliesLive(settings, entry.settingsNs),
  }
}

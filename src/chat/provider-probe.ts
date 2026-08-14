/**
 * Key verification and model discovery for `/login` and `/provider add`.
 *
 * Both are one call: the LLM service's discovery seam interrogates an endpoint
 * with a candidate key and answers with the models it lists, so a key that
 * comes back with a model list is a key that authenticated. Nothing here opens
 * a socket itself — the adapter owns the request — which is also what makes
 * this testable without a network: a test supplies the discovery function.
 * @module @deepseek-ai/dsh-tui/chat/provider-probe
 */

import type { LlmDiscoveredModel, LlmModelDiscoveryRequest } from '@deepseek-ai/dsh-llm'

/**
 * Protocols the adapter's discovery path can list models over.
 *
 * Kept as data rather than asked at runtime because the seam offers no way to
 * ask: an endpoint speaking anything else answers `DISCOVERY_UNSUPPORTED`, and
 * a flow that only found that out after taking the user's key would have made
 * them type a secret to learn a fact about a protocol. The refusal is the same
 * either way; this list is what lets the flow say it first.
 */
const LISTABLE_PROTOCOLS: ReadonlySet<string> = new Set(['openai-completions', 'openai-responses'])

/** Wire protocols a provider profile may name, in the order the form offers them. */
export const SUPPORTED_PROTOCOLS: readonly string[] = [
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
]

/** What one probe of an endpoint established. */
export type ProbeOutcome =
  /** The endpoint accepted the key and listed these models. */
  | { readonly kind: 'verified'; readonly models: readonly LlmDiscoveredModel[] }
  /** The endpoint answered, and rejected the key. Nothing should be saved. */
  | { readonly kind: 'rejected'; readonly message: string }
  /** The endpoint could not be reached, so the key is neither good nor bad. */
  | { readonly kind: 'unreachable'; readonly message: string }
  /** This endpoint cannot be interrogated at all, so the key cannot be checked here. */
  | { readonly kind: 'unsupported'; readonly message: string }
  /** The user or the terminal cancelled the probe. */
  | { readonly kind: 'aborted' }

/** The discovery call this module drives, isolated so a test can supply its own. */
export type DiscoverModels = (
  settingsNs: string,
  request: LlmModelDiscoveryRequest,
) => Promise<readonly LlmDiscoveredModel[]>

/** One endpoint to interrogate, with the credential to interrogate it with. */
export interface ProbeTarget {
  /** Namespace whose adapter owns the discovery implementation. */
  readonly settingsNs: string
  /** Endpoint to interrogate. */
  readonly baseURL: string
  /** Wire protocol the endpoint speaks. */
  readonly api?: string
  /** Candidate key; sent for this interrogation alone and never stored by the seam. */
  readonly apiKey: string
  /** Caller cancellation. */
  readonly signal?: AbortSignal
}

/** Read a thrown value's `code` without an `instanceof` this bundle cannot rely on. */
function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

/** A thrown value's message, or a stand-in when it has none. */
function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message !== '') return error.message
  return typeof error === 'string' && error !== '' ? error : 'the endpoint failed without saying why'
}

/**
 * Remove a candidate key from text that is about to be shown.
 *
 * Discovery messages name the URL rather than the credential, so this should
 * never fire. It exists because "should never" is not a property anyone can
 * check at review time on every future adapter's error strings, and the cost
 * of being wrong once is the secret in the transcript and in the session log.
 * @param text - message to display.
 * @param key - the secret that must not appear in it.
 * @returns the message with any occurrence of the key replaced.
 */
function withoutKey(text: string, key: string): string {
  if (key === '' || !text.includes(key)) return text
  return text.replaceAll(key, '[key]')
}

/**
 * Whether an endpoint answered by refusing the credential.
 *
 * Read off the message text, which is not where anyone would want to read it.
 * The adapter codes every discovery failure `DISCOVERY_FAILED` — an
 * unreachable host and a rejected key are the same code — and appends a
 * "check the API key" hint to the 401 and 403 cases alone. Refusing to
 * distinguish them would make the flow either save keys the endpoint already
 * rejected, or refuse to save when the user's network is simply down; both are
 * worse than matching a status this pattern will keep matching for as long as
 * the message names the status at all.
 * @param message - the discovery failure's message.
 * @returns true when the endpoint answered with an auth refusal.
 */
function isCredentialRefusal(message: string): boolean {
  return /\banswered\s+(?:401|403)\b/u.test(message)
}

/**
 * Interrogate one endpoint with one candidate key.
 *
 * `provider` is deliberately not sent. A request naming a route the adapter
 * already knows is answered from the adapter's own registry with no network
 * call at all — the right answer for a model list, and useless for checking a
 * key, because a catalog lookup cannot reject a credential. Sending the
 * endpoint and the key instead is what makes this a verification.
 * @param discover - the discovery seam.
 * @param target - endpoint, protocol, and candidate key.
 * @returns what the probe established.
 */
export async function probeProviderKey(
  discover: DiscoverModels,
  target: ProbeTarget,
): Promise<ProbeOutcome> {
  if (target.api !== undefined && !LISTABLE_PROTOCOLS.has(target.api)) {
    return {
      kind: 'unsupported',
      message: `${target.api} endpoints do not list their models, so the key cannot be checked from here.`,
    }
  }
  try {
    const models = await discover(target.settingsNs, {
      baseURL: target.baseURL,
      apiKey: target.apiKey,
      ...target.api === undefined ? {} : { api: target.api },
      ...target.signal === undefined ? {} : { signal: target.signal },
    })
    return { kind: 'verified', models }
  } catch (error: unknown) {
    const code = errorCode(error)
    const message = withoutKey(errorMessage(error), target.apiKey)
    if (code === 'ABORTED') return { kind: 'aborted' }
    if (code === 'DISCOVERY_UNSUPPORTED') return { kind: 'unsupported', message }
    if (code === 'INVALID_CREDENTIAL') return { kind: 'rejected', message }
    if (isCredentialRefusal(message)) return { kind: 'rejected', message }
    return { kind: 'unreachable', message }
  }
}

/**
 * Ask the adapter which models a route it already knows serves.
 *
 * Naming the route is what makes this free: the adapter answers from its own
 * catalog without a request, which is the whole reason a catalog provider can
 * offer a model list before it has an endpoint or a key.
 * @param discover - the discovery seam.
 * @param settingsNs - namespace whose adapter owns the route.
 * @param provider - route key to ask about.
 * @param signal - caller cancellation.
 * @returns the models, or an empty list when the adapter cannot answer.
 */
export async function catalogModels(
  discover: DiscoverModels,
  settingsNs: string,
  provider: string,
  signal?: AbortSignal,
): Promise<readonly LlmDiscoveredModel[]> {
  try {
    return await discover(settingsNs, {
      provider,
      ...signal === undefined ? {} : { signal },
    })
  } catch {
    // A route the adapter cannot describe is not an error here: the flow falls
    // through to asking the user for a model id, which is the same path an
    // endpoint that lists nothing takes.
    return []
  }
}

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
import type { LlmDiscoveredModel, LlmModelDiscoveryRequest } from '@deepseek-ai/dsh-llm';
/** Wire protocols a provider profile may name, in the order the form offers them. */
export declare const SUPPORTED_PROTOCOLS: readonly string[];
/** What one probe of an endpoint established. */
export type ProbeOutcome = 
/** The endpoint accepted the key and listed these models. */
{
    readonly kind: 'verified';
    readonly models: readonly LlmDiscoveredModel[];
}
/** The endpoint answered, and rejected the key. Nothing should be saved. */
 | {
    readonly kind: 'rejected';
    readonly message: string;
}
/** The endpoint could not be reached, so the key is neither good nor bad. */
 | {
    readonly kind: 'unreachable';
    readonly message: string;
}
/** This endpoint cannot be interrogated at all, so the key cannot be checked here. */
 | {
    readonly kind: 'unsupported';
    readonly message: string;
}
/** The user or the terminal cancelled the probe. */
 | {
    readonly kind: 'aborted';
};
/** The discovery call this module drives, isolated so a test can supply its own. */
export type DiscoverModels = (settingsNs: string, request: LlmModelDiscoveryRequest) => Promise<readonly LlmDiscoveredModel[]>;
/** One endpoint to interrogate, with the credential to interrogate it with. */
export interface ProbeTarget {
    /** Namespace whose adapter owns the discovery implementation. */
    readonly settingsNs: string;
    /** Endpoint to interrogate. */
    readonly baseURL: string;
    /** Wire protocol the endpoint speaks. */
    readonly api?: string;
    /** Candidate key; sent for this interrogation alone and never stored by the seam. */
    readonly apiKey: string;
    /** Caller cancellation. */
    readonly signal?: AbortSignal;
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
export declare function probeProviderKey(discover: DiscoverModels, target: ProbeTarget): Promise<ProbeOutcome>;
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
export declare function catalogModels(discover: DiscoverModels, settingsNs: string, provider: string, signal?: AbortSignal): Promise<readonly LlmDiscoveredModel[]>;

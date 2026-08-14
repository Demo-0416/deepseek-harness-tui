/**
 * Provider sign-in sub-controller for the interactive chat channel: the queued
 * `/login` command, which gives an existing or catalog-known provider a key,
 * and `/provider`, which lists what is configured and adds a route the catalog
 * has never heard of.
 *
 * Both flows end in the same two writes and the same honesty rule: the terminal
 * says what it actually verified and what actually takes effect, never that a
 * key works because it was stored, and never that a provider is live because
 * the write succeeded.
 * @module @deepseek-ai/dsh-tui/chat/login-command
 */

import { errorChain } from '@deepseek-ai/dsh-llm'
import type { LlmDiscoveredModel } from '@deepseek-ai/dsh-llm'
import type { TuiOverlaySession } from '../extension/types.ts'
import {
  ProviderWizard,
  type ProviderWizardItem,
  type ProviderWizardStep,
} from '../components/provider-dialog.ts'
import { displayInlineText } from '../components/text.ts'
import {
  apiKeyRefusal,
  credentialRefRefusal,
  defaultCredentialRef,
  defaultSettingsNamespace,
  maskApiKey,
  providerCredentials,
  providerSettings,
  readProviderRoster,
  routeKeyRefusal,
  saveProviderLogin,
  type ProviderProfileDraft,
  type ProviderRosterEntry,
  type SavedProvider,
} from './provider-store.ts'
import {
  catalogModels,
  probeProviderKey,
  SUPPORTED_PROTOCOLS,
  type DiscoverModels,
  type ProbeOutcome,
} from './provider-probe.ts'
import type { ChannelNotice, ChannelPendingHint, ChatChannelDeps } from './channel.ts'

/** Collaborators the login controller needs from the chat channel. */
export type LoginControllerDeps = ChatChannelDeps & ChannelNotice & ChannelPendingHint

/** Provider sign-in controller for one chat channel. */
export interface LoginController {
  /** Queue a `/login` command; the argument pre-selects a provider. */
  queueLoginCommand(raw: string): void
  /** Queue a `/provider` command; `add` starts the new-route form. */
  queueProviderCommand(raw: string): void
  /** Forget the tracked wizard overlay (shutdown). */
  clearOverlay(): void
}

/** Answers offered when a key could not be checked before storing it. */
const SAVE_ANYWAY = 'save'
const ABANDON = 'abandon'

/** Endpoints a provider form accepts, stated once so the refusal can name it. */
const ENDPOINT_PATTERN = /^https?:\/\/\S+$/u

/**
 * Build the provider sign-in controller for one chat channel.
 * @param deps - channel collaborators.
 * @returns the controller wired to the channel's overlay and notice surfaces.
 */
export function createLoginController(deps: LoginControllerDeps): LoginController {
  const { ctx, resolved, palette, overlayManager } = deps
  let overlay: TuiOverlaySession | undefined
  let wizard: ProviderWizard | undefined
  let flowAbort: AbortController | undefined
  let commands = Promise.resolve()

  /** The discovery seam, read live so an adapter that registers late is still used. */
  const discover: DiscoverModels | undefined = (() => {
    const llm = ctx.llm as unknown as { discoverModels?: DiscoverModels }
    return typeof llm.discoverModels === 'function'
      ? (ns, request) => llm.discoverModels!(ns, request)
      : undefined
  })()

  const closeFlow = (): void => {
    flowAbort?.abort()
    flowAbort = undefined
    const session = overlay
    overlay = undefined
    wizard = undefined
    void session?.close()
    deps.requestRender()
  }

  /**
   * Open the wizard on its first step.
   *
   * The dialog is not dismissable, unlike the model selector. A surface holding
   * a half-typed credential must not be taken down by an arriving notice: the
   * user would have to retype a pasted key, and would have no way to know why
   * it vanished.
   *
   * The first step is passed in rather than pushed afterwards because the
   * component is built when the overlay reaches the front of the queue, which
   * is only synchronous when the slot happens to be free. Every later step is
   * pushed from a callback the component itself raised, so by then it exists.
   * @param first - the step to show.
   */
  const openWizard = (first: ProviderWizardStep): void => {
    closeFlow()
    flowAbort = new AbortController()
    const session = overlayManager.open({
      create: () => {
        const created = new ProviderWizard(
          first,
          resolved.maxModelOptions,
          palette,
          closeFlow,
          () => { deps.requestRender() },
        )
        wizard = created
        return created
      },
      options: { width: resolved.modelDialogWidth, maxHeight: resolved.modelDialogMaxHeight },
    }, 'inline')
    overlay = session
    void session.closed.then(() => {
      if (overlay === session) {
        overlay = undefined
        wizard = undefined
        flowAbort?.abort()
        flowAbort = undefined
      }
    })
    deps.requestRender()
  }

  /**
   * State the effect of a completed write without overstating it.
   *
   * The namespace's owner declares whether its changes reach a running process,
   * and the settings service reports that declaration, so the first two arms are
   * this deployment's answer rather than the one that held when this was
   * written. When nothing answers, the sentence says so and names the fallback
   * instead of implying either outcome.
   * @param saved - what the write produced.
   * @returns one sentence about when the provider becomes usable.
   */
  const effectSentence = (saved: SavedProvider): string => {
    if (saved.appliesLive === true) return 'It is live now — /model lists its models.'
    if (saved.appliesLive === false) return 'Restart dsh for it to take effect.'
    return 'This deployment does not say whether that applies without a restart; if /model does not list it, restart dsh.'
  }

  /** Report a completed save, naming only the masked tail of the key. */
  const reportSaved = (saved: SavedProvider, key: string, verified: boolean): void => {
    const what = saved.created ? 'Added provider' : 'Signed in to'
    deps.appendNotice([
      `${what} ${displayInlineText(saved.provider)} with key ${maskApiKey(key)}.`,
      `The key is stored in the credential store as ${displayInlineText(saved.credentialRef)}; settings record the variable name only.`,
      verified ? 'The endpoint accepted it.' : 'It was not checked against the endpoint.',
      effectSentence(saved),
    ].join(' '))
  }

  /** Store one provider, then report it; failures name the service that refused. */
  const commit = async (
    entry: ProviderRosterEntry,
    key: string,
    draft: ProviderProfileDraft,
    verified: boolean,
    credentialRef?: string,
  ): Promise<void> => {
    wizard?.setStatus('Saving…')
    try {
      const saved = await saveProviderLogin(ctx, entry, key, draft, credentialRef)
      if (deps.isDisposed()) return
      closeFlow()
      reportSaved(saved, key, verified)
    } catch (error: unknown) {
      if (deps.isDisposed()) return
      // Kept on screen rather than closed: a rejected write usually names
      // something the user can change (a variable the shell already defines, a
      // route the adapter refuses), and closing would take the entered key with
      // it.
      wizard?.setStatus('')
      wizard?.setRefusal(`Could not save: ${errorChain(error)}`)
    }
  }

  /** Turn discovered models into the profile's model entries. */
  const modelDraft = (
    models: readonly LlmDiscoveredModel[],
    chosen: readonly string[],
  ): ProviderProfileDraft['models'] => {
    const picked = models.filter(model => chosen.includes(model.id))
    return picked.map(model => ({
      id: model.id,
      ...model.name === undefined ? {} : { name: model.name },
    }))
  }

  /**
   * Run the probe and hand the outcome on.
   *
   * A route with no endpoint of its own is never probed and never pretends to
   * have been: the adapter supplies its endpoint from a built-in catalog that
   * this terminal cannot read, so there is nothing here to interrogate. Saying
   * "not checked" is the whole of the honesty this case allows.
   * @param entry - the route being signed in to.
   * @param key - candidate key.
   * @param baseURL - endpoint, when one is known.
   * @param api - protocol, when one is known.
   * @returns what the probe established, or undefined when there was nothing to probe.
   */
  const runProbe = async (
    entry: ProviderRosterEntry,
    key: string,
    baseURL: string | undefined,
    api: string | undefined,
  ): Promise<ProbeOutcome | undefined> => {
    if (discover === undefined || baseURL === undefined) return undefined
    wizard?.setStatus('Checking the key against the endpoint…')
    const outcome = await probeProviderKey(discover, {
      settingsNs: entry.settingsNs,
      baseURL,
      apiKey: key,
      ...api === undefined ? {} : { api },
      ...flowAbort === undefined ? {} : { signal: flowAbort.signal },
    })
    if (!deps.isDisposed()) wizard?.setStatus('')
    return outcome
  }

  /** Offer the explicit choice a key that could not be checked requires. */
  const askSaveAnyway = (reason: string, onSave: () => void): void => {
    wizard?.setStep({
      kind: 'select',
      title: 'Key not verified',
      lines: [reason, 'Storing it is safe; it simply has not been proven to work yet.'],
      items: [
        { value: SAVE_ANYWAY, label: 'Save the key anyway', description: 'checked on first use' },
        { value: ABANDON, label: 'Cancel', description: 'nothing is written' },
      ],
      onPick: (value) => {
        if (value === SAVE_ANYWAY) onSave()
        else closeFlow()
      },
    })
  }

  // ── /login ───────────────────────────────────────────────────────────────

  /** The key step for one route: ask, verify, then store. */
  const loginKeyStep = (entry: ProviderRosterEntry): ProviderWizardStep => ({
    kind: 'text',
    title: `Sign in to ${entry.displayName}`,
    lines: [
      entry.baseURL === undefined
        ? 'This provider\'s endpoint comes from the built-in catalog, so the key cannot be checked from here.'
        : `Endpoint: ${entry.baseURL}`,
      'The key is stored in the credential store, never in settings.',
    ],
    prompt: 'Paste the API key. It is never echoed.',
    secret: true,
    refuse: apiKeyRefusal,
    onSubmit: (key) => {
      void (async () => {
        const outcome = await runProbe(entry, key, entry.baseURL, entry.api)
        if (deps.isDisposed()) return
        if (outcome === undefined) {
          await commit(entry, key, {}, false)
          return
        }
        if (outcome.kind === 'aborted') return
        if (outcome.kind === 'rejected') {
          wizard?.setRefusal(`The endpoint rejected that key: ${outcome.message}. Nothing was saved.`)
          return
        }
        if (outcome.kind === 'verified') {
          await commit(entry, key, {}, true)
          return
        }
        askSaveAnyway(outcome.message, () => { void commit(entry, key, {}, false) })
      })()
    },
  })

  /** One roster row as a picker item, grouped by whether it is already configured. */
  const rosterItem = (entry: ProviderRosterEntry): ProviderWizardItem => ({
    value: entry.provider,
    label: entry.displayName === entry.provider
      ? entry.provider
      : `${entry.displayName} (${entry.provider})`,
    group: entry.configured ? 'Configured' : 'Available to configure',
    ...entry.configured
      ? { description: entry.apiKeyEnv === undefined ? 'no key stored' : `key in ${entry.apiKeyEnv}` }
      : {},
  })

  const handleLoginCommand = (raw: string): void => {
    const roster = readProviderRoster(ctx)
    if (roster.length === 0) {
      deps.appendNotice(
        'No providers are configured and none are offered by a registered adapter. Use /provider add to describe one.',
        'warning',
      )
      return
    }
    if (providerCredentials(ctx) === undefined || providerSettings(ctx) === undefined) {
      deps.appendNotice(
        'This deployment has no writable settings or credential store, so a key cannot be saved here.',
        'warning',
      )
      return
    }
    const argument = raw.trim()
    if (argument !== '') {
      const match = roster.find(entry => entry.provider === argument)
      if (match === undefined) {
        deps.appendNotice(`Unknown provider: ${displayInlineText(argument)}. Run /login to list them.`, 'warning')
        return
      }
      openWizard(loginKeyStep(match))
      return
    }
    openWizard({
      kind: 'select',
      title: 'Sign in to a provider',
      lines: ['Configured routes take a new key; the rest are written into settings when you sign in.'],
      items: roster.map(rosterItem),
      onPick: (value) => {
        const entry = roster.find(candidate => candidate.provider === value)
        /* v8 ignore next -- the picker only offers values it was given. */
        if (entry === undefined) return
        wizard?.setStep(loginKeyStep(entry))
      },
    })
  }

  // ── /provider add ────────────────────────────────────────────────────────

  /** The draft a new route accumulates as the form advances. */
  interface RouteDraft {
    provider: string
    baseURL: string
    api: string
    displayName: string
    credentialRef: string
  }

  /** Ask for a model id by hand, for an endpoint that lists none. */
  const askModelByHand = (draft: RouteDraft, entry: ProviderRosterEntry, key: string): void => {
    wizard?.setStep({
      kind: 'text',
      title: 'Model',
      lines: ['This endpoint did not list its models. Name one, or leave it empty to let the adapter decide.'],
      prompt: 'Model id (optional).',
      onSubmit: (id) => {
        void commit(entry, key, {
          baseURL: draft.baseURL,
          api: draft.api,
          ...draft.displayName === '' ? {} : { displayName: draft.displayName },
          ...id === '' ? {} : { models: [{ id }] },
        }, false, draft.credentialRef)
      },
    })
  }

  /** Confirm which discovered models the route should serve. */
  const askModelSelection = (
    draft: RouteDraft,
    entry: ProviderRosterEntry,
    key: string,
    models: readonly LlmDiscoveredModel[],
    verified: boolean,
  ): void => {
    wizard?.setStep({
      kind: 'checklist',
      title: 'Models',
      lines: [`${models.length} model(s) reported by the endpoint. Ticked models are written into settings.`,
        'Tick none to serve whatever the adapter finds.'],
      items: models.map(model => ({
        value: model.id,
        label: model.id,
        ...model.name === undefined || model.name === model.id ? {} : { description: model.name },
      })),
      initial: models.map(model => model.id),
      onSubmit: (chosen) => {
        const picked = modelDraft(models, chosen)
        void commit(entry, key, {
          baseURL: draft.baseURL,
          api: draft.api,
          ...draft.displayName === '' ? {} : { displayName: draft.displayName },
          ...picked === undefined || picked.length === 0 ? {} : { models: picked },
        }, verified, draft.credentialRef)
      },
    })
  }

  /** Take the key for a new route, then probe, discover, and store it. */
  const askNewRouteKey = (draft: RouteDraft, ns: string): void => {
    const entry: ProviderRosterEntry = {
      provider: draft.provider,
      displayName: draft.displayName === '' ? draft.provider : draft.displayName,
      settingsNs: ns,
      settingsPath: ['providers', draft.provider],
      configured: false,
    }
    wizard?.setStep({
      kind: 'text',
      title: `Key for ${draft.provider}`,
      lines: [
        `Endpoint: ${draft.baseURL}`,
        `Stored in the credential store as ${draft.credentialRef}.`,
      ],
      prompt: 'Paste the API key. It is never echoed.',
      secret: true,
      refuse: apiKeyRefusal,
      onSubmit: (key) => {
        void (async () => {
          const outcome = await runProbe(entry, key, draft.baseURL, draft.api)
          if (deps.isDisposed()) return
          if (outcome === undefined || outcome.kind === 'aborted') {
            if (outcome === undefined) askModelByHand(draft, entry, key)
            return
          }
          if (outcome.kind === 'rejected') {
            wizard?.setRefusal(`The endpoint rejected that key: ${outcome.message}. Nothing was saved.`)
            return
          }
          if (outcome.kind === 'verified') {
            if (outcome.models.length === 0) askModelByHand(draft, entry, key)
            else askModelSelection(draft, entry, key, outcome.models, true)
            return
          }
          askSaveAnyway(outcome.message, () => { askModelByHand(draft, entry, key) })
        })()
      },
    })
  }

  /** Ask for the variable name the key is stored under, pre-filled from the route. */
  const askCredentialRef = (draft: RouteDraft, ns: string): void => {
    wizard?.setStep({
      kind: 'text',
      title: 'Credential variable',
      lines: ['Settings record this name; the secret itself lives in the credential store.'],
      prompt: 'Environment variable name.',
      initial: draft.credentialRef,
      refuse: credentialRefRefusal,
      onSubmit: (ref) => {
        draft.credentialRef = ref
        askNewRouteKey(draft, ns)
      },
    })
  }

  const askDisplayName = (draft: RouteDraft, ns: string): void => {
    wizard?.setStep({
      kind: 'text',
      title: 'Display name',
      lines: ['Shown in pickers. Leave empty to use the route name.'],
      prompt: 'Display name (optional).',
      onSubmit: (name) => {
        draft.displayName = name
        askCredentialRef(draft, ns)
      },
    })
  }

  const askProtocol = (draft: RouteDraft, ns: string): void => {
    wizard?.setStep({
      kind: 'select',
      title: 'Wire protocol',
      lines: ['Only OpenAI-shaped endpoints can be interrogated for their models; the rest are saved unchecked.'],
      items: SUPPORTED_PROTOCOLS.map(api => ({
        value: api,
        label: api,
        ...api === 'anthropic-messages' ? { description: 'no model listing' } : {},
      })),
      initial: SUPPORTED_PROTOCOLS[0] ?? '',
      onPick: (api) => {
        draft.api = api
        askDisplayName(draft, ns)
      },
    })
  }

  const askBaseUrl = (draft: RouteDraft, ns: string): void => {
    wizard?.setStep({
      kind: 'text',
      title: 'Endpoint',
      lines: ['The base URL the adapter appends its paths to.'],
      prompt: 'Base URL, for example https://api.example.com/v1',
      refuse: (value) => {
        if (value === '') return 'Enter a URL, or press Esc to cancel.'
        return ENDPOINT_PATTERN.test(value) ? undefined : 'Enter an http:// or https:// URL.'
      },
      onSubmit: (url) => {
        draft.baseURL = url
        askProtocol(draft, ns)
      },
    })
  }

  const startProviderAdd = (): void => {
    const ns = defaultSettingsNamespace(ctx)
    const taken = new Set(readProviderRoster(ctx).filter(entry => entry.configured).map(entry => entry.provider))
    const draft: RouteDraft = { provider: '', baseURL: '', api: '', displayName: '', credentialRef: '' }
    openWizard({
      kind: 'text',
      title: 'Add a provider',
      lines: [`Written to the ${ns} settings section.`],
      prompt: 'Route name, as /model will spell it (for example acme).',
      refuse: (value) => {
        const refusal = routeKeyRefusal(value)
        if (refusal !== undefined) return refusal
        return taken.has(value)
          ? `${value} is already configured; /login gives it a new key.`
          : undefined
      },
      onSubmit: (route) => {
        draft.provider = route
        draft.credentialRef = defaultCredentialRef(route)
        askBaseUrl(draft, ns)
      },
    })
  }

  /** List what is configured and what could be, without opening a form. */
  const listProviders = async (): Promise<void> => {
    const roster = readProviderRoster(ctx)
    if (roster.length === 0) {
      deps.appendNotice('No providers are configured, and no adapter offers any. Use /provider add.', 'warning')
      return
    }
    const configured = roster.filter(entry => entry.configured)
    const available = roster.filter(entry => !entry.configured)
    const lines: string[] = []
    if (configured.length > 0) {
      lines.push('Configured:')
      for (const entry of configured) {
        const models = discover === undefined
          ? []
          : await catalogModels(discover, entry.settingsNs, entry.provider)
        const where = entry.apiKeyEnv === undefined ? 'no key stored' : `key in ${entry.apiKeyEnv}`
        const count = models.length === 0 ? '' : `, ${models.length} model(s)`
        lines.push(`  ${displayInlineText(entry.provider)} — ${where}${count}`)
      }
    }
    if (available.length > 0) {
      lines.push('Available to configure with /login:')
      lines.push(`  ${available.map(entry => displayInlineText(entry.provider)).join(', ')}`)
    }
    lines.push('Use /provider add to describe an endpoint no adapter ships.')
    deps.appendNotice(lines.join('\n'))
  }

  const handleProviderCommand = async (raw: string): Promise<void> => {
    const argument = raw.trim()
    if (argument === '') {
      await listProviders()
      return
    }
    if (argument !== 'add') {
      deps.appendNotice('Usage: /provider [add]', 'warning')
      return
    }
    if (providerCredentials(ctx) === undefined || providerSettings(ctx) === undefined) {
      deps.appendNotice(
        'This deployment has no writable settings or credential store, so a provider cannot be added here.',
        'warning',
      )
      return
    }
    startProviderAdd()
  }

  return {
    queueLoginCommand(raw: string): void {
      commands = commands.then(() => {
        if (deps.isDisposed()) return
        handleLoginCommand(raw)
      }).catch((error: unknown) => {
        if (!deps.isDisposed()) deps.appendNotice(`Could not start sign-in: ${errorChain(error)}`, 'error')
      })
    },
    queueProviderCommand(raw: string): void {
      commands = commands.then(async () => {
        if (deps.isDisposed()) return
        await handleProviderCommand(raw)
      }).catch((error: unknown) => {
        if (!deps.isDisposed()) deps.appendNotice(`Could not read providers: ${errorChain(error)}`, 'error')
      })
    },
    clearOverlay(): void {
      overlay = undefined
      wizard = undefined
      flowAbort?.abort()
      flowAbort = undefined
    },
  }
}

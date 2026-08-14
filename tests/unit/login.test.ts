/**
 * Provider sign-in at the terminal boundary: what `/login` offers on a machine
 * that has configured nothing, what reaches the screen while a key is typed,
 * and what is written — and not written — for each answer an endpoint can give.
 *
 * The cases that matter here are the ones no type can state. A key must never
 * be echoed, never appear in a notice, and never be stored after the endpoint
 * has already rejected it; and the sentence about when a provider starts
 * working has to come from the deployment rather than from an assumption made
 * when this was written.
 * @module dsh-tui/tests/unit/login
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import type { LlmDiscoveredModel, LlmModelDiscoveryRequest } from '@deepseek-ai/dsh-llm'
import {
  createTuiTestHarness,
  disposeTuiTestHarness,
  tuiEntryAvailable,
  type TuiHarness,
  type TuiHarnessOptions,
} from '../harness.ts'
import { HeadlessTerminal } from '../headless-terminal.ts'

/** `src/index.ts` is landed by a separate port; without it this suite cannot run. */
const entryAvailable = await tuiEntryAvailable()
const skipWithoutEntry = entryAvailable
  ? false
  : 'requires src/index.ts to export createTuiChat(ctx, config, runtime)'

/** The store publishes one snapshot per 16 ms frame; settle by outwaiting it. */
const SETTLE_MS = 80

/**
 * A key that is not one.
 *
 * Deliberately long enough that the masking rule keeps a tail, and deliberately
 * ending in characters no other assertion in this file contains, so "the tail
 * is shown" and "the key is not" can be told apart.
 */
const FAKE_KEY = 'sk-not-a-real-key-0000000000-WXYZ'

/** What the masking rule leaves of {@link FAKE_KEY}. */
const MASKED_TAIL = 'WXYZ'

/** The namespace the fake adapter directory configures its routes through. */
const NS = 'llm-pi-ai'

type Harness = TuiHarness<HeadlessTerminal, (code: number) => void>

/** One recorded settings write. */
interface SettingsWrite {
  ns: string
  ops: { op: string; path: readonly string[]; value?: unknown }[]
}

/** One recorded credential write; the value is kept so a case can prove it was stored. */
type CredentialWrite = [ref: string, value: string]

interface Recorder {
  readonly settingsWrites: SettingsWrite[]
  readonly credentialWrites: CredentialWrite[]
  readonly services: Record<string, unknown>
}

/**
 * Fake the two host services a saved provider is written through.
 * @param section - the settings section the namespace already holds.
 * @param applies - the effect timing the owner declares; `null` declares none.
 * @returns the recorded writes and the services to mount.
 */
function recordingServices(section: unknown = {}, applies: string | null = 'live'): Recorder {
  const settingsWrites: SettingsWrite[] = []
  const credentialWrites: CredentialWrite[] = []
  return {
    settingsWrites,
    credentialWrites,
    services: {
      settings: {
        get: (ns: string) => ns === NS ? section : {},
        mutate: async (ns: string, ops: SettingsWrite['ops']) => {
          settingsWrites.push({ ns, ops: [...ops] })
        },
        describe: () => applies === null ? [{ ns: NS }] : [{ ns: NS, applies }],
      },
      credentials: {
        set: async (ref: string, value: string) => { credentialWrites.push([ref, value]) },
      },
    },
  }
}

/** The adapter directory entry a fresh machine sees for DeepSeek's official endpoint. */
const DEEPSEEK_DIRECTORY = {
  provider: 'deepseek',
  displayName: 'deepseek',
  settingsNs: NS,
  settingsPath: ['providers', 'deepseek'],
  declared: false,
}

/** A configured route with an endpoint of its own, so it can actually be probed. */
const ACME_SECTION = {
  providers: {
    acme: {
      baseURL: 'https://api.acme.test/v1',
      api: 'openai-completions',
      apiKeyEnv: 'ACME_API_KEY',
      displayName: 'Acme',
    },
  },
}

/** Throw the shape the adapter's discovery path throws, code and all. */
function discoveryError(message: string, code = 'DISCOVERY_FAILED'): Error {
  return Object.assign(new Error(message), { code })
}

async function mount(options: TuiHarnessOptions = {}): Promise<Harness> {
  const terminal = new HeadlessTerminal(100, 30)
  const harness = await createTuiTestHarness(terminal, () => {}, {
    cwd: '/workspace/project',
    ...options,
    config: {
      title: 'DSH login',
      welcome: 'ready.',
      theme: { color: false, inputPrompt: 'dsh> ' },
      ...options.config,
    },
  })
  await delay(SETTLE_MS)
  return harness
}

async function unmount(harness: Harness): Promise<void> {
  await disposeTuiTestHarness(harness)
  await harness.terminal.dispose()
}

/** Type a command line and let the surface it opens settle. */
async function run(harness: Harness, line: string): Promise<string> {
  harness.terminal.send(line)
  harness.terminal.send('\r')
  await delay(SETTLE_MS)
  return harness.terminal.text()
}

/** Send one chunk and settle, the way a paste or a key press arrives. */
async function press(harness: Harness, data: string): Promise<string> {
  harness.terminal.send(data)
  await delay(SETTLE_MS)
  return harness.terminal.text()
}

describe('provider commands are discoverable', { skip: skipWithoutEntry }, () => {
  it('registers both into the list /help and autocomplete are generated from', async () => {
    // Asserted against the registry rather than against the rendered help page:
    // the page is a scrolling panel, so what is on screen is a fact about panel
    // geometry, while what is registered is the fact that decides whether the
    // page, the autocomplete menu, and the README's table can name these at
    // all. The docs suite holds the README to this same list.
    const harness = await mount({
      catalog: { providers: [], models: [] },
      services: recordingServices().services,
    })
    try {
      const registered = harness.ctx.commands.list(harness.agent).map(command => command.name)
      assert.ok(registered.includes('login'), `/login is registered: ${registered.join(', ')}`)
      assert.ok(registered.includes('provider'), `/provider is registered: ${registered.join(', ')}`)
    } finally {
      await unmount(harness)
    }
  })
})

describe('/login provider roster', { skip: skipWithoutEntry }, () => {
  it('offers a catalog provider on a machine whose settings hold none', async () => {
    // The fresh-machine case: without the adapter directory the picker would be
    // empty and there would be no way to configure a first provider from the
    // terminal at all.
    const recorder = recordingServices({})
    const harness = await mount({
      catalog: {
        providers: [],
        models: [],
        configurableProviders: [DEEPSEEK_DIRECTORY],
      },
      services: recorder.services,
    })
    try {
      const screen = await run(harness, '/login')
      assert.match(screen, /Available to configure/u, `the catalog group is offered:\n${screen}`)
      assert.match(screen, /deepseek/u, `DeepSeek's official route is listed:\n${screen}`)
    } finally {
      await unmount(harness)
    }
  })

  it('separates a configured route from one that only could be', async () => {
    const recorder = recordingServices(ACME_SECTION)
    const harness = await mount({
      catalog: {
        providers: [],
        models: [],
        configurableProviders: [DEEPSEEK_DIRECTORY],
      },
      services: recorder.services,
    })
    try {
      const screen = await run(harness, '/login')
      assert.match(screen, /Configured/u, `the stored route is grouped as configured:\n${screen}`)
      assert.match(screen, /key in ACME_API_KEY/u, `the row names the variable, never a key:\n${screen}`)
      assert.match(screen, /Available to configure/u, `the catalog group survives beside it:\n${screen}`)
    } finally {
      await unmount(harness)
    }
  })
})

describe('/login key entry', { skip: skipWithoutEntry }, () => {
  it('never echoes the key, and stores it once the endpoint accepts it', async () => {
    const recorder = recordingServices(ACME_SECTION)
    const asked: LlmModelDiscoveryRequest[] = []
    const harness = await mount({
      catalog: {
        providers: [],
        models: [],
        discoverModels: async (_ns: string, request: LlmModelDiscoveryRequest) => {
          asked.push(request)
          return [{ id: 'acme-large', name: 'Acme Large' }] satisfies LlmDiscoveredModel[]
        },
      },
      services: recorder.services,
    })
    try {
      await run(harness, '/login acme')
      const typed = await press(harness, FAKE_KEY)
      assert.doesNotMatch(typed, /sk-not-a-real-key/u, `the key is not echoed:\n${typed}`)
      assert.match(typed, /•/u, `the field shows dots instead:\n${typed}`)

      const done = await press(harness, '\r')
      // The probe carries the endpoint and the key rather than the route name:
      // naming the route would be answered from the adapter's own catalog with
      // no request at all, which cannot reject a credential.
      assert.equal(asked.length, 1, 'the endpoint was interrogated exactly once')
      assert.equal(asked[0]?.apiKey, FAKE_KEY, 'the candidate key is what was checked')
      assert.equal(asked[0]?.provider, undefined, 'the route name is withheld so the probe is a real one')

      assert.deepEqual(recorder.credentialWrites, [['ACME_API_KEY', FAKE_KEY]],
        'the secret goes to the credential store')
      assert.deepEqual(recorder.settingsWrites, [{
        ns: NS,
        ops: [{ op: 'set', path: ['providers', 'acme', 'apiKeyEnv'], value: 'ACME_API_KEY' }],
      }], 'settings record the variable name and nothing else')
      assert.doesNotMatch(done, /sk-not-a-real-key/u, `the notice does not carry the key:\n${done}`)
      assert.match(done, new RegExp(MASKED_TAIL, 'u'), `the notice names the masked tail:\n${done}`)
      assert.match(done, /accepted it/u, `the notice says the endpoint accepted it:\n${done}`)
    } finally {
      await unmount(harness)
    }
  })

  it('refuses a key the endpoint rejected, and writes nothing at all', async () => {
    // The distinction this rests on is only in the message text: the adapter
    // codes a refused credential and an unreachable host identically.
    const recorder = recordingServices(ACME_SECTION)
    const harness = await mount({
      catalog: {
        providers: [],
        models: [],
        discoverModels: async () => {
          throw discoveryError('https://api.acme.test/v1/models answered 401; check the API key')
        },
      },
      services: recorder.services,
    })
    try {
      await run(harness, '/login acme')
      await press(harness, FAKE_KEY)
      const screen = await press(harness, '\r')
      assert.match(screen, /rejected that key/u, `the refusal is stated:\n${screen}`)
      assert.match(screen, /Nothing was saved/u, `and the consequence is stated:\n${screen}`)
      assert.deepEqual(recorder.credentialWrites, [], 'a rejected key is not stored')
      assert.deepEqual(recorder.settingsWrites, [], 'and no profile is written for it')
    } finally {
      await unmount(harness)
    }
  })

  it('asks before storing a key it could not check, then stores it on a yes', async () => {
    const recorder = recordingServices(ACME_SECTION)
    const harness = await mount({
      catalog: {
        providers: [],
        models: [],
        discoverModels: async () => {
          throw discoveryError('could not reach https://api.acme.test/v1/models')
        },
      },
      services: recorder.services,
    })
    try {
      await run(harness, '/login acme')
      await press(harness, FAKE_KEY)
      const asked = await press(harness, '\r')
      assert.match(asked, /Key not verified/u, `the unchecked case is named:\n${asked}`)
      assert.deepEqual(recorder.credentialWrites, [], 'nothing is written before the answer')

      const saved = await press(harness, '\r')
      assert.deepEqual(recorder.credentialWrites, [['ACME_API_KEY', FAKE_KEY]],
        'the explicit yes is what stores it')
      assert.match(saved, /not checked against the endpoint/u,
        `the notice refuses to claim it works:\n${saved}`)
    } finally {
      await unmount(harness)
    }
  })

  it('stores a catalog route without pretending it checked anything', async () => {
    // A catalog route's endpoint comes from the adapter's own registry, which
    // this terminal cannot read, so there is nothing here to interrogate.
    const recorder = recordingServices({})
    const harness = await mount({
      catalog: {
        providers: [],
        models: [],
        configurableProviders: [DEEPSEEK_DIRECTORY],
      },
      services: recorder.services,
    })
    try {
      await run(harness, '/login deepseek')
      await press(harness, FAKE_KEY)
      const done = await press(harness, '\r')
      assert.deepEqual(recorder.credentialWrites, [['DEEPSEEK_API_KEY', FAKE_KEY]],
        'the variable name is derived from the route')
      assert.deepEqual(recorder.settingsWrites, [{
        ns: NS,
        ops: [{ op: 'set', path: ['providers', 'deepseek', 'apiKeyEnv'], value: 'DEEPSEEK_API_KEY' }],
      }], 'a catalog route needs no endpoint written: the adapter supplies it')
      assert.match(done, /not checked against the endpoint/u,
        `an unprobed route is reported as unprobed:\n${done}`)
    } finally {
      await unmount(harness)
    }
  })
})

describe('/login effect reporting', { skip: skipWithoutEntry }, () => {
  it('says a provider is live only when the namespace owner says so', async () => {
    const recorder = recordingServices(ACME_SECTION, 'live')
    const harness = await mount({
      catalog: { providers: [], models: [], discoverModels: async () => [] },
      services: recorder.services,
    })
    try {
      await run(harness, '/login acme')
      await press(harness, FAKE_KEY)
      const done = await press(harness, '\r')
      assert.match(done, /live now/u, `a live namespace is reported as live:\n${done}`)
    } finally {
      await unmount(harness)
    }
  })

  it('tells the user to restart when the owner declares a restart', async () => {
    const recorder = recordingServices(ACME_SECTION, 'restart')
    const harness = await mount({
      catalog: { providers: [], models: [], discoverModels: async () => [] },
      services: recorder.services,
    })
    try {
      await run(harness, '/login acme')
      await press(harness, FAKE_KEY)
      const done = await press(harness, '\r')
      assert.match(done, /Restart dsh/u, `a restart namespace is reported as one:\n${done}`)
      assert.doesNotMatch(done, /live now/u, 'and is never called live')
    } finally {
      await unmount(harness)
    }
  })

  it('admits it cannot tell when the deployment declares nothing', async () => {
    // The honest third answer. A terminal that guessed "live" here would send
    // the user to a /model list that may not have moved.
    const recorder = recordingServices(ACME_SECTION, null)
    const harness = await mount({
      catalog: { providers: [], models: [], discoverModels: async () => [] },
      services: recorder.services,
    })
    try {
      await run(harness, '/login acme')
      await press(harness, FAKE_KEY)
      const done = await press(harness, '\r')
      assert.match(done, /does not say/u, `the uncertainty is stated:\n${done}`)
      assert.doesNotMatch(done, /live now/u, 'and nothing is claimed to be live')
    } finally {
      await unmount(harness)
    }
  })
})

describe('/provider', { skip: skipWithoutEntry }, () => {
  it('lists what is configured and what /login could configure', async () => {
    const recorder = recordingServices(ACME_SECTION)
    const harness = await mount({
      catalog: {
        providers: [],
        models: [],
        configurableProviders: [DEEPSEEK_DIRECTORY],
        discoverModels: async () => [],
      },
      services: recorder.services,
    })
    try {
      const screen = await run(harness, '/provider')
      assert.match(screen, /Configured:/u, `configured routes are listed:\n${screen}`)
      assert.match(screen, /acme/u, `by name:\n${screen}`)
      assert.match(screen, /Available to configure with \/login/u,
        `and the catalog routes point at the command that configures them:\n${screen}`)
    } finally {
      await unmount(harness)
    }
  })

  it('walks a new route through to a profile with its discovered models', async () => {
    const recorder = recordingServices({})
    const harness = await mount({
      catalog: {
        providers: [],
        models: [],
        discoverModels: async () => [
          { id: 'zeta-1', name: 'Zeta One' },
          { id: 'zeta-2' },
        ] satisfies LlmDiscoveredModel[],
      },
      services: recorder.services,
    })
    try {
      await run(harness, '/provider add')
      await press(harness, 'zeta')
      await press(harness, '\r')
      await press(harness, 'https://api.zeta.test/v1')
      await press(harness, '\r')
      // Protocol: the first row is the OpenAI-shaped one, which is the only
      // family this endpoint could have been interrogated over.
      await press(harness, '\r')
      // Display name: left empty, so the route name stands in.
      await press(harness, '\r')
      // Credential variable: accepted as derived.
      const keyStep = await press(harness, '\r')
      assert.match(keyStep, /ZETA_API_KEY/u, `the derived variable is shown:\n${keyStep}`)

      await press(harness, FAKE_KEY)
      const models = await press(harness, '\r')
      assert.match(models, /zeta-1/u, `discovered models are offered:\n${models}`)
      assert.match(models, /\[x\]/u, `ticked by default:\n${models}`)

      const done = await press(harness, '\r')
      assert.deepEqual(recorder.credentialWrites, [['ZETA_API_KEY', FAKE_KEY]],
        'the key reaches the credential store under the chosen variable')
      const write = recorder.settingsWrites[0]
      assert.equal(write?.ns, NS)
      assert.deepEqual(write?.ops, [
        { op: 'set', path: ['providers', 'zeta', 'apiKeyEnv'], value: 'ZETA_API_KEY' },
        { op: 'set', path: ['providers', 'zeta', 'baseURL'], value: 'https://api.zeta.test/v1' },
        { op: 'set', path: ['providers', 'zeta', 'api'], value: 'openai-completions' },
        {
          op: 'set',
          path: ['providers', 'zeta', 'models'],
          value: [{ id: 'zeta-1', name: 'Zeta One' }, { id: 'zeta-2' }],
        },
      ], 'the profile is written field by field, never by replacing the section')
      assert.doesNotMatch(done, /sk-not-a-real-key/u, `and the key stays out of the notice:\n${done}`)
    } finally {
      await unmount(harness)
    }
  })

  it('refuses a route name that is already configured', async () => {
    const recorder = recordingServices(ACME_SECTION)
    const harness = await mount({
      catalog: { providers: [], models: [], discoverModels: async () => [] },
      services: recorder.services,
    })
    try {
      await run(harness, '/provider add')
      await press(harness, 'acme')
      const screen = await press(harness, '\r')
      assert.match(screen, /already configured/u, `the collision is refused:\n${screen}`)
      assert.match(screen, /\/login/u, `and the command that does re-key it is named:\n${screen}`)
    } finally {
      await unmount(harness)
    }
  })
})

/**
 * Fake TUI harness: composes the production TUI around a real Cordis context,
 * an in-memory session, and a controllable fake agent, so tests drive the UI
 * through a terminal boundary instead of a live model.
 *
 * Ported from the upstream DeepSeek Harness TUI suite and realigned to
 * dsh 0.1.0-rc.6: the agent contract is `send(message, target, wakeup)` plus a
 * real {@link Inbox} projection, user questions live on `ctx.userQuestions`,
 * and the session-query seam is `SessionQueryEngine`.
 * @module dsh-tui/tests/harness
 */

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import type { Terminal } from '@earendil-works/pi-tui'
import AgentRegistry, {
  agentEvents,
  Inbox,
  type Agent,
  type AgentCancelCause,
  type AgentOptions,
  type AgentStatus,
  type CancelOptions,
  type InboxTarget,
} from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  LlmConfigurableProvider,
  LlmDiscoveredModel,
  LlmModelDiscoveryRequest,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  TokenUsage,
} from '@deepseek-ai/dsh-llm'
import SessionStore, {
  SessionId,
  type Session,
  type SessionEvent,
  type SessionHeader,
  type UserMessage,
} from '@deepseek-ai/dsh-session'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolDefinition } from '@deepseek-ai/dsh-tools'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import TuiPromptService from '../src/prompt.ts'
import type { Config } from '../src/config.ts'
import type { TuiRuntime } from '../src/runtime.ts'

/** Lifecycle handle a mounted interactive terminal channel returns. */
export interface TuiControllerHandle {
  /** Stop rendering, restore the terminal, and reject pending questions. */
  dispose(): Promise<void>
}

/**
 * The entry point this harness mounts. Declared structurally rather than
 * imported statically because `src/index.ts` is landed by a separate port; the
 * suite must load (and skip) without it.
 */
export type CreateTuiChat = (ctx: Context, config: Config, runtime: TuiRuntime) => TuiControllerHandle

/** Test-only backend-independent query engine: the surface reads stay real, the search results are empty. */
export class TestSessionQueryEngine extends SessionQueryEngine {
  override searchSessions(
    ..._args: Parameters<SessionQueryEngine['searchSessions']>
  ): ReturnType<SessionQueryEngine['searchSessions']> {
    return Promise.resolve({ items: [] })
  }

  override searchEvents(
    ...args: Parameters<SessionQueryEngine['searchEvents']>
  ): ReturnType<SessionQueryEngine['searchEvents']> {
    return this.readSurface(args[0].sessionId).then(surface => ({
      session: surface.session,
      items: [],
    }))
  }
}

/** One `Agent.send()` call, recorded with its rc.6 routing arguments. */
export interface SentDelivery {
  message: UserMessage
  target: InboxTarget
  wakeup: boolean
}

/** One `Agent.cancel()` call, recorded with its options. */
export interface CancelRecord {
  cause: AgentCancelCause
  options: CancelOptions | undefined
}

/**
 * A live agent whose driver is the test. Every routing method records its input
 * and mirrors it into a real {@link Inbox}, so inbox-derived UI (pending badges,
 * claimed/discarded notices) sees production-shaped projections and events.
 */
export interface FakeAgent extends Agent {
  /** Mutable so a test can flip lifecycle state before emitting `agent/status`. */
  status: AgentStatus
  /** Every `send()` in call order. */
  readonly sent: SentDelivery[]
  /** Every `followup()` in call order. */
  readonly followups: UserMessage[]
  /** Every `steer()` in call order. */
  readonly steered: UserMessage[]
  /** Every `inject()` in call order. */
  readonly injected: UserMessage[]
  /** Every `cancel()` in call order. */
  readonly cancelled: CancelRecord[]
  /** Every `runMaintenance()` task, in call order. */
  readonly maintenance: ((signal: AbortSignal) => Promise<unknown>)[]
}

/** Advisory model catalog the fake `ctx.llm` serves to the model selector. */
export interface FakeLlmCatalog {
  providers: LlmProviderInfo[]
  models: LlmModelInfo[]
  listModels?: (provider: string) => Promise<LlmModelInfo[]>
  resolveModelInfo?: (
    provider: string,
    model: string,
  ) => Promise<Pick<LlmResolvedModelInfo, 'context' | 'reasoning'>>
  /**
   * Provider routes an adapter could activate through configuration, whether or
   * not one is registered. This is the directory `/login` reads to offer a
   * provider on a machine whose settings hold none, so a case about the
   * fresh-machine path supplies it and no other case has to.
   */
  configurableProviders?: LlmConfigurableProvider[]
  /**
   * Endpoint interrogation, standing in for the adapter's discovery path.
   *
   * Supplying it is how a login case exercises a probe without a socket: the
   * production code reaches the endpoint only through this service method, so a
   * fake here is the whole of the network boundary.
   */
  discoverModels?: (
    settingsNs: string,
    request: LlmModelDiscoveryRequest,
  ) => Promise<readonly LlmDiscoveredModel[]>
}

/** Fake `ctx.sessionPersistence` surface the resume flows read. */
export interface FakeSessionPersistence {
  list(): Promise<SessionHeader[]>
  load?(id: SessionId): Promise<{ meta: SessionHeader; events: readonly SessionEvent[] }>
  /** Per-session artifact location for mtime-based activity; defaults to none. */
  locate?(meta: SessionHeader): { kind: string; path: string } | undefined
}

export interface TuiHarnessOptions {
  status?: AgentStatus
  config?: Config
  /** Leave the session event log empty instead of seeding one turn and step. */
  omitInitialLifecycle?: boolean
  /** Omit the harness's default `welcome`, exercising the banner sweep-reveal path. */
  omitWelcome?: boolean
  tools?: Record<string, ToolDefinition>
  /** Replace the default `systemPrompt` + `tools` composition. */
  configureContext?: (ctx: Context) => Promise<void>
  /** Seed the session log before the TUI mounts, so the first frame is a replay. */
  beforeMount?: (session: Session) => void
  /** Session workspace; `null` creates the session without any `cwd` metadata. */
  cwd?: string | null
  formatCwd?: TuiRuntime['formatCwd']
  gitBranch?: TuiRuntime['gitBranch']
  /** Fake-agent creation options (`provider`/`model` seed the model selector's initial selection). */
  agentOptions?: AgentOptions
  contextWindow?: number
  contextTokens?: number
  now?: () => number
  catalog?: FakeLlmCatalog
  /** Provide a fake `sessionPersistence` service so resume surfaces can list sessions. */
  sessionPersistence?: FakeSessionPersistence
  handoffResume?: TuiRuntime['handoffResume']
  /** Provide a fake fork handoff, so the rewind surface takes its forking path. */
  handoffFork?: TuiRuntime['handoffFork']
  /** Provide a fake blank-session handoff, so `/new` takes its replacing path. */
  handoffNew?: TuiRuntime['handoffNew']
  /** Host-supplied exit line; absent exercises the no-message path. */
  goodbyeMessage?: TuiRuntime['goodbyeMessage']
  /** Set false to exercise the optional session-query degradation path. */
  mountSessionQuery?: boolean
  /**
   * Extra services provided on the test context before the TUI mounts, for the
   * optional ones it reads through `ctx.get` (`agentDefaultModel`,
   * `tuiStartup`, …). Provided last, so a name here wins over the defaults.
   */
  services?: Record<string, unknown>
}

/** Everything a mounted harness lets a test drive or inspect. */
export interface TuiHarness<TerminalType extends Terminal, Exit extends (code: number) => void> {
  ctx: Context
  session: Session
  agent: FakeAgent
  terminal: TerminalType
  exit: Exit
  controller: TuiControllerHandle
}

/** The context, session, and agent a harness mounts the TUI onto. */
export interface TuiTestContext {
  ctx: Context
  session: Session
  agent: FakeAgent
}

const DEFAULT_CATALOG: FakeLlmCatalog = {
  providers: [{ id: 'deepseek-official', name: 'DeepSeek' }],
  models: [
    { provider: 'deepseek-official', id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
    { provider: 'deepseek-official', id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
  ],
}

const TUI_ENTRY_URL = new URL('../src/index.ts', import.meta.url)

let entryProbe: Promise<CreateTuiChat | undefined> | undefined

async function importTuiEntry(): Promise<CreateTuiChat | undefined> {
  if (!existsSync(fileURLToPath(TUI_ENTRY_URL))) return undefined
  // Non-literal specifier: the module is optional at type level too, so the
  // suite typechecks before the entry lands.
  const specifier: string = TUI_ENTRY_URL.href
  const entry = await import(specifier) as { createTuiChat?: unknown }
  return typeof entry.createTuiChat === 'function' ? entry.createTuiChat as CreateTuiChat : undefined
}

/**
 * Resolve the TUI entry point once per process.
 * @returns `createTuiChat`, or undefined while `src/index.ts` is absent or does not export it.
 */
export function loadCreateTuiChat(): Promise<CreateTuiChat | undefined> {
  entryProbe ??= importTuiEntry()
  return entryProbe
}

/**
 * Whether end-to-end mounting is possible in this checkout.
 * @returns true once `src/index.ts` exports `createTuiChat`.
 */
export async function tuiEntryAvailable(): Promise<boolean> {
  return await loadCreateTuiChat() !== undefined
}

/**
 * Build the Cordis world the TUI mounts onto: the real session store, agent
 * registry, command runtime, user-question service, and TUI prompt service,
 * plus a fake agent registered under the configured session id.
 * @param options - session, agent, tool, and service configuration.
 * @returns the live context, session, and fake agent (nothing is mounted yet).
 */
export async function createTuiTestContext(options: TuiHarnessOptions = {}): Promise<TuiTestContext> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(TuiPromptService)
  const catalog = options.catalog ?? DEFAULT_CATALOG
  // Skipped when the test brings its own, because a name can only be provided
  // once: a case that counts how often the meter is read supplies a counting
  // one through `services`, and this default exists only so the prompt row has
  // a meter at all.
  if (options.services?.['tokenMeter'] === undefined) {
    ctx.provide('tokenMeter', {
      measure() {
        return { totalTokens: options.contextTokens ?? 0 }
      },
    } as never)
  }
  if (options.configureContext === undefined) {
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    for (const tool of Object.values(options.tools ?? {})) ctx.tools.register(tool)
  } else {
    await options.configureContext(ctx)
  }
  // A configureContext may mount the real LlmRuntime; only fill the
  // advisory-catalog stub when none was provided.
  if (ctx.get('llm') === undefined) {
    ctx.provide('llm', {
      listProviders() {
        return catalog.providers.map(provider => ({ ...provider }))
      },
      listModels(provider: string) {
        return catalog.listModels?.(provider)
          ?? Promise.resolve(catalog.models.filter(model => model.provider === provider).map(model => ({ ...model })))
      },
      listConfigurableProviders() {
        return (catalog.configurableProviders ?? []).map(entry => ({ ...entry }))
      },
      discoverModels(settingsNs: string, request: LlmModelDiscoveryRequest) {
        if (catalog.discoverModels === undefined) {
          return Promise.reject(new Error('this fake catalog was not given a discovery implementation'))
        }
        return catalog.discoverModels(settingsNs, request)
      },
      async resolveModelInfo(provider: string, model: string) {
        const advertised = catalog.models.find(candidate =>
          candidate.provider === provider && candidate.id === model)
        const capabilities = await (catalog.resolveModelInfo?.(provider, model)
          ?? Promise.resolve({
            context: { contextWindow: options.contextWindow ?? 128_000 },
          }))
        return {
          provider,
          id: model,
          name: advertised?.name ?? model,
          ...advertised?.description === undefined ? {} : { description: advertised.description },
          ...capabilities,
        }
      },
    } as never)
  }
  if (ctx.get('systemPrompt') === undefined) await ctx.plugin(SystemPrompt)
  if (options.sessionPersistence !== undefined) {
    const persistence = options.sessionPersistence
    const missing = (id: SessionId): Promise<never> => Promise.reject(new Error(`session "${id}" not found`))
    const read = persistence.load === undefined
      ? missing
      : (id: SessionId) => persistence.load!(id)
    ctx.provide('sessionPersistence', {
      ...persistence,
      locate: (meta: SessionHeader) => persistence.locate?.(meta),
      create: () => Promise.resolve(),
      append: () => Promise.resolve(),
      load: read,
      inspect: read,
    } as never)
  }
  if (options.mountSessionQuery !== false && ctx.get('sessionQuery') === undefined) {
    await ctx.plugin(TestSessionQueryEngine)
  }
  for (const [service, value] of Object.entries(options.services ?? {})) {
    ctx.provide(service, value as never)
  }
  const sessionId = SessionId(options.config?.sessionId ?? 'main-session')
  const session = ctx.sessions.create(
    sessionId,
    options.cwd === null ? undefined : { meta: { cwd: options.cwd ?? '/workspace' } },
  )
  if (options.omitInitialLifecycle !== true) {
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
  }
  options.beforeMount?.(session)
  const agent = registerFakeAgent(ctx, session, options)
  return { ctx, session, agent }
}

/** Register a driver-free agent whose routing calls are recorded and projected. */
function registerFakeAgent(ctx: Context, session: Session, options: TuiHarnessOptions): FakeAgent {
  const sent: SentDelivery[] = []
  const followups: UserMessage[] = []
  const steered: UserMessage[] = []
  const injected: UserMessage[] = []
  const cancelled: CancelRecord[] = []
  const maintenance: ((signal: AbortSignal) => Promise<unknown>)[] = []
  // The notifications close over `agent`, which the inbox construction precedes;
  // every publication happens after registration, so the binding is always set.
  let agent: FakeAgent
  const inbox = new Inbox(session, {
    inserted(message) {
      agentEvents(ctx, agent).emit('agent/inbox/inserted', { message })
    },
    discarded(message) {
      agentEvents(ctx, agent).emit('agent/inbox/discarded', { message })
    },
    claimed(message, turn) {
      agentEvents(ctx, agent).emit('agent/inbox/claimed', { message, turn })
    },
  })
  agent = {
    id: session.id,
    options: options.agentOptions ?? { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    session,
    inbox,
    status: options.status ?? 'idle',
    ctx,
    sent,
    followups,
    steered,
    injected,
    cancelled,
    maintenance,
    send(message, target, wakeup) {
      sent.push({ message, target, wakeup })
      inbox.append(target, message)
    },
    followup(message) {
      followups.push(message)
      inbox.append('next-turn', message)
    },
    steer(message) {
      steered.push(message)
      inbox.append('next-step', message)
    },
    inject(message) {
      injected.push(message)
      inbox.append('next-step', message)
    },
    cancel(cause, cancelOptions) {
      cancelled.push({ cause, options: cancelOptions })
    },
    runMaintenance(task) {
      maintenance.push(task)
      return task(new AbortController().signal)
    },
    whenIdle() {
      return Promise.resolve()
    },
  }
  ctx.agents.register(agent)
  return agent
}

/**
 * Compose the production TUI around an in-memory session and controllable agent.
 * @param terminal - Terminal boundary driven by the test.
 * @param exit - Process-exit observer.
 * @param options - Initial session, agent, tool, and TUI configuration.
 * @returns The mounted TUI and every boundary the test may drive or inspect.
 * @throws when `src/index.ts` does not export `createTuiChat` yet.
 */
export async function createTuiTestHarness<TerminalType extends Terminal, Exit extends (code: number) => void>(
  terminal: TerminalType,
  exit: Exit,
  options: TuiHarnessOptions = {},
): Promise<TuiHarness<TerminalType, Exit>> {
  const createTuiChat = await loadCreateTuiChat()
  if (createTuiChat === undefined) {
    throw new Error('dsh-tui tests: src/index.ts does not export createTuiChat yet')
  }
  const { ctx, session, agent } = await createTuiTestContext(options)
  const controller = createTuiChat(ctx, Object.assign({
    ...options.omitWelcome === true ? {} : { welcome: 'Coding agent ready.' },
    sessionId: session.id,
    theme: { color: false },
  }, options.config), {
    terminal,
    exit,
    // Default to the real clock (runtime.now falls back to Date.now) so the
    // elapsed-status cases can drive time through timers; a test pins the clock
    // only by passing `now` explicitly.
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.formatCwd === undefined ? {} : { formatCwd: options.formatCwd }),
    ...(options.handoffResume === undefined ? {} : { handoffResume: options.handoffResume }),
    ...(options.handoffFork === undefined ? {} : { handoffFork: options.handoffFork }),
    ...(options.handoffNew === undefined ? {} : { handoffNew: options.handoffNew }),
    ...(options.goodbyeMessage === undefined ? {} : { goodbyeMessage: options.goodbyeMessage }),
    gitBranch: options.gitBranch ?? (() => 'tui-staging'),
  })
  return { ctx, session, agent, terminal, exit, controller }
}

/** Dispose the mounted TUI before its owning Cordis context. */
export async function disposeTuiTestHarness(
  setup: Pick<TuiHarness<Terminal, (code: number) => void>, 'controller' | 'ctx'>,
): Promise<void> {
  await setup.controller.dispose()
  await setup.ctx.fiber.dispose()
}

/**
 * Flip the fake agent's lifecycle state and publish the transition the UI
 * mirrors, exactly as the real loop does.
 * @param agent - the fake agent to transition.
 * @param status - the status just entered.
 */
export function setAgentStatus(agent: FakeAgent, status: AgentStatus): void {
  agent.status = status
  agentEvents(agent.ctx, agent).emit('agent/status', { status })
}

/** Append a production-shaped user message to the active session surface. */
export function appendUser(session: Session, text: string): void {
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

/** Append a production-shaped assistant message to the active session surface. */
export function appendAssistant(
  session: Session,
  content: ContentBlock[],
  usage?: TokenUsage,
  position: { turn: number; step: number } = { turn: 1, step: 1 },
): void {
  session.append('assistant/message', {
    ...position,
    message: createMessage({
      role: 'assistant',
      content,
      source: { kind: 'model', provider: 'mock', model: 'deepseek-v4-flash' },
    }),
    ...usage === undefined ? {} : { usage },
  }, { surfaceOp: 'append' })
}

/**
 * Join a message's text blocks, so assertions read prompts rather than blocks.
 * @param message - any identified message recorded by the fake agent.
 * @returns the concatenated text content.
 */
export function messageText(message: UserMessage): string {
  return message.content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/**
 * Interactive pi-tui front door for DeepSeek Harness agents. It renders the
 * durable session transcript, drives one agent it owns for the process, and
 * provides keyboard-driven user-question dialogs.
 *
 * Unlike the upstream front door, this bundle owns the agent lifecycle: the
 * `tui-runner` row reads the `tuiStartup` service parsed by `dsh-tui/startup`,
 * creates or resumes the agent itself, and mounts the chat over it.
 * @module dsh-tui
 */

import { randomUUID } from 'node:crypto'
import { resolve as resolvePath } from 'node:path'
import {
  CombinedAutocompleteProvider,
  Container,
  Key,
  ProcessTerminal,
  Spacer,
  Text,
  TuiMainScreen,
  isKeyRelease,
  isKeyRepeat,
  matchesKey,
  type Component,
  type EditorTheme,
  type SlashCommand,
  type TerminalColorScheme,
  type TUI,
} from '@earendil-works/pi-tui'
import { Service, type Context, type Fiber, type FiberState } from '@deepseek-ai/cordis'
import {
  assembleContextFor,
  installModelSelection,
  type Agent,
  type AgentHandle,
  type AgentOptions,
  type AgentStatus,
  type ModelSelection,
  type ModelSelectionRef,
} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-loop'
import type {} from '@deepseek-ai/dsh-token-meter'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { createUserMessage, errorChain } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, MessageId, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-llm-retry'
// Type import declaration-merges the compaction bracket events onto the
// session event map, so `compaction/start` / `compaction/end` are typed here.
import type {} from '@deepseek-ai/dsh-compaction'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import {
  SessionId,
  type Session,
  type SessionHeader,
  type UserMessage,
} from '@deepseek-ai/dsh-session'
import { foldGoal } from '@deepseek-ai/dsh-goal'
import { parseSessionReferenceText } from '@deepseek-ai/dsh-session-reference'
// Type import declaration-merges the `session/title` event onto the session
// event map, which the store folds into the snapshot's title.
import type {} from '@deepseek-ai/dsh-session-title'
// Type import also declaration-merges the optional `sessionPersistence`
// service onto `Context` so `ctx.get('sessionPersistence')` is typed.
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { SkillRegistry } from '@deepseek-ai/dsh-skill'
// Type import declaration-merges the `userQuestions` service onto `Context`;
// the ask-user-question queue is registered by ./chat/questions.
import type {} from '@deepseek-ai/dsh-user-questions'
// Declaration-merges the `approval/request` waterfall onto `Events`; the
// terminal answerer below is registered for this TUI's own agent only.
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import {
  TuiExtensionServiceImpl,
  TuiOverlayManager,
} from './extension/overlay-manager.ts'

import {
  parseTuiPromptTemplate,
  renderTuiPromptTemplate,
  TuiPromptService,
  type TuiPromptValueHandle,
} from './prompt.ts'
import type {
  TuiOverlayRequest,
  TuiOverlaySession,
  TuiTheme,
} from './extension/types.ts'
import { ApprovalDialog } from './components/approval.ts'
import { displayInlineText, displayText } from './components/text.ts'
import { brandText, createPalette, markdownTheme, renderPalette, selectTheme } from './components/theme.ts'
import { TranscriptReconciler } from './components/reconciler.ts'
import { SessionStore } from './core/session-store.ts'
import type { SessionSnapshot } from './core/types.ts'
import {
  cacheHitRate,
  formatTokens,
  recordEventUsage,
  sessionTokens,
} from './chat/tokens.ts'
import {
  fadeGlyph,
  formatQueuedStatus,
  formatStatusDuration,
  openStepPhase,
  openTurn,
  pulseLevel,
  runningPhaseGlyph,
  STATUS_ANIMATION_INTERVAL_MS,
  STATUS_FADE_MS,
  StepTimingTracker,
  TIMING_BUCKET_GLYPHS,
} from './chat/timing.ts'
import {
  resolveTuiConfig,
  type Config,
} from './config.ts'
import {
  type ToolCardVisibility,
  HeaderComponent,
  TodoComponent,
} from './components/transcript.ts'
import {
  compactTargetLabel,
  DetailsDialog,
  diagnosticMeter,
  formatDiagnosticCount,
  formatDiagnosticNumber,
  formatDiagnosticTime,
  initialTarget,
  StatusCardComponent,
  PromptContextComponent,
  targetLabel,
  type DetailsSelection,
  type StatusCardRow,
} from './components/dialogs.ts'
import {
  parseSkillCommand,
  renderSkillInvocation,
  SKILL_COMMAND_PREFIX,
} from './chat/skill-invocation.ts'
import { ReferenceAutocompleteProvider } from './chat/autocomplete.ts'
import {
  BANNER_REVEAL_INTERVAL_MS,
  BANNER_REVEAL_STEPS,
  formatCwd,
  gitBranch,
  HintEditor,
  packageVersion,
  shortSessionId,
} from './chat/helpers.ts'
import {
  createModelController,
  type ModelController,
} from './chat/model-command.ts'
import { createQuestionQueue } from './chat/questions.ts'
import { createResumeController } from './chat/resume.ts'
import type { TuiResumeHost, TuiRuntime } from './runtime.ts'
import { WorkspaceFileSearch } from './chat/file-autocomplete.ts'
import type { TuiStartupValues } from './startup.ts'

export { TuiPromptService } from './prompt.ts'
export { renderSkillInvocation } from './chat/skill-invocation.ts'
export type { TuiResumeHost, TuiRuntime } from './runtime.ts'
export {
  resolveTuiConfig,
  TuiConfigSchema,
  Config,
  type ResolvedTuiConfig,
  type ResolvedTuiThemeConfig,
  type TuiConfig,
  type TuiThemeConfig,
} from './config.ts'
export {
  DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES,
  DEFAULT_FILE_SEARCH_MAX_ENTRIES,
  DEFAULT_FILE_SEARCH_MAX_RESULTS,
} from './chat/file-autocomplete.ts'

export type {
  TuiComponent,
  TuiFocusable,
  TuiOverlayAnchor,
  TuiOverlayCloseReason,
  TuiOverlayHost,
  TuiOverlayMargin,
  TuiOverlayOptions,
  TuiOverlayOutcome,
  TuiOverlayRequest,
  TuiOverlaySession,
  TuiOverlayState,
  TuiTheme,
  TuiViewport,
} from './extension/types.ts'

/** First terminal Cordis state: FAILED, DISPOSED, and UNLOADING are unusable. */
const FIBER_FAILED = 3 as FiberState.FAILED

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Terminal-only interaction service, available only while a TUI is mounted. */
    tui: TuiExtensionService
    /** Optional process host that can replace this TUI with a resumed session. */
    tuiResumeHost: TuiResumeHost
    /** Command line parsed by the `dsh-tui/startup` row. */
    tuiStartup: TuiStartupValues
    /** Launcher-owned `main` session identity; absent lets the app mint one. */
    mainSessionId: MainSessionIdentity | undefined
    /** Line the launcher wants printed on exit; absent prints nothing. */
    tuiGoodbyeMessage: string | undefined
    /** Skill the launcher wants auto-invoked as the fresh session's first turn; absent leaves it to the user. */
    tuiInitialSkill: string | undefined
  }
}

/** Launcher-chosen identity for the app's `main` session. */
export interface MainSessionIdentity {
  /** Exact session id `main` binds to. */
  readonly id: SessionId
  /**
   * Whether that session already has persisted history to load. `true` requires
   * an existing log and fails loud when absent; `false` creates it fresh.
   */
  readonly resume: boolean
}

/**
 * Context key a launcher sets before any Loader entry mounts
 * (`ctx.provide(MAIN_SESSION_ID_KEY, identity)`) to fix the app agent's session
 * identity, so an app bundle mounted from a `cordis.yml` binds a
 * launcher-selected session without a config key. `ctx.provide` is the only
 * channel from launcher argv into a Loader-mounted plugin, because config
 * `!!js` expressions evaluate against the entry's context. Absent leaves the
 * choice to the app (a `--resume`/`--continue` flag, else a fresh session).
 */
export const MAIN_SESSION_ID_KEY = 'mainSessionId'

/**
 * Context key a launcher sets before any Loader entry mounts
 * (`ctx.provide(TUI_GOODBYE_MESSAGE_KEY, line)`) to supply the line the TUI
 * prints once the terminal is released on exit — for the shipped CLI, the
 * command that resumes this session. The launcher owns the wording because only
 * it knows how it was invoked; the TUI escapes terminal controls before
 * rendering. Absent prints nothing.
 */
export const TUI_GOODBYE_MESSAGE_KEY = 'tuiGoodbyeMessage'

/**
 * Context key a launcher sets before any Loader entry mounts
 * (`ctx.provide(INITIAL_SKILL_KEY, name)`) to seed a fresh session's first user
 * turn with `/skill:<name>`. The launcher sets it only when minting a fresh
 * session, so it never re-fires on a resumed one. Absent leaves the first turn
 * to the user.
 */
export const INITIAL_SKILL_KEY = 'tuiInitialSkill'

/**
 * Optional terminal-local interaction service provided by one mounted TUI.
 *
 * The concrete provider retains pi-tui, focus, and terminal lifecycle state.
 * Plugins receive only effect-owned overlay sessions.
 */
export abstract class TuiExtensionService extends Service {
  /** Exact agent driven by this terminal instance. */
  abstract readonly agent: Agent

  /**
   * Queue an interactive overlay owned by the calling plugin fiber.
   *
   * The TUI displays one overlay at a time in FIFO order. Disposing the caller
   * removes a queued overlay or closes an active one before plugin teardown
   * settles. This live presentation is neither logged nor replayed.
   *
   * @param request - component factory, layout constraints, and cancellation.
   * @returns the effect-owned overlay session.
   * @throws when the TUI has begun shutting down.
   */
  abstract openOverlay(request: TuiOverlayRequest): TuiOverlaySession
}

export const name = 'dsh-tui'
export const inject = [
  'agents',
  'sessions',
  'commands',
  'userQuestions',
  'tools',
  'llm',
  'systemPrompt',
  'tokenMeter',
  'tuiStartup',
]

/** Model guidance for path-only file references selected through the TUI. */
export const FILE_REFERENCE_PROMPT = 'Paths prefixed with @ are files explicitly referenced by the user. Use the read tool when their contents are needed; do not claim to have inspected a file before reading it.'

/**
 * Wall-clock time of the session's most recent logged event.
 *
 * Replaces the `lastActivityTime` helper the session package exported before
 * rc.6: any append (including bookkeeping) moves it, and an empty log has none.
 * @param session - the session whose log to read.
 * @returns epoch milliseconds of the last event, or `undefined` for an empty log.
 */
function lastActivityTime(session: Session): number | undefined {
  return session.events.at(-1)?.time
}

/**
 * How long a transient confirmation (the Ctrl+O card cycle, the Ctrl+R
 * reasoning toggle) stays on the status row before the row goes back to what it
 * was showing.
 */
const STATUS_FLASH_MS = 1_500

/**
 * Read the live default model selection, when a default-model service is
 * mounted.
 *
 * Optional service: `agentDefaultModel` is not one of this bundle's injections,
 * so it is read through the non-throwing accessor and shape-checked rather than
 * typed. Called on every read of the selection, never cached: the service reads
 * its user layer from a settings file that loads asynchronously, so a value
 * captured while the TUI mounts is the bundle's inline default rather than the
 * user's `agent-default-model`.
 * @param ctx - the runner context.
 * @returns the current default selection, or `undefined` when unavailable.
 */
function defaultModelSelection(ctx: Context): ModelSelection | undefined {
  const service = ctx.get('agentDefaultModel') as {
    currentSelection?: () => { provider?: unknown; model?: unknown; reasoningEffort?: unknown } | undefined
  } | undefined
  const selection = service?.currentSelection?.()
  if (selection === undefined) return undefined
  const { provider, model, reasoningEffort } = selection
  if (typeof provider !== 'string' || typeof model !== 'string') return undefined
  return {
    provider,
    model,
    // The service's own effort id, re-branded: this crosses an untyped optional
    // service boundary, and the adapter validates the value it accepts.
    ...typeof reasoningEffort === 'string' ? { reasoningEffort: reasoningEffort as ReasoningEffortId } : {},
  }
}

/**
 * The route `--model` fixed for this process, when the flag was given.
 *
 * Read from the startup service rather than from {@link Config}: `Config` is
 * the deployment's serializable presentation settings, while this is one
 * process's command line, which is also why it is absent in an embedder.
 * @param ctx - the runner context.
 * @returns the explicit route, or `undefined` when none was given.
 */
function startupSelection(ctx: Context): ModelSelection | undefined {
  const route = parseModelSelection(ctx.get('tuiStartup')?.model)
  return route === undefined ? undefined : { provider: route.provider, model: route.model }
}

interface RunningStatus {
  turn: number | undefined
  timer: ReturnType<typeof setInterval>
  /** Render clock when the turn began; origin of the glyph fade-in. */
  startedAt: number
  /** The most recently rendered phase glyph, handed to the fade-out. */
  lastGlyph: string
}

/** A running glyph fading out after its turn ended, before the caret returns. */
interface FadingStatus {
  glyph: string
  /** Render clock when the turn ended; origin of the glyph fade-out. */
  endedAt: number
  timer: ReturnType<typeof setInterval>
}

/** Width/height adapter for a modal component rendered inside the base TUI flow. */
class InlineModalComponent extends Container {
  constructor(
    component: Component,
    private readonly width: number,
    private readonly maxHeight: number,
  ) {
    super()
    this.addChild(component)
  }

  override render(width: number): string[] {
    const lines = super.render(Math.max(1, Math.min(width, this.width)))
    return lines.slice(0, Math.max(1, this.maxHeight))
  }
}

/** Lifecycle handle for a mounted interactive terminal channel. */
export interface TuiController {
  /**
   * Deliver one line through the exact path a typed submission takes: slash
   * commands, `/skill:` invocations, and session references all route the same
   * way. Used for the launcher-seeded initial prompt.
   * @param text - the line as the user would have typed it.
   */
  submit(text: string): void
  /** Stop rendering, restore the terminal, and reject pending questions. */
  dispose(): Promise<void>
}

/**
 * Start the interactive pi-tui channel for an already-created target agent.
 * @param ctx - agent, tools, session-event, and user-question context.
 * @param config - target agent, banner, and TUI presentation config.
 * @param runtime - terminal and process-exit boundary.
 * @returns lifecycle controller used by the Cordis effect disposer.
 */
export function createTuiChat(
  ctx: Context,
  config: Config,
  runtime: TuiRuntime,
): TuiController {
  const sessionId = SessionId(config.sessionId ?? 'main')
  const agent = ctx.agents.get(sessionId)
  if (agent === undefined) throw new Error(`dsh-tui: session "${sessionId}" is not running`)
  const resolved = resolveTuiConfig(config)
  const palette = createPalette(resolved.theme.color)
  const mdTheme = markdownTheme(palette)
  const ui: TUI = new TuiMainScreen(runtime.terminal, resolved.showHardwareCursor)
  const chat = new Container()
  const todoContainer = new Container()
  const questionContainer = new Container()
  const inputTemplate = parseTuiPromptTemplate(displayInlineText(resolved.theme.inputPrompt))
  const renderInputPrompt = (): string => renderTuiPromptTemplate(inputTemplate, valueName => ctx.tuiPrompt.get(valueName))
  // pi-tui 0.84.1 dropped the editor's own prompt slot (`EditorOptions.prompt`
  // and `Editor.setPrompt`), so the input prompt renders as its own row
  // directly above the editor and is refreshed by `requestRender`.
  const inputPromptLine = new Text(renderInputPrompt(), 0, 0)
  const editor = new HintEditor(ui, {
    borderColor: palette.dim,
    selectList: selectTheme(palette),
  } satisfies EditorTheme, {
    paddingX: 1,
  })
  const todo = new TodoComponent(palette)
  /**
   * The row above the prompt: a live compaction's stopwatch while one runs,
   * otherwise whatever transient confirmation is flashing, otherwise nothing.
   * View-state confirmations belong here rather than in the transcript — they
   * report the state of the screen, not something the conversation did.
   */
  const statusLine = new Text('', 0, 0)
  let flashingStatus: { text: string; timer: ReturnType<typeof setTimeout> } | undefined
  let showReasoning = resolved.showReasoning
  // Ctrl+O cycles collapsed -> expanded -> hidden. Codex-style: hidden drops
  // tool cards entirely, collapsed previews, expanded shows full bodies.
  let toolsVisibility: ToolCardVisibility = 'collapsed'
  // One shared accumulator serves every step's timing footer; per-footer
  // replay of the whole log is quadratic on a long resumed session.
  const stepTimingTracker = new StepTimingTracker()
  let runningStatus: RunningStatus | undefined
  let fadingStatus: FadingStatus | undefined
  /**
   * Live standalone compaction observed by this process. Never derive this
   * state from history: a resumed log may contain a stale orphaned start.
   */
  let compacting: {
    startedAt: number
    timer: ReturnType<typeof setInterval>
  } | undefined
  // TUI steering submissions that the inbox has not yet claimed or discarded,
  // for the prompt's queued badge. The same claimed/discarded signals settle
  // the optimistic echo in the store (one node per MessageId), so this set
  // counts pending work and owns no transcript state of its own.
  const pendingSteering = new Set<MessageId>()
  let disposed = false
  let shuttingDown: Promise<void> | undefined
  // Optional: skills mount conditionally, so read the global service store
  // rather than declaring an injection that would make the TUI require them.
  const skills = ctx.get('skills')
  const cwd = agent.session.header.cwd ?? process.cwd()
  const fileSearch = new WorkspaceFileSearch(cwd, {
    maxResults: resolved.fileSearchMaxResults,
    maxEntries: resolved.fileSearchMaxEntries,
    excludedDirectories: resolved.fileSearchExcludedDirectories,
  })
  const skillAbort = new AbortController()
  const tokens = sessionTokens(agent.session)
  const commandControllers = new Set<AbortController>()
  const referenceControllers = new Set<AbortController>()
  let tuiServiceFiber: Fiber | undefined
  // The route the next step runs under, resolved on EVERY read rather than
  // frozen at mount, the way the Web host's `selectionFor` resolves it:
  //   1. a route this process picked — the `-m` flag, or a `/model` selection;
  //   2. this session's own latest logged request header, so a resumed session
  //      keeps the model it ran under;
  //   3. the live `agentDefaultModel` selection, whose user layer arrives with
  //      an asynchronous settings load that mounting does not wait for;
  //   4. the options the agent was created with (an embedder's fixed route).
  // Freezing tier 3 at mount was the bug: it captured the bundle's inline
  // default instead of the user's `agent-default-model` setting.
  let pickedTarget: ModelSelection | undefined = startupSelection(ctx)
  const target: ModelSelectionRef = {
    get current(): ModelSelection | undefined {
      if (pickedTarget !== undefined) return pickedTarget
      // `initialTarget` reads the logged header first and the agent's own
      // options second, which is exactly tiers 2 and 4; the live default sits
      // between them, so it is consulted only when no request was logged.
      if (agent.session.requestHeader()?.config !== undefined) return initialTarget(agent)
      return defaultModelSelection(ctx) ?? initialTarget(agent)
    },
    set current(next: ModelSelection | undefined) {
      pickedTarget = next
    },
    assembled: undefined,
  }
  // `updatePromptValues` (defined below) closes over the model controller, but
  // the controller needs `appendNotice`/`overlayManager`, defined after that
  // closure. Declare here, assign once after those exist, and defer the first
  // `updatePromptValues()` call until after the assignment so no read precedes it.
  // oxlint-disable-next-line prefer-const -- single assignment is a forward-reference, not a const.
  let modelController!: ModelController
  const now = (): number => runtime.now?.() ?? Date.now()
  const agentStatus = (): AgentStatus => agent.status
  const isDisposed = (): boolean => disposed

  // The read model: every session event — seeded log and live append alike —
  // folds into chat nodes and session aggregates here, and nowhere else. The
  // terminal owns no per-event view state, only the process-local presentation
  // below (running status, live compaction clock, pending steering).
  const store = new SessionStore(ctx, agent.session, agent)
  const transcript = new TranscriptReconciler(chat, {
    palette,
    mdTheme,
    maxToolOutputLines: resolved.maxToolOutputLines,
    maxDiffEditLength: resolved.maxDiffEditLength,
    events: () => agent.session.events,
    tracker: stepTimingTracker,
    now,
    toolDefinition: name => ctx.tools.get(name, agent),
  }, { showReasoning, visibility: toolsVisibility })

  let sessionTitle = store.getSnapshot().title
  const formattedCwd = displayText(runtime.formatCwd?.(agent.session.header.cwd) ?? formatCwd(agent.session.header.cwd))
  // A resumed session opens with a conversation this terminal did not hold, and
  // its id is what `--resume` takes back, so the banner names it. A fresh
  // session's id is a uuid nobody chose and nothing accepts yet; Claude Code
  // prints no id at all on a new session, and neither does this.
  const resumedSessionId = agent.session.events.some(event => event.type === 'user/message')
    ? shortSessionId(agent.session.id)
    : undefined
  const header = new HeaderComponent(
    {
      version: packageVersion(),
      // Read per render, like the prompt's model fragment: the route resolves
      // through the live default, which an asynchronous settings load fills in
      // after mount. Until one resolves the line is just the workspace — an
      // unresolved route is a startup state, not an error to report.
      model: () => {
        const current = target.current
        return current === undefined ? undefined : compactTargetLabel(current)
      },
      cwd: formattedCwd,
      resumed: resumedSessionId,
      title: () => sessionTitle,
      ...config.welcome === undefined ? {} : { welcome: config.welcome },
    },
    palette,
    resolved.theme.color && resolved.theme.truecolor,
  )
  const branch = runtime.gitBranch?.(cwd) ?? gitBranch(cwd)
  const promptValues: TuiPromptValueHandle[] = [
    ctx.tuiPrompt.register('cwd', palette.bold(palette.accent(formattedCwd))),
    ctx.tuiPrompt.register('git/worktree', branch === undefined ? undefined : palette.dim(` (${displayText(branch)})`)),
    ctx.tuiPrompt.register('token_meter/cache_hit_rate'),
    ctx.tuiPrompt.register('model'),
    ctx.tuiPrompt.register('context'),
    ctx.tuiPrompt.register('queued'),
    ctx.tuiPrompt.register('symbol', palette.bold(palette.accent('dsh'))),
    ctx.tuiPrompt.register('indicator', palette.dim('> ')),
  ]
  const [cwdValue, gitValue, tokenValue, modelValue, contextValue, queuedValue, symbolValue, indicatorValue] = promptValues
  /* v8 ignore next -- the fixed built-in registration list always supplies each handle. */
  if (cwdValue === undefined || gitValue === undefined || tokenValue === undefined || modelValue === undefined
    || contextValue === undefined || queuedValue === undefined || symbolValue === undefined || indicatorValue === undefined) {
    throw new Error('TUI prompt built-ins failed to initialize')
  }
  const updatePromptValues = (): void => {
    const renderTime = now()
    cwdValue.set(palette.bold(palette.accent(formattedCwd)))
    gitValue.set(branch === undefined ? undefined : palette.dim(` (${displayText(branch)})`))
    const rate = cacheHitRate(tokens)
    const usage = `↑${formatTokens(tokens.input)} ↓${formatTokens(tokens.output)}`
    modelValue.set(`  ${palette.dim(displayText(target.current === undefined ? 'model unset' : compactTargetLabel(target.current)))}`)
    tokenValue.set(`  ${palette.dim(rate === undefined ? usage : `${usage}  cache ${rate}%`)}`)
    const contextWindow = modelController.contextWindow()
    contextValue.set(contextWindow === undefined ? undefined : `  ${palette.dim(
      `${Math.min(100, Math.round(ctx.tokenMeter.measure(agent.session).totalTokens / contextWindow * 100))}% context`,
    )}`)
    const queued = runningStatus === undefined ? undefined : formatQueuedStatus(pendingSteering.size)
    queuedValue.set(queued === undefined ? undefined : palette.dim(queued))
    symbolValue.set(palette.bold(palette.accent('dsh')))
    // A live compaction owns the row while it runs; a flash only fills it in
    // between, so a transient confirmation can never hide ongoing work.
    statusLine.setText(compacting !== undefined
      ? palette.dim(`Context being compacted ${formatStatusDuration(renderTime - compacting.startedAt)}`)
      : flashingStatus === undefined ? '' : palette.dim(displayText(flashingStatus.text)))
    // `${indicator}` owns the caret column and its trailing gap before the
    // cursor. The active status glyph replaces the `>` caret in place — same
    // width every frame — fading in when work starts, throbbing while it runs,
    // and fading out after it ends before the plain `>` returns. Only the gray
    // brightness changes, so the caret never shifts.
    const statusGlyph = runningPhaseGlyph(
      agent.session.events,
      runningStatus !== undefined,
      compacting !== undefined,
    )
    // Remember the live phase glyph so the fade-out shows it, not the ttft
    // fallback the derivation returns once the closing turn's step has ended.
    if (runningStatus !== undefined && statusGlyph !== undefined) runningStatus.lastGlyph = statusGlyph
    // The fade envelope gates appear/disappear; the active throb breathes the
    // glyph throughout the operation. Truecolor opacity is envelope × throb; the
    // non-truecolor fallback keys visibility off the envelope alone, so the
    // throb never blinks it. `envelope` clamps to [0, 1].
    const activeSince = runningStatus?.startedAt ?? compacting?.startedAt
    const envelope = activeSince !== undefined && statusGlyph !== undefined
      ? { glyph: statusGlyph, level: Math.min(1, (renderTime - activeSince) / STATUS_FADE_MS) }
      : fadingStatus !== undefined
        ? { glyph: fadingStatus.glyph, level: Math.max(0, 1 - (renderTime - fadingStatus.endedAt) / STATUS_FADE_MS) }
        : undefined
    const caret = envelope === undefined
      ? palette.dim('>')
      : fadeGlyph(
        envelope.glyph,
        palette,
        resolved.theme.color,
        resolved.theme.color && resolved.theme.truecolor,
        envelope.level * pulseLevel(renderTime),
        envelope.level >= 0.5,
      )
    indicatorValue.set(`${caret}${palette.dim(' ')}`)
  }
  const promptContext = new PromptContextComponent(
    parseTuiPromptTemplate(displayInlineText(resolved.theme.leftPrompt)),
    parseTuiPromptTemplate(displayInlineText(resolved.theme.rightPrompt)),
    valueName => ctx.tuiPrompt.get(valueName),
  )
  ui.addChild(header)
  ui.addChild(chat)
  ui.addChild(new Spacer(1))
  todoContainer.addChild(todo)
  ui.addChild(todoContainer)
  ui.addChild(statusLine)
  ui.addChild(promptContext)
  ui.addChild(questionContainer)
  ui.addChild(inputPromptLine)
  ui.addChild(editor)
  ui.setFocus(editor)
  const updateTerminalTitle = (): void => {
    runtime.terminal.setTitle(displayText(
      sessionTitle === undefined ? resolved.title : `${sessionTitle} — ${resolved.title}`,
    ))
  }
  updateTerminalTitle()

  const requestRender = (): void => {
    if (disposed) return
    updatePromptValues()
    inputPromptLine.setText(renderInputPrompt())
    promptContext.invalidate()
    ui.requestRender()
  }
  // A prompt value that changes on its own schedule (e.g. a plugin-owned
  // `${custom}` fragment) redraws through the registry's coalesced notification;
  // built-ins are already covered by the state-change callers of requestRender.
  const disposePromptChanges = ctx.tuiPrompt.subscribe(requestRender)

  /**
   * Report a terminal-local outcome (a command result, a failed skill load) in
   * the transcript. Anything the session log records instead reaches the screen
   * as a folded notice node; this is only for what the log never sees.
   */
  const appendNotice = (message: string, kind: 'info' | 'warning' | 'error' = 'info'): void => {
    const color = kind === 'error' ? palette.error : kind === 'warning' ? palette.warning : palette.dim
    transcript.appendLocal(new Spacer(1), new Text(color(displayText(message)), 0, 0))
    requestRender()
  }

  /** Stop the flash timer and clear the transient text it was showing. */
  const clearFlash = (): void => {
    if (flashingStatus === undefined) return
    clearTimeout(flashingStatus.timer)
    flashingStatus = undefined
  }

  /**
   * Confirm a view-state change on the status row for {@link STATUS_FLASH_MS},
   * then restore the row.
   *
   * View state (which cards are visible, whether reasoning renders) is a
   * property of the screen, not of the conversation: repeating its
   * confirmations into the transcript pushed the conversation up the screen
   * every time the user cycled Ctrl+O, which is exactly when they are reading
   * it. A later flash replaces an earlier one rather than queueing.
   * @param message - the confirmation to show.
   */
  const flashStatus = (message: string): void => {
    clearFlash()
    flashingStatus = {
      text: message,
      timer: setTimeout(() => {
        flashingStatus = undefined
        requestRender()
      }, STATUS_FLASH_MS),
    }
    requestRender()
  }

  const extensionTheme: TuiTheme = Object.freeze({
    text: (value: string) => palette.text(value),
    brand: (value: string) => resolved.theme.color
      ? resolved.theme.truecolor ? brandText(value) : palette.brand(value)
      : value,
    dim: (value: string) => palette.dim(value),
    accent: (value: string) => palette.accent(value),
    success: (value: string) => palette.success(value),
    warning: (value: string) => palette.warning(value),
    error: (value: string) => palette.error(value),
    bold: (value: string) => palette.bold(value),
  })
  const overlayManager = new TuiOverlayManager({
    viewport: () => Object.freeze({
      columns: runtime.terminal.columns,
      rows: runtime.terminal.rows,
    }),
    theme: () => extensionTheme,
    display: displayText,
    show: (component, options, placement) => {
      if (placement === 'overlay') {
        return ui.showOverlay(component, options === undefined
          ? undefined
          : {
            ...options,
            ...typeof options.margin === 'object'
              ? { margin: { ...options.margin } }
              : {},
          })
      }
      const modal = new InlineModalComponent(
        component,
        resolved.questionDialogWidth,
        resolved.questionDialogMaxHeight,
      )
      questionContainer.clear()
      questionContainer.addChild(modal)
      ui.setFocus(component)
      return {
        hide(): void {
          questionContainer.clear()
          ui.setFocus(editor)
        },
      }
    },
    invalidate: requestRender,
    reportError: (error) => {
      const message = errorChain(error)
      ctx.logger.warn(`dsh-tui: overlay failed: ${message}`)
      /* v8 ignore next -- shutdown removes overlays before the terminal stops */
      if (disposed) return
      appendNotice(`TUI overlay failed: ${message}`, 'error')
    },
  })

  const disposeTargetListeners = installModelSelection(agent.ctx, target)

  modelController = createModelController({
    ctx,
    resolved,
    palette,
    overlayManager,
    target,
    appendNotice,
    requestRender,
    isDisposed,
  })
  updatePromptValues()

  const renderStatus = (): void => {
    // Only the open step's live timing footer moves between animation frames;
    // every settled row keeps its cached lines.
    transcript.invalidateOpenStep()
    requestRender()
  }

  /** Stop the turn-phase running and fade-out timers and drop both states. */
  const clearTurnStatus = (): void => {
    if (runningStatus !== undefined) {
      clearInterval(runningStatus.timer)
      runningStatus = undefined
    }
    if (fadingStatus !== undefined) {
      clearInterval(fadingStatus.timer)
      fadingStatus = undefined
    }
    runtime.terminal.setProgress(compacting !== undefined)
  }

  /** Hard clear: drop every indicator, including a live compaction bracket. */
  const clearStatus = (): void => {
    if (compacting !== undefined) {
      clearInterval(compacting.timer)
      compacting = undefined
    }
    clearFlash()
    clearTurnStatus()
  }

  /**
   * Hand the last active glyph to a fade-out that re-renders until it settles
   * on the `>` caret, then stops its own timer. A hard clear (teardown) skips
   * this via {@link clearStatus}.
   */
  const beginFadeOut = (glyph: string): void => {
    clearTurnStatus()
    const fading: FadingStatus = {
      glyph,
      endedAt: now(),
      timer: setInterval(() => {
        if (now() - fading.endedAt >= STATUS_FADE_MS) clearTurnStatus()
        renderStatus()
      }, STATUS_ANIMATION_INTERVAL_MS),
    }
    fadingStatus = fading
  }

  const setStatus = (status: AgentStatus): void => {
    const priorTurn = runningStatus?.turn
    const fadeOutGlyph = status !== 'running' ? runningStatus?.lastGlyph : undefined
    if (status === 'running') clearTurnStatus()
    else if (fadeOutGlyph !== undefined) beginFadeOut(fadeOutGlyph)
    else clearTurnStatus()
    editor.borderColor = status === 'running' ? text => palette.accent(text) : text => palette.dim(text)
    editor.hint = status === 'running' ? palette.dim(displayInlineText(resolved.theme.inputPlaceholder)) : undefined
    if (status === 'running') {
      const turn = priorTurn ?? openTurn(agent.session.events)
      const running: RunningStatus = {
        turn,
        startedAt: now(),
        // Seed with the current phase (ttft before the first step opens) so the
        // fade-out always has a glyph, even for a turn that ends before a render.
        lastGlyph: TIMING_BUCKET_GLYPHS[openStepPhase(agent.session.events) ?? 'ttft'],
        // Refresh every tick so the fading prompt phase glyph animates even
        // before the first token, when no step has folded a row yet.
        timer: setInterval(renderStatus, STATUS_ANIMATION_INTERVAL_MS),
      }
      runningStatus = running
      runtime.terminal.setProgress(true)
    }
    requestRender()
  }

  const refreshStatus = (): void => {
    renderStatus()
  }

  /**
   * Apply one published snapshot: the reconciler re-places the transcript, the
   * plan strip and header read the session aggregates. This is the whole
   * event-to-screen path — nothing else writes chat rows.
   */
  const applySnapshot = (snapshot: SessionSnapshot): void => {
    transcript.reconcile(snapshot.nodes)
    todo.update(snapshot.todos ?? [])
    if (snapshot.title !== sessionTitle) {
      sessionTitle = snapshot.title
      header.invalidate()
      updateTerminalTitle()
    }
  }
  const disposeSnapshots = store.subscribe(() => {
    if (disposed) return
    applySnapshot(store.getSnapshot())
    requestRender()
  })

  const questions = createQuestionQueue({
    ctx,
    resolved,
    palette,
    overlayManager,
    requestRender,
    isDisposed,
    questionMaxHeight: () => {
      const width = runtime.terminal.columns
      const editorRows = editor.render(width).length
      return Math.max(1, Math.min(
        resolved.questionDialogMaxHeight,
        runtime.terminal.rows - editorRows,
      ))
    },
  })

  /**
   * Interactive answerer for this agent's permission questions. The dialog goes
   * through the same single-modal slot as the ask-user-question queue, so an
   * approval and a question can never occupy the prompt area at once and
   * concurrent asks are served FIFO.
   *
   * Every path that ends the dialog without an answer — the asker withdrawing
   * the request (`req.signal`), TUI teardown, a failed component — settles the
   * request as `'cancelled'`, so an unanswered prompt releases the tool call
   * instead of hanging the turn.
   */
  const disposeApprovals = ctx.on('approval/request', (req, next) => {
    // The chain is not agent-scoped here, and vetoing (returning without calling
    // `next()`) would answer for an agent this terminal does not drive: a
    // question for any other agent MUST fall through to its own answerer.
    if (req.agent.session.id !== agent.session.id) return next()
    // A shutting-down TUI can no longer show anything; the rest of the chain
    // (finally the fail-closed default) owns the answer.
    if (disposed) return next()
    return new Promise<ApprovalOutcome>((resolveOutcome) => {
      let settled = false
      let overlay: TuiOverlaySession | undefined
      const settle = (outcome: ApprovalOutcome): void => {
        if (settled) return
        settled = true
        void overlay?.close()
        resolveOutcome(outcome)
      }
      overlay = overlayManager.open({
        ...req.signal === undefined ? {} : { signal: req.signal },
        create: () => new ApprovalDialog(
          {
            toolName: req.toolName,
            ...req.callId === undefined ? {} : { callId: req.callId },
            ...req.reason === undefined ? {} : { reason: req.reason },
          },
          palette,
          (decision) => { settle(decision) },
        ),
        options: {
          width: resolved.questionDialogWidth,
          maxHeight: resolved.questionDialogMaxHeight,
        },
      }, 'inline')
      void overlay.closed.then(() => { settle('cancelled') })
    })
  })

  const resume = createResumeController({
    ctx,
    agent,
    runtime,
    resolved,
    palette,
    overlayManager,
    // Optional and independently mounted. Cordis transiently leaves this sibling
    // non-ACTIVE during command callbacks, so the non-strict read is intentional;
    // terminal fiber states still exclude failed, closing, and closed providers.
    sessionQuery: () => {
      const implementation = ctx.reflect._getImpl('sessionQuery', false)
      if (implementation === undefined || implementation.fiber.state >= FIBER_FAILED) return undefined
      return ctx.get('sessionQuery', false)
    },
    ui,
    editor,
    appendNotice,
    requestRender,
    isDisposed,
    agentStatus,
  })

  const shutdown = (exitProcess: boolean): Promise<void> => {
    shuttingDown ??= (async () => {
      disposed = true
      overlayManager.beginShutdown()
      modelController.resetContextResolution()
      clearStatus()
      for (const controller of commandControllers) controller.abort(new Error('TUI disposed'))
      commandControllers.clear()
      for (const controller of referenceControllers) controller.abort(new Error('TUI disposed'))
      referenceControllers.clear()
      await tuiServiceFiber?.dispose()
      tuiServiceFiber = undefined
      questions.rejectAll()
      await overlayManager.dispose()
      modelController.clearOverlay()
      questions.unregister()
      await runtime.terminal.drainInput(100, 20)
      ui.stop()
      if (exitProcess) {
        if (runtime.goodbyeMessage !== undefined) {
          runtime.terminal.write(`${palette.dim(displayText(runtime.goodbyeMessage))}\n`)
        }
        runtime.exit(0)
      }
    })()
    return shuttingDown
  }

  const requestExit = (): void => {
    if (agent.status === 'running') {
      agent.cancel({ kind: 'user' })
      appendNotice('Cancelling the active turn before exit…', 'warning')
      void agent.whenIdle().then(() => shutdown(true))
      return
    }
    void shutdown(true)
  }

  /** Swap the palette and all derived themes for the given terminal color scheme. */
  const applyColorScheme = (scheme: TerminalColorScheme): void => {
    if (scheme === currentScheme) return
    currentScheme = scheme
    Object.assign(palette, createPalette(resolved.theme.color, scheme))
    Object.assign(mdTheme, markdownTheme(palette))
    // Rows cache the escapes they were built with, so every component is
    // remounted from the same nodes under the new palette.
    transcript.reset()
    applySnapshot(store.getSnapshot())
    // `setStatus` below re-derives `editor.borderColor` from the new palette.
    setStatus(agent.status)
    requestRender()
  }
  let currentScheme: TerminalColorScheme = 'dark'

  // Apply any color scheme the terminal reports. Registering before the query
  // below means even a synchronous reply reaches `applyColorScheme`; in practice
  // the startup query's reply is the only report, since dsh-tui leaves
  // unsolicited color-scheme notifications disabled.
  const disposeSchemeListener = ui.onTerminalColorSchemeChange(applyColorScheme)

  // Ask the terminal for its color scheme via device-status report; the reply,
  // if any, arrives through the listener above. Most terminals do not respond,
  // so we keep the dark-optimised palette. Swallow a query-write failure for the
  // same reason.
  ui.queryTerminalColorScheme({ timeoutMs: 2000 }).catch(() => {})

  const setToolsVisibility = (next: ToolCardVisibility): void => {
    toolsVisibility = next
    // The reconciler owns card visibility, so one call re-places every card.
    transcript.setVisibility(toolsVisibility)
    flashStatus(toolsVisibility === 'hidden' ? 'Tool cards hidden.' : `Tool and context cards ${toolsVisibility}.`)
  }

  const toggleTools = (): void => {
    // The cycle order puts the two common reading modes adjacent: preview ->
    // full detail -> conversation-only, then back to the preview default.
    setToolsVisibility(toolsVisibility === 'collapsed' ? 'expanded'
      : toolsVisibility === 'expanded' ? 'hidden' : 'collapsed')
  }

  const setReasoning = (show: boolean): void => {
    showReasoning = show
    // Every mounted step toggles in place, so a running stream keeps streaming
    // and the rows above it keep their positions.
    transcript.setShowReasoning(showReasoning)
    flashStatus(`Reasoning blocks ${showReasoning ? 'shown' : 'hidden'}.`)
  }

  const toggleReasoning = (): void => { setReasoning(!showReasoning) }

  // The selector and the argument grammar mutate the same closure state the
  // Ctrl+O cycle and Ctrl+R toggle drive, so every entry converges.
  let detailsOverlay: TuiOverlaySession | undefined
  const showDetailsSelector = (): void => {
    void detailsOverlay?.close()
    const session = overlayManager.open({
      create: () => new DetailsDialog(
        toolsVisibility,
        showReasoning,
        palette,
        // Each Tab applies immediately; one dimension changes per call.
        (selection: DetailsSelection) => {
          if (selection.showReasoning !== showReasoning) setReasoning(selection.showReasoning)
          if (selection.visibility !== toolsVisibility) setToolsVisibility(selection.visibility)
        },
        () => { void session.close() },
      ),
      options: { width: resolved.detailsDialogWidth, anchor: 'center', margin: 1 },
    })
    detailsOverlay = session
    void session.closed.then(() => {
      if (detailsOverlay === session) detailsOverlay = undefined
    })
    requestRender()
  }

  // `/details` names the same transcript-detail state the Ctrl+O cycle and
  // Ctrl+R toggle mutate, so a user can jump to a mode without cycling.
  const runDetails = (rawInput: string): CommandResult => {
    const tokens = rawInput.split(/\s+/u).filter(token => token !== '')
    if (tokens.length === 0) {
      showDetailsSelector()
      return { kind: 'success' }
    }
    let visibility: ToolCardVisibility | undefined
    let reasoning: boolean | undefined
    for (let token = tokens.shift(); token !== undefined; token = tokens.shift()) {
      if (token === 'collapsed' || token === 'expanded' || token === 'hidden') {
        visibility = token
      } else if (token === 'reasoning') {
        const value = tokens[0]
        if (value === 'on' || value === 'off') {
          tokens.shift()
          reasoning = value === 'on'
        } else {
          reasoning = !showReasoning
        }
      } else {
        return { kind: 'error', text: `Unknown /details argument "${token}". Usage: /details [collapsed|expanded|hidden] [reasoning [on|off]]` }
      }
    }
    if (reasoning !== undefined) setReasoning(reasoning)
    if (visibility !== undefined) setToolsVisibility(visibility)
    return { kind: 'success' }
  }

  const showHelp = (): void => {
    const commandLines = ctx.commands.list(agent).map((command) => {
      const input = command.input === undefined ? '' : ` ${command.input.hint}`
      return `/${command.name}${input} — ${command.description}`
    })
    transcript.appendLocal(
      new Spacer(1),
      new Text(palette.bold(palette.accent('Keyboard shortcuts')), 0, 0),
      new Text([
        'Enter send • Shift/Alt+Enter newline • Up/Down prompt history',
        'Esc cancel turn • Ctrl+O cycle cards (collapse/expand/hide) • Ctrl+R toggle reasoning • Ctrl+L redraw',
        'Ctrl+C cancel while running; clear input or exit while idle • Ctrl+D exit',
        '',
        ...commandLines,
        '/skill:<name> [instructions] — load a skill into the conversation',
      ].map(line => palette.dim(line)).join('\n'), 0, 0),
    )
    requestRender()
  }

  const showPalette = (): void => {
    transcript.appendLocal(
      new Spacer(1),
      new Text(renderPalette(palette, currentScheme, resolved.theme.color).join('\n'), 0, 0),
    )
    requestRender()
  }

  const showStatus = async (signal: AbortSignal): Promise<void> => {
    const assembly = await ctx.systemPrompt.assemble(assembleContextFor(agent, signal))
    /* v8 ignore next -- disposal during the awaited assembly is covered by command-owner teardown tests. */
    if (disposed) return
    /* v8 ignore next -- SystemPrompt always emits at least its required base section. */
    const systemPrompt = displayText(renderPrompt(assembly)) || '(empty)'
    const registeredTools = assembly.tools.map(tool => displayText(tool.name)).join(', ') || '(none)'
    const events = agent.session.events
    const latestActivity = lastActivityTime(agent.session) ?? agent.session.header.createdAt
    const usedContext = Math.max(0, Math.round(ctx.tokenMeter.measure(agent.session).totalTokens))
    let context = `${formatDiagnosticNumber(usedContext)} used · capacity unknown`
    const contextWindow = modelController.contextWindow()
    if (contextWindow !== undefined) {
      const contextPercent = Math.round(usedContext / contextWindow * 100)
      context = `${diagnosticMeter(contextPercent, palette)} ${String(contextPercent)}% used (${formatDiagnosticNumber(usedContext)} / ${formatDiagnosticNumber(contextWindow)})`
    }
    const rate = cacheHitRate(tokens)
    const turns = events.filter(event => event.type === 'turn/start').length
    const steps = events.filter(event => event.type === 'step/start').length
    const toolCalls = events.filter(event => event.type === 'tool/call').length
    const model = target.current === undefined ? 'unset' : displayText(targetLabel(target.current))
    const effort = target.current === undefined
      ? 'unset'
      : target.current.reasoningEffort === undefined
        ? 'default'
        : displayText(target.current.reasoningEffort)
    const groups: readonly (readonly StatusCardRow[])[] = [
      [
        ['Session', displayText(agent.session.id)],
        ['Title', displayText(sessionTitle ?? 'untitled')],
        ['Directory', displayText(cwd)],
        ['Model', `${model} ${palette.dim(`(effort ${effort}; reasoning blocks ${showReasoning ? 'shown' : 'hidden'})`)}`],
      ],
      [
        ['Agent', [
          agent.status,
          formatDiagnosticCount(events.length, 'event'),
          formatDiagnosticCount(turns, 'turn'),
          formatDiagnosticCount(steps, 'step'),
          formatDiagnosticCount(toolCalls, 'tool call'),
        ].join(' · ')],
      ],
      [
        ['Tokens', `${formatDiagnosticNumber(tokens.input)} input + ${formatDiagnosticNumber(tokens.output)} output`],
        ['KV cache', rate === undefined
          ? `n/a (${formatDiagnosticNumber(tokens.cacheRead)} read + ${formatDiagnosticNumber(tokens.cacheWrite)} write)`
          : `${diagnosticMeter(rate, palette)} ${String(rate)}% hit (${formatDiagnosticNumber(tokens.cacheRead)} read + ${formatDiagnosticNumber(tokens.cacheWrite)} write)`],
        ['Context', context],
      ],
      [
        ['Created', formatDiagnosticTime(agent.session.header.createdAt)],
        ['Active', formatDiagnosticTime(latestActivity)],
      ],
    ]
    transcript.appendLocal(
      new Spacer(1),
      new StatusCardComponent(groups, palette),
      new Spacer(1),
      new Text(palette.bold(palette.accent('System prompt')), 0, 0),
      new Text(systemPrompt, 0, 0),
      new Spacer(1),
      new Text(palette.bold(palette.accent('Registered tools')), 0, 0),
      new Text(registeredTools, 0, 0),
    )
    requestRender()
  }

  // Skill listing is async while `createTuiChat` is synchronous, so the TUI
  // retains the last complete invocation-neutral catalog for synchronous
  // editor completion, filters it for user invocation, and refreshes it after
  // registry invalidation.
  let skillCommands: SlashCommand[] = []
  let skillCommandScan = 0
  const refreshCommandAutocomplete = (): void => {
    const base = new CombinedAutocompleteProvider(
      [
        ...ctx.commands.list(agent).map(command => ({
          name: command.name,
          description: command.description,
          ...(command.input === undefined ? {} : { argumentHint: command.input.hint }),
        })),
        ...skillCommands,
      ],
      agent.session.header.cwd ?? process.cwd(),
    )
    const sessionReferences = ctx.get('sessionReferenceResolver')
    editor.setAutocompleteProvider(new ReferenceAutocompleteProvider(
      base,
      fileSearch,
      sessionReferences,
      agent,
    ))
  }
  const refreshVisibleSlashAutocomplete = (): void => {
    const cursor = editor.getCursor()
    const textBeforeCursor = editor.getLines().slice(cursor.line, cursor.line + 1).join('').slice(0, cursor.col)
    if (cursor.line === 0 && textBeforeCursor.startsWith('/') && !textBeforeCursor.includes(' ')) {
      // pi-tui's provider setter closes an existing menu but does not query
      // the replacement for the current draft. Tab in a slash-name context
      // only requests suggestions, so it refreshes without editing the text.
      editor.handleInput('\t')
    }
  }
  const disposeCommandChanges = ctx.on('commands/change', refreshCommandAutocomplete)
  refreshCommandAutocomplete()

  const refreshSkillCommands = (service: SkillRegistry): void => {
    const scan = ++skillCommandScan
    service.snapshot({ cwd, signal: skillAbort.signal }).then(
      (snapshot) => {
        if (disposed || scan !== skillCommandScan || !snapshot.complete) return
        const invocable = snapshot.skills.filter(skill => skill.invocation.userInvocable)
        // The argument-hint slot shows in the menu but is never inserted on
        // selection, so it carries the skill's scope instead of an
        // instructions placeholder. `SkillSource` is open-ended; every
        // non-project source (user, custom, bundled, runtime, …) collapses
        // to `(user)`.
        skillCommands = invocable.map(skill => ({
          name: `skill:${skill.name}`,
          description: skill.description,
          argumentHint: skill.source.startsWith('project-') ? '(project)' : '(user)',
        }))
        refreshCommandAutocomplete()
        refreshVisibleSlashAutocomplete()
        requestRender()
      },
      () => {
        // Discovery failed or was aborted on dispose; keep the base slash
        // commands so autocomplete still works without skill entries.
      },
    )
  }
  const disposeSkillChanges = skills === undefined
    ? () => {}
    : ctx.on('skills/change', () => { refreshSkillCommands(skills) })
  if (skills !== undefined) refreshSkillCommands(skills)

  // The agent scope is minted by agent-loop and intentionally inherits only
  // that core plugin's dependencies. A child command producer declares its own
  // UI-service dependency while retaining the parent agent scope and lifetime.
  const commandFiber = agent.ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: 'help',
      description: 'Show keyboard shortcuts and commands',
      handler: () => { showHelp(); return { kind: 'success' } },
    })
    commandCtx.commands.register({
      name: 'model',
      description: 'Show or switch this session\'s model',
      input: { hint: '[[provider/]model]' },
      handler: ({ rawInput }) => {
        modelController.queueModelCommand(rawInput)
        return { kind: 'success' }
      },
    })
    commandCtx.commands.register({
      name: 'clear',
      description: 'Clear the transcript view (session history is unchanged)',
      handler: () => { transcript.clearTranscript(); requestRender(); return { kind: 'success' } },
    })
    commandCtx.commands.register({
      name: 'details',
      description: 'Select tool-card visibility and reasoning display',
      input: { hint: '[collapsed|expanded|hidden] [reasoning [on|off]]' },
      handler: ({ rawInput }) => runDetails(rawInput),
    })
    commandCtx.commands.register({
      name: 'palette',
      description: 'Show every color and attribute role this terminal renders',
      handler: () => { showPalette(); return { kind: 'success' } },
    })
    commandCtx.commands.register({
      name: 'reload',
      description: 'EXPERIMENTAL (dev): re-read loader config files and apply the diff (idle only)',
      handler: () => { runReload(); return { kind: 'success' } },
    })
    commandCtx.commands.register({
      name: 'resume',
      description: 'List this workspace\'s resumable sessions',
      handler: () => { resume.showResume(); return { kind: 'success' } },
    })
    commandCtx.commands.register({
      name: 'status',
      description: 'Show session diagnostics, system prompt, and registered tools',
      handler: async ({ signal }) => { await showStatus(signal); return { kind: 'success' } },
    })
    const exitHandler = (): CommandResult => {
      requestExit()
      return { kind: 'success' }
    }
    commandCtx.commands.register({
      name: 'exit',
      description: 'Exit after the active turn reaches idle',
      handler: exitHandler,
    })
    commandCtx.commands.register({
      name: 'quit',
      description: 'Exit after the active turn reaches idle',
      handler: exitHandler,
    })
  })
  const fileReferencePromptFiber = agent.ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.systemPrompt.section({
      name: 'ui:tui-file-reference',
      order: 99,
      // Tool visibility can change dynamically or by agent scope. Empty
      // sections are omitted by renderPrompt, so guidance never names a tool
      // that this agent cannot call.
      text: () => agent.ctx.tools.get('read', agent) === undefined ? '' : FILE_REFERENCE_PROMPT,
    })
  })

  const runCommand = (text: string): void => {
    const controller = new AbortController()
    commandControllers.add(controller)
    void ctx.commands.execute(agent, text, controller.signal).then(
      (execution) => {
        if (disposed) return
        if (execution === undefined) {
          appendNotice(`Unknown command: ${text}`, 'warning')
        } else if (execution.result.text !== undefined && execution.result.text !== '') {
          appendNotice(execution.result.text, execution.result.kind === 'error' ? 'error' : 'info')
        }
      },
      (error: unknown) => {
        if (!disposed) {
          appendNotice(`Command failed: ${errorChain(error)}`, 'error')
        }
      },
    ).finally(() => { commandControllers.delete(controller) })
  }

  /**
   * Deliver a user turn: steer a running driver, otherwise queue a follow-up.
   *
   * rc.6 removed `Agent.acceptsNextStep` and the `agent/prompt-submit`
   * admission waterfall, so the running check is the public status and an
   * attached reference snapshot rides `agent.inject()` beside the prompt
   * instead of inside its admission transaction.
   * @param content - the model-facing blocks of the user's turn.
   * @param attachedContext - optional session-reference snapshot delivered with it.
   */
  const dispatchMessage = (content: ContentBlock[], attachedContext?: UserMessage): void => {
    if (disposed) {
      appendNotice(`Agent "${agent.id}" is disposed.`, 'error')
      return
    }
    // Queued before the prompt so the nearest pre-step claims both together.
    if (attachedContext !== undefined) agent.inject(attachedContext)
    const message = createUserMessage({ content, source: { kind: 'user' } })
    const steering = agent.status === 'running'
    // Echo the prompt before delivering it. A steered message is recorded only
    // when the running driver claims it at its next step boundary, so its
    // `user/message` event lands after the answer it interrupted has already
    // streamed rows onto the screen: without this the prompt would appear
    // below the reply it came before. The echo is keyed by MessageId, so the
    // event lands on this exact node instead of appending a second one.
    store.appendOptimistic(message, steering ? 'steering' : 'user')
    if (steering) {
      // Steering is never subject to prompt admission; a running driver
      // consumes it at its next step boundary.
      agent.steer(message)
      pendingSteering.add(message.id)
      refreshStatus()
      return
    }
    agent.followup(message)
  }

  /** Deliver a user turn to the agent: steer while running, send while idle, or report a disposed agent. */
  const deliver = (payload: string): void => {
    dispatchMessage([{ type: 'text', text: payload }])
  }

  /** Load a manually invoked skill and deliver its rendered body as a user turn, reporting lookup outcomes as notices. */
  const invokeSkill = (name: string, instructions: string): void => {
    if (skills === undefined) {
      appendNotice('Skills are not available in this session.', 'warning')
      return
    }
    const lookup = { cwd, signal: skillAbort.signal }
    const reportFailure = (error: unknown): void => {
      if (disposed) return
      appendNotice(`Skill "${name}" failed to load: ${errorChain(error)}`, 'error')
    }
    skills.list(lookup).then(
      (summaries) => {
        if (disposed) return
        const summary = summaries.find(skill => skill.name === name)
        if (summary === undefined) {
          appendNotice(`Unknown skill: ${name}`, 'warning')
          return
        }
        if (!summary.invocation.userInvocable) {
          appendNotice(`Skill "${name}" is not available for user invocation.`, 'warning')
          return
        }
        skills.get(name, lookup).then(
          (skill) => {
            if (disposed) return
            if (skill === undefined) {
              appendNotice(`Unknown skill: ${name}`, 'warning')
              return
            }
            if (!skill.invocation.userInvocable) {
              appendNotice(`Skill "${name}" is not available for user invocation.`, 'warning')
              return
            }
            deliver(renderSkillInvocation(skill, instructions))
          },
          reportFailure,
        )
      },
      reportFailure,
    )
  }

  // EXPERIMENTAL, dev-only: manually re-read every file-backed loader config
  // tree and apply the diff to the running app — the same path the HMR
  // watcher's config-change branch drives, minus the watcher. Useful when the
  // watcher misses an edit (replace-by-rename saves) or HMR is not mounted.
  // Module-source hot reload stays watcher-owned; this refreshes configs only.
  let reloadInFlight = false
  const runReload = (): void => {
    // Idle-only: a reload can dispose and re-mount entries mid-flight; doing
    // that under an active turn could tear tools or the adapter out from
    // under in-flight calls. Idleness is advisory (a send can race in after
    // the check), but it removes the common footgun.
    if (agent.status !== 'idle') {
      appendNotice(`/reload requires an idle agent (status: ${agent.status}).`, 'warning')
      return
    }
    // Re-entrancy guard: concurrent refreshes over a genuinely changed file
    // would race unmutexed tree updates (create/remove interleaving); one
    // reload at a time keeps the update pass single-writer.
    if (reloadInFlight) {
      appendNotice('A config reload is already running.', 'warning')
      return
    }

    // Optional-service lookup: the TUI must not depend on the Loader (tests
    // and embedders run without one), so `loader` stays out of `inject` and
    // is read through the non-throwing `ctx.get` accessor — a bare `ctx.loader`
    // proxy read would throw `cannot get property without inject` in a fiber.
    const loader = ctx.get('loader') as { entries(): Iterable<{ subtree?: { refresh?(): Promise<void> } }> } | undefined
    if (loader === undefined) {
      appendNotice('/reload needs the cordis Loader; this runtime has none.', 'warning')
      return
    }
    const refreshes: Promise<void>[] = []
    for (const entry of loader.entries()) {
      if (entry.subtree?.refresh !== undefined) refreshes.push(entry.subtree.refresh())
    }
    reloadInFlight = true
    appendNotice(`Reloading ${refreshes.length} config tree(s)… (experimental)`)
    // refresh() never rejects (it warns and keeps the running tree), so the
    // join can only fulfill; the catch arm guards a future contract change.
    void Promise.all(refreshes).then(() => {
      appendNotice('Config reload complete. Unchanged files were skipped; invalid files keep the running tree (see logs).')
    }).catch((error: unknown) => {
      appendNotice(`Config reload failed: ${errorChain(error)}`, 'error')
    }).finally(() => {
      reloadInFlight = false
    })
  }

  const submitLine = (value: string): void => {
    const text = value.trim()
    if (text === '') return
    const restoreSubmittedInput = (): void => {
      if (editor.getText() === '') editor.setText(value)
    }
    // `/skill:<name>` carries a colon, which the command registry's name
    // grammar rejects, so it is intercepted before generic command routing.
    if (text.startsWith(SKILL_COMMAND_PREFIX)) {
      editor.addToHistory(text)
      editor.setText('')
      const { name: skillName, instructions } = parseSkillCommand(text)
      if (skillName === '') appendNotice('Usage: /skill:<name> [instructions]', 'warning')
      else invokeSkill(skillName, instructions)
      return
    }
    if (value.startsWith('/')) {
      editor.addToHistory(text)
      editor.setText('')
      runCommand(value)
      return
    }
    let parsed: ReturnType<typeof parseSessionReferenceText>
    try {
      parsed = parseSessionReferenceText(text)
    } catch (error: unknown) {
      restoreSubmittedInput()
      appendNotice(`Invalid session reference: ${errorChain(error)}`, 'error')
      return
    }
    if (parsed.references.length === 0) {
      editor.addToHistory(text)
      editor.setText('')
      dispatchMessage([{ type: 'text', text: parsed.text }])
      return
    }
    const sessionReferences = ctx.get('sessionReferenceResolver')
    if (sessionReferences === undefined) {
      restoreSubmittedInput()
      appendNotice('Session reference capability unavailable.', 'error')
      return
    }
    const controller = new AbortController()
    referenceControllers.add(controller)
    editor.disableSubmit = true
    void sessionReferences.prepare(
      agent,
      [{ type: 'text', text: parsed.text }],
      parsed.references,
      controller.signal,
    ).then((prepared) => {
      if (disposed) return
      editor.addToHistory(text)
      if (editor.getText() === value) editor.setText('')
      // The snapshot travels with the prompt so the nearest pre-step claims
      // them together — see dispatchMessage's attached-context path.
      dispatchMessage(prepared.content, prepared.additionalContext)
    }, (error: unknown) => {
      if (!disposed && !controller.signal.aborted) {
        restoreSubmittedInput()
        appendNotice(`Session reference failed: ${errorChain(error)}`, 'error')
      }
    }).finally(() => {
      referenceControllers.delete(controller)
      editor.disableSubmit = false
      requestRender()
    })
  }
  editor.onSubmit = submitLine

  const removeInputListener = ui.addInputListener((data) => {
    if (overlayManager.hasActiveOverlay()) return undefined
    // `matchesKey` reports the key, not the transition: under the Kitty
    // keyboard protocol one physical Ctrl+O arrives as press, then release
    // (and a repeat per auto-repeat tick), and every one of them matches. Each
    // binding below acts once, on the press, and swallows the rest of its own
    // key's events so they never reach the editor. Terminals without the
    // protocol send press only, so this changes nothing for them.
    const press = !isKeyRelease(data) && !isKeyRepeat(data)
    if (matchesKey(data, Key.ctrl('o'))) {
      if (press) toggleTools()
      return { consume: true }
    }
    if (matchesKey(data, Key.ctrl('r'))) {
      if (press) toggleReasoning()
      return { consume: true }
    }
    if (matchesKey(data, Key.ctrl('l'))) {
      if (press) {
        ui.invalidate()
        ui.requestRender(true)
      }
      return { consume: true }
    }
    if (matchesKey(data, Key.escape) && agent.status === 'running') {
      if (press) agent.cancel({ kind: 'user' })
      return { consume: true }
    }
    if (matchesKey(data, Key.ctrl('c'))) {
      if (press) {
        if (agent.status === 'running') {
          agent.cancel({ kind: 'user' })
        } else if (editor.getText() !== '') {
          editor.setText('')
        } else {
          requestExit()
        }
      }
      return { consume: true }
    }
    if (matchesKey(data, Key.ctrl('d'))) {
      if (press) {
        if (agent.status === 'running') appendNotice('Cancel the active turn before exiting.', 'warning')
        else requestExit()
      }
      return { consume: true }
    }
    return undefined
  })

  // Transcript rows are the store's business. This listener owns only what the
  // durable log cannot express: caches to invalidate, the prompt's token
  // counters, and the clocks this process is running.
  const disposeSessionEvents = ctx.on('session/event', (session, event) => {
    if (session !== agent.session) return
    if (event.type === 'tool/result') fileSearch.invalidate()
    recordEventUsage(tokens, event)
    if (event.type === 'turn/start' && runningStatus !== undefined) runningStatus.turn = event.data.turn
    // Live standalone compaction is process state on purpose: a resumed log may
    // carry a stale orphaned start, so this clock never comes from history.
    if (event.type === 'compaction/start' && event.data.turn === null) {
      if (compacting === undefined) {
        compacting = {
          startedAt: now(),
          timer: setInterval(renderStatus, STATUS_ANIMATION_INTERVAL_MS),
        }
        runtime.terminal.setProgress(true)
      }
    } else if (event.type === 'compaction/end' && event.data.turn === null && compacting !== undefined) {
      const fadeOutGlyph = runningPhaseGlyph(agent.session.events, false, true)
      clearInterval(compacting.timer)
      compacting = undefined
      // A concurrently running turn owns the indicator. Keep its timer and
      // progress bit instead of letting the compaction fade clear that state.
      if (runningStatus === undefined && fadeOutGlyph !== undefined) beginFadeOut(fadeOutGlyph)
    }
    requestRender()
  })
  const settlePendingSteering = (id: MessageId): void => {
    if (pendingSteering.delete(id)) refreshStatus()
  }
  const disposeClaimed = ctx.on('agent/inbox/claimed', (payload) => {
    if (payload.agent === agent) settlePendingSteering(payload.message.id)
  })
  const disposeDiscarded = ctx.on('agent/inbox/discarded', (payload) => {
    if (payload.agent !== agent) return
    // Discarded means no `user/message` will ever land for it (cancelling a
    // turn clears the whole inbox), so the echo has to go with it: the model
    // never saw this prompt, and a transcript that keeps showing it is lying.
    store.withdrawOptimistic(payload.message.id)
    settlePendingSteering(payload.message.id)
  })
  const disposeStatus = ctx.on('agent/status', (payload) => {
    if (payload.agent !== agent) return
    // Leaving 'running' ends the turn's status line; clear any badge so the
    // next running turn starts from zero (and a cancellation, which discards
    // the queue without logging drains, cannot strand a stale count).
    if (payload.status !== 'running') pendingSteering.clear()
    setStatus(payload.status)
  })
  // The transcript's failure row is the folded `turn/end` notice, so the live
  // signal is not repeated on screen; its full cause chain goes to the log,
  // where wrapper messages like `fetch failed` keep the transport detail.
  const disposeError = ctx.on('agent/error', (payload) => {
    if (payload.agent !== agent) return
    ctx.logger.warn(`dsh-tui: turn ${payload.turn} step ${payload.step} failed: ${errorChain(payload.error)}`)
  })
  const disposeAgent = ctx.on('agent/disposed', (payload) => {
    if (payload.agent !== agent) return
    // The agent left the registry (e.g. an agent-loop-only reload) while the
    // TUI stays mounted. Retained agents accept deliveries after detachment, so
    // without this a later send would drive a zombie agent/session; mark
    // disposed so dispatchMessage reports it instead.
    // The hard clear also retires live compaction. A later compaction/end is
    // intentionally presentation-silent: this disposal notice owns the
    // terminal outcome, and no animation may survive agent detachment.
    clearStatus()
    appendNotice(`Agent "${agent.id}" was disposed.`, 'warning')
    disposed = true
  })

  const detachListeners = (): void => {
    skillAbort.abort()
    fileSearch.dispose()
    clearFlash()
    removeInputListener()
    disposeCommandChanges()
    disposeSkillChanges()
    disposePromptChanges()
    for (const value of promptValues) value.dispose()
    stopBannerReveal()
    disposeSnapshots()
    store.dispose()
    disposeSessionEvents()
    disposeClaimed()
    disposeDiscarded()
    disposeStatus()
    disposeError()
    disposeAgent()
    disposeSchemeListener()
    disposeTargetListeners()
    disposeApprovals()
    modelController.detach()
  }

  // Sweep reveal of the wordmark: it wipes in left-to-right over
  // ~BANNER_REVEAL_STEPS frames (started after `ui.start()` succeeds). Only that
  // row sweeps — the lines under it say where this session runs, and animating
  // them moved the whole screen at startup. A configured welcome line skips the
  // sweep so deployments (and snapshot fixtures) stay frame-deterministic.
  let revealTimer: ReturnType<typeof setInterval> | undefined
  const stopBannerReveal = (): void => {
    if (revealTimer === undefined) return
    clearInterval(revealTimer)
    revealTimer = undefined
    header.setRevealWidth(undefined)
  }
  const startBannerReveal = (): void => {
    if (config.welcome !== undefined) return
    const total = Math.max(1, runtime.terminal.columns)
    const step = Math.max(1, Math.ceil(total / BANNER_REVEAL_STEPS))
    let shown = 0
    header.setRevealWidth(0)
    revealTimer = setInterval(() => {
      shown += step
      if (shown >= total) {
        stopBannerReveal()
      } else {
        header.setRevealWidth(shown)
      }
      requestRender()
    }, BANNER_REVEAL_INTERVAL_MS)
  }

  // First paint: the seeded log is already folded, so the transcript is on
  // screen before `ui.start()`. Replayed prompts also seed the editor's history,
  // which live submissions add for themselves.
  const initial = store.getSnapshot()
  applySnapshot(initial)
  for (const node of initial.nodes) {
    if (node.kind === 'user-message' && node.source === 'user') editor.addToHistory(node.text)
  }
  const restoredGoal = foldGoal(agent.session.events).goal
  /* v8 ignore next -- goal replay coverage lives with the goal seam; the TUI only formats its startup notice. */
  if (restoredGoal !== undefined && restoredGoal.phase !== 'complete') {
    appendNotice(
      `Goal restored (${restoredGoal.phase}) with automatic continuation disarmed. `
      + 'Human confirmation is required; send “继续” or run /goal resume.',
      'warning',
    )
  }
  setStatus(agent.status)
  try {
    ui.start()
  } catch (error: unknown) {
    disposed = true
    detachListeners()
    void Promise.all([
      commandFiber.dispose(),
      fileReferencePromptFiber.dispose(),
    ]).catch(
      /* v8 ignore next 2 -- command registration cleanup is non-throwing; this guards a future disposer regression */
      (cleanupError: unknown) => {
        ctx.logger.warn(`dsh-tui: scoped cleanup after startup failure failed: ${errorChain(cleanupError)}`)
      },
    )
    clearStatus()
    questions.unregister()
    ui.stop()
    throw error
  }
  tuiServiceFiber = ctx.inject([], (serviceCtx) => {
    new TuiExtensionServiceImpl(serviceCtx, agent, overlayManager)
  })
  startBannerReveal()

  // A launcher-seeded first turn (`dsh migrate`/`dsh upgrade`):
  // invoke the named skill exactly as a typed `/skill:<name>` would, once the
  // chat is live and the agent is idle. The launcher sets this only for a fresh
  // session, so there is no prior turn to collide with; invokeSkill reports an
  // unknown skill as a notice.
  if (config.initialSkill !== undefined) invokeSkill(config.initialSkill, '')

  return {
    submit(text: string): void {
      submitLine(text)
    },
    async dispose(): Promise<void> {
      detachListeners()
      await shutdown(false)
      await Promise.all([
        commandFiber.dispose(),
        fileReferencePromptFiber.dispose(),
      ])
    },
  }
}

/**
 * Open the pi-tui channel once its configured agent exists. Kept for embedders
 * that let a declarative agent row own the lifecycle; the shipped `apply`
 * creates the agent itself and calls {@link createTuiChat} directly.
 *
 * @param ctx - Context supplying the agent registry, tools, and event stream.
 * @param config - Target agent and presentation configuration.
 * @param runtime - Terminal and process-exit boundary.
 */
export function mountTui(ctx: Context, config: Config, runtime: TuiRuntime): void {
  const sessionId = SessionId(config.sessionId ?? 'main')
  const matchesConfiguredIdentity = (agent: Agent): boolean =>
    agent.id === sessionId && ctx.agents.roots().includes(agent)
  let settled = false

  const stopWaiting = (): void => {
    disposeCreated()
    disposeFailure()
  }
  const start = (agent: Agent): void => {
    if (settled || !matchesConfiguredIdentity(agent)) return
    settled = true
    stopWaiting()
    ctx.effect(() => {
      const controller = createTuiChat(ctx, config, runtime)
      return () => controller.dispose()
    }, 'dsh-tui')
  }
  const fail = (failedSessionId: SessionId, error: unknown): void => {
    if (settled || failedSessionId !== sessionId) return
    settled = true
    stopWaiting()
    runtime.terminal.write(displayText(`dsh-tui: session "${sessionId}" failed to start: ${errorChain(error)}\n`))
    runtime.exit(1)
  }

  const disposeCreated = ctx.on('agent/created', payload => { start(payload.agent) })
  const disposeFailure = ctx.on('agent-loop/config-start-failed', (payload) => {
    fail(payload.sessionId, payload.error)
  })
  const existing = ctx.agents.roots().find(agent => agent.id === sessionId)
  if (existing !== undefined) start(existing)
}

const ROOT_DISPOSE_TIMEOUT_MS = 5_000

/**
 * Dispose the whole application before process exit, with a bounded fallback.
 * @param ctx - The TUI plugin context whose root owns sibling resources.
 * @param code - Process status to report.
 * @param exit - Exit boundary, replaceable by tests.
 */
export function disposeRootAndExit(
  ctx: Context,
  code: number,
  exit: (status: number) => void = (status) => { process.exit(status) },
): void {
  let exited = false
  const exitOnce = (): void => {
    if (exited) return
    exited = true
    exit(code)
  }
  const timeout = setTimeout(exitOnce, ROOT_DISPOSE_TIMEOUT_MS)
  void ctx.root.fiber.dispose().then(
    () => { clearTimeout(timeout); exitOnce() },
    () => { clearTimeout(timeout); exitOnce() },
  )
}

/** One `provider/model` route selected on the command line or by a default-model service. */
interface ModelRoute {
  provider: string
  model: string
}

/**
 * Split a `provider/model` selection string.
 * @param value - the raw `--model` argument, when one was given.
 * @returns the route, or `undefined` when absent or not `provider/model`.
 */
function parseModelSelection(value: string | undefined): ModelRoute | undefined {
  if (value === undefined) return undefined
  const slash = value.indexOf('/')
  if (slash <= 0 || slash === value.length - 1) return undefined
  return { provider: value.slice(0, slash), model: value.slice(slash + 1) }
}

/**
 * Resolve the per-agent model options for this run.
 *
 * Only an explicit `--model` fixes the agent's own options. A default-model
 * service is deliberately NOT read here: it loads its user layer from settings
 * asynchronously, so a route captured at startup is the bundle's inline default
 * rather than the user's. The chat's model selection reads that service live
 * instead (see `defaultModelSelection`) and applies it through the
 * `agent/request` waterfall, which is the surface that actually routes a step.
 * @param startup - the parsed command line.
 * @returns agent options, or `undefined` to leave the route to the selection.
 */
function resolveAgentOptions(startup: TuiStartupValues): AgentOptions | undefined {
  const route = parseModelSelection(startup.model)
  if (route === undefined) return undefined
  return { provider: route.provider, model: route.model }
}

/**
 * The most recent persisted session for this workspace, for `--continue`.
 * @param ctx - the runner context.
 * @returns the session id, or `undefined` without persistence or candidates.
 */
async function latestWorkspaceSession(ctx: Context): Promise<SessionId | undefined> {
  const persistence = ctx.get('sessionPersistence')
  if (persistence === undefined) return undefined
  const cwd = process.cwd()
  const headers = await persistence.list()
  const candidates = headers.filter((header: SessionHeader) => header.cwd === undefined || header.cwd === cwd)
  const latest = [...candidates].sort((a, b) => b.createdAt - a.createdAt)[0]
  return latest?.id
}

/**
 * Create or resume the single agent this terminal drives.
 * @param ctx - the runner context.
 * @param startup - the parsed command line.
 * @param agentOptions - resolved model route, when one was selected.
 * @returns the owned agent handle.
 * @throws when `--resume`/`--continue` names no loadable session.
 */
async function openStartupAgent(
  ctx: Context,
  startup: TuiStartupValues,
  agentOptions: AgentOptions | undefined,
): Promise<AgentHandle> {
  const options = agentOptions === undefined ? {} : { agentOptions }
  if (startup.resume !== undefined) {
    return ctx.agents.resume({ resumeSessionId: SessionId(startup.resume), ...options })
  }
  if (startup.continueLatest) {
    const latest = await latestWorkspaceSession(ctx)
    if (latest === undefined) {
      throw new Error('dsh-tui: --continue found no persisted session for this workspace')
    }
    return ctx.agents.resume({ resumeSessionId: latest, ...options })
  }
  // A launcher may still fix the identity through `ctx.provide('mainSessionId', …)`.
  const identity = ctx.get('mainSessionId')
  if (identity !== undefined) {
    return identity.resume
      ? ctx.agents.resume({ resumeSessionId: identity.id, ...options })
      : ctx.agents.create({ sessionId: identity.id, meta: { cwd: process.cwd() }, ...options })
  }
  return ctx.agents.create({
    sessionId: SessionId(`session-${randomUUID()}`),
    meta: { cwd: process.cwd() },
    ...options,
  })
}

/** The agent and chat this runner currently owns. */
interface MountedSession {
  handle: AgentHandle
  controller: TuiController
}

/**
 * Own the process terminal for one run: open the startup agent, mount the chat
 * over it, and keep an in-process resume host that swaps both without leaving
 * the process.
 * @param ctx - runner context with `tuiPrompt` available.
 * @param config - presentation configuration from the bundle row.
 */
async function runTui(ctx: Context, config: Config): Promise<void> {
  const startup = ctx.tuiStartup
  // TODO(dsh-tui): `--print` should answer one task headlessly and exit without
  // ever starting the renderer. Until that path exists the flag is ignored and
  // the interactive UI starts as usual.
  // Truecolor is a terminal capability, so detect it here at the process
  // boundary from COLORTERM; an explicit theme value still wins.
  const truecolor = config.theme?.truecolor ?? ['truecolor', '24bit'].includes(process.env['COLORTERM'] ?? '')
  // The launcher seeds a guided fresh session's first turn through this key; a
  // config value still wins. Consumed in createTuiChat via config.initialSkill.
  const initialSkill = config.initialSkill ?? ctx.get('tuiInitialSkill')
  const goodbyeMessage = ctx.get('tuiGoodbyeMessage')
  const terminal = new ProcessTerminal()
  const exit = (code: number): void => {
    // A launcher-provided bounded exit disposes the tree it owns; without one
    // the TUI disposes its own root and exits.
    const appExit = ctx.get('appExit')
    if (appExit === undefined) {
      disposeRootAndExit(ctx, code)
      return
    }
    appExit(code)
  }
  const agentOptions = resolveAgentOptions(startup)
  // A host that owns the process (a launcher able to re-exec) wins; otherwise
  // resume happens in this process through `handoff` below.
  const hostResume = ctx.get('tuiResumeHost')
  let mounted: MountedSession | undefined

  const runtime: TuiRuntime = {
    terminal,
    exit,
    formatCwd,
    gitBranch,
    ...goodbyeMessage === undefined ? {} : { goodbyeMessage },
    handoffResume: hostResume === undefined
      ? (sessionId, cwd) => handoff(sessionId, cwd)
      : (sessionId, cwd) => hostResume.handoff(sessionId, cwd),
  }

  const mount = (handle: AgentHandle): void => {
    const controller = createTuiChat(ctx, {
      ...config,
      theme: { ...config.theme, truecolor },
      ...initialSkill === undefined ? {} : { initialSkill },
      sessionId: handle.agent.session.id,
    }, runtime)
    mounted = { handle, controller }
  }

  const teardown = async (): Promise<void> => {
    const active = mounted
    mounted = undefined
    if (active === undefined) return
    await active.controller.dispose()
    await active.handle.dispose()
  }

  /**
   * In-process resume: tear the current chat and agent down, resume the
   * selected session, and mount a fresh chat over it. Rejects before
   * committing teardown when the target workspace cannot be entered; a failure
   * after that point is fatal and reported on the released terminal.
   */
  async function handoff(sessionId: SessionId, cwd: string): Promise<never> {
    if (resolvePath(cwd) !== resolvePath(process.cwd())) {
      try {
        process.chdir(cwd)
      } catch (error: unknown) {
        throw new Error(`dsh-tui: cannot enter workspace "${cwd}": ${errorChain(error)}`)
      }
    }
    await teardown()
    let resumed: AgentHandle
    try {
      resumed = await ctx.agents.resume({
        resumeSessionId: sessionId,
        ...agentOptions === undefined ? {} : { agentOptions },
      })
    } catch (error: unknown) {
      terminal.write(`dsh-tui: failed to resume session "${sessionId}": ${errorChain(error)}\n`)
      exit(1)
      throw error
    }
    mount(resumed)
    // Success never returns: the replacement chat owns the terminal from here,
    // exactly as a process-replacing host would.
    return await new Promise<never>(() => {})
  }

  // Registered before the first await so plugin teardown always reaches
  // whichever session is mounted when it runs.
  ctx.effect(() => () => teardown(), 'dsh-tui/session')

  mount(await openStartupAgent(ctx, startup, agentOptions))

  // The command-line prompt takes the same path a typed line would.
  if (startup.initialPrompt !== undefined) mounted?.controller.submit(startup.initialPrompt)
}

/**
 * Cordis entry point (`tui-runner`): owns the process terminal, the startup
 * agent, and the prompt-value registry this bundle's chat renders against.
 * @param ctx - plugin context carrying the injected core services.
 * @param config - presentation configuration from the bundle row.
 */
/* v8 ignore start -- production process wiring; fake-terminal tests cover createTuiChat */
export function apply(ctx: Context, config: Config): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('dsh-tui: both stdin and stdout must be TTYs; use a headless profile for pipes')
  }
  // Mounted here rather than as its own bundle row so the two-row patch stays
  // the deployment contract; the child below waits for it through `inject`,
  // which is why this plugin does not inject `tuiPrompt` itself.
  ctx.plugin(TuiPromptService)
  ctx.inject(['tuiPrompt'], uiCtx => runTui(uiCtx, config))
}
/* v8 ignore stop */

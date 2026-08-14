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
  type KeybindingsManager,
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
  type AgentSetup,
  type AgentStatus,
  type CreateAgentOptions,
  type ModelSelection,
  type ModelSelectionRef,
} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-loop'
// Type import declaration-merges the optional `agentPresets` service onto
// `Context`, so the boot path reads the roster by name rather than by cast. The
// package itself is a deployment choice this bundle never requires at runtime;
// see ./chat/preset-command.ts for why nothing imports its values.
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-token-meter'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { createUserMessage, errorChain } from '@deepseek-ai/dsh-llm'
import type { CallId, ContentBlock, MessageId, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
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
import { foldGoal, type FoldedGoal } from '@deepseek-ai/dsh-goal'
// Type-only: declaration-merges `sessionStats` onto the projection value table
// so the `/status` panel reads the unit by name rather than by cast. The
// plugin itself is a deployment choice the TUI never requires.
import type {} from '@deepseek-ai/dsh-session-stats'
import type {} from '@deepseek-ai/dsh-session-projection'
import { parseSessionReferenceText } from '@deepseek-ai/dsh-session-reference'
// Type import declaration-merges the `session/title` event onto the session
// event map, which the store folds into the snapshot's title.
import type {} from '@deepseek-ai/dsh-session-title'
// Type import also declaration-merges the optional `sessionPersistence`
// service onto `Context` so `ctx.get('sessionPersistence')` is typed.
import type {} from '@deepseek-ai/dsh-session-persistence'
// Type-only: the resume controller and `/resume` argument completion read the
// same optional store service through one typed handle.
import type { SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-session-projection-cache'
import type { SkillRegistry } from '@deepseek-ai/dsh-skill'
// Type import declaration-merges the `userQuestions` service onto `Context`;
// the ask-user-question queue is registered by ./chat/questions.
import type {} from '@deepseek-ai/dsh-user-questions'
// Declaration-merges the `approval/request` waterfall onto `Events`; the
// terminal answerer below is registered for this TUI's own agent only.
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import {
  dismissableOverlays,
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
import { contentText } from './components/content.ts'
import { brandText, createPalette, markdownTheme, renderPalette, selectTheme } from './components/theme.ts'
import { cardPhaseNotice, TranscriptReconciler } from './components/reconciler.ts'
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
  type HeaderInfo,
  type MarkdownPolicy,
  type ToolCardVisibility,
  HeaderComponent,
  planModeRow,
  TodoComponent,
} from './components/transcript.ts'
import { claudeMarkdownTheme } from './render/markdown.ts'
import { ScrollablePanel } from './components/panel.ts'
import { HistorySearchPanel, type HistorySearchOutcome } from './components/history-search.ts'
import { RewindPanel } from './components/rewind.ts'
import { forkSeedLength, hasRewindTarget, rewindTargets, type RewindTarget } from './chat/rewind.ts'
import {
  APP_KEYBINDINGS,
  installKeybindings,
  keyLabel,
  type AppKeybinding,
} from './keybindings.ts'
import {
  PluginsPanel,
  type PluginInventoryReader,
} from './components/plugins-panel.ts'
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
import { clipboardPath, copyToClipboard } from './chat/clipboard.ts'
import {
  BANNER_REVEAL_INTERVAL_MS,
  bannerRevealWidth,
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
import {
  createPresetController,
  sessionAgentPreset,
  type PresetController,
} from './chat/preset-command.ts'
import { createQuestionQueue } from './chat/questions.ts'
import {
  exportSessionLog,
  type SessionArtifactReader,
  type SessionFlusher,
} from './chat/export.ts'
import {
  formatGoalPrompt,
  formatSessionStats,
  goalStatusRows,
} from './chat/session-summary.ts'
import { createResumeController } from './chat/resume.ts'
import type { TuiForkRequest, TuiResumeHost, TuiRuntime } from './runtime.ts'
import { toolCallTouchesFiles, WorkspaceFileSearch } from './chat/file-autocomplete.ts'
import { resolveFileSearchCommand } from './chat/fd.ts'
import {
  detailsArgumentCompletions,
  memoizeListing,
  modelArgumentCompletions,
  presetArgumentCompletions,
  resumeArgumentCompletions,
  type CompletableSession,
} from './chat/command-completions.ts'
import {
  AGENT_START_TIMEOUT_MS,
  EXIT_IDLE_TIMEOUT_MS,
  whenIdleOrTimeout,
} from './chat/lifecycle.ts'
import type { TuiStartupValues } from './startup.ts'

export { TuiPromptService } from './prompt.ts'
export { renderSkillInvocation } from './chat/skill-invocation.ts'
export type { TuiForkRequest, TuiResumeHost, TuiRuntime } from './runtime.ts'
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
 * How long a transient confirmation (the Ctrl+O card cycle, the Ctrl+T plan
 * toggle) stays on the status row before the row goes back to what it was
 * showing.
 */
const STATUS_FLASH_MS = 1_500

/**
 * How long a first Esc stays armed for the second one that clears the draft or
 * opens Rewind. Claude Code's own double-press window, and short enough that
 * two unrelated cancels are never mistaken for one gesture.
 */
const ESCAPE_DOUBLE_PRESS_MS = 800

/**
 * How long a first Ctrl+C at an empty prompt stays armed for the second one
 * that exits. Long enough to be a deliberate second press, short enough that a
 * Ctrl+C typed minutes later is a fresh intent rather than a stale half of one.
 */
const EXIT_CONFIRM_MS = 2_000

/**
 * Longest a "working on it" hint holds the status row when the command that
 * armed it never settles. Not a deadline the command is held to — nothing is
 * cancelled here — only the point past which an unanswered hint is more
 * misleading than an empty row.
 */
const PENDING_HINT_MS = 30_000

/**
 * How long one listing serves slash-argument completion before it is read
 * again. Long enough that typing a model name costs one provider catalog read
 * rather than one per character, short enough that a session created in
 * another window is offered by the time the user reaches for it.
 */
const ARGUMENT_COMPLETION_CACHE_MS = 3_000

/**
 * Smallest panel a short terminal still gets: three rows of chrome (the
 * separating blank, the title, the hint) and two of content. A panel squeezed
 * below this shows nothing it was opened for, which is worse than one that
 * crowds the prompt.
 */
const MIN_PANEL_ROWS = 5

/**
 * The two ways out of a session whose agent is gone, named by every refusal
 * that mentions it.
 *
 * A disposed agent (an agent-loop reload, a host that retired it) leaves this
 * TUI mounted over a session that can still be read and can no longer run a
 * turn. Reporting only the refusal made that a dead end: every submission
 * failed and nothing on screen said what to do about it. `/resume` swaps this
 * chat for another session without leaving the process, and Ctrl+D ends it.
 */
const DISPOSED_RECOVERY = 'Run /resume to open another session, or press ctrl+d to exit.'

/**
 * Every key this terminal binds, as `/hotkeys`, `/help` and `?` list them.
 *
 * Built from the installed keybinding manager rather than written out, because
 * a deployment can rebind any of these: a help page that named the default key
 * after the user moved it would be worse than no help page. Only the keys this
 * registry does not own — the editor's own, the ones a panel or a dialog binds
 * while it has focus, and Ctrl+C, which is never rebindable — are spelled out.
 * @param manager - the installed keybinding manager.
 * @returns one line per group, in reading order.
 */
function keyboardShortcuts(manager: KeybindingsManager): string[] {
  const key = (action: AppKeybinding): string => keyLabel(manager, action)
  return [
    'Enter send • Shift/Alt+Enter newline • Up/Down prompt history • Tab accept a completion',
    '@ reference a file • / run a command • /skill:<name> load a skill • ? this list',
    `${key('app.history.search')} search prompt history backwards • ${key('app.todos.toggle')} expand or collapse the plan`,
    `${key('app.tools.cycle')} cycle tool cards (preview/full/hidden) • ${key('app.message.copy')} copy the last answer • ${key('app.screen.redraw')} redraw`,
    `${key('app.cancel')} cancel the turn; again on a draft clears it; again on an empty prompt opens Rewind`,
    `${key('app.exit')} exit on an empty prompt • Shift+Ctrl+D session debug panel`,
    'Ctrl+C cancel while running; clear input while typing; twice to exit while idle',
    'Ctrl+C again on a turn that will not cancel exits without waiting for it',
    'In a panel: ↑/↓ scroll • PgUp/PgDn page • g/G top or bottom • Esc close',
    'In a question: ↑/↓ move • Space multi-select • Tab custom answer • Enter confirm • Esc cancel',
    'In an approval: ↑/↓ move • 1-4 answer straight away • Enter confirm • Esc deny',
  ]
}

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
 * The permission preset every tool call in this session is decided under, when
 * a permission service is mounted.
 *
 * Optional service: `approval` is not one of this bundle's injections (a
 * deployment can run without any permission seam), so it is read through the
 * non-throwing accessor and shape-checked rather than typed. The session's own
 * logged override wins over the deployment default, which is the same order the
 * service resolves an ask under. Nothing readable prints no row at all: an
 * invented "unknown" would read like a policy.
 * @param ctx - the runner context.
 * @param session - the session whose override applies.
 * @returns the preset name, or `undefined` when no service reports one.
 */
function approvalPreset(ctx: Context, session: Session): string | undefined {
  const service = ctx.get('approval') as {
    overrideOf?: (session: Session) => unknown
    config?: { policy?: unknown }
  } | undefined
  if (service === undefined) return undefined
  const override = typeof service.overrideOf === 'function' ? service.overrideOf(session) : undefined
  const preset = typeof override === 'string' ? override : service.config?.policy
  return typeof preset === 'string' && preset !== '' ? preset : undefined
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
  // Published before the first component: pi-tui resolves every key through one
  // process-global registry, and `Editor.handleInput` reads it on its first
  // line, so an editor constructed ahead of this would answer to pi-tui's
  // defaults for the rest of its life.
  const keybindings = installKeybindings(resolved.keybindings)
  const palette = createPalette(resolved.theme.color)
  const mdTheme = markdownTheme(palette)
  const ui: TUI = new TuiMainScreen(runtime.terminal, resolved.showHardwareCursor)
  const chat = new Container()
  const todoContainer = new Container()
  const questionContainer = new Container()
  /**
   * Holds the plan-mode badge while the session is in plan mode, and nothing at
   * all otherwise — an empty container costs no row, which is what keeps the
   * prompt in the same place in the ordinary case.
   */
  const planContainer = new Container()
  const inputTemplate = parseTuiPromptTemplate(displayInlineText(resolved.theme.inputPrompt))
  const renderInputPrompt = (): string => renderTuiPromptTemplate(inputTemplate, valueName => ctx.tuiPrompt.get(valueName))
  // pi-tui 0.84.1 dropped the editor's own prompt slot (`EditorOptions.prompt`
  // and `Editor.setPrompt`), so `HintEditor` places the rendered prompt on the
  // input frame's first content row itself — Claude's inline `❯ `, not a row of
  // its own above the frame. `requestRender` re-renders the template there on
  // the same schedule the separate row used to be refreshed on.
  const editor = new HintEditor(ui, {
    borderColor: palette.dim,
    selectList: selectTheme(palette),
  } satisfies EditorTheme, {
    paddingX: 1,
  })
  editor.promptPrefix = renderInputPrompt()
  const todo = new TodoComponent(palette, () => runtime.terminal.rows)
  /**
   * The row above the prompt: a live compaction's stopwatch while one runs,
   * otherwise whatever transient confirmation is flashing, otherwise nothing.
   * View-state confirmations belong here rather than in the transcript — they
   * report the state of the screen, not something the conversation did.
   */
  const statusLine = new Text('', 0, 0)
  let flashingStatus: { text: string; timer: ReturnType<typeof setTimeout> } | undefined
  /** Timer of an armed first Ctrl+C; while it runs, a second one exits. */
  let exitArmed: ReturnType<typeof setTimeout> | undefined
  /** The status row's wording while that exit is armed, so disarming can take it down. */
  let armedAsk: string | undefined
  /** Timer of an armed first Esc; while it runs, a second one clears or rewinds. */
  let escapeArmed: ReturnType<typeof setTimeout> | undefined
  /** The status row's wording while that Esc is armed, so disarming can take it down. */
  let escapeAsk: string | undefined
  /**
   * Whether the running turn has already been asked to stop (Esc, or a Ctrl+C
   * this terminal sent). Read by the Ctrl+C ladder to tell "cancel this turn"
   * from "this turn is not stopping, get me out"; cleared whenever the agent
   * leaves `running`.
   */
  let cancelRequested = false
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
  // for the prompt's queued badge, keyed by MessageId and carrying the text a
  // cancel hands back to the editor. The same claimed/discarded signals settle
  // the optimistic echo in the store (one node per MessageId), so this map
  // counts pending work and owns no transcript state of its own.
  const pendingSteering = new Map<MessageId, string>()
  let disposed = false
  /**
   * Whether this terminal's agent left the registry while the terminal stayed.
   *
   * Separate from {@link disposed}, which means "this UI is going away" and
   * gates rendering: an agent can be retired under a live screen (an
   * agent-loop-only reload), and that screen still has to paint the refusal and
   * the `/resume` picker that gets the user out of it.
   */
  let agentGone = false
  let shuttingDown: Promise<void> | undefined
  // Optional: skills mount conditionally, so read the global service store
  // rather than declaring an injection that would make the TUI require them.
  // The host registry is layered per scope and serves every session; a
  // composition may realm-mount its own registry instead, which is invisible
  // to host contexts, so address it through the live agent — the same
  // resolution the Web host's skill domain performs. Guarded per the optional
  // -service stance: an embedder's roster stub need not carry `serviceFor`.
  const presetRoster = ctx.get('agentPresets')
  const skills = (typeof presetRoster?.serviceFor === 'function'
    ? presetRoster.serviceFor(agent, 'skills')
    : undefined) ?? ctx.get('skills')
  const cwd = agent.session.header.cwd ?? process.cwd()
  /**
   * `fd` if this host has it, which is what makes `@` respect `.gitignore`:
   * pi's own provider shells out to it, and `fd` reads the ignore files the
   * repository already wrote. Resolved once per mount — a binary that appears
   * on `PATH` mid-session is not worth a `PATH` walk per keystroke.
   */
  const fileSearchCommand = resolveFileSearchCommand(resolved.fileSearchCommand)
  /**
   * The fallback index, used only when this host has no `fd`. It is built
   * either way so the tool-result listener can drop it without knowing which
   * source is live, and an unused index costs nothing: the traversal starts at
   * the first `@` query, which only the fallback ever issues.
   */
  const fileSearch = new WorkspaceFileSearch(cwd, {
    maxResults: resolved.fileSearchMaxResults,
    maxEntries: resolved.fileSearchMaxEntries,
    excludedDirectories: resolved.fileSearchExcludedDirectories,
  })
  /**
   * Name and arguments of every tool call this session has logged but not yet
   * answered, keyed by call id.
   *
   * The `@` index is dropped when a tool could have moved a file, and only
   * `tool/call` carries what tool that was — its `tool/result` names nothing
   * but the call id. Kept as narrowly as the question needs: entries are
   * removed as their results land (see the session listener).
   */
  const inFlightToolCalls = new Map<CallId, { name: string; arguments: string }>()
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
  // The claude pipeline is the default and the pi component the safety net: a
  // render that throws demotes every body for the rest of the process and says
  // so once, so a document the port mishandles costs styling, not the answer.
  const markdown: MarkdownPolicy = {
    mode: resolved.markdownRenderer,
    theme: claudeMarkdownTheme,
    onError: (error: unknown) => {
      ctx.logger.warn(
        `dsh-tui: claude markdown renderer failed; falling back to pi for this process: ${errorChain(error)}`,
      )
      // The log is where the stack belongs, but the screen is where the change
      // is: every answer from here on is typeset by a different renderer, and
      // the only sign of it used to be that the transcript's styling quietly
      // changed shape mid-session. One row says what happened, once — the
      // policy invokes this at most once per process.
      //
      // Deferred to the microtask queue because the throw that demoted the
      // renderer happened *inside* a render pass: appending a row there would
      // mutate the container the frame is walking. By the time this runs the
      // stack has unwound and the append is an ordinary one.
      queueMicrotask(() => {
        if (disposed) return
        appendNotice('Markdown rendering degraded; using the fallback renderer for the rest of this session.', 'warning')
      })
    },
  }
  /**
   * The color scheme the terminal last reported, and the one every fill on
   * screen is chosen against. Declared here rather than beside
   * `applyColorScheme` because the reconciler reads it per mount.
   */
  let currentScheme: TerminalColorScheme = 'dark'
  const transcript = new TranscriptReconciler(chat, {
    palette,
    mdTheme,
    scheme: () => currentScheme,
    markdown,
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
  // The user-invocable skill names the banner lists, filled by the same skill
  // scan that feeds slash-command autocomplete (see refreshSkillCommands).
  // Discovery is asynchronous while the banner renders from mount, so the
  // header holds this exact array and reads whatever it contains at render
  // time; a scan replaces its contents in place rather than the binding.
  const headerSkills: string[] = []
  const headerInfo = {
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
    skills: headerSkills,
  } satisfies HeaderInfo
  const header = new HeaderComponent(
    headerInfo,
    palette,
    resolved.theme.color && resolved.theme.truecolor,
  )
  const branch = runtime.gitBranch?.(cwd) ?? gitBranch(cwd)
  /**
   * The session's current goal, refolded only when a `goal/change` lands.
   *
   * `updatePromptValues` runs on every animation frame, so it must not fold the
   * whole log; a goal changes at most once per mutation, which is where the
   * refold belongs.
   */
  let goalState: FoldedGoal = foldGoal(agent.session.events)
  /**
   * The session's measured context total, remeasured only when the log grew.
   *
   * `tokenMeter.measure` folds the whole session, and `updatePromptValues` runs
   * on every animation frame — 50 ms apart while a turn is live — so measuring
   * per frame is O(events) per frame on a log that a long session only makes
   * longer. A mounted chat's log is append-only, so its length is the version
   * of the thing being measured: same length, same measurement. The step-timing
   * tracker earns its frame budget the same way.
   */
  let measuredContext: { events: number; totalTokens: number } | undefined
  const contextTokens = (): number => {
    const events = agent.session.events.length
    if (measuredContext?.events !== events) {
      measuredContext = { events, totalTokens: ctx.tokenMeter.measure(agent.session).totalTokens }
    }
    return measuredContext.totalTokens
  }
  const promptValues: TuiPromptValueHandle[] = [
    ctx.tuiPrompt.register('cwd', palette.bold(palette.accent(formattedCwd))),
    ctx.tuiPrompt.register('git/worktree', branch === undefined ? undefined : palette.dim(` (${displayText(branch)})`)),
    ctx.tuiPrompt.register('token_meter/cache_hit_rate'),
    ctx.tuiPrompt.register('model'),
    ctx.tuiPrompt.register('context'),
    // Registered unconditionally, absent from the default templates: a goal is
    // opt-in on the prompt row (a deployment that runs goals adds `${goal}` to
    // `theme.leftPrompt`), while `/status` shows it whether the row does or not.
    ctx.tuiPrompt.register('goal'),
    ctx.tuiPrompt.register('queued'),
    ctx.tuiPrompt.register('symbol', palette.bold(palette.accent('dsh'))),
    ctx.tuiPrompt.register('indicator', palette.dim('> ')),
  ]
  const [
    cwdValue, gitValue, tokenValue, modelValue, contextValue, goalValue, queuedValue, symbolValue, indicatorValue,
  ] = promptValues
  /* v8 ignore next -- the fixed built-in registration list always supplies each handle. */
  if (cwdValue === undefined || gitValue === undefined || tokenValue === undefined || modelValue === undefined
    || contextValue === undefined || goalValue === undefined || queuedValue === undefined
    || symbolValue === undefined || indicatorValue === undefined) {
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
      `${Math.min(100, Math.round(contextTokens() / contextWindow * 100))}% context`,
    )}`)
    const goalFragment = formatGoalPrompt(goalState.goal)
    goalValue.set(goalFragment === undefined ? undefined : `  ${palette.dim(goalFragment)}`)
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
  ui.addChild(planContainer)
  ui.addChild(promptContext)
  ui.addChild(editor)
  // The inline surfaces (a question, an approval, `/model`, a panel) open BELOW
  // the input, not above it. Claude Code renders them in the slot the prompt
  // itself occupies — a local-JSX command hides the input entirely and takes
  // its place (`processSlashCommand.tsx:632` sets `shouldHidePromptInput`,
  // `REPL.tsx:4894` drops the input for it and for any focused dialog) — so the
  // echoed `❯ /model` stays in the transcript and the picker appears under the
  // line the user typed it on. Mounting them above the editor put every panel
  // between the conversation and the prompt, which read as if the panel were
  // part of the transcript and pushed the input down the screen. The editor
  // stays mounted rather than being hidden: it is what the terminal's cursor
  // and the `esc` handling live on, and a reachable prompt under an inline
  // dialog is a smaller deviation than a prompt that disappears.
  ui.addChild(questionContainer)
  ui.setFocus(editor)
  const updateTerminalTitle = (): void => {
    runtime.terminal.setTitle(displayText(
      sessionTitle === undefined ? resolved.title : `${sessionTitle} — ${resolved.title}`,
    ))
  }
  updateTerminalTitle()

  /**
   * The editor's rendered height, measured at most once per frame.
   *
   * Every surface that shares the screen with the input frame sizes itself
   * against it, and each asks more than once per render (a panel derives its
   * viewport, the clamp on its scroll offset, and its page size from the same
   * budget) while `Editor.render` caches nothing. The measurement is dropped by
   * `requestRender` and re-taken on either terminal dimension, so an edit or a
   * resize cannot serve a stale height. Both dimensions, not just the width: a
   * draft taller than the editor's own scroll budget is clipped to a share of
   * the terminal's rows, so a purely vertical resize moves the height too, and
   * pi-tui's resize path asks the screen to repaint without coming through
   * `requestRender`.
   */
  let editorRowsFrame: { columns: number; terminalRows: number; rows: number } | undefined
  const editorRowCount = (): number => {
    const columns = runtime.terminal.columns
    const terminalRows = runtime.terminal.rows
    if (editorRowsFrame?.columns === columns && editorRowsFrame.terminalRows === terminalRows) {
      return editorRowsFrame.rows
    }
    const rows = editor.render(columns).length
    editorRowsFrame = { columns, terminalRows, rows }
    return rows
  }

  const requestRender = (): void => {
    if (disposed) return
    updatePromptValues()
    editor.promptPrefix = renderInputPrompt()
    // The editor's own height is measured by the panel and question surfaces
    // several times per frame; drop the last frame's measurement so the first
    // reader of this one pays for it and the rest reuse it.
    editorRowsFrame = undefined
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
    // Built on demand, not once: the reconciler re-runs this when the palette
    // changes, so the row has to pick up the tone that is current then rather
    // than the escapes of the palette it was first written under.
    transcript.appendLocal(() => {
      const color = kind === 'error' ? palette.error : kind === 'warning' ? palette.warning : palette.dim
      return [new Spacer(1), new Text(color(displayText(message)), 0, 0)]
    })
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
   * @param duration - how long to hold the row; a message that announces a
   *   window the user can act inside must outlive that window rather than the
   *   default, or the row goes quiet while the key it named is still armed.
   */
  const flashStatus = (message: string, duration: number = STATUS_FLASH_MS): void => {
    clearFlash()
    flashingStatus = {
      text: message,
      timer: setTimeout(() => {
        flashingStatus = undefined
        requestRender()
      }, duration),
    }
    requestRender()
  }

  /**
   * Say that an asynchronous command is working, and hand back the way to stop
   * saying it.
   *
   * `/status` folds the whole system prompt and `/model` reads every registered
   * provider's catalog; either can take a visible beat, and until its panel
   * opened the screen carried no evidence the key press had landed at all. The
   * ordinary flash window is the wrong shape for this — a hint that expires
   * mid-assembly reads as "your command was dropped" — so the row is held for
   * the work's own duration, with {@link PENDING_HINT_MS} only as a backstop.
   *
   * The settle callback clears the row only while it is still showing this
   * message: a later flash (a Ctrl+O cycle, an armed exit) owns the row from
   * the moment it lands, and a slow command settling afterwards must not wipe
   * something the user just did.
   * @param message - what the command is doing, in the present tense.
   * @returns the callback that takes the hint back down.
   */
  const flashPending = (message: string): (() => void) => {
    flashStatus(message, PENDING_HINT_MS)
    return () => {
      if (flashingStatus?.text !== message) return
      clearFlash()
      requestRender()
    }
  }

  /**
   * The last answer this session produced, as plain text.
   *
   * Read from the store's own snapshot rather than the rendered rows: what the
   * user wants on their clipboard is the model's text, not the markdown the
   * terminal painted from it. Steps that produced only tool calls carry no
   * text, so the search walks back to the last one that did.
   * @returns the answer, or `undefined` before this session has one.
   */
  const lastAnswerText = (): string | undefined => {
    const { nodes } = store.getSnapshot()
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
      const node = nodes[index]
      if (node?.kind !== 'assistant' || node.text.trim() === '') continue
      return displayText(node.text)
    }
    return undefined
  }

  /**
   * Put the last answer on the system clipboard (`/copy`, Ctrl+X).
   *
   * The escape sequence the clipboard port returns is written straight to the
   * terminal, outside the frame: it is an instruction to the terminal
   * emulator, not a cell the renderer owns, and a synchronized update would
   * make it part of a frame that pi-tui may redraw. The confirmation names the
   * path the copy actually took, because on a remote host "copied" and "loaded
   * into the tmux buffer" are different things to the person reading it.
   */
  const copyLastAnswer = (): void => {
    const text = lastAnswerText()
    if (text === undefined) {
      flashStatus('Nothing to copy yet.')
      return
    }
    const path = clipboardPath()
    void copyToClipboard(text).then((sequence) => {
      if (disposed) return
      runtime.terminal.write(sequence)
      flashStatus(path === 'native'
        ? `Copied ${String(text.length)} chars to clipboard.`
        : path === 'tmux-buffer'
          ? 'Copied to tmux buffer (prefix+] to paste).'
          : 'Sent to clipboard via OSC 52.')
    }, (error: unknown) => {
      /* v8 ignore next 2 -- the clipboard port collapses every subprocess failure into an exit code. */
      if (!disposed) appendNotice(`Copy failed: ${errorChain(error)}`, 'error')
    })
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
      // A dialog that draws its own frame states the width that frame was
      // designed for; without this the inline slot stretched every box across
      // the terminal. Percentages are an overlay-only unit, so a request that
      // uses one falls back to the slot's own bounds.
      const modal = new InlineModalComponent(
        component,
        typeof options?.width === 'number' ? options.width : resolved.questionDialogWidth,
        typeof options?.maxHeight === 'number' ? options.maxHeight : resolved.questionDialogMaxHeight,
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
    // The model selector is a picker, not a decision the agent waits on, so it
    // yields the inline slot the same way the panels do. The controller takes
    // the manager rather than a per-request flag, so the mark is applied here.
    overlayManager: dismissableOverlays(overlayManager),
    target,
    appendNotice,
    flashPending,
    requestRender,
    isDisposed,
  })
  const presetController: PresetController = createPresetController({
    ctx,
    resolved,
    palette,
    // Same slot and same dismissal rule as the model picker: a permission
    // prompt or a question that arrives while it is open takes the slot back.
    overlayManager: dismissableOverlays(overlayManager),
    agent,
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
    // The armed exit outlives the row that announced it, so teardown drops the
    // timer too rather than holding the event loop open for its window.
    disarmExit()
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
    // A turn that ended closes its cancel ladder: the next Ctrl+C on the next
    // turn starts at "cancel" again rather than inheriting an escalation from
    // a turn that did, in the end, stop.
    if (status !== 'running') cancelRequested = false
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
   * Mount or drop the plan-mode badge for the folded mode.
   *
   * Rebuilt rather than toggled so the row is painted with whatever palette and
   * scheme are current — a color-scheme change goes through here on the same
   * snapshot every other row is remounted from.
   * @param active - Whether the session is in plan mode.
   */
  const applyPlanMode = (active: boolean): void => {
    planContainer.clear()
    if (active) planContainer.addChild(new Text(planModeRow(palette, currentScheme), 0, 0))
  }

  /**
   * Apply one published snapshot: the reconciler re-places the transcript, the
   * plan strip, the plan-mode badge and header read the session aggregates.
   * This is the whole event-to-screen path — nothing else writes chat rows.
   */
  const applySnapshot = (snapshot: SessionSnapshot): void => {
    transcript.reconcile(snapshot.nodes)
    todo.update(snapshot.todos ?? [])
    applyPlanMode(snapshot.planMode)
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
    questionMaxHeight: () => Math.max(1, Math.min(
      resolved.questionDialogMaxHeight,
      runtime.terminal.rows - editorRowCount(),
    )),
  })

  /**
   * Tools the user granted for the rest of this session, by tool name.
   *
   * Terminal-side by necessity: rc.6's approval vocabulary is one-shot only
   * (`allowed-once` with no `allow-always`, no rule table, no grant store —
   * `@deepseek-ai/dsh-user-approval` README, "Only one-shot grants exist"), and
   * its session policy is the single `ask`/`never` switch `/permission` moves.
   * So "don't ask again" is remembered here and spent as one `'allowed-once'`
   * per later ask, which is exactly what the seam would have received had the
   * user answered each prompt by hand.
   *
   * Process-lifetime and this-agent only: it is not logged, so resuming the
   * session or opening it in another client starts from asking again. That is
   * the honest scope for a grant no durable layer can revoke.
   */
  const sessionApprovals = new Set<string>()

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
    // A grant the user already gave answers without redrawing the prompt. The
    // tool card still reports the call, so the run stays visible; what is gone
    // is the question the user already answered.
    if (sessionApprovals.has(req.toolName)) return Promise.resolve<ApprovalOutcome>('allowed-once')
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
          (decision) => {
            settle(decision.outcome)
            if (decision.outcome === 'allowed-once') {
              if (!decision.remember) return
              sessionApprovals.add(req.toolName)
              // Said once, where the grant was made: a permission that stops
              // asking must announce its own scope, or the silence afterwards
              // reads as the tool never having needed approval at all.
              appendNotice(
                `Allowing ${displayText(req.toolName)} for the rest of this session in this terminal. `
                + 'Restarting or resuming asks again.',
              )
              return
            }
            // The refusal itself carries no user text — `approval/decided` has
            // room for an outcome and nothing else, and the model sees the
            // seam's fixed `the user rejected tool "<name>"`. The instruction
            // therefore rides the one channel that does reach the model: a user
            // turn, steered into the running driver's next step, so it lands
            // beside the denial rather than a turn later.
            if (decision.feedback === undefined) return
            dispatchMessage([{ type: 'text', text: decision.feedback }])
          },
        ),
        options: {
          width: resolved.questionDialogWidth,
          maxHeight: resolved.questionDialogMaxHeight,
        },
      }, 'inline')
      void overlay.closed.then(() => { settle('cancelled') })
    })
  })

  // Optional and independently mounted. Cordis transiently leaves this sibling
  // non-ACTIVE during command callbacks, so the non-strict read is intentional;
  // terminal fiber states still exclude failed, closing, and closed providers.
  // Shared with `/resume` argument completion, which lists the same store.
  const sessionQueryService = (): SessionQueryEngine | undefined => {
    const implementation = ctx.reflect._getImpl('sessionQuery', false)
    if (implementation === undefined || implementation.fiber.state >= FIBER_FAILED) return undefined
    return ctx.get('sessionQuery', false)
  }
  const resume = createResumeController({
    ctx,
    agent,
    runtime,
    resolved,
    palette,
    overlayManager,
    sessionQuery: sessionQueryService,
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
      presetController.clearOverlay()
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

  /**
   * Leave, after the running turn has been cancelled and given a bounded chance
   * to end itself.
   *
   * The wait exists so a session is never torn down mid-write; the bound exists
   * because the wait is only as good as the driver's cancellation. An unbounded
   * tool loop or a stalled stream never reports idle, and the unbounded version
   * of this left the terminal owned by a TUI that had already said it was
   * leaving — an exit the user could only complete by killing the process from
   * somewhere else. `shutdown` is idempotent, so whichever of the two settles
   * first ends the session and the other becomes a no-op.
   */
  const requestExit = (): void => {
    if (agent.status === 'running') {
      cancelActiveTurn()
      appendNotice('Cancelling the active turn before exit…', 'warning')
      void whenIdleOrTimeout(agent.whenIdle(), EXIT_IDLE_TIMEOUT_MS).then((outcome) => {
        if (outcome === 'timeout') {
          ctx.logger.warn(`dsh-tui: the cancelled turn did not reach idle within ${String(EXIT_IDLE_TIMEOUT_MS)}ms; exiting anyway`)
        }
        void shutdown(true)
      })
      return
    }
    void shutdown(true)
  }

  /**
   * Cancel the running turn and remember that a cancel is outstanding.
   *
   * The memory is what turns the Ctrl+C ladder into an escape hatch instead of
   * a loop: a driver that honors the cancel reaches idle and clears this (see
   * {@link setStatus}), so the next press starts the ordinary two-press exit,
   * while one that does not leaves it set — and the press after that can offer
   * to leave without it.
   */
  const cancelActiveTurn = (): void => {
    cancelRequested = true
    agent.cancel({ kind: 'user' })
  }

  /**
   * Drop the armed first Ctrl+C, so the next one asks again instead of exiting.
   *
   * The row goes with it. An ask that outlives its window is the same lie in
   * reverse as one that expires early: it names a key that no longer exits,
   * while the press it invites now does something else entirely (cancel the
   * turn that just started).
   */
  const disarmExit = (): void => {
    if (exitArmed === undefined) return
    clearTimeout(exitArmed)
    exitArmed = undefined
    if (flashingStatus?.text === armedAsk) {
      clearFlash()
      requestRender()
    }
    armedAsk = undefined
  }

  /**
   * Arm the second Ctrl+C for {@link EXIT_CONFIRM_MS} and say so.
   *
   * Ctrl+C at an empty prompt used to end the session on the first press, which
   * is one mistyped Ctrl+V away from throwing away a conversation that is still
   * on screen. Claude Code asks for the key twice, and so does this: the first
   * press only arms the second, and the window closes on its own.
   *
   * The row holds the ask for the whole window rather than the default flash:
   * a hint that vanished half a second early left the exit armed with nothing
   * on screen saying so, which is the same surprise exit this replaced.
   * @param ask - the wording the row holds, which differs between the idle exit
   *   and the running session's escape hatch because the two do different
   *   things to the turn that is still open.
   */
  const armExit = (ask: string): void => {
    disarmExit()
    exitArmed = setTimeout(() => { exitArmed = undefined }, EXIT_CONFIRM_MS)
    armedAsk = ask
    flashStatus(ask, EXIT_CONFIRM_MS)
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
    // The reconciler owns card visibility, so one call re-places every card,
    // and it also owns the sentence naming what the phase leaves on screen —
    // the collapsed phase renders no context card, so it must not say it does.
    transcript.setVisibility(toolsVisibility)
    flashStatus(cardPhaseNotice(toolsVisibility))
  }

  const toggleTools = (): void => {
    // The cycle order puts the two common reading modes adjacent: preview ->
    // full detail -> conversation-only, then back to the preview default.
    setToolsVisibility(toolsVisibility === 'collapsed' ? 'expanded'
      : toolsVisibility === 'expanded' ? 'hidden' : 'collapsed')
  }

  /**
   * Show the plan's items or its one-line summary (Ctrl+T).
   *
   * The panel used to be unconditional, so a session with a long plan spent the
   * rows above the prompt on it from the moment the agent wrote one until the
   * moment it cleared it, with no key that took it back down.
   */
  const toggleTodos = (): void => {
    if (!todo.hasTodos()) {
      flashStatus('No plan in this session yet.')
      return
    }
    todo.setExpanded(!todo.isExpanded())
    todo.invalidate()
    flashStatus(todo.isExpanded() ? 'Plan expanded.' : 'Plan collapsed.')
    requestRender()
  }

  const setReasoning = (show: boolean): void => {
    showReasoning = show
    // Every mounted step toggles in place, so a running stream keeps streaming
    // and the rows above it keep their positions.
    transcript.setShowReasoning(showReasoning)
    flashStatus(`Reasoning blocks ${showReasoning ? 'shown' : 'hidden'}.`)
  }

  // Reasoning display has no key of its own: Ctrl+O's expanded phase already
  // shows the thinking blocks, and Ctrl+R is worth more as history search than
  // as a second switch over the same rows. `/details` and the selector below
  // still set it, and a deployment can still turn it off in config.
  //
  // The selector and the argument grammar mutate the same closure state the
  // Ctrl+O cycle drives, so every entry converges.
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
      options: { width: resolved.detailsDialogWidth },
      // A view of this screen's own settings: a permission prompt or a question
      // that arrives while it is open takes the slot back.
      dismissable: true,
      // Under the conversation, in the editor slot, like every other
      // interactive surface — not floating over the transcript it previews.
    }, 'inline')
    detailsOverlay = session
    void session.closed.then(() => {
      if (detailsOverlay === session) detailsOverlay = undefined
    })
    requestRender()
  }

  // `/details` names the same transcript-detail state the Ctrl+O cycle mutates,
  // plus the reasoning switch that has no key of its own, so a user can jump to
  // a mode without cycling.
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

  /**
   * The row budget one panel may occupy, read per render so a resize applies.
   * Bounded by the inline slot's own clip, which is what actually decides how
   * much of a component the terminal shows.
   */
  const panelRows = (): number => Math.max(
    MIN_PANEL_ROWS,
    Math.min(resolved.questionDialogMaxHeight, runtime.terminal.rows - editorRowCount()),
  )
  // One panel at a time, in the same editor slot the question, approval, model,
  // and details surfaces use; opening another replaces it.
  let panelOverlay: TuiOverlaySession | undefined
  /**
   * Show one page of pre-rendered lines under the editor, in the inline slot.
   *
   * These commands answer a question about the session — its status, its
   * palette, its keys — rather than adding to the conversation, so their output
   * is a view that opens and closes. Dumping it into the transcript pushed the
   * conversation off screen and left the answer stranded in the log above every
   * later reply.
   * @param title - the panel heading.
   * @param lines - already-rendered content rows.
   */
  const showPanel = (title: string, lines: readonly string[]): void => {
    void panelOverlay?.close()
    const session = overlayManager.open({
      create: () => new ScrollablePanel(
        title,
        lines,
        panelRows,
        palette,
        () => { void session.close() },
      ),
      // A panel is an answer the user reads, and it is the surface most often
      // left open while the agent works: an arriving permission prompt or
      // question closes it rather than waiting behind it forever.
      dismissable: true,
    }, 'inline')
    panelOverlay = session
    void session.closed.then(() => {
      if (panelOverlay === session) panelOverlay = undefined
    })
    requestRender()
  }

  // Every panel is titled with the command that opened it: the body already
  // says what it is (the status card, the palette table), so the heading's job
  // is naming the answer you are reading, and how to ask for it again.
  const showHotkeys = (): void => {
    showPanel('/hotkeys', keyboardShortcuts(keybindings).map(line => palette.dim(line)))
  }

  /**
   * What this terminal knows about itself (Shift+Ctrl+D).
   *
   * pi-tui dispatches that key ahead of focus and overlays, so this is the one
   * surface reachable from any state — which is exactly what a debug dump is
   * for. It reports what a bug report needs and nothing the transcript already
   * shows: identity, lifecycle, log size, screen, and the resolved keys, since a
   * rebound key is the first thing to suspect when a key "does nothing".
   */
  const showDebug = (): void => {
    const conflicts = keybindings.getConflicts()
    showPanel('debug (shift+ctrl+d)', [
      `session ${displayText(agent.session.id)} · agent ${agent.status}${agentGone ? ' · detached' : ''}`,
      `events ${String(agent.session.events.length)} · context ${String(Math.round(contextTokens()))} tokens`,
      `terminal ${String(runtime.terminal.columns)}x${String(runtime.terminal.rows)} · editor ${String(editorRowCount())} rows`,
      `cards ${toolsVisibility} · reasoning ${showReasoning ? 'shown' : 'hidden'} · plan ${todo.isExpanded() ? 'expanded' : 'collapsed'}`,
      `overlay ${overlayManager.hasActiveOverlay() ? 'active' : 'none'} · pending steering ${String(pendingSteering.size)}`,
      '',
      ...Object.keys(APP_KEYBINDINGS).map(action => `${action} → ${keyLabel(keybindings, action as AppKeybinding)}`),
      ...conflicts.length === 0
        ? []
        : ['', ...conflicts.map(conflict => `conflict: ${conflict.key} claimed by ${conflict.keybindings.join(', ')}`)],
    ].map(line => palette.dim(line)))
  }
  // pi-tui hands this key over before focus is resolved, so it works with a
  // panel or a dialog open; nothing else in this UI claims it.
  ui.onDebug = showDebug

  const showHelp = (): void => {
    const commandLines = ctx.commands.list(agent).map((command) => {
      const input = command.input === undefined ? '' : ` ${command.input.hint}`
      return `/${command.name}${input} — ${command.description}`
    })
    showPanel('/help', [
      ...keyboardShortcuts(keybindings),
      '',
      ...commandLines,
      '/skill:<name> [instructions] — load a skill into the conversation',
    ].map(line => palette.dim(line)))
  }

  const showPalette = (): void => {
    showPanel('/palette', renderPalette(palette, currentScheme, resolved.theme.color))
  }

  /**
   * The Loader inventory, read fresh on every `/plugins`.
   *
   * `pluginInventory` is a host mount the TUI never requires, so this is a
   * `ctx.get` rather than an injection, and the panel explains its own absence.
   * Unlike the pre-rendered panels above, this one keeps the keyboard for its
   * own filter box and per-entry detail, so it mounts its own component in the
   * same dismissable inline slot.
   */
  const showPlugins = (): void => {
    const inventory = ctx.get('pluginInventory') as PluginInventoryReader | undefined
    void panelOverlay?.close()
    const session = overlayManager.open({
      create: () => new PluginsPanel(
        inventory?.list(),
        panelRows,
        palette,
        () => { void session.close() },
      ),
      dismissable: true,
    }, 'inline')
    panelOverlay = session
    void session.closed.then(() => {
      if (panelOverlay === session) panelOverlay = undefined
    })
    requestRender()
  }

  const showStatus = async (signal: AbortSignal): Promise<void> => {
    // Assembling the system prompt runs every registered section, some of which
    // read files or ask a service; on a cold cache that is long enough for the
    // screen to look like `/status` never landed.
    const settleHint = flashPending('Collecting session status…')
    const assembly = await ctx.systemPrompt.assemble(assembleContextFor(agent, signal)).finally(settleHint)
    /* v8 ignore next -- disposal during the awaited assembly is covered by command-owner teardown tests. */
    if (disposed) return
    /* v8 ignore next -- SystemPrompt always emits at least its required base section. */
    const systemPrompt = displayText(renderPrompt(assembly)) || '(empty)'
    const registeredTools = assembly.tools.map(tool => displayText(tool.name)).join(', ') || '(none)'
    const events = agent.session.events
    const latestActivity = lastActivityTime(agent.session) ?? agent.session.header.createdAt
    const usedContext = Math.max(0, Math.round(contextTokens()))
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
    // Whole-log figures the in-memory counts above cannot give: `sessionStats`
    // folds every turn, step, and wall time from the durable log, so paging and
    // compaction cannot move them. The unit is a deployment choice, so its row
    // is present only when the projection is.
    const stats = ctx.get('sessionProjections')?.snapshot(agent.session).values.sessionStats
    // What every tool call in this session is decided under. Present only when
    // a permission service reports it, so a deployment without one says nothing
    // rather than implying a policy it does not enforce.
    const preset = approvalPreset(ctx, agent.session)
    // Which composition this session's tools, prompt sections, and skills come
    // from. Present only when the deployment composes a roster, for the same
    // reason the Permission row is: naming a preset in a profile that mounts
    // none would describe a layer that is not there.
    const agentPreset = presetController.currentPreset()
    const groups: readonly (readonly StatusCardRow[])[] = [
      [
        ['Session', displayText(agent.session.id)],
        ['Title', displayText(sessionTitle ?? 'untitled')],
        ['Directory', displayText(cwd)],
        ['Model', `${model} ${palette.dim(`(effort ${effort}; reasoning blocks ${showReasoning ? 'shown' : 'hidden'})`)}`],
        ...agentPreset === undefined ? [] : [['Preset', displayText(agentPreset)] as StatusCardRow],
        ...preset === undefined ? [] : [['Permission', displayText(preset)] as StatusCardRow],
        ...goalStatusRows(goalState.goal, goalState.roundsStarted),
      ],
      [
        ['Agent', [
          agent.status,
          formatDiagnosticCount(events.length, 'event'),
          formatDiagnosticCount(turns, 'turn'),
          formatDiagnosticCount(steps, 'step'),
          formatDiagnosticCount(toolCalls, 'tool call'),
        ].join(' · ')],
        ...stats === undefined ? [] : [['Session totals', formatSessionStats(stats)] as StatusCardRow],
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
    // The card renders itself once, at the panel's own content width; the panel
    // scrolls those rows rather than re-deriving them per frame.
    const cardWidth = Math.max(8, runtime.terminal.columns - 2)
    showPanel('/status', [
      ...new StatusCardComponent(groups, palette).render(cardWidth),
      '',
      palette.bold(palette.accent('System prompt')),
      ...systemPrompt.split('\n'),
      '',
      palette.bold(palette.accent('Registered tools')),
      registeredTools,
    ])
  }

  // Skill listing is async while `createTuiChat` is synchronous, so the TUI
  // retains the last complete invocation-neutral catalog for synchronous
  // editor completion, filters it for user invocation, and refreshes it after
  // registry invalidation.
  let skillCommands: SlashCommand[] = []
  let skillCommandScan = 0
  /** Advertised routes, read once per typing burst rather than per keystroke. */
  const listModelRoutes = memoizeListing(
    (provider: string) => ctx.llm.listModels(provider),
    ARGUMENT_COMPLETION_CACHE_MS,
  )
  /**
   * Every persisted session reduced to metadata `/resume` completion can rank.
   *
   * Titles come from the projection cache's already-written checkpoint rows
   * only. A cold projection would fold a log tail, and a menu rendered between
   * two keystrokes has no business reading logs — an untitled row falls back
   * to its id, which is what the argument carries anyway.
   */
  const listResumeSessions = memoizeListing(async (): Promise<CompletableSession[]> => {
    const service = sessionQueryService()
    if (service === undefined) return []
    const cache = ctx.get('sessionProjectionCache')
    return (await service.listSessions()).map((record): CompletableSession => {
      const cached = cache?.cachedSnapshot(record.header)
      const title = cached !== undefined && 'title' in cached.values ? cached.values.title : undefined
      return {
        id: record.header.id,
        ...record.header.cwd === undefined ? {} : { cwd: record.header.cwd },
        createdAt: record.header.createdAt,
        live: record.live,
        ...typeof title === 'string' ? { title } : {},
      }
    })
  }, ARGUMENT_COMPLETION_CACHE_MS)
  /**
   * The argument completion source for one command, or `undefined` for a
   * command whose argument is free text (or that takes none).
   *
   * `argumentHint` describes the shape of an argument; these say which values
   * exist in THIS session, so `/model `, `/preset `, `/details `, and
   * `/resume ` offer the same rows their pickers would. Optional services are
   * read inside the closure, not captured: the roster and the session store
   * mount independently of the command registry, so a source resolved when the
   * provider was built could be stale by the time a user types.
   *
   * Skills need nothing here: they are commands named `skill:<name>`, so the
   * name-completion branch already lists them from `/skill:`.
   * @param name - the registered command name.
   * @returns the argument completion source, when this terminal has one.
   */
  const argumentCompletionsFor = (name: string): SlashCommand['getArgumentCompletions'] => {
    switch (name) {
      case 'model':
        return prefix => modelArgumentCompletions(
          { listProviders: () => ctx.llm.listProviders(), listModels: listModelRoutes },
          prefix,
          resolved.maxModelOptions,
        )
      case 'preset':
        return (prefix) => {
          const presets = ctx.get('agentPresets')
          return presets === undefined
            ? null
            : presetArgumentCompletions(presets, prefix, resolved.maxModelOptions)
        }
      case 'details':
        return detailsArgumentCompletions
      case 'resume':
        return prefix => resumeArgumentCompletions(
          {
            list: () => listResumeSessions('sessions'),
            currentSessionId: agent.session.id,
            cwd: agent.session.header.cwd,
          },
          prefix,
          resolved.maxResumeOptions,
        )
      default:
        return undefined
    }
  }
  const refreshCommandAutocomplete = (): void => {
    const base = new CombinedAutocompleteProvider(
      [
        ...ctx.commands.list(agent).map((command) => {
          const getArgumentCompletions = argumentCompletionsFor(command.name)
          return {
            name: command.name,
            description: command.description,
            ...(command.input === undefined ? {} : { argumentHint: command.input.hint }),
            ...(getArgumentCompletions === undefined ? {} : { getArgumentCompletions }),
          }
        }),
        ...skillCommands,
      ],
      agent.session.header.cwd ?? process.cwd(),
      // With `fd` the base provider answers `@` itself, respecting the ignore
      // files the repository already wrote; without it the walker below does,
      // and the two never run together (see ReferenceAutocompleteProvider).
      fileSearchCommand ?? null,
    )
    const sessionReferences = ctx.get('sessionReferenceResolver')
    editor.setAutocompleteProvider(new ReferenceAutocompleteProvider(
      base,
      fileSearchCommand === undefined ? fileSearch : undefined,
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
    // `scope` selects the agent's preset layers; without it the read sees the
    // global layer alone, which the host composition leaves empty now that
    // skill discovery is a preset row.
    service.snapshot({ cwd, scope: agent, signal: skillAbort.signal }).then(
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
        // Same scan, second reader: the banner names what this workspace can
        // invoke. The whole catalog is handed over — the header packs it into
        // its own row budget and counts the remainder itself, so a cut here
        // only made its `+N more` lie about how many skills were left out.
        headerSkills.length = 0
        headerSkills.push(...invocable.map(skill => skill.name))
        header.invalidate()
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
      name: 'hotkeys',
      description: 'Show the keyboard shortcuts alone',
      handler: () => { showHotkeys(); return { kind: 'success' } },
    })
    commandCtx.commands.register({
      name: 'model',
      // Named for what it writes: with a route it saves the default, and the
      // picker it opens without one offers the session-scoped pick as well.
      description: 'Switch the model and save it as your default',
      input: { hint: '[[provider/]model]' },
      handler: ({ rawInput }) => {
        modelController.queueModelCommand(rawInput)
        return { kind: 'success' }
      },
    })
    commandCtx.commands.register({
      name: 'preset',
      description: 'Show, switch, or copy this session\'s agent preset',
      input: { hint: '[<preset> | copy <preset> <new-id>]' },
      handler: ({ rawInput }) => {
        presetController.queuePresetCommand(rawInput)
        return { kind: 'success' }
      },
    })
    commandCtx.commands.register({
      name: 'copy',
      description: 'Copy the last answer to the system clipboard',
      handler: () => { copyLastAnswer(); return { kind: 'success' } },
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
      name: 'export',
      description: 'Write this session\'s log to a file and report the path',
      input: { hint: '[path]' },
      handler: ({ rawInput, signal }) => exportSessionLog({
        // Both services are optional: without persistence the export
        // re-serializes the in-memory log, which is the same conversation.
        persistence: ctx.get('sessionPersistence') as SessionArtifactReader | undefined,
        sessions: ctx.get('sessions') as SessionFlusher | undefined,
        cwd,
      }, agent.session, rawInput, signal),
    })
    commandCtx.commands.register({
      name: 'plugins',
      description: 'Search and inspect the Loader\'s plugin entries',
      handler: () => { showPlugins(); return { kind: 'success' } },
    })
    // Registered only where someone asked for it. A command that re-mounts
    // Loader entries under a live session belongs to whoever is editing those
    // files, and `/help` is read as a menu: an entry there labelled
    // EXPERIMENTAL is still an entry a user will try once.
    if (config.experimentalCommands === true) {
      commandCtx.commands.register({
        name: 'reload',
        description: 'EXPERIMENTAL (dev): re-read loader config files and apply the diff (idle only)',
        handler: () => { runReload(); return { kind: 'success' } },
      })
    }
    commandCtx.commands.register({
      name: 'rewind',
      description: 'Go back to an earlier prompt in this session (files are never restored)',
      handler: () => { showRewind(); return { kind: 'success' } },
    })
    commandCtx.commands.register({
      name: 'resume',
      description: 'List this workspace\'s resumable sessions',
      // An argument narrows the same picker instead of resuming behind the
      // user's back: switching sessions replaces this process, so the row is
      // always confirmed on screen first.
      input: { hint: '[session]' },
      handler: ({ rawInput }) => { resume.showResume(rawInput.trim()); return { kind: 'success' } },
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
    if (disposed || agentGone) {
      appendNotice(`Agent "${agent.id}" is disposed. ${DISPOSED_RECOVERY}`, 'error')
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
      pendingSteering.set(message.id, contentText(content).trim())
      refreshStatus()
      return
    }
    agent.followup(message)
  }

  /** Deliver a user turn to the agent: steer while running, send while idle, or report a disposed agent. */
  const deliver = (payload: string): void => {
    dispatchMessage([{ type: 'text', text: payload }])
  }

  /**
   * Load a manually invoked skill and deliver its rendered body as a user turn,
   * reporting lookup outcomes as notices.
   *
   * The returned promise settles when the invocation is over — delivered,
   * refused, or failed — which is what the launcher-seeded first turn waits on
   * before it lets typed prompts through (see `initialSkillPending`). A typed
   * `/skill:` needs nothing from it.
   * @param name - the skill to look up in the registry.
   * @param instructions - extra text the user typed after the skill name.
   * @returns a promise that settles once the invocation has run its course.
   */
  const invokeSkill = (name: string, instructions: string): Promise<void> => {
    if (skills === undefined) {
      appendNotice('Skills are not available in this session.', 'warning')
      return Promise.resolve()
    }
    const lookup = { cwd, scope: agent, signal: skillAbort.signal }
    const reportFailure = (error: unknown): void => {
      if (disposed) return
      appendNotice(`Skill "${name}" failed to load: ${errorChain(error)}`, 'error')
    }
    return skills.list(lookup).then(
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
        return skills.get(name, lookup).then(
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

  /**
   * Whether the launcher-seeded skill still owes this session its first turn.
   *
   * Only a `config.initialSkill` session ever has one, so an ordinary chat
   * never queues anything: the flag is false from the first submission on.
   */
  let initialSkillPending = config.initialSkill !== undefined
  /** Prompts submitted during that window, in the order they were typed. */
  const queuedSubmissions: string[] = []

  const submitLine = (value: string): void => {
    const text = value.trim()
    if (text === '') return
    const restoreSubmittedInput = (): void => {
      if (editor.getText() === '') editor.setText(value)
    }
    // Every routing decision below reads the trimmed line, because a leading
    // space is a typo, not an intent: " /help" used to miss the command branch
    // and be sent to the model as a chat message, which the user paid for and
    // could not undo.
    const command = text.startsWith('/')
    // A launcher-seeded skill owns the first turn of the session it seeded, and
    // its registry lookup is asynchronous: a prompt submitted inside that window
    // used to reach the model first, so the model answered a question whose
    // instructions had not arrived yet. Anything that becomes a turn waits for
    // that send and is replayed in order; terminal-local slash commands are not
    // turns and run immediately, so `/quit` still works while the skill loads.
    if (initialSkillPending && (!command || text.startsWith(SKILL_COMMAND_PREFIX))) {
      editor.addToHistory(text)
      editor.setText('')
      queuedSubmissions.push(value)
      flashStatus('Queued until the startup skill has been sent.')
      return
    }
    // `/skill:<name>` carries a colon, which the command registry's name
    // grammar rejects, so it is intercepted before generic command routing.
    if (text.startsWith(SKILL_COMMAND_PREFIX)) {
      editor.addToHistory(text)
      editor.setText('')
      const { name: skillName, instructions } = parseSkillCommand(text)
      if (skillName === '') appendNotice('Usage: /skill:<name> [instructions]', 'warning')
      else void invokeSkill(skillName, instructions)
      return
    }
    if (command) {
      editor.addToHistory(text)
      editor.setText('')
      runCommand(text)
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
  /**
   * `?` on an empty prompt opens the shortcut list, and is not typed.
   *
   * Claude Code's rule exactly (`PromptInput.tsx`): the help opens only when the
   * whole input is a single `?`, and the character itself never lands in the
   * draft — a `?` typed inside a sentence is a question mark, not a keystroke.
   */
  editor.onChange = (text: string): void => {
    if (text !== '?') return
    editor.setText('')
    showHotkeys()
    requestRender()
  }

  /**
   * Open the gate the launcher-seeded skill held, and replay what waited behind
   * it in submission order.
   *
   * A teardown mid-lookup drops the queue instead: those prompts were never
   * delivered, and re-submitting them against a disposed agent would answer the
   * user's typing with a row of refusals on a screen that is going away.
   */
  const releaseInitialSkill = (): void => {
    initialSkillPending = false
    const held = queuedSubmissions.splice(0, queuedSubmissions.length)
    if (disposed) return
    for (const line of held) submitLine(line)
  }

  /**
   * Put every queued steering prompt back in the editor, newest submission last.
   *
   * Cancelling a turn empties the agent's inbox, so a prompt the user typed and
   * sent while the turn ran is discarded with it. Claude Code hands those back
   * to the input frame rather than dropping them, and so does this: the text is
   * prepended to whatever is being typed now, which is the order the user wrote
   * them in. The map itself is settled by the inbox's own discard events, not
   * here — until those land the prompts really are still queued.
   */
  const popQueuedSteering = (): void => {
    if (pendingSteering.size === 0) return
    const queued = [...pendingSteering.values()].filter(text => text !== '')
    if (queued.length === 0) return
    const draft = editor.getText()
    editor.setText(draft === '' ? queued.join('\n') : `${queued.join('\n')}\n${draft}`)
    // `Editor.setText` mutates the buffer without asking for a redraw.
    requestRender()
  }

  /** Drop the armed first Esc, so the next one asks again instead of acting. */
  const disarmEscape = (): void => {
    if (escapeArmed === undefined) return
    clearTimeout(escapeArmed)
    escapeArmed = undefined
    if (flashingStatus?.text === escapeAsk) {
      clearFlash()
      requestRender()
    }
    escapeAsk = undefined
  }

  /**
   * Arm the second Esc for {@link ESCAPE_DOUBLE_PRESS_MS} and say what it will do.
   * @param ask - the wording the status row holds for the whole window.
   */
  const armEscape = (ask: string): void => {
    disarmEscape()
    escapeArmed = setTimeout(() => { escapeArmed = undefined }, ESCAPE_DOUBLE_PRESS_MS)
    escapeAsk = ask
    flashStatus(ask, ESCAPE_DOUBLE_PRESS_MS)
  }

  /** Overlay of a live Ctrl+R search, so a second press replaces rather than stacks. */
  let historyOverlay: TuiOverlaySession | undefined
  /**
   * Search the prompt history backwards (Ctrl+R).
   *
   * The draft is captured on the way in and restored by a cancel, which is the
   * half of Claude Code's behavior that matters most: a search entered by
   * accident must give back exactly what the user was typing.
   */
  const showHistorySearch = (): void => {
    const entries = editor.historyEntries()
    if (entries.length === 0) {
      flashStatus('No prompt history in this session yet.')
      return
    }
    void historyOverlay?.close()
    const draft = editor.getText()
    const session = overlayManager.open({
      create: () => new HistorySearchPanel(
        entries,
        palette,
        (text: string, outcome: HistorySearchOutcome) => {
          void session.close()
          editor.setText(text)
          requestRender()
          if (outcome === 'submit') submitLine(text)
        },
        () => {
          void session.close()
          editor.setText(draft)
          requestRender()
        },
      ),
      dismissable: true,
    }, 'inline')
    historyOverlay = session
    void session.closed.then(() => {
      if (historyOverlay === session) historyOverlay = undefined
    })
    requestRender()
  }

  /**
   * Go back to an earlier prompt in this session (`/rewind`, double Esc on an
   * empty prompt).
   *
   * What "back" means depends on the host. One that can fork the session
   * branches it at the last completed turn before the chosen prompt and mounts
   * the branch, leaving this session whole and resumable. One that cannot only
   * puts the prompt's text back in the editor. Neither touches a file: dsh keeps
   * no working-tree snapshots, and the panel says so instead of implying one.
   * @param target - the prompt the user picked.
   */
  const rewindTo = (target: RewindTarget): void => {
    const events = agent.session.events
    const fork = runtime.handoffFork
    const seedLength = fork === undefined ? undefined : forkSeedLength(events, target.seq)
    editor.setText(target.text)
    requestRender()
    if (fork === undefined || seedLength === undefined) {
      appendNotice(fork === undefined
        ? 'Rewind put that prompt back in the editor. This runtime cannot fork a session, so the conversation above it is unchanged.'
        : 'Rewind put that prompt back in the editor. No completed turn precedes it, so there was nothing to fork to.', 'warning')
      return
    }
    appendNotice('Forking this session to the point before that prompt; the original stays resumable.')
    void fork({
      seed: events.slice(0, seedLength),
      parentSession: agent.session.id,
      cwd,
      draft: target.text,
    }).catch((error: unknown) => {
      /* v8 ignore next -- a fork that fails after teardown has no screen left to report on. */
      if (!disposed) appendNotice(`Rewind failed: ${errorChain(error)}`, 'error')
    })
  }

  const showRewind = (): void => {
    if (agent.status === 'running') {
      appendNotice('Cancel the active turn before rewinding.', 'warning')
      return
    }
    void panelOverlay?.close()
    const targets = rewindTargets(agent.session.events)
    const session = overlayManager.open({
      create: () => new RewindPanel(
        targets,
        runtime.handoffFork !== undefined,
        panelRows,
        palette,
        (target: RewindTarget) => {
          void session.close()
          rewindTo(target)
        },
        () => { void session.close() },
      ),
      dismissable: true,
    }, 'inline')
    panelOverlay = session
    void session.closed.then(() => {
      if (panelOverlay === session) panelOverlay = undefined
    })
    requestRender()
  }

  /**
   * Esc, in Claude Code's own order.
   *
   * Running: cancel, and hand back whatever was queued behind the turn. Idle
   * with a draft: two presses clear it, and the cleared text goes into the
   * history first, so a draft abandoned by accident is one Ctrl+R away. Idle
   * with an empty prompt: two presses open Rewind — but only when there is a
   * prompt to go back to, since arming a key that opens an empty panel teaches
   * the wrong thing about it.
   */
  const handleEscape = (): void => {
    if (agent.status === 'running') {
      disarmEscape()
      popQueuedSteering()
      cancelActiveTurn()
      return
    }
    const draft = editor.getText()
    if (draft !== '') {
      if (escapeArmed === undefined) {
        armEscape('Press esc again to clear the draft.')
        return
      }
      disarmEscape()
      // Stored before it is dropped, exactly as Claude Code does: a draft the
      // user threw away is still something they typed, and Ctrl+R is how they
      // get it back.
      editor.addToHistory(draft)
      editor.setText('')
      requestRender()
      return
    }
    if (!hasRewindTarget(agent.session.events)) return
    if (escapeArmed === undefined) {
      armEscape('Press esc again to rewind to an earlier prompt.')
      return
    }
    disarmEscape()
    showRewind()
  }

  const removeInputListener = ui.addInputListener((data) => {
    if (overlayManager.hasActiveOverlay()) return undefined
    // `matchesKey` reports the key, not the transition: under the Kitty
    // keyboard protocol one physical Ctrl+O arrives as press, then release
    // (and a repeat per auto-repeat tick), and every one of them matches. Each
    // binding below acts once, on the press, and swallows the rest of its own
    // key's events so they never reach the editor. Terminals without the
    // protocol send press only, so this changes nothing for them.
    const press = !isKeyRelease(data) && !isKeyRepeat(data)
    if (keybindings.matches(data, 'app.tools.cycle')) {
      if (press) toggleTools()
      return { consume: true }
    }
    if (keybindings.matches(data, 'app.history.search')) {
      if (press) showHistorySearch()
      return { consume: true }
    }
    if (keybindings.matches(data, 'app.todos.toggle')) {
      if (press) toggleTodos()
      return { consume: true }
    }
    if (keybindings.matches(data, 'app.message.copy')) {
      if (press) copyLastAnswer()
      return { consume: true }
    }
    if (keybindings.matches(data, 'app.screen.redraw')) {
      if (press) {
        ui.invalidate()
        ui.requestRender(true)
      }
      return { consume: true }
    }
    if (keybindings.matches(data, 'app.cancel')) {
      // An open completion popup owns Esc first: the editor closes it, and a
      // key that dismissed the popup and cancelled the turn in one press would
      // make the popup dangerous to open mid-run.
      if (editor.isShowingAutocomplete()) return undefined
      if (press) handleEscape()
      return { consume: true }
    }
    if (matchesKey(data, Key.ctrl('c'))) {
      if (press) {
        if (agent.status === 'running') {
          // Claude Code's ladder, plus the rung a terminal needs that a browser
          // tab does not. While a turn runs Ctrl+C means cancel, so the first
          // press cancels and drops any exit armed while idle — a turn that
          // started under an armed exit must not die of a keypress aimed at it.
          // A cancel the driver honors ends the turn, and the ladder resets with
          // it. One it does not honor leaves the user pressing a key that visibly
          // does nothing, so the second press repeats the cancel (a driver may
          // check the flag only at its next boundary) and arms the escape hatch,
          // and the third leaves without the turn — the only exit available when
          // the turn is what is stuck.
          if (!cancelRequested) {
            cancelActiveTurn()
            disarmExit()
          } else if (exitArmed === undefined) {
            cancelActiveTurn()
            armExit('Press ctrl+c again to exit without waiting for the turn.')
          } else {
            disarmExit()
            void shutdown(true)
          }
        } else if (editor.getText() !== '') {
          editor.setText('')
          disarmExit()
          // `Editor.setText` mutates the buffer without asking for a redraw, so
          // without this the cleared draft stays on screen until something else
          // repaints — the discard has to be visible the moment it happens.
          requestRender()
        } else if (exitArmed !== undefined) {
          requestExit()
        } else {
          armExit('Press ctrl+c again to exit.')
        }
      }
      return { consume: true }
    }
    if (keybindings.matches(data, 'app.exit')) {
      if (press) {
        // Ctrl+D is the empty-prompt EOF it is in every shell: a draft in the
        // editor is unsent work, and ending the session on top of it threw away
        // something the user had typed but not yet delivered. The row names the
        // key that discards it, so the exit is two deliberate presses away
        // rather than one accident.
        if (agent.status === 'running') appendNotice('Cancel the active turn before exiting.', 'warning')
        else if (editor.getText() !== '') flashStatus('Draft in the editor — clear it with ctrl+c to exit.')
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
    // A completed call's own event says nothing about which tool ran, so the
    // name and arguments are carried from its `tool/call`. Entries are dropped
    // as they are consumed, and a turn that ends takes its unanswered calls
    // (a cancelled turn discards them) with it, so this never grows with the
    // log the way a per-session index would.
    if (event.type === 'tool/call') {
      inFlightToolCalls.set(event.data.callId, { name: event.data.name, arguments: event.data.arguments })
    }
    if (event.type === 'turn/end') inFlightToolCalls.clear()
    if (event.type === 'tool/result') {
      const callId = event.data.message.content[0].toolCallId
      const call = inFlightToolCalls.get(callId)
      inFlightToolCalls.delete(callId)
      // An orphaned result (its call was compacted away, or the TUI mounted
      // mid-turn) is unclassifiable, and unclassifiable means "assume it
      // wrote" — see toolCallTouchesFiles.
      if (call === undefined || toolCallTouchesFiles(ctx.tools.get(call.name, agent), call.arguments)) {
        fileSearch.invalidate()
      }
    }
    // `foldGoal` rejects a malformed change loudly, and this listener runs on
    // the shared event bus: a throw here would take every other subscriber's
    // notification with it, so a rejected refold keeps the last good goal.
    if (event.type === 'goal/change') {
      try {
        goalState = foldGoal(agent.session.events)
      } catch (error: unknown) {
        ctx.logger.warn(`dsh-tui: goal fold rejected a change; keeping the last goal: ${errorChain(error)}`)
      }
    }
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
    // without this a later send would drive a zombie agent/session; `agentGone`
    // makes dispatchMessage report it instead.
    //
    // It is deliberately not `disposed`: that flag means "this terminal is
    // going away" and gates rendering itself, so setting it here froze the
    // screen the notice below was written for — the refusal never painted, and
    // neither did the `/resume` picker it points at. The agent is gone; the
    // terminal is not.
    // The hard clear also retires live compaction. A later compaction/end is
    // intentionally presentation-silent: this disposal notice owns the
    // terminal outcome, and no animation may survive agent detachment.
    agentGone = true
    clearStatus()
    appendNotice(`Agent "${agent.id}" was disposed; this session can no longer run a turn. ${DISPOSED_RECOVERY}`, 'warning')
  })

  const detachListeners = (): void => {
    skillAbort.abort()
    fileSearch.dispose()
    clearFlash()
    disarmEscape()
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
    let frame = 0
    header.setRevealWidth(0)
    revealTimer = setInterval(() => {
      // The width is re-read every frame rather than captured at the start: a
      // terminal resized mid-sweep used to keep wiping toward the width the
      // animation began at, which left the wipe running past the edge of a
      // narrowed frame and stopping short of a widened one.
      frame += 1
      const total = Math.max(1, runtime.terminal.columns)
      const shown = bannerRevealWidth(frame, total)
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
  // A rewind handoff opens its forked chat with the prompt it went back to
  // already in the editor, unsent: the point of going back is to say it
  // differently, and sending it unread would take that choice away.
  if (config.initialDraft !== undefined && config.initialDraft !== '') {
    editor.setText(config.initialDraft)
  }
  const restoredGoal = goalState.goal
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
  //
  // The gate around it is the ordering guarantee: until this invocation has
  // settled, a submitted prompt is held (see submitLine) rather than racing the
  // registry lookup to the model. It opens on every outcome, including a failed
  // or unknown skill — a lookup that produced nothing must not strand what the
  // user typed while it ran.
  if (config.initialSkill !== undefined) {
    void invokeSkill(config.initialSkill, '').finally(releaseInitialSkill)
  }

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
    clearTimeout(stallTimer)
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
  // Neither event is guaranteed to arrive: the plugin that creates this agent
  // can deadlock (a provider initializing against an unreachable endpoint) and
  // then it reports neither success nor failure. The wait used to be unbounded,
  // and its symptom was a terminal that printed nothing and never returned —
  // the one failure mode a startup path must not have.
  const stallTimer = setTimeout(() => {
    fail(sessionId, new Error(`no agent was created within ${String(AGENT_START_TIMEOUT_MS)}ms (the plugin that creates it reported neither success nor failure)`))
  }, AGENT_START_TIMEOUT_MS)
  stallTimer.unref()
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
 * One agent's preset composition: the id its creation header records, and the
 * setup hook that installs it. Both absent when the deployment composes no
 * roster, which is the shape every session had before presets existed.
 */
interface PresetComposition {
  /** The preset id to record as a creation fact; absent without a roster. */
  readonly agentPreset?: string
  /** Creation-time hook that joins the unpublished agent to that composition. */
  readonly setup?: AgentSetup
}

/**
 * Resolve the preset an agent will be composed from, and the setup that
 * installs it.
 *
 * The id is resolved BEFORE the agent exists because the session boundary
 * snapshots `meta` before asynchronous setup begins, so a preset discovered
 * during setup could never reach the header. Mounting still happens inside
 * setup, where a rejection rolls the whole creation back rather than leaving a
 * published session whose capabilities are half-installed — which is also why
 * an unknown `--preset` fails the start with the roster's own message and its
 * list of ids that do exist.
 *
 * Optional service: the roster is a deployment choice, and a profile that
 * mounts none composes nothing, exactly as this bundle behaved before.
 * @param ctx - the runner context.
 * @param presetId - the requested preset, or `undefined` for the roster default.
 * @returns the header fact and the setup hook, both absent without a roster.
 * @throws when the roster supplies no such preset.
 */
async function composeAgentPreset(
  ctx: Context,
  presetId: string | undefined,
): Promise<PresetComposition> {
  const presets = ctx.get('agentPresets')
  if (presets === undefined) return {}
  const resolvedId = (await presets.resolve(presetId)).id
  return {
    agentPreset: resolvedId,
    setup: async (agentCtx: Context) => { await presets.mount(agentCtx, resolvedId) },
  }
}

/**
 * The composition a resumed session must be rebuilt under: the one its own log
 * records, never the one this process was asked for.
 *
 * Read from the LOG rather than the header, because a session that switched
 * preset while it was blank ran every one of its turns under the newer
 * composition; rebuilding it from the header would restore that history under
 * a tool set the model no longer has. The session is inspected cold — before
 * `resume` publishes anything — because setup receives only the agent's scope
 * and has nothing to read the log from.
 *
 * A session with no persistence to inspect (an embedder without the service, a
 * log written before the roster existed) falls back to the roster default,
 * which is what an unrecorded preset resolves to everywhere else.
 * @param ctx - the runner context.
 * @param sessionId - the session about to be resumed.
 * @returns the setup hook, absent without a roster.
 */
async function composeResumedPreset(ctx: Context, sessionId: SessionId): Promise<PresetComposition> {
  const presets = ctx.get('agentPresets')
  if (presets === undefined) return {}
  const persistence = ctx.get('sessionPersistence')
  let recorded: string | undefined
  if (persistence !== undefined) {
    const { meta, events } = await persistence.inspect(sessionId)
    recorded = sessionAgentPreset({ header: meta, events })
  }
  const composition = await composeAgentPreset(ctx, recorded)
  // A resume records nothing new: the header is a creation fact and the log
  // already carries whatever switch produced `recorded`.
  return composition.setup === undefined ? {} : { setup: composition.setup }
}

/**
 * Create or resume the single agent this terminal drives.
 *
 * Exported for the same reason {@link startupFailureMessage} is: the boot path
 * settles facts a mounted chat can no longer be asked about — which preset the
 * creation header records, and which composition a resumed session is rebuilt
 * under — and both are decided before any terminal exists.
 * @param ctx - the runner context.
 * @param startup - the parsed command line.
 * @param agentOptions - resolved model route, when one was selected.
 * @returns the owned agent handle.
 * @throws when `--resume`/`--continue` names no loadable session, or when
 * `--preset` names one the roster does not supply.
 */
export async function openStartupAgent(
  ctx: Context,
  startup: TuiStartupValues,
  agentOptions: AgentOptions | undefined,
): Promise<AgentHandle> {
  const options = agentOptions === undefined ? {} : { agentOptions }
  const resumeOptions = async (resumeSessionId: SessionId): Promise<{
    resumeSessionId: SessionId
    agentOptions?: AgentOptions
    setup?: AgentSetup
  }> => ({ resumeSessionId, ...options, ...await composeResumedPreset(ctx, resumeSessionId) })
  const createOptions = async (sessionId: SessionId): Promise<CreateAgentOptions> => {
    const composition = await composeAgentPreset(ctx, startup.preset)
    return {
      sessionId,
      meta: {
        cwd: process.cwd(),
        ...composition.agentPreset === undefined ? {} : { agentPreset: composition.agentPreset },
      },
      ...options,
      ...composition.setup === undefined ? {} : { setup: composition.setup },
    }
  }
  if (startup.resume !== undefined) {
    return ctx.agents.resume(await resumeOptions(SessionId(startup.resume)))
  }
  if (startup.continueLatest) {
    const latest = await latestWorkspaceSession(ctx)
    if (latest === undefined) {
      throw new Error('dsh-tui: --continue found no persisted session for this workspace')
    }
    return ctx.agents.resume(await resumeOptions(latest))
  }
  // A launcher may still fix the identity through `ctx.provide('mainSessionId', …)`.
  const identity = ctx.get('mainSessionId')
  if (identity !== undefined) {
    return identity.resume
      ? ctx.agents.resume(await resumeOptions(identity.id))
      : ctx.agents.create(await createOptions(identity.id))
  }
  return ctx.agents.create(await createOptions(SessionId(`session-${randomUUID()}`)))
}

/**
 * What a start that could not open its session prints before exiting.
 *
 * The in-process resume path already answers a bad session id with one readable
 * line (`handoff` below); the startup path let the same failure propagate out of
 * the cordis effect, so `--resume <typo>` answered with a stack trace, or with
 * whatever the loader logged around it. This says which session could not be
 * opened, why, and the flag to change — the three things the user needs and a
 * trace does not carry.
 * @param startup - the parsed command line, for which selection failed.
 * @param error - the rejection from the agent registry.
 * @returns the message to write on the released terminal, newline included.
 */
export function startupFailureMessage(startup: TuiStartupValues, error: unknown): string {
  const cause = errorChain(error)
  if (startup.resume !== undefined) {
    return `dsh-tui: cannot resume session "${startup.resume}": ${cause}\n`
      + 'Start without --resume for a new session, or --continue for the most recent one in this workspace.\n'
  }
  if (startup.continueLatest) {
    return `dsh-tui: cannot continue the most recent session: ${cause}\n`
      + 'Start without --continue for a new session.\n'
  }
  return `dsh-tui: cannot start a session: ${cause}\n`
}

/**
 * Why a parsed command line cannot be served at all, when it cannot be.
 *
 * `--print` is the one flag this app parses and does not implement: it asks for
 * an answer without a UI, and the runner used to ignore it and open the chat —
 * so the caller who wanted text on stdout got a full-screen terminal instead,
 * and a script that piped the output got the TTY refusal from `apply` with no
 * word about the flag it actually passed. Refusing names the profile that does
 * have a headless path, which makes the flag a redirection rather than a wall.
 * @param startup - the parsed command line.
 * @returns the refusal to write on stderr, or `undefined` when the run may proceed.
 */
export function startupRefusal(startup: TuiStartupValues): string | undefined {
  if (startup.print === undefined) return undefined
  return 'dsh-tui: --print is not implemented in this profile.\n'
    + 'Use a headless profile for a one-shot answer, e.g. dsh --profile headless "run the tests".\n'
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
  // Refused before the renderer exists, not after: `--print` asks for an answer
  // without a UI, and the terminal this run would otherwise take over is the one
  // thing the caller said they did not want. `ProcessTerminal`'s constructor
  // touches nothing, so nothing has to be restored on this path.
  const refusal = startupRefusal(startup)
  if (refusal !== undefined) {
    process.stderr.write(refusal)
    exit(2)
    return
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
    handoffFork: fork => forkHandoff(fork),
  }

  const mount = (handle: AgentHandle, draft?: string): void => {
    const controller = createTuiChat(ctx, {
      ...config,
      theme: { ...config.theme, truecolor },
      ...initialSkill === undefined ? {} : { initialSkill },
      ...draft === undefined || draft === '' ? {} : { initialDraft: draft },
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
        // Same composition rule as the startup path: the session picked in
        // `/resume` is rebuilt under the preset its own log records.
        ...await composeResumedPreset(ctx, sessionId),
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

  /**
   * In-process rewind: tear the current chat and agent down, create the fork the
   * rewind asked for, and mount a fresh chat over it.
   *
   * The parent session is never touched — it keeps its whole log and stays
   * resumable — so a rewind is a branch, not an edit. Files on disk are not part
   * of the fork in either direction: dsh snapshots no working tree, and the
   * Rewind panel says so rather than implying a restore this cannot do.
   * @param fork - The seed, lineage, workspace, and draft the new chat opens with.
   * @returns Never; the replacement chat owns the terminal from here.
   */
  async function forkHandoff(fork: TuiForkRequest): Promise<never> {
    await teardown()
    let forked: AgentHandle
    try {
      forked = await ctx.agents.create({
        sessionId: SessionId(`session-${randomUUID()}`),
        seed: fork.seed,
        meta: { cwd: fork.cwd, parentSession: fork.parentSession, seedLength: fork.seed.length },
        ...agentOptions === undefined ? {} : { agentOptions },
        // The fork replays the parent's turns, so it is rebuilt under the
        // composition the parent's own log records, exactly as a resume is.
        ...await composeResumedPreset(ctx, fork.parentSession),
      })
    } catch (error: unknown) {
      terminal.write(`dsh-tui: failed to fork session "${fork.parentSession}": ${errorChain(error)}\n`)
      exit(1)
      throw error
    }
    mount(forked, fork.draft)
    return await new Promise<never>(() => {})
  }

  // Registered before the first await so plugin teardown always reaches
  // whichever session is mounted when it runs.
  ctx.effect(() => () => teardown(), 'dsh-tui/session')

  let handle: AgentHandle
  try {
    handle = await openStartupAgent(ctx, startup, agentOptions)
  } catch (error: unknown) {
    // Reported on the terminal this run never took over, exactly as the resume
    // handoff reports its own fatal case: nothing is mounted yet, so there is
    // no transcript to put a notice in and no renderer to restore.
    terminal.write(displayText(startupFailureMessage(startup, error)))
    exit(1)
    return
  }
  mount(handle)

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

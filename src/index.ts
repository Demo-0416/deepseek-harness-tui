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
import { parseCommand, type CommandResult } from '@deepseek-ai/dsh-commands'
import { createUserMessage, errorChain } from '@deepseek-ai/dsh-llm'
import type { CallId, ContentBlock, LlmCallConfig, MessageId, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-llm-retry'
// Type import declaration-merges the compaction bracket events onto the
// session event map, so `compaction/start` / `compaction/end` are typed here.
import type {} from '@deepseek-ai/dsh-compaction'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import {
  SessionId,
  type Session,
  type SessionEvent,
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
import {
  renderSkillContent,
  type SkillDefinition,
  type SkillRegistry,
  type SkillSummary,
  type SkillViewOptions,
} from '@deepseek-ai/dsh-skill'
// Type-only: declaration-merges `subagent/start` and `subagent/end` onto
// `Events`, the two edges `/subagents` re-reads its directory on. The registry
// itself is a deployment choice this TUI never requires, and its listing is
// read structurally (see ./chat/subagents.ts), so only the event names are
// borrowed from the package.
import type {} from '@deepseek-ai/dsh-subagent'
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
import type { FileDiff } from '@deepseek-ai/dsh-tools'
import { ApprovalDialog } from './components/approval.ts'
import { displayInlineText, displayText } from './components/text.ts'
import { contentText } from './components/content.ts'
import {
  brandText,
  createPalette,
  isThemePreference,
  markdownTheme,
  renderPalette,
  resolveThemeAppearance,
  selectTheme,
  THEME_PREFERENCES,
  type ThemePreferenceId,
} from './components/theme.ts'
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
  contextPressure,
  createContextAnnouncementTracker,
  nextContextAnnouncement,
  type ContextPressure,
} from './chat/context-pressure.ts'
import {
  runCompactCommand,
  type ManualCompactionEngine,
} from './chat/compact.ts'
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
  autoAcceptRow,
  HeaderComponent,
  planModeRow,
  TodoComponent,
  TOOL_CARD_PHASES,
} from './components/transcript.ts'
import { claudeMarkdownTheme } from './render/markdown.ts'
import { ScrollablePanel } from './components/panel.ts'
import { HistorySearchPanel, type HistorySearchOutcome } from './components/history-search.ts'
import { RewindPanel } from './components/rewind.ts'
import { forkSeedLength, hasRewindTarget, rewindTargets, type RewindTarget } from './chat/rewind.ts'
import { TranscriptSearchPanel } from './components/transcript-search.ts'
import { transcriptEntries } from './chat/transcript-search.ts'
import {
  APP_KEYBINDINGS,
  installKeybindings,
  keybindingCollisions,
  keyLabel,
  type AppKeybinding,
} from './keybindings.ts'
import {
  PluginsPanel,
  type PluginInventoryReader,
} from './components/plugins-panel.ts'
import { SkillsPanel } from './components/skills-panel.ts'
import { SubagentsPanel } from './components/subagents-panel.ts'
import { JobsPanel } from './components/jobs-panel.ts'
import {
  SettingsPanel,
  type SettingsEntry,
} from './components/settings-panel.ts'
import {
  BUSY_ENTER_BEHAVIORS,
  openTuiPreferences,
  QUEUE_UP_HINT_LIMIT,
  type BusyEnterBehavior,
  type TuiPreferenceStore,
} from './chat/preferences.ts'
import {
  compactTargetLabel,
  diagnosticMeter,
  formatDiagnosticCount,
  formatDiagnosticNumber,
  formatDiagnosticTime,
  initialTarget,
  QuestionDialog,
  StatusCardComponent,
  PromptContextComponent,
  targetLabel,
  ThemeDialog,
  type StatusCardRow,
} from './components/dialogs.ts'
import {
  parseSkillCommand,
  renderSkillEcho,
  SKILL_COMMAND_PREFIX,
} from './chat/skill-invocation.ts'
import { ReferenceAutocompleteProvider } from './chat/autocomplete.ts'
import { clipboardPath, copyToClipboard, type ClipboardPath } from './chat/clipboard.ts'
import { collectAnswerTexts, parseCopyArgument, type CopyRequest } from './chat/copy.ts'
import { truncatePrompt } from './chat/prompt-truncation.ts'
import {
  BANNER_REVEAL_INTERVAL_MS,
  bannerRevealWidth,
  formatCwd,
  gitBranch,
  HintEditor,
  HISTORY_LIMIT,
  packageVersion,
  resumeCommandLine,
  shortSessionId,
} from './chat/helpers.ts'
import {
  APPROVAL_RULES_FLUSH_TIMEOUT_MS,
  escalationAccess,
  isInsideProject,
  openApprovalRules,
  serializeApprovalRule,
} from './chat/approval-rules.ts'
import {
  openPromptHistory,
  PROMPT_HISTORY_FLUSH_TIMEOUT_MS,
} from './chat/prompt-history.ts'
import {
  checkForUpdate,
  updateCommandLine,
  UPDATE_CHECK_PACKAGE_NAME,
} from './chat/update-check.ts'
import {
  createModelController,
  type ModelController,
} from './chat/model-command.ts'
import {
  createPresetController,
  sessionAgentPreset,
  type PresetController,
} from './chat/preset-command.ts'
import {
  createLoginController,
  type LoginController,
} from './chat/login-command.ts'
import { pendingUserQueue, queueItemPreview } from './chat/queue.ts'
import { createQuestionQueue } from './chat/questions.ts'
import { startPrintRun, type PrintIo } from './print.ts'
import {
  clipSessionMarkdown,
  exportSessionLog,
  isClipboardExportTarget,
  MARKDOWN_MAX_CHARS,
  renderSessionMarkdown,
  type SessionArtifactReader,
  type SessionFlusher,
} from './chat/export.ts'
import { runRenameCommand, type SessionTitleWriter } from './chat/rename.ts'
import {
  subagentCounts,
  subagentDirectory,
  type SubagentCounts,
  type SubagentDescendant,
} from './chat/subagents.ts'
import {
  jobCounts,
  jobsRegistry,
  sortJobRows,
  type JobRow,
  type JobsRegistry,
} from './chat/jobs.ts'
import {
  formatGoalPrompt,
  formatSessionStats,
  goalStatusRows,
} from './chat/session-summary.ts'
import { createResumeController } from './chat/resume.ts'
import { renderMcpPanel } from './chat/mcp.ts'
import { renderDoctorPanel, runDoctorChecks } from './chat/doctor.ts'
import type { TuiForkRequest, TuiResumeHost, TuiRuntime } from './runtime.ts'
import { toolCallTouchesFiles, WorkspaceFileSearch } from './chat/file-autocomplete.ts'
import { resolveFileSearchCommand } from './chat/fd.ts'
import {
  editTextExternally,
  resolveExternalEditor,
  type ExternalEditorResolution,
} from './chat/external-editor.ts'
import {
  copyArgumentCompletions,
  exportArgumentCompletions,
  langArgumentCompletions,
  loginArgumentCompletions,
  memoizeListing,
  modelArgumentCompletions,
  presetArgumentCompletions,
  providerArgumentCompletions,
  resumeArgumentCompletions,
  themeArgumentCompletions,
  type CompletableSession,
} from './chat/command-completions.ts'
import { readProviderRoster } from './chat/provider-store.ts'
import {
  AGENT_START_TIMEOUT_MS,
  EXIT_IDLE_TIMEOUT_MS,
  whenIdleOrTimeout,
} from './chat/lifecycle.ts'
import type { TuiStartupValues } from './startup.ts'
import {
  commandDescription,
  currentLocale,
  localeName,
  onLocaleChange,
  plural,
  setLocale,
  t,
  type MessageKey,
} from './i18n/index.ts'
import { resolveLocaleStore } from './i18n/persistence.ts'
import { runLangCommand } from './chat/lang-command.ts'
import {
  AUTO_ACCEPT_PRESET,
  nextMode,
  type ModeAxes,
  type SessionMode,
} from './chat/modes.ts'

export { TuiPromptService } from './prompt.ts'
export { renderSkillEcho } from './chat/skill-invocation.ts'
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
 * How long a transient confirmation (the Ctrl+O card cycle, the Ctrl+T thinking
 * switch, the Ctrl+N plan toggle) stays on the status row before the row goes
 * back to what it was showing.
 */
const STATUS_FLASH_MS = 1_500

/**
 * How long the "there is an editor for this" hint holds the status row the
 * first time a draft grows a second line. Claude Code's own `timeoutMs`
 * (`Notifications.tsx:146-160`), and long enough to be read once without
 * becoming a thing that keeps happening.
 */
const EXTERNAL_EDITOR_HINT_MS = 5_000

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
 * Device-status report asking the terminal which color scheme it is set to
 * (`CSI ? 996 n`); a terminal that implements the palette-notification protocol
 * answers `CSI ? 997 ; 1 n` for dark or `CSI ? 997 ; 2 n` for light, and most
 * answer nothing at all.
 *
 * Written directly rather than through pi-tui's `queryTerminalColorScheme`,
 * whose answer this terminal already takes from `onTerminalColorSchemeChange`
 * instead: that helper arms a two-second `setTimeout` so it can resolve a
 * promise nothing here reads, and neither the timer nor the promise can be
 * reached from outside to cancel. A referenced timer that teardown cannot clear
 * is the one thing an exit path must not leave behind — the process sat in the
 * event loop for the remainder of that window after printing its goodbye,
 * instead of ending — and it is the same rule `clearStatus` already applies to
 * the armed-exit timer.
 */
const COLOR_SCHEME_QUERY = '\x1b[?996n'

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
 * How long the open `/subagents` panel waits after a delegation edge before it
 * re-reads the directory. A fan-out spawns its children in one burst, and each
 * listing is a persistence pass over the whole tree, so the burst is answered
 * once — short enough that a single delegation still appears at once.
 */
const SUBAGENT_REFRESH_DEBOUNCE_MS = 200

/**
 * How often the open `/jobs` panel repaints while something is still running.
 *
 * The list is the one surface with a clock that has to move while nothing else
 * on screen does, and a second is the resolution its durations are printed at.
 * The timer exists only while the panel is open AND a job is live, so a
 * terminal sitting idle at the prompt schedules nothing.
 */
const JOBS_ELAPSED_TICK_MS = 1_000

/**
 * Smallest panel a short terminal still gets: three rows of chrome (the
 * separating blank, the title, the hint) and two of content. A panel squeezed
 * below this shows nothing it was opened for, which is worse than one that
 * crowds the prompt.
 */
const MIN_PANEL_ROWS = 5

/**
 * How the debug and status surfaces name the Ctrl+T state.
 *
 * Message keys rather than the strings themselves: a `const` holding rendered
 * text would freeze the locale it was imported under, so the lookup happens at
 * render time through {@link t}.
 */
const THINKING_STATE_KEYS = {
  disabled: 'status.thinking.disabled',
  pinned: 'status.thinking.kept',
  live: 'status.thinking.live',
} as const

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
    t('hotkeys.editor'),
    t('hotkeys.entry'),
    t('hotkeys.history', { search: key('app.history.search'), transcript: key('app.transcript.search') }),
    // Split off the copy/redraw half when Ctrl+T joined this row: one line
    // naming four keys wrapped at 96 columns, which is where `?` renders.
    t('hotkeys.cards', { cycle: key('app.tools.cycle'), thinking: key('app.thinking.toggle') }),
    t('hotkeys.modes', { mode: key('app.mode.cycle') }),
    t('hotkeys.copy', {
      todos: key('app.todos.toggle'),
      copy: key('app.message.copy'),
      redraw: key('app.screen.redraw'),
    }),
    t('hotkeys.externalEditor', { key: key('app.draft.edit') }),
    t('hotkeys.busyEnter', { key: key('app.submit.opposite') }),
    t('hotkeys.cancel', { cancel: key('app.cancel') }),
    t('hotkeys.exit', { exit: key('app.exit') }),
    t('hotkeys.interrupt'),
    t('hotkeys.interruptAgain'),
    t('hotkeys.panel'),
    t('hotkeys.question', { custom: t('dialog.question.customAnswerLabel') }),
    t('hotkeys.approval'),
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
 * The events a permission switch writes: the recorded selection and the two
 * knobs it bundles.
 *
 * Matched as strings rather than as event-map members because this bundle does
 * not depend on the packages that declare them (`dsh-permission-presets`,
 * `dsh-sandbox-policy`) — the same reason the service itself is read through
 * `ctx.get`. A deployment without them simply never emits these.
 */
const PERMISSION_EVENTS: ReadonlySet<string> = new Set([
  'permission/preset',
  'approval/policy',
  'sandbox/mode',
])

/**
 * The permission-preset service as the mode cycle uses it.
 *
 * Optional and untyped for the same reason `approval` is: this bundle does not
 * depend on `@deepseek-ai/dsh-permission-presets` (a deployment may compose no
 * preset table at all), so the service is read through the non-throwing
 * accessor and every member is checked before it is called. The three members
 * are the whole write path the README documents — the table, the derived
 * current selection, and the switch — with `custom` arriving from `current()`
 * as an ordinary name the cycle simply does not own.
 */
interface PermissionPresetSeam {
  /** Every switchable preset name, in table order. */
  names?: readonly string[]
  /** The preset the session's folded knobs compose to, or `custom`. */
  current?: (events: readonly SessionEvent[]) => unknown
  /** Record the selection and write whichever knobs it changes. */
  set?: (session: Session, name: string) => void
}

/**
 * The plan-mode service as the mode cycle uses it.
 *
 * `get` separates the logged state from a selection queued for the next step,
 * and `set` reports which of the two it did — both facts the cycle needs, since
 * a press during an open turn queues rather than commits and the next press
 * must start from the queued value rather than repeat the transition.
 */
interface PlanModeSeam {
  /** The logged state, plus a selection awaiting the next accepted pre-step. */
  get?: (agent: Agent) => { active?: unknown; pending?: unknown } | undefined
  /** Select plan mode; reports `committed`, `queued`, `cancelled`, or `noop`. */
  set?: (agent: Agent, active: boolean) => unknown
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

/**
 * Which key sent one prompt.
 *
 * `enter` follows the stored busy-Enter preference; `opposite` takes the other
 * branch for that one send, the way the harness's web chat reads Cmd/Ctrl+Enter.
 */
type SubmitGesture = 'enter' | 'opposite'

/** One submission's session-reference snapshot, and where it is right now. */
interface AttachedSnapshot {
  /** The context message itself, for delivering or withdrawing it later. */
  readonly message: UserMessage
  /**
   * Whether it is in the inbox already, rather than parked here waiting for the
   * turn boundary that will claim the prompt it belongs to.
   */
  injected: boolean
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
  /**
   * The choices `/config` and `/theme` write, read once here so the first frame
   * is already painted in the theme the user picked in an earlier session.
   *
   * The report is deferred to a microtask: nothing exists to append a notice to
   * while the terminal is still being assembled.
   */
  const preferences: TuiPreferenceStore = openTuiPreferences(
    ctx,
    // No deployment layer under these three: `showReasoning` in config is the
    // master switch over whether thinking may be shown at all, not the default
    // for the pin, and the tool-card phase and theme have no config of their own.
    {},
    (message) => {
      queueMicrotask(() => {
        if (!disposed) appendNotice(message, 'warning')
      })
    },
  )
  const storedPreferences = preferences.current()
  /**
   * The theme this terminal paints with, and the scheme the terminal itself
   * last reported. `auto` follows the report; the other three override it, so
   * both facts are kept — a user who returns to `auto` gets the terminal's own
   * answer back rather than whichever palette was forced over it.
   */
  let themePreference: ThemePreferenceId = storedPreferences.theme
  let reportedScheme: TerminalColorScheme = 'dark'
  let appearance = resolveThemeAppearance(themePreference, reportedScheme, resolved.theme.color)
  const palette = createPalette(appearance.color, appearance.scheme)
  const mdTheme = markdownTheme(palette)
  const ui: TUI = new TuiMainScreen(runtime.terminal, resolved.showHardwareCursor)
  const chat = new Container()
  const todoContainer = new Container()
  const questionContainer = new Container()
  /**
   * The component holding the inline modal slot, while one holds it.
   *
   * Inline dialogs (permission prompts, agent questions) are children of
   * {@link questionContainer} rather than pi-tui overlays, so they are not on
   * the overlay stack and pi-tui's "focus fell off a visible overlay, put it
   * back" self-heal never covers them. Anything that reclaims focus for the
   * prompt has to ask this first, or a dialog that arrived while the prompt was
   * away is left on screen and unanswerable — the turn behind it blocks forever.
   */
  let inlineFocusTarget: Component | undefined
  /**
   * Holds the mode badges — plan mode, auto-accept — while either is on, and
   * nothing at all otherwise: an empty container costs no row, which is what
   * keeps the prompt in the same place in the ordinary case.
   *
   * Both can be on at once. The Shift+Tab cycle never leaves them that way, but
   * `/permission auto-accept` and `/plan` are independent commands and the badge
   * strip reports what is true rather than what one key produces.
   */
  const modeContainer = new Container()
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
  /**
   * The deployment's master switch over reasoning, read once and never moved.
   *
   * `showReasoning: false` means this transcript does not show reasoning at
   * all — no phase, no key, no command, no `/config` row — so it is a constant
   * here rather than the seed of a runtime toggle: a switch a user could flip
   * back on would make the setting a default rather than the policy it is meant
   * to be.
   */
  const reasoningEnabled = resolved.showReasoning
  /**
   * Ctrl+T and the `/config` panel's Thinking display row: whether finished
   * steps keep their thinking blocks on screen.
   *
   * A presentation switch and nothing else — the model reasons either way, and
   * flipping it re-renders the whole transcript, history included. Off (the
   * shipped default) is Claude Code's shape: thinking streams while the step
   * runs and goes with the step that produced it. A user who said otherwise in
   * `/config` opens on their own answer instead, unless the deployment took the
   * blocks away entirely.
   */
  let thinkingPinned = reasoningEnabled && storedPreferences.thinkingPinned
  // Ctrl+O cycles collapsed -> expanded -> hidden. Codex-style: hidden drops
  // tool cards entirely, collapsed previews, expanded shows full bodies. The
  // session opens on the stored default; the key moves this session alone.
  let toolsVisibility: ToolCardVisibility = storedPreferences.toolCards
  /**
   * How often the empty input row has already offered Up as the way to edit a
   * queued prompt. Counted across sessions, because a hint that starts over on
   * every launch is an advertisement rather than a lesson.
   */
  let queueUpHintSeen = storedPreferences.queueUpHintSeen
  /** Whether the queue on screen right now has already been counted as taught. */
  let queueHintCounted = false
  /**
   * Whether the queue is one the user actually has to wait through.
   *
   * Read off the inbox signals rather than off {@link queueCount} alone: an
   * ordinary prompt typed at an idle agent is in the inbox for the tick between
   * the send and the driver's claim, and the status flip to `running` happens
   * inside that tick. Teaching there would spend the whole three-showing lesson
   * on the first three ordinary prompts of a user's first session, before a
   * queue they can edit has ever existed.
   */
  let queueTeachable = false
  /**
   * What Enter does with a prompt typed while a turn runs — steer it or queue
   * it — as `/config` last left it. Read on every submission rather than
   * captured, so the row and the key can never disagree.
   */
  let busyEnter: BusyEnterBehavior = storedPreferences.busyEnter
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
  // keyed by MessageId and carrying the text a cancel hands back to the editor.
  // Counting and listing read `agent.inbox` instead (see {@link queueCount}):
  // that is the queue the driver actually consumes, and it also holds what
  // other hosts inserted. What is left here is the refund ledger for a cancel,
  // settled by the same claimed/discarded signals that settle the optimistic
  // echo in the store (one node per MessageId), so this map owns no transcript
  // state of its own.
  const pendingSteering = new Map<MessageId, string>()
  /**
   * The session-reference snapshot each unclaimed submission was sent with,
   * keyed by the prompt's MessageId.
   *
   * A snapshot is a separate message with its own delivery boundary, so the two
   * halves of one submission can come apart in both directions: injected
   * context takes the nearest pre-step, which for a queued prompt belongs to a
   * turn that has nothing to do with it, and a prompt taken back out of the
   * queue by Up would leave its snapshot behind as a recall dump with no
   * question attached. Keeping the pairing here is what lets both be answered.
   * Entries live exactly as long as the prompt is unclaimed.
   */
  const attachedContexts = new Map<MessageId, AttachedSnapshot>()
  /**
   * Pending user prompts in the agent's inbox, as of the last inbox or status
   * signal. Cached rather than derived per frame: `updatePromptValues` runs on
   * every animation tick, and the badge must not walk the inbox 20 times a
   * second for a number that only moves when the inbox publishes. Seeded from
   * the inbox rather than from zero: a terminal that mounts onto a session
   * whose agent is mid-turn inherits whatever is already queued there.
   */
  let queueCount = pendingUserQueue(agent.inbox).length
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
  /**
   * The skill registry this session currently composes, resolved on every use.
   *
   * `serviceFor` returns the VALUE of whichever standing mount the agent's
   * scope pointed at when it was called, not a live handle: `/preset` re-links
   * a blank session to another preset's composition, and a registry captured
   * at mount would keep serving the preset the session opened on — `/skill:`
   * completion, invocation, and the banner would all name skills this agent no
   * longer has. Cheap enough to repeat: both arms are map lookups.
   * @returns the registry serving this agent now, or `undefined` when none is mounted.
   */
  const skillRegistry = (): SkillRegistry | undefined => (typeof presetRoster?.serviceFor === 'function'
    ? presetRoster.serviceFor(agent, 'skills')
    : undefined) ?? ctx.get('skills')
  /**
   * Whether this deployment composes skills at all, decided once.
   *
   * Only the presence question is answered at mount — a profile without skills
   * never grows them, and a profile with them keeps the listener and the first
   * scan that a `/preset` switch later re-runs.
   */
  const skillsAvailable = skillRegistry() !== undefined
  /**
   * The compaction engine serving THIS agent, resolved on every use.
   *
   * Addressed through the preset roster for the same reason plan mode is: the
   * shipped `standard` preset mounts compaction behind `isolate: { compaction }`,
   * a realm no host context can see, and the host lookup is the fallback for a
   * profile that mounts it on the host plane instead. Re-resolved per call
   * because `/preset` re-links a blank session to another composition — one
   * that may compose no compaction at all.
   * @returns the engine serving this agent now, or `undefined` when none is mounted.
   */
  const compactionEngine = (): ManualCompactionEngine | undefined => (
    typeof presetRoster?.serviceFor === 'function'
      ? presetRoster.serviceFor(agent, 'compaction') as ManualCompactionEngine | undefined
      : undefined
  ) ?? ctx.get('compaction') as ManualCompactionEngine | undefined
  const cwd = agent.session.header.cwd ?? process.cwd()
  /**
   * The prompts this workspace has been given, across sessions
   * (`$DSH_HOME/history.jsonl`).
   *
   * Failures go to the log and no further: losing one history entry is not
   * worth interrupting a session over, and it is not something the user can act
   * on — the same call Claude Code makes (`history.ts:131-134 / 319-321`).
   */
  const promptHistory = openPromptHistory({
    cwd,
    sessionId: agent.session.id,
    reportError: (message) => { ctx.logger.warn(`dsh-tui: ${message}`) },
  })
  editor.onHistoryAdd = (text) => { promptHistory.append(text) }
  /**
   * The permission grants this workspace already gave, across sessions
   * (`$DSH_HOME/approvals.json`).
   *
   * Read once at mount and consulted before any prompt is drawn, so a "don't
   * ask again in this project" answered last week costs nothing today. Failures
   * take the history's route — the log and no further: an unwritable home
   * degrades the grant to this process instead of interrupting the session.
   */
  const approvalRules = openApprovalRules({
    cwd,
    reportError: (message) => { ctx.logger.warn(`dsh-tui: ${message}`) },
  })
  /**
   * `fd` if this host has it, which is what makes `@` respect `.gitignore`:
   * pi's own provider shells out to it, and `fd` reads the ignore files the
   * repository already wrote. Resolved once per mount — a binary that appears
   * on `PATH` mid-session is not worth a `PATH` walk per keystroke.
   */
  const fileSearchCommand = resolveFileSearchCommand(resolved.fileSearchCommand)
  /**
   * Which editor `Alt+E` hands the draft to, answered per press rather than
   * once: a user who exports `$EDITOR` in another pane and comes back to this
   * one gets the editor they just set, and a refusal names the reason it found
   * now rather than the reason it found at mount.
   * @returns the editor, or why there is none.
   */
  const externalEditor = (): ExternalEditorResolution => resolveExternalEditor(resolved.externalEditor)
  /**
   * Where `/lang` keeps its answer for the next process. Resolved once: the
   * choice between the Host's settings document and this bundle's own file is a
   * property of the deployment, not of the moment the command runs.
   */
  const localeStore = resolveLocaleStore(ctx)
  // …and read again from *this* store, because `apply()` resolved its own
  // before the first frame. Which store answers depends on whether the Host's
  // `locale` namespace was registered yet, so the two resolutions can disagree:
  // the earlier one lands on the file (nothing written → English) while `/lang`
  // writes to settings, and the language switched last session never comes
  // back. Reading the store that will be written keeps the pair honest, and a
  // second `setLocale` to the locale already active is a no-op.
  const storedLocale = localeStore.load()
  if (storedLocale !== undefined) setLocale(storedLocale)
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
  /** The registry read behind the update notice; nobody's answer once this terminal is gone. */
  const updateCheckAbort = new AbortController()
  const tokens = sessionTokens(agent.session)
  const commandControllers = new Set<AbortController>()
  /**
   * The controller of a `/compact` this terminal started, so Esc can stop it.
   *
   * Separate from {@link compacting} — the stopwatch — which is derived from
   * session events and also lights up for a compaction the automatic policy or
   * another process ran. Only what this terminal started is ours to cancel.
   */
  let activeCompaction: AbortController | undefined
  /**
   * Whether the user has already asked {@link activeCompaction} to stop.
   *
   * Read by the status row rather than announced beside it: a live compaction
   * owns that row while it runs, so a flash saying "cancelling" was painted
   * only in the window where no `compaction/start` had landed yet — that is,
   * never, once a real backend is behind the seam. The stopwatch says it
   * itself, and keeps counting until the backend actually lets go.
   */
  let compactCancelling = false
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
        appendNotice(t('notice.markdownDegraded'), 'warning')
      })
    },
  }
  const transcript = new TranscriptReconciler(chat, {
    palette,
    mdTheme,
    // The scheme every fill on screen is chosen against: the terminal's report
    // under `auto`, and whichever scheme `/theme` forced otherwise.
    scheme: () => appearance.scheme,
    markdown,
    maxToolOutputLines: resolved.maxToolOutputLines,
    maxDiffEditLength: resolved.maxDiffEditLength,
    events: () => agent.session.events,
    tracker: stepTimingTracker,
    now,
    toolDefinition: name => ctx.tools.get(name, agent),
    cwd,
    // Read from the manager, like every other key this UI names: a deployment
    // that moved `app.tools.cycle` would otherwise leave every collapsed row
    // advertising a key that does nothing.
    expandKey: () => keyLabel(keybindings, 'app.tools.cycle'),
  }, { showReasoning: reasoningEnabled, visibility: toolsVisibility, thinkingPinned })

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
  /**
   * The banner's `[Plugins]` list, read from the Loader inventory on first
   * successful render and cached: the plugin set is the deployment's
   * cordis.yml, which does not change within a session, but `pluginInventory`
   * is a host mount that may resolve only after the banner is on screen — so
   * an unanswered read retries next frame rather than pinning "no plugins".
   */
  let headerPlugins: readonly string[] | undefined
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
    plugins: (): readonly string[] | undefined => {
      if (headerPlugins === undefined) {
        const inventory = ctx.get('pluginInventory') as PluginInventoryReader | undefined
        const entries = inventory?.list().entries
        if (entries !== undefined) {
          // Enabled entries only, one row per module: the banner is a menu of
          // what is live, not the Loader tree `/plugins` inspects.
          headerPlugins = [...new Set(
            entries.filter(entry => entry.enabled).map(entry => entry.moduleName),
          )].sort((left, right) => left.localeCompare(right))
        }
      }
      return headerPlugins
    },
  } satisfies HeaderInfo
  const header = new HeaderComponent(
    headerInfo,
    palette,
    // A getter, not a value: the banner is mounted once and never remounted by
    // `repaint`, so a `/theme no-color` mid-session (or a stored `no-color`
    // preference read after this line) has to reach the wordmark's gradient
    // through the same live appearance every other surface reads.
    () => appearance.color && resolved.theme.truecolor,
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
  /**
   * The highest pressure band this terminal has already put a row in the
   * transcript for.
   *
   * Per-mount state on purpose: `/new`, `/resume`, and every handoff rebuild
   * this channel, and a fresh session starts un-warned.
   */
  const contextAnnouncement = createContextAnnouncementTracker()
  /**
   * The job registry the badge and the open `/jobs` panel are subscribed to.
   *
   * Re-resolved rather than captured (see `watchJobs` below): both of them are
   * fed by one subscription, so a registry that arrives after this mount — an
   * embedder providing `jobs` around `createTuiChat`, or a reload of the
   * plugin that owns it — would otherwise leave that subscription attached to
   * an instance nobody reports to, with a badge stuck at zero and an open panel
   * frozen on the snapshot it opened with.
   */
  let jobs = jobsRegistry(ctx)
  /**
   * How many background jobs are still live, refolded only when the registry
   * says the visible set changed.
   *
   * `updatePromptValues` runs on every animation frame — 50 ms apart while a
   * turn is live — and `list()` mints a fresh snapshot object per job per call,
   * so counting per frame would allocate the whole visible set per frame for a
   * number that changes when a job starts or ends. The goal fragment beside it
   * earns its frame budget the same way.
   */
  let liveJobs = jobs === undefined ? 0 : jobCounts(jobs.list(agent)).live
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
    ctx.tuiPrompt.register('jobs'),
    ctx.tuiPrompt.register('symbol', palette.bold(palette.accent('dsh'))),
    ctx.tuiPrompt.register('indicator', palette.dim('> ')),
  ]
  const [
    cwdValue, gitValue, tokenValue, modelValue, contextValue, goalValue, queuedValue, jobsValue,
    symbolValue, indicatorValue,
  ] = promptValues
  /* v8 ignore next -- the fixed built-in registration list always supplies each handle. */
  if (cwdValue === undefined || gitValue === undefined || tokenValue === undefined || modelValue === undefined
    || contextValue === undefined || goalValue === undefined || queuedValue === undefined
    || jobsValue === undefined || symbolValue === undefined || indicatorValue === undefined) {
    throw new Error('TUI prompt built-ins failed to initialize')
  }
  const updatePromptValues = (): void => {
    const renderTime = now()
    cwdValue.set(palette.bold(palette.accent(formattedCwd)))
    gitValue.set(branch === undefined ? undefined : palette.dim(` (${displayText(branch)})`))
    const rate = cacheHitRate(tokens)
    const usage = `↑${formatTokens(tokens.input)} ↓${formatTokens(tokens.output)}`
    modelValue.set(`  ${palette.dim(displayText(target.current === undefined
      ? t('prompt.modelUnset')
      : compactTargetLabel(target.current)))}`)
    tokenValue.set(`  ${palette.dim(rate === undefined ? usage : `${usage}  ${t('prompt.cache', { rate })}`)}`)
    // One measurement feeds both the row's colour and the escalation check, so
    // a warning can never disagree with the percentage printed beside it.
    const pressure = contextPressure(contextTokens(), modelController.contextWindow())
    contextValue.set(pressure === undefined ? undefined : `  ${
      pressure.level === 'normal'
        ? palette.dim(t('prompt.context', { percent: pressure.percentUsed }))
        : (pressure.level === 'critical' ? palette.error : palette.warning)(
          t('prompt.contextLow', { remaining: pressure.percentRemaining }),
        )
    }`)
    if (pressure !== undefined) announceContextPressure(pressure)
    const goalFragment = formatGoalPrompt(goalState.goal)
    goalValue.set(goalFragment === undefined ? undefined : `  ${palette.dim(goalFragment)}`)
    const queued = runningStatus === undefined ? undefined : formatQueuedStatus(queueCount)
    queuedValue.set(queued === undefined ? undefined : palette.dim(queued))
    // A count and no stopwatch: the count moves only when the registry says a
    // job started or settled, so the badge costs nothing between those, while a
    // ticking one would redraw the prompt row every second of a long build. The
    // durations are in `/jobs`, which is where a reader who wants them goes.
    // The fragment carries its own separator, as the left row's do: the right
    // prompt is `${queued}${jobs}`, so neither value has to know about the other.
    jobsValue.set(liveJobs === 0 ? undefined : `  ${palette.dim(plural(liveJobs, 'prompt.jobs'))}`)
    symbolValue.set(palette.bold(palette.accent('dsh')))
    // A live compaction owns the row while it runs; a flash only fills it in
    // between, so a transient confirmation can never hide ongoing work. Which
    // is why the one confirmation that belongs to the compaction — Esc asking
    // it to stop — is a phase OF the stopwatch rather than a flash under it.
    statusLine.setText(compacting !== undefined
      ? palette.dim(t(compactCancelling ? 'prompt.compactingCancelling' : 'prompt.compacting',
        { duration: formatStatusDuration(renderTime - compacting.startedAt) }))
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
        // The live appearance, not the deployment's `theme.color`: `/theme
        // no-color` rebuilds the palette into identity functions, but this
        // glyph writes its own 24-bit escape and would keep painting.
        appearance.color,
        appearance.color && resolved.theme.truecolor,
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
  ui.addChild(modeContainer)
  ui.addChild(editor)
  // The cwd/model/token/context line renders BELOW the input frame, the slot
  // Claude Code keeps it in (`PromptInputFooterLeftSide`): the input is the
  // last thing the eye hunts for, and the session vitals sit under it.
  ui.addChild(promptContext)
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
  /** Set by an open `/jobs` panel, so one re-read serves both it and the badge. */
  let refreshJobsPanel: ((rows: readonly JobRow[]) => void) | undefined
  /**
   * Re-read the visible set for both readers of it.
   *
   * The registry reports an owner whose visible set moved rather than the job
   * that moved — a removal is not expressible per job — so every listener
   * re-reads the whole set anyway; reading it once here keeps the badge and the
   * open panel from ever disagreeing about the same edge, and costs one listing
   * per change instead of one per observer. The owner argument is ignored on
   * purpose: this terminal's visible set includes every unowned job, so a
   * change to somebody else's is still a change to ours.
   */
  const readJobs = (): void => {
    if (disposed) return
    const rows = jobs?.list(agent) ?? []
    liveJobs = jobCounts(rows).live
    refreshJobsPanel?.(rows)
    requestRender()
  }
  /** The subscription held on {@link jobs}, dropped when that instance changes. */
  let disposeJobChanges = jobs?.onJobsChanged(readJobs)
  /**
   * Move the one subscription onto whichever registry answers for `jobs` now.
   *
   * Only ever called from the service-change edge below, because the row can
   * move in either direction under a composition this terminal does not
   * control: `jobs` is not in this plugin's `inject` list (a terminal with no
   * job producer is a working terminal), so nothing sequences the registry's
   * mount against this one, and a reload of the plugin that owns it replaces
   * the instance outright. Re-reading on every attach is what keeps the badge
   * and an open panel honest across the swap.
   */
  const watchJobs = (): void => {
    const registry = jobsRegistry(ctx)
    if (registry === jobs) return
    disposeJobChanges?.()
    disposeJobChanges = undefined
    jobs = registry
    if (registry !== undefined) disposeJobChanges = registry.onJobsChanged(readJobs)
    readJobs()
  }
  // Emitted by cordis whenever a service registration changes; filtering by name
  // is the whole cost of hearing about every other service in the process.
  const disposeJobsService = ctx.on('internal/service', (name: string) => {
    if (disposed) return
    if (name === 'jobs') watchJobs()
  })

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

  /**
   * Whether telling the user to run `/compact` would get them anywhere.
   *
   * The command itself is always registered — `/help` and the README table have
   * to be stable — so its presence answers nothing; what varies is whether this
   * session's preset composes a compaction service behind it. Read when the
   * warning is written rather than at mount, because `/preset` can move the
   * session onto a composition that mounts none.
   * @returns true when this agent has something to compact with.
   */
  const canCompact = (): boolean => compactionEngine() !== undefined

  /**
   * Put ONE row in the transcript the first time the window gets tight, and one
   * more the first time it gets critical.
   *
   * The prompt row already carries the live percentage; this exists because a
   * user reading a long answer is not looking at the prompt row, and because
   * `/compact` is an instruction, not a colour. `nextContextAnnouncement` owns
   * the "once per band" rule and re-arms itself when a compaction drops the
   * band, so this runs every frame and writes at most twice per cycle.
   *
   * A live standalone compaction is already the answer to this warning, so the
   * check is skipped while one runs rather than announcing a problem that is
   * being fixed — and skipped WITHOUT touching the tracker, so the drop the
   * compaction produces is what re-arms it.
   * @param pressure - the reading the prompt row was just painted from.
   */
  const announceContextPressure = (pressure: ContextPressure): void => {
    if (compacting !== undefined) return
    const announce = nextContextAnnouncement(contextAnnouncement, pressure)
    if (announce === undefined) return
    const remaining = pressure.percentRemaining
    const used = formatDiagnosticNumber(Math.round(pressure.used))
    const capacity = formatDiagnosticNumber(pressure.window)
    // Deferred for the reason `notice.markdownDegraded` is: this runs inside
    // `requestRender`, and appending a row there would mutate the container the
    // frame is walking. The tracker was already updated synchronously above, so
    // a re-entrant frame cannot queue the same row twice.
    queueMicrotask(() => {
      if (disposed) return
      // Read at write time, like `canCompact()`: the pressure that trips this
      // warning is built by an answer and its tool results, so the session is
      // usually mid-turn — and `/compact` refuses a non-idle agent. Telling a
      // user to run a command that will answer "this one is still running a
      // turn" is worse than telling them when to run it.
      const action = t(canCompact()
        ? agent.status === 'idle' ? 'notice.contextCompactAction' : 'notice.contextCompactActionAfterTurn'
        : 'notice.contextNoCompactAction')
      appendNotice(
        t(announce === 'critical' ? 'notice.contextCritical' : 'notice.contextLow',
          { remaining, used, capacity, action }),
        announce === 'critical' ? 'error' : 'warning',
      )
    })
  }

  /**
   * The two ways out of a session whose agent is gone, named by every refusal
   * that mentions it.
   *
   * A disposed agent (an agent-loop reload, a host that retired it) leaves this
   * TUI mounted over a session that can still be read and can no longer run a
   * turn. Reporting only the refusal made that a dead end: every submission
   * failed and nothing on screen said what to do about it. `/resume` swaps this
   * chat for another session without leaving the process, and the exit key ends
   * it — read from the manager, since a deployment may have moved it.
   * @returns The recovery sentence, in the active locale.
   */
  const disposedRecovery = (): string =>
    t('notice.disposedRecovery', { exit: keyLabel(keybindings, 'app.exit') })

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
   * The confirmation for one clipboard write, worded for the path it actually
   * took: on a remote host "copied" and "loaded into the tmux buffer" are
   * different things to the person reading it.
   * @param path - the route the clipboard port took this time.
   * @param count - how many characters went out.
   * @returns the line for the status row.
   */
  const clipboardConfirmation = (path: ClipboardPath, count: number): string =>
    path === 'native'
      ? t('status.flash.copied', { count })
      : t(path === 'tmux-buffer' ? 'status.flash.copiedTmux' : 'status.flash.copiedOsc52')

  /**
   * Put one answer on the system clipboard (`/copy`, `/copy N`, Ctrl+X).
   *
   * The escape sequence the clipboard port returns is written straight to the
   * terminal, outside the frame: it is an instruction to the terminal
   * emulator, not a cell the renderer owns, and a synchronized update would
   * make it part of a frame that pi-tui may redraw.
   *
   * Without an argument "nothing to copy" is a fact about the screen and is
   * flashed on the status row; with one it is a command result and stays as a
   * transcript line — a refused argument is something the user comes back to
   * read, and a flash is gone before they look.
   * @param request - which answer this invocation asks for.
   * @returns the command result; the Ctrl+X path ignores it.
   */
  const copyAnswer = (request: CopyRequest): CommandResult => {
    if (request.kind === 'invalid') {
      return { kind: 'error', text: t('copy.usage', { input: displayInlineText(request.input) }) }
    }
    const answers = collectAnswerTexts(store.getSnapshot().nodes)
    if (answers.length === 0) {
      if (request.kind === 'latest') {
        flashStatus(t('status.flash.nothingToCopy'))
        return { kind: 'success' }
      }
      return { kind: 'error', text: t('status.flash.nothingToCopy') }
    }
    const index = request.kind === 'latest' ? 0 : request.n - 1
    if (index >= answers.length) {
      return { kind: 'error', text: plural(answers.length, 'copy.outOfRange') }
    }
    const text = answers[index]!
    const path = clipboardPath()
    void copyToClipboard(text).then((sequence) => {
      if (disposed) return
      runtime.terminal.write(sequence)
      const detail = clipboardConfirmation(path, text.length)
      flashStatus(request.kind === 'latest'
        ? detail
        : t('status.flash.copiedNth', { n: index + 1, total: answers.length, detail }))
    }, (error: unknown) => {
      /* v8 ignore next 2 -- the clipboard port collapses every subprocess failure into an exit code. */
      if (!disposed) appendNotice(t('notice.copyFailed', { error: errorChain(error) }), 'error')
    })
    return { kind: 'success' }
  }

  /** The Ctrl+X entry: no argument, and no command result to report. */
  const copyLastAnswer = (): void => { void copyAnswer({ kind: 'latest' }) }

  const extensionTheme: TuiTheme = Object.freeze({
    text: (value: string) => palette.text(value),
    brand: (value: string) => appearance.color
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
      inlineFocusTarget = component
      ui.setFocus(component)
      return {
        hide(): void {
          questionContainer.clear()
          if (inlineFocusTarget === component) inlineFocusTarget = undefined
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
      appendNotice(t('notice.overlayFailed', { error: message }), 'error')
    },
  })

  const disposeTargetListeners = installModelSelection(agent.ctx, target)

  // Subagent children (tool-subagent / workflow spawns) mint their own scope
  // with no parent chain, so the agent-scoped selection above never routes
  // them, and they inherit only `AgentOptions` — which this TUI deliberately
  // leaves empty so the live default stays live (see `resolveAgentOptions`).
  // This listener is the other half of that decision: registered on the
  // UNTAGGED runner context, it hears every agent in the process, and fills a
  // resolved request that still has no route with the same selection the
  // mounted chat would run its own next step under. A route that is already
  // resolved — the mounted agent under the scoped listener above, or a child
  // started with explicit per-child options — passes through untouched.
  const disposeChildRouteFallback = ctx.on(
    'agent/request',
    async (_payload, next): Promise<LlmCallConfig> => {
      const resolved = await next()
      // The loop builds its proposal from `options.provider ?? ''`, so an
      // absent route arrives as undefined OR the empty string.
      const hasRoute = resolved.provider !== undefined && resolved.provider !== ''
        && resolved.model !== undefined && resolved.model !== ''
      if (hasRoute) return resolved
      const selected = target.current
      if (selected === undefined) return resolved
      return {
        ...resolved,
        provider: selected.provider,
        model: selected.model,
        ...resolved.reasoningEffort === undefined && selected.reasoningEffort !== undefined
          ? { reasoningEffort: selected.reasoningEffort }
          : {},
      }
    },
  )

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
  // Not wrapped in `dismissableOverlays`, unlike the two pickers above: this
  // surface holds a half-typed credential, and a notice arriving mid-paste
  // would take it down with nothing on screen to explain where the key went.
  const loginController: LoginController = createLoginController({
    ctx,
    resolved,
    palette,
    overlayManager,
    appendNotice,
    flashPending,
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
    compactCancelling = false
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
    // After `runningStatus`, which is what the hint reads for "a turn is
    // running" — the placeholder must not describe the state this call left.
    refreshEditorHint()
    requestRender()
  }

  const refreshStatus = (): void => {
    renderStatus()
  }

  /**
   * Repaint the placeholder the empty input row shows, and count the lesson it
   * teaches the first few times it teaches it.
   *
   * Three states, most specific first: a queue waiting under a running turn
   * offers the key that edits it, while the offer is still new to this user; a
   * running turn keeps the deployment's own placeholder; an idle prompt shows
   * none. `HintEditor` paints it only while the draft is empty, so a user in
   * the middle of typing is never told anything — which is also exactly when
   * the Up key means something else (see the queue branch of the input
   * listener). The running condition is the same one the queued badge uses: a
   * queue is a thing a user watches while they wait for a turn, and Up borrows
   * the key only there.
   *
   * The count is written here, where the offer is actually made, rather than
   * from whichever signal happened to fill the queue — and only for a showing
   * the user can see: `HintEditor` paints nothing over a draft being typed, so
   * a queue that arrives mid-sentence would otherwise burn a lesson that was
   * never on screen. One count per queue: {@link queueHintCounted} latches
   * until the queue drains, and it also holds the offer up for the showing that
   * reaches the limit.
   */
  const refreshEditorHint = (): void => {
    const teaching = runningStatus !== undefined
      && queueTeachable
      && queueCount > 0
      && (queueHintCounted || queueUpHintSeen < QUEUE_UP_HINT_LIMIT)
    if (teaching && !queueHintCounted && editor.getText() === '') {
      queueHintCounted = true
      queueUpHintSeen += 1
      preferences.save({ queueUpHintSeen })
    }
    editor.hint = teaching
      ? palette.dim(t('prompt.queuedEditHint'))
      : runningStatus !== undefined
        ? palette.dim(displayInlineText(resolved.theme.inputPlaceholder))
        : undefined
  }

  /**
   * Stop teaching the Up key: this user has just used it.
   *
   * A hint is a lesson, and the lesson is over the moment it is acted on —
   * counting to three would go on telling someone what they already do.
   */
  const markQueueHintLearned = (): void => {
    // Dropped as well as saturated: the latch is what keeps the current queue's
    // offer up once it has been counted, and leaving it set would go on showing
    // the hint for the rest of a queue the user is already editing — taking the
    // deployment's own placeholder with it.
    queueHintCounted = false
    if (queueUpHintSeen < QUEUE_UP_HINT_LIMIT) {
      queueUpHintSeen = QUEUE_UP_HINT_LIMIT
      preferences.save({ queueUpHintSeen })
    }
    // Repaint now rather than at the next inbox signal: the draft this key just
    // filled hides the hint anyway, and clearing that draft has to reveal the
    // placeholder the running turn would have shown.
    refreshEditorHint()
  }

  /**
   * Re-read the queue the driver will consume and repaint what counts it.
   *
   * Called from every inbox signal rather than from the submitting code paths,
   * so a prompt another host or a plugin parked in this agent's inbox is
   * counted exactly like one typed here.
   */
  const refreshQueueState = (): void => {
    queueCount = pendingUserQueue(agent.inbox).length
    // Judged here, on the signal itself, rather than in the hint: this runs
    // before `setStatus` on a status change, so a prompt sent to an idle agent
    // is still seen against the idle status it was typed at, and only a queue
    // that outlives a turn already running counts as one to teach.
    queueTeachable = queueCount > 0 && runningStatus !== undefined
    // A queue that drained is a lesson finished: the next one may be taught
    // again, up to the limit. A queue that merely grew is still the same queue.
    if (queueCount === 0) queueHintCounted = false
    refreshEditorHint()
    refreshStatus()
  }

  /** Plan mode as the last published snapshot folded it out of the session log. */
  let loggedPlanMode = false

  /**
   * The permission preset table and switch, when a deployment composes one.
   *
   * Resolved per call, not captured: `ctx.get` is a store lookup, and a service
   * that arrived or left through an HMR reload has to be seen by the next press
   * rather than by the next process.
   * @returns the service, or `undefined` when no preset table is mounted.
   */
  const permissionPresets = (): PermissionPresetSeam | undefined =>
    ctx.get('permissionPresets') as PermissionPresetSeam | undefined

  /**
   * The plan-mode service for THIS agent.
   *
   * Addressed through the preset roster first, for the same reason the skill
   * registry is: a preset composition mounts plan mode behind an `isolate`
   * realm (the shipped `standard` preset declares `isolate: { planMode: true }`),
   * which is invisible to a host context. The host lookup is the fallback for a
   * profile that mounts plan mode on the host plane instead.
   * @returns the service serving this agent now, or `undefined` when none is mounted.
   */
  const planModeService = (): PlanModeSeam | undefined => (typeof presetRoster?.serviceFor === 'function'
    ? presetRoster.serviceFor(agent, 'planMode') as PlanModeSeam | undefined
    : undefined) ?? ctx.get('planMode') as PlanModeSeam | undefined

  /**
   * Both axes as the services report them right now.
   *
   * Nothing here is remembered between calls — that is the whole point. The
   * permission axis is the service's own derivation over the session log, and
   * the plan axis is the logged fold widened by a queued selection, so a cycle
   * driven mid-turn advances instead of repeating its last transition.
   * @returns the axes {@link nextMode} decides from.
   */
  const modeAxes = (): ModeAxes => {
    const presets = permissionPresets()
    const plan = planModeService()
    const preset = typeof presets?.current === 'function' ? presets.current(agent.session.events) : undefined
    const state = typeof plan?.get === 'function' ? plan.get(agent) : undefined
    return {
      // The service's own answer wins while it is mounted — a queued selection
      // over the logged one, so a press during an open turn moves the badge and
      // the next press starts from where this one left it. The snapshot's fold
      // is the fallback for a deployment that mounts no plan mode at all, where
      // the log can still carry the state a resumed session was left in.
      planActive: typeof state?.pending === 'boolean' ? state.pending
        : typeof state?.active === 'boolean' ? state.active
          : loggedPlanMode,
      planAvailable: typeof plan?.set === 'function',
      preset: typeof preset === 'string' && preset !== '' ? preset : undefined,
      presets: Array.isArray(presets?.names) ? presets.names : [],
    }
  }

  /**
   * Whether the plan axis is a selection waiting for the next step rather than
   * the mode already in force.
   *
   * A `/plan` or a Shift+Tab during an open turn writes no `plan/mode` event
   * until the next accepted pre-step, so the service reports the queued value
   * as `pending` while `active` still says what the log folded. The badge says
   * which of the two the user is looking at, instead of promising a mode the
   * running turn is not under.
   * @returns true when a queued selection disagrees with the mode in force.
   */
  const planModePending = (): boolean => {
    const state = planModeService()?.get?.(agent)
    if (typeof state?.pending !== 'boolean') return false
    return state.pending !== (typeof state.active === 'boolean' ? state.active : loggedPlanMode)
  }

  /**
   * The hint the badges carry, naming whichever key the action resolved to.
   * @returns the parenthesised hint, or `undefined` when a deployment unbound
   * the action — a hint pointing at nothing is worse than no hint.
   */
  const modeCycleHint = (): string | undefined => {
    const keys = keybindings.getKeys('app.mode.cycle')
    return keys.length === 0 ? undefined : t('transcript.modeCycleHint', { key: keyLabel(keybindings, 'app.mode.cycle') })
  }

  /** The flash each reached mode reports itself with. */
  const MODE_FLASH: Readonly<Record<SessionMode, MessageKey>> = {
    normal: 'status.flash.modeNormal',
    'auto-accept': 'status.flash.modeAutoAccept',
    plan: 'status.flash.modePlan',
    // Reached by leaving plan mode on a preset the cycle does not own
    // (`danger-full-access`, `read-only`, a derived `custom`): the plan axis is
    // what moved, and the message says exactly that rather than naming a mode.
    other: 'status.flash.modePlanOff',
  }

  /**
   * Advance the composed mode one rung (Shift+Tab).
   *
   * The two writes are the services' own: `permissionPresets.set` records the
   * selection and moves whichever knob changed, `planMode.set` appends or queues
   * `plan/mode`. Nothing is written here, so `/permission`, `/plan`, a resumed
   * log, and this key all end up saying the same thing.
   *
   * The permission switch is deliberately the log-only `set(session, name)`
   * rather than the `/permission` command's live path: the difference is one
   * injected "the approval policy changed" user message aimed at the model, and
   * the model already reads the policy from its own prompt section on every
   * request. What the user needs to see is the badge, which this repaints.
   */
  const cycleMode = (): void => {
    const next = nextMode(modeAxes())
    if (next === undefined) {
      flashStatus(t('status.flash.modeUnavailable'))
      return
    }
    let queued = false
    try {
      if (next.preset !== undefined) permissionPresets()?.set?.(agent.session, next.preset)
      if (next.plan !== undefined) queued = planModeService()?.set?.(agent, next.plan) === 'queued'
    } catch (error) {
      // A throwing switch leaves the axes wherever it got to; the badges are
      // rebuilt from the services below, so the screen reports the real state
      // rather than the one the press aimed at.
      appendNotice(t('status.flash.modeFailed', { error: errorChain(error) }), 'error')
      applyModeBadges()
      requestRender()
      return
    }
    applyModeBadges()
    requestRender()
    flashStatus(t(queued && next.mode === 'plan' ? 'status.flash.modePlanQueued' : MODE_FLASH[next.mode]))
  }

  /**
   * Mount or drop the mode badges for the axes as they stand now.
   *
   * Rebuilt rather than toggled so the rows are painted with whatever palette
   * and scheme are current — a color-scheme change goes through here on the same
   * snapshot every other row is remounted from.
   *
   * The plan axis comes from the fold ({@link loggedPlanMode}) widened by any
   * selection queued for the next step: pressing the key mid-turn has to move
   * the badge, or the key reads as broken. The permission axis is re-derived
   * from the service on every call rather than mirrored, because `/permission`,
   * a resumed log, and another client all move it without this terminal being
   * the one that asked.
   */
  const applyModeBadges = (): void => {
    modeContainer.clear()
    const axes = modeAxes()
    const rows: ((hint: string | undefined) => string)[] = []
    if (axes.planActive) rows.push(hint => planModeRow(palette, appearance.scheme, hint, planModePending()))
    if (axes.preset === AUTO_ACCEPT_PRESET) rows.push(hint => autoAcceptRow(palette, appearance.scheme, hint))
    // Both axes can be on at once, and one key cycles both: the hint rides the
    // last badge alone, because the same `(shift+tab to cycle)` on two stacked
    // rows reads as two different keys to press.
    const hint = modeCycleHint()
    for (const [index, row] of rows.entries()) {
      modeContainer.addChild(new Text(row(index === rows.length - 1 ? hint : undefined), 0, 0))
    }
  }

  /**
   * Apply one published snapshot: the reconciler re-places the transcript, the
   * plan strip, the mode badges and header read the session aggregates.
   * This is the whole event-to-screen path — nothing else writes chat rows.
   * @param snapshot - The published snapshot.
   * @param options - `repaint` rebuilds rows that no aggregate reports moved:
   *   the mode badges hold the palette and the locale they were built under, so
   *   a theme or language change asks for them explicitly.
   */
  const applySnapshot = (snapshot: SessionSnapshot, options: { readonly repaint?: boolean } = {}): void => {
    transcript.reconcile(snapshot.nodes)
    todo.update(snapshot.todos ?? [])
    // The badge strip stays event-driven: rebuilding it here would re-derive
    // both axes from the whole session log on every published snapshot — the
    // store batches at 16 ms, so ~60 full-log folds a second while a turn
    // streams. The permission axis repaints from `PERMISSION_EVENTS`, a queued
    // plan selection from `cycleMode`, and the logged plan axis from this
    // aggregate, which is the one thing a snapshot actually reports about them.
    const planChanged = snapshot.planMode !== loggedPlanMode
    loggedPlanMode = snapshot.planMode
    if (planChanged || options.repaint === true) applyModeBadges()
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

  /**
   * Rows a question dialog may take: the configured ceiling, or whatever the
   * editor leaves when the terminal is shorter than that.
   *
   * Read per render rather than captured, because both terms move: the terminal
   * is resizable and the editor grows with the draft in it.
   * @returns the row budget, never below one.
   */
  const questionMaxHeight = (): number => Math.max(1, Math.min(
    resolved.questionDialogMaxHeight,
    runtime.terminal.rows - editorRowCount(),
  ))

  const questions = createQuestionQueue({
    ctx,
    resolved,
    palette,
    overlayManager,
    requestRender,
    isDisposed,
    questionMaxHeight,
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
   * session or opening it in another client starts from asking again — which
   * is what the row that fills it promises. The answer that outlives the
   * window is the row beneath it, and that one lands in {@link approvalRules}.
   */
  const sessionApprovals = new Set<string>()

  /**
   * Calls a stored command rule has already answered for, by call id.
   *
   * A tool that asks twice about ONE call is asking for more than it had, so
   * the second ask belongs to the user: the rule is already spent and the
   * dialog is drawn. This is the narrow half of the escalation defence — the
   * hosts this terminal drives retry a sandbox refusal as a NEW call, and what
   * stops a rule from answering that one is the access recorded in the rule
   * itself (`chat/approval-rules.ts`). Emptied with {@link inFlightToolCalls}
   * when the turn ends.
   */
  const prefixGrantedCallIds = new Set<CallId>()

  /**
   * What one pending call would do, taken from the call the session already
   * logged rather than from the approval request — which carries a tool name
   * and nothing else.
   *
   * The tool's own `presentCall` is the classifier: it is a pure function of
   * the arguments (the same property `toolCallTouchesFiles` relies on), so it
   * can be asked without running anything, a terminal card's title IS the
   * command line, and a diff card's entries ARE the pending edit — derived from
   * the arguments, so nothing here reads the disk. Reading a `command` field
   * off the arguments instead would be wrong on any tool that happens to have
   * one — `str_replace_editor` takes a `command` that is an edit verb.
   *
   * Every way this can fail — no call id, a call this terminal never saw,
   * arguments that will not parse, a tool that is gone, a presenter that
   * throws — returns nothing, and the prompt is the plain one it has always
   * been.
   * @param callId - the call being decided, when the asker named one.
   * @returns the command this call runs or the files it edits, or nothing when it is neither.
   */
  const presentApprovalCall = (
    callId: CallId | undefined,
  ): { command?: string; cwd?: string; diffs?: readonly FileDiff[] } | undefined => {
    if (callId === undefined) return undefined
    const call = inFlightToolCalls.get(callId)
    if (call === undefined) return undefined
    let args: unknown
    try {
      args = JSON.parse(call.arguments)
    } catch (_unparsableArguments: unknown) {
      return undefined
    }
    const definition = ctx.tools.get(call.name, agent)
    if (definition?.presentCall === undefined) return undefined
    try {
      const view = definition.presentCall(args)
      // The directory travels with the command. It is an argument the model
      // chose, and a rule granted here must not answer for the same words run
      // somewhere the user never opened.
      if (view?.card === 'terminal') return { command: view.title, ...view.cwd === undefined ? {} : { cwd: view.cwd } }
      if (view?.card === 'diff' && view.diffs.length > 0) return { diffs: view.diffs }
      return undefined
    } catch (_presenterFailed: unknown) {
      return undefined
    }
  }

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
    // What this ask wants beyond the tool's name: a host widens a sandbox by
    // asking again with a reason that names the mode, and a grant only ever
    // answers asks of its own kind — a rule stored while widening to
    // `workspace-write` is not an answer to a later `danger-full-access`.
    const access = escalationAccess(req.reason)
    const presented = presentApprovalCall(req.callId)
    const matchContext = {
      ...access === undefined ? {} : { access },
      ...presented?.cwd === undefined ? {} : { cwd: presented.cwd },
    }
    // A grant the user already gave answers without redrawing the prompt —
    // whether it was given a minute ago in this process or once before in this
    // project. The tool card still reports the call, so the run stays visible;
    // what is gone is the question the user already answered.
    if (sessionApprovals.has(req.toolName) || approvalRules.matchesTool(req.toolName, matchContext)) {
      return Promise.resolve<ApprovalOutcome>('allowed-once')
    }
    // A command rule answers the same way, for the one call it covers: matched
    // against what this call actually runs, where it would run it, and never
    // twice for the same call (see prefixGrantedCallIds).
    if (
      presented?.command !== undefined
      && req.callId !== undefined
      && !prefixGrantedCallIds.has(req.callId)
      && approvalRules.matchesCommand(req.toolName, presented.command, matchContext)
    ) {
      prefixGrantedCallIds.add(req.callId)
      return Promise.resolve<ApprovalOutcome>('allowed-once')
    }
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
            ...presented?.command === undefined ? {} : { command: presented.command },
            // Named only when it is somewhere else: the working directory is
            // noise on the calls that run where the session does, and the whole
            // question on the calls that do not.
            ...presented?.cwd === undefined || isInsideProject(presented.cwd, cwd)
              ? {}
              : { commandCwd: presented.cwd },
            ...presented?.diffs === undefined ? {} : { diffs: presented.diffs },
            ...access === undefined ? {} : { access },
          },
          palette,
          (decision) => {
            settle(decision.outcome)
            if (decision.outcome === 'allowed-once') {
              const grant = decision.remember
              if (grant === undefined) return
              const tool = displayText(req.toolName)
              // Said once, where the grant was made: a permission that stops
              // asking must announce its own scope, or the silence afterwards
              // reads as the tool never having needed approval at all. A
              // durable grant owes the user one thing more — the file it went
              // into, because a rule nobody can find is a rule nobody can take
              // back.
              if (grant.scope === 'session') {
                sessionApprovals.add(req.toolName)
                appendNotice(t('approval.grantedSession', { tool }))
                return
              }
              const path = approvalRules.displayPath
              // The sandbox this ask was widening to is part of the grant: it
              // is stored with the rule and said in the notice, so "don't ask
              // again" never turns out to have meant more of the machine than
              // the user was looking at.
              const scope = { tool: req.toolName, ...access === undefined ? {} : { access } }
              if (grant.prefix === undefined) {
                approvalRules.allow(scope)
                appendNotice(access === undefined
                  ? t('approval.grantedProject', { tool, path })
                  : t('approval.grantedProjectAccess', { tool, access: displayText(access), path }))
                return
              }
              approvalRules.allow({ ...scope, content: grant.prefix })
              appendNotice(t('approval.grantedPrefix', {
                rule: serializeApprovalRule({ ...scope, content: grant.prefix }),
                path,
              }))
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
          // The same budgets the overlay itself is opened with: the preview
          // compares no more than the transcript's diff cards do, and stays
          // short enough that the height below cannot clip the answers away.
          {
            maxDiffEditLength: resolved.maxDiffEditLength,
            maxHeight: resolved.questionDialogMaxHeight,
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
      loginController.clearOverlay()
      questions.unregister()
      await runtime.terminal.drainInput(100, 20)
      // The last prompt may still be in the history's write queue; wait for it,
      // but never let one stuck disk write hold the exit.
      await whenIdleOrTimeout(promptHistory.flush(), PROMPT_HISTORY_FLUSH_TIMEOUT_MS)
      // Same bargain for a permission the user just granted: the notice already
      // told them where it was stored, and another terminal holding the file's
      // lock is exactly when leaving would lose it.
      await whenIdleOrTimeout(approvalRules.flush(), APPROVAL_RULES_FLUSH_TIMEOUT_MS)
      ui.stop()
      if (exitProcess) {
        if (runtime.goodbyeMessage !== undefined) {
          runtime.terminal.write(`${palette.dim(displayText(runtime.goodbyeMessage))}\n`)
        }
        // The last thing on screen is the way back in. Printed only where the
        // session outlives the process: a composition with no persistence
        // cannot resume anything, and the line would be an instruction that
        // fails when followed.
        if (ctx.get('sessionPersistence') !== undefined) {
          const command = resumeCommandLine(agent.session.id)
          runtime.terminal.write(`${palette.dim(displayText(t('exit.resumeHint', { command })))}\n`)
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
      appendNotice(t('status.flash.cancellingBeforeExit'), 'warning')
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

  /**
   * Rebuild the palette and every theme derived from it, when the two inputs
   * that decide it — the stored `/theme` choice and the terminal's own report —
   * resolve to something other than what is on screen.
   */
  const repaint = (): void => {
    const next = resolveThemeAppearance(themePreference, reportedScheme, resolved.theme.color)
    if (next.scheme === appearance.scheme && next.color === appearance.color) return
    appearance = next
    Object.assign(palette, createPalette(next.color, next.scheme))
    Object.assign(mdTheme, markdownTheme(palette))
    // Rows cache the escapes they were built with, so every component is
    // remounted from the same nodes under the new palette.
    transcript.reset()
    applySnapshot(store.getSnapshot(), { repaint: true })
    // `setStatus` below re-derives `editor.borderColor` from the new palette.
    setStatus(agent.status)
    requestRender()
  }

  /** Record what the terminal says about itself; `auto` is what acts on it. */
  const applyColorScheme = (scheme: TerminalColorScheme): void => {
    reportedScheme = scheme
    repaint()
  }

  /**
   * Paint one theme, without saving it — the preview the selector runs on every
   * highlight move, and the path `/theme <id>` and the `/config` row commit
   * through {@link saveThemePreference}.
   */
  const applyThemePreference = (theme: ThemePreferenceId): void => {
    themePreference = theme
    repaint()
  }

  /** Paint one theme and keep it: the choice a user made outlives the process. */
  const saveThemePreference = (theme: ThemePreferenceId): void => {
    applyThemePreference(theme)
    preferences.save({ theme })
    flashStatus(t('theme.applied', { theme }))
  }

  // Apply any color scheme the terminal reports. Registering before the query
  // below means even a synchronous reply reaches `applyColorScheme`; in practice
  // the startup query's reply is the only report, since dsh-tui leaves
  // unsolicited color-scheme notifications disabled.
  const disposeSchemeListener = ui.onTerminalColorSchemeChange(applyColorScheme)

  // Ask the terminal for its color scheme via device-status report; the reply,
  // if any, arrives through the listener above. Most terminals do not respond,
  // so we keep the dark-optimised palette — and, per {@link COLOR_SCHEME_QUERY},
  // wait for the answer with no clock at all rather than with one that outlives
  // the session. Swallow a query-write failure for the same reason: a terminal
  // that will not take the question is a terminal that was not going to answer.
  try {
    runtime.terminal.write(COLOR_SCHEME_QUERY)
  } catch (_terminalWillNotTakeTheQuestion: unknown) {
    // The palette stays as resolved above.
  }

  /**
   * Move the tool-card phase, and optionally make it this user's default.
   *
   * The two callers want different reaches, which is why the write is a
   * parameter rather than a rule: Ctrl+O is a look at the conversation in front
   * of you and stays in this session, while the `/config` row is the phase
   * every future session opens on. A key that wants to write the default opts
   * in here rather than persisting behind the cycle.
   * @param next - the phase to enter.
   * @param options - `persist` writes it to the settings document as well.
   */
  const setToolsVisibility = (next: ToolCardVisibility, options?: { persist?: boolean }): void => {
    toolsVisibility = next
    // The reconciler owns card visibility, so one call re-places every card,
    // and it also owns the sentence naming what the phase leaves on screen —
    // the collapsed phase renders no context card, so it must not say it does.
    transcript.setVisibility(toolsVisibility)
    if (options?.persist === true) preferences.save({ toolCards: toolsVisibility })
    flashStatus(cardPhaseNotice(toolsVisibility))
  }

  /**
   * Choose what Enter does with a prompt typed while a turn runs.
   *
   * Unlike the tool-card phase this has no key of its own to cycle it — the
   * gesture is Ctrl+Enter, which takes the other branch for one send without
   * moving the setting — so `persist` is here for symmetry with the rows beside
   * it rather than because anything sets it without writing.
   * @param next - the behaviour to adopt.
   * @param options - `persist` writes it to the settings document as well.
   */
  const setBusyEnter = (next: BusyEnterBehavior, options?: { persist?: boolean }): void => {
    busyEnter = next
    if (options?.persist === true) preferences.save({ busyEnter })
  }

  const toggleTools = (): void => {
    // The cycle order puts the two common reading modes adjacent: preview ->
    // full detail -> conversation-only, then back to the preview default.
    setToolsVisibility(toolsVisibility === 'collapsed' ? 'expanded'
      : toolsVisibility === 'expanded' ? 'hidden' : 'collapsed')
  }

  /**
   * Show the plan's items or its one-line summary (Ctrl+N).
   *
   * The panel used to be unconditional, so a session with a long plan spent the
   * rows above the prompt on it from the moment the agent wrote one until the
   * moment it cleared it, with no key that took it back down.
   */
  const toggleTodos = (): void => {
    if (!todo.hasTodos()) {
      flashStatus(t('status.flash.planEmpty'))
      return
    }
    todo.setExpanded(!todo.isExpanded())
    todo.invalidate()
    flashStatus(t(todo.isExpanded() ? 'status.flash.planExpanded' : 'status.flash.planCollapsed'))
    requestRender()
  }

  /**
   * Keep or drop thinking blocks across the whole transcript (Ctrl+T, and the
   * `/config` panel's Thinking display row).
   *
   * Purely presentational: the model reasons whatever this says, and every
   * mounted step re-renders in place, so a running stream keeps streaming while
   * history gains or loses its asides. Independent of the Ctrl+O card cycle —
   * pinned thinking survives the hidden phase, and expanded still brings
   * thinking back on its own while the pin is off.
   * @param pinned - Whether a finished step keeps its thinking on screen.
   * @param options - `persist` writes the choice to the settings document as
   *   well, which is what `/config` means and what the key does not: Ctrl+T is
   *   "show me now", the panel row is "from now on".
   */
  const setThinking = (pinned: boolean, options?: { persist?: boolean }): void => {
    if (!reasoningEnabled) {
      // A key that does nothing at all reads as a broken key, so the refusal is
      // spoken rather than silent — and it names the setting, because that is
      // the only thing that can bring the blocks back.
      flashStatus(t('status.flash.thinkingDisabled'))
      return
    }
    thinkingPinned = pinned
    transcript.setThinkingPinned(thinkingPinned)
    if (options?.persist === true) preferences.save({ thinkingPinned })
    // `flashStatus` requests the frame, which is also the one that re-lays the
    // transcript the call above just rebuilt.
    flashStatus(t(thinkingPinned ? 'status.flash.thinkingPinned' : 'status.flash.thinkingUnpinned'))
  }

  const toggleThinking = (): void => { setThinking(!thinkingPinned) }

  /** The Ctrl+T state as the debug and status surfaces report it. */
  const thinkingStateLabel = (): string => t(!reasoningEnabled
    ? THINKING_STATE_KEYS.disabled
    : thinkingPinned ? THINKING_STATE_KEYS.pinned : THINKING_STATE_KEYS.live)

  /**
   * The theme selector `/theme` opens and the `/config` panel's Theme row
   * enters, in the editor slot like every other interactive surface.
   *
   * One selector, two doors: a value picked here is painted while the highlight
   * moves and written on Enter, so the two entries cannot drift into two
   * different vocabularies for the same four themes.
   *
   * The preview is undone from here rather than from the dialog, because the
   * dialog is not told when it goes away: the surface is `dismissable`, so a
   * permission prompt or a question arriving mid-selection takes the slot back
   * through `close()` without routing a key through `handleInput`. Restoring on
   * `closed` covers that path and the dialog's own Esc alike — the screen and
   * the stored preference cannot end up disagreeing.
   */
  let themeOverlay: TuiOverlaySession | undefined
  const showThemeSelector = (): void => {
    void themeOverlay?.close()
    const opened = themePreference
    let committed = false
    const session = overlayManager.open({
      create: () => new ThemeDialog(
        themePreference,
        palette,
        applyThemePreference,
        theme => {
          committed = true
          saveThemePreference(theme)
        },
        () => { void session.close() },
      ),
      options: { width: resolved.settingsDialogWidth },
      // A view of this screen's own settings: a permission prompt or a question
      // that arrives while it is open takes the slot back.
      dismissable: true,
    }, 'inline')
    themeOverlay = session
    void session.closed.then(() => {
      if (themeOverlay === session) themeOverlay = undefined
      // Nothing was chosen, so whatever the highlight painted on the way is not
      // a preference: put the theme the selector opened on back.
      if (!committed && themePreference !== opened) applyThemePreference(opened)
    })
    requestRender()
  }

  /**
   * `/theme [auto|light|dark|no-color]`: the selector without an argument, and
   * the named theme with one, so a user who knows what they want does not have
   * to walk a list to get it.
   * @param rawInput - everything typed after the command name.
   * @returns success, or the refusal naming the four values.
   */
  const runTheme = (rawInput: string): CommandResult => {
    const token = rawInput.trim()
    if (token === '') {
      showThemeSelector()
      return { kind: 'success' }
    }
    if (!isThemePreference(token)) {
      return {
        kind: 'error',
        text: t('theme.unknown', { value: displayInlineText(token), options: THEME_PREFERENCES.join('|') }),
      }
    }
    saveThemePreference(token)
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
  // and settings surfaces use; opening another replaces it.
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
    // `getConflicts()` compares user overrides against each other only, so a key
    // an `app.*` action takes off pi-tui is invisible to it — and invisible on
    // screen too, since the app's listener consumes the key before the editor
    // ever sees it. This is the panel that has to name that class of bug.
    const shadowed = keybindingCollisions(keybindings)
    showPanel('debug (shift+ctrl+d)', [
      `session ${displayText(agent.session.id)} · agent ${agent.status}${agentGone ? ' · detached' : ''}`,
      `events ${String(agent.session.events.length)} · context ${String(Math.round(contextTokens()))} tokens`,
      `terminal ${String(runtime.terminal.columns)}x${String(runtime.terminal.rows)} · editor ${String(editorRowCount())} rows`,
      // Both facts, because `auto` is the default and a forced theme is exactly
      // the kind of thing a "the colors are wrong" report never mentions.
      `theme ${themePreference} · painting ${appearance.scheme}${appearance.color ? '' : ' · no color'} · terminal reports ${reportedScheme}`,
      `cards ${toolsVisibility} · thinking ${thinkingStateLabel()} · plan ${todo.isExpanded() ? 'expanded' : 'collapsed'}`,
      // Both numbers, because they answer different questions and disagreeing
      // is itself the bug: the map is what a cancel would hand back, the queue
      // is what the driver will actually claim (including foreign inserts).
      `overlay ${overlayManager.hasActiveOverlay() ? 'active' : 'none'} · pending steering ${
        String(pendingSteering.size)} · inbox queue ${String(queueCount)}`,
      `locale ${currentLocale()} · preference stored in ${localeStore.origin}`,
      '',
      ...Object.keys(APP_KEYBINDINGS).map(action => `${action} → ${keyLabel(keybindings, action as AppKeybinding)}`),
      ...conflicts.length === 0
        ? []
        : ['', ...conflicts.map(conflict => `conflict: ${conflict.key} claimed by ${conflict.keybindings.join(', ')}`)],
      ...shadowed.length === 0
        ? []
        : ['', ...shadowed.map(hit => `shadows pi-tui: ${hit.key} (${hit.action}) hides ${hit.shadowed.join(', ')}`)],
    ].map(line => palette.dim(line)))
  }
  // pi-tui hands this key over before focus is resolved, so it works with a
  // panel or a dialog open; nothing else in this UI claims it.
  ui.onDebug = showDebug

  const showHelp = (): void => {
    const commandLines = ctx.commands.list(agent).map((command) => {
      const input = command.input === undefined ? '' : ` ${command.input.hint}`
      return `/${command.name}${input} — ${commandDescription(command.name, command.description)}`
    })
    showPanel('/help', [
      ...keyboardShortcuts(keybindings),
      '',
      ...commandLines,
      t('help.skill'),
    ].map(line => palette.dim(line)))
  }

  const showPalette = (): void => {
    showPanel('/palette', renderPalette(palette, appearance.scheme, appearance.color))
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

  /**
   * Search this session's own messages (`/search`, the transcript-search key).
   *
   * The entries are flattened from the store's current snapshot rather than
   * kept as an index: the panel is opened by a keypress, the snapshot it reads
   * is the one on screen, and an index maintained beside the fold would be one
   * more thing that can disagree with the transcript. A session with nothing to
   * search still opens the panel, which says so — a keypress that appears to do
   * nothing teaches the wrong thing about the key.
   * @param query - the `/search` argument, prefilled into the panel's query box.
   */
  const showTranscriptSearch = (query: string): void => {
    const entries = transcriptEntries(store.getSnapshot().nodes)
    void panelOverlay?.close()
    const session = overlayManager.open({
      create: () => new TranscriptSearchPanel(
        entries,
        query,
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

  /**
   * The `/config` rows, rebuilt per open so a value changed elsewhere — Ctrl+O,
   * `/theme`, `/model` — is the value the panel shows.
   *
   * Deliberately short. This is the terminal's own presentation, not the
   * harness's configuration: everything a deployment sets in `cordis.yml` and
   * everything a session decides through its own command stays where it is, and
   * a row that another command owns says so rather than growing a second way to
   * set it.
   * @returns the entries in display order.
   */
  const settingsEntries = (): SettingsEntry[] => [
    {
      kind: 'toggle',
      label: t('settings.thinking'),
      // The same pin Ctrl+T flips, read live: a key pressed behind this panel
      // shows up on the row that names it.
      value: () => thinkingPinned,
      // Written, not just applied: this row is the answer to "do I want to read
      // the model's reasoning", which is a preference, not a per-session look.
      set: next => { setThinking(next, { persist: true }); requestRender() },
    },
    {
      kind: 'choice',
      label: t('settings.toolCards'),
      options: TOOL_CARD_PHASES,
      value: () => toolsVisibility,
      // The ids are internal: nothing takes `collapsed` as an argument, and the
      // same three states are already worded in the flash row, so a `/config`
      // that printed them raw was the one untranslated cell on the panel.
      format: phase => t(`settings.toolCards.${phase as ToolCardVisibility}`),
      set: (next) => {
        /* v8 ignore next -- the options are TOOL_CARD_PHASES, so every value is one. */
        if (next !== 'collapsed' && next !== 'expanded' && next !== 'hidden') return
        setToolsVisibility(next, { persist: true })
        requestRender()
      },
    },
    {
      kind: 'choice',
      label: t('settings.busyEnter'),
      options: BUSY_ENTER_BEHAVIORS,
      value: () => busyEnter,
      // Same reason as the row above: `steer` and `queue` are the ids the
      // document stores, and the panel is prose.
      format: behavior => t(`settings.busyEnter.${behavior as BusyEnterBehavior}`),
      set: (next) => {
        /* v8 ignore next -- the options are BUSY_ENTER_BEHAVIORS, so every value is one. */
        if (next !== 'steer' && next !== 'queue') return
        setBusyEnter(next, { persist: true })
        requestRender()
      },
    },
    {
      kind: 'submenu',
      label: t('settings.theme'),
      value: () => themePreference,
      // The selector replaces this panel in the one inline slot; closing it
      // returns to the conversation, not to the panel, which is what every
      // other surface here does with the slot it took.
      open: showThemeSelector,
    },
    {
      kind: 'notice',
      label: t('settings.language'),
      // Read live from the message layer, so a `/lang` switch made behind this
      // panel is the language this row names — and the row stays a readout,
      // because `/lang` owns the list of languages and the way it is stored.
      value: () => localeName(currentLocale()),
      hint: '(/lang)',
    },
    {
      kind: 'notice',
      label: t('settings.model'),
      value: () => target.current === undefined ? t('settings.model.unset') : targetLabel(target.current),
      hint: '(/model)',
    },
  ]

  /**
   * The settings panel, in the same inline slot every other panel takes.
   *
   * Changes apply as they are made — there is no OK button, because there is
   * nothing to confirm: each row is one value, already live on the screen
   * behind the panel, and already written.
   */
  const showSettings = (): void => {
    void panelOverlay?.close()
    const session = overlayManager.open({
      create: () => new SettingsPanel(
        settingsEntries(),
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

  /**
   * The skill catalog behind `/skills`, scanned per open.
   *
   * Every read goes through {@link skillRegistry}, so the panel lists what this
   * agent composes right now — a `/preset` switch changes the answer, and a
   * catalog captured at mount would name skills `/skill:` refuses. Both the
   * listing and one skill's body are provider reads that can be slow or fail:
   * the panel opens first and is filled as they land, and a body that arrives
   * after its overlay closed is dropped by the aborted scan.
   */
  const showSkills = (): void => {
    const registry = skillRegistry()
    if (registry === undefined) {
      appendNotice(t('skills.unavailable'), 'warning')
      return
    }
    void panelOverlay?.close()
    const scan = new AbortController()
    // The overlay's slot can still be held by a closing predecessor, so `create`
    // runs late; a catalog that settled before then is handed to the
    // constructor instead of stranding the panel on its loading line.
    let panel: SkillsPanel | undefined
    let scanned: readonly SkillSummary[] | undefined
    const lookup = (): SkillViewOptions => ({ cwd, scope: agent, signal: scan.signal })
    const session = overlayManager.open({
      create: () => {
        panel = new SkillsPanel(
          scanned,
          panelRows,
          palette,
          (name) => {
            void registry.get(name, lookup()).then(
              (skill) => {
                if (disposed || scan.signal.aborted) return
                panel?.setDetail(name, skill === undefined
                  ? { kind: 'failed', message: t('skills.unknown', { name }) }
                  : { kind: 'ready', skill })
                requestRender()
              },
              (error: unknown) => {
                if (disposed || scan.signal.aborted) return
                panel?.setDetail(name, {
                  kind: 'failed',
                  message: t('skills.loadFailed', { name, error: errorChain(error) }),
                })
                requestRender()
              },
            )
          },
          () => { void session.close() },
        )
        return panel
      },
      // A catalog the user reads, like `/plugins`: an arriving permission
      // prompt or question takes the slot rather than queueing behind it.
      dismissable: true,
    }, 'inline')
    panelOverlay = session
    void session.closed.then(() => {
      // A closed panel's provider reads are nobody's answer any more.
      scan.abort()
      if (panelOverlay === session) panelOverlay = undefined
    })
    requestRender()
    void registry.list(lookup()).then(
      (summaries) => {
        if (disposed || scan.signal.aborted) return
        // Alphabetical, like the Web skill list and Claude Code's own menu:
        // registry order is provider-registration order, which reads as random.
        scanned = [...summaries].sort((a, b) => a.name.localeCompare(b.name))
        panel?.setSkills(scanned)
        requestRender()
      },
      (error: unknown) => {
        if (disposed || scan.signal.aborted) return
        void session.close()
        appendNotice(t('skills.scanFailed', { error: errorChain(error) }), 'error')
      },
    )
  }

  /**
   * `/subagents`: the delegation tree below this session.
   *
   * One `listDescendants()` read fills the whole panel — a terminal shows the
   * tree at once rather than expanding it a level at a time, so there is no
   * per-parent lazy read to keep track of. The listing merges the live store
   * with persistence and resolves each child's identity through the `subagent`
   * projection, which is why the panel says nothing the events alone could not
   * have proven wrong: `subagent/start` and `subagent/end` carry no label, no
   * mode, and no parent, so they are used only as the edge that makes the
   * current listing stale.
   *
   * The two edges are debounced together. A workflow that fans out spawns a
   * burst of starts, and one directory read per child would be one persistence
   * pass per child for a tree that is going to be re-read anyway.
   */
  const showSubagents = (): void => {
    const directory = subagentDirectory(ctx)
    if (directory === undefined) {
      appendNotice(t('subagents.unavailable'), 'warning')
      return
    }
    void panelOverlay?.close()
    const scan = new AbortController()
    // The overlay's slot can still be held by a closing predecessor, so `create`
    // runs late; a listing that settled before then is handed to the constructor
    // instead of stranding the panel on its loading line.
    let panel: SubagentsPanel | undefined
    let scanned: readonly SubagentDescendant[] | undefined
    /** Reads issued, and the newest one that has already answered the panel. */
    let issued = 0
    let answered = 0
    /**
     * One directory read, which writes only if it is still the newest answer.
     *
     * The debounce below coalesces the *starts* of a burst, not the listings
     * already in flight: a read outlives its window whenever persistence has a
     * cold subtree to inspect, so two reads overlap and the slower one settles
     * last. Without this guard the older listing — enumerated before the child
     * that triggered the newer read even existed — would overwrite the fresher
     * tree, and a slow failure would pin an error banner over a tree that was
     * in fact read successfully. Both states then survive until the next
     * delegation edge, which for a run whose members have all started may be
     * the end of the run.
     */
    const read = (): void => {
      issued += 1
      const seq = issued
      const current = (): boolean => !disposed && !scan.signal.aborted && seq > answered
      void directory.listDescendants(agent.session.id, scan.signal).then(
        (entries) => {
          if (!current()) return
          answered = seq
          scanned = [...entries]
          panel?.setEntries(scanned)
          requestRender()
        },
        (error: unknown) => {
          if (!current()) return
          answered = seq
          // Reported inside the panel rather than as a notice: a directory that
          // will not answer is this view's own state, and a refresh that fails
          // must not close a tree the reader is still looking at.
          panel?.setError(t('subagents.loadFailed', { error: errorChain(error) }))
          requestRender()
        },
      )
    }
    const session = overlayManager.open({
      create: () => {
        panel = new SubagentsPanel(scanned, panelRows, palette, () => { void session.close() })
        return panel
      },
      // A tree the user reads, like `/skills`: an arriving permission prompt or
      // question takes the slot rather than queueing behind it.
      dismissable: true,
    }, 'inline')
    panelOverlay = session
    let refreshTimer: ReturnType<typeof setTimeout> | undefined
    const refresh = (): void => {
      if (refreshTimer !== undefined || scan.signal.aborted) return
      refreshTimer = setTimeout(() => {
        refreshTimer = undefined
        if (disposed || scan.signal.aborted) return
        read()
      }, SUBAGENT_REFRESH_DEBOUNCE_MS)
    }
    // Registered on the untagged runner context, which hears every delegation in
    // the process rather than only this agent's own — the same reason the child
    // route fallback above is registered there.
    const disposeSubagentStart = ctx.on('subagent/start', refresh)
    const disposeSubagentEnd = ctx.on('subagent/end', refresh)
    void session.closed.then(() => {
      // A closed panel's directory reads are nobody's answer any more, and its
      // invalidation edges have nothing left to invalidate.
      scan.abort()
      disposeSubagentStart()
      disposeSubagentEnd()
      if (refreshTimer !== undefined) clearTimeout(refreshTimer)
      refreshTimer = undefined
      if (panelOverlay === session) panelOverlay = undefined
    })
    requestRender()
    read()
  }

  /**
   * The two counts the `/status` Subagents row states.
   *
   * `undefined` on both absences the row must not invent a number for: a
   * profile that mounts no registry, and a listing that failed. `/status` is a
   * diagnostic panel, so one unreadable directory drops its row rather than
   * failing the command that was asked for everything else.
   * @param signal - the command's own cancellation.
   * @returns the running and total counts, or `undefined`.
   */
  const readSubagentCounts = async (signal: AbortSignal): Promise<SubagentCounts | undefined> => {
    const directory = subagentDirectory(ctx)
    if (directory === undefined) return undefined
    return directory.listDescendants(agent.session.id, signal).then(
      subagentCounts,
      () => undefined,
    )
  }

  /**
   * `/jobs`: the background work this session can still see.
   *
   * The registry lives in this process, so the panel is filled synchronously
   * from the first frame — there is no loading line to show and no read that
   * can fail. What it does own is a clock: a live row's elapsed time has to
   * move while the rest of the screen holds still, so the panel repaints on a
   * timer that exists only while it is open and something is actually running.
   * A settled list schedules nothing.
   *
   * The list itself is refreshed from the terminal's one registry subscription
   * rather than a second one of its own, so the badge on the prompt row and the
   * rows in the panel are always the same reading.
   * @param registry - the registry the command resolved before opening.
   */
  const showJobs = (registry: JobsRegistry): void => {
    void panelOverlay?.close()
    let panel: JobsPanel | undefined
    let ticker: ReturnType<typeof setInterval> | undefined
    let rows = sortJobRows(registry.list(agent))
    const stopTicking = (): void => {
      if (ticker === undefined) return
      clearInterval(ticker)
      ticker = undefined
    }
    // Started and stopped by what is on screen, not by what the registry holds:
    // a list of finished jobs is a still picture, and repainting it once a
    // second would spend a frame a second saying nothing.
    const retime = (): void => {
      const live = rows.some(row => row.status === 'running' || row.status === 'stopping')
      if (!live) {
        stopTicking()
        return
      }
      if (ticker !== undefined) return
      ticker = setInterval(() => {
        if (disposed) return
        panel?.invalidate()
        requestRender()
      }, JOBS_ELAPSED_TICK_MS)
      // Never a reason to hold the process open: the clock is only a repaint.
      ticker.unref()
    }
    const session = overlayManager.open({
      create: () => {
        panel = new JobsPanel(rows, panelRows, palette, now, () => { void session.close() })
        return panel
      },
      // A list the user reads, like `/skills`: an arriving permission prompt or
      // question takes the slot rather than queueing behind it.
      dismissable: true,
    }, 'inline')
    panelOverlay = session
    const refresh = (changed: readonly JobRow[]): void => {
      rows = sortJobRows(changed)
      panel?.setJobs(rows)
      retime()
    }
    refreshJobsPanel = refresh
    void session.closed.then(() => {
      // A closed panel has no clock to move and no rows to refresh; the
      // registry subscription itself belongs to the terminal, not to this view.
      // The hook is cleared by identity, the way the overlay slot is: a second
      // `/jobs` closes the first one, and that close lands after the second
      // panel has already registered itself.
      stopTicking()
      if (refreshJobsPanel === refresh) refreshJobsPanel = undefined
      if (panelOverlay === session) panelOverlay = undefined
    })
    retime()
    requestRender()
  }

  /**
   * The MCP inventory, folded out of the tool names this agent can see.
   *
   * The registry view is read directly rather than through the system prompt
   * assembly `/status` uses: the assembly runs every prompt section to get the
   * same names, and this panel needs nothing else from it. `schemas` is the
   * scoped view, so a preset that restricts a server's tools away reports what
   * this agent may actually call rather than what the process registered.
   */
  const showMcp = (): void => {
    const names = agent.ctx.tools.schemas(agent).map(tool => tool.name)
    showPanel('/mcp', [...renderMcpPanel(names, palette)])
  }

  /**
   * Environment self-check (`/doctor`): what this session is running ON.
   *
   * Every input is read here and handed over as a value, so the checks stay a
   * pure function of the environment they describe. The one asynchronous check
   * is the route resolution, which is the only thing that proves an adapter
   * answers for the selected model rather than merely being registered.
   */
  const showDoctor = async (): Promise<void> => {
    // Resolving a route can wait on an adapter that is still coming up; without
    // the hint the screen looks like `/doctor` never landed.
    const settleHint = flashPending(t('doctor.flash.running'))
    const checks = await runDoctorChecks({
      nodeVersion: process.version,
      stdinTty: process.stdin.isTTY === true,
      stdoutTty: process.stdout.isTTY === true,
      columns: runtime.terminal.columns,
      rows: runtime.terminal.rows,
      // The resolved appearance, not the deployment's setting: `/theme
      // no-color` is now the main way color gets turned off, and a check that
      // read `theme.color` reported a palette the screen no longer paints.
      color: appearance.color,
      truecolor: appearance.color && resolved.theme.truecolor,
      providers: ctx.llm.listProviders().map(provider => provider.id),
      route: target.current,
      resolveModelInfo: (provider, model) => ctx.llm.resolveModelInfo(provider, model),
      persistence: ctx.get('sessionPersistence') !== undefined,
      presets: ctx.get('agentPresets') !== undefined,
      preset: presetController.currentPreset(),
    }).finally(settleHint)
    /* v8 ignore next -- disposal during the awaited resolution is covered by command-owner teardown tests. */
    if (disposed) return
    showPanel('/doctor', [...renderDoctorPanel(checks, palette)])
  }

  const showStatus = async (signal: AbortSignal): Promise<void> => {
    // Assembling the system prompt runs every registered section, some of which
    // read files or ask a service; on a cold cache that is long enough for the
    // screen to look like `/status` never landed.
    const settleHint = flashPending(t('status.flash.collecting'))
    // Read alongside the prompt rather than after it: the delegation tree is
    // another session-scoped read under the same signal, and the panel should
    // wait for the pair once instead of twice in a row.
    const [assembly, subagents] = await Promise.all([
      ctx.systemPrompt.assemble(assembleContextFor(agent, signal)),
      readSubagentCounts(signal),
    ]).finally(settleHint)
    /* v8 ignore next -- disposal during the awaited assembly is covered by command-owner teardown tests. */
    if (disposed) return
    /* v8 ignore next -- SystemPrompt always emits at least its required base section. */
    const systemPrompt = displayText(renderPrompt(assembly)) || '(empty)'
    const registeredTools = assembly.tools.map(tool => displayText(tool.name)).join(', ') || '(none)'
    const events = agent.session.events
    const latestActivity = lastActivityTime(agent.session) ?? agent.session.header.createdAt
    const usedContext = Math.max(0, Math.round(contextTokens()))
    let context = t('status.contextUnknown', { used: formatDiagnosticNumber(usedContext) })
    // The same reading the prompt row is painted from, so the panel and the row
    // can never disagree about how full the window is. The meter keeps its own
    // neutral colouring: it also serves the cache-hit row, where high is good.
    const pressure = contextPressure(usedContext, modelController.contextWindow())
    if (pressure !== undefined) {
      context = t('status.contextValue', {
        meter: diagnosticMeter(pressure.percentUsed, palette),
        percent: pressure.percentUsed,
        used: formatDiagnosticNumber(pressure.used),
        capacity: formatDiagnosticNumber(pressure.window),
      })
    }
    const rate = cacheHitRate(tokens)
    const turns = events.filter(event => event.type === 'turn/start').length
    const steps = events.filter(event => event.type === 'step/start').length
    const toolCalls = events.filter(event => event.type === 'tool/call').length
    // The same words `/config` uses for the same two states: a card whose
    // labels are translated and whose values are not reads as half a card.
    const model = target.current === undefined
      ? t('settings.model.unset')
      : displayText(targetLabel(target.current))
    const effort = target.current === undefined
      ? t('settings.model.unset')
      : target.current.reasoningEffort === undefined
        ? t('status.effort.default')
        : displayText(target.current.reasoningEffort)
    // Whole-log figures the in-memory counts above cannot give: `sessionStats`
    // folds every turn, step, and wall time from the durable log, so paging and
    // compaction cannot move them. The unit is a deployment choice, so its row
    // is present only when the projection is.
    const stats = ctx.get('sessionProjections')?.snapshot(agent.session).values.sessionStats
    // What this session left running in the background. A synchronous read of
    // an in-process registry, so it needs no place in the awaited pair above;
    // absent only when the profile mounts no registry, in which case the row is
    // left out rather than reporting a zero this terminal never looked for.
    const backgroundJobs = jobsRegistry(ctx)?.list(agent)
    // What every tool call in this session is decided under. Present only when
    // a permission service reports it, so a deployment without one says nothing
    // rather than implying a policy it does not enforce.
    //
    // The preset table's own name comes first when a table is mounted: it is
    // the vocabulary `/permission`, the mode badge, and Shift+Tab all speak, and
    // a row that answered `never` while the badge said `auto-accept` would make
    // the user look for a second switch. The bare approval policy is the answer
    // for a deployment that composes the approval seam and no preset table.
    const preset = modeAxes().preset ?? approvalPreset(ctx, agent.session)
    // Which composition this session's tools, prompt sections, and skills come
    // from. Present only when the deployment composes a roster, for the same
    // reason the Permission row is: naming a preset in a profile that mounts
    // none would describe a layer that is not there.
    const agentPreset = presetController.currentPreset()
    const groups: readonly (readonly StatusCardRow[])[] = [
      [
        [t('status.row.session'), displayText(agent.session.id)],
        [t('status.row.title'), displayText(sessionTitle ?? t('status.untitled'))],
        [t('status.row.directory'), displayText(cwd)],
        [t('status.row.model'), `${model} ${palette.dim(t('status.modelDetail', {
          effort,
          // The Ctrl+T state, not a shown/hidden pair: this row answers for the
          // same switch the key and the `/config` panel's row drive.
          thinking: thinkingStateLabel(),
        }))}`],
        ...agentPreset === undefined ? [] : [[t('status.row.preset'), displayText(agentPreset)] as StatusCardRow],
        ...preset === undefined ? [] : [[t('status.row.permission'), displayText(preset)] as StatusCardRow],
        ...goalStatusRows(goalState.goal, goalState.roundsStarted),
      ],
      [
        [t('status.row.agent'), [
          agent.status,
          formatDiagnosticCount(events.length, 'status.count.event'),
          formatDiagnosticCount(turns, 'status.count.turn'),
          formatDiagnosticCount(steps, 'status.count.step'),
          formatDiagnosticCount(toolCalls, 'status.count.toolCall'),
        ].join(' · ')],
        ...stats === undefined
          ? []
          : [[t('status.row.sessionTotals'), formatSessionStats(stats)] as StatusCardRow],
        // What this session delegated. Present only when a subagent registry
        // answered: a profile that mounts none, and a directory that could not
        // be read, both leave the row out rather than reporting zero children
        // this terminal never actually looked for.
        ...subagents === undefined
          ? []
          : [[t('status.row.subagents'), t('status.subagentsValue', { ...subagents })] as StatusCardRow],
        ...backgroundJobs === undefined
          ? []
          : [[t('status.row.jobs'), t('status.jobsValue', { ...jobCounts(backgroundJobs) })] as StatusCardRow],
      ],
      [
        [t('status.row.tokens'), t('status.tokensValue', {
          input: formatDiagnosticNumber(tokens.input),
          output: formatDiagnosticNumber(tokens.output),
        })],
        [t('status.row.kvCache'), rate === undefined
          ? t('status.cacheUnavailable', {
            read: formatDiagnosticNumber(tokens.cacheRead),
            write: formatDiagnosticNumber(tokens.cacheWrite),
          })
          : t('status.cacheValue', {
            meter: diagnosticMeter(rate, palette),
            rate,
            read: formatDiagnosticNumber(tokens.cacheRead),
            write: formatDiagnosticNumber(tokens.cacheWrite),
          })],
        [t('status.row.context'), context],
      ],
      [
        [t('status.row.created'), formatDiagnosticTime(agent.session.header.createdAt)],
        [t('status.row.active'), formatDiagnosticTime(latestActivity)],
      ],
    ]
    // The queue as it stands when the panel opens: prompts claimed while the
    // system prompt was being assembled are gone, and listing them would be
    // listing work the driver already took. Numbered in claim order, one line
    // each — the transcript above already shows every one of them in full.
    const queue = pendingUserQueue(agent.inbox)
    // The card renders itself once, at the panel's own content width; the panel
    // scrolls those rows rather than re-deriving them per frame.
    const cardWidth = Math.max(8, runtime.terminal.columns - 2)
    showPanel('/status', [
      ...new StatusCardComponent(groups, palette).render(cardWidth),
      ...queue.length === 0 ? [] : [
        '',
        palette.bold(palette.accent(t('status.queued'))),
        ...queue.map((item, index) => `${String(index + 1)}. ${
          palette.dim(`[${t(item.placement === 'steering' ? 'status.queued.steering' : 'status.queued.nextTurn')}]`)
        } ${displayInlineText(queueItemPreview(item.message))}`),
      ],
      '',
      palette.bold(palette.accent(t('status.systemPrompt'))),
      ...systemPrompt.split('\n'),
      '',
      palette.bold(palette.accent(t('status.registeredTools'))),
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
   * exist in THIS session, so `/model `, `/preset `, `/theme `, `/login `,
   * `/copy `, and `/resume ` offer the same rows their pickers would — and
   * `/export ` names the one value of its own that is not a path. Optional services are
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
      case 'theme':
        return themeArgumentCompletions
      case 'lang':
        return langArgumentCompletions
      case 'login':
        // Read per keystroke rather than captured: a route added by
        // `/provider add` in this same session must be offerable immediately,
        // and the roster is assembled from settings already in memory.
        return prefix => loginArgumentCompletions(
          readProviderRoster(ctx),
          prefix,
          resolved.maxModelOptions,
        )
      case 'provider':
        return providerArgumentCompletions
      case 'copy':
        // The snapshot is read per keystroke: an answer that just landed has to
        // be countable immediately.
        return prefix => copyArgumentCompletions(
          collectAnswerTexts(store.getSnapshot().nodes),
          prefix,
          resolved.maxModelOptions,
        )
      case 'export':
        return exportArgumentCompletions
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
            description: commandDescription(command.name, command.description),
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

  /**
   * Repaint everything after a language switch.
   *
   * The same rebuild a color-scheme change does, and for the same reason:
   * transcript rows cache the strings they were built with, so a component that
   * is already mounted keeps rendering the previous language until it is
   * remounted from its node. The slash menu is rebuilt too, because its
   * descriptions are translated on the way into it.
   */
  const disposeLocaleChanges = onLocaleChange(() => {
    if (disposed) return
    transcript.reset()
    applySnapshot(store.getSnapshot(), { repaint: true })
    refreshCommandAutocomplete()
    requestRender()
  })

  const refreshSkillCommands = (): void => {
    const scan = ++skillCommandScan
    const service = skillRegistry()
    if (service === undefined) return
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
  const disposeSkillChanges = skillsAvailable
    ? ctx.on('skills/change', () => { refreshSkillCommands() })
    : () => {}
  if (skillsAvailable) refreshSkillCommands()

  /**
   * Put a yes/no decision to the user on the same surface a model's question
   * uses, and answer it.
   *
   * The question dialog is reused rather than a confirmation widget of its own:
   * a user who has answered one option list in this terminal knows this one, and
   * the two would otherwise diverge on navigation, cancelling, and width. Every
   * way out that is not the affirmative option — Esc, a closed overlay, a
   * disposed terminal — answers no, because these prompts guard destructive
   * work and silence must never mean "go ahead".
   * @param question - the decision, phrased as a question.
   * @param confirmLabel - the option that means yes; every other answer means no.
   * @param declineLabel - the option that means no, offered so cancelling is not the only refusal.
   * @returns whether the user chose the affirmative option.
   */
  const askConfirmation = (
    question: string,
    confirmLabel: string,
    declineLabel: string,
  ): Promise<boolean> => {
    if (disposed) return Promise.resolve(false)
    return new Promise<boolean>((resolveAnswer) => {
      let settled = false
      const settle = (answer: boolean): void => {
        if (settled) return
        settled = true
        resolveAnswer(answer)
      }
      const session = overlayManager.open({
        create: () => new QuestionDialog(
          {
            id: 'tui-confirm',
            question,
            options: [{ label: confirmLabel }, { label: declineLabel }],
          },
          1,
          1,
          1,
          resolved.maxQuestionOptions,
          questionMaxHeight,
          palette,
          (selection) => {
            void session.close()
            settle(selection.selected.includes(confirmLabel))
          },
          () => {
            void session.close()
            settle(false)
          },
        ),
        options: {
          width: resolved.questionDialogWidth,
          maxHeight: resolved.questionDialogMaxHeight,
        },
      }, 'inline')
      // A terminal torn down under an open confirmation closes the overlay
      // without answering it; the awaiting caller still has to be released.
      void session.closed.then(() => { settle(false) })
      requestRender()
    })
  }

  /**
   * Put this session on the clipboard as Markdown (`/export clipboard`).
   *
   * The content comes from the store's snapshot rather than the JSONL on disk:
   * the log is written for a machine to read back, while what goes on the
   * clipboard is pasted into another window for a person. The entries are
   * `/search`'s own, so "what was exported" and "what is findable" are always
   * the same session.
   * @param signal - cancellation owned by the dispatching UI.
   * @returns a success result naming how many entries went out, whether the
   *   document had to be cut to fit one OSC 52 write, and which clipboard path
   *   carried them.
   */
  const exportSessionMarkdown = async (signal: AbortSignal): Promise<CommandResult> => {
    const snapshot = store.getSnapshot()
    const entries = transcriptEntries(snapshot.nodes)
    if (entries.length === 0) return { kind: 'error', text: t('export.clipboard.empty') }
    const path = clipboardPath()
    const markdown = renderSessionMarkdown(entries, {
      sessionId: agent.session.id,
      ...snapshot.title === undefined ? {} : { title: snapshot.title },
      ...agent.session.header.cwd === undefined ? {} : { cwd: agent.session.header.cwd },
      ...snapshot.model === undefined ? {} : { model: snapshot.model },
      exportedAt: now(),
    })
    // The budget belongs to the escape sequence, not to the export: only OSC 52
    // puts the whole document into a single terminal write, where a session long
    // enough to overrun the terminal's ceiling is dropped in silence. The native
    // utilities and `tmux load-buffer` are fed through a pipe with no per-write
    // limit, so clipping there would throw away text the clipboard would have
    // taken whole.
    const document = path === 'osc52'
      ? clipSessionMarkdown(markdown)
      : { text: markdown, truncated: false }
    try {
      // Checked once, before the write: the clipboard port's subprocess has a
      // deadline of its own and no cancellation entry, so a signal threaded
      // into it would only be decoration.
      signal.throwIfAborted()
      const sequence = await copyToClipboard(document.text)
      if (!disposed) runtime.terminal.write(sequence)
      return {
        kind: 'success',
        text: plural(
          entries.length,
          document.truncated ? 'export.clipboard.truncated' : 'export.clipboard.done',
          {
            detail: clipboardConfirmation(path, document.text.length),
            limit: MARKDOWN_MAX_CHARS,
          },
        ),
      }
    } catch (error: unknown) {
      return { kind: 'error', text: t('notice.copyFailed', { error: errorChain(error) }) }
    }
  }

  /**
   * Start over in a blank session (`/new`), leaving this one resumable.
   *
   * Deliberately not called "clear": nothing below this UI can truncate a
   * session log, so the only honest way to start with an empty context is a new
   * session, and the one being left is flushed and kept rather than emptied. A
   * host that cannot replace the mounted agent says so instead of clearing the
   * screen and leaving the model's context exactly as full as it was.
   * @returns the command result the notice column reports.
   */
  const startNewSession = (): CommandResult => {
    const start = runtime.handoffNew
    if (start === undefined) {
      return {
        kind: 'error',
        text: t('notice.newSessionUnsupported'),
      }
    }
    // Idle-only, as `/resume` is: a running turn is writing to the log this
    // teardown releases, and its tools are mid-call.
    if (agent.status !== 'idle') {
      return { kind: 'error', text: t('notice.newSessionBusy', { status: agent.status }) }
    }
    appendNotice(t('notice.newSession'))
    void start().catch((error: unknown) => {
      /* v8 ignore next -- a handoff that fails after teardown has no screen left to report on. */
      if (!disposed) appendNotice(t('notice.newSessionFailed', { error: errorChain(error) }), 'error')
    })
    return { kind: 'success' }
  }

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
      name: 'login',
      // Named for the thing being signed in to, not for the field being
      // written: the key lands in the credential store and only its variable
      // name reaches settings, which is not what "set an API key" would say.
      description: 'Give a provider an API key and store it',
      input: { hint: '[provider]' },
      handler: ({ rawInput }) => {
        loginController.queueLoginCommand(rawInput)
        return { kind: 'success' }
      },
    })
    commandCtx.commands.register({
      name: 'provider',
      description: 'List configured providers, or add one /login does not offer',
      input: { hint: '[add]' },
      handler: ({ rawInput }) => {
        loginController.queueProviderCommand(rawInput)
        return { kind: 'success' }
      },
    })
    commandCtx.commands.register({
      name: 'copy',
      // Numbered from the last answer backwards: `/copy` and `/copy 1` are the
      // same answer, `/copy 2` is the one before it.
      description: 'Copy an answer to the system clipboard (the last one, or /copy N for the Nth-latest)',
      input: { hint: '[N]' },
      handler: ({ rawInput }) => copyAnswer(parseCopyArgument(rawInput)),
    })
    commandCtx.commands.register({
      name: 'editor',
      // The entry that does not depend on a terminal being able to send Alt.
      description: 'Edit the current prompt in $EDITOR',
      handler: () => { void openExternalEditor(); return { kind: 'success' } },
    })
    commandCtx.commands.register({
      name: 'new',
      description: 'Start a blank session in this workspace (this one stays resumable)',
      handler: () => startNewSession(),
    })
    commandCtx.commands.register({
      name: 'clear',
      description: 'Clear the transcript view (session history is unchanged)',
      handler: () => { transcript.clearTranscript(); requestRender(); return { kind: 'success' } },
    })
    commandCtx.commands.register({
      name: 'rename',
      description: 'Name this session yourself, or regenerate the title with no argument',
      input: { hint: '[name]' },
      handler: ({ rawInput, signal }) => runRenameCommand(
        {
          // Read per call rather than captured at mount: the title service is a
          // line in the base bundle, and a deployment that disables it deserves
          // the explanation rather than a crash here.
          titles: ctx.get('sessionTitle') as SessionTitleWriter | undefined,
          announceGenerating: () => { appendNotice(t('rename.generating')) },
        },
        agent.session,
        rawInput,
        signal,
      ),
    })
    commandCtx.commands.register({
      name: 'compact',
      // Registered unconditionally, exactly like `/skills`: whether this
      // session's preset composes a compaction service is a runtime fact the
      // handler reports, and a command list that changed shape per preset would
      // make `/help` and the README table disagree. Registered on the agent's
      // own context, which shadows the preset realm's English `/compact` — the
      // rationale is in `chat/compact.ts`.
      description: 'Compact older conversation history into one summary',
      // No `input` hint: advertising an argument the handler refuses would be
      // the slash menu contradicting the command.
      handler: async (invocation) => {
        // Only one `/compact` may be in flight from this terminal. The backend
        // refuses a second with `busy` anyway, but a local refusal writes no
        // log line and claims no maintenance slot.
        if (activeCompaction !== undefined) return { kind: 'error', text: t('compact.inFlight') }
        // A fresh request is not the cancelled one: the flag outlives the
        // command on purpose (the backend closes its transaction after the
        // command has already answered), so the next one clears it.
        compactCancelling = false
        const controller = new AbortController()
        // The dispatching UI's signal still owns teardown; this one adds Esc,
        // so both reasons to stop reach the same backend request.
        const relay = (): void => { controller.abort(new Error('compaction cancelled by the user')) }
        invocation.signal.addEventListener('abort', relay, { once: true })
        activeCompaction = controller
        try {
          return await runCompactCommand(
            {
              engine: compactionEngine,
              agent,
              expandKey: () => keyLabel(keybindings, 'app.tools.cycle'),
            },
            invocation.rawInput,
            controller.signal,
            invocation.commandId,
          )
        } finally {
          invocation.signal.removeEventListener('abort', relay)
          activeCompaction = undefined
          // The flag outlives the command only while a bracket is still open —
          // that one is the cancelled compaction, and the row keeps saying so
          // until `compaction/end` closes it. With no bracket open the backend
          // never started one (Esc landed before `compaction/start`, or the
          // events were logged against a turn), and a flag left standing here
          // would label the NEXT compaction this terminal merely observes —
          // the automatic policy's, or another process's — as cancelling.
          if (compacting === undefined) compactCancelling = false
        }
      },
    })
    commandCtx.commands.register({
      name: 'config',
      description: 'Change this terminal\'s settings, saved for your next session',
      handler: () => { showSettings(); return { kind: 'success' } },
    })
    commandCtx.commands.register({
      name: 'theme',
      description: 'Pick the palette this terminal paints with',
      input: { hint: '[auto|light|dark|no-color]' },
      handler: ({ rawInput }) => runTheme(rawInput),
    })
    commandCtx.commands.register({
      name: 'lang',
      description: 'Show or switch the interface language',
      input: { hint: '[en|zh]' },
      handler: ({ rawInput }) => runLangCommand(rawInput, {
        store: localeStore,
        // After the fact, so it reads as what it is: the language did change,
        // and only its durability did not.
        reportSaveFailure: message => { appendNotice(message, 'warning') },
      }),
    })
    commandCtx.commands.register({
      name: 'palette',
      description: 'Show every color and attribute role this terminal renders',
      handler: () => { showPalette(); return { kind: 'success' } },
    })
    commandCtx.commands.register({
      name: 'export',
      description: 'Write this session\'s log to a file, or copy it to the clipboard as Markdown',
      // `clipboard` is a bare keyword rather than a dialog option: this
      // terminal's argument-less `/export` already writes the default file, and
      // a file really called `clipboard` is still reachable as `./clipboard`.
      input: { hint: '[path | clipboard]' },
      handler: ({ rawInput, signal }) => isClipboardExportTarget(rawInput)
        ? exportSessionMarkdown(signal)
        : exportSessionLog({
          // Both services are optional: without persistence the export
          // re-serializes the in-memory log, which is the same conversation.
          persistence: ctx.get('sessionPersistence') as SessionArtifactReader | undefined,
          sessions: ctx.get('sessions') as SessionFlusher | undefined,
          cwd,
          // The default destination is one path per session, so exporting the
          // same session twice lands on the first file. Asked, not assumed.
          confirmOverwrite: destination => askConfirmation(
            t('export.overwrite.question', { path: displayInlineText(destination) }),
            t('export.overwrite.replace'),
            t('export.overwrite.keep'),
          ),
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
      name: 'search',
      description: 'Search this session\'s messages',
      // The argument only fills the panel's query box: the transcript is in the
      // terminal's scrollback, so there is no "jump to the first hit" to do
      // without a panel to show the hits in.
      input: { hint: '[query]' },
      handler: ({ rawInput }) => { showTranscriptSearch(rawInput.trim()); return { kind: 'success' } },
    })
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
      name: 'skills',
      description: 'Search this session\'s skills and read one in full',
      handler: () => { showSkills(); return { kind: 'success' } },
    })
    // Registered whether or not the registry is mounted, like `/compact`: a
    // command that vanished on a profile without subagents would leave the
    // user with nothing to ask, and no answer explaining why.
    commandCtx.commands.register({
      name: 'subagents',
      description: 'Show the subagent tree below this session',
      handler: () => { showSubagents(); return { kind: 'success' } },
    })
    // Registered whether or not the registry is mounted, for the same reason
    // `/subagents` is: the answer "this profile runs no background jobs" is
    // worth more than a command that is not there to ask.
    commandCtx.commands.register({
      name: 'jobs',
      description: 'Show this session\'s background jobs and their state',
      handler: () => {
        const registry = jobsRegistry(ctx)
        if (registry === undefined) {
          appendNotice(t('jobs.unavailable'), 'warning')
          return { kind: 'success' }
        }
        showJobs(registry)
        return { kind: 'success' }
      },
    })
    commandCtx.commands.register({
      name: 'status',
      description: 'Show session diagnostics, system prompt, and registered tools',
      handler: async ({ signal }) => { await showStatus(signal); return { kind: 'success' } },
    })
    commandCtx.commands.register({
      name: 'mcp',
      description: 'Show the MCP servers this agent\'s tools come from',
      handler: () => { showMcp(); return { kind: 'success' } },
    })
    commandCtx.commands.register({
      name: 'doctor',
      description: 'Check the runtime, terminal, model route, and mounted services',
      handler: async () => { await showDoctor(); return { kind: 'success' } },
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
          appendNotice(t('notice.unknownCommand', { text }), 'warning')
        } else if (execution.result.text !== undefined && execution.result.text !== '') {
          appendNotice(execution.result.text, execution.result.kind === 'error' ? 'error' : 'info')
        }
        // A `/plan` selection writes no event while a turn is open, so the
        // snapshot path cannot see it: rebuild the badges from the services.
        applyModeBadges()
        requestRender()
      },
      (error: unknown) => {
        if (!disposed) {
          appendNotice(t('notice.commandFailed', { error: errorChain(error) }), 'error')
        }
      },
    ).finally(() => {
      commandControllers.delete(controller)
      if (disposed) return
      // A command is the other hand on the mode axes, and one of its moves
      // announces itself with nothing this terminal subscribes to: a `/plan`
      // during an open turn is held as a pending selection and appends no
      // event until the next step boundary. One rebuild per command is free —
      // it is the per-snapshot rebuild that was not.
      applyModeBadges()
      requestRender()
    })
  }

  /**
   * Deliver a user turn: interrupt a running driver, park the prompt for the
   * turn after it, or — on an idle agent — open a turn with it.
   *
   * The middle branch is the `/config` choice: a prompt typed while a turn runs
   * either steers that turn or queues for the next one, and Ctrl+Enter sends
   * one prompt the other way without moving the setting. An idle agent has no
   * turn to interrupt, so both behaviours mean the same thing there and the
   * choice does not apply.
   *
   * rc.6 removed `Agent.acceptsNextStep` and the `agent/prompt-submit`
   * admission waterfall, so the running check is the public status and an
   * attached reference snapshot rides `agent.inject()` beside the prompt
   * instead of inside its admission transaction — for a queued prompt, at the
   * turn boundary that claims it rather than at this call.
   * @param content - the model-facing blocks of the user's turn.
   * @param attachedContext - optional session-reference snapshot delivered with it.
   * @param gesture - `opposite` takes the other branch of the busy-Enter choice.
   */
  const dispatchMessage = (
    content: ContentBlock[],
    attachedContext?: UserMessage,
    gesture: SubmitGesture = 'enter',
  ): void => {
    if (disposed || agentGone) {
      appendNotice(t('notice.agentDisposed', { id: agent.id, recovery: disposedRecovery() }), 'error')
      return
    }
    const message = createUserMessage({ content, source: { kind: 'user' } })
    const running = agent.status === 'running'
    // One place decides it: the stored preference, inverted for this one send
    // when the user asked for the other branch.
    const behavior = gesture === 'opposite'
      ? busyEnter === 'steer' ? 'queue' : 'steer'
      : busyEnter
    const steering = running && behavior === 'steer'
    const queued = running && !steering
    // Echo the prompt before delivering it. A message the driver has not read
    // yet is recorded only when it claims it — at its next step boundary for
    // steering, at the next turn for a queued prompt — so its `user/message`
    // event lands after the answer it was typed over has already streamed rows
    // onto the screen: without this the prompt would appear below the reply it
    // came before. The echo is keyed by MessageId, so the event lands on this
    // exact node instead of appending a second one.
    store.appendOptimistic(message, steering ? 'steering' : queued ? 'queued' : 'user')
    if (attachedContext !== undefined) {
      // Injected context takes the nearest pre-step, which is the boundary a
      // steered prompt and an idle agent's own turn both take — so for those
      // two the snapshot goes now, ahead of the prompt, and one claim takes the
      // pair. A queued prompt's boundary is a later TURN, past every remaining
      // step of the turn in flight: injecting now would read the snapshot into
      // an answer it has nothing to do with (the very turn queueing promised to
      // leave alone) and open the queued prompt's own turn without it. It waits
      // in {@link attachedContexts} until that turn is next (see the `turn/end`
      // handler), and travels with the prompt if Up takes the prompt back.
      const injected = !queued
      if (injected) agent.inject(attachedContext)
      attachedContexts.set(message.id, { message: attachedContext, injected })
    }
    if (steering) {
      // Steering is never subject to prompt admission; a running driver
      // consumes it at its next step boundary.
      agent.steer(message)
      pendingSteering.set(message.id, contentText(content).trim())
      // The insertion this call publishes has already refreshed the count;
      // asking again costs one list walk and keeps the badge right on a host
      // that routes steering without publishing.
      refreshQueueState()
      return
    }
    // The idle path and the queued one are the same call: a follow-up is a
    // next-turn message, which an idle agent starts a turn for immediately and
    // a busy one gets to when the turn in flight is done.
    agent.followup(message)
    if (queued) {
      // Booked into the refund ledger exactly like a steered prompt: it is
      // still text this terminal typed and has not seen answered, so Esc and
      // Ctrl+C owe it back, and the same claimed/discarded signals settle both.
      pendingSteering.set(message.id, contentText(content).trim())
      refreshQueueState()
    }
  }

  /**
   * Drop the pairing for a prompt the inbox has settled.
   *
   * A parked snapshot outlives the claim on purpose: the step that claimed the
   * prompt is the one that has to carry it, and the pre-step waterfall below
   * runs after this notification, inside that same claim.
   * @param id - the settled prompt's identity.
   * @param claimed - whether it was claimed rather than discarded.
   */
  const settleAttachedContext = (id: MessageId, claimed: boolean): void => {
    const attached = attachedContexts.get(id)
    if (attached === undefined) return
    // A claim leaves a parked snapshot exactly where it is: the pre-step
    // waterfall runs inside this same claim, and it is what delivers it.
    if (claimed && !attached.injected) return
    attachedContexts.delete(id)
  }

  /**
   * Deliver a loaded skill the way Claude Code presents a slash-command skill:
   * the visible user turn is the command line itself, and the skill body rides
   * an injected context message beside it — model-visible, but rendered as a
   * context card the transcript only mounts in the expanded Ctrl+O phase,
   * never as user prose. The body is dsh-skill's canonical `<skill_content>`
   * render, so the model sees one shape whether it loaded the skill itself or
   * the user invoked it, and the injection carries the durable
   * `skill-invocation` source dsh-skill declares for exactly this boundary.
   */
  const deliverSkill = (skill: SkillDefinition, instructions: string): void => {
    const context = createUserMessage({
      content: [{ type: 'text', text: renderSkillContent(skill) }],
      source: { kind: 'skill-invocation', name: skill.name, form: 'instructions' },
    })
    dispatchMessage([{ type: 'text', text: renderSkillEcho(skill.name, instructions) }], context)
  }

  /**
   * Load a manually invoked skill and deliver it — command-line echo as the
   * user turn, body as injected context — reporting lookup outcomes as notices.
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
    // Resolved per invocation, not at mount: after `/preset` re-links a blank
    // session the registry captured at mount is the previous preset's, and a
    // lookup against it either loads the wrong body or refuses a skill this
    // agent does have.
    const skills = skillRegistry()
    if (skills === undefined) {
      appendNotice(t('skills.unavailable'), 'warning')
      return Promise.resolve()
    }
    const lookup = { cwd, scope: agent, signal: skillAbort.signal }
    const reportFailure = (error: unknown): void => {
      if (disposed) return
      appendNotice(t('skills.loadFailed', { name, error: errorChain(error) }), 'error')
    }
    return skills.list(lookup).then(
      (summaries) => {
        if (disposed) return
        const summary = summaries.find(skill => skill.name === name)
        if (summary === undefined) {
          appendNotice(t('skills.unknown', { name }), 'warning')
          return
        }
        if (!summary.invocation.userInvocable) {
          appendNotice(t('skills.notUserInvocable', { name }), 'warning')
          return
        }
        return skills.get(name, lookup).then(
          (skill) => {
            if (disposed) return
            if (skill === undefined) {
              appendNotice(t('skills.unknown', { name }), 'warning')
              return
            }
            if (!skill.invocation.userInvocable) {
              appendNotice(t('skills.notUserInvocable', { name }), 'warning')
              return
            }
            deliverSkill(skill, instructions)
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
      appendNotice(t('notice.reloadBusyAgent', { status: agent.status }), 'warning')
      return
    }
    // Re-entrancy guard: concurrent refreshes over a genuinely changed file
    // would race unmutexed tree updates (create/remove interleaving); one
    // reload at a time keeps the update pass single-writer.
    if (reloadInFlight) {
      appendNotice(t('notice.reloadRunning'), 'warning')
      return
    }

    // Optional-service lookup: the TUI must not depend on the Loader (tests
    // and embedders run without one), so `loader` stays out of `inject` and
    // is read through the non-throwing `ctx.get` accessor — a bare `ctx.loader`
    // proxy read would throw `cannot get property without inject` in a fiber.
    const loader = ctx.get('loader') as { entries(): Iterable<{ subtree?: { refresh?(): Promise<void> } }> } | undefined
    if (loader === undefined) {
      appendNotice(t('notice.reloadNoLoader'), 'warning')
      return
    }
    const refreshes: Promise<void>[] = []
    for (const entry of loader.entries()) {
      if (entry.subtree?.refresh !== undefined) refreshes.push(entry.subtree.refresh())
    }
    reloadInFlight = true
    appendNotice(t('notice.reloadStarted', { count: refreshes.length }))
    // refresh() never rejects (it warns and keeps the running tree), so the
    // join can only fulfill; the catch arm guards a future contract change.
    void Promise.all(refreshes).then(() => {
      appendNotice(t('notice.reloadDone'))
    }).catch((error: unknown) => {
      appendNotice(t('notice.reloadFailed', { error: errorChain(error) }), 'error')
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

  /**
   * Which key sent the line the editor is about to hand back.
   *
   * Set by the Ctrl+Enter branch just before it asks the editor to submit, read
   * and reset by the submission it caused — and disarmed by that same branch
   * for the presses the editor answers with something other than a submission.
   * A one-shot slot rather than a parameter because pi-tui's `onSubmit` carries
   * only the text: the editor owns paste expansion and buffer clearing, so the
   * gesture has to travel beside that call rather than through it.
   */
  let pendingSubmitGesture: SubmitGesture = 'enter'

  const submitLine = (raw: string): void => {
    // Consumed here, on the way in, so no later return path can leave the
    // inverse armed for the next Enter.
    const gesture = pendingSubmitGesture
    pendingSubmitGesture = 'enter'
    const trimmed = raw.trim()
    if (trimmed === '') return
    // The one place a prompt's length is decided. It has to be here rather than
    // in the editor: pi-tui's `submitValue()` expands every paste marker,
    // clears the buffer and drops the paste map before it calls back, so this
    // string is both the first and the last sight of the full text. Nothing
    // downstream can put it back, which is why the notice reports the original
    // length — the user's only remaining copy is the one they pasted from.
    const limited = truncatePrompt(trimmed, resolved.maxPromptChars)
    if (limited.removed > 0) {
      appendNotice(t('notice.promptTruncated', {
        original: limited.original,
        limit: resolved.maxPromptChars,
        removed: limited.removed,
      }), 'warning')
    }
    // Every routing decision, the history entry, the restored draft and the
    // model-facing turn all read this one value, so the transcript, the history
    // and the request body can never disagree about what was sent.
    const value = limited.text
    const text = value
    const restoreSubmittedInput = (): void => {
      if (editor.getText() === '') editor.setText(value)
    }
    // Every routing decision below reads the trimmed line, because a leading
    // space is a typo, not an intent: " /help" used to miss the command branch
    // and be sent to the model as a chat message, which the user paid for and
    // could not undo. The line counts as a command only when it parses as one:
    // a pasted absolute path (/Users/..., /var/folders/...) also starts with
    // '/' but fails the command-name grammar, and used to be answered with
    // "Unknown command" instead of reaching the model.
    const command = parseCommand(text) !== undefined
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
      flashStatus(t('status.flash.queuedForSkill'))
      return
    }
    // `/skill:<name>` carries a colon, which the command registry's name
    // grammar rejects, so it is intercepted before generic command routing.
    if (text.startsWith(SKILL_COMMAND_PREFIX)) {
      editor.addToHistory(text)
      editor.setText('')
      const { name: skillName, instructions } = parseSkillCommand(text)
      if (skillName === '') appendNotice(t('notice.skillUsage'), 'warning')
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
      appendNotice(t('notice.referenceInvalid', { error: errorChain(error) }), 'error')
      return
    }
    if (parsed.references.length === 0) {
      editor.addToHistory(text)
      editor.setText('')
      dispatchMessage([{ type: 'text', text: parsed.text }], undefined, gesture)
      return
    }
    const sessionReferences = ctx.get('sessionReferenceResolver')
    if (sessionReferences === undefined) {
      restoreSubmittedInput()
      appendNotice(t('notice.referenceUnavailable'), 'error')
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
      // them together — see dispatchMessage's attached-context path. The
      // gesture travels with it too, captured before the await: a reference
      // that took a second to resolve still goes where the key that sent it
      // said it should.
      dispatchMessage(prepared.content, prepared.additionalContext, gesture)
    }, (error: unknown) => {
      if (!disposed && !controller.signal.aborted) {
        restoreSubmittedInput()
        appendNotice(t('notice.referenceFailed', { error: errorChain(error) }), 'error')
      }
    }).finally(() => {
      referenceControllers.delete(controller)
      editor.disableSubmit = false
      requestRender()
    })
  }
  editor.onSubmit = submitLine
  /**
   * Whether the draft is being written by this terminal rather than typed.
   *
   * `setText` calls `onChange` synchronously, so a draft handed back by
   * `$EDITOR` runs the same rule a keystroke does. `?` is a keystroke rule: a
   * file whose whole content is `?` was saved on purpose, and answering it with
   * the shortcut list would throw that save away silently.
   */
  let writingDraft = false
  /**
   * `?` on an empty prompt opens the shortcut list, and is not typed.
   *
   * Claude Code's rule exactly (`PromptInput.tsx`): the help opens only when the
   * whole input is a single `?`, and the character itself never lands in the
   * draft — a `?` typed inside a sentence is a question mark, not a keystroke.
   */
  editor.onChange = (text: string): void => {
    if (text === '?' && !writingDraft) {
      editor.setText('')
      showHotkeys()
      requestRender()
      return
    }
    // Claude Code raises this the moment the input wraps
    // (`Notifications.tsx:146`); this raises it on the first hard newline,
    // because `onChange` runs per keystroke and measuring the wrap would mean
    // re-rendering the editor to find out. Once per session, and never over a
    // row that is saying something else.
    if (externalEditorHinted || !text.includes('\n')) return
    if (flashingStatus !== undefined || compacting !== undefined) return
    const resolution = externalEditor()
    externalEditorHinted = true
    if (resolution.kind !== 'editor') return
    flashStatus(t('status.flash.externalEditorHint', {
      key: keyLabel(keybindings, 'app.draft.edit'),
      editor: resolution.editor.name,
    }), EXTERNAL_EDITOR_HINT_MS)
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
    // Expanded, because `setText` empties the editor's paste map: a draft that
    // still holds a `[paste #1 +40 lines]` marker would keep the marker and
    // lose the forty lines it pointed at, and the literal marker is what the
    // next Enter would send to the model.
    const draft = editor.getExpandedText()
    editor.setText(draft === '' ? queued.join('\n') : `${queued.join('\n')}\n${draft}`)
    // `Editor.setText` mutates the buffer without asking for a redraw.
    requestRender()
  }

  /**
   * Take the newest unclaimed prompt out of the queue and into the editor.
   *
   * The Up key's queue meaning, and the whole of it: one prompt comes back as
   * an ordinary draft, and from there every key means what it always means —
   * Enter sends it again (to the back of the queue, since the copy in the inbox
   * is gone), Esc throws it away into the prompt history, and Up itself goes
   * back to being the editor's. Editing an older prompt is sending this one
   * back and pressing Up again, which walks the whole queue.
   *
   * The newest is the one taken because it is furthest from being claimed:
   * pulling it back disturbs the running turn least, and it is also the prompt
   * a user who just typed one too many is reaching for. The removal is the
   * inbox's own, not a shadow copy, so the discard it publishes withdraws the
   * optimistic echo and settles the refund ledger without any of that being
   * repeated here — the prompt now exists only as the draft on screen.
   * @returns whether a prompt was taken; `false` leaves Up to the editor.
   */
  const popQueuedForEdit = (): boolean => {
    const item = pendingUserQueue(agent.inbox).at(-1)
    if (item === undefined) return false
    // The ledger holds what this terminal submitted, already trimmed; a prompt
    // inserted from elsewhere is flattened out of its own blocks.
    const text = pendingSteering.get(item.message.id) ?? contentText(item.message.content).trim()
    // Read before the removal below, whose discard notification settles this
    // very entry.
    const attached = attachedContexts.get(item.message.id)
    // Racing the driver: it claimed the prompt between the projection and here,
    // so the prompt is being answered and there is nothing to edit.
    if (!agent.inbox.remove(item.message.id)) return false
    // The snapshot the prompt was sent with comes back with it. Left behind, an
    // injected session recall is claimed on its own by the running turn — a dump
    // of another session with no question attached — and the prompt in the
    // editor would be re-sent against material the model no longer has.
    if (attached !== undefined) {
      attachedContexts.delete(item.message.id)
      if (attached.injected) agent.inbox.remove(attached.message.id)
    }
    editor.setText(text)
    // `Editor.setText` mutates the buffer without asking for a redraw.
    requestRender()
    markQueueHintLearned()
    return true
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
      flashStatus(t('status.flash.historyEmpty'))
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
   * branches it at the last safe boundary before the chosen prompt — after the
   * last closed turn, or the log head for the first prompt — and mounts
   * the branch, leaving this session whole and resumable. One that cannot only
   * puts the prompt's text back in the editor. Neither touches a file: dsh keeps
   * no working-tree snapshots, and the panel says so instead of implying one.
   * @param target - the prompt the user picked.
   */
  const rewindTo = (target: RewindTarget): void => {
    const events = agent.session.events
    const fork = runtime.handoffFork
    editor.setText(target.text)
    requestRender()
    if (fork === undefined) {
      appendNotice(t('notice.rewindNoFork'), 'warning')
      return
    }
    appendNotice(t('notice.rewindForking'))
    void fork({
      seed: events.slice(0, forkSeedLength(events, target.seq)),
      parentSession: agent.session.id,
      cwd,
      draft: target.text,
    }).catch((error: unknown) => {
      /* v8 ignore next -- a fork that fails after teardown has no screen left to report on. */
      if (!disposed) appendNotice(t('notice.rewindFailed', { error: errorChain(error) }), 'error')
    })
  }

  const showRewind = (): void => {
    if (agent.status === 'running') {
      appendNotice(t('notice.rewindBusy'), 'warning')
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
   * Guard against a second entry. No key can reach this terminal while the
   * child owns it, but `/editor` is a second front door and a controller can
   * drive it.
   */
  let externalEditActive = false
  /**
   * Whether the multi-line hint has already been spent. Claude Code raises its
   * version on every wrap; once a session is enough here, because a hint that
   * keeps coming back is a hint the user has already declined.
   */
  let externalEditorHinted = false

  /**
   * Give the keyboard back to whoever owns it after the terminal was released.
   *
   * Not always the prompt: an approval request or an agent question can arrive
   * while `$EDITOR` holds the tty, and the dialog it opens took focus for
   * itself. Focusing the editor over it strands a decision the turn is blocked
   * on — the panel keeps drawing, its keys go into the draft instead, and Esc
   * and Ctrl+C never reach it either, because the input listener steps aside
   * while an overlay is active. A pi-tui overlay repairs its own focus on the
   * next key; the inline slot has no such owner, so it is repaired here.
   */
  const reclaimFocus = (): void => {
    if (inlineFocusTarget !== undefined) {
      ui.setFocus(inlineFocusTarget)
      return
    }
    // A stacked overlay keeps the focus pi-tui gave it; taking it away here
    // would only be undone on the next key.
    if (overlayManager.hasActiveOverlay()) return
    ui.setFocus(editor)
  }

  /**
   * Hand the draft to `$EDITOR` and take back what was saved.
   *
   * The terminal is released the way `/resume` releases it (`chat/resume.ts`):
   * stdin is drained first so a Kitty release event cannot leak into the child,
   * `ui.stop()` restores raw mode and parks the frame, and the child inherits
   * the tty. Nothing renders while it runs — pi-tui short-circuits every render
   * path once stopped — so the repaint on the way back is forced rather than
   * diffed: the editor has scribbled over rows the differ still believes in.
   */
  const openExternalEditor = async (): Promise<void> => {
    if (externalEditActive || disposed) return
    const resolution = externalEditor()
    if (resolution.kind === 'disabled') {
      appendNotice(t('notice.externalEditorDisabled'), 'warning')
      return
    }
    if (resolution.kind === 'unset') {
      appendNotice(t('notice.externalEditorUnset'), 'warning')
      return
    }
    if (resolution.kind === 'unresolved') {
      appendNotice(t('notice.externalEditorUnresolved', { command: resolution.command }), 'warning')
      return
    }
    const editorSpec = resolution.editor
    // Expanded, because that is what pi-tui says this reader is for: `getText()`
    // would write `[paste #1 +40 lines]` into the file as a literal.
    const draft = editor.getExpandedText()
    externalEditActive = true
    externalEditorHinted = true
    clearFlash()
    let released = false
    try {
      await runtime.terminal.drainInput(100, 20)
      if (disposed) return
      ui.stop()
      released = true
      const result = await editTextExternally(draft, editorSpec, { cwd })
      // Teardown can run while the child does: a `ui.start()` here would take
      // back a terminal `shutdown` has already handed over.
      if (disposed) return
      ui.start()
      reclaimFocus()
      ui.invalidate()
      ui.requestRender(true)
      released = false
      if (result.kind === 'failed') {
        appendNotice(t('notice.externalEditorFailed', { error: result.error }), 'error')
        return
      }
      if (result.kind === 'exit') {
        // `vim :cq`, a crash, a signal: the user said no, so the draft stands.
        appendNotice(t('notice.externalEditorExit', { editor: editorSpec.name, code: result.code }), 'warning')
        return
      }
      // Unchanged is silent, and does not touch the buffer: `setText` would
      // push an undo snapshot that undoes nothing.
      if (result.text === draft) return
      // `setText` pushes the undo snapshot itself, so Ctrl+- still reaches the
      // draft as it was before the edit; it does not ask for a redraw. The flag
      // marks the change as written rather than typed, so a file saved as a
      // single `?` comes back as a draft instead of opening the shortcut list.
      writingDraft = true
      try {
        editor.setText(result.text)
      } finally {
        writingDraft = false
      }
      requestRender()
    } catch (error: unknown) {
      /* v8 ignore next 5 -- only a spawn that fails after the terminal was released reaches here. */
      if (!disposed) {
        if (released) {
          ui.start()
          reclaimFocus()
          ui.invalidate()
          ui.requestRender(true)
        }
        appendNotice(t('notice.externalEditorFailed', { error: errorChain(error) }), 'error')
      }
    } finally {
      externalEditActive = false
    }
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
    // A manual compaction only runs while the agent is idle, so this rung can
    // never race the turn cancel above. Claude Code answers Esc during a
    // compaction the same way: the compaction stops, the conversation is
    // untouched. One press, not two — nothing is lost by stopping it.
    if (activeCompaction !== undefined) {
      disarmEscape()
      compactCancelling = true
      activeCompaction.abort(new Error('compaction cancelled by the user'))
      // The stopwatch row renders the cancelling phase whenever the backend has
      // opened a `compaction/start`; the flash covers the window before it, so
      // the answer to Esc is on screen either way and never twice.
      if (compacting === undefined) flashStatus(t('status.flash.compactCancelling'))
      requestRender()
      return
    }
    const draft = editor.getText()
    if (draft !== '') {
      if (escapeArmed === undefined) {
        armEscape(t('status.flash.escDraft'))
        return
      }
      disarmEscape()
      // Stored before it is dropped, exactly as Claude Code does: a draft the
      // user threw away is still something they typed, and Ctrl+R is how they
      // get it back.
      //
      // Expanded, for the same reason `submitLine` stores expanded text: a
      // `[paste #1 +40 lines]` marker is a handle on THIS editor's paste map,
      // which `setText('')` below empties and the next process never had. A
      // history entry has to be the prompt itself, or the recall it promises
      // sends a literal marker to the model with the pasted text gone.
      editor.addToHistory(editor.getExpandedText())
      editor.setText('')
      requestRender()
      return
    }
    if (!hasRewindTarget(agent.session.events)) return
    if (escapeArmed === undefined) {
      armEscape(t('status.flash.escRewind'))
      return
    }
    disarmEscape()
    showRewind()
  }

  /** Whether the last Up press was taken by the queue, so its tail is too. */
  let upClaimed = false
  const removeInputListener = ui.addInputListener((data) => {
    if (overlayManager.hasActiveOverlay()) return undefined
    // `matchesKey` reports the key, not the transition: under the Kitty
    // keyboard protocol one physical Ctrl+O arrives as press, then release
    // (and a repeat per auto-repeat tick), and every one of them matches. Each
    // binding below acts once, on the press, and swallows the rest of its own
    // key's events so they never reach the editor. Terminals without the
    // protocol send press only, so this changes nothing for them.
    const press = !isKeyRelease(data) && !isKeyRepeat(data)
    // Shift+Tab reaches this branch only in the main input state: an open
    // overlay returned above, which is what leaves the `/model` picker's own
    // Shift+Tab (step the reasoning effort) to the dialog that binds it.
    if (keybindings.matches(data, 'app.mode.cycle')) {
      if (press) cycleMode()
      return { consume: true }
    }
    if (keybindings.matches(data, 'app.tools.cycle')) {
      if (press) toggleTools()
      return { consume: true }
    }
    if (keybindings.matches(data, 'app.history.search')) {
      if (press) showHistorySearch()
      return { consume: true }
    }
    if (keybindings.matches(data, 'app.transcript.search')) {
      if (press) showTranscriptSearch('')
      return { consume: true }
    }
    if (keybindings.matches(data, 'app.todos.toggle')) {
      if (press) toggleTodos()
      return { consume: true }
    }
    if (keybindings.matches(data, 'app.thinking.toggle')) {
      if (press) toggleThinking()
      return { consume: true }
    }
    if (keybindings.matches(data, 'app.message.copy')) {
      if (press) copyLastAnswer()
      return { consume: true }
    }
    // Before `app.cancel`: legacy Alt is an ESC prefix, and while pi-tui's
    // `escape` only matches a bare `\x1b`, the specific key answering before
    // the general one is the order that stays correct if that ever changes.
    if (keybindings.matches(data, 'app.draft.edit')) {
      if (press) void openExternalEditor()
      return { consume: true }
    }
    if (keybindings.matches(data, 'app.screen.redraw')) {
      if (press) {
        ui.invalidate()
        ui.requestRender(true)
      }
      return { consume: true }
    }
    // Up belongs to the editor; the queue only borrows it, and only when
    // borrowing costs nothing. Claude Code's three gates, adapted: an open
    // completion popup owns its own arrows, a draft in progress is never
    // overwritten, and an empty queue leaves prompt history exactly as it was.
    // An empty draft is this terminal's reading of Claude Code's "cursor on the
    // first row" — pi-tui keeps visual-line arithmetic private, and an empty
    // draft is on the first row by definition, so the gate is the stricter one
    // and taking a prompt into the editor can never lose typing.
    //
    // Plus one gate a terminal needs that a browser tab does not: only while a
    // turn runs. That is when a queue is a thing the user is watching (the
    // badge counts it and the placeholder offers this key), and it keeps Up on
    // an idle prompt meaning what it has always meant — the prompt history —
    // rather than briefly handing back a prompt the driver is about to claim.
    //
    // Bound by matching the editor's own action rather than by declaring an
    // `app.*` binding on `up`: an app binding would shadow `tui.editor.cursorUp`
    // outright, and `/hotkeys` would be right to report it as a collision.
    if (keybindings.matches(data, 'tui.editor.cursorUp')) {
      // The press that empties the queue closes the gate behind itself, so
      // under the Kitty protocol its own release and repeats would fall through
      // to the editor and recall history over the prompt just taken. A claimed
      // press owns every event of its key.
      if (!press) return upClaimed ? { consume: true } : undefined
      upClaimed = runningStatus !== undefined
        && inlineFocusTarget === undefined
        // A question or permission dialog draws in the inline slot rather than
        // over the screen, and Up is how its own rows are chosen. The manager's
        // own modals are already refused above, whichever slot they drew in;
        // this reads the focus the slot holds, so a dialog whose focus outlives
        // its overlay session by a frame still keeps its arrows.
        && !editor.isShowingAutocomplete()
        && editor.getText() === ''
        && popQueuedForEdit()
      return upClaimed ? { consume: true } : undefined
    }
    // Send this one prompt the other way: queue it when Enter would steer, and
    // steer with it when Enter would queue. Answered before `app.cancel` for
    // the same reason `app.draft.edit` is — a legacy Alt is an ESC prefix — and
    // it has to be answered before the editor sees the key at all, because the
    // editor's own Enter would submit with the preference unchanged.
    if (keybindings.matches(data, 'app.submit.opposite')) {
      // A completion popup takes Enter to accept the highlighted entry, and a
      // key that accepted a completion and sent the line in one press would
      // make the popup dangerous to open. Same rule Esc follows below.
      if (editor.isShowingAutocomplete()) return undefined
      // An empty draft sends nothing, which is where the web chat's "steer
      // everything queued" gesture would go if this terminal grew one.
      if (press && !editor.disableSubmit && editor.getText() !== '') {
        pendingSubmitGesture = 'opposite'
        // Handed to the editor rather than read out of it: `submitValue()`
        // expands paste markers, clears the buffer and drives history, and a
        // second path into `submitLine` would have to reimplement all three.
        editor.handleInput('\r')
        // Disarmed the moment the editor is done with the key, because Enter
        // does not always submit: a draft ending in a backslash turns it into a
        // newline (pi-tui's workaround for terminals with no Shift+Enter), and
        // a paste in progress buffers it. Either way `submitLine` never runs,
        // and an inverse left armed would flip the NEXT plain Enter — steering
        // a turn the user meant to queue behind, or interrupting one they meant
        // to leave alone, with nothing on screen saying so. A submission that
        // did happen has already read the slot on its way in.
        pendingSubmitGesture = 'enter'
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
          // Cancelling empties the inbox either way, so the queued prompts come
          // back to the editor here exactly as they do under Esc: the two keys
          // mean the same thing about the turn, and typed text that no path
          // ever hands back is text the user simply loses. Idempotent on an
          // already-empty ledger, so the repeat rung can call it too.
          if (!cancelRequested) {
            popQueuedSteering()
            cancelActiveTurn()
            disarmExit()
          } else if (exitArmed === undefined) {
            popQueuedSteering()
            cancelActiveTurn()
            armExit(t('status.flash.exitWithoutTurn'))
          } else {
            disarmExit()
            void shutdown(true)
          }
        } else if (editor.getText() !== '') {
          // Stored before it is dropped, for Esc's reason and one of this
          // ladder's own: the rung above hands the cancelled turn's queue back
          // into this draft, and a cancel that settles fast turns the "press it
          // again" this ladder invites into a single press that erases what the
          // press before it just returned. Expanded, so a `[paste #1 …]` marker
          // recalls the pasted text rather than the marker (see `handleEscape`).
          editor.addToHistory(editor.getExpandedText())
          editor.setText('')
          disarmExit()
          // `Editor.setText` mutates the buffer without asking for a redraw, so
          // without this the cleared draft stays on screen until something else
          // repaints — the discard has to be visible the moment it happens.
          requestRender()
        } else if (exitArmed !== undefined) {
          requestExit()
        } else {
          armExit(t('status.flash.exitAgain'))
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
        if (agent.status === 'running') appendNotice(t('status.flash.cancelBeforeExit'), 'warning')
        else if (editor.getText() !== '') flashStatus(t('status.flash.draftBlocksExit'))
        else requestExit()
      }
      return { consume: true }
    }
    return undefined
  })

  /**
   * Deliver a queued prompt's parked snapshot with the step that claims it.
   *
   * The pre-step batch is the one place both halves of such a submission can be
   * put back together. `agent.inject()` cannot do it: injected context takes the
   * NEAREST step boundary, which for a prompt queued behind a running turn
   * belongs to that turn — the answer the user chose not to disturb — and the
   * prompt's own turn would then open without the material it asked about. So
   * the snapshot waits in {@link attachedContexts} and joins the batch here,
   * ahead of the prompt, which is where injecting it would have put it. The
   * loop logs every message of the batch, so it lands in the transcript as the
   * same context card either way.
   */
  const disposeAttachedContext = ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (payload.agent !== agent || attachedContexts.size === 0 || decision.kind === 'reject') return decision
    const parked: UserMessage[] = []
    for (const message of payload.messages) {
      const attached = attachedContexts.get(message.id)
      if (attached === undefined || attached.injected) continue
      attachedContexts.delete(message.id)
      parked.push(attached.message)
    }
    return parked.length === 0 ? decision : { ...decision, messages: [...parked, ...decision.messages] }
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
    // The call ids a stored rule already answered for go with them: a turn that
    // is over has no call left to escalate, and the next turn's ids are its own.
    if (event.type === 'turn/end') {
      inFlightToolCalls.clear()
      prefixGrantedCallIds.clear()
    }
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
    // A preset switch re-links this agent's scope to another standing
    // composition, whose skill rows are a different catalog. Nothing else
    // announces that: `skills/change` fires when a registry's own contents
    // move, not when the agent is pointed at a different registry, so the
    // scan that fills `/skill:` completion and the banner is re-run here.
    if (event.type === 'agent-preset/selected' && skillsAvailable) refreshSkillCommands()
    // The permission axis writes no node and no snapshot aggregate, so the
    // store publishes nothing for it and the badge strip would keep whatever
    // the last transcript change left there. These three events are the whole
    // vocabulary a preset switch speaks — the selection and the two knobs — and
    // they arrive from `/permission` and another client as readily as from the
    // key, which is why the badges are rebuilt here rather than by the caller.
    if (PERMISSION_EVENTS.has(event.type)) applyModeBadges()
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
      // The bracket the cancel was aimed at is closed; nothing is stopping.
      compactCancelling = false
      // A concurrently running turn owns the indicator. Keep its timer and
      // progress bit instead of letting the compaction fade clear that state.
      if (runningStatus === undefined && fadeOutGlyph !== undefined) beginFadeOut(fadeOutGlyph)
    }
    requestRender()
  })
  const settlePendingSteering = (id: MessageId): void => {
    pendingSteering.delete(id)
  }
  // Every insertion, including the ones this terminal did not make: a prompt a
  // second host steered into this session is queued work the user is waiting
  // on, and the badge that says how much work is queued has to know about it.
  const disposeInserted = ctx.on('agent/inbox/inserted', (payload) => {
    if (payload.agent === agent) refreshQueueState()
  })
  const disposeClaimed = ctx.on('agent/inbox/claimed', (payload) => {
    if (payload.agent !== agent) return
    settlePendingSteering(payload.message.id)
    settleAttachedContext(payload.message.id, true)
    refreshQueueState()
  })
  const disposeDiscarded = ctx.on('agent/inbox/discarded', (payload) => {
    if (payload.agent !== agent) return
    settleAttachedContext(payload.message.id, false)
    // Discarded means no `user/message` will ever land for it (cancelling a
    // turn clears the whole inbox), so the echo has to go with it: the model
    // never saw this prompt, and a transcript that keeps showing it is lying.
    store.withdrawOptimistic(payload.message.id)
    settlePendingSteering(payload.message.id)
    refreshQueueState()
  })
  const disposeStatus = ctx.on('agent/status', (payload) => {
    if (payload.agent !== agent) return
    // Leaving 'running' reconciles the refund ledger against the inbox rather
    // than emptying it: a cancellation can discard the queue without every
    // discard reaching this terminal, and those entries have to go — but the
    // ones the inbox still holds are still refundable, and dropping their text
    // would lose prompts the user can still get back.
    if (payload.status !== 'running') {
      const pending = new Set(pendingUserQueue(agent.inbox).map(item => item.message.id))
      for (const id of [...pendingSteering.keys()]) if (!pending.has(id)) pendingSteering.delete(id)
    }
    refreshQueueState()
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
    appendNotice(
      t('notice.agentDisposedTurn', { id: agent.id, recovery: disposedRecovery() }),
      'warning',
    )
  })

  const detachListeners = (): void => {
    skillAbort.abort()
    updateCheckAbort.abort()
    fileSearch.dispose()
    clearFlash()
    disarmEscape()
    removeInputListener()
    disposeCommandChanges()
    disposeLocaleChanges()
    disposeSkillChanges()
    disposePromptChanges()
    disposeJobChanges?.()
    disposeJobsService()
    for (const value of promptValues) value.dispose()
    stopBannerReveal()
    disposeSnapshots()
    store.dispose()
    disposeSessionEvents()
    disposeAttachedContext()
    disposeInserted()
    disposeClaimed()
    disposeDiscarded()
    disposeStatus()
    disposeError()
    disposeAgent()
    disposeSchemeListener()
    disposeTargetListeners()
    disposeChildRouteFallback()
    disposeApprovals()
    modelController.detach()
  }

  // Sweep reveal of the banner: the welcome box and its whale art wipe in
  // left-to-right over ~BANNER_REVEAL_STEPS frames (started after `ui.start()`
  // succeeds). The clip changes no row count, so the screen holds still while
  // the sweep runs. A configured welcome line skips the sweep so deployments
  // (and snapshot fixtures) stay frame-deterministic.
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
  // with the workspace's stored history laid in underneath them; live
  // submissions add for themselves.
  const initial = store.getSnapshot()
  applySnapshot(initial, { repaint: true })
  // This session's own (replayed) prompts come before every other session's,
  // both groups newest first — Claude Code's own order (`history.ts:190-217`).
  // The replayed ones were written to disk by the process that took them, so
  // they go in with `persist: false`; without that every resume would rewrite
  // the whole history. `load()` is synchronous because it has to be: pi-tui
  // only unshifts, so the stored entries must be seated before the replayed
  // ones, and an asynchronous read would arrive after there was any way to put
  // them underneath.
  const replayed: string[] = []
  for (const node of initial.nodes) {
    if (node.kind === 'user-message' && node.source === 'user') replayed.push(node.text.trim())
  }
  const fromSession = [...replayed].reverse().filter(text => text !== '')
  const seenInSession = new Set(fromSession)
  const fromDisk = promptHistory.load().filter(text => !seenInSession.has(text))
  editor.seedHistory([...fromSession, ...fromDisk].slice(0, HISTORY_LIMIT))
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

  // Is a newer bundle published? Asked after the first frame and never before
  // it: a registry read is a network round trip, and nothing about it is worth
  // a startup a user waits on. At most one notice per process — the check is
  // fire-and-forget, so the only way to nag twice is to run twice.
  //
  // A version this build cannot state (`packageVersion()` found no
  // package.json) has nothing to compare against, so the check is skipped
  // rather than run against a guess.
  const runningVersion = packageVersion()
  if (resolved.updateCheck && runningVersion !== undefined) {
    void checkForUpdate({
      name: UPDATE_CHECK_PACKAGE_NAME,
      currentVersion: runningVersion,
      signal: updateCheckAbort.signal,
    }).then(
      (update) => {
        if (disposed || updateCheckAbort.signal.aborted) return
        if (update === undefined || !update.hasUpdate) return
        appendNotice(t('notice.updateAvailable', {
          current: runningVersion,
          latest: update.latest,
          command: updateCommandLine(UPDATE_CHECK_PACKAGE_NAME),
        }))
      },
      /* v8 ignore next 4 -- `checkForUpdate` answers `undefined` instead of throwing; this guards a future one that does not. */
      (error: unknown) => {
        ctx.logger.warn(`dsh-tui: update check failed: ${errorChain(error)}`)
      },
    )
  }

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

/**
 * End this run with `code`, through whichever exit the deployment owns.
 *
 * A launcher-provided bounded exit disposes the tree it owns; without one the
 * app disposes its own root and exits. Shared by the interactive run and the
 * one-shot `--print` run, which end for different reasons and must end the same
 * way.
 * @param ctx - the runner context.
 * @param code - the process status to report.
 */
function requestExit(ctx: Context, code: number): void {
  const appExit = ctx.get('appExit')
  if (appExit === undefined) {
    disposeRootAndExit(ctx, code)
    return
  }
  appExit(code)
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
 * The one line a `--print` run produces is the answer to its task, so a task
 * that is only whitespace has no answer to produce: the model would be sent an
 * empty turn and the caller would get a blank line and a success code. Refused
 * on the command line instead, before an agent is created and while stderr is
 * still the only thing anyone is reading.
 * @param startup - the parsed command line.
 * @returns the refusal to write on stderr, or `undefined` when the run may proceed.
 */
export function startupRefusal(startup: TuiStartupValues): string | undefined {
  if (startup.print === undefined) return undefined
  if (startup.print.trim() === '') {
    return 'dsh-tui: --print needs a task to run.\n'
      + 'Pass one, e.g. dsh --profile tui --print "run the tests".\n'
  }
  // Two tasks, one run: the positional prompt is the interactive path's first
  // turn and `--print` never opens that path, so one of them would be dropped
  // in silence. Which one is not a guess worth making for the caller.
  if (startup.initialPrompt !== undefined) {
    return 'dsh-tui: --print already carries the task; the prompt argument would be ignored.\n'
      + 'Pass the task to --print alone.\n'
  }
  return undefined
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
  const exit = (code: number): void => { requestExit(ctx, code) }
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
    handoffNew: () => newSessionHandoff(),
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

  // `ui.stop()` leaves the outgoing chat's frame in place (it only parks the
  // cursor below the rendered lines), so every in-process handoff wipes the
  // screen AND the scrollback before mounting its replacement — otherwise the
  // session being left stays stacked above the one taking over. Exit keeps the
  // frame on purpose; only a handoff that repaints over the same terminal
  // clears it.
  const resetScreen = (): void => {
    // 3J erases the scrollback, 2J the visible screen, H homes the cursor.
    terminal.write('\x1b[3J\x1b[2J\x1b[H')
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
    resetScreen()
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
    resetScreen()
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

  /**
   * In-process `/new`: flush the session being left, tear the chat and agent
   * down, create a blank session in this workspace, and mount a fresh chat over
   * it.
   *
   * The session left behind keeps its whole log and stays resumable — there is
   * no truncating "clear" anywhere below this UI, and inventing one out of a
   * fresh create would be a lie about what the log holds. The new session is
   * composed exactly as a fresh start would compose it, so `--preset` and the
   * saved default still decide what it runs.
   * @returns Never; the replacement chat owns the terminal from here.
   */
  async function newSessionHandoff(): Promise<never> {
    // Flushed before the handle is released, so the session the user just left
    // is on disk complete when `/resume` lists it.
    const leaving = mounted?.handle.agent.session
    if (leaving !== undefined) await ctx.sessions.flush(leaving)
    await teardown()
    resetScreen()
    let created: AgentHandle
    try {
      const composition = await composeAgentPreset(ctx, startup.preset)
      created = await ctx.agents.create({
        sessionId: SessionId(`session-${randomUUID()}`),
        meta: {
          cwd: process.cwd(),
          ...composition.agentPreset === undefined ? {} : { agentPreset: composition.agentPreset },
        },
        ...agentOptions === undefined ? {} : { agentOptions },
        ...composition.setup === undefined ? {} : { setup: composition.setup },
      })
    } catch (error: unknown) {
      terminal.write(`dsh-tui: failed to start a new session: ${errorChain(error)}\n`)
      exit(1)
      throw error
    }
    mount(created)
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
 * agent, and the prompt-value registry this bundle's chat renders against —
 * except under `--print`, which owns none of them and writes one answer on
 * stdout instead.
 * @param ctx - plugin context carrying the injected core services.
 * @param config - presentation configuration from the bundle row.
 */
/* v8 ignore start -- production process wiring; fake-terminal tests cover createTuiChat, and the print suite covers runPrintTask */
export function apply(ctx: Context, config: Config): void {
  // Before the first frame, and before `--print` writes its first line: the
  // language is a property of this process, so every surface it opens — banner,
  // refusal, panel — has to be in the one the user last chose. This runs while
  // the Host may still be mounting, so the store resolved here can be the file
  // one where `/lang` will use settings; `createTuiChat` reads its own store
  // again for exactly that reason.
  const storedLocale = resolveLocaleStore(ctx).load()
  if (storedLocale !== undefined) setLocale(storedLocale)
  const startup = ctx.tuiStartup
  // Decided before the TTY check, which is a requirement of the renderer and
  // not of this app: `--print` exists to be used from a script, where stdout is
  // a pipe by definition, and refusing it there would refuse it everywhere it
  // is meant to run.
  if (startup.print !== undefined) {
    const io: PrintIo = {
      stdout: process.stdout,
      stderr: process.stderr,
      exit: code => { requestExit(ctx, code) },
    }
    const refusal = startupRefusal(startup)
    if (refusal !== undefined) {
      io.stderr.write(refusal)
      io.exit(2)
      return
    }
    startPrintRun(ctx, startup.print, {
      // The same opening the interactive run uses, so --model, --preset,
      // --resume and --continue keep one meaning across both.
      openAgent: () => openStartupAgent(ctx, startup, resolveAgentOptions(startup)),
    }, io)
    return
  }
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

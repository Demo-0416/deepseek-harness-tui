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
import { Service, type Context } from '@deepseek-ai/cordis';
import { type Agent, type AgentHandle, type AgentOptions } from '@deepseek-ai/dsh-agent';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { TuiOverlayRequest, TuiOverlaySession } from './extension/types.ts';
import { type Config } from './config.ts';
import type { TuiResumeHost, TuiRuntime } from './runtime.ts';
import type { TuiStartupValues } from './startup.ts';
export { TuiPromptService } from './prompt.ts';
export { renderSkillInvocation } from './chat/skill-invocation.ts';
export type { TuiForkRequest, TuiResumeHost, TuiRuntime } from './runtime.ts';
export { resolveTuiConfig, TuiConfigSchema, Config, type ResolvedTuiConfig, type ResolvedTuiThemeConfig, type TuiConfig, type TuiThemeConfig, } from './config.ts';
export { DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES, DEFAULT_FILE_SEARCH_MAX_ENTRIES, DEFAULT_FILE_SEARCH_MAX_RESULTS, } from './chat/file-autocomplete.ts';
export type { TuiComponent, TuiFocusable, TuiOverlayAnchor, TuiOverlayCloseReason, TuiOverlayHost, TuiOverlayMargin, TuiOverlayOptions, TuiOverlayOutcome, TuiOverlayRequest, TuiOverlaySession, TuiOverlayState, TuiTheme, TuiViewport, } from './extension/types.ts';
declare module '@deepseek-ai/cordis' {
    interface Context {
        /** Terminal-only interaction service, available only while a TUI is mounted. */
        tui: TuiExtensionService;
        /** Optional process host that can replace this TUI with a resumed session. */
        tuiResumeHost: TuiResumeHost;
        /** Command line parsed by the `dsh-tui/startup` row. */
        tuiStartup: TuiStartupValues;
        /** Launcher-owned `main` session identity; absent lets the app mint one. */
        mainSessionId: MainSessionIdentity | undefined;
        /** Line the launcher wants printed on exit; absent prints nothing. */
        tuiGoodbyeMessage: string | undefined;
        /** Skill the launcher wants auto-invoked as the fresh session's first turn; absent leaves it to the user. */
        tuiInitialSkill: string | undefined;
    }
}
/** Launcher-chosen identity for the app's `main` session. */
export interface MainSessionIdentity {
    /** Exact session id `main` binds to. */
    readonly id: SessionId;
    /**
     * Whether that session already has persisted history to load. `true` requires
     * an existing log and fails loud when absent; `false` creates it fresh.
     */
    readonly resume: boolean;
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
export declare const MAIN_SESSION_ID_KEY = "mainSessionId";
/**
 * Context key a launcher sets before any Loader entry mounts
 * (`ctx.provide(TUI_GOODBYE_MESSAGE_KEY, line)`) to supply the line the TUI
 * prints once the terminal is released on exit — for the shipped CLI, the
 * command that resumes this session. The launcher owns the wording because only
 * it knows how it was invoked; the TUI escapes terminal controls before
 * rendering. Absent prints nothing.
 */
export declare const TUI_GOODBYE_MESSAGE_KEY = "tuiGoodbyeMessage";
/**
 * Context key a launcher sets before any Loader entry mounts
 * (`ctx.provide(INITIAL_SKILL_KEY, name)`) to seed a fresh session's first user
 * turn with `/skill:<name>`. The launcher sets it only when minting a fresh
 * session, so it never re-fires on a resumed one. Absent leaves the first turn
 * to the user.
 */
export declare const INITIAL_SKILL_KEY = "tuiInitialSkill";
/**
 * Optional terminal-local interaction service provided by one mounted TUI.
 *
 * The concrete provider retains pi-tui, focus, and terminal lifecycle state.
 * Plugins receive only effect-owned overlay sessions.
 */
export declare abstract class TuiExtensionService extends Service {
    /** Exact agent driven by this terminal instance. */
    abstract readonly agent: Agent;
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
    abstract openOverlay(request: TuiOverlayRequest): TuiOverlaySession;
}
export declare const name = "dsh-tui";
export declare const inject: string[];
/** Model guidance for path-only file references selected through the TUI. */
export declare const FILE_REFERENCE_PROMPT = "Paths prefixed with @ are files explicitly referenced by the user. Use the read tool when their contents are needed; do not claim to have inspected a file before reading it.";
/** Lifecycle handle for a mounted interactive terminal channel. */
export interface TuiController {
    /**
     * Deliver one line through the exact path a typed submission takes: slash
     * commands, `/skill:` invocations, and session references all route the same
     * way. Used for the launcher-seeded initial prompt.
     * @param text - the line as the user would have typed it.
     */
    submit(text: string): void;
    /** Stop rendering, restore the terminal, and reject pending questions. */
    dispose(): Promise<void>;
}
/**
 * Start the interactive pi-tui channel for an already-created target agent.
 * @param ctx - agent, tools, session-event, and user-question context.
 * @param config - target agent, banner, and TUI presentation config.
 * @param runtime - terminal and process-exit boundary.
 * @returns lifecycle controller used by the Cordis effect disposer.
 */
export declare function createTuiChat(ctx: Context, config: Config, runtime: TuiRuntime): TuiController;
/**
 * Open the pi-tui channel once its configured agent exists. Kept for embedders
 * that let a declarative agent row own the lifecycle; the shipped `apply`
 * creates the agent itself and calls {@link createTuiChat} directly.
 *
 * @param ctx - Context supplying the agent registry, tools, and event stream.
 * @param config - Target agent and presentation configuration.
 * @param runtime - Terminal and process-exit boundary.
 */
export declare function mountTui(ctx: Context, config: Config, runtime: TuiRuntime): void;
/**
 * Dispose the whole application before process exit, with a bounded fallback.
 * @param ctx - The TUI plugin context whose root owns sibling resources.
 * @param code - Process status to report.
 * @param exit - Exit boundary, replaceable by tests.
 */
export declare function disposeRootAndExit(ctx: Context, code: number, exit?: (status: number) => void): void;
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
export declare function openStartupAgent(ctx: Context, startup: TuiStartupValues, agentOptions: AgentOptions | undefined): Promise<AgentHandle>;
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
export declare function startupFailureMessage(startup: TuiStartupValues, error: unknown): string;
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
export declare function startupRefusal(startup: TuiStartupValues): string | undefined;
/**
 * Cordis entry point (`tui-runner`): owns the process terminal, the startup
 * agent, and the prompt-value registry this bundle's chat renders against —
 * except under `--print`, which owns none of them and writes one answer on
 * stdout instead.
 * @param ctx - plugin context carrying the injected core services.
 * @param config - presentation configuration from the bundle row.
 */
export declare function apply(ctx: Context, config: Config): void;

/**
 * Serializable configuration and defaults for the pi-tui terminal mode. Loader
 * schema validation normally fills defaults; {@link resolveTuiConfig} applies
 * the same defaults for direct callers that bypass the Loader.
 * @module @deepseek-ai/dsh-tui/config
 */
import z from '@deepseek-ai/schemastery';
/** Theme and prompt-template settings for the pi-tui terminal mode. */
export interface TuiThemeConfig {
    /** Apply the built-in ANSI color palette. */
    color?: boolean;
    /** Paint the startup banner with the 24-bit DeepSeek brand gradient. */
    truecolor?: boolean;
    /** Left-aligned template on the row above the editor. */
    leftPrompt?: string;
    /** Right-aligned template on the row above the editor. */
    rightPrompt?: string;
    /** Template used as the editor's first-line prefix. */
    inputPrompt?: string;
    /** Static placeholder shown in an empty editor while the agent is running. */
    inputPlaceholder?: string;
}
/**
 * Which pipeline renders an assistant response body.
 *
 * `claude` is {@link ../render/markdown.ts | renderMarkdownAnsi} under
 * {@link ../render/markdown.ts | claudeMarkdownTheme}; `pi` is pi-tui's own
 * `Markdown` component. A `claude` render that throws falls back to `pi` for
 * the rest of the process, so this setting selects the preferred path rather
 * than the only one.
 */
export type MarkdownRendererId = 'claude' | 'pi';
/** Interaction and presentation settings for the pi-tui terminal mode. */
export interface TuiConfig {
    /** Render model reasoning blocks. */
    showReasoning?: boolean;
    /** Pipeline that renders assistant response bodies. */
    markdownRenderer?: MarkdownRendererId;
    /** Maximum tool-card body lines retained in its collapsed head/tail preview. */
    maxToolOutputLines?: number;
    /** Maximum added and removed lines explored while deriving an exact line diff. */
    maxDiffEditLength?: number;
    /** Maximum options visible at once in a user-question panel. */
    maxQuestionOptions?: number;
    /** Maximum models visible at once in the model selector. */
    maxModelOptions?: number;
    /** Maximum sessions visible at once in the resume selector. */
    maxResumeOptions?: number;
    /** Maximum concurrent cold projection reads in one resume scan. */
    resumeScanConcurrency?: number;
    /** User-question panel width in terminal columns, clamped to the terminal. */
    questionDialogWidth?: number;
    /** User-question panel maximum height in terminal rows. */
    questionDialogMaxHeight?: number;
    /** Model-selector width in terminal columns. */
    modelDialogWidth?: number;
    /** Model-selector maximum height in terminal rows. */
    modelDialogMaxHeight?: number;
    /**
     * `/theme` selector width in terminal columns. The `/config` panel takes its
     * width from the terminal and only its row budget from this bundle's config,
     * so this is the selector's alone.
     */
    settingsDialogWidth?: number;
    /** Maximum fuzzy file candidates displayed for one `@` query. */
    fileSearchMaxResults?: number;
    /** Maximum paths retained in one `@` workspace index. */
    fileSearchMaxEntries?: number;
    /** Directory basenames excluded from `@` traversal and completion. */
    fileSearchExcludedDirectories?: string[];
    /**
     * Path or command name of the `fd` binary backing gitignore-aware `@`
     * completion. Unset discovers `fd`/`fdfind` on `PATH`; the empty string
     * disables it and completion falls back to the in-process walker, which
     * excludes {@link fileSearchExcludedDirectories} by name instead.
     */
    fileSearchCommand?: string;
    /** Show the terminal's hardware cursor at the pi editor's IME marker. */
    showHardwareCursor?: boolean;
    /** Color and prompt-template settings. */
    theme?: TuiThemeConfig;
    /** Terminal window title while the UI is mounted; a logged session title prefixes it. */
    title?: string;
    /**
     * Key overrides for this terminal's own actions (`app.tools.cycle`,
     * `app.history.search`, …) and for pi-tui's built-ins, keyed by action id and
     * valued with one pi-tui key id or several. An action left out keeps its
     * default; an action bound to `[]` is unbound.
     */
    keybindings?: Record<string, string | string[]>;
}
/** Schemastery schema for presentation settings embedded by app bundles. */
export declare const TuiConfigSchema: z<TuiConfig>;
/** Serializable plugin configuration. */
export interface Config extends TuiConfig {
    /**
     * Extra dim line under the startup banner.
     *
     * Optional in the schema as well as in this interface, because absence is a
     * behavior and not a missing value: with no key at all the wordmark sweeps in
     * over the first frames, and any string — the empty one included — states the
     * deployment's own line instead and keeps the banner still, which is what
     * makes a snapshot fixture frame-deterministic. A deployment that wants
     * neither the sweep nor a sentence writes `""`.
     */
    welcome?: string;
    /** Exact shared agent/session identity driven by this terminal. Defaults to `main`. */
    sessionId?: string;
    /**
     * Skill name auto-invoked as this session's first user turn, exactly as if
     * the user typed `/skill:<name>`. Set only by a launcher for a fresh
     * skill-guided session (`dsh migrate`/`dsh upgrade`); absent
     * leaves the first turn to the user.
     */
    initialSkill?: string;
    /**
     * Text the editor opens with, unsent. Set by a rewind handoff so the prompt
     * the user chose to go back to is in the input frame, ready to edit and send
     * again; never by a person, and never submitted on the user's behalf.
     */
    initialDraft?: string;
    /**
     * Register this bundle's experimental developer commands, which today means
     * `/reload` alone.
     *
     * Off by default because `/reload` re-reads the Loader's config files and
     * applies the diff to a live tree: it can dispose and re-mount plugin entries
     * under the session on screen, which is a thing someone editing those files
     * wants and a thing nobody else does. Labelling it in `/help` was not enough —
     * every command in that list reads as an offer, and this one is a tool for the
     * person who already knows what a Loader entry is.
     */
    experimentalCommands?: boolean;
}
/** Schemastery schema for the full plugin configuration. */
export declare const Config: z<Config>;
/** Fully defaulted TUI theme settings. */
export interface ResolvedTuiThemeConfig {
    color: boolean;
    truecolor: boolean;
    leftPrompt: string;
    rightPrompt: string;
    inputPrompt: string;
    inputPlaceholder: string;
}
/** Fully defaulted TUI presentation settings. */
export interface ResolvedTuiConfig {
    showReasoning: boolean;
    markdownRenderer: MarkdownRendererId;
    maxToolOutputLines: number;
    maxDiffEditLength: number;
    maxQuestionOptions: number;
    maxModelOptions: number;
    maxResumeOptions: number;
    resumeScanConcurrency: number;
    questionDialogWidth: number;
    questionDialogMaxHeight: number;
    modelDialogWidth: number;
    modelDialogMaxHeight: number;
    settingsDialogWidth: number;
    fileSearchMaxResults: number;
    fileSearchMaxEntries: number;
    fileSearchExcludedDirectories: string[];
    /** Configured `fd` path or name; `undefined` leaves discovery to `PATH`. */
    fileSearchCommand: string | undefined;
    showHardwareCursor: boolean;
    theme: ResolvedTuiThemeConfig;
    title: string;
    /** Key overrides, empty when the deployment configured none. */
    keybindings: Record<string, string | string[]>;
}
/**
 * Apply direct-call defaults after Loader schema validation has normally run.
 *
 * @param config - Deployment-provided terminal presentation settings.
 * @returns Complete settings consumed by the TUI renderer.
 */
export declare function resolveTuiConfig(config: TuiConfig | undefined): ResolvedTuiConfig;

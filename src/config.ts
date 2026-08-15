/**
 * Serializable configuration and defaults for the pi-tui terminal mode. Loader
 * schema validation normally fills defaults; {@link resolveTuiConfig} applies
 * the same defaults for direct callers that bypass the Loader.
 * @module @deepseek-ai/dsh-tui/config
 */

import z from '@deepseek-ai/schemastery'
import {
  DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES,
  DEFAULT_FILE_SEARCH_MAX_ENTRIES,
  DEFAULT_FILE_SEARCH_MAX_RESULTS,
} from './chat/file-autocomplete.ts'
import { DEFAULT_MAX_PROMPT_CHARS } from './chat/prompt-truncation.ts'

/** Theme and prompt-template settings for the pi-tui terminal mode. */
export interface TuiThemeConfig {
  /** Apply the built-in ANSI color palette. */
  color?: boolean
  /** Paint the startup banner with the 24-bit DeepSeek brand gradient. */
  truecolor?: boolean
  /** Left-aligned template on the row above the editor. */
  leftPrompt?: string
  /** Right-aligned template on the row above the editor. */
  rightPrompt?: string
  /** Template used as the editor's first-line prefix. */
  inputPrompt?: string
  /** Static placeholder shown in an empty editor while the agent is running. */
  inputPlaceholder?: string
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
export type MarkdownRendererId = 'claude' | 'pi'

/** Interaction and presentation settings for the pi-tui terminal mode. */
export interface TuiConfig {
  /** Render model reasoning blocks. */
  showReasoning?: boolean
  /** Pipeline that renders assistant response bodies. */
  markdownRenderer?: MarkdownRendererId
  /** Maximum tool-card body lines retained in its collapsed head/tail preview. */
  maxToolOutputLines?: number
  /** Maximum added and removed lines explored while deriving an exact line diff. */
  maxDiffEditLength?: number
  /**
   * Characters one submitted prompt may carry before its middle is dropped.
   * `0` sends every prompt whole, however long.
   */
  maxPromptChars?: number
  /** Maximum options visible at once in a user-question panel. */
  maxQuestionOptions?: number
  /** Maximum models visible at once in the model selector. */
  maxModelOptions?: number
  /** Maximum sessions visible at once in the resume selector. */
  maxResumeOptions?: number
  /** Maximum concurrent cold projection reads in one resume scan. */
  resumeScanConcurrency?: number
  /** User-question panel width in terminal columns, clamped to the terminal. */
  questionDialogWidth?: number
  /** User-question panel maximum height in terminal rows. */
  questionDialogMaxHeight?: number
  /** Model-selector width in terminal columns. */
  modelDialogWidth?: number
  /** Model-selector maximum height in terminal rows. */
  modelDialogMaxHeight?: number
  /**
   * `/theme` selector width in terminal columns. The `/config` panel takes its
   * width from the terminal and only its row budget from this bundle's config,
   * so this is the selector's alone.
   */
  settingsDialogWidth?: number
  /** Maximum fuzzy file candidates displayed for one `@` query. */
  fileSearchMaxResults?: number
  /** Maximum paths retained in one `@` workspace index. */
  fileSearchMaxEntries?: number
  /** Directory basenames excluded from `@` traversal and completion. */
  fileSearchExcludedDirectories?: string[]
  /**
   * Path or command name of the `fd` binary backing gitignore-aware `@`
   * completion. Unset discovers `fd`/`fdfind` on `PATH`; the empty string
   * disables it and completion falls back to the in-process walker, which
   * excludes {@link fileSearchExcludedDirectories} by name instead.
   */
  fileSearchCommand?: string
  /**
   * Path or command line of the editor `Alt+E` and `/editor` hand the draft to.
   * Unset reads `$VISUAL`, then `$EDITOR`, then discovers a terminal editor on
   * `PATH`; the empty string turns the feature off, and the key says so instead
   * of spawning anything. A GUI editor needs its own wait flag (`code -w`); the
   * known ones get it added for them.
   */
  externalEditor?: string
  /** Show the terminal's hardware cursor at the pi editor's IME marker. */
  showHardwareCursor?: boolean
  /** Color and prompt-template settings. */
  theme?: TuiThemeConfig
  /** Terminal window title while the UI is mounted; a logged session title prefixes it. */
  title?: string
  /**
   * Key overrides for this terminal's own actions (`app.tools.cycle`,
   * `app.history.search`, …) and for pi-tui's built-ins, keyed by action id and
   * valued with one pi-tui key id or several. An action left out keeps its
   * default; an action bound to `[]` is unbound.
   */
  keybindings?: Record<string, string | string[]>
}

const showReasoningSchema = z.boolean().default(true)
const markdownRendererSchema: z<MarkdownRendererId> = z.union(['claude', 'pi'] as const).default('claude')
const maxToolOutputLinesSchema = z.number().step(1).min(1).default(6)
const maxDiffEditLengthSchema = z.number().step(1).min(1).default(1000)
// `min(0)` rather than the `min(1)` every other maximum here takes: zero is not
// a degenerate budget but the deployment turning the rule off, and a schema that
// refused it would leave no way to say "send every prompt whole".
const maxPromptCharsSchema = z.number().step(1).min(0).default(DEFAULT_MAX_PROMPT_CHARS)
const maxQuestionOptionsSchema = z.number().step(1).min(1).default(8)
const maxModelOptionsSchema = z.number().step(1).min(1).default(8)
const maxResumeOptionsSchema = z.number().step(1).min(1).default(8)
const resumeScanConcurrencySchema = z.number().step(1).min(1).default(4)
const questionDialogWidthSchema = z.number().step(1).min(20).default(200)
const questionDialogMaxHeightSchema = z.number().step(1).min(6).default(20)
const modelDialogWidthSchema = z.number().step(1).min(20).default(76)
const modelDialogMaxHeightSchema = z.number().step(1).min(6).default(20)
const settingsDialogWidthSchema = z.number().step(1).min(20).default(72)
const fileSearchMaxResultsSchema = z.number().step(1).min(1).default(DEFAULT_FILE_SEARCH_MAX_RESULTS)
const fileSearchMaxEntriesSchema = z.number().step(1).min(1).default(DEFAULT_FILE_SEARCH_MAX_ENTRIES)
const fileSearchExcludedDirectoriesSchema = z.array(z.string()).default([...DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES])
// No default: an unset value discovers `fd` on PATH, while a configured empty
// string is the deployment saying "do not spawn it", and the two must not
// collapse into one value.
const fileSearchCommandSchema = z.string()
// No default, and for the same reason `fileSearchCommand` has none: unset
// discovers an editor, `""` forbids one, and the two must not collapse.
const externalEditorSchema = z.string()
const showHardwareCursorSchema = z.boolean().default(false)
const colorSchema = z.boolean().default(true)
// No default: an unset value auto-detects truecolor from COLORTERM in `apply`.
const truecolorSchema = z.boolean()
const DEFAULT_LEFT_PROMPT = '${cwd}${git/worktree}${model}${token_meter/cache_hit_rate}${context}'
const DEFAULT_RIGHT_PROMPT = '${queued}'
/**
 * Claude's inline caret, on the editor's first content row rather than a row of
 * its own: one column of `❯` plus its gap, two columns total, so the text starts
 * where every wrapped continuation row starts. Still a template — a deployment
 * that wants the session name back writes `${symbol} ${indicator}`, and one that
 * wants the caret to carry the running-phase glyph writes `${indicator}`.
 */
const DEFAULT_INPUT_PROMPT = '❯ '
const DEFAULT_INPUT_PLACEHOLDER = 'press enter to steer and esc to cancel'
const TuiThemeConfigSchema: z<TuiThemeConfig> = z.object({
  color: colorSchema,
  truecolor: truecolorSchema,
  leftPrompt: z.string().default(DEFAULT_LEFT_PROMPT),
  rightPrompt: z.string().default(DEFAULT_RIGHT_PROMPT),
  inputPrompt: z.string().default(DEFAULT_INPUT_PROMPT),
  inputPlaceholder: z.string().default(DEFAULT_INPUT_PLACEHOLDER),
})
const titleSchema = z.string().default('DeepSeek Harness')
const keybindingsSchema = z.dict(z.union([z.string(), z.array(z.string())]))

const tuiConfigSchemaFields = {
  showReasoning: showReasoningSchema,
  markdownRenderer: markdownRendererSchema,
  maxToolOutputLines: maxToolOutputLinesSchema,
  maxDiffEditLength: maxDiffEditLengthSchema,
  maxPromptChars: maxPromptCharsSchema,
  maxQuestionOptions: maxQuestionOptionsSchema,
  maxModelOptions: maxModelOptionsSchema,
  maxResumeOptions: maxResumeOptionsSchema,
  resumeScanConcurrency: resumeScanConcurrencySchema,
  questionDialogWidth: questionDialogWidthSchema,
  questionDialogMaxHeight: questionDialogMaxHeightSchema,
  modelDialogWidth: modelDialogWidthSchema,
  modelDialogMaxHeight: modelDialogMaxHeightSchema,
  settingsDialogWidth: settingsDialogWidthSchema,
  fileSearchMaxResults: fileSearchMaxResultsSchema,
  fileSearchMaxEntries: fileSearchMaxEntriesSchema,
  fileSearchExcludedDirectories: fileSearchExcludedDirectoriesSchema,
  fileSearchCommand: fileSearchCommandSchema,
  externalEditor: externalEditorSchema,
  showHardwareCursor: showHardwareCursorSchema,
  theme: TuiThemeConfigSchema,
  title: titleSchema,
  keybindings: keybindingsSchema,
}

/** Schemastery schema for presentation settings embedded by app bundles. */
export const TuiConfigSchema: z<TuiConfig> = z.object(tuiConfigSchemaFields)

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
  welcome?: string
  /** Exact shared agent/session identity driven by this terminal. Defaults to `main`. */
  sessionId?: string
  /**
   * Skill name auto-invoked as this session's first user turn, exactly as if
   * the user typed `/skill:<name>`. Set only by a launcher for a fresh
   * skill-guided session (`dsh migrate`/`dsh upgrade`); absent
   * leaves the first turn to the user.
   */
  initialSkill?: string
  /**
   * Text the editor opens with, unsent. Set by a rewind handoff so the prompt
   * the user chose to go back to is in the input frame, ready to edit and send
   * again; never by a person, and never submitted on the user's behalf.
   */
  initialDraft?: string
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
  experimentalCommands?: boolean
}

/** Schemastery schema for the full plugin configuration. */
export const Config: z<Config> = z.object({
  // Deliberately neither `.required()` nor `.default('')`: the startup banner
  // reads the absence of this key, so a default would delete the sweep-reveal
  // path from every deployment that never mentioned a welcome line.
  welcome: z.string(),
  sessionId: z.string().default('main'),
  initialSkill: z.string(),
  initialDraft: z.string(),
  experimentalCommands: z.boolean().default(false),
  showReasoning: tuiConfigSchemaFields.showReasoning,
  markdownRenderer: tuiConfigSchemaFields.markdownRenderer,
  maxToolOutputLines: tuiConfigSchemaFields.maxToolOutputLines,
  maxDiffEditLength: tuiConfigSchemaFields.maxDiffEditLength,
  maxPromptChars: tuiConfigSchemaFields.maxPromptChars,
  maxQuestionOptions: tuiConfigSchemaFields.maxQuestionOptions,
  maxModelOptions: tuiConfigSchemaFields.maxModelOptions,
  maxResumeOptions: tuiConfigSchemaFields.maxResumeOptions,
  resumeScanConcurrency: tuiConfigSchemaFields.resumeScanConcurrency,
  questionDialogWidth: tuiConfigSchemaFields.questionDialogWidth,
  questionDialogMaxHeight: tuiConfigSchemaFields.questionDialogMaxHeight,
  modelDialogWidth: tuiConfigSchemaFields.modelDialogWidth,
  modelDialogMaxHeight: tuiConfigSchemaFields.modelDialogMaxHeight,
  settingsDialogWidth: tuiConfigSchemaFields.settingsDialogWidth,
  fileSearchMaxResults: tuiConfigSchemaFields.fileSearchMaxResults,
  fileSearchMaxEntries: tuiConfigSchemaFields.fileSearchMaxEntries,
  fileSearchExcludedDirectories: tuiConfigSchemaFields.fileSearchExcludedDirectories,
  fileSearchCommand: tuiConfigSchemaFields.fileSearchCommand,
  externalEditor: tuiConfigSchemaFields.externalEditor,
  showHardwareCursor: tuiConfigSchemaFields.showHardwareCursor,
  theme: tuiConfigSchemaFields.theme,
  title: tuiConfigSchemaFields.title,
  keybindings: tuiConfigSchemaFields.keybindings,
})

/** Fully defaulted TUI theme settings. */
export interface ResolvedTuiThemeConfig {
  color: boolean
  truecolor: boolean
  leftPrompt: string
  rightPrompt: string
  inputPrompt: string
  inputPlaceholder: string
}

/** Fully defaulted TUI presentation settings. */
export interface ResolvedTuiConfig {
  showReasoning: boolean
  markdownRenderer: MarkdownRendererId
  maxToolOutputLines: number
  maxDiffEditLength: number
  maxPromptChars: number
  maxQuestionOptions: number
  maxModelOptions: number
  maxResumeOptions: number
  resumeScanConcurrency: number
  questionDialogWidth: number
  questionDialogMaxHeight: number
  modelDialogWidth: number
  modelDialogMaxHeight: number
  settingsDialogWidth: number
  fileSearchMaxResults: number
  fileSearchMaxEntries: number
  fileSearchExcludedDirectories: string[]
  /** Configured `fd` path or name; `undefined` leaves discovery to `PATH`. */
  fileSearchCommand: string | undefined
  /** Configured editor path or command line; `undefined` leaves discovery to `$VISUAL`/`$EDITOR`/`PATH`. */
  externalEditor: string | undefined
  showHardwareCursor: boolean
  theme: ResolvedTuiThemeConfig
  title: string
  /** Key overrides, empty when the deployment configured none. */
  keybindings: Record<string, string | string[]>
}

/**
 * Apply direct-call defaults after Loader schema validation has normally run.
 *
 * @param config - Deployment-provided terminal presentation settings.
 * @returns Complete settings consumed by the TUI renderer.
 */
export function resolveTuiConfig(config: TuiConfig | undefined): ResolvedTuiConfig {
  return {
    showReasoning: config?.showReasoning ?? true,
    markdownRenderer: config?.markdownRenderer ?? 'claude',
    maxToolOutputLines: config?.maxToolOutputLines ?? 6,
    maxDiffEditLength: config?.maxDiffEditLength ?? 1000,
    maxPromptChars: config?.maxPromptChars ?? DEFAULT_MAX_PROMPT_CHARS,
    maxQuestionOptions: config?.maxQuestionOptions ?? 8,
    maxModelOptions: config?.maxModelOptions ?? 8,
    maxResumeOptions: config?.maxResumeOptions ?? 8,
    resumeScanConcurrency: config?.resumeScanConcurrency ?? 4,
    questionDialogWidth: config?.questionDialogWidth ?? 200,
    questionDialogMaxHeight: config?.questionDialogMaxHeight ?? 20,
    modelDialogWidth: config?.modelDialogWidth ?? 76,
    modelDialogMaxHeight: config?.modelDialogMaxHeight ?? 20,
    settingsDialogWidth: config?.settingsDialogWidth ?? 72,
    fileSearchMaxResults: config?.fileSearchMaxResults ?? DEFAULT_FILE_SEARCH_MAX_RESULTS,
    fileSearchMaxEntries: config?.fileSearchMaxEntries ?? DEFAULT_FILE_SEARCH_MAX_ENTRIES,
    fileSearchExcludedDirectories: [...(config?.fileSearchExcludedDirectories ?? DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES)],
    fileSearchCommand: config?.fileSearchCommand,
    externalEditor: config?.externalEditor,
    showHardwareCursor: config?.showHardwareCursor ?? false,
    theme: {
      color: config?.theme?.color ?? true,
      truecolor: config?.theme?.truecolor ?? false,
      leftPrompt: config?.theme?.leftPrompt ?? DEFAULT_LEFT_PROMPT,
      rightPrompt: config?.theme?.rightPrompt ?? DEFAULT_RIGHT_PROMPT,
      inputPrompt: config?.theme?.inputPrompt ?? DEFAULT_INPUT_PROMPT,
      inputPlaceholder: config?.theme?.inputPlaceholder ?? DEFAULT_INPUT_PLACEHOLDER,
    },
    title: config?.title ?? 'DeepSeek Harness',
    keybindings: { ...config?.keybindings },
  }
}

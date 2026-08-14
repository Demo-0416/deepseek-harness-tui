/**
 * pi-tui dialog and selector components for the terminal front door: the status
 * card, prompt-context line, model selector, agent-preset selector, theme
 * selector, resume picker, and user-question dialog, plus the model-choice,
 * preset-choice, and resume-candidate data they present.
 * @module @deepseek-ai/dsh-tui/components/dialogs
 */
import { type Component, type Focusable } from '@earendil-works/pi-tui';
import type { Context } from '@deepseek-ai/cordis';
import { type Agent, type ModelSelection } from '@deepseek-ai/dsh-agent';
import type { LlmModelReasoningInfo, ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import type { SessionId } from '@deepseek-ai/dsh-session';
import type { SessionRecord } from '@deepseek-ai/dsh-session-query';
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions';
import { type Palette, type ThemePreferenceId } from './theme.ts';
import { type TuiPromptTemplateToken } from '../prompt.ts';
import { type PluralKey } from '../i18n/index.ts';
/** A selectable model advertised by a provider, with its display name, description, and reasoning metadata. */
export interface ModelChoice extends ModelSelection {
    modelName: string;
    description?: string;
    reasoning?: LlmModelReasoningInfo;
}
/**
 * How far a pick reaches: to the default-model layer every future session
 * starts from, or to this session alone.
 *
 * Two keys rather than one because the two are genuinely different decisions —
 * "this is my model now" and "just for this piece of work" — and a picker that
 * silently wrote the user's global default on every Enter made the second one
 * unavailable.
 */
export type ModelSelectionScope = 'default' | 'session';
/**
 * The provider/model route, reasoning effort, and reach resolved from a model dialog.
 */
export interface ModelDialogSelection {
    choice: ModelChoice;
    reasoningEffort: ReasoningEffortId | undefined;
    scope: ModelSelectionScope;
}
/**
 * Format a provider/model target as its `provider/model` label.
 * @param target - The LLM target.
 * @returns The `provider/model` label.
 */
export declare function targetLabel(target: ModelSelection): string;
/**
 * Format a target compactly as its model name with any selected reasoning effort appended.
 * @param target - The LLM target.
 * @returns The compact `model [effort]` label.
 */
export declare function compactTargetLabel(target: ModelSelection): string;
/**
 * Resolve the display label for a choice's reasoning effort.
 * @param choice - The model choice carrying advertised reasoning metadata.
 * @param effort - The selected effort, or `undefined` for provider default.
 * @returns The effort's display name, `Default`, or `undefined` when the model has no reasoning metadata.
 */
export declare function targetReasoningLabel(choice: ModelChoice, effort: ReasoningEffortId | undefined): string | undefined;
/**
 * Derive the agent's initial LLM target from its logged request header or options.
 * @param agent - The driven agent.
 * @returns The initial target, or `undefined` when unset.
 */
export declare function initialTarget(agent: Agent): ModelSelection | undefined;
/**
 * List every advertised model across registered providers, appending the current
 * target when a provider does not advertise it.
 * @param ctx - Context supplying the LLM service.
 * @param current - The current target, appended when unadvertised.
 * @returns The model choices, flattened across providers.
 */
export declare function readModelChoices(ctx: Context, current: ModelSelection | undefined): Promise<ModelChoice[]>;
/**
 * Format a diagnostic integer with grouping separators.
 * @param value - Integer to format.
 * @returns The grouped decimal string.
 */
export declare function formatDiagnosticNumber(value: number): string;
/**
 * Format a diagnostic timestamp as an ISO date-time in UTC.
 * @param value - Epoch milliseconds.
 * @returns The formatted UTC timestamp.
 */
export declare function formatDiagnosticTime(value: number): string;
/**
 * Format a pluralized count for a diagnostic row.
 *
 * The noun comes from the message table as a `.one`/`.other` pair rather than
 * from `singular + 's'`: `/status` translates its labels, and a row reading
 * `Agent idle · 42 events · 3 turns` in a Chinese card was half a translation.
 * @param value - Count.
 * @param key - The plural pair naming what is being counted.
 * @returns The formatted count, in the active locale.
 */
export declare function formatDiagnosticCount(value: number, key: PluralKey): string;
/**
 * Render a fixed-width filled meter bar for a percentage.
 * @param percent - Percentage in [0, 100].
 * @param palette - Active role palette.
 * @returns The rendered meter.
 */
export declare function diagnosticMeter(percent: number, palette: Palette): string;
/** One `label: value` row of a status card group. */
export type StatusCardRow = readonly [label: string, value: string];
/** Bordered, grouped field card for one point-in-time status snapshot. */
export declare class StatusCardComponent implements Component {
    private readonly groups;
    private readonly palette;
    constructor(groups: readonly (readonly StatusCardRow[])[], palette: Palette);
    invalidate(): void;
    render(width: number): string[];
}
/** The left/right template line rendered above the editor. */
export declare class PromptContextComponent implements Component {
    private readonly leftTemplate;
    private readonly rightTemplate;
    private readonly resolve;
    constructor(leftTemplate: readonly TuiPromptTemplateToken[], rightTemplate: readonly TuiPromptTemplateToken[], resolve: (name: string) => string | undefined);
    invalidate(): void;
    render(width: number): string[];
}
/**
 * How the two keys that open a question's custom answer are named, wherever
 * they are named.
 *
 * Both keys are bound — `Tab` and `c` — and neither belongs to the keybinding
 * registry, so nothing generated from the registry can spell them: the dialog
 * footer, the dialog's own "nothing selected" refusal, the shortcut list
 * `/help`, `/hotkeys` and `?` print, and the README's question row are four
 * hand-written places that have to agree. Three of them read this constant;
 * the README is held to it by the docs suite.
 */
export declare const CUSTOM_ANSWER_KEYS = "Tab/c";
/**
 * The custom-answer row as the question dialog's footer and the shortcut list
 * both print it, in English.
 *
 * The rendering surfaces read `dialog.question.customAnswer` per frame, so
 * `/lang` moves what the user sees; this constant is the English form the docs
 * suite holds the README to, which is a document that has no locale.
 */
export declare const CUSTOM_ANSWER_HINT: string;
/** A user's answer to one question: chosen option labels and an optional custom answer. */
export interface QuestionSelection {
    selected: string[];
    custom?: string;
}
/**
 * Render a bordered dialog frame around body lines with a titled top edge.
 * @param title - Dialog title shown in the top border.
 * @param body - Body lines.
 * @param width - Dialog width in columns.
 * @param palette - Active role palette.
 * @returns The framed dialog lines.
 */
export declare function renderDialog(title: string, body: readonly string[], width: number, palette: Palette): string[];
/**
 * Keyboard model selector: Claude Code's numbered picker — one row per route,
 * its description in a right-hand column, and the focused model's reasoning
 * effort on a line of its own under the list — over a filter box this
 * deployment needs and Claude Code does not, because a harness advertises every
 * model of every registered provider rather than a hand-written shortlist.
 *
 * The row numbers are ordinals, not shortcuts. Model names are full of digits
 * (`deepseek-v4-pro`), so a digit belongs to the filter; binding it to a row
 * would make the third character of a search jump the cursor somewhere else.
 *
 * Which is also why the session-only pick is `Ctrl+S` rather than `s`: every
 * printable key is a search character. The two writes are otherwise deliberately
 * symmetric — `Enter` saves the pick as the default, `Ctrl+S` spends it on this
 * session only, and the footer says both.
 */
export declare class ModelDialog implements Component {
    private readonly maxVisible;
    private readonly palette;
    private readonly done;
    private readonly cancel;
    private list;
    private readonly filter;
    private readonly items;
    private readonly choices;
    private readonly efforts;
    private readonly currentValue;
    constructor(choices: readonly ModelChoice[], current: ModelSelection | undefined, maxVisible: number, palette: Palette, done: (selection: ModelDialogSelection) => void, cancel: () => void);
    /** Build a SelectList over the currently filtered items, selecting `selectValue` when present. */
    private buildList;
    /**
     * Items matching the filter box, as a case-insensitive substring over the
     * label, model name, and description, numbered in the order they appear.
     *
     * The numbering is applied here rather than at construction because a filtered
     * list that keeps its original ordinals reads as a broken list: the reader
     * counts rows, not catalog positions.
     */
    private filteredItems;
    private confirm;
    /**
     * The row's right-hand column: what the route is, in the provider's own
     * words. The reasoning effort is deliberately absent — it belongs to the
     * focused row alone and has its own adjustable line under the list, where it
     * cannot be truncated away by a long description.
     */
    private describeChoice;
    /** Move the focused model's reasoning effort one step through its advertised ladder. */
    private cycleReasoningEffort;
    /**
     * The focused model's reasoning effort, stated as a line the arrow keys act
     * on — Claude Code's effort row — or as the reason there is nothing to adjust.
     */
    private renderEffortRow;
    invalidate(): void;
    handleInput(data: string): void;
    render(width: number): string[];
}
/**
 * One selectable agent preset, exactly the fields the roster reports about it.
 *
 * Structural rather than the roster's own `AgentPreset`: the preset package is
 * an optional mount, so nothing under `src/` may depend on its runtime, and the
 * absolute composition `path` it also carries has no place on a picker row.
 */
export interface PresetChoice {
    /** Preset id and directory name; also what `/preset <id>` takes. */
    id: string;
    /** Whether the preset ships with the deployment or was authored locally. */
    trust: 'system' | 'user';
    /** Display name the preset published, absent when it published none. */
    name?: string;
    /** One sentence on what the preset is for, when it published one. */
    description?: string;
    /** Why the preset cannot compose a session, absent when it can. */
    broken?: string;
}
/**
 * Keyboard agent-preset selector: the `ModelDialog` frame and filter box over
 * the deployment's preset roster.
 *
 * Broken presets stay on the list rather than being filtered out — a directory
 * that occupies an id with nothing usable in it is exactly what the reader
 * needs to see — and each states its own reason in the description column the
 * list already dims. Enter still yields them; the caller owns the refusal,
 * because it owns the sentence explaining what would have happened.
 */
export declare class PresetDialog implements Component {
    /** The preset this session runs, badged `current` and pre-selected. */
    private readonly current;
    /** The preset a session that names none gets, badged `default`. */
    private readonly defaultId;
    private readonly maxVisible;
    private readonly palette;
    private readonly done;
    private readonly cancel;
    private list;
    private readonly filter;
    private readonly items;
    private readonly choices;
    constructor(choices: readonly PresetChoice[], 
    /** The preset this session runs, badged `current` and pre-selected. */
    current: string | undefined, 
    /** The preset a session that names none gets, badged `default`. */
    defaultId: string | undefined, maxVisible: number, palette: Palette, done: (choice: PresetChoice) => void, cancel: () => void);
    /** Build a SelectList over the currently filtered items, selecting `selectValue` when present. */
    private buildList;
    /** Items matching the filter box, as a case-insensitive substring over the id, name, and description. */
    private filteredItems;
    private confirm;
    /**
     * The row's description column: why the preset is unusable if it is, then how
     * this deployment relates to it, then what it says about itself.
     *
     * Badges lead and prose follows because the column is truncated from the
     * right. `current` and `default` are the two facts a reader is scanning the
     * list FOR — which composition is running and which one a new session would
     * get — and a sentence long enough to push either off the edge would hide
     * exactly the answer the picker was opened to give.
     */
    private describeChoice;
    invalidate(): void;
    handleInput(data: string): void;
    render(width: number): string[];
}
/**
 * Keyboard theme selector, shared by `/theme` and the `/config` panel's Theme
 * row: one row per {@link ThemePreferenceId}, applied while the highlight moves
 * so the screen behind the dialog is the preview, and committed on Enter.
 *
 * Esc puts the theme the dialog opened on back, because a preview the user
 * scrolled past is not a choice they made — the same relation `/model`'s picker
 * has to the route it opened on.
 */
export declare class ThemeDialog implements Component {
    private readonly current;
    private readonly palette;
    private readonly apply;
    private readonly commit;
    private readonly close;
    private readonly list;
    private preview;
    /**
     * @param current - the theme in force when the dialog opened, restored on Esc.
     * @param palette - active role palette.
     * @param apply - paints one theme; called on every highlight move.
     * @param commit - persists the chosen theme; called once, on Enter.
     * @param close - closes the overlay.
     */
    constructor(current: ThemePreferenceId, palette: Palette, apply: (theme: ThemePreferenceId) => void, commit: (theme: ThemePreferenceId) => void, close: () => void);
    invalidate(): void;
    handleInput(data: string): void;
    render(width: number): string[];
}
/** A resume selector row summarizing one session from metadata and its folded title. */
export interface ResumeCandidate {
    record: SessionRecord;
    title: string;
    /** Last observed change: live last-event time or artifact mtime, falling back to creation. */
    lastActivityAt: number;
    /** Whether the session's workspace is the one the current session runs in, which selects the picker scope that lists it. */
    currentWorkspace: boolean;
    /** The session's own workspace as a prompt-style label; the all-workspaces scope shows it per row. */
    workspaceLabel: string;
    disabledReason?: string;
}
/**
 * Build one resume selector row from a record, its batch-folded title, and a
 * metadata-derived activity time, deriving the workspace scope and any reason
 * the session cannot be resumed here. A workspace other than the current one
 * is a scope, not a disabled reason: resuming it hands the process off into
 * that directory. Rows carry no per-log detail beyond the title — route and
 * replay validity are checked by the Enter-time preflight against the one
 * chosen log.
 * @param record - The session record.
 * @param title - The session's batch-folded title, absent for an untitled log.
 * @param lastActivityAt - Metadata activity time; absent falls back to the header's creation time.
 * @param currentId - The current session id.
 * @param cwd - The CURRENT session's workspace, which decides the picker scope this row falls in.
 * @param formatWorkspace - Renders THIS record's own cwd as its prompt-style label.
 * @returns The summarized resume candidate.
 */
export declare function summarizeResumeCandidate(record: SessionRecord, title: string | undefined, lastActivityAt: number | undefined, currentId: SessionId, cwd: string | undefined, formatWorkspace: (cwd: string | undefined) => string): ResumeCandidate;
/** Which workspaces the resume picker currently lists. */
export type ResumeScope = 'workspace' | 'all';
/**
 * Full-viewport keyboard selector over detached, preflighted resume summaries.
 *
 * Two scopes over one candidate set: `workspace` (the default) lists only the
 * current session's workspace, `all` lists every workspace and labels each row
 * with its own. Tab toggles between them; the search query and selection reset
 * on a scope change so the highlighted row always belongs to the visible list.
 *
 * The picker opens before the session scan settles: an `undefined` candidate
 * set renders a loading placeholder that keeps input away from the editor,
 * and `setCandidates` swaps the scanned rows in without replacing the overlay.
 */
export declare class ResumePicker implements Component, Focusable {
    private readonly maxVisible;
    private readonly workspaceLabel;
    private readonly viewportRows;
    private readonly palette;
    private readonly done;
    private readonly cancel;
    private readonly search;
    private pasteBuffer;
    private selectedIndex;
    private error;
    private scope;
    private candidates;
    focused: boolean;
    constructor(candidates: readonly ResumeCandidate[] | undefined, maxVisible: number, workspaceLabel: string, viewportRows: () => number, palette: Palette, done: (candidate: ResumeCandidate) => void, cancel: () => void);
    invalidate(): void;
    /**
     * Narrow the picker to a query the user already typed.
     *
     * `/resume <session>` is the same selection as `/resume` plus a search term,
     * so it opens the same picker with the term already in its search box rather
     * than resuming behind the user's back: the row still has to be looked at
     * and confirmed, and Escape still clears the query instead of the overlay.
     * @param query - the argument text, verbatim.
     */
    setQuery(query: string): void;
    /**
     * Replace the loading placeholder with the scanned candidate set.
     * @param candidates - the summarized rows the finished scan produced.
     */
    setCandidates(candidates: readonly ResumeCandidate[]): void;
    /** Candidates in the active scope, before the search query narrows them. */
    private scoped;
    private filtered;
    private visibleCandidateCount;
    private handleBracketedPaste;
    handleInput(data: string): void;
    /**
     * The scope line under the search box: the active scope with the current
     * workspace it means, and the inactive scope with the count Tab would reveal.
     */
    private renderScopeLine;
    render(width: number): string[];
}
/** Inline dialog for one user question with option or custom-answer modes. */
export declare class QuestionDialog implements Component, Focusable {
    private readonly question;
    private readonly position;
    private readonly total;
    private readonly unanswered;
    private readonly maxVisible;
    private readonly maxHeight;
    private readonly palette;
    private readonly done;
    private readonly cancel;
    private selectedIndex;
    private selected;
    private headerPage;
    private selectedBlockPage;
    private mode;
    private error;
    private readonly input;
    private readonly options;
    focused: boolean;
    constructor(question: AskUserQuestionItem, position: number, total: number, unanswered: number, maxVisible: number, maxHeight: () => number, palette: Palette, done: (selection: QuestionSelection) => void, cancel: () => void);
    invalidate(): void;
    handleInput(data: string): void;
    private submitCustom;
    private selectedOptionLabels;
    /** Page backward through an oversized option, then through question detail. */
    private pageBackward;
    /** Page forward through question detail, then through an oversized option. */
    private pageForward;
    render(width: number): string[];
    /** Render one option as wrapped label and indented description lines. */
    private renderOptionBlock;
    /** Keep the question visible when fixed chrome must be compacted. */
    private compactQuestionHeader;
    /** Keep Page Up / Page Down discoverable when a full pager status cannot fit. */
    private pagerStatus;
    /** Render custom-mode controls on one row when the header must compact. */
    private compactCustomControls;
    /** Render a one-row option footer that retains every mode-specific control. */
    private compactOptionControls;
    /**
     * Choose option blocks that fit while keeping the selected option visible.
     * Omitted blocks are counted at each end for explicit overflow markers.
     */
    private windowBlocks;
}

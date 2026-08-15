/**
 * pi-tui transcript components: the startup banner, user/assistant messages,
 * per-step timing footer, streaming assistant buffer, tool cards, and the todo
 * panel. Each is a pure function of its inputs and the active palette.
 * @module @deepseek-ai/dsh-tui/components/transcript
 */
import { Container, type Component, type MarkdownTheme, type TerminalColorScheme } from '@earendil-works/pi-tui';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { JsonValue, SessionEvent, TodoItem } from '@deepseek-ai/dsh-session';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import { type CollapsedGroup } from '../core/collapse.ts';
import { type Palette } from './theme.ts';
import { type ParsedArguments } from './content.ts';
import { type MarkdownAnsiTheme } from '../render/markdown.ts';
import { type StepPosition, type StepTimingTracker } from '../chat/timing.ts';
/**
 * Which pipeline renders an assistant response body, plus the one-shot report
 * of a failure in the preferred one.
 *
 * The object is shared and mutable — like {@link Palette} and `MarkdownTheme`,
 * which a theme change also rewrites in place — so a single failing render
 * moves every mounted and future body onto the pi path at once, rather than
 * leaving the transcript split between two renderers.
 */
export interface MarkdownPolicy {
    /** Preferred body renderer; set to `pi` for good after a `claude` render throws. */
    mode: 'claude' | 'pi';
    /**
     * Styling for the claude pipeline, the counterpart of the `MarkdownTheme`
     * every component already takes for the pi one. Production passes
     * {@link ../render/markdown.ts | claudeMarkdownTheme}.
     */
    readonly theme: MarkdownAnsiTheme;
    /**
     * Report the failure that demoted `claude` to `pi`. Invoked at most once per
     * policy object, at the moment {@link MarkdownPolicy.mode} flips.
     * @param error - the value the `claude` render threw.
     */
    readonly onError: (error: unknown) => void;
}
/**
 * A markdown body rendered by {@link ../render/markdown.ts | renderMarkdownAnsi}
 * under Claude Code's own styling, with pi-tui's `Markdown` as the fallback.
 *
 * The rows come back already wrapped to the requested width, so the caller must
 * not re-flow them (`PrefixedComponent` only prefixes, which is safe). A throw
 * out of the claude path is contained here: the shared policy flips to `pi`,
 * the failure is reported once, and this render returns the pi rows instead —
 * and a throw out of *that* leaves the unparsed text on screen. A malformed
 * document can degrade the styling but never blank the transcript, and never
 * takes the frame down with it.
 */
export declare class MarkdownBodyComponent implements Component {
    private readonly text;
    private readonly palette;
    private readonly mdTheme;
    private readonly policy;
    /** The pi-tui document, built on demand: the claude path never constructs one. */
    private fallback;
    /** The last claude render, with the width it was wrapped to. */
    private cached;
    /**
     * @param text - the markdown source of one assistant response body.
     * @param palette - active role palette; also decides whether escapes survive.
     * @param mdTheme - pi-tui Markdown theme, used only on the fallback path.
     * @param policy - shared renderer choice and failure report.
     */
    constructor(text: string, palette: Palette, mdTheme: MarkdownTheme, policy: MarkdownPolicy);
    invalidate(): void;
    /** The pi-tui document for this text, built once and reused. */
    private piDocument;
    /** The fallback's rows, or the bare words when even the fallback cannot parse them. */
    private piRows;
    render(width: number): string[];
}
/** What the startup banner reports about the session it opens. */
export interface HeaderInfo {
    /** This bundle's version, rendered next to the wordmark; omitted when unknown. */
    readonly version: string | undefined;
    /** The route the next turn runs under, or `undefined` before one resolves. */
    readonly model: () => string | undefined;
    /** The workspace, already shortened by the host's `formatCwd`. */
    readonly cwd: string;
    /** Short form of the resumed session's id; `undefined` for a fresh session. */
    readonly resumed: string | undefined;
    /** The session's logged title, once it has one. */
    readonly title: () => string | undefined;
    /** Deployment-configured banner line; absent renders none. */
    readonly welcome?: string;
    /**
     * Skill names available to this session, rendered as the banner's `[Skills]`
     * summary. Absent (or empty) renders no section at all: a deployment with no
     * skills must not spend a banner row saying so.
     */
    readonly skills?: readonly string[];
    /**
     * Plugin module names mounted into this session, rendered as the banner's
     * `[Plugins]` summary. Read per render, like the model: the Loader keeps
     * mounting entries after the banner is on screen, and the inventory service
     * itself is a host mount that may resolve late. Absent (or an empty read)
     * renders no section.
     */
    readonly plugins?: () => readonly string[] | undefined;
}
/**
 * Startup banner in the shape of Claude Code's welcome box, at three widths.
 * On a wide terminal ({@link FULL_MIN_WIDTH}+) a session with a skill list gets
 * the two-column frame {@link renderFull} draws — mascot and identity on the
 * left, skills on the right, wordmark in the border. Under that, the badge
 * shape below: a dim rounded border around the brand mark and the session's
 * identity lines, with the skill summary as a borderless section under it.
 *
 * ```text
 *  ╭───────────────────────────────────────────╮
 *  │  ▄███▄  █▄█▄   DEEPSEEK HARNESS v0.1.0    │
 *  │ ▐▀▀██▙▟▙▄▀▀    deepseek-v4-pro            │
 *  │ ▜▖  ▝█▙█▛      ~/src/project              │
 *  │  ▀▙▟█▄▛▀       resumed 85d19568 · a title │
 *  ╰───────────────────────────────────────────╯
 *
 *  [Skills]
 *  lark-doc, lark-base, meego-tech-story, +12 more
 * ```
 *
 * The box hugs its widest identity line rather than the terminal: it is a
 * badge, not a layout region. The session id is on the resumed line only. A
 * fresh session's id is a uuid the user did not choose and cannot act on, and
 * printing it (as this banner once did) spent the first thing on screen saying
 * nothing; a resumed one is exactly what `--resume` takes back, so it is worth
 * its line — with the logged title beside it, which is why the title is not a
 * transcript row of its own.
 *
 * The skill summary stays outside the border, under a blank row: the box says
 * which session this is (mark, route, workspace, resume), and the section
 * under it says what the session can do. A configured welcome line renders
 * between them, as plain left-padded text matching transcript notices. Under
 * {@link MIN_BOXED_WIDTH} columns the whole banner degrades to that plain
 * stack — a box that cannot fit its own art has nothing left to frame.
 */
export declare class HeaderComponent implements Component {
    private readonly info;
    private readonly palette;
    private readonly gradient;
    /** Columns of the banner currently revealed; `undefined` renders it whole. */
    private revealWidth;
    /**
     * @param info - The identity lines this banner states.
     * @param palette - Active role palette, mutated in place by a repaint.
     * @param gradient - Whether the wordmark may carry truecolor brand art, read
     *   per render: the banner is mounted once, so a theme changed mid-session
     *   (`/theme no-color`) has no other way to reach it.
     */
    constructor(info: HeaderInfo, palette: Palette, gradient: () => boolean);
    /**
     * Clip every banner row to `width` columns (the sweep reveal); `undefined`
     * restores the full banner. The clip changes no row count, so the screen
     * does not move while the sweep runs — the box and its art wipe in
     * left-to-right over a frame that already has its final height.
     * @param width - Revealed width in columns, or `undefined` for the whole banner.
     */
    setRevealWidth(width: number | undefined): void;
    invalidate(): void;
    render(width: number): string[];
    /** The wordmark fragment: gradient brand name, bold product name, dim version. */
    private wordmark;
    /** The `resumed <id> · <title>` line, or `undefined` on a fresh session. */
    private resumedLine;
    /**
     * The two-column welcome box, in the shape of Claude Code's full startup
     * frame: the wordmark spliced into the top border, the left panel centering
     * the welcome line, the large whale, and the identity lines, and the right
     * panel spending the box's height on the skill summary.
     *
     * ```text
     *  ╭─ DEEPSEEK HARNESS v0.1.0 ────────────────────────────────╮
     *  │                          │ [Skills]                      │
     *  │      ▗▄▄▄██  █▄▜▙▖       │ lark-doc, lark-base, hotcli   │
     *  │     ▟████▙▟█▄▝█▛▀        │ meego-tech-story, +12 more    │
     *  │     █   ▀▜█▙▝██▘         │                               │
     *  │     ▝▙▖ ▗▖▀███▘          │                               │
     *  │      ▝▀███▙▟▀▀▘          │                               │
     *  │                          │                               │
     *  │   deepseek-v4-pro        │                               │
     *  │   ~/src/project          │                               │
     *  ╰──────────────────────────┴───────────────────────────────╯
     * ```
     *
     * @param width - Render width in columns.
     * @returns Every banner row, or `undefined` when the entry supplied no skill
     * list — with nothing to spend the right panel on, the badge box says the
     * same thing in a third of the rows.
     */
    private renderFull;
    /**
     * The bordered banner: whale art beside the identity lines inside a dim
     * rounded frame, then the welcome line and skill section below it.
     * @param width - Render width in columns.
     * @returns Every banner row, already indented.
     */
    private renderBoxed;
    /**
     * The borderless narrow-terminal banner: the same lines the box carries,
     * stacked as plain left-padded text with no art.
     * @param width - Render width in columns.
     * @returns Every banner row, already indented.
     */
    private renderPlain;
    /**
     * What renders under the identity block in either shape: the configured
     * welcome line, then the skill section.
     * @param width - Render width in columns.
     * @returns The trailing rows, already indented.
     */
    private trailer;
    /**
     * The skill names with something to show: a blank entry would render as a
     * stray `, ,` in either summary shape.
     */
    private skillNames;
    /** The plugin module names with something to show, read fresh per render. */
    private pluginNames;
    /**
     * One borderless summary section (`[Skills]`, `[Plugins]`): its label row and
     * the packed name rows, or nothing when there is nothing to list.
     * @param usable - Columns a banner row may occupy.
     * @param label - The section's bracket label.
     * @param names - The names to pack, in the order the entry supplied them.
     * @returns The section's rows, led by the blank row that separates it.
     */
    private sectionRows;
}
/**
 * A user or steering prompt in the transcript, rendered as Claude Code's
 * borderless filled block: the `❯ ` pointer and then the prompt **as typed**, on
 * the theme's user-message fill with one column of padding, which is what marks
 * the user's own turns in a long transcript.
 *
 * The text is deliberately not a Markdown document. Upstream renders a user
 * message through `HighlightedThinkingText`, which is plain `<Text>` with the
 * pointer in front — only assistant output goes through `<Markdown>`. This port
 * used to typeset it with pi-tui's Markdown while the answer above it went
 * through the claude pipeline, so the same `$x^2$`, the same `*` and the same
 * `#` came out one way in the question and another in the answer, and a prompt
 * that quoted markup was rewritten before the user could check what they had
 * sent. Echoing the prompt verbatim also removes the second dialect from the
 * transcript entirely: one renderer, on assistant text alone.
 *
 * `_label` is retained from the boxed frame this replaced (no caller ever passed
 * it): Claude Code's block names no role, so nothing is rendered for it.
 */
export declare class UserMessageComponent implements Component {
    private readonly palette;
    /** The pointer and body, already sanitized; wrapped per width at render. */
    private readonly text;
    private readonly fill;
    private cached;
    /**
     * @param text - The prompt as submitted.
     * @param palette - Active role palette.
     * @param scheme - Terminal color scheme, which picks the fill.
     * @param _label - Unused role name; see the class note.
     */
    constructor(text: string, palette: Palette, scheme?: TerminalColorScheme, _label?: string);
    invalidate(): void;
    render(width: number): string[];
}
/**
 * The one permanent sign that this session is in plan mode: the badge Claude
 * Code keeps at the left of the row under its input frame, in the theme's plan
 * tone.
 *
 * The mode reaches this terminal as a folded `plan/mode` event and nothing on
 * screen consumed it, so a session could sit in plan mode with the transcript
 * and the prompt looking exactly as they do outside it — the user found out
 * when the agent declined to edit. Upstream's badge is the whole visual
 * treatment, deliberately: the input border does NOT change color in plan mode
 * (`PromptInput.tsx:2214-2235` routes only bash and teammate colors), so a
 * colored frame here would be a signal the product does not have.
 *
 * Upstream's trailing `(shift+tab to cycle)` hint used to be dropped here,
 * because plan mode was only ever set through the session log and this terminal
 * bound no key that cycled modes. `app.mode.cycle` is that key, so the hint is
 * back — named from the installed keybinding manager by the caller, never
 * written out, so a deployment that rebinds the action gets its own key printed.
 * @param palette - Active role palette; decides whether the tone is emitted.
 * @param scheme - Terminal color scheme, which picks the plan tone.
 * @param hint - The cycle hint, already parenthesised and translated.
 * @param pending - True when the mode was selected during a running turn and
 *   commits at the next accepted pre-step (no `plan/mode` event yet). The badge
 *   says so rather than pretending the mode is already in force.
 * @returns The badge row, ready to render above the prompt.
 */
export declare function planModeRow(palette: Palette, scheme?: TerminalColorScheme, hint?: string, pending?: boolean): string;
/**
 * The sign that this session runs its tool calls without asking: the
 * auto-accept preset's badge, in upstream's electric violet.
 *
 * Named `auto-accept` rather than upstream's `accept edits`, because the state
 * behind it is wider than editing: the preset sets `approval/policy` to `never`,
 * so every tool this agent has runs unattended inside the workspace sandbox, not
 * just the file writers. A badge that promised only edits would understate what
 * the user just switched on.
 * @param palette - Active role palette; decides whether the tone is emitted.
 * @param scheme - Terminal color scheme, which picks the auto-accept tone.
 * @param hint - The cycle hint, already parenthesised and translated.
 * @returns The badge row, ready to render above the prompt.
 */
export declare function autoAcceptRow(palette: Palette, scheme?: TerminalColorScheme, hint?: string): string;
/**
 * Claude Code's past-tense turn verbs, copied from its
 * `src/constants/turnCompletionVerbs.ts`. One is sampled per turn and reads as
 * `<verb> for <duration>`.
 */
export declare const TURN_COMPLETION_VERBS: readonly string[];
/**
 * Wall time a turn must exceed before it prints a completion row at all
 * (`REPL.tsx:2974` — `turnDurationMs > 30000`). Anything shorter says nothing:
 * the user watched it happen.
 */
export declare const TURN_FOOTER_MIN_MS = 30000;
/**
 * Format a turn's wall time the way Claude Code's `formatDuration` does: whole
 * seconds under a minute (`45s`), minutes and seconds above it (`1m 23s`), and
 * hours ahead of both for a run long enough to need them. A rounding carry
 * (59.6 s) is carried up rather than printed as `1m 60s`.
 * @param ms - Elapsed wall time in milliseconds.
 * @returns The formatted duration.
 */
export declare function formatTurnDuration(ms: number): string;
/**
 * One turn's verb, sampled uniformly like Claude Code's `sample()`. Sampled
 * once per turn by the caller and held for that turn's whole life, so the row
 * does not reword itself on a re-render.
 * @returns One of {@link TURN_COMPLETION_VERBS}.
 */
export declare function turnCompletionVerb(): string;
/**
 * Claude Code's turn completion row — `✻ Worked for 45s`, dim, the glyph in the
 * two-column gutter the product gives it (`<Box minWidth={2}>`), which here is
 * the column the assistant bullet occupies: this transcript indents every row
 * one column further than the product does, and this row is part of the
 * conversation rather than a diagnostic under it.
 *
 * It is the only timing the default transcript reports. Claude Code has no
 * per-message timing line anywhere, and prints this one only for a turn that
 * ran longer than {@link TURN_FOOTER_MIN_MS}.
 * @param durationMs - The turn's wall time.
 * @param palette - Active palette; the row is entirely in the recessed tone.
 * @param verb - The turn's verb, sampled when omitted.
 * @returns The row's styled text.
 */
export declare function turnFooterRow(durationMs: number, palette: Palette, verb?: string): string;
/**
 * A step's timing summary, rendered as a self-refreshing footer that stays at
 * the tail of the step's output. Kept separate from the assistant message so
 * the timing line trails any tool cards the step appends after its message.
 *
 * Claude Code has no per-step timing line at all, so this one renders only on
 * the expanded phase of the Ctrl+O cycle — the phase a user opens to inspect
 * the run. The default transcript keeps the per-turn row alone.
 */
declare class StepTimingComponent extends Container {
    private readonly position;
    private readonly events;
    private readonly tracker;
    private readonly now;
    private readonly palette;
    private visibility;
    private completionTime;
    constructor(position: StepPosition, events: () => readonly SessionEvent[], tracker: StepTimingTracker, now: () => number, palette: Palette, visibility: ToolCardVisibility);
    complete(time: number): void;
    /**
     * Set the Ctrl+O phase this footer renders under.
     * @param visibility - Hidden, collapsed preview, or full body.
     */
    setVisibility(visibility: ToolCardVisibility): void;
    invalidate(): void;
    private rebuild;
}
/** A live assistant step: streamed reasoning/text blocks until the message settles. */
export declare class StreamingAssistantComponent extends Container {
    /** The step's turn/step coordinates, used to group steps into their turn. */
    readonly position: StepPosition;
    private readonly showReasoning;
    private thinkingPinned;
    private visibility;
    private readonly palette;
    private readonly mdTheme;
    private readonly markdown;
    private readonly blocks;
    private settledContent;
    /** The last folded text applied through {@link setFoldedText}, for idempotence. */
    private foldedText;
    /** Whether this step's `assistant/message` has landed. */
    private settled;
    /** Whether the step closed, including one a cancelled turn closed unsettled. */
    private closed;
    /**
     * The step's timing footer. The renderer keeps it at the tail of the chat so
     * it trails any tool cards the step appends after this assistant message; it
     * is not a child of this component.
     */
    readonly timing: StepTimingComponent;
    constructor(
    /** The step's turn/step coordinates, used to group steps into their turn. */
    position: StepPosition, events: () => readonly SessionEvent[], tracker: StepTimingTracker, now: () => number, showReasoning: boolean, thinkingPinned: boolean, visibility: ToolCardVisibility, palette: Palette, mdTheme: MarkdownTheme, markdown: MarkdownPolicy);
    /**
     * Apply one step's folded text: the accumulated deltas while the step
     * streams, the settled message's text once it lands. Idempotent — an
     * unchanged triple rebuilds nothing — so a reconciler may call it for every
     * snapshot without re-rendering a step that did not move.
     * @param text - The step's response text so far, or its settled text.
     * @param reasoning - The step's reasoning text so far, or its settled reasoning.
     * @param settled - Whether the step's assistant message has landed.
     */
    setFoldedText(text: string, reasoning: string, settled: boolean): void;
    /**
     * Pin the step's timing footer to its completion time, and close the step:
     * its thinking is history from here, so the default transcript drops it —
     * unless Ctrl+T pinned it, which is what that key is for.
     * @param time - Step completion time in epoch milliseconds.
     */
    complete(time: number): void;
    invalidate(): void;
    /**
     * Pin or unpin this step's thinking block (Ctrl+T), then re-render.
     * @param pinned - Whether a finished step keeps its thinking on screen.
     */
    setThinkingPinned(pinned: boolean): void;
    /**
     * Set the Ctrl+O phase this step renders under: it decides whether a
     * finished step's thinking is on screen, and whether its timing footer is.
     * @param visibility - Hidden, collapsed preview, or full body.
     */
    setVisibility(visibility: ToolCardVisibility): void;
    /**
     * Whether this step's thinking block is on screen.
     *
     * Claude Code keeps thinking out of the default transcript entirely — a
     * finished message's thinking is `null`, with no summary row standing in for
     * it — and shows it only under ctrl+o (its transcript mode). The one window
     * where it is live is the step itself: while the model streams, the block is
     * what says work is happening, and this port keeps that text rather than the
     * product's spinner-only line. So the block is on screen while the step runs,
     * disappears with the step that produced it, and comes back whole on the
     * expanded phase.
     *
     * Ctrl+T pins that window open: with it on, every step's thinking stays on
     * screen — this turn's and every earlier one's — because the switch is over
     * the transcript rather than over the model, which thinks either way. It is
     * checked before the Ctrl+O phase and independently of it: the two are
     * separate switches over the same rows, and neither takes the other over.
     * Pinned thinking therefore survives the hidden phase, and expanded still
     * brings thinking back with the tool bodies while the pin is off.
     *
     * A configured `showReasoning: false` still means never, in any phase and
     * whatever the pin says: that setting predates the cycle and is a deployment
     * saying this transcript does not show reasoning at all.
     */
    private showsThinking;
    /** The settled content when available, otherwise the streamed blocks in model order. */
    private presentedContent;
    private rebuild;
}
/**
 * Ctrl+O card-visibility cycle: `hidden` drops tool cards from the transcript,
 * `collapsed` previews the first body lines, `expanded` shows everything.
 */
export type ToolCardVisibility = 'hidden' | 'collapsed' | 'expanded';
/**
 * Every phase, in the order Ctrl+O walks them: the two common reading modes
 * adjacent, then the conversation on its own. The `/config` row that sets the
 * default steps through this same list, so the two surfaces cannot end up
 * offering different words for the same three states.
 */
export declare const TOOL_CARD_PHASES: readonly ToolCardVisibility[];
/**
 * Transcript card with a width-keyed rendered-row cache. pi-tui re-renders
 * every component each frame and relies on per-component line caches (its own
 * `Text`/`Markdown` do this); a card that rebuilds rows inside `render(width)`
 * would re-wrap its output every frame
 * ([rationale](../../../../../.agents/notes/implemented/bug-fix/2026-08-03-tui-long-session-render-costs.md)).
 * Subclasses render through {@link renderLines} and call {@link dropLines}
 * from every state mutator; with `invalidate()` (pi-tui's tree-wide cascade)
 * also dropping, a state change always re-renders.
 */
declare abstract class CachedCardComponent implements Component {
    private cached;
    /** Discard the cached rows so the next render recomputes them. */
    protected dropLines(): void;
    invalidate(): void;
    render(width: number): string[];
    /**
     * Render the card's rows for `width` without caching.
     * @param width - Render width the rows are wrapped to.
     * @returns The card's rows.
     */
    protected abstract renderLines(width: number): string[];
}
/** A tool call and its result, rendered as a collapsible status card. */
export declare class ToolCardComponent extends CachedCardComponent {
    private readonly name;
    private readonly parsed;
    private readonly definition;
    private readonly maxOutputLines;
    private readonly maxDiffEditLength;
    private readonly palette;
    private readonly mdTheme;
    /**
     * The label of whichever key currently cycles tool cards, read per render
     * for the same reason the collapsed row reads it: `app.tools.cycle` is
     * rebindable, and a folded body that names the shipped default after a
     * deployment moved the binding points at a key that does nothing.
     */
    private readonly expandKey;
    private result;
    private visibility;
    private callView;
    private resultView;
    private diffBodyCache;
    constructor(name: string, parsed: ParsedArguments, definition: ToolDefinition | undefined, maxOutputLines: number, maxDiffEditLength: number, palette: Palette, mdTheme: MarkdownTheme, 
    /**
     * The label of whichever key currently cycles tool cards, read per render
     * for the same reason the collapsed row reads it: `app.tools.cycle` is
     * rebindable, and a folded body that names the shipped default after a
     * deployment moved the binding points at a key that does nothing.
     */
    expandKey: () => string);
    private presentCall;
    /**
     * Record an already-projected tool result and derive its result view. Takes
     * the result rather than the event so a folded node can drive the card
     * without re-deriving the event payload.
     * @param result - The model-facing blocks, the failure flag, and the tool's `meta`.
     */
    setResult(result: {
        content: ContentBlock[];
        isError: boolean;
        meta?: JsonValue;
    }): void;
    /**
     * Set the card's visibility state.
     * @param visibility - Hidden, collapsed preview, or full body.
     */
    setVisibility(visibility: ToolCardVisibility): void;
    protected renderLines(width: number): string[];
    /**
     * The card's one header row: `⏺ <tool>(<summary>)`. The bullet carries the
     * call's state as color (the brand blue while the call is in flight,
     * green settled, red failed) and the tool name is bold, so a transcript scans
     * as a list of what ran; the parenthesized summary is the call's own one-line
     * detail (a command, an edited path) in the recessed tone.
     */
    private headerRow;
    /**
     * The header's trailing detail: a terminal card's description (or its command
     * when it has none), and otherwise the presenter's title — skipped when the
     * title only repeats the tool name, which the header already shows.
     */
    private headerSummary;
    /** The pending terminal call view, when this row is a terminal card. */
    private terminalPending;
    /**
     * The card's body, split into the blocks the branch tree hangs off.
     * @param inner - Width available to a body row, after the branch prefix.
     * @param expanded - Whether the full body is shown.
     */
    private bodySections;
    /**
     * A terminal card's body: the command echo and its cwd as one block, the
     * captured output and exit status as another. Both keep the pre-Claude-Code
     * behaviour; only the output's truncation now goes through the shared preview.
     */
    private terminalSections;
    /**
     * A tool's own output text as dim rows under the collapsed preview budget —
     * the card's result-output color, which separates what the tool produced from
     * the card's own framing. A blank row stays the empty string so it reads as
     * blank rather than as an ANSI-wrapped value.
     */
    private previewOutput;
    /**
     * A diff card's body: each file's path, its rendered hunks, and one trailing
     * `+A -R` stat bar across every file. The rendered rows are already fitted to
     * the body width (they carry background fills that must not be re-wrapped), so
     * this section is marked `fitted` and the render is cached per width and fold
     * state — a diff is the one card body expensive enough to recompute.
     */
    private diffSection;
    /**
     * One file's parsed diff. A comparison beyond the edit-distance budget falls
     * back to whole-side rows (every old line removed, every new line added) so a
     * model-authored pending edit cannot stall the TUI; the caller labels that
     * fallback `approximate` because its totals are not exact change counts.
     */
    private parseFileDiff;
    /**
     * Every other card's body. A generic card's own content, a read card's
     * `content` fallback (the envelope-stripped file text — the TUI has no
     * dedicated read rendering, so a read renders exactly as before the read card
     * existed), or a search/web card's fallback to the raw result content (neither
     * view carries a `content` copy) all render as one dim Markdown document, so
     * links/lists/headings keep the unified dim styling rather than reading as
     * bare text.
     */
    private genericSections;
    /**
     * Render a card's result as one Markdown document under the dim body tone.
     * Rendering the body as one document preserves its own block spacing
     * (Markdown's blank row before a heading); dimming every row keeps the card
     * body one uniform tone, so only the header bullet carries status color.
     */
    private dimBody;
}
/**
 * Thinking a group has to have absorbed before its row says so.
 *
 * Under a second there is nothing to report: the duration prints as `0s`, and
 * `Thought for 0s, read 2 files` spends a clause on a pause the user could not
 * have noticed. The same floor applies while the thinking runs, so the fragment
 * appears when the counter has something to count rather than flickering in at
 * zero.
 */
export declare const COLLAPSE_THINKING_MIN_MS = 1000;
/**
 * Word one collapsed group's summary row.
 *
 * Present tense while the group runs (`Thinking for 4s, reading 1 file…`), past
 * tense once it settles (`Thought for 8s, searched for 2 patterns, read 1
 * file`). The first fragment opens with a capital, later ones do not, and each
 * fragment agrees with its own count — and with its own clock: a group whose
 * calls have all landed reads `Thinking for 4s, read 2 files…`, because the
 * files are read and the thought is not finished.
 *
 * The thinking the run opened with leads the sentence, because that is the
 * order it happened in: the model thought, then it went looking. A group that
 * absorbed no thinking prints no such fragment and reads exactly as before.
 * While the thinking is still open the row is in progress by definition, so
 * `now` is what makes its counter move between two events — the group carries
 * the span's start, not its length (see `groupThinkingMs`).
 *
 * Each fragment is one message rather than a verb and a noun joined here, so a
 * locale can move the count, drop the plural, or reorder the clause; the
 * capitalization is a no-op in a script without letter case.
 * @param group - The planned group.
 * @param now - Render clock, for a group whose thinking is still running.
 * @returns The row's text, without the expand hint.
 */
export declare function collapsedSummary(group: CollapsedGroup, now?: number): string;
/**
 * One run of read-only calls, rendered as the single row that replaces their
 * cards on the collapsed phase — Claude Code's `CollapsedReadSearchContent`.
 *
 * The row is the transcript's default answer to "what has it been doing": a
 * sentence of counts (`Searched for 3 patterns, read 2 files`) rather than one
 * card per file. While a call of the group is running the counts are
 * present-tense and a `⎿` row names the call in flight; while anything at all
 * is still going — a call, or the thinking the row absorbed — it keeps its
 * leading bullet and its ellipsis. Once both are over the bullet goes and the
 * whole row recedes, exactly as upstream. The group's own cards come back on
 * the expanded phase, where the reconciler mounts them instead of this row.
 *
 * The one addition to upstream's row: a group that contains a failed call keeps
 * its bullet, in the error color, after it settles. A collapsed row is the only
 * thing on screen for those calls, and a failure that leaves no mark at all is
 * a failure the user never learns about.
 *
 * The row also opens with the thinking that led to the run (`Thought for 8s,
 * read 2 files`), which is where this transcript states a thinking duration at
 * all — the thinking block itself keeps its own rule and disappears with the
 * step. While that thinking is still open the row re-renders per frame, so its
 * counter moves with the clock rather than with the next event.
 */
export declare class CollapsedGroupComponent extends CachedCardComponent {
    private group;
    private readonly palette;
    private readonly displayPath;
    private readonly expandKey;
    private readonly now;
    /**
     * @param group - The planned group this row reports.
     * @param palette - Active role palette.
     * @param displayPath - Shortens an absolute path for the `⎿` hint.
     * @param expandKey - The label of whichever key currently cycles tool cards,
     *   read per render: `app.tools.cycle` is rebindable, and a row that named
     *   the default key after a deployment moved it would send every reader to a
     *   key that does nothing.
     * @param now - Render clock, read per render so a group still thinking counts
     *   up; a group whose thinking has closed never consults it. Injected rather
     *   than defaulted to `Date.now`, like every other clock in this bundle: a
     *   row that reads the process clock cannot be rendered from a test.
     */
    constructor(group: CollapsedGroup, palette: Palette, displayPath: (path: string) => string, expandKey: () => string, now: () => number);
    /**
     * Apply the group's current counts; a running group re-seals on every
     * snapshot as its calls land.
     * @param group - The freshly planned group.
     */
    setGroup(group: CollapsedGroup): void;
    protected renderLines(width: number): string[];
    /**
     * The group's `⎿` hint, when it still names something that is happening.
     *
     * A call's path, pattern or command holds the row only while a call is
     * actually running; once they have all landed, the newest one is a finished
     * operation and pointing at it would claim work that is over. A thinking line
     * holds the row only while the thinking is open, for the same reason. A group
     * whose calls have settled under an open thought therefore shows no hint at
     * all unless the thought itself is what the group has to point at.
     * @returns The hint to render, or `undefined` for no hint row.
     */
    private hintInFlight;
}
/**
 * Injected context (plugin/goal source, e.g. `workspace-context`), rendered as a
 * dim card under a `Context · <label>` header, with a surrounding reminder frame
 * stripped because the source label already names the context.
 *
 * The card has one state, not two. It is mounted only by the expanded phase of
 * the Ctrl+O cycle ({@link ToolCardVisibility}), because this text was never
 * written for the user: it is the runtime snapshot and skill catalog the
 * producers hand the model on every request. Claude Code puts none of that in
 * the conversation, and the one-row `Context · <label> (ctrl+o)` placeholder
 * this card used to render collapsed still spent a row of every fresh screen —
 * and one per request thereafter — on traffic nobody reads. Ctrl+O is where a
 * user goes to see what the model was actually sent; until then the transcript
 * is the conversation and nothing else.
 *
 * Injected context is prose, not markup, so this card does not parse it. The
 * `<system-reminder>` frame is a prompting convention no model is trained on
 * ([envelope rationale](../../../../../.agents/notes/implemented/simplification/2026-07-20-unwrap-injected-content-envelopes.md)),
 * and instruction bodies legitimately contain a raw `&` or angle-bracket
 * placeholders (`packages/<group>/<pkg>/`, `-t <name>`) that are prose rather than
 * elements. Tree-rendering such a payload depended on whether it happened to be
 * well-formed XML, which made both the fold and the frame-line suppression
 * content-dependent.
 */
export declare class ContextCardComponent extends CachedCardComponent {
    private readonly label;
    private readonly text;
    private readonly palette;
    constructor(label: string, text: string, palette: Palette);
    protected renderLines(width: number): string[];
}
/**
 * The summary one compaction wrote, rendered on the expanded Ctrl+O phase.
 *
 * Same placement rule as a context card: it is what the model was left holding
 * rather than something anyone said, so the two default phases keep it off the
 * transcript and the expanded phase — where a user goes to see what the model
 * was actually sent — opens it in the conversation's own order, right under the
 * marker that says where the history stopped.
 *
 * Not capped, for the same reason a context card is not: the point of the card
 * is that the summary is now the whole of that history, and a summary clipped
 * mid-sentence would answer the question with another one.
 */
export declare class CompactionSummaryComponent extends CachedCardComponent {
    private readonly summary;
    private readonly palette;
    constructor(summary: string, palette: Palette);
    protected renderLines(width: number): string[];
}
/**
 * The plan/todo panel rendered above the prompt, expanded or collapsed.
 *
 * The panel used to be unconditional: any session whose agent wrote a plan paid
 * for it on every frame, with no key that took it back down. Ctrl+N collapses it
 * to a single summary row — what is left to do and what is being done now —
 * which is the same trade Claude Code offers, and the same one a long plan on a
 * short terminal forces anyway.
 */
export declare class TodoComponent implements Component {
    private readonly palette;
    private readonly terminalRows;
    private todos;
    private expanded;
    /**
     * @param palette - Active role palette.
     * @param terminalRows - The terminal's current height, read per render so a
     *   resize re-budgets the panel; the default leaves the panel unbounded for
     *   callers (tests, snapshots) that measure it on its own.
     */
    constructor(palette: Palette, terminalRows?: () => number);
    /**
     * Replace the rendered plan items.
     * @param todos - The current todo items.
     */
    update(todos: readonly TodoItem[]): void;
    /** Whether this session has a plan at all, which is what makes Ctrl+N meaningful. */
    hasTodos(): boolean;
    /** Whether the panel is showing its items rather than its one-line summary. */
    isExpanded(): boolean;
    /**
     * Show the items or the summary row.
     * @param expanded - `true` for the item list, `false` for the summary row.
     */
    setExpanded(expanded: boolean): void;
    invalidate(): void;
    /**
     * Items in display order, most urgent first, so a truncated panel drops the
     * least interesting rows rather than whatever happens to sort last.
     * @returns The items, in-progress first and completed last.
     */
    private ordered;
    /**
     * How many items the expanded panel may show on this terminal.
     * @returns The item budget; zero on a terminal with no room to spare.
     */
    private itemBudget;
    /** One item as its icon and text, already truncated to the width. */
    private renderItem;
    /** Counts of each status, for the summary and overflow rows. */
    private counts;
    /**
     * The collapsed row: how much of the plan is done, and what is being worked
     * on now (or what comes next when nothing is in flight).
     * @param width - Render width.
     * @returns The single summary row.
     */
    private renderSummary;
    render(width: number): string[];
}
export {};

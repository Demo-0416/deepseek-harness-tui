/**
 * Zero-state helpers for the interactive chat channel: prompt-directory and
 * Git-branch formatting, the placeholder editor, and banner-reveal timing
 * constants. None of these close over channel state. Log-derived presentation
 * (transcript rows, compaction markers, reference cards) belongs to the fold in
 * `core/nodes.ts`, not here.
 * @module @deepseek-ai/dsh-tui/chat/helpers
 */
import { Editor } from '@earendil-works/pi-tui';
/**
 * Editor that carries its prompt inside the frame and shows a placeholder
 * without making it editable content.
 *
 * Two pi-tui 0.84.1 render facts are load-bearing here, both pinned by
 * `tests/unit/editor-prompt.test.ts` so an upgrade that moves them fails loudly:
 *
 * - `Editor.render(width)` returns `[top frame, ...content rows, bottom frame,
 *   ...autocomplete rows]`. Row 0 is a rule (`─` repeated, or a `─── ↑ N more`
 *   scroll indicator), never text, so the first content row is row 1.
 * - Every content and autocomplete row opens with the editor's `paddingX`
 *   spaces. With `paddingX >= 1` — what the mounted editor is constructed with —
 *   a row whose first visible column is `─` can only be a frame row, which is
 *   how the two rules are found among rows this class has to indent instead.
 */
export declare class HintEditor extends Editor {
    /** Placeholder shown in the empty input row; `undefined` hides it. */
    hint: string | undefined;
    /**
     * Prompt rendered at the start of the first content row (Claude's `❯ `), ANSI
     * allowed. Continuation rows and the autocomplete popup indent by its visible
     * width and both rules grow by the same amount, so the frame keeps the full
     * render width and the text column never moves between rows.
     */
    promptPrefix: string;
    /**
     * Every prompt this editor has been given, newest first, under pi-tui's own
     * history rules (see {@link HintEditor.addToHistory}).
     *
     * pi-tui keeps its history private and exports no reader (`Editor.history` is
     * `private`, `EditorOptions` takes no seed), so the reverse-incremental search
     * Ctrl+R runs has to search a mirror. Feeding both from the one override is
     * what keeps the mirror and the arrow keys' history from disagreeing about
     * which prompt is the most recent.
     */
    private readonly entries;
    /**
     * The prompt history, newest first.
     *
     * Named around the parent's private `history` field rather than after it: an
     * instance field shadows a subclass method of the same name, so a `history()`
     * accessor here would be replaced by pi-tui's own array at construction.
     * @returns The mirrored entries; the array is the editor's own, so callers read it.
     */
    historyEntries(): readonly string[];
    /**
     * Record a submitted prompt, in pi-tui's history and in the searchable mirror.
     *
     * Deliberately duplicates the parent's three rules rather than approximating
     * them: entries are trimmed, blank ones are dropped, and a prompt equal to the
     * newest entry is not stored twice. A mirror that kept an entry the parent
     * dropped would make Ctrl+R offer a prompt the up arrow cannot reach.
     * @param text - The submitted prompt.
     */
    addToHistory(text: string): void;
    render(width: number): string[];
    /**
     * Render the editor frame, replacing the sole content row with the placeholder
     * while the input is empty.
     * @param width - Columns the frame occupies, with the prompt already deducted.
     * @returns The rendered rows, prompt not yet applied.
     */
    private renderFrame;
}
/**
 * Format the session working directory as a prompt label: `~` for home,
 * `~/rel` for a home-relative path, the raw path otherwise.
 * @param cwd - operational working directory from the session header.
 * @returns unescaped prompt label.
 */
export declare function formatCwd(cwd: string | undefined): string;
/**
 * Shorten a file path the way Claude Code's `getDisplayPath` does: relative to
 * the workspace when it is inside it, `~`-notated when it is under home, and
 * otherwise left absolute. A row that names a file the user just read should
 * read as the path they would type, not as the machine's copy of it.
 * @param path - the path to shorten; a relative one is returned unchanged.
 * @param cwd - operational working directory the path is shown against.
 * @returns the display form of the path.
 */
export declare function displayPath(path: string, cwd: string): string;
/**
 * Resolve the current Git branch for the prompt context line.
 * @param cwd - operational working directory to query.
 * @returns branch name, or `undefined` outside a worktree or on any failure.
 */
export declare function gitBranch(cwd: string): string | undefined;
/**
 * Shorten a session id for the resume banner line: `session-<uuid>` becomes the
 * uuid's first group, which is what a user types back into `--resume` and what
 * the session directory is named after. Any other identity (`main`, a launcher's
 * fixed name) is already short and is left exactly as it is.
 * @param id - the session identity.
 * @returns the display form of the id.
 */
export declare function shortSessionId(id: string): string;
/**
 * The profile this process was booted with, read back off its own command line.
 *
 * The launcher parses `--profile` itself and hands the app only the arguments
 * after it, so the name reaches no service this bundle can inject: `process.argv`
 * is the one place it survives. A run started some other way (an embedding host,
 * a test) has no `--profile` in its argv and gets `undefined` — the caller then
 * prints a command without the flag rather than inventing a profile name that
 * would not exist on this machine.
 * @param argv - the process command line; injectable so the parse can be tested.
 * @returns the profile name, or `undefined` when the invocation named none.
 */
export declare function launchProfileName(argv?: readonly string[]): string | undefined;
/**
 * The command that brings this exact session back, as the exiting terminal
 * prints it.
 *
 * The full session id, not the banner's shortened one: this line is meant to be
 * copied into a shell weeks later, where an abbreviation is a guess about how
 * the store resolves prefixes.
 * @param sessionId - the session the command would resume.
 * @param profile - the booted profile; absent drops the flag from the command.
 * @returns the command line, ready to paste.
 */
export declare function resumeCommandLine(sessionId: string, profile?: string | undefined): string;
/**
 * This bundle's version, for the startup banner.
 *
 * Read from the nearest package.json above the running module rather than
 * imported, because the two layouts this code runs in disagree on the relative
 * path: `src/chat/helpers.ts` under tsx, one bundled `lib/index.js` after
 * build. Neither layout has a package.json between the module and the package
 * root, so the first one found walking up is this package's. A version that
 * cannot be read is not an error — the banner simply omits it.
 * @param from - file the search starts from; defaults to this module.
 * @returns the semver string, or `undefined` when no package.json was readable.
 */
export declare function packageVersion(from?: string): string | undefined;
/** Milliseconds between banner sweep-reveal frames (~60 fps). */
export declare const BANNER_REVEAL_INTERVAL_MS = 15;
/** Number of sweep frames the banner reveal spreads the terminal width over. */
export declare const BANNER_REVEAL_STEPS = 24;
/**
 * How much of the wordmark the sweep has uncovered after `frame` frames.
 *
 * A pure function of the frame and the width it is asked about, so the caller
 * can re-read the terminal every frame: the sweep is always the same fraction of
 * the CURRENT width, and a terminal resized mid-sweep stays aligned instead of
 * wiping toward the width the animation started at.
 * @param frame - Frames elapsed since the sweep began, starting at 1.
 * @param columns - The terminal's current width.
 * @returns Columns revealed, never past the width itself.
 */
export declare function bannerRevealWidth(frame: number, columns: number): number;

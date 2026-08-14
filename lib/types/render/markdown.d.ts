/**
 * Claude Code's markdown-to-ANSI pipeline, ported from `utils/markdown.ts`
 * (`formatToken`) and `components/Markdown.tsx` (block spacing, the table
 * exception, the no-syntax fast path) as a pure module: no React, no Ink, no
 * global `marked` mutation.
 *
 * Four deliberate departures from the upstream source:
 *
 * - Styling is injected. Upstream hard-codes `chalk` plus a theme lookup;
 *   here every visual decision is a {@link MarkdownAnsiTheme} function, and
 *   {@link claudeMarkdownTheme} reproduces the upstream choices on top of
 *   {@link ../render/palette.ts | CLAUDE_COLORS}.
 * - Rendering is synchronous and returns wrapped rows rather than one joined
 *   string, so a pi-tui component can render inside its own `render(width)`
 *   pass. Syntax highlighting is therefore not bundled: upstream resolves
 *   `cli-highlight` behind a React `Suspense` boundary and re-renders when it
 *   lands, which a synchronous `render(width)` has no equivalent of. A fenced
 *   block is styled as a block instead — indented and in Claude Code's own code
 *   tone, the same tone an inline codespan gets — and a host that wants real
 *   per-token highlighting injects a synchronous {@link MarkdownHighlighter}
 *   through {@link MarkdownRenderOptions.highlight}.
 * - Wrapping is delegated to pi-tui's `wrapTextWithAnsi`, which is ANSI-, OSC 8-
 *   and East-Asian-width-aware. Nothing here computes a column count by hand.
 * - Three upstream bugs are not reproduced: a task-list checkbox token used to
 *   contribute a bare indent (and no `[ ]` marker) to its list item; a `del`
 *   token is dropped by disabling the tokenizer on a *private* `Marked`
 *   instance instead of on the shared singleton; and the markdown sniff reads
 *   the whole string rather than its first 500 characters, which is the
 *   difference between rendering and not rendering a Chinese answer (see
 *   {@link hasMarkdownSyntax}).
 *
 * Tables are a monospace text block with the upstream React component's own
 * glyphs and column algorithm (`MarkdownTable.tsx`: box-drawing borders, `│`
 * walls, centered header): the widths are fitted to the render width and cell
 * content wraps inside its column, because a table padded to its widest cell
 * is re-wrapped by the caller the moment it is wider than the terminal, and a
 * re-wrapped table is a wall of stray glyphs.
 * @module @deepseek-ai/dsh-tui/render/markdown
 */
/**
 * Every visual decision the renderer makes, as a styling function.
 *
 * All slots are `(text: string) => string`; {@link MarkdownAnsiTheme.heading}
 * additionally receives the heading level, which a plain `string => string`
 * function may simply ignore.
 */
export interface MarkdownAnsiTheme {
    /**
     * A heading's text.
     * @param text - The already-formatted heading content.
     * @param depth - Heading level, 1–6.
     */
    readonly heading: (text: string, depth: number) => string;
    /** `**strong**` emphasis. */
    readonly bold: (text: string) => string;
    /** `*em*` emphasis, and the body of a blockquote line. */
    readonly italic: (text: string) => string;
    /** An inline `` `codespan` ``. */
    readonly code: (text: string) => string;
    /**
     * One line of a fenced code block that no highlighter covered. Applied per
     * line rather than per block so every wrapped row carries its own color: a
     * single span opened around a whole block ends at the first row break.
     */
    readonly codeBlock: (text: string) => string;
    /** A link's display text (inside the OSC 8 sequence, when hyperlinks are on). */
    readonly link: (text: string) => string;
    /** The `▎` bar prefixed to each blockquote line. */
    readonly quote: (text: string) => string;
    /** A list marker: `-`, `1.`, `a.`, or `i.`. */
    readonly listBullet: (text: string) => string;
    /** A thematic break. */
    readonly hr: (text: string) => string;
}
/**
 * Claude Code's own styling, on {@link ../render/palette.ts | CLAUDE_COLORS}.
 *
 * `codeBlock` paints a fenced block in the same tone as an inline codespan.
 * Upstream leaves it unstyled because `cli-highlight` colors it token by token;
 * with no highlighter that fallback is *literally* indistinguishable from
 * prose, so the block keeps the one color the product already reads as code.
 * `listBullet` is intentionally identity — upstream renders a list marker at
 * plain text weight. `hr` is dimmed: a rule is chrome, and at full weight it
 * reads as content.
 */
export declare const claudeMarkdownTheme: MarkdownAnsiTheme;
/**
 * A synchronous syntax highlighter for a fenced code block.
 * @param code - The block body, without its fences.
 * @param language - The fence's language id.
 * @returns The highlighted block, or `undefined` to render it plain.
 */
export type MarkdownHighlighter = (code: string, language: string) => string | undefined;
/** Knobs that are not styling. */
export interface MarkdownRenderOptions {
    /**
     * Highlighter for fenced code blocks. With none — the default — a block is
     * styled line by line through {@link MarkdownAnsiTheme.codeBlock}. A
     * highlighter is only ever consulted for a fence that named its language.
     */
    readonly highlight?: MarkdownHighlighter;
    /**
     * Emit OSC 8 hyperlinks for links. When `false`, a link degrades to its bare
     * URL — upstream's fallback on terminals without hyperlink support.
     * @defaultValue `true`
     */
    readonly hyperlinks?: boolean;
}
/**
 * Whether `text` contains anything the lexer would treat as markdown.
 *
 * The whole string is scanned. Upstream samples the first 500 characters on the
 * theory that markdown announces itself early, but that theory is written for
 * English: a Chinese answer opens with a paragraph that carries no ASCII marker
 * at all, and the table or fence it ends with lands well past character 500.
 * The document then renders as one plain paragraph — raw pipes, raw fences —
 * and because the sniff is monotone in nothing, every streamed delta re-decides
 * the same way and the answer never converts. One `O(n)` regex pass against a
 * misrendered answer is not a trade; the render itself is cached per
 * `(text, width)` by the component that mounts it.
 * @param text - The candidate source.
 * @returns `true` when the full lexer is needed.
 */
export declare function hasMarkdownSyntax(text: string): boolean;
/**
 * Render markdown to ANSI rows, already wrapped to `width`.
 *
 * Plain text with no markdown markers skips the parser entirely and is wrapped
 * as one paragraph.
 * @param text - The markdown source.
 * @param width - Terminal columns available; values below 1 are clamped.
 * @param theme - Styling functions; defaults to {@link claudeMarkdownTheme}.
 * @param options - Highlighter and hyperlink policy.
 * @returns One entry per terminal row, with a blank row between blocks. Empty
 * input renders as no rows at all.
 */
export declare function renderMarkdownAnsi(text: string, width: number, theme?: MarkdownAnsiTheme, options?: MarkdownRenderOptions): string[];

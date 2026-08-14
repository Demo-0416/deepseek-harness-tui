/**
 * Claude Code's exact color values and the truecolor ANSI helpers the render
 * package paints with. These are fixed 24-bit brand colors taken from the
 * official claude-code dark theme, deliberately outside the theme-adaptive
 * {@link ../components/theme.ts | role palette}: a Claude Code transcript is
 * recognizable by these particular tones (the orange bullet, the diff greens),
 * so they must not remap with the terminal's own scheme.
 *
 * Every helper closes only the SGR group it opens — foreground spans close with
 * `39`, background spans with `49`, attributes with their own reset — so a span
 * nested inside a caller's bold/dim never clears the caller's attribute the way
 * a bare `ESC[0m` would.
 * @module @deepseek-ai/dsh-tui/render/palette
 */
/** A 24-bit color's channels, each 0–255. */
export interface Rgb {
    readonly r: number;
    readonly g: number;
    readonly b: number;
}
/**
 * The Claude Code dark theme's exact palette. Names mirror the upstream theme
 * keys so a value can be traced back to the product it was taken from.
 */
export declare const CLAUDE_COLORS: {
    /** The brand orange: the assistant bullet, the spinner verb, an in-progress todo. */
    readonly claude: Rgb;
    /** A settled, successful tool call. */
    readonly success: Rgb;
    /** A failed tool call, and a signal/exit-status pill. */
    readonly error: Rgb;
    /** A warning row (a capped display, a degraded render). */
    readonly warning: Rgb;
    /** The recessed status tone: elapsed time, token counts, fold hints. */
    readonly inactive: Rgb;
    /** A permission prompt's accent. */
    readonly permission: Rgb;
    /** Plan-mode chrome, on a dark terminal; see {@link claudeSchemeColors}. */
    readonly planMode: Rgb;
    /** Auto-accept chrome, on a dark terminal; see {@link claudeSchemeColors}. */
    readonly autoAccept: Rgb;
    /**
     * Background fill behind a user message on a dark terminal, the block that
     * marks the user's own turns; see {@link claudeSchemeColors}.
     */
    readonly userMessageBg: Rgb;
    /** Muted outline of a bordered surface. */
    readonly borderMuted: Rgb;
    /** Tool branch connectors (`├ └ │`), a fixed gray independent of the terminal theme. */
    readonly branch: Rgb;
    /** An added line's background fill in a diff. */
    readonly diffAddedBg: Rgb;
    /** A removed line's background fill in a diff. */
    readonly diffRemovedBg: Rgb;
    /** The word-level added highlight inside an added line. */
    readonly diffAddedWordBg: Rgb;
    /** The word-level removed highlight inside a removed line. */
    readonly diffRemovedWordBg: Rgb;
    /** An added line's sign, gutter number, and stat-bar segment. */
    readonly diffAddedFg: Rgb;
    /** A removed line's sign, gutter number, and stat-bar segment. */
    readonly diffRemovedFg: Rgb;
    /** Diff chrome: separators, the `…` clip marker, context text. */
    readonly diffDim: Rgb;
    /** Diff gutter line numbers. */
    readonly diffLineNumber: Rgb;
    /** Diff horizontal rules and the split divider. */
    readonly diffRule: Rgb;
    /** The `╱` fill of an absent split-view side. */
    readonly diffStripe: Rgb;
    /** Replacement foreground for highlighted code too dark to read on a diff fill. */
    readonly diffSafeMuted: Rgb;
};
/**
 * The three Claude Code colors that cannot be one fixed brand tone.
 *
 * Everything else in {@link CLAUDE_COLORS} is a foreground the product keeps
 * across its themes, so it reads on any background. These do not: a fill is
 * only legible against the terminal's own background, and the two mode tones
 * are mid colors that upstream darkens for a light theme (`utils/theme.ts` —
 * plan dark `rgb(72,150,140)`, light `rgb(0,102,102)`; auto-accept dark
 * `rgb(175,135,255)`, light `rgb(135,0,255)`). Left at their dark values on a
 * white terminal, the user's own prompts turn into a dark bar with dark text on
 * it and the mode badges wash out — which is exactly what the fixed fill did.
 */
export interface ClaudeSchemeColors {
    /** Background fill behind a user message. */
    readonly userMessageBg: Rgb;
    /** Plan-mode chrome: the mode badge and the plan blocks that carry it. */
    readonly planMode: Rgb;
    /** Auto-accept chrome: the mode badge shown while approval is not asked for. */
    readonly autoAccept: Rgb;
}
/**
 * Claude Code's own values for the scheme-dependent colors, taken from its
 * `darkTheme` and `lightTheme`.
 *
 * Returned as a fresh object per call so a caller can hold one and refresh it
 * in place (`Object.assign`) when the terminal reports a scheme change, the way
 * the role {@link ../components/theme.ts | Palette} is refreshed.
 * @param scheme - The terminal's reported color scheme.
 * @returns The fill and the two mode tones for that scheme.
 */
export declare function claudeSchemeColors(scheme: 'dark' | 'light'): ClaudeSchemeColors;
/** Reset every SGR group. Only for a span that owns the whole line. */
export declare const RESET = "\u001B[0m";
/** Close a foreground span without touching background or attributes. */
export declare const FG_DEFAULT = "\u001B[39m";
/** Close a background span without touching foreground or attributes. */
export declare const BG_DEFAULT = "\u001B[49m";
/** Open bold. */
export declare const BOLD = "\u001B[1m";
/** Open dim. */
export declare const DIM = "\u001B[2m";
/** Open italic. */
export declare const ITALIC = "\u001B[3m";
/** Open strike-through. */
export declare const STRIKE = "\u001B[9m";
/**
 * The truecolor foreground escape for a color.
 * @param color - The color to open.
 * @returns The SGR sequence, with no closing sequence.
 */
export declare function fgAnsi(color: Rgb): string;
/**
 * The truecolor background escape for a color.
 * @param color - The color to open.
 * @returns The SGR sequence, with no closing sequence.
 */
export declare function bgAnsi(color: Rgb): string;
/**
 * Paint text in a truecolor foreground, closing only the foreground group.
 * @param color - The foreground color.
 * @param text - Text to paint.
 * @returns The painted text.
 */
export declare function fg(color: Rgb, text: string): string;
/**
 * Fill text with a truecolor background, closing only the background group.
 * @param color - The background color.
 * @param text - Text to fill.
 * @returns The filled text.
 */
export declare function bg(color: Rgb, text: string): string;
/** Bold text, preserving any color the caller applied. */
export declare function bold(text: string): string;
/** Dim text, preserving any color the caller applied. */
export declare function dim(text: string): string;
/** Italic text, preserving any color the caller applied. */
export declare function italic(text: string): string;
/** Struck-through text, preserving any color the caller applied. */
export declare function strike(text: string): string;
/**
 * Parse a truecolor foreground/background escape back into channels.
 * @param ansi - A string that may open with a `38;2;r;g;b` or `48;2;r;g;b` SGR.
 * @returns The channels, or `undefined` when `ansi` carries no truecolor open.
 */
export declare function parseAnsiRgb(ansi: string): Rgb | undefined;

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
  readonly r: number
  readonly g: number
  readonly b: number
}

/** Build an {@link Rgb} from three channels. */
function rgb(r: number, g: number, b: number): Rgb {
  return { r, g, b }
}

/**
 * The Claude Code dark theme's exact palette. Names mirror the upstream theme
 * keys so a value can be traced back to the product it was taken from.
 */
export const CLAUDE_COLORS = {
  /** The brand orange: the assistant bullet, the spinner verb, an in-progress todo. */
  claude: rgb(215, 119, 87),
  /** A settled, successful tool call. */
  success: rgb(78, 186, 101),
  /** A failed tool call, and a signal/exit-status pill. */
  error: rgb(255, 107, 128),
  /** A warning row (a capped display, a degraded render). */
  warning: rgb(255, 193, 7),
  /** The recessed status tone: elapsed time, token counts, fold hints. */
  inactive: rgb(153, 153, 153),
  /** A permission prompt's accent. */
  permission: rgb(177, 185, 249),
  /** Plan-mode chrome. */
  planMode: rgb(72, 150, 140),
  /** Background fill behind a user message (unused by the transcript's box, kept for parity). */
  userMessageBg: rgb(55, 55, 55),
  /** Muted border of the user message box and other outlines. */
  borderMuted: rgb(68, 68, 68),
  /** Tool branch connectors (`├ └ │`), a fixed gray independent of the terminal theme. */
  branch: rgb(72, 72, 72),
  /** An added line's background fill in a diff. */
  diffAddedBg: rgb(34, 92, 43),
  /** A removed line's background fill in a diff. */
  diffRemovedBg: rgb(122, 41, 54),
  /** The word-level added highlight inside an added line. */
  diffAddedWordBg: rgb(56, 166, 96),
  /** The word-level removed highlight inside a removed line. */
  diffRemovedWordBg: rgb(179, 89, 107),
  /** An added line's sign, gutter number, and stat-bar segment. */
  diffAddedFg: rgb(100, 180, 120),
  /** A removed line's sign, gutter number, and stat-bar segment. */
  diffRemovedFg: rgb(200, 100, 100),
  /** Diff chrome: separators, the `…` clip marker, context text. */
  diffDim: rgb(80, 80, 80),
  /** Diff gutter line numbers. */
  diffLineNumber: rgb(100, 100, 100),
  /** Diff horizontal rules and the split divider. */
  diffRule: rgb(50, 50, 50),
  /** The `╱` fill of an absent split-view side. */
  diffStripe: rgb(40, 40, 40),
  /** Replacement foreground for highlighted code too dark to read on a diff fill. */
  diffSafeMuted: rgb(139, 148, 158),
} as const satisfies Record<string, Rgb>

/** Reset every SGR group. Only for a span that owns the whole line. */
export const RESET = '\x1b[0m'
/** Close a foreground span without touching background or attributes. */
export const FG_DEFAULT = '\x1b[39m'
/** Close a background span without touching foreground or attributes. */
export const BG_DEFAULT = '\x1b[49m'
/** Open bold. */
export const BOLD = '\x1b[1m'
/** Open dim. */
export const DIM = '\x1b[2m'
/** Open italic. */
export const ITALIC = '\x1b[3m'
/** Open strike-through. */
export const STRIKE = '\x1b[9m'

/**
 * The truecolor foreground escape for a color.
 * @param color - The color to open.
 * @returns The SGR sequence, with no closing sequence.
 */
export function fgAnsi(color: Rgb): string {
  return `\x1b[38;2;${color.r};${color.g};${color.b}m`
}

/**
 * The truecolor background escape for a color.
 * @param color - The color to open.
 * @returns The SGR sequence, with no closing sequence.
 */
export function bgAnsi(color: Rgb): string {
  return `\x1b[48;2;${color.r};${color.g};${color.b}m`
}

/**
 * Paint text in a truecolor foreground, closing only the foreground group.
 * @param color - The foreground color.
 * @param text - Text to paint.
 * @returns The painted text.
 */
export function fg(color: Rgb, text: string): string {
  return `${fgAnsi(color)}${text}${FG_DEFAULT}`
}

/**
 * Fill text with a truecolor background, closing only the background group.
 * @param color - The background color.
 * @param text - Text to fill.
 * @returns The filled text.
 */
export function bg(color: Rgb, text: string): string {
  return `${bgAnsi(color)}${text}${BG_DEFAULT}`
}

/**
 * Wrap text in one SGR attribute pair.
 * @param open - The opening sequence (one of {@link BOLD}, {@link DIM}, …).
 * @param text - Text to wrap.
 * @returns The wrapped text, closed with the matching attribute reset.
 */
function attribute(open: string, text: string): string {
  const close = open === BOLD || open === DIM ? '\x1b[22m' : open === ITALIC ? '\x1b[23m' : '\x1b[29m'
  return `${open}${text}${close}`
}

/** Bold text, preserving any color the caller applied. */
export function bold(text: string): string {
  return attribute(BOLD, text)
}

/** Dim text, preserving any color the caller applied. */
export function dim(text: string): string {
  return attribute(DIM, text)
}

/** Italic text, preserving any color the caller applied. */
export function italic(text: string): string {
  return attribute(ITALIC, text)
}

/** Struck-through text, preserving any color the caller applied. */
export function strike(text: string): string {
  return attribute(STRIKE, text)
}

/**
 * Parse a truecolor foreground/background escape back into channels.
 * @param ansi - A string that may open with a `38;2;r;g;b` or `48;2;r;g;b` SGR.
 * @returns The channels, or `undefined` when `ansi` carries no truecolor open.
 */
export function parseAnsiRgb(ansi: string): Rgb | undefined {
  const match = /\x1b\[[34]8;2;(\d{1,3});(\d{1,3});(\d{1,3})m/u.exec(ansi)
  if (match === null) return undefined
  const [, r = '0', g = '0', b = '0'] = match
  return rgb(Number(r), Number(g), Number(b))
}

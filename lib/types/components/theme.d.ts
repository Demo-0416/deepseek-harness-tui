/**
 * Theme-agnostic ANSI palette and derived pi-tui themes for the terminal front
 * door. The palette is built from the standard 16-color ANSI set plus SGR
 * attributes so every terminal remaps it to its active color scheme.
 * @module @deepseek-ai/dsh-tui/components/theme
 */
import type { MarkdownTheme, SelectListTheme, TerminalColorScheme } from '@earendil-works/pi-tui';
/**
 * Text carrying exactly one palette color. Branded so the compiler rejects
 * wrapping it in a second color: SGR has no color stack, so an inner span's
 * close reverts to the default foreground rather than the outer color, which
 * silently drops the outer color for the remainder of the line.
 */
export type Colored = string & {
    readonly __coloredBy: unique symbol;
};
/**
 * Text a color may still be applied to: a bare string, or one already carrying
 * SGR attributes. Attributes (bold, italic, underline, strike, reverse) occupy
 * independent SGR groups from the foreground color, so they compose in either
 * order without either side clobbering the other.
 */
export type Colorable = string & {
    readonly __coloredBy?: undefined;
};
/** Applies one color role; rejects input that already carries a color. */
export type ColorRole = (text: Colorable) => Colored;
/** Applies one SGR attribute; accepts colored or uncolored text and preserves its color. */
export type AttributeRole = <T extends string>(text: T) => T;
/**
 * Theme-agnostic role colors and SGR attribute wrappers.
 *
 * One role per visual meaning: `dim` is the single recessed tone, `accent` the
 * single emphasis color, and `success`/`error` double as a diff's added/removed
 * pair. Roles that resolved to the same escape were merged rather than kept as
 * aliases, so a reader cannot pick a name that silently renders as another.
 *
 * Colors and attributes are separately typed: `bold(accent(x))` and
 * `accent(bold(x))` both compile, while `accent(error(x))` does not.
 */
export interface Palette {
    accent: ColorRole;
    /** DeepSeek brand ink; exact gradient callers may override it on truecolor terminals. */
    brand: ColorRole;
    /** The terminal's own default foreground; still a color, so it does not stack. */
    text: ColorRole;
    /** The one recessed tone, below `text`: tool-card bodies, chrome, reasoning, footers. */
    dim: ColorRole;
    success: ColorRole;
    warning: ColorRole;
    error: ColorRole;
    code: ColorRole;
    bold: AttributeRole;
    italic: AttributeRole;
    underline: AttributeRole;
    strike: AttributeRole;
    /** Reverse video for the active selection; swaps the theme's own fg/bg so it reads on any scheme. */
    selected: AttributeRole;
}
/** Names of the palette's color roles, in the order `/palette` prints them. */
export declare const COLOR_ROLES: readonly ["text", "dim", "accent", "brand", "code", "success", "warning", "error"];
/** Names of the palette's attribute roles, in the order `/palette` prints them. */
export declare const ATTRIBUTE_ROLES: readonly ["bold", "italic", "underline", "strike", "selected"];
/** One role's SGR parameters and the reason it carries them. */
export interface RoleSpec {
    /** SGR parameters that open the span, without the `ESC [` prefix or `m` suffix. */
    readonly open: string;
    /** SGR parameters that close it; MUST reset every group `open` sets. */
    readonly close: string;
    /** What the role means, shown by `/palette`. */
    readonly purpose: string;
}
/**
 * Every SGR code the TUI is allowed to emit, keyed by role. This table is the
 * single source: {@link createPalette} derives the wrappers from it and
 * `/palette` prints it, so a role cannot exist in one and not the other, and no
 * component hand-writes an escape.
 *
 * Only the standard 16-color set and SGR attributes appear here. Terminals remap
 * those to the user's active theme, so the TUI stays legible on any background;
 * a fixed 24-bit color would not. The startup gradient and exact official mark
 * color are the two deliberate brand exceptions ({@link gradientText},
 * {@link brandText}).
 *
 * @param scheme - Active terminal color scheme; only `code` differs between them.
 * @returns The SGR spec for every color and attribute role.
 */
export declare function paletteSpec(scheme: TerminalColorScheme): {
    readonly colors: Readonly<Record<typeof COLOR_ROLES[number], RoleSpec>>;
    readonly attributes: Readonly<Record<typeof ATTRIBUTE_ROLES[number], RoleSpec>>;
};
/**
 * Theme-agnostic palette derived from {@link paletteSpec}. Body `text` stays the
 * terminal's default foreground so it reads on light and dark backgrounds alike;
 * grouping uses foreground-only bold, underlined role headers and reverse video
 * rather than fixed background fills or per-line prefixes, so a transcript
 * drag-select copies message text without stray glyphs.
 *
 * @param enabled - Whether ANSI is emitted at all.
 * @param scheme - Active terminal color scheme; adjusts the code role.
 * @returns The role palette for the given scheme.
 */
export declare function createPalette(enabled: boolean, scheme?: TerminalColorScheme): Palette;
/**
 * What `/theme` chooses: which palette this terminal paints with, as a value
 * that outlives the process.
 *
 * `auto` is the behavior every earlier build had and remains the default — the
 * palette follows whatever color scheme the terminal reports, which most
 * terminals never do, leaving the dark-optimised tones. The two forced schemes
 * exist for the terminals that answer wrongly or not at all, and `no-color`
 * emits no SGR whatsoever, which is the same switch `theme.color: false` throws
 * in config, reachable without editing a file.
 */
export type ThemePreferenceId = 'auto' | 'light' | 'dark' | 'no-color';
/** Every `/theme` value, in the order the selector lists them. */
export declare const THEME_PREFERENCES: readonly ["auto", "light", "dark", "no-color"];
/**
 * The line shown beside one `/theme` value, in the selector and in the
 * command's own completions.
 *
 * A function rather than a table of strings: a message read at import time
 * freezes the locale it was first read in, and this line is rendered by two
 * surfaces that both outlive a `/lang` switch.
 * @param id - the theme value to describe.
 * @returns the description in the active locale.
 */
export declare function themePreferenceDescription(id: ThemePreferenceId): string;
/**
 * Whether a string is one of the four `/theme` values, for a typed argument and
 * for a settings document a person may have edited by hand.
 * @param value - candidate theme id.
 * @returns true when the value names a theme this terminal can apply.
 */
export declare function isThemePreference(value: string): value is ThemePreferenceId;
/** The palette arguments one theme preference resolves to. */
export interface ThemeAppearance {
    /** Whether ANSI is emitted at all. */
    readonly color: boolean;
    /** The scheme the palette is built for. */
    readonly scheme: TerminalColorScheme;
}
/**
 * Resolve a theme preference against the two facts it layers over: what the
 * terminal reported about itself, and whether this deployment allows color at
 * all.
 *
 * Config keeps the last word on `no-color`: a deployment that set
 * `theme.color: false` (a pipe, a CI log) must not get escapes back because a
 * settings document from another terminal says `dark`.
 * @param preference - the stored `/theme` choice.
 * @param reported - the scheme the terminal last reported; `auto` follows it.
 * @param configColor - the deployment's `theme.color` setting.
 * @returns the arguments {@link createPalette} is called with.
 */
export declare function resolveThemeAppearance(preference: ThemePreferenceId, reported: TerminalColorScheme, configColor: boolean): ThemeAppearance;
/**
 * Paint trusted static DeepSeek brand art with the official `#4D6BFE` ink.
 * @param text - Static brand text or raster cells.
 * @returns text wrapped in the official truecolor foreground and a foreground reset.
 */
export declare function brandText(text: string): string;
/**
 * Paint `text` left-to-right in the DeepSeek brand gradient with per-character
 * 24-bit foreground codes, resetting to the default foreground at the end.
 * Foreground-only, so it stays legible on any terminal background; the caller
 * gates it on truecolor support and wraps it in bold.
 *
 * @param text - Text to colorize; sampled once per character.
 * @returns `text` wrapped in truecolor SGR foreground codes.
 */
export declare function gradientText(text: string): string;
/**
 * Derive the pi-tui Markdown theme from a role palette.
 * @param palette - Active role palette.
 * @returns The Markdown theme wired to palette roles.
 */
export declare function markdownTheme(palette: Palette): MarkdownTheme;
/**
 * Derive the pi-tui select-list theme from a role palette.
 *
 * Each entry reads its role off the palette when it paints, rather than
 * capturing the wrapper the palette held at construction: a theme change swaps
 * the roles in place, and the editor's autocomplete menu is built once and
 * lives for the whole session, so a captured wrapper would keep emitting the
 * palette `/theme` just replaced — colored rows under `no-color` included.
 * @param palette - Active role palette.
 * @returns The select-list theme wired to palette roles.
 */
export declare function selectTheme(palette: Palette): SelectListTheme;
/**
 * Derive the reverse-video dialog select-list theme from a role palette.
 * @param palette - Active role palette.
 * @returns The dialog select-list theme with a reverse-video selection.
 */
export declare function dialogSelectTheme(palette: Palette): SelectListTheme;
/**
 * Render every palette role as a labelled sample row, each painted by the role
 * it names, so a reader compares the actual tones their terminal produces rather
 * than reading SGR numbers. Colors print first and attributes second because the
 * two groups compose in that order; every row shows its SGR pair so a mismatch
 * between the table and the screen is visible.
 *
 * @param palette - Active role palette, used to paint each sample.
 * @param scheme - Active color scheme, reported in the heading and selecting the spec.
 * @param colorEnabled - Whether ANSI is emitted; reported so an unstyled listing is not confusing.
 * @returns The rendered rows, without a trailing blank.
 */
export declare function renderPalette(palette: Palette, scheme: TerminalColorScheme, colorEnabled: boolean): string[];

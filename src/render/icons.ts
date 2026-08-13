/**
 * Nerd Font file icons, ported from pi-claude-code-ui. Each glyph is painted in
 * the language's own brand color on a truecolor terminal, which is how a Claude
 * Code file list reads as a file list at a glance.
 *
 * Two caveats a caller must know: the glyphs live in the Nerd Font private-use
 * area, so a terminal without a patched font shows a replacement box; and each
 * icon closes with a foreground reset (`39`), not a full `ESC[0m`, so an icon
 * embedded in a bold header does not silently drop the header's bold.
 * @module @deepseek-ai/dsh-tui/render/icons
 */

import { fg, type Rgb } from './palette.ts'

/** One icon: its Nerd Font codepoint and the brand color it is painted in. */
interface IconSpec {
  readonly glyph: string
  readonly color: Rgb
}

/** Build an icon spec from a glyph and raw channels. */
function icon(glyph: string, r: number, g: number, b: number): IconSpec {
  return { glyph, color: { r, g, b } }
}

/** Directory icon (Nerd Font `nf-custom-folder`). */
const DIR_ICON = icon('', 100, 140, 220)

/** Fallback icon for an unrecognized extension (Nerd Font `nf-fa-file_o`). */
const DEFAULT_ICON = icon('', 80, 80, 80)

/** Icons keyed by lowercase file extension. */
const EXTENSION_ICONS: Readonly<Record<string, IconSpec>> = {
  ts: icon('', 49, 120, 198),
  tsx: icon('', 49, 120, 198),
  js: icon('', 241, 224, 90),
  jsx: icon('', 97, 218, 251),
  py: icon('', 55, 118, 171),
  rs: icon('', 222, 165, 132),
  go: icon('', 0, 173, 216),
  java: icon('', 204, 62, 68),
  rb: icon('', 204, 52, 45),
  swift: icon('', 255, 172, 77),
  c: icon('', 85, 154, 211),
  cpp: icon('', 85, 154, 211),
  html: icon('', 228, 77, 38),
  css: icon('', 66, 165, 245),
  scss: icon('', 207, 100, 154),
  vue: icon('', 65, 184, 131),
  svelte: icon('', 255, 62, 0),
  json: icon('', 241, 224, 90),
  yaml: icon('', 160, 116, 196),
  yml: icon('', 160, 116, 196),
  toml: icon('', 160, 116, 196),
  md: icon('', 66, 165, 245),
  sh: icon('', 137, 180, 130),
  bash: icon('', 137, 180, 130),
  zsh: icon('', 137, 180, 130),
  lua: icon('', 81, 160, 207),
  php: icon('', 137, 147, 186),
  sql: icon('', 218, 218, 218),
  xml: icon('', 228, 77, 38),
  graphql: icon('', 224, 51, 144),
  dockerfile: icon('', 56, 152, 236),
  lock: icon('', 130, 130, 130),
  png: icon('', 160, 116, 196),
  jpg: icon('', 160, 116, 196),
  svg: icon('', 255, 180, 50),
  gif: icon('', 160, 116, 196),
}

/** Icons keyed by exact lowercase file name; checked before the extension table. */
const NAME_ICONS: Readonly<Record<string, IconSpec>> = {
  'package.json': icon('', 137, 180, 130),
  'tsconfig.json': icon('', 49, 120, 198),
  '.gitignore': icon('', 222, 165, 132),
  dockerfile: icon('', 56, 152, 236),
  makefile: icon('', 130, 130, 130),
  'readme.md': icon('', 66, 165, 245),
  license: icon('', 218, 218, 218),
}

/** Paint one icon spec. */
function paint(spec: IconSpec): string {
  return fg(spec.color, spec.glyph)
}

/**
 * The colored Nerd Font icon for a file path, chosen by exact file name first
 * and by extension second.
 * @param path - A file path; only its basename is inspected.
 * @param trailingSpace - Whether to append the separating space (the usual call site does).
 * @returns The painted glyph.
 */
export function fileIcon(path: string, trailingSpace = true): string {
  const base = path.split('/').pop()?.toLowerCase() ?? ''
  const suffix = trailingSpace ? ' ' : ''
  const byName = NAME_ICONS[base]
  if (byName !== undefined) return `${paint(byName)}${suffix}`
  const extension = base.includes('.') ? base.split('.').pop() ?? '' : ''
  const byExtension = EXTENSION_ICONS[extension]
  return `${paint(byExtension ?? DEFAULT_ICON)}${suffix}`
}

/**
 * The colored Nerd Font directory icon.
 * @param trailingSpace - Whether to append the separating space.
 * @returns The painted glyph.
 */
export function dirIcon(trailingSpace = true): string {
  return `${paint(DIR_ICON)}${trailingSpace ? ' ' : ''}`
}

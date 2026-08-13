/**
 * Theme tokens for the TUI. Dark-first, truecolor hex values (Ink passes them
 * through as ANSI 24-bit; terminals without truecolor degrade via the
 * terminal's own color quantization). Light theme mirrors the same semantics.
 * @module dsh-tui/tui/theme
 */

export interface Theme {
  /** Brand accent (dsh blue). */
  brand: string
  /** Primary body text. */
  text: string
  /** Secondary text (labels, hints). */
  muted: string
  /** Tertiary text (disabled, faint chrome). */
  dim: string
  /** Page background tint (where boxes paint a background). */
  background: string
  /** Borders and separators. */
  border: string
  success: string
  error: string
  warning: string
  /** Approval / permission accent. */
  approval: string
  /** Plan mode accent. */
  plan: string
  /** User message bubble background. */
  userBubble: string
  /** Tool card backgrounds by state. */
  toolPending: string
  toolSuccess: string
  toolError: string
  /** Diff colors. */
  diffAdded: string
  diffRemoved: string
  /** Markdown accents. */
  heading: string
  link: string
  code: string
  /** Thinking/reasoning text. */
  reasoning: string
}

export const darkTheme: Theme = {
  brand: '#4176e6',
  text: '#d4d4d4',
  muted: '#808080',
  dim: '#666666',
  background: '#151517',
  border: '#505050',
  success: '#4eba65',
  error: '#ff6b80',
  warning: '#ffc107',
  approval: '#b1b9f9',
  plan: '#48968c',
  userBubble: '#373737',
  toolPending: '#282832',
  toolSuccess: '#283228',
  toolError: '#3c2828',
  diffAdded: '#225c2b',
  diffRemoved: '#7a2936',
  heading: '#f0c674',
  link: '#81a2be',
  code: '#8abeb7',
  reasoning: '#808080',
}

export const lightTheme: Theme = {
  brand: '#4176e6',
  text: '#1a1a1a',
  muted: '#5f5f5f',
  dim: '#8a8a8a',
  background: '#ffffff',
  border: '#c8c8c8',
  success: '#1a7f37',
  error: '#cf222e',
  warning: '#9a6700',
  approval: '#5a67d8',
  plan: '#2f8579',
  userBubble: '#e8e8e8',
  toolPending: '#e8e8f0',
  toolSuccess: '#e8f0e8',
  toolError: '#f0e8e8',
  diffAdded: '#d4f4d4',
  diffRemoved: '#f4d4d4',
  heading: '#7a5c1e',
  link: '#2a5db0',
  code: '#2a7a72',
  reasoning: '#5f5f5f',
}

/** Glyphs shared across screens. */
export const symbols = {
  userPrompt: '⏺',
  inputPrefix: '❯',
  toolResult: '⎿',
  thinking: '∴',
  treeBranch: '├──',
  treeLast: '└──',
  treeVertical: '│',
  separator: '─',
  overlayTop: '▔',
  spinner: ['✻', '✶', '✷', '✽', '✳', '✴'],
  statusOk: '✓',
  statusError: '✗',
  statusWarn: '⚠',
  statusInfo: 'ℹ',
} as const

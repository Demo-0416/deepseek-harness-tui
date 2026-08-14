/**
 * `/skills` panel: the skills this session composes, searchable, with one
 * skill's full body a keystroke away.
 *
 * The rows are `ctx.skills.list()` summaries — the same layered read
 * `/skill:<name>` completion and invocation perform, so what this panel names
 * is exactly what the user can invoke right now, preset switches included. The
 * body behind Enter is `ctx.skills.get()`, which is a provider read that can be
 * slow or fail; both outcomes are the panel's own states rather than a notice
 * the panel would have to be closed to see.
 *
 * The keyboard is Claude Code's `/skills` menu translated to this codebase's
 * filterable-panel shape (see {@link ./plugins-panel.ts | PluginsPanel}):
 * typing filters by name or description, ↑/↓ move, Enter opens the detail view,
 * and Esc backs out one step at a time — detail to list, filter to empty, panel
 * to closed.
 * @module @deepseek-ai/dsh-tui/components/skills-panel
 */

import {
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
} from '@earendil-works/pi-tui'
import type { SkillDefinition, SkillSummary } from '@deepseek-ai/dsh-skill'
import { displayInlineText, displayText } from './text.ts'
import type { Palette } from './theme.ts'

/** The panel's heading, so the command and its view name the same thing. */
export const SKILLS_PANEL_TITLE = '/skills'

/**
 * Reported when no skill registry serves this session, by every surface that
 * would otherwise have to explain the same absence: the panel is not opened at
 * all, because a skill-less deployment has nothing to search.
 */
export const SKILLS_UNAVAILABLE = 'Skills are not available in this session.'

/** Shown while the first catalog read is in flight; the panel is already on screen. */
export const SKILLS_LOADING = 'Loading skills…'

/** Shown when the registry is mounted but this agent composes no skill. */
export const SKILLS_EMPTY = 'This session composes no skills.'

/** Shown when the filter matches nothing; the skills themselves still exist. */
export const SKILLS_NO_MATCH = 'No skills match the filter.'

/** Marks a row the user cannot invoke: the model may load it, `/skill:` may not. */
export const SKILL_MODEL_ONLY = 'model only'

/** Shown in the detail view while `ctx.skills.get()` is still reading the body. */
export const SKILL_DETAIL_LOADING = 'Loading skill…'

/** Terminal rows the list state spends on its own chrome: blank, title, filter, count, footer. */
const LIST_CHROME_ROWS = 5

/** Terminal rows the detail state spends on its own chrome: blank, title, footer. */
const DETAIL_CHROME_ROWS = 3

/** The key hints the list state ends with, before its position readout. */
const LIST_HINT = 'type to filter · ↑↓ move · enter details · esc close'

/** The key hints the detail state ends with; Esc goes back to the list, not out. */
const DETAIL_HINT = '↑↓ scroll · esc back'

/**
 * Body lines one detail view renders before it stops.
 *
 * A skill body is a whole prompt — some run to thousands of lines — and this
 * panel is a place to recognize a skill, not to read it end to end. The cut is
 * announced with the real total and the skill's path, so the reader knows both
 * that there is more and where it lives.
 */
const SKILL_BODY_MAX_LINES = 400

/**
 * The line that admits a cut body, naming what was left out.
 * @param total - the body's real line count.
 * @param path - the skill's file, when its provider has one.
 * @returns the dim notice appended after the last shown body line.
 */
export function skillBodyTruncated(total: number, path: string | undefined): string {
  const shown = `showing the first ${String(SKILL_BODY_MAX_LINES)} of ${String(total)} lines`
  return path === undefined ? `… ${shown}.` : `… ${shown}. Full text: ${path}`
}

/** One skill's detail view, from the moment Enter asks for it. */
export type SkillDetailState =
  /** `ctx.skills.get()` is in flight. */
  | { readonly kind: 'loading' }
  /** The provider returned a body. */
  | { readonly kind: 'ready'; readonly skill: SkillDefinition }
  /** The lookup failed, or the skill is gone; the message is shown verbatim. */
  | { readonly kind: 'failed'; readonly message: string }

/**
 * Whether a summary matches the filter box: a case-insensitive substring over
 * the two things a row shows, the skill's name and its routing description.
 * @param skill - one skill summary.
 * @param normalizedQuery - the query, already trimmed and lower-cased.
 * @returns true when the skill stays visible under this query.
 */
function matchesQuery(skill: SkillSummary, normalizedQuery: string): boolean {
  if (normalizedQuery.length === 0) return true
  return [skill.name, skill.description]
    .some(value => value.toLocaleLowerCase().includes(normalizedQuery))
}

/**
 * Searchable skill catalog in the editor slot, with a per-skill detail view.
 *
 * Keyboard-owned like {@link ./panel.ts | ScrollablePanel}: every keystroke is
 * consumed here and none leaks into the editor underneath. The catalog and the
 * detail bodies are both loaded by the caller, which owns the registry, the
 * lookup scope, and the abort signal; the panel only asks (`onOpen`) and shows
 * what it is handed ({@link setSkills}, {@link setDetail}).
 */
export class SkillsPanel implements Component, Focusable {
  /** Set by the TUI on focus; the filter box owns the visible cursor. */
  focused = false
  private readonly filter = new Input()
  /** The catalog, or `undefined` while the first read is still in flight. */
  private skills: readonly SkillSummary[] | undefined
  /** Skill the selection bar sits on; kept by name so filtering re-finds it. */
  private selectedName: string | undefined
  /** Skill the detail view is showing, or `undefined` while the list is up. */
  private detailName: string | undefined
  private detail: SkillDetailState | undefined
  /** First visible list row. */
  private offset = 0
  /** First visible detail row. */
  private detailOffset = 0

  /**
   * @param skills - the catalog when it is already known, `undefined` while it loads.
   * @param rows - the panel's total row budget, read per render so a resize applies.
   * @param palette - active role palette.
   * @param onOpen - asks the caller to load one skill's body; answered by {@link setDetail}.
   * @param onClose - called on Esc (with an empty filter, from the list) or Ctrl+C.
   */
  constructor(
    skills: readonly SkillSummary[] | undefined,
    private readonly rows: () => number,
    private readonly palette: Palette,
    private readonly onOpen: (name: string) => void,
    private readonly onClose: () => void,
  ) {
    this.skills = skills
  }

  invalidate(): void {
    this.filter.invalidate()
  }

  /**
   * Replace the loading placeholder with the catalog the scan produced.
   * @param skills - the summaries this session's registry served.
   */
  setSkills(skills: readonly SkillSummary[]): void {
    this.skills = skills
    this.refilter()
    this.invalidate()
  }

  /**
   * Answer one {@link onOpen} request.
   *
   * The name is checked against the open detail: a body that arrives after the
   * reader went back to the list, or moved on to another skill, is dropped
   * rather than painted over whatever they are looking at now.
   * @param name - the skill the caller was asked to load.
   * @param state - the outcome, shown as-is.
   */
  setDetail(name: string, state: SkillDetailState): void {
    if (this.detailName !== name) return
    this.detail = state
    this.detailOffset = 0
    this.invalidate()
  }

  /** Skills visible under the current filter, in the order the caller supplied. */
  private filtered(): readonly SkillSummary[] {
    const query = this.filter.getValue().trim().toLocaleLowerCase()
    return (this.skills ?? []).filter(skill => matchesQuery(skill, query))
  }

  /** The selection bar's index within `visible`, falling back to the first row. */
  private selectedIndex(visible: readonly SkillSummary[]): number {
    const index = visible.findIndex(skill => skill.name === this.selectedName)
    return index === -1 ? 0 : index
  }

  private viewport(): number {
    return Math.max(1, this.rows() - LIST_CHROME_ROWS)
  }

  private detailViewport(): number {
    return Math.max(1, this.rows() - DETAIL_CHROME_ROWS)
  }

  private move(delta: number): void {
    const visible = this.filtered()
    if (visible.length === 0) return
    const index = Math.max(0, Math.min(this.selectedIndex(visible) + delta, visible.length - 1))
    this.selectedName = visible[index]?.name
  }

  /** Ask the caller for the selected skill's body and switch to the detail view. */
  private openDetail(): void {
    const visible = this.filtered()
    const selected = visible[this.selectedIndex(visible)]
    if (selected === undefined) return
    this.selectedName = selected.name
    this.detailName = selected.name
    this.detail = { kind: 'loading' }
    this.detailOffset = 0
    this.onOpen(selected.name)
  }

  /** Leave the detail view; the list keeps its filter and its selection. */
  private closeDetail(): void {
    this.detailName = undefined
    this.detail = undefined
  }

  /** Re-derive the selection after the filter box or the catalog changed. */
  private refilter(): void {
    const visible = this.filtered()
    if (!visible.some(skill => skill.name === this.selectedName)) {
      this.selectedName = visible[0]?.name
    }
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.ctrl('c'))) {
      this.onClose()
      return
    }
    if (this.detailName !== undefined) {
      // Esc backs out one step: the detail view is a place inside the panel,
      // not a second panel, so leaving it returns to the search the reader
      // arrived through.
      if (matchesKey(data, Key.escape)) { this.closeDetail(); return }
      if (matchesKey(data, Key.up)) { this.scrollDetail(-1); return }
      if (matchesKey(data, Key.down)) { this.scrollDetail(1); return }
      if (matchesKey(data, Key.pageUp)) { this.scrollDetail(-this.detailViewport()); return }
      if (matchesKey(data, Key.pageDown)) { this.scrollDetail(this.detailViewport()); return }
      // The reading keys `ScrollablePanel` already taught in this terminal; a
      // body is read the same way `/status` output is.
      if (data === 'g' || matchesKey(data, Key.home)) { this.detailOffset = 0; return }
      if (data === 'G' || matchesKey(data, Key.end)) { this.scrollDetail(Number.MAX_SAFE_INTEGER); return }
      // Every other key is swallowed: a body is read, not edited.
      return
    }
    if (matchesKey(data, Key.escape)) {
      // The Esc ladder every filterable dialog here uses: a non-empty filter
      // is cleared first, so backing out of a search is not losing the panel.
      if (this.filter.getValue() === '') {
        this.onClose()
        return
      }
      this.filter.setValue('')
      this.refilter()
      return
    }
    if (this.skills === undefined || this.skills.length === 0) return
    if (matchesKey(data, Key.up)) { this.move(-1); return }
    if (matchesKey(data, Key.down)) { this.move(1); return }
    if (matchesKey(data, Key.pageUp)) { this.move(-this.viewport()); return }
    if (matchesKey(data, Key.pageDown)) { this.move(this.viewport()); return }
    if (matchesKey(data, Key.enter)) { this.openDetail(); return }
    const previous = this.filter.getValue()
    this.filter.focused = true
    this.filter.handleInput(data)
    if (this.filter.getValue() !== previous) this.refilter()
    // Anything the filter box ignored is still swallowed: the panel owns the
    // keyboard while it is open.
  }

  private scrollDetail(delta: number): void {
    // Clamped against the last rendered body in `render`, which runs after
    // every keystroke; a scroll past either end simply stops there.
    this.detailOffset = Math.max(0, this.detailOffset + delta)
  }

  /** Body rows for the list state, plus the display-row index of the selection bar. */
  private body(visible: readonly SkillSummary[], width: number): { rows: string[]; selectedRow: number } {
    if (visible.length === 0) return { rows: [this.palette.dim(SKILLS_NO_MATCH)], selectedRow: 0 }
    // The name column is sized to the widest visible name, but never past a
    // third of the panel: one outlier name must not push every description off
    // the right edge.
    const nameColumn = Math.min(
      Math.max(...visible.map(skill => visibleWidth(skill.name))),
      Math.max(8, Math.floor(width / 3)),
    )
    const selectedIndex = this.selectedIndex(visible)
    const rows = visible.map((skill, index) => {
      const bar = index === selectedIndex ? this.palette.accent('→ ') : '  '
      const name = truncateToWidth(displayInlineText(skill.name), nameColumn, '…', true)
      // The marker rides the description rather than a column of its own:
      // most catalogs are entirely user-invocable, and an empty column in
      // every row buys nothing.
      const marker = skill.invocation.userInvocable ? '' : `  ${SKILL_MODEL_ONLY}`
      const description = displayInlineText(skill.description)
      return truncateToWidth(
        `${bar}${this.palette.text(name)}  ${this.palette.dim(`${description}${marker}`)}`,
        width,
        '',
      )
    })
    return { rows, selectedRow: selectedIndex }
  }

  /** The one-page states: a message and the way out, with no filter box above them. */
  private renderMessage(title: string, message: string, width: number): string[] {
    return [
      '',
      title,
      ...wrapTextWithAnsi(this.palette.dim(message), width).map(line => ` ${line}`),
      ` ${this.palette.dim('esc close')}`,
    ]
  }

  /** Detail rows for one loaded skill: what the list showed, then the body. */
  private detailBody(skill: SkillDefinition, width: number): string[] {
    const lines = skill.content.split('\n')
    const shown = lines.slice(0, SKILL_BODY_MAX_LINES)
    const provenance = [
      skill.source,
      skill.provider,
      skill.invocation.userInvocable ? 'user invocable' : SKILL_MODEL_ONLY,
    ].join(' · ')
    const rows = [
      this.palette.accent(displayInlineText(skill.name)),
      ...wrapTextWithAnsi(this.palette.dim(displayInlineText(skill.description)), width),
      this.palette.dim(displayInlineText(provenance)),
      '',
      ...shown.flatMap(line => wrapTextWithAnsi(this.palette.text(displayText(line)), width)),
    ]
    if (lines.length > shown.length) {
      rows.push('', ...wrapTextWithAnsi(
        this.palette.dim(skillBodyTruncated(lines.length, skill.path)),
        width,
      ))
    }
    return rows
  }

  /** The detail state: a loading line, a failure, or the skill itself, scrollable. */
  private renderDetail(title: string, width: number): string[] {
    const state = this.detail ?? { kind: 'loading' as const }
    const rows = state.kind === 'ready'
      ? this.detailBody(state.skill, width)
      : wrapTextWithAnsi(
        state.kind === 'loading'
          ? this.palette.dim(SKILL_DETAIL_LOADING)
          : this.palette.error(displayInlineText(state.message)),
        width,
      )
    const viewport = this.detailViewport()
    // Re-clamped every frame: a resize, or a body that arrived shorter than
    // the one scrolled through, must not leave the view past its own end.
    this.detailOffset = Math.max(0, Math.min(this.detailOffset, Math.max(0, rows.length - viewport)))
    const shown = rows.slice(this.detailOffset, this.detailOffset + viewport)
    const position = rows.length > viewport
      ? `  ·  ${String(this.detailOffset + 1)}–${String(this.detailOffset + shown.length)} of ${String(rows.length)}`
      : ''
    return [
      '',
      title,
      ...shown.map(line => ` ${line}`),
      ` ${truncateToWidth(this.palette.dim(`${DETAIL_HINT}${position}`), width, '')}`,
    ]
  }

  render(width: number): string[] {
    const contentWidth = Math.max(1, width - 2)
    const title = ` ${this.palette.dim(SKILLS_PANEL_TITLE)}`
    if (this.detailName !== undefined) return this.renderDetail(title, contentWidth)
    if (this.skills === undefined) return this.renderMessage(title, SKILLS_LOADING, contentWidth)
    if (this.skills.length === 0) return this.renderMessage(title, SKILLS_EMPTY, contentWidth)
    const visible = this.filtered()
    this.filter.focused = true
    const filterLine = truncateToWidth(
      `${this.palette.dim('filter:')} ${this.filter.render(Math.max(1, contentWidth - 8)).join('')}`,
      contentWidth,
      '',
    )
    const invocable = this.skills.filter(skill => skill.invocation.userInvocable).length
    const count = `${String(visible.length)}/${String(this.skills.length)} skills · ${String(invocable)} user invocable`
    const { rows, selectedRow } = this.body(visible, contentWidth)
    const viewport = this.viewport()
    // The selection bar stays in view: scrolling follows it, and a resize or a
    // narrowed filter re-clamps the window every frame.
    this.offset = Math.max(0, Math.min(this.offset, Math.max(0, rows.length - viewport)))
    if (selectedRow < this.offset) this.offset = selectedRow
    if (selectedRow >= this.offset + viewport) this.offset = selectedRow - viewport + 1
    const shown = rows.slice(this.offset, this.offset + viewport)
    const position = rows.length > viewport
      ? `  ·  ${String(this.offset + 1)}–${String(this.offset + shown.length)} of ${String(rows.length)}`
      : ''
    return [
      '',
      title,
      ` ${filterLine}`,
      ` ${truncateToWidth(this.palette.dim(count), contentWidth, '')}`,
      ...shown.map(line => ` ${line}`),
      ` ${truncateToWidth(this.palette.dim(`${LIST_HINT}${position}`), contentWidth, '')}`,
    ]
  }
}

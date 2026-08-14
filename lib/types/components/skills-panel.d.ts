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
import { type Component, type Focusable } from '@earendil-works/pi-tui';
import type { SkillDefinition, SkillSummary } from '@deepseek-ai/dsh-skill';
import type { Palette } from './theme.ts';
/** The panel's heading, so the command and its view name the same thing. */
export declare const SKILLS_PANEL_TITLE = "/skills";
/**
 * Reported when no skill registry serves this session, by every surface that
 * would otherwise have to explain the same absence: the panel is not opened at
 * all, because a skill-less deployment has nothing to search.
 *
 * These five are the English text of the message keys the panel renders, not a
 * second source of it: every rendering site looks its key up per frame, so
 * `/lang` moves the screen, while the constants stay for the tests and parity
 * fixtures that quote the shipped English wording.
 */
export declare const SKILLS_UNAVAILABLE: string;
/** Shown while the first catalog read is in flight; the panel is already on screen. */
export declare const SKILLS_LOADING: string;
/** Shown when the registry is mounted but this agent composes no skill. */
export declare const SKILLS_EMPTY: string;
/** Shown when the filter matches nothing; the skills themselves still exist. */
export declare const SKILLS_NO_MATCH: string;
/** Marks a row the user cannot invoke: the model may load it, `/skill:` may not. */
export declare const SKILL_MODEL_ONLY: string;
/** Shown in the detail view while `ctx.skills.get()` is still reading the body. */
export declare const SKILL_DETAIL_LOADING: string;
/**
 * The line that admits a cut body, naming what was left out.
 * @param total - the body's real line count.
 * @param path - the skill's file, when its provider has one.
 * @returns the dim notice appended after the last shown body line.
 */
export declare function skillBodyTruncated(total: number, path: string | undefined): string;
/** One skill's detail view, from the moment Enter asks for it. */
export type SkillDetailState = 
/** `ctx.skills.get()` is in flight. */
{
    readonly kind: 'loading';
}
/** The provider returned a body. */
 | {
    readonly kind: 'ready';
    readonly skill: SkillDefinition;
}
/** The lookup failed, or the skill is gone; the message is shown verbatim. */
 | {
    readonly kind: 'failed';
    readonly message: string;
};
/**
 * Searchable skill catalog in the editor slot, with a per-skill detail view.
 *
 * Keyboard-owned like {@link ./panel.ts | ScrollablePanel}: every keystroke is
 * consumed here and none leaks into the editor underneath. The catalog and the
 * detail bodies are both loaded by the caller, which owns the registry, the
 * lookup scope, and the abort signal; the panel only asks (`onOpen`) and shows
 * what it is handed ({@link setSkills}, {@link setDetail}).
 */
export declare class SkillsPanel implements Component, Focusable {
    private readonly rows;
    private readonly palette;
    private readonly onOpen;
    private readonly onClose;
    /** Set by the TUI on focus; the filter box owns the visible cursor. */
    focused: boolean;
    private readonly filter;
    /** The catalog, or `undefined` while the first read is still in flight. */
    private skills;
    /** Skill the selection bar sits on; kept by name so filtering re-finds it. */
    private selectedName;
    /** Skill the detail view is showing, or `undefined` while the list is up. */
    private detailName;
    private detail;
    /** First visible list row. */
    private offset;
    /** First visible detail row. */
    private detailOffset;
    /**
     * @param skills - the catalog when it is already known, `undefined` while it loads.
     * @param rows - the panel's total row budget, read per render so a resize applies.
     * @param palette - active role palette.
     * @param onOpen - asks the caller to load one skill's body; answered by {@link setDetail}.
     * @param onClose - called on Esc (with an empty filter, from the list) or Ctrl+C.
     */
    constructor(skills: readonly SkillSummary[] | undefined, rows: () => number, palette: Palette, onOpen: (name: string) => void, onClose: () => void);
    invalidate(): void;
    /**
     * Replace the loading placeholder with the catalog the scan produced.
     * @param skills - the summaries this session's registry served.
     */
    setSkills(skills: readonly SkillSummary[]): void;
    /**
     * Answer one {@link onOpen} request.
     *
     * The name is checked against the open detail: a body that arrives after the
     * reader went back to the list, or moved on to another skill, is dropped
     * rather than painted over whatever they are looking at now.
     * @param name - the skill the caller was asked to load.
     * @param state - the outcome, shown as-is.
     */
    setDetail(name: string, state: SkillDetailState): void;
    /** Skills visible under the current filter, in the order the caller supplied. */
    private filtered;
    /** The selection bar's index within `visible`, falling back to the first row. */
    private selectedIndex;
    private viewport;
    private detailViewport;
    private move;
    /** Ask the caller for the selected skill's body and switch to the detail view. */
    private openDetail;
    /** Leave the detail view; the list keeps its filter and its selection. */
    private closeDetail;
    /** Re-derive the selection after the filter box or the catalog changed. */
    private refilter;
    handleInput(data: string): void;
    private scrollDetail;
    /** Body rows for the list state, plus the display-row index of the selection bar. */
    private body;
    /** The one-page states: a message and the way out, with no filter box above them. */
    private renderMessage;
    /** Detail rows for one loaded skill: what the list showed, then the body. */
    private detailBody;
    /** The detail state: a loading line, a failure, or the skill itself, scrollable. */
    private renderDetail;
    render(width: number): string[];
}

/**
 * The Shift+Tab mode cycle: one key over two axes the harness keeps apart.
 *
 * dsh has no "permission mode" enum. It has a permission preset table
 * (`ctx.permissionPresets`, each name a `sandbox/mode` + `approval/policy`
 * bundle) and, independently, plan mode (`ctx.planMode`, logged per agent as
 * `plan/mode`). Claude Code's single Shift+Tab ladder is a *composition* of the
 * two, so this module owns exactly that composition and nothing else: it reads
 * the two axes as the services report them and answers which writes the next
 * press should make. No mode is stored here — a terminal that kept its own
 * copy would disagree with the session log the moment `/permission`, `/plan`,
 * or another client moved an axis, and the badge above the prompt would be
 * lying rather than reporting.
 *
 * The ladder is `normal → auto-accept → plan → normal`. Two deliberate holes
 * in it:
 *
 * - **`danger-full-access` is not a rung.** A preset that turns the sandbox off
 *   is a decision worth typing `/permission danger-full-access` for; reaching
 *   it by pressing a key three times is how a user ends up there without
 *   noticing. The cycle never selects it — and never selects *away* from it
 *   either ({@link SessionMode} calls that state `other`): a session that opted
 *   into a preset outside the ladder keeps it, and the key moves only plan mode.
 * - **A missing axis collapses its rung.** A deployment that mounts no preset
 *   table, or one without an `auto-accept` entry, still cycles plan mode; one
 *   with no plan mode still toggles auto-accept. The key does what the mounted
 *   services can do, rather than reporting an error the user cannot act on.
 * @module @deepseek-ai/dsh-tui/chat/modes
 */
/**
 * The preset the ladder treats as home: the workspace sandbox with approval
 * asked for anything wider. `dsh-permission-presets` ships it as a default
 * table entry, and the base bundle configures it by this name.
 */
export declare const NORMAL_PRESET = "workspace-write";
/**
 * The preset the auto-accept rung selects: the same workspace sandbox with the
 * approval policy set to `never`, so tool calls inside it run unattended.
 *
 * Not a default of `dsh-permission-presets` — this bundle's `cordis.patch.yml`
 * adds it to the table. Absent (an embedder composing the plugin itself), the
 * rung drops out of the cycle instead of failing the press.
 */
export declare const AUTO_ACCEPT_PRESET = "auto-accept";
/**
 * The composed mode a session is in, as the badge above the prompt reports it.
 *
 * `other` is the honest name for "on a preset the ladder does not own", which
 * is `danger-full-access`, `read-only`, a deployment's own table entry, or the
 * service's derived `custom` when the two knobs match no entry at all.
 */
export type SessionMode = 'normal' | 'auto-accept' | 'plan' | 'other';
/** The two axes, read from the services rather than remembered. */
export interface ModeAxes {
    /**
     * Whether plan mode is in force, counting a selection that is queued for the
     * next step: `ctx.planMode.set()` returns `queued` during an open turn, and a
     * cycle that ignored the queued value would answer the second press with the
     * first one's transition.
     */
    readonly planActive: boolean;
    /** Whether a plan-mode service is mounted at all, which is what makes plan a rung. */
    readonly planAvailable: boolean;
    /** The preset in force, or `undefined` when no preset service is mounted. */
    readonly preset: string | undefined;
    /** Every switchable preset name, which is what makes auto-accept a rung. */
    readonly presets: readonly string[];
}
/** The writes one press makes, and the mode they land the session in. */
export interface ModeSwitch {
    /** The mode after the writes below are applied. */
    readonly mode: SessionMode;
    /** The plan axis, when this press moves it. */
    readonly plan?: boolean;
    /** The permission preset to select, when this press moves that axis. */
    readonly preset?: string;
}
/**
 * Name the mode a pair of axis values composes to.
 * @param axes - the two axes as the services report them.
 * @returns the composed mode.
 */
export declare function currentMode(axes: ModeAxes): SessionMode;
/**
 * The next rung of the ladder from where the session is now.
 * @param axes - the two axes as the services report them.
 * @returns the writes to make and the mode they reach, or `undefined` when
 * neither axis can move (no preset table with an auto-accept entry, and no plan
 * mode) and the press has nothing to do.
 */
export declare function nextMode(axes: ModeAxes): ModeSwitch | undefined;

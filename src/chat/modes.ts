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
export const NORMAL_PRESET = 'workspace-write'

/**
 * The preset the auto-accept rung selects: the same workspace sandbox with the
 * approval policy set to `never`, so tool calls inside it run unattended.
 *
 * Not a default of `dsh-permission-presets` — this bundle's `cordis.patch.yml`
 * adds it to the table. Absent (an embedder composing the plugin itself), the
 * rung drops out of the cycle instead of failing the press.
 */
export const AUTO_ACCEPT_PRESET = 'auto-accept'

/**
 * The composed mode a session is in, as the badge above the prompt reports it.
 *
 * `other` is the honest name for "on a preset the ladder does not own", which
 * is `danger-full-access`, `read-only`, a deployment's own table entry, or the
 * service's derived `custom` when the two knobs match no entry at all.
 */
export type SessionMode = 'normal' | 'auto-accept' | 'plan' | 'other'

/** The two axes, read from the services rather than remembered. */
export interface ModeAxes {
  /**
   * Whether plan mode is in force, counting a selection that is queued for the
   * next step: `ctx.planMode.set()` returns `queued` during an open turn, and a
   * cycle that ignored the queued value would answer the second press with the
   * first one's transition.
   */
  readonly planActive: boolean
  /** Whether a plan-mode service is mounted at all, which is what makes plan a rung. */
  readonly planAvailable: boolean
  /** The preset in force, or `undefined` when no preset service is mounted. */
  readonly preset: string | undefined
  /** Every switchable preset name, which is what makes auto-accept a rung. */
  readonly presets: readonly string[]
}

/** The writes one press makes, and the mode they land the session in. */
export interface ModeSwitch {
  /** The mode after the writes below are applied. */
  readonly mode: SessionMode
  /** The plan axis, when this press moves it. */
  readonly plan?: boolean
  /** The permission preset to select, when this press moves that axis. */
  readonly preset?: string
}

/**
 * Name the mode a pair of axis values composes to.
 * @param axes - the two axes as the services report them.
 * @returns the composed mode.
 */
export function currentMode(axes: ModeAxes): SessionMode {
  // Plan mode wins the label when both are on: it is the axis that changes what
  // the model is allowed to do next, and the one the user just chose.
  if (axes.planActive) return 'plan'
  if (axes.preset === AUTO_ACCEPT_PRESET) return 'auto-accept'
  // No preset service is `normal` for labelling purposes: a deployment without
  // one asks for approval or does not, and either way there is no preset to
  // name — so the badge says nothing and the ladder is plan-only.
  if (axes.preset === undefined || axes.preset === NORMAL_PRESET) return 'normal'
  return 'other'
}

/**
 * The next rung of the ladder from where the session is now.
 * @param axes - the two axes as the services report them.
 * @returns the writes to make and the mode they reach, or `undefined` when
 * neither axis can move (no preset table with an auto-accept entry, and no plan
 * mode) and the press has nothing to do.
 */
export function nextMode(axes: ModeAxes): ModeSwitch | undefined {
  const canAutoAccept = axes.presets.includes(AUTO_ACCEPT_PRESET)
  const canNormal = axes.presets.includes(NORMAL_PRESET)
  let plan: boolean | undefined
  let preset: string | undefined
  switch (currentMode(axes)) {
    case 'normal':
      if (canAutoAccept) preset = AUTO_ACCEPT_PRESET
      else if (axes.planAvailable) plan = true
      else return undefined
      break
    case 'auto-accept':
      // Plan mode is not an auto-accepting mode upstream either, so the rung
      // that enters it hands the permission axis back to `workspace-write`.
      if (axes.planAvailable) plan = true
      if (canNormal) preset = NORMAL_PRESET
      if (plan === undefined && preset === undefined) return undefined
      break
    case 'plan':
      if (!axes.planAvailable) return undefined
      plan = false
      // Only the preset this cycle itself selected is handed back. Leaving plan
      // mode must not quietly rewrite a permission choice made elsewhere.
      if (axes.preset === AUTO_ACCEPT_PRESET && canNormal) preset = NORMAL_PRESET
      break
    case 'other':
      // A preset outside the ladder is left exactly as it is; the press moves
      // the only axis it may move.
      if (!axes.planAvailable) return undefined
      plan = true
      break
  }
  const mode = currentMode({
    ...axes,
    planActive: plan ?? axes.planActive,
    preset: preset ?? axes.preset,
  })
  return {
    mode,
    ...plan === undefined ? {} : { plan },
    ...preset === undefined ? {} : { preset },
  }
}

/**
 * Local `/doctor`: the environment checks a bug report starts with, run and
 * answered on screen.
 *
 * `/status` describes the session; this describes what the session is running
 * ON — the interpreter, the terminal, the model route, the services a terminal
 * silently degrades without. Each check is one line the user can act on: a
 * verdict, what was actually observed, and, when it is not a pass, the one
 * thing to do about it.
 *
 * Every input arrives as a value or a callback rather than being read here, so
 * the checks are a pure function of the environment they describe and a test
 * can state any environment it wants to see reported.
 * @module @deepseek-ai/dsh-tui/chat/doctor
 */

import { errorChain } from '@deepseek-ai/dsh-llm'
import { displayInlineText } from '../components/text.ts'
import type { Palette } from '../components/theme.ts'

/** Verdict of one check: what the glyph and the color say. */
export type DoctorStatus = 'pass' | 'warn' | 'fail'

/** One answered check, as `/doctor` prints it. */
export interface DoctorCheck {
  /** Column-one subject, e.g. `Node`. */
  readonly label: string
  readonly status: DoctorStatus
  /** What was observed, stated as a fact rather than a verdict. */
  readonly detail: string
  /** The one thing to do about it; absent on a pass, which needs nothing done. */
  readonly advice?: string
}

/**
 * Node versions this bundle is published for, mirroring `engines.node`
 * (`^22.19.0 || >=24.0.0`). Restated rather than parsed out of `package.json`:
 * the built bundle does not ship its manifest beside the code that would read
 * it, and a range this small is cheaper to keep honest than to resolve.
 */
const NODE_LTS_MAJOR = 22
const NODE_LTS_MIN_MINOR = 19
const NODE_CURRENT_MAJOR = 24
/** The range, as `/doctor` states it when the running version misses it. */
const NODE_SUPPORTED_RANGE = '22.19+ or 24+'

/** Below this many columns the transcript's cards and diffs wrap to unreadable. */
const NARROW_COLUMNS = 60
/** Below this many rows the editor and a panel cannot both be on screen. */
const SHORT_ROWS = 10

/** The error code a route whose adapter has not registered rejects with. */
const NO_ADAPTER = 'NO_ADAPTER'

/** The `provider/model` a session is pointed at. */
export interface DoctorRoute {
  readonly provider: string
  readonly model: string
}

/** Everything `/doctor` reports on, read by the caller and handed over as values. */
export interface DoctorInputs {
  /** `process.version`, including its leading `v`. */
  readonly nodeVersion: string
  readonly stdinTty: boolean
  readonly stdoutTty: boolean
  readonly columns: number
  readonly rows: number
  /** Resolved `theme.color`: whether this terminal is allowed any SGR at all. */
  readonly color: boolean
  /** Resolved `theme.truecolor`: whether the brand art may use 24-bit color. */
  readonly truecolor: boolean
  /** Registered provider ids, from `ctx.llm.listProviders()`. */
  readonly providers: readonly string[]
  /** The selected route, or `undefined` when nothing is selected yet. */
  readonly route: DoctorRoute | undefined
  /** `ctx.llm.resolveModelInfo`, which is what proves the route is reachable. */
  readonly resolveModelInfo: (provider: string, model: string) => Promise<unknown>
  /** Whether `sessionPersistence` is mounted. */
  readonly persistence: boolean
  /** Whether the `agentPresets` roster is mounted. */
  readonly presets: boolean
  /** The preset this session runs, when the roster is mounted and names one. */
  readonly preset: string | undefined
}

/**
 * Whether a version string satisfies this bundle's `engines.node`.
 * @param version - `process.version`, with or without its leading `v`.
 * @returns true when the version is in range; false for out-of-range AND for
 *   anything that does not parse, since an unreadable version is not a
 *   supported one.
 */
export function nodeVersionSupported(version: string): boolean {
  const parsed = /^v?(\d+)\.(\d+)\./u.exec(version)
  if (parsed === null) return false
  const major = Number(parsed[1])
  const minor = Number(parsed[2])
  if (major >= NODE_CURRENT_MAJOR) return true
  return major === NODE_LTS_MAJOR && minor >= NODE_LTS_MIN_MINOR
}

/**
 * Whether a rejection means only that the route's adapter has not registered.
 *
 * Matched on `code`, never with `instanceof LlmError`: this bundle resolves
 * `@deepseek-ai/dsh-llm` from its own installation while the host that mounts
 * it resolves its own, so the two error classes are different objects and an
 * `instanceof` guard is false for the very error it exists to recognize.
 * @param error - the rejection from `resolveModelInfo`.
 * @returns true when the failure is a missing adapter registration.
 */
function isMissingAdapter(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  return (error as { code?: unknown }).code === NO_ADAPTER
}

/** The interpreter this process runs on. */
function nodeCheck(inputs: DoctorInputs): DoctorCheck {
  const detail = displayInlineText(inputs.nodeVersion)
  if (nodeVersionSupported(inputs.nodeVersion)) return { label: 'Node', status: 'pass', detail }
  return {
    label: 'Node',
    status: 'fail',
    detail,
    advice: `this bundle is published for Node ${NODE_SUPPORTED_RANGE}; older runtimes miss APIs it calls unguarded`,
  }
}

/**
 * Whether both ends of the terminal are a TTY.
 *
 * A failure here is reported rather than acted on: the interactive entry point
 * refuses a non-TTY invocation outright, so this check answers for an embedded
 * host that drove the UI over something else.
 */
function terminalCheck(inputs: DoctorInputs): DoctorCheck {
  if (inputs.stdinTty && inputs.stdoutTty) {
    return { label: 'Terminal', status: 'pass', detail: 'stdin and stdout are both TTYs' }
  }
  const missing = [
    ...inputs.stdinTty ? [] : ['stdin'],
    ...inputs.stdoutTty ? [] : ['stdout'],
  ].join(' and ')
  return {
    label: 'Terminal',
    status: 'fail',
    detail: `${missing} ${inputs.stdinTty || inputs.stdoutTty ? 'is' : 'are'} not a TTY`,
    advice: 'keys and redraws need a terminal on both ends; for pipes use --print, which runs one task with no UI',
  }
}

/** How much screen the layout actually has. */
function screenCheck(inputs: DoctorInputs): DoctorCheck {
  const detail = `${String(inputs.columns)}x${String(inputs.rows)}`
  if (inputs.columns < NARROW_COLUMNS) {
    return {
      label: 'Screen',
      status: 'warn',
      detail,
      advice: `below ${String(NARROW_COLUMNS)} columns tool cards, diffs, and panels wrap; widen the window`,
    }
  }
  if (inputs.rows < SHORT_ROWS) {
    return {
      label: 'Screen',
      status: 'warn',
      detail,
      advice: `below ${String(SHORT_ROWS)} rows a panel leaves no room for the editor; make the window taller`,
    }
  }
  return { label: 'Screen', status: 'pass', detail }
}

/**
 * What this terminal is allowed to render.
 *
 * Configuration, not detection: the TUI emits the standard 16 colors and lets
 * the terminal map them, so what matters is whether the deployment turned them
 * off — a disabled palette is legible but flat, which is worth saying out loud
 * before someone reports missing highlighting as a bug.
 */
function colorCheck(inputs: DoctorInputs): DoctorCheck {
  if (!inputs.color) {
    return {
      label: 'Color',
      status: 'warn',
      detail: 'disabled (theme.color is off)',
      advice: 'every surface renders as plain text; set theme.color to bring the palette back',
    }
  }
  return {
    label: 'Color',
    status: 'pass',
    detail: inputs.truecolor ? '16-color palette, truecolor brand art' : '16-color palette',
  }
}

/**
 * Whether the selected route can actually be resolved.
 *
 * This is the one check that asks a service rather than reading a value: a
 * provider list proves a plugin registered, and only a resolution proves the
 * adapter behind it answers for THIS model.
 */
async function modelCheck(inputs: DoctorInputs): Promise<DoctorCheck> {
  if (inputs.providers.length === 0) {
    return {
      label: 'Model',
      status: 'fail',
      detail: 'no LLM provider is registered',
      advice: 'the profile mounts no adapter row, or none of them activated; check the bundle and its credentials',
    }
  }
  const providers = inputs.providers.map(provider => displayInlineText(provider)).join(', ')
  if (inputs.route === undefined) {
    return {
      label: 'Model',
      status: 'fail',
      detail: `no model selected (providers: ${providers})`,
      advice: 'pick one with /model, or pass --model provider/model on the command line',
    }
  }
  const route = displayInlineText(`${inputs.route.provider}/${inputs.route.model}`)
  try {
    await inputs.resolveModelInfo(inputs.route.provider, inputs.route.model)
    return { label: 'Model', status: 'pass', detail: `${route} resolves (providers: ${providers})` }
  } catch (error: unknown) {
    if (isMissingAdapter(error)) {
      return {
        label: 'Model',
        status: 'fail',
        detail: `${route} has no registered adapter`,
        advice: `no adapter answers for "${displayInlineText(inputs.route.provider)}"; mount its plugin row, or switch with /model`,
      }
    }
    return {
      label: 'Model',
      status: 'fail',
      detail: `${route} did not resolve: ${displayInlineText(errorChain(error))}`,
      advice: 'the adapter is registered but rejected the lookup; check the provider\'s credentials and base URL',
    }
  }
}

/** Whether anything writes this session down. */
function persistenceCheck(inputs: DoctorInputs): DoctorCheck {
  if (inputs.persistence) return { label: 'Persistence', status: 'pass', detail: 'sessionPersistence is mounted' }
  return {
    label: 'Persistence',
    status: 'warn',
    detail: 'sessionPersistence is not mounted',
    advice: 'this session lives in memory only: it cannot be resumed after exit, and /export re-serializes what is still in RAM',
  }
}

/** Which composition this session's tools, prompt, and skills come from. */
function presetCheck(inputs: DoctorInputs): DoctorCheck {
  if (!inputs.presets) {
    return {
      label: 'Preset',
      status: 'warn',
      detail: 'no agent-preset roster is mounted',
      advice: 'the shipped bundle patch mounts agentPresets; without it /preset lists nothing and every session runs one fixed agent plane',
    }
  }
  if (inputs.preset === undefined) {
    return {
      label: 'Preset',
      status: 'warn',
      detail: 'the roster is mounted but this session names no preset',
      advice: 'the session was opened without joining a preset; start a new one with /new, or select one with /preset',
    }
  }
  return { label: 'Preset', status: 'pass', detail: displayInlineText(inputs.preset) }
}

/**
 * Run every check, in the order the panel prints them.
 * @param inputs - the environment, read by the caller.
 * @returns one answered check per row.
 */
export async function runDoctorChecks(inputs: DoctorInputs): Promise<readonly DoctorCheck[]> {
  return [
    nodeCheck(inputs),
    terminalCheck(inputs),
    screenCheck(inputs),
    colorCheck(inputs),
    await modelCheck(inputs),
    persistenceCheck(inputs),
    presetCheck(inputs),
  ]
}

/** Verdict glyphs, one per status. */
const DOCTOR_GLYPHS: Readonly<Record<DoctorStatus, string>> = { pass: '✓', warn: '!', fail: '✗' }

/** Summary line wording, so the panel's first row states the outcome. */
const DOCTOR_HEALTHY = 'Everything this terminal depends on is in place.'

/**
 * The `/doctor` panel body.
 * @param checks - answered checks, in print order.
 * @param palette - active role palette.
 * @returns pre-rendered rows for the scrollable panel.
 */
export function renderDoctorPanel(checks: readonly DoctorCheck[], palette: Palette): readonly string[] {
  const failed = checks.filter(check => check.status === 'fail').length
  const warned = checks.filter(check => check.status === 'warn').length
  const summary = failed === 0 && warned === 0
    ? DOCTOR_HEALTHY
    : [
      ...failed === 0 ? [] : [`${String(failed)} failed`],
      ...warned === 0 ? [] : [`${String(warned)} to look at`],
    ].join(' · ')
  // One column for every label, so the verdicts line up and the details read as
  // a column of their own rather than as a ragged sentence per row.
  const labelWidth = Math.max(...checks.map(check => check.label.length))
  return [
    palette.dim(summary),
    '',
    ...checks.flatMap((check) => {
      const glyph = DOCTOR_GLYPHS[check.status]
      const mark = check.status === 'pass'
        ? palette.success(glyph)
        : check.status === 'warn' ? palette.warning(glyph) : palette.error(glyph)
      const label = palette.dim(check.label.padEnd(labelWidth))
      return [
        `${mark} ${label}  ${check.detail}`,
        // The advice starts in the detail column, under the observation it
        // answers: a verdict and its remedy are one row's worth of meaning, not
        // two entries. The glyph, its space, and the two after the label are
        // what the detail column costs.
        ...check.advice === undefined ? [] : [palette.dim(`${' '.repeat(labelWidth + 2)}→ ${check.advice}`)],
      ]
    }),
  ]
}

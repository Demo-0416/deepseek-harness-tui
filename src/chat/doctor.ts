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
import { visibleWidth } from '@earendil-works/pi-tui'
import { displayInlineText } from '../components/text.ts'
import { t } from '../i18n/index.ts'
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
  /** The live appearance's `color`: whether this screen emits any SGR at all. */
  readonly color: boolean
  /** Whether the brand art may use 24-bit color, color being on at all. */
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
  const label = t('doctor.label.node')
  const detail = displayInlineText(inputs.nodeVersion)
  if (nodeVersionSupported(inputs.nodeVersion)) return { label, status: 'pass', detail }
  return {
    label,
    status: 'fail',
    detail,
    advice: t('doctor.node.advice', { range: NODE_SUPPORTED_RANGE }),
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
  const label = t('doctor.label.terminal')
  if (inputs.stdinTty && inputs.stdoutTty) {
    return { label, status: 'pass', detail: t('doctor.terminal.pass') }
  }
  // One end or both, as two separate messages rather than one assembled from a
  // subject list and a copula: which words agree with how many is the
  // translation's business, not this function's.
  const detail = inputs.stdinTty || inputs.stdoutTty
    ? t('doctor.terminal.failOne', { end: inputs.stdinTty ? 'stdout' : 'stdin' })
    : t('doctor.terminal.failBoth')
  return {
    label,
    status: 'fail',
    detail,
    advice: t('doctor.terminal.advice'),
  }
}

/** How much screen the layout actually has. */
function screenCheck(inputs: DoctorInputs): DoctorCheck {
  const label = t('doctor.label.screen')
  const detail = `${String(inputs.columns)}x${String(inputs.rows)}`
  if (inputs.columns < NARROW_COLUMNS) {
    return {
      label,
      status: 'warn',
      detail,
      advice: t('doctor.screen.narrowAdvice', { columns: NARROW_COLUMNS }),
    }
  }
  if (inputs.rows < SHORT_ROWS) {
    return {
      label,
      status: 'warn',
      detail,
      advice: t('doctor.screen.shortAdvice', { rows: SHORT_ROWS }),
    }
  }
  return { label, status: 'pass', detail }
}

/**
 * What this terminal is allowed to render.
 *
 * Choice, not detection: the TUI emits the standard 16 colors and lets the
 * terminal map them, so what matters is whether anything turned them off — a
 * disabled palette is legible but flat, which is worth saying out loud before
 * someone reports missing highlighting as a bug. The caller passes the
 * *resolved* appearance rather than the deployment's `theme.color`, because
 * `/theme no-color` puts the switch in the user's hands too, and a check that
 * described the config would pass on a screen that is already plain text.
 */
function colorCheck(inputs: DoctorInputs): DoctorCheck {
  const label = t('doctor.label.color')
  if (!inputs.color) {
    return {
      label,
      status: 'warn',
      detail: t('doctor.color.disabled'),
      advice: t('doctor.color.disabledAdvice'),
    }
  }
  return {
    label,
    status: 'pass',
    detail: inputs.truecolor ? t('doctor.color.truecolor') : t('doctor.color.basic'),
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
  const label = t('doctor.label.model')
  if (inputs.providers.length === 0) {
    return {
      label,
      status: 'fail',
      detail: t('doctor.model.noProvider'),
      advice: t('doctor.model.noProviderAdvice'),
    }
  }
  const providers = inputs.providers.map(provider => displayInlineText(provider)).join(', ')
  if (inputs.route === undefined) {
    return {
      label,
      status: 'fail',
      detail: t('doctor.model.noRoute', { providers }),
      advice: t('doctor.model.noRouteAdvice'),
    }
  }
  const route = displayInlineText(`${inputs.route.provider}/${inputs.route.model}`)
  try {
    await inputs.resolveModelInfo(inputs.route.provider, inputs.route.model)
    return { label, status: 'pass', detail: t('doctor.model.resolves', { route, providers }) }
  } catch (error: unknown) {
    if (isMissingAdapter(error)) {
      return {
        label,
        status: 'fail',
        detail: t('doctor.model.noAdapter', { route }),
        advice: t('doctor.model.noAdapterAdvice', { provider: displayInlineText(inputs.route.provider) }),
      }
    }
    return {
      label,
      status: 'fail',
      detail: t('doctor.model.failed', { route, error: displayInlineText(errorChain(error)) }),
      advice: t('doctor.model.failedAdvice'),
    }
  }
}

/** Whether anything writes this session down. */
function persistenceCheck(inputs: DoctorInputs): DoctorCheck {
  const label = t('doctor.label.persistence')
  if (inputs.persistence) return { label, status: 'pass', detail: t('doctor.persistence.mounted') }
  return {
    label,
    status: 'warn',
    detail: t('doctor.persistence.missing'),
    advice: t('doctor.persistence.advice'),
  }
}

/** Which composition this session's tools, prompt, and skills come from. */
function presetCheck(inputs: DoctorInputs): DoctorCheck {
  const label = t('doctor.label.preset')
  if (!inputs.presets) {
    return {
      label,
      status: 'warn',
      detail: t('doctor.preset.noRoster'),
      advice: t('doctor.preset.noRosterAdvice'),
    }
  }
  if (inputs.preset === undefined) {
    return {
      label,
      status: 'warn',
      detail: t('doctor.preset.unjoined'),
      advice: t('doctor.preset.unjoinedAdvice'),
    }
  }
  return { label, status: 'pass', detail: displayInlineText(inputs.preset) }
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
    ? t('doctor.healthy')
    : [
      ...failed === 0 ? [] : [t('doctor.summary.failed', { count: failed })],
      ...warned === 0 ? [] : [t('doctor.summary.warned', { count: warned })],
    ].join(' · ')
  // One column for every label, so the verdicts line up and the details read as
  // a column of their own rather than as a ragged sentence per row. Measured in
  // display cells rather than code units: a translated label is CJK, where one
  // character costs two columns and `length` would under-pad every row.
  const labelWidth = Math.max(...checks.map(check => visibleWidth(check.label)))
  return [
    palette.dim(summary),
    '',
    ...checks.flatMap((check) => {
      const glyph = DOCTOR_GLYPHS[check.status]
      const mark = check.status === 'pass'
        ? palette.success(glyph)
        : check.status === 'warn' ? palette.warning(glyph) : palette.error(glyph)
      const label = palette.dim(check.label + ' '.repeat(labelWidth - visibleWidth(check.label)))
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

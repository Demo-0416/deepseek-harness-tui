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
import type { Palette } from '../components/theme.ts';
/** Verdict of one check: what the glyph and the color say. */
export type DoctorStatus = 'pass' | 'warn' | 'fail';
/** One answered check, as `/doctor` prints it. */
export interface DoctorCheck {
    /** Column-one subject, e.g. `Node`. */
    readonly label: string;
    readonly status: DoctorStatus;
    /** What was observed, stated as a fact rather than a verdict. */
    readonly detail: string;
    /** The one thing to do about it; absent on a pass, which needs nothing done. */
    readonly advice?: string;
}
/** The `provider/model` a session is pointed at. */
export interface DoctorRoute {
    readonly provider: string;
    readonly model: string;
}
/** Everything `/doctor` reports on, read by the caller and handed over as values. */
export interface DoctorInputs {
    /** `process.version`, including its leading `v`. */
    readonly nodeVersion: string;
    readonly stdinTty: boolean;
    readonly stdoutTty: boolean;
    readonly columns: number;
    readonly rows: number;
    /** The live appearance's `color`: whether this screen emits any SGR at all. */
    readonly color: boolean;
    /** Whether the brand art may use 24-bit color, color being on at all. */
    readonly truecolor: boolean;
    /** Registered provider ids, from `ctx.llm.listProviders()`. */
    readonly providers: readonly string[];
    /** The selected route, or `undefined` when nothing is selected yet. */
    readonly route: DoctorRoute | undefined;
    /** `ctx.llm.resolveModelInfo`, which is what proves the route is reachable. */
    readonly resolveModelInfo: (provider: string, model: string) => Promise<unknown>;
    /** Whether `sessionPersistence` is mounted. */
    readonly persistence: boolean;
    /** Whether the `agentPresets` roster is mounted. */
    readonly presets: boolean;
    /** The preset this session runs, when the roster is mounted and names one. */
    readonly preset: string | undefined;
}
/**
 * Whether a version string satisfies this bundle's `engines.node`.
 * @param version - `process.version`, with or without its leading `v`.
 * @returns true when the version is in range; false for out-of-range AND for
 *   anything that does not parse, since an unreadable version is not a
 *   supported one.
 */
export declare function nodeVersionSupported(version: string): boolean;
/**
 * Run every check, in the order the panel prints them.
 * @param inputs - the environment, read by the caller.
 * @returns one answered check per row.
 */
export declare function runDoctorChecks(inputs: DoctorInputs): Promise<readonly DoctorCheck[]>;
/**
 * The `/doctor` panel body.
 * @param checks - answered checks, in print order.
 * @param palette - active role palette.
 * @returns pre-rendered rows for the scrollable panel.
 */
export declare function renderDoctorPanel(checks: readonly DoctorCheck[], palette: Palette): readonly string[];

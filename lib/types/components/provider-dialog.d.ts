/**
 * The step surface `/login` and `/provider add` share: one inline dialog whose
 * content is swapped as the flow advances, rather than one overlay per step.
 *
 * Swapping beats reopening for a reason the user can see: an overlay closing
 * and another opening in the editor slot flashes the transcript up and down on
 * every step, and a queued modal behind it would win the slot in between. One
 * dialog that outlives the whole flow also gives the flow one place to cancel
 * from, so Esc means the same thing on every step.
 * @module @deepseek-ai/dsh-tui/components/provider-dialog
 */
import { type Component, type Focusable } from '@earendil-works/pi-tui';
import type { Palette } from './theme.ts';
/** One row a select or checklist step offers. */
export interface ProviderWizardItem {
    /** Value handed back when this row is taken. */
    readonly value: string;
    /** Row label. */
    readonly label: string;
    /** Right-hand detail, when the row has any. */
    readonly description?: string;
    /** Group heading printed above this row; repeated headings print once. */
    readonly group?: string;
}
/** Pick exactly one row. */
export interface ProviderWizardSelect {
    readonly kind: 'select';
    readonly title: string;
    /** Context printed above the list. */
    readonly lines?: readonly string[];
    readonly items: readonly ProviderWizardItem[];
    /** Row selected when the step opens. */
    readonly initial?: string;
    readonly onPick: (value: string) => void;
}
/** Type one value. */
export interface ProviderWizardText {
    readonly kind: 'text';
    readonly title: string;
    readonly lines?: readonly string[];
    /** What to type, in the imperative. */
    readonly prompt: string;
    /** Whether the value is a secret, which decides whether it is ever echoed. */
    readonly secret?: boolean;
    /** Value the field opens with. */
    readonly initial?: string;
    /** Reject a value with a reason, or return undefined to accept it. */
    readonly refuse?: (value: string) => string | undefined;
    readonly onSubmit: (value: string) => void;
}
/** Tick any number of rows. */
export interface ProviderWizardChecklist {
    readonly kind: 'checklist';
    readonly title: string;
    readonly lines?: readonly string[];
    readonly items: readonly ProviderWizardItem[];
    /** Rows ticked when the step opens. */
    readonly initial?: readonly string[];
    readonly onSubmit: (values: readonly string[]) => void;
}
/** One step of a provider flow. */
export type ProviderWizardStep = ProviderWizardSelect | ProviderWizardText | ProviderWizardChecklist;
/**
 * The step dialog both provider flows drive.
 *
 * The component owns presentation and key handling; every decision about what
 * comes next belongs to the controller that calls {@link setStep}. That split
 * is what lets the flows differ (one re-keys a route, the other builds one)
 * while looking and behaving identically.
 */
export declare class ProviderWizard implements Component, Focusable {
    private readonly maxVisible;
    private readonly palette;
    private readonly cancel;
    private readonly redraw;
    private step;
    private cursor;
    private ticked;
    private value;
    private pasting;
    private refusal;
    private status;
    private busy;
    focused: boolean;
    constructor(initial: ProviderWizardStep, maxVisible: number, palette: Palette, cancel: () => void, redraw: () => void);
    /**
     * Show a different step.
     *
     * Every per-step state is reset here rather than by the caller, so a flow
     * cannot leak a half-typed value or a stale refusal into the next question.
     * @param step - the step to show.
     */
    setStep(step: ProviderWizardStep): void;
    /**
     * Hold the dialog while the flow waits on something slow.
     *
     * The step stays on screen underneath: a probe that replaced the form with a
     * spinner would leave the user unable to see what they had entered when it
     * failed.
     * @param message - what the flow is doing, in the present tense; empty clears it.
     */
    setStatus(message: string): void;
    /** Show a refusal above the control without disturbing what was typed. */
    setRefusal(message: string): void;
    private adoptStep;
    invalidate(): void;
    handleInput(data: string): void;
    private handleTextInput;
    private submitText;
    private handleListInput;
    /** The slice of rows on screen, keeping the cursor inside it. */
    private windowed;
    render(width: number): string[];
    private renderText;
    private renderList;
    private renderRow;
    private footer;
}

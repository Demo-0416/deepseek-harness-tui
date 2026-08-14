/**
 * Mutable terminal-prompt value registry consumed by the TUI template renderer.
 * Values are trusted presentation fragments and may contain ANSI control sequences.
 * @module @deepseek-ai/dsh-tui/prompt
 */
import { Context, Service } from '@deepseek-ai/cordis';
export declare const name = "tui-prompt";
/** Handle owned by one prompt-value registration. */
export interface TuiPromptValueHandle {
    /**
     * Replace the current fragment and schedule a coalesced change notification
     * so the owning renderer redraws. Setting the current value again is a no-op.
     * @param value - Trusted ANSI-capable fragment, or `undefined` while unavailable.
     */
    set(value: string | undefined): void;
    /** Unregister this value; subsequent {@link TuiPromptValueHandle.set} calls fail. */
    dispose(): void;
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        tuiPrompt: TuiPromptService;
    }
}
/** Removes a change subscription registered with {@link TuiPromptService.subscribe}. */
export type TuiPromptUnsubscribe = () => void;
/** One literal or variable token in a parsed TUI prompt template. */
export type TuiPromptTemplateToken = {
    readonly kind: 'literal';
    readonly value: string;
} | {
    readonly kind: 'value';
    readonly name: string;
};
/**
 * Parse a prompt template into immutable literal and value tokens.
 * @param template - Text containing `${name}` references.
 * @returns Tokens consumed by {@link renderTuiPromptTemplate}.
 */
export declare function parseTuiPromptTemplate(template: string): readonly TuiPromptTemplateToken[];
/**
 * Interpolate one parsed prompt while removing horizontal separators adjacent
 * only to unavailable values.
 * @param tokens - Parsed template tokens.
 * @param resolve - Current value lookup.
 * @returns ANSI-capable rendered prompt text.
 */
export declare function renderTuiPromptTemplate(tokens: readonly TuiPromptTemplateToken[], resolve: (name: string) => string | undefined): string;
/**
 * Context-global mutable values interpolated by TUI theme prompt templates.
 * A registration, mutation, or disposal schedules one coalesced notification to
 * the renderer subscribed with {@link TuiPromptService.subscribe}, so a value
 * that changes on its own schedule (not only in response to a UI event) still
 * redraws. Notification is a direct in-service callback, not a Cordis event.
 */
export declare class TuiPromptService extends Service {
    private readonly values;
    private readonly listeners;
    private notificationQueued;
    constructor(ctx: Context);
    /**
     * Register one globally unique template value under the calling Cordis effect.
     * @param name - Lowercase slash-separated template name.
     * @param initialValue - Initial trusted ANSI-capable fragment.
     * @returns A mutable handle whose disposal unregisters the name.
     */
    register(name: string, initialValue?: string): TuiPromptValueHandle;
    /**
     * Read a registered fragment without evaluating plugin code.
     * @param name - Exact registered template name.
     * @returns The current fragment, or `undefined` when unknown or unavailable.
     */
    get(name: string): string | undefined;
    /**
     * Observe registration and value changes. The listener runs after a coalesced
     * microtask following any burst of mutations; the renderer re-reads current
     * values on that callback. The subscription is owned by the calling Cordis
     * effect, so it is removed when the subscriber's fiber disposes; the returned
     * disposer removes it early. Listener failures are contained — a synchronous
     * throw or a rejected returned promise cannot starve the other observers.
     * @param listener - Invoked once per coalesced change burst. Delivery does
     *   not wait on a returned promise; its rejection is only observed and logged,
     *   never left unhandled, so an async listener cannot order later observers.
     * @returns A disposer that removes the subscription.
     */
    subscribe(listener: () => unknown): TuiPromptUnsubscribe;
    /** Coalesce mutation bursts into one notification while containing each observer. */
    private scheduleChange;
    /** Deliver one change notification, containing a synchronous throw or a rejected promise. */
    private notifyOne;
}
export default TuiPromptService;

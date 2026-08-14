/**
 * Private bridge between the public TUI extension contract and pi-tui.
 *
 * The manager serializes modal ownership, guards extension callbacks, and
 * settles every queued or active operation before terminal teardown.
 * @module @deepseek-ai/dsh-tui/extension/overlay-manager
 */
import { Service, type Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { TuiExtensionService } from '../index.ts';
import type { Component } from '@earendil-works/pi-tui';
import type { TuiOverlayCloseReason, TuiOverlayOutcome, TuiOverlayOptions, TuiOverlayRequest, TuiOverlaySession, TuiTheme, TuiViewport } from './types.ts';
/** pi-tui operations retained by the front door instead of exposed to plugins. */
export interface TuiOverlayDriver {
    /** Current terminal viewport. */
    viewport(): TuiViewport;
    /** Current semantic theme facade. */
    theme(): TuiTheme;
    /** Escape text at the terminal display boundary. */
    display(value: string): string;
    /** Mount one guarded modal and return its private focus/lifecycle handle. */
    show(component: Component, options: TuiOverlayOptions | undefined, placement: TuiOverlayPlacement): TuiModalHandle;
    /** Invalidate the mounted UI and request a render. */
    invalidate(): void;
    /** Report a contained extension failure. */
    reportError(error: unknown): void;
}
type TuiOverlayPlacement = 'overlay' | 'inline';
interface TuiModalHandle {
    hide(): void;
}
/** FIFO modal owner for one mounted TUI. */
export declare class TuiOverlayManager {
    private readonly driver;
    private readonly queue;
    private active;
    private accepting;
    private disposeTask;
    constructor(driver: TuiOverlayDriver);
    /**
     * Whether one extension or built-in overlay currently owns terminal focus.
     * @returns `true` while an overlay is active.
     */
    hasActiveOverlay(): boolean;
    /** Reject new work while the TUI unloads dependent extension fibers. */
    beginShutdown(): void;
    /**
     * Queue one modal without assigning Cordis ownership.
     *
     * An arriving inline request first takes down an active
     * {@link TuiOverlayRequest.dismissable} surface, so a permission prompt or a
     * question reaches the screen even when the user left a panel or a selector
     * open. Without that, the single inline slot let a view the user was merely
     * reading hide the decision a turn was blocked on, and the turn hung with
     * nothing on screen to answer.
     * @param request - component factory, constraints, and request signal.
     * @param placement - terminal overlay for extensions, or inline for the built-in question panel.
     * @returns an internal session that can close with an ownership reason.
     */
    open(request: TuiOverlayRequest, placement?: TuiOverlayPlacement): TuiOverlaySession & {
        closeWith(reason: Exclude<TuiOverlayCloseReason, 'error'>): Promise<TuiOverlayOutcome>;
    };
    /** Close an active dismissable surface so an arriving inline one takes the slot. */
    private dismissActive;
    /** Stop accepting work and settle every active or queued overlay. */
    dispose(): Promise<void>;
    private activateNext;
    private host;
    private fail;
    private report;
    private hide;
    private close;
}
/**
 * A forwarding view of one manager that marks every request it opens
 * {@link TuiOverlayRequest.dismissable}.
 *
 * Sub-controllers (the model selector) receive the manager itself rather than a
 * per-request flag, so the channel marks their whole surface where it hands the
 * manager over. The view holds no state of its own — every method forwards to
 * the one manager, which is why the cast is safe.
 * @param manager - the single manager that owns the modal slot.
 * @returns a manager view whose overlays yield to arriving decisions.
 */
export declare function dismissableOverlays(manager: TuiOverlayManager): TuiOverlayManager;
/** Cordis service whose method effects bind to the calling plugin fiber. */
export declare class TuiExtensionServiceImpl extends Service implements TuiExtensionService {
    readonly agent: Agent;
    private readonly overlays;
    constructor(ctx: Context, agent: Agent, overlays: TuiOverlayManager);
    /** @inheritdoc */
    openOverlay(request: TuiOverlayRequest): TuiOverlaySession;
}
export {};

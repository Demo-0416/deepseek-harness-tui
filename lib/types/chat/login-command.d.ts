/**
 * Provider sign-in sub-controller for the interactive chat channel: the queued
 * `/login` command, which gives an existing or catalog-known provider a key,
 * and `/provider`, which lists what is configured and adds a route the catalog
 * has never heard of.
 *
 * Both flows end in the same two writes and the same honesty rule: the terminal
 * says what it actually verified and what actually takes effect, never that a
 * key works because it was stored, and never that a provider is live because
 * the write succeeded.
 * @module @deepseek-ai/dsh-tui/chat/login-command
 */
import type { ChannelNotice, ChannelPendingHint, ChatChannelDeps } from './channel.ts';
/** Collaborators the login controller needs from the chat channel. */
export type LoginControllerDeps = ChatChannelDeps & ChannelNotice & ChannelPendingHint;
/** Provider sign-in controller for one chat channel. */
export interface LoginController {
    /** Queue a `/login` command; the argument pre-selects a provider. */
    queueLoginCommand(raw: string): void;
    /** Queue a `/provider` command; `add` starts the new-route form. */
    queueProviderCommand(raw: string): void;
    /** Forget the tracked wizard overlay (shutdown). */
    clearOverlay(): void;
}
/**
 * Build the provider sign-in controller for one chat channel.
 * @param deps - channel collaborators.
 * @returns the controller wired to the channel's overlay and notice surfaces.
 */
export declare function createLoginController(deps: LoginControllerDeps): LoginController;

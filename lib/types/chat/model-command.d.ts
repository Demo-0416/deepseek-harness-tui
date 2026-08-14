/**
 * Model-selection sub-controller for the interactive chat channel: the queued
 * `/model` command, the keyboard model selector overlay with reasoning-effort
 * selection, and resolution of the selected model's context window. Owns the
 * context-window cache the prompt and status views read; the caller owns the
 * shared {@link ModelSelectionRef}.
 * @module @deepseek-ai/dsh-tui/chat/model-command
 */
import type { ModelSelectionRef } from '@deepseek-ai/dsh-agent';
import type { ChannelNotice, ChannelPendingHint, ChatChannelDeps } from './channel.ts';
/** Collaborators the model controller needs from the chat channel. */
export interface ModelControllerDeps extends ChatChannelDeps, ChannelNotice, ChannelPendingHint {
    /** Shared selected-target handle owned by the channel. */
    readonly target: ModelSelectionRef;
}
/** Model-selection controller for one chat channel. */
export interface ModelController {
    /** Resolved context window of the selected model, or `undefined` if unknown. */
    contextWindow(): number | undefined;
    /** Queue a `/model` command; empty argument opens the selector. */
    queueModelCommand(raw: string): void;
    /** Drop the pending context-window resolution (shutdown). */
    resetContextResolution(): void;
    /** Forget the tracked selector overlay (shutdown). */
    clearOverlay(): void;
    /** Remove the adapter-registration listener (channel detach). */
    detach(): void;
}
/**
 * Build the model-selection controller for one chat channel.
 * @param deps - channel collaborators and shared target handle.
 * @returns the controller wired to the channel's overlay and prompt views.
 */
export declare function createModelController(deps: ModelControllerDeps): ModelController;

/**
 * Session-resume sub-controller for the interactive chat channel: the
 * `/resume` selector, one metadata-plus-title scan that tolerates a corrupt
 * neighbor, the pre-handoff preflight, and the terminal handoff itself.
 * @module @deepseek-ai/dsh-tui/chat/resume
 */
import type { TUI } from '@earendil-works/pi-tui';
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent';
import type { SessionQueryEngine } from '@deepseek-ai/dsh-session-query';
import type { HintEditor } from './helpers.ts';
import type { TuiRuntime } from '../runtime.ts';
import type { ChannelNotice, ChatChannelDeps } from './channel.ts';
/** Collaborators the resume controller needs from the chat channel. */
export interface ResumeControllerDeps extends ChatChannelDeps, ChannelNotice {
    readonly agent: Agent;
    readonly runtime: TuiRuntime;
    /**
     * The optional session-query service, re-read at each use. `sessionQuery` is
     * mounted by an independent plugin, and a flat config tree gives no ordering
     * guarantee between it and this front door, so a value captured once at
     * construction can be `undefined` even though the service arrives moments later.
     */
    readonly sessionQuery: (this: void) => SessionQueryEngine | undefined;
    readonly ui: TUI;
    readonly editor: HintEditor;
    /** Current agent status, re-read at each resume precondition point. */
    agentStatus(): AgentStatus;
}
/** Session-resume controller for one chat channel. */
export interface ResumeController {
    /**
     * Open the searchable session selector, scoped to this workspace until the user widens it.
     * @param query - `/resume`'s argument, pre-filling the picker's search box; empty opens the full list.
     */
    showResume(query?: string): void;
}
/**
 * Build the session-resume controller for one chat channel.
 * @param deps - channel collaborators, terminal handles, and optional services.
 * @returns the controller wired to the `/resume` command.
 */
export declare function createResumeController(deps: ResumeControllerDeps): ResumeController;

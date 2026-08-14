/**
 * Agent-preset sub-controller for the interactive chat channel: the queued
 * `/preset` command, the keyboard preset selector overlay, the blank-window
 * switch, the saved default, and `/preset copy`. Also owns the reading of which
 * preset a session actually runs, which the `/status` card shows.
 *
 * A preset is one session's model-facing composition — its tools, its prompt
 * sections, its skill catalog — so switching one is not a display setting. The
 * rules this controller enforces are the Web host's, not new ones:
 *
 *   - a session that has run a turn cannot change preset, because its history
 *     was produced under that composition's tools and replaying it under
 *     another would call tools the model can no longer make. Picking one then
 *     saves it as the default for sessions created later, which is the only
 *     thing left that the pick can honestly mean;
 *   - a blank session may switch, and the switch is recorded in its log rather
 *     than only in its creation header, because every turn from here runs under
 *     the new composition.
 *
 * The roster is an optional mount. Nothing here imports its package at runtime:
 * a bundle that hard-required an optional peer would fail to load in a
 * deployment that composes no presets at all.
 * @module @deepseek-ai/dsh-tui/chat/preset-command
 */
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { PresetBearingSession } from '@deepseek-ai/dsh-agent-presets';
import type { ChannelNotice, ChatChannelDeps } from './channel.ts';
/**
 * Settings namespace carrying the user's chosen default preset — the same one
 * the roster resolves `defaultId` through, and the same one the Web settings
 * row writes. Restated rather than imported for the reason in the module note.
 */
export declare const PRESET_SETTINGS_NAMESPACE = "agent-presets";
/** What `/preset` says when this deployment composes no preset roster. */
export declare const PRESETS_UNAVAILABLE = "Agent presets are not mounted in this profile. Add @deepseek-ai/dsh-agent-presets to the bundle to compose sessions from a preset.";
/** Collaborators the preset controller needs from the chat channel. */
export interface PresetControllerDeps extends ChatChannelDeps, ChannelNotice {
    /** The agent this terminal drives; its scope is what a switch re-links. */
    readonly agent: Agent;
}
/** Agent-preset controller for one chat channel. */
export interface PresetController {
    /**
     * The preset this session runs, for the `/status` card.
     * @returns the preset id, or `undefined` when the deployment composes none.
     */
    currentPreset(): string | undefined;
    /** Queue a `/preset` command; an empty argument opens the selector. */
    queuePresetCommand(raw: string): void;
    /** Forget the tracked selector overlay (shutdown). */
    clearOverlay(): void;
}
/**
 * The preset a session actually runs, newest logged selection winning over the
 * creation header.
 *
 * This is the roster package's own `resolveSessionPreset`, restated here rather
 * than imported: the package is an optional peer, and a static import of it
 * would make a deployment that composes no presets fail to load this bundle at
 * all. The fold is the contract — the header states what the session was
 * CREATED with, and a blank-window switch that is not read back would rebuild a
 * resumed session under the composition its history was not produced under.
 * @param session - the session's header and event log.
 * @returns the preset id, or `undefined` when neither names one.
 */
export declare function sessionAgentPreset(session: PresetBearingSession): string | undefined;
/**
 * Build the agent-preset controller for one chat channel.
 * @param deps - channel collaborators and the driven agent.
 * @returns the controller wired to the channel's overlay and notice surfaces.
 */
export declare function createPresetController(deps: PresetControllerDeps): PresetController;

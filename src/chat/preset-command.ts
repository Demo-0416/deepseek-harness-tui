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

import { dirname } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { errorChain } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
// Type-only, and load-bearing twice over: it declaration-merges `agentPresets`
// onto `Context` so the roster below is read by name rather than by cast, and
// it merges `agent-preset/selected` onto the session event map so the switch
// this file records is a typed append rather than an invented event name.
import type {} from '@deepseek-ai/dsh-agent-presets'
import type { PresetBearingSession } from '@deepseek-ai/dsh-agent-presets'
import type { TuiOverlaySession } from '../extension/types.ts'
import { PresetDialog, type PresetChoice } from '../components/dialogs.ts'
import type { ChannelNotice, ChatChannelDeps } from './channel.ts'

/**
 * Settings namespace carrying the user's chosen default preset — the same one
 * the roster resolves `defaultId` through, and the same one the Web settings
 * row writes. Restated rather than imported for the reason in the module note.
 */
export const PRESET_SETTINGS_NAMESPACE = 'agent-presets'

/** What `/preset` says when this deployment composes no preset roster. */
export const PRESETS_UNAVAILABLE = 'Agent presets are not mounted in this profile. Add @deepseek-ai/dsh-agent-presets to the bundle to compose sessions from a preset.'

/** Collaborators the preset controller needs from the chat channel. */
export interface PresetControllerDeps extends ChatChannelDeps, ChannelNotice {
  /** The agent this terminal drives; its scope is what a switch re-links. */
  readonly agent: Agent
}

/** Agent-preset controller for one chat channel. */
export interface PresetController {
  /**
   * The preset this session runs, for the `/status` card.
   * @returns the preset id, or `undefined` when the deployment composes none.
   */
  currentPreset(): string | undefined
  /** Queue a `/preset` command; an empty argument opens the selector. */
  queuePresetCommand(raw: string): void
  /** Forget the tracked selector overlay (shutdown). */
  clearOverlay(): void
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
export function sessionAgentPreset(session: PresetBearingSession): string | undefined {
  for (let index = session.events.length - 1; index >= 0; index -= 1) {
    const event = session.events[index]
    if (event?.type === 'agent-preset/selected') return event.data.agentPreset
  }
  return session.header.agentPreset
}

/**
 * Whether the session's conversation has started: no turn has run yet.
 *
 * The Host draws the same line for the same reason — standalone plugin events
 * (command records, plan mode, titles, goals) never open a turn, so running
 * `/plan` on a fresh session leaves it switchable.
 * @param session - the session to judge.
 * @returns true while no turn has started.
 */
function sessionBlank(session: Session): boolean {
  return !session.events.some(event => event.type === 'turn/start')
}

/**
 * The human sentence one authoring refusal deserves, or `undefined` when the
 * failure is not one this command can explain better than the package did.
 *
 * Matched on the constructor name, never with `instanceof`: this bundle
 * resolves `@deepseek-ai/dsh-agent-presets` from its own installation while the
 * runtime that mounts the roster resolves the host's, so the two class objects
 * are different and an `instanceof` guard is false for the very error it exists
 * to recognize (the same reason `model-command.ts` matches `LlmError` by code).
 * An unrecognized failure falls back to the package's own message, which is
 * already a full sentence.
 * @param error - the rejection from an authoring call.
 * @param id - the id the caller was trying to create.
 * @returns the sentence to show, or `undefined` to fall back.
 */
function authoringRefusal(error: unknown, id: string): string | undefined {
  const name: unknown = (error as { constructor?: { name?: unknown } } | undefined)?.constructor?.name
  if (name === 'PresetExistsError') {
    return `A preset named "${id}" already exists. A copy never overwrites — choose another id.`
  }
  if (name === 'InvalidPresetIdError') {
    return `"${id}" is not a usable preset id: the id becomes a directory name, so it must be lower-case letters, digits, and dashes, starting with a letter or digit.`
  }
  if (name === 'PresetNotWritableError') {
    return `This deployment has nowhere to author presets, so "${id}" cannot be created.`
  }
  return undefined
}

/**
 * Build the agent-preset controller for one chat channel.
 * @param deps - channel collaborators and the driven agent.
 * @returns the controller wired to the channel's overlay and notice surfaces.
 */
export function createPresetController(deps: PresetControllerDeps): PresetController {
  const { ctx, resolved, palette, overlayManager, agent } = deps
  let presetOverlay: TuiOverlaySession | undefined
  // Serialized for the reason the Host serializes its own preset selects: two
  // switches in flight over one session would both pass the blank check, and
  // the second would re-link a composition the first had already moved.
  let presetCommands = Promise.resolve()

  /**
   * Persist one preset as the default for sessions created later.
   *
   * The settings service is read through the non-throwing accessor and
   * shape-checked rather than typed, exactly like `agentDefaultModel` in the
   * model controller: a settings provider is a deployment choice, and a TUI
   * embedded without one must still answer rather than throw.
   * @param id - the preset to make default.
   * @throws when no settings provider is mounted, or the write is refused.
   */
  const saveDefaultPreset = async (id: string): Promise<void> => {
    const service = ctx.get('settings') as unknown as {
      update?: (namespace: string, patch: object) => Promise<void>
    } | undefined
    // Called as a member so the service keeps its `this`; a synchronous throw
    // from an out-of-contract implementation lands in the caller's catch.
    if (typeof service?.update !== 'function') {
      throw new Error('this deployment mounts no settings provider')
    }
    await service.update(PRESET_SETTINGS_NAMESPACE, { default: id })
  }

  /**
   * Apply one picked preset, which means two different things by design.
   *
   * A blank session is recomposed in place and the choice is recorded in its
   * log; a started session cannot be recomposed at all, so the pick becomes the
   * default for sessions created later. Both are reported in the sentence that
   * says which one happened, because the two outcomes are not interchangeable.
   * @param id - the chosen preset id.
   */
  const applyPreset = async (id: string): Promise<void> => {
    const presets = ctx.get('agentPresets')
    if (presets === undefined) {
      deps.appendNotice(PRESETS_UNAVAILABLE, 'warning')
      return
    }
    if (!sessionBlank(agent.session)) {
      try {
        await saveDefaultPreset(id)
      } catch (error: unknown) {
        if (deps.isDisposed()) return
        deps.appendNotice(`Preset "${id}" could not be saved as the default: ${errorChain(error)}`, 'warning')
        return
      }
      if (deps.isDisposed()) return
      // Headline first, reason second, on their own lines: what happened has to
      // survive the notice column, and what did NOT happen is the follow-up.
      deps.appendNotice([
        `Preset saved as the default. New sessions will use ${id}.`,
        'This session has already started, so its own preset is fixed.',
      ].join('\n'))
      return
    }
    if (sessionAgentPreset(agent.session) === id) {
      deps.appendNotice(`Preset is already ${id}.`)
      return
    }
    let preset: { id: string }
    try {
      preset = await presets.recompose(agent.ctx, id)
    } catch (error: unknown) {
      if (deps.isDisposed()) return
      // The roster refuses an unknown id and an unusable composition in its own
      // words — one carries the ids that do exist, the other the reason
      // discovery read — and both are more useful than anything restated here.
      deps.appendNotice(`Could not select preset "${id}": ${errorChain(error)}`, 'error')
      return
    }
    if (deps.isDisposed()) return
    // Recorded only after the swap committed, the way the Host records it: the
    // log states what the agent RUNS, and a rejected mount leaves the previous
    // composition in place with nothing to record.
    agent.session.append('agent-preset/selected', { agentPreset: preset.id })
    deps.appendNotice(`Preset selected: ${preset.id}. This session now runs it.`)
  }

  const showPresetSelector = (choices: readonly PresetChoice[], defaultId: string): void => {
    const current = sessionAgentPreset(agent.session)
    if (choices.length === 0) {
      deps.appendNotice('This deployment\'s preset roots supply no presets.', 'warning')
      return
    }
    void presetOverlay?.close()
    const session = overlayManager.open({
      create: () => new PresetDialog(
        choices,
        current,
        defaultId,
        resolved.maxModelOptions,
        palette,
        (choice: PresetChoice) => {
          void session.close()
          // The list shows broken presets so their directories are visible; it
          // is this refusal, not a hidden row, that keeps one from composing.
          if (choice.broken !== undefined) {
            deps.appendNotice(`Preset "${choice.id}" cannot compose a session: ${choice.broken}`, 'error')
            return
          }
          queue(() => applyPreset(choice.id))
        },
        () => { void session.close() },
      ),
      options: {
        width: resolved.modelDialogWidth,
        maxHeight: resolved.modelDialogMaxHeight,
      },
      // A picker, not a decision the agent waits on: it sits under the
      // conversation in the editor slot like every other interactive surface.
    }, 'inline')
    presetOverlay = session
    void session.closed.then(() => {
      if (presetOverlay === session) presetOverlay = undefined
    })
    deps.requestRender()
  }

  /**
   * Create a locally authored preset by copying an existing one whole.
   *
   * Copy is the roster's only authoring write, and the landed path is read back
   * through `resolve` rather than reported from the call: the service returns
   * nothing, and a directory named in a confirmation must be one that is
   * actually on the roster now.
   * @param from - the preset the copy starts from.
   * @param id - the new preset's id, which becomes its directory name.
   */
  const copyPreset = async (from: string, id: string): Promise<void> => {
    const presets = ctx.get('agentPresets')
    if (presets === undefined) {
      deps.appendNotice(PRESETS_UNAVAILABLE, 'warning')
      return
    }
    try {
      await presets.copy(from, id)
    } catch (error: unknown) {
      if (deps.isDisposed()) return
      deps.appendNotice(authoringRefusal(error, id) ?? `Could not copy preset "${from}" to "${id}": ${errorChain(error)}`, 'error')
      return
    }
    let landed: string | undefined
    try {
      landed = dirname((await presets.resolve(id)).path)
    } catch {
      // The copy committed; only the read-back of where it landed failed, and
      // a confirmation without a path still reports the thing that happened.
      landed = undefined
    }
    if (deps.isDisposed()) return
    deps.appendNotice(landed === undefined
      ? `Preset "${id}" created from "${from}". Run /preset ${id} to use it.`
      : `Preset "${id}" created from "${from}" at ${landed}. Run /preset ${id} to use it.`)
  }

  const handlePresetCommand = async (raw: string): Promise<void> => {
    const parts = raw.trim().split(/\s+/u).filter(part => part !== '')
    const [first, second, third] = parts
    if (first === 'copy') {
      if (second === undefined || third === undefined || parts.length > 3) {
        deps.appendNotice('Usage: /preset copy <preset> <new-id>', 'warning')
        return
      }
      await copyPreset(second, third)
      return
    }
    if (parts.length > 1) {
      deps.appendNotice('Usage: /preset [<preset> | copy <preset> <new-id>]', 'warning')
      return
    }
    const presets = ctx.get('agentPresets')
    if (presets === undefined) {
      deps.appendNotice(PRESETS_UNAVAILABLE, 'warning')
      return
    }
    if (first !== undefined) {
      await applyPreset(first)
      return
    }
    // Discovery is unmemoized on purpose: a preset authored while this process
    // runs is on the next listing, so the selector reads the roster per open.
    const listed = await presets.list()
    const defaultId = presets.defaultId
    if (deps.isDisposed()) return
    showPresetSelector(listed.map(preset => ({
      id: preset.id,
      trust: preset.trust,
      ...preset.name === undefined ? {} : { name: preset.name },
      ...preset.description === undefined ? {} : { description: preset.description },
      ...preset.broken === undefined ? {} : { broken: preset.broken },
    })), defaultId)
  }

  /** Put one preset operation on the channel's single-writer chain. */
  const queue = (operation: () => Promise<void>): void => {
    presetCommands = presetCommands.then(operation).catch((error: unknown) => {
      if (!deps.isDisposed()) deps.appendNotice(`Agent preset command failed: ${errorChain(error)}`, 'error')
    })
  }

  return {
    currentPreset(): string | undefined {
      // Gated on the roster being mounted, not on the log alone: a log written
      // under a profile that composed presets can be resumed under one that
      // does not, and naming a composition nothing mounts would describe a
      // layer that is not there — the same rule the Permission row follows.
      if (ctx.get('agentPresets') === undefined) return undefined
      return sessionAgentPreset(agent.session)
    },
    queuePresetCommand(raw: string): void {
      queue(() => handlePresetCommand(raw))
    },
    clearOverlay(): void {
      presetOverlay = undefined
    },
  }
}

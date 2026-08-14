/**
 * Keyed transcript reconciler: the only writer of the chat container's children.
 *
 * It takes a folded node list (see `core/nodes.ts`) and maintains one component
 * instance per node key. A node whose `version` it has already applied is left
 * untouched, so a burst of stream chunks re-renders one assistant step rather
 * than rebuilding the transcript; a node that stops rendering (a `/clear`
 * watermark, a palette reset, a withdrawn submission) drops its component.
 *
 * One placement is not a plain node→component map and lives here: a step's
 * timing footer trails the tool cards that step requested.
 * Process-local rows the entry appends (command output, notices, the status
 * card) are interleaved by the node count they were appended at, so they keep
 * their place in the conversation as the log grows.
 * @module @deepseek-ai/dsh-tui/components/reconciler
 */

import { Container, Spacer, Text, type Component } from '@earendil-works/pi-tui'
import type { MarkdownTheme, TerminalColorScheme } from '@earendil-works/pi-tui'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type {
  AssistantNode,
  ChatNode,
  ToolCallNode,
  UserMessageNode,
} from '../core/types.ts'
import type { StepTimingTracker } from '../chat/timing.ts'
import { collapseToolGroups, type CollapsedGroup } from '../core/collapse.ts'
import { displayPath } from '../chat/helpers.ts'
import { displayText } from './text.ts'
import type { Palette } from './theme.ts'
import { t } from '../i18n/index.ts'
import { withTuiPresenters } from './tool-presenters.ts'
import {
  CollapsedGroupComponent,
  ContextCardComponent,
  StreamingAssistantComponent,
  ToolCardComponent,
  turnCompletionVerb,
  turnFooterRow,
  TURN_FOOTER_MIN_MS,
  UserMessageComponent,
  type MarkdownPolicy,
  type ToolCardVisibility,
} from './transcript.ts'

/**
 * Transcript row standing in for one compacted range. The conversation the
 * compaction replaced stays rendered above it: the marker reports where the
 * model stopped seeing that history, not that the history is gone.
 *
 * The English form, for the docs suite and for tests; the row itself is read
 * from the message table per render, so `/lang` moves it.
 */
export const COMPACTION_MARKER = t('transcript.compactionMarker', undefined, 'en')

/** Label above a prompt that was submitted into a running turn, in English. */
export const STEERING_BADGE = t('transcript.steeringBadge', undefined, 'en')

/**
 * The status line one Ctrl+O phase reports.
 *
 * Only the expanded phase renders injected context at all (see
 * {@link TranscriptReconciler.reconcile}), so the collapsed sentence no longer
 * claims to be showing context cards: it names what each kind of card actually
 * does in that phase — including the read/search runs it reports as one row.
 * The hidden and expanded sentences are unchanged, because what they said was
 * already true.
 * @param visibility - The phase the cycle just entered.
 * @returns One sentence naming what that phase leaves on screen.
 */
export function cardPhaseNotice(visibility: ToolCardVisibility): string {
  if (visibility === 'hidden') return t('status.flash.cardsHidden')
  if (visibility === 'expanded') return t('status.flash.cardsExpanded')
  return t('status.flash.cardsCollapsed')
}

/** Everything the reconciler needs to build a component for a node. */
export interface TranscriptDeps {
  /** Active palette; mutated in place by a color-scheme change. */
  readonly palette: Palette
  /** Active Markdown theme, likewise mutated in place. */
  readonly mdTheme: MarkdownTheme
  /**
   * The terminal's reported color scheme, read per mount rather than captured:
   * the fills a component picks from it (the user block's background) are the
   * one thing the role palette cannot carry, and a scheme change remounts every
   * component through {@link TranscriptReconciler.reset} anyway.
   */
  readonly scheme: () => TerminalColorScheme
  /** Preferred assistant-body renderer and its one-shot failure report. */
  readonly markdown: MarkdownPolicy
  /** Collapsed-preview budget for card bodies. */
  readonly maxToolOutputLines: number
  /** Edit-distance budget before a diff falls back to whole-side rows. */
  readonly maxDiffEditLength: number
  /** The session log, read by each step's timing footer. */
  readonly events: () => readonly SessionEvent[]
  /** Shared per-step timing accumulator. */
  readonly tracker: StepTimingTracker
  /** Render clock. */
  readonly now: () => number
  /** Tool definition lookup, so a card can use the tool's own presenters. */
  readonly toolDefinition: (name: string) => ToolDefinition | undefined
  /** Workspace directory a collapsed group's file hint is shortened against. */
  readonly cwd: string
  /**
   * The label of the key that currently cycles tool cards, read per render.
   * `app.tools.cycle` is rebindable, so the two rows that offer to expand — the
   * collapsed group's hint and a card's folded XML body — have to name whatever
   * the manager resolved rather than the shipped default.
   */
  readonly expandKey: () => string
}

/**
 * One process-local row group: the recipe that builds it, and the components
 * that recipe last produced.
 *
 * The recipe is kept because the components are disposable. Every row holds the
 * escapes of the palette it was built under, so a color-scheme change has to
 * rebuild it — and a local row has no node to rebuild it *from*, which is why
 * dropping the locals on reset silently deleted every command answer and notice
 * from the transcript the moment the terminal changed scheme. Holding the
 * builder makes them as reconstructible as a node-backed row.
 */
interface LocalRows {
  /** Builds the row group under whatever palette is current when it runs. */
  readonly build: () => Component[]
  /** The components currently mounted for this group. */
  components: Component[]
}

/** One node's mounted component(s) and the node version they were built from. */
type NodeView =
  | { kind: 'assistant'; version: number; component: StreamingAssistantComponent }
  | { kind: 'tool'; version: number; component: ToolCardComponent; argsRaw: string }
  | { kind: 'group'; signature: string; component: CollapsedGroupComponent }
  | { kind: 'plain'; version: number; component: Component }

/**
 * A collapsed row's view key: the first member's node key, prefixed so it can
 * never collide with that member's own card key. The first member of a group is
 * stable — the log only appends, so nothing can land above it.
 */
function groupKey(group: CollapsedGroup): string {
  return `collapsed:${group.keys[0] ?? group.index}`
}

/**
 * Everything a collapsed row shows, as one string. The group is re-planned from
 * scratch on every snapshot, so the mounted component is refreshed by what the
 * row would say rather than by object identity — a group whose counts did not
 * move keeps its cached rows.
 */
function groupSignature(group: CollapsedGroup): string {
  return [
    group.searchCount,
    group.readCount,
    group.listCount,
    group.mcpCallCount,
    group.mcpServers.join('|'),
    // The closed thinking total only: an open span's *start* never moves, so it
    // says nothing about what the row currently reads. That row is refreshed by
    // {@link TranscriptReconciler.invalidateOpenStep} instead, on the animation
    // tick, which is what a signature over node facts cannot do.
    group.thinkingMs,
    group.thinkingSince ?? '',
    group.running,
    group.active,
    group.failed,
    group.hint?.kind ?? '',
    group.hint?.value ?? '',
  ].join(' ')
}

/**
 * Wall time of each turn, replayed from the log's `turn/start`/`turn/end` pair.
 *
 * The turn's own bracket is the measurement, not the sum of its steps: the row
 * it feeds answers "how long did this take me", which includes the gaps between
 * steps that no step's timing bucket owns. Like {@link StepTimingTracker} it
 * advances a cursor over the appended tail rather than replaying the log per
 * query, so a transcript of T turns costs one pass over the events in total.
 */
class TurnDurationTracker {
  private scanned = 0
  private readonly turns = new Map<number, { start: number; end: number | undefined }>()

  /**
   * Advance over events appended since the previous query, then read one turn's
   * wall time.
   * @param events - Current session event log (append-only).
   * @param turn - The turn index to measure.
   * @returns Elapsed milliseconds, or `undefined` while the turn is still open.
   */
  durationOf(events: readonly SessionEvent[], turn: number): number | undefined {
    for (; this.scanned < events.length; this.scanned += 1) {
      const event = events[this.scanned] as SessionEvent
      if (event.type === 'turn/start') {
        // First bracket wins on both ends: a resumed log can carry a stale
        // start, and the turn the transcript renders is the first one opened
        // under that index.
        if (!this.turns.has(event.data.turn)) this.turns.set(event.data.turn, { start: event.time, end: undefined })
      } else if (event.type === 'turn/end') {
        const state = this.turns.get(event.data.turn)
        if (state !== undefined) state.end ??= event.time
      }
    }
    const state = this.turns.get(turn)
    if (state?.end === undefined) return undefined
    // A backward wall-clock step clamps at zero rather than reporting a
    // negative turn, matching how the step buckets treat the same log.
    return Math.max(0, state.end - state.start)
  }
}

/** A leading blank row plus the row itself, the transcript's block spacing. */
function block(child: Component): Container {
  const container = new Container()
  container.addChild(new Spacer(1))
  container.addChild(child)
  return container
}

/** The keyed reconciler over one chat container. */
export class TranscriptReconciler {
  private readonly views = new Map<string, NodeView>()
  /** Process-local row groups keyed by the node count they were appended after. */
  private readonly locals = new Map<number, LocalRows[]>()
  /** Nodes before this index are not rendered (`/clear` hides history). */
  private hiddenBefore = 0
  /**
   * Steps `/clear` hid while they were still open, so the calls they request
   * after the cut are hidden with them. Read live: `toolCalls` keeps growing on
   * the same node object as the step runs on.
   */
  private hiddenSteps: readonly AssistantNode[] = []
  /** The last reconciled node list, so a view-state change can re-place it. */
  private nodes: readonly ChatNode[] = []
  private nodeCount = 0
  private visibility: ToolCardVisibility
  /** The deployment's master switch: false means no step ever renders thinking. */
  private readonly showReasoning: boolean
  /** Ctrl+T: whether a finished step keeps its thinking block on screen. */
  private thinkingPinned: boolean
  /** The open step's component, so an animation tick refreshes only that step. */
  private openStep: StreamingAssistantComponent | undefined
  /**
   * The collapsed row whose thinking is still open, refreshed on the same tick:
   * its duration counts up against the clock, not against the node list, so no
   * snapshot is due while the model is thinking between two events.
   */
  private openGroup: CollapsedGroupComponent | undefined
  /** Wall time of every turn in the log, for the per-turn completion row. */
  private readonly turnDurations = new TurnDurationTracker()
  /**
   * One completion row per turn, built once the turn ends. Held rather than
   * rebuilt so the sampled verb — and with it the row's wording — stays put
   * across the re-renders every later snapshot triggers.
   */
  private readonly turnFooters = new Map<number, Component>()
  /**
   * The verb each turn's row was worded with, kept apart from the rows.
   *
   * A palette change remounts every row, and a re-sample there would reword
   * turns the user already read — the wording is a property of the turn, not of
   * the row that happens to be mounted for it.
   */
  private readonly turnVerbs = new Map<number, string>()

  constructor(
    private readonly chat: Container,
    private readonly deps: TranscriptDeps,
    view: {
      readonly showReasoning: boolean
      readonly visibility: ToolCardVisibility
      readonly thinkingPinned?: boolean
    },
  ) {
    this.showReasoning = view.showReasoning
    this.thinkingPinned = view.thinkingPinned ?? false
    this.visibility = view.visibility
  }

  /**
   * Rebuild the chat container from a folded node list.
   * @param nodes - the snapshot's nodes, in log order.
   */
  reconcile(nodes: readonly ChatNode[]): void {
    this.nodes = nodes
    this.nodeCount = nodes.length
    const seen = new Set<string>()
    const children: Component[] = []
    let openStep: StreamingAssistantComponent | undefined
    let openGroup: CollapsedGroupComponent | undefined
    // A step's timing footer waits for the tool cards that step requested, so
    // it renders at the tail of the step's own output.
    let footer: { component: Component; calls: readonly string[] } | undefined
    const flushFooter = (): void => {
      if (footer === undefined) return
      children.push(footer.component)
      footer = undefined
    }
    // The turn a step belongs to, tracked so the turn's completion row lands
    // after everything that turn rendered — its last step's footer included.
    let turn: number | undefined
    // One row per turn, whatever the node order does. A turn the pass re-enters
    // would otherwise push its (memoized) row a second time, which is the same
    // component mounted twice.
    const reported = new Set<number>()
    const flushTurn = (): void => {
      const closing = turn
      turn = undefined
      if (closing === undefined || reported.has(closing)) return
      const row = this.turnFooter(closing)
      if (row === undefined) return
      reported.add(closing)
      children.push(row)
    }
    const emitLocals = (anchor: number): void => {
      const groups = this.locals.get(anchor)
      if (groups === undefined) return
      flushFooter()
      for (const group of groups) children.push(...group.components)
    }

    // The collapsed phase reports a run of read-only calls as one row instead
    // of one card each; the other two phases have no groups at all (expanded
    // shows every card, hidden shows none), so the plan is not even computed.
    const collapsed = this.visibility === 'collapsed'
      ? collapseToolGroups(nodes, {
        from: this.hiddenBefore,
        isHidden: id => this.isHiddenCall(id),
        // The row's thinking hint is reasoning text, and this transcript's
        // master switch governs it exactly as it governs the thinking block.
        showReasoning: this.showReasoning,
      })
      : new Map<number, CollapsedGroup>()

    for (let index = this.hiddenBefore; index < nodes.length; index += 1) {
      const node = nodes[index]
      /* v8 ignore next -- the loop bound keeps the index inside the array. */
      if (node === undefined) continue
      emitLocals(index)
      if (node.kind === 'tool-call') {
        if (!node.argsComplete || this.isHiddenCall(node.callId)) continue
        const group = collapsed.get(index)
        if (group !== undefined) {
          // Every member maps to the same group; only the last one renders it,
          // and the rest are absorbed into the counts that row carries. The
          // last rather than the first so the row never lands above a notice —
          // or a process-local row — that arrived between two of its members.
          if (group.index !== index) continue
          const row = this.groupView(group)
          seen.add(groupKey(group))
          if (group.thinkingSince !== undefined) openGroup = row
          if (footer?.calls.includes(node.callId) !== true) flushFooter()
          children.push(row)
          continue
        }
        const card = this.toolView(node)
        seen.add(node.key)
        // A card of the open step renders before that step's footer.
        if (footer?.calls.includes(node.callId) !== true) flushFooter()
        children.push(card)
        continue
      }
      flushFooter()
      // A new turn opens at its first step, or at the prompt that asked for it
      // (the fold logs the prompt above the step it entered), so either one is
      // where the previous turn's row is due. A steering prompt is neither: it
      // lands between two steps of the turn it interrupted, and closing the
      // turn there reported it mid-answer and again at its real end.
      const opensTurn = node.kind === 'user-message'
        ? node.source !== 'steering'
        : node.kind === 'assistant' && node.turn !== turn
      if (opensTurn) flushTurn()
      if (node.kind === 'assistant') turn = node.turn
      switch (node.kind) {
        case 'assistant': {
          const view = this.assistantView(node)
          seen.add(node.key)
          children.push(view)
          // A step stays open until it closes, not until its message settles:
          // the tool phase between `assistant/message` and `step/end` is exactly
          // when the footer's elapsed time has to keep moving.
          if (node.completedAt === undefined) openStep = view
          footer = { component: view.timing, calls: node.toolCalls }
          break
        }
        case 'todo':
          // The plan strip renders above the prompt, from the same fold; it is
          // not a transcript row.
          seen.add(node.key)
          break
        case 'compaction':
          if (!node.landed) break
          seen.add(node.key)
          children.push(this.plainView(node.key, node.version, () =>
            block(new Text(this.deps.palette.dim(t('transcript.compactionMarker')), 0, 0))))
          break
        case 'context':
          // Injected context is traffic between the harness and the model, not
          // part of the conversation, so it is off the transcript in both
          // default phases — collapsed as well as hidden — and no component is
          // built for it. Only the expanded phase, which is where a user goes
          // to see what the model was actually sent, renders the card.
          if (this.visibility !== 'expanded') break
          seen.add(node.key)
          children.push(this.plainView(node.key, node.version, () =>
            block(new ContextCardComponent(node.label, node.text, this.deps.palette))))
          break
        case 'reference':
          seen.add(node.key)
          children.push(this.plainView(node.key, node.version, () => block(new Text(
            this.deps.palette.dim(t('notice.referencedSessions', {
              labels: node.labels.map(displayText).join(', '),
            })),
            0,
            0,
          ))))
          break
        case 'user-message':
          // A submission the inbox discarded keeps its place in the fold and
          // renders nothing, exactly like an unlanded compaction.
          if (node.withdrawn === true) break
          seen.add(node.key)
          children.push(this.plainView(node.key, node.version, () => this.userView(node)))
          break
        case 'notice':
          seen.add(node.key)
          children.push(this.plainView(node.key, node.version, () =>
            block(new Text(this.tone(node.tone)(displayText(node.text)), 0, 0))))
          break
        /* v8 ignore next 2 -- ChatNode is a closed union; the guard is a future-node backstop. */
        default:
          break
      }
    }
    flushFooter()
    flushTurn()
    emitLocals(nodes.length)

    for (const [key] of this.views) {
      if (!seen.has(key)) this.views.delete(key)
    }
    this.openStep = openStep
    this.openGroup = openGroup
    this.chat.clear()
    for (const child of children) this.chat.addChild(child)
  }

  /**
   * Append process-local rows (command output, notices, diagnostics) after the
   * transcript's current tail.
   *
   * The caller supplies a builder rather than components so the rows survive a
   * palette swap: {@link TranscriptReconciler.reset} re-runs it under the new
   * palette instead of dropping the answer the user is still reading. The
   * builder must therefore read the palette it paints with at call time (the
   * entry's palette object is mutated in place), not close over pre-styled text.
   * @param build - Builds this group's rows, in render order.
   */
  appendLocal(build: () => Component[]): void {
    const group: LocalRows = { build, components: build() }
    const groups = this.locals.get(this.nodeCount)
    if (groups === undefined) this.locals.set(this.nodeCount, [group])
    else groups.push(group)
    // Attach immediately as well: a notice must be on screen before the next
    // snapshot arrives, and the tail is exactly where the reconcile places it.
    for (const component of group.components) this.chat.addChild(component)
  }

  /**
   * Hide every row rendered so far (`/clear`). The session log is unchanged, so
   * later nodes keep folding onto the same model; only this view is truncated.
   *
   * A step the cut hides takes its whole output with it, including the tool
   * cards it has not requested yet: those fold at indices below the cut and
   * would otherwise render with no message and no timing footer above them.
   * Only a step still open at the cut can do that — a closed step logged every
   * one of its calls before its `step/end`.
   */
  clearTranscript(): void {
    this.hiddenBefore = this.nodeCount
    this.hiddenSteps = this.nodes.filter(
      (node): node is AssistantNode => node.kind === 'assistant' && node.completedAt === undefined,
    )
    this.locals.clear()
    this.views.clear()
    this.turnFooters.clear()
    this.chat.clear()
  }

  /**
   * Drop every mounted component so the next reconcile rebuilds them — the
   * palette and Markdown theme are captured at construction, so a color-scheme
   * change has to remount.
   *
   * Process-local rows are rebuilt here rather than dropped. They have no node
   * to be re-derived from, so clearing them (as this did) threw away every
   * command result and notice on screen the first time the terminal reported a
   * scheme — the answer to the command the user had just run disappeared, and
   * nothing brought it back. Each group's builder re-runs under the palette
   * that is current now, which is the same remount every other row gets.
   */
  reset(): void {
    this.views.clear()
    for (const groups of this.locals.values()) {
      for (const group of groups) group.components = group.build()
    }
    // The rows hold the palette they were built with, so they remount too.
    this.turnFooters.clear()
    this.chat.clear()
  }

  /**
   * Set the Ctrl+O card visibility on every mounted card.
   *
   * A tool card and an assistant step both carry the phase — the step's
   * finished thinking and its timing footer are on screen only where the tool
   * bodies are. A context card has no collapsed form, so the reconcile below is
   * what mounts it on the expanded phase and drops it again on the other two.
   * @param visibility - hidden, collapsed preview, or full body.
   */
  setVisibility(visibility: ToolCardVisibility): void {
    this.visibility = visibility
    for (const view of this.views.values()) {
      if (view.kind === 'tool') view.component.setVisibility(visibility)
      else if (view.kind === 'assistant') view.component.setVisibility(visibility)
    }
    this.reconcile(this.nodes)
  }

  /**
   * Pin or unpin thinking blocks on every mounted assistant step (Ctrl+T).
   *
   * Applied to the mounted components rather than through a remount, so the
   * open step keeps streaming into the same component and the rows above it
   * keep their positions while history gains or loses its asides.
   * @param pinned - whether a finished step keeps its thinking on screen.
   */
  setThinkingPinned(pinned: boolean): void {
    this.thinkingPinned = pinned
    for (const view of this.views.values()) {
      if (view.kind === 'assistant') view.component.setThinkingPinned(pinned)
    }
    this.reconcile(this.nodes)
  }

  /**
   * Refresh the two rows whose text moves with the clock rather than with the
   * log — the open step's timing footer and the collapsed row of a group that
   * is still thinking — for the status animation tick. Only those components
   * are invalidated, so a long transcript is not re-rendered 20 times a second.
   */
  invalidateOpenStep(): void {
    this.openStep?.invalidate()
    this.openGroup?.invalidate()
  }

  /**
   * One turn's completion row, or `undefined` when that turn prints none.
   *
   * This is Claude Code's only timing report on the transcript: one dim
   * `✻ <verb> for <duration>` at the end of a turn, and only for a turn that
   * ran longer than {@link TURN_FOOTER_MIN_MS} — a turn the user watched
   * complete needs no receipt. It renders on every phase of the Ctrl+O cycle,
   * because unlike the per-step breakdown it is part of the conversation.
   * @param turn - The turn index to report.
   * @returns The mounted row, or `undefined` while the turn is open or short.
   */
  private turnFooter(turn: number): Component | undefined {
    const existing = this.turnFooters.get(turn)
    if (existing !== undefined) return existing
    const elapsed = this.turnDurations.durationOf(this.deps.events(), turn)
    if (elapsed === undefined || elapsed <= TURN_FOOTER_MIN_MS) return undefined
    const verb = this.turnVerbs.get(turn) ?? turnCompletionVerb()
    this.turnVerbs.set(turn, verb)
    const component = block(new Text(turnFooterRow(elapsed, this.deps.palette, verb), 0, 0))
    this.turnFooters.set(turn, component)
    return component
  }

  /** Whether one call belongs to a step `/clear` hid while it was open. */
  private isHiddenCall(callId: string): boolean {
    for (const step of this.hiddenSteps) {
      if (step.toolCalls.includes(callId)) return true
    }
    return false
  }

  /** Palette role for a notice tone. */
  private tone(tone: 'info' | 'warning' | 'error'): (value: string) => string {
    const palette = this.deps.palette
    if (tone === 'error') return value => palette.error(value)
    if (tone === 'warning') return value => palette.warning(value)
    return value => palette.dim(value)
  }

  /** Mount or reuse a component that never updates after creation. */
  private plainView(key: string, version: number, create: () => Component): Component {
    const existing = this.views.get(key)
    if (existing !== undefined && existing.kind === 'plain' && existing.version === version) {
      return existing.component
    }
    const component = create()
    this.views.set(key, { kind: 'plain', version, component })
    return component
  }

  /**
   * Build one user turn: the filled prompt block, under a `Steering` badge when
   * the turn interrupted a running one. Claude Code's block names no role, so
   * an ordinary prompt carries no label at all and the badge is the exception
   * that says this text reached the model mid-answer.
   */
  private userView(node: UserMessageNode): Component {
    const body = new UserMessageComponent(node.text, this.deps.palette, this.deps.scheme())
    if (node.source !== 'steering') return block(body)
    const container = new Container()
    container.addChild(new Spacer(1))
    container.addChild(new Text(this.deps.palette.dim(t('transcript.steeringBadge')), 0, 0))
    container.addChild(body)
    return container
  }

  /** Mount or update one assistant step, keeping its streamed buffer in sync. */
  private assistantView(node: AssistantNode): StreamingAssistantComponent {
    const existing = this.views.get(node.key)
    if (existing !== undefined && existing.kind === 'assistant') {
      if (existing.version !== node.version) {
        existing.version = node.version
        existing.component.setFoldedText(node.text, node.reasoning, node.settled)
        if (node.completedAt !== undefined) existing.component.complete(node.completedAt)
      }
      return existing.component
    }
    const component = new StreamingAssistantComponent(
      { turn: node.turn, step: node.step },
      this.deps.events,
      this.deps.tracker,
      this.deps.now,
      this.showReasoning,
      this.thinkingPinned,
      this.visibility,
      this.deps.palette,
      this.deps.mdTheme,
      this.deps.markdown,
    )
    component.setFoldedText(node.text, node.reasoning, node.settled)
    if (node.completedAt !== undefined) component.complete(node.completedAt)
    this.views.set(node.key, { kind: 'assistant', version: node.version, component })
    return component
  }

  /**
   * Mount or update one collapsed read/search row. The row is a component
   * rather than a rebuilt text line so a running group's counts can be pushed
   * into it every snapshot without re-wrapping the rows it already computed.
   */
  private groupView(group: CollapsedGroup): CollapsedGroupComponent {
    const key = groupKey(group)
    const signature = groupSignature(group)
    const existing = this.views.get(key)
    if (existing !== undefined && existing.kind === 'group') {
      if (existing.signature !== signature) {
        existing.signature = signature
        existing.component.setGroup(group)
      }
      return existing.component
    }
    const component = new CollapsedGroupComponent(
      group,
      this.deps.palette,
      path => displayPath(path, this.deps.cwd),
      this.deps.expandKey,
      this.deps.now,
    )
    this.views.set(key, { kind: 'group', signature, component })
    return component
  }

  /**
   * Mount or update one tool card. The card captures its parsed arguments (its
   * presenter reads them), so a call whose raw arguments changed after the card
   * was built is remounted rather than patched.
   */
  private toolView(node: ToolCallNode): ToolCardComponent {
    const existing = this.views.get(node.key)
    if (existing !== undefined && existing.kind === 'tool' && existing.argsRaw === node.argsRaw) {
      if (existing.version !== node.version) {
        existing.version = node.version
        if (node.result !== undefined) existing.component.setResult(node.result)
      }
      return existing.component
    }
    const component = new ToolCardComponent(
      node.name,
      node.args,
      withTuiPresenters(node.name, this.deps.toolDefinition(node.name)),
      this.deps.maxToolOutputLines,
      this.deps.maxDiffEditLength,
      this.deps.palette,
      this.deps.mdTheme,
      this.deps.expandKey,
    )
    component.setVisibility(this.visibility)
    if (node.result !== undefined) component.setResult(node.result)
    this.views.set(node.key, { kind: 'tool', version: node.version, component, argsRaw: node.argsRaw })
    return component
  }
}

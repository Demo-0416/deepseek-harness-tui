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
import type { MarkdownTheme } from '@earendil-works/pi-tui'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type {
  AssistantNode,
  ChatNode,
  ContextCardNode,
  ToolCallNode,
  UserMessageNode,
} from '../core/types.ts'
import type { StepTimingTracker } from '../chat/timing.ts'
import { displayText } from './text.ts'
import type { Palette } from './theme.ts'
import {
  ContextCardComponent,
  StreamingAssistantComponent,
  ToolCardComponent,
  UserMessageComponent,
  type ToolCardVisibility,
} from './transcript.ts'

/**
 * Transcript row standing in for one compacted range. The conversation the
 * compaction replaced stays rendered above it: the marker reports where the
 * model stopped seeing that history, not that the history is gone.
 */
export const COMPACTION_MARKER = '… earlier context was compacted …'

/** Label above a prompt that was submitted into a running turn. */
export const STEERING_BADGE = 'Steering'

/** Everything the reconciler needs to build a component for a node. */
export interface TranscriptDeps {
  /** Active palette; mutated in place by a color-scheme change. */
  readonly palette: Palette
  /** Active Markdown theme, likewise mutated in place. */
  readonly mdTheme: MarkdownTheme
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
}

/** One node's mounted component(s) and the node version they were built from. */
type NodeView =
  | { kind: 'assistant'; version: number; component: StreamingAssistantComponent }
  | { kind: 'tool'; version: number; component: ToolCardComponent; argsRaw: string }
  | { kind: 'context'; version: number; component: Component; card: ContextCardComponent }
  | { kind: 'plain'; version: number; component: Component }

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
  /** Process-local rows keyed by the node count they were appended after. */
  private readonly locals = new Map<number, Component[]>()
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
  private showReasoning: boolean
  /** The open step's component, so an animation tick refreshes only that step. */
  private openStep: StreamingAssistantComponent | undefined

  constructor(
    private readonly chat: Container,
    private readonly deps: TranscriptDeps,
    view: { readonly showReasoning: boolean; readonly visibility: ToolCardVisibility },
  ) {
    this.showReasoning = view.showReasoning
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
    // A step's timing footer waits for the tool cards that step requested, so
    // it renders at the tail of the step's own output.
    let footer: { component: Component; calls: readonly string[] } | undefined
    const flushFooter = (): void => {
      if (footer === undefined) return
      children.push(footer.component)
      footer = undefined
    }
    const emitLocals = (anchor: number): void => {
      const rows = this.locals.get(anchor)
      if (rows === undefined) return
      flushFooter()
      children.push(...rows)
    }

    for (let index = this.hiddenBefore; index < nodes.length; index += 1) {
      const node = nodes[index]
      /* v8 ignore next -- the loop bound keeps the index inside the array. */
      if (node === undefined) continue
      emitLocals(index)
      if (node.kind === 'tool-call') {
        if (!node.argsComplete || this.isHiddenCall(node.callId)) continue
        const card = this.toolView(node)
        seen.add(node.key)
        // A card of the open step renders before that step's footer.
        if (footer?.calls.includes(node.callId) !== true) flushFooter()
        children.push(card)
        continue
      }
      flushFooter()
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
            block(new Text(this.deps.palette.dim(COMPACTION_MARKER), 0, 0))))
          break
        case 'context': {
          // The hidden phase drops injected context exactly as it drops tool
          // cards: both are traffic between the harness and the model, and the
          // phase exists to leave nothing but the conversation on screen.
          if (this.visibility === 'hidden') break
          seen.add(node.key)
          children.push(this.contextView(node))
          break
        }
        case 'reference':
          seen.add(node.key)
          children.push(this.plainView(node.key, node.version, () => block(new Text(
            this.deps.palette.dim(`Referenced sessions · ${node.labels.map(displayText).join(', ')}`),
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
    emitLocals(nodes.length)

    for (const [key] of this.views) {
      if (!seen.has(key)) this.views.delete(key)
    }
    this.openStep = openStep
    this.chat.clear()
    for (const child of children) this.chat.addChild(child)
  }

  /**
   * Append process-local rows (command output, notices, diagnostics) after the
   * transcript's current tail.
   * @param components - rows to append, in render order.
   */
  appendLocal(...components: Component[]): void {
    const rows = this.locals.get(this.nodeCount)
    if (rows === undefined) this.locals.set(this.nodeCount, [...components])
    else rows.push(...components)
    // Attach immediately as well: a notice must be on screen before the next
    // snapshot arrives, and the tail is exactly where the reconcile places it.
    for (const component of components) this.chat.addChild(component)
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
    this.chat.clear()
  }

  /**
   * Drop every mounted component so the next reconcile rebuilds them — the
   * palette and Markdown theme are captured at construction, so a color-scheme
   * change has to remount. Local rows are rebuilt by their owners, so they go
   * with it, exactly as the transcript rebuild before the reconciler did.
   */
  reset(): void {
    this.views.clear()
    this.locals.clear()
    this.chat.clear()
  }

  /**
   * Set the Ctrl+O card visibility on every mounted card.
   * @param visibility - hidden, collapsed preview, or full body.
   */
  setVisibility(visibility: ToolCardVisibility): void {
    this.visibility = visibility
    for (const view of this.views.values()) {
      if (view.kind === 'tool') view.component.setVisibility(visibility)
      // A context card has two states, not three: the hidden phase drops it in
      // `reconcile` instead, so only expanded/collapsed reaches the card.
      else if (view.kind === 'context') view.card.setExpanded(visibility === 'expanded')
    }
    this.reconcile(this.nodes)
  }

  /**
   * Toggle reasoning blocks on every mounted assistant step.
   * @param show - whether reasoning blocks render.
   */
  setShowReasoning(show: boolean): void {
    this.showReasoning = show
    for (const view of this.views.values()) {
      if (view.kind === 'assistant') view.component.setShowReasoning(show)
    }
    this.reconcile(this.nodes)
  }

  /**
   * Refresh the open step's live timing footer, for the status animation tick.
   * Only that component is invalidated, so a long transcript is not re-rendered
   * 20 times a second.
   */
  invalidateOpenStep(): void {
    this.openStep?.invalidate()
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
    const body = new UserMessageComponent(node.text, this.deps.palette, this.deps.mdTheme)
    if (node.source !== 'steering') return block(body)
    const container = new Container()
    container.addChild(new Spacer(1))
    container.addChild(new Text(this.deps.palette.dim(STEERING_BADGE), 0, 0))
    container.addChild(body)
    return container
  }

  /** Mount or update one injected-context card. */
  private contextView(node: ContextCardNode): Component {
    const existing = this.views.get(node.key)
    if (existing !== undefined && existing.kind === 'context' && existing.version === node.version) {
      return existing.component
    }
    const card = new ContextCardComponent(node.label, node.text, this.deps.palette)
    card.setExpanded(this.visibility === 'expanded')
    const component = block(card)
    this.views.set(node.key, { kind: 'context', version: node.version, component, card })
    return component
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
      this.deps.palette,
      this.deps.mdTheme,
    )
    component.setFoldedText(node.text, node.reasoning, node.settled)
    if (node.completedAt !== undefined) component.complete(node.completedAt)
    this.views.set(node.key, { kind: 'assistant', version: node.version, component })
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
      this.deps.toolDefinition(node.name),
      this.deps.maxToolOutputLines,
      this.deps.maxDiffEditLength,
      this.deps.palette,
      this.deps.mdTheme,
    )
    component.setVisibility(this.visibility)
    if (node.result !== undefined) component.setResult(node.result)
    this.views.set(node.key, { kind: 'tool', version: node.version, component, argsRaw: node.argsRaw })
    return component
  }
}

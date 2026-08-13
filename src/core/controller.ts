/**
 * The TUI controller: owns the agent lifecycle, the per-session store, the
 * approval answerer, and the screen state React renders. One controller per
 * process; the app component subscribes to it via useSyncExternalStore.
 * @module dsh-tui/core/controller
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionHeader } from '@deepseek-ai/dsh-session'
import type { AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
// Load the Events declaration merge for 'approval/request'.
import type {} from '@deepseek-ai/dsh-user-approval'
import type { TuiStartupValues } from '../startup.ts'
import { SessionStore } from './session-store.ts'
import type { PendingApproval } from './types.ts'

/** Top-level screens the app can show. */
export type Screen = 'chat' | 'sessions' | 'settings' | 'help' | 'search' | 'trajectory' | 'plugins' | 'subagents'

/** A pending user question routed to the TUI. */
export interface PendingQuestion {
  id: number
  request: AskUserQuestionRequest
  resolve: (answer: { answers: { id: string; selected: string[]; custom?: string }[] }) => void
}

/** Controller state surfaced to React. */
export interface ControllerState {
  screen: Screen
  /** Pending approval questions, oldest first. */
  approvals: PendingApproval[]
  /** Pending user question, when the agent asked one. */
  question: PendingQuestion | undefined
  /** The active session id, when one is open. */
  sessionId: string | undefined
  /** Fatal boot error, when the app cannot start. */
  error: string | undefined
  /** Active theme name. */
  theme: 'dark' | 'light'
  /** Whether the approval policy asks interactively. */
  approvalAsks: boolean
}

const INITIAL_STATE: ControllerState = {
  screen: 'chat',
  approvals: [],
  question: undefined,
  sessionId: undefined,
  error: undefined,
  theme: 'dark',
  approvalAsks: true,
}

/** Parse a `provider/model` selection string. */
function parseModelSelection(value: string | undefined): { provider: string; model: string } | undefined {
  if (value === undefined) return undefined
  const slash = value.indexOf('/')
  if (slash <= 0) return undefined
  return { provider: value.slice(0, slash), model: value.slice(slash + 1) }
}

export class TuiController {
  private readonly ctx: Context
  private readonly exit: (code: number) => void
  private state: ControllerState = INITIAL_STATE
  private readonly listeners = new Set<() => void>()
  private handle: AgentHandle | undefined
  private store: SessionStore | undefined
  private approvalSeq = 0
  private disposed = false

  constructor(ctx: Context, exit: (code: number) => void) {
    this.ctx = ctx
    this.exit = exit
  }

  /** useSyncExternalStore subscription. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** useSyncExternalStore snapshot getter. */
  getState(): ControllerState {
    return this.state
  }

  private setState(patch: Partial<ControllerState>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }

  /** The active session's read model, when a session is open. */
  get sessionStore(): SessionStore | undefined {
    return this.store
  }

  /** The active agent, when one is open. */
  get agent(): Agent | undefined {
    return this.handle?.agent
  }

  /**
   * Boot the agent: create, resume, or continue, then wire the store and the
   * approval answerer.
   */
  async boot(startup: TuiStartupValues): Promise<void> {
    const agents = this.ctx.get('agents')
    if (agents === undefined) throw new Error('dsh-tui: ctx.agents is unavailable')

    const selection = parseModelSelection(startup.model)
      ?? this.ctx.get('agentDefaultModel')?.currentSelection()
    const agentOptions = selection === undefined ? undefined : {
      provider: selection.provider,
      model: selection.model,
    }

    if (startup.resume !== undefined || startup.continueLatest) {
      const resumeId = startup.resume ?? (await this.mostRecentSessionId())
      if (resumeId === undefined) {
        throw new Error('dsh-tui: no session to resume')
      }
      this.handle = await agents.resume({
        resumeSessionId: SessionId(resumeId),
        ...(agentOptions === undefined ? {} : { agentOptions }),
      })
    } else {
      this.handle = await agents.create({
        sessionId: SessionId(`session-${randomUUID()}`),
        meta: { cwd: process.cwd() },
        ...(agentOptions === undefined ? {} : { agentOptions }),
      })
    }

    const agent = this.handle.agent
    this.store = new SessionStore(this.ctx, agent.session, agent)
    this.setState({ sessionId: agent.session.id })

    if (startup.initialPrompt !== undefined) {
      this.send(startup.initialPrompt)
    }
  }

  /** Find the most recent persisted session id, for --continue. */
  private async mostRecentSessionId(): Promise<string | undefined> {
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) return undefined
    const sessions = await persistence.list()
    const latest = sessions
      .filter((s: SessionHeader) => s.cwd === undefined || s.cwd === process.cwd())
      .sort((a: SessionHeader, b: SessionHeader) => b.createdAt - a.createdAt)[0]
    return latest?.id
  }

  /** Send one user message or slash command. */
  send(text: string): void {
    const agent = this.handle?.agent
    if (agent === undefined) return
    const trimmed = text.trim()
    if (trimmed === '') return
    if (trimmed.startsWith('/')) {
      const commands = this.ctx.get('commands')
      if (commands !== undefined) {
        void commands.execute(agent, trimmed, new AbortController().signal).catch((error: unknown) => {
          this.setState({ error: error instanceof Error ? error.message : String(error) })
        })
      }
      return
    }
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: trimmed }],
      source: { kind: 'user' },
    }))
  }

  /** Interrupt the active turn. */
  cancel(): void {
    this.handle?.agent.cancel({ kind: 'user' })
  }

  /** Switch the top-level screen. */
  setScreen(screen: Screen): void {
    this.setState({ screen })
  }

  /** Answer a pending approval question. */
  answerApproval(id: number, outcome: 'allowed-once' | 'rejected' | 'cancelled'): void {
    const pending = this.state.approvals.find(a => a.id === id)
    if (pending === undefined) return
    pending.resolve(outcome)
    this.setState({ approvals: this.state.approvals.filter(a => a.id !== id) })
  }

  /** Answer the pending user question. */
  answerQuestion(answer: { answers: { id: string; selected: string[]; custom?: string }[] }): void {
    const pending = this.state.question
    if (pending === undefined) return
    pending.resolve(answer)
    this.setState({ question: undefined })
  }

  /** Switch the color theme. */
  setTheme(theme: 'dark' | 'light'): void {
    this.setState({ theme })
  }

  /** Toggle the approval policy between 'ask' and 'never'. */
  setApprovalAsks(asks: boolean): void {
    const agent = this.handle?.agent
    if (agent !== undefined) {
      this.ctx.get('approval')?.setPolicy(agent, asks ? 'ask' : 'never')
    }
    this.setState({ approvalAsks: asks })
  }

  /** List persisted sessions for the picker, newest first. */
  async listSessions(): Promise<SessionHeader[]> {
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) return []
    const sessions = await persistence.list()
    return [...sessions].sort((a, b) => b.createdAt - a.createdAt)
  }

  /** List the agent's registered slash commands for the help screen. */
  listCommands(): { name: string; description: string }[] {
    const agent = this.handle?.agent
    const commands = this.ctx.get('commands')
    if (agent === undefined || commands === undefined) return []
    return commands.list(agent).map(c => ({
      name: c.name,
      description: c.description ?? '',
    }))
  }

  /** The raw session events for the trajectory screen. */
  sessionEvents(): readonly import('@deepseek-ai/dsh-session').SessionEvent[] {
    return this.handle?.agent.session.events ?? []
  }

  /** Switch to a different session: dispose the current agent and resume. */
  async resumeSession(sessionId: string): Promise<void> {
    const agents = this.ctx.get('agents')
    if (agents === undefined) return
    this.store?.dispose()
    if (this.handle !== undefined) {
      await this.handle.dispose().catch(() => undefined)
    }
    this.handle = await agents.resume({ resumeSessionId: SessionId(sessionId) })
    const agent = this.handle.agent
    this.store = new SessionStore(this.ctx, agent.session, agent)
    this.setState({ sessionId: agent.session.id, screen: 'chat' })
  }

  /** Start a fresh session, abandoning the current one. */
  async newSession(): Promise<void> {
    const agents = this.ctx.get('agents')
    if (agents === undefined) return
    this.store?.dispose()
    if (this.handle !== undefined) {
      await this.handle.dispose().catch(() => undefined)
    }
    this.handle = await agents.create({
      sessionId: SessionId(`session-${randomUUID()}`),
      meta: { cwd: process.cwd() },
    })
    const agent = this.handle.agent
    this.store = new SessionStore(this.ctx, agent.session, agent)
    this.setState({ sessionId: agent.session.id, screen: 'chat' })
  }

  /** List loaded plugins for the plugins screen. */
  listPlugins(): { name: string; status: string }[] {
    const registry = this.ctx.registry
    if (registry === undefined) return []
    const entries: { name: string; status: string }[] = []
    for (const [name, fiber] of Object.entries(registry)) {
      const status = fiber?.value?.status ?? 'unknown'
      entries.push({ name, status: String(status) })
    }
    return entries.sort((a, b) => a.name.localeCompare(b.name))
  }

  /**
   * Register the approval answerer: routes questions for our agent to the UI
   * and delegates everything else down the waterfall.
   */
  registerApprovalAnswerer(): () => void {
    return this.ctx.on('approval/request', async (req, next) => {
      if (this.handle === undefined || req.agent.session.id !== this.handle.agent.session.id) {
        return next()
      }
      const id = ++this.approvalSeq
      const outcome = await new Promise<'allowed-once' | 'rejected' | 'cancelled'>((resolve) => {
        const pending: PendingApproval = {
          id,
          toolName: req.toolName,
          ...(req.callId === undefined ? {} : { callId: req.callId }),
          ...(req.reason === undefined ? {} : { reason: req.reason }),
          resolve,
        }
        this.setState({ approvals: [...this.state.approvals, pending] })
        req.signal?.addEventListener('abort', () => {
          this.answerApproval(id, 'cancelled')
        }, { once: true })
      })
      return outcome
    })
  }

  /**
   * Register the user-question provider: routes ask_user_question calls to
   * the TUI as a pending question dialog.
   */
  registerQuestionProvider(): () => void {
    const userQuestions = this.ctx.get('userQuestions')
    if (userQuestions === undefined) return () => undefined
    return userQuestions.registerProvider({
      ask: async (request: AskUserQuestionRequest) => {
        if (this.handle === undefined || request.agent?.session.id !== this.handle.agent.session.id) {
          throw new Error('dsh-tui: question for a foreign agent')
        }
        const id = ++this.approvalSeq
        const answer = await new Promise<{ answers: { id: string; selected: string[]; custom?: string }[] }>((resolve) => {
          this.setState({ question: { id, request, resolve } })
          request.signal?.addEventListener('abort', () => {
            this.answerQuestion({ answers: [] })
          }, { once: true })
        })
        return answer
      },
    })
  }

  /** Tear down: unmount the store, dispose the agent, and request exit. */
  async quit(code = 0): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.store?.dispose()
    if (this.handle !== undefined) {
      try {
        await this.ctx.get('sessions')?.flush(this.handle.agent.session)
      } catch {
        // Best-effort durability; exit either way.
      }
      await this.handle.dispose().catch(() => undefined)
    }
    this.exit(code)
  }
}

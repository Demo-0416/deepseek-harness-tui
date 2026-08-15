/**
 * The user-visible projection of an agent's pending inbox: which prompts the
 * driver has not claimed yet, in the order it will claim them.
 *
 * The terminal's own `pendingSteering` map only knows about submissions this
 * process made, and only until a status flap clears it; the inbox is the
 * durable truth for "what is still queued", including messages another host or
 * a plugin inserted. Every queue-facing surface (the prompt badge, `/status`,
 * and the editing entry points built on top of them) reads this projection so
 * they can never disagree about the count.
 * @module @deepseek-ai/dsh-tui/chat/queue
 */

import type { Inbox } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import { contentText } from '../components/content.ts'

/** Longest preview kept for one queued prompt before it is elided. */
const PREVIEW_LIMIT = 200

/** Where a pending prompt sits in the inbox, in the words the reader sees. */
export type QueuePlacement = 'steering' | 'queued'

/** One pending user prompt, listed in the order the driver will claim it. */
export interface PendingQueueItem {
  /** The message still parked in the inbox. */
  readonly message: UserMessage
  /** `steering` waits for the next step, `queued` waits for the next turn. */
  readonly placement: QueuePlacement
}

/**
 * Project the prompts a user is still waiting on out of an agent's inbox.
 *
 * Only `user` messages are listed: `agent.inject()` parks session-reference
 * snapshots and skill bodies on the same next-step boundary, and those are
 * context the terminal delivered on the user's behalf, not prompts the user is
 * waiting to see answered. Next-step input comes first because a running driver
 * claims it at its next boundary, ahead of any queued turn.
 * @param inbox - the agent inbox to read.
 * @returns pending user prompts in claim order.
 */
export function pendingUserQueue(inbox: Inbox): PendingQueueItem[] {
  return [
    ...inbox.nextStep.map(message => ({ message, placement: 'steering' as const })),
    ...inbox.nextTurn.map(message => ({ message, placement: 'queued' as const })),
  ].filter(item => item.message.source.kind === 'user')
}

/**
 * Render one queued prompt as a single line for a list.
 *
 * A queued prompt can be a pasted page; the list is a table of contents, not a
 * transcript (which already shows the full text), so newlines and runs of
 * blank space collapse into one line and the tail is elided.
 * @param message - the queued message to describe.
 * @returns one line of at most {@link PREVIEW_LIMIT} characters, plus an ellipsis when cut.
 */
export function queueItemPreview(message: UserMessage): string {
  const flattened = contentText(message.content).replace(/\s+/gu, ' ').trim()
  return flattened.length > PREVIEW_LIMIT ? `${flattened.slice(0, PREVIEW_LIMIT)}…` : flattened
}

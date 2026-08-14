/**
 * Ask-user-question sub-machine for the interactive chat channel. Registers the
 * user-interaction provider, presents one question overlay at a time in FIFO
 * order, and settles each request on answer, abort, overlay error, or channel
 * shutdown.
 * @module @deepseek-ai/dsh-tui/chat/questions
 */
import type { ChatChannelDeps } from './channel.ts';
/** Collaborators the question queue needs from the chat channel. */
export interface QuestionQueueDeps extends ChatChannelDeps {
    /** Current row budget after reserving the editor. */
    questionMaxHeight(): number;
}
/** Ask-user-question controller for one chat channel. */
export interface QuestionQueue {
    /** Reject the active and all queued questions (shutdown). */
    rejectAll(): void;
    /** Remove the user-interaction provider registration. */
    unregister(): void;
}
/**
 * Build the ask-user-question queue for one chat channel.
 * @param deps - channel collaborators and overlay host.
 * @returns the controller used at shutdown to drain and unregister.
 */
export declare function createQuestionQueue(deps: QuestionQueueDeps): QuestionQueue;

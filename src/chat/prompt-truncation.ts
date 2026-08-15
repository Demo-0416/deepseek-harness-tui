/**
 * The one length rule a submitted prompt has to obey before it becomes a turn.
 *
 * pi-tui's paste marker already keeps the editor's line buffer small — a large
 * paste lives in the editor's private map and shows as `[paste #1 30000 chars]`
 * — but `Editor.submitValue()` expands every marker before it calls `onSubmit`,
 * so what reaches this terminal is the full text with no ceiling at all. A
 * pasted file therefore used to travel verbatim into `agent.followup()`, into
 * the session log, and into the request body, where the provider answers with a
 * context-length error the user cannot connect to anything they did.
 *
 * The cut is deliberately lossy and deliberately exact: the result is exactly
 * `limit` characters, which makes the function idempotent (re-submitting a
 * truncated prompt from history changes nothing) and makes the guarantee
 * statable — "no turn this terminal sends is longer than `limit`".
 * @see A `!`-prefixed bash line, if this terminal ever grows one, must not come
 * through here: a shell command cut in the middle is a different command, so
 * that branch would have to leave before the length rule runs.
 * @module @deepseek-ai/dsh-tui/chat/prompt-truncation
 */

/**
 * Characters a submitted prompt may carry before its middle is dropped.
 *
 * Claude Code's own input ceiling (`PromptInput/inputPaste.ts:4`), kept as the
 * default so the two terminals refuse the same paste.
 */
export const DEFAULT_MAX_PROMPT_CHARS = 10_000

/** Marker rendered in place of the dropped middle; upstream's `utils/toolErrors.ts:21` wording. */
function truncationMarker(removed: number): string {
  return `\n\n... [${removed} characters truncated] ...\n\n`
}

/** What one length check decided about one prompt. */
export interface TruncatedPrompt {
  /** The text to submit. Identical to the input when nothing was dropped. */
  text: string
  /** Characters the prompt had before the cut. */
  original: number
  /** Characters dropped from the middle; `0` when the prompt was inside the budget. */
  removed: number
}

/**
 * Whether an index sits between the two halves of a surrogate pair.
 * @param text - the string being cut.
 * @param index - the candidate cut offset.
 * @returns true when cutting here would leave a lone surrogate.
 */
function splitsSurrogatePair(text: string, index: number): boolean {
  if (index <= 0 || index >= text.length) return false
  const before = text.charCodeAt(index - 1)
  const after = text.charCodeAt(index)
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff
}

/**
 * Hold a prompt to its character budget, dropping the middle if it is over.
 *
 * `limit <= 0` disables the rule entirely, which is what a deployment that
 * trusts its own provider configures.
 *
 * The marker is paid for out of the budget rather than added on top, so the
 * result is exactly `limit` characters (minus at most one per edge, when the cut
 * would have split a surrogate pair). That is what makes a second call a no-op:
 * a prompt recalled from history and submitted again is already inside the
 * budget, so it is neither cut twice nor announced twice.
 * @param text - the prompt as submitted, with paste markers already expanded.
 * @param limit - the character budget; `0` or less disables truncation.
 * @returns the text to send, with what it cost.
 */
export function truncatePrompt(text: string, limit: number): TruncatedPrompt {
  const original = text.length
  if (limit <= 0 || original <= limit) return { text, original, removed: 0 }

  // The marker's own length depends on the number printed inside it, which
  // depends on how much the marker displaces: converge instead of guessing.
  let removed = original - limit
  let marker = truncationMarker(removed)
  for (let pass = 0; pass < 4; pass++) {
    const next = original - (limit - marker.length)
    if (next === removed) break
    removed = next
    marker = truncationMarker(removed)
  }

  const keep = limit - marker.length
  // A budget too small to seat the marker keeps the head alone: a marker that
  // is most of the payload says nothing the notice has not already said. The
  // pair rule still holds here — a lone surrogate is what breaks the JSON body,
  // whatever made the cut.
  if (keep < 2) {
    const end = splitsSurrogatePair(text, limit) ? limit - 1 : limit
    return { text: text.slice(0, end), original, removed: original - end }
  }

  let head = Math.ceil(keep / 2)
  let tail = keep - head
  if (splitsSurrogatePair(text, head)) head -= 1
  if (splitsSurrogatePair(text, original - tail)) tail -= 1
  const dropped = original - head - tail
  // Stepping off a surrogate pair drops one more character per edge than the
  // convergence above priced in, so the marker is re-rendered rather than left
  // stating a count the result no longer has: the notice on screen and the
  // marker in the text are the same number or they are a bug report. The text
  // stays inside the budget — a count one or two higher is at most one digit
  // longer, and each edge gave back a character to pay for it.
  if (dropped !== removed) marker = truncationMarker(dropped)
  return {
    text: `${text.slice(0, head)}${marker}${text.slice(original - tail)}`,
    original,
    removed: dropped,
  }
}

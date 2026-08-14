/**
 * System-clipboard writes for the TUI, ported from Claude Code's
 * `src/ink/termio/osc.ts` (`setClipboard` and its helpers). Three paths, in
 * order of confidence:
 *
 * - native: a local clipboard utility (pbcopy/wl-copy/xclip/xsel/clip.exe)
 *   always works locally, where OSC 52 depends on terminal settings (iTerm2
 *   ships with it disabled, VS Code prompts on first use).
 * - tmux buffer: inside tmux the paste buffer is always reachable — works
 *   over SSH, survives detach/reattach — and `-w` (tmux 3.2+) propagates to
 *   the outer terminal's clipboard through tmux's own OSC 52 emission.
 * - OSC 52: the escape sequence itself, for remote sessions with no tmux;
 *   best-effort by design.
 * @module @deepseek-ai/dsh-tui/chat/clipboard
 */
/** Runs a command with text piped to stdin; resolves with its exit code, never rejects. */
export type QuietRunner = (file: string, args: readonly string[], input: string) => Promise<number>;
/**
 * Which path {@link copyToClipboard} will take, from env state alone.
 * Synchronous so the caller can flash an honest confirmation without
 * awaiting the copy.
 *
 * pbcopy gating uses SSH_CONNECTION specifically, not SSH_TTY — tmux panes
 * inherit SSH_TTY forever even after local reattach, but SSH_CONNECTION is
 * in tmux's default update-environment set and gets cleared.
 */
export type ClipboardPath = 'native' | 'tmux-buffer' | 'osc52';
export declare function clipboardPath(env?: NodeJS.ProcessEnv): ClipboardPath;
/** @internal test-only */
export declare function _resetLinuxCopyCache(): void;
/**
 * Write `text` to the system clipboard and return the escape sequence the
 * caller must write to the terminal to finish the job.
 *
 * The native utility fires FIRST, before the tmux await — a quick
 * focus-switch right after copying must not beat pbcopy to the paste. When
 * the tmux buffer loads, the returned OSC 52 is DCS-wrapped so it tunnels to
 * the outer terminal; our sequence carries an explicit `c` selection, which
 * sidesteps the iTerm2 crash tmux's own empty-param variant triggers.
 * @param text - what to copy.
 * @param env - process env override for tests.
 * @param run - subprocess runner override for tests.
 * @returns the sequence to write to the terminal (raw OSC 52 outside tmux).
 */
export declare function copyToClipboard(text: string, env?: NodeJS.ProcessEnv, run?: QuietRunner): Promise<string>;

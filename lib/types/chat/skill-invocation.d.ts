/**
 * Manual `/skill:<name> [instructions]` parsing and echo rendering for the
 * terminal front door: the command line becomes the visible user turn, and the
 * skill body rides beside it as injected context (Claude Code's breadcrumb +
 * hidden content split). The body itself is rendered by dsh-skill's
 * `renderSkillContent`, shared with the model-facing `skill` tool.
 * @module @deepseek-ai/dsh-tui/chat/skill-invocation
 */
/** Prefix that marks an editor submission as a manual skill invocation. */
export declare const SKILL_COMMAND_PREFIX = "/skill:";
/** Parsed `/skill:<name> [instructions]` submission; `name` is empty when the prefix carries no name. */
export interface ParsedSkillCommand {
    /** Skill name typed after `/skill:`, up to the first space. */
    name: string;
    /** Trimmed text after the name; empty when none was typed. */
    instructions: string;
}
/**
 * Split a `/skill:<name> [instructions]` submission into its name and trailing instructions.
 * @param text - trimmed submission that starts with {@link SKILL_COMMAND_PREFIX}.
 * @returns the skill name and any trailing instructions.
 */
export declare function parseSkillCommand(text: string): ParsedSkillCommand;
/**
 * The visible user turn of a `/skill:` invocation: the command line itself.
 *
 * This is both what the transcript echoes and what the model receives as the
 * turn — the skill body arrives beside it as injected context, so the turn
 * only has to name the skill and carry the user's request. A launcher-seeded
 * skill has no typed line, so the echo is reconstructed rather than captured.
 * @param name - the invoked skill's name.
 * @param instructions - trimmed text typed after `/skill:<name>`; empty when absent.
 * @returns the user-message text delivered and echoed for this turn.
 */
export declare function renderSkillEcho(name: string, instructions: string): string;

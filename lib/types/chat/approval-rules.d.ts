/**
 * The permission grants this workspace keeps past the process that gave them.
 *
 * rc.6's approval seam is one-shot only, so "don't ask again" has never been
 * anything but a `Set` in one terminal's memory: closing the window, resuming
 * the session, or opening a second pane threw the answer away. This module is
 * the durable half — `$DSH_HOME/approvals.json`, one allow list per project —
 * and the mounted terminal still spends each rule as a plain `'allowed-once'`,
 * which is exactly what the seam would have received had the user answered by
 * hand.
 *
 * The rule spelling is Claude Code's `permissions.allow` shape
 * (`permissionRuleParser.ts:93-152`), so a file written here reads the way a
 * user who knows that product expects:
 *
 * - `edit` — every ask about that tool is granted;
 * - `bash(npm run:*)` — content ending in `:*` is a command PREFIX;
 * - `bash(git status)` — any other content is one exact command.
 *
 * "Project" is the working directory the session was opened in, kept as a key
 * in one home file rather than as a dotfile in the repository: that is the
 * prompt-history pattern (`chat/prompt-history.ts`), it needs no gitignore
 * conversation, and a grant one person gave never travels to a colleague in a
 * commit.
 *
 * A rule may also carry the sandbox access it was granted at, written after it
 * in brackets (`bash(npm run:*) [danger-full-access]`). A host escalates a
 * refused call by asking again for more permission — same tool, same command,
 * a strictly wider sandbox (`escalate sandbox to <mode>: <why>`) — so the mode
 * is part of the grant's identity: a rule given while widening to
 * `workspace-write` answers exactly that ask and leaves a later
 * `danger-full-access` one to the user.
 *
 * Five rules the matcher never bends, all of them narrower than Claude Code's
 * and all deliberately so — the failure mode of being too narrow is one extra
 * permission prompt, and the failure mode of being too wide is a command
 * nobody approved:
 *
 * - A compound command matches nothing. Claude Code splits on shell operators
 *   and grants the whole line only when every sub-command is allowed
 *   (`bashPermissions.ts:874-932`); this module has no shell parser, so
 *   anything carrying `;`, `&&`, `|`, a redirect, a backquote, a parenthesis,
 *   or a newline simply falls through to the dialog. Parentheses count
 *   anywhere on the line rather than only at its head, because the matcher is
 *   tool-agnostic and `@(…)`/`(…)` run a second command in PowerShell and fish
 *   where they are a syntax error in `sh`.
 * - A prefix stops at a word boundary, so `npm run:*` never covers
 *   `npm run-evil`.
 * - Nothing is stripped before matching: `sudo npm run build` and
 *   `FOO=1 npm run build` are not `npm run build` and are asked about.
 * - A command is compared token by token, so the whitespace a model varies
 *   (`npm  run   build`) neither widens a rule nor silently stops it firing.
 * - A command that names a working directory outside the project the rule was
 *   granted in matches nothing: the directory is a call ARGUMENT the model
 *   chooses, and `npm test` means something else in a repository the user
 *   never opened.
 *
 * Reads never throw and writes never block: a file that will not parse is the
 * same as no grants at all, and a home that will not accept the write leaves
 * the grant alive for this process and reports the failure to the log.
 * @module @deepseek-ai/dsh-tui/chat/approval-rules
 */
/** File under the harness home the allow lists are kept in. */
export declare const APPROVAL_RULES_FILE_NAME = "approvals.json";
/** Schema version written into the document; a foreign one is read leniently, never rejected. */
export declare const APPROVAL_RULES_VERSION = 1;
/**
 * How long an exiting terminal waits for the rules it was just given to reach
 * the disk. Long enough to outlast another process holding the file's lock,
 * short enough that a stuck disk never holds the exit — the bargain the prompt
 * history makes with the same number.
 */
export declare const APPROVAL_RULES_FLUSH_TIMEOUT_MS = 1000;
/** One grant, before it is spelled as a rule string. */
export interface ApprovalRule {
    /** The tool the grant is about. */
    readonly tool: string;
    /**
     * What of that tool is granted, or absent for the whole tool. Content ending
     * in `:*` is a command prefix; anything else is one exact command.
     */
    readonly content?: string;
    /**
     * The sandbox mode the grant was given at, for a request that asked to widen
     * one (`escalate sandbox to danger-full-access: …`). Absent for an ordinary
     * ask, and a grant only ever answers asks of its own kind: the permission the
     * user granted is the permission the rule spends.
     */
    readonly access?: string;
}
/** What a request is asking for, beyond the tool's name. */
export interface ApprovalMatchContext {
    /** The sandbox mode this ask would widen to, from {@link escalationAccess}. */
    readonly access?: string;
    /**
     * The directory the command would run in, when the call names one. Absent
     * means the tool's own default, which is the project — a workspace tool that
     * was given no directory does not leave it. A shell that keeps a directory of
     * its own between calls is the one case this cannot see through, and only its
     * host can report that.
     */
    readonly cwd?: string;
}
/** Options {@link openApprovalRules} is opened with. */
export interface ApprovalRulesOptions {
    /** The project the rules belong to; the session's workspace. */
    readonly cwd: string;
    /** Override the document's location. Tests only; production uses the harness home. */
    readonly path?: string;
    /** Where a failed write is reported; never shown to the user as an error dialog. */
    readonly reportError?: (message: string) => void;
}
/** The handle the approval front door asks before it draws anything. */
export interface ApprovalRulesStore {
    /** Whether the whole tool is granted in this project, for the access this ask wants. */
    matchesTool(toolName: string, context?: ApprovalMatchContext): boolean;
    /** Whether one command is covered by a prefix or exact rule of this tool. */
    matchesCommand(toolName: string, command: string, context?: ApprovalMatchContext): boolean;
    /** Remember one grant: in memory now, on disk when the write lands. */
    allow(rule: ApprovalRule): void;
    /** This project's rules in their written form, newest last. */
    rules(): readonly string[];
    /** Settle every write this store has started, so an exiting process keeps the grant. */
    flush(): Promise<void>;
    /** Where the rules live, said the way a user can act on (`~/.dsh/approvals.json`). */
    readonly displayPath: string;
}
/**
 * Spell one grant the way it is stored.
 *
 * Parentheses inside the content are escaped, so a command that contains one
 * survives the round trip instead of ending the rule early.
 * @param rule - the grant to write.
 * @returns the rule string, `tool` or `tool(content)`.
 */
export declare function serializeApprovalRule(rule: ApprovalRule): string;
/**
 * Read one stored rule back.
 *
 * A string that does not close its parenthesis is taken as a bare tool name
 * rather than rejected: a hand-edited file must not stop a terminal from
 * mounting, and a tool nobody is called `bash(npm` is a rule that grants
 * nothing.
 * @param raw - one entry from a project's allow list.
 * @returns the grant it names.
 */
export declare function parseApprovalRule(raw: string): ApprovalRule;
/**
 * The sandbox mode a request would widen to, read off the reason the host
 * wrote (`escalate sandbox to danger-full-access: needs the network`).
 *
 * This is what keeps a stored rule honest: without it, a rule granted for an
 * ordinary call would answer a later ask for full system access, because the
 * command being decided is the same string in both.
 * @param reason - the request's reason, when it had one.
 * @returns the mode being asked for, or `undefined` for an ordinary request.
 */
export declare function escalationAccess(reason: string | undefined): string | undefined;
/**
 * Whether one directory is the project or somewhere under it.
 * @param cwd - the directory to test; relative paths resolve against the project.
 * @param projectCwd - the project the rules belong to.
 * @returns true when a call running there is running inside the project.
 */
export declare function isInsideProject(cwd: string, projectCwd: string): boolean;
/**
 * Whether one line is more than one command, and therefore beyond what an
 * allow rule may cover.
 * @param command - the command line as the tool received it.
 * @returns true when the line carries a shell operator, a substitution, or a second line.
 */
export declare function isCompoundCommand(command: string): boolean;
/**
 * Whether one simple command is covered by one rule's content.
 *
 * The caller has already proved the command is not compound; this is the
 * word-boundary half. An empty prefix (`bash(:*)`) covers nothing: a rule that
 * wide is a mistake, and honouring it would be a blanket grant written by
 * accident.
 *
 * Both sides are compared as WORDS. A model writes `npm  run build` as readily
 * as `npm run build`, and a rule that the command it was suggested from cannot
 * match is worse than no rule at all — the user pressed "don't ask again" and
 * would be asked again forever.
 * @param command - a non-compound command line.
 * @param content - the rule's content, prefix (`npm run:*`) or exact.
 * @returns whether the rule grants that command.
 */
export declare function commandMatchesRuleContent(command: string, content: string): boolean;
/**
 * The rule this command would most usefully be remembered as, for the editable
 * prefix the permission dialog offers.
 *
 * Claude Code's `getSimpleCommandPrefix` narrowed to what this module can
 * defend: no environment assignments, no wrappers, and nothing at all for a
 * command that an allow rule could never match anyway.
 *
 * The WHOLE command is tested for being compound, first. Naming a line by its
 * head — its first line, or the part before a heredoc — would put a truthful
 * label (`npm run:*`) on a row that also runs whatever came after it, and the
 * user answering the prompt sees the label rather than the line.
 * @param command - the command line as the tool received it.
 * @returns the suggested rule content, or `undefined` when none is safe to offer.
 */
export declare function suggestCommandPrefix(command: string): string | undefined;
/**
 * Open the allow list for one project (`$DSH_HOME/approvals.json`, or
 * `options.path`). Never throws.
 *
 * The rules are read once, into a snapshot: a grant another terminal writes
 * while this one runs is invisible until the next mount, which is the same
 * bargain the prompt history makes and the reason this file is cheap to
 * consult on every ask.
 * @param options - the project, the test override, and where failures go.
 * @returns the handle the approval front door matches against.
 */
export declare function openApprovalRules(options: ApprovalRulesOptions): ApprovalRulesStore;

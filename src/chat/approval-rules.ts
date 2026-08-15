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

import { readFileSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { writeFileAtomic, withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { dshHomeDisplay, dshHomePath, resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** File under the harness home the allow lists are kept in. */
export const APPROVAL_RULES_FILE_NAME = 'approvals.json'

/** Schema version written into the document; a foreign one is read leniently, never rejected. */
export const APPROVAL_RULES_VERSION = 1

/**
 * How long an exiting terminal waits for the rules it was just given to reach
 * the disk. Long enough to outlast another process holding the file's lock,
 * short enough that a stuck disk never holds the exit — the bargain the prompt
 * history makes with the same number.
 */
export const APPROVAL_RULES_FLUSH_TIMEOUT_MS = 1_000

/** Suffix that turns a rule's content into a command prefix, as in Claude Code. */
const PREFIX_SUFFIX = ':*'

/**
 * Commands that are wrappers rather than the thing being run, so a prefix built
 * from them would name nothing. Claude Code's `BARE_SHELL_PREFIXES`
 * (`bashPermissions.ts:196-226`), minus its two-word exception: `sudo apt:*` is
 * a rule about privilege, not about a program, and this module refuses to
 * suggest it.
 */
const WRAPPER_COMMANDS: ReadonlySet<string> = new Set([
  'sh', 'bash', 'zsh', 'fish', 'csh', 'tcsh', 'ksh', 'dash', 'cmd', 'powershell', 'pwsh',
  'env', 'xargs', 'nice', 'stdbuf', 'nohup', 'timeout', 'time', 'sudo', 'doas', 'pkexec',
])

/**
 * Anything that makes one line more than one command: separators, pipes,
 * redirects, substitutions, parentheses, and a second line.
 *
 * Deliberately blind to quoting — a `|` inside a string literal disqualifies
 * the command too. Being wrong here costs a prompt the user was already used
 * to seeing; being right about quotes would cost a shell parser.
 *
 * A parenthesis anywhere disqualifies the line, not only one at its head: this
 * matcher serves whatever shell tool the host composed, and PowerShell's
 * `@(…)` and fish's `(…)` evaluate a second command mid-line where `sh` would
 * only raise a syntax error.
 */
const COMPOUND_COMMAND = /[;&|<>`()]|\n/u

/** A second word plain enough to read as a sub-command (`run`, `commit`, `check-types`). */
const SUBCOMMAND_WORD = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u

/** The sandbox access a rule was granted at, written after the rule in brackets. */
const RULE_ACCESS_SUFFIX = /^(.*\S)\s\[([^\][]+)\]$/u

/** How a host words the ask that widens one call's sandbox (`sandbox/escalation.ts`). */
const ESCALATION_REASON = /^escalate sandbox to ([^\s:]+)/u

/** One grant, before it is spelled as a rule string. */
export interface ApprovalRule {
  /** The tool the grant is about. */
  readonly tool: string
  /**
   * What of that tool is granted, or absent for the whole tool. Content ending
   * in `:*` is a command prefix; anything else is one exact command.
   */
  readonly content?: string
  /**
   * The sandbox mode the grant was given at, for a request that asked to widen
   * one (`escalate sandbox to danger-full-access: …`). Absent for an ordinary
   * ask, and a grant only ever answers asks of its own kind: the permission the
   * user granted is the permission the rule spends.
   */
  readonly access?: string
}

/** What a request is asking for, beyond the tool's name. */
export interface ApprovalMatchContext {
  /** The sandbox mode this ask would widen to, from {@link escalationAccess}. */
  readonly access?: string
  /**
   * The directory the command would run in, when the call names one. Absent
   * means the tool's own default, which is the project — a workspace tool that
   * was given no directory does not leave it. A shell that keeps a directory of
   * its own between calls is the one case this cannot see through, and only its
   * host can report that.
   */
  readonly cwd?: string
}

/** Options {@link openApprovalRules} is opened with. */
export interface ApprovalRulesOptions {
  /** The project the rules belong to; the session's workspace. */
  readonly cwd: string
  /** Override the document's location. Tests only; production uses the harness home. */
  readonly path?: string
  /** Where a failed write is reported; never shown to the user as an error dialog. */
  readonly reportError?: (message: string) => void
}

/** The handle the approval front door asks before it draws anything. */
export interface ApprovalRulesStore {
  /** Whether the whole tool is granted in this project, for the access this ask wants. */
  matchesTool(toolName: string, context?: ApprovalMatchContext): boolean
  /** Whether one command is covered by a prefix or exact rule of this tool. */
  matchesCommand(toolName: string, command: string, context?: ApprovalMatchContext): boolean
  /** Remember one grant: in memory now, on disk when the write lands. */
  allow(rule: ApprovalRule): void
  /** This project's rules in their written form, newest last. */
  rules(): readonly string[]
  /** Settle every write this store has started, so an exiting process keeps the grant. */
  flush(): Promise<void>
  /** Where the rules live, said the way a user can act on (`~/.dsh/approvals.json`). */
  readonly displayPath: string
}

/** The document's shape, as far as this module reads it. */
interface ApprovalRulesDocument {
  version?: number
  projects?: Record<string, { allow?: unknown } | undefined>
  [unknownKey: string]: unknown
}

/**
 * Spell one grant the way it is stored.
 *
 * Parentheses inside the content are escaped, so a command that contains one
 * survives the round trip instead of ending the rule early.
 * @param rule - the grant to write.
 * @returns the rule string, `tool` or `tool(content)`.
 */
export function serializeApprovalRule(rule: ApprovalRule): string {
  const escaped = rule.content === undefined
    ? rule.tool
    : `${rule.tool}(${rule.content.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)')})`
  return rule.access === undefined ? escaped : `${escaped} [${rule.access}]`
}

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
export function parseApprovalRule(raw: string): ApprovalRule {
  const trimmed = raw.trim()
  // The access suffix is read only off a line that ENDS in it, so a rule whose
  // content closes with a bracket (`bash(ls a[0])`) keeps its own text.
  const suffix = RULE_ACCESS_SUFFIX.exec(trimmed)
  const access = suffix?.[2]
  const body = suffix?.[1] ?? trimmed
  const open = body.indexOf('(')
  if (open <= 0 || !body.endsWith(')')) return { tool: body, ...access === undefined ? {} : { access } }
  const content = body.slice(open + 1, -1).replaceAll(/\\(.)/gu, '$1')
  return { tool: body.slice(0, open), content, ...access === undefined ? {} : { access } }
}

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
export function escalationAccess(reason: string | undefined): string | undefined {
  if (reason === undefined) return undefined
  return ESCALATION_REASON.exec(reason)?.[1]
}

/**
 * Whether one directory is the project or somewhere under it.
 * @param cwd - the directory to test; relative paths resolve against the project.
 * @param projectCwd - the project the rules belong to.
 * @returns true when a call running there is running inside the project.
 */
export function isInsideProject(cwd: string, projectCwd: string): boolean {
  const step = relative(resolve(projectCwd), resolve(projectCwd, cwd))
  return step === '' || (!step.startsWith('..') && !isAbsolute(step))
}

/**
 * Split a command into the words a rule is compared against.
 * @param command - the command line.
 * @returns its words, with every run of whitespace treated as one separator.
 */
function commandTokens(command: string): string[] {
  const trimmed = command.trim()
  return trimmed === '' ? [] : trimmed.split(/\s+/u)
}

/**
 * Whether one line is more than one command, and therefore beyond what an
 * allow rule may cover.
 * @param command - the command line as the tool received it.
 * @returns true when the line carries a shell operator, a substitution, or a second line.
 */
export function isCompoundCommand(command: string): boolean {
  return COMPOUND_COMMAND.test(command)
}

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
export function commandMatchesRuleContent(command: string, content: string): boolean {
  const isPrefix = content.endsWith(PREFIX_SUFFIX)
  const wanted = commandTokens(isPrefix ? content.slice(0, -PREFIX_SUFFIX.length) : content)
  if (wanted.length === 0) return false
  const given = commandTokens(command)
  if (isPrefix ? given.length < wanted.length : given.length !== wanted.length) return false
  return wanted.every((word, index) => given[index] === word)
}

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
export function suggestCommandPrefix(command: string): string | undefined {
  const line = command.trim()
  if (line === '' || isCompoundCommand(line)) return undefined
  const tokens = line.split(/\s+/u)
  const head = tokens[0] ?? ''
  // `FOO=1 cmd` names the environment, not the program; Claude Code allows a
  // white list of variables here and this module allows none.
  if (head.includes('=') || WRAPPER_COMMANDS.has(head)) return undefined
  const second = tokens[1]
  if (second !== undefined && SUBCOMMAND_WORD.test(second)) return `${head} ${second}${PREFIX_SUFFIX}`
  return `${head}${PREFIX_SUFFIX}`
}

/**
 * Read this project's allow list out of the document, dropping anything that is
 * not a string.
 * @param document - the parsed file, or whatever was found in its place.
 * @param cwd - the project whose list is wanted.
 * @returns the rule strings stored for that project.
 */
function readProjectRules(document: unknown, cwd: string): string[] {
  if (typeof document !== 'object' || document === null) return []
  const projects = (document as ApprovalRulesDocument).projects
  if (typeof projects !== 'object' || projects === null) return []
  const entry = (projects as Record<string, unknown>)[cwd]
  if (typeof entry !== 'object' || entry === null) return []
  const allow = (entry as { allow?: unknown }).allow
  if (!Array.isArray(allow)) return []
  return allow.filter((rule): rule is string => typeof rule === 'string' && rule.trim() !== '')
}

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
export function openApprovalRules(options: ApprovalRulesOptions): ApprovalRulesStore {
  const path = options.path ?? dshHomePath(APPROVAL_RULES_FILE_NAME)
  const displayPath = options.path ?? `${dshHomeDisplay(resolveDshHome())}/${APPROVAL_RULES_FILE_NAME}`
  const report = (message: string): void => { options.reportError?.(message) }

  /** This project's rules as parsed grants, in the order they were granted. */
  const grants: ApprovalRule[] = []
  /** The same rules in written form, which is both the dedupe key and what `rules()` reports. */
  const written = new Set<string>()
  for (const raw of loadRules()) {
    if (written.has(raw)) continue
    written.add(raw)
    grants.push(parseApprovalRule(raw))
  }

  /** Serializes this process's writes, so two grants in one turn cannot race the file. */
  let queue: Promise<void> = Promise.resolve()

  /**
   * Read the stored rules for this project. A document that will not parse, a
   * home that cannot be read, a shape from a future version — all of them are
   * "no grants", because a permission file is never worth a failed mount.
   * @returns the rule strings on disk, or none.
   */
  function loadRules(): string[] {
    try {
      return readProjectRules(JSON.parse(readFileSync(path, 'utf8')), options.cwd)
    } catch (_missingOrCorrupt: unknown) {
      return []
    }
  }

  /**
   * Append one rule to the document, re-reading it first so a grant made in
   * another terminal is kept rather than overwritten.
   * @param serialized - the rule to store.
   */
  const persist = async (serialized: string): Promise<void> => {
    // The lock file is created before anything under it can be, so the home has
    // to exist first — on a machine whose first session this is, nothing else
    // has made it yet (`chat/prompt-history.ts` does the same before its first
    // append).
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await withFileLock(path, async () => {
      let document: ApprovalRulesDocument = {}
      try {
        const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
        // Unknown top-level keys are carried through untouched: a newer build
        // may have written fields this one has never heard of.
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          document = parsed as ApprovalRulesDocument
        }
      } catch (_missingOrCorrupt: unknown) {
        // A file nobody can parse is replaced whole; there is nothing in it to keep.
      }
      const stored = readProjectRules(document, options.cwd)
      // Normalized before comparing, so `bash(npm run:*)` written by hand and
      // the same grant made from the dialog are one entry rather than two.
      const normalized: string[] = []
      const seen = new Set<string>()
      for (const raw of stored) {
        const rule = serializeApprovalRule(parseApprovalRule(raw))
        if (seen.has(rule)) continue
        seen.add(rule)
        normalized.push(rule)
      }
      if (seen.has(serialized)) return
      normalized.push(serialized)
      const projects: Record<string, unknown> = typeof document.projects === 'object' && document.projects !== null
        ? { ...document.projects }
        : {}
      // Only the allow list is this module's to rewrite. A user who wrote a
      // `deny` beside it — the Claude Code spelling this file borrows invites
      // exactly that — keeps it, the same way the unknown top-level keys above
      // are kept.
      const entry = projects[options.cwd]
      projects[options.cwd] = {
        ...typeof entry === 'object' && entry !== null && !Array.isArray(entry) ? entry : {},
        allow: normalized,
      }
      const next = { ...document, version: APPROVAL_RULES_VERSION, projects }
      await writeFileAtomic(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
    })
  }

  return {
    displayPath,
    matchesTool(toolName: string, context: ApprovalMatchContext = {}): boolean {
      return grants.some(grant => (
        grant.content === undefined
        && grant.tool === toolName
        && grant.access === context.access
      ))
    },
    matchesCommand(toolName: string, command: string, context: ApprovalMatchContext = {}): boolean {
      const trimmed = command.trim()
      // The whole safety story in three lines: a rule may cover one simple
      // command, run where it was granted, at the permission it was granted at
      // — and never a line that runs a second one.
      if (trimmed === '' || isCompoundCommand(trimmed)) return false
      if (context.cwd !== undefined && !isInsideProject(context.cwd, options.cwd)) return false
      return grants.some(grant => (
        grant.tool === toolName
        && grant.content !== undefined
        && grant.access === context.access
        && commandMatchesRuleContent(trimmed, grant.content)
      ))
    },
    allow(rule: ApprovalRule): void {
      const serialized = serializeApprovalRule(rule)
      // In memory first and unconditionally: the answer the user just gave must
      // hold for this session even if the disk never accepts it.
      if (!written.has(serialized)) {
        written.add(serialized)
        grants.push(parseApprovalRule(serialized))
      }
      queue = queue.then(() => persist(serialized)).catch((error: unknown) => {
        report(`could not store the approval rule ${serialized}: ${String(error)}; it holds for this session only`)
      })
    },
    rules(): readonly string[] {
      return [...written]
    },
    flush(): Promise<void> {
      return queue
    },
  }
}

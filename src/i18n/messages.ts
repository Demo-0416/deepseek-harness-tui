/**
 * The two message tables this terminal renders its own chrome from.
 *
 * English is the base: every key exists in {@link EN_MESSAGES}, which is what
 * makes {@link ../i18n/index.ts | MessageKey} a closed type and what an
 * untranslated Chinese entry falls back to. `ZH_MESSAGES` is therefore partial
 * on purpose — a missing row is a row that has not been translated yet, not a
 * row that renders empty.
 *
 * Only chrome lives here: command descriptions, panel titles and hints, the
 * status row, dialog buttons. Model output, tool output, and everything else
 * the transcript quotes is the conversation and is never translated.
 *
 * Placeholders are `{name}`; a key ending in `.one`/`.other` is a plural pair
 * read through {@link ../i18n/index.ts | plural}.
 * @module @deepseek-ai/dsh-tui/i18n/messages
 */

/**
 * The English table, and the schema every other locale is checked against.
 *
 * Values are the exact strings this terminal shipped before it had a message
 * table: the English UI is the reference rendering, so a migration that
 * reworded a line while moving it would be a silent redesign.
 */
export const EN_MESSAGES = {
  // Commands this bundle registers. Translated where they are DISPLAYED (the
  // `/help` panel, the slash menu) rather than where they are registered: the
  // command registry is a shared service other clients read, so its
  // `description` stays one language and this terminal renders its own.
  'command.help.description': 'Show keyboard shortcuts and commands',
  'command.hotkeys.description': 'Show the keyboard shortcuts alone',
  'command.model.description': 'Switch the model and save it as your default',
  'command.preset.description': 'Show, switch, or copy this session\'s agent preset',
  'command.copy.description': 'Copy the last answer to the system clipboard',
  'command.new.description': 'Start a blank session in this workspace (this one stays resumable)',
  'command.clear.description': 'Clear the transcript view (session history is unchanged)',
  'command.config.description': 'Change this terminal\'s settings, saved for your next session',
  'command.theme.description': 'Pick the palette this terminal paints with',
  'command.palette.description': 'Show every color and attribute role this terminal renders',
  'command.export.description': 'Write this session\'s log to a file and report the path',
  'command.plugins.description': 'Search and inspect the Loader\'s plugin entries',
  'command.reload.description': 'EXPERIMENTAL (dev): re-read loader config files and apply the diff (idle only)',
  'command.rewind.description': 'Go back to an earlier prompt in this session (files are never restored)',
  'command.resume.description': 'List this workspace\'s resumable sessions',
  'command.status.description': 'Show session diagnostics, system prompt, and registered tools',
  'command.exit.description': 'Exit after the active turn reaches idle',
  'command.quit.description': 'Exit after the active turn reaches idle',
  'command.lang.description': 'Show or switch the interface language',
  'command.skills.description': 'Search this session\'s skills and read one in full',
  'command.mcp.description': 'Show the MCP servers this agent\'s tools come from',
  'command.doctor.description': 'Check the runtime, terminal, model route, and mounted services',
  'command.search.description': 'Search this session\'s messages',

  // `/lang` itself.
  'lang.name.en': 'English',
  'lang.name.zh': '中文',
  'lang.active': 'current',
  'lang.current': 'Language: {name} ({id}). Available: {options}.',
  'lang.switched': 'Language switched to {name} ({id}).',
  'lang.unchanged': 'Language is already {name} ({id}).',
  'lang.unknown': 'Unknown language "{value}". Available: {options}.',
  'lang.saveFailed': 'Language could not be saved for the next session: {error}',

  // `/hotkeys`, `/help` and `?`.
  'hotkeys.editor': 'Enter send • Shift/Alt+Enter newline • Up/Down prompt history • Tab accept a completion',
  'hotkeys.entry': '@ reference a file • / run a command • /skill:<name> load a skill • ? this list',
  'hotkeys.history': '{search} search prompt history backwards • {transcript} search this session\'s messages',
  'hotkeys.cards': '{cycle} cycle tool cards (preview/full/hidden) • {thinking} show or hide thinking blocks',
  'hotkeys.copy': '{todos} expand or collapse the plan • {copy} copy the last answer • {redraw} redraw',
  'hotkeys.cancel': '{cancel} cancel the turn; again on a draft clears it; again on an empty prompt opens Rewind',
  'hotkeys.exit': '{exit} exit on an empty prompt • Shift+Ctrl+D session debug panel',
  'hotkeys.interrupt': 'Ctrl+C cancel while running; clear input while typing; twice to exit while idle',
  'hotkeys.interruptAgain': 'Ctrl+C again on a turn that will not cancel exits without waiting for it',
  'hotkeys.panel': 'In a panel: ↑/↓ scroll • PgUp/PgDn page • g/G top or bottom • Esc close',
  'hotkeys.question': 'In a question: ↑/↓ move • Space multi-select • {custom} • Enter confirm • Esc cancel',
  'hotkeys.approval': 'In an approval: ↑/↓ move • 1-4 answer straight away • Enter confirm • Esc deny',
  'help.skill': '/skill:<name> [instructions] — load a skill into the conversation',

  // Scrollable panels.
  'panel.hint': '↑↓ scroll · esc close',
  'panel.position': '{first}–{last} of {total}',
  'panel.escClose': 'esc close',

  // `/plugins`.
  'plugins.unavailable':
    'Plugin inventory is not mounted. Add @deepseek-ai/dsh-host-plugin-inventory to this profile to list Loader entries.',
  'plugins.empty': 'The Loader reports no plugin entries.',
  'plugins.noMatch': 'No entries match the filter.',
  'plugins.hint': 'type to filter · ↑↓ move · enter details · esc close',
  'plugins.filter': 'filter:',
  'plugins.count.one': '{visible}/{total} entry · {active} active',
  'plugins.count.other': '{visible}/{total} entries · {active} active',

  // `/skills`: the catalog panel, one skill's detail view, and the notices the
  // command and `/skill:<name>` both report absences through.
  'skills.unavailable': 'Skills are not available in this session.',
  'skills.loading': 'Loading skills…',
  'skills.empty': 'This session composes no skills.',
  'skills.noMatch': 'No skills match the filter.',
  'skills.filter': 'filter:',
  'skills.hint': 'type to filter · ↑↓ move · enter details · esc close',
  'skills.count.one': '{visible}/{total} skill · {invocable} user invocable',
  'skills.count.other': '{visible}/{total} skills · {invocable} user invocable',
  // The two halves of a row's invocation fact: the list marks only the skills
  // `/skill:` refuses, the detail view names either side of it.
  'skills.modelOnly': 'model only',
  'skills.userInvocable': 'user invocable',
  'skills.detailLoading': 'Loading skill…',
  'skills.detailHint': '↑↓ scroll · esc back',
  'skills.truncated': '… showing the first {max} of {total} lines.',
  'skills.truncatedPath': '… showing the first {max} of {total} lines. Full text: {path}',
  'skills.unknown': 'Unknown skill: {name}',
  'skills.notUserInvocable': 'Skill "{name}" is not available for user invocation.',
  'skills.loadFailed': 'Skill "{name}" failed to load: {error}',
  'skills.scanFailed': 'Skill scan failed: {error}',

  // `/search`: the panel over this session's own messages, plus the row labels
  // the flattened entries carry. The labels are the transcript's own vocabulary,
  // so they read the same here as they do on the surface they were folded from.
  'search.empty': 'This session has no messages to search yet.',
  'search.noMatch': 'No message matches this search.',
  'search.query': 'search',
  'search.hint': 'type to search · ↑↓ move · enter open · esc close',
  'search.detailHint': '↑↓ scroll · PgUp/PgDn page · esc back',
  'search.count.one': '{visible}/{total} message',
  'search.count.other': '{visible}/{total} messages',
  'search.detail.whole': 'the whole message',
  'search.detail.hits': 'hits for "{query}" are highlighted',
  'search.role.user': 'You',
  'search.role.assistant': 'Assistant',
  'search.role.tool': 'Tool',
  'search.role.notice': 'Notice',
  'search.role.context': 'Context',
  // A `reference` row is a session-reference attachment, not a file list; it is
  // named after the thing it carries, exactly like `notice.referencedSessions`.
  'search.role.reference': 'Sessions',
  'search.role.compaction': 'Compacted',

  // `/mcp`. The counted rows are plural pairs; the "nothing is mounted" block is
  // three paragraphs, each one key with its own line breaks, so a translation
  // may rewrap where its own language wants to. The bundle row between them is
  // YAML a user copies, not prose, and is never translated.
  'mcp.servers.one': '{count} server',
  'mcp.servers.other': '{count} servers',
  'mcp.tools.one': '{count} tool',
  'mcp.tools.other': '{count} tools',
  'mcp.summary': '{servers} · {tools}',
  'mcp.serverRow': '({tools})',
  'mcp.empty.headline': 'No MCP tools are registered for this agent.',
  'mcp.empty.howto': 'MCP servers reach the model through @deepseek-ai/dsh-mcp-client, one plugin\n'
    + 'instance per server. Install it and add a row to this profile\'s bundle:',
  'mcp.empty.transport': 'transport is "stdio" (command, args, env, cwd) or "streamable-http" (url,\n'
    + 'headers). Every tool the server advertises is then registered as\n'
    + 'mcp__<serverName>__<rawName>, and this panel lists it.',

  // `/doctor`: one row per check, each a verdict, an observation, and — when it
  // is not a pass — the one thing to do about it.
  'doctor.flash.running': 'Running environment checks…',
  'doctor.healthy': 'Everything this terminal depends on is in place.',
  'doctor.summary.failed': '{count} failed',
  'doctor.summary.warned': '{count} to look at',
  'doctor.label.node': 'Node',
  'doctor.label.terminal': 'Terminal',
  'doctor.label.screen': 'Screen',
  'doctor.label.color': 'Color',
  'doctor.label.model': 'Model',
  'doctor.label.persistence': 'Persistence',
  'doctor.label.preset': 'Preset',
  'doctor.node.advice': 'this bundle is published for Node {range}; older runtimes miss APIs it calls unguarded',
  'doctor.terminal.pass': 'stdin and stdout are both TTYs',
  'doctor.terminal.failOne': '{end} is not a TTY',
  'doctor.terminal.failBoth': 'stdin and stdout are not a TTY',
  'doctor.terminal.advice':
    'keys and redraws need a terminal on both ends; for pipes use --print, which runs one task with no UI',
  'doctor.screen.narrowAdvice': 'below {columns} columns tool cards, diffs, and panels wrap; widen the window',
  'doctor.screen.shortAdvice': 'below {rows} rows a panel leaves no room for the editor; make the window taller',
  'doctor.color.disabled': 'disabled; this screen emits no color at all',
  'doctor.color.disabledAdvice':
    'every surface renders as plain text; run /theme to pick a palette, or set theme.color if the deployment turned it off',
  'doctor.color.basic': '16-color palette',
  'doctor.color.truecolor': '16-color palette, truecolor brand art',
  'doctor.model.noProvider': 'no LLM provider is registered',
  'doctor.model.noProviderAdvice':
    'the profile mounts no adapter row, or none of them activated; check the bundle and its credentials',
  'doctor.model.noRoute': 'no model selected (providers: {providers})',
  'doctor.model.noRouteAdvice': 'pick one with /model, or pass --model provider/model on the command line',
  'doctor.model.resolves': '{route} resolves (providers: {providers})',
  'doctor.model.noAdapter': '{route} has no registered adapter',
  'doctor.model.noAdapterAdvice':
    'no adapter answers for "{provider}"; mount its plugin row, or switch with /model',
  'doctor.model.failed': '{route} did not resolve: {error}',
  'doctor.model.failedAdvice':
    'the adapter is registered but rejected the lookup; check the provider\'s credentials and base URL',
  'doctor.persistence.mounted': 'sessionPersistence is mounted',
  'doctor.persistence.missing': 'sessionPersistence is not mounted',
  'doctor.persistence.advice':
    'this session lives in memory only: it cannot be resumed after exit, and /export re-serializes what is still in RAM',
  'doctor.preset.noRoster': 'no agent-preset roster is mounted',
  'doctor.preset.noRosterAdvice':
    'the shipped bundle patch mounts agentPresets; without it /preset lists nothing and every session runs one fixed agent plane',
  'doctor.preset.unjoined': 'the roster is mounted but this session names no preset',
  'doctor.preset.unjoinedAdvice':
    'the session was opened without joining a preset; start a new one with /new, or select one with /preset',

  // The rewind picker.
  'rewind.title': 'Rewind',
  'rewind.empty': 'Nothing to rewind to yet.',
  'rewind.fork': 'Fork the conversation to the point before…',
  'rewind.reuse': 'Bring an earlier prompt back to the editor…',
  'rewind.files': 'Files are never restored — dsh keeps no file checkpoints.',
  'rewind.hint': '↑/↓ navigate · enter rewind · esc close',

  // Ctrl+R prompt-history search.
  'history.label': 'search prompts',
  'history.noMatch': 'no matching prompt',
  'history.empty': '(type to search your prompt history)',
  'history.hint': 'ctrl+r older · enter send · tab/esc accept · ctrl+c cancel',

  // The permission prompt.
  'approval.title': 'Permission required',
  'approval.allowOnce': 'Yes, allow once',
  'approval.allowSession': 'Yes, and don\'t ask again for {tool} this session',
  'approval.rejectWithFeedback': 'No, and tell the agent what to do differently',
  'approval.reject': 'No, reject',
  'approval.feedbackPrompt': 'Tell the agent what to do differently:',
  'approval.feedbackHint': 'Enter reject with this feedback • Esc back to the answers',

  // The model picker.
  'dialog.model.title': 'Select model',
  'dialog.model.noMatch': 'No models match the filter',
  'dialog.model.noFocus': 'No model focused',
  'dialog.model.effortUnsupported': 'Reasoning effort not supported',
  'dialog.model.effortUnsupportedFor': 'Reasoning effort not supported for {model}',
  'dialog.model.providerDefault': 'Provider default',
  'dialog.model.effortRow': '{effort} effort',
  'dialog.model.effortDefault': '(default)',
  'dialog.model.adjust': '←/→ to adjust',
  'dialog.model.hintMove': 'type to filter • ↑/↓ move • ←/→ reasoning effort',
  'dialog.model.hintCommit': 'Enter save as default • Ctrl+S this session only • Esc cancel',

  // The preset picker.
  'dialog.preset.title': 'Select agent preset',
  'dialog.preset.noMatch': 'No presets match the filter',
  'dialog.preset.hint': 'type to filter • ↑/↓ move • Enter select • Esc',

  // `/config`: the panel's own chrome and one label per row. The two hints
  // beside a notice row are command names (`/lang`, `/model`), which every
  // locale types the same way and which are therefore not in this table.
  'settings.hint': '↑↓ move · enter change · esc close',
  'settings.thinking': 'Thinking display',
  'settings.toolCards': 'Tool cards default',
  'settings.theme': 'Theme',
  'settings.language': 'Language',
  'settings.model': 'Model',
  'settings.model.unset': 'unset',
  // How a toggle row words its two states.
  'settings.on': 'on',
  'settings.off': 'off',
  // Storage refusing a preference. The choice is already live on screen; what
  // failed is only its durability, which is what both sentences say.
  'settings.saveFailed': 'Setting could not be saved: {error}',
  'settings.refused': 'Stored terminal settings were refused; this session uses the defaults: {error}',

  // `/theme` and the selector the `/config` Theme row opens. The four ids
  // (`auto`, `light`, `dark`, `no-color`) are typed arguments and stay as they
  // are in every locale; only the line explaining each one is translated.
  'dialog.theme.title': 'Select theme',
  'dialog.theme.hint': '↑/↓ preview • Enter select • Esc cancel',
  'theme.description.auto': 'Follow the color scheme the terminal reports',
  'theme.description.light': 'Always paint the light-background palette',
  'theme.description.dark': 'Always paint the dark-background palette',
  'theme.description.no-color': 'Emit no color at all',
  'theme.applied': 'Theme: {theme}.',
  'theme.unknown': 'Unknown theme "{value}". Usage: /theme [{options}]',

  // `/resume`.
  'dialog.resume.title': 'Resume session',
  'dialog.resume.titleCounted': 'Resume session ({position} of {total})',
  'dialog.resume.loading': 'Loading sessions…',
  'dialog.resume.noMatch': 'No matching sessions.',
  'dialog.resume.stillLoading': 'Sessions are still loading.',
  'dialog.resume.noSessionMatch': 'No session matches this search.',
  'dialog.resume.scopeWorkspace': 'this workspace {label}',
  'dialog.resume.scopeWorkspaceCount': 'this workspace ({count})',
  'dialog.resume.scopeAll': 'all workspaces ({count})',
  'dialog.resume.workspaceRow': 'workspace {label}',
  'dialog.resume.unavailable': 'unavailable: {reason}',
  'dialog.resume.hint': 'Type to search  •  ↑/↓ navigate  •  Tab scope  •  Enter resume  •  Esc clear/cancel',

  // The user-question dialog.
  'dialog.question.header': 'Question {position}/{total} ({unanswered} unanswered)',
  'dialog.question.selectOne': 'Select at least one option, or press {keys} for a custom answer.',
  'dialog.question.emptyAnswer': 'Enter an answer before submitting.',
  'dialog.question.selectedCount': '{count} selected',
  'dialog.question.customAnswer': '{keys} custom answer',
  'dialog.question.navigate': '↑/↓ navigate',
  'dialog.question.spaceToggle': 'Space toggle',
  'dialog.question.submit': 'Enter submit',
  'dialog.question.escOptions': 'Esc options',
  'dialog.question.escCancel': 'Esc cancel',
  'dialog.question.escInterrupt': 'Esc interrupt',
  'dialog.question.moreAbove': '↑ {count} more',
  'dialog.question.moreBelow': '↓ {count} more',
  // The two rows the dialog only prints when the terminal cannot hold it: the
  // refusal above a compacted footer, and the count of rows clipped off the top.
  'dialog.question.error': 'Error: {message}',
  'dialog.question.linesHidden': '↑ {count} lines hidden',

  // The prompt context row and the status row under it.
  'prompt.modelUnset': 'model unset',
  'prompt.cache': 'cache {rate}%',
  'prompt.context': '{percent}% context',
  'prompt.compacting': 'Context being compacted {duration}',
  'prompt.queued': '{count} queued',

  // The one row a run of read-only calls collapses into. Each fragment is a
  // whole clause rather than a verb and a noun the caller concatenates: word
  // order and the shape of a count are exactly what a translation changes, and
  // a table of parts would fix English's order for every locale. The `.one` /
  // `.other` pair carries plural agreement in English and, for the MCP rows,
  // the difference between naming a server and counting the calls to it —
  // which is why the Chinese halves of those two differ where the rest match.
  // The thinking the run opened with, always the row's first fragment. It takes
  // a duration rather than a count, so it is a single row per tense instead of
  // a `.one`/`.other` pair — "1 second" needs no agreement here, the formatted
  // span (`8s`, `1m 20s`) carries its own unit.
  'collapse.thinking.active': 'thinking for {duration}',
  'collapse.thinking.settled': 'thought for {duration}',
  'collapse.search.active.one': 'searching for {count} pattern',
  'collapse.search.active.other': 'searching for {count} patterns',
  'collapse.search.settled.one': 'searched for {count} pattern',
  'collapse.search.settled.other': 'searched for {count} patterns',
  'collapse.read.active.one': 'reading {count} file',
  'collapse.read.active.other': 'reading {count} files',
  'collapse.read.settled.one': 'read {count} file',
  'collapse.read.settled.other': 'read {count} files',
  'collapse.list.active.one': 'listing {count} directory',
  'collapse.list.active.other': 'listing {count} directories',
  'collapse.list.settled.one': 'listed {count} directory',
  'collapse.list.settled.other': 'listed {count} directories',
  'collapse.mcp.active.one': 'querying {server}',
  'collapse.mcp.active.other': 'querying {server} {count} times',
  'collapse.mcp.settled.one': 'queried {server}',
  'collapse.mcp.settled.other': 'queried {server} {count} times',
  // How the clauses above are joined, and what closes a row still running.
  // Chinese punctuates a list with its own full-width comma, so the separator
  // is a translated row rather than a literal in the renderer.
  'collapse.separator': ', ',
  'collapse.ellipsis': '…',
  // The key is interpolated rather than written in: `app.tools.cycle` is
  // rebindable, and a hint on every collapsed row naming a key that does
  // nothing is exactly what `/hotkeys` reads from the manager to avoid.
  'collapse.expandHint': '({key} to expand)',

  // Transient status-row confirmations.
  'status.flash.cardsHidden': 'Tool cards hidden.',
  'status.flash.cardsExpanded': 'Tool and context cards expanded.',
  'status.flash.cardsCollapsed': 'Tool cards collapsed; reads grouped, context hidden.',
  // Ctrl+T. The refusal names `showReasoning` on purpose: it is the only thing
  // that can bring the blocks back, so a message that stayed vague would leave
  // the user pressing a key that will never answer.
  'status.flash.thinkingPinned': 'Thinking blocks kept on screen.',
  'status.flash.thinkingUnpinned': 'Thinking blocks hidden once a step finishes.',
  'status.flash.thinkingDisabled': 'Thinking blocks are off in this configuration (showReasoning: false).',
  'status.flash.planEmpty': 'No plan in this session yet.',
  'status.flash.planExpanded': 'Plan expanded.',
  'status.flash.planCollapsed': 'Plan collapsed.',
  'status.flash.escDraft': 'Press esc again to clear the draft.',
  'status.flash.escRewind': 'Press esc again to rewind to an earlier prompt.',
  'status.flash.exitAgain': 'Press ctrl+c again to exit.',
  'status.flash.exitWithoutTurn': 'Press ctrl+c again to exit without waiting for the turn.',
  'status.flash.cancelBeforeExit': 'Cancel the active turn before exiting.',
  'status.flash.cancellingBeforeExit': 'Cancelling the active turn before exit…',
  'status.flash.collecting': 'Collecting session status…',
  'status.flash.draftBlocksExit': 'Draft in the editor — clear it with ctrl+c to exit.',
  'status.flash.historyEmpty': 'No prompt history in this session yet.',
  'status.flash.queuedForSkill': 'Queued until the startup skill has been sent.',
  'status.flash.nothingToCopy': 'Nothing to copy yet.',
  'status.flash.copied': 'Copied {count} chars to clipboard.',
  'status.flash.copiedTmux': 'Copied to tmux buffer (prefix+] to paste).',
  'status.flash.copiedOsc52': 'Sent to clipboard via OSC 52.',

  // The `/status` card.
  'status.card.title': 'Session status',
  'status.row.session': 'Session',
  'status.row.title': 'Title',
  'status.row.directory': 'Directory',
  'status.row.model': 'Model',
  'status.row.preset': 'Preset',
  'status.row.permission': 'Permission',
  'status.row.agent': 'Agent',
  'status.row.goal': 'Goal',
  'status.row.goalState': 'Goal state',
  'status.row.sessionTotals': 'Session totals',
  'status.row.tokens': 'Tokens',
  'status.row.kvCache': 'KV cache',
  'status.row.context': 'Context',
  'status.row.created': 'Created',
  'status.row.active': 'Active',
  'status.untitled': 'untitled',
  'status.modelDetail': '(effort {effort}; thinking blocks {thinking})',
  'status.tokensValue': '{input} input + {output} output',
  'status.cacheValue': '{meter} {rate}% hit ({read} read + {write} write)',
  'status.cacheUnavailable': 'n/a ({read} read + {write} write)',
  'status.contextValue': '{meter} {percent}% used ({used} / {capacity})',
  'status.contextUnknown': '{used} used · capacity unknown',
  'status.systemPrompt': 'System prompt',
  'status.registeredTools': 'Registered tools',

  // How `/status` and the debug panel name the Ctrl+T state. Three states, not
  // a shown/hidden pair: `showReasoning: false` is a deployment-level `off`
  // that the key cannot leave, and it reads differently from a user who simply
  // has not pinned anything.
  'status.thinking.disabled': 'disabled',
  'status.thinking.kept': 'kept',
  'status.thinking.live': 'while streaming',
  // The two `/status` values that were still English literals while their own
  // labels were translated: `/config` already words the first one this way.
  'status.effort.default': 'default',
  // The counts the Agent row and the session totals are made of. A plural pair
  // rather than `singular + 's'`, so a locale that does not inflect can say so.
  'status.count.event.one': '{count} event',
  'status.count.event.other': '{count} events',
  'status.count.turn.one': '{count} turn',
  'status.count.turn.other': '{count} turns',
  'status.count.step.one': '{count} step',
  'status.count.step.other': '{count} steps',
  'status.count.toolCall.one': '{count} tool call',
  'status.count.toolCall.other': '{count} tool calls',
  'status.totals.model': 'model {duration}',
  'status.totals.tools': 'tools {duration}',
  'status.totals.ttft': 'ttft {duration} avg',
  'status.totals.decode': '{rate} tok/s decode',

  // The notice layer: what a command answers with when it has nothing to show,
  // and what a failure says. This is chrome — the terminal talking about
  // itself, not the conversation — so it belongs in the table like the rest.
  'notice.unknownCommand': 'Unknown command: {text}',
  'notice.commandFailed': 'Command failed: {error}',
  'notice.markdownDegraded': 'Markdown rendering degraded; using the fallback renderer for the rest of this session.',
  'notice.copyFailed': 'Copy failed: {error}',
  'notice.overlayFailed': 'TUI overlay failed: {error}',
  'notice.newSession': 'Starting a blank session. This one keeps its history — /resume brings it back.',
  'notice.newSessionFailed': 'Could not start a new session: {error}',
  // The key is interpolated for the same reason the collapsed row's is: it is
  // rebindable, and this sentence is the only way out of a disposed agent.
  'notice.disposedRecovery': 'Run /resume to open another session, or press {exit} to exit.',
  'notice.agentDisposed': 'Agent "{id}" is disposed. {recovery}',
  'notice.agentDisposedTurn': 'Agent "{id}" was disposed; this session can no longer run a turn. {recovery}',
  'notice.skillUsage': 'Usage: /skill:<name> [instructions]',
  'notice.referenceInvalid': 'Invalid session reference: {error}',
  'notice.referenceUnavailable': 'Session reference capability unavailable.',
  'notice.referenceFailed': 'Session reference failed: {error}',
  'notice.newSessionUnsupported':
    'This runtime cannot open a new session in place. Exit and start dsh again for a blank session.',
  'notice.newSessionBusy': 'A new session needs an idle agent (status: {status}).',
  'notice.rewindNoFork':
    'Rewind put that prompt back in the editor. This runtime cannot fork a session, so the conversation above it is unchanged.',
  'notice.rewindNoTurn':
    'Rewind put that prompt back in the editor. No completed turn precedes it, so there was nothing to fork to.',
  'notice.rewindBusy': 'Cancel the active turn before rewinding.',
  'notice.rewindForking': 'Forking this session to the point before that prompt; the original stays resumable.',
  'notice.rewindFailed': 'Rewind failed: {error}',
  'notice.reloadBusyAgent': '/reload requires an idle agent (status: {status}).',
  'notice.reloadRunning': 'A config reload is already running.',
  'notice.reloadNoLoader': '/reload needs the cordis Loader; this runtime has none.',
  'notice.reloadStarted': 'Reloading {count} config tree(s)… (experimental)',
  'notice.reloadDone':
    'Config reload complete. Unchanged files were skipped; invalid files keep the running tree (see logs).',
  'notice.reloadFailed': 'Config reload failed: {error}',
  // Rendered by the transcript reconciler rather than by a command, but the
  // same kind of chrome: a label over names the session carries.
  'notice.referencedSessions': 'Referenced sessions · {labels}',
  // The rest of the transcript's own chrome — rows the terminal writes about
  // the conversation, not rows the model or a tool produced.
  'transcript.compactionMarker': '… earlier context was compacted …',
  'transcript.steeringBadge': 'Steering',
  'banner.resumed': 'resumed {id}',
  // `/export` asking before it replaces a file, and the two answers it offers.
  'export.overwrite.question': '{path} already exists. Replace it?',
  'export.overwrite.replace': 'Replace the file',
  'export.overwrite.keep': 'Keep it',

  // The three tool-card phases as the `/config` value column shows them. Unlike
  // the four theme ids two rows down, these are not the argument of any
  // command — nothing takes `collapsed` as input — so they are display text.
  'settings.toolCards.collapsed': 'collapsed',
  'settings.toolCards.expanded': 'expanded',
  'settings.toolCards.hidden': 'hidden',

} as const

/**
 * The Chinese table.
 *
 * Product vocabulary the harness itself does not translate stays in English —
 * `preset`, `skill`, `plugin`, `token`, `Loader`, key names — because those are
 * what the config files, the docs, and the other clients call them; a row that
 * translated them would leave the reader guessing which knob it meant.
 */
export const ZH_MESSAGES: Partial<Record<keyof typeof EN_MESSAGES, string>> = {
  'command.help.description': '显示快捷键与命令列表',
  'command.hotkeys.description': '只显示快捷键',
  'command.model.description': '切换模型，并保存为默认模型',
  'command.preset.description': '查看、切换或复制本会话的 agent preset',
  'command.copy.description': '把最后一条回答复制到系统剪贴板',
  'command.new.description': '在当前工作区开一个空会话（当前会话仍可 resume）',
  'command.clear.description': '清空 transcript 视图（不影响会话历史）',
  'command.config.description': '修改本终端自己的设置，下次启动仍然生效',
  'command.theme.description': '选择本终端使用的配色',
  'command.palette.description': '展示本终端渲染的全部配色与文字属性',
  'command.export.description': '把本会话日志写入文件并给出路径',
  'command.plugins.description': '搜索并查看 Loader 的 plugin 条目',
  'command.reload.description': 'EXPERIMENTAL（开发用）：重读 loader 配置并应用差异（仅空闲时）',
  'command.rewind.description': '回到本会话更早的一次提问（不会恢复文件）',
  'command.resume.description': '列出当前工作区可恢复的会话',
  'command.status.description': '显示会话诊断信息、system prompt 与已注册工具',
  'command.exit.description': '等当前轮次结束后退出',
  'command.quit.description': '等当前轮次结束后退出',
  'command.lang.description': '查看或切换界面语言',
  'command.skills.description': '搜索本会话的 skill，并查看某个 skill 的完整正文',
  'command.mcp.description': '显示本 agent 的工具分别来自哪些 MCP server',
  'command.doctor.description': '检查运行时、终端、模型路由与已挂载的服务',
  'command.search.description': '搜索本会话的消息',

  'lang.name.en': 'English',
  'lang.name.zh': '中文',
  'lang.active': '当前',
  'lang.current': '当前语言：{name}（{id}）。可选：{options}。',
  'lang.switched': '语言已切换为 {name}（{id}）。',
  'lang.unchanged': '当前语言已经是 {name}（{id}）。',
  'lang.unknown': '无法识别的语言 "{value}"。可选：{options}。',
  'lang.saveFailed': '语言设置未能保存，下次启动仍是原来的语言：{error}',

  'hotkeys.editor': 'Enter 发送 • Shift/Alt+Enter 换行 • Up/Down 翻历史提问 • Tab 采纳补全',
  'hotkeys.entry': '@ 引用文件 • / 执行命令 • /skill:<name> 加载 skill • ? 打开本列表',
  'hotkeys.history': '{search} 向前搜索历史提问 • {transcript} 搜索本次会话的消息',
  'hotkeys.cards': '{cycle} 切换工具卡片（预览/完整/隐藏） • {thinking} 显示或隐藏思考块',
  'hotkeys.copy': '{todos} 展开或收起计划 • {copy} 复制最后一条回答 • {redraw} 重绘屏幕',
  'hotkeys.cancel': '{cancel} 取消当前轮次；草稿状态下再按一次清空草稿；空输入时再按一次打开 Rewind',
  'hotkeys.exit': '{exit} 空输入时退出 • Shift+Ctrl+D 打开会话调试面板',
  'hotkeys.interrupt': 'Ctrl+C 运行中取消；输入中清空输入；空闲时连按两次退出',
  'hotkeys.interruptAgain': '对取消不掉的轮次再按一次 Ctrl+C，会直接退出而不再等它',
  'hotkeys.panel': '面板内：↑/↓ 滚动 • PgUp/PgDn 翻页 • g/G 跳到首尾 • Esc 关闭',
  'hotkeys.question': '提问框内：↑/↓ 移动 • Space 多选 • {custom} • Enter 确认 • Esc 取消',
  'hotkeys.approval': '授权框内：↑/↓ 移动 • 1-4 直接作答 • Enter 确认 • Esc 拒绝',
  'help.skill': '/skill:<name> [instructions] — 把一个 skill 加载进对话',

  'panel.hint': '↑↓ 滚动 · esc 关闭',
  'panel.position': '第 {first}–{last} 行，共 {total} 行',
  'panel.escClose': 'esc 关闭',

  'plugins.unavailable':
    '未挂载 plugin inventory。在本 profile 中加入 @deepseek-ai/dsh-host-plugin-inventory 才能列出 Loader 条目。',
  'plugins.empty': 'Loader 没有报告任何 plugin 条目。',
  'plugins.noMatch': '没有条目匹配当前筛选。',
  'plugins.hint': '输入以筛选 · ↑↓ 移动 · enter 查看详情 · esc 关闭',
  'plugins.filter': '筛选：',
  'plugins.count.one': '{visible}/{total} 个条目 · {active} 个运行中',
  'plugins.count.other': '{visible}/{total} 个条目 · {active} 个运行中',

  'skills.unavailable': '本会话没有可用的 skill。',
  'skills.loading': '正在加载 skill 列表…',
  'skills.empty': '本会话没有组合任何 skill。',
  'skills.noMatch': '没有 skill 匹配当前筛选。',
  'skills.filter': '筛选：',
  'skills.hint': '输入以筛选 · ↑↓ 移动 · enter 查看详情 · esc 关闭',
  'skills.count.one': '{visible}/{total} 个 skill · {invocable} 个用户可调用',
  'skills.count.other': '{visible}/{total} 个 skill · {invocable} 个用户可调用',
  'skills.modelOnly': '仅模型可调用',
  'skills.userInvocable': '用户可调用',
  'skills.detailLoading': '正在加载 skill 正文…',
  'skills.detailHint': '↑↓ 滚动 · esc 返回',
  'skills.truncated': '… 只显示前 {max} 行，共 {total} 行。',
  'skills.truncatedPath': '… 只显示前 {max} 行，共 {total} 行。完整正文：{path}',
  'skills.unknown': '找不到名为 {name} 的 skill',
  'skills.notUserInvocable': 'skill "{name}" 不支持用户直接调用。',
  'skills.loadFailed': 'skill "{name}" 加载失败：{error}',
  'skills.scanFailed': 'skill 扫描失败：{error}',

  'search.empty': '本会话还没有可搜索的消息。',
  'search.noMatch': '没有消息匹配这次搜索。',
  'search.query': '搜索',
  'search.hint': '输入以搜索 · ↑↓ 移动 · enter 展开 · esc 关闭',
  'search.detailHint': '↑↓ 滚动 · PgUp/PgDn 翻页 · esc 返回',
  'search.count.one': '{visible}/{total} 条消息',
  'search.count.other': '{visible}/{total} 条消息',
  'search.detail.whole': '完整消息',
  'search.detail.hits': '“{query}”的命中处已高亮',
  'search.role.user': '你',
  'search.role.assistant': '助手',
  'search.role.tool': '工具',
  'search.role.notice': '提示',
  'search.role.context': '上下文',
  'search.role.reference': '引用的会话',
  'search.role.compaction': '已压缩',

  'mcp.servers.one': '{count} 个 server',
  'mcp.servers.other': '{count} 个 server',
  'mcp.tools.one': '{count} 个工具',
  'mcp.tools.other': '{count} 个工具',
  'mcp.summary': '{servers} · {tools}',
  'mcp.serverRow': '（{tools}）',
  'mcp.empty.headline': '本 agent 没有注册任何 MCP 工具。',
  'mcp.empty.howto': 'MCP server 通过 @deepseek-ai/dsh-mcp-client 接入模型，一个 server 对应一个 plugin\n'
    + '实例。安装它，并在本 profile 的 bundle 里加一行：',
  'mcp.empty.transport': 'transport 取 "stdio"（command、args、env、cwd）或 "streamable-http"（url、\n'
    + 'headers）。server 声明的每个工具都会以 mcp__<serverName>__<rawName> 注册，\n'
    + '然后出现在这个面板里。',

  'doctor.flash.running': '正在做环境检查…',
  'doctor.healthy': '本终端依赖的东西都到位了。',
  'doctor.summary.failed': '{count} 项失败',
  'doctor.summary.warned': '{count} 项需要留意',
  'doctor.label.node': 'Node',
  'doctor.label.terminal': '终端',
  'doctor.label.screen': '窗口',
  'doctor.label.color': '配色',
  'doctor.label.model': '模型',
  'doctor.label.persistence': '持久化',
  'doctor.label.preset': 'Preset',
  'doctor.node.advice': '本 bundle 面向 Node {range} 发布；更老的运行时缺少它直接调用的 API',
  'doctor.terminal.pass': 'stdin 与 stdout 都是 TTY',
  'doctor.terminal.failOne': '{end} 不是 TTY',
  'doctor.terminal.failBoth': 'stdin 与 stdout 都不是 TTY',
  'doctor.terminal.advice': '按键与重绘要求两端都是终端；走管道请用 --print，它跑一次任务、不启动 UI',
  'doctor.screen.narrowAdvice': '窄于 {columns} 列时工具卡片、diff 和面板都会折行；把窗口拉宽',
  'doctor.screen.shortAdvice': '少于 {rows} 行时面板会挤掉输入框；把窗口拉高',
  'doctor.color.disabled': '已关闭；当前屏幕完全不输出颜色',
  'doctor.color.disabledAdvice': '所有界面都会渲染成纯文本；用 /theme 选一个配色，或在部署关掉了颜色时打开 theme.color',
  'doctor.color.basic': '16 色配色',
  'doctor.color.truecolor': '16 色配色，品牌图形用 truecolor',
  'doctor.model.noProvider': '没有注册任何 LLM provider',
  'doctor.model.noProviderAdvice': 'profile 里没有 adapter 行，或者它们都没激活；检查 bundle 与其凭据',
  'doctor.model.noRoute': '未选择模型（provider：{providers}）',
  'doctor.model.noRouteAdvice': '用 /model 选一个，或在命令行传 --model provider/model',
  'doctor.model.resolves': '{route} 可解析（provider：{providers}）',
  'doctor.model.noAdapter': '{route} 没有对应的 adapter',
  'doctor.model.noAdapterAdvice': '没有 adapter 负责 "{provider}"；挂上它的 plugin 行，或用 /model 换一个',
  'doctor.model.failed': '{route} 解析失败：{error}',
  'doctor.model.failedAdvice': 'adapter 已注册但拒绝了这次查询；检查该 provider 的凭据与 base URL',
  'doctor.persistence.mounted': '已挂载 sessionPersistence',
  'doctor.persistence.missing': '未挂载 sessionPersistence',
  'doctor.persistence.advice': '本会话只存在于内存中：退出后无法 resume，/export 导出的也只是还在内存里的内容',
  'doctor.preset.noRoster': '未挂载 agent preset 名册',
  'doctor.preset.noRosterAdvice': '随包的 bundle patch 会挂载 agentPresets；没有它，/preset 列不出任何东西，每个会话都跑同一个固定的 agent plane',
  'doctor.preset.unjoined': '名册已挂载，但本会话没有指定 preset',
  'doctor.preset.unjoinedAdvice': '这个会话开启时没有加入任何 preset；用 /new 开一个新会话，或用 /preset 选一个',

  'rewind.title': 'Rewind',
  'rewind.empty': '还没有可以回退到的提问。',
  'rewind.fork': '从这条提问之前分叉出新的对话…',
  'rewind.reuse': '把更早的一条提问放回输入框…',
  'rewind.files': '文件不会被恢复 —— dsh 不保存文件检查点。',
  'rewind.hint': '↑/↓ 移动 · enter 回退 · esc 关闭',

  'history.label': '搜索提问',
  'history.noMatch': '没有匹配的提问',
  'history.empty': '（输入以搜索历史提问）',
  'history.hint': 'ctrl+r 更早一条 · enter 发送 · tab/esc 采纳 · ctrl+c 取消',

  'approval.title': '需要授权',
  'approval.allowOnce': '同意，仅此一次',
  'approval.allowSession': '同意，本会话内不再询问 {tool}',
  'approval.rejectWithFeedback': '拒绝，并告诉 agent 该怎么做',
  'approval.reject': '拒绝',
  'approval.feedbackPrompt': '告诉 agent 该怎么做：',
  'approval.feedbackHint': 'Enter 带着这段说明拒绝 • Esc 返回选项',

  'dialog.model.title': '选择模型',
  'dialog.model.noMatch': '没有模型匹配当前筛选',
  'dialog.model.noFocus': '当前没有选中的模型',
  'dialog.model.effortUnsupported': '不支持调节推理强度',
  'dialog.model.effortUnsupportedFor': '{model} 不支持调节推理强度',
  'dialog.model.providerDefault': '服务商默认',
  'dialog.model.effortRow': '推理强度 {effort}',
  'dialog.model.effortDefault': '（默认）',
  'dialog.model.adjust': '←/→ 调节',
  'dialog.model.hintMove': '输入以筛选 • ↑/↓ 移动 • ←/→ 调节推理强度',
  'dialog.model.hintCommit': 'Enter 存为默认 • Ctrl+S 仅本会话 • Esc 取消',

  'dialog.preset.title': '选择 agent preset',
  'dialog.preset.noMatch': '没有 preset 匹配当前筛选',
  'dialog.preset.hint': '输入以筛选 • ↑/↓ 移动 • Enter 选择 • Esc 取消',

  'settings.hint': '↑↓ 移动 · enter 修改 · esc 关闭',
  'settings.thinking': '思考块显示',
  'settings.toolCards': '工具卡片默认形态',
  'settings.theme': '配色',
  'settings.language': '界面语言',
  'settings.model': '模型',
  'settings.model.unset': '未设置',
  'settings.on': '开',
  'settings.off': '关',
  'settings.saveFailed': '设置没能保存：{error}',
  'settings.refused': '已存的终端设置不合法，本次会话使用默认值：{error}',

  'dialog.theme.title': '选择配色',
  'dialog.theme.hint': '↑/↓ 预览 • Enter 选定 • Esc 取消',
  'theme.description.auto': '跟随终端上报的明暗',
  'theme.description.light': '固定使用浅色背景的配色',
  'theme.description.dark': '固定使用深色背景的配色',
  'theme.description.no-color': '完全不输出颜色',
  'theme.applied': '配色：{theme}。',
  'theme.unknown': '未知配色 "{value}"。用法：/theme [{options}]',

  'dialog.resume.title': '恢复会话',
  'dialog.resume.titleCounted': '恢复会话（第 {position} / 共 {total}）',
  'dialog.resume.loading': '正在加载会话…',
  'dialog.resume.noMatch': '没有匹配的会话。',
  'dialog.resume.stillLoading': '会话还在加载中。',
  'dialog.resume.noSessionMatch': '没有会话匹配这次搜索。',
  'dialog.resume.scopeWorkspace': '当前工作区 {label}',
  'dialog.resume.scopeWorkspaceCount': '当前工作区（{count}）',
  'dialog.resume.scopeAll': '全部工作区（{count}）',
  'dialog.resume.workspaceRow': '工作区 {label}',
  'dialog.resume.unavailable': '不可用：{reason}',
  'dialog.resume.hint': '输入以搜索  •  ↑/↓ 移动  •  Tab 切换范围  •  Enter 恢复  •  Esc 清空/取消',

  'dialog.question.header': '第 {position}/{total} 个问题（{unanswered} 个待回答）',
  'dialog.question.selectOne': '至少选择一项，或按 {keys} 自己填写答案。',
  'dialog.question.emptyAnswer': '提交前请先填写答案。',
  'dialog.question.selectedCount': '已选 {count} 项',
  'dialog.question.customAnswer': '{keys} 自定义答案',
  'dialog.question.navigate': '↑/↓ 移动',
  'dialog.question.spaceToggle': 'Space 选中',
  'dialog.question.submit': 'Enter 提交',
  'dialog.question.escOptions': 'Esc 返回选项',
  'dialog.question.escCancel': 'Esc 取消',
  'dialog.question.escInterrupt': 'Esc 中断',
  'dialog.question.moreAbove': '↑ 还有 {count} 项',
  'dialog.question.moreBelow': '↓ 还有 {count} 项',
  'dialog.question.error': '错误：{message}',
  'dialog.question.linesHidden': '↑ 还有 {count} 行未显示',

  'prompt.modelUnset': '未设置模型',
  'prompt.cache': '缓存 {rate}%',
  'prompt.context': '已用 {percent}% 上下文',
  'prompt.compacting': '正在压缩上下文 {duration}',
  'prompt.queued': '{count} 条排队中',

  // 折叠行。中文没有单复数之分，所以 .one 与 .other 填同一句；只有 MCP 那两对
  // 例外——它们的区别不是复数，而是「只报服务名」还是「连调用次数一起报」。
  'collapse.thinking.active': '正在思考 {duration}',
  'collapse.thinking.settled': '思考了 {duration}',
  'collapse.search.active.one': '正在搜索 {count} 个 pattern',
  'collapse.search.active.other': '正在搜索 {count} 个 pattern',
  'collapse.search.settled.one': '搜索了 {count} 个 pattern',
  'collapse.search.settled.other': '搜索了 {count} 个 pattern',
  'collapse.read.active.one': '正在读取 {count} 个文件',
  'collapse.read.active.other': '正在读取 {count} 个文件',
  'collapse.read.settled.one': '读取了 {count} 个文件',
  'collapse.read.settled.other': '读取了 {count} 个文件',
  'collapse.list.active.one': '正在列出 {count} 个目录',
  'collapse.list.active.other': '正在列出 {count} 个目录',
  'collapse.list.settled.one': '列出了 {count} 个目录',
  'collapse.list.settled.other': '列出了 {count} 个目录',
  'collapse.mcp.active.one': '正在查询 {server}',
  'collapse.mcp.active.other': '正在查询 {server} {count} 次',
  'collapse.mcp.settled.one': '查询了 {server}',
  'collapse.mcp.settled.other': '查询了 {server} {count} 次',
  'collapse.separator': '，',
  'collapse.expandHint': '({key} 展开)',

  'status.flash.cardsHidden': '已隐藏工具卡片。',
  'status.flash.cardsExpanded': '已展开工具与上下文卡片。',
  'status.flash.cardsCollapsed': '工具卡片已收起，只读调用已归组，上下文已隐藏。',
  'status.flash.thinkingPinned': '思考块将一直留在屏幕上。',
  'status.flash.thinkingUnpinned': '思考块会在该步结束后隐藏。',
  'status.flash.thinkingDisabled': '当前配置关闭了思考块显示（showReasoning: false）。',
  'status.flash.planEmpty': '本会话还没有计划。',
  'status.flash.planExpanded': '计划已展开。',
  'status.flash.planCollapsed': '计划已收起。',
  'status.flash.escDraft': '再按一次 esc 清空草稿。',
  'status.flash.escRewind': '再按一次 esc 回退到更早的提问。',
  'status.flash.exitAgain': '再按一次 ctrl+c 退出。',
  'status.flash.exitWithoutTurn': '再按一次 ctrl+c 直接退出，不等当前轮次。',
  'status.flash.cancelBeforeExit': '请先取消当前轮次再退出。',
  'status.flash.cancellingBeforeExit': '正在取消当前轮次，之后退出…',
  'status.flash.collecting': '正在收集会话状态…',
  'status.flash.draftBlocksExit': '输入框里还有草稿 —— 先按 ctrl+c 清空再退出。',
  'status.flash.historyEmpty': '本会话还没有历史提问。',
  'status.flash.queuedForSkill': '已排队，等启动 skill 发送后再处理。',
  'status.flash.nothingToCopy': '还没有可复制的内容。',
  'status.flash.copied': '已复制 {count} 个字符到剪贴板。',
  'status.flash.copiedTmux': '已复制到 tmux 缓冲区（prefix+] 粘贴）。',
  'status.flash.copiedOsc52': '已通过 OSC 52 发送到剪贴板。',

  'status.card.title': '会话状态',
  'status.row.session': '会话',
  'status.row.title': '标题',
  'status.row.directory': '目录',
  'status.row.model': '模型',
  'status.row.preset': 'Preset',
  'status.row.permission': '权限',
  'status.row.agent': 'Agent',
  'status.row.goal': '目标',
  'status.row.goalState': '目标状态',
  'status.row.sessionTotals': '会话累计',
  'status.row.tokens': 'Token',
  'status.row.kvCache': 'KV 缓存',
  'status.row.context': '上下文',
  'status.row.created': '创建于',
  'status.row.active': '最近活动',
  'status.untitled': '未命名',
  'status.modelDetail': '（推理强度 {effort}；思考块 {thinking}）',
  'status.tokensValue': '输入 {input} + 输出 {output}',
  'status.cacheValue': '{meter} 命中 {rate}%（读 {read} + 写 {write}）',
  'status.cacheUnavailable': '无数据（读 {read} + 写 {write}）',
  'status.contextValue': '{meter} 已用 {percent}%（{used} / {capacity}）',
  'status.contextUnknown': '已用 {used} · 容量未知',
  'status.systemPrompt': 'System prompt',
  'status.registeredTools': '已注册工具',
  'status.thinking.disabled': '已禁用',
  'status.thinking.kept': '常驻',
  'status.thinking.live': '仅流式输出时',
  'status.effort.default': '默认',
  'status.count.event.one': '{count} 个事件',
  'status.count.event.other': '{count} 个事件',
  'status.count.turn.one': '{count} 轮',
  'status.count.turn.other': '{count} 轮',
  'status.count.step.one': '{count} 步',
  'status.count.step.other': '{count} 步',
  'status.count.toolCall.one': '{count} 次工具调用',
  'status.count.toolCall.other': '{count} 次工具调用',
  'status.totals.model': '模型 {duration}',
  'status.totals.tools': '工具 {duration}',
  'status.totals.ttft': '首字 {duration} 平均',
  'status.totals.decode': '解码 {rate} tok/s',

  'notice.unknownCommand': '未知命令：{text}',
  'notice.commandFailed': '命令执行失败：{error}',
  'notice.markdownDegraded': 'Markdown 渲染降级，本次会话余下部分改用后备渲染器。',
  'notice.copyFailed': '复制失败：{error}',
  'notice.overlayFailed': 'TUI 浮层失败：{error}',
  'notice.newSession': '已开启一个空会话。当前会话的历史仍在，用 /resume 可以回来。',
  'notice.newSessionFailed': '没能开启新会话：{error}',
  'notice.disposedRecovery': '用 /resume 打开另一个会话，或按 {exit} 退出。',
  'notice.agentDisposed': 'Agent "{id}" 已释放。{recovery}',
  'notice.agentDisposedTurn': 'Agent "{id}" 已释放，本会话无法再执行任何一轮。{recovery}',
  'notice.skillUsage': '用法：/skill:<name> [instructions]',
  'notice.referenceInvalid': '会话引用不合法：{error}',
  'notice.referenceUnavailable': '当前环境不提供会话引用能力。',
  'notice.referenceFailed': '会话引用失败：{error}',
  'notice.newSessionUnsupported': '当前运行时不能就地开新会话。退出后重新启动 dsh 即可得到一个空会话。',
  'notice.newSessionBusy': '开新会话需要 agent 处于空闲状态（当前：{status}）。',
  'notice.rewindNoFork': '那条提问已经放回编辑器。当前运行时不能分叉会话，所以它上面的对话没有变化。',
  'notice.rewindNoTurn': '那条提问已经放回编辑器。它前面没有已完成的一轮，没有可以分叉的位置。',
  'notice.rewindBusy': '先取消正在执行的这一轮，再回退。',
  'notice.rewindForking': '正在从那条提问之前的位置分叉本会话；原会话仍可 resume。',
  'notice.rewindFailed': '回退失败：{error}',
  'notice.reloadBusyAgent': '/reload 需要 agent 处于空闲状态（当前：{status}）。',
  'notice.reloadRunning': '已经有一个配置重载在执行了。',
  'notice.reloadNoLoader': '/reload 需要 cordis Loader，当前运行时没有。',
  'notice.reloadStarted': '正在重载 {count} 棵配置树…（experimental）',
  'notice.reloadDone': '配置重载完成。未改动的文件已跳过；不合法的文件保持原来的运行态（详见日志）。',
  'notice.reloadFailed': '配置重载失败：{error}',
  'notice.referencedSessions': '引用的会话 · {labels}',
  'transcript.compactionMarker': '… 更早的上下文已被压缩 …',
  'transcript.steeringBadge': '插入指令',
  'banner.resumed': '已恢复 {id}',
  'export.overwrite.question': '{path} 已存在，要覆盖吗？',
  'export.overwrite.replace': '覆盖这个文件',
  'export.overwrite.keep': '保留原文件',

  'settings.toolCards.collapsed': '折叠',
  'settings.toolCards.expanded': '展开',
  'settings.toolCards.hidden': '隐藏',
}

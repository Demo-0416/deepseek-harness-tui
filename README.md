# deepseek-harness-tui

Interactive terminal UI for [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness),
installed as a dsh profile bundle. It renders into the terminal's main screen —
no alternate screen, so the conversation stays in the scrollback after you leave
— and runs in the same process as the agent it drives.

## Prerequisite

The [dsh CLI](https://www.npmjs.com/package/@deepseek-ai/dsh) must be installed
first — this package is a dsh plugin, not a standalone program:

```sh
npm install -g @deepseek-ai/dsh
```

## Install

```sh
dsh plugin --profile tui add deepseek-harness-tui
```

This installs the package into a new `tui` profile (dsh-base + deepseek-harness-tui) and
activates it on next launch.

## Usage

```sh
dsh --profile tui                                # start the interactive TUI
dsh --profile tui "fix the failing test"         # start and send an initial prompt
dsh --profile tui --continue                     # resume the most recent session
dsh --profile tui --resume <sessionId>           # resume a specific session
dsh --profile tui --preset code                  # start on the "code" agent preset
dsh --profile tui -m kimi-coding/kimi-for-coding # override the model
dsh --profile tui --print "run the tests"        # one task, one answer on stdout
```

| Flag | Action |
|---|---|
| `-m, --model <provider/model>` | model selection for this run |
| `--preset <id>` | agent preset a fresh session is composed from; a resumed session keeps the preset its own log records |
| `-r, --resume <sessionId>` | resume a session by id |
| `-c, --continue` | continue the most recent session in this workspace |
| `-p, --print <task>` | run one task with no UI: the answer goes to stdout, the exit code is 0 only for a completed turn, and tool approvals are pinned to `never` because there is nobody to ask |
| `-h, --help` | show this help |
| `[prompt...]` | initial prompt, sent once the UI is up |

Both stdin and stdout must be TTYs; the bundle refuses to start on a pipe.
`--print` is the exception — it renders nothing, so it runs on a pipe, which is
the only place it is useful. Every other flag means the same thing with it:
`--print` runs against a `--resume`d or `--continue`d session as readily as
against a fresh one, under the model and preset the rest of the command line
selects.

### Keys

Every key below is what the terminal actually binds, at its default. `?` at an
empty prompt, `/hotkeys`, and `/help` print the same list, generated from the
keybinding registry, so a deployment that moves a key sees the new one named on
all three.

| Key | Action |
|---|---|
| Enter | send |
| Shift+Enter / Alt+Enter / Ctrl+J | newline; a `\` before Enter does the same, for terminals that cannot send Shift+Enter |
| Up / Down | prompt history from the first row of the prompt, cursor movement below it |
| Tab | accept a completion |
| `@` | reference a file |
| `/` | run a command; `/skill:<name>` loads a skill |
| `?` | shortcut help, on an empty prompt; never typed into the draft |
| Ctrl+R | search the prompt history backwards |
| Ctrl+T | expand or collapse the plan |
| Ctrl+O | cycle tool cards: preview, full, hidden |
| Ctrl+X | copy the last answer |
| Ctrl+L | redraw |
| Esc | cancel the turn (and hand back what was queued behind it); again on a draft clears it; again on an empty prompt opens Rewind |
| Ctrl+C | cancel while running, clear the draft while typing, twice to exit while idle; a third press leaves a turn that will not cancel |
| Ctrl+D | exit on an empty prompt |
| Shift+Ctrl+D | session debug panel — identity, lifecycle, screen, resolved keys |

#### While a surface holds the keyboard

| Surface | Keys |
|---|---|
| Panel (`/help`, `/hotkeys`, `/palette`, `/status`) | Up/Down scroll · PgUp/PgDn page · g/G or Home/End top or bottom · Esc or Ctrl+C close |
| Question | Up/Down move · 1-9 answer straight away · Space toggle (multi-select) · "Type something." row for a custom answer · PgUp/PgDn page long detail · Enter submit · Esc or Ctrl+C cancel |
| Permission prompt | Up/Down move · 1-4 answer straight away · Enter confirm · Esc or Ctrl+C deny |
| History search (Ctrl+R) | type to match · Ctrl+R steps to an older match · Tab or Esc accepts into the editor · Enter sends it · Ctrl+C or an emptied query restores the draft |
| Model picker (`/model`) | type to filter · Up/Down move · Left/Right or Shift+Tab adjust reasoning effort · Enter save as default · Ctrl+S use for this session only · Esc clears the filter, then closes |
| Resume picker (`/resume`) | type to search · Up/Down move · PgUp/PgDn page · Tab switches between this workspace and all · Enter resume · Esc clears the search, then closes |
| Rewind (`/rewind`) | Up/Down move · PgUp/PgDn page · Home/End first or last · Enter go back to that prompt · Esc close |
| Plugins (`/plugins`) | type to filter · Up/Down move · PgUp/PgDn page · Enter expand one entry · Esc close |
| Details (`/details`) | Tab cycles the highlighted setting, applied immediately · Esc close |

Ctrl+C is the one key that is never rebindable: it is how a terminal is always
left. Every other binding is configurable — see `keybindings` below.

### Commands

| Command | Action |
|---|---|
| `/help` | keyboard shortcuts and commands |
| `/hotkeys` | the keyboard shortcuts alone |
| `/model [[provider/]model]` | switch the model and save it as your default; without an argument it opens the picker, which can also pick for this session only |
| `/preset [<preset> \| copy <preset> <new-id>]` | show, switch, or copy this session's agent preset |
| `/details [collapsed\|expanded\|hidden] [reasoning [on\|off]]` | tool-card visibility and reasoning display; without arguments it opens the selector |
| `/login [provider]` | give a provider an API key: pick a configured route or one the adapter offers, paste the key, and it is checked against the endpoint before being stored. The key goes to the credential store; settings record only the variable name |
| `/provider [add]` | list configured providers and the ones `/login` can configure; `add` walks through name, endpoint, protocol, key, and the models the endpoint reports |
| `/copy` | copy the last answer to the system clipboard |
| `/new` | start a blank session in this workspace; the current one keeps its history and stays resumable |
| `/clear` | clear the transcript view; the session log is unchanged |
| `/palette` | every color and attribute role this terminal renders |
| `/export [path]` | write this session's log to a file and report the path; an existing file is replaced only after you confirm |
| `/plugins` | search and inspect the Loader's plugin entries |
| `/rewind` | go back to an earlier prompt in this session |
| `/resume [session]` | list this workspace's resumable sessions; an argument fills the picker's search box |
| `/status` | session diagnostics, system prompt, registered tools |
| `/exit`, `/quit` | exit after the active turn reaches idle |
| `/skill:<name> [instructions]` | load a skill into the conversation |
| `/reload` | EXPERIMENTAL (dev): re-read the Loader's config files and apply the diff, idle only. Registered only when `experimentalCommands` is on |

Those are this bundle's own commands. Whatever else the profile mounts registers
its own on top of them, and `/help` lists what the running session actually has.

### `@` file references

`@` lists the workspace through `fd` when the host has it (`fd`, or `fdfind` on
Debian and Ubuntu), so completion honors `.gitignore`, `.ignore`, and
`.fdignore`. Without it a built-in walker takes over and skips build output by
name — `.git`, `node_modules`, `dist`, `build`, `out`, `coverage`, `.cache`,
`.next`, `.nuxt`, `.turbo`, `.venv`, `__pycache__`, `target` — and withholds
`*.log` and `*.tsbuildinfo` from a query that named no extension. Set
`fileSearchCommand` to pin the binary's path, or to `""` to always use the
walker, and `fileSearchExcludedDirectories` to change what the walker skips.

Commands complete their arguments too: `/model` offers every advertised
`provider/model`, `/preset` the roster's presets and the `copy` verb, `/details`
whichever of its two slots the cursor is in, and `/resume` this workspace's
recent sessions.

### Surfaces

- **Chat** — the main view: streaming messages, tool cards, the plan, the status
  row, and the prompt with its context line.
- **Rewind** — `/rewind`, or a double Esc at an empty prompt: go back to an
  earlier prompt. With a host that can fork the session the conversation moves
  with it and the original stays resumable; otherwise the prompt comes back to
  the editor alone. Files are never restored — dsh keeps no file checkpoints.
- **Resume** — `/resume [session]`: pick and resume a past session, in this
  workspace or (Tab) in all of them.
- **Plugins** — `/plugins`: search and inspect the Loader's entries.
- **Status** — `/status`: session diagnostics, system prompt, registered tools.
- **Help** — `/help`: keys and slash commands.

## Configuration

Values on the bundle row (`tui-runner`), all optional.

| Key | Default | Meaning |
|---|---|---|
| `welcome` | — | extra dim line under the startup banner; with no key at all the wordmark sweeps in instead |
| `sessionId` | `main` | shared agent/session identity this terminal drives |
| `initialSkill` | — | skill auto-invoked as the session's first turn, as if `/skill:<name>` were typed; set by a launcher, not by a person |
| `initialDraft` | — | text the editor opens with, unsent; set by a rewind handoff |
| `experimentalCommands` | `false` | register the developer commands (`/reload` today) |
| `showReasoning` | `true` | render model reasoning blocks |
| `markdownRenderer` | `claude` | `claude` (this bundle's renderer) or `pi` (pi-tui's `Markdown`); a `claude` render that throws falls back to `pi` for the rest of the process |
| `maxToolOutputLines` | `6` | body lines kept in a collapsed tool card's head/tail preview |
| `maxDiffEditLength` | `1000` | added and removed lines explored while deriving an exact line diff |
| `maxQuestionOptions` | `8` | options visible at once in a question panel |
| `maxModelOptions` | `8` | models visible at once in the model selector |
| `maxResumeOptions` | `8` | sessions visible at once in the resume selector |
| `resumeScanConcurrency` | `4` | concurrent cold projection reads in one resume scan |
| `questionDialogWidth` | `200` | question panel width in columns, clamped to the terminal |
| `questionDialogMaxHeight` | `20` | question panel maximum height in rows |
| `modelDialogWidth` | `76` | model selector width in columns |
| `modelDialogMaxHeight` | `20` | model selector maximum height in rows |
| `detailsDialogWidth` | `72` | details selector width in columns |
| `fileSearchMaxResults` | `20` | fuzzy file candidates displayed for one `@` query |
| `fileSearchMaxEntries` | `10000` | paths retained in one `@` workspace index |
| `fileSearchExcludedDirectories` | see above | directory basenames the walker skips |
| `fileSearchCommand` | — | `fd` path or name; unset discovers it on `PATH`, `""` disables it |
| `showHardwareCursor` | `false` | show the terminal's hardware cursor at the editor's IME marker |
| `title` | `DeepSeek Harness` | terminal window title while the UI is mounted |
| `theme.color` | `true` | apply the built-in ANSI palette |
| `theme.truecolor` | detected | 24-bit brand gradient on the banner; unset reads `COLORTERM` |
| `theme.leftPrompt` | `${cwd}${git/worktree}${model}${token_meter/cache_hit_rate}${context}` | left-aligned template above the editor |
| `theme.rightPrompt` | `${queued}` | right-aligned template above the editor |
| `theme.inputPrompt` | `❯ ` | the editor's first-line prefix |
| `theme.inputPlaceholder` | `press enter to steer and esc to cancel` | placeholder in an empty editor while the agent runs |
| `keybindings` | — | key overrides, keyed by action id |

Prompt templates interpolate `${name}` against the values this bundle registers
— `cwd`, `git/worktree`, `model`, `context`, `token_meter/cache_hit_rate`,
`goal`, `queued`, `symbol`, `indicator` — and a separator next to a value that
is currently unavailable is dropped with it.

Bindings other than Ctrl+C are configurable: set `keybindings` on the bundle row
(`{ "app.history.search": "ctrl+g" }`), keyed by action id and valued with one
pi-tui key id or several. This bundle's ids are `app.tools.cycle`,
`app.history.search`, `app.todos.toggle`, `app.message.copy`,
`app.screen.redraw`, `app.cancel`, and `app.exit`; pi-tui's own editor bindings
can be moved the same way. Shift+Ctrl+D reports what each of those ids resolved
to, and any key two actions both claim — which is the first thing to suspect
when a key "does nothing".

## Development

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
dsh plugin --profile tui add link:./path/to/dsh-tui  # live-link for development
dsh --profile tui
```

Set `experimentalCommands: true` on the `tui-runner` row to get `/reload` while
editing config files.

The plugin is two Cordis plugins in one bundle:

- `dsh-tui/startup` — parses the TUI's own command line and provides the
  `tuiStartup` service.
- `dsh-tui` — the runner: owns the pi-tui render loop, the in-process agent
  session, the approval answerer, and the user-question provider.

Data flows one way. Events from the dsh bus (`session/event`, `agent/status`)
are folded by a per-session read model into an immutable node list; a keyed
reconciler turns that list into pi-tui components, reusing every node whose
version it has already applied, so a burst of stream chunks repaints one
assistant step rather than the transcript. The TUI runs in-process and calls
`ctx.agents` / `ctx.approval` / `ctx.commands` directly — no SDK, no ACP
transport, and no React.

## License

MIT

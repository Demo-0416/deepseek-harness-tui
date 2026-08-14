# dsh-tui

Interactive terminal UI for [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness), installed as a dsh profile bundle.

## Install

```sh
dsh plugin --profile tui add dsh-tui
```

This installs the package into a new `tui` profile (dsh-base + dsh-tui) and activates it on next launch.

## Usage

```sh
dsh --profile tui                    # start the interactive TUI
dsh --profile tui "fix the tests"     # start and send an initial prompt
dsh --profile tui --continue          # resume the most recent session
dsh --profile tui --resume <id>       # resume a specific session
dsh --profile tui -m kimi-coding/kimi-for-coding  # override the model
dsh --profile tui -p "run the tests"  # one-shot: answer and exit
```

### Keys

Every key below is what the terminal actually binds; `?` at an empty prompt,
`/hotkeys`, and `/help` print the same list from the same table.

| Key | Action |
|---|---|
| Enter | send |
| Shift+Enter / Alt+Enter | newline |
| ↑ / ↓ | prompt history (composer), navigate (pickers) |
| Tab | accept a completion |
| `@` | reference a file |
| `/` | run a command; `/skill:<name>` loads a skill |
| `?` | shortcut help, on an empty prompt |
| Ctrl+R | search the prompt history backwards |
| Ctrl+T | expand or collapse the plan |
| Ctrl+O | cycle tool cards: preview, full, hidden |
| Ctrl+X | copy the last answer |
| Ctrl+L | redraw |
| Esc | cancel the turn; again on a draft clears it; again on an empty prompt opens Rewind |
| Ctrl+C | cancel while running, clear the draft while typing, twice to exit while idle |
| Ctrl+D | exit on an empty prompt |
| Shift+Ctrl+D | session debug panel |

Bindings other than Ctrl+C are configurable: set `keybindings` on the bundle row
(`{ "app.history.search": "ctrl+g" }`), keyed by action id and valued with one
pi-tui key id or several. pi-tui's own editor bindings can be moved the same way.

### Surfaces

- **Chat** — the main view: streaming messages, tool cards, the plan, status row.
- **Rewind** — `/rewind`, or a double Esc at an empty prompt: go back to an
  earlier prompt. With a host that can fork the session the conversation moves
  with it and the original stays resumable; otherwise the prompt comes back to
  the editor alone. Files are never restored — dsh keeps no file checkpoints.
- **Resume** — `/resume`: pick and resume a past session.
- **Plugins** — `/plugins`: search and inspect the Loader's entries.
- **Status** — `/status`: session diagnostics, system prompt, registered tools.
- **Help** — `/help`: keys and slash commands.

## Development

```sh
pnpm install
pnpm run build
dsh plugin --profile tui add link:./path/to/dsh-tui  # live-link for development
dsh --profile tui
```

The plugin is two Cordis plugins in one bundle:

- `dsh-tui/startup` — parses the TUI's own command line and provides the `tuiStartup` service.
- `dsh-tui` — the runner: owns the Ink render loop, the in-process agent session, the approval answerer, and the user-question provider.

Data flows from the dsh event bus (`session/event`, `agent/status`) through an event-sourcing store into immutable React snapshots. The TUI runs in-process and calls `ctx.agents` / `ctx.approval` / `ctx.commands` directly — no SDK or ACP transport.

## License

MIT

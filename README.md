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

| Key | Action |
|---|---|
| Enter | send message |
| Ctrl+J | insert newline |
| Ctrl+C | cancel the active turn, or quit when idle |
| Esc | return to chat / cancel |
| ↑ / ↓ | history (in composer), navigate (in pickers) |
| Ctrl+K | kill to end of line |
| Ctrl+U | kill to start of line |
| Alt+B / Alt+F | word left / right |
| `?` | help |
| Ctrl+S | sessions |
| Ctrl+F | search |
| Ctrl+T | trajectory |
| Ctrl+B | subagents |
| Ctrl+P | plugins |
| Ctrl+, | settings |

### Screens

- **Chat** — the main view: streaming messages, tool calls, todos, status bar.
- **Sessions** — pick and resume past sessions.
- **Search** — search within the current session.
- **Trajectory** — raw event log of the current session.
- **Subagents** — subagent activity in the current session.
- **Plugins** — loaded dsh plugins.
- **Settings** — theme, approval policy.
- **Help** — keybindings and slash commands.

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

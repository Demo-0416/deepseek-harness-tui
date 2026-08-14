/**
 * `dsh --profile tui` command-line provider: parses this app's own flags and
 * provides the parsed values as the `tuiStartup` service. The launcher only
 * knows --profile/--patch and the web/plugin subcommands, so every app flag
 * is parsed here, exactly like the headless bundle's startup plugin.
 * @module dsh-tui/startup
 */

import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'

/** Stable Cordis plugin name. */
export const name = 'tui-startup'

/** Services required before the command line can be parsed. */
export const inject = ['cmdlineArgs']

/** Service provided by this plugin and injected by the TUI runner. */
export const TUI_STARTUP_SERVICE = 'tuiStartup'

/** What the runner reads from the {@link TUI_STARTUP_SERVICE} service. */
export interface TuiStartupValues {
  /** `provider/model` selection override, e.g. `kimi-coding/kimi-for-coding`. */
  model: string | undefined
  /**
   * Agent preset the fresh session is composed from, when `--preset` was
   * passed. Applies to creation only: a resumed session runs the preset its own
   * log records, because its history was produced under that composition.
   */
  preset: string | undefined
  /** Session id to resume, when `--resume` was passed. */
  resume: string | undefined
  /** Continue the most recent session, when `--continue` was passed. */
  continueLatest: boolean
  /**
   * One-shot task text, when `--print` was passed.
   *
   * Selects the runner's headless path: the task is run to quiescence and its
   * answer is written on stdout, with no renderer and no TTY requirement. Every
   * other value here still applies — the one-shot run opens its session through
   * the same startup path the interactive run does.
   */
  print: string | undefined
  /** Initial prompt typed on the command line, sent once the UI is up. */
  initialPrompt: string | undefined
}

/**
 * This app's command: its flags, descriptions, and help text.
 * @returns a fresh program, so one process can parse more than once (tests).
 */
export function tuiCommand(): Command {
  return new Command()
    .name('dsh --profile tui')
    .description('Interactive terminal UI for deepseek-harness')
    .helpOption('-h, --help', 'show this help')
    .option('-m, --model <provider/model>', 'model selection (provider/model)')
    .option('--preset <id>', 'agent preset a fresh session is composed from')
    .option('-r, --resume <sessionId>', 'resume a session by id')
    .option('-c, --continue', 'continue the most recent session')
    .option('-p, --print <task>', 'run one task without a UI and write the answer on stdout')
    .argument('[prompt...]', 'initial prompt to send on start')
    .addHelpText('after', `
Examples:
  dsh --profile tui                           start the interactive TUI
  dsh --profile tui "fix the failing test"    start and send an initial prompt
  dsh --profile tui --continue                resume the most recent session
  dsh --profile tui --resume <sessionId>      resume a specific session
  dsh --profile tui --preset code             start on the "code" agent preset
  dsh --profile tui --print "run the tests"   answer one task on stdout, no UI
`)
}

/**
 * Parse and provide the TUI startup values as an ordinary Cordis service.
 * @param ctx - plugin context carrying the command line.
 */
export function apply(ctx: Context): void {
  const program = tuiCommand()
  program.action(() => {
    const opts = program.opts<{
      model?: string
      preset?: string
      resume?: string
      continue?: boolean
      print?: string
    }>()
    const prompt = program.args.join(' ').trim()
    ctx.provide(TUI_STARTUP_SERVICE, {
      model: opts.model,
      preset: opts.preset,
      resume: opts.resume,
      continueLatest: opts.continue === true,
      print: opts.print,
      initialPrompt: prompt === '' ? undefined : prompt,
    } satisfies TuiStartupValues)
  })
  parseCmdline(ctx, program)
}

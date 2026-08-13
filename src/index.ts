/**
 * @dsh-tui — the interactive terminal UI runner. The bundle patch rides over
 * dsh-base without Host, HTTP, or browser plugins; this plugin owns the Ink
 * render loop, the in-process agent session, the approval answerer, and the
 * process exit handshake.
 *
 * @module dsh-tui
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { TUI_STARTUP_SERVICE, type TuiStartupValues } from './startup.ts'
import { TuiController } from './core/controller.ts'
import { renderApp } from './tui/app.tsx'

/** Stable Cordis plugin name. */
export const name = 'dsh-tui'

/**
 * Core services required before the UI can start. The `tuiStartup` provider
 * is a sibling in this bundle and is injected through the patch row.
 */
export const inject = ['agents', 'sessions']

/** Plugin config (reserved; the TUI's knobs arrive as flags, not config). */
export interface Config {}

export const Config: z<Config> = z.object({})

/** This app's version, read from its checked-in package.json. */
function readVersion(): string {
  const manifest = JSON.parse(
    readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf-8'),
  ) as { version?: unknown }
  return typeof manifest.version === 'string' ? manifest.version : '0.0.0'
}

/**
 * Boot the TUI: wait for the whole application to compose, create the
 * controller (agent + store + approval answerer), and render until quit.
 * @param ctx - plugin context carrying the core services and launcher IO.
 * @param exit - the launcher's bounded exit request.
 */
async function boot(ctx: Context, exit: (code: number) => void): Promise<void> {
  // Loader siblings mount concurrently; await the complete application so the
  // TUI does not race half-composed scoped tools and adapters.
  await ctx.get('loader')?.await()

  const startup = ctx.get(TUI_STARTUP_SERVICE) as TuiStartupValues | undefined
  if (startup === undefined) {
    throw new Error('dsh-tui: tuiStartup service missing — the tui-startup plugin must mount first')
  }

  const controller = new TuiController(ctx, exit)
  const offApproval = controller.registerApprovalAnswerer()
  const offQuestions = controller.registerQuestionProvider()
  ctx.effect(() => () => {
    offApproval()
    offQuestions()
  })

  const model = startup.model ?? 'default'
  const app = renderApp(controller, readVersion(), model, () => {
    void controller.quit()
  })
  ctx.effect(() => () => {
    app.unmount()
  })

  try {
    await controller.boot(startup)
  } catch (error) {
    app.unmount()
    throw error
  }

  await app.waitUntilExit()
}

/**
 * Mount the TUI runner.
 * @param ctx - plugin context carrying core services and the launcher exit request.
 * @param _config - validated plugin config (reserved).
 */
export function apply(ctx: Context, _config: Config): void {
  const exit = ctx.get('appExit')
  if (exit === undefined) {
    throw new Error('dsh-tui: the launcher must provide ctx.appExit before the tree mounts')
  }
  void boot(ctx, exit).catch((error: unknown) => {
    process.stderr.write(`dsh-tui: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    exit(1)
  })
}

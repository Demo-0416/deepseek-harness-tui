import { Command } from "commander";
import { parseCmdline } from "@deepseek-ai/dsh-cmdline";
//#region src/startup.ts
/**
* `dsh --profile tui` command-line provider: parses this app's own flags and
* provides the parsed values as the `tuiStartup` service. The launcher only
* knows --profile/--patch and the web/plugin subcommands, so every app flag
* is parsed here, exactly like the headless bundle's startup plugin.
* @module dsh-tui/startup
*/
/** Stable Cordis plugin name. */
const name = "tui-startup";
/** Services required before the command line can be parsed. */
const inject = ["cmdlineArgs"];
/** Service provided by this plugin and injected by the TUI runner. */
const TUI_STARTUP_SERVICE = "tuiStartup";
/**
* This app's command: its flags, descriptions, and help text.
* @returns a fresh program, so one process can parse more than once (tests).
*/
function tuiCommand() {
	return new Command().name("dsh --profile tui").description("Interactive terminal UI for deepseek-harness").helpOption("-h, --help", "show this help").option("-m, --model <provider/model>", "model selection (provider/model)").option("--preset <id>", "agent preset a fresh session is composed from").option("-r, --resume <sessionId>", "resume a session by id").option("-c, --continue", "continue the most recent session").option("-p, --print <task>", "run one task without a UI and write the answer on stdout").argument("[prompt...]", "initial prompt to send on start").addHelpText("after", `
Examples:
  dsh --profile tui                           start the interactive TUI
  dsh --profile tui "fix the failing test"    start and send an initial prompt
  dsh --profile tui --continue                resume the most recent session
  dsh --profile tui --resume <sessionId>      resume a specific session
  dsh --profile tui --preset code             start on the "code" agent preset
  dsh --profile tui --print "run the tests"   answer one task on stdout, no UI
`);
}
/**
* Parse and provide the TUI startup values as an ordinary Cordis service.
* @param ctx - plugin context carrying the command line.
*/
function apply(ctx) {
	const program = tuiCommand();
	program.action(() => {
		const opts = program.opts();
		const prompt = program.args.join(" ").trim();
		ctx.provide(TUI_STARTUP_SERVICE, {
			model: opts.model,
			preset: opts.preset,
			resume: opts.resume,
			continueLatest: opts.continue === true,
			print: opts.print,
			initialPrompt: prompt === "" ? void 0 : prompt
		});
	});
	parseCmdline(ctx, program);
}
//#endregion
export { TUI_STARTUP_SERVICE, apply, inject, name, tuiCommand };

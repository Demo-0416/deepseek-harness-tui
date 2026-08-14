import { randomUUID } from "node:crypto";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { CURSOR_MARKER, CombinedAutocompleteProvider, Container, Editor, Input, Key, KeybindingsManager, Markdown, ProcessTerminal, SelectList, Spacer, TUI_KEYBINDINGS, Text, TuiMainScreen, isKeyRelease, isKeyRepeat, matchesKey, setKeybindings, stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Service } from "@deepseek-ai/cordis";
import { assembleContextFor, installModelSelection } from "@deepseek-ai/dsh-agent";
import { assertNever, createUserMessage, errorChain } from "@deepseek-ai/dsh-llm";
import { renderPrompt } from "@deepseek-ai/dsh-system-prompt";
import { SessionId, isReplacementSurfaceEvent } from "@deepseek-ai/dsh-session";
import { foldGoal } from "@deepseek-ai/dsh-goal";
import { formatSessionReferenceMention, parseSessionReferenceText } from "@deepseek-ai/dsh-session-reference";
import { execFile, execFileSync } from "node:child_process";
import { accessSync, constants, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { scrubbedParentEnv } from "@deepseek-ai/dsh-subprocess";
import { SaxesParser } from "saxes";
import { diffWords, structuredPatch } from "diff";
import { Marked } from "marked";
import { isCompactCheckpointSource } from "@deepseek-ai/dsh-compaction";
import z from "@deepseek-ai/schemastery";
import { lstat, readdir, stat, writeFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { UserQuestionError } from "@deepseek-ai/dsh-user-questions";
import { setApprovalPolicy } from "@deepseek-ai/dsh-user-approval";
//#region src/extension/overlay-manager.ts
/**
* Private bridge between the public TUI extension contract and pi-tui.
*
* The manager serializes modal ownership, guards extension callbacks, and
* settles every queued or active operation before terminal teardown.
* @module @deepseek-ai/dsh-tui/extension/overlay-manager
*/
/** Turn a close reason into its immutable public outcome. */
function outcome(reason) {
	return Object.freeze({ reason });
}
/** Retain only supported layout fields before a queued request returns to its caller. */
function retainOptions(options) {
	return Object.freeze({
		...options.width === void 0 ? {} : { width: options.width },
		...options.minWidth === void 0 ? {} : { minWidth: options.minWidth },
		...options.maxHeight === void 0 ? {} : { maxHeight: options.maxHeight },
		...options.anchor === void 0 ? {} : { anchor: options.anchor },
		...options.margin === void 0 ? {} : { margin: typeof options.margin === "object" ? Object.freeze({ ...options.margin }) : options.margin }
	});
}
/** Guard plugin component methods while preserving focus and key-release state. */
var GuardedOverlayComponent = class {
	component;
	fail;
	constructor(component, fail) {
		this.component = component;
		this.fail = fail;
	}
	get focused() {
		try {
			return this.component.focused ?? false;
		} catch (error) {
			this.fail(error);
			return false;
		}
	}
	set focused(value) {
		try {
			if ("focused" in this.component) this.component.focused = value;
		} catch (error) {
			this.fail(error);
		}
	}
	get wantsKeyRelease() {
		try {
			return this.component.wantsKeyRelease ?? false;
		} catch (error) {
			this.fail(error);
			return false;
		}
	}
	render(width) {
		try {
			return this.component.render(width);
		} catch (error) {
			this.fail(error);
			return [];
		}
	}
	handleInput(data) {
		try {
			this.component.handleInput?.(data);
		} catch (error) {
			this.fail(error);
		}
	}
	invalidate() {
		try {
			this.component.invalidate();
			return true;
		} catch (error) {
			this.fail(error);
			return false;
		}
	}
};
/** FIFO modal owner for one mounted TUI. */
var TuiOverlayManager = class {
	driver;
	queue = [];
	active;
	accepting = true;
	disposeTask;
	constructor(driver) {
		this.driver = driver;
	}
	/**
	* Whether one extension or built-in overlay currently owns terminal focus.
	* @returns `true` while an overlay is active.
	*/
	hasActiveOverlay() {
		return this.active !== void 0;
	}
	/** Reject new work while the TUI unloads dependent extension fibers. */
	beginShutdown() {
		this.accepting = false;
	}
	/**
	* Queue one modal without assigning Cordis ownership.
	*
	* An arriving inline request first takes down an active
	* {@link TuiOverlayRequest.dismissable} surface, so a permission prompt or a
	* question reaches the screen even when the user left a panel or a selector
	* open. Without that, the single inline slot let a view the user was merely
	* reading hide the decision a turn was blocked on, and the turn hung with
	* nothing on screen to answer.
	* @param request - component factory, constraints, and request signal.
	* @param placement - terminal overlay for extensions, or inline for the built-in question panel.
	* @returns an internal session that can close with an ownership reason.
	*/
	open(request, placement = "overlay") {
		if (!this.accepting) throw new Error("TUI is shutting down");
		const requestSignal = request.signal;
		const retainedRequest = Object.freeze({
			create: request.create,
			...request.options === void 0 ? {} : { options: retainOptions(request.options) },
			...requestSignal === void 0 ? {} : { signal: requestSignal }
		});
		const controller = new AbortController();
		const signal = requestSignal === void 0 ? controller.signal : AbortSignal.any([requestSignal, controller.signal]);
		const deferred = Promise.withResolvers();
		const session = {
			get state() {
				return entry.state;
			},
			closed: deferred.promise,
			close: () => this.close(entry, outcome("closed")),
			closeWith: (reason) => this.close(entry, outcome(reason))
		};
		const entry = {
			request: retainedRequest,
			controller,
			signal,
			closed: deferred.promise,
			resolveClosed: deferred.resolve,
			session,
			placement,
			dismissable: request.dismissable === true,
			state: "queued"
		};
		if (requestSignal?.aborted === true) {
			this.close(entry, outcome("aborted"));
			return session;
		}
		if (requestSignal !== void 0) {
			const onAbort = () => {
				this.close(entry, outcome("aborted"));
			};
			requestSignal.addEventListener("abort", onAbort, { once: true });
			entry.removeRequestAbort = () => {
				requestSignal.removeEventListener("abort", onAbort);
			};
		}
		if (placement === "inline") this.dismissActive();
		this.queue.push(entry);
		this.activateNext();
		return session;
	}
	/** Close an active dismissable surface so an arriving inline one takes the slot. */
	dismissActive() {
		const active = this.active;
		if (active === void 0 || !active.dismissable) return;
		this.close(active, outcome("closed"));
	}
	/** Stop accepting work and settle every active or queued overlay. */
	dispose() {
		if (this.disposeTask !== void 0) return this.disposeTask;
		this.beginShutdown();
		const entries = [...this.active === void 0 ? [] : [this.active], ...this.queue];
		return this.disposeTask = Promise.all(entries.map((entry) => this.close(entry, outcome("tui-disposed")))).then(() => {});
	}
	activateNext() {
		if (!this.accepting || this.active !== void 0) return;
		const entry = this.queue.shift();
		if (entry === void 0) return;
		this.active = entry;
		entry.state = "active";
		const host = this.host(entry);
		let component;
		try {
			component = entry.request.create(host);
		} catch (error) {
			this.fail(entry, error);
			return;
		}
		if (this.active !== entry) return;
		const guarded = new GuardedOverlayComponent(component, (error) => {
			this.fail(entry, error);
		});
		entry.component = guarded;
		try {
			const handle = this.driver.show(guarded, entry.request.options, entry.placement);
			if (this.active !== entry) {
				this.hide(handle);
				return;
			}
			entry.handle = handle;
			this.driver.invalidate();
		} catch (error) {
			this.fail(entry, error);
		}
	}
	host(entry) {
		const driver = this.driver;
		return Object.freeze({
			get signal() {
				return entry.signal;
			},
			get viewport() {
				return Object.freeze({ ...driver.viewport() });
			},
			get theme() {
				return driver.theme();
			},
			display: (value) => this.driver.display(value),
			invalidate: () => {
				if (this.active !== entry || entry.component === void 0 || entry.failing === true) return;
				if (!entry.component.invalidate() || this.active !== entry) return;
				try {
					this.driver.invalidate();
				} catch (error) {
					this.fail(entry, error);
				}
			},
			close: () => {
				this.close(entry, outcome("closed"));
			}
		});
	}
	fail(entry, error) {
		if (entry.state === "closed" || entry.failing === true) return;
		entry.failing = true;
		this.report(error);
		queueMicrotask(() => {
			this.close(entry, Object.freeze({
				reason: "error",
				error
			}));
		});
	}
	report(error) {
		try {
			this.driver.reportError(error);
		} catch {}
	}
	hide(handle) {
		try {
			handle.hide();
		} catch (error) {
			this.report(error);
		}
	}
	close(entry, result) {
		if (entry.outcome !== void 0) return entry.closed;
		entry.outcome = result;
		entry.state = "closed";
		entry.removeRequestAbort?.();
		delete entry.removeRequestAbort;
		if (!entry.controller.signal.aborted) entry.controller.abort(result);
		const queuedIndex = this.queue.indexOf(entry);
		if (queuedIndex >= 0) this.queue.splice(queuedIndex, 1);
		if (this.active === entry) {
			this.active = void 0;
			if (entry.handle !== void 0) this.hide(entry.handle);
			delete entry.handle;
		}
		delete entry.component;
		entry.resolveClosed(result);
		try {
			this.driver.invalidate();
		} catch (error) {
			this.report(error);
		}
		queueMicrotask(() => {
			this.activateNext();
		});
		return entry.closed;
	}
};
/**
* A forwarding view of one manager that marks every request it opens
* {@link TuiOverlayRequest.dismissable}.
*
* Sub-controllers (the model selector) receive the manager itself rather than a
* per-request flag, so the channel marks their whole surface where it hands the
* manager over. The view holds no state of its own — every method forwards to
* the one manager, which is why the cast is safe.
* @param manager - the single manager that owns the modal slot.
* @returns a manager view whose overlays yield to arriving decisions.
*/
function dismissableOverlays(manager) {
	return {
		open: (request, placement) => manager.open({
			...request,
			dismissable: true
		}, placement),
		hasActiveOverlay: () => manager.hasActiveOverlay(),
		beginShutdown: () => {
			manager.beginShutdown();
		},
		dispose: () => manager.dispose()
	};
}
/** Cordis service whose method effects bind to the calling plugin fiber. */
var TuiExtensionServiceImpl = class extends Service {
	agent;
	overlays;
	constructor(ctx, agent, overlays) {
		super(ctx, "tui");
		this.agent = agent;
		this.overlays = overlays;
	}
	/** @inheritdoc */
	openOverlay(request) {
		let operation;
		const disposeOwner = this.ctx.effect(() => () => operation?.closeWith("owner-disposed"), "tui.openOverlay()");
		try {
			operation = this.overlays.open(request);
		} catch (error) {
			disposeOwner();
			throw error;
		}
		operation.closed.then(() => {
			disposeOwner();
		});
		return operation;
	}
};
//#endregion
//#region src/prompt.ts
/**
* Mutable terminal-prompt value registry consumed by the TUI template renderer.
* Values are trusted presentation fragments and may contain ANSI control sequences.
* @module @deepseek-ai/dsh-tui/prompt
*/
const VALUE_NAME = /^[a-z][a-z0-9_-]*(?:\/[a-z][a-z0-9_-]*)*$/u;
/**
* Parse a prompt template into immutable literal and value tokens.
* @param template - Text containing `${name}` references.
* @returns Tokens consumed by {@link renderTuiPromptTemplate}.
*/
function parseTuiPromptTemplate(template) {
	const tokens = [];
	const pattern = /\$\{([^}]*)\}/gu;
	let offset = 0;
	for (const match of template.matchAll(pattern)) {
		const index = match.index;
		const name = match[1];
		/* v8 ignore next -- the sole capture always exists when this pattern matches. */
		if (name === void 0) continue;
		if (index > offset) tokens.push(Object.freeze({
			kind: "literal",
			value: template.slice(offset, index)
		}));
		tokens.push(Object.freeze({
			kind: "value",
			name
		}));
		offset = index + match[0].length;
	}
	if (offset < template.length) tokens.push(Object.freeze({
		kind: "literal",
		value: template.slice(offset)
	}));
	return Object.freeze(tokens);
}
/**
* Interpolate one parsed prompt while removing horizontal separators adjacent
* only to unavailable values.
* @param tokens - Parsed template tokens.
* @param resolve - Current value lookup.
* @returns ANSI-capable rendered prompt text.
*/
function renderTuiPromptTemplate(tokens, resolve) {
	const rendered = [];
	let omitLeadingWhitespace = false;
	for (const token of tokens) {
		if (token.kind === "value") {
			const value = resolve(token.name);
			if (value === void 0) omitLeadingWhitespace = true;
			else {
				rendered.push(value);
				omitLeadingWhitespace = false;
			}
			continue;
		}
		rendered.push(omitLeadingWhitespace ? token.value.replace(/^[\t ]+/u, "") : token.value);
		omitLeadingWhitespace = false;
	}
	return rendered.join("");
}
/**
* Context-global mutable values interpolated by TUI theme prompt templates.
* A registration, mutation, or disposal schedules one coalesced notification to
* the renderer subscribed with {@link TuiPromptService.subscribe}, so a value
* that changes on its own schedule (not only in response to a UI event) still
* redraws. Notification is a direct in-service callback, not a Cordis event.
*/
var TuiPromptService = class extends Service {
	values = /* @__PURE__ */ new Map();
	listeners = /* @__PURE__ */ new Set();
	notificationQueued = false;
	constructor(ctx) {
		super(ctx, "tuiPrompt");
	}
	/**
	* Register one globally unique template value under the calling Cordis effect.
	* @param name - Lowercase slash-separated template name.
	* @param initialValue - Initial trusted ANSI-capable fragment.
	* @returns A mutable handle whose disposal unregisters the name.
	*/
	register(name, initialValue) {
		if (!VALUE_NAME.test(name)) throw new TypeError(`TUI prompt value name "${name}" must match ${String(VALUE_NAME)}`);
		if (this.values.has(name)) throw new Error(`TUI prompt value "${name}" is already registered`);
		const registered = { value: initialValue };
		let active = true;
		const effectDisposer = this.ctx.effect(() => {
			this.values.set(name, registered);
			this.scheduleChange();
			return () => {
				active = false;
				this.values.delete(name);
				this.scheduleChange();
			};
		}, `tuiPrompt.register(${name})`);
		return Object.freeze({
			set: (value) => {
				if (!active) throw new Error(`TUI prompt value "${name}" is disposed`);
				if (registered.value === value) return;
				registered.value = value;
				this.scheduleChange();
			},
			dispose: () => {
				effectDisposer();
			}
		});
	}
	/**
	* Read a registered fragment without evaluating plugin code.
	* @param name - Exact registered template name.
	* @returns The current fragment, or `undefined` when unknown or unavailable.
	*/
	get(name) {
		return this.values.get(name)?.value;
	}
	/**
	* Observe registration and value changes. The listener runs after a coalesced
	* microtask following any burst of mutations; the renderer re-reads current
	* values on that callback. The subscription is owned by the calling Cordis
	* effect, so it is removed when the subscriber's fiber disposes; the returned
	* disposer removes it early. Listener failures are contained — a synchronous
	* throw or a rejected returned promise cannot starve the other observers.
	* @param listener - Invoked once per coalesced change burst. Delivery does
	*   not wait on a returned promise; its rejection is only observed and logged,
	*   never left unhandled, so an async listener cannot order later observers.
	* @returns A disposer that removes the subscription.
	*/
	subscribe(listener) {
		const record = { listener };
		const disposeEffect = this.ctx.effect(() => {
			this.listeners.add(record);
			return () => {
				this.listeners.delete(record);
			};
		}, "tuiPrompt.subscribe");
		return () => {
			disposeEffect();
		};
	}
	/** Coalesce mutation bursts into one notification while containing each observer. */
	scheduleChange() {
		if (this.notificationQueued) return;
		this.notificationQueued = true;
		queueMicrotask(() => {
			this.notificationQueued = false;
			for (const record of [...this.listeners]) if (this.listeners.has(record)) this.notifyOne(record.listener);
		});
	}
	/** Deliver one change notification, containing a synchronous throw or a rejected promise. */
	notifyOne(listener) {
		let returned;
		try {
			returned = listener();
		} catch (error) {
			this.ctx.logger.warn(`tui-prompt change listener threw: ${errorChain(error)}`);
			return;
		}
		Promise.resolve(returned).catch((error) => {
			this.ctx.logger.warn(`tui-prompt change listener rejected: ${errorChain(error)}`);
		});
	}
};
//#endregion
//#region src/components/text.ts
/**
* Terminal text sanitization shared across the pi-tui front door. External text
* (model output, tool results, clipboard) is escaped or stripped of C0/C1
* controls before the TUI adds its own application-owned ANSI.
* @module @deepseek-ai/dsh-tui/components/text
*/
const TERMINAL_CONTROL_PATTERN = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/gu;
const TERMINAL_OSC_PATTERN = /(?:\u001B\]|\u009D)(?:(?!\u0007|\u001B\\)[\s\S])*(?:\u0007|\u001B\\|$)/gu;
const TERMINAL_CSI_PATTERN = /(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/gu;
const TERMINAL_ESCAPE_PATTERN = /\u001B[@-_]/gu;
/** Bracketed-paste start marker emitted by terminals around pasted content. */
const BRACKETED_PASTE_START = "\x1B[200~";
/** Bracketed-paste end marker emitted by terminals around pasted content. */
const BRACKETED_PASTE_END = "\x1B[201~";
/**
* Escape external C0/C1 controls before pi-tui adds application-owned ANSI.
* Line feeds remain structural so transcript and tool output retain their layout.
* @param text - Untrusted text to render.
* @returns The text with control characters escaped as `\xNN`.
*/
function displayText(text) {
	return text.replace(TERMINAL_CONTROL_PATTERN, (control) => `\\x${control.charCodeAt(0).toString(16).padStart(2, "0")}`);
}
/**
* Escape external controls for terminal fields that must remain on one line.
* @param text - Untrusted text to render inline.
* @returns The escaped text with newlines rendered as `\x0a`.
*/
function displayInlineText(text) {
	return displayText(text).replaceAll("\n", "\\x0a");
}
/**
* Remove terminal controls from clipboard text before an editable field stores it.
* @param text - Raw pasted clipboard text.
* @returns The text stripped of OSC, CSI, escape, and control sequences.
*/
function sanitizePastedText(text) {
	return text.replace(TERMINAL_OSC_PATTERN, "").replace(TERMINAL_CSI_PATTERN, "").replace(TERMINAL_ESCAPE_PATTERN, "").replace(TERMINAL_CONTROL_PATTERN, "");
}
//#endregion
//#region src/i18n/messages.ts
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
const EN_MESSAGES = {
	"command.help.description": "Show keyboard shortcuts and commands",
	"command.hotkeys.description": "Show the keyboard shortcuts alone",
	"command.model.description": "Switch the model and save it as your default",
	"command.preset.description": "Show, switch, or copy this session's agent preset",
	"command.copy.description": "Copy the last answer to the system clipboard",
	"command.new.description": "Start a blank session in this workspace (this one stays resumable)",
	"command.clear.description": "Clear the transcript view (session history is unchanged)",
	"command.config.description": "Change this terminal's settings, saved for your next session",
	"command.theme.description": "Pick the palette this terminal paints with",
	"command.palette.description": "Show every color and attribute role this terminal renders",
	"command.export.description": "Write this session's log to a file and report the path",
	"command.plugins.description": "Search and inspect the Loader's plugin entries",
	"command.reload.description": "EXPERIMENTAL (dev): re-read loader config files and apply the diff (idle only)",
	"command.rewind.description": "Go back to an earlier prompt in this session (files are never restored)",
	"command.resume.description": "List this workspace's resumable sessions",
	"command.status.description": "Show session diagnostics, system prompt, and registered tools",
	"command.exit.description": "Exit after the active turn reaches idle",
	"command.quit.description": "Exit after the active turn reaches idle",
	"command.lang.description": "Show or switch the interface language",
	"command.skills.description": "Search this session's skills and read one in full",
	"command.mcp.description": "Show the MCP servers this agent's tools come from",
	"command.doctor.description": "Check the runtime, terminal, model route, and mounted services",
	"command.search.description": "Search this session's messages",
	"lang.name.en": "English",
	"lang.name.zh": "中文",
	"lang.active": "current",
	"lang.current": "Language: {name} ({id}). Available: {options}.",
	"lang.switched": "Language switched to {name} ({id}).",
	"lang.unchanged": "Language is already {name} ({id}).",
	"lang.unknown": "Unknown language \"{value}\". Available: {options}.",
	"lang.saveFailed": "Language could not be saved for the next session: {error}",
	"hotkeys.editor": "Enter send • Shift/Alt+Enter newline • Up/Down prompt history • Tab accept a completion",
	"hotkeys.entry": "@ reference a file • / run a command • /skill:<name> load a skill • ? this list",
	"hotkeys.history": "{search} search prompt history backwards • {transcript} search this session's messages",
	"hotkeys.cards": "{cycle} cycle tool cards (preview/full/hidden) • {thinking} show or hide thinking blocks",
	"hotkeys.modes": "{mode} cycle mode: normal → auto-accept → plan (danger-full-access stays a /permission switch)",
	"hotkeys.copy": "{todos} expand or collapse the plan • {copy} copy the last answer • {redraw} redraw",
	"hotkeys.cancel": "{cancel} cancel the turn; again on a draft clears it; again on an empty prompt opens Rewind",
	"hotkeys.exit": "{exit} exit on an empty prompt • Shift+Ctrl+D session debug panel",
	"hotkeys.interrupt": "Ctrl+C cancel while running; clear input while typing; twice to exit while idle",
	"hotkeys.interruptAgain": "Ctrl+C again on a turn that will not cancel exits without waiting for it",
	"hotkeys.panel": "In a panel: ↑/↓ scroll • PgUp/PgDn page • g/G top or bottom • Esc close",
	"hotkeys.question": "In a question: ↑/↓ move • Space multi-select • {custom} • Enter confirm • Esc cancel",
	"hotkeys.approval": "In an approval: ↑/↓ move • 1-4 answer straight away • Enter confirm • Esc deny",
	"help.skill": "/skill:<name> [instructions] — load a skill into the conversation",
	"panel.hint": "↑↓ scroll · esc close",
	"panel.position": "{first}–{last} of {total}",
	"panel.escClose": "esc close",
	"plugins.unavailable": "Plugin inventory is not mounted. Add @deepseek-ai/dsh-host-plugin-inventory to this profile to list Loader entries.",
	"plugins.empty": "The Loader reports no plugin entries.",
	"plugins.noMatch": "No entries match the filter.",
	"plugins.hint": "type to filter · ↑↓ move · enter details · esc close",
	"plugins.filter": "filter:",
	"plugins.count.one": "{visible}/{total} entry · {active} active",
	"plugins.count.other": "{visible}/{total} entries · {active} active",
	"skills.unavailable": "Skills are not available in this session.",
	"skills.loading": "Loading skills…",
	"skills.empty": "This session composes no skills.",
	"skills.noMatch": "No skills match the filter.",
	"skills.filter": "filter:",
	"skills.hint": "type to filter · ↑↓ move · enter details · esc close",
	"skills.count.one": "{visible}/{total} skill · {invocable} user invocable",
	"skills.count.other": "{visible}/{total} skills · {invocable} user invocable",
	"skills.modelOnly": "model only",
	"skills.userInvocable": "user invocable",
	"skills.detailLoading": "Loading skill…",
	"skills.detailHint": "↑↓ scroll · esc back",
	"skills.truncated": "… showing the first {max} of {total} lines.",
	"skills.truncatedPath": "… showing the first {max} of {total} lines. Full text: {path}",
	"skills.unknown": "Unknown skill: {name}",
	"skills.notUserInvocable": "Skill \"{name}\" is not available for user invocation.",
	"skills.loadFailed": "Skill \"{name}\" failed to load: {error}",
	"skills.scanFailed": "Skill scan failed: {error}",
	"search.empty": "This session has no messages to search yet.",
	"search.noMatch": "No message matches this search.",
	"search.query": "search",
	"search.hint": "type to search · ↑↓ move · enter open · esc close",
	"search.detailHint": "↑↓ scroll · PgUp/PgDn page · esc back",
	"search.count.one": "{visible}/{total} message",
	"search.count.other": "{visible}/{total} messages",
	"search.detail.whole": "the whole message",
	"search.detail.hits": "hits for \"{query}\" are highlighted",
	"search.role.user": "You",
	"search.role.assistant": "Assistant",
	"search.role.tool": "Tool",
	"search.role.notice": "Notice",
	"search.role.context": "Context",
	"search.role.reference": "Sessions",
	"search.role.compaction": "Compacted",
	"mcp.servers.one": "{count} server",
	"mcp.servers.other": "{count} servers",
	"mcp.tools.one": "{count} tool",
	"mcp.tools.other": "{count} tools",
	"mcp.summary": "{servers} · {tools}",
	"mcp.serverRow": "({tools})",
	"mcp.empty.headline": "No MCP tools are registered for this agent.",
	"mcp.empty.howto": "MCP servers reach the model through @deepseek-ai/dsh-mcp-client, one plugin\ninstance per server. Install it and add a row to this profile's bundle:",
	"mcp.empty.transport": "transport is \"stdio\" (command, args, env, cwd) or \"streamable-http\" (url,\nheaders). Every tool the server advertises is then registered as\nmcp__<serverName>__<rawName>, and this panel lists it.",
	"doctor.flash.running": "Running environment checks…",
	"doctor.healthy": "Everything this terminal depends on is in place.",
	"doctor.summary.failed": "{count} failed",
	"doctor.summary.warned": "{count} to look at",
	"doctor.label.node": "Node",
	"doctor.label.terminal": "Terminal",
	"doctor.label.screen": "Screen",
	"doctor.label.color": "Color",
	"doctor.label.model": "Model",
	"doctor.label.persistence": "Persistence",
	"doctor.label.preset": "Preset",
	"doctor.node.advice": "this bundle is published for Node {range}; older runtimes miss APIs it calls unguarded",
	"doctor.terminal.pass": "stdin and stdout are both TTYs",
	"doctor.terminal.failOne": "{end} is not a TTY",
	"doctor.terminal.failBoth": "stdin and stdout are not a TTY",
	"doctor.terminal.advice": "keys and redraws need a terminal on both ends; for pipes use --print, which runs one task with no UI",
	"doctor.screen.narrowAdvice": "below {columns} columns tool cards, diffs, and panels wrap; widen the window",
	"doctor.screen.shortAdvice": "below {rows} rows a panel leaves no room for the editor; make the window taller",
	"doctor.color.disabled": "disabled; this screen emits no color at all",
	"doctor.color.disabledAdvice": "every surface renders as plain text; run /theme to pick a palette, or set theme.color if the deployment turned it off",
	"doctor.color.basic": "16-color palette",
	"doctor.color.truecolor": "16-color palette, truecolor brand art",
	"doctor.model.noProvider": "no LLM provider is registered",
	"doctor.model.noProviderAdvice": "the profile mounts no adapter row, or none of them activated; check the bundle and its credentials",
	"doctor.model.noRoute": "no model selected (providers: {providers})",
	"doctor.model.noRouteAdvice": "pick one with /model, or pass --model provider/model on the command line",
	"doctor.model.resolves": "{route} resolves (providers: {providers})",
	"doctor.model.noAdapter": "{route} has no registered adapter",
	"doctor.model.noAdapterAdvice": "no adapter answers for \"{provider}\"; mount its plugin row, or switch with /model",
	"doctor.model.failed": "{route} did not resolve: {error}",
	"doctor.model.failedAdvice": "the adapter is registered but rejected the lookup; check the provider's credentials and base URL",
	"doctor.persistence.mounted": "sessionPersistence is mounted",
	"doctor.persistence.missing": "sessionPersistence is not mounted",
	"doctor.persistence.advice": "this session lives in memory only: it cannot be resumed after exit, and /export re-serializes what is still in RAM",
	"doctor.preset.noRoster": "no agent-preset roster is mounted",
	"doctor.preset.noRosterAdvice": "the shipped bundle patch mounts agentPresets; without it /preset lists nothing and every session runs one fixed agent plane",
	"doctor.preset.unjoined": "the roster is mounted but this session names no preset",
	"doctor.preset.unjoinedAdvice": "the session was opened without joining a preset; start a new one with /new, or select one with /preset",
	"rewind.title": "Rewind",
	"rewind.empty": "Nothing to rewind to yet.",
	"rewind.fork": "Fork the conversation to the point before…",
	"rewind.reuse": "Bring an earlier prompt back to the editor…",
	"rewind.files": "Files are never restored — dsh keeps no file checkpoints.",
	"rewind.hint": "↑/↓ navigate · enter rewind · esc close",
	"history.label": "search prompts",
	"history.noMatch": "no matching prompt",
	"history.empty": "(type to search your prompt history)",
	"history.hint": "ctrl+r older · enter send · tab/esc accept · ctrl+c cancel",
	"approval.title": "Permission required",
	"approval.allowOnce": "Yes, allow once",
	"approval.allowSession": "Yes, and don't ask again for {tool} this session",
	"approval.rejectWithFeedback": "No, and tell the agent what to do differently",
	"approval.reject": "No, reject",
	"approval.feedbackPrompt": "Tell the agent what to do differently:",
	"approval.feedbackHint": "Enter reject with this feedback • Esc back to the answers",
	"dialog.model.title": "Select model",
	"dialog.model.noMatch": "No models match the filter",
	"dialog.model.noFocus": "No model focused",
	"dialog.model.effortUnsupported": "Reasoning effort not supported",
	"dialog.model.effortUnsupportedFor": "Reasoning effort not supported for {model}",
	"dialog.model.providerDefault": "Provider default",
	"dialog.model.effortRow": "{effort} effort",
	"dialog.model.effortDefault": "(default)",
	"dialog.model.adjust": "←/→ to adjust",
	"dialog.model.hintMove": "type to filter • ↑/↓ move • ←/→ reasoning effort",
	"dialog.model.hintCommit": "Enter save as default • Ctrl+S this session only • Esc cancel",
	"dialog.preset.title": "Select agent preset",
	"dialog.preset.noMatch": "No presets match the filter",
	"dialog.preset.hint": "type to filter • ↑/↓ move • Enter select • Esc",
	"settings.hint": "↑↓ move · enter change · esc close",
	"settings.thinking": "Thinking display",
	"settings.toolCards": "Tool cards default",
	"settings.theme": "Theme",
	"settings.language": "Language",
	"settings.model": "Model",
	"settings.model.unset": "unset",
	"settings.on": "on",
	"settings.off": "off",
	"settings.saveFailed": "Setting could not be saved: {error}",
	"settings.refused": "Stored terminal settings were refused; this session uses the defaults: {error}",
	"dialog.theme.title": "Select theme",
	"dialog.theme.hint": "↑/↓ preview • Enter select • Esc cancel",
	"theme.description.auto": "Follow the color scheme the terminal reports",
	"theme.description.light": "Always paint the light-background palette",
	"theme.description.dark": "Always paint the dark-background palette",
	"theme.description.no-color": "Emit no color at all",
	"theme.applied": "Theme: {theme}.",
	"theme.unknown": "Unknown theme \"{value}\". Usage: /theme [{options}]",
	"dialog.resume.title": "Resume session",
	"dialog.resume.titleCounted": "Resume session ({position} of {total})",
	"dialog.resume.loading": "Loading sessions…",
	"dialog.resume.noMatch": "No matching sessions.",
	"dialog.resume.noOthers": "No other session to resume.",
	"dialog.resume.stillLoading": "Sessions are still loading.",
	"dialog.resume.noSessionMatch": "No session matches this search.",
	"dialog.resume.scopeWorkspace": "this workspace {label}",
	"dialog.resume.scopeWorkspaceCount": "this workspace ({count})",
	"dialog.resume.scopeAll": "all workspaces ({count})",
	"dialog.resume.workspaceRow": "workspace {label}",
	"dialog.resume.unavailable": "unavailable: {reason}",
	"dialog.resume.hint": "Type to search  •  ↑/↓ navigate  •  Tab scope  •  Enter resume  •  Esc clear/cancel",
	"dialog.resume.searchPlaceholder": "Search…",
	"dialog.resume.ageJustNow": "just now",
	"dialog.resume.ageMinutes.one": "{count} minute ago",
	"dialog.resume.ageMinutes.other": "{count} minutes ago",
	"dialog.resume.ageHours.one": "{count} hour ago",
	"dialog.resume.ageHours.other": "{count} hours ago",
	"dialog.resume.ageDays.one": "{count} day ago",
	"dialog.resume.ageDays.other": "{count} days ago",
	"exit.resumeHint": "Resume this session: {command}",
	"dialog.question.header": "Question {position}/{total} ({unanswered} unanswered)",
	"dialog.question.selectOne": "Select at least one option, or press {keys} for a custom answer.",
	"dialog.question.emptyAnswer": "Enter an answer before submitting.",
	"dialog.question.selectedCount": "{count} selected",
	"dialog.question.customAnswer": "{keys} custom answer",
	"dialog.question.navigate": "↑/↓ navigate",
	"dialog.question.spaceToggle": "Space toggle",
	"dialog.question.submit": "Enter submit",
	"dialog.question.escOptions": "Esc options",
	"dialog.question.escCancel": "Esc cancel",
	"dialog.question.escInterrupt": "Esc interrupt",
	"dialog.question.moreAbove": "↑ {count} more",
	"dialog.question.moreBelow": "↓ {count} more",
	"dialog.question.error": "Error: {message}",
	"dialog.question.linesHidden": "↑ {count} lines hidden",
	"prompt.modelUnset": "model unset",
	"prompt.cache": "cache {rate}%",
	"prompt.context": "{percent}% context",
	"prompt.compacting": "Context being compacted {duration}",
	"prompt.queued": "{count} queued",
	"collapse.thinking.active": "thinking for {duration}",
	"collapse.thinking.settled": "thought for {duration}",
	"collapse.search.active.one": "searching for {count} pattern",
	"collapse.search.active.other": "searching for {count} patterns",
	"collapse.search.settled.one": "searched for {count} pattern",
	"collapse.search.settled.other": "searched for {count} patterns",
	"collapse.read.active.one": "reading {count} file",
	"collapse.read.active.other": "reading {count} files",
	"collapse.read.settled.one": "read {count} file",
	"collapse.read.settled.other": "read {count} files",
	"collapse.list.active.one": "listing {count} directory",
	"collapse.list.active.other": "listing {count} directories",
	"collapse.list.settled.one": "listed {count} directory",
	"collapse.list.settled.other": "listed {count} directories",
	"collapse.mcp.active.one": "querying {server}",
	"collapse.mcp.active.other": "querying {server} {count} times",
	"collapse.mcp.settled.one": "queried {server}",
	"collapse.mcp.settled.other": "queried {server} {count} times",
	"collapse.separator": ", ",
	"collapse.ellipsis": "…",
	"collapse.expandHint": "({key} to expand)",
	"status.flash.cardsHidden": "Tool cards hidden.",
	"status.flash.cardsExpanded": "Tool and context cards expanded.",
	"status.flash.cardsCollapsed": "Tool cards collapsed; reads grouped, context hidden.",
	"status.flash.thinkingPinned": "Thinking blocks kept on screen.",
	"status.flash.thinkingUnpinned": "Thinking blocks hidden once a step finishes.",
	"status.flash.thinkingDisabled": "Thinking blocks are off in this configuration (showReasoning: false).",
	"status.flash.planEmpty": "No plan in this session yet.",
	"status.flash.planExpanded": "Plan expanded.",
	"status.flash.planCollapsed": "Plan collapsed.",
	"status.flash.modeNormal": "Mode: normal — the workspace sandbox, approval asked for anything wider.",
	"status.flash.modeAutoAccept": "Mode: auto-accept — tool calls run without asking, inside the workspace sandbox.",
	"status.flash.modePlan": "Mode: plan — explore and design; the agent presents a plan instead of carrying it out.",
	"status.flash.modePlanQueued": "Mode: plan — applied from the next step of this turn.",
	"status.flash.modePlanOff": "Plan mode off; the permission preset is unchanged.",
	"status.flash.modeUnavailable": "Nothing to cycle in this deployment: no auto-accept preset, and no plan mode.",
	"status.flash.modeFailed": "Mode switch failed: {error}",
	"status.flash.escDraft": "Press esc again to clear the draft.",
	"status.flash.escRewind": "Press esc again to rewind to an earlier prompt.",
	"status.flash.exitAgain": "Press ctrl+c again to exit.",
	"status.flash.exitWithoutTurn": "Press ctrl+c again to exit without waiting for the turn.",
	"status.flash.cancelBeforeExit": "Cancel the active turn before exiting.",
	"status.flash.cancellingBeforeExit": "Cancelling the active turn before exit…",
	"status.flash.collecting": "Collecting session status…",
	"status.flash.draftBlocksExit": "Draft in the editor — clear it with ctrl+c to exit.",
	"status.flash.historyEmpty": "No prompt history in this session yet.",
	"status.flash.queuedForSkill": "Queued until the startup skill has been sent.",
	"status.flash.nothingToCopy": "Nothing to copy yet.",
	"status.flash.copied": "Copied {count} chars to clipboard.",
	"status.flash.copiedTmux": "Copied to tmux buffer (prefix+] to paste).",
	"status.flash.copiedOsc52": "Sent to clipboard via OSC 52.",
	"status.card.title": "Session status",
	"status.row.session": "Session",
	"status.row.title": "Title",
	"status.row.directory": "Directory",
	"status.row.model": "Model",
	"status.row.preset": "Preset",
	"status.row.permission": "Permission",
	"status.row.agent": "Agent",
	"status.row.goal": "Goal",
	"status.row.goalState": "Goal state",
	"status.row.sessionTotals": "Session totals",
	"status.row.tokens": "Tokens",
	"status.row.kvCache": "KV cache",
	"status.row.context": "Context",
	"status.row.created": "Created",
	"status.row.active": "Active",
	"status.untitled": "untitled",
	"status.modelDetail": "(effort {effort}; thinking blocks {thinking})",
	"status.tokensValue": "{input} input + {output} output",
	"status.cacheValue": "{meter} {rate}% hit ({read} read + {write} write)",
	"status.cacheUnavailable": "n/a ({read} read + {write} write)",
	"status.contextValue": "{meter} {percent}% used ({used} / {capacity})",
	"status.contextUnknown": "{used} used · capacity unknown",
	"status.systemPrompt": "System prompt",
	"status.registeredTools": "Registered tools",
	"status.thinking.disabled": "disabled",
	"status.thinking.kept": "kept",
	"status.thinking.live": "while streaming",
	"status.effort.default": "default",
	"status.count.event.one": "{count} event",
	"status.count.event.other": "{count} events",
	"status.count.turn.one": "{count} turn",
	"status.count.turn.other": "{count} turns",
	"status.count.step.one": "{count} step",
	"status.count.step.other": "{count} steps",
	"status.count.toolCall.one": "{count} tool call",
	"status.count.toolCall.other": "{count} tool calls",
	"status.totals.model": "model {duration}",
	"status.totals.tools": "tools {duration}",
	"status.totals.ttft": "ttft {duration} avg",
	"status.totals.decode": "{rate} tok/s decode",
	"notice.unknownCommand": "Unknown command: {text}",
	"notice.commandFailed": "Command failed: {error}",
	"notice.markdownDegraded": "Markdown rendering degraded; using the fallback renderer for the rest of this session.",
	"notice.copyFailed": "Copy failed: {error}",
	"notice.overlayFailed": "TUI overlay failed: {error}",
	"notice.newSession": "Starting a blank session. This one keeps its history — /resume brings it back.",
	"notice.newSessionFailed": "Could not start a new session: {error}",
	"notice.disposedRecovery": "Run /resume to open another session, or press {exit} to exit.",
	"notice.agentDisposed": "Agent \"{id}\" is disposed. {recovery}",
	"notice.agentDisposedTurn": "Agent \"{id}\" was disposed; this session can no longer run a turn. {recovery}",
	"notice.skillUsage": "Usage: /skill:<name> [instructions]",
	"notice.referenceInvalid": "Invalid session reference: {error}",
	"notice.referenceUnavailable": "Session reference capability unavailable.",
	"notice.referenceFailed": "Session reference failed: {error}",
	"notice.newSessionUnsupported": "This runtime cannot open a new session in place. Exit and start dsh again for a blank session.",
	"notice.newSessionBusy": "A new session needs an idle agent (status: {status}).",
	"notice.rewindNoFork": "Rewind put that prompt back in the editor. This runtime cannot fork a session, so the conversation above it is unchanged.",
	"notice.rewindNoTurn": "Rewind put that prompt back in the editor. No completed turn precedes it, so there was nothing to fork to.",
	"notice.rewindBusy": "Cancel the active turn before rewinding.",
	"notice.rewindForking": "Forking this session to the point before that prompt; the original stays resumable.",
	"notice.rewindFailed": "Rewind failed: {error}",
	"notice.reloadBusyAgent": "/reload requires an idle agent (status: {status}).",
	"notice.reloadRunning": "A config reload is already running.",
	"notice.reloadNoLoader": "/reload needs the cordis Loader; this runtime has none.",
	"notice.reloadStarted": "Reloading {count} config tree(s)… (experimental)",
	"notice.reloadDone": "Config reload complete. Unchanged files were skipped; invalid files keep the running tree (see logs).",
	"notice.reloadFailed": "Config reload failed: {error}",
	"notice.referencedSessions": "Referenced sessions · {labels}",
	"transcript.compactionMarker": "… earlier context was compacted …",
	"transcript.steeringBadge": "Steering",
	"transcript.planModeBadge": "plan mode on",
	"transcript.autoAcceptBadge": "auto-accept on",
	"transcript.modeCycleHint": "({key} to cycle)",
	"transcript.xmlOmitted.one": "… +{count} line ({key} to expand)",
	"transcript.xmlOmitted.other": "… +{count} lines ({key} to expand)",
	"banner.resumed": "resumed {id}",
	"export.overwrite.question": "{path} already exists. Replace it?",
	"export.overwrite.replace": "Replace the file",
	"export.overwrite.keep": "Keep it",
	"settings.toolCards.collapsed": "collapsed",
	"settings.toolCards.expanded": "expanded",
	"settings.toolCards.hidden": "hidden"
};
/**
* The Chinese table.
*
* Product vocabulary the harness itself does not translate stays in English —
* `preset`, `skill`, `plugin`, `token`, `Loader`, key names — because those are
* what the config files, the docs, and the other clients call them; a row that
* translated them would leave the reader guessing which knob it meant.
*/
const ZH_MESSAGES = {
	"command.help.description": "显示快捷键与命令列表",
	"command.hotkeys.description": "只显示快捷键",
	"command.model.description": "切换模型，并保存为默认模型",
	"command.preset.description": "查看、切换或复制本会话的 agent preset",
	"command.copy.description": "把最后一条回答复制到系统剪贴板",
	"command.new.description": "在当前工作区开一个空会话（当前会话仍可 resume）",
	"command.clear.description": "清空 transcript 视图（不影响会话历史）",
	"command.config.description": "修改本终端自己的设置，下次启动仍然生效",
	"command.theme.description": "选择本终端使用的配色",
	"command.palette.description": "展示本终端渲染的全部配色与文字属性",
	"command.export.description": "把本会话日志写入文件并给出路径",
	"command.plugins.description": "搜索并查看 Loader 的 plugin 条目",
	"command.reload.description": "EXPERIMENTAL（开发用）：重读 loader 配置并应用差异（仅空闲时）",
	"command.rewind.description": "回到本会话更早的一次提问（不会恢复文件）",
	"command.resume.description": "列出当前工作区可恢复的会话",
	"command.status.description": "显示会话诊断信息、system prompt 与已注册工具",
	"command.exit.description": "等当前轮次结束后退出",
	"command.quit.description": "等当前轮次结束后退出",
	"command.lang.description": "查看或切换界面语言",
	"command.skills.description": "搜索本会话的 skill，并查看某个 skill 的完整正文",
	"command.mcp.description": "显示本 agent 的工具分别来自哪些 MCP server",
	"command.doctor.description": "检查运行时、终端、模型路由与已挂载的服务",
	"command.search.description": "搜索本会话的消息",
	"lang.name.en": "English",
	"lang.name.zh": "中文",
	"lang.active": "当前",
	"lang.current": "当前语言：{name}（{id}）。可选：{options}。",
	"lang.switched": "语言已切换为 {name}（{id}）。",
	"lang.unchanged": "当前语言已经是 {name}（{id}）。",
	"lang.unknown": "无法识别的语言 \"{value}\"。可选：{options}。",
	"lang.saveFailed": "语言设置未能保存，下次启动仍是原来的语言：{error}",
	"hotkeys.editor": "Enter 发送 • Shift/Alt+Enter 换行 • Up/Down 翻历史提问 • Tab 采纳补全",
	"hotkeys.entry": "@ 引用文件 • / 执行命令 • /skill:<name> 加载 skill • ? 打开本列表",
	"hotkeys.history": "{search} 向前搜索历史提问 • {transcript} 搜索本次会话的消息",
	"hotkeys.cards": "{cycle} 切换工具卡片（预览/完整/隐藏） • {thinking} 显示或隐藏思考块",
	"hotkeys.modes": "{mode} 循环切换模式：normal → auto-accept → plan（danger-full-access 只能用 /permission 切）",
	"hotkeys.copy": "{todos} 展开或收起计划 • {copy} 复制最后一条回答 • {redraw} 重绘屏幕",
	"hotkeys.cancel": "{cancel} 取消当前轮次；草稿状态下再按一次清空草稿；空输入时再按一次打开 Rewind",
	"hotkeys.exit": "{exit} 空输入时退出 • Shift+Ctrl+D 打开会话调试面板",
	"hotkeys.interrupt": "Ctrl+C 运行中取消；输入中清空输入；空闲时连按两次退出",
	"hotkeys.interruptAgain": "对取消不掉的轮次再按一次 Ctrl+C，会直接退出而不再等它",
	"hotkeys.panel": "面板内：↑/↓ 滚动 • PgUp/PgDn 翻页 • g/G 跳到首尾 • Esc 关闭",
	"hotkeys.question": "提问框内：↑/↓ 移动 • Space 多选 • {custom} • Enter 确认 • Esc 取消",
	"hotkeys.approval": "授权框内：↑/↓ 移动 • 1-4 直接作答 • Enter 确认 • Esc 拒绝",
	"help.skill": "/skill:<name> [instructions] — 把一个 skill 加载进对话",
	"panel.hint": "↑↓ 滚动 · esc 关闭",
	"panel.position": "第 {first}–{last} 行，共 {total} 行",
	"panel.escClose": "esc 关闭",
	"plugins.unavailable": "未挂载 plugin inventory。在本 profile 中加入 @deepseek-ai/dsh-host-plugin-inventory 才能列出 Loader 条目。",
	"plugins.empty": "Loader 没有报告任何 plugin 条目。",
	"plugins.noMatch": "没有条目匹配当前筛选。",
	"plugins.hint": "输入以筛选 · ↑↓ 移动 · enter 查看详情 · esc 关闭",
	"plugins.filter": "筛选：",
	"plugins.count.one": "{visible}/{total} 个条目 · {active} 个运行中",
	"plugins.count.other": "{visible}/{total} 个条目 · {active} 个运行中",
	"skills.unavailable": "本会话没有可用的 skill。",
	"skills.loading": "正在加载 skill 列表…",
	"skills.empty": "本会话没有组合任何 skill。",
	"skills.noMatch": "没有 skill 匹配当前筛选。",
	"skills.filter": "筛选：",
	"skills.hint": "输入以筛选 · ↑↓ 移动 · enter 查看详情 · esc 关闭",
	"skills.count.one": "{visible}/{total} 个 skill · {invocable} 个用户可调用",
	"skills.count.other": "{visible}/{total} 个 skill · {invocable} 个用户可调用",
	"skills.modelOnly": "仅模型可调用",
	"skills.userInvocable": "用户可调用",
	"skills.detailLoading": "正在加载 skill 正文…",
	"skills.detailHint": "↑↓ 滚动 · esc 返回",
	"skills.truncated": "… 只显示前 {max} 行，共 {total} 行。",
	"skills.truncatedPath": "… 只显示前 {max} 行，共 {total} 行。完整正文：{path}",
	"skills.unknown": "找不到名为 {name} 的 skill",
	"skills.notUserInvocable": "skill \"{name}\" 不支持用户直接调用。",
	"skills.loadFailed": "skill \"{name}\" 加载失败：{error}",
	"skills.scanFailed": "skill 扫描失败：{error}",
	"search.empty": "本会话还没有可搜索的消息。",
	"search.noMatch": "没有消息匹配这次搜索。",
	"search.query": "搜索",
	"search.hint": "输入以搜索 · ↑↓ 移动 · enter 展开 · esc 关闭",
	"search.detailHint": "↑↓ 滚动 · PgUp/PgDn 翻页 · esc 返回",
	"search.count.one": "{visible}/{total} 条消息",
	"search.count.other": "{visible}/{total} 条消息",
	"search.detail.whole": "完整消息",
	"search.detail.hits": "“{query}”的命中处已高亮",
	"search.role.user": "你",
	"search.role.assistant": "助手",
	"search.role.tool": "工具",
	"search.role.notice": "提示",
	"search.role.context": "上下文",
	"search.role.reference": "引用的会话",
	"search.role.compaction": "已压缩",
	"mcp.servers.one": "{count} 个 server",
	"mcp.servers.other": "{count} 个 server",
	"mcp.tools.one": "{count} 个工具",
	"mcp.tools.other": "{count} 个工具",
	"mcp.summary": "{servers} · {tools}",
	"mcp.serverRow": "（{tools}）",
	"mcp.empty.headline": "本 agent 没有注册任何 MCP 工具。",
	"mcp.empty.howto": "MCP server 通过 @deepseek-ai/dsh-mcp-client 接入模型，一个 server 对应一个 plugin\n实例。安装它，并在本 profile 的 bundle 里加一行：",
	"mcp.empty.transport": "transport 取 \"stdio\"（command、args、env、cwd）或 \"streamable-http\"（url、\nheaders）。server 声明的每个工具都会以 mcp__<serverName>__<rawName> 注册，\n然后出现在这个面板里。",
	"doctor.flash.running": "正在做环境检查…",
	"doctor.healthy": "本终端依赖的东西都到位了。",
	"doctor.summary.failed": "{count} 项失败",
	"doctor.summary.warned": "{count} 项需要留意",
	"doctor.label.node": "Node",
	"doctor.label.terminal": "终端",
	"doctor.label.screen": "窗口",
	"doctor.label.color": "配色",
	"doctor.label.model": "模型",
	"doctor.label.persistence": "持久化",
	"doctor.label.preset": "Preset",
	"doctor.node.advice": "本 bundle 面向 Node {range} 发布；更老的运行时缺少它直接调用的 API",
	"doctor.terminal.pass": "stdin 与 stdout 都是 TTY",
	"doctor.terminal.failOne": "{end} 不是 TTY",
	"doctor.terminal.failBoth": "stdin 与 stdout 都不是 TTY",
	"doctor.terminal.advice": "按键与重绘要求两端都是终端；走管道请用 --print，它跑一次任务、不启动 UI",
	"doctor.screen.narrowAdvice": "窄于 {columns} 列时工具卡片、diff 和面板都会折行；把窗口拉宽",
	"doctor.screen.shortAdvice": "少于 {rows} 行时面板会挤掉输入框；把窗口拉高",
	"doctor.color.disabled": "已关闭；当前屏幕完全不输出颜色",
	"doctor.color.disabledAdvice": "所有界面都会渲染成纯文本；用 /theme 选一个配色，或在部署关掉了颜色时打开 theme.color",
	"doctor.color.basic": "16 色配色",
	"doctor.color.truecolor": "16 色配色，品牌图形用 truecolor",
	"doctor.model.noProvider": "没有注册任何 LLM provider",
	"doctor.model.noProviderAdvice": "profile 里没有 adapter 行，或者它们都没激活；检查 bundle 与其凭据",
	"doctor.model.noRoute": "未选择模型（provider：{providers}）",
	"doctor.model.noRouteAdvice": "用 /model 选一个，或在命令行传 --model provider/model",
	"doctor.model.resolves": "{route} 可解析（provider：{providers}）",
	"doctor.model.noAdapter": "{route} 没有对应的 adapter",
	"doctor.model.noAdapterAdvice": "没有 adapter 负责 \"{provider}\"；挂上它的 plugin 行，或用 /model 换一个",
	"doctor.model.failed": "{route} 解析失败：{error}",
	"doctor.model.failedAdvice": "adapter 已注册但拒绝了这次查询；检查该 provider 的凭据与 base URL",
	"doctor.persistence.mounted": "已挂载 sessionPersistence",
	"doctor.persistence.missing": "未挂载 sessionPersistence",
	"doctor.persistence.advice": "本会话只存在于内存中：退出后无法 resume，/export 导出的也只是还在内存里的内容",
	"doctor.preset.noRoster": "未挂载 agent preset 名册",
	"doctor.preset.noRosterAdvice": "随包的 bundle patch 会挂载 agentPresets；没有它，/preset 列不出任何东西，每个会话都跑同一个固定的 agent plane",
	"doctor.preset.unjoined": "名册已挂载，但本会话没有指定 preset",
	"doctor.preset.unjoinedAdvice": "这个会话开启时没有加入任何 preset；用 /new 开一个新会话，或用 /preset 选一个",
	"rewind.title": "Rewind",
	"rewind.empty": "还没有可以回退到的提问。",
	"rewind.fork": "从这条提问之前分叉出新的对话…",
	"rewind.reuse": "把更早的一条提问放回输入框…",
	"rewind.files": "文件不会被恢复 —— dsh 不保存文件检查点。",
	"rewind.hint": "↑/↓ 移动 · enter 回退 · esc 关闭",
	"history.label": "搜索提问",
	"history.noMatch": "没有匹配的提问",
	"history.empty": "（输入以搜索历史提问）",
	"history.hint": "ctrl+r 更早一条 · enter 发送 · tab/esc 采纳 · ctrl+c 取消",
	"approval.title": "需要授权",
	"approval.allowOnce": "同意，仅此一次",
	"approval.allowSession": "同意，本会话内不再询问 {tool}",
	"approval.rejectWithFeedback": "拒绝，并告诉 agent 该怎么做",
	"approval.reject": "拒绝",
	"approval.feedbackPrompt": "告诉 agent 该怎么做：",
	"approval.feedbackHint": "Enter 带着这段说明拒绝 • Esc 返回选项",
	"dialog.model.title": "选择模型",
	"dialog.model.noMatch": "没有模型匹配当前筛选",
	"dialog.model.noFocus": "当前没有选中的模型",
	"dialog.model.effortUnsupported": "不支持调节推理强度",
	"dialog.model.effortUnsupportedFor": "{model} 不支持调节推理强度",
	"dialog.model.providerDefault": "服务商默认",
	"dialog.model.effortRow": "推理强度 {effort}",
	"dialog.model.effortDefault": "（默认）",
	"dialog.model.adjust": "←/→ 调节",
	"dialog.model.hintMove": "输入以筛选 • ↑/↓ 移动 • ←/→ 调节推理强度",
	"dialog.model.hintCommit": "Enter 存为默认 • Ctrl+S 仅本会话 • Esc 取消",
	"dialog.preset.title": "选择 agent preset",
	"dialog.preset.noMatch": "没有 preset 匹配当前筛选",
	"dialog.preset.hint": "输入以筛选 • ↑/↓ 移动 • Enter 选择 • Esc 取消",
	"settings.hint": "↑↓ 移动 · enter 修改 · esc 关闭",
	"settings.thinking": "思考块显示",
	"settings.toolCards": "工具卡片默认形态",
	"settings.theme": "配色",
	"settings.language": "界面语言",
	"settings.model": "模型",
	"settings.model.unset": "未设置",
	"settings.on": "开",
	"settings.off": "关",
	"settings.saveFailed": "设置没能保存：{error}",
	"settings.refused": "已存的终端设置不合法，本次会话使用默认值：{error}",
	"dialog.theme.title": "选择配色",
	"dialog.theme.hint": "↑/↓ 预览 • Enter 选定 • Esc 取消",
	"theme.description.auto": "跟随终端上报的明暗",
	"theme.description.light": "固定使用浅色背景的配色",
	"theme.description.dark": "固定使用深色背景的配色",
	"theme.description.no-color": "完全不输出颜色",
	"theme.applied": "配色：{theme}。",
	"theme.unknown": "未知配色 \"{value}\"。用法：/theme [{options}]",
	"dialog.resume.title": "恢复会话",
	"dialog.resume.titleCounted": "恢复会话（第 {position} / 共 {total}）",
	"dialog.resume.loading": "正在加载会话…",
	"dialog.resume.noMatch": "没有匹配的会话。",
	"dialog.resume.noOthers": "没有其他可恢复的会话。",
	"dialog.resume.stillLoading": "会话还在加载中。",
	"dialog.resume.noSessionMatch": "没有会话匹配这次搜索。",
	"dialog.resume.scopeWorkspace": "当前工作区 {label}",
	"dialog.resume.scopeWorkspaceCount": "当前工作区（{count}）",
	"dialog.resume.scopeAll": "全部工作区（{count}）",
	"dialog.resume.workspaceRow": "工作区 {label}",
	"dialog.resume.unavailable": "不可用：{reason}",
	"dialog.resume.hint": "输入以搜索  •  ↑/↓ 移动  •  Tab 切换范围  •  Enter 恢复  •  Esc 清空/取消",
	"dialog.resume.searchPlaceholder": "搜索…",
	"dialog.resume.ageJustNow": "刚刚",
	"dialog.resume.ageMinutes.one": "{count} 分钟前",
	"dialog.resume.ageMinutes.other": "{count} 分钟前",
	"dialog.resume.ageHours.one": "{count} 小时前",
	"dialog.resume.ageHours.other": "{count} 小时前",
	"dialog.resume.ageDays.one": "{count} 天前",
	"dialog.resume.ageDays.other": "{count} 天前",
	"exit.resumeHint": "恢复本会话：{command}",
	"dialog.question.header": "第 {position}/{total} 个问题（{unanswered} 个待回答）",
	"dialog.question.selectOne": "至少选择一项，或按 {keys} 自己填写答案。",
	"dialog.question.emptyAnswer": "提交前请先填写答案。",
	"dialog.question.selectedCount": "已选 {count} 项",
	"dialog.question.customAnswer": "{keys} 自定义答案",
	"dialog.question.navigate": "↑/↓ 移动",
	"dialog.question.spaceToggle": "Space 选中",
	"dialog.question.submit": "Enter 提交",
	"dialog.question.escOptions": "Esc 返回选项",
	"dialog.question.escCancel": "Esc 取消",
	"dialog.question.escInterrupt": "Esc 中断",
	"dialog.question.moreAbove": "↑ 还有 {count} 项",
	"dialog.question.moreBelow": "↓ 还有 {count} 项",
	"dialog.question.error": "错误：{message}",
	"dialog.question.linesHidden": "↑ 还有 {count} 行未显示",
	"prompt.modelUnset": "未设置模型",
	"prompt.cache": "缓存 {rate}%",
	"prompt.context": "已用 {percent}% 上下文",
	"prompt.compacting": "正在压缩上下文 {duration}",
	"prompt.queued": "{count} 条排队中",
	"collapse.thinking.active": "正在思考 {duration}",
	"collapse.thinking.settled": "思考了 {duration}",
	"collapse.search.active.one": "正在搜索 {count} 个 pattern",
	"collapse.search.active.other": "正在搜索 {count} 个 pattern",
	"collapse.search.settled.one": "搜索了 {count} 个 pattern",
	"collapse.search.settled.other": "搜索了 {count} 个 pattern",
	"collapse.read.active.one": "正在读取 {count} 个文件",
	"collapse.read.active.other": "正在读取 {count} 个文件",
	"collapse.read.settled.one": "读取了 {count} 个文件",
	"collapse.read.settled.other": "读取了 {count} 个文件",
	"collapse.list.active.one": "正在列出 {count} 个目录",
	"collapse.list.active.other": "正在列出 {count} 个目录",
	"collapse.list.settled.one": "列出了 {count} 个目录",
	"collapse.list.settled.other": "列出了 {count} 个目录",
	"collapse.mcp.active.one": "正在查询 {server}",
	"collapse.mcp.active.other": "正在查询 {server} {count} 次",
	"collapse.mcp.settled.one": "查询了 {server}",
	"collapse.mcp.settled.other": "查询了 {server} {count} 次",
	"collapse.separator": "，",
	"collapse.expandHint": "({key} 展开)",
	"status.flash.cardsHidden": "已隐藏工具卡片。",
	"status.flash.cardsExpanded": "已展开工具与上下文卡片。",
	"status.flash.cardsCollapsed": "工具卡片已收起，只读调用已归组，上下文已隐藏。",
	"status.flash.thinkingPinned": "思考块将一直留在屏幕上。",
	"status.flash.thinkingUnpinned": "思考块会在该步结束后隐藏。",
	"status.flash.thinkingDisabled": "当前配置关闭了思考块显示（showReasoning: false）。",
	"status.flash.planEmpty": "本会话还没有计划。",
	"status.flash.planExpanded": "计划已展开。",
	"status.flash.planCollapsed": "计划已收起。",
	"status.flash.modeNormal": "模式：normal —— 在 workspace sandbox 内工作，超出范围要先征求同意。",
	"status.flash.modeAutoAccept": "模式：auto-accept —— 在 workspace sandbox 内的工具调用不再逐次询问。",
	"status.flash.modePlan": "模式：plan —— 只做调研和设计，先给方案，不直接动手。",
	"status.flash.modePlanQueued": "模式：plan —— 从本轮的下一步开始生效。",
	"status.flash.modePlanOff": "已退出 plan 模式；权限 preset 保持不变。",
	"status.flash.modeUnavailable": "当前部署没有可切换的模式：既没有 auto-accept preset，也没有 plan 模式。",
	"status.flash.modeFailed": "切换模式失败：{error}",
	"status.flash.escDraft": "再按一次 esc 清空草稿。",
	"status.flash.escRewind": "再按一次 esc 回退到更早的提问。",
	"status.flash.exitAgain": "再按一次 ctrl+c 退出。",
	"status.flash.exitWithoutTurn": "再按一次 ctrl+c 直接退出，不等当前轮次。",
	"status.flash.cancelBeforeExit": "请先取消当前轮次再退出。",
	"status.flash.cancellingBeforeExit": "正在取消当前轮次，之后退出…",
	"status.flash.collecting": "正在收集会话状态…",
	"status.flash.draftBlocksExit": "输入框里还有草稿 —— 先按 ctrl+c 清空再退出。",
	"status.flash.historyEmpty": "本会话还没有历史提问。",
	"status.flash.queuedForSkill": "已排队，等启动 skill 发送后再处理。",
	"status.flash.nothingToCopy": "还没有可复制的内容。",
	"status.flash.copied": "已复制 {count} 个字符到剪贴板。",
	"status.flash.copiedTmux": "已复制到 tmux 缓冲区（prefix+] 粘贴）。",
	"status.flash.copiedOsc52": "已通过 OSC 52 发送到剪贴板。",
	"status.card.title": "会话状态",
	"status.row.session": "会话",
	"status.row.title": "标题",
	"status.row.directory": "目录",
	"status.row.model": "模型",
	"status.row.preset": "Preset",
	"status.row.permission": "权限",
	"status.row.agent": "Agent",
	"status.row.goal": "目标",
	"status.row.goalState": "目标状态",
	"status.row.sessionTotals": "会话累计",
	"status.row.tokens": "Token",
	"status.row.kvCache": "KV 缓存",
	"status.row.context": "上下文",
	"status.row.created": "创建于",
	"status.row.active": "最近活动",
	"status.untitled": "未命名",
	"status.modelDetail": "（推理强度 {effort}；思考块 {thinking}）",
	"status.tokensValue": "输入 {input} + 输出 {output}",
	"status.cacheValue": "{meter} 命中 {rate}%（读 {read} + 写 {write}）",
	"status.cacheUnavailable": "无数据（读 {read} + 写 {write}）",
	"status.contextValue": "{meter} 已用 {percent}%（{used} / {capacity}）",
	"status.contextUnknown": "已用 {used} · 容量未知",
	"status.systemPrompt": "System prompt",
	"status.registeredTools": "已注册工具",
	"status.thinking.disabled": "已禁用",
	"status.thinking.kept": "常驻",
	"status.thinking.live": "仅流式输出时",
	"status.effort.default": "默认",
	"status.count.event.one": "{count} 个事件",
	"status.count.event.other": "{count} 个事件",
	"status.count.turn.one": "{count} 轮",
	"status.count.turn.other": "{count} 轮",
	"status.count.step.one": "{count} 步",
	"status.count.step.other": "{count} 步",
	"status.count.toolCall.one": "{count} 次工具调用",
	"status.count.toolCall.other": "{count} 次工具调用",
	"status.totals.model": "模型 {duration}",
	"status.totals.tools": "工具 {duration}",
	"status.totals.ttft": "首字 {duration} 平均",
	"status.totals.decode": "解码 {rate} tok/s",
	"notice.unknownCommand": "未知命令：{text}",
	"notice.commandFailed": "命令执行失败：{error}",
	"notice.markdownDegraded": "Markdown 渲染降级，本次会话余下部分改用后备渲染器。",
	"notice.copyFailed": "复制失败：{error}",
	"notice.overlayFailed": "TUI 浮层失败：{error}",
	"notice.newSession": "已开启一个空会话。当前会话的历史仍在，用 /resume 可以回来。",
	"notice.newSessionFailed": "没能开启新会话：{error}",
	"notice.disposedRecovery": "用 /resume 打开另一个会话，或按 {exit} 退出。",
	"notice.agentDisposed": "Agent \"{id}\" 已释放。{recovery}",
	"notice.agentDisposedTurn": "Agent \"{id}\" 已释放，本会话无法再执行任何一轮。{recovery}",
	"notice.skillUsage": "用法：/skill:<name> [instructions]",
	"notice.referenceInvalid": "会话引用不合法：{error}",
	"notice.referenceUnavailable": "当前环境不提供会话引用能力。",
	"notice.referenceFailed": "会话引用失败：{error}",
	"notice.newSessionUnsupported": "当前运行时不能就地开新会话。退出后重新启动 dsh 即可得到一个空会话。",
	"notice.newSessionBusy": "开新会话需要 agent 处于空闲状态（当前：{status}）。",
	"notice.rewindNoFork": "那条提问已经放回编辑器。当前运行时不能分叉会话，所以它上面的对话没有变化。",
	"notice.rewindNoTurn": "那条提问已经放回编辑器。它前面没有已完成的一轮，没有可以分叉的位置。",
	"notice.rewindBusy": "先取消正在执行的这一轮，再回退。",
	"notice.rewindForking": "正在从那条提问之前的位置分叉本会话；原会话仍可 resume。",
	"notice.rewindFailed": "回退失败：{error}",
	"notice.reloadBusyAgent": "/reload 需要 agent 处于空闲状态（当前：{status}）。",
	"notice.reloadRunning": "已经有一个配置重载在执行了。",
	"notice.reloadNoLoader": "/reload 需要 cordis Loader，当前运行时没有。",
	"notice.reloadStarted": "正在重载 {count} 棵配置树…（experimental）",
	"notice.reloadDone": "配置重载完成。未改动的文件已跳过；不合法的文件保持原来的运行态（详见日志）。",
	"notice.reloadFailed": "配置重载失败：{error}",
	"notice.referencedSessions": "引用的会话 · {labels}",
	"transcript.compactionMarker": "… 更早的上下文已被压缩 …",
	"transcript.steeringBadge": "插入指令",
	"transcript.planModeBadge": "plan 模式已开启",
	"transcript.autoAcceptBadge": "auto-accept 已开启",
	"transcript.modeCycleHint": "({key} 切换模式)",
	"transcript.xmlOmitted.one": "… 还有 {count} 行（{key} 展开）",
	"transcript.xmlOmitted.other": "… 还有 {count} 行（{key} 展开）",
	"banner.resumed": "已恢复 {id}",
	"export.overwrite.question": "{path} 已存在，要覆盖吗？",
	"export.overwrite.replace": "覆盖这个文件",
	"export.overwrite.keep": "保留原文件",
	"settings.toolCards.collapsed": "折叠",
	"settings.toolCards.expanded": "展开",
	"settings.toolCards.hidden": "隐藏"
};
//#endregion
//#region src/i18n/index.ts
/**
* This terminal's message layer: one process-wide locale, two message tables,
* and a lookup every rendering surface calls at render time.
*
* Deliberately tiny and dependency-free. The alternative — a real i18n runtime —
* buys plural categories and date formats this UI does not have, and costs a
* runtime dependency in a bundle that ships none.
*
* Two rules make locale switching work at all:
*
* 1. **Look up late.** {@link t} is called from `render`, from a command
*    handler, from a getter — never from a module-level `const`, which would
*    freeze the first locale into the module graph. A string captured at import
*    time survives `/lang` and lies for the rest of the process.
* 2. **Repaint after.** {@link setLocale} notifies {@link onLocaleChange}
*    observers; the TUI's observer is `requestRender`, so a switch redraws every
*    surface that is already on screen.
* @module @deepseek-ai/dsh-tui/i18n
*/
/** The locales this terminal ships, in the order `/lang` lists them. */
const LOCALE_IDS = ["en", "zh"];
/**
* The tables, in lookup order per locale. English is every locale's last
* resort, which is what lets `ZH_MESSAGES` stay partial: an untranslated row
* renders in English instead of rendering empty.
*/
const TABLES = {
	en: EN_MESSAGES,
	zh: ZH_MESSAGES
};
/**
* The active locale.
*
* Process-wide rather than passed down: every component in this bundle renders
* for the one terminal attached to the one process, and threading a locale
* through every constructor would buy an independence no caller has.
*/
let activeLocale = "en";
/** Observers notified after a committed locale change. */
const listeners = /* @__PURE__ */ new Set();
/** Placeholder syntax shared by both tables: `{name}`. */
const PLACEHOLDER = /\{(\w+)\}/gu;
/**
* Substitute `{name}` placeholders.
*
* A placeholder with no matching parameter is left standing rather than
* replaced with an empty string: a visible `{count}` in the UI names the bug,
* while a silent gap only makes the sentence read wrong.
* @param template - the message text.
* @param params - values by placeholder name.
* @returns the interpolated text.
*/
function interpolate(template, params) {
	if (params === void 0) return template;
	return template.replace(PLACEHOLDER, (match, name) => {
		const value = params[name];
		return value === void 0 ? match : String(value);
	});
}
/**
* Whether a raw string names a shipped locale, which is what `/lang <value>`
* and a stored preference both have to decide.
* @param value - a candidate locale id.
* @returns true when the value is one this terminal ships.
*/
function isLocaleId(value) {
	return typeof value === "string" && LOCALE_IDS.includes(value);
}
/**
* The locale every surface is currently rendering in.
* @returns the active locale id.
*/
function currentLocale() {
	return activeLocale;
}
/**
* Switch the locale and notify observers.
*
* Notification is skipped when the locale did not move, so re-applying a stored
* preference at startup costs no repaint.
*
* An observer that throws is contained: the locale is already committed by the
* time they run, and one broken repaint must not leave the rest of the screen
* on the previous language.
* @param next - the locale to render in from now on.
* @returns whether the active locale actually changed.
*/
function setLocale(next) {
	if (next === activeLocale) return false;
	activeLocale = next;
	for (const listener of [...listeners]) try {
		listener();
	} catch (_observerFailed) {}
	return true;
}
/**
* Observe committed locale changes — in this bundle, to repaint.
* @param listener - invoked after the active locale changes.
* @returns the disposer removing this observer.
*/
function onLocaleChange(listener) {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}
/**
* Read one message in the active locale.
* @param key - the dotted message key.
* @param params - values for the message's `{name}` placeholders.
* @param locale - render in this locale instead of the active one; used by the
*   English constants the docs suite holds the README to.
* @returns the interpolated message text.
*/
function t(key, params, locale = activeLocale) {
	return interpolate(TABLES[locale][key] ?? EN_MESSAGES[key], params);
}
/**
* Read one count-dependent message.
*
* English is the only shipped locale with a plural distinction, and it has
* exactly two forms, so the pair is `<key>.one` / `<key>.other` rather than a
* CLDR category set. Chinese fills both halves with the same sentence, which is
* what "no plural" looks like in a table that has to answer for both.
*
* `count` is passed through as `{count}` so a message can name it without the
* caller repeating itself.
* @param count - how many things the message is about.
* @param key - the pair's shared prefix.
* @param params - values for the message's other placeholders.
* @returns the interpolated message text for this count.
*/
function plural(count, key, params) {
	return t(`${key}.${count === 1 ? "one" : "other"}`, {
		count,
		...params
	});
}
/**
* The language's own name, as `/lang` prints it.
* @param locale - the locale to name.
* @returns the endonym, in the active locale's table.
*/
function localeName(locale) {
	return t(`lang.name.${locale}`);
}
/**
* One command's description in the active locale, falling back to whatever the
* registry holds.
*
* Command descriptions are registered once, in English, because the command
* registry is a service other front doors read; this terminal translates them
* on the way to the screen instead. A command registered by another plugin has
* no key here and keeps its own text.
* @param name - the registered command name.
* @param registered - the description the registry carries.
* @returns the text to show for this command.
*/
function commandDescription(name, registered) {
	const key = `command.${name}.description`;
	return key in EN_MESSAGES ? t(key) : registered;
}
//#endregion
//#region src/render/palette.ts
/** Build an {@link Rgb} from three channels. */
function rgb(r, g, b) {
	return {
		r,
		g,
		b
	};
}
/**
* The Claude Code dark theme's exact palette. Names mirror the upstream theme
* keys so a value can be traced back to the product it was taken from.
*/
const CLAUDE_COLORS = {
	/** The brand orange: the assistant bullet, the spinner verb, an in-progress todo. */
	claude: rgb(215, 119, 87),
	/** A settled, successful tool call. */
	success: rgb(78, 186, 101),
	/** A failed tool call, and a signal/exit-status pill. */
	error: rgb(255, 107, 128),
	/** A warning row (a capped display, a degraded render). */
	warning: rgb(255, 193, 7),
	/** The recessed status tone: elapsed time, token counts, fold hints. */
	inactive: rgb(153, 153, 153),
	/** A permission prompt's accent. */
	permission: rgb(177, 185, 249),
	/** Plan-mode chrome, on a dark terminal; see {@link claudeSchemeColors}. */
	planMode: rgb(72, 150, 140),
	/** Auto-accept chrome, on a dark terminal; see {@link claudeSchemeColors}. */
	autoAccept: rgb(175, 135, 255),
	/**
	* Background fill behind a user message on a dark terminal, the block that
	* marks the user's own turns; see {@link claudeSchemeColors}.
	*/
	userMessageBg: rgb(55, 55, 55),
	/** Muted outline of a bordered surface. */
	borderMuted: rgb(68, 68, 68),
	/** Tool branch connectors (`├ └ │`), a fixed gray independent of the terminal theme. */
	branch: rgb(72, 72, 72),
	/** An added line's background fill in a diff. */
	diffAddedBg: rgb(34, 92, 43),
	/** A removed line's background fill in a diff. */
	diffRemovedBg: rgb(122, 41, 54),
	/** The word-level added highlight inside an added line. */
	diffAddedWordBg: rgb(56, 166, 96),
	/** The word-level removed highlight inside a removed line. */
	diffRemovedWordBg: rgb(179, 89, 107),
	/** An added line's sign, gutter number, and stat-bar segment. */
	diffAddedFg: rgb(100, 180, 120),
	/** A removed line's sign, gutter number, and stat-bar segment. */
	diffRemovedFg: rgb(200, 100, 100),
	/** Diff chrome: separators, the `…` clip marker, context text. */
	diffDim: rgb(80, 80, 80),
	/** Diff gutter line numbers. */
	diffLineNumber: rgb(100, 100, 100),
	/** Diff horizontal rules and the split divider. */
	diffRule: rgb(50, 50, 50),
	/** The `╱` fill of an absent split-view side. */
	diffStripe: rgb(40, 40, 40),
	/** Replacement foreground for highlighted code too dark to read on a diff fill. */
	diffSafeMuted: rgb(139, 148, 158)
};
/**
* Claude Code's own values for the scheme-dependent colors, taken from its
* `darkTheme` and `lightTheme`.
*
* Returned as a fresh object per call so a caller can hold one and refresh it
* in place (`Object.assign`) when the terminal reports a scheme change, the way
* the role {@link ../components/theme.ts | Palette} is refreshed.
* @param scheme - The terminal's reported color scheme.
* @returns The fill and the two mode tones for that scheme.
*/
function claudeSchemeColors(scheme) {
	return scheme === "light" ? {
		userMessageBg: rgb(240, 240, 240),
		planMode: rgb(0, 102, 102),
		autoAccept: rgb(135, 0, 255)
	} : {
		userMessageBg: CLAUDE_COLORS.userMessageBg,
		planMode: CLAUDE_COLORS.planMode,
		autoAccept: CLAUDE_COLORS.autoAccept
	};
}
/** Reset every SGR group. Only for a span that owns the whole line. */
const RESET = "\x1B[0m";
/** Close a foreground span without touching background or attributes. */
const FG_DEFAULT$1 = "\x1B[39m";
/** Close a background span without touching foreground or attributes. */
const BG_DEFAULT = "\x1B[49m";
/** Open dim. */
const DIM = "\x1B[2m";
/**
* The truecolor foreground escape for a color.
* @param color - The color to open.
* @returns The SGR sequence, with no closing sequence.
*/
function fgAnsi(color) {
	return `\x1b[38;2;${color.r};${color.g};${color.b}m`;
}
/**
* The truecolor background escape for a color.
* @param color - The color to open.
* @returns The SGR sequence, with no closing sequence.
*/
function bgAnsi(color) {
	return `\x1b[48;2;${color.r};${color.g};${color.b}m`;
}
/**
* Paint text in a truecolor foreground, closing only the foreground group.
* @param color - The foreground color.
* @param text - Text to paint.
* @returns The painted text.
*/
function fg(color, text) {
	return `${fgAnsi(color)}${text}${FG_DEFAULT$1}`;
}
/**
* Fill text with a truecolor background, closing only the background group.
* @param color - The background color.
* @param text - Text to fill.
* @returns The filled text.
*/
function bg(color, text) {
	return `${bgAnsi(color)}${text}${BG_DEFAULT}`;
}
/**
* Wrap text in one SGR attribute pair.
* @param open - The opening sequence (one of {@link BOLD}, {@link DIM}, …).
* @param text - Text to wrap.
* @returns The wrapped text, closed with the matching attribute reset.
*/
function attribute$1(open, text) {
	return `${open}${text}${open === "\x1B[1m" || open === "\x1B[2m" ? "\x1B[22m" : open === "\x1B[3m" ? "\x1B[23m" : "\x1B[29m"}`;
}
/** Dim text, preserving any color the caller applied. */
function dim(text) {
	return attribute$1(DIM, text);
}
//#endregion
//#region src/components/approval.ts
/**
* Claude Code's permission prompt: the dialog an interactive answerer shows when
* the approval seam asks whether one tool call may run.
*
* The frame is Claude Code's own — a rounded TOP edge only
* (`╭─ Permission required ─…─╮`) with no side rules, so the prompt reads as a
* banner over the transcript rather than as a boxed form — painted in the fixed
* permission tone (rgb(177,185,249)) the product uses for every permission
* surface. The answer list is the `❯`-cursor Select shape the rest of the TUI
* uses, with number shortcuts that answer immediately.
*
* The dialog decides nothing on its own: it reports one {@link ApprovalDecision}
* and leaves closing the overlay, auditing, and the `'cancelled'`/`'unavailable'`
* outcomes to the front door that opened it — along with the two answers the
* approval protocol cannot express, remembering a session grant and delivering
* rejection feedback to the agent.
* @module @deepseek-ai/dsh-tui/components/approval
*/
/**
* The answer rows, in Claude Code's order: allow once, allow for the session,
* then the refusals — narrowest grant first, so the safe answer is the one the
* cursor already sits on.
*
* Claude Code hides "and tell Claude what to do differently" behind `Tab` on
* the refusal row. Here it is a row of its own: this terminal has no hover, no
* placeholder text, and no second chance to advertise a modifier, so an
* affordance that is not on the list is an affordance nobody finds.
*/
const APPROVAL_OPTIONS = [
	{
		action: "allow-once",
		label: () => t("approval.allowOnce")
	},
	{
		action: "allow-session",
		label: (toolName) => t("approval.allowSession", { tool: toolName })
	},
	{
		action: "reject-with-feedback",
		label: () => t("approval.rejectWithFeedback")
	},
	{
		action: "reject",
		label: () => t("approval.reject")
	}
];
/**
* Paint text in the fixed permission tone, or leave it bare when the palette has
* color disabled. A colorless palette makes every role the identity function, so
* `bold` carrying no escape is what tells the two apart.
*/
function permissionAccent(palette, text) {
	return palette.bold("x") === "x" ? text : fg(CLAUDE_COLORS.permission, text);
}
/**
* Inline dialog for one approval request: a tool identity, the asker's reason,
* and the four answers. `Esc` (and `Ctrl+C`) reject, because a permission prompt
* that is dismissed must fail closed.
*
* The refusal-with-feedback row swaps the answer list for a one-line editor
* rather than opening a second surface: the request is still unanswered while
* the user types, so the prompt must keep owning the single inline slot the
* front door gave it. `Esc` there goes back to the list — the only place in
* this dialog where `Esc` does not refuse — because a user who opened the box
* by mistake has not decided anything yet.
*/
var ApprovalDialog = class {
	prompt;
	palette;
	done;
	selectedIndex = 0;
	decided = false;
	/** Whether the feedback editor has replaced the answer list. */
	feedback = false;
	input = new Input();
	focused = false;
	constructor(prompt, palette, done) {
		this.prompt = prompt;
		this.palette = palette;
		this.done = done;
		this.input.onSubmit = (value) => {
			const text = value.trim();
			this.settle({
				outcome: "rejected",
				...text === "" ? {} : { feedback: text }
			});
		};
		this.input.onEscape = () => {
			this.feedback = false;
			this.input.setValue("");
		};
	}
	invalidate() {
		this.input.invalidate();
	}
	handleInput(data) {
		if (matchesKey(data, Key.ctrl("c"))) {
			this.settle({ outcome: "rejected" });
			return;
		}
		if (this.feedback) {
			this.input.focused = this.focused;
			this.input.handleInput(data);
			this.invalidate();
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.selectedIndex = this.selectedIndex === 0 ? APPROVAL_OPTIONS.length - 1 : this.selectedIndex - 1;
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.selectedIndex = this.selectedIndex === APPROVAL_OPTIONS.length - 1 ? 0 : this.selectedIndex + 1;
			return;
		}
		if (matchesKey(data, Key.enter)) {
			this.choose(this.selectedIndex);
			return;
		}
		if (matchesKey(data, Key.escape)) {
			this.settle({ outcome: "rejected" });
			return;
		}
		const shortcut = APPROVAL_OPTIONS.findIndex((_option, index) => data === String(index + 1));
		if (shortcut >= 0) {
			this.selectedIndex = shortcut;
			this.choose(shortcut);
		}
	}
	render(width) {
		const outer = Math.max(8, width);
		const inner = Math.max(1, outer - 2);
		const head = `─ ${t("approval.title")} `;
		const top = permissionAccent(this.palette, `╭${head}${"─".repeat(Math.max(0, outer - 2 - visibleWidth(head)))}╮`);
		const callId = this.prompt.callId;
		const heading = `${this.palette.bold(displayInlineText(this.prompt.toolName))}${callId === void 0 || callId === "" ? "" : ` ${this.palette.dim(displayInlineText(callId))}`}`;
		const body = [...wrapTextWithAnsi(heading, inner)];
		const reason = this.prompt.reason;
		if (reason !== void 0 && reason !== "") body.push(...wrapTextWithAnsi(this.palette.text(displayText(reason)), inner));
		body.push("");
		for (const line of this.feedback ? this.renderFeedback(inner) : this.renderOptions()) body.push(line);
		return [
			"",
			top,
			...body.map((row) => row === "" ? "" : ` ${truncateToWidth(row, inner, "…")}`)
		];
	}
	/** The answer list, cursor on the selected row. */
	renderOptions() {
		const toolName = displayInlineText(this.prompt.toolName);
		return APPROVAL_OPTIONS.map((option, index) => {
			const selected = index === this.selectedIndex;
			const suffix = option.action === "reject" ? " (esc)" : "";
			const row = `${selected ? "❯" : " "} ${index + 1}. ${option.label(toolName)}${suffix}`;
			return selected ? this.palette.bold(permissionAccent(this.palette, row)) : row;
		});
	}
	/** The feedback editor and its two keys, in place of the answer list. */
	renderFeedback(inner) {
		this.input.focused = this.focused;
		return [
			this.palette.text(t("approval.feedbackPrompt")),
			...this.input.render(inner),
			this.palette.dim(t("approval.feedbackHint"))
		];
	}
	/** Answer with the option at `index`; an out-of-range index cannot occur. */
	choose(index) {
		const option = APPROVAL_OPTIONS[index];
		/* v8 ignore next -- every caller derives `index` from APPROVAL_OPTIONS itself. */
		if (option === void 0) return;
		switch (option.action) {
			case "allow-once":
				this.settle({
					outcome: "allowed-once",
					remember: false
				});
				return;
			case "allow-session":
				this.settle({
					outcome: "allowed-once",
					remember: true
				});
				return;
			case "reject-with-feedback":
				this.feedback = true;
				this.invalidate();
				return;
			case "reject": this.settle({ outcome: "rejected" });
		}
	}
	/** Report the decision exactly once: a settled dialog is already closing. */
	settle(decision) {
		if (this.decided) return;
		this.decided = true;
		this.done(decision);
	}
};
//#endregion
//#region src/components/content.ts
/**
* Flatten content blocks into a single display string, recursing into
* tool-result content and naming unknown block types.
* @param content - Content blocks to flatten.
* @returns The concatenated display text.
*/
function contentText(content) {
	const parts = [];
	for (const block of content) switch (block.type) {
		case "text":
		case "reasoning":
			parts.push(block.text);
			break;
		case "tool-call":
			parts.push(`${block.name}(${block.arguments})`);
			break;
		case "tool-result":
			parts.push(contentText(block.content));
			break;
		default: {
			const rawType = block.type;
			parts.push(`[${typeof rawType === "string" ? rawType : "content"}]`);
			break;
		}
	}
	return parts.join("");
}
/**
* Parse tool-call arguments from their JSON source.
* @param raw - Raw JSON arguments text.
* @returns The parsed value, or the raw text with `valid: false` on parse failure.
*/
function parseArguments(raw) {
	try {
		return {
			value: JSON.parse(raw),
			valid: true
		};
	} catch {
		return {
			value: raw,
			valid: false
		};
	}
}
//#endregion
//#region src/components/theme.ts
/** Names of the palette's color roles, in the order `/palette` prints them. */
const COLOR_ROLES = [
	"text",
	"dim",
	"accent",
	"brand",
	"code",
	"success",
	"warning",
	"error"
];
/** Names of the palette's attribute roles, in the order `/palette` prints them. */
const ATTRIBUTE_ROLES = [
	"bold",
	"italic",
	"underline",
	"strike",
	"selected"
];
/**
* Every SGR code the TUI is allowed to emit, keyed by role. This table is the
* single source: {@link createPalette} derives the wrappers from it and
* `/palette` prints it, so a role cannot exist in one and not the other, and no
* component hand-writes an escape.
*
* Only the standard 16-color set and SGR attributes appear here. Terminals remap
* those to the user's active theme, so the TUI stays legible on any background;
* a fixed 24-bit color would not. The startup gradient and exact official mark
* color are the two deliberate brand exceptions ({@link gradientText},
* {@link brandText}).
*
* @param scheme - Active terminal color scheme; only `code` differs between them.
* @returns The SGR spec for every color and attribute role.
*/
function paletteSpec(scheme) {
	return {
		colors: {
			text: {
				open: "",
				close: "",
				purpose: "Body text, the terminal default foreground"
			},
			dim: {
				open: "2;39",
				close: "22;39",
				purpose: "The one recessed tone: tool bodies, chrome, footers"
			},
			accent: {
				open: "95",
				close: "39",
				purpose: "The one emphasis color: role headers, prompt, borders"
			},
			brand: {
				open: "34",
				close: "39",
				purpose: "DeepSeek brand art when truecolor is unavailable"
			},
			code: scheme === "light" ? {
				open: "34",
				close: "39",
				purpose: "Inline code and code blocks in prose"
			} : {
				open: "36",
				close: "39",
				purpose: "Inline code and code blocks in prose"
			},
			success: {
				open: "32",
				close: "39",
				purpose: "Succeeded calls, and a diff's added lines"
			},
			warning: {
				open: "33",
				close: "39",
				purpose: "Pending calls and warnings"
			},
			error: {
				open: "31",
				close: "39",
				purpose: "Failures, signals, and a diff's removed lines"
			}
		},
		attributes: {
			bold: {
				open: "1",
				close: "22",
				purpose: "Emphasis; composes with any color"
			},
			italic: {
				open: "3",
				close: "23",
				purpose: "Reasoning text"
			},
			underline: {
				open: "4",
				close: "24",
				purpose: "Role-header banding"
			},
			strike: {
				open: "9",
				close: "29",
				purpose: "Struck-through Markdown"
			},
			selected: {
				open: "7",
				close: "27",
				purpose: "Reverse video for the active selection"
			}
		}
	};
}
/**
* Wrap text in an SGR pair, or pass it through when color is disabled.
* An empty `open` emits nothing, so the `text` role costs no escape.
*/
function ansi(spec, enabled) {
	if (!enabled || spec.open === "") return (text) => text;
	return (text) => `\x1b[${spec.open}m${text}\x1b[${spec.close}m`;
}
/**
* Theme-agnostic palette derived from {@link paletteSpec}. Body `text` stays the
* terminal's default foreground so it reads on light and dark backgrounds alike;
* grouping uses foreground-only bold, underlined role headers and reverse video
* rather than fixed background fills or per-line prefixes, so a transcript
* drag-select copies message text without stray glyphs.
*
* @param enabled - Whether ANSI is emitted at all.
* @param scheme - Active terminal color scheme; adjusts the code role.
* @returns The role palette for the given scheme.
*/
function createPalette(enabled, scheme = "dark") {
	const spec = paletteSpec(scheme);
	const roles = {};
	for (const name of COLOR_ROLES) roles[name] = ansi(spec.colors[name], enabled);
	for (const name of ATTRIBUTE_ROLES) roles[name] = ansi(spec.attributes[name], enabled);
	return roles;
}
/** Every `/theme` value, in the order the selector lists them. */
const THEME_PREFERENCES = [
	"auto",
	"light",
	"dark",
	"no-color"
];
/**
* The line shown beside one `/theme` value, in the selector and in the
* command's own completions.
*
* A function rather than a table of strings: a message read at import time
* freezes the locale it was first read in, and this line is rendered by two
* surfaces that both outlive a `/lang` switch.
* @param id - the theme value to describe.
* @returns the description in the active locale.
*/
function themePreferenceDescription(id) {
	return t(`theme.description.${id}`);
}
/**
* Whether a string is one of the four `/theme` values, for a typed argument and
* for a settings document a person may have edited by hand.
* @param value - candidate theme id.
* @returns true when the value names a theme this terminal can apply.
*/
function isThemePreference(value) {
	return THEME_PREFERENCES.includes(value);
}
/**
* Resolve a theme preference against the two facts it layers over: what the
* terminal reported about itself, and whether this deployment allows color at
* all.
*
* Config keeps the last word on `no-color`: a deployment that set
* `theme.color: false` (a pipe, a CI log) must not get escapes back because a
* settings document from another terminal says `dark`.
* @param preference - the stored `/theme` choice.
* @param reported - the scheme the terminal last reported; `auto` follows it.
* @param configColor - the deployment's `theme.color` setting.
* @returns the arguments {@link createPalette} is called with.
*/
function resolveThemeAppearance(preference, reported, configColor) {
	return {
		color: configColor && preference !== "no-color",
		scheme: preference === "light" || preference === "dark" ? preference : reported
	};
}
/**
* DeepSeek brand gradient stops (indigo → light blue) taken from the
* deepseek.com logo, painted across the startup banner's product name on
* truecolor terminals. Fixed brand identity, deliberately outside the
* theme-adaptive {@link Palette}.
*/
const BRAND_GRADIENT = [
	[
		77,
		107,
		254
	],
	[
		57,
		130,
		255
	],
	[
		36,
		152,
		255
	]
];
/** Official DeepSeek icon ink from the shipped 24x24 SVG. */
const DEEPSEEK_BRAND_RGB = BRAND_GRADIENT[0];
/**
* Paint trusted static DeepSeek brand art with the official `#4D6BFE` ink.
* @param text - Static brand text or raster cells.
* @returns text wrapped in the official truecolor foreground and a foreground reset.
*/
function brandText(text) {
	const [r, g, b] = DEEPSEEK_BRAND_RGB;
	return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
}
/**
* Sample {@link BRAND_GRADIENT} at fraction `t` via piecewise-linear
* interpolation across its stops.
*
* @param t - Position along the gradient; clamped to [0, 1].
* @returns The interpolated `[r, g, b]` channels, each rounded to 0–255.
*/
function brandColorAt(t) {
	const span = Math.min(Math.max(t, 0), 1) * (BRAND_GRADIENT.length - 1);
	const index = Math.min(Math.floor(span), BRAND_GRADIENT.length - 2);
	const local = span - index;
	const from = BRAND_GRADIENT[index];
	const to = BRAND_GRADIENT[index + 1];
	return [
		Math.round(from[0] + (to[0] - from[0]) * local),
		Math.round(from[1] + (to[1] - from[1]) * local),
		Math.round(from[2] + (to[2] - from[2]) * local)
	];
}
/**
* Paint `text` left-to-right in the DeepSeek brand gradient with per-character
* 24-bit foreground codes, resetting to the default foreground at the end.
* Foreground-only, so it stays legible on any terminal background; the caller
* gates it on truecolor support and wraps it in bold.
*
* @param text - Text to colorize; sampled once per character.
* @returns `text` wrapped in truecolor SGR foreground codes.
*/
function gradientText(text) {
	const glyphs = Array.from(text);
	const last = Math.max(1, glyphs.length - 1);
	let painted = "";
	for (let index = 0; index < glyphs.length; index += 1) {
		const [r, g, b] = brandColorAt(index / last);
		painted += `\x1b[38;2;${r};${g};${b}m${glyphs[index]}`;
	}
	return `${painted}\x1b[39m`;
}
/**
* Derive the pi-tui Markdown theme from a role palette.
* @param palette - Active role palette.
* @returns The Markdown theme wired to palette roles.
*/
function markdownTheme(palette) {
	return {
		heading: (text) => palette.accent(text),
		link: (text) => palette.accent(text),
		/* v8 ignore next */
		linkUrl: (text) => palette.dim(text),
		code: (text) => palette.code(text),
		codeBlock: (text) => palette.code(text),
		codeBlockBorder: (text) => palette.dim(text.slice(3)),
		quote: (text) => palette.dim(text),
		quoteBorder: (text) => palette.accent(text),
		hr: (text) => palette.dim(text),
		listBullet: (text) => palette.accent(text),
		bold: (text) => palette.bold(text),
		italic: (text) => palette.italic(text),
		strikethrough: (text) => palette.strike(text),
		underline: (text) => palette.underline(text)
	};
}
/**
* Derive the pi-tui select-list theme from a role palette.
*
* Each entry reads its role off the palette when it paints, rather than
* capturing the wrapper the palette held at construction: a theme change swaps
* the roles in place, and the editor's autocomplete menu is built once and
* lives for the whole session, so a captured wrapper would keep emitting the
* palette `/theme` just replaced — colored rows under `no-color` included.
* @param palette - Active role palette.
* @returns The select-list theme wired to palette roles.
*/
function selectTheme(palette) {
	return {
		selectedPrefix: (text) => palette.accent(text),
		selectedText: (text) => palette.accent(text),
		description: (text) => palette.dim(text),
		scrollInfo: (text) => palette.dim(text),
		noMatch: (text) => palette.warning(text)
	};
}
/**
* Derive the reverse-video dialog select-list theme from a role palette.
* @param palette - Active role palette.
* @returns The dialog select-list theme with a reverse-video selection.
*/
function dialogSelectTheme(palette) {
	return {
		...selectTheme(palette),
		selectedText: (text) => palette.selected(palette.accent(text))
	};
}
/** Sample text every `/palette` row renders, long enough to judge a tone against its neighbours. */
const PALETTE_SAMPLE = "The quick brown fox 0123";
/**
* Render every palette role as a labelled sample row, each painted by the role
* it names, so a reader compares the actual tones their terminal produces rather
* than reading SGR numbers. Colors print first and attributes second because the
* two groups compose in that order; every row shows its SGR pair so a mismatch
* between the table and the screen is visible.
*
* @param palette - Active role palette, used to paint each sample.
* @param scheme - Active color scheme, reported in the heading and selecting the spec.
* @param colorEnabled - Whether ANSI is emitted; reported so an unstyled listing is not confusing.
* @returns The rendered rows, without a trailing blank.
*/
function renderPalette(palette, scheme, colorEnabled) {
	const spec = paletteSpec(scheme);
	const width = Math.max(...[...COLOR_ROLES, ...ATTRIBUTE_ROLES].map((name) => name.length));
	const head = (name, role, sample) => {
		const pair = role.open === "" ? "no escape" : `ESC[${role.open}m ESC[${role.close}m`;
		return `  ${sample}  ${palette.dim(`${name.padEnd(width)} ${pair}`)}`;
	};
	const purpose = (role) => `  ${palette.dim(`    ${role.purpose}`)}`;
	const rows = [
		palette.bold(palette.accent("Palette")),
		palette.dim(`${scheme} scheme · color ${colorEnabled ? "on" : "off"}`),
		"",
		palette.dim("Colors — exactly one per span; they never nest inside each other.")
	];
	for (const name of COLOR_ROLES) rows.push(head(name, spec.colors[name], palette[name](PALETTE_SAMPLE)), purpose(spec.colors[name]));
	rows.push("", palette.dim("Attributes — compose with any color, in either order."));
	for (const name of ATTRIBUTE_ROLES) rows.push(head(name, spec.attributes[name], palette[name](PALETTE_SAMPLE)), purpose(spec.attributes[name]));
	return rows;
}
/** Shell words that make a command a search (upstream's `BASH_SEARCH_COMMANDS`). */
const BASH_SEARCH_COMMANDS = /* @__PURE__ */ new Set([
	"find",
	"grep",
	"rg",
	"ag",
	"ack",
	"locate",
	"which",
	"whereis"
]);
/**
* Shell words that make a command a read: the viewers, the analysers, and the
* text processors a pipeline uses to pick a file apart.
*/
const BASH_READ_COMMANDS = /* @__PURE__ */ new Set([
	"cat",
	"head",
	"tail",
	"less",
	"more",
	"wc",
	"stat",
	"file",
	"strings",
	"jq",
	"awk",
	"cut",
	"sort",
	"uniq",
	"tr"
]);
/**
* Shell words that list a directory. Split from {@link BASH_READ_COMMANDS} so
* the summary says `Listed 2 directories` rather than the false `Read 2 files`.
*/
const BASH_LIST_COMMANDS = /* @__PURE__ */ new Set([
	"ls",
	"tree",
	"du"
]);
/**
* Shell words that are semantically neutral in any position: pure output or
* status, so they do not change what a pipeline is. `ls src && echo --- && ls
* tests` is still a listing.
*/
const BASH_NEUTRAL_COMMANDS = /* @__PURE__ */ new Set([
	"echo",
	"printf",
	"true",
	"false",
	":"
]);
/** Operator tokens whose right-hand side is a redirect target, not a command. */
const REDIRECT_OPERATORS = /* @__PURE__ */ new Set([
	">",
	">>",
	">&",
	"2>",
	"2>>",
	"2>&",
	"<"
]);
/**
* The redirects that put bytes somewhere. A command carrying one of these is
* not read-only, whatever its verb says — `cat a > b` writes `b`.
*/
const WRITE_REDIRECT_OPERATORS = /* @__PURE__ */ new Set([
	">",
	">>",
	">&",
	"2>",
	"2>>",
	"2>&"
]);
/** The redirects whose target may be a file descriptor rather than a path. */
const FD_DUP_OPERATORS = /* @__PURE__ */ new Set([">&", "2>&"]);
/** The sink that is not a file: writing here loses the bytes on purpose. */
const NULL_DEVICE = "/dev/null";
/**
* `find` predicates that act on what they match. `find` is otherwise the
* archetypal read-only search, which is exactly what makes `-delete` worth
* naming: it turns the same command into a bulk removal.
*/
const FIND_MUTATING_FLAGS = /* @__PURE__ */ new Set([
	"-delete",
	"-exec",
	"-execdir",
	"-ok",
	"-okdir",
	"-fprint",
	"-fprintf"
]);
/**
* Shell syntax that runs a second command this classifier never sees.
*
* `cat $(rm -rf build)`, ``cat `rm -rf build` `` and `cat <(rm x)` all read as
* a bare `cat` once split into segments, because the inner command is an
* argument, a quoted-looking word, or a redirect target rather than a segment
* of its own. Nothing here parses those, and a command this module cannot parse
* is not read-only — the same stance {@link splitCommandWithOperators} already
* takes for an unbalanced quote.
*/
const COMMAND_SUBSTITUTION = /\$\(|`|<\(/u;
/**
* Whether a whitelisted verb writes a file through its own arguments rather
* than through a shell redirect.
*
* `sort` and `uniq` are in {@link BASH_READ_COMMANDS} because a pipeline uses
* them to pick text apart, but both also take an output path — `sort -o out in`
* truncates `out`, and `uniq in out` writes `out`. Neither carries a redirect,
* so the redirect analysis never sees them, and the write folds into the
* transcript's `Read 1 file` row with no card behind it.
* @param base - The segment's leading word.
* @param words - Every whitespace-separated word of the segment, `base` first.
* @returns Whether this invocation writes a file through its arguments.
*/
function writesThroughArguments(base, words) {
	const args = words.slice(1);
	if (base === "sort") return args.some((word) => word.startsWith("--output") || /^-[a-zA-Z]*o$/u.test(word));
	if (base === "uniq") {
		const valued = /* @__PURE__ */ new Set([
			"-f",
			"-s",
			"-w",
			"--skip-fields",
			"--skip-chars",
			"--check-chars"
		]);
		let operands = 0;
		for (let index = 0; index < args.length; index += 1) {
			const word = args[index];
			if (valued.has(word)) {
				index += 1;
				continue;
			}
			if (word.startsWith("-") && word !== "-") continue;
			operands += 1;
		}
		return operands >= 2;
	}
	return false;
}
/** Operator tokens that merely separate commands. */
const SEPARATOR_OPERATORS = /* @__PURE__ */ new Set([
	"|",
	"||",
	"&&",
	";",
	"&"
]);
/** The prefix an MCP tool name carries: `mcp__<server>__<raw>`. */
const MCP_PREFIX = "mcp__";
/**
* Leading verbs that make an MCP tool a query.
*
* Upstream keys this off a 600-entry allowlist of tool names it has seen; a
* port cannot keep that list current, so this reads the tool's own verb
* instead. It stays conservative in the same direction — an unrecognised verb
* (`send_message`, `create_issue`, `update_page`) is not read-only and breaks
* the group, which is what matters.
*/
const MCP_READ_VERBS = /* @__PURE__ */ new Set([
	"search",
	"find",
	"get",
	"list",
	"read",
	"fetch",
	"query",
	"describe",
	"view",
	"lookup",
	"browse",
	"inspect",
	"show"
]);
/**
* Leading verbs that make an MCP tool a mutation, whatever its object is.
*
* The two-token window below exists for servers that namespace their tools
* (`slack_search_public`), and it is what let `delete_search_index`,
* `create_search_filter` and `save_search` read as queries: their object
* happens to be a query. A first token in this set settles the question before
* the window is consulted.
*/
const MCP_WRITE_VERBS = /* @__PURE__ */ new Set([
	"create",
	"update",
	"delete",
	"remove",
	"write",
	"set",
	"add",
	"send",
	"post",
	"patch",
	"save",
	"clear",
	"drop",
	"move",
	"rename",
	"upload",
	"insert",
	"edit",
	"append",
	"archive",
	"close",
	"cancel",
	"run",
	"execute"
]);
/**
* A group's thinking time at render clock `now`: what the fold measured plus
* whatever the open span has run since it opened.
*
* The clock is the caller's because this module holds none — the same reason
* the fold publishes a span's start rather than its length. Called without one
* (a settled row, a test), it reports the closed total alone.
* @param group - The planned group.
* @param now - Render clock, in epoch milliseconds.
* @returns Thinking time in milliseconds.
*/
function groupThinkingMs(group, now) {
	const open = group.thinkingSince === void 0 || now === void 0 ? 0 : Math.max(0, now - group.thinkingSince);
	return group.thinkingMs + open;
}
/**
* Split a shell command into command segments and the operator tokens between
* them, the way upstream's `splitCommandWithOperators` does — enough structure
* to read each segment's leading word and to skip redirect targets.
*
* Quoting is honoured so `grep "a | b" file` stays one segment. An unbalanced
* quote is unparseable, and an unparseable command is not read-only.
* @param command - The raw command line.
* @returns Segments and operators in order, or `undefined` when unparseable.
*/
function splitCommandWithOperators(command) {
	const parts = [];
	let current = "";
	let quote;
	let index = 0;
	const flush = () => {
		const trimmed = current.trim();
		if (trimmed !== "") parts.push(trimmed);
		current = "";
	};
	while (index < command.length) {
		const char = command[index];
		if (quote !== void 0) {
			current += char;
			if (char === quote) quote = void 0;
			index += 1;
			continue;
		}
		if (char === "\"" || char === "'") {
			quote = char;
			current += char;
			index += 1;
			continue;
		}
		if (char === "\\" && index + 1 < command.length) {
			current += char + command[index + 1];
			index += 2;
			continue;
		}
		const triple = command.slice(index, index + 3);
		if (triple === "2>>" || triple === "2>&") {
			flush();
			parts.push(triple);
			index += 3;
			continue;
		}
		const pair = command.slice(index, index + 2);
		if (pair === "||" || pair === "&&" || pair === ">>" || pair === ">&" || pair === "2>") {
			flush();
			parts.push(pair);
			index += 2;
			continue;
		}
		if (char === "|" || char === ";" || char === "&" || char === ">" || char === "<" || char === "\n") {
			flush();
			parts.push(char);
			index += 1;
			continue;
		}
		current += char;
		index += 1;
	}
	if (quote !== void 0) return void 0;
	flush();
	return parts;
}
/**
* Classify a shell command as search, read, or listing.
*
* Every non-neutral segment of a pipeline has to be one of the three: `cat
* file | jq .` is a read, and `cat file > out` is not a read at all — it is a
* write, so the whole command is disqualified. A redirect is judged by where it
* points rather than skipped: `< in` only names an input, `2>&1` and `2>` to
* {@link NULL_DEVICE} throw bytes away, and everything else creates or
* truncates a file the user would want to see reported. Skipping the target
* instead — which is what this did — folded a real file write into the
* transcript's `Read 1 file` row, with no card and no command text behind it.
*
* The same reasoning disqualifies a command that runs another one out of this
* classifier's sight ({@link COMMAND_SUBSTITUTION}) or writes through an
* argument instead of a redirect ({@link writesThroughArguments}): the leading
* word says `cat`, and the line still deletes a tree or truncates a file.
*
* A command of nothing but neutral words (`echo hi`) is not collapsible either
* — it read nothing.
* @param command - The raw command line.
* @returns Which of the three kinds the command performs, all false when none.
*/
function classifyShellCommand(command) {
	const none = {
		isSearch: false,
		isRead: false,
		isList: false
	};
	if (COMMAND_SUBSTITUTION.test(command)) return none;
	const parts = splitCommandWithOperators(command);
	if (parts === void 0 || parts.length === 0) return none;
	let hasSearch = false;
	let hasRead = false;
	let hasList = false;
	let hasCommand = false;
	let redirect;
	for (const part of parts) {
		if (redirect !== void 0) {
			const operator = redirect;
			redirect = void 0;
			if (!WRITE_REDIRECT_OPERATORS.has(operator)) continue;
			const target = part.split(/\s+/)[0] ?? "";
			if (FD_DUP_OPERATORS.has(operator) && /^\d+-?$/u.test(target)) continue;
			if (target === NULL_DEVICE) continue;
			return none;
		}
		if (REDIRECT_OPERATORS.has(part)) {
			redirect = part;
			continue;
		}
		if (SEPARATOR_OPERATORS.has(part)) continue;
		const words = part.split(/\s+/);
		const base = words[0];
		if (base === void 0 || base === "") continue;
		if (BASH_NEUTRAL_COMMANDS.has(base)) continue;
		hasCommand = true;
		const isSearch = BASH_SEARCH_COMMANDS.has(base);
		const isRead = BASH_READ_COMMANDS.has(base);
		const isList = BASH_LIST_COMMANDS.has(base);
		if (!isSearch && !isRead && !isList) return none;
		if (base === "find" && words.some((word) => FIND_MUTATING_FLAGS.has(word))) return none;
		if (writesThroughArguments(base, words)) return none;
		if (isSearch) hasSearch = true;
		if (isRead) hasRead = true;
		if (isList) hasList = true;
	}
	if (redirect !== void 0 && WRITE_REDIRECT_OPERATORS.has(redirect)) return none;
	if (!hasCommand) return none;
	return {
		isSearch: hasSearch,
		isRead: hasRead,
		isList: hasList
	};
}
/**
* Compact a command for the `⎿` row: blank lines dropped, runs of inline
* whitespace squeezed, newlines kept so the renderer can indent continuations.
* @param command - The raw command line.
* @returns The compacted command, without its `$ ` lead-in.
*/
function compactCommand(command) {
	return command.split("\n").map((line) => line.replace(/\s+/g, " ").trim()).filter((line) => line !== "").join("\n");
}
/** Read one string field off a tool call's parsed arguments. */
function argString(args, key) {
	if (typeof args !== "object" || args === null) return void 0;
	const value = args[key];
	return typeof value === "string" && value !== "" ? value : void 0;
}
/**
* The MCP server one tool name names, or `undefined` when it is not an MCP
* tool. `mcp__<server>__<raw>` is the registry's own qualified form.
*/
function mcpParts(name) {
	if (!name.startsWith(MCP_PREFIX)) return void 0;
	const rest = name.slice(5);
	const separator = rest.indexOf("__");
	if (separator <= 0) return void 0;
	return {
		server: rest.slice(0, separator),
		raw: rest.slice(separator + 2)
	};
}
/** Whether an MCP tool's own name reads as a query rather than a mutation. */
function isMcpQuery(raw) {
	const verb = raw.replace(/([a-z\d])([A-Z])/g, "$1_$2").replace(/-/g, "_").toLowerCase().split("_").filter((part) => part !== "");
	if (verb[0] !== void 0 && MCP_WRITE_VERBS.has(verb[0])) return false;
	return verb.slice(0, 2).some((part) => MCP_READ_VERBS.has(part));
}
/**
* Classify one tool call as a read-only operation.
*
* The tool set is this harness's own: `read`/`read_image` read, `grep`/`glob`
* search, `str_replace_editor` reads only under its `view` command, and
* `bash`/`pwsh` are whatever their command line says they are. Everything else
* — edits, writes, web calls, task tools — is not collapsible and breaks the
* group it lands in.
* @param name - The tool's registered name.
* @param args - The call's parsed arguments.
* @returns The classification, or `undefined` when the call is not read-only.
*/
function classifyToolCall(name, args) {
	const mcp = mcpParts(name);
	if (mcp !== void 0) {
		if (!isMcpQuery(mcp.raw)) return void 0;
		const query = argString(args, "query") ?? argString(args, "pattern");
		return {
			kind: "mcp",
			server: mcp.server,
			...query === void 0 ? {} : { hint: {
				kind: "pattern",
				value: query
			} }
		};
	}
	switch (name) {
		case "read":
		case "read_image": {
			const path = argString(args, "file_path");
			return {
				kind: "read",
				...path === void 0 ? {} : {
					path,
					hint: {
						kind: "path",
						value: path
					}
				}
			};
		}
		case "grep":
		case "glob": {
			const pattern = argString(args, "pattern");
			return {
				kind: "search",
				...pattern === void 0 ? {} : { hint: {
					kind: "pattern",
					value: pattern
				} }
			};
		}
		case "str_replace_editor": {
			if (argString(args, "command") !== "view") return void 0;
			const path = argString(args, "path");
			return {
				kind: "read",
				...path === void 0 ? {} : {
					path,
					hint: {
						kind: "path",
						value: path
					}
				}
			};
		}
		case "bash":
		case "pwsh": {
			const command = argString(args, "command");
			if (command === void 0) return void 0;
			const { isSearch, isRead, isList } = classifyShellCommand(command);
			if (!isSearch && !isRead && !isList) return void 0;
			return {
				kind: isSearch ? "search" : isList && !isRead ? "list" : "read",
				hint: {
					kind: "command",
					value: compactCommand(command)
				}
			};
		}
		default: return;
	}
}
/** Freeze a draft into the group the renderer reads. */
function sealGroup(draft) {
	return {
		index: draft.index,
		keys: draft.keys,
		searchCount: draft.searchCount,
		readCount: draft.readPaths.size + draft.readOperations,
		listCount: draft.listCount,
		mcpCallCount: draft.mcpCallCount,
		mcpServers: draft.mcpServers,
		thinkingMs: draft.thinkingMs,
		running: draft.running,
		active: draft.running || draft.thinkingSince !== void 0,
		failed: draft.failed,
		...draft.thinkingSince === void 0 ? {} : { thinkingSince: draft.thinkingSince },
		...draft.hint === void 0 ? {} : { hint: draft.hint }
	};
}
/**
* The latest line of one step's thinking, with runs of whitespace squeezed to a
* single space so a wrapped paragraph reads as one line.
*
* The *latest* rather than the first: while the model is thinking, the last
* line it wrote is the closest thing there is to "what it is doing right now",
* which is exactly what the `⎿` row under a running group answers.
* @param reasoning - The step's reasoning text so far.
* @returns The line, or `undefined` when the text is blank.
*/
function latestThinkingLine(reasoning) {
	const lines = reasoning.split("\n");
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const line = lines[index].replace(/\s+/gu, " ").trim();
		if (line !== "") return line;
	}
}
/** One step's thinking, or `undefined` when the step never thought. */
function stepThinking(node) {
	const ms = node.thinkingMs ?? 0;
	const since = node.thinkingSince;
	if (ms === 0 && since === void 0) return void 0;
	return {
		ms,
		since,
		line: latestThinkingLine(node.reasoning)
	};
}
/**
* Add one step's thinking to a group under construction.
* @param draft - The group under construction.
* @param thinking - The step's span.
* @param quoteLine - Whether this deployment may put reasoning text on screen.
*/
function absorbThinking(draft, thinking, quoteLine) {
	draft.thinkingMs += thinking.ms;
	if (thinking.since !== void 0) draft.thinkingSince = thinking.since;
	if (quoteLine && draft.hint === void 0 && thinking.line !== void 0) draft.hint = {
		kind: "thinking",
		value: thinking.line
	};
}
/** Merge two thinking spans that reach the same group, in log order. */
function mergeThinking(carried, next) {
	if (carried === void 0) return next;
	return {
		ms: carried.ms + next.ms,
		since: next.since ?? carried.since,
		line: next.line ?? carried.line
	};
}
/**
* Whether a node ends the run of read-only calls above it.
*
* Assistant prose and a non-read-only call are the two breaks upstream keeps: a
* sentence the model wrote, or work that changed something, is where one
* stretch of looking around ends. A new prompt and a compaction boundary break
* it here as well, because both are the conversation moving on. Everything else
* (thinking with no text, an injected context card, a notice, the plan) is
* carried over the group rather than ending it.
*/
function breaksGroup(node) {
	switch (node.kind) {
		case "assistant": return node.text.trim() !== "";
		case "user-message": return node.withdrawn !== true;
		case "compaction": return node.landed;
		case "reference": return true;
		default: return false;
	}
}
/**
* Plan the collapsed groups over a folded node list.
*
* A run of one is not a run: a lone `read` keeps its card, because the summary
* row it would become names no file, no pattern and no command (the `⎿` hint
* only shows while the group is running), and "Read 1 file" is strictly less
* than the `Read(src/a.ts)` card it replaced. The row earns its place from two
* members up, which is where it starts saving rows instead of spending them.
* Absorbed thinking does not lower that threshold — `Thought for 8s, read 1
* file` still drops the path the card names — so a group's thinking is only
* ever reported next to two or more calls, and its thinking hint stands only
* until the first of those calls names something of its own.
*
* @param nodes - The snapshot's nodes, in log order.
* @param options - Range and per-call exclusions.
* @returns A map from node index to the group that index belongs to. Every
*   member index maps to the same object, whose `index` names the last member —
*   the one whose place the summary row takes. Indices of a single-member run
*   are absent, so the caller renders their card.
*/
function collapseToolGroups(nodes, options = {}) {
	const groups = /* @__PURE__ */ new Map();
	const from = options.from ?? 0;
	const quoteThinking = options.showReasoning !== false;
	let draft;
	let members = [];
	/**
	* Thinking seen with no group open yet. A step thinks *before* it calls
	* anything, so its reasoning reaches the run it opens by being carried here
	* until that run's first member arrives.
	*/
	let carried;
	const flush = () => {
		if (draft !== void 0 && draft.keys.length > 1) {
			const group = sealGroup(draft);
			for (const index of members) groups.set(index, group);
		}
		draft = void 0;
		members = [];
		carried = void 0;
	};
	for (let index = Math.max(0, from); index < nodes.length; index += 1) {
		const node = nodes[index];
		/* v8 ignore next -- the loop bound keeps the index inside the array. */
		if (node === void 0) continue;
		if (node.kind === "tool-call") {
			if (!node.argsComplete) continue;
			if (options.isHidden?.(node.callId) === true) continue;
			const classification = classifyToolCall(node.name, node.args.value);
			if (classification === void 0) {
				flush();
				continue;
			}
			if (draft === void 0) {
				draft = {
					index,
					keys: [],
					searchCount: 0,
					readPaths: /* @__PURE__ */ new Set(),
					readOperations: 0,
					listCount: 0,
					mcpCallCount: 0,
					mcpServers: [],
					thinkingMs: 0,
					thinkingSince: void 0,
					running: false,
					failed: false,
					hint: void 0
				};
				if (carried !== void 0) absorbThinking(draft, carried, quoteThinking);
				carried = void 0;
			}
			absorb(draft, node, classification);
			draft.index = index;
			members.push(index);
			continue;
		}
		if (node.kind === "assistant") {
			const thinking = stepThinking(node);
			if (draft !== void 0) {
				if (thinking !== void 0) absorbThinking(draft, thinking, quoteThinking);
				if (breaksGroup(node)) flush();
				continue;
			}
			if (breaksGroup(node)) flush();
			if (thinking !== void 0) carried = mergeThinking(carried, thinking);
			continue;
		}
		if (breaksGroup(node)) flush();
	}
	flush();
	return groups;
}
/** Fold one classified call into the group it joins. */
function absorb(draft, node, classification) {
	draft.keys.push(node.key);
	if (node.status === "running") draft.running = true;
	if (node.status === "error") draft.failed = true;
	switch (classification.kind) {
		case "search":
			draft.searchCount += 1;
			break;
		case "list":
			draft.listCount += 1;
			break;
		case "mcp":
			draft.mcpCallCount += 1;
			if (classification.server !== void 0 && !draft.mcpServers.includes(classification.server)) draft.mcpServers.push(classification.server);
			break;
		default: if (classification.path !== void 0) draft.readPaths.add(classification.path);
		else draft.readOperations += 1;
	}
	if (classification.hint !== void 0) draft.hint = classification.hint;
}
/**
* Render a group's `⎿` hint: the file's workspace-relative path, the quoted
* pattern, the `$ `-prefixed command, or — before the group's first operation —
* the bare line of thinking, all capped at {@link MAX_HINT_CHARS}.
* @param hint - The group's latest operation.
* @param displayPath - Shortens an absolute path for display.
* @returns The hint row's text.
*/
function formatCollapseHint(hint, displayPath) {
	const text = hint.kind === "path" ? displayPath(hint.value) : hint.kind === "thinking" ? hint.value : hint.kind === "pattern" ? `"${hint.value}"` : `$ ${hint.value}`;
	return text.length > 300 ? `${text.slice(0, 299)}…` : text;
}
//#endregion
//#region src/chat/helpers.ts
/**
* Zero-state helpers for the interactive chat channel: prompt-directory and
* Git-branch formatting, the placeholder editor, and banner-reveal timing
* constants. None of these close over channel state. Log-derived presentation
* (transcript rows, compaction markers, reference cards) belongs to the fold in
* `core/nodes.ts`, not here.
* @module @deepseek-ai/dsh-tui/chat/helpers
*/
/** The glyph pi-tui rules the editor's top and bottom frame rows with. */
const EDITOR_FRAME_GLYPH = "─";
/**
* Entries pi-tui's own editor history keeps ({@link Editor.addToHistory} pops
* past it), mirrored here so the two never disagree on which prompt is oldest.
*/
const HISTORY_LIMIT = 100;
/**
* Editor that carries its prompt inside the frame and shows a placeholder
* without making it editable content.
*
* Two pi-tui 0.84.1 render facts are load-bearing here, both pinned by
* `tests/unit/editor-prompt.test.ts` so an upgrade that moves them fails loudly:
*
* - `Editor.render(width)` returns `[top frame, ...content rows, bottom frame,
*   ...autocomplete rows]`. Row 0 is a rule (`─` repeated, or a `─── ↑ N more`
*   scroll indicator), never text, so the first content row is row 1.
* - Every content and autocomplete row opens with the editor's `paddingX`
*   spaces. With `paddingX >= 1` — what the mounted editor is constructed with —
*   a row whose first visible column is `─` can only be a frame row, which is
*   how the two rules are found among rows this class has to indent instead.
*/
var HintEditor = class extends Editor {
	/** Placeholder shown in the empty input row; `undefined` hides it. */
	hint;
	/**
	* Prompt rendered at the start of the first content row (Claude's `❯ `), ANSI
	* allowed. Continuation rows and the autocomplete popup indent by its visible
	* width and both rules grow by the same amount, so the frame keeps the full
	* render width and the text column never moves between rows.
	*/
	promptPrefix = "";
	/**
	* Every prompt this editor has been given, newest first, under pi-tui's own
	* history rules (see {@link HintEditor.addToHistory}).
	*
	* pi-tui keeps its history private and exports no reader (`Editor.history` is
	* `private`, `EditorOptions` takes no seed), so the reverse-incremental search
	* Ctrl+R runs has to search a mirror. Feeding both from the one override is
	* what keeps the mirror and the arrow keys' history from disagreeing about
	* which prompt is the most recent.
	*/
	entries = [];
	/**
	* The prompt history, newest first.
	*
	* Named around the parent's private `history` field rather than after it: an
	* instance field shadows a subclass method of the same name, so a `history()`
	* accessor here would be replaced by pi-tui's own array at construction.
	* @returns The mirrored entries; the array is the editor's own, so callers read it.
	*/
	historyEntries() {
		return this.entries;
	}
	/**
	* Record a submitted prompt, in pi-tui's history and in the searchable mirror.
	*
	* Deliberately duplicates the parent's three rules rather than approximating
	* them: entries are trimmed, blank ones are dropped, and a prompt equal to the
	* newest entry is not stored twice. A mirror that kept an entry the parent
	* dropped would make Ctrl+R offer a prompt the up arrow cannot reach.
	* @param text - The submitted prompt.
	*/
	addToHistory(text) {
		super.addToHistory(text);
		const trimmed = text.trim();
		if (trimmed === "" || this.entries[0] === trimmed) return;
		this.entries.unshift(trimmed);
		if (this.entries.length > HISTORY_LIMIT) this.entries.pop();
	}
	render(width) {
		const prefixWidth = visibleWidth(this.promptPrefix);
		const padding = this.getPaddingX();
		let absorbed = stripTerminalSequences(this.promptPrefix).endsWith(" ") ? Math.min(1, padding) : 0;
		let inner = width - prefixWidth + absorbed;
		if (absorbed > 0 && Math.floor(Math.max(0, inner - 1) / 2) < padding) {
			absorbed = 0;
			inner = width - prefixWidth;
		}
		if (prefixWidth === 0 || inner < 1) return this.renderFrame(width);
		const lines = this.renderFrame(inner);
		const indent = " ".repeat(prefixWidth - absorbed);
		const fill = this.borderColor(EDITOR_FRAME_GLYPH.repeat(prefixWidth - absorbed));
		return lines.map((line, index) => {
			if (index === 0 || stripTerminalSequences(line).startsWith(EDITOR_FRAME_GLYPH)) return `${line}${fill}`;
			return index === 1 ? `${this.promptPrefix}${line.slice(absorbed)}` : `${indent}${line}`;
		});
	}
	/**
	* Render the editor frame, replacing the sole content row with the placeholder
	* while the input is empty.
	* @param width - Columns the frame occupies, with the prompt already deducted.
	* @returns The rendered rows, prompt not yet applied.
	*/
	renderFrame(width) {
		const lines = super.render(width);
		if (this.hint === void 0 || this.getText() !== "") return lines;
		const padding = " ".repeat(this.getPaddingX());
		/* v8 ignore next -- the mounted editor is focused whenever its empty-input hint is rendered. */
		const marker = this.focused ? CURSOR_MARKER : "";
		const available = Math.max(0, width - visibleWidth(padding));
		const placeholder = truncateToWidth(this.hint, available, "");
		const used = visibleWidth(padding) + visibleWidth(placeholder);
		lines[1] = `${padding}${marker}${placeholder}${" ".repeat(Math.max(0, width - used))}`;
		return lines;
	}
};
/**
* Format the session working directory as a prompt label: `~` for home,
* `~/rel` for a home-relative path, the raw path otherwise.
* @param cwd - operational working directory from the session header.
* @returns unescaped prompt label.
*/
function formatCwd(cwd) {
	if (cwd === void 0) return "cwd unset";
	const home = homedir();
	const rel = relative(resolve(home), resolve(cwd));
	if (rel === "") return "~";
	/* v8 ignore next -- Windows cross-drive coverage; POSIX relative() cannot return an absolute path. */
	if (isAbsolute(rel)) return cwd;
	if (rel !== ".." && !rel.startsWith(`..${sep}`)) return `~${sep}${rel}`;
	return cwd;
}
/**
* Shorten a file path the way Claude Code's `getDisplayPath` does: relative to
* the workspace when it is inside it, `~`-notated when it is under home, and
* otherwise left absolute. A row that names a file the user just read should
* read as the path they would type, not as the machine's copy of it.
* @param path - the path to shorten; a relative one is returned unchanged.
* @param cwd - operational working directory the path is shown against.
* @returns the display form of the path.
*/
function displayPath(path, cwd) {
	if (!isAbsolute(path)) return path;
	const rel = relative(resolve(cwd), resolve(path));
	if (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)) return rel;
	const home = homedir();
	if (path.startsWith(home + sep)) return `~${path.slice(home.length)}`;
	return path;
}
/**
* Resolve the current Git branch for the prompt context line.
* @param cwd - operational working directory to query.
* @returns branch name, or `undefined` outside a worktree or on any failure.
*/
function gitBranch(cwd) {
	try {
		const branch = execFileSync("git", ["branch", "--show-current"], {
			cwd,
			encoding: "utf8",
			env: scrubbedParentEnv(),
			stdio: [
				"ignore",
				"pipe",
				"ignore"
			],
			timeout: 1e3
		}).trim();
		/* v8 ignore next -- detached-HEAD behavior is exercised by the runtime smoke, not the unit checkout. */
		return branch === "" ? void 0 : branch;
	} catch (_gitUnavailableOrOutsideWorktree) {
		return;
	}
}
/** Prefix the runner mints session ids with (`session-<uuid>`). */
const SESSION_ID_PREFIX = "session-";
/** A minted session id's random part, the only ids worth shortening. */
const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
/**
* Shorten a session id for the resume banner line: `session-<uuid>` becomes the
* uuid's first group, which is what a user types back into `--resume` and what
* the session directory is named after. Any other identity (`main`, a launcher's
* fixed name) is already short and is left exactly as it is.
* @param id - the session identity.
* @returns the display form of the id.
*/
function shortSessionId(id) {
	const bare = id.startsWith(SESSION_ID_PREFIX) ? id.slice(8) : id;
	return SESSION_UUID.test(bare) ? bare.slice(0, 8) : bare;
}
/** The launcher flag that names the booted profile, in both spellings it accepts. */
const PROFILE_FLAG = "--profile";
/**
* The profile this process was booted with, read back off its own command line.
*
* The launcher parses `--profile` itself and hands the app only the arguments
* after it, so the name reaches no service this bundle can inject: `process.argv`
* is the one place it survives. A run started some other way (an embedding host,
* a test) has no `--profile` in its argv and gets `undefined` — the caller then
* prints a command without the flag rather than inventing a profile name that
* would not exist on this machine.
* @param argv - the process command line; injectable so the parse can be tested.
* @returns the profile name, or `undefined` when the invocation named none.
*/
function launchProfileName(argv = process.argv) {
	for (const [index, argument] of argv.entries()) {
		if (argument.startsWith(`${PROFILE_FLAG}=`)) {
			const name = argument.slice(10);
			return name === "" ? void 0 : name;
		}
		if (argument !== PROFILE_FLAG) continue;
		const name = argv[index + 1];
		return name === void 0 || name === "" || name.startsWith("-") ? void 0 : name;
	}
}
/**
* The command that brings this exact session back, as the exiting terminal
* prints it.
*
* The full session id, not the banner's shortened one: this line is meant to be
* copied into a shell weeks later, where an abbreviation is a guess about how
* the store resolves prefixes.
* @param sessionId - the session the command would resume.
* @param profile - the booted profile; absent drops the flag from the command.
* @returns the command line, ready to paste.
*/
function resumeCommandLine(sessionId, profile = launchProfileName()) {
	return [
		"dsh",
		...profile === void 0 ? [] : [PROFILE_FLAG, profile],
		"--resume",
		sessionId
	].join(" ");
}
/** Directory levels searched upward for this bundle's own package.json. */
const PACKAGE_SEARCH_DEPTH = 4;
/**
* This bundle's version, for the startup banner.
*
* Read from the nearest package.json above the running module rather than
* imported, because the two layouts this code runs in disagree on the relative
* path: `src/chat/helpers.ts` under tsx, one bundled `lib/index.js` after
* build. Neither layout has a package.json between the module and the package
* root, so the first one found walking up is this package's. A version that
* cannot be read is not an error — the banner simply omits it.
* @param from - file the search starts from; defaults to this module.
* @returns the semver string, or `undefined` when no package.json was readable.
*/
function packageVersion(from = fileURLToPath(import.meta.url)) {
	let directory = dirname(from);
	for (let level = 0; level < PACKAGE_SEARCH_DEPTH; level += 1) {
		try {
			const parsed = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
			if (typeof parsed.version === "string" && parsed.version !== "") return parsed.version;
		} catch (_missingOrUnreadablePackage) {}
		const parent = dirname(directory);
		/* v8 ignore next -- the walk always finds this package before the filesystem root. */
		if (parent === directory) break;
		directory = parent;
	}
}
/**
* How much of the wordmark the sweep has uncovered after `frame` frames.
*
* A pure function of the frame and the width it is asked about, so the caller
* can re-read the terminal every frame: the sweep is always the same fraction of
* the CURRENT width, and a terminal resized mid-sweep stays aligned instead of
* wiping toward the width the animation started at.
* @param frame - Frames elapsed since the sweep began, starting at 1.
* @param columns - The terminal's current width.
* @returns Columns revealed, never past the width itself.
*/
function bannerRevealWidth(frame, columns) {
	const total = Math.max(1, columns);
	return Math.min(total, Math.max(1, Math.ceil(total / 24)) * frame);
}
//#endregion
//#region src/components/xml-tool-output.ts
/**
* Conservative readable-tree rendering for model-facing text containing one XML
* document, used by the transcript's tool cards for unknown tool results. Injected
* context is prose and is not parsed; only {@link preview} is shared with its card.
* @module @deepseek-ai/dsh-tui/components/xml-tool-output
*/
function parseXml(source, display) {
	const parser = new SaxesParser({ xmlns: false });
	const stack = [];
	let root;
	const state = { invalid: false };
	const reject = () => {
		state.invalid = true;
	};
	parser.on("opentag", (tag) => {
		const element = {
			name: tag.name,
			attributes: Object.entries(tag.attributes).map(([name, value]) => ({
				name,
				value: display(value)
			})),
			children: []
		};
		const parent = stack.at(-1);
		if (parent === void 0) {
			if (root !== void 0) reject();
			root = element;
		} else parent.children.push(element);
		stack.push(element);
	});
	parser.on("text", (text) => {
		const parent = stack.at(-1);
		if (parent === void 0) {
			if (text.trim() !== "") reject();
		} else parent.children.push(display(text));
	});
	parser.on("cdata", (text) => {
		const parent = stack.at(-1);
		if (parent === void 0) reject();
		else parent.children.push(display(text));
	});
	parser.on("closetag", () => {
		stack.pop();
	});
	parser.on("xmldecl", reject);
	parser.on("processinginstruction", reject);
	parser.on("doctype", reject);
	parser.on("comment", reject);
	parser.on("error", reject);
	parser.write(source).close();
	return state.invalid ? void 0 : root;
}
function elementLabel(element) {
	const attributes = element.attributes.map((attribute) => `${attribute.name}=${JSON.stringify(attribute.value)}`).join(" ");
	return attributes === "" ? element.name : `${element.name} (${attributes})`;
}
function meaningfulChildren(element) {
	return element.children.filter((child) => typeof child !== "string" || child.trim() !== "");
}
function textBlock(text, depth, body) {
	return text.replace(/^\n|\n$/gu, "").split("\n").map((line) => line === "" ? line : `${"  ".repeat(depth)}${body(line)}`);
}
function treeLines(element, depth, label, body) {
	const indent = "  ".repeat(depth);
	const children = meaningfulChildren(element);
	if (children.length === 0) return [`${indent}${label(elementLabel(element))}`];
	if (children.length === 1 && typeof children[0] === "string" && !children[0].includes("\n")) return [`${indent}${label(`${elementLabel(element)}:`)} ${body(children[0].trim())}`];
	const lines = [`${indent}${label(elementLabel(element))}`];
	for (const child of children) if (typeof child === "string") lines.push(...textBlock(child, depth + 1, body));
	else lines.push(...treeLines(child, depth + 1, label, body));
	return lines;
}
/**
* Collapse `lines` to a head/tail preview around one omitted-count marker.
* The single fold rule for every transcript card, so a card's fold never depends
* on how its body was rendered: tool cards share it with their tree output and
* context cards apply it to prose rows.
* @param lines - Fully rendered body rows.
* @param limit - Maximum retained rows, excluding the marker.
* @param omitted - Renders the marker for the omitted row count.
* @returns `lines` unchanged when within `limit`, else head rows, the marker, and tail rows.
*/
function preview(lines, limit, omitted) {
	if (lines.length <= limit) return [...lines];
	const head = Math.ceil(limit / 2);
	const tail = limit - head;
	return [
		...lines.slice(0, head),
		omitted(lines.length - limit),
		...lines.slice(lines.length - tail)
	];
}
/**
* Render a complete XML document as an indented tree, or decline without changing partial/mixed text.
* @param source - Raw model-facing text from an unknown tool result.
* @param maxChildLines - Collapsed budget independently applied to each top-level child's lines and
* to the number of top-level children, so many siblings cannot grow the collapsed card without bound.
* @param expanded - Whether to retain every rendered child line.
* @param display - Escapes parsed text and attribute values for terminal output; character references
* can expand to control characters that pre-parse escaping never saw.
* @param label - Styles element names and attributes.
* @param body - Styles the text content under those elements; the card's body tone, so tree
* content matches the surrounding card rows instead of falling back to the default foreground.
* @param omitted - Renders the omitted-line marker for a collapsed child or child range.
* @returns Tree rows, or `undefined` when `source` is not one supported complete XML document.
*/
function renderUnknownXml(source, maxChildLines, expanded, display, label, body, omitted) {
	const root = parseXml(source, display);
	if (root === void 0) return void 0;
	const blocks = meaningfulChildren(root).map((child) => typeof child === "string" ? textBlock(child, 1, body) : treeLines(child, 1, label, body));
	const rootLine = label(elementLabel(root));
	if (expanded) return [rootLine, ...blocks.flat()];
	const previewed = blocks.map((block) => preview(block, maxChildLines, omitted));
	if (previewed.length <= maxChildLines) return [rootLine, ...previewed.flat()];
	const head = Math.ceil(maxChildLines / 2);
	const tail = maxChildLines - head;
	const hidden = blocks.slice(head, blocks.length - tail).reduce((total, block) => total + block.length, 0);
	return [
		rootLine,
		...previewed.slice(0, head).flat(),
		omitted(hidden),
		...previewed.slice(previewed.length - tail).flat()
	];
}
/** Minimum per-side code width for the split view to stay readable. */
const SPLIT_MIN_CODE_WIDTH = 60;
/** Split is abandoned when this share of visible rows would soft-wrap. */
const SPLIT_MAX_WRAP_RATIO = .2;
/** Split is abandoned when this many visible rows would soft-wrap. */
const SPLIT_MAX_WRAP_LINES = 8;
/** Default row budget for the split view. */
const MAX_PREVIEW_LINES = 60;
/** Default row budget for the unified view, and the cap on highlightable rows. */
const MAX_RENDER_LINES = 150;
/** Text beyond this size is never syntax-highlighted. */
const MAX_HL_CHARS = 32e3;
/** Below this similarity a changed pair renders as whole-line add/remove, not a word diff. */
const WORD_DIFF_MIN_SIM = .15;
/** Soft-wrap row budgets by terminal width. */
const MAX_WRAP_ROWS_WIDE = 3;
const MAX_WRAP_ROWS_MED = 2;
const MAX_WRAP_ROWS_NARROW = 1;
/** Full SGR reset. Every diff row owns its line, so resetting all groups is safe. */
const D_RST = RESET;
const D_BOLD = "\x1B[1m";
const D_DIM = "\x1B[2m";
const BG_ADD = bgAnsi(CLAUDE_COLORS.diffAddedBg);
const BG_DEL = bgAnsi(CLAUDE_COLORS.diffRemovedBg);
const BG_ADD_W = bgAnsi(CLAUDE_COLORS.diffAddedWordBg);
const BG_DEL_W = bgAnsi(CLAUDE_COLORS.diffRemovedWordBg);
const BG_GUTTER_ADD = BG_ADD;
const BG_GUTTER_DEL = BG_DEL;
/** Unfilled cells keep the terminal's own background. */
const BG_BASE = BG_DEFAULT;
const BG_EMPTY = BG_DEFAULT;
const FG_ADD = fgAnsi(CLAUDE_COLORS.diffAddedFg);
const FG_DEL = fgAnsi(CLAUDE_COLORS.diffRemovedFg);
const FG_DIM = fgAnsi(CLAUDE_COLORS.diffDim);
const FG_LNUM = fgAnsi(CLAUDE_COLORS.diffLineNumber);
const FG_RULE = fgAnsi(CLAUDE_COLORS.diffRule);
const FG_STRIPE = fgAnsi(CLAUDE_COLORS.diffStripe);
fgAnsi(CLAUDE_COLORS.diffSafeMuted);
const DIVIDER = `${FG_RULE}│${D_RST}`;
/** Strip SGR sequences for width math. */
function diffStrip(value) {
	return value.replaceAll(/\x1b\[[0-9;]*m/gu, "");
}
/** Render tabs as two spaces so a gutter-aligned layout stays aligned. */
function tabs(text) {
	return text.replaceAll("	", "  ");
}
/** Soft-wrap row budget for a width: wide terminals allow more continuation rows. */
function adaptiveWrapRows(width) {
	if (width >= 180) return MAX_WRAP_ROWS_WIDE;
	if (width >= 120) return MAX_WRAP_ROWS_MED;
	return MAX_WRAP_ROWS_NARROW;
}
/** Pad or clip an ANSI-carrying value to exactly `width` visible columns. */
function fit(value, width) {
	if (width <= 0) return "";
	const plain = diffStrip(value);
	if (plain.length <= width) return value + " ".repeat(width - plain.length);
	const showWidth = width > 2 ? width - 1 : width;
	let visible = 0;
	let index = 0;
	while (index < value.length && visible < showWidth) {
		if (value[index] === "\x1B") {
			const end = value.indexOf("m", index);
			if (end !== -1) {
				index = end + 1;
				continue;
			}
		}
		visible += 1;
		index += 1;
	}
	return width > 2 ? `${value.slice(0, index)}${D_RST}${FG_DIM}›${D_RST}` : `${value.slice(0, index)}${D_RST}`;
}
/** The foreground/background state a row ends in, replayed to open its next row. */
function ansiState(text) {
	const matches = text.match(/\x1b\[[0-9;]*m/gu) ?? [];
	let foreground = "";
	let background = "";
	for (const sequence of matches) {
		const params = sequence.slice(2, -1);
		if (params === "0") {
			foreground = "";
			background = "";
		} else if (params === "39") foreground = "";
		else if (params.startsWith("38;")) foreground = sequence;
		else if (params.startsWith("48;")) background = sequence;
	}
	return background + foreground;
}
/**
* Wrap ANSI text to `width`, padding each row with `fillBg` so a background fill
* runs to the margin, and clipping with a `›` once `maxRows` is reached.
*/
function wrapAnsi(text, width, maxRows, fillBg = "") {
	if (width <= 0) return [""];
	const plain = diffStrip(text);
	if (plain.length <= width) {
		const pad = width - plain.length;
		return pad > 0 ? [text + fillBg + " ".repeat(pad) + (fillBg === "" ? "" : D_RST)] : [text];
	}
	const rows = [];
	let row = "";
	let visible = 0;
	let index = 0;
	let onLastRow = false;
	let effectiveWidth = width;
	while (index < text.length) {
		if (!onLastRow && rows.length >= maxRows - 1) {
			onLastRow = true;
			effectiveWidth = width > 2 ? width - 1 : width;
		}
		if (text[index] === "\x1B") {
			const end = text.indexOf("m", index);
			if (end !== -1) {
				row += text.slice(index, end + 1);
				index = end + 1;
				continue;
			}
		}
		if (visible >= effectiveWidth) {
			if (onLastRow) {
				let hasMore = false;
				for (let scan = index; scan < text.length; scan += 1) {
					if (text[scan] === "\x1B") {
						const end = text.indexOf("m", scan);
						if (end !== -1) {
							scan = end;
							continue;
						}
					}
					hasMore = true;
					break;
				}
				if (hasMore && width > 2) row += `${D_RST}${FG_DIM}›${D_RST}`;
				else row += fillBg + " ".repeat(Math.max(0, width - visible)) + D_RST;
				rows.push(row);
				return rows;
			}
			const state = ansiState(row);
			rows.push(row + D_RST);
			row = state + fillBg;
			visible = 0;
			if (rows.length >= maxRows - 1) {
				onLastRow = true;
				effectiveWidth = width > 2 ? width - 1 : width;
			}
		}
		row += text[index] ?? "";
		visible += 1;
		index += 1;
	}
	if (row.length > 0 || rows.length === 0) rows.push(row + fillBg + " ".repeat(Math.max(0, width - visible)) + D_RST);
	return rows;
}
/** A right-aligned gutter line number; the caller resets after the whole cell. */
function lnum(value, width, foreground = FG_LNUM) {
	if (value === null) return " ".repeat(width);
	const text = String(value);
	return `${foreground}${" ".repeat(Math.max(0, width - text.length))}${text}`;
}
/** The `╱` fill marking a side that has no counterpart row. */
function stripes(width) {
	return BG_BASE + FG_STRIPE + "╱".repeat(width) + D_RST;
}
/** A full-width horizontal rule framing a diff body. */
function diffRule(width) {
	return `${BG_BASE}${FG_RULE}${"─".repeat(width)}${D_RST}`;
}
/**
* The largest line number any row carries. Loop-based rather than
* `Math.max(...spread)` so a huge diff cannot blow the call stack.
*/
function maxLineNumber(lines) {
	let max = 0;
	for (const line of lines) {
		const value = line.oldNum ?? line.newNum ?? 0;
		if (value > max) max = value;
	}
	return max;
}
/**
* The add/remove proportion bar shown beside a change summary.
* @param added - Added row count.
* @param removed - Removed row count.
* @param width - Available width; below 20 columns the bar is dropped.
* @returns The bar, or `''` when there is nothing to show.
*/
function renderDiffStatBar(added, removed, width = 80) {
	const total = added + removed;
	if (total === 0 || width < 20) return "";
	const slots = Math.max(8, Math.min(20, Math.floor(width / 14)));
	let addSlots = Math.max(0, Math.min(slots, Math.round(added / total * slots)));
	if (added > 0 && addSlots === 0) addSlots = 1;
	if (removed > 0 && addSlots >= slots) addSlots = slots - 1;
	const removeSlots = Math.max(0, slots - addSlots);
	const addBar = addSlots > 0 ? `${FG_ADD}${"━".repeat(addSlots)}${D_RST}` : "";
	const removeBar = removeSlots > 0 ? `${FG_DEL}${"━".repeat(removeSlots)}${D_RST}` : "";
	return `${FG_DIM}[${D_RST}${addBar}${removeBar}${FG_DIM}]${D_RST}`;
}
/**
* A one-line change summary: `+A -R` followed by the proportion bar.
* @param added - Added row count.
* @param removed - Removed row count.
* @param width - Available width, passed to {@link renderDiffStatBar}.
* @returns The summary text.
*/
function summarizeDiff(added, removed, width = 80) {
	const parts = [];
	if (added > 0) parts.push(`${FG_ADD}+${added}${D_RST}`);
	if (removed > 0) parts.push(`${FG_DEL}-${removed}${D_RST}`);
	if (parts.length === 0) return `${FG_DIM}no changes${D_RST}`;
	const bar = renderDiffStatBar(added, removed, width);
	return bar === "" ? parts.join(" ") : `${parts.join(" ")} ${bar}`;
}
/**
* The clip marker under a truncated diff, degrading through shorter phrasings
* until one fits the available width.
* @param remainingLines - Rows the render dropped.
* @param hiddenHunks - Hunks the render dropped entirely.
* @param width - Available width.
* @param toggleHint - Key hint appended to the longest phrasing.
* @returns The marker text, always within `width`.
*/
function collapsedDiffHint(remainingLines, hiddenHunks, width = 80, toggleHint = "ctrl+o to toggle") {
	const candidates = [
		`… (${remainingLines} more diff lines${hiddenHunks > 0 ? ` • ${hiddenHunks} more hunks` : ""} • ${toggleHint})`,
		`… (${remainingLines} more lines${hiddenHunks > 0 ? ` • ${hiddenHunks} hunks` : ""})`,
		`… (+${remainingLines}${hiddenHunks > 0 ? ` • +${hiddenHunks}h` : ""})`,
		"…"
	];
	for (const candidate of candidates) if (visibleWidth(candidate) <= width) return candidate;
	return truncateToWidth("…", width, "");
}
/**
* Whether a diff should render side-by-side at this width: wide enough for two
* readable code columns, and few enough long rows that the split would not
* degenerate into wrapped fragments.
* @param diff - The parsed diff.
* @param width - Available width.
* @param maxRows - Row budget the caller will render.
* @returns `true` when the split layout applies.
*/
function shouldUseSplit(diff, width, maxRows = MAX_PREVIEW_LINES) {
	if (diff.lines.length === 0) return false;
	if (width < 150) return false;
	const numberWidth = Math.max(2, String(maxLineNumber(diff.lines)).length);
	const half = Math.floor((width - 1) / 2);
	const codeWidth = Math.max(12, half - (numberWidth + 5));
	if (codeWidth < SPLIT_MIN_CODE_WIDTH) return false;
	let contentLines = 0;
	let wrapCandidates = 0;
	for (const line of diff.lines.slice(0, maxRows)) {
		if (line.type === "sep") continue;
		contentLines += 1;
		if (tabs(line.content).length > codeWidth) wrapCandidates += 1;
	}
	if (contentLines === 0) return true;
	if (wrapCandidates >= SPLIT_MAX_WRAP_LINES) return false;
	return wrapCandidates / contentLines < SPLIT_MAX_WRAP_RATIO;
}
/** Shiki language ids keyed by lowercase file extension. */
const EXTENSION_LANGUAGES = {
	ts: "typescript",
	mts: "typescript",
	cts: "typescript",
	tsx: "tsx",
	js: "javascript",
	mjs: "javascript",
	cjs: "javascript",
	jsx: "jsx",
	py: "python",
	rb: "ruby",
	rs: "rust",
	go: "go",
	java: "java",
	c: "c",
	h: "c",
	cpp: "cpp",
	hpp: "cpp",
	cs: "csharp",
	swift: "swift",
	kt: "kotlin",
	html: "html",
	css: "css",
	scss: "scss",
	json: "json",
	yaml: "yaml",
	yml: "yaml",
	toml: "toml",
	md: "markdown",
	sh: "bash",
	bash: "bash",
	zsh: "bash",
	sql: "sql",
	xml: "xml",
	lua: "lua",
	php: "php",
	vue: "vue",
	svelte: "svelte",
	graphql: "graphql"
};
/**
* The syntax-highlighting language for a file path.
* @param path - The file path.
* @returns A shiki language id, or `undefined` when the extension maps to none.
*/
function diffLanguage(path) {
	const base = path.split("/").pop()?.toLowerCase() ?? "";
	if (base === "dockerfile") return "docker";
	if (base === "makefile") return "make";
	const extension = base.includes(".") ? base.split(".").pop() ?? "" : "";
	return EXTENSION_LANGUAGES[extension];
}
/**
* {@link parseDiff} under an edit-distance budget: a comparison that would need
* more than `maxEditLength` changed lines declines rather than stalling the UI
* on a model-authored pending edit.
* @param oldContent - The prior file text.
* @param newContent - The new file text.
* @param maxEditLength - Changed-line budget for the comparison.
* @param contextLines - Context rows kept around each change.
* @returns The parsed diff, or `undefined` when the comparison exceeded the budget.
*/
function parseDiffBounded(oldContent, newContent, maxEditLength, contextLines = 3) {
	const patch = structuredPatch("", "", oldContent, newContent, "", "", {
		context: contextLines,
		maxEditLength
	});
	if (patch === void 0) return void 0;
	return fromPatch(patch.hunks, oldContent.length + newContent.length);
}
/** Walk a structured patch's hunks into diff rows, inserting a `sep` per collapsed gap. */
function fromPatch(hunks, chars) {
	const lines = [];
	let added = 0;
	let removed = 0;
	for (const [hunkIndex, hunk] of hunks.entries()) {
		const previous = hunkIndex > 0 ? hunks[hunkIndex - 1] : void 0;
		if (previous !== void 0) {
			const gap = hunk.oldStart - (previous.oldStart + previous.oldLines);
			lines.push({
				type: "sep",
				oldNum: null,
				newNum: gap > 0 ? gap : null,
				content: ""
			});
		}
		let oldLine = hunk.oldStart;
		let newLine = hunk.newStart;
		for (const raw of hunk.lines) {
			if (raw === "\\ No newline at end of file") continue;
			const marker = raw[0];
			const text = raw.slice(1);
			if (marker === "+") {
				lines.push({
					type: "add",
					oldNum: null,
					newNum: newLine,
					content: text
				});
				newLine += 1;
				added += 1;
			} else if (marker === "-") {
				lines.push({
					type: "del",
					oldNum: oldLine,
					newNum: null,
					content: text
				});
				oldLine += 1;
				removed += 1;
			} else {
				lines.push({
					type: "ctx",
					oldNum: oldLine,
					newNum: newLine,
					content: text
				});
				oldLine += 1;
				newLine += 1;
			}
		}
	}
	return {
		lines,
		added,
		removed,
		chars
	};
}
/**
* Word-level comparison of a changed line pair: how similar the two sides are,
* and the character ranges that actually differ on each side.
* @param oldText - The removed line.
* @param newText - The added line.
* @returns Similarity in [0, 1] and the differing ranges per side.
*/
function wordDiffAnalysis(oldText, newText) {
	if (oldText === "" && newText === "") return {
		similarity: 1,
		oldRanges: [],
		newRanges: []
	};
	const parts = diffWords(oldText, newText);
	const oldRanges = [];
	const newRanges = [];
	let oldPos = 0;
	let newPos = 0;
	let same = 0;
	for (const part of parts) {
		const length = part.value.length;
		if (part.removed === true) {
			oldRanges.push([oldPos, oldPos + length]);
			oldPos += length;
		} else if (part.added === true) {
			newRanges.push([newPos, newPos + length]);
			newPos += length;
		} else {
			same += length;
			oldPos += length;
			newPos += length;
		}
	}
	const maxLength = Math.max(oldText.length, newText.length);
	return {
		similarity: maxLength > 0 ? same / maxLength : 1,
		oldRanges,
		newRanges
	};
}
/**
* Overlay a word-level background on already-highlighted text: the base fill
* everywhere, the highlight fill inside `ranges`, re-applied after every reset
* the highlighter emitted.
*/
function injectBg(ansiLine, ranges, baseBg, highlightBg) {
	if (ranges.length === 0) return baseBg + ansiLine + D_RST;
	let out = baseBg;
	let visible = 0;
	let inHighlight = false;
	let rangeIndex = 0;
	let index = 0;
	while (index < ansiLine.length) {
		if (ansiLine[index] === "\x1B") {
			const end = ansiLine.indexOf("m", index);
			if (end !== -1) {
				const sequence = ansiLine.slice(index, end + 1);
				out += sequence;
				if (sequence === "\x1B[0m") out += inHighlight ? highlightBg : baseBg;
				index = end + 1;
				continue;
			}
		}
		let range = ranges[rangeIndex];
		while (range !== void 0 && visible >= range[1]) {
			rangeIndex += 1;
			range = ranges[rangeIndex];
		}
		const want = range !== void 0 && visible >= range[0] && visible < range[1];
		if (want !== inHighlight) {
			inHighlight = want;
			out += inHighlight ? highlightBg : baseBg;
		}
		out += ansiLine[index] ?? "";
		visible += 1;
		index += 1;
	}
	return out + D_RST;
}
/** Word-level highlighting without a syntax highlighter: fills only, no code colors. */
function plainWordDiff(oldText, newText) {
	const parts = diffWords(oldText, newText);
	let oldOut = "";
	let newOut = "";
	for (const part of parts) if (part.removed === true) oldOut += `${BG_DEL_W}${part.value}${D_RST}${BG_DEL}`;
	else if (part.added === true) newOut += `${BG_ADD_W}${part.value}${D_RST}${BG_ADD}`;
	else {
		oldOut += part.value;
		newOut += part.value;
	}
	return {
		old: oldOut,
		new: newOut
	};
}
/** Highlight one side's joined source, falling back to its plain lines. */
function highlightSide(source, options, enabled) {
	if (!enabled || options.highlight === void 0) return source;
	return options.highlight(source.join("\n"), options.language) ?? source;
}
/**
* Render a diff as a unified view: one column, each changed row carrying its
* sign, its gutter number, and a full-width background fill, with word-level
* highlighting on a one-for-one changed pair.
* @param diff - The parsed diff.
* @param width - Available width in columns.
* @param options - Budgets, language, and highlighter.
* @returns The rendered rows.
*/
function renderUnified(diff, width, options = {}) {
	if (diff.lines.length === 0) return [];
	const max = options.maxLines ?? MAX_RENDER_LINES;
	const visible = diff.lines.slice(0, max);
	const numberWidth = Math.max(2, String(maxLineNumber(visible)).length);
	const codeWidth = Math.max(20, width - (numberWidth + 5));
	const wrapRows = adaptiveWrapRows(width);
	const canHighlight = diff.chars <= MAX_HL_CHARS && visible.length <= MAX_RENDER_LINES;
	const oldSource = [];
	const newSource = [];
	for (const line of visible) {
		if (line.type === "ctx" || line.type === "del") oldSource.push(line.content);
		if (line.type === "ctx" || line.type === "add") newSource.push(line.content);
	}
	const oldHighlighted = highlightSide(oldSource, options, canHighlight);
	const newHighlighted = highlightSide(newSource, options, canHighlight);
	let oldIndex = 0;
	let newIndex = 0;
	let index = 0;
	const out = [diffRule(width)];
	const emitRow = (num, sign, gutterBg, signFg, body, bodyBg = "") => {
		const borderFg = sign === "-" ? FG_DEL : sign === "+" ? FG_ADD : "";
		const border = borderFg === "" ? `${BG_BASE} ` : `${borderFg}▌${D_RST}`;
		const gutter = `${border}${gutterBg}${lnum(num, numberWidth, borderFg === "" ? FG_LNUM : borderFg)}${signFg}${sign} ${D_RST}${DIVIDER} `;
		const continuation = `${border}${gutterBg}${" ".repeat(numberWidth + 2)}${D_RST}${DIVIDER} `;
		const rows = wrapAnsi(tabs(body), codeWidth, wrapRows, bodyBg);
		out.push(`${gutter}${rows[0] ?? ""}${D_RST}`);
		for (const row of rows.slice(1)) out.push(`${continuation}${row}${D_RST}`);
	};
	while (index < visible.length) {
		const line = visible[index];
		if (line === void 0) break;
		if (line.type === "sep") {
			const gap = line.newNum;
			const label = gap !== null && gap > 0 ? ` ${gap} unmodified lines ` : "···";
			const pad = Math.max(0, Math.min(width, 72) - label.length - 2);
			const half = Math.floor(pad / 2);
			out.push(`${BG_BASE}${FG_DIM}${"─".repeat(half)}${label}${"─".repeat(pad - half)}${D_RST}`);
			index += 1;
			continue;
		}
		if (line.type === "ctx") {
			const highlighted = oldHighlighted[oldIndex] ?? line.content;
			emitRow(line.newNum, " ", BG_BASE, FG_DIM, `${BG_BASE}${D_DIM}${highlighted}`, BG_BASE);
			oldIndex += 1;
			newIndex += 1;
			index += 1;
			continue;
		}
		const removals = [];
		while (index < visible.length) {
			const candidate = visible[index];
			if (candidate === void 0 || candidate.type !== "del") break;
			removals.push({
				line: candidate,
				highlighted: oldHighlighted[oldIndex] ?? candidate.content
			});
			oldIndex += 1;
			index += 1;
		}
		const additions = [];
		while (index < visible.length) {
			const candidate = visible[index];
			if (candidate === void 0 || candidate.type !== "add") break;
			additions.push({
				line: candidate,
				highlighted: newHighlighted[newIndex] ?? candidate.content
			});
			newIndex += 1;
			index += 1;
		}
		const removal = removals.length === 1 ? removals[0] : void 0;
		const addition = additions.length === 1 ? additions[0] : void 0;
		const paired = removal !== void 0 && addition !== void 0 ? wordDiffAnalysis(removal.line.content, addition.line.content) : void 0;
		if (removal !== void 0 && addition !== void 0 && paired !== void 0 && paired.similarity >= WORD_DIFF_MIN_SIM) {
			if (canHighlight) {
				emitRow(removal.line.oldNum, "-", BG_GUTTER_DEL, `${FG_DEL}${D_BOLD}`, injectBg(removal.highlighted, paired.oldRanges, BG_DEL, BG_DEL_W), BG_DEL);
				emitRow(addition.line.newNum, "+", BG_GUTTER_ADD, `${FG_ADD}${D_BOLD}`, injectBg(addition.highlighted, paired.newRanges, BG_ADD, BG_ADD_W), BG_ADD);
			} else {
				const words = plainWordDiff(removal.line.content, addition.line.content);
				emitRow(removal.line.oldNum, "-", BG_GUTTER_DEL, `${FG_DEL}${D_BOLD}`, `${BG_DEL}${words.old}`, BG_DEL);
				emitRow(addition.line.newNum, "+", BG_GUTTER_ADD, `${FG_ADD}${D_BOLD}`, `${BG_ADD}${words.new}`, BG_ADD);
			}
			continue;
		}
		for (const entry of removals) {
			const body = canHighlight ? entry.highlighted : entry.line.content;
			emitRow(entry.line.oldNum, "-", BG_GUTTER_DEL, `${FG_DEL}${D_BOLD}`, `${BG_DEL}${body}`, BG_DEL);
		}
		for (const entry of additions) {
			const body = canHighlight ? entry.highlighted : entry.line.content;
			emitRow(entry.line.newNum, "+", BG_GUTTER_ADD, `${FG_ADD}${D_BOLD}`, `${BG_ADD}${body}`, BG_ADD);
		}
	}
	out.push(diffRule(width));
	if (diff.lines.length > visible.length) {
		const hint = collapsedDiffHint(diff.lines.length - visible.length, 0, width, options.toggleHint);
		out.push(`${BG_BASE}${FG_DIM}  ${hint}${D_RST}`);
	}
	return out;
}
/**
* Render a diff side by side, old on the left and new on the right. Falls back
* to {@link renderUnified} whenever the width or the row shapes make the split
* unreadable ({@link shouldUseSplit}), so a caller can always ask for it.
* @param diff - The parsed diff.
* @param width - Available width in columns; below {@link SPLIT_MIN_WIDTH} this delegates.
* @param options - Budgets, language, and highlighter.
* @returns The rendered rows.
*/
function renderSplit(diff, width, options = {}) {
	const max = options.maxLines ?? MAX_PREVIEW_LINES;
	if (!shouldUseSplit(diff, width, max)) return renderUnified(diff, width, options);
	if (diff.lines.length === 0) return [];
	const rows = [];
	let cursor = 0;
	while (cursor < diff.lines.length) {
		const line = diff.lines[cursor];
		if (line === void 0) break;
		if (line.type === "sep" || line.type === "ctx") {
			rows.push({
				left: line,
				right: line
			});
			cursor += 1;
			continue;
		}
		const removals = [];
		const additions = [];
		while (cursor < diff.lines.length) {
			const candidate = diff.lines[cursor];
			if (candidate === void 0 || candidate.type !== "del") break;
			removals.push(candidate);
			cursor += 1;
		}
		while (cursor < diff.lines.length) {
			const candidate = diff.lines[cursor];
			if (candidate === void 0 || candidate.type !== "add") break;
			additions.push(candidate);
			cursor += 1;
		}
		for (let pair = 0; pair < Math.max(removals.length, additions.length); pair += 1) rows.push({
			left: removals[pair] ?? null,
			right: additions[pair] ?? null
		});
	}
	const visible = rows.slice(0, max);
	const half = Math.floor((width - 1) / 2);
	const numberWidth = Math.max(2, String(maxLineNumber(diff.lines)).length);
	const codeWidth = Math.max(12, half - (numberWidth + 5));
	const wrapRows = adaptiveWrapRows(width);
	const canHighlight = diff.chars <= MAX_HL_CHARS;
	const leftSource = [];
	const rightSource = [];
	for (const row of visible) {
		if (row.left !== null && row.left.type !== "sep") leftSource.push(row.left.content);
		if (row.right !== null && row.right.type !== "sep") rightSource.push(row.right.content);
	}
	const leftHighlighted = highlightSide(leftSource, options, canHighlight);
	const rightHighlighted = highlightSide(rightSource, options, canHighlight);
	let leftIndex = 0;
	let rightIndex = 0;
	const halfBuild = (line, highlighted, ranges, side) => {
		if (line === null) {
			const gutter = ` ${FG_STRIPE}${"╱".repeat(numberWidth + 2)}${D_RST}${FG_RULE}│${D_RST} `;
			return {
				gutter,
				contGutter: gutter,
				bodyRows: [stripes(codeWidth)]
			};
		}
		if (line.type === "sep") {
			const gap = line.newNum;
			const label = gap !== null && gap > 0 ? `··· ${gap} lines ···` : "···";
			const gutter = `${BG_BASE} ${FG_DIM}${fit("", numberWidth + 2)}${D_RST}${FG_RULE}│${D_RST} `;
			return {
				gutter,
				contGutter: gutter,
				bodyRows: [`${BG_BASE}${FG_DIM}${fit(label, codeWidth)}${D_RST}`]
			};
		}
		const isDel = line.type === "del";
		const isAdd = line.type === "add";
		const gutterBg = isDel ? BG_GUTTER_DEL : isAdd ? BG_GUTTER_ADD : BG_BASE;
		const bodyBg = isDel ? BG_DEL : isAdd ? BG_ADD : BG_BASE;
		const signFg = isDel ? FG_DEL : isAdd ? FG_ADD : FG_DIM;
		const sign = isDel ? "-" : isAdd ? "+" : " ";
		const num = isDel ? line.oldNum : isAdd ? line.newNum : side === "left" ? line.oldNum : line.newNum;
		const borderFg = isDel ? FG_DEL : isAdd ? FG_ADD : "";
		const border = borderFg === "" ? ` ${BG_BASE}` : `${borderFg}▌${D_RST}`;
		const numberFg = borderFg === "" ? FG_LNUM : borderFg;
		const body = ranges !== null && ranges.length > 0 ? injectBg(highlighted, ranges, bodyBg, isDel ? BG_DEL_W : BG_ADD_W) : isDel || isAdd ? `${bodyBg}${highlighted}` : `${BG_BASE}${D_DIM}${highlighted}`;
		return {
			gutter: `${border}${gutterBg}${lnum(num, numberWidth, numberFg)}${signFg}${D_BOLD}${sign} ${D_RST}${FG_RULE}│${D_RST} `,
			contGutter: `${border}${gutterBg}${" ".repeat(numberWidth + 2)}${D_RST}${FG_RULE}│${D_RST} `,
			bodyRows: wrapAnsi(tabs(body), codeWidth, wrapRows, bodyBg)
		};
	};
	const out = [];
	const headerOld = `${BG_BASE}${" ".repeat(Math.max(0, numberWidth - 2))}${FG_DEL}${D_DIM}old${D_RST}`;
	const headerNew = `${BG_BASE}${" ".repeat(Math.max(0, numberWidth - 2))}${FG_ADD}${D_DIM}new${D_RST}`;
	out.push(`${BG_BASE}${headerOld}${" ".repeat(Math.max(0, half - numberWidth - 1))}${FG_RULE}┊${D_RST}${headerNew}`);
	out.push(`${diffRule(half)}${FG_RULE}┊${D_RST}${diffRule(half)}`);
	for (const row of visible) {
		const { left, right } = row;
		const paired = left !== null && right !== null && left.type === "del" && right.type === "add" ? wordDiffAnalysis(left.content, right.content) : void 0;
		let leftResult;
		let rightResult;
		if (left !== null && right !== null && paired !== void 0 && paired.similarity >= WORD_DIFF_MIN_SIM) {
			if (canHighlight) {
				leftResult = halfBuild(left, leftHighlighted[leftIndex] ?? left.content, paired.oldRanges, "left");
				rightResult = halfBuild(right, rightHighlighted[rightIndex] ?? right.content, paired.newRanges, "right");
			} else {
				const words = plainWordDiff(left.content, right.content);
				leftResult = halfBuild(left, words.old, null, "left");
				rightResult = halfBuild(right, words.new, null, "right");
			}
			leftIndex += 1;
			rightIndex += 1;
		} else {
			const leftBody = left !== null && left.type !== "sep" ? leftHighlighted[leftIndex++] ?? left.content : "";
			const rightBody = right !== null && right.type !== "sep" ? rightHighlighted[rightIndex++] ?? right.content : "";
			leftResult = halfBuild(left, leftBody, null, "left");
			rightResult = halfBuild(right, rightBody, null, "right");
		}
		const rowCount = Math.max(leftResult.bodyRows.length, rightResult.bodyRows.length);
		for (let bodyRow = 0; bodyRow < rowCount; bodyRow += 1) {
			const leftGutter = bodyRow === 0 ? leftResult.gutter : leftResult.contGutter;
			const rightGutter = bodyRow === 0 ? rightResult.gutter : rightResult.contGutter;
			const leftBody = leftResult.bodyRows[bodyRow] ?? (left === null ? stripes(codeWidth) : `${BG_EMPTY}${" ".repeat(codeWidth)}${D_RST}`);
			const rightBody = rightResult.bodyRows[bodyRow] ?? (right === null ? stripes(codeWidth) : `${BG_EMPTY}${" ".repeat(codeWidth)}${D_RST}`);
			out.push(`${leftGutter}${leftBody}${DIVIDER}${rightGutter}${rightBody}`);
		}
	}
	out.push(`${diffRule(half)}${FG_RULE}┊${D_RST}${diffRule(half)}`);
	if (rows.length > visible.length) {
		const hint = collapsedDiffHint(rows.length - visible.length, 0, width, options.toggleHint);
		out.push(`${BG_BASE}${FG_DIM}  ${hint}${D_RST}`);
	}
	return out;
}
/**
* Render a diff in whichever layout the width supports: split at
* {@link SPLIT_MIN_WIDTH} columns and above, unified below it.
* @param diff - The parsed diff.
* @param width - Available width in columns.
* @param options - Budgets, language, and highlighter.
* @returns The rendered rows.
*/
function renderDiff(diff, width, options = {}) {
	return width >= 150 ? renderSplit(diff, width, options) : renderUnified(diff, width, options);
}
//#endregion
//#region src/render/preview.ts
/**
* Collapsed output previews, ported from pi-claude-code-ui: the "first N lines
* plus a `+N more lines` marker" body a tool card shows while collapsed.
*
* The upstream version read its budgets from a settings file; here every budget
* is a parameter default, so a preview is a pure function of its inputs. Only
* the lines that will actually be displayed are styled — the upstream comment is
* worth keeping: mapping a color over the whole output array first made the cost
* scale with total tool output even when eight rows were shown.
* @module @deepseek-ai/dsh-tui/render/preview
*/
/** The default recessed tone for preview chrome and unstyled body rows. */
function muted(text) {
	return fg(CLAUDE_COLORS.inactive, text);
}
/**
* Build a collapsed preview body: the leading rows, then a `... (N more lines)`
* marker, then an expanded-cap warning when even the expanded view clipped.
* @param lines - The output rows available to display.
* @param options - Budgets and styling.
* @returns The preview text, newline-separated; `(no output)` when there is nothing.
*/
function buildPreviewText(lines, options = {}) {
	const { expanded = false, previewLines = 8, expandedLines = 4e3, totalLineCount = lines.length, styleLine, toggleHint = "ctrl+o to toggle" } = options;
	if (lines.length === 0 && totalLineCount === 0) return muted("(no output)");
	const maxLines = expanded ? expandedLines : previewLines;
	const limit = Math.min(lines.length, maxLines);
	let text = "";
	for (let index = 0; index < limit; index += 1) {
		const raw = lines[index] ?? "";
		const line = styleLine ? styleLine(raw) : raw;
		text += index === 0 ? line : `\n${line}`;
	}
	const remaining = Math.max(0, totalLineCount - limit);
	if (remaining > 0) {
		const hint = toggleHint === "" ? "" : ` • ${toggleHint}`;
		text += `${text === "" ? "" : "\n"}${muted(`... (${remaining} more lines${hint})`)}`;
	}
	if (expanded && totalLineCount > maxLines) text += `\n${fg(CLAUDE_COLORS.warning, `(display capped at ${maxLines} lines)`)}`;
	return text;
}
//#endregion
//#region src/render/markdown.ts
/**
* Claude Code's markdown-to-ANSI pipeline, ported from `utils/markdown.ts`
* (`formatToken`) and `components/Markdown.tsx` (block spacing, the table
* exception, the no-syntax fast path) as a pure module: no React, no Ink, no
* global `marked` mutation.
*
* Four deliberate departures from the upstream source:
*
* - Styling is injected. Upstream hard-codes `chalk` plus a theme lookup;
*   here every visual decision is a {@link MarkdownAnsiTheme} function, and
*   {@link claudeMarkdownTheme} reproduces the upstream choices on top of
*   {@link ../render/palette.ts | CLAUDE_COLORS}.
* - Rendering is synchronous and returns wrapped rows rather than one joined
*   string, so a pi-tui component can render inside its own `render(width)`
*   pass. Syntax highlighting is therefore not bundled: upstream resolves
*   `cli-highlight` behind a React `Suspense` boundary and re-renders when it
*   lands, which a synchronous `render(width)` has no equivalent of. A fenced
*   block is styled as a block instead — indented and in Claude Code's own code
*   tone, the same tone an inline codespan gets — and a host that wants real
*   per-token highlighting injects a synchronous {@link MarkdownHighlighter}
*   through {@link MarkdownRenderOptions.highlight}.
* - Wrapping is delegated to pi-tui's `wrapTextWithAnsi`, which is ANSI-, OSC 8-
*   and East-Asian-width-aware. Nothing here computes a column count by hand.
* - Three upstream bugs are not reproduced: a task-list checkbox token used to
*   contribute a bare indent (and no `[ ]` marker) to its list item; a `del`
*   token is dropped by disabling the tokenizer on a *private* `Marked`
*   instance instead of on the shared singleton; and the markdown sniff reads
*   the whole string rather than its first 500 characters, which is the
*   difference between rendering and not rendering a Chinese answer (see
*   {@link hasMarkdownSyntax}).
*
* Tables are a monospace text block with the upstream React component's own
* glyphs and column algorithm (`MarkdownTable.tsx`: box-drawing borders, `│`
* walls, centered header): the widths are fitted to the render width and cell
* content wraps inside its column, because a table padded to its widest cell
* is re-wrapped by the caller the moment it is wider than the terminal, and a
* re-wrapped table is a wall of stray glyphs.
* @module @deepseek-ai/dsh-tui/render/markdown
*/
/**
* Line separator. Always `\n` — `os.EOL` is `\r\n` on Windows and the stray
* `\r` becomes a visible column in every width computation downstream.
*/
const EOL = "\n";
/** `▎` left one-quarter block: the bar prefixed to each blockquote line. */
const BLOCKQUOTE_BAR = "▎";
/** OSC 8 hyperlink open, `ESC ] 8 ; ;`. */
const OSC8_START = "\x1B]8;;";
/** OSC 8 terminator; BEL is accepted more widely than `ESC \`. */
const OSC8_END = "\x07";
/** Basic (non-truecolor) blue, the one color that survives a wrap inside OSC 8. */
const BLUE = "\x1B[34m";
/** Close a foreground span. */
const FG_DEFAULT = "\x1B[39m";
/**
* Build a *nesting-safe* SGR attribute wrapper.
*
* A naive `open + text + close` breaks on nesting: `**a *b* c**` closes italic
* in the middle and the terminal drops bold for `c` too, because bold and italic
* share no state. Re-opening the attribute at every close already inside `text`
* is what chalk does, and it is the only reason emphasis survives a heading or a
* blockquote that contains its own emphasis.
* @param open - The opening SGR sequence.
* @param close - The matching closing sequence.
* @returns A styling function safe to nest inside itself.
*/
function attribute(open, close) {
	return (text) => `${open}${text.includes(close) ? text.replaceAll(close, open) : text}${close}`;
}
/** Bold, nesting-safe. */
const bold = attribute("\x1B[1m", "\x1B[22m");
/** Italic, nesting-safe. */
const italic = attribute("\x1B[3m", "\x1B[23m");
/** Underline, nesting-safe. */
const underline = attribute("\x1B[4m", "\x1B[24m");
/**
* Claude Code's own styling, on {@link ../render/palette.ts | CLAUDE_COLORS}.
*
* `codeBlock` paints a fenced block in the same tone as an inline codespan.
* Upstream leaves it unstyled because `cli-highlight` colors it token by token;
* with no highlighter that fallback is *literally* indistinguishable from
* prose, so the block keeps the one color the product already reads as code.
* `listBullet` is intentionally identity — upstream renders a list marker at
* plain text weight. `hr` is dimmed: a rule is chrome, and at full weight it
* reads as content.
*/
const claudeMarkdownTheme = {
	heading: (text, depth) => depth === 1 ? bold(italic(underline(text))) : bold(text),
	bold: (text) => bold(text),
	italic: (text) => italic(text),
	code: (text) => fg(CLAUDE_COLORS.permission, text),
	codeBlock: (text) => fg(CLAUDE_COLORS.permission, text),
	link: (text) => `${BLUE}${text}${FG_DEFAULT}`,
	quote: (text) => dim(text),
	listBullet: (text) => text,
	hr: (text) => dim(text)
};
/**
* A private lexer. Strikethrough is disabled because the model writes `~` for
* "approximately" (`~100ms`) far more often than it means struck-through text —
* and doing it on an owned instance leaves the caller's `marked` singleton
* untouched.
*/
const lexer = new Marked({ tokenizer: { del: () => void 0 } });
/**
* Any markdown marker, or an ordered-list start at the beginning of a line.
* One pass instead of ten `includes` scans.
*/
const MD_SYNTAX_RE = /[#*`|[>\-_~]|\n\n|^\d+\. |\n\d+\. /;
/**
* Whether `text` contains anything the lexer would treat as markdown.
*
* The whole string is scanned. Upstream samples the first 500 characters on the
* theory that markdown announces itself early, but that theory is written for
* English: a Chinese answer opens with a paragraph that carries no ASCII marker
* at all, and the table or fence it ends with lands well past character 500.
* The document then renders as one plain paragraph — raw pipes, raw fences —
* and because the sniff is monotone in nothing, every streamed delta re-decides
* the same way and the answer never converts. One `O(n)` regex pass against a
* misrendered answer is not a trade; the render itself is cached per
* `(text, width)` by the component that mounts it.
* @param text - The candidate source.
* @returns `true` when the full lexer is needed.
*/
function hasMarkdownSyntax(text) {
	return MD_SYNTAX_RE.test(text);
}
/**
* Lex `text`, taking a fast path when it holds no markdown syntax at all.
*
* The fast path reconstructs the single paragraph token the lexer would have
* produced, which is one allocation against a full GFM parse.
* @param text - The markdown source.
* @returns The top-level token list.
*/
function lexMarkdown(text) {
	if (!hasMarkdownSyntax(text)) return [{
		type: "paragraph",
		raw: text,
		text,
		tokens: [{
			type: "text",
			raw: text,
			text
		}]
	}];
	return lexer.lexer(text);
}
/**
* Columns a fenced block is indented by. Upstream indents by nothing and leans
* on `cli-highlight` to tell code from prose; with the highlighter optional the
* indent is what still reads as a block when the colors are stripped (a no-color
* terminal, a piped transcript, a copy out of scrollback).
*/
const CODE_BLOCK_INDENT = "  ";
/**
* The highlighter's language id for a fence info string.
*
* A fence may carry metadata (` ```ts twoslash `), so only the first word is
* the language.
* @param lang - The fence info string, if any.
* @returns A language id, or `undefined` for a bare fence.
*/
function normalizeLanguage(lang) {
	const first = (lang ?? "").trim().split(/\s+/u)[0];
	if (first === void 0 || first === "") return void 0;
	return first.toLowerCase();
}
/**
* Render a fenced code block: indented, and styled per line.
*
* The fence's language is passed to the highlighter and otherwise dropped — no
* language label is drawn, which is upstream's own choice — and a highlighter's
* output is indented but never re-styled, since it already carries its colors.
* @param code - The `code` token.
* @param ctx - Theme, highlighter, and hyperlink policy.
* @returns The rendered block, ending in a newline.
*/
function formatCodeBlock(code, ctx) {
	const language = normalizeLanguage(code.lang);
	const highlighted = language === void 0 ? void 0 : ctx.highlight?.(code.text, language);
	return (highlighted ?? code.text).split(EOL).map((line) => {
		if (stripTerminalSequences(line).trim() === "") return "";
		return CODE_BLOCK_INDENT + (highlighted === void 0 ? ctx.theme.codeBlock(line) : line);
	}).join(EOL) + EOL;
}
/** A token's children, or an empty list — `Tokens.Generic` may carry none. */
function tokensOf(token) {
	return token.tokens ?? [];
}
/** A token's `text` field, or `''` when it has none. */
function textOf(token) {
	const value = token.text;
	return typeof value === "string" ? value : "";
}
/** Render a token's children at top level (no list context, no parent). */
function inner(token, ctx) {
	return tokensOf(token).map((child) => formatToken(child, ctx, 0, null, null)).join("");
}
/** Wrap `content` in an OSC 8 hyperlink, or degrade to the bare URL. */
function hyperlink(ctx, url, content) {
	if (!ctx.hyperlinks) return ctx.theme.link(url);
	const display = ctx.theme.link(content ?? url);
	return `${OSC8_START}${url}${OSC8_END}${display}${OSC8_START}${OSC8_END}`;
}
/**
* Render one marked token to an ANSI string.
*
* The returned string carries its own newlines — block tokens end with `\n`,
* headings with two — so a caller concatenating siblings gets the upstream
* spacing for free.
* @param token - The token to render.
* @param ctx - Theme, highlighter, and hyperlink policy.
* @param listDepth - Nesting level inside lists; drives indent and marker style.
* @param orderedListNumber - This item's number, or `null` in an unordered list.
* @param parent - The enclosing token, which changes how `text` renders.
* @returns The rendered fragment.
*/
function formatToken(token, ctx, listDepth, orderedListNumber, parent) {
	switch (token.type) {
		case "blockquote": {
			const bar = ctx.theme.quote(BLOCKQUOTE_BAR);
			return inner(token, ctx).split(EOL).map((line) => stripTerminalSequences(line).trim() === "" ? line : `${bar} ${ctx.theme.italic(line)}`).join(EOL);
		}
		case "code": return formatCodeBlock(token, ctx);
		case "codespan": return ctx.theme.code(textOf(token));
		case "em": return ctx.theme.italic(tokensOf(token).map((child) => formatToken(child, ctx, 0, null, parent)).join(""));
		case "strong": return ctx.theme.bold(tokensOf(token).map((child) => formatToken(child, ctx, 0, null, parent)).join(""));
		case "heading": return ctx.theme.heading(inner(token, ctx), token.depth) + "\n\n";
		case "hr": return ctx.theme.hr("---");
		case "image": return token.href;
		case "link": {
			const link = token;
			if (link.href.startsWith("mailto:")) return link.href.slice(7);
			const linkText = tokensOf(token).map((child) => formatToken(child, ctx, 0, null, token)).join("");
			const plainLinkText = stripTerminalSequences(linkText);
			if (plainLinkText !== "" && plainLinkText !== link.href) return hyperlink(ctx, link.href, linkText);
			return hyperlink(ctx, link.href);
		}
		case "list": {
			const list = token;
			const start = typeof list.start === "number" ? list.start : 1;
			return list.items.map((item, index) => formatToken(item, ctx, listDepth, list.ordered ? start + index : null, list)).join("");
		}
		case "list_item": return tokensOf(token).filter((child) => child.type !== "checkbox").map((child) => `${"  ".repeat(listDepth)}${formatToken(child, ctx, listDepth + 1, orderedListNumber, token)}`).join("");
		case "paragraph": return inner(token, ctx) + EOL;
		case "space":
		case "br": return EOL;
		case "text":
			if (parent?.type === "link") return textOf(token);
			if (parent?.type === "list_item") {
				const item = parent;
				const marker = orderedListNumber === null ? "-" : `${listNumber(listDepth, orderedListNumber)}.`;
				const checkbox = item.task ? item.checked === true ? "[x] " : "[ ] " : "";
				const body = tokensOf(token).length > 0 ? inner(token, ctx) : textOf(token);
				return `${ctx.theme.listBullet(marker)} ${checkbox}${body}${EOL}`;
			}
			return textOf(token);
		case "table": return formatTable(token, ctx);
		case "escape": return textOf(token);
		default: return "";
	}
}
/** `1 → a`, `27 → aa`: a bijective base-26 label. */
function numberToLetter(value) {
	let remaining = value;
	let result = "";
	while (remaining > 0) {
		remaining -= 1;
		result = String.fromCharCode(97 + remaining % 26) + result;
		remaining = Math.floor(remaining / 26);
	}
	return result;
}
const ROMAN_VALUES = [
	[1e3, "m"],
	[900, "cm"],
	[500, "d"],
	[400, "cd"],
	[100, "c"],
	[90, "xc"],
	[50, "l"],
	[40, "xl"],
	[10, "x"],
	[9, "ix"],
	[5, "v"],
	[4, "iv"],
	[1, "i"]
];
/** `4 → iv`: lowercase Roman numerals. */
function numberToRoman(value) {
	let remaining = value;
	let result = "";
	for (const [amount, numeral] of ROMAN_VALUES) while (remaining >= amount) {
		result += numeral;
		remaining -= amount;
	}
	return result;
}
/** An ordered item's label: digits, then letters, then Roman numerals by depth. */
function listNumber(listDepth, orderedListNumber) {
	switch (listDepth) {
		case 2: return numberToLetter(orderedListNumber);
		case 3: return numberToRoman(orderedListNumber);
		default: return orderedListNumber.toString();
	}
}
/** Minimum rendered width of a table column. */
const MIN_COLUMN_WIDTH = 3;
/**
* Pad `content` to `targetWidth` according to alignment. `displayWidth` is the
* visible width of `content`, computed by the caller so ANSI codes inside
* `content` never affect the padding.
*/
function padAligned(content, displayWidth, targetWidth, align) {
	const padding = Math.max(0, targetWidth - displayWidth);
	if (align === "center") {
		const leftPad = Math.floor(padding / 2);
		return " ".repeat(leftPad) + content + " ".repeat(padding - leftPad);
	}
	if (align === "right") return " ".repeat(padding) + content;
	return content + " ".repeat(padding);
}
/** Render one table cell's inline tokens. */
function cellContent(cell, ctx) {
	if (cell === void 0) return "";
	return cell.tokens.map((child) => formatToken(child, ctx, 0, null, null)).join("");
}
/** Visible width of `content`, with any ANSI in it discounted. */
function displayWidth(content) {
	return visibleWidth(stripTerminalSequences(content));
}
/**
* The width of the longest run that cannot be broken across lines. A CJK cell
* has no spaces at all, so this is the whole cell — which is exactly why a CJK
* table has to fall through to the proportional path below.
*/
function longestWordWidth(plain) {
	let widest = 0;
	for (const word of plain.split(/\s+/u)) if (word !== "") widest = Math.max(widest, visibleWidth(word));
	return widest;
}
/**
* Chrome around the cells of an `n`-column row: the leading `│`, then a space,
* the cell, and ` │` per column. `│ a │ b │` is 1 + 2×3 columns wide beyond
* its cells.
*/
function tableChromeWidth(columns) {
	return 1 + columns * 3;
}
/**
* Fit the columns into `available` cells' worth of space.
*
* Upstream's React table decides this and this port copies the decision: pay
* every column its ideal width when the table fits, otherwise pay each its
* minimum and split what is left in proportion to what each column asked for,
* and when even the minimums do not fit, scale them down and let the cells
* break mid-word.
* @param ideal - Per column, the width that needs no wrapping.
* @param minimum - Per column, the width that breaks no word.
* @param available - Total cell width the row may use.
* @returns One width per column.
*/
function fitColumns(ideal, minimum, available) {
	const total = (widths) => widths.reduce((sum, width) => sum + width, 0);
	if (total(ideal) <= available) return [...ideal];
	if (total(minimum) <= available) {
		const overflow = ideal.map((width, index) => width - (minimum[index] ?? MIN_COLUMN_WIDTH));
		const totalOverflow = total(overflow);
		if (totalOverflow === 0) return [...minimum];
		const spare = available - total(minimum);
		return minimum.map((width, index) => width + Math.floor((overflow[index] ?? 0) / totalOverflow * spare));
	}
	const scale = available / total(minimum);
	const scaled = minimum.map((width) => Math.max(MIN_COLUMN_WIDTH, Math.floor(width * scale)));
	for (let excess = total(scaled) - available; excess > 0; excess -= 1) {
		let widest = 0;
		for (const [index, width] of scaled.entries()) if (width > (scaled[widest] ?? 0)) widest = index;
		const current = scaled[widest] ?? MIN_COLUMN_WIDTH;
		/* v8 ignore next -- `available >= columns * MIN_COLUMN_WIDTH`, so a row of floors always fits. */
		if (current <= MIN_COLUMN_WIDTH) break;
		scaled[widest] = current - 1;
	}
	return scaled;
}
/** Wrap one cell to its column, as at least one line. */
function wrapCell(content, width) {
	const lines = wrapTextWithAnsi(content.trimEnd(), Math.max(1, width)).filter((line) => line !== "");
	return lines.length > 0 ? lines : [""];
}
/**
* Render one table row, which may be several terminal rows tall when a cell
* wrapped. A cell shorter than the tallest one is centered against it, which is
* what keeps a one-word cell next to a wrapped paragraph readable.
*/
function formatRow(row, columnWidths, align, isHeader) {
	const wrapped = row.map((cell, index) => wrapCell(cell.content, columnWidths[index] ?? MIN_COLUMN_WIDTH));
	const height = Math.max(1, ...wrapped.map((lines) => lines.length));
	const offsets = wrapped.map((lines) => Math.floor((height - lines.length) / 2));
	let output = "";
	for (let lineIndex = 0; lineIndex < height; lineIndex += 1) {
		let line = "│";
		wrapped.forEach((lines, index) => {
			const text = lines[lineIndex - (offsets[index] ?? 0)] ?? "";
			const width = columnWidths[index] ?? MIN_COLUMN_WIDTH;
			const cellAlign = isHeader ? "center" : align[index] ?? null;
			line += ` ${padAligned(text, displayWidth(text), width, cellAlign)} │`;
		});
		output += line + EOL;
	}
	return output;
}
/**
* Render a GFM table as a monospace-aligned text block, laid out to
* {@link FormatContext.width}.
*
* Column widths are measured on the *visible* text, so a styled or CJK cell
* still lines up, and a cell too wide for its column wraps inside it rather
* than pushing the row past the terminal — a row that overflows is re-wrapped
* by the caller, and a re-wrapped row loses every column boundary it had. The
* one case that still overflows is a terminal too narrow for three columns per
* cell, where there is nothing left to shrink.
*
* The glyphs are upstream's `MarkdownTable.tsx` verbatim: box-drawing borders
* (`┌─┬─┐`, a `├─┼─┤` rule between every row, `└─┴─┘`), `│` cell walls, and a
* centered header row. Alignment colons are consumed by the layout, never
* echoed.
* @param table - The table token.
* @param ctx - Theme, highlighter, hyperlink policy, and render width.
* @returns The rendered table, ending in a blank line.
*/
function formatTable(table, ctx) {
	const columns = table.header.length;
	if (columns === 0) return "";
	const rendered = [table.header, ...table.rows].map((row) => table.header.map((_, index) => {
		const content = cellContent(row[index], ctx);
		const plain = stripTerminalSequences(content);
		return {
			content,
			width: visibleWidth(plain),
			wordWidth: longestWordWidth(plain)
		};
	}));
	const columnWidths = fitColumns(table.header.map((_, index) => Math.max(MIN_COLUMN_WIDTH, ...rendered.map((row) => row[index]?.width ?? 0))), table.header.map((_, index) => Math.max(MIN_COLUMN_WIDTH, ...rendered.map((row) => row[index]?.wordWidth ?? 0))), Math.max(ctx.width - tableChromeWidth(columns), columns * MIN_COLUMN_WIDTH));
	const border = (left, cross, right) => `${left}${columnWidths.map((width) => "─".repeat(width + 2)).join(cross)}${right}${EOL}`;
	let output = border("┌", "┬", "┐");
	rendered.forEach((row, rowIndex) => {
		output += formatRow(row, columnWidths, table.align, rowIndex === 0);
		if (rowIndex < rendered.length - 1) output += border("├", "┼", "┤");
	});
	return output + border("└", "┴", "┘") + EOL;
}
/**
* Strip the blank lines around a block, but not the indent of its first line.
*
* A plain `trim()` would eat a fenced block's leading indent whenever the fence
* opens the block, which is the common case: ``` ```ts ``` right after a
* heading, or as the whole message.
*/
function trimBlankEdges$1(text) {
	return text.replace(/^(?:[^\S\n]*\n)+/u, "").replace(/\s+$/u, "");
}
/**
* Split `text` into rendered blocks.
*
* A table becomes its own block; every run of other tokens accumulates into one
* block and is trimmed, which is what puts exactly one blank line either side of
* a table while leaving the token-level spacing inside a run untouched.
*/
function buildBlocks(text, ctx) {
	const blocks = [];
	let pending = "";
	const flush = () => {
		const trimmed = trimBlankEdges$1(pending);
		if (trimmed !== "") blocks.push(trimmed);
		pending = "";
	};
	for (const token of lexMarkdown(text)) {
		if (token.type === "table") {
			flush();
			const rendered = trimBlankEdges$1(formatToken(token, ctx, 0, null, null));
			if (rendered !== "") blocks.push(rendered);
			continue;
		}
		pending += formatToken(token, ctx, 0, null, null);
	}
	flush();
	return blocks;
}
/**
* Render markdown to ANSI rows, already wrapped to `width`.
*
* Plain text with no markdown markers skips the parser entirely and is wrapped
* as one paragraph.
* @param text - The markdown source.
* @param width - Terminal columns available; values below 1 are clamped.
* @param theme - Styling functions; defaults to {@link claudeMarkdownTheme}.
* @param options - Highlighter and hyperlink policy.
* @returns One entry per terminal row, with a blank row between blocks. Empty
* input renders as no rows at all.
*/
function renderMarkdownAnsi(text, width, theme = claudeMarkdownTheme, options = {}) {
	const usable = Math.max(1, Math.floor(width));
	const ctx = {
		theme,
		highlight: options.highlight,
		hyperlinks: options.hyperlinks ?? true,
		width: usable
	};
	const rows = [];
	for (const block of buildBlocks(text, ctx)) {
		if (rows.length > 0) rows.push("");
		rows.push(...wrapTextWithAnsi(block, usable));
	}
	return rows;
}
//#endregion
//#region src/chat/timing.ts
/** Milliseconds for one full brightness throb of the active status glyph. */
const STATUS_PULSE_PERIOD_MS = 1400;
/**
* Muted-gray foreground the truecolor status glyph fades through, from the
* near-background trough (opacity 0) to the settled dim gray (opacity 1). Same
* hue-free gray as the idle caret, so the glyph reads as the caret dimly
* appearing rather than a colored indicator. Foreground-only, matching the
* brand gradient, so it stays legible on any terminal background.
*/
const STATUS_FADE_GRAY = {
	trough: [
		43,
		43,
		43
	],
	settled: [
		136,
		136,
		136
	]
};
const TIMING_BUCKET_LABELS = {
	ttft: "Model wait",
	thinking: "Thinking",
	responding: "Response",
	tools: "Tools"
};
const TIMING_BUCKETS = [
	"ttft",
	"thinking",
	"responding",
	"tools"
];
function emptyTimingTotals() {
	return {
		ttft: 0,
		thinking: 0,
		responding: 0,
		tools: 0
	};
}
function timingState(startedAt) {
	return {
		totals: emptyTimingTotals(),
		/* v8 ignore next -- production timing state always begins at a logged step timestamp. */
		active: startedAt === void 0 ? void 0 : {
			bucket: "ttft",
			since: startedAt
		}
	};
}
function sameStep(event, position) {
	return typeof event.data === "object" && "turn" in event.data && "step" in event.data && event.data.turn === position.turn && event.data.step === position.step;
}
function closeTimingBucket(state, at) {
	if (state.active === void 0) return;
	state.totals[state.active.bucket] += Math.max(0, at - state.active.since);
	state.active = void 0;
}
function enterTimingBucket(state, bucket, at) {
	if (state.active?.bucket === bucket) return;
	closeTimingBucket(state, at);
	if (bucket !== void 0) state.active = {
		bucket,
		since: at
	};
}
function advanceStepTiming(state, event) {
	if (event.type === "assistant/chunk") {
		const chunk = event.data.chunk;
		if (state.active?.bucket === "ttft") enterTimingBucket(state, void 0, event.time);
		if (chunk.type === "reasoning-delta" || chunk.type === "block-start" && chunk.blockType === "reasoning") enterTimingBucket(state, "thinking", event.time);
		else if (chunk.type === "text-delta" || chunk.type === "block-start" && chunk.blockType === "text") enterTimingBucket(state, "responding", event.time);
	} else if (event.type === "tool/call") enterTimingBucket(state, "tools", event.time);
	else closeTimingBucket(state, event.time);
}
function timingTotalsAt(state, at) {
	const totals = { ...state.totals };
	if (state.active !== void 0 && at !== void 0) totals[state.active.bucket] += Math.max(0, at - state.active.since);
	return totals;
}
function stepKey(position) {
	return `${position.turn}:${position.step}`;
}
/**
* Incremental per-step timing accumulator shared by every step's timing footer
* in one transcript. One forward pass over the append-only session log serves
* all steps' totals: each query advances a cursor over the events appended
* since the previous query, so a transcript of S steps costs O(events) in
* total instead of the O(S × events) of replaying the whole log per footer
* ([rationale](../../../../../.agents/notes/implemented/bug-fix/2026-08-03-tui-long-session-render-costs.md)).
*
* The log must be append-only with stable indices (the session `seq = log
* length` contract). Event times are consumed as logged: a backward wall-clock
* step clamps each bucket at zero rather than cutting the scan off at the
* query clock. The open bucket is accumulated to the query clock at lookup,
* never during the scan.
*/
var StepTimingTracker = class {
	scanned = 0;
	steps = /* @__PURE__ */ new Map();
	/**
	* Advance over events appended since the previous query, then return one
	* step's accumulated per-phase timing up to clock `at`.
	* @param events - Current session event log (append-only).
	* @param position - Turn/step coordinates of the queried step.
	* @param at - Render clock to accumulate the open bucket up to.
	* @returns The step's per-phase totals; empty when the step never started.
	*/
	totalsAt(events, position, at) {
		for (; this.scanned < events.length; this.scanned += 1) {
			const event = events[this.scanned];
			if (event.type === "step/start") {
				const key = stepKey(event.data);
				if (!this.steps.has(key)) this.steps.set(key, {
					...timingState(event.time),
					closed: false
				});
			} else if (event.type === "assistant/chunk" || event.type === "tool/call" || event.type === "step/end") {
				const state = this.steps.get(stepKey(event.data));
				if (state !== void 0 && !state.closed) {
					advanceStepTiming(state, event);
					if (event.type === "step/end") state.closed = true;
				}
			}
		}
		const state = this.steps.get(stepKey(position));
		return state === void 0 ? emptyTimingTotals() : timingTotalsAt(state, at);
	}
};
/**
* The turn index of the currently open turn, or `undefined` when none is open.
* @param events - Session events to scan from the tail.
* @returns The open turn index, or `undefined`.
*/
function openTurn(events) {
	for (let index = events.length - 1; index >= 0; index -= 1) {
		const event = events[index];
		if (event.type === "turn/end") return void 0;
		if (event.type === "turn/start") return event.data.turn;
	}
}
/**
* Phase-specific status glyph, keyed by the running step's active timing bucket.
* `ttft` is the pre-first-token wait a running turn falls back to between steps.
*/
const TIMING_BUCKET_GLYPHS = {
	ttft: "◍",
	thinking: "✻",
	responding: "●",
	tools: "⚙"
};
/** Status glyph for a live standalone compaction bracket. */
const COMPACTING_GLYPH = "⊙";
/**
* Derive the currently open step's active timing bucket, or `undefined` when no
* step is open. The open step is the last `step/start` with no later matching
* `step/end`; its bucket is replayed with the same rules as {@link StepTimingTracker}.
* @param events - Session events to scan.
* @returns The open step's active bucket, or `undefined`.
*/
function openStepPhase(events) {
	let startIndex = -1;
	let start;
	for (let index = events.length - 1; index >= 0; index -= 1) {
		const event = events[index];
		if (event.type === "step/end") return void 0;
		if (event.type === "step/start") {
			startIndex = index;
			start = event;
			break;
		}
		if (event.type === "turn/end") return void 0;
	}
	if (start === void 0) return void 0;
	const position = start.data;
	const state = timingState(start.time);
	for (let index = startIndex + 1; index < events.length; index += 1) {
		const event = events[index];
		if ((event.type === "assistant/chunk" || event.type === "tool/call" || event.type === "step/end") && sameStep(event, position)) advanceStepTiming(state, event);
	}
	return state.active?.bucket;
}
/**
* The active status glyph, or `undefined` when idle. A running turn takes
* precedence over standalone compaction and falls back to the pre-first-token
* wait when no step is open. The caller applies the shared fade and throb
* animation (see {@link fadeGlyph}).
* @param events - Session events to derive the phase from.
* @param running - Whether the agent is currently running.
* @param compacting - Whether a live standalone compaction bracket is open.
* @returns The active status glyph, or `undefined` when idle.
*/
function runningPhaseGlyph(events, running, compacting) {
	if (running) {
		const bucket = openStepPhase(events) ?? "ttft";
		return TIMING_BUCKET_GLYPHS[bucket];
	}
	return compacting ? COMPACTING_GLYPH : void 0;
}
/**
* The status throb's brightness at continuous clock `nowMs`: a cosine between
* {@link STATUS_PULSE_FLOOR} and 1 over {@link STATUS_PULSE_PERIOD_MS}, so the
* dim glyph breathes bold→dim→bold without ever blinking off. Multiplied by the
* fade envelope, which alone drives appear/disappear at work boundaries.
*
* @param nowMs - Monotonic render clock in milliseconds.
* @returns Brightness fraction in [{@link STATUS_PULSE_FLOOR}, 1].
*/
function pulseLevel(nowMs) {
	const phase = nowMs % STATUS_PULSE_PERIOD_MS / STATUS_PULSE_PERIOD_MS;
	return 0 + 1 * (.5 - .5 * Math.cos(2 * Math.PI * phase));
}
/**
* One frame of the status glyph at fade `opacity` (0 = near-background trough
* gray, 1 = settled dim gray). The character and its width never change — only
* the gray fades — so the prompt caret column stays fixed and the glyph reads as
* the caret dimly breathing, never a colored indicator.
*
* With truecolor the glyph's 24-bit gray foreground interpolates continuously
* between {@link STATUS_FADE_GRAY}'s trough and settled stops, so both the fade
* and the status throb render as a smooth, symmetric brightness swing with no
* hard cutoff to clip the trough into a blank. Without truecolor there is no
* per-frame gray, so `visible` (driven by the fade envelope, not the opacity)
* shows the glyph in the palette's muted role or leaves a blank column — a
* single dim appear/disappear at fixed width, still dim rather than accent, and
* no throb-driven blink. With color off entirely a visible glyph is bare,
* holding the caret column on a monochrome terminal.
*
* @param glyph - The status glyph to paint.
* @param palette - Active palette supplying the muted (dim gray) role.
* @param colorEnabled - Whether ANSI is emitted at all.
* @param truecolor - Whether the terminal accepts 24-bit foreground codes.
* @param opacity - Brightness fraction in [0, 1] for the truecolor gray.
* @param visible - Whether the non-truecolor fallback shows the glyph at all.
* @returns The gray glyph at this opacity, or a single space when hidden.
*/
function fadeGlyph(glyph, palette, colorEnabled, truecolor, opacity, visible) {
	if (truecolor && colorEnabled) {
		const o = Math.min(Math.max(opacity, 0), 1);
		const [tr, tg, tb] = STATUS_FADE_GRAY.trough;
		const [sr, sg, sb] = STATUS_FADE_GRAY.settled;
		return `\x1b[38;2;${Math.round(tr + (sr - tr) * o)};${Math.round(tg + (sg - tg) * o)};${Math.round(tb + (sb - tb) * o)}m${glyph}\x1b[39m`;
	}
	if (!visible) return " ";
	return colorEnabled ? palette.dim(glyph) : glyph;
}
/**
* Format a non-negative elapsed span at 100 ms resolution.
* @param elapsedMs - Elapsed milliseconds.
* @returns The formatted duration (e.g. `1.5s`, `2m03.4s`).
*/
function formatStatusDuration(elapsedMs) {
	const seconds = Math.floor(Math.max(0, elapsedMs) / 100) / 10;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m${(seconds - minutes * 60).toFixed(1).padStart(4, "0")}s`;
}
/**
* Format the non-zero timing buckets of one step as a middot-joined summary.
* @param totals - Per-phase totals to format.
* @param includeModelWait - Whether to always include the model-wait bucket.
* @returns The formatted timing summary.
*/
function formatTimingTotals(totals, includeModelWait = false) {
	return TIMING_BUCKETS.filter((bucket) => totals[bucket] > 0 || includeModelWait && bucket === "ttft").map((bucket) => `${TIMING_BUCKET_LABELS[bucket]} ${formatStatusDuration(totals[bucket])}`).join(" · ");
}
/**
* Format the queued-steering badge shown on the running status line.
* @param queued - Number of queued steering messages.
* @returns The badge text, or `undefined` when nothing is queued.
*/
function formatQueuedStatus(queued) {
	return queued > 0 ? t("prompt.queued", { count: queued }) : void 0;
}
/**
* Format a completion timestamp as `YYYY-MM-DD HH:MM:SS` in local time.
* @param time - Epoch milliseconds.
* @returns The formatted local timestamp.
*/
function formatCompletionTime(time) {
	const date = new Date(time);
	const parts = [
		date.getFullYear().toString().padStart(4, "0"),
		(date.getMonth() + 1).toString().padStart(2, "0"),
		date.getDate().toString().padStart(2, "0")
	];
	const clock = [
		date.getHours(),
		date.getMinutes(),
		date.getSeconds()
	].map((value) => value.toString().padStart(2, "0")).join(":");
	return `${parts.join("-")} ${clock}`;
}
//#endregion
//#region src/components/transcript.ts
/**
* pi-tui transcript components: the startup banner, user/assistant messages,
* per-step timing footer, streaming assistant buffer, tool cards, and the todo
* panel. Each is a pure function of its inputs and the active palette.
* @module @deepseek-ai/dsh-tui/components/transcript
*/
/** Concatenate the text of every block of one type, separated by blank lines. */
function textBlocks(content, type) {
	return content.filter((block) => block.type === type).map((block) => block.text).join("\n\n");
}
/** Render a value as terminal-safe text: strings escaped, other values as pretty JSON. */
function pretty(value) {
	if (typeof value === "string") return displayText(value);
	return displayText(JSON.stringify(value, null, 2) ?? String(value));
}
/**
* A side's content lines under the terminator rule the Web DiffBlock also
* applies: empty text is zero lines, a trailing newline terminates the last
* line, and an interior blank line survives.
*/
function diffContentLines(text) {
	if (text === "") return [];
	return (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
}
/**
* Whether the active palette emits ANSI at all. Every role wrapper is the
* identity function when color is disabled, so a role that always carries an
* escape (`bold`) tells the two apart — which is how the fixed truecolor Claude
* accents below stay out of a `--no-color` transcript.
*/
function colorEnabled(palette) {
	return palette.bold("x") !== "x";
}
/**
* Paint text in one of Claude Code's fixed brand colors, or leave it bare when
* the palette has color disabled.
*/
function accent(palette, color, text) {
	return colorEnabled(palette) ? fg(color, text) : text;
}
/** Drop every escape from `lines` when the palette has color disabled. */
function plainIfNoColor(palette, lines) {
	return colorEnabled(palette) ? lines : lines.map((line) => stripTerminalSequences(line));
}
/**
* The transcript's left margin, and with it the column every gutter glyph sits
* in: an assistant answer's `●`, a tool card's `⏺`, the `∴` of a thinking
* block, and a turn's `✻`.
*
* Claude Code puts all four in the same two-column gutter at the left edge of
* the message row (`<Box minWidth={2}>` in `AssistantTextMessage`,
* `AssistantToolUseMessage`, `SystemTextMessage`), so they line up down the
* whole transcript; this port indents every row one column further, and tool
* cards were the one surface that never got that column — which put their
* bullets a column left of every other bullet on screen. One constant now
* carries the margin so the two cannot drift apart again.
*/
const GUTTER = " ";
/** Columns a gutter glyph and its trailing space occupy: {@link GUTTER} plus `● `. */
const GUTTER_WIDTH = 3;
/** Continuation indent under a gutter glyph, so a wrapped body stays one block. */
const GUTTER_INDENT = " ".repeat(GUTTER_WIDTH);
/**
* A markdown body rendered by {@link ../render/markdown.ts | renderMarkdownAnsi}
* under Claude Code's own styling, with pi-tui's `Markdown` as the fallback.
*
* The rows come back already wrapped to the requested width, so the caller must
* not re-flow them (`PrefixedComponent` only prefixes, which is safe). A throw
* out of the claude path is contained here: the shared policy flips to `pi`,
* the failure is reported once, and this render returns the pi rows instead —
* and a throw out of *that* leaves the unparsed text on screen. A malformed
* document can degrade the styling but never blank the transcript, and never
* takes the frame down with it.
*/
var MarkdownBodyComponent = class {
	text;
	palette;
	mdTheme;
	policy;
	/** The pi-tui document, built on demand: the claude path never constructs one. */
	fallback;
	/** The last claude render, with the width it was wrapped to. */
	cached;
	/**
	* @param text - the markdown source of one assistant response body.
	* @param palette - active role palette; also decides whether escapes survive.
	* @param mdTheme - pi-tui Markdown theme, used only on the fallback path.
	* @param policy - shared renderer choice and failure report.
	*/
	constructor(text, palette, mdTheme, policy) {
		this.text = text;
		this.palette = palette;
		this.mdTheme = mdTheme;
		this.policy = policy;
	}
	invalidate() {
		this.cached = void 0;
		this.fallback?.invalidate();
	}
	/** The pi-tui document for this text, built once and reused. */
	piDocument() {
		this.fallback ??= new Markdown(this.text, 0, 0, this.mdTheme, { color: (value) => this.palette.text(value) });
		return this.fallback;
	}
	/** The fallback's rows, or the bare words when even the fallback cannot parse them. */
	piRows(width) {
		try {
			return this.piDocument().render(width);
		} catch {
			return wrapTextWithAnsi(this.text, Math.max(1, width));
		}
	}
	render(width) {
		if (this.policy.mode === "claude") {
			if (this.cached?.width === width) return this.cached.rows;
			try {
				const rows = plainIfNoColor(this.palette, renderMarkdownAnsi(this.text, width, this.policy.theme, { hyperlinks: colorEnabled(this.palette) }));
				this.cached = {
					width,
					rows
				};
				return rows;
			} catch (error) {
				this.policy.mode = "pi";
				this.policy.onError(error);
			}
		}
		return this.piRows(width);
	}
};
/**
* Clip rows to a collapsed budget, replacing the remainder with the fold marker
* that names the toggle (`… +N lines • ctrl+o to toggle`). A budget of zero
* leaves only the marker, so a card can be reduced to its one-line summary.
*/
function foldRows(rows, limit, palette) {
	if (rows.length <= limit) return [...rows];
	const hidden = rows.length - limit;
	return [...rows.slice(0, limit), palette.dim(`… +${hidden} line${hidden === 1 ? "" : "s"} • ctrl+o to toggle`)];
}
/**
* Wrap a child component's rows behind a fixed per-row prefix: a lead glyph on
* the first row and an aligned indent on the rest. This is how an assistant
* paragraph gets its ` ● ` bullet and a thinking block its ` ∴ ` without the
* prefix entering the Markdown document (where it would be re-wrapped as text
* and would land in a drag-select copy of the message).
*/
var PrefixedComponent = class {
	child;
	lead;
	continuation;
	constructor(child, lead, continuation) {
		this.child = child;
		this.lead = lead;
		this.continuation = continuation;
	}
	invalidate() {
		this.child.invalidate();
	}
	render(width) {
		return this.child.render(Math.max(1, width - visibleWidth(this.continuation))).map((row, index) => {
			if (stripTerminalSequences(row).trim() === "") return index === 0 ? this.lead.trimEnd() : "";
			return `${index === 0 ? this.lead : this.continuation}${row}`;
		});
	}
};
/** Label above the banner's skill summary. */
const SKILLS_LABEL = "[Skills]";
/** Rows of skill names the banner spends before it summarizes the rest. */
const SKILLS_MAX_ROWS = 4;
/**
* Pack skill names into comma-joined rows of at most `width` columns, spending
* at most {@link SKILLS_MAX_ROWS} of them.
*
* What does not fit is counted into a trailing `+N more`, and the marker is
* packed onto the last row like any other item: names are dropped from that row
* until it fits, each dropped name raising the count the marker reports (on a
* narrow banner every one of them can go, leaving the marker alone on its row).
* That keeps the summary inside its budget at any width, and keeps the count
* itself off the part a truncation would clip.
* @param names - Skill names, in the order the entry supplied them.
* @param width - Columns one row may occupy.
* @returns The rows to render, without styling.
*/
function packSkillNames(names, width) {
	if (names.length === 0) return [];
	const joined = (parts) => parts.join(", ");
	const rows = [];
	let row = [];
	let placed = 0;
	for (const name of names) {
		if (row.length === 0 || visibleWidth(joined([...row, name])) <= width) {
			row.push(name);
			placed += 1;
			continue;
		}
		if (rows.length + 1 === SKILLS_MAX_ROWS) break;
		rows.push(joined(row));
		row = [name];
		placed += 1;
	}
	let hidden = names.length - placed;
	if (hidden > 0) {
		while (row.length > 0 && visibleWidth(joined([...row, `+${hidden} more`])) > width) {
			row.pop();
			hidden += 1;
		}
		row.push(`+${hidden} more`);
	}
	rows.push(joined(row));
	return rows;
}
/**
* Borderless startup banner, in Claude Code's shape: the wordmark and version on
* one line, what this session is running as on the next, and then the input.
*
* ```text
*  DEEPSEEK HARNESS v0.1.0
*  deepseek-v4-pro · ~/src/project
*  resumed 85d19568 · fix the ordering bug
*
*  [Skills]
*  lark-doc, lark-base, meego-tech-story, +12 more
* ```
*
* The session id is on the resumed line only. A fresh session's id is a uuid the
* user did not choose and cannot act on, and printing it (as this banner did)
* spent the first thing on screen saying nothing; a resumed one is exactly what
* `--resume` takes back, so it is worth its line — with the logged title beside
* it, which is why the title is no longer a transcript row of its own. Each line
* renders as plain left-padded text, matching transcript notices, so it reads on
* any theme.
*
* The skill summary is a section rather than another identity line, so it goes
* last, under a blank row: which session this is (route, workspace, resume) is
* one block, and what it can do is another. On a fresh session — the common
* case, with no resume and no configured welcome — that puts it directly under
* the workspace row.
*/
var HeaderComponent = class {
	info;
	palette;
	gradient;
	/** Columns of the wordmark currently revealed; `undefined` renders it whole. */
	revealWidth;
	/**
	* @param info - The identity lines this banner states.
	* @param palette - Active role palette, mutated in place by a repaint.
	* @param gradient - Whether the wordmark may carry truecolor brand art, read
	*   per render: the banner is mounted once, so a theme changed mid-session
	*   (`/theme no-color`) has no other way to reach it.
	*/
	constructor(info, palette, gradient) {
		this.info = info;
		this.palette = palette;
		this.gradient = gradient;
	}
	/**
	* Clip the wordmark to `width` columns (the sweep reveal); `undefined` restores it.
	*
	* Only the wordmark sweeps. The lines under it state where the session is
	* running, and wiping those in as well made the whole screen move at startup.
	* @param width - Revealed wordmark width in columns, or `undefined` for the whole row.
	*/
	setRevealWidth(width) {
		this.revealWidth = width;
	}
	invalidate() {}
	render(width) {
		const usable = Math.max(1, width - 2);
		const name = this.gradient() ? this.palette.bold(gradientText("DEEPSEEK")) : this.palette.bold(this.palette.accent("DEEPSEEK"));
		const version = this.info.version;
		const wordmark = `${name} ${this.palette.bold("HARNESS")}` + (version === void 0 ? "" : ` ${this.palette.dim(`v${displayText(version)}`)}`);
		const model = this.info.model();
		const title = this.info.title();
		const welcome = this.info.welcome;
		const cwd = displayText(this.info.cwd);
		const detail = (text) => wrapTextWithAnsi(this.palette.dim(text), usable).map((line) => truncateToWidth(line, usable, ""));
		return [
			truncateToWidth(wordmark, this.revealWidth ?? usable, ""),
			...detail(model === void 0 ? cwd : `${displayText(model)} · ${cwd}`),
			...this.info.resumed === void 0 ? [] : detail(t("banner.resumed", { id: displayText(this.info.resumed) }) + (title === void 0 ? "" : ` · ${displayText(title)}`)),
			...welcome === void 0 ? [] : detail(displayText(welcome)),
			...this.skillRows(usable)
		].map((line) => line === "" ? "" : ` ${line}`);
	}
	/**
	* The `[Skills]` section: its label row and the packed name rows, or nothing
	* when the entry supplied no skills.
	* @param usable - Columns a banner row may occupy.
	* @returns The section's rows, led by the blank row that separates it.
	*/
	skillRows(usable) {
		const names = (this.info.skills ?? []).map((name) => displayText(name).trim()).filter((name) => name !== "");
		if (names.length === 0) return [];
		return [
			"",
			this.palette.bold(this.palette.dim(SKILLS_LABEL)),
			...packSkillNames(names, usable).map((row) => truncateToWidth(this.palette.dim(row), usable, ""))
		];
	}
};
/**
* Claude Code's prompt pointer (`figures.pointer`), the only marker a user
* message carries. It renders in the recessed tone, upstream's `subtle`
* (`HighlightedThinkingText.tsx:91`).
*/
const PROMPT_POINTER = "❯";
/**
* Characters of one prompt beyond which the block prints a middle instead
* (`UserPromptMessage.tsx:28-30`): a pasted file is not worth scrolling past to
* reach the answer it asked for.
*/
const MAX_PROMPT_CHARS = 1e4;
/** Characters kept from each end when a prompt exceeds {@link MAX_PROMPT_CHARS}. */
const PROMPT_EDGE_CHARS = 2500;
/**
* Clip an over-long prompt to its two ends, counting the lines the middle drops.
* @param text - The prompt as submitted.
* @returns The text to render, unchanged when it is inside the budget.
*/
function clipPrompt(text) {
	if (text.length <= MAX_PROMPT_CHARS) return text;
	const head = text.slice(0, PROMPT_EDGE_CHARS);
	const tail = text.slice(-2500);
	return `${head}\n… +${text.slice(PROMPT_EDGE_CHARS, -2500).split("\n").length} lines …\n${tail}`;
}
/**
* A user or steering prompt in the transcript, rendered as Claude Code's
* borderless filled block: the `❯ ` pointer and then the prompt **as typed**, on
* the theme's user-message fill with one column of padding, which is what marks
* the user's own turns in a long transcript.
*
* The text is deliberately not a Markdown document. Upstream renders a user
* message through `HighlightedThinkingText`, which is plain `<Text>` with the
* pointer in front — only assistant output goes through `<Markdown>`. This port
* used to typeset it with pi-tui's Markdown while the answer above it went
* through the claude pipeline, so the same `$x^2$`, the same `*` and the same
* `#` came out one way in the question and another in the answer, and a prompt
* that quoted markup was rewritten before the user could check what they had
* sent. Echoing the prompt verbatim also removes the second dialect from the
* transcript entirely: one renderer, on assistant text alone.
*
* `_label` is retained from the boxed frame this replaced (no caller ever passed
* it): Claude Code's block names no role, so nothing is rendered for it.
*/
var UserMessageComponent = class {
	palette;
	/** The pointer and body, already sanitized; wrapped per width at render. */
	text;
	fill;
	cached;
	/**
	* @param text - The prompt as submitted.
	* @param palette - Active role palette.
	* @param scheme - Terminal color scheme, which picks the fill.
	* @param _label - Unused role name; see the class note.
	*/
	constructor(text, palette, scheme = "dark", _label = "You") {
		this.palette = palette;
		this.text = `${palette.dim(PROMPT_POINTER)} ${palette.text(displayText(clipPrompt(text)))}`;
		this.fill = claudeSchemeColors(scheme).userMessageBg;
	}
	invalidate() {
		this.cached = void 0;
	}
	render(width) {
		if (this.cached?.width === width) return this.cached.rows;
		const inner = Math.max(1, width - 2);
		const rows = wrapTextWithAnsi(this.text, inner).map((row) => truncateToWidth(row, inner, "", true));
		const painted = colorEnabled(this.palette) ? rows.map((row) => bg(this.fill, ` ${row} `)) : rows.map((row) => stripTerminalSequences(` ${row}`).trimEnd());
		this.cached = {
			width,
			rows: painted
		};
		return painted;
	}
};
/**
* Claude Code's thinking title: U+2234 and U+2026, dim and italic, on its own
* row (`AssistantThinkingMessage.tsx:62`). The block's body is dim but NOT
* italic and sits two columns in from the title, with one blank row between
* them — the product renders the pair as a `gap={1}` column, and the italic run
* is the title alone.
*/
const THINKING_TITLE = "∴ Thinking…";
/**
* Indent of a thinking body: the transcript's own {@link GUTTER} plus Claude
* Code's two columns (`<Box paddingLeft={2}>`), which also lands the body in the
* same column as an answer's text under its ` ● ` bullet.
*/
const THINKING_INDENT = GUTTER_INDENT;
/**
* Children of a settled assistant message: the optional thinking block then the
* response text. The response is a Markdown document behind Claude Code's
* orange ` ● ` bullet, so the message needs no role header at all: the bullet IS
* the marker. The thinking block is the product's own two-part shape — the
* `∴ Thinking…` title, a blank row, and the indented dim body — so an aside
* never reads as a second voice answering.
*
* A step with nothing to show renders nothing, not even its leading gap: a step
* that only calls tools is common, and its cards already open with a blank row
* of their own.
* @param showThinking - Whether this step's thinking block renders at all;
* {@link StreamingAssistantComponent.showsThinking} decides it from the
* configured setting, the Ctrl+T pin, the step's lifecycle, and the Ctrl+O
* phase.
*/
function assistantMessageChildren(content, showThinking, palette, mdTheme, markdown) {
	const reasoning = displayText(textBlocks(content, "reasoning").trim());
	const text = displayText(textBlocks(content, "text").trim());
	const showsThinking = reasoning !== "" && showThinking;
	if (!showsThinking && text === "") return [];
	const children = [new Spacer(1)];
	if (showsThinking) {
		const document = new Markdown(reasoning, 0, 0, mdTheme, { color: (value) => palette.dim(value) });
		children.push(new Text(palette.italic(palette.dim(`${GUTTER}${THINKING_TITLE}`)), 0, 0));
		children.push(new Spacer(1));
		children.push(new PrefixedComponent(document, THINKING_INDENT, THINKING_INDENT));
	}
	if (text !== "") {
		if (showsThinking) children.push(new Spacer(1));
		const document = new MarkdownBodyComponent(text, palette, mdTheme, markdown);
		children.push(new PrefixedComponent(document, `${GUTTER}${accent(palette, CLAUDE_COLORS.claude, "●")} `, GUTTER_INDENT));
	}
	return children;
}
/**
* Claude Code's plan-mode badge (`PAUSE_ICON`, `constants/figures.ts:17`).
*/
const PLAN_MODE_ICON = "⏸";
/**
* Claude Code's accept-edits badge (`permissionModeSymbol('acceptEdits')`,
* `utils/permissions/PermissionMode.ts`).
*/
const AUTO_ACCEPT_ICON = "⏵⏵";
/**
* One mode badge: the row Claude Code keeps at the left of the strip under its
* input frame (`PromptInputFooterLeftSide.tsx:348-355`), in that mode's tone,
* with the cycle key named after it in dim.
*
* Upstream's `<Text color={getModeColor(mode)}>{symbol} {title} on</Text>`
* followed by a `dimColor` shortcut hint, with the hint dropped once the footer
* carries two other pills. Nothing here counts pills, because nothing else
* shares the row.
* @param palette - Active role palette; decides whether the tone is emitted.
* @param color - The mode's tone for the active scheme.
* @param text - The badge sentence, already translated.
* @param hint - The parenthesised cycle hint, or `undefined` to leave it off.
* @returns The badge row, ready to render above the prompt.
*/
function modeRow(palette, color, text, hint) {
	const badge = accent(palette, color, `${GUTTER}${text}`);
	return hint === void 0 ? badge : `${badge} ${palette.dim(hint)}`;
}
/**
* The one permanent sign that this session is in plan mode: the badge Claude
* Code keeps at the left of the row under its input frame, in the theme's plan
* tone.
*
* The mode reaches this terminal as a folded `plan/mode` event and nothing on
* screen consumed it, so a session could sit in plan mode with the transcript
* and the prompt looking exactly as they do outside it — the user found out
* when the agent declined to edit. Upstream's badge is the whole visual
* treatment, deliberately: the input border does NOT change color in plan mode
* (`PromptInput.tsx:2214-2235` routes only bash and teammate colors), so a
* colored frame here would be a signal the product does not have.
*
* Upstream's trailing `(shift+tab to cycle)` hint used to be dropped here,
* because plan mode was only ever set through the session log and this terminal
* bound no key that cycled modes. `app.mode.cycle` is that key, so the hint is
* back — named from the installed keybinding manager by the caller, never
* written out, so a deployment that rebinds the action gets its own key printed.
* @param palette - Active role palette; decides whether the tone is emitted.
* @param scheme - Terminal color scheme, which picks the plan tone.
* @param hint - The cycle hint, already parenthesised and translated.
* @returns The badge row, ready to render above the prompt.
*/
function planModeRow(palette, scheme = "dark", hint) {
	return modeRow(palette, claudeSchemeColors(scheme).planMode, `${PLAN_MODE_ICON} ${t("transcript.planModeBadge")}`, hint);
}
/**
* The sign that this session runs its tool calls without asking: the
* auto-accept preset's badge, in upstream's electric violet.
*
* Named `auto-accept` rather than upstream's `accept edits`, because the state
* behind it is wider than editing: the preset sets `approval/policy` to `never`,
* so every tool this agent has runs unattended inside the workspace sandbox, not
* just the file writers. A badge that promised only edits would understate what
* the user just switched on.
* @param palette - Active role palette; decides whether the tone is emitted.
* @param scheme - Terminal color scheme, which picks the auto-accept tone.
* @param hint - The cycle hint, already parenthesised and translated.
* @returns The badge row, ready to render above the prompt.
*/
function autoAcceptRow(palette, scheme = "dark", hint) {
	return modeRow(palette, claudeSchemeColors(scheme).autoAccept, `${AUTO_ACCEPT_ICON} ${t("transcript.autoAcceptBadge")}`, hint);
}
/**
* Claude Code's past-tense turn verbs, copied from its
* `src/constants/turnCompletionVerbs.ts`. One is sampled per turn and reads as
* `<verb> for <duration>`.
*/
const TURN_COMPLETION_VERBS = [
	"Baked",
	"Brewed",
	"Churned",
	"Cogitated",
	"Cooked",
	"Crunched",
	"Sautéed",
	"Worked"
];
/**
* Claude Code's teardrop asterisk (`constants/figures.ts`), which the turn row
* puts in a two-column gutter (`<Box minWidth={2}>`).
*/
const TURN_GLYPH = "✻";
/**
* Format a turn's wall time the way Claude Code's `formatDuration` does: whole
* seconds under a minute (`45s`), minutes and seconds above it (`1m 23s`), and
* hours ahead of both for a run long enough to need them. A rounding carry
* (59.6 s) is carried up rather than printed as `1m 60s`.
* @param ms - Elapsed wall time in milliseconds.
* @returns The formatted duration.
*/
function formatTurnDuration(ms) {
	const elapsed = Math.max(0, ms);
	if (elapsed < 6e4) return `${Math.floor(elapsed / 1e3)}s`;
	let seconds = Math.round(elapsed % 6e4 / 1e3);
	let minutes = Math.floor(elapsed % 36e5 / 6e4);
	let hours = Math.floor(elapsed / 36e5);
	if (seconds === 60) {
		seconds = 0;
		minutes += 1;
	}
	if (minutes === 60) {
		minutes = 0;
		hours += 1;
	}
	return hours > 0 ? `${hours}h ${minutes}m ${seconds}s` : `${minutes}m ${seconds}s`;
}
/**
* One turn's verb, sampled uniformly like Claude Code's `sample()`. Sampled
* once per turn by the caller and held for that turn's whole life, so the row
* does not reword itself on a re-render.
* @returns One of {@link TURN_COMPLETION_VERBS}.
*/
function turnCompletionVerb() {
	return TURN_COMPLETION_VERBS[Math.floor(Math.random() * TURN_COMPLETION_VERBS.length)] ?? "Worked";
}
/**
* Claude Code's turn completion row — `✻ Worked for 45s`, dim, the glyph in the
* two-column gutter the product gives it (`<Box minWidth={2}>`), which here is
* the column the assistant bullet occupies: this transcript indents every row
* one column further than the product does, and this row is part of the
* conversation rather than a diagnostic under it.
*
* It is the only timing the default transcript reports. Claude Code has no
* per-message timing line anywhere, and prints this one only for a turn that
* ran longer than {@link TURN_FOOTER_MIN_MS}.
* @param durationMs - The turn's wall time.
* @param palette - Active palette; the row is entirely in the recessed tone.
* @param verb - The turn's verb, sampled when omitted.
* @returns The row's styled text.
*/
function turnFooterRow(durationMs, palette, verb = turnCompletionVerb()) {
	return palette.dim(`${GUTTER}${TURN_GLYPH} ${verb} for ${formatTurnDuration(durationMs)}`);
}
/**
* A step's timing summary, rendered as a self-refreshing footer that stays at
* the tail of the step's output. Kept separate from the assistant message so
* the timing line trails any tool cards the step appends after its message.
*
* Claude Code has no per-step timing line at all, so this one renders only on
* the expanded phase of the Ctrl+O cycle — the phase a user opens to inspect
* the run. The default transcript keeps the per-turn row alone.
*/
var StepTimingComponent = class extends Container {
	position;
	events;
	tracker;
	now;
	palette;
	visibility;
	completionTime;
	constructor(position, events, tracker, now, palette, visibility) {
		super();
		this.position = position;
		this.events = events;
		this.tracker = tracker;
		this.now = now;
		this.palette = palette;
		this.visibility = visibility;
		this.rebuild();
	}
	complete(time) {
		this.completionTime = time;
		this.rebuild();
	}
	/**
	* Set the Ctrl+O phase this footer renders under.
	* @param visibility - Hidden, collapsed preview, or full body.
	*/
	setVisibility(visibility) {
		this.visibility = visibility;
		this.rebuild();
	}
	invalidate() {
		this.rebuild();
		super.invalidate();
	}
	rebuild() {
		this.clear();
		if (this.visibility !== "expanded") return;
		const timing = formatTimingTotals(this.tracker.totalsAt(this.events(), this.position, this.completionTime ?? this.now()), true);
		const header = this.completionTime === void 0 ? timing : `${timing} · Completed ${formatCompletionTime(this.completionTime)}`;
		this.addChild(new Text(this.palette.dim(header), 0, 0));
	}
};
/** A live assistant step: streamed reasoning/text blocks until the message settles. */
var StreamingAssistantComponent = class extends Container {
	position;
	showReasoning;
	thinkingPinned;
	visibility;
	palette;
	mdTheme;
	markdown;
	blocks = /* @__PURE__ */ new Map();
	settledContent;
	/** The last folded text applied through {@link setFoldedText}, for idempotence. */
	foldedText;
	/** Whether this step's `assistant/message` has landed. */
	settled = false;
	/** Whether the step closed, including one a cancelled turn closed unsettled. */
	closed = false;
	/**
	* The step's timing footer. The renderer keeps it at the tail of the chat so
	* it trails any tool cards the step appends after this assistant message; it
	* is not a child of this component.
	*/
	timing;
	constructor(position, events, tracker, now, showReasoning, thinkingPinned, visibility, palette, mdTheme, markdown) {
		super();
		this.position = position;
		this.showReasoning = showReasoning;
		this.thinkingPinned = thinkingPinned;
		this.visibility = visibility;
		this.palette = palette;
		this.mdTheme = mdTheme;
		this.markdown = markdown;
		this.timing = new StepTimingComponent(position, events, tracker, now, palette, visibility);
		this.rebuild();
	}
	/**
	* Apply one step's folded text: the accumulated deltas while the step
	* streams, the settled message's text once it lands. Idempotent — an
	* unchanged triple rebuilds nothing — so a reconciler may call it for every
	* snapshot without re-rendering a step that did not move.
	* @param text - The step's response text so far, or its settled text.
	* @param reasoning - The step's reasoning text so far, or its settled reasoning.
	* @param settled - Whether the step's assistant message has landed.
	*/
	setFoldedText(text, reasoning, settled) {
		if (this.foldedText?.text === text && this.foldedText.reasoning === reasoning && this.foldedText.settled === settled) return;
		this.foldedText = {
			text,
			reasoning,
			settled
		};
		this.settled = settled;
		const content = [...reasoning === "" ? [] : [{
			type: "reasoning",
			text: reasoning
		}], ...text === "" ? [] : [{
			type: "text",
			text
		}]];
		this.blocks.clear();
		if (settled) this.settledContent = content.map((block) => block.type === "reasoning" ? {
			type: "reasoning",
			text: block.text
		} : {
			type: "text",
			text: block.text
		});
		else {
			this.settledContent = void 0;
			for (const [index, block] of content.entries()) this.blocks.set(index, block);
		}
		this.rebuild();
	}
	/**
	* Pin the step's timing footer to its completion time, and close the step:
	* its thinking is history from here, so the default transcript drops it —
	* unless Ctrl+T pinned it, which is what that key is for.
	* @param time - Step completion time in epoch milliseconds.
	*/
	complete(time) {
		this.closed = true;
		this.timing.complete(time);
		this.rebuild();
	}
	invalidate() {
		this.rebuild();
		this.timing.invalidate();
		super.invalidate();
	}
	/**
	* Pin or unpin this step's thinking block (Ctrl+T), then re-render.
	* @param pinned - Whether a finished step keeps its thinking on screen.
	*/
	setThinkingPinned(pinned) {
		this.thinkingPinned = pinned;
		this.rebuild();
	}
	/**
	* Set the Ctrl+O phase this step renders under: it decides whether a
	* finished step's thinking is on screen, and whether its timing footer is.
	* @param visibility - Hidden, collapsed preview, or full body.
	*/
	setVisibility(visibility) {
		this.visibility = visibility;
		this.timing.setVisibility(visibility);
		this.rebuild();
	}
	/**
	* Whether this step's thinking block is on screen.
	*
	* Claude Code keeps thinking out of the default transcript entirely — a
	* finished message's thinking is `null`, with no summary row standing in for
	* it — and shows it only under ctrl+o (its transcript mode). The one window
	* where it is live is the step itself: while the model streams, the block is
	* what says work is happening, and this port keeps that text rather than the
	* product's spinner-only line. So the block is on screen while the step runs,
	* disappears with the step that produced it, and comes back whole on the
	* expanded phase.
	*
	* Ctrl+T pins that window open: with it on, every step's thinking stays on
	* screen — this turn's and every earlier one's — because the switch is over
	* the transcript rather than over the model, which thinks either way. It is
	* checked before the Ctrl+O phase and independently of it: the two are
	* separate switches over the same rows, and neither takes the other over.
	* Pinned thinking therefore survives the hidden phase, and expanded still
	* brings thinking back with the tool bodies while the pin is off.
	*
	* A configured `showReasoning: false` still means never, in any phase and
	* whatever the pin says: that setting predates the cycle and is a deployment
	* saying this transcript does not show reasoning at all.
	*/
	showsThinking() {
		if (!this.showReasoning) return false;
		if (this.thinkingPinned) return true;
		if (this.visibility === "expanded") return true;
		return !this.settled && !this.closed;
	}
	/** The settled content when available, otherwise the streamed blocks in model order. */
	presentedContent() {
		return this.settledContent ?? [...this.blocks.entries()].sort(([left], [right]) => left - right).flatMap(([, block]) => {
			if (block.type === "text") return [{
				type: "text",
				text: block.text
			}];
			if (block.type === "reasoning") return [{
				type: "reasoning",
				text: block.text
			}];
			return [];
		});
	}
	rebuild() {
		this.clear();
		const children = assistantMessageChildren(this.presentedContent(), this.showsThinking(), this.palette, this.mdTheme, this.markdown);
		for (const child of children) this.addChild(child);
	}
};
/**
* Claude Code's tool bullet. The product ships the heavy `⏺` and falls back to
* the plain `●` off macOS, where the heavy glyph is commonly missing from the
* terminal font and renders as a replacement box.
*/
const TOOL_BULLET = process.platform === "darwin" ? "⏺" : "●";
/**
* The lead-in of a tool card's result block: Claude Code's `⎿` result glyph
* under the card's own tool name, then two columns of gap. Continuation rows
* align under the body with {@link RESULT_INDENT}, so a wrapped result reads as
* one left-aligned block rather than as a tree.
*
* The glyph sits at {@link GUTTER_WIDTH} — the column the header's tool name
* starts in — which is where Claude Code's `MessageResponse` prefix puts it
* (`"  ⎿  "` against a bullet at column 0).
*/
const RESULT_LEAD = `${GUTTER_INDENT}⎿  `;
/** The continuation indent of a result block: {@link RESULT_LEAD}'s width in spaces. */
const RESULT_INDENT = " ".repeat(RESULT_LEAD.length);
/** Columns a result row spends on its prefix, taken from the body width. */
const RESULT_PREFIX_WIDTH = RESULT_LEAD.length;
/** Drop leading and trailing blank rows, keeping interior ones. */
function trimBlankEdges(rows) {
	let start = 0;
	let end = rows.length;
	while (start < end && (rows[start] ?? "") === "") start += 1;
	while (end > start && (rows[end - 1] ?? "") === "") end -= 1;
	return rows.slice(start, end);
}
/**
* Every phase, in the order Ctrl+O walks them: the two common reading modes
* adjacent, then the conversation on its own. The `/config` row that sets the
* default steps through this same list, so the two surfaces cannot end up
* offering different words for the same three states.
*/
const TOOL_CARD_PHASES = [
	"collapsed",
	"expanded",
	"hidden"
];
/**
* Transcript card with a width-keyed rendered-row cache. pi-tui re-renders
* every component each frame and relies on per-component line caches (its own
* `Text`/`Markdown` do this); a card that rebuilds rows inside `render(width)`
* would re-wrap its output every frame
* ([rationale](../../../../../.agents/notes/implemented/bug-fix/2026-08-03-tui-long-session-render-costs.md)).
* Subclasses render through {@link renderLines} and call {@link dropLines}
* from every state mutator; with `invalidate()` (pi-tui's tree-wide cascade)
* also dropping, a state change always re-renders.
*/
var CachedCardComponent = class {
	cached;
	/** Discard the cached rows so the next render recomputes them. */
	dropLines() {
		this.cached = void 0;
	}
	invalidate() {
		this.cached = void 0;
	}
	render(width) {
		if (this.cached?.width !== width) this.cached = {
			width,
			lines: this.renderLines(width)
		};
		return this.cached.lines;
	}
};
/** A tool call and its result, rendered as a collapsible status card. */
var ToolCardComponent = class extends CachedCardComponent {
	name;
	parsed;
	definition;
	maxOutputLines;
	maxDiffEditLength;
	palette;
	mdTheme;
	expandKey;
	result;
	visibility = "collapsed";
	callView;
	resultView;
	diffBodyCache;
	constructor(name, parsed, definition, maxOutputLines, maxDiffEditLength, palette, mdTheme, expandKey) {
		super();
		this.name = name;
		this.parsed = parsed;
		this.definition = definition;
		this.maxOutputLines = maxOutputLines;
		this.maxDiffEditLength = maxDiffEditLength;
		this.palette = palette;
		this.mdTheme = mdTheme;
		this.expandKey = expandKey;
		this.callView = this.presentCall();
	}
	presentCall() {
		if (this.parsed.valid && this.definition?.presentCall) try {
			const view = this.definition.presentCall(this.parsed.value);
			if (view !== void 0) return view;
		} catch (error) {
			return {
				card: "generic",
				title: displayText(this.name),
				rawInput: `Presenter failed: ${String(error)}`
			};
		}
		return {
			card: "generic",
			title: displayText(this.name),
			rawInput: this.parsed.value
		};
	}
	/**
	* Record an already-projected tool result and derive its result view. Takes
	* the result rather than the event so a folded node can drive the card
	* without re-deriving the event payload.
	* @param result - The model-facing blocks, the failure flag, and the tool's `meta`.
	*/
	setResult(result) {
		this.diffBodyCache = void 0;
		this.dropLines();
		this.result = { ...result };
		if (this.parsed.valid && this.definition?.presentResult) try {
			const view = this.definition.presentResult(this.parsed.value, this.result);
			if (view !== void 0) this.resultView = view;
		} catch (error) {
			this.resultView = {
				card: "generic",
				content: [{
					type: "text",
					text: `Presenter failed: ${String(error)}`
				}]
			};
		}
	}
	/**
	* Set the card's visibility state.
	* @param visibility - Hidden, collapsed preview, or full body.
	*/
	setVisibility(visibility) {
		this.visibility = visibility;
		this.dropLines();
	}
	renderLines(width) {
		if (this.visibility === "hidden") return [];
		const expanded = this.visibility === "expanded";
		const inner = Math.max(20, width - RESULT_PREFIX_WIDTH);
		const rows = ["", this.headerRow(width)];
		let lead = true;
		for (const section of this.bodySections(inner, expanded)) {
			const sectionRows = section.fitted ? section.rows : section.rows.flatMap((row) => wrapTextWithAnsi(row, inner));
			for (const row of sectionRows) {
				if (lead) {
					lead = false;
					rows.push(`${this.palette.dim(RESULT_LEAD)}${row}`);
					continue;
				}
				rows.push(stripTerminalSequences(row).trim() === "" ? "" : `${RESULT_INDENT}${row}`);
			}
		}
		return plainIfNoColor(this.palette, rows);
	}
	/**
	* The card's one header row: `⏺ <tool>(<summary>)`. The bullet carries the
	* call's state as color (Claude Code's orange while the call is in flight,
	* green settled, red failed) and the tool name is bold, so a transcript scans
	* as a list of what ran; the parenthesized summary is the call's own one-line
	* detail (a command, an edited path) in the recessed tone.
	*/
	headerRow(width) {
		const isError = this.result?.isError ?? false;
		const status = this.result === void 0 ? CLAUDE_COLORS.claude : isError ? CLAUDE_COLORS.error : CLAUDE_COLORS.success;
		const bullet = this.palette.bold(accent(this.palette, status, TOOL_BULLET));
		const name = this.palette.bold(displayText(this.name));
		const summary = this.headerSummary();
		const text = summary === void 0 ? `${GUTTER}${bullet} ${name}` : `${GUTTER}${bullet} ${name}${this.palette.dim(`(${displayInlineText(summary)})`)}`;
		return truncateToWidth(text, Math.max(1, width - 2), "");
	}
	/**
	* The header's trailing detail: a terminal card's description (or its command
	* when it has none), and otherwise the presenter's title — skipped when the
	* title only repeats the tool name, which the header already shows.
	*/
	headerSummary() {
		const pending = this.terminalPending();
		if (pending !== void 0) {
			const description = pending.description;
			return description !== void 0 && description !== "" ? description : pending.title;
		}
		const title = this.resultView?.title ?? this.callView.title;
		return title === displayText(this.name) ? void 0 : title;
	}
	/** The pending terminal call view, when this row is a terminal card. */
	terminalPending() {
		return this.callView.card === "terminal" ? this.callView : void 0;
	}
	/**
	* The card's body, split into the blocks the branch tree hangs off.
	* @param inner - Width available to a body row, after the branch prefix.
	* @param expanded - Whether the full body is shown.
	*/
	bodySections(inner, expanded) {
		const view = this.resultView ?? this.callView;
		if (view.card === "terminal") return this.terminalSections(expanded);
		if (view.card === "diff") return [this.diffSection(view, inner, expanded)];
		return this.genericSections(view, inner, expanded);
	}
	/**
	* A terminal card's body: the command echo and its cwd as one block, the
	* captured output and exit status as another. Both keep the pre-Claude-Code
	* behaviour; only the output's truncation now goes through the shared preview.
	*/
	terminalSections(expanded) {
		const pending = this.terminalPending();
		const sections = [];
		const prelude = [];
		const headlined = pending?.description !== void 0 && pending.description !== "";
		if (pending !== void 0 && (headlined || this.result === void 0)) prelude.push(this.palette.dim(`$ ${displayInlineText(pending.title)}`));
		if (pending?.cwd !== void 0 && pending.cwd !== "") prelude.push(this.palette.dim(displayInlineText(pending.cwd)));
		if (prelude.length > 0) sections.push({
			rows: prelude,
			fitted: false
		});
		const output = [];
		const resultView = this.resultView;
		if (resultView?.card === "terminal") {
			if (resultView.output !== void 0 && resultView.output !== "") output.push(...this.previewOutput(resultView.output, expanded));
			if (resultView.exitCode !== void 0) output.push(this.palette.dim(`[exit ${resultView.exitCode}]`));
			if (resultView.signal !== void 0) output.push(this.palette.error(`[signal ${displayText(resultView.signal)}]`));
		} else if (this.result !== void 0) output.push(...this.previewOutput(contentText(this.result.content), expanded));
		if (output.length > 0) sections.push({
			rows: output,
			fitted: false
		});
		return sections;
	}
	/**
	* A tool's own output text as dim rows under the collapsed preview budget —
	* the card's result-output color, which separates what the tool produced from
	* the card's own framing. A blank row stays the empty string so it reads as
	* blank rather than as an ANSI-wrapped value.
	*/
	previewOutput(text, expanded) {
		return buildPreviewText(displayText(text).split("\n"), {
			expanded,
			previewLines: this.maxOutputLines,
			styleLine: (line) => line === "" ? line : this.palette.dim(line)
		}).split("\n");
	}
	/**
	* A diff card's body: each file's path, its rendered hunks, and one trailing
	* `+A -R` stat bar across every file. The rendered rows are already fitted to
	* the body width (they carry background fills that must not be re-wrapped), so
	* this section is marked `fitted` and the render is cached per width and fold
	* state — a diff is the one card body expensive enough to recompute.
	*/
	diffSection(view, inner, expanded) {
		const cached = this.diffBodyCache;
		if (cached?.view === view && cached.width === inner && cached.expanded === expanded) return cached.section;
		const rows = [];
		let added = 0;
		let removed = 0;
		let approximate = false;
		for (const [index, diff] of view.diffs.entries()) {
			if (index > 0) rows.push("");
			rows.push(truncateToWidth(this.palette.bold(displayText(diff.path)), inner, ""));
			const parsed = this.parseFileDiff(diff);
			added += parsed.diff.added;
			removed += parsed.diff.removed;
			if (parsed.approximate) {
				approximate = true;
				rows.push(this.palette.dim(`[exact line diff omitted: >${this.maxDiffEditLength} changed lines]`));
			}
			const language = diffLanguage(diff.path);
			rows.push(...renderDiff(parsed.diff, inner, {
				toggleHint: "ctrl+o to toggle",
				...expanded ? {} : { maxLines: Math.max(1, this.maxOutputLines) },
				...language === void 0 ? {} : { language }
			}));
		}
		const files = new Set(view.diffs.map((diff) => diff.path)).size;
		const trailer = `${files} file${files === 1 ? "" : "s"}${approximate ? " · approximate" : ""}`;
		rows.push(truncateToWidth(`${summarizeDiff(added, removed, inner)} ${this.palette.dim(`· ${trailer}`)}`, inner, ""));
		const section = {
			rows,
			fitted: true
		};
		this.diffBodyCache = {
			view,
			width: inner,
			expanded,
			section
		};
		return section;
	}
	/**
	* One file's parsed diff. A comparison beyond the edit-distance budget falls
	* back to whole-side rows (every old line removed, every new line added) so a
	* model-authored pending edit cannot stall the TUI; the caller labels that
	* fallback `approximate` because its totals are not exact change counts.
	*/
	parseFileDiff(diff) {
		const oldText = displayText(diff.oldText ?? "");
		const newText = displayText(diff.newText);
		const parsed = parseDiffBounded(oldText, newText, this.maxDiffEditLength);
		if (parsed !== void 0) return {
			diff: parsed,
			approximate: false
		};
		const oldLines = diffContentLines(oldText);
		const newLines = diffContentLines(newText);
		return {
			diff: {
				lines: [...oldLines.map((content, index) => ({
					type: "del",
					oldNum: index + 1,
					newNum: null,
					content
				})), ...newLines.map((content, index) => ({
					type: "add",
					oldNum: null,
					newNum: index + 1,
					content
				}))],
				added: newLines.length,
				removed: oldLines.length,
				chars: oldText.length + newText.length
			},
			approximate: true
		};
	}
	/**
	* Every other card's body. A generic card's own content, a read card's
	* `content` fallback (the envelope-stripped file text — the TUI has no
	* dedicated read rendering, so a read renders exactly as before the read card
	* existed), or a search/web card's fallback to the raw result content (neither
	* view carries a `content` copy) all render as one dim Markdown document, so
	* links/lists/headings keep the unified dim styling rather than reading as
	* bare text.
	*/
	genericSections(view, inner, expanded) {
		const markdownContent = view.card === "generic" || view.card === "read" ? view.content ?? this.result?.content : view.card === "search" ? this.result?.content : view.card === "web" ? this.result?.content : void 0;
		const unknownXml = this.definition === void 0 && markdownContent !== void 0 ? renderUnknownXml(displayText(contentText(markdownContent)), this.maxOutputLines, expanded, displayText, (text) => this.palette.dim(text), (text) => this.palette.dim(text), (count) => this.palette.dim(`  ${plural(count, "transcript.xmlOmitted", { key: this.expandKey().toLowerCase() })}`)) : void 0;
		if (unknownXml !== void 0) return [{
			rows: unknownXml,
			fitted: false
		}];
		const lines = [];
		if (markdownContent !== void 0) lines.push(...displayText(contentText(markdownContent)).split("\n"));
		const rawInput = this.result === void 0 && this.callView.card === "generic" ? this.callView.rawInput : void 0;
		if (rawInput !== void 0) lines.push(...pretty(rawInput).split("\n"));
		const trimmed = trimBlankEdges(lines);
		if (trimmed.length === 0) return [];
		const markdown = markdownContent !== void 0;
		const rows = markdown ? this.dimBody(trimmed, inner) : trimmed;
		return [{
			rows: foldRows(rows, expanded ? rows.length : this.maxOutputLines, this.palette),
			fitted: markdown
		}];
	}
	/**
	* Render a card's result as one Markdown document under the dim body tone.
	* Rendering the body as one document preserves its own block spacing
	* (Markdown's blank row before a heading); dimming every row keeps the card
	* body one uniform tone, so only the header bullet carries status color.
	*/
	dimBody(lines, width) {
		return new Markdown(lines.join("\n"), 0, 0, this.mdTheme, { color: (value) => this.palette.text(value) }).render(width).map((row) => row.trim() === "" ? row : this.palette.dim(row));
	}
};
/** Capitalize a fragment when it opens the sentence, leave it alone otherwise. */
function opener(text, first) {
	return first ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}
/**
* Word one collapsed group's summary row.
*
* Present tense while the group runs (`Thinking for 4s, reading 1 file…`), past
* tense once it settles (`Thought for 8s, searched for 2 patterns, read 1
* file`). The first fragment opens with a capital, later ones do not, and each
* fragment agrees with its own count — and with its own clock: a group whose
* calls have all landed reads `Thinking for 4s, read 2 files…`, because the
* files are read and the thought is not finished.
*
* The thinking the run opened with leads the sentence, because that is the
* order it happened in: the model thought, then it went looking. A group that
* absorbed no thinking prints no such fragment and reads exactly as before.
* While the thinking is still open the row is in progress by definition, so
* `now` is what makes its counter move between two events — the group carries
* the span's start, not its length (see `groupThinkingMs`).
*
* Each fragment is one message rather than a verb and a noun joined here, so a
* locale can move the count, drop the plural, or reorder the clause; the
* capitalization is a no-op in a script without letter case.
* @param group - The planned group.
* @param now - Render clock, for a group whose thinking is still running.
* @returns The row's text, without the expand hint.
*/
function collapsedSummary(group, now) {
	const parts = [];
	const phase = group.running ? "active" : "settled";
	const fragment = (kind, count) => {
		parts.push(opener(plural(count, `collapse.${kind}.${phase}`), parts.length === 0));
	};
	const thinking = groupThinkingMs(group, now);
	if (thinking >= 1e3) {
		const tense = group.thinkingSince === void 0 ? "settled" : "active";
		parts.push(opener(t(`collapse.thinking.${tense}`, { duration: formatTurnDuration(thinking) }), true));
	}
	if (group.searchCount > 0) fragment("search", group.searchCount);
	if (group.readCount > 0) fragment("read", group.readCount);
	if (group.listCount > 0) fragment("list", group.listCount);
	if (group.mcpCallCount > 0) {
		const server = group.mcpServers.length > 0 ? group.mcpServers.join(t("collapse.separator")) : "MCP";
		parts.push(opener(plural(group.mcpCallCount, `collapse.mcp.${phase}`, { server }), parts.length === 0));
	}
	const text = parts.join(t("collapse.separator"));
	return group.active ? `${text}${t("collapse.ellipsis")}` : text;
}
/**
* One run of read-only calls, rendered as the single row that replaces their
* cards on the collapsed phase — Claude Code's `CollapsedReadSearchContent`.
*
* The row is the transcript's default answer to "what has it been doing": a
* sentence of counts (`Searched for 3 patterns, read 2 files`) rather than one
* card per file. While a call of the group is running the counts are
* present-tense and a `⎿` row names the call in flight; while anything at all
* is still going — a call, or the thinking the row absorbed — it keeps its
* leading bullet and its ellipsis. Once both are over the bullet goes and the
* whole row recedes, exactly as upstream. The group's own cards come back on
* the expanded phase, where the reconciler mounts them instead of this row.
*
* The one addition to upstream's row: a group that contains a failed call keeps
* its bullet, in the error color, after it settles. A collapsed row is the only
* thing on screen for those calls, and a failure that leaves no mark at all is
* a failure the user never learns about.
*
* The row also opens with the thinking that led to the run (`Thought for 8s,
* read 2 files`), which is where this transcript states a thinking duration at
* all — the thinking block itself keeps its own rule and disappears with the
* step. While that thinking is still open the row re-renders per frame, so its
* counter moves with the clock rather than with the next event.
*/
var CollapsedGroupComponent = class extends CachedCardComponent {
	group;
	palette;
	displayPath;
	expandKey;
	now;
	/**
	* @param group - The planned group this row reports.
	* @param palette - Active role palette.
	* @param displayPath - Shortens an absolute path for the `⎿` hint.
	* @param expandKey - The label of whichever key currently cycles tool cards,
	*   read per render: `app.tools.cycle` is rebindable, and a row that named
	*   the default key after a deployment moved it would send every reader to a
	*   key that does nothing.
	* @param now - Render clock, read per render so a group still thinking counts
	*   up; a group whose thinking has closed never consults it. Injected rather
	*   than defaulted to `Date.now`, like every other clock in this bundle: a
	*   row that reads the process clock cannot be rendered from a test.
	*/
	constructor(group, palette, displayPath, expandKey, now) {
		super();
		this.group = group;
		this.palette = palette;
		this.displayPath = displayPath;
		this.expandKey = expandKey;
		this.now = now;
	}
	/**
	* Apply the group's current counts; a running group re-seals on every
	* snapshot as its calls land.
	* @param group - The freshly planned group.
	*/
	setGroup(group) {
		this.group = group;
		this.dropLines();
	}
	renderLines(width) {
		const group = this.group;
		const summary = collapsedSummary(group, this.now());
		const bullet = group.active ? this.palette.bold(accent(this.palette, group.failed ? CLAUDE_COLORS.error : CLAUDE_COLORS.claude, TOOL_BULLET)) : group.failed ? accent(this.palette, CLAUDE_COLORS.error, TOOL_BULLET) : " ";
		const head = `${group.active ? this.palette.text(summary) : this.palette.dim(summary)} ${this.palette.dim(t("collapse.expandHint", { key: this.expandKey().toLowerCase() }))}`;
		const rows = [""];
		let first = true;
		for (const row of wrapTextWithAnsi(head, Math.max(20, width - GUTTER_WIDTH - 2))) {
			rows.push(first ? `${GUTTER}${bullet} ${row}` : `${GUTTER_INDENT}${row}`);
			first = false;
		}
		const inFlight = this.hintInFlight();
		if (inFlight !== void 0) {
			const inner = Math.max(20, width - RESULT_PREFIX_WIDTH);
			const hint = formatCollapseHint(inFlight, this.displayPath);
			let lead = true;
			for (const line of displayText(hint).split("\n")) for (const row of wrapTextWithAnsi(this.palette.dim(line), inner)) {
				rows.push(lead ? `${this.palette.dim(RESULT_LEAD)}${row}` : `${RESULT_INDENT}${row}`);
				lead = false;
			}
		}
		return plainIfNoColor(this.palette, rows);
	}
	/**
	* The group's `⎿` hint, when it still names something that is happening.
	*
	* A call's path, pattern or command holds the row only while a call is
	* actually running; once they have all landed, the newest one is a finished
	* operation and pointing at it would claim work that is over. A thinking line
	* holds the row only while the thinking is open, for the same reason. A group
	* whose calls have settled under an open thought therefore shows no hint at
	* all unless the thought itself is what the group has to point at.
	* @returns The hint to render, or `undefined` for no hint row.
	*/
	hintInFlight() {
		const { hint } = this.group;
		if (hint === void 0) return void 0;
		if (hint.kind === "thinking") return this.group.thinkingSince === void 0 ? void 0 : hint;
		return this.group.running ? hint : void 0;
	}
};
/**
* Matches a lone reminder-frame tag on its own line, capturing the element name.
* Producers emit the frame as whole lines (`workspace-context`, `dsh-tool-skill`),
* so anchoring the whole line keeps a tag mentioned inside prose from matching.
*/
const REMINDER_FRAME_LINE = /^<(\/?)([a-zA-Z][\w:.-]*)>$/u;
/**
* Drop a producer's outer reminder frame, keeping the instruction body verbatim.
* The card header already names the source, so the frame lines carry nothing.
* Only a matched open/close pair on the first and last lines is removed, so a
* body that merely starts with a tag-like line is left intact.
* @param text - Complete model-facing context text.
* @returns The body without its outer frame lines, trimmed of the blank lines they leave.
*/
function stripReminderFrame(text) {
	const [first = "", ...rest] = text.split("\n");
	const last = rest.at(-1);
	if (last === void 0) return text;
	const open = REMINDER_FRAME_LINE.exec(first.trim());
	const close = REMINDER_FRAME_LINE.exec(last.trim());
	if (open?.[1] !== "" || close?.[1] !== "/" || open[2] !== close[2]) return text;
	return rest.slice(0, -1).join("\n").replace(/^\n+|\n+$/gu, "");
}
/**
* Injected context (plugin/goal source, e.g. `workspace-context`), rendered as a
* dim card under a `Context · <label>` header, with a surrounding reminder frame
* stripped because the source label already names the context.
*
* The card has one state, not two. It is mounted only by the expanded phase of
* the Ctrl+O cycle ({@link ToolCardVisibility}), because this text was never
* written for the user: it is the runtime snapshot and skill catalog the
* producers hand the model on every request. Claude Code puts none of that in
* the conversation, and the one-row `Context · <label> (ctrl+o)` placeholder
* this card used to render collapsed still spent a row of every fresh screen —
* and one per request thereafter — on traffic nobody reads. Ctrl+O is where a
* user goes to see what the model was actually sent; until then the transcript
* is the conversation and nothing else.
*
* Injected context is prose, not markup, so this card does not parse it. The
* `<system-reminder>` frame is a prompting convention no model is trained on
* ([envelope rationale](../../../../../.agents/notes/implemented/simplification/2026-07-20-unwrap-injected-content-envelopes.md)),
* and instruction bodies legitimately contain a raw `&` or angle-bracket
* placeholders (`packages/<group>/<pkg>/`, `-t <name>`) that are prose rather than
* elements. Tree-rendering such a payload depended on whether it happened to be
* well-formed XML, which made both the fold and the frame-line suppression
* content-dependent.
*/
var ContextCardComponent = class extends CachedCardComponent {
	label;
	text;
	palette;
	constructor(label, text, palette) {
		super();
		this.label = label;
		this.text = text;
		this.palette = palette;
	}
	renderLines(width) {
		const header = this.palette.dim(`Context · ${displayText(this.label)}`);
		const stripped = stripReminderFrame(this.text);
		if (stripped === "") return [header];
		const body = stripped.split("\n").map((line) => line === "" ? line : this.palette.dim(displayText(line)));
		return [header, ...new Text(body.join("\n"), 0, 0).render(width)];
	}
};
/** Terminal rows the plan panel never grows past, matching Claude Code's own cap. */
const TODO_MAX_ROWS = 10;
/**
* Rows the screen owes the transcript, the prompt and the status line before the
* plan panel may spend any: below this the panel shows its one-line summary
* whatever the user asked for.
*/
const TODO_ROW_RESERVE = 14;
/** Order the expanded panel drops items in when it cannot show them all. */
const TODO_PRIORITY = {
	in_progress: 0,
	pending: 1,
	completed: 2
};
/**
* The plan/todo panel rendered above the prompt, expanded or collapsed.
*
* The panel used to be unconditional: any session whose agent wrote a plan paid
* for it on every frame, with no key that took it back down. Ctrl+N collapses it
* to a single summary row — what is left to do and what is being done now —
* which is the same trade Claude Code offers, and the same one a long plan on a
* short terminal forces anyway.
*/
var TodoComponent = class {
	palette;
	terminalRows;
	todos = [];
	expanded = true;
	/**
	* @param palette - Active role palette.
	* @param terminalRows - The terminal's current height, read per render so a
	*   resize re-budgets the panel; the default leaves the panel unbounded for
	*   callers (tests, snapshots) that measure it on its own.
	*/
	constructor(palette, terminalRows = () => Number.MAX_SAFE_INTEGER) {
		this.palette = palette;
		this.terminalRows = terminalRows;
	}
	/**
	* Replace the rendered plan items.
	* @param todos - The current todo items.
	*/
	update(todos) {
		this.todos = todos;
	}
	/** Whether this session has a plan at all, which is what makes Ctrl+N meaningful. */
	hasTodos() {
		return this.todos.length > 0;
	}
	/** Whether the panel is showing its items rather than its one-line summary. */
	isExpanded() {
		return this.expanded;
	}
	/**
	* Show the items or the summary row.
	* @param expanded - `true` for the item list, `false` for the summary row.
	*/
	setExpanded(expanded) {
		this.expanded = expanded;
	}
	invalidate() {}
	/**
	* Items in display order, most urgent first, so a truncated panel drops the
	* least interesting rows rather than whatever happens to sort last.
	* @returns The items, in-progress first and completed last.
	*/
	ordered() {
		return [...this.todos].map((todo, index) => ({
			todo,
			index
		})).sort((left, right) => TODO_PRIORITY[left.todo.status] - TODO_PRIORITY[right.todo.status] || left.index - right.index).map((entry) => entry.todo);
	}
	/**
	* How many items the expanded panel may show on this terminal.
	* @returns The item budget; zero on a terminal with no room to spare.
	*/
	itemBudget() {
		const rows = this.terminalRows();
		if (rows <= TODO_MAX_ROWS) return 0;
		return Math.min(TODO_MAX_ROWS, Math.max(3, rows - TODO_ROW_RESERVE));
	}
	/** One item as its icon and text, already truncated to the width. */
	renderItem(todo, width) {
		const icon = todo.status === "completed" ? accent(this.palette, CLAUDE_COLORS.success, "✔") : todo.status === "in_progress" ? accent(this.palette, CLAUDE_COLORS.claude, "◼") : this.palette.dim("◻");
		const content = displayText(todo.content);
		const text = todo.status === "completed" ? this.palette.strike(this.palette.dim(content)) : todo.status === "in_progress" ? this.palette.bold(content) : content;
		return truncateToWidth(`  ${icon} ${text}`, width, "");
	}
	/** Counts of each status, for the summary and overflow rows. */
	counts(todos) {
		return {
			inProgress: todos.filter((todo) => todo.status === "in_progress").length,
			pending: todos.filter((todo) => todo.status === "pending").length,
			completed: todos.filter((todo) => todo.status === "completed").length
		};
	}
	/**
	* The collapsed row: how much of the plan is done, and what is being worked
	* on now (or what comes next when nothing is in flight).
	* @param width - Render width.
	* @returns The single summary row.
	*/
	renderSummary(width) {
		const { completed } = this.counts(this.todos);
		const active = this.todos.find((todo) => todo.status === "in_progress") ?? this.todos.find((todo) => todo.status === "pending");
		const next = active === void 0 ? "" : ` · Next: ${displayText(active.content)}`;
		const summary = `Plan ${String(completed)}/${String(this.todos.length)} done${next}`;
		return truncateToWidth(this.palette.dim(`  ${summary}`), width, "…");
	}
	render(width) {
		if (this.todos.length === 0) return [];
		const budget = this.itemBudget();
		if (!this.expanded || budget === 0) return plainIfNoColor(this.palette, ["", this.renderSummary(width)]);
		const ordered = this.ordered();
		const shown = ordered.slice(0, budget);
		const hidden = this.counts(ordered.slice(budget));
		const lines = [this.palette.bold(this.palette.accent("Plan"))];
		for (const todo of shown) lines.push(this.renderItem(todo, width));
		const overflow = [
			hidden.inProgress === 0 ? void 0 : `${String(hidden.inProgress)} in progress`,
			hidden.pending === 0 ? void 0 : `${String(hidden.pending)} pending`,
			hidden.completed === 0 ? void 0 : `${String(hidden.completed)} completed`
		].filter((part) => part !== void 0);
		if (overflow.length > 0) lines.push(truncateToWidth(this.palette.dim(`   … +${overflow.join(", ")}`), width, ""));
		return plainIfNoColor(this.palette, ["", ...lines]);
	}
};
t("transcript.compactionMarker", void 0, "en");
t("transcript.steeringBadge", void 0, "en");
/**
* The status line one Ctrl+O phase reports.
*
* Only the expanded phase renders injected context at all (see
* {@link TranscriptReconciler.reconcile}), so the collapsed sentence no longer
* claims to be showing context cards: it names what each kind of card actually
* does in that phase — including the read/search runs it reports as one row.
* The hidden and expanded sentences are unchanged, because what they said was
* already true.
* @param visibility - The phase the cycle just entered.
* @returns One sentence naming what that phase leaves on screen.
*/
function cardPhaseNotice(visibility) {
	if (visibility === "hidden") return t("status.flash.cardsHidden");
	if (visibility === "expanded") return t("status.flash.cardsExpanded");
	return t("status.flash.cardsCollapsed");
}
/**
* A collapsed row's view key: the first member's node key, prefixed so it can
* never collide with that member's own card key. The first member of a group is
* stable — the log only appends, so nothing can land above it.
*/
function groupKey(group) {
	return `collapsed:${group.keys[0] ?? group.index}`;
}
/**
* Everything a collapsed row shows, as one string. The group is re-planned from
* scratch on every snapshot, so the mounted component is refreshed by what the
* row would say rather than by object identity — a group whose counts did not
* move keeps its cached rows.
*/
function groupSignature(group) {
	return [
		group.searchCount,
		group.readCount,
		group.listCount,
		group.mcpCallCount,
		group.mcpServers.join("|"),
		group.thinkingMs,
		group.thinkingSince ?? "",
		group.running,
		group.active,
		group.failed,
		group.hint?.kind ?? "",
		group.hint?.value ?? ""
	].join(" ");
}
/**
* Wall time of each turn, replayed from the log's `turn/start`/`turn/end` pair.
*
* The turn's own bracket is the measurement, not the sum of its steps: the row
* it feeds answers "how long did this take me", which includes the gaps between
* steps that no step's timing bucket owns. Like {@link StepTimingTracker} it
* advances a cursor over the appended tail rather than replaying the log per
* query, so a transcript of T turns costs one pass over the events in total.
*/
var TurnDurationTracker = class {
	scanned = 0;
	turns = /* @__PURE__ */ new Map();
	/**
	* Advance over events appended since the previous query, then read one turn's
	* wall time.
	* @param events - Current session event log (append-only).
	* @param turn - The turn index to measure.
	* @returns Elapsed milliseconds, or `undefined` while the turn is still open.
	*/
	durationOf(events, turn) {
		for (; this.scanned < events.length; this.scanned += 1) {
			const event = events[this.scanned];
			if (event.type === "turn/start") {
				if (!this.turns.has(event.data.turn)) this.turns.set(event.data.turn, {
					start: event.time,
					end: void 0
				});
			} else if (event.type === "turn/end") {
				const state = this.turns.get(event.data.turn);
				if (state !== void 0) state.end ??= event.time;
			}
		}
		const state = this.turns.get(turn);
		if (state?.end === void 0) return void 0;
		return Math.max(0, state.end - state.start);
	}
};
/** A leading blank row plus the row itself, the transcript's block spacing. */
function block(child) {
	const container = new Container();
	container.addChild(new Spacer(1));
	container.addChild(child);
	return container;
}
/** The keyed reconciler over one chat container. */
var TranscriptReconciler = class {
	chat;
	deps;
	views = /* @__PURE__ */ new Map();
	/** Process-local row groups keyed by the node count they were appended after. */
	locals = /* @__PURE__ */ new Map();
	/** Nodes before this index are not rendered (`/clear` hides history). */
	hiddenBefore = 0;
	/**
	* Steps `/clear` hid while they were still open, so the calls they request
	* after the cut are hidden with them. Read live: `toolCalls` keeps growing on
	* the same node object as the step runs on.
	*/
	hiddenSteps = [];
	/** The last reconciled node list, so a view-state change can re-place it. */
	nodes = [];
	nodeCount = 0;
	visibility;
	/** The deployment's master switch: false means no step ever renders thinking. */
	showReasoning;
	/** Ctrl+T: whether a finished step keeps its thinking block on screen. */
	thinkingPinned;
	/** The open step's component, so an animation tick refreshes only that step. */
	openStep;
	/**
	* The collapsed row whose thinking is still open, refreshed on the same tick:
	* its duration counts up against the clock, not against the node list, so no
	* snapshot is due while the model is thinking between two events.
	*/
	openGroup;
	/** Wall time of every turn in the log, for the per-turn completion row. */
	turnDurations = new TurnDurationTracker();
	/**
	* One completion row per turn, built once the turn ends. Held rather than
	* rebuilt so the sampled verb — and with it the row's wording — stays put
	* across the re-renders every later snapshot triggers.
	*/
	turnFooters = /* @__PURE__ */ new Map();
	/**
	* The verb each turn's row was worded with, kept apart from the rows.
	*
	* A palette change remounts every row, and a re-sample there would reword
	* turns the user already read — the wording is a property of the turn, not of
	* the row that happens to be mounted for it.
	*/
	turnVerbs = /* @__PURE__ */ new Map();
	constructor(chat, deps, view) {
		this.chat = chat;
		this.deps = deps;
		this.showReasoning = view.showReasoning;
		this.thinkingPinned = view.thinkingPinned ?? false;
		this.visibility = view.visibility;
	}
	/**
	* Rebuild the chat container from a folded node list.
	* @param nodes - the snapshot's nodes, in log order.
	*/
	reconcile(nodes) {
		this.nodes = nodes;
		this.nodeCount = nodes.length;
		const seen = /* @__PURE__ */ new Set();
		const children = [];
		let openStep;
		let openGroup;
		let footer;
		const flushFooter = () => {
			if (footer === void 0) return;
			children.push(footer.component);
			footer = void 0;
		};
		let turn;
		const reported = /* @__PURE__ */ new Set();
		const flushTurn = () => {
			const closing = turn;
			turn = void 0;
			if (closing === void 0 || reported.has(closing)) return;
			const row = this.turnFooter(closing);
			if (row === void 0) return;
			reported.add(closing);
			children.push(row);
		};
		const emitLocals = (anchor) => {
			const groups = this.locals.get(anchor);
			if (groups === void 0) return;
			flushFooter();
			for (const group of groups) children.push(...group.components);
		};
		const collapsed = this.visibility === "collapsed" ? collapseToolGroups(nodes, {
			from: this.hiddenBefore,
			isHidden: (id) => this.isHiddenCall(id),
			showReasoning: this.showReasoning
		}) : /* @__PURE__ */ new Map();
		for (let index = this.hiddenBefore; index < nodes.length; index += 1) {
			const node = nodes[index];
			/* v8 ignore next -- the loop bound keeps the index inside the array. */
			if (node === void 0) continue;
			emitLocals(index);
			if (node.kind === "tool-call") {
				if (!node.argsComplete || this.isHiddenCall(node.callId)) continue;
				const group = collapsed.get(index);
				if (group !== void 0) {
					if (group.index !== index) continue;
					const row = this.groupView(group);
					seen.add(groupKey(group));
					if (group.thinkingSince !== void 0) openGroup = row;
					if (footer?.calls.includes(node.callId) !== true) flushFooter();
					children.push(row);
					continue;
				}
				const card = this.toolView(node);
				seen.add(node.key);
				if (footer?.calls.includes(node.callId) !== true) flushFooter();
				children.push(card);
				continue;
			}
			flushFooter();
			if (node.kind === "user-message" ? node.source !== "steering" : node.kind === "assistant" && node.turn !== turn) flushTurn();
			if (node.kind === "assistant") turn = node.turn;
			switch (node.kind) {
				case "assistant": {
					const view = this.assistantView(node);
					seen.add(node.key);
					children.push(view);
					if (node.completedAt === void 0) openStep = view;
					footer = {
						component: view.timing,
						calls: node.toolCalls
					};
					break;
				}
				case "todo":
					seen.add(node.key);
					break;
				case "compaction":
					if (!node.landed) break;
					seen.add(node.key);
					children.push(this.plainView(node.key, node.version, () => block(new Text(this.deps.palette.dim(t("transcript.compactionMarker")), 0, 0))));
					break;
				case "context":
					if (this.visibility !== "expanded") break;
					seen.add(node.key);
					children.push(this.plainView(node.key, node.version, () => block(new ContextCardComponent(node.label, node.text, this.deps.palette))));
					break;
				case "reference":
					seen.add(node.key);
					children.push(this.plainView(node.key, node.version, () => block(new Text(this.deps.palette.dim(t("notice.referencedSessions", { labels: node.labels.map(displayText).join(", ") })), 0, 0))));
					break;
				case "user-message":
					if (node.withdrawn === true) break;
					seen.add(node.key);
					children.push(this.plainView(node.key, node.version, () => this.userView(node)));
					break;
				case "notice":
					seen.add(node.key);
					children.push(this.plainView(node.key, node.version, () => block(new Text(this.tone(node.tone)(displayText(node.text)), 0, 0))));
			}
		}
		flushFooter();
		flushTurn();
		emitLocals(nodes.length);
		for (const [key] of this.views) if (!seen.has(key)) this.views.delete(key);
		this.openStep = openStep;
		this.openGroup = openGroup;
		this.chat.clear();
		for (const child of children) this.chat.addChild(child);
	}
	/**
	* Append process-local rows (command output, notices, diagnostics) after the
	* transcript's current tail.
	*
	* The caller supplies a builder rather than components so the rows survive a
	* palette swap: {@link TranscriptReconciler.reset} re-runs it under the new
	* palette instead of dropping the answer the user is still reading. The
	* builder must therefore read the palette it paints with at call time (the
	* entry's palette object is mutated in place), not close over pre-styled text.
	* @param build - Builds this group's rows, in render order.
	*/
	appendLocal(build) {
		const group = {
			build,
			components: build()
		};
		const groups = this.locals.get(this.nodeCount);
		if (groups === void 0) this.locals.set(this.nodeCount, [group]);
		else groups.push(group);
		for (const component of group.components) this.chat.addChild(component);
	}
	/**
	* Hide every row rendered so far (`/clear`). The session log is unchanged, so
	* later nodes keep folding onto the same model; only this view is truncated.
	*
	* A step the cut hides takes its whole output with it, including the tool
	* cards it has not requested yet: those fold at indices below the cut and
	* would otherwise render with no message and no timing footer above them.
	* Only a step still open at the cut can do that — a closed step logged every
	* one of its calls before its `step/end`.
	*/
	clearTranscript() {
		this.hiddenBefore = this.nodeCount;
		this.hiddenSteps = this.nodes.filter((node) => node.kind === "assistant" && node.completedAt === void 0);
		this.locals.clear();
		this.views.clear();
		this.turnFooters.clear();
		this.chat.clear();
	}
	/**
	* Drop every mounted component so the next reconcile rebuilds them — the
	* palette and Markdown theme are captured at construction, so a color-scheme
	* change has to remount.
	*
	* Process-local rows are rebuilt here rather than dropped. They have no node
	* to be re-derived from, so clearing them (as this did) threw away every
	* command result and notice on screen the first time the terminal reported a
	* scheme — the answer to the command the user had just run disappeared, and
	* nothing brought it back. Each group's builder re-runs under the palette
	* that is current now, which is the same remount every other row gets.
	*/
	reset() {
		this.views.clear();
		for (const groups of this.locals.values()) for (const group of groups) group.components = group.build();
		this.turnFooters.clear();
		this.chat.clear();
	}
	/**
	* Set the Ctrl+O card visibility on every mounted card.
	*
	* A tool card and an assistant step both carry the phase — the step's
	* finished thinking and its timing footer are on screen only where the tool
	* bodies are. A context card has no collapsed form, so the reconcile below is
	* what mounts it on the expanded phase and drops it again on the other two.
	* @param visibility - hidden, collapsed preview, or full body.
	*/
	setVisibility(visibility) {
		this.visibility = visibility;
		for (const view of this.views.values()) if (view.kind === "tool") view.component.setVisibility(visibility);
		else if (view.kind === "assistant") view.component.setVisibility(visibility);
		this.reconcile(this.nodes);
	}
	/**
	* Pin or unpin thinking blocks on every mounted assistant step (Ctrl+T).
	*
	* Applied to the mounted components rather than through a remount, so the
	* open step keeps streaming into the same component and the rows above it
	* keep their positions while history gains or loses its asides.
	* @param pinned - whether a finished step keeps its thinking on screen.
	*/
	setThinkingPinned(pinned) {
		this.thinkingPinned = pinned;
		for (const view of this.views.values()) if (view.kind === "assistant") view.component.setThinkingPinned(pinned);
		this.reconcile(this.nodes);
	}
	/**
	* Refresh the two rows whose text moves with the clock rather than with the
	* log — the open step's timing footer and the collapsed row of a group that
	* is still thinking — for the status animation tick. Only those components
	* are invalidated, so a long transcript is not re-rendered 20 times a second.
	*/
	invalidateOpenStep() {
		this.openStep?.invalidate();
		this.openGroup?.invalidate();
	}
	/**
	* One turn's completion row, or `undefined` when that turn prints none.
	*
	* This is Claude Code's only timing report on the transcript: one dim
	* `✻ <verb> for <duration>` at the end of a turn, and only for a turn that
	* ran longer than {@link TURN_FOOTER_MIN_MS} — a turn the user watched
	* complete needs no receipt. It renders on every phase of the Ctrl+O cycle,
	* because unlike the per-step breakdown it is part of the conversation.
	* @param turn - The turn index to report.
	* @returns The mounted row, or `undefined` while the turn is open or short.
	*/
	turnFooter(turn) {
		const existing = this.turnFooters.get(turn);
		if (existing !== void 0) return existing;
		const elapsed = this.turnDurations.durationOf(this.deps.events(), turn);
		if (elapsed === void 0 || elapsed <= 3e4) return void 0;
		const verb = this.turnVerbs.get(turn) ?? turnCompletionVerb();
		this.turnVerbs.set(turn, verb);
		const component = block(new Text(turnFooterRow(elapsed, this.deps.palette, verb), 0, 0));
		this.turnFooters.set(turn, component);
		return component;
	}
	/** Whether one call belongs to a step `/clear` hid while it was open. */
	isHiddenCall(callId) {
		for (const step of this.hiddenSteps) if (step.toolCalls.includes(callId)) return true;
		return false;
	}
	/** Palette role for a notice tone. */
	tone(tone) {
		const palette = this.deps.palette;
		if (tone === "error") return (value) => palette.error(value);
		if (tone === "warning") return (value) => palette.warning(value);
		return (value) => palette.dim(value);
	}
	/** Mount or reuse a component that never updates after creation. */
	plainView(key, version, create) {
		const existing = this.views.get(key);
		if (existing !== void 0 && existing.kind === "plain" && existing.version === version) return existing.component;
		const component = create();
		this.views.set(key, {
			kind: "plain",
			version,
			component
		});
		return component;
	}
	/**
	* Build one user turn: the filled prompt block, under a `Steering` badge when
	* the turn interrupted a running one. Claude Code's block names no role, so
	* an ordinary prompt carries no label at all and the badge is the exception
	* that says this text reached the model mid-answer.
	*/
	userView(node) {
		const body = new UserMessageComponent(node.text, this.deps.palette, this.deps.scheme());
		if (node.source !== "steering") return block(body);
		const container = new Container();
		container.addChild(new Spacer(1));
		container.addChild(new Text(this.deps.palette.dim(t("transcript.steeringBadge")), 0, 0));
		container.addChild(body);
		return container;
	}
	/** Mount or update one assistant step, keeping its streamed buffer in sync. */
	assistantView(node) {
		const existing = this.views.get(node.key);
		if (existing !== void 0 && existing.kind === "assistant") {
			if (existing.version !== node.version) {
				existing.version = node.version;
				existing.component.setFoldedText(node.text, node.reasoning, node.settled);
				if (node.completedAt !== void 0) existing.component.complete(node.completedAt);
			}
			return existing.component;
		}
		const component = new StreamingAssistantComponent({
			turn: node.turn,
			step: node.step
		}, this.deps.events, this.deps.tracker, this.deps.now, this.showReasoning, this.thinkingPinned, this.visibility, this.deps.palette, this.deps.mdTheme, this.deps.markdown);
		component.setFoldedText(node.text, node.reasoning, node.settled);
		if (node.completedAt !== void 0) component.complete(node.completedAt);
		this.views.set(node.key, {
			kind: "assistant",
			version: node.version,
			component
		});
		return component;
	}
	/**
	* Mount or update one collapsed read/search row. The row is a component
	* rather than a rebuilt text line so a running group's counts can be pushed
	* into it every snapshot without re-wrapping the rows it already computed.
	*/
	groupView(group) {
		const key = groupKey(group);
		const signature = groupSignature(group);
		const existing = this.views.get(key);
		if (existing !== void 0 && existing.kind === "group") {
			if (existing.signature !== signature) {
				existing.signature = signature;
				existing.component.setGroup(group);
			}
			return existing.component;
		}
		const component = new CollapsedGroupComponent(group, this.deps.palette, (path) => displayPath(path, this.deps.cwd), this.deps.expandKey, this.deps.now);
		this.views.set(key, {
			kind: "group",
			signature,
			component
		});
		return component;
	}
	/**
	* Mount or update one tool card. The card captures its parsed arguments (its
	* presenter reads them), so a call whose raw arguments changed after the card
	* was built is remounted rather than patched.
	*/
	toolView(node) {
		const existing = this.views.get(node.key);
		if (existing !== void 0 && existing.kind === "tool" && existing.argsRaw === node.argsRaw) {
			if (existing.version !== node.version) {
				existing.version = node.version;
				if (node.result !== void 0) existing.component.setResult(node.result);
			}
			return existing.component;
		}
		const component = new ToolCardComponent(node.name, node.args, this.deps.toolDefinition(node.name), this.deps.maxToolOutputLines, this.deps.maxDiffEditLength, this.deps.palette, this.deps.mdTheme, this.deps.expandKey);
		component.setVisibility(this.visibility);
		if (node.result !== void 0) component.setResult(node.result);
		this.views.set(node.key, {
			kind: "tool",
			version: node.version,
			component,
			argsRaw: node.argsRaw
		});
		return component;
	}
};
//#endregion
//#region src/core/nodes.ts
/** Key prefixes keep one kind's ids from ever colliding with another's. */
const KEY = {
	assistant: (turn, step) => `assistant:${turn}:${step}`,
	tool: (callId) => `tool:${callId}`,
	/** A user turn is keyed by its durable MessageId, else by its log position. */
	user: (id) => `user:${id}`,
	context: (seq) => `context:${seq}`,
	reference: (seq) => `reference:${seq}`,
	notice: (seq) => `notice:${seq}`,
	compaction: (seq) => `compaction:${seq}`,
	todo: "todo"
};
/** Record an in-place mutation so the reconciler re-applies exactly this node. */
function touch(node) {
	node.version += 1;
	return true;
}
/** Append a node to the draft. */
function push(nodes, node) {
	nodes.push(node);
	return true;
}
/** The assistant node for one step, or undefined when the step folded none yet. */
function findAssistant(nodes, turn, step) {
	const key = KEY.assistant(turn, step);
	for (let index = nodes.length - 1; index >= 0; index -= 1) {
		const node = nodes[index];
		if (node?.kind === "assistant" && node.key === key) return node;
	}
}
/** The tool node for one call id, or undefined when the call folded none yet. */
function findToolCall(nodes, callId) {
	const key = KEY.tool(callId);
	for (let index = nodes.length - 1; index >= 0; index -= 1) {
		const node = nodes[index];
		if (node?.kind === "tool-call" && node.key === key) return node;
	}
}
/** The user node carrying one key, with its position, or undefined when absent. */
function findUserMessage(nodes, key) {
	for (let index = nodes.length - 1; index >= 0; index -= 1) {
		const node = nodes[index];
		if (node?.kind === "user-message" && node.key === key) return {
			index,
			node
		};
	}
}
/**
* The transcript key of one logged user message: its durable MessageId when the
* message carries one, else the event's own log position.
*
* The id is what lets the terminal's optimistic echo (see
* {@link appendOptimisticUserMessage}) and the event that eventually records the
* same message share one node. The log is a replay boundary, so a message
* without a usable id still keys stably — by seq, exactly as before.
* @param message - the logged message.
* @param seq - the event's log position, used when the message has no id.
* @returns the node key.
*/
function userKey(message, seq) {
	const id = message.id;
	return KEY.user(typeof id === "string" && id !== "" ? id : seq);
}
/**
* Land the durable form of one user turn.
*
* When the terminal already echoed this message (same MessageId, so same key),
* the node is replaced where it stands rather than appended a second time: the
* echo owns the position the submission actually has in the conversation, and
* that position is the whole point of echoing it. `time` and `key` are readonly,
* so the update is a replacement of the node object, carrying the log's time.
*
* A `steering` echo stays steering: rc.6 has no steering message source, so the
* log records mid-run input as a plain `user` message and only the terminal that
* submitted it knows it interrupted a running turn.
*/
function landUserMessage(nodes, key, time, text, source) {
	const existing = findUserMessage(nodes, key);
	if (existing === void 0) return push(nodes, {
		kind: "user-message",
		key,
		version: 0,
		time,
		text,
		source
	});
	const node = {
		kind: "user-message",
		key,
		version: existing.node.version + 1,
		time,
		text,
		source: existing.node.source === "steering" ? "steering" : source
	};
	nodes[existing.index] = node;
	return true;
}
/**
* Echo one just-submitted user message, before any event records it.
*
* The only non-event entry into the node list. A message the terminal hands to
* a running agent is claimed at that agent's next step boundary, so its
* `user/message` event lands after the answer it interrupts has already
* streamed rows onto the screen; without an echo the prompt would appear below
* the reply it came before. Keyed by MessageId, so {@link foldEvent} lands the
* logged message on this exact node.
* @param nodes - the mutable draft node list.
* @param message - the message handed to the agent.
* @param source - `steering` when a running turn was interrupted, else `user`.
* @returns true when a node was appended.
*/
function appendOptimisticUserMessage(nodes, message, source) {
	const text = contentText(message.content).trim();
	if (text === "") return false;
	const key = KEY.user(message.id);
	if (findUserMessage(nodes, key) !== void 0) return false;
	return push(nodes, {
		kind: "user-message",
		key,
		version: 0,
		time: 0,
		text,
		source,
		optimistic: true
	});
}
/**
* Withdraw the echo of a submission the agent's inbox discarded (cancelling a
* turn clears every pending message), so a message the model will never see
* does not stay on screen. Only an echo is withdrawn: once the log recorded the
* message, the node is history.
*
* The node keeps its place and renders nothing, the way an unlanded compaction
* already does, rather than leaving the array: positions in this list are
* anchors — the `/clear` cut and the entry's process-local rows are both stored
* as node indices — and shifting them would hide or misplace what follows.
* @param nodes - the mutable draft node list.
* @param id - the discarded message's identity.
* @returns true when an echo was withdrawn.
*/
function withdrawOptimisticUserMessage(nodes, id) {
	const found = findUserMessage(nodes, KEY.user(id));
	if (found?.node.optimistic !== true || found.node.withdrawn === true) return false;
	found.node.withdrawn = true;
	return touch(found.node);
}
/** The singleton plan-strip node, or undefined before the first `todo/write`. */
function findTodo(nodes) {
	for (let index = nodes.length - 1; index >= 0; index -= 1) {
		const node = nodes[index];
		if (node?.kind === "todo") return node;
	}
}
/**
* Concatenate one block type's text the way the transcript renders it: blocks
* of the same kind are separate paragraphs, so they join on a blank line.
*/
function blocksText(content, type) {
	return content.filter((block) => block.type === type).map((block) => block.text).join("\n\n");
}
/**
* Read a session-reference attachment's display labels from an event source.
* The source shape is a durable/replay boundary, so every field is checked
* rather than narrowed: a foreign or corrupt source is simply not a reference.
* @param source - the message source to inspect.
* @returns per-reference labels, or `undefined` when the source is not one.
*/
function referenceLabels(source) {
	if (typeof source !== "object" || source === null) return void 0;
	const record = source;
	if (record["kind"] !== "session-reference" || !Array.isArray(record["references"])) return void 0;
	const labels = [];
	for (const reference of record["references"]) {
		if (typeof reference !== "object" || reference === null) return void 0;
		const entry = reference;
		const sessionId = entry["sessionId"];
		const label = entry["label"];
		if (typeof sessionId !== "string" || typeof label !== "string") return void 0;
		labels.push(label === sessionId ? sessionId : `${label} (${sessionId})`);
	}
	return labels;
}
/**
* A producer-injected context card's label: the plugin name when the source
* names one, else its `kind`. The union is merge-extensible and the log is a
* replay boundary, so this reads the fields without narrowing on `kind`.
*/
function contextLabel(source) {
	const record = source;
	if (typeof record.plugin === "string") return record.plugin;
	if (typeof record.kind === "string") return record.kind;
	/* v8 ignore next -- every logged source carries at least a string kind. */
	return "context";
}
/**
* Append a notice, dropping one that merely repeats the notice before it. The
* fold is the single source of transcript notices, so a turn that reports the
* same outcome twice (a failure recorded and then closed) states it once.
*/
function pushNotice(nodes, seq, time, text, tone) {
	const last = nodes[nodes.length - 1];
	if (last?.kind === "notice" && last.text === text && last.tone === tone) return false;
	return push(nodes, {
		kind: "notice",
		key: KEY.notice(seq),
		version: 0,
		time,
		text,
		tone
	});
}
/**
* Mark the compaction whose replacement just landed, or record a bare marker.
*
* Premise: one session compacts one range at a time, so the nearest unlanded
* compaction above is the one this checkpoint closes. The compaction service
* brackets each transaction (`compaction/start` … `compaction/end`) and does not
* open a second while one is open; if that ever changes, this pairing has to
* carry the `compactionId` the events already hold instead of scanning back.
*/
function landCompaction(nodes, seq, time) {
	for (let index = nodes.length - 1; index >= 0; index -= 1) {
		const node = nodes[index];
		if (node?.kind === "compaction" && !node.landed) {
			node.landed = true;
			return touch(node);
		}
	}
	return push(nodes, {
		kind: "compaction",
		key: KEY.compaction(seq),
		version: 0,
		time,
		landed: true,
		summary: ""
	});
}
/** Open the tool node for one call id, creating it when the call is new. */
function openToolCall(nodes, callId, name, time) {
	const existing = findToolCall(nodes, callId);
	if (existing !== void 0) return existing;
	const node = {
		kind: "tool-call",
		key: KEY.tool(callId),
		version: 0,
		time,
		callId,
		name,
		argsRaw: "",
		args: {
			value: {},
			valid: true
		},
		argsComplete: false,
		status: "running"
	};
	push(nodes, node);
	return node;
}
/**
* Open the step's thinking span at `time`, unless one is already open.
*
* The span is the log's own bracket around the reasoning phase: it opens at the
* first reasoning delta and closes at whatever ends the thinking
* ({@link closeThinking}). Only the start is recorded, because the fold reads no
* clock — the renderer accumulates the open span against its own.
*/
function openThinking(node, time) {
	node.thinkingSince ??= time;
}
/**
* Close the step's open thinking span at `time`, adding its wall time to the
* step's total.
*
* A backward wall-clock step contributes zero rather than a negative span, the
* same stance the step timing buckets take on the same log. The field is
* deleted rather than set to `undefined` so a folded node carries exactly the
* shape a replayed one does — "no span is open" is the field's absence.
* @returns whether a span was actually closed.
*/
function closeThinking(node, time) {
	const since = node.thinkingSince;
	if (since === void 0) return false;
	node.thinkingMs = (node.thinkingMs ?? 0) + Math.max(0, time - since);
	delete node.thinkingSince;
	return true;
}
/** Open the assistant node for one step, creating it when the step is new. */
function openAssistant(nodes, turn, step, time) {
	const existing = findAssistant(nodes, turn, step);
	if (existing !== void 0) return existing;
	const node = {
		kind: "assistant",
		key: KEY.assistant(turn, step),
		version: 0,
		time,
		turn,
		step,
		status: "running",
		text: "",
		reasoning: "",
		settled: false,
		toolCalls: []
	};
	push(nodes, node);
	return node;
}
/**
* Fold one session event into the draft node list.
*
* Pure: the result depends only on `nodes` and `event`, which is what lets a
* resumed log and a live append share this one path.
* @param nodes - the mutable draft node list.
* @param event - the session event to apply.
* @returns true when the rendered node list changed.
*/
function foldEvent(nodes, event) {
	const time = event.time;
	const seq = event.seq;
	if (isReplacementSurfaceEvent(event)) {
		if (event.type !== "user/message" || !isCompactCheckpointSource(event.data.source)) return false;
		return landCompaction(nodes, seq, time);
	}
	switch (event.type) {
		case "user/message": {
			const message = event.data;
			const source = message.source;
			const labels = referenceLabels(source);
			if (labels !== void 0) return push(nodes, {
				kind: "reference",
				key: KEY.reference(seq),
				version: 0,
				time,
				labels
			});
			const text = contentText(message.content).trim();
			if (text === "") return false;
			if (source.kind === "user" || source.kind === "steering") return landUserMessage(nodes, userKey(message, seq), time, text, source.kind === "steering" ? "steering" : "user");
			return push(nodes, {
				kind: "context",
				key: KEY.context(seq),
				version: 0,
				time,
				label: contextLabel(source),
				text
			});
		}
		case "step/start": return false;
		case "assistant/chunk": {
			const { turn, step, chunk } = event.data;
			switch (chunk.type) {
				case "text-delta": {
					const node = openAssistant(nodes, turn, step, time);
					closeThinking(node, time);
					node.text += chunk.text;
					return touch(node);
				}
				case "reasoning-delta": {
					const node = openAssistant(nodes, turn, step, time);
					openThinking(node, time);
					node.reasoning += chunk.text;
					return touch(node);
				}
				case "tool-call-delta": {
					const node = openAssistant(nodes, turn, step, time);
					closeThinking(node, time);
					const tool = openToolCall(nodes, chunk.id, chunk.name ?? "", time);
					if (chunk.name !== void 0 && tool.name === "") tool.name = chunk.name;
					tool.argsRaw += chunk.argumentsDelta;
					tool.args = parseArguments(tool.argsRaw);
					touch(tool);
					if (!node.toolCalls.includes(tool.callId)) {
						node.toolCalls.push(tool.callId);
						touch(node);
					}
					return true;
				}
				default: return false;
			}
		}
		case "assistant/message": {
			const { turn, step, message, usage } = event.data;
			const node = openAssistant(nodes, turn, step, time);
			closeThinking(node, time);
			if (message.content.length > 0) {
				node.text = blocksText(message.content, "text");
				node.reasoning = blocksText(message.content, "reasoning");
				node.settled = true;
				node.status = "complete";
			}
			if (usage !== void 0) node.usage = usage;
			for (const block of message.content) if (block.type === "tool-call" && !node.toolCalls.includes(block.id)) node.toolCalls.push(block.id);
			return touch(node);
		}
		case "step/end": {
			const { turn, step } = event.data;
			const node = openAssistant(nodes, turn, step, time);
			closeThinking(node, time);
			node.completedAt = time;
			if (node.status === "running") node.status = "complete";
			return touch(node);
		}
		case "tool/call": {
			const { callId, name, arguments: argsRaw, turn, step } = event.data;
			const tool = openToolCall(nodes, callId, name, time);
			tool.name = name;
			tool.argsRaw = argsRaw;
			tool.args = parseArguments(argsRaw);
			tool.argsComplete = true;
			touch(tool);
			const assistant = findAssistant(nodes, turn, step);
			if (assistant !== void 0) {
				let changed = closeThinking(assistant, time);
				if (!assistant.toolCalls.includes(callId)) {
					assistant.toolCalls.push(callId);
					changed = true;
				}
				if (changed) touch(assistant);
			}
			return true;
		}
		case "tool/result": {
			const { message, error, meta } = event.data;
			const block = message.content[0];
			const callId = block.toolCallId;
			const tool = findToolCall(nodes, callId) ?? openToolCall(nodes, callId, "tool", time);
			tool.argsComplete = true;
			const text = contentText(block.content);
			const isError = block.isError === true || error !== void 0;
			tool.result = {
				content: [...block.content],
				isError,
				text: error === void 0 ? text : `${error.code}: ${text}`,
				...meta === void 0 ? {} : { meta }
			};
			tool.status = isError ? "error" : "complete";
			return touch(tool);
		}
		case "todo/write": {
			const todos = [...event.data.todos];
			const existing = findTodo(nodes);
			if (existing === void 0) return push(nodes, {
				kind: "todo",
				key: KEY.todo,
				version: 0,
				time,
				todos
			});
			existing.todos = todos;
			return touch(existing);
		}
		case "turn/start": {
			const existing = findTodo(nodes);
			if (existing === void 0 || existing.todos.length === 0) return false;
			existing.todos = [];
			return touch(existing);
		}
		case "compaction/start": return push(nodes, {
			kind: "compaction",
			key: KEY.compaction(seq),
			version: 0,
			time,
			landed: false,
			summary: ""
		});
		case "compaction/summary":
			for (let index = nodes.length - 1; index >= 0; index -= 1) {
				const node = nodes[index];
				if (node?.kind === "compaction" && !node.landed) {
					node.summary = blocksText(event.data.summary, "text");
					return touch(node);
				}
			}
			return false;
		case "compaction/end": {
			const failure = event.data.error;
			if (failure === void 0) return false;
			return pushNotice(nodes, seq, time, `Compaction failed: ${failure}`, "warning");
		}
		case "llm/retry": {
			const data = event.data;
			const limit = data.mode === "always" ? "∞" : String(data.maxRetries);
			const node = findAssistant(nodes, data.turn, data.step);
			let changed = false;
			if (node !== void 0 && closeThinking(node, time)) changed = touch(node);
			if (node !== void 0 && (node.text !== "" || node.reasoning !== "" || node.toolCalls.length > 0)) {
				node.text = "";
				node.reasoning = "";
				node.toolCalls = [];
				node.settled = false;
				node.status = "running";
				changed = touch(node);
			}
			return pushNotice(nodes, seq, time, `Retrying model request (${data.retry}/${limit}) in ${data.delayMs}ms: ${data.failure.message}`, "warning") || changed;
		}
		case "turn/end": {
			const reason = event.data.reason;
			let changed = false;
			for (let index = nodes.length - 1; index >= 0; index -= 1) {
				const node = nodes[index];
				if (node?.kind !== "assistant" || node.turn !== event.data.turn) continue;
				if (node.status !== "running") break;
				closeThinking(node, time);
				node.status = reason.kind === "error" ? "error" : reason.kind === "completed" ? "complete" : "interrupted";
				node.completedAt ??= time;
				changed = touch(node);
				break;
			}
			switch (reason.kind) {
				case "completed": return changed;
				case "error": return pushNotice(nodes, seq, time, reason.error.message, "error") || changed;
				case "aborted": return pushNotice(nodes, seq, time, "Turn cancelled.", "warning") || changed;
				case "blocked": return pushNotice(nodes, seq, time, "Turn blocked before it could run.", "warning") || changed;
				case "max-tokens": return pushNotice(nodes, seq, time, "The model reached its output-token limit.", "warning") || changed;
				case "interrupted": return pushNotice(nodes, seq, time, "The previous process ended during this turn.", "warning") || changed;
				default: return pushNotice(nodes, seq, time, `Turn ended: ${reason.kind}.`, "warning") || changed;
			}
		}
		default: return false;
	}
}
//#endregion
//#region src/core/session-store.ts
/** One animation frame: bursts of stream chunks publish one snapshot. */
const BATCH_INTERVAL_MS = 16;
const EMPTY_USAGE = {
	inputTokens: 0,
	outputTokens: 0
};
/**
* Fold the non-node aggregates (usage totals, route, plan mode, plan items,
* title) from one event.
* @param state - the mutable aggregate draft.
* @param event - the session event to apply.
* @returns true when an aggregate changed.
*/
function foldState(state, event) {
	switch (event.type) {
		case "assistant/message": {
			const usage = event.data.usage;
			if (usage === void 0) return false;
			state.lastUsage = usage;
			state.totalUsage = {
				inputTokens: state.totalUsage.inputTokens + usage.inputTokens,
				outputTokens: state.totalUsage.outputTokens + usage.outputTokens,
				cacheReadTokens: (state.totalUsage.cacheReadTokens ?? 0) + (usage.cacheReadTokens ?? 0),
				cacheWriteTokens: (state.totalUsage.cacheWriteTokens ?? 0) + (usage.cacheWriteTokens ?? 0),
				reasoningTokens: (state.totalUsage.reasoningTokens ?? 0) + (usage.reasoningTokens ?? 0)
			};
			return true;
		}
		case "request/context": {
			const window = event.data.contextWindow;
			if (window !== void 0) state.contextWindow = window;
			state.model = `${event.data.provider}/${event.data.model}`;
			return true;
		}
		case "plan/mode":
			state.planMode = event.data.active;
			return true;
		case "todo/write":
			state.todos = [...event.data.todos];
			return true;
		case "turn/start":
			if (state.todos === void 0 || state.todos.length === 0) return false;
			state.todos = [];
			return true;
		case "turn/end":
			state.lastTurnEndReason = event.data.reason.kind;
			return true;
		case "session/title":
			state.title = event.data.title;
			return true;
		default: return false;
	}
}
/**
* One live session's read model. Dispose to unsubscribe.
*/
var SessionStore = class {
	nodes = [];
	state;
	snapshot;
	listeners = /* @__PURE__ */ new Set();
	batchTimer = null;
	offSessionEvent;
	offAgentStatus;
	constructor(ctx, session, agent) {
		this.state = {
			status: agent.status,
			totalUsage: { ...EMPTY_USAGE },
			planMode: false
		};
		for (const event of session.events) {
			foldEvent(this.nodes, event);
			foldState(this.state, event);
		}
		this.snapshot = this.publish();
		this.offSessionEvent = ctx.on("session/event", (eventSession, event) => {
			if (eventSession.id !== session.id) return;
			this.apply(event);
		});
		this.offAgentStatus = ctx.on("agent/status", ({ agent: eventAgent, status }) => {
			if (eventAgent.session.id !== session.id) return;
			if (this.state.status === status) return;
			this.state.status = status;
			this.scheduleFlush();
		});
	}
	/**
	* Echo one just-submitted user message into the draft before any event
	* records it, so the prompt appears where it was sent rather than after the
	* answer it interrupted. The `user/message` event lands on the same node.
	* @param message - the message handed to the agent.
	* @param source - `steering` when a running turn was interrupted, else `user`.
	*/
	appendOptimistic(message, source) {
		if (appendOptimisticUserMessage(this.nodes, message, source)) this.scheduleFlush();
	}
	/**
	* Withdraw the echo of a submission the agent's inbox discarded.
	* @param id - the discarded message's identity.
	*/
	withdrawOptimistic(id) {
		if (withdrawOptimisticUserMessage(this.nodes, id)) this.scheduleFlush();
	}
	/** Apply one event to the draft and schedule a snapshot flush. */
	apply(event) {
		const nodesChanged = foldEvent(this.nodes, event);
		const stateChanged = foldState(this.state, event);
		if (nodesChanged || stateChanged) this.scheduleFlush();
	}
	/** Build the immutable snapshot from the current draft. */
	publish() {
		return {
			...this.state,
			nodes: [...this.nodes]
		};
	}
	/** Coalesce bursts of chunks into one snapshot per batch interval. */
	scheduleFlush() {
		if (this.batchTimer !== null) return;
		this.batchTimer = setTimeout(() => {
			this.batchTimer = null;
			this.snapshot = this.publish();
			for (const listener of this.listeners) listener();
		}, BATCH_INTERVAL_MS);
	}
	/**
	* Subscribe to snapshot replacements.
	* @param listener - called after each published snapshot.
	* @returns the unsubscribe function.
	*/
	subscribe(listener) {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
	/**
	* The current snapshot.
	* @returns the latest published snapshot.
	*/
	getSnapshot() {
		return this.snapshot;
	}
	/** Unsubscribe from the event bus, publishing whatever the last batch held. */
	dispose() {
		if (this.batchTimer !== null) {
			clearTimeout(this.batchTimer);
			this.batchTimer = null;
			this.snapshot = this.publish();
			for (const listener of this.listeners) listener();
		}
		this.listeners.clear();
		this.offSessionEvent();
		this.offAgentStatus();
	}
};
//#endregion
//#region src/chat/tokens.ts
/**
* Fold one step's usage into the running totals, replacing any prior usage
* logged for the same turn/step.
* @param totals - Running totals mutated in place.
* @param turn - Turn index of the usage.
* @param step - Step index of the usage.
* @param usage - The step's token usage.
*/
function recordTokenUsage(totals, turn, step, usage) {
	const key = `${turn}:${step}`;
	const previous = totals.byStep.get(key);
	if (previous !== void 0) {
		totals.input -= previous.inputTokens;
		totals.output -= previous.outputTokens;
		totals.cacheRead -= previous.cacheReadTokens ?? 0;
		totals.cacheWrite -= previous.cacheWriteTokens ?? 0;
	}
	totals.byStep.set(key, usage);
	totals.input += usage.inputTokens;
	totals.output += usage.outputTokens;
	totals.cacheRead += usage.cacheReadTokens ?? 0;
	totals.cacheWrite += usage.cacheWriteTokens ?? 0;
}
/**
* Fold a usage-bearing session event into the running totals.
* @param totals - Running totals mutated in place.
* @param event - Session event; ignored when it carries no usage.
*/
function recordEventUsage(totals, event) {
	if (event.type === "assistant/chunk" && event.data.chunk.type === "usage") recordTokenUsage(totals, event.data.turn, event.data.step, event.data.chunk.usage);
	else if (event.type === "assistant/message" && event.data.usage !== void 0) recordTokenUsage(totals, event.data.turn, event.data.step, event.data.usage);
}
/**
* Share of billed input (prompt) tokens served from the provider cache, as an
* integer percent, or `undefined` before any input is billed (avoids 0/0 and a
* meaningless rate on an empty session).
* @param totals - Running totals to measure.
* @returns The cache hit rate percent, or `undefined` when no input is billed.
*/
function cacheHitRate(totals) {
	const billedInput = totals.input + totals.cacheRead + totals.cacheWrite;
	if (billedInput === 0) return void 0;
	return Math.round(totals.cacheRead / billedInput * 100);
}
/**
* Fold every usage-bearing event in a session into fresh totals.
* @param session - Session whose events supply usage.
* @returns The accumulated token totals.
*/
function sessionTokens(session) {
	const totals = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		byStep: /* @__PURE__ */ new Map()
	};
	for (const event of session.events) recordEventUsage(totals, event);
	return totals;
}
/**
* Format a token count with a compact k/m suffix for the footer.
* @param value - Token count.
* @returns The compact display string.
*/
function formatTokens(value) {
	if (value < 1e3) return String(value);
	if (value < 1e4) return `${(value / 1e3).toFixed(1)}k`;
	if (value < 1e6) return `${Math.round(value / 1e3)}k`;
	return `${(value / 1e6).toFixed(1)}m`;
}
//#endregion
//#region src/chat/file-autocomplete.ts
/**
* Host-workspace discovery for TUI `@file` completion. The index contains
* paths only: selected values remain ordinary prompt text and file contents
* stay behind the model-facing `read` tool.
*
* @module @deepseek-ai/dsh-tui/chat/file-autocomplete
*/
/** Default maximum file and directory candidates rendered for one query. */
const DEFAULT_FILE_SEARCH_MAX_RESULTS = 20;
/** Default maximum entries retained in one workspace search index. */
const DEFAULT_FILE_SEARCH_MAX_ENTRIES = 1e4;
/**
* Directory basenames omitted from traversal unless the deployment overrides them.
*
* This walker only runs when the host has no `fd` (see `./fd.ts`), so it has to
* approximate by name what `fd` would have read out of `.gitignore`. The list
* is build and dependency output — the directories a repository ignores
* whatever its language is — and not a taste list: excluding a directory here
* makes it unreachable through `@`, so anything a user might plausibly want to
* mention (`.github`, `docs`, `vendor` in a repo that checks it in) stays.
*/
const DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES = [
	".git",
	"node_modules",
	"dist",
	"build",
	"out",
	"coverage",
	".cache",
	".next",
	".nuxt",
	".turbo",
	".venv",
	"__pycache__",
	"target"
];
/**
* File name suffixes withheld from a query that names no extension.
*
* Logs and build stamps are written by the tools the session itself runs, so a
* long-lived workspace accumulates them faster than it accumulates source, and
* they crowd out the file the user is reaching for. Unlike the directory list
* this is not configurable, because it is not a policy: it is reachable the
* moment the query contains a `.`, which is exactly how a user asks for a file
* by extension.
*/
const NOISE_FILE_SUFFIXES = [".log", ".tsbuildinfo"];
/**
* Extract an `@path` or `@"path with spaces` token at the cursor. An `@`
* inside another token, such as an email address, is not a completion trigger.
* @param line - current editor line.
* @param cursorCol - cursor column within that line.
* @returns the active token, or `undefined` outside an `@` token.
*/
function activeAtToken(line, cursorCol) {
	const beforeCursor = line.slice(0, cursorCol);
	const quoted = /(?:^|\s)(@"([^"]*))$/u.exec(beforeCursor);
	if (quoted?.[1] !== void 0 && quoted[2] !== void 0) return {
		prefix: quoted[1],
		query: quoted[2],
		quoted: true
	};
	const plain = /(?:^|\s)(@([^\s]*))$/u.exec(beforeCursor);
	if (plain?.[1] === void 0 || plain[2] === void 0) return void 0;
	return {
		prefix: plain[1],
		query: plain[2],
		quoted: false
	};
}
/**
* Format a selected path as prompt text. Whitespace uses Pi's quoted
* `@"path"` grammar; directories retain a trailing slash so completion can
* descend another level.
* @param candidate - selected file or directory.
* @param preserveQuote - retain an explicitly opened quote even when unnecessary.
* @returns the insertion value, or `undefined` for a path the editor grammar cannot represent safely.
*/
function formatFileMention(candidate, preserveQuote) {
	const path = candidate.kind === "directory" ? `${candidate.path}/` : candidate.path;
	if (/[\u0000-\u001f\u007f-\u009f"]/u.test(path)) return void 0;
	if (!(preserveQuote || /\s/u.test(path))) return `@${path}`;
	return `@"${path}"`;
}
/**
* Tool-call intents that cannot have moved a path in the workspace.
*
* `other` is in here on the strength of what actually carries it: `todo_write`,
* the goal tools, and `exit_plan_mode` write session log entries, not files.
* `read`, `search`, and `fetch` are read-only by definition of the vocabulary.
*/
const READ_ONLY_CALL_KINDS = /* @__PURE__ */ new Set([
	"read",
	"search",
	"fetch",
	"other"
]);
/**
* Whether a completed tool call could have changed the workspace tree, and the
* `@` index therefore has to be discarded.
*
* Invalidating on every tool result threw away a full traversal (up to
* `maxEntries` paths) after a `grep`, a `web_search`, or a `todo_write` — none
* of which can move a file — and rebuilt it on the next `@`, which is precisely
* the interaction the index exists to keep fast.
*
* The classification is the tool's own declared render intent, never a name
* list: a profile mounts tools this bundle has never heard of, and a tool's
* `presentCall` is a pure function of its arguments, so it can be asked without
* running anything. A diff card is a file mutation; a terminal card is a shell
* whose side effects are unknowable, so it counts as one. Anything this cannot
* classify — no presenter, unparsable arguments, a presenter that threw, a
* generic card with no `kind` — is assumed to have written, because a stale
* completion list is a wrong answer while a redundant rescan is only slow.
* @param definition - the registered tool, when the runtime still has it.
* @param rawArguments - the call's arguments exactly as the model produced them.
* @returns true when the index must be rebuilt before the next bare query.
*/
function toolCallTouchesFiles(definition, rawArguments) {
	if (definition?.presentCall === void 0) return true;
	let parsed;
	try {
		parsed = JSON.parse(rawArguments);
	} catch (_unparsableArguments) {
		return true;
	}
	let view;
	try {
		view = definition.presentCall(parsed);
	} catch (_presenterFailed) {
		return true;
	}
	if (view === void 0) return true;
	if (view.card !== "generic") return true;
	return view.kind === void 0 || !READ_ONLY_CALL_KINDS.has(view.kind);
}
/**
* Cancellable, reusable fuzzy index rooted at one agent working directory.
* Directory-scoped queries list live state; bare fuzzy queries share one
* bounded traversal until the `@` interaction ends or a tool result invalidates it.
*/
var WorkspaceFileSearch = class {
	root;
	config;
	excludedDirectories;
	generation;
	disposed = false;
	constructor(root, config) {
		this.root = root;
		this.config = config;
		if (!Number.isSafeInteger(config.maxResults) || config.maxResults <= 0) throw new Error("file search maxResults must be a positive safe integer");
		if (!Number.isSafeInteger(config.maxEntries) || config.maxEntries <= 0) throw new Error("file search maxEntries must be a positive safe integer");
		if (config.excludedDirectories.some((name) => name.length === 0 || name.includes("/") || name.includes("\\"))) throw new Error("file search excludedDirectories entries must be non-empty directory basenames");
		this.excludedDirectories = new Set(config.excludedDirectories);
	}
	/**
	* Return ranked path candidates for the current token.
	* @param rawQuery - path text following `@` or `@"`.
	* @param signal - cancels this caller's wait without killing an index shared by a newer query.
	* @returns at most `maxResults` deterministic candidates.
	*/
	async list(rawQuery, signal) {
		signal.throwIfAborted();
		if (this.disposed) return [];
		const query = rawQuery.replaceAll("\\", "/");
		const slash = query.lastIndexOf("/");
		if (query === "" || slash >= 0) {
			const directory = slash < 0 ? "" : query.slice(0, slash + 1);
			const fragment = slash < 0 ? "" : query.slice(slash + 1);
			return this.listDirectory(directory, fragment, signal);
		}
		return rankCandidates((await waitForPromise(this.ensureIndex(), signal)).filter((candidate) => visibleForGlobalQuery(candidate.path, query) && visibleForNoiseQuery(candidate, query)), query, this.config.maxResults);
	}
	/** Discard the current index so the next bare query observes a fresh tree. */
	invalidate() {
		this.generation?.controller.abort(/* @__PURE__ */ new Error("file search index invalidated"));
		this.generation = void 0;
	}
	/** Abort traversal and make later queries return no candidates. */
	dispose() {
		if (this.disposed) return;
		this.disposed = true;
		this.invalidate();
	}
	ensureIndex() {
		if (this.generation !== void 0) return this.generation.promise;
		const controller = new AbortController();
		const generation = {
			controller,
			promise: Promise.resolve([])
		};
		generation.promise = this.scanWorkspace(controller.signal).catch((error) => {
			/* v8 ignore next -- every owned abort clears `generation` synchronously; this only protects an unexpected scan failure */
			if (this.generation === generation) this.generation = void 0;
			throw error;
		});
		this.generation = generation;
		return generation.promise;
	}
	async scanWorkspace(signal) {
		const indexed = [];
		const directories = [{
			absolute: this.root,
			relative: ""
		}];
		for (let cursor = 0; cursor < directories.length && indexed.length < this.config.maxEntries; cursor += 1) {
			signal.throwIfAborted();
			const directory = directories[cursor];
			/* v8 ignore next 3 -- cursor is bounded by this exact queue's length. */
			if (directory === void 0) throw new Error("file search selected a missing directory");
			const entries = await readDirectory(directory.absolute, signal);
			for (const entry of entries) {
				signal.throwIfAborted();
				const path = directory.relative === "" ? entry.name : `${directory.relative}/${entry.name}`;
				if (entry.isDirectory()) {
					if (this.excludedDirectories.has(entry.name)) continue;
					indexed.push({
						path,
						kind: "directory"
					});
					directories.push({
						absolute: join(directory.absolute, entry.name),
						relative: path
					});
				} else if (entry.isFile()) indexed.push({
					path,
					kind: "file"
				});
				if (indexed.length >= this.config.maxEntries) break;
			}
		}
		return indexed;
	}
	async listDirectory(displayDirectory, fragment, signal) {
		if (displayDirectory.split("/").some((segment) => this.excludedDirectories.has(segment))) return [];
		const absolute = await resolveDisplayDirectory(this.root, displayDirectory, signal);
		if (absolute === void 0) return [];
		const entries = await readDirectory(absolute, signal);
		const candidates = [];
		for (const entry of entries) {
			if (entry.name.startsWith(".") && !fragment.startsWith(".")) continue;
			if (entry.isDirectory()) {
				if (this.excludedDirectories.has(entry.name)) continue;
				candidates.push({
					path: `${displayDirectory}${entry.name}`,
					kind: "directory"
				});
			} else if (entry.isFile()) {
				const candidate = {
					path: `${displayDirectory}${entry.name}`,
					kind: "file"
				};
				if (!visibleForNoiseQuery(candidate, fragment)) continue;
				candidates.push(candidate);
			}
		}
		return rankCandidates(candidates, fragment, this.config.maxResults);
	}
};
async function resolveDisplayDirectory(root, displayDirectory, signal) {
	const resolvedRoot = resolve(root);
	const absolute = resolve(resolvedRoot, displayDirectory === "" ? "." : displayDirectory);
	const fromRoot = relative(resolvedRoot, absolute);
	if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) return void 0;
	/* v8 ignore next -- only Windows can produce a cross-volume absolute relative path */
	if (isAbsolute(fromRoot)) return void 0;
	let current = resolvedRoot;
	for (const segment of fromRoot.split(sep).filter(Boolean)) {
		signal.throwIfAborted();
		current = join(current, segment);
		try {
			const status = await lstat(current);
			signal.throwIfAborted();
			if (status.isSymbolicLink() || !status.isDirectory()) return void 0;
		} catch (_error) {
			signal.throwIfAborted();
			return;
		}
	}
	return absolute;
}
async function readDirectory(absolute, signal) {
	signal.throwIfAborted();
	try {
		const entries = await readdir(absolute, { withFileTypes: true });
		signal.throwIfAborted();
		return entries.sort((left, right) => compareText(left.name, right.name));
	} catch (_error) {
		signal.throwIfAborted();
		return [];
	}
}
/**
* Whether a generated-artifact file is offered for this query.
*
* A query carrying a `.` is naming an extension, and the only way to reach
* `debug.log` is to be allowed to type it — so the filter lifts exactly then,
* the same way a leading `.` lifts the hidden-entry filter. Directories are
* never artifacts by suffix.
* @param candidate - the indexed or listed entry.
* @param query - the path text the user has typed inside this token segment.
* @returns false only for artifact files under a query that named no extension.
*/
function visibleForNoiseQuery(candidate, query) {
	if (candidate.kind === "directory" || query.includes(".")) return true;
	const name = candidate.path.slice(candidate.path.lastIndexOf("/") + 1).toLowerCase();
	return !NOISE_FILE_SUFFIXES.some((suffix) => name.endsWith(suffix));
}
function visibleForGlobalQuery(path, query) {
	if (query.startsWith(".") || query.includes("/.")) return true;
	return !path.split("/").some((segment) => segment.startsWith("."));
}
function rankCandidates(candidates, query, limit) {
	const ranked = [];
	for (const candidate of candidates) {
		const score = scoreCandidate(candidate, query);
		if (score !== void 0) ranked.push({
			candidate,
			score
		});
	}
	ranked.sort((left, right) => right.score - left.score || kindRank(left.candidate.kind) - kindRank(right.candidate.kind) || (query === "" ? 0 : left.candidate.path.length - right.candidate.path.length) || compareText(left.candidate.path, right.candidate.path));
	return ranked.slice(0, limit).map((entry) => entry.candidate);
}
function scoreCandidate(candidate, query) {
	if (query === "") return 0;
	const path = candidate.path.toLowerCase();
	const name = path.slice(path.lastIndexOf("/") + 1);
	const needle = query.toLowerCase();
	const directoryBonus = candidate.kind === "directory" ? 25 : 0;
	if (name === needle) return 1e3 + directoryBonus;
	if (name.startsWith(needle)) return 900 + directoryBonus;
	if (name.includes(needle)) return 700 + directoryBonus;
	if (path.includes(needle)) return 500 + directoryBonus;
	const subsequence = subsequenceScore(path, needle);
	return subsequence === void 0 ? void 0 : 300 + subsequence + directoryBonus;
}
function subsequenceScore(target, query) {
	let targetIndex = 0;
	let gap = 0;
	for (const character of query) {
		const found = target.indexOf(character, targetIndex);
		if (found < 0) return void 0;
		gap += found - targetIndex;
		targetIndex = found + 1;
	}
	return Math.max(0, 100 - gap);
}
function kindRank(kind) {
	return kind === "directory" ? 0 : 1;
}
function compareText(left, right) {
	/* v8 ignore next -- entries and candidates are unique; host enumeration
	* order determines which comparison direction sort requests. */
	return left < right ? -1 : left > right ? 1 : 0;
}
function waitForPromise(promise, signal) {
	/* v8 ignore next -- `list()` checks this signal immediately before its synchronous call into this helper */
	if (signal.aborted) return Promise.reject(errorReason(signal.reason, "file search aborted"));
	return new Promise((resolvePromise, rejectPromise) => {
		const onAbort = () => {
			rejectPromise(errorReason(signal.reason, "file search aborted"));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then((value) => {
			signal.removeEventListener("abort", onAbort);
			resolvePromise(value);
		}, (error) => {
			signal.removeEventListener("abort", onAbort);
			rejectPromise(errorReason(error, "file search index failed"));
		});
	});
}
function errorReason(reason, fallback) {
	return reason instanceof Error ? reason : new Error(fallback, { cause: reason });
}
//#endregion
//#region src/config.ts
/**
* Serializable configuration and defaults for the pi-tui terminal mode. Loader
* schema validation normally fills defaults; {@link resolveTuiConfig} applies
* the same defaults for direct callers that bypass the Loader.
* @module @deepseek-ai/dsh-tui/config
*/
const showReasoningSchema = z.boolean().default(true);
const markdownRendererSchema = z.union(["claude", "pi"]).default("claude");
const maxToolOutputLinesSchema = z.number().step(1).min(1).default(6);
const maxDiffEditLengthSchema = z.number().step(1).min(1).default(1e3);
const maxQuestionOptionsSchema = z.number().step(1).min(1).default(8);
const maxModelOptionsSchema = z.number().step(1).min(1).default(8);
const maxResumeOptionsSchema = z.number().step(1).min(1).default(8);
const resumeScanConcurrencySchema = z.number().step(1).min(1).default(4);
const questionDialogWidthSchema = z.number().step(1).min(20).default(200);
const questionDialogMaxHeightSchema = z.number().step(1).min(6).default(20);
const modelDialogWidthSchema = z.number().step(1).min(20).default(76);
const modelDialogMaxHeightSchema = z.number().step(1).min(6).default(20);
const settingsDialogWidthSchema = z.number().step(1).min(20).default(72);
const fileSearchMaxResultsSchema = z.number().step(1).min(1).default(20);
const fileSearchMaxEntriesSchema = z.number().step(1).min(1).default(DEFAULT_FILE_SEARCH_MAX_ENTRIES);
const fileSearchExcludedDirectoriesSchema = z.array(z.string()).default([...DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES]);
const fileSearchCommandSchema = z.string();
const showHardwareCursorSchema = z.boolean().default(false);
const colorSchema = z.boolean().default(true);
const truecolorSchema = z.boolean();
const DEFAULT_LEFT_PROMPT = "${cwd}${git/worktree}${model}${token_meter/cache_hit_rate}${context}";
const DEFAULT_RIGHT_PROMPT = "${queued}";
/**
* Claude's inline caret, on the editor's first content row rather than a row of
* its own: one column of `❯` plus its gap, two columns total, so the text starts
* where every wrapped continuation row starts. Still a template — a deployment
* that wants the session name back writes `${symbol} ${indicator}`, and one that
* wants the caret to carry the running-phase glyph writes `${indicator}`.
*/
const DEFAULT_INPUT_PROMPT = "❯ ";
const DEFAULT_INPUT_PLACEHOLDER = "press enter to steer and esc to cancel";
const tuiConfigSchemaFields = {
	showReasoning: showReasoningSchema,
	markdownRenderer: markdownRendererSchema,
	maxToolOutputLines: maxToolOutputLinesSchema,
	maxDiffEditLength: maxDiffEditLengthSchema,
	maxQuestionOptions: maxQuestionOptionsSchema,
	maxModelOptions: maxModelOptionsSchema,
	maxResumeOptions: maxResumeOptionsSchema,
	resumeScanConcurrency: resumeScanConcurrencySchema,
	questionDialogWidth: questionDialogWidthSchema,
	questionDialogMaxHeight: questionDialogMaxHeightSchema,
	modelDialogWidth: modelDialogWidthSchema,
	modelDialogMaxHeight: modelDialogMaxHeightSchema,
	settingsDialogWidth: settingsDialogWidthSchema,
	fileSearchMaxResults: fileSearchMaxResultsSchema,
	fileSearchMaxEntries: fileSearchMaxEntriesSchema,
	fileSearchExcludedDirectories: fileSearchExcludedDirectoriesSchema,
	fileSearchCommand: fileSearchCommandSchema,
	showHardwareCursor: showHardwareCursorSchema,
	theme: z.object({
		color: colorSchema,
		truecolor: truecolorSchema,
		leftPrompt: z.string().default(DEFAULT_LEFT_PROMPT),
		rightPrompt: z.string().default(DEFAULT_RIGHT_PROMPT),
		inputPrompt: z.string().default(DEFAULT_INPUT_PROMPT),
		inputPlaceholder: z.string().default(DEFAULT_INPUT_PLACEHOLDER)
	}),
	title: z.string().default("DeepSeek Harness"),
	keybindings: z.dict(z.union([z.string(), z.array(z.string())]))
};
/** Schemastery schema for presentation settings embedded by app bundles. */
const TuiConfigSchema = z.object(tuiConfigSchemaFields);
/** Schemastery schema for the full plugin configuration. */
const Config = z.object({
	welcome: z.string(),
	sessionId: z.string().default("main"),
	initialSkill: z.string(),
	initialDraft: z.string(),
	experimentalCommands: z.boolean().default(false),
	showReasoning: tuiConfigSchemaFields.showReasoning,
	markdownRenderer: tuiConfigSchemaFields.markdownRenderer,
	maxToolOutputLines: tuiConfigSchemaFields.maxToolOutputLines,
	maxDiffEditLength: tuiConfigSchemaFields.maxDiffEditLength,
	maxQuestionOptions: tuiConfigSchemaFields.maxQuestionOptions,
	maxModelOptions: tuiConfigSchemaFields.maxModelOptions,
	maxResumeOptions: tuiConfigSchemaFields.maxResumeOptions,
	resumeScanConcurrency: tuiConfigSchemaFields.resumeScanConcurrency,
	questionDialogWidth: tuiConfigSchemaFields.questionDialogWidth,
	questionDialogMaxHeight: tuiConfigSchemaFields.questionDialogMaxHeight,
	modelDialogWidth: tuiConfigSchemaFields.modelDialogWidth,
	modelDialogMaxHeight: tuiConfigSchemaFields.modelDialogMaxHeight,
	settingsDialogWidth: tuiConfigSchemaFields.settingsDialogWidth,
	fileSearchMaxResults: tuiConfigSchemaFields.fileSearchMaxResults,
	fileSearchMaxEntries: tuiConfigSchemaFields.fileSearchMaxEntries,
	fileSearchExcludedDirectories: tuiConfigSchemaFields.fileSearchExcludedDirectories,
	fileSearchCommand: tuiConfigSchemaFields.fileSearchCommand,
	showHardwareCursor: tuiConfigSchemaFields.showHardwareCursor,
	theme: tuiConfigSchemaFields.theme,
	title: tuiConfigSchemaFields.title,
	keybindings: tuiConfigSchemaFields.keybindings
});
/**
* Apply direct-call defaults after Loader schema validation has normally run.
*
* @param config - Deployment-provided terminal presentation settings.
* @returns Complete settings consumed by the TUI renderer.
*/
function resolveTuiConfig(config) {
	return {
		showReasoning: config?.showReasoning ?? true,
		markdownRenderer: config?.markdownRenderer ?? "claude",
		maxToolOutputLines: config?.maxToolOutputLines ?? 6,
		maxDiffEditLength: config?.maxDiffEditLength ?? 1e3,
		maxQuestionOptions: config?.maxQuestionOptions ?? 8,
		maxModelOptions: config?.maxModelOptions ?? 8,
		maxResumeOptions: config?.maxResumeOptions ?? 8,
		resumeScanConcurrency: config?.resumeScanConcurrency ?? 4,
		questionDialogWidth: config?.questionDialogWidth ?? 200,
		questionDialogMaxHeight: config?.questionDialogMaxHeight ?? 20,
		modelDialogWidth: config?.modelDialogWidth ?? 76,
		modelDialogMaxHeight: config?.modelDialogMaxHeight ?? 20,
		settingsDialogWidth: config?.settingsDialogWidth ?? 72,
		fileSearchMaxResults: config?.fileSearchMaxResults ?? 20,
		fileSearchMaxEntries: config?.fileSearchMaxEntries ?? 1e4,
		fileSearchExcludedDirectories: [...config?.fileSearchExcludedDirectories ?? DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES],
		fileSearchCommand: config?.fileSearchCommand,
		showHardwareCursor: config?.showHardwareCursor ?? false,
		theme: {
			color: config?.theme?.color ?? true,
			truecolor: config?.theme?.truecolor ?? false,
			leftPrompt: config?.theme?.leftPrompt ?? DEFAULT_LEFT_PROMPT,
			rightPrompt: config?.theme?.rightPrompt ?? DEFAULT_RIGHT_PROMPT,
			inputPrompt: config?.theme?.inputPrompt ?? DEFAULT_INPUT_PROMPT,
			inputPlaceholder: config?.theme?.inputPlaceholder ?? DEFAULT_INPUT_PLACEHOLDER
		},
		title: config?.title ?? "DeepSeek Harness",
		keybindings: { ...config?.keybindings }
	};
}
//#endregion
//#region src/components/panel.ts
/**
* Read-only scrollable panel for command output that is a view of the session,
* not a turn in it: `/help`, `/hotkeys`, `/palette`, `/status`.
*
* These commands used to dump their whole output into the transcript, which
* pushed the conversation off screen every time a user asked what the session
* was doing — and left the answer stranded in the log, above every later reply.
* The panel is pi's selector shape instead: it takes over the editor slot, owns
* the keyboard while it is open, and leaves nothing behind when it closes.
*
* Content arrives already rendered (ANSI allowed) and is soft-wrapped once per
* width; the panel never re-derives it, so what a caller hands over is exactly
* what the user reads.
* @module @deepseek-ai/dsh-tui/components/panel
*/
/** Terminal rows the panel spends on its own chrome: title, footer, and the blank above. */
const PANEL_CHROME_ROWS$3 = 3;
/**
* One scrollable page of pre-rendered lines in the editor slot.
*
* The panel is inert except for its own scroll keys: ↑/↓ by a row, PgUp/PgDn by
* a page, `g`/`G` (and Home/End) to either end, Esc or Ctrl+C to close. Every
* other key is swallowed rather than forwarded, so a keystroke aimed at the
* panel can never reach the editor behind it.
*/
var ScrollablePanel = class {
	title;
	lines;
	rows;
	palette;
	onClose;
	/** Set by the TUI on focus; the panel shows no cursor, so it only tracks it. */
	focused = false;
	/** First visible content row. */
	offset = 0;
	/** Wrapped content for {@link wrappedWidth}; recomputed when the width changes. */
	wrapped = [];
	wrappedWidth = -1;
	/**
	* @param title - dim heading, shown above the content.
	* @param lines - pre-rendered content rows; ANSI is preserved, empty rows are kept.
	* @param rows - the panel's total row budget, read per render so a resize applies.
	* @param palette - active role palette.
	* @param onClose - called on Esc or Ctrl+C; the caller closes the overlay.
	*/
	constructor(title, lines, rows, palette, onClose) {
		this.title = title;
		this.lines = lines;
		this.rows = rows;
		this.palette = palette;
		this.onClose = onClose;
	}
	invalidate() {
		this.wrappedWidth = -1;
	}
	/** Content rows for `width`, wrapped once and reused until the width changes. */
	content(width) {
		if (this.wrappedWidth === width) return this.wrapped;
		this.wrapped = this.lines.flatMap((line) => wrapTextWithAnsi(line, width));
		this.wrappedWidth = width;
		return this.wrapped;
	}
	/** Visible content rows, once the title, footer, and leading blank are paid for. */
	viewport() {
		return Math.max(1, this.rows() - PANEL_CHROME_ROWS$3);
	}
	/** Last legal offset for the last measured width; zero while the content fits. */
	maxOffset() {
		return Math.max(0, this.wrapped.length - this.viewport());
	}
	scrollTo(offset) {
		this.offset = Math.max(0, Math.min(offset, this.maxOffset()));
	}
	handleInput(data) {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.onClose();
			return;
		}
		if (matchesKey(data, Key.up)) this.scrollTo(this.offset - 1);
		else if (matchesKey(data, Key.down)) this.scrollTo(this.offset + 1);
		else if (matchesKey(data, Key.pageUp)) this.scrollTo(this.offset - this.viewport());
		else if (matchesKey(data, Key.pageDown)) this.scrollTo(this.offset + this.viewport());
		else if (data === "g" || matchesKey(data, Key.home)) this.scrollTo(0);
		else if (data === "G" || matchesKey(data, Key.end)) this.scrollTo(this.maxOffset());
	}
	render(width) {
		const contentWidth = Math.max(1, width - 2);
		const content = this.content(contentWidth);
		const viewport = this.viewport();
		this.scrollTo(this.offset);
		const visible = content.slice(this.offset, this.offset + viewport);
		const position = content.length > viewport ? `  ·  ${t("panel.position", {
			first: this.offset + 1,
			last: this.offset + visible.length,
			total: content.length
		})}` : "";
		return [
			"",
			` ${this.palette.dim(displayText(this.title))}`,
			...visible.map((line) => ` ${line}`),
			` ${this.palette.dim(`${t("panel.hint")}${position}`)}`
		];
	}
};
//#endregion
//#region src/components/history-search.ts
/**
* Reverse incremental search over the prompt history (Ctrl+R), in the shape a
* shell user already knows.
*
* Claude Code runs this search inside the input frame: the match is written into
* the editor and the footer becomes `search prompts: <query>`. This terminal
* cannot borrow that layout — the editor's text is the draft the search has to
* be able to give back untouched, and pi-tui's editor owns its own keys the
* moment it has focus — so the search takes the editor slot as a panel instead
* and hands the accepted entry back on the way out. The semantics are Claude's,
* key for key: Ctrl+R walks to older matches, Esc and Tab accept, Enter accepts
* and submits, and only Ctrl+C (or a backspace over the empty query) restores
* the draft the user was typing.
* @module @deepseek-ai/dsh-tui/components/history-search
*/
/**
* One page of reverse history search in the editor slot.
*
* Matching is a case-sensitive substring test against the entries in order,
* newest first, exactly as Claude Code does it: a fuzzy match would make the
* next Ctrl+R unpredictable, which is the one thing this key has to be.
*/
var HistorySearchPanel = class {
	entries;
	palette;
	accept;
	cancel;
	/** Set by the TUI on focus; the panel draws its own caret, so it only tracks it. */
	focused = false;
	query = "";
	/** Index of the entry currently shown, or -1 before anything matched. */
	matchIndex = -1;
	/** Whether the last search ran off the end of the history without a match. */
	failed = false;
	/**
	* @param entries - Prompt history, newest first.
	* @param palette - Active role palette.
	* @param accept - Called with the entry to put back in the editor, and whether to send it.
	* @param cancel - Called when the search is abandoned; the caller restores the draft.
	*/
	constructor(entries, palette, accept, cancel) {
		this.entries = entries;
		this.palette = palette;
		this.accept = accept;
		this.cancel = cancel;
	}
	invalidate() {}
	/** The entry currently on screen, or `undefined` while nothing has matched. */
	current() {
		return this.matchIndex < 0 ? void 0 : this.entries[this.matchIndex];
	}
	/**
	* Search from `from` toward older entries and adopt the first match.
	*
	* A search that finds nothing keeps the previous match on screen and only
	* raises {@link HistorySearchPanel.failed}: Claude Code does the same, because
	* dropping back to nothing would throw away the entry the user is one keypress
	* away from accepting.
	* @param from - First index to test.
	*/
	search(from) {
		if (this.query === "") {
			this.matchIndex = -1;
			this.failed = false;
			return;
		}
		for (let index = Math.max(0, from); index < this.entries.length; index += 1) if ((this.entries[index] ?? "").includes(this.query)) {
			this.matchIndex = index;
			this.failed = false;
			return;
		}
		this.failed = true;
	}
	handleInput(data) {
		if (matchesKey(data, Key.ctrl("c"))) {
			this.cancel();
			return;
		}
		if (matchesKey(data, Key.ctrl("r"))) {
			this.search(this.matchIndex + 1);
			return;
		}
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.tab)) {
			const match = this.current();
			if (match === void 0) this.cancel();
			else this.accept(match, "accept");
			return;
		}
		if (matchesKey(data, Key.enter)) {
			const match = this.current();
			if (match === void 0) this.cancel();
			else this.accept(match, "submit");
			return;
		}
		if (matchesKey(data, Key.backspace) || matchesKey(data, Key.delete)) {
			if (this.query === "") this.cancel();
			else {
				this.query = this.query.slice(0, -1);
				this.search(0);
			}
			return;
		}
		if (data !== "" && [...data].every((char) => {
			const code = char.codePointAt(0) ?? 0;
			return code >= 32 && code !== 127;
		})) {
			this.query += data;
			this.search(0);
		}
	}
	render(width) {
		const contentWidth = Math.max(1, width - 2);
		const match = this.current();
		const heading = `${t(this.failed ? "history.noMatch" : "history.label")}: ${displayText(this.query)}`;
		const body = match === void 0 ? this.palette.dim(t("history.empty")) : this.palette.accent(displayText(match.split("\n")[0] ?? ""));
		return [
			"",
			` ${this.palette.dim(truncateToWidth(heading, contentWidth, "…"))}`,
			` ${truncateToWidth(`❯ ${body}`, contentWidth, "…")}`,
			` ${this.palette.dim(truncateToWidth(t("history.hint"), contentWidth, "…"))}`
		];
	}
};
//#endregion
//#region src/components/rewind.ts
/**
* The Rewind surface: jump back to an earlier prompt in this session.
*
* Claude Code's Rewind can restore files as well as conversation, because it
* snapshots the working tree per message. dsh keeps no such snapshots, so this
* panel says so on its own face and never implies otherwise — a rewind here
* moves the conversation, and the files on disk stay exactly as the last turn
* left them. Which of the two conversation outcomes is on offer depends on the
* runtime: a host that can fork the session hands the transcript back to the
* chosen point, and one that cannot only brings the prompt's text back to the
* editor.
* @module @deepseek-ai/dsh-tui/components/rewind
*/
/** Rows the panel spends on its own chrome: blank, title, lead line, caveat, footer. */
const REWIND_CHROME_ROWS = 6;
/**
* Keyboard picker over this session's own prompts, newest last.
*
* The list is ordered the way the conversation reads (oldest first) and opens on
* the most recent prompt, because "take that back" is the common case and it is
* the row nearest the input frame.
*/
var RewindPanel = class {
	targets;
	canFork;
	rows;
	palette;
	done;
	cancel;
	/** Set by the TUI on focus; the panel draws its own pointer, so it only tracks it. */
	focused = false;
	selectedIndex;
	/**
	* @param targets - Selectable prompts, oldest first.
	* @param canFork - Whether the runtime can fork the session; decides the wording only.
	* @param rows - The panel's row budget, read per render so a resize applies.
	* @param palette - Active role palette.
	* @param done - Called with the chosen prompt.
	* @param cancel - Called on Esc or Ctrl+C.
	*/
	constructor(targets, canFork, rows, palette, done, cancel) {
		this.targets = targets;
		this.canFork = canFork;
		this.rows = rows;
		this.palette = palette;
		this.done = done;
		this.cancel = cancel;
		this.selectedIndex = Math.max(0, targets.length - 1);
	}
	invalidate() {}
	/** Prompts visible at once, once the panel's own chrome is paid for. */
	visibleCount() {
		return Math.max(1, Math.min(this.targets.length, this.rows() - REWIND_CHROME_ROWS));
	}
	handleInput(data) {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.cancel();
			return;
		}
		if (this.targets.length === 0) {
			if (matchesKey(data, Key.enter)) this.cancel();
			return;
		}
		if (matchesKey(data, Key.up)) this.selectedIndex = (this.selectedIndex + this.targets.length - 1) % this.targets.length;
		else if (matchesKey(data, Key.down)) this.selectedIndex = (this.selectedIndex + 1) % this.targets.length;
		else if (matchesKey(data, Key.pageUp)) this.selectedIndex = Math.max(0, this.selectedIndex - this.visibleCount());
		else if (matchesKey(data, Key.pageDown)) this.selectedIndex = Math.min(this.targets.length - 1, this.selectedIndex + this.visibleCount());
		else if (matchesKey(data, Key.home)) this.selectedIndex = 0;
		else if (matchesKey(data, Key.end)) this.selectedIndex = this.targets.length - 1;
		else if (matchesKey(data, Key.enter)) {
			const target = this.targets[this.selectedIndex];
			if (target !== void 0) this.done(target);
		}
	}
	render(width) {
		const contentWidth = Math.max(1, width - 2);
		const push = (line) => ` ${truncateToWidth(line, contentWidth, "…")}`;
		const lines = ["", push(this.palette.bold(this.palette.accent(t("rewind.title"))))];
		if (this.targets.length === 0) {
			lines.push(push(t("rewind.empty")), push(this.palette.dim(t("panel.escClose"))));
			return lines;
		}
		lines.push(push(t(this.canFork ? "rewind.fork" : "rewind.reuse")));
		const visible = this.visibleCount();
		const start = Math.max(0, Math.min(this.selectedIndex - Math.floor(visible / 2), this.targets.length - visible));
		for (let index = start; index < Math.min(this.targets.length, start + visible); index += 1) {
			const target = this.targets[index];
			const active = index === this.selectedIndex;
			const text = displayText((target.text.split("\n")[0] ?? "").trim());
			const row = `${active ? "❯" : " "} ${text}`;
			lines.push(push(active ? this.palette.bold(this.palette.accent(row)) : row));
		}
		lines.push(push(this.palette.dim(t("rewind.files"))), push(this.palette.dim(t("rewind.hint"))));
		return lines;
	}
};
//#endregion
//#region src/chat/rewind.ts
/**
* The prompts this session can be rewound to, oldest first.
*
* Only messages the user actually typed qualify: producer-injected context and
* compaction checkpoints are also `user/message` events, and offering them as
* rewind targets would put text in the editor that no human ever wrote.
* @param events - The session's event log.
* @returns One target per typed prompt, in log order.
*/
function rewindTargets(events) {
	const targets = [];
	for (const event of events) {
		if (event.type !== "user/message") continue;
		const message = event.data;
		if (message.source.kind !== "user") continue;
		const text = contentText(message.content).trim();
		if (text === "") continue;
		targets.push({
			seq: event.seq,
			time: event.time,
			text
		});
	}
	return targets;
}
/**
* Whether this session has any prompt to rewind to.
*
* Scanned from the end and stopped at the first hit, because this answers a
* keystroke: the Esc ladder asks it on every press at an empty prompt, and
* folding the whole log each time would make the key slower the longer the
* session gets.
* @param events - The session's event log.
* @returns `true` once one typed prompt is in the log.
*/
function hasRewindTarget(events) {
	for (let index = events.length - 1; index >= 0; index -= 1) {
		const event = events[index];
		if (event?.type !== "user/message") continue;
		if (event.data.source.kind === "user" && contentText(event.data.content).trim() !== "") return true;
	}
	return false;
}
/**
* How many leading events a fork placed before `seq` may keep.
*
* A seed must be a prefix that contains no open turn, step, or tool call
* (`AgentRegistry.create` rejects anything else), so the only legal cut is
* immediately after a completed turn — the same rule the API's own fork applies.
* The cut lands on the last such boundary before the prompt, which is why a
* prompt sent during a turn that never completed cannot be rewound to.
* @param events - The session's event log.
* @param seq - Sequence of the `user/message` being rewound to.
* @returns The seed length, or `undefined` when no completed turn precedes it.
*/
function forkSeedLength(events, seq) {
	let cut;
	for (const [index, event] of events.entries()) {
		if (event.seq >= seq) break;
		if (event.type === "turn/end") cut = index + 1;
	}
	return cut;
}
//#endregion
//#region src/chat/transcript-search.ts
/**
* The row label for a role that does not carry one of its own.
*
* Read through {@link t} per call rather than held in a module-level table: a
* table built at import time would freeze the locale the module was first
* loaded under, and `/lang` would leave these labels behind in English.
* @param role - the entry's origin.
* @returns the label in the active locale.
*/
function roleLabel(role) {
	return t(`search.role.${role}`);
}
/** Characters an excerpt keeps; a row is truncated to the panel's width anyway. */
const EXCERPT_MAX = 160;
/** Characters kept before the hit when the line is windowed, for context. */
const EXCERPT_LEAD = 24;
/**
* Cut text to a budget, marking the cut.
* @param text - the text to clip.
* @param max - characters the result may occupy, ellipsis included.
* @returns the text, or its head with a trailing ellipsis.
*/
function clip(text, max) {
	return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}
/**
* A tool call's one-line detail, derived from its arguments alone.
*
* The transcript's own header summary comes from the tool's presenter, which
* needs the tool definition and the registry that owns it. A search runs over a
* folded snapshot with neither, so it reads the arguments directly: the scalar
* fields, in the order the model wrote them, which is where a command, a path,
* or a pattern actually is.
* @param args - the node's parsed arguments.
* @returns the summary, or the empty string when nothing scalar survives.
*/
function toolArgumentsSummary(args) {
	if (!args.valid) return typeof args.value === "string" ? args.value : "";
	const value = args.value;
	if (value === null || typeof value !== "object") return value === void 0 ? "" : String(value);
	return Object.entries(value).filter(([, field]) => typeof field === "string" || typeof field === "number" || typeof field === "boolean").map(([name, field]) => `${name}: ${String(field)}`).join(" · ");
}
/**
* The searchable text one node contributes, or `undefined` when it has none.
* @param node - one folded chat node.
* @returns the entry's role, label, and body.
*/
function entryOf(node) {
	switch (node.kind) {
		case "user-message": return node.withdrawn === true ? void 0 : {
			role: "user",
			label: roleLabel("user"),
			text: node.text
		};
		case "assistant": return {
			role: "assistant",
			label: roleLabel("assistant"),
			text: node.text
		};
		case "tool-call": {
			const summary = toolArgumentsSummary(node.args);
			const header = summary === "" ? node.name : `${node.name}(${summary})`;
			const result = node.result?.text ?? "";
			return {
				role: "tool",
				label: node.name,
				text: result === "" ? header : `${header}\n${result}`
			};
		}
		case "notice": return {
			role: "notice",
			label: roleLabel("notice"),
			text: node.text
		};
		case "context": return {
			role: "context",
			label: node.label,
			text: node.text
		};
		case "reference": return {
			role: "reference",
			label: roleLabel("reference"),
			text: node.labels.join("\n")
		};
		case "compaction": return node.landed ? {
			role: "compaction",
			label: roleLabel("compaction"),
			text: node.summary
		} : void 0;
		default: return;
	}
}
/**
* Flatten a snapshot's nodes into the entries a search runs over.
*
* Order is the transcript's own, and an entry with nothing to read is dropped:
* a row that matched on emptiness would open a panel page with nothing on it.
* @param nodes - the store snapshot's nodes, in log order.
* @returns one entry per readable node.
*/
function transcriptEntries(nodes) {
	const entries = [];
	for (const node of nodes) {
		const entry = entryOf(node);
		if (entry === void 0 || entry.text.trim() === "") continue;
		entries.push({
			key: node.key,
			time: node.time,
			...entry
		});
	}
	return entries;
}
/**
* The lower-case form used for matching, and whether it may be sliced by index.
*
* Case folding can change a string's length (`İ` lowers to two code units), and
* an index taken from the folded text would then cut the original in the wrong
* place. Where that happens the search stays case-sensitive for that text rather
* than reporting a highlight that lands on the wrong characters.
* @param text - the text to fold.
* @returns the searchable form, or the original when folding is not index-safe.
*/
function foldCase(text) {
	const lowered = text.toLocaleLowerCase();
	return lowered.length === text.length ? lowered : text;
}
/**
* The excerpt shown for one hit line: trimmed, and windowed when the hit sits
* past the point a row can show.
* @param line - the matching line, as folded.
* @param needle - the query, already case-folded; empty for "no query".
* @returns a single line, at most {@link EXCERPT_MAX} characters.
*/
function excerptFor(line, needle) {
	const trimmed = line.trim();
	if (needle === "") return clip(trimmed, EXCERPT_MAX);
	const index = foldCase(trimmed).indexOf(needle);
	if (index <= EXCERPT_LEAD) return clip(trimmed, EXCERPT_MAX);
	return `…${clip(trimmed.slice(index - EXCERPT_LEAD), 159)}`;
}
/**
* Every entry the query hits, in transcript order.
*
* The test is a case-insensitive substring, the same one the `/plugins` filter
* and the model picker use: a fuzzy match would return rows whose relation to
* what was typed the user cannot see, and this panel's whole job is to show it.
* An empty query matches everything, so the panel opens on the session rather
* than on an empty page.
* @param entries - the flattened transcript.
* @param query - what the user typed, verbatim.
* @returns one match per hit entry.
*/
function searchTranscript(entries, query) {
	const needle = foldCase(query);
	const matches = [];
	for (const entry of entries) {
		const lines = entry.text.split("\n");
		if (needle === "") {
			const lead = lines.find((line) => line.trim() !== "") ?? "";
			matches.push({
				entry,
				excerpt: excerptFor(lead, ""),
				hitLines: 0
			});
			continue;
		}
		let first;
		let hitLines = 0;
		for (const line of lines) {
			if (!foldCase(line).includes(needle)) continue;
			hitLines += 1;
			first ??= line;
		}
		if (first === void 0) continue;
		matches.push({
			entry,
			excerpt: excerptFor(first, needle),
			hitLines
		});
	}
	return matches;
}
/**
* Split one line at the query's occurrences, so the panel can paint them.
*
* The segments carry the original text, not the folded one: a highlight that
* lower-cased what it drew would rewrite the message under the reader's eyes.
* @param text - the line to split.
* @param query - what the user typed, verbatim.
* @returns the runs in order; empty for empty text.
*/
function highlightSegments(text, query) {
	if (text === "") return [];
	const needle = foldCase(query);
	if (needle === "") return [{
		text,
		hit: false
	}];
	const haystack = foldCase(text);
	const segments = [];
	let cursor = 0;
	for (;;) {
		const index = haystack.indexOf(needle, cursor);
		if (index === -1) break;
		if (index > cursor) segments.push({
			text: text.slice(cursor, index),
			hit: false
		});
		segments.push({
			text: text.slice(index, index + needle.length),
			hit: true
		});
		cursor = index + needle.length;
	}
	if (cursor < text.length) segments.push({
		text: text.slice(cursor),
		hit: false
	});
	return segments;
}
//#endregion
//#region src/components/transcript-search.ts
/**
* `/search` panel: every message in this session, filtered as you type.
*
* An inline terminal prints its transcript into the terminal's own scrollback,
* where nothing this process runs can scroll it or point at a line inside it.
* So the search does not jump: it opens a panel over the input frame, lists the
* messages the query hits with the hit shown in place, and gives one message its
* whole page on Enter. Esc walks back out the way it came in — the page, then
* the query, then the panel — which is the ladder every filterable surface here
* already uses.
* @module @deepseek-ai/dsh-tui/components/transcript-search
*/
/** The panel's heading, so the command and its view name the same thing. */
const TRANSCRIPT_SEARCH_TITLE = "/search";
t("search.empty", void 0, "en");
t("search.noMatch", void 0, "en");
/** Terminal rows the panel spends on its own chrome: blank, title, query, count, footer. */
const PANEL_CHROME_ROWS$2 = 5;
/** Widest label column a row will give up to the message itself. */
const LABEL_COLUMN_MAX = 14;
/**
* Paint one row label in the role its message reads as.
* @param role - the entry's origin.
* @param label - the label text, already escaped.
* @param palette - active role palette.
* @returns the painted label.
*/
function paintLabel(role, label, palette) {
	if (role === "user") return palette.accent(label);
	if (role === "assistant") return palette.text(label);
	if (role === "notice") return palette.warning(label);
	return palette.dim(label);
}
/**
* Paint one line with the query's occurrences standing out.
*
* The hits are reverse video rather than a color: the row underneath is already
* colored by role, and a second color would read as a third meaning.
* @param text - the line to paint, already escaped for the terminal.
* @param query - what the user typed, verbatim.
* @param palette - active role palette.
* @returns the line with every hit painted.
*/
function paintHits(text, query, palette) {
	return highlightSegments(text, query).map((segment) => segment.hit ? palette.selected(segment.text) : segment.text).join("");
}
/**
* Full-text search over this session's messages, in the editor slot.
*
* Keyboard-owned like {@link ./plugins-panel.ts | PluginsPanel}: every keystroke
* is consumed here — query box, selection, the open message — and none leaks
* into the editor underneath. The caller closes the overlay through `onClose`.
*/
var TranscriptSearchPanel = class {
	entries;
	rows;
	palette;
	onClose;
	/** Set by the TUI on focus; the query box owns the visible cursor. */
	focused = false;
	query = new Input();
	/** Message the selection bar sits on; kept by key so filtering re-finds it. */
	selectedKey;
	/** The message whose whole text fills the panel, or `undefined` in the list. */
	openKey;
	/** First visible list row. */
	offset = 0;
	/** First visible row of the open message. */
	detailOffset = 0;
	/**
	* @param entries - this session's messages, in transcript order.
	* @param initialQuery - the `/search` argument, if the command carried one.
	* @param rows - the panel's total row budget, read per render so a resize applies.
	* @param palette - active role palette.
	* @param onClose - called on Esc (with an empty query) or Ctrl+C.
	*/
	constructor(entries, initialQuery, rows, palette, onClose) {
		this.entries = entries;
		this.rows = rows;
		this.palette = palette;
		this.onClose = onClose;
		for (const character of initialQuery) this.query.handleInput(character);
	}
	invalidate() {
		this.query.invalidate();
	}
	/** The messages the current query hits, in transcript order. */
	matches() {
		return searchTranscript(this.entries, this.query.getValue());
	}
	/** The selection bar's index within `visible`, falling back to the first row. */
	selectedIndex(visible) {
		const index = visible.findIndex((match) => match.entry.key === this.selectedKey);
		return index === -1 ? 0 : index;
	}
	viewport() {
		return Math.max(1, this.rows() - PANEL_CHROME_ROWS$2);
	}
	move(delta) {
		const visible = this.matches();
		if (visible.length === 0) return;
		const index = Math.max(0, Math.min(this.selectedIndex(visible) + delta, visible.length - 1));
		this.selectedKey = visible[index]?.entry.key;
	}
	/** Re-derive the selection after the query box changed. */
	refilter() {
		const visible = this.matches();
		if (!visible.some((match) => match.entry.key === this.selectedKey)) this.selectedKey = visible[0]?.entry.key;
		this.offset = 0;
	}
	/** The message currently filling the panel, when one is open. */
	opened() {
		return this.entries.find((entry) => entry.key === this.openKey);
	}
	handleInput(data) {
		if (matchesKey(data, Key.ctrl("c"))) {
			this.onClose();
			return;
		}
		if (this.openKey !== void 0) {
			this.handleDetailInput(data);
			return;
		}
		if (matchesKey(data, Key.escape)) {
			if (this.query.getValue() === "") {
				this.onClose();
				return;
			}
			this.query.setValue("");
			this.refilter();
			return;
		}
		if (this.entries.length === 0) return;
		if (matchesKey(data, Key.up)) {
			this.move(-1);
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.move(1);
			return;
		}
		if (matchesKey(data, Key.pageUp)) {
			this.move(-this.viewport());
			return;
		}
		if (matchesKey(data, Key.pageDown)) {
			this.move(this.viewport());
			return;
		}
		if (matchesKey(data, Key.enter)) {
			const visible = this.matches();
			const selected = visible[this.selectedIndex(visible)];
			if (selected === void 0) return;
			this.selectedKey = selected.entry.key;
			this.openKey = selected.entry.key;
			this.detailOffset = 0;
			return;
		}
		const previous = this.query.getValue();
		this.query.focused = true;
		this.query.handleInput(data);
		if (this.query.getValue() !== previous) this.refilter();
	}
	/** Keys while one message fills the panel: scrolling, and the way back. */
	handleDetailInput(data) {
		if (matchesKey(data, Key.escape)) {
			this.openKey = void 0;
			this.detailOffset = 0;
			return;
		}
		const viewport = this.viewport();
		if (matchesKey(data, Key.up)) this.detailOffset -= 1;
		else if (matchesKey(data, Key.down)) this.detailOffset += 1;
		else if (matchesKey(data, Key.pageUp)) this.detailOffset -= viewport;
		else if (matchesKey(data, Key.pageDown)) this.detailOffset += viewport;
		else if (matchesKey(data, Key.home)) this.detailOffset = 0;
		else if (matchesKey(data, Key.end)) this.detailOffset = Number.MAX_SAFE_INTEGER;
	}
	/** List body rows, plus the display-row index of the selection bar. */
	listBody(visible, width) {
		if (visible.length === 0) return {
			rows: [this.palette.dim(t("search.noMatch"))],
			selectedRow: 0
		};
		const query = this.query.getValue();
		const labels = visible.map((match) => truncateToWidth(displayInlineText(match.entry.label), LABEL_COLUMN_MAX, ""));
		const column = Math.max(...labels.map((label) => visibleWidth(label)));
		const selectedIndex = this.selectedIndex(visible);
		return {
			rows: visible.map((match, index) => {
				/* v8 ignore next -- labels is built from `visible`, so the index always resolves. */
				const label = labels[index] ?? "";
				const bar = index === selectedIndex ? this.palette.accent("→ ") : "  ";
				const painted = paintHits(displayInlineText(match.excerpt), query, this.palette);
				return truncateToWidth(`${bar}${paintLabel(match.entry.role, label, this.palette)}${" ".repeat(column - visibleWidth(label))}  ${painted}`, width, "");
			}),
			selectedRow: selectedIndex
		};
	}
	/** The open message's body, wrapped to the panel and with its hits painted. */
	detailBody(entry, width) {
		const query = this.query.getValue();
		return displayText(entry.text).split("\n").flatMap((line) => {
			if (line.trim() === "") return [""];
			return wrapTextWithAnsi(paintHits(line, query, this.palette), width);
		});
	}
	/**
	* Frame one body block into the panel: a window that follows the row it must
	* keep in view, and the readout that says where the window sits.
	* @param rows - every body row.
	* @param offset - the current first visible row.
	* @param keep - a row the window must contain, when one has to stay in view.
	* @returns the visible rows, the clamped offset, and the position readout.
	*/
	frame(rows, offset, keep) {
		const viewport = this.viewport();
		let next = Math.max(0, Math.min(offset, Math.max(0, rows.length - viewport)));
		if (keep !== void 0) {
			if (keep < next) next = keep;
			if (keep >= next + viewport) next = keep - viewport + 1;
		}
		const shown = rows.slice(next, next + viewport);
		const position = rows.length > viewport ? `  ·  ${t("panel.position", {
			first: next + 1,
			last: next + shown.length,
			total: rows.length
		})}` : "";
		return {
			shown,
			offset: next,
			position
		};
	}
	render(width) {
		const contentWidth = Math.max(1, width - 2);
		const title = ` ${this.palette.dim(TRANSCRIPT_SEARCH_TITLE)}`;
		if (this.entries.length === 0) return [
			"",
			title,
			...wrapTextWithAnsi(this.palette.dim(t("search.empty")), contentWidth).map((line) => ` ${line}`),
			` ${this.palette.dim(t("panel.escClose"))}`
		];
		const open = this.opened();
		return open === void 0 ? this.renderList(contentWidth, title) : this.renderDetail(open, contentWidth);
	}
	/** The list of hits, with the query box above it. */
	renderList(contentWidth, title) {
		const visible = this.matches();
		this.query.focused = true;
		const queryLine = truncateToWidth(`${this.palette.dim(t("search.query"))} ${this.query.render(Math.max(1, contentWidth - 7)).join("")}`, contentWidth, "");
		const count = plural(this.entries.length, "search.count", {
			visible: visible.length,
			total: this.entries.length
		});
		const { rows, selectedRow } = this.listBody(visible, contentWidth);
		const framed = this.frame(rows, this.offset, selectedRow);
		this.offset = framed.offset;
		return [
			"",
			title,
			` ${queryLine}`,
			` ${truncateToWidth(this.palette.dim(count), contentWidth, "")}`,
			...framed.shown.map((line) => ` ${line}`),
			` ${truncateToWidth(this.palette.dim(`${t("search.hint")}${framed.position}`), contentWidth, "")}`
		];
	}
	/** One message's whole text, paged. */
	renderDetail(entry, contentWidth) {
		const query = this.query.getValue();
		const heading = `${TRANSCRIPT_SEARCH_TITLE} · ${displayInlineText(entry.label)}`;
		const rows = this.detailBody(entry, contentWidth);
		const framed = this.frame(rows, this.detailOffset);
		this.detailOffset = framed.offset;
		const subtitle = query === "" ? t("search.detail.whole") : t("search.detail.hits", { query: displayInlineText(query) });
		return [
			"",
			` ${truncateToWidth(this.palette.dim(heading), contentWidth, "")}`,
			` ${truncateToWidth(this.palette.dim(subtitle), contentWidth, "")}`,
			"",
			...framed.shown.map((line) => ` ${line}`),
			` ${truncateToWidth(this.palette.dim(`${t("search.detailHint")}${framed.position}`), contentWidth, "")}`
		];
	}
};
//#endregion
//#region src/keybindings.ts
/**
* The keys this terminal binds for itself, as a pi-tui keybinding registry.
*
* pi-tui resolves every key through one process-global {@link KeybindingsManager}
* (`Editor.handleInput` reads it on its first line), so an app that wants its own
* keys rebindable has to own that singleton: the registry below is pi-tui's own
* table plus this terminal's actions, and {@link installKeybindings} publishes it
* before any component is constructed. Omitting `TUI_KEYBINDINGS` would silently
* unbind the editor's own keys — `matches()` answers `false` for an id the
* manager does not know — so the spread is not optional.
*
* Ctrl+C is deliberately absent: it is the one key a terminal must always answer
* (cancel, then leave), and a user who rebinds it away has no way back.
* @module @deepseek-ai/dsh-tui/keybindings
*/
/**
* This terminal's own actions and their default keys.
*
* The descriptions are user-facing: `/hotkeys` and `/help` render them beside
* whichever key is bound, so a rebound key never leaves the help lying.
*/
const APP_KEYBINDINGS = {
	"app.mode.cycle": {
		defaultKeys: "shift+tab",
		description: "Cycle mode: normal, auto-accept, plan"
	},
	"app.tools.cycle": {
		defaultKeys: "ctrl+o",
		description: "Cycle tool cards: preview, full, hidden"
	},
	"app.history.search": {
		defaultKeys: "ctrl+r",
		description: "Search prompt history backwards"
	},
	"app.transcript.search": {
		defaultKeys: "ctrl+g",
		description: "Search this session's messages"
	},
	"app.todos.toggle": {
		defaultKeys: "ctrl+n",
		description: "Expand or collapse the plan"
	},
	"app.thinking.toggle": {
		defaultKeys: "ctrl+t",
		description: "Show or hide thinking blocks"
	},
	"app.message.copy": {
		defaultKeys: "ctrl+x",
		description: "Copy the last answer"
	},
	"app.screen.redraw": {
		defaultKeys: "ctrl+l",
		description: "Redraw the screen"
	},
	"app.cancel": {
		defaultKeys: "escape",
		description: "Cancel the turn; twice to clear the draft or rewind"
	},
	"app.exit": {
		defaultKeys: "ctrl+d",
		description: "Exit on an empty prompt"
	}
};
/** pi-tui's own bindings plus this terminal's, which is what the manager is built from. */
const KEYBINDINGS = {
	...TUI_KEYBINDINGS,
	...APP_KEYBINDINGS
};
/**
* Keep only the entries a keybinding config can express.
*
* Configuration reaches this from a deployment file, so a value of the wrong
* shape is dropped rather than trusted: an unbindable entry that reached the
* manager would take its action's default away and bind nothing in its place.
* @param bindings - The deployment's `keybindings` map, if any.
* @returns The usable subset, in the manager's own shape.
*/
function toKeybindingsConfig(bindings) {
	const config = {};
	for (const [action, keys] of Object.entries(bindings ?? {})) if (typeof keys === "string") config[action] = keys;
	else if (Array.isArray(keys) && keys.every((key) => typeof key === "string")) config[action] = keys;
	return config;
}
/**
* Publish this terminal's registry as pi-tui's process-global one.
*
* Must run before the editor and every other pi-tui component is constructed;
* they read the singleton at construction and on every keystroke.
* @param bindings - User overrides, keyed by action id.
* @returns The manager, for the resolved keys the help panels render.
*/
function installKeybindings(bindings) {
	const manager = new KeybindingsManager(KEYBINDINGS, toKeybindingsConfig(bindings));
	setKeybindings(manager);
	return manager;
}
/**
* The keys this terminal knowingly takes off pi-tui, and the editor action each
* one shadows.
*
* Both are load-bearing terminal conventions the editor cannot outrank: Ctrl+D
* is EOF on an empty prompt (it shadows `tui.editor.deleteCharForward`, whose
* job the Delete key still does), and Esc cancels the turn (it shadows the
* select widget's own cancel, which never coexists with the input listener
* anyway, since an open overlay returns before this listener's first branch).
* Everything *not* listed here is a bug — see {@link keybindingCollisions}.
*/
const ACCEPTED_COLLISIONS = {
	"ctrl+d": ["tui.editor.deleteCharForward"],
	escape: ["tui.select.cancel"]
};
/**
* Keys an `app.*` action takes away from pi-tui.
*
* `KeybindingsManager.getConflicts()` only compares *user overrides* against
* each other, so a default that collides with a pi-tui default is invisible to
* it — and the collision is silent at runtime too, because the app's input
* listener runs before the focused component and answers with `consume: true`,
* so the editor never sees the key at all. This is the check that names it:
* resolved keys, not declared ones, so a deployment that rebinds *into* a
* pi-tui key is reported as well.
* @param manager - The installed manager, read for resolved keys.
* @returns One entry per contested key, minus {@link ACCEPTED_COLLISIONS}.
*/
function keybindingCollisions(manager) {
	const collisions = [];
	for (const action of Object.keys(APP_KEYBINDINGS)) for (const key of manager.getKeys(action)) {
		const shadowed = Object.keys(TUI_KEYBINDINGS).filter((other) => manager.getKeys(other).includes(key)).filter((other) => !(ACCEPTED_COLLISIONS[key] ?? []).includes(other));
		if (shadowed.length > 0) collisions.push({
			key,
			action,
			shadowed
		});
	}
	return collisions;
}
/** How a key id's parts are shown to the user: `ctrl+o` reads as `Ctrl+O`. */
const KEY_LABELS = {
	ctrl: "Ctrl",
	alt: "Alt",
	shift: "Shift",
	escape: "Esc",
	enter: "Enter",
	tab: "Tab",
	backspace: "Backspace",
	delete: "Delete",
	up: "Up",
	down: "Down",
	left: "Left",
	right: "Right",
	pageUp: "PgUp",
	pageDown: "PgDn",
	home: "Home",
	end: "End",
	space: "Space"
};
/**
* Render one key id the way the help panels name keys.
* @param key - A pi-tui key id such as `shift+ctrl+d`.
* @returns The display form, such as `Shift+Ctrl+D`.
*/
function formatKeyId(key) {
	return key.split("+").map((part) => KEY_LABELS[part] ?? (part.length === 1 ? part.toUpperCase() : part)).join("+");
}
/**
* The keys an action is currently bound to, as one label.
*
* Read from the manager rather than from {@link APP_KEYBINDINGS}, so a
* deployment that rebinds an action gets help text that names its key.
* @param manager - The installed manager.
* @param action - The action to name.
* @returns The bound keys joined by `/`, or `unbound` when the user removed them all.
*/
function keyLabel(manager, action) {
	const keys = manager.getKeys(action);
	return keys.length === 0 ? "unbound" : keys.map((key) => formatKeyId(key)).join("/");
}
//#endregion
//#region src/components/plugins-panel.ts
/**
* `/plugins` panel: the Cordis Loader's current entries, searchable and
* inspectable row by row.
*
* The rows come from `ctx.get('pluginInventory')` — the `pluginInventory`
* service of `@deepseek-ai/dsh-host-plugin-inventory`, whose `list()` reads the
* Loader on every call. That plugin is a HOST mount (the Web settings tab is
* its only other reader), so the TUI treats it as optional: a deployment
* without it gets a one-line explanation rather than an empty panel.
*
* The interaction is the Web plugin tab's, translated to the keyboard: typing
* filters by module name or entry id (case-insensitive substring), ↑/↓ move,
* Enter opens one entry's detail (full entry id plus the two independent facts
* the status word collapses), and Esc clears the filter before it closes the
* panel. The gateway is a read-only projection — enable/disable lives in the
* deployment's cordis.yml, not in any UI, Web included.
* @module @deepseek-ai/dsh-tui/components/plugins-panel
*/
/** The panel's heading, so the command and its view name the same thing. */
const PLUGINS_PANEL_TITLE = "/plugins";
t("plugins.unavailable", void 0, "en");
t("plugins.empty", void 0, "en");
t("plugins.noMatch", void 0, "en");
/** Terminal rows the panel spends on its own chrome: blank, title, filter, count, footer. */
const PANEL_CHROME_ROWS$1 = 5;
/**
* One entry's effective state, collapsing the two independent facts the
* inventory carries (Loader enablement and root-Fiber phase) into the one word
* a reader acts on.
*
* `disabled` wins over any phase: an entry disabled in config is off regardless
* of what its Fiber last did. `inactive` is the honest name for `fiberPhase:
* null` — enabled, but holding no live root Fiber.
* @param entry - one Loader entry from the inventory snapshot.
* @returns the status word shown in the panel's first column.
*/
function pluginEntryStatus(entry) {
	if (!entry.enabled) return "disabled";
	return entry.fiberPhase ?? "inactive";
}
/** Paint one status word in the role that says what it means. */
function paintStatus(status, palette) {
	if (status === "active") return palette.success(status);
	if (status === "failed") return palette.error(status);
	if (status === "disabled" || status === "inactive") return palette.dim(status);
	return palette.warning(status);
}
/**
* Whether an entry matches the filter box, the Web tab's `matches` verbatim:
* a case-insensitive substring over the module name and the Loader entry id.
* @param entry - one Loader entry.
* @param normalizedQuery - the query, already trimmed and lower-cased.
* @returns true when the entry stays visible under this query.
*/
function matchesQuery$1(entry, normalizedQuery) {
	if (normalizedQuery.length === 0) return true;
	return [entry.moduleName, String(entry.entryId)].some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
}
/**
* Searchable Loader-inventory panel in the editor slot.
*
* Keyboard-owned like {@link ./panel.ts | ScrollablePanel}: every keystroke is
* consumed here — filter box, selection, expansion — and none leaks into the
* editor underneath. The caller closes the overlay through `onClose`.
*/
var PluginsPanel = class {
	snapshot;
	rows;
	palette;
	onClose;
	/** Set by the TUI on focus; the filter box owns the visible cursor. */
	focused = false;
	filter = new Input();
	/** Loader entry the selection bar sits on; kept by id so filtering re-finds it. */
	selectedId;
	/** Loader entry whose detail block is open, one at a time like the Web tab. */
	expandedId;
	/** First visible body row. */
	offset = 0;
	/**
	* @param snapshot - the inventory's current entries, or `undefined` when the
	*   `pluginInventory` service is not mounted.
	* @param rows - the panel's total row budget, read per render so a resize applies.
	* @param palette - active role palette.
	* @param onClose - called on Esc (with an empty filter) or Ctrl+C.
	*/
	constructor(snapshot, rows, palette, onClose) {
		this.snapshot = snapshot;
		this.rows = rows;
		this.palette = palette;
		this.onClose = onClose;
	}
	invalidate() {
		this.filter.invalidate();
	}
	/** Entries visible under the current filter, in Loader order. */
	filtered() {
		const query = this.filter.getValue().trim().toLocaleLowerCase();
		return (this.snapshot?.entries ?? []).filter((entry) => matchesQuery$1(entry, query));
	}
	/** The selection bar's index within `visible`, falling back to the first row. */
	selectedIndex(visible) {
		const index = visible.findIndex((entry) => entry.entryId === this.selectedId);
		return index === -1 ? 0 : index;
	}
	viewport() {
		return Math.max(1, this.rows() - PANEL_CHROME_ROWS$1);
	}
	move(delta) {
		const visible = this.filtered();
		if (visible.length === 0) return;
		const index = Math.max(0, Math.min(this.selectedIndex(visible) + delta, visible.length - 1));
		this.selectedId = visible[index]?.entryId;
	}
	toggleExpanded() {
		const visible = this.filtered();
		const selected = visible[this.selectedIndex(visible)];
		if (selected === void 0) return;
		this.selectedId = selected.entryId;
		this.expandedId = this.expandedId === selected.entryId ? void 0 : selected.entryId;
	}
	/** Re-derive selection and expansion after the filter box changed. */
	refilter() {
		const visible = this.filtered();
		if (!visible.some((entry) => entry.entryId === this.selectedId)) this.selectedId = visible[0]?.entryId;
		if (!visible.some((entry) => entry.entryId === this.expandedId)) this.expandedId = void 0;
	}
	handleInput(data) {
		if (matchesKey(data, Key.ctrl("c"))) {
			this.onClose();
			return;
		}
		if (matchesKey(data, Key.escape)) {
			if (this.filter.getValue() === "") {
				this.onClose();
				return;
			}
			this.filter.setValue("");
			this.refilter();
			return;
		}
		if (this.snapshot === void 0 || this.snapshot.entries.length === 0) return;
		if (matchesKey(data, Key.up)) {
			this.move(-1);
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.move(1);
			return;
		}
		if (matchesKey(data, Key.pageUp)) {
			this.move(-this.viewport());
			return;
		}
		if (matchesKey(data, Key.pageDown)) {
			this.move(this.viewport());
			return;
		}
		if (matchesKey(data, Key.enter)) {
			this.toggleExpanded();
			return;
		}
		const previous = this.filter.getValue();
		this.filter.focused = true;
		this.filter.handleInput(data);
		if (this.filter.getValue() !== previous) this.refilter();
	}
	/** Body rows for the ready state, plus the display-row index of the selection bar. */
	body(visible, width) {
		if (visible.length === 0) return {
			rows: [this.palette.dim(t("plugins.noMatch"))],
			selectedRow: 0
		};
		const statuses = visible.map((entry) => pluginEntryStatus(entry));
		const statusColumn = Math.max(...statuses.map((status) => status.length));
		const selectedIndex = this.selectedIndex(visible);
		const rows = [];
		let selectedRow = 0;
		visible.forEach((entry, index) => {
			/* v8 ignore next -- statuses is built from `visible`, so the index always resolves. */
			const status = statuses[index] ?? "";
			const bar = index === selectedIndex ? this.palette.accent("→ ") : "  ";
			if (index === selectedIndex) selectedRow = rows.length;
			const name = displayInlineText(entry.moduleName);
			rows.push(truncateToWidth(`${bar}${paintStatus(status, this.palette)}${" ".repeat(statusColumn - status.length)}  ${this.palette.text(name)}`, width, ""));
			if (entry.entryId !== this.expandedId) return;
			const detail = [
				["entry", displayInlineText(String(entry.entryId))],
				["config", entry.enabled ? "enabled" : "disabled"],
				...entry.enabled ? [["cordis", entry.fiberPhase ?? "unobserved"]] : []
			];
			for (const [label, value] of detail) rows.push(truncateToWidth(`      ${this.palette.dim(`${label.padEnd(6)} ${value}`)}`, width, ""));
		});
		return {
			rows,
			selectedRow
		};
	}
	render(width) {
		const contentWidth = Math.max(1, width - 2);
		const title = ` ${this.palette.dim(PLUGINS_PANEL_TITLE)}`;
		if (this.snapshot === void 0 || this.snapshot.entries.length === 0) {
			const reason = this.snapshot === void 0 ? t("plugins.unavailable") : t("plugins.empty");
			return [
				"",
				title,
				...wrapTextWithAnsi(this.palette.dim(reason), contentWidth).map((line) => ` ${line}`),
				` ${this.palette.dim(t("panel.escClose"))}`
			];
		}
		const visible = this.filtered();
		this.filter.focused = true;
		const filterLine = truncateToWidth(`${this.palette.dim(t("plugins.filter"))} ${this.filter.render(Math.max(1, contentWidth - 8)).join("")}`, contentWidth, "");
		const active = this.snapshot.entries.filter((entry) => pluginEntryStatus(entry) === "active").length;
		const total = this.snapshot.entries.length;
		const count = plural(total, "plugins.count", {
			visible: visible.length,
			total,
			active
		});
		const { rows, selectedRow } = this.body(visible, contentWidth);
		const viewport = this.viewport();
		this.offset = Math.max(0, Math.min(this.offset, Math.max(0, rows.length - viewport)));
		if (selectedRow < this.offset) this.offset = selectedRow;
		if (selectedRow >= this.offset + viewport) this.offset = selectedRow - viewport + 1;
		const shown = rows.slice(this.offset, this.offset + viewport);
		const position = rows.length > viewport ? `  ·  ${t("panel.position", {
			first: this.offset + 1,
			last: this.offset + shown.length,
			total: rows.length
		})}` : "";
		return [
			"",
			title,
			` ${filterLine}`,
			` ${truncateToWidth(this.palette.dim(count), contentWidth, "")}`,
			...shown.map((line) => ` ${line}`),
			` ${truncateToWidth(this.palette.dim(`${t("plugins.hint")}${position}`), contentWidth, "")}`
		];
	}
};
//#endregion
//#region src/components/skills-panel.ts
/**
* `/skills` panel: the skills this session composes, searchable, with one
* skill's full body a keystroke away.
*
* The rows are `ctx.skills.list()` summaries — the same layered read
* `/skill:<name>` completion and invocation perform, so what this panel names
* is exactly what the user can invoke right now, preset switches included. The
* body behind Enter is `ctx.skills.get()`, which is a provider read that can be
* slow or fail; both outcomes are the panel's own states rather than a notice
* the panel would have to be closed to see.
*
* The keyboard is Claude Code's `/skills` menu translated to this codebase's
* filterable-panel shape (see {@link ./plugins-panel.ts | PluginsPanel}):
* typing filters by name or description, ↑/↓ move, Enter opens the detail view,
* and Esc backs out one step at a time — detail to list, filter to empty, panel
* to closed.
* @module @deepseek-ai/dsh-tui/components/skills-panel
*/
/** The panel's heading, so the command and its view name the same thing. */
const SKILLS_PANEL_TITLE = "/skills";
t("skills.unavailable", void 0, "en");
t("skills.loading", void 0, "en");
t("skills.empty", void 0, "en");
t("skills.noMatch", void 0, "en");
t("skills.modelOnly", void 0, "en");
t("skills.detailLoading", void 0, "en");
/** Terminal rows the list state spends on its own chrome: blank, title, filter, count, footer. */
const LIST_CHROME_ROWS = 5;
/** Terminal rows the detail state spends on its own chrome: blank, title, footer. */
const DETAIL_CHROME_ROWS = 3;
/**
* Body lines one detail view renders before it stops.
*
* A skill body is a whole prompt — some run to thousands of lines — and this
* panel is a place to recognize a skill, not to read it end to end. The cut is
* announced with the real total and the skill's path, so the reader knows both
* that there is more and where it lives.
*/
const SKILL_BODY_MAX_LINES = 400;
/**
* The line that admits a cut body, naming what was left out.
* @param total - the body's real line count.
* @param path - the skill's file, when its provider has one.
* @returns the dim notice appended after the last shown body line.
*/
function skillBodyTruncated(total, path) {
	const counts = {
		max: SKILL_BODY_MAX_LINES,
		total
	};
	return path === void 0 ? t("skills.truncated", counts) : t("skills.truncatedPath", {
		...counts,
		path
	});
}
/**
* Whether a summary matches the filter box: a case-insensitive substring over
* the two things a row shows, the skill's name and its routing description.
* @param skill - one skill summary.
* @param normalizedQuery - the query, already trimmed and lower-cased.
* @returns true when the skill stays visible under this query.
*/
function matchesQuery(skill, normalizedQuery) {
	if (normalizedQuery.length === 0) return true;
	return [skill.name, skill.description].some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
}
/**
* Searchable skill catalog in the editor slot, with a per-skill detail view.
*
* Keyboard-owned like {@link ./panel.ts | ScrollablePanel}: every keystroke is
* consumed here and none leaks into the editor underneath. The catalog and the
* detail bodies are both loaded by the caller, which owns the registry, the
* lookup scope, and the abort signal; the panel only asks (`onOpen`) and shows
* what it is handed ({@link setSkills}, {@link setDetail}).
*/
var SkillsPanel = class {
	rows;
	palette;
	onOpen;
	onClose;
	/** Set by the TUI on focus; the filter box owns the visible cursor. */
	focused = false;
	filter = new Input();
	/** The catalog, or `undefined` while the first read is still in flight. */
	skills;
	/** Skill the selection bar sits on; kept by name so filtering re-finds it. */
	selectedName;
	/** Skill the detail view is showing, or `undefined` while the list is up. */
	detailName;
	detail;
	/** First visible list row. */
	offset = 0;
	/** First visible detail row. */
	detailOffset = 0;
	/**
	* @param skills - the catalog when it is already known, `undefined` while it loads.
	* @param rows - the panel's total row budget, read per render so a resize applies.
	* @param palette - active role palette.
	* @param onOpen - asks the caller to load one skill's body; answered by {@link setDetail}.
	* @param onClose - called on Esc (with an empty filter, from the list) or Ctrl+C.
	*/
	constructor(skills, rows, palette, onOpen, onClose) {
		this.rows = rows;
		this.palette = palette;
		this.onOpen = onOpen;
		this.onClose = onClose;
		this.skills = skills;
	}
	invalidate() {
		this.filter.invalidate();
	}
	/**
	* Replace the loading placeholder with the catalog the scan produced.
	* @param skills - the summaries this session's registry served.
	*/
	setSkills(skills) {
		this.skills = skills;
		this.refilter();
		this.invalidate();
	}
	/**
	* Answer one {@link onOpen} request.
	*
	* The name is checked against the open detail: a body that arrives after the
	* reader went back to the list, or moved on to another skill, is dropped
	* rather than painted over whatever they are looking at now.
	* @param name - the skill the caller was asked to load.
	* @param state - the outcome, shown as-is.
	*/
	setDetail(name, state) {
		if (this.detailName !== name) return;
		this.detail = state;
		this.detailOffset = 0;
		this.invalidate();
	}
	/** Skills visible under the current filter, in the order the caller supplied. */
	filtered() {
		const query = this.filter.getValue().trim().toLocaleLowerCase();
		return (this.skills ?? []).filter((skill) => matchesQuery(skill, query));
	}
	/** The selection bar's index within `visible`, falling back to the first row. */
	selectedIndex(visible) {
		const index = visible.findIndex((skill) => skill.name === this.selectedName);
		return index === -1 ? 0 : index;
	}
	viewport() {
		return Math.max(1, this.rows() - LIST_CHROME_ROWS);
	}
	detailViewport() {
		return Math.max(1, this.rows() - DETAIL_CHROME_ROWS);
	}
	move(delta) {
		const visible = this.filtered();
		if (visible.length === 0) return;
		const index = Math.max(0, Math.min(this.selectedIndex(visible) + delta, visible.length - 1));
		this.selectedName = visible[index]?.name;
	}
	/** Ask the caller for the selected skill's body and switch to the detail view. */
	openDetail() {
		const visible = this.filtered();
		const selected = visible[this.selectedIndex(visible)];
		if (selected === void 0) return;
		this.selectedName = selected.name;
		this.detailName = selected.name;
		this.detail = { kind: "loading" };
		this.detailOffset = 0;
		this.onOpen(selected.name);
	}
	/** Leave the detail view; the list keeps its filter and its selection. */
	closeDetail() {
		this.detailName = void 0;
		this.detail = void 0;
	}
	/** Re-derive the selection after the filter box or the catalog changed. */
	refilter() {
		const visible = this.filtered();
		if (!visible.some((skill) => skill.name === this.selectedName)) this.selectedName = visible[0]?.name;
	}
	handleInput(data) {
		if (matchesKey(data, Key.ctrl("c"))) {
			this.onClose();
			return;
		}
		if (this.detailName !== void 0) {
			if (matchesKey(data, Key.escape)) {
				this.closeDetail();
				return;
			}
			if (matchesKey(data, Key.up)) {
				this.scrollDetail(-1);
				return;
			}
			if (matchesKey(data, Key.down)) {
				this.scrollDetail(1);
				return;
			}
			if (matchesKey(data, Key.pageUp)) {
				this.scrollDetail(-this.detailViewport());
				return;
			}
			if (matchesKey(data, Key.pageDown)) {
				this.scrollDetail(this.detailViewport());
				return;
			}
			if (data === "g" || matchesKey(data, Key.home)) {
				this.detailOffset = 0;
				return;
			}
			if (data === "G" || matchesKey(data, Key.end)) {
				this.scrollDetail(Number.MAX_SAFE_INTEGER);
				return;
			}
			return;
		}
		if (matchesKey(data, Key.escape)) {
			if (this.filter.getValue() === "") {
				this.onClose();
				return;
			}
			this.filter.setValue("");
			this.refilter();
			return;
		}
		if (this.skills === void 0 || this.skills.length === 0) return;
		if (matchesKey(data, Key.up)) {
			this.move(-1);
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.move(1);
			return;
		}
		if (matchesKey(data, Key.pageUp)) {
			this.move(-this.viewport());
			return;
		}
		if (matchesKey(data, Key.pageDown)) {
			this.move(this.viewport());
			return;
		}
		if (matchesKey(data, Key.enter)) {
			this.openDetail();
			return;
		}
		const previous = this.filter.getValue();
		this.filter.focused = true;
		this.filter.handleInput(data);
		if (this.filter.getValue() !== previous) this.refilter();
	}
	scrollDetail(delta) {
		this.detailOffset = Math.max(0, this.detailOffset + delta);
	}
	/** Body rows for the list state, plus the display-row index of the selection bar. */
	body(visible, width) {
		if (visible.length === 0) return {
			rows: [this.palette.dim(t("skills.noMatch"))],
			selectedRow: 0
		};
		const nameColumn = Math.min(Math.max(...visible.map((skill) => visibleWidth(skill.name))), Math.max(8, Math.floor(width / 3)));
		const selectedIndex = this.selectedIndex(visible);
		return {
			rows: visible.map((skill, index) => {
				const bar = index === selectedIndex ? this.palette.accent("→ ") : "  ";
				const name = truncateToWidth(displayInlineText(skill.name), nameColumn, "…", true);
				const marker = skill.invocation.userInvocable ? "" : `  ${t("skills.modelOnly")}`;
				const description = displayInlineText(skill.description);
				return truncateToWidth(`${bar}${this.palette.text(name)}  ${this.palette.dim(`${description}${marker}`)}`, width, "");
			}),
			selectedRow: selectedIndex
		};
	}
	/** The one-page states: a message and the way out, with no filter box above them. */
	renderMessage(title, message, width) {
		return [
			"",
			title,
			...wrapTextWithAnsi(this.palette.dim(message), width).map((line) => ` ${line}`),
			` ${this.palette.dim(t("panel.escClose"))}`
		];
	}
	/** Detail rows for one loaded skill: what the list showed, then the body. */
	detailBody(skill, width) {
		const lines = skill.content.split("\n");
		const shown = lines.slice(0, SKILL_BODY_MAX_LINES);
		const provenance = [
			skill.source,
			skill.provider,
			skill.invocation.userInvocable ? t("skills.userInvocable") : t("skills.modelOnly")
		].join(" · ");
		const rows = [
			this.palette.accent(displayInlineText(skill.name)),
			...wrapTextWithAnsi(this.palette.dim(displayInlineText(skill.description)), width),
			this.palette.dim(displayInlineText(provenance)),
			"",
			...shown.flatMap((line) => wrapTextWithAnsi(this.palette.text(displayText(line)), width))
		];
		if (lines.length > shown.length) rows.push("", ...wrapTextWithAnsi(this.palette.dim(skillBodyTruncated(lines.length, skill.path)), width));
		return rows;
	}
	/** The detail state: a loading line, a failure, or the skill itself, scrollable. */
	renderDetail(title, width) {
		const state = this.detail ?? { kind: "loading" };
		const rows = state.kind === "ready" ? this.detailBody(state.skill, width) : wrapTextWithAnsi(state.kind === "loading" ? this.palette.dim(t("skills.detailLoading")) : this.palette.error(displayInlineText(state.message)), width);
		const viewport = this.detailViewport();
		this.detailOffset = Math.max(0, Math.min(this.detailOffset, Math.max(0, rows.length - viewport)));
		const shown = rows.slice(this.detailOffset, this.detailOffset + viewport);
		const position = rows.length > viewport ? `  ·  ${t("panel.position", {
			first: this.detailOffset + 1,
			last: this.detailOffset + shown.length,
			total: rows.length
		})}` : "";
		return [
			"",
			title,
			...shown.map((line) => ` ${line}`),
			` ${truncateToWidth(this.palette.dim(`${t("skills.detailHint")}${position}`), width, "")}`
		];
	}
	render(width) {
		const contentWidth = Math.max(1, width - 2);
		const title = ` ${this.palette.dim(SKILLS_PANEL_TITLE)}`;
		if (this.detailName !== void 0) return this.renderDetail(title, contentWidth);
		if (this.skills === void 0) return this.renderMessage(title, t("skills.loading"), contentWidth);
		if (this.skills.length === 0) return this.renderMessage(title, t("skills.empty"), contentWidth);
		const visible = this.filtered();
		this.filter.focused = true;
		const filterLine = truncateToWidth(`${this.palette.dim(t("skills.filter"))} ${this.filter.render(Math.max(1, contentWidth - 8)).join("")}`, contentWidth, "");
		const invocable = this.skills.filter((skill) => skill.invocation.userInvocable).length;
		const total = this.skills.length;
		const count = plural(total, "skills.count", {
			visible: visible.length,
			total,
			invocable
		});
		const { rows, selectedRow } = this.body(visible, contentWidth);
		const viewport = this.viewport();
		this.offset = Math.max(0, Math.min(this.offset, Math.max(0, rows.length - viewport)));
		if (selectedRow < this.offset) this.offset = selectedRow;
		if (selectedRow >= this.offset + viewport) this.offset = selectedRow - viewport + 1;
		const shown = rows.slice(this.offset, this.offset + viewport);
		const position = rows.length > viewport ? `  ·  ${t("panel.position", {
			first: this.offset + 1,
			last: this.offset + shown.length,
			total: rows.length
		})}` : "";
		return [
			"",
			title,
			` ${filterLine}`,
			` ${truncateToWidth(this.palette.dim(count), contentWidth, "")}`,
			...shown.map((line) => ` ${line}`),
			` ${truncateToWidth(this.palette.dim(`${t("skills.hint")}${position}`), contentWidth, "")}`
		];
	}
};
//#endregion
//#region src/components/settings-panel.ts
/**
* `/config` panel: the handful of presentation choices this terminal owns, one
* row each, changed in place.
*
* Claude Code's Config tab, reduced to what a terminal front door actually
* decides: a switch reads as a switch (`on`/`off`), a choice cycles through its
* values, a submenu row opens the selector that owns its vocabulary, and a row
* this panel cannot change says who can (`/model`, `/lang`). Every value is
* read through a getter rather than copied in at construction, so a Ctrl+O
* press behind the panel — or a theme picked in the submenu it opened — shows
* up on the row that names it.
*
* Keyboard-owned like {@link ./plugins-panel.ts | PluginsPanel}: while it is
* open no keystroke reaches the editor underneath, and the caller closes the
* overlay through `onClose`.
* @module @deepseek-ai/dsh-tui/components/settings-panel
*/
/**
* The panel's heading, so the command and its view name the same thing. Not a
* message: it is the command a user types, which reads the same in every
* locale.
*/
const SETTINGS_PANEL_TITLE = "/config";
/** Terminal rows the panel spends on its own chrome: blank, title, footer. */
const PANEL_CHROME_ROWS = 3;
/** Columns between the widest label and the value column. */
const VALUE_GAP = 2;
/** How a toggle's two states are worded, once, for every row that has them. */
function toggleLabel(value) {
	return t(value ? "settings.on" : "settings.off");
}
/** The value column's text for one entry, without color. */
function entryValueText(entry) {
	if (entry.kind === "toggle") return toggleLabel(entry.value());
	const value = entry.value();
	if (entry.kind === "choice" && entry.format !== void 0) return displayInlineText(entry.format(value));
	return displayInlineText(value);
}
/** Settings list in the editor slot, one row per entry. */
var SettingsPanel = class {
	entries;
	rows;
	palette;
	onClose;
	/** Set by the TUI on focus; the panel draws its own selection bar either way. */
	focused = false;
	selectedIndex = 0;
	/** First visible row, moved only by a selection that would fall outside the viewport. */
	offset = 0;
	/**
	* @param entries - the rows, in display order; at least one.
	* @param rows - the panel's total row budget, read per render so a resize applies.
	* @param palette - active role palette.
	* @param onClose - called on Esc or Ctrl+C.
	*/
	constructor(entries, rows, palette, onClose) {
		this.entries = entries;
		this.rows = rows;
		this.palette = palette;
		this.onClose = onClose;
	}
	invalidate() {}
	viewport() {
		return Math.max(1, this.rows() - PANEL_CHROME_ROWS);
	}
	move(delta) {
		if (this.entries.length === 0) return;
		this.selectedIndex = Math.max(0, Math.min(this.selectedIndex + delta, this.entries.length - 1));
	}
	/** Step one choice entry, wrapping, in the direction the key asked for. */
	step(entry, delta) {
		const { options } = entry;
		if (options.length === 0) return;
		const index = options.indexOf(entry.value());
		const next = index === -1 ? 0 : (index + delta + options.length) % options.length;
		entry.set(options[next]);
	}
	/** Apply the highlighted row's own idea of what Enter means. */
	activate() {
		const entry = this.entries[this.selectedIndex];
		if (entry === void 0) return;
		if (entry.kind === "toggle") entry.set(!entry.value());
		else if (entry.kind === "choice") this.step(entry, 1);
		else if (entry.kind === "submenu") entry.open();
	}
	handleInput(data) {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.onClose();
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.move(-1);
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.move(1);
			return;
		}
		if (matchesKey(data, Key.enter)) {
			this.activate();
			return;
		}
		const entry = this.entries[this.selectedIndex];
		if (entry?.kind === "choice") {
			if (matchesKey(data, Key.left)) {
				this.step(entry, -1);
				return;
			}
			if (matchesKey(data, Key.right)) {
				this.step(entry, 1);
				return;
			}
		}
	}
	/** One row per entry: the selection bar, the label column, then the value. */
	body(width) {
		const labelColumn = Math.max(0, ...this.entries.map((entry) => visibleWidth(displayInlineText(entry.label))));
		return this.entries.map((entry, index) => {
			const bar = index === this.selectedIndex ? this.palette.accent("→ ") : "  ";
			const label = displayInlineText(entry.label);
			const padding = " ".repeat(Math.max(0, labelColumn - visibleWidth(label) + VALUE_GAP));
			const value = entryValueText(entry);
			const painted = entry.kind === "notice" ? this.palette.dim(`${value} ${entry.hint}`) : `${this.palette.accent(value)}${entry.kind === "submenu" ? this.palette.dim(" ›") : ""}`;
			return truncateToWidth(`${bar}${this.palette.text(label)}${padding}${painted}`, width, "");
		});
	}
	render(width) {
		const contentWidth = Math.max(1, width - 2);
		const rows = this.body(contentWidth);
		const viewport = this.viewport();
		this.offset = Math.max(0, Math.min(this.offset, Math.max(0, rows.length - viewport)));
		if (this.selectedIndex < this.offset) this.offset = this.selectedIndex;
		if (this.selectedIndex >= this.offset + viewport) this.offset = this.selectedIndex - viewport + 1;
		const shown = rows.slice(this.offset, this.offset + viewport);
		const position = rows.length > viewport ? `  ·  ${t("panel.position", {
			first: this.offset + 1,
			last: this.offset + shown.length,
			total: rows.length
		})}` : "";
		return [
			"",
			` ${this.palette.dim(SETTINGS_PANEL_TITLE)}`,
			...shown.map((line) => ` ${line}`),
			` ${truncateToWidth(this.palette.dim(`${t("settings.hint")}${position}`), contentWidth, "")}`
		];
	}
};
/**
* Schema of the `tui` settings section.
*
* Declared even though every read here is shape-checked anyway: the provider
* validates a stored section against it, so a hand-edited document says which
* value it got wrong instead of silently resolving to a default, and a
* configuration UI has something to render.
*/
const TUI_PREFERENCES_SCHEMA = z.object({
	thinkingPinned: z.boolean().default(false),
	toolCards: z.union([
		"collapsed",
		"expanded",
		"hidden"
	]).default("collapsed"),
	theme: z.union([
		"auto",
		"light",
		"dark",
		"no-color"
	]).default("auto")
});
/** Shape-check one stored section, field by field, over a fallback. */
function normalize(value, fallback) {
	if (typeof value !== "object" || value === null) return fallback;
	const section = value;
	const toolCards = section.toolCards;
	const theme = section.theme;
	return {
		thinkingPinned: typeof section.thinkingPinned === "boolean" ? section.thinkingPinned : fallback.thinkingPinned,
		toolCards: toolCards === "collapsed" || toolCards === "expanded" || toolCards === "hidden" ? toolCards : fallback.toolCards,
		theme: typeof theme === "string" && isThemePreference(theme) ? theme : fallback.theme
	};
}
/**
* Open this terminal's preference section, or an in-memory stand-in for it.
*
* @param ctx - the runner context, which may or may not carry a `settings` provider.
* @param base - the deployment's own config values, layered under the user's.
* @param reportError - how a failed read or write reaches the screen; called
*   with a finished sentence.
* @returns the store `/config` and `/theme` read and write.
*/
function openTuiPreferences(ctx, base, reportError) {
	const defaults = {
		...TUI_PREFERENCES_SCHEMA(),
		...base
	};
	const provider = ctx.get("settings");
	if (provider === void 0 || typeof provider.register !== "function") {
		let memory = defaults;
		return {
			current: () => memory,
			save: (patch) => {
				memory = {
					...memory,
					...patch
				};
			}
		};
	}
	const resolved = () => {
		try {
			return provider.get("tui");
		} catch {
			/* v8 ignore next -- only an out-of-contract provider reaches here. */
			return;
		}
	};
	try {
		provider.register("tui", TUI_PREFERENCES_SCHEMA, { base });
	} catch (error) {
		if (resolved() === void 0) reportError(t("settings.refused", { error: errorChain(error) }));
	}
	const read = () => normalize(resolved(), defaults);
	return {
		current: read,
		save: (patch) => {
			Promise.resolve().then(async () => {
				await provider.update("tui", patch);
			}).catch((error) => {
				reportError(t("settings.saveFailed", { error: errorChain(error) }));
			});
		}
	};
}
//#endregion
//#region src/components/dialogs.ts
/**
* pi-tui dialog and selector components for the terminal front door: the status
* card, prompt-context line, model selector, agent-preset selector, theme
* selector, resume picker, and user-question dialog, plus the model-choice,
* preset-choice, and resume-candidate data they present.
* @module @deepseek-ai/dsh-tui/components/dialogs
*/
/**
* Format a provider/model target as its `provider/model` label.
* @param target - The LLM target.
* @returns The `provider/model` label.
*/
function targetLabel(target) {
	return `${target.provider}/${target.model}`;
}
/**
* Format a target compactly as its model name with any selected reasoning effort appended.
* @param target - The LLM target.
* @returns The compact `model [effort]` label.
*/
function compactTargetLabel(target) {
	return `${target.model}${target.reasoningEffort === void 0 ? "" : ` ${target.reasoningEffort}`}`;
}
/**
* Resolve the display label for a choice's reasoning effort.
* @param choice - The model choice carrying advertised reasoning metadata.
* @param effort - The selected effort, or `undefined` for provider default.
* @returns The effort's display name, `Default`, or `undefined` when the model has no reasoning metadata.
*/
function targetReasoningLabel(choice, effort) {
	if (effort === void 0) return choice.reasoning === void 0 ? void 0 : "Default";
	return choice.reasoning?.efforts.find((candidate) => candidate.id === effort)?.name ?? effort;
}
/**
* Derive the agent's initial LLM target from its logged request header or options.
* @param agent - The driven agent.
* @returns The initial target, or `undefined` when unset.
*/
function initialTarget(agent) {
	const logged = agent.session.requestHeader()?.config;
	if (logged !== void 0) {
		if (logged.reasoningEffort === void 0) return {
			provider: logged.provider,
			model: logged.model
		};
		return {
			provider: logged.provider,
			model: logged.model,
			reasoningEffort: logged.reasoningEffort
		};
	}
	if (agent.options.provider === void 0 || agent.options.model === void 0) return void 0;
	return {
		provider: agent.options.provider,
		model: agent.options.model
	};
}
/**
* List every advertised model across registered providers, appending the current
* target when a provider does not advertise it.
* @param ctx - Context supplying the LLM service.
* @param current - The current target, appended when unadvertised.
* @returns The model choices, flattened across providers.
*/
async function readModelChoices(ctx, current) {
	const providers = ctx.llm.listProviders();
	return (await Promise.all(providers.map(async (provider) => {
		const models = [...await ctx.llm.listModels(provider.id)];
		if (current?.provider === provider.id && !models.some((model) => model.id === current.model)) models.push({
			provider: provider.id,
			id: current.model,
			name: current.model
		});
		return Promise.all(models.map(async (model) => {
			const reasoning = (await ctx.llm.resolveModelInfo(provider.id, model.id)).reasoning;
			return {
				provider: provider.id,
				model: model.id,
				modelName: model.name,
				...model.description === void 0 ? {} : { description: model.description },
				...reasoning === void 0 ? {} : { reasoning }
			};
		}));
	}))).flat();
}
/**
* Format a diagnostic integer with grouping separators.
* @param value - Integer to format.
* @returns The grouped decimal string.
*/
function formatDiagnosticNumber(value) {
	return value.toLocaleString("en-US");
}
/**
* Format a diagnostic timestamp as an ISO date-time in UTC.
* @param value - Epoch milliseconds.
* @returns The formatted UTC timestamp.
*/
function formatDiagnosticTime(value) {
	return new Date(value).toISOString().replace("T", " ").replace(/\.\d{3}Z$/u, " UTC");
}
/**
* Format a pluralized count for a diagnostic row.
*
* The noun comes from the message table as a `.one`/`.other` pair rather than
* from `singular + 's'`: `/status` translates its labels, and a row reading
* `Agent idle · 42 events · 3 turns` in a Chinese card was half a translation.
* @param value - Count.
* @param key - The plural pair naming what is being counted.
* @returns The formatted count, in the active locale.
*/
function formatDiagnosticCount(value, key) {
	return plural(value, key);
}
/**
* Render a fixed-width filled meter bar for a percentage.
* @param percent - Percentage in [0, 100].
* @param palette - Active role palette.
* @returns The rendered meter.
*/
function diagnosticMeter(percent, palette) {
	const width = 16;
	const filled = Math.round(Math.min(100, Math.max(0, percent)) / 100 * width);
	return `${palette.dim("[")}${palette.accent("█".repeat(filled))}${palette.dim(`${"░".repeat(width - filled)}]`)}`;
}
/** Bordered, grouped field card for one point-in-time status snapshot. */
var StatusCardComponent = class {
	groups;
	palette;
	constructor(groups, palette) {
		this.groups = groups;
		this.palette = palette;
	}
	invalidate() {}
	render(width) {
		const title = t("status.card.title");
		const labels = this.groups.flatMap((group) => group.map(([label]) => `${label}:`));
		const naturalLabelWidth = Math.max(...labels.map((label) => visibleWidth(label)));
		const naturalBodyWidth = Math.max(...this.groups.flatMap((group) => group.map(([, value]) => 1 + naturalLabelWidth + 2 + visibleWidth(value))));
		const cardWidth = Math.min(Math.max(8, width), Math.max(visibleWidth(title) + 5, naturalBodyWidth + 4));
		const innerWidth = Math.max(1, cardWidth - 4);
		const labelWidth = Math.min(naturalLabelWidth, Math.max(1, Math.floor(innerWidth / 3)));
		const body = [];
		for (const [groupIndex, group] of this.groups.entries()) {
			if (groupIndex > 0) body.push("");
			for (const [label, value] of group) {
				const plainLabel = truncateToWidth(`${label}:`, labelWidth, "");
				const padded = plainLabel + " ".repeat(Math.max(0, labelWidth - visibleWidth(plainLabel)));
				const prefix = ` ${this.palette.dim(padded)}  `;
				const continuation = " ".repeat(1 + labelWidth + 2);
				const valueWidth = Math.max(1, innerWidth - visibleWidth(prefix));
				const wrapped = wrapTextWithAnsi(value, valueWidth);
				for (const [lineIndex, line] of wrapped.entries()) body.push(`${lineIndex === 0 ? prefix : continuation}${line}`);
			}
		}
		const clippedTitle = truncateToWidth(title, Math.max(1, cardWidth - 5), "");
		const topTail = "─".repeat(Math.max(0, cardWidth - visibleWidth(clippedTitle) - 5));
		const lines = [`${this.palette.dim("╭─ ")}${this.palette.bold(this.palette.accent(clippedTitle))}${this.palette.dim(` ${topTail}╮`)}`];
		for (const line of body) {
			const clipped = truncateToWidth(line, innerWidth, "");
			lines.push(`${this.palette.dim("│")} ${clipped}${" ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)))} ${this.palette.dim("│")}`);
		}
		lines.push(this.palette.dim(`╰${"─".repeat(Math.max(0, cardWidth - 2))}╯`));
		return lines;
	}
};
/** The left/right template line rendered above the editor. */
var PromptContextComponent = class {
	leftTemplate;
	rightTemplate;
	resolve;
	constructor(leftTemplate, rightTemplate, resolve) {
		this.leftTemplate = leftTemplate;
		this.rightTemplate = rightTemplate;
		this.resolve = resolve;
	}
	invalidate() {}
	render(width) {
		const right = truncateToWidth(renderTuiPromptTemplate(this.rightTemplate, this.resolve), width, "");
		const rightWidth = visibleWidth(right);
		const leftCapacity = Math.max(0, width - rightWidth - (rightWidth === 0 ? 0 : 2));
		const left = truncateToWidth(renderTuiPromptTemplate(this.leftTemplate, this.resolve), leftCapacity, "");
		if (rightWidth === 0) return [left];
		return [`${left}${" ".repeat(Math.max(0, width - visibleWidth(left) - rightWidth))}${right}`];
	}
};
/**
* How the two keys that open a question's custom answer are named, wherever
* they are named.
*
* Both keys are bound — `Tab` and `c` — and neither belongs to the keybinding
* registry, so nothing generated from the registry can spell them: the dialog
* footer, the dialog's own "nothing selected" refusal, the shortcut list
* `/help`, `/hotkeys` and `?` print, and the README's question row are four
* hand-written places that have to agree. Three of them read this constant;
* the README is held to it by the docs suite.
*/
const CUSTOM_ANSWER_KEYS = "Tab/c";
t("dialog.question.customAnswer", { keys: CUSTOM_ANSWER_KEYS }, "en");
/**
* Render a bordered dialog frame around body lines with a titled top edge.
* @param title - Dialog title shown in the top border.
* @param body - Body lines.
* @param width - Dialog width in columns.
* @param palette - Active role palette.
* @returns The framed dialog lines.
*/
function renderDialog(title, body, width, palette) {
	const innerWidth = Math.max(1, width - 4);
	const topLabel = ` ${displayText(title)} `;
	const top = `╭${topLabel}${"─".repeat(Math.max(0, width - visibleWidth(topLabel) - 2))}╮`;
	const lines = [palette.accent(top)];
	for (const line of body) {
		const clipped = truncateToWidth(line, innerWidth, "");
		lines.push(`${palette.accent("│")} ${clipped}${" ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)))} ${palette.accent("│")}`);
	}
	lines.push(palette.accent(`╰${"─".repeat(Math.max(0, width - 2))}╯`));
	return lines;
}
/**
* Widest the route column grows before a row is truncated, leaving the rest of
* a default-width dialog for the description beside it.
*/
const MODEL_ROUTE_COLUMN = 44;
/**
* Keyboard model selector: Claude Code's numbered picker — one row per route,
* its description in a right-hand column, and the focused model's reasoning
* effort on a line of its own under the list — over a filter box this
* deployment needs and Claude Code does not, because a harness advertises every
* model of every registered provider rather than a hand-written shortlist.
*
* The row numbers are ordinals, not shortcuts. Model names are full of digits
* (`deepseek-v4-pro`), so a digit belongs to the filter; binding it to a row
* would make the third character of a search jump the cursor somewhere else.
*
* Which is also why the session-only pick is `Ctrl+S` rather than `s`: every
* printable key is a search character. The two writes are otherwise deliberately
* symmetric — `Enter` saves the pick as the default, `Ctrl+S` spends it on this
* session only, and the footer says both.
*/
var ModelDialog = class {
	maxVisible;
	palette;
	done;
	cancel;
	list;
	filter = new Input();
	items;
	choices;
	efforts;
	currentValue;
	constructor(choices, current, maxVisible, palette, done, cancel) {
		this.maxVisible = maxVisible;
		this.palette = palette;
		this.done = done;
		this.cancel = cancel;
		this.items = /* @__PURE__ */ new Map();
		this.choices = /* @__PURE__ */ new Map();
		this.efforts = /* @__PURE__ */ new Map();
		this.currentValue = current === void 0 ? void 0 : targetLabel(current);
		for (const choice of choices) {
			const value = targetLabel(choice);
			const isCurrent = current?.provider === choice.provider && current.model === choice.model;
			this.choices.set(value, choice);
			this.efforts.set(value, isCurrent ? current.reasoningEffort ?? choice.reasoning?.defaultEffort : choice.reasoning?.defaultEffort);
			this.items.set(value, {
				value,
				label: displayText(value),
				description: this.describeChoice(choice, isCurrent)
			});
		}
		this.list = this.buildList(this.currentValue);
	}
	/** Build a SelectList over the currently filtered items, selecting `selectValue` when present. */
	buildList(selectValue) {
		const items = this.filteredItems();
		const list = new SelectList(items, this.maxVisible, dialogSelectTheme(this.palette), {
			minPrimaryColumnWidth: 24,
			maxPrimaryColumnWidth: MODEL_ROUTE_COLUMN
		});
		const index = selectValue === void 0 ? 0 : items.findIndex((item) => item.value === selectValue);
		list.setSelectedIndex(Math.max(0, index));
		list.onSelect = (item) => {
			this.confirm(item, "default");
		};
		list.onCancel = this.cancel;
		return list;
	}
	/**
	* Items matching the filter box, as a case-insensitive substring over the
	* label, model name, and description, numbered in the order they appear.
	*
	* The numbering is applied here rather than at construction because a filtered
	* list that keeps its original ordinals reads as a broken list: the reader
	* counts rows, not catalog positions.
	*/
	filteredItems() {
		const query = this.filter.getValue().trim().toLocaleLowerCase();
		const matches = query === "" ? [...this.items.values()] : [...this.items.values()].filter((item) => {
			const choice = this.choices.get(item.value);
			/* v8 ignore next -- items and choices share the same keys. */
			if (choice === void 0) return false;
			return [
				item.value,
				choice.modelName,
				choice.description ?? ""
			].some((field) => field.toLocaleLowerCase().includes(query));
		});
		for (const [index, item] of matches.entries()) item.label = `${String(index + 1)}. ${displayText(item.value)}`;
		return matches;
	}
	confirm(item, scope) {
		const selected = this.choices.get(item.value);
		/* v8 ignore next -- SelectList only returns values built from `choices`. */
		if (selected === void 0) return;
		this.done({
			choice: selected,
			reasoningEffort: this.efforts.get(item.value),
			scope
		});
	}
	/**
	* The row's right-hand column: what the route is, in the provider's own
	* words. The reasoning effort is deliberately absent — it belongs to the
	* focused row alone and has its own adjustable line under the list, where it
	* cannot be truncated away by a long description.
	*/
	describeChoice(choice, isCurrent) {
		return [
			...isCurrent ? ["current"] : [],
			displayText(choice.modelName),
			...choice.description === void 0 ? [] : [displayText(choice.description)]
		].join(" — ");
	}
	/** Move the focused model's reasoning effort one step through its advertised ladder. */
	cycleReasoningEffort(step) {
		const selectedItem = this.list.getSelectedItem();
		/* v8 ignore next -- the dialog is opened only for a non-empty catalog. */
		if (selectedItem === null) return;
		const choice = this.choices.get(selectedItem.value);
		if (choice?.reasoning === void 0) return;
		const current = this.efforts.get(selectedItem.value);
		const efforts = [...choice.reasoning.defaultEffort === void 0 ? [void 0] : [], ...choice.reasoning.efforts.map((effort) => effort.id)];
		const next = efforts[(efforts.indexOf(current) + step + efforts.length) % efforts.length];
		this.efforts.set(selectedItem.value, next);
	}
	/**
	* The focused model's reasoning effort, stated as a line the arrow keys act
	* on — Claude Code's effort row — or as the reason there is nothing to adjust.
	*/
	renderEffortRow() {
		const selectedItem = this.list.getSelectedItem();
		/* v8 ignore next -- the dialog is opened only for a non-empty catalog. */
		if (selectedItem === null) return this.palette.dim(`◇ ${t("dialog.model.noFocus")}`);
		const choice = this.choices.get(selectedItem.value);
		if (choice?.reasoning === void 0) return this.palette.dim(`◇ ${choice === void 0 ? t("dialog.model.effortUnsupported") : t("dialog.model.effortUnsupportedFor", { model: displayText(choice.modelName) })}`);
		const effort = this.efforts.get(selectedItem.value);
		const name = effort === void 0 ? t("dialog.model.providerDefault") : displayText(targetReasoningLabel(choice, effort) ?? effort);
		const isDefault = choice.reasoning.defaultEffort !== void 0 && effort === choice.reasoning.defaultEffort;
		return `${this.palette.accent("◆")} ${t("dialog.model.effortRow", { effort: name })}${isDefault ? ` ${t("dialog.model.effortDefault")}` : ""}  ${this.palette.dim(t("dialog.model.adjust"))}`;
	}
	invalidate() {
		this.filter.invalidate();
		this.list.invalidate();
	}
	handleInput(data) {
		if (matchesKey(data, Key.ctrl("c"))) {
			this.cancel();
			return;
		}
		if (matchesKey(data, Key.left)) this.cycleReasoningEffort(-1);
		else if (matchesKey(data, Key.right) || matchesKey(data, Key.shift(Key.tab))) this.cycleReasoningEffort(1);
		else if (matchesKey(data, Key.ctrl("s"))) {
			const selectedItem = this.list.getSelectedItem();
			if (selectedItem !== null) this.confirm(selectedItem, "session");
		} else if (matchesKey(data, Key.escape)) {
			if (this.filter.getValue() === "") this.cancel();
			else {
				this.filter.setValue("");
				this.list = this.buildList(void 0);
			}
		} else if (matchesKey(data, Key.up) || matchesKey(data, Key.down) || matchesKey(data, Key.enter)) this.list.handleInput(data);
		else {
			const previous = this.filter.getValue();
			this.filter.focused = true;
			this.filter.handleInput(data);
			if (this.filter.getValue() !== previous) {
				const selected = this.list.getSelectedItem();
				this.list = this.buildList(selected?.value);
			}
		}
		this.invalidate();
	}
	render(width) {
		const innerWidth = Math.max(1, width - 4);
		this.filter.focused = true;
		const results = this.filteredItems();
		const filterContent = truncateToWidth(this.filter.render(innerWidth).join(""), innerWidth, "");
		return renderDialog(t("dialog.model.title"), [
			filterContent,
			"",
			...results.length === 0 ? [this.palette.dim(`  ${t("dialog.model.noMatch")}`)] : this.list.render(innerWidth),
			"",
			...results.length === 0 ? [] : [this.renderEffortRow(), ""],
			this.palette.dim(t("dialog.model.hintMove")),
			this.palette.dim(t("dialog.model.hintCommit"))
		], width, this.palette);
	}
};
/**
* Keyboard agent-preset selector: the `ModelDialog` frame and filter box over
* the deployment's preset roster.
*
* Broken presets stay on the list rather than being filtered out — a directory
* that occupies an id with nothing usable in it is exactly what the reader
* needs to see — and each states its own reason in the description column the
* list already dims. Enter still yields them; the caller owns the refusal,
* because it owns the sentence explaining what would have happened.
*/
var PresetDialog = class {
	current;
	defaultId;
	maxVisible;
	palette;
	done;
	cancel;
	list;
	filter = new Input();
	items;
	choices;
	constructor(choices, current, defaultId, maxVisible, palette, done, cancel) {
		this.current = current;
		this.defaultId = defaultId;
		this.maxVisible = maxVisible;
		this.palette = palette;
		this.done = done;
		this.cancel = cancel;
		this.items = /* @__PURE__ */ new Map();
		this.choices = /* @__PURE__ */ new Map();
		for (const choice of choices) {
			this.choices.set(choice.id, choice);
			this.items.set(choice.id, {
				value: choice.id,
				label: displayText(choice.id),
				description: this.describeChoice(choice)
			});
		}
		this.list = this.buildList(current);
	}
	/** Build a SelectList over the currently filtered items, selecting `selectValue` when present. */
	buildList(selectValue) {
		const items = this.filteredItems();
		const list = new SelectList(items, this.maxVisible, dialogSelectTheme(this.palette));
		const index = selectValue === void 0 ? 0 : items.findIndex((item) => item.value === selectValue);
		list.setSelectedIndex(Math.max(0, index));
		list.onSelect = (item) => {
			this.confirm(item);
		};
		list.onCancel = this.cancel;
		return list;
	}
	/** Items matching the filter box, as a case-insensitive substring over the id, name, and description. */
	filteredItems() {
		const query = this.filter.getValue().trim().toLocaleLowerCase();
		if (query === "") return [...this.items.values()];
		return [...this.items.values()].filter((item) => {
			const choice = this.choices.get(item.value);
			/* v8 ignore next -- items and choices share the same keys. */
			if (choice === void 0) return false;
			return [
				choice.id,
				choice.name ?? "",
				choice.description ?? ""
			].some((field) => field.toLocaleLowerCase().includes(query));
		});
	}
	confirm(item) {
		const selected = this.choices.get(item.value);
		/* v8 ignore next -- SelectList only returns values built from `choices`. */
		if (selected === void 0) return;
		this.done(selected);
	}
	/**
	* The row's description column: why the preset is unusable if it is, then how
	* this deployment relates to it, then what it says about itself.
	*
	* Badges lead and prose follows because the column is truncated from the
	* right. `current` and `default` are the two facts a reader is scanning the
	* list FOR — which composition is running and which one a new session would
	* get — and a sentence long enough to push either off the edge would hide
	* exactly the answer the picker was opened to give.
	*/
	describeChoice(choice) {
		const badges = [
			...choice.id === this.current ? ["current"] : [],
			...choice.id === this.defaultId ? ["default"] : [],
			...choice.trust === "system" ? ["built-in"] : ["local"]
		].join(" · ");
		return [
			...choice.broken === void 0 ? [] : [`unavailable: ${displayText(choice.broken)}`],
			badges,
			...choice.name === void 0 ? [] : [displayText(choice.name)],
			...choice.description === void 0 ? [] : [displayText(choice.description)]
		].join(" — ");
	}
	invalidate() {
		this.filter.invalidate();
		this.list.invalidate();
	}
	handleInput(data) {
		if (matchesKey(data, Key.ctrl("c"))) {
			this.cancel();
			return;
		}
		if (matchesKey(data, Key.escape)) {
			if (this.filter.getValue() === "") this.cancel();
			else {
				this.filter.setValue("");
				this.list = this.buildList(void 0);
			}
		} else if (matchesKey(data, Key.up) || matchesKey(data, Key.down) || matchesKey(data, Key.enter)) this.list.handleInput(data);
		else {
			const previous = this.filter.getValue();
			this.filter.focused = true;
			this.filter.handleInput(data);
			if (this.filter.getValue() !== previous) {
				const selected = this.list.getSelectedItem();
				this.list = this.buildList(selected?.value);
			}
		}
		this.invalidate();
	}
	render(width) {
		const innerWidth = Math.max(1, width - 4);
		this.filter.focused = true;
		const results = this.filteredItems();
		const filterContent = truncateToWidth(this.filter.render(innerWidth).join(""), innerWidth, "");
		return renderDialog(t("dialog.preset.title"), [
			filterContent,
			"",
			...results.length === 0 ? [this.palette.dim(`  ${t("dialog.preset.noMatch")}`)] : this.list.render(innerWidth),
			"",
			this.palette.dim(t("dialog.preset.hint"))
		], width, this.palette);
	}
};
/**
* Keyboard theme selector, shared by `/theme` and the `/config` panel's Theme
* row: one row per {@link ThemePreferenceId}, applied while the highlight moves
* so the screen behind the dialog is the preview, and committed on Enter.
*
* Esc puts the theme the dialog opened on back, because a preview the user
* scrolled past is not a choice they made — the same relation `/model`'s picker
* has to the route it opened on.
*/
var ThemeDialog = class {
	current;
	palette;
	apply;
	commit;
	close;
	list;
	preview;
	/**
	* @param current - the theme in force when the dialog opened, restored on Esc.
	* @param palette - active role palette.
	* @param apply - paints one theme; called on every highlight move.
	* @param commit - persists the chosen theme; called once, on Enter.
	* @param close - closes the overlay.
	*/
	constructor(current, palette, apply, commit, close) {
		this.current = current;
		this.palette = palette;
		this.apply = apply;
		this.commit = commit;
		this.close = close;
		this.preview = current;
		const items = THEME_PREFERENCES.map((id) => ({
			value: id,
			label: id,
			description: themePreferenceDescription(id)
		}));
		this.list = new SelectList(items, THEME_PREFERENCES.length, dialogSelectTheme(palette));
		this.list.setSelectedIndex(Math.max(0, THEME_PREFERENCES.indexOf(current)));
		this.list.onSelectionChange = (item) => {
			/* v8 ignore next -- the list is built from THEME_PREFERENCES, so every value is one. */
			if (!isThemePreference(item.value)) return;
			this.preview = item.value;
			this.apply(item.value);
		};
		this.list.onSelect = (item) => {
			/* v8 ignore next -- as above. */
			if (!isThemePreference(item.value)) return;
			this.commit(item.value);
			this.close();
		};
	}
	invalidate() {
		this.list.invalidate();
	}
	handleInput(data) {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			if (this.preview !== this.current) this.apply(this.current);
			this.close();
			return;
		}
		this.list.handleInput(data);
		this.invalidate();
	}
	render(width) {
		const innerWidth = Math.max(1, width - 4);
		return renderDialog(t("dialog.theme.title"), [
			...this.list.render(innerWidth),
			"",
			this.palette.dim(t("dialog.theme.hint"))
		], width, this.palette);
	}
};
/** A minute, an hour, a day, and the week past which a row shows a date instead of an age. */
const MINUTE_MS = 6e4;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const AGE_DATE_THRESHOLD_MS = 7 * DAY_MS;
/**
* A row's age in the coarsest unit that still says something: "just now" under
* a minute, then minutes, hours, and days, and a plain `YYYY-MM-DD` once a
* week has passed.
*
* An exact timestamp is the wrong unit for this list. Browsing asks "which of
* these is the one I was in", and an ISO string answers that only after the
* reader does the subtraction themselves. Past a week the arithmetic stops
* being useful in the other direction — "23 days ago" is not a date anyone
* navigates by — so the calendar day takes over.
*
* A timestamp in the future (a clock that moved backwards, a file touched by
* another machine) reads as "just now" rather than as a negative age.
* @param timestamp - the row's activity time, in epoch milliseconds.
* @param now - the current time, injectable so the wording can be tested.
* @returns the localized age, or the local calendar date past the threshold.
*/
function formatResumeAge(timestamp, now = Date.now()) {
	const elapsed = now - timestamp;
	if (elapsed < MINUTE_MS) return t("dialog.resume.ageJustNow");
	if (elapsed < HOUR_MS) return plural(Math.floor(elapsed / MINUTE_MS), "dialog.resume.ageMinutes");
	if (elapsed < DAY_MS) return plural(Math.floor(elapsed / HOUR_MS), "dialog.resume.ageHours");
	if (elapsed < AGE_DATE_THRESHOLD_MS) return plural(Math.floor(elapsed / DAY_MS), "dialog.resume.ageDays");
	const date = new Date(timestamp);
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${String(date.getFullYear())}-${month}-${day}`;
}
/**
* A session artifact's size at one decimal place, in the largest unit that
* leaves a number below 1024, with a trailing `.0` dropped.
*
* Not localized: the units are the same three letters in every locale this
* terminal ships, and a translated `KB` would only make two identical lists
* look different.
* @param bytes - the artifact's size.
* @returns the size as a short display string, e.g. `354.1KB`.
*/
function formatResumeSize(bytes) {
	const kb = bytes / 1024;
	if (kb < 1) return `${String(Math.max(0, Math.round(bytes)))}B`;
	const scaled = (value) => value.toFixed(1).replace(/\.0$/u, "");
	if (kb < 1024) return `${scaled(kb)}KB`;
	const mb = kb / 1024;
	if (mb < 1024) return `${scaled(mb)}MB`;
	return `${scaled(mb / 1024)}GB`;
}
/**
* Build one resume selector row from a record, its batch-folded title, and a
* metadata-derived activity time, deriving the workspace scope and any reason
* the session cannot be resumed here. A workspace other than the current one
* is a scope, not a disabled reason: resuming it hands the process off into
* that directory. Rows carry no per-log detail beyond the title — route and
* replay validity are checked by the Enter-time preflight against the one
* chosen log.
*
* The session being browsed from is not summarized here at all — the scan
* leaves it out of the list — so there is no "current session" reason: a row
* that cannot be resumed carries a real failure (a live twin, a missing
* workspace), and the picker paints those, and only those, as warnings.
* @param record - The session record.
* @param title - The session's batch-folded title, absent for an untitled log.
* @param metadata - What the metadata scan observed: activity time and artifact size, each optional.
* @param cwd - The CURRENT session's workspace, which decides the picker scope this row falls in.
* @param formatWorkspace - Renders THIS record's own cwd as its prompt-style label.
* @returns The summarized resume candidate.
*/
function summarizeResumeCandidate(record, title, metadata, cwd, formatWorkspace) {
	let disabledReason;
	if (record.live) disabledReason = "session is already live in this runtime";
	else if (record.header.cwd === void 0) disabledReason = "session has no recorded workspace";
	return {
		record,
		title: title ?? "Untitled session",
		lastActivityAt: metadata.lastActivityAt ?? record.header.createdAt,
		...metadata.sizeBytes === void 0 ? {} : { sizeBytes: metadata.sizeBytes },
		currentWorkspace: record.header.cwd === cwd,
		workspaceLabel: formatWorkspace(record.header.cwd),
		...disabledReason === void 0 ? {} : { disabledReason }
	};
}
/**
* Full-viewport keyboard selector over detached, preflighted resume summaries.
*
* Two scopes over one candidate set: `workspace` (the default) lists only the
* current session's workspace, `all` lists every workspace and labels each row
* with its own. Tab toggles between them; the search query and selection reset
* on a scope change so the highlighted row always belongs to the visible list.
*
* The picker opens before the session scan settles: an `undefined` candidate
* set renders a loading placeholder that keeps input away from the editor,
* and `setCandidates` swaps the scanned rows in without replacing the overlay.
*/
var ResumePicker = class {
	maxVisible;
	workspaceLabel;
	viewportRows;
	palette;
	done;
	cancel;
	search = new Input();
	pasteBuffer;
	selectedIndex = 0;
	error = "";
	scope = "workspace";
	candidates;
	focused = false;
	constructor(candidates, maxVisible, workspaceLabel, viewportRows, palette, done, cancel) {
		this.maxVisible = maxVisible;
		this.workspaceLabel = workspaceLabel;
		this.viewportRows = viewportRows;
		this.palette = palette;
		this.done = done;
		this.cancel = cancel;
		this.candidates = candidates;
	}
	invalidate() {
		this.search.invalidate();
	}
	/**
	* Narrow the picker to a query the user already typed.
	*
	* `/resume <session>` is the same selection as `/resume` plus a search term,
	* so it opens the same picker with the term already in its search box rather
	* than resuming behind the user's back: the row still has to be looked at
	* and confirmed, and Escape still clears the query instead of the overlay.
	* @param query - the argument text, verbatim.
	*/
	setQuery(query) {
		this.search.setValue(query);
		this.selectedIndex = 0;
		this.invalidate();
	}
	/**
	* Replace the loading placeholder with the scanned candidate set.
	* @param candidates - the summarized rows the finished scan produced.
	*/
	setCandidates(candidates) {
		this.candidates = candidates;
		this.selectedIndex = 0;
		this.error = "";
		this.invalidate();
	}
	/** Candidates in the active scope, before the search query narrows them. */
	scoped() {
		const candidates = this.candidates ?? [];
		return this.scope === "all" ? [...candidates] : candidates.filter((candidate) => candidate.currentWorkspace);
	}
	filtered() {
		const query = this.search.getValue().trim().toLocaleLowerCase();
		const scoped = this.scoped();
		if (query === "") return scoped;
		return scoped.filter((candidate) => candidate.title.toLocaleLowerCase().includes(query) || candidate.record.header.id.toLocaleLowerCase().includes(query) || this.scope === "all" && candidate.workspaceLabel.toLocaleLowerCase().includes(query));
	}
	visibleCandidateCount() {
		const rowHeight = this.scope === "all" ? 5 : 4;
		const candidateBudget = Math.max(1, Math.floor((Math.max(1, this.viewportRows()) - 13) / rowHeight));
		return Math.min(this.maxVisible, candidateBudget);
	}
	handleBracketedPaste(data) {
		const start = data.indexOf(BRACKETED_PASTE_START);
		if (this.pasteBuffer === void 0 && start < 0) return false;
		if (this.pasteBuffer === void 0) {
			const prefix = data.slice(0, start);
			if (prefix !== "") this.handleInput(prefix);
			this.pasteBuffer = data.slice(start + 6);
		} else this.pasteBuffer += data;
		const end = this.pasteBuffer.indexOf(BRACKETED_PASTE_END);
		if (end < 0) return true;
		const pasted = sanitizePastedText(this.pasteBuffer.slice(0, end));
		const remaining = this.pasteBuffer.slice(end + 6);
		this.pasteBuffer = void 0;
		const previous = this.search.getValue();
		this.search.handleInput(`${BRACKETED_PASTE_START}${pasted}${BRACKETED_PASTE_END}`);
		if (this.search.getValue() !== previous) {
			this.selectedIndex = 0;
			this.error = "";
		}
		if (remaining !== "") this.handleInput(remaining);
		this.invalidate();
		return true;
	}
	handleInput(data) {
		if (this.handleBracketedPaste(data)) return;
		const filtered = this.filtered();
		if (matchesKey(data, Key.ctrl("c"))) {
			this.cancel();
			return;
		}
		if (matchesKey(data, Key.escape)) {
			if (this.search.getValue() === "") this.cancel();
			else {
				this.search.setValue("");
				this.selectedIndex = 0;
				this.error = "";
			}
		} else if (matchesKey(data, Key.up)) this.selectedIndex = filtered.length === 0 ? 0 : (this.selectedIndex + filtered.length - 1) % filtered.length;
		else if (matchesKey(data, Key.down)) this.selectedIndex = filtered.length === 0 ? 0 : (this.selectedIndex + 1) % filtered.length;
		else if (matchesKey(data, Key.pageUp)) this.selectedIndex = Math.max(0, this.selectedIndex - this.visibleCandidateCount());
		else if (matchesKey(data, Key.pageDown)) this.selectedIndex = Math.min(Math.max(0, filtered.length - 1), this.selectedIndex + this.visibleCandidateCount());
		else if (matchesKey(data, Key.tab)) {
			this.scope = this.scope === "workspace" ? "all" : "workspace";
			this.search.setValue("");
			this.selectedIndex = 0;
			this.error = "";
		} else if (matchesKey(data, Key.enter)) {
			const selected = filtered[this.selectedIndex];
			if (this.candidates === void 0) this.error = t("dialog.resume.stillLoading");
			else if (selected === void 0) this.error = t("dialog.resume.noSessionMatch");
			else if (selected.disabledReason !== void 0) this.error = selected.disabledReason;
			else this.done(selected);
		} else {
			const previous = this.search.getValue();
			this.search.focused = this.focused;
			this.search.handleInput(data);
			if (this.search.getValue() !== previous) {
				this.selectedIndex = 0;
				this.error = "";
			}
		}
		this.invalidate();
	}
	/**
	* The scope line under the search box: the active scope with the current
	* workspace it means, and the inactive scope with the count Tab would reveal.
	*/
	renderScopeLine() {
		const candidates = this.candidates ?? [];
		const inWorkspace = candidates.filter((candidate) => candidate.currentWorkspace).length;
		const active = this.scope === "workspace" ? t("dialog.resume.scopeWorkspace", { label: displayText(this.workspaceLabel) }) : t("dialog.resume.scopeAll", { count: candidates.length });
		const other = this.scope === "workspace" ? t("dialog.resume.scopeAll", { count: candidates.length }) : t("dialog.resume.scopeWorkspaceCount", { count: inWorkspace });
		return `${this.palette.accent(active)}${this.palette.dim(`  ⇥ ${other}`)}`;
	}
	render(width) {
		this.search.focused = this.focused;
		const height = Math.max(1, this.viewportRows());
		const horizontalPadding = width >= 12 ? 2 : 0;
		const contentWidth = Math.max(1, width - horizontalPadding * 2);
		const indent = " ".repeat(horizontalPadding);
		const filtered = this.filtered();
		if (this.selectedIndex >= filtered.length) this.selectedIndex = Math.max(0, filtered.length - 1);
		const position = filtered[this.selectedIndex] === void 0 ? 0 : this.selectedIndex + 1;
		const title = this.candidates === void 0 ? t("dialog.resume.title") : t("dialog.resume.titleCounted", {
			position,
			total: filtered.length
		});
		const lines = [
			"",
			`${indent}${this.palette.bold(this.palette.accent(title))}`,
			""
		];
		const searchInnerWidth = Math.max(1, contentWidth - 4);
		lines.push(`${indent}${this.palette.dim(`╭${"─".repeat(Math.max(0, contentWidth - 2))}╮`)}`);
		const rendered = this.search.render(searchInnerWidth).join("").replace(/^> /u, "⌕ ");
		const searchContent = this.search.getValue() === "" ? `${rendered.trimEnd()}${this.palette.dim(t("dialog.resume.searchPlaceholder"))}` : rendered;
		const clippedSearch = truncateToWidth(searchContent, searchInnerWidth, "");
		lines.push(`${indent}${this.palette.dim("│")} ${clippedSearch}${" ".repeat(Math.max(0, searchInnerWidth - visibleWidth(clippedSearch)))} ${this.palette.dim("│")}`, `${indent}${this.palette.dim(`╰${"─".repeat(Math.max(0, contentWidth - 2))}╯`)}`, "", `${indent}${this.renderScopeLine()}`, "");
		const visibleCount = this.visibleCandidateCount();
		const start = Math.max(0, Math.min(this.selectedIndex - Math.floor(visibleCount / 2), filtered.length - visibleCount));
		const end = Math.min(filtered.length, start + visibleCount);
		const push = (line) => {
			lines.push(`${indent}${truncateToWidth(line, contentWidth, "…")}`);
		};
		for (let index = start; index < end; index += 1) {
			const candidate = filtered[index];
			const active = index === this.selectedIndex;
			if (index > start) lines.push("");
			const lead = `${active ? "❯" : " "} ${displayText(candidate.title)}`;
			push(active ? this.palette.bold(this.palette.accent(lead)) : lead);
			const meta = [formatResumeAge(candidate.lastActivityAt), ...candidate.sizeBytes === void 0 ? [] : [formatResumeSize(candidate.sizeBytes)]].join(" · ");
			push(this.palette.dim(`  ${meta}`));
			if (this.scope === "all") push(this.palette.dim(`  ${t("dialog.resume.workspaceRow", { label: displayText(candidate.workspaceLabel) })}`));
			if (candidate.disabledReason !== void 0) push(this.palette.warning(`  ${t("dialog.resume.unavailable", { reason: displayText(candidate.disabledReason) })}`));
		}
		if (this.candidates === void 0) push(this.palette.dim(t("dialog.resume.loading")));
		else if (filtered.length === 0) push(this.palette.warning(t(this.search.getValue() === "" ? "dialog.resume.noOthers" : "dialog.resume.noMatch")));
		if (this.error !== "") {
			lines.push("");
			push(this.palette.error(displayText(this.error)));
		}
		const footer = `${indent}${this.palette.dim(t("dialog.resume.hint"))}`;
		while (lines.length < height - 2) lines.push("");
		lines.push(footer, "");
		return lines.slice(0, height);
	}
};
/** Inline dialog for one user question with option or custom-answer modes. */
var QuestionDialog = class {
	question;
	position;
	total;
	unanswered;
	maxVisible;
	maxHeight;
	palette;
	done;
	cancel;
	selectedIndex = 0;
	selected = /* @__PURE__ */ new Set();
	headerPage = {
		offset: 0,
		size: 1,
		maxOffset: 0
	};
	selectedBlockPage = {
		offset: 0,
		size: 1,
		maxOffset: 0
	};
	mode;
	error = "";
	input = new Input();
	options;
	focused = false;
	constructor(question, position, total, unanswered, maxVisible, maxHeight, palette, done, cancel) {
		this.question = question;
		this.position = position;
		this.total = total;
		this.unanswered = unanswered;
		this.maxVisible = maxVisible;
		this.maxHeight = maxHeight;
		this.palette = palette;
		this.done = done;
		this.cancel = cancel;
		this.options = question.options ?? [];
		this.mode = this.options.length > 0 ? "options" : "custom";
		this.input.onSubmit = (value) => {
			this.submitCustom(value);
		};
		this.input.onEscape = () => {
			if (this.options.length > 0) {
				this.mode = "options";
				this.error = "";
			} else this.cancel();
		};
	}
	invalidate() {
		this.input.invalidate();
	}
	handleInput(data) {
		this.invalidate();
		if (matchesKey(data, Key.pageUp)) {
			this.pageBackward();
			return;
		}
		if (matchesKey(data, Key.pageDown)) {
			this.pageForward();
			return;
		}
		if (matchesKey(data, Key.ctrl("c"))) {
			this.cancel();
			return;
		}
		if (this.mode === "custom") {
			this.input.focused = this.focused;
			this.input.handleInput(data);
			return;
		}
		const options = this.options;
		if (matchesKey(data, Key.up)) {
			this.selectedBlockPage = {
				offset: 0,
				size: 1,
				maxOffset: 0
			};
			this.selectedIndex = this.selectedIndex === 0 ? options.length - 1 : this.selectedIndex - 1;
		} else if (matchesKey(data, Key.down)) {
			this.selectedBlockPage = {
				offset: 0,
				size: 1,
				maxOffset: 0
			};
			this.selectedIndex = this.selectedIndex === options.length - 1 ? 0 : this.selectedIndex + 1;
		} else if (matchesKey(data, Key.space) && this.question.multiSelect) {
			if (this.selected.has(this.selectedIndex)) this.selected.delete(this.selectedIndex);
			else this.selected.add(this.selectedIndex);
		} else if (matchesKey(data, Key.enter)) {
			const selected = this.question.multiSelect ? this.selectedOptionLabels() : [options[this.selectedIndex]?.label].filter((label) => label !== void 0);
			const custom = this.question.multiSelect ? this.input.getValue().trim() : "";
			if (selected.length === 0 && custom === "") {
				this.error = t("dialog.question.selectOne", { keys: CUSTOM_ANSWER_KEYS });
				return;
			}
			this.done({
				selected,
				...custom === "" ? {} : { custom }
			});
		} else if (matchesKey(data, Key.tab) || data.toLowerCase() === "c") {
			this.mode = "custom";
			this.selectedBlockPage = {
				offset: 0,
				size: 1,
				maxOffset: 0
			};
			this.error = "";
		} else if (matchesKey(data, Key.escape)) this.cancel();
	}
	submitCustom(value) {
		const custom = value.trim();
		if (custom === "") {
			this.error = t("dialog.question.emptyAnswer");
			return;
		}
		this.done({
			selected: this.question.multiSelect ? this.selectedOptionLabels() : [],
			custom
		});
	}
	selectedOptionLabels() {
		return [...this.selected].sort((a, b) => a - b).map((index) => this.options[index]?.label).filter((label) => label !== void 0);
	}
	/** Page backward through an oversized option, then through question detail. */
	pageBackward() {
		if (this.mode === "options" && this.selectedBlockPage.offset > 0) {
			this.selectedBlockPage = {
				...this.selectedBlockPage,
				offset: Math.max(0, this.selectedBlockPage.offset - this.selectedBlockPage.size)
			};
			return;
		}
		this.headerPage = {
			...this.headerPage,
			offset: Math.max(0, this.headerPage.offset - this.headerPage.size)
		};
	}
	/** Page forward through question detail, then through an oversized option. */
	pageForward() {
		if (this.headerPage.offset < this.headerPage.maxOffset) {
			this.headerPage = {
				...this.headerPage,
				offset: Math.min(this.headerPage.maxOffset, this.headerPage.offset + this.headerPage.size)
			};
			return;
		}
		if (this.mode === "custom") return;
		this.selectedBlockPage = {
			...this.selectedBlockPage,
			offset: Math.min(this.selectedBlockPage.maxOffset, this.selectedBlockPage.offset + this.selectedBlockPage.size)
		};
	}
	render(width) {
		this.input.focused = this.focused;
		const horizontalPadding = Math.min(2, Math.max(0, Math.floor((width - 1) / 2)));
		const innerWidth = Math.max(1, width - horizontalPadding * 2);
		const header = `${t("dialog.question.header", {
			position: this.position,
			total: this.total,
			unanswered: this.unanswered
		})}${this.question.header === void 0 ? "" : ` · ${displayText(this.question.header)}`}`;
		const questionLines = wrapTextWithAnsi(this.palette.text(displayText(this.question.question)), innerWidth);
		const contentLines = [...questionLines];
		const headerLines = [...wrapTextWithAnsi(this.palette.dim(header), innerWidth), ...questionLines];
		if (this.question.detail !== void 0) {
			headerLines.push("");
			contentLines.push("");
			for (const line of wrapTextWithAnsi(displayText(this.question.detail), innerWidth)) {
				headerLines.push(line);
				contentLines.push(line);
			}
		}
		headerLines.push("");
		const customControls = [
			...this.options.length > 0 && this.question.multiSelect ? [t("dialog.question.selectedCount", { count: this.selected.size })] : [],
			t("dialog.question.submit"),
			t(this.options.length > 0 ? "dialog.question.escOptions" : "dialog.question.escCancel")
		];
		const customHint = this.palette.dim(customControls.join(" • "));
		const footerLines = [];
		if (this.mode === "custom") {
			for (const line of this.input.render(innerWidth)) footerLines.push(line);
			for (const line of wrapTextWithAnsi(customHint, innerWidth)) footerLines.push(line);
		} else {
			const controls = [
				t("dialog.question.customAnswer", { keys: CUSTOM_ANSWER_KEYS }),
				...this.options.length > 1 ? [t("dialog.question.navigate")] : [],
				...this.question.multiSelect ? [t("dialog.question.spaceToggle")] : [],
				t("dialog.question.submit"),
				t("dialog.question.escInterrupt")
			];
			const hint = this.palette.dim(controls.join(" • "));
			for (const line of wrapTextWithAnsi(hint, innerWidth)) footerLines.push(line);
		}
		if (this.error) for (const line of wrapTextWithAnsi(this.palette.error(this.error), innerWidth)) footerLines.push(line);
		const positionLines = this.mode === "options" && this.options.length > this.maxVisible ? [this.palette.dim(`${this.selectedIndex + 1}/${this.options.length}`)] : [];
		const paddingRows = 2;
		const maxHeight = this.maxHeight();
		const availableForOptions = Math.max(this.mode === "options" ? 4 : 1, maxHeight - paddingRows - headerLines.length - positionLines.length - footerLines.length);
		const body = [...headerLines];
		const optionLines = [];
		if (this.mode === "custom") for (const line of footerLines) body.push(line);
		else {
			const optionBlocks = this.options.map((option, index) => this.renderOptionBlock(option, index, innerWidth));
			const { visibleBlocks, hiddenBefore, hiddenAfter } = this.windowBlocks(optionBlocks, availableForOptions, innerWidth);
			if (hiddenBefore > 0) optionLines.push(this.palette.dim(t("dialog.question.moreAbove", { count: hiddenBefore })));
			for (const block of visibleBlocks) for (const line of block) optionLines.push(line);
			if (hiddenAfter > 0) optionLines.push(this.palette.dim(t("dialog.question.moreBelow", { count: hiddenAfter })));
			for (const line of optionLines) body.push(line);
			for (const line of positionLines) body.push(line);
			for (const line of footerLines) body.push(line);
		}
		const rows = [
			"",
			...body,
			""
		];
		let visibleRows = rows;
		if (rows.length <= maxHeight) this.headerPage = {
			offset: 0,
			size: 1,
			maxOffset: 0
		};
		if (rows.length > maxHeight && this.mode === "options" && maxHeight >= 6) {
			const headerBudget = Math.max(0, maxHeight - optionLines.length - (this.error === "" ? 1 : 2));
			const compactFooter = [...this.error === "" ? [] : [truncateToWidth(this.palette.error(t("dialog.question.error", { message: this.error })), innerWidth, "…")], this.compactOptionControls(innerWidth, headerBudget === 1 && contentLines.length > headerBudget)];
			visibleRows = [
				...this.compactQuestionHeader(contentLines, headerBudget, innerWidth),
				...optionLines,
				...compactFooter
			];
		} else if (rows.length > maxHeight && this.mode === "custom" && maxHeight >= 2) {
			const compactFooterSource = [
				...this.input.render(innerWidth),
				this.compactCustomControls(innerWidth),
				...this.error === "" ? [] : [truncateToWidth(this.palette.error(this.error), innerWidth, "…")]
			];
			const footerBudget = Math.max(1, maxHeight - 1);
			const compactFooter = compactFooterSource.length <= footerBudget ? compactFooterSource : footerBudget === 1 ? compactFooterSource.slice(0, 1) : [...compactFooterSource.slice(0, 1), ...compactFooterSource.slice(-(footerBudget - 1))];
			visibleRows = [...this.compactQuestionHeader(contentLines, Math.max(0, maxHeight - compactFooter.length), innerWidth), ...compactFooter];
		}
		if (visibleRows.length > maxHeight) visibleRows = maxHeight === 1 ? [this.palette.dim(t("dialog.question.linesHidden", { count: visibleRows.length }))] : [this.palette.dim(t("dialog.question.linesHidden", { count: visibleRows.length - maxHeight + 1 })), ...visibleRows.slice(-(maxHeight - 1))];
		return visibleRows.map((line) => {
			const bounded = truncateToWidth(line, innerWidth, "…");
			const pad = " ".repeat(Math.max(0, innerWidth - visibleWidth(bounded)));
			const outerPad = " ".repeat(horizontalPadding);
			return `${outerPad}${bounded}${pad}${outerPad}`;
		});
	}
	/** Render one option as wrapped label and indented description lines. */
	renderOptionBlock(option, index, innerWidth) {
		const labelPrefixPlain = ` ${index === this.selectedIndex ? "›" : " "} ${`${index + 1}. `}${this.question.multiSelect ? this.selected.has(index) ? "[x] " : "[ ] " : ""}`;
		const labelPrefixWidth = visibleWidth(labelPrefixPlain);
		const labelBodyWidth = Math.max(1, innerWidth - labelPrefixWidth);
		const labelLines = wrapTextWithAnsi(displayText(option.label), labelBodyWidth);
		const continuation = " ".repeat(labelPrefixWidth);
		const lines = [];
		for (const [lineIndex, labelLine] of labelLines.entries()) {
			const composed = `${lineIndex === 0 ? labelPrefixPlain : continuation}${labelLine}`;
			lines.push(index === this.selectedIndex ? this.palette.bold(this.palette.accent(composed)) : composed);
		}
		if (option.description !== void 0) {
			const descIndent = " ".repeat(labelPrefixWidth);
			const descBodyWidth = Math.max(1, innerWidth - labelPrefixWidth);
			const descLines = wrapTextWithAnsi(displayText(option.description), descBodyWidth);
			for (const descLine of descLines) lines.push(`${descIndent}${this.palette.dim(descLine)}`);
		}
		return lines;
	}
	/** Keep the question visible when fixed chrome must be compacted. */
	compactQuestionHeader(contentLines, budget, innerWidth) {
		if (budget <= 0) return [];
		if (contentLines.length <= budget) {
			this.headerPage = {
				offset: 0,
				size: 1,
				maxOffset: 0
			};
			return [...contentLines];
		}
		const pageSize = Math.max(1, budget - 1);
		const maxOffset = Math.max(0, contentLines.length - pageSize);
		const offset = Math.min(this.headerPage.offset, maxOffset);
		this.headerPage = {
			offset,
			size: pageSize,
			maxOffset
		};
		const keptLines = contentLines.slice(offset, offset + pageSize);
		if (budget === 1) return [keptLines[0]];
		return [...keptLines, this.pagerStatus(offset + 1, offset + keptLines.length, contentLines.length, innerWidth)];
	}
	/** Keep Page Up / Page Down discoverable when a full pager status cannot fit. */
	pagerStatus(first, last, total, innerWidth) {
		const full = `… lines ${first}-${last}/${total} • PgUp/PgDn`;
		const compact = `PgUp/PgDn ${first}/${total}`;
		return this.palette.dim(truncateToWidth(visibleWidth(full) <= innerWidth ? full : compact, innerWidth, "…"));
	}
	/** Render custom-mode controls on one row when the header must compact. */
	compactCustomControls(innerWidth) {
		const controls = [t("dialog.question.submit"), t(this.options.length > 0 ? "dialog.question.escOptions" : "dialog.question.escCancel")].join(" • ");
		const fallback = this.options.length > 0 ? "↵ Esc options" : "Enter Esc cancel";
		const line = visibleWidth(controls) <= innerWidth ? controls : fallback;
		return this.palette.dim(truncateToWidth(line, innerWidth, "…"));
	}
	/** Render a one-row option footer that retains every mode-specific control. */
	compactOptionControls(innerWidth, showPager = false) {
		const controls = [
			...this.options.length > 1 ? ["↑/↓"] : [],
			t("dialog.question.customAnswer", { keys: CUSTOM_ANSWER_KEYS }),
			...this.question.multiSelect ? [t("dialog.question.spaceToggle")] : [],
			"Enter",
			t("dialog.question.escInterrupt"),
			...showPager ? ["PgUp/PgDn"] : []
		].join(" • ");
		const optionNavigation = this.options.length > 1 ? "↑↓ " : "";
		const fallback = showPager ? `P↑↓ ${optionNavigation}Tab${this.question.multiSelect ? " S" : ""}↵Esc` : this.question.multiSelect ? `${optionNavigation}Tab Sp ↵Esc` : `${optionNavigation}Tab ↵ Esc`;
		const line = visibleWidth(controls) <= innerWidth ? controls : fallback;
		return this.palette.dim(truncateToWidth(line, innerWidth, "…"));
	}
	/**
	* Choose option blocks that fit while keeping the selected option visible.
	* Omitted blocks are counted at each end for explicit overflow markers.
	*/
	windowBlocks(blocks, budget, innerWidth) {
		if (blocks.reduce((sum, block) => sum + block.length, 0) <= budget && blocks.length <= this.maxVisible) return {
			visibleBlocks: [...blocks],
			hiddenBefore: 0,
			hiddenAfter: 0
		};
		let start = this.selectedIndex;
		let end = this.selectedIndex + 1;
		/* v8 ignore next -- selectedIndex stays inside [0, options.length). */
		let used = blocks[this.selectedIndex]?.length ?? 0;
		const markerLines = (before, after) => (before > 0 ? 1 : 0) + (after > 0 ? 1 : 0);
		const fits = (nextStart, nextEnd, nextUsed) => nextEnd - nextStart <= this.maxVisible && nextUsed + markerLines(nextStart, blocks.length - nextEnd) <= budget;
		const selectedMarkers = markerLines(start, blocks.length - end);
		if (used + selectedMarkers > budget) {
			/* v8 ignore next -- selectedIndex stays inside [0, options.length). */
			const selectedBlock = blocks[this.selectedIndex] ?? [];
			const hiddenBefore = start;
			const hiddenAfter = blocks.length - end;
			const pageSize = budget - selectedMarkers - 1;
			const maxOffset = Math.max(0, selectedBlock.length - pageSize);
			const offset = Math.min(this.selectedBlockPage.offset, maxOffset);
			this.selectedBlockPage = {
				offset,
				size: pageSize,
				maxOffset
			};
			const keptLines = selectedBlock.slice(offset, offset + pageSize);
			const first = offset + 1;
			const last = offset + keptLines.length;
			const overflow = this.pagerStatus(first, last, selectedBlock.length, innerWidth);
			return {
				visibleBlocks: [[...keptLines, overflow]],
				hiddenBefore,
				hiddenAfter
			};
		}
		this.selectedBlockPage = {
			offset: 0,
			size: 1,
			maxOffset: 0
		};
		let expanded = true;
		while (expanded && (start > 0 || end < blocks.length)) {
			expanded = false;
			if (end < blocks.length) {
				/* v8 ignore next -- guarded by `end < blocks.length` above. */
				const next = blocks[end]?.length ?? 0;
				if (fits(start, end + 1, used + next)) {
					used += next;
					end += 1;
					expanded = true;
					continue;
				}
			}
			if (start > 0) {
				/* v8 ignore next -- guarded by `start > 0` above. */
				const previous = blocks[start - 1]?.length ?? 0;
				if (fits(start - 1, end, used + previous)) {
					used += previous;
					start -= 1;
					expanded = true;
				}
			}
		}
		return {
			visibleBlocks: blocks.slice(start, end),
			hiddenBefore: start,
			hiddenAfter: blocks.length - end
		};
	}
};
/**
* Split a `/skill:<name> [instructions]` submission into its name and trailing instructions.
* @param text - trimmed submission that starts with {@link SKILL_COMMAND_PREFIX}.
* @returns the skill name and any trailing instructions.
*/
function parseSkillCommand(text) {
	const rest = text.slice(7);
	const spaceIndex = rest.indexOf(" ");
	if (spaceIndex === -1) return {
		name: rest,
		instructions: ""
	};
	return {
		name: rest.slice(0, spaceIndex),
		instructions: rest.slice(spaceIndex + 1).trim()
	};
}
/** Model-visible line locating a manually invoked skill's relative resources, or `undefined` when the provider has no base. */
function skillResourceReference(base) {
	if (base === void 0) return void 0;
	switch (base.kind) {
		case "directory": return `References in this skill are relative to ${base.path}.`;
		case "url": return `References in this skill are relative to ${base.url}.`;
		case "opaque": return base.description;
		default: return assertNever(base, "SkillResourceBase.kind");
	}
}
/**
* Render a manually invoked skill into the model-visible user-message text. The
* `<skill>` block carries the body and, when the provider supplies one, its
* resource base; the trimmed `instructions` follow the block as the user's
* request for this turn. The name is registry-validated kebab-case
* (the skill registry rejects any other) and the resource base is trusted
* same-process provider prose, so — unlike the model-facing `dsh-tool-skill`
* result, which escapes for a tool channel — this user turn is assembled raw.
* @param skill - the loaded skill definition.
* @param instructions - trimmed text typed after `/skill:<name>`; empty when absent.
* @returns the user-message text delivered to the agent.
*/
function renderSkillInvocation(skill, instructions) {
	const lines = [`<skill name="${skill.name}">`];
	const reference = skillResourceReference(skill.resourceBase);
	if (reference !== void 0) lines.push(reference, "");
	lines.push(skill.content, "</skill>");
	const block = lines.join("\n");
	return instructions === "" ? block : `${block}\n\n${instructions}`;
}
//#endregion
//#region src/chat/autocomplete.ts
/** Merge path-only file candidates and optional session snapshots with commands. */
var ReferenceAutocompleteProvider = class {
	base;
	files;
	sessions;
	agent;
	/**
	* @param base - pi's provider, which also answers `@` when it was given an `fd` path.
	* @param files - the in-process walker, or `undefined` when `fd` answers `@` instead.
	*   The two are alternatives, never both: pi's provider and this one produce
	*   the same paths from the same token, so running them together would put
	*   every file in the menu twice.
	* @param sessions - the optional session-reference resolver.
	* @param agent - the agent whose session references are offered.
	*/
	constructor(base, files, sessions, agent) {
		this.base = base;
		this.files = files;
		this.sessions = sessions;
		this.agent = agent;
	}
	async getSuggestions(lines, cursorLine, cursorCol, options) {
		const basePromise = this.base.getSuggestions(lines, cursorLine, cursorCol, options);
		const currentLine = lines[cursorLine];
		/* v8 ignore next -- Editor always supplies its current state line. */
		if (currentLine === void 0) return basePromise;
		const token = activeAtToken(currentLine, cursorCol);
		if (token === void 0) {
			this.files?.invalidate();
			return basePromise;
		}
		const filePromise = this.files === void 0 ? Promise.resolve([]) : this.files.list(token.query, options.signal).catch(() => []);
		const sessionPromise = this.sessions === void 0 || token.quoted ? Promise.resolve([]) : this.sessions.listCandidates(this.agent, token.query, void 0, options.signal).catch(() => []);
		const [base, fileCandidates, sessionCandidates] = await Promise.all([
			basePromise,
			filePromise,
			sessionPromise
		]);
		if (options.signal.aborted) return base;
		const fileItems = fileCandidates.flatMap((candidate) => {
			const value = formatFileMention(candidate, token.quoted);
			if (value === void 0) return [];
			const name = candidate.path.slice(candidate.path.lastIndexOf("/") + 1);
			const directory = candidate.kind === "directory";
			return [{
				value,
				label: `${directory ? "Folder" : "File"} · ${displayInlineText(name)}${directory ? "/" : ""}`,
				description: displayInlineText(candidate.path)
			}];
		});
		const sessionItems = sessionCandidates.map((candidate) => {
			const mentionLabel = displayInlineText(candidate.label);
			const sessionId = displayInlineText(candidate.sessionId);
			const location = candidate.cwd === void 0 ? "(no cwd)" : displayInlineText(candidate.cwd);
			const description = `${candidate.label === candidate.sessionId ? "" : `${sessionId} · `}${location} · ${new Date(candidate.createdAt).toISOString()}`;
			return {
				value: formatSessionReferenceMention({
					sessionId: candidate.sessionId,
					label: mentionLabel
				}),
				label: `Session · ${mentionLabel}`,
				description
			};
		});
		const items = [...fileItems, ...sessionItems];
		const baseItems = base === null ? [] : base.items.map(fileItemLabel);
		if (items.length === 0) return base === null ? null : {
			items: baseItems,
			prefix: base.prefix
		};
		return {
			items: [...items, ...baseItems],
			prefix: token.prefix
		};
	}
	applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
		return this.base.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
	}
	shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
		return this.base.shouldTriggerFileCompletion(lines, cursorLine, cursorCol);
	}
};
/**
* Restate one base-provider file row the way this terminal names its own.
*
* pi labels a row with the bare basename, this bundle prefixes it with what
* the row is, and a user should not be able to tell which source answered.
* The trailing slash is left exactly where it was: pi reads directory-ness off
* `item.label` when the completion is applied — a directory keeps completion
* open instead of finishing the mention with a space.
* @param item - one row produced by pi's file search.
* @returns the row under this terminal's label.
*/
function fileItemLabel(item) {
	const directory = item.label.endsWith("/");
	return {
		...item,
		label: `${directory ? "Folder" : "File"} · ${item.label}`
	};
}
//#endregion
//#region src/chat/clipboard.ts
/**
* System-clipboard writes for the TUI, ported from Claude Code's
* `src/ink/termio/osc.ts` (`setClipboard` and its helpers). Three paths, in
* order of confidence:
*
* - native: a local clipboard utility (pbcopy/wl-copy/xclip/xsel/clip.exe)
*   always works locally, where OSC 52 depends on terminal settings (iTerm2
*   ships with it disabled, VS Code prompts on first use).
* - tmux buffer: inside tmux the paste buffer is always reachable — works
*   over SSH, survives detach/reattach — and `-w` (tmux 3.2+) propagates to
*   the outer terminal's clipboard through tmux's own OSC 52 emission.
* - OSC 52: the escape sequence itself, for remote sessions with no tmux;
*   best-effort by design.
* @module @deepseek-ai/dsh-tui/chat/clipboard
*/
const ESC = "\x1B";
const BEL = "\x07";
/** String Terminator (ESC \) — Kitty beeps on BEL-terminated OSC. */
const ST = `${ESC}\\`;
/** `execFile` with stdin input and a 2s cap, collapsed to an exit code. */
const runQuietly = (file, args, input) => new Promise((resolve) => {
	const child = execFile(file, [...args], { timeout: 2e3 }, (error) => {
		resolve(error === null ? 0 : typeof error.code === "number" ? error.code : 1);
	});
	if (child.stdin === null) {
		child.kill();
		resolve(1);
		return;
	}
	child.stdin.on("error", () => {});
	child.stdin.end(input);
});
function clipboardPath(env = process.env) {
	if (process.platform === "darwin" && env["SSH_CONNECTION"] === void 0) return "native";
	if (env["TMUX"] !== void 0) return "tmux-buffer";
	return "osc52";
}
/** OSC 52 clipboard write: ESC ] 52 ; c ; base64 — ST on Kitty (BEL beeps there), BEL elsewhere. */
function osc52(b64, env) {
	const kitty = env["KITTY_WINDOW_ID"] !== void 0 || (env["TERM"] ?? "").includes("kitty");
	return `${ESC}]52;c;${b64}${kitty ? ST : BEL}`;
}
/**
* tmux DCS passthrough: ESC P tmux ; payload ESC \ with inner ESCs doubled.
* Needs `allow-passthrough on`; without it tmux silently drops the whole DCS
* — no junk, no worse than an unwrapped OSC the multiplexer would eat.
*/
function tmuxPassthrough(payload) {
	return `${ESC}Ptmux;${payload.replaceAll(ESC, "\x1B\x1B")}${ST}`;
}
/**
* Load text into tmux's paste buffer. `-w` also propagates to the outer
* terminal's clipboard, but is dropped for iTerm2: tmux's own OSC 52
* emission (empty selection param) crashes iTerm2 sessions over SSH.
*/
async function tmuxLoadBuffer(text, env, run) {
	if (env["TMUX"] === void 0) return false;
	return await run("tmux", env["LC_TERMINAL"] === "iTerm2" ? ["load-buffer", "-"] : [
		"load-buffer",
		"-w",
		"-"
	], text) === 0;
}
let linuxCopy;
const LINUX_ARGS = {
	"wl-copy": [],
	"xclip": ["-selection", "clipboard"],
	"xsel": ["--clipboard", "--input"]
};
/**
* Shell out to a native clipboard utility. Fire-and-forget: failures are
* silent, since the OSC 52 sequence the caller writes may still succeed.
* Never called over SSH — there these would write the REMOTE clipboard.
*/
function copyNative(text, run) {
	switch (process.platform) {
		case "darwin":
			run("pbcopy", [], text);
			return;
		case "linux":
			if (linuxCopy === null) return;
			if (linuxCopy !== void 0) {
				run(linuxCopy, LINUX_ARGS[linuxCopy], text);
				return;
			}
			(async () => {
				for (const tool of [
					"wl-copy",
					"xclip",
					"xsel"
				]) if (await run(tool, LINUX_ARGS[tool], text) === 0) {
					linuxCopy = tool;
					return;
				}
				linuxCopy = null;
			})();
			return;
		case "win32":
			run("clip", [], text);
			return;
	}
}
/**
* Write `text` to the system clipboard and return the escape sequence the
* caller must write to the terminal to finish the job.
*
* The native utility fires FIRST, before the tmux await — a quick
* focus-switch right after copying must not beat pbcopy to the paste. When
* the tmux buffer loads, the returned OSC 52 is DCS-wrapped so it tunnels to
* the outer terminal; our sequence carries an explicit `c` selection, which
* sidesteps the iTerm2 crash tmux's own empty-param variant triggers.
* @param text - what to copy.
* @param env - process env override for tests.
* @param run - subprocess runner override for tests.
* @returns the sequence to write to the terminal (raw OSC 52 outside tmux).
*/
async function copyToClipboard(text, env = process.env, run = runQuietly) {
	const b64 = Buffer.from(text, "utf8").toString("base64");
	if (env["SSH_CONNECTION"] === void 0) copyNative(text, run);
	if (await tmuxLoadBuffer(text, env, run)) return tmuxPassthrough(`${ESC}]52;c;${b64}${BEL}`);
	return osc52(b64, env);
}
//#endregion
//#region src/chat/model-command.ts
/**
* Whether a resolution failed only because the route's adapter has not
* registered yet.
*
* Matched on the error's `code`, never with `instanceof LlmError`: this bundle
* resolves `@deepseek-ai/dsh-llm` from its own installation while the runtime
* that mounts it resolves the host's, so the two `LlmError` classes are
* different objects and an `instanceof` guard is false for the very error it
* exists to recognize.
* @param error - the rejection from `resolveModelInfo`.
* @returns true when the failure is a missing adapter registration.
*/
function isMissingAdapter$1(error) {
	if (typeof error !== "object" || error === null) return false;
	return error.code === "NO_ADAPTER";
}
/** The `provider/model` a resolution was made for, for change detection. */
function routeKey(selection) {
	return selection === void 0 ? void 0 : `${selection.provider}/${selection.model}`;
}
/**
* Build the model-selection controller for one chat channel.
* @param deps - channel collaborators and shared target handle.
* @returns the controller wired to the channel's overlay and prompt views.
*/
function createModelController(deps) {
	const { ctx, resolved, palette, overlayManager, target } = deps;
	let contextWindow;
	let contextResolution;
	let modelOverlay;
	let modelCommands = Promise.resolve();
	let awaitingAdapter = false;
	let resolvedRoute;
	let silentResolution = true;
	const resolveContextWindow = (selected) => {
		contextWindow = void 0;
		awaitingAdapter = false;
		resolvedRoute = routeKey(selected);
		const resolution = selected === void 0 ? Promise.resolve({
			kind: "resolved",
			contextWindow: void 0
		}) : ctx.llm.resolveModelInfo(selected.provider, selected.model).then((info) => ({
			kind: "resolved",
			contextWindow: info.context?.contextWindow
		}), (error) => ({
			kind: "error",
			error
		}));
		contextResolution = resolution;
		resolution.then((result) => {
			if (contextResolution !== resolution) return;
			if (result.kind === "error") {
				if (selected !== void 0 && (silentResolution || isMissingAdapter$1(result.error))) {
					awaitingAdapter = true;
					return;
				}
				deps.appendNotice(`Could not resolve model context: ${errorChain(result.error)}`, "error");
				return;
			}
			contextWindow = result.contextWindow;
			deps.requestRender();
		});
	};
	const disposeAdapterListener = ctx.on("llm/adapters-updated", () => {
		if (deps.isDisposed()) return;
		deps.requestRender();
		if (!awaitingAdapter && routeKey(target.current) === resolvedRoute) return;
		resolveContextWindow(target.current);
	});
	resolveContextWindow(target.current);
	/**
	* Write the user's pick through to the default-model service, so the next
	* process starts on it.
	*
	* The `/model` command only moved `target.current`, which is this process's
	* memory: every restart re-read `agentDefaultModel.currentSelection()` and
	* landed back on the configured default, so a selection never survived the
	* session that made it. Saving here is what the web client's picker does,
	* and it writes the user settings layer whenever a settings provider is
	* mounted.
	*
	* Optional service, read exactly like `defaultModelSelection` in the entry:
	* `agentDefaultModel` is not one of this bundle's injections, so it goes
	* through the non-throwing accessor and is shape-checked rather than typed.
	* An embedder that mounts the TUI without it keeps working with no
	* persistence and no complaint.
	*
	* Fire-and-forget: the selection is already live for the next step, so the
	* screen must not wait on a settings write to acknowledge it. A rejected
	* write is a warning, not an error — what failed is the durability of the
	* choice, not the choice.
	* @param selection - the freshly committed route, reasoning effort included.
	*/
	const persistDefaultSelection = (selection) => {
		const save = async () => {
			const service = ctx.get("agentDefaultModel");
			if (typeof service?.saveSelection !== "function") return;
			await service.saveSelection(selection);
		};
		save().catch((error) => {
			if (deps.isDisposed()) return;
			deps.appendNotice(`Selected model could not be saved as the default: ${errorChain(error)}`, "warning");
		});
	};
	/**
	* Commit one pick.
	*
	* `scope` is what the user chose to write, not a preference this controller
	* infers: `'default'` also saves through the default-model service, so the
	* next process starts on it, and `'session'` moves this process only. The
	* notice says which happened, because a picker that writes the user's global
	* default without saying so is indistinguishable from one that does not.
	* @param selected - the picked route with its advertised metadata.
	* @param explicitReasoning - the effort the picker resolved, when it resolved one.
	* @param scope - how far the pick reaches; the text `/model <route>` path saves the default.
	*/
	const selectModel = (selected, explicitReasoning, scope = "default") => {
		const sameRoute = target.current?.provider === selected.provider && target.current.model === selected.model;
		const reasoningEffort = explicitReasoning === void 0 ? sameRoute ? target.current?.reasoningEffort ?? selected.reasoning?.defaultEffort : selected.reasoning?.defaultEffort : explicitReasoning.effort;
		if (sameRoute && target.current?.reasoningEffort === reasoningEffort) {
			const reasoning = targetReasoningLabel(selected, reasoningEffort);
			deps.appendNotice(`Model is already ${targetLabel(selected)}${reasoning === void 0 ? "" : ` with reasoning effort ${displayText(reasoning)}`}.`);
			return;
		}
		const next = {
			provider: selected.provider,
			model: selected.model,
			...reasoningEffort === void 0 ? {} : { reasoningEffort }
		};
		target.current = next;
		silentResolution = false;
		resolveContextWindow(next);
		if (scope === "default") persistDefaultSelection(next);
		const reasoning = targetReasoningLabel(selected, reasoningEffort);
		deps.appendNotice([
			`Model selected: ${targetLabel(selected)}.`,
			...reasoning === void 0 ? [] : [`Reasoning effort: ${displayText(reasoning)}.`],
			scope === "default" ? "Saved as your default model; new steps use it." : "This session only; your default model is unchanged."
		].join(" "));
	};
	const showModelSelector = (choices) => {
		const current = target.current === void 0 ? "unset" : targetLabel(target.current);
		if (choices.length === 0) {
			deps.appendNotice(`Current model: ${current}\nNo models are advertised by registered providers.`, "warning");
			return;
		}
		modelOverlay?.close();
		const session = overlayManager.open({
			create: () => new ModelDialog(choices, target.current, resolved.maxModelOptions, palette, (selection) => {
				session.close();
				selectModel(selection.choice, { effort: selection.reasoningEffort }, selection.scope);
			}, () => {
				session.close();
			}),
			options: {
				width: resolved.modelDialogWidth,
				maxHeight: resolved.modelDialogMaxHeight
			}
		}, "inline");
		modelOverlay = session;
		session.closed.then(() => {
			if (modelOverlay === session) modelOverlay = void 0;
		});
		deps.requestRender();
	};
	const handleModelCommand = async (raw) => {
		const settleHint = deps.flashPending("Loading models…");
		const choices = await readModelChoices(ctx, target.current).finally(settleHint);
		if (deps.isDisposed()) return;
		const argument = raw.trim();
		if (argument === "") {
			showModelSelector(choices);
			return;
		}
		const parts = argument.split(/\s+/u);
		if (parts.length > 2) {
			deps.appendNotice("Usage: /model [provider/]model", "warning");
			return;
		}
		let matches;
		if (parts.length === 2) matches = choices.filter((choice) => choice.provider === parts[0] && choice.model === parts[1]);
		else {
			const value = argument;
			const qualified = choices.filter((choice) => targetLabel(choice) === value);
			matches = qualified.length > 0 ? qualified : choices.filter((choice) => choice.model === value);
		}
		if (matches.length === 0) {
			deps.appendNotice(`Unknown model: ${argument}. Run /model to list available models.`, "warning");
			return;
		}
		if (matches.length > 1) {
			deps.appendNotice(`Model "${argument}" is advertised by multiple providers; use /model <provider>/<model>.`, "warning");
			return;
		}
		const selected = matches[0];
		/* v8 ignore next -- a non-empty matches array always has index zero. */
		if (selected === void 0) return;
		selectModel(selected);
	};
	return {
		contextWindow: () => contextWindow,
		queueModelCommand(raw) {
			modelCommands = modelCommands.then(async () => {
				await handleModelCommand(raw);
			}).catch((error) => {
				if (!deps.isDisposed()) deps.appendNotice(`Could not read the model catalog: ${errorChain(error)}`, "error");
			});
		},
		resetContextResolution() {
			contextResolution = void 0;
		},
		clearOverlay() {
			modelOverlay = void 0;
		},
		detach() {
			disposeAdapterListener();
		}
	};
}
//#endregion
//#region src/chat/preset-command.ts
/**
* Agent-preset sub-controller for the interactive chat channel: the queued
* `/preset` command, the keyboard preset selector overlay, the blank-window
* switch, the saved default, and `/preset copy`. Also owns the reading of which
* preset a session actually runs, which the `/status` card shows.
*
* A preset is one session's model-facing composition — its tools, its prompt
* sections, its skill catalog — so switching one is not a display setting. The
* rules this controller enforces are the Web host's, not new ones:
*
*   - a session that has run a turn cannot change preset, because its history
*     was produced under that composition's tools and replaying it under
*     another would call tools the model can no longer make. Picking one then
*     saves it as the default for sessions created later, which is the only
*     thing left that the pick can honestly mean;
*   - a blank session may switch, and the switch is recorded in its log rather
*     than only in its creation header, because every turn from here runs under
*     the new composition.
*
* The roster is an optional mount. Nothing here imports its package at runtime:
* a bundle that hard-required an optional peer would fail to load in a
* deployment that composes no presets at all.
* @module @deepseek-ai/dsh-tui/chat/preset-command
*/
/**
* Settings namespace carrying the user's chosen default preset — the same one
* the roster resolves `defaultId` through, and the same one the Web settings
* row writes. Restated rather than imported for the reason in the module note.
*/
const PRESET_SETTINGS_NAMESPACE = "agent-presets";
/** What `/preset` says when this deployment composes no preset roster. */
const PRESETS_UNAVAILABLE = "Agent presets are not mounted in this profile. Add @deepseek-ai/dsh-agent-presets to the bundle to compose sessions from a preset.";
/**
* The preset a session actually runs, newest logged selection winning over the
* creation header.
*
* This is the roster package's own `resolveSessionPreset`, restated here rather
* than imported: the package is an optional peer, and a static import of it
* would make a deployment that composes no presets fail to load this bundle at
* all. The fold is the contract — the header states what the session was
* CREATED with, and a blank-window switch that is not read back would rebuild a
* resumed session under the composition its history was not produced under.
* @param session - the session's header and event log.
* @returns the preset id, or `undefined` when neither names one.
*/
function sessionAgentPreset(session) {
	for (let index = session.events.length - 1; index >= 0; index -= 1) {
		const event = session.events[index];
		if (event?.type === "agent-preset/selected") return event.data.agentPreset;
	}
	return session.header.agentPreset;
}
/**
* Whether the session's conversation has started: no turn has run yet.
*
* The Host draws the same line for the same reason — standalone plugin events
* (command records, plan mode, titles, goals) never open a turn, so running
* `/plan` on a fresh session leaves it switchable.
* @param session - the session to judge.
* @returns true while no turn has started.
*/
function sessionBlank(session) {
	return !session.events.some((event) => event.type === "turn/start");
}
/**
* The human sentence one authoring refusal deserves, or `undefined` when the
* failure is not one this command can explain better than the package did.
*
* Matched on the constructor name, never with `instanceof`: this bundle
* resolves `@deepseek-ai/dsh-agent-presets` from its own installation while the
* runtime that mounts the roster resolves the host's, so the two class objects
* are different and an `instanceof` guard is false for the very error it exists
* to recognize (the same reason `model-command.ts` matches `LlmError` by code).
* An unrecognized failure falls back to the package's own message, which is
* already a full sentence.
* @param error - the rejection from an authoring call.
* @param id - the id the caller was trying to create.
* @returns the sentence to show, or `undefined` to fall back.
*/
function authoringRefusal(error, id) {
	const name = error?.constructor?.name;
	if (name === "PresetExistsError") return `A preset named "${id}" already exists. A copy never overwrites — choose another id.`;
	if (name === "InvalidPresetIdError") return `"${id}" is not a usable preset id: the id becomes a directory name, so it must be lower-case letters, digits, and dashes, starting with a letter or digit.`;
	if (name === "PresetNotWritableError") return `This deployment has nowhere to author presets, so "${id}" cannot be created.`;
}
/**
* Build the agent-preset controller for one chat channel.
* @param deps - channel collaborators and the driven agent.
* @returns the controller wired to the channel's overlay and notice surfaces.
*/
function createPresetController(deps) {
	const { ctx, resolved, palette, overlayManager, agent } = deps;
	let presetOverlay;
	let presetCommands = Promise.resolve();
	/**
	* Persist one preset as the default for sessions created later.
	*
	* The settings service is read through the non-throwing accessor and
	* shape-checked rather than typed, exactly like `agentDefaultModel` in the
	* model controller: a settings provider is a deployment choice, and a TUI
	* embedded without one must still answer rather than throw.
	* @param id - the preset to make default.
	* @throws when no settings provider is mounted, or the write is refused.
	*/
	const saveDefaultPreset = async (id) => {
		const service = ctx.get("settings");
		if (typeof service?.update !== "function") throw new Error("this deployment mounts no settings provider");
		await service.update(PRESET_SETTINGS_NAMESPACE, { default: id });
	};
	/**
	* Apply one picked preset, which means two different things by design.
	*
	* A blank session is recomposed in place and the choice is recorded in its
	* log; a started session cannot be recomposed at all, so the pick becomes the
	* default for sessions created later. Both are reported in the sentence that
	* says which one happened, because the two outcomes are not interchangeable.
	* @param id - the chosen preset id.
	*/
	const applyPreset = async (id) => {
		const presets = ctx.get("agentPresets");
		if (presets === void 0) {
			deps.appendNotice(PRESETS_UNAVAILABLE, "warning");
			return;
		}
		if (!sessionBlank(agent.session)) {
			try {
				await saveDefaultPreset(id);
			} catch (error) {
				if (deps.isDisposed()) return;
				deps.appendNotice(`Preset "${id}" could not be saved as the default: ${errorChain(error)}`, "warning");
				return;
			}
			if (deps.isDisposed()) return;
			deps.appendNotice([`Preset saved as the default. New sessions will use ${id}.`, "This session has already started, so its own preset is fixed."].join("\n"));
			return;
		}
		if (sessionAgentPreset(agent.session) === id) {
			deps.appendNotice(`Preset is already ${id}.`);
			return;
		}
		let preset;
		try {
			preset = await presets.recompose(agent.ctx, id);
		} catch (error) {
			if (deps.isDisposed()) return;
			deps.appendNotice(`Could not select preset "${id}": ${errorChain(error)}`, "error");
			return;
		}
		if (deps.isDisposed()) return;
		agent.session.append("agent-preset/selected", { agentPreset: preset.id });
		deps.appendNotice(`Preset selected: ${preset.id}. This session now runs it.`);
	};
	const showPresetSelector = (choices, defaultId) => {
		const current = sessionAgentPreset(agent.session);
		if (choices.length === 0) {
			deps.appendNotice("This deployment's preset roots supply no presets.", "warning");
			return;
		}
		presetOverlay?.close();
		const session = overlayManager.open({
			create: () => new PresetDialog(choices, current, defaultId, resolved.maxModelOptions, palette, (choice) => {
				session.close();
				if (choice.broken !== void 0) {
					deps.appendNotice(`Preset "${choice.id}" cannot compose a session: ${choice.broken}`, "error");
					return;
				}
				queue(() => applyPreset(choice.id));
			}, () => {
				session.close();
			}),
			options: {
				width: resolved.modelDialogWidth,
				maxHeight: resolved.modelDialogMaxHeight
			}
		}, "inline");
		presetOverlay = session;
		session.closed.then(() => {
			if (presetOverlay === session) presetOverlay = void 0;
		});
		deps.requestRender();
	};
	/**
	* Create a locally authored preset by copying an existing one whole.
	*
	* Copy is the roster's only authoring write, and the landed path is read back
	* through `resolve` rather than reported from the call: the service returns
	* nothing, and a directory named in a confirmation must be one that is
	* actually on the roster now.
	* @param from - the preset the copy starts from.
	* @param id - the new preset's id, which becomes its directory name.
	*/
	const copyPreset = async (from, id) => {
		const presets = ctx.get("agentPresets");
		if (presets === void 0) {
			deps.appendNotice(PRESETS_UNAVAILABLE, "warning");
			return;
		}
		try {
			await presets.copy(from, id);
		} catch (error) {
			if (deps.isDisposed()) return;
			deps.appendNotice(authoringRefusal(error, id) ?? `Could not copy preset "${from}" to "${id}": ${errorChain(error)}`, "error");
			return;
		}
		let landed;
		try {
			landed = dirname((await presets.resolve(id)).path);
		} catch {
			landed = void 0;
		}
		if (deps.isDisposed()) return;
		deps.appendNotice(landed === void 0 ? `Preset "${id}" created from "${from}". Run /preset ${id} to use it.` : `Preset "${id}" created from "${from}" at ${landed}. Run /preset ${id} to use it.`);
	};
	const handlePresetCommand = async (raw) => {
		const parts = raw.trim().split(/\s+/u).filter((part) => part !== "");
		const [first, second, third] = parts;
		if (first === "copy") {
			if (second === void 0 || third === void 0 || parts.length > 3) {
				deps.appendNotice("Usage: /preset copy <preset> <new-id>", "warning");
				return;
			}
			await copyPreset(second, third);
			return;
		}
		if (parts.length > 1) {
			deps.appendNotice("Usage: /preset [<preset> | copy <preset> <new-id>]", "warning");
			return;
		}
		const presets = ctx.get("agentPresets");
		if (presets === void 0) {
			deps.appendNotice(PRESETS_UNAVAILABLE, "warning");
			return;
		}
		if (first !== void 0) {
			await applyPreset(first);
			return;
		}
		const listed = await presets.list();
		const defaultId = presets.defaultId;
		if (deps.isDisposed()) return;
		showPresetSelector(listed.map((preset) => ({
			id: preset.id,
			trust: preset.trust,
			...preset.name === void 0 ? {} : { name: preset.name },
			...preset.description === void 0 ? {} : { description: preset.description },
			...preset.broken === void 0 ? {} : { broken: preset.broken }
		})), defaultId);
	};
	/** Put one preset operation on the channel's single-writer chain. */
	const queue = (operation) => {
		presetCommands = presetCommands.then(operation).catch((error) => {
			if (!deps.isDisposed()) deps.appendNotice(`Agent preset command failed: ${errorChain(error)}`, "error");
		});
	};
	return {
		currentPreset() {
			if (ctx.get("agentPresets") === void 0) return void 0;
			return sessionAgentPreset(agent.session);
		},
		queuePresetCommand(raw) {
			queue(() => handlePresetCommand(raw));
		},
		clearOverlay() {
			presetOverlay = void 0;
		}
	};
}
//#endregion
//#region src/chat/questions.ts
/**
* Ask-user-question sub-machine for the interactive chat channel. Registers the
* user-interaction provider, presents one question overlay at a time in FIFO
* order, and settles each request on answer, abort, overlay error, or channel
* shutdown.
* @module @deepseek-ai/dsh-tui/chat/questions
*/
/**
* Build the ask-user-question queue for one chat channel.
* @param deps - channel collaborators and overlay host.
* @returns the controller used at shutdown to drain and unregister.
*/
function createQuestionQueue(deps) {
	const { ctx, resolved, palette, overlayManager } = deps;
	const questionQueue = [];
	let activeQuestion;
	const removeAbortListener = (pending) => {
		pending.request.signal?.removeEventListener("abort", pending.onAbort);
	};
	const rejectQuestion = (pending) => {
		pending.overlay?.close();
		pending.overlay = void 0;
		removeAbortListener(pending);
		pending.reject(new UserQuestionError("ask_user_question was interrupted before the user answered", "ASK_ABORTED"));
	};
	const startNextQuestion = () => {
		if (activeQuestion !== void 0 || deps.isDisposed()) return;
		const pending = questionQueue.shift();
		if (pending === void 0) return;
		activeQuestion = pending;
		const show = () => {
			const question = pending.request.questions[pending.index];
			if (question === void 0) {
				activeQuestion = void 0;
				removeAbortListener(pending);
				pending.resolve({ answers: pending.answers });
				startNextQuestion();
				return;
			}
			const session = overlayManager.open({
				...pending.request.signal === void 0 ? {} : { signal: pending.request.signal },
				create: () => new QuestionDialog(question, pending.index + 1, pending.request.questions.length, pending.request.questions.length - pending.answers.length, resolved.maxQuestionOptions, () => deps.questionMaxHeight(), palette, (selection) => {
					pending.overlay = void 0;
					session.close();
					pending.answers.push({
						id: question.id,
						...selection
					});
					pending.index += 1;
					show();
				}, () => {
					activeQuestion = void 0;
					rejectQuestion(pending);
					startNextQuestion();
				}),
				options: {
					width: resolved.questionDialogWidth,
					maxHeight: resolved.questionDialogMaxHeight
				}
			}, "inline");
			pending.overlay = session;
			session.closed.then((result) => {
				if (pending.overlay !== session) return;
				pending.overlay = void 0;
				/* v8 ignore next 2 -- close, abort, and shutdown settle the owner before this callback */
				if (result.reason !== "error") return;
				activeQuestion = void 0;
				removeAbortListener(pending);
				pending.reject(new UserQuestionError(`ask_user_question TUI failed: ${errorChain(result.error)}`, "ASK_ABORTED"));
				startNextQuestion();
			});
			deps.requestRender();
		};
		show();
	};
	return {
		rejectAll() {
			if (activeQuestion !== void 0) {
				const pending = activeQuestion;
				activeQuestion = void 0;
				rejectQuestion(pending);
			}
			for (const pending of questionQueue.splice(0)) rejectQuestion(pending);
		},
		unregister: ctx.userQuestions.registerProvider({ ask(request) {
			return new Promise((resolveAnswer, reject) => {
				const pending = {
					request,
					index: 0,
					answers: [],
					resolve: resolveAnswer,
					reject,
					overlay: void 0,
					onAbort: () => {
						if (activeQuestion === pending) {
							activeQuestion = void 0;
							rejectQuestion(pending);
							startNextQuestion();
							return;
						}
						questionQueue.splice(questionQueue.indexOf(pending), 1);
						rejectQuestion(pending);
					}
				};
				request.signal?.addEventListener("abort", pending.onAbort, { once: true });
				questionQueue.push(pending);
				startNextQuestion();
			});
		} })
	};
}
//#endregion
//#region src/print.ts
/**
* The answer and the verdict of one run interval.
*
* Read from the session log rather than from a stream subscription because the
* log is the durable record: a run that printed what it streamed and a run that
* printed what it stored could disagree, and only one of the two is what
* `/resume` will show. Events before `firstSeq` belong to a resumed session's
* history and are not this run's answer.
* @param events - the whole session log, in order.
* @param firstSeq - the first sequence number this run owns.
* @returns the last non-empty assistant text and the turn's end reason.
*/
function summarizePrintRun(events, firstSeq) {
	let started = false;
	let text = "";
	let reason;
	for (const event of events) {
		if (event.seq < firstSeq) continue;
		if (event.type === "turn/start") {
			started = true;
			continue;
		}
		if (!started) continue;
		if (event.type === "assistant/message") {
			const joined = event.data.message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
			if (joined !== "") text = joined;
		}
		if (event.type === "turn/end") reason = event.data.reason;
	}
	return {
		text,
		reason
	};
}
/**
* The durability barrier, when the profile mounts a session store.
*
* Structural and optional: a profile that keeps sessions in memory has nothing
* to flush, and a one-shot run must still print its answer there.
* @param ctx - the runner context.
* @returns the flusher, or `undefined` when no store is mounted.
*/
function sessionFlusher(ctx) {
	return ctx.get("sessions");
}
/**
* Run one task through a freshly opened agent, print its answer, and request
* the matching exit code.
*
* Approvals are pinned to `never` before the task is delivered. A one-shot run
* has no surface to ask a human on, and the alternative is worse than a refusal
* the model can read: an unanswerable request resolves fail-closed as
* `unavailable` and the model is told a channel exists but is broken, twice per
* tool call, with two audit events each time. `never` states the rule once, up
* front, in the system prompt the model already reads.
* @param ctx - the runner context, carrying `sessions` and optionally the loader.
* @param task - the one-shot task text.
* @param deps - how this run opens its agent.
* @param io - the streams to write on and the exit to request.
*/
async function runPrintTask(ctx, task, deps, io) {
	await ctx.get("loader")?.await?.();
	const { agent } = await deps.openAgent();
	await agent.whenIdle();
	setApprovalPolicy(agent.session, "never");
	const firstSeq = agent.session.seq;
	agent.followup(createUserMessage({
		content: [{
			type: "text",
			text: task
		}],
		source: { kind: "user" }
	}));
	await agent.whenIdle();
	await sessionFlusher(ctx)?.flush(agent.session);
	const outcome = summarizePrintRun(agent.session.events, firstSeq);
	io.stdout.write(`${outcome.text}\n`);
	if (outcome.reason?.kind === "error") io.stderr.write(`dsh-tui: ${outcome.reason.error.code}: ${outcome.reason.error.message}\n`);
	io.exit(outcome.reason?.kind === "completed" ? 0 : 1);
}
/**
* Drive a print run and report anything it could not survive.
*
* Every failure lands here rather than on an unhandled rejection: a one-shot
* run's whole product is one line on one stream and one exit code, and a run
* that dies without printing either is indistinguishable from a hang.
* @param ctx - the runner context.
* @param task - the one-shot task text.
* @param deps - how this run opens its agent.
* @param io - the streams to write on and the exit to request.
*/
function startPrintRun(ctx, task, deps, io) {
	runPrintTask(ctx, task, deps, io).catch((error) => {
		io.stderr.write(`dsh-tui: ${errorChain(error)}\n`);
		io.exit(1);
	});
}
//#endregion
//#region src/chat/export.ts
/**
* Local `/export`: write this session's log to a file in the workspace and
* report the path.
*
* `@deepseek-ai/dsh-session-log-export` is the Web command of the same name and
* is not usable here: its host half only returns the text
* `Session log download requested.`, and the archive is produced by
* `@deepseek-ai/dsh-host-apiproxy` at `GET /api/session.export` and saved by a
* browser plugin watching for that result. A terminal has no browser download
* manager and a TUI profile mounts no webserver, so mounting that plugin here
* would leave a command that reports success and produces nothing.
*
* This is the terminal's own implementation: same intent, local delivery. A
* profile mounts exactly one `/export` — the command registry rejects a
* duplicate global name outright — so the TUI bundle patch leaves the Web
* plugin out rather than layering over it.
*
* The archive is a single file rather than the Web ZIP because the two things
* the ZIP bundles — descendant sessions and image attachments — come from
* `sessionQuery` and `attachments`, neither of which a TUI profile mounts.
* @module @deepseek-ai/dsh-tui/chat/export
*/
/** Extension of the written artifact: one JSON record per line. */
const LOG_EXTENSION = ".jsonl";
/**
* Whether a failed exclusive create failed because the path was taken.
*
* Structural rather than typed: `writeFile` rejects with a plain `Error`
* carrying a `code`, and every other failure (a directory in the way, a
* read-only volume) has to keep travelling to the error result.
* @param error - the rejection from an exclusive write.
* @returns true when the destination already exists.
*/
function destinationExists(error) {
	return typeof error === "object" && error !== null && error.code === "EEXIST";
}
/**
* Collapse an untrusted session id into one safe filename segment — the same
* convention the Web endpoint's own filename uses, so the two exports of one
* session are recognizably the same file.
* @param id - the session's durable id.
* @returns the sanitized segment.
*/
function sessionLogBasename(id) {
	return `dsh-session-${id.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}
/**
* Serialize a live session as JSONL: the header record, then one event per
* line — the same line-per-record layout the JSONL backend writes.
*
* This is the fallback path. When the backend exposes a raw artifact, the
* export copies those exact bytes instead, because only they preserve the
* backend's own serialization (chunk packing, key order).
* @param session - the live session to serialize.
* @returns the artifact text, newline-terminated.
*/
function serializeSessionLog(session) {
	return `${[{
		type: "session",
		...session.header
	}, ...session.events].map((record) => JSON.stringify(record)).join("\n")}\n`;
}
/**
* Write this session's log and report where it landed.
*
* A path argument is taken as written (resolved against the workspace when
* relative); without one the file is `dsh-session-<id>.jsonl` in the workspace,
* or the backend's own artifact name when it has one.
*
* An existing file is never written over unsaid. The write is attempted
* exclusively first, so "does this path exist" is answered by the write itself
* rather than by a check another process can invalidate between the two calls;
* only an `EEXIST` asks, and only a yes writes again without the flag.
* @param deps - persistence, session store, workspace, and overwrite consent.
* @param session - the session to export.
* @param rawInput - the command's argument text; empty selects the default path.
* @param signal - cancellation owned by the dispatching command.
* @returns a success result naming the absolute path, or an error result.
*/
async function exportSessionLog(deps, session, rawInput, signal) {
	const requested = rawInput.trim();
	try {
		signal.throwIfAborted();
		await deps.sessions?.flush(session);
		signal.throwIfAborted();
		const raw = deps.persistence?.supportsRawArtifacts === true ? await deps.persistence.readRaw(session.id, signal) : void 0;
		signal.throwIfAborted();
		const content = raw?.content ?? serializeSessionLog(session);
		const basename = raw?.filename ?? `${sessionLogBasename(session.id)}${LOG_EXTENSION}`;
		const destination = requested === "" ? resolve(deps.cwd, basename) : isAbsolute(requested) ? requested : resolve(deps.cwd, requested);
		try {
			await writeFile(destination, content, {
				encoding: "utf8",
				flag: "wx"
			});
		} catch (error) {
			if (!destinationExists(error)) throw error;
			if (deps.confirmOverwrite === void 0) return {
				kind: "error",
				text: `Session log export refused: ${displayInlineText(destination)} already exists and nothing here can ask whether to replace it. Pass another path.`
			};
			if (!await deps.confirmOverwrite(destination)) return {
				kind: "success",
				text: `Session log export cancelled; ${displayInlineText(destination)} was left unchanged.`
			};
			signal.throwIfAborted();
			await writeFile(destination, content, "utf8");
			return {
				kind: "success",
				text: `Session log exported to ${displayInlineText(destination)} (replaced)`
			};
		}
		return {
			kind: "success",
			text: `Session log exported to ${displayInlineText(destination)}`
		};
	} catch (error) {
		return {
			kind: "error",
			text: `Session log export failed: ${displayInlineText(errorChain(error))}`
		};
	}
}
/**
* The goal fragment for the `${goal}` prompt value.
*
* A completed goal is deliberately absent rather than rendered as done: the
* prompt row reports what the next turn is working toward, and a finished goal
* is not that. Phases that still steer a turn (`active`, `paused`, `blocked`)
* carry their phase word, so a paused or blocked goal cannot read as a running
* one.
* @param goal - the session's current durable goal, when it has one.
* @returns the fragment, or `undefined` when nothing should occupy the slot.
*/
function formatGoalPrompt(goal) {
	if (goal === void 0 || goal.phase === "complete") return void 0;
	const objective = stripTerminalSequences(truncateToWidth(displayInlineText(goal.objective), 40, "…"));
	return goal.phase === "active" ? objective : `${objective} (${goal.phase})`;
}
/**
* The goal rows for the `/status` panel: the objective in full, then the
* numbers the prompt row has no space for.
* @param goal - the session's current durable goal, when it has one.
* @param roundsStarted - highest admitted goal round, from the same fold.
* @returns one label/value pair per row; empty when the session has no goal.
*/
function goalStatusRows(goal, roundsStarted) {
	if (goal === void 0) return [];
	const detail = [
		goal.phase,
		`round ${String(roundsStarted)}/${String(goal.maxGoalRounds)}`,
		...goal.blockedReason === void 0 ? [] : [displayInlineText(goal.blockedReason.message)]
	].join(" · ");
	return [[t("status.row.goal"), displayText(goal.objective)], [t("status.row.goalState"), detail]];
}
/**
* Mean milliseconds per sample, or `undefined` when nothing was sampled.
* @param total - summed wall time.
* @param samples - number of contributing samples.
* @returns the mean, or `undefined` for an empty sample set.
*/
function mean(total, samples) {
	return samples > 0 ? total / samples : void 0;
}
/**
* The `/status` row for the whole-log `sessionStats` projection.
*
* The panel already counts turns, steps, and tool calls off the in-memory log;
* this row is the projection's own figures, which paging and compaction cannot
* move, plus the wall times only it folds. Zero-sample averages are omitted
* rather than printed as `0`, so a session that has not decoded a token says
* nothing about its decode rate.
* @param stats - the folded projection value.
* @returns the formatted row.
*/
function formatSessionStats(stats) {
	const ttft = mean(stats.ttftMs, stats.ttftSteps);
	const decodeRate = stats.decodeMs > 0 ? stats.decodeTokens / (stats.decodeMs / 1e3) : void 0;
	return [
		plural(stats.turns, "status.count.turn"),
		plural(stats.steps, "status.count.step"),
		t("status.totals.model", { duration: formatStatusDuration(stats.llmMs) }),
		t("status.totals.tools", { duration: formatStatusDuration(stats.toolMs) }),
		...ttft === void 0 ? [] : [t("status.totals.ttft", { duration: formatStatusDuration(ttft) })],
		...decodeRate === void 0 ? [] : [t("status.totals.decode", { rate: decodeRate.toFixed(1) })]
	].join(" · ");
}
//#endregion
//#region src/chat/resume.ts
/**
* Session-resume sub-controller for the interactive chat channel: the
* `/resume` selector, one metadata-plus-title scan that tolerates a corrupt
* neighbor, the pre-handoff preflight, and the terminal handoff itself.
* @module @deepseek-ai/dsh-tui/chat/resume
*/
/**
* Build the session-resume controller for one chat channel.
* @param deps - channel collaborators, terminal handles, and optional services.
* @returns the controller wired to the `/resume` command.
*/
function createResumeController(deps) {
	const { ctx, agent, runtime, resolved, palette, overlayManager, sessionQuery, ui, editor } = deps;
	let resumeOverlay;
	let resumeInFlight = false;
	let resumeScan = 0;
	/** Label any session's own workspace the way the prompt labels the current one. */
	const workspaceLabel = (cwd) => runtime.formatCwd?.(cwd) ?? formatCwd(cwd);
	/** Summarize one record from metadata and its batch-folded title. */
	const summarize = (record, title, metadata) => summarizeResumeCandidate(record, title, metadata, agent.session.header.cwd, workspaceLabel);
	/** The disabled fallback row for a session whose title read failed. */
	const unreadableCandidate = (record, metadata, error) => ({
		record,
		title: "Unreadable session",
		lastActivityAt: metadata.lastActivityAt ?? record.header.createdAt,
		...metadata.sizeBytes === void 0 ? {} : { sizeBytes: metadata.sizeBytes },
		currentWorkspace: record.header.cwd === agent.session.header.cwd,
		workspaceLabel: workspaceLabel(record.header.cwd),
		disabledReason: `session cannot be loaded: ${errorChain(error)}`
	});
	/**
	* One row's activity time and artifact size, from metadata alone: a live
	* session's last in-memory event time wins over the artifact's mtime, and the
	* size comes from the same `stat` that produced the mtime. Never reads a log,
	* so browsing cost stays independent of log size; any append (including
	* bookkeeping) moves the time.
	*
	* A session with no artifact — memory-only persistence, or a log not
	* materialized yet — reports no size at all, and its row shows none.
	*/
	const scanMetadata = async (record) => {
		const liveActivityAt = ctx.sessions.get(record.header.id)?.events.at(-1)?.time;
		const location = ctx.get("sessionPersistence")?.locate(record.header);
		if (location === void 0) return liveActivityAt === void 0 ? {} : { lastActivityAt: liveActivityAt };
		try {
			const artifact = await stat(location.path);
			return {
				lastActivityAt: liveActivityAt ?? artifact.mtimeMs,
				sizeBytes: artifact.size
			};
		} catch {
			return liveActivityAt === void 0 ? {} : { lastActivityAt: liveActivityAt };
		}
	};
	/**
	* One persisted row's title through the projection-cache ladder: the
	* zero-I/O checkpoint row when usable, otherwise a cold read that folds
	* only the log tail since the checkpoint and writes the refreshed row
	* back — so a store scanned once serves later scans without log reads.
	*/
	const projectedTitle = async (cache, record, signal) => {
		const live = ctx.sessions.get(record.header.id);
		if (live !== void 0) return ctx.get("sessionProjections")?.snapshot(live).values.title;
		const cached = cache.cachedSnapshot(record.header);
		if (cached !== void 0 && "title" in cached.values) return cached.values.title;
		return (await cache.coldSnapshot(record.header.id, signal)).values.title;
	};
	/**
	* Resolve every row's title without reading whole logs when the projection
	* cache is mounted (live registry snapshot / checkpoint row / tail-only
	* cold read, bounded by `resumeScanConcurrency`); a composition without
	* the cache falls back to one bounded raw-log title batch.
	*/
	const resolveTitles = async (listQuery, records, signal) => {
		const cache = ctx.get("sessionProjectionCache");
		if (cache === void 0) {
			const results = await listQuery.readTitleSnapshots(records.map((record) => record.header.id), signal);
			return records.map((record, index) => {
				const result = results[index];
				/* v8 ignore next 2 -- readTitleSnapshots returns one result per unique listed id in input order */
				if (result === void 0 || result.sessionId !== record.header.id) throw new Error(`resume scan misaligned at "${record.header.id}"`);
				if (result.status === "rejected") return { failure: result.reason };
				const title = result.value.title?.title;
				return title === void 0 ? {} : { title };
			});
		}
		const resolutions = new Array(records.length);
		let cursor = 0;
		const worker = async () => {
			for (;;) {
				const index = cursor;
				if (index >= records.length) return;
				cursor += 1;
				const record = records[index];
				try {
					const value = await projectedTitle(cache, record, signal);
					resolutions[index] = typeof value === "string" ? { title: value } : {};
				} catch (failure) {
					resolutions[index] = { failure };
				}
			}
		};
		await Promise.all(Array.from({ length: Math.min(resolved.resumeScanConcurrency, records.length) }, () => worker()));
		return resolutions;
	};
	/** The latest logged provider/model route, for the preflight availability check. */
	const resumeRoute = (events) => {
		const header = events.findLast((item) => item.type === "request/header");
		if (header?.type === "request/header") return {
			provider: header.data.header.config.provider,
			model: header.data.header.config.model
		};
		const assistant = events.findLast((item) => item.type === "assistant/message");
		return assistant?.type === "assistant/message" ? {
			provider: assistant.data.message.source.provider,
			model: assistant.data.message.source.model
		} : void 0;
	};
	/**
	* Re-read every mutable precondition immediately before terminal handoff and
	* resolve the exact identity and workspace the host will re-exec into. This
	* is where the one chosen log is fully read, replay-validated, and checked
	* for a currently-available route — the listing never does any of that.
	*/
	const preflightResume = async (sessionId) => {
		const query = sessionQuery();
		/* v8 ignore start -- showResume alone calls this after proving the optional service exists */
		if (query === void 0) throw new Error("Resume is unavailable: session query is not mounted.");
		/* v8 ignore stop */
		const initialStatus = deps.agentStatus();
		if (initialStatus !== "idle") throw new Error(`Resume requires an idle agent (status: ${initialStatus}).`);
		const record = (await query.listSessions()).find((candidate) => candidate.header.id === sessionId);
		if (record === void 0) throw new Error(`Session "${sessionId}" is no longer available.`);
		const candidate = summarize(record, void 0, {});
		if (candidate.disabledReason !== void 0) throw new Error(candidate.disabledReason);
		let events;
		try {
			events = (await query.readSession(record.header.id)).events;
		} catch (error) {
			throw new Error(`session cannot be loaded: ${errorChain(error)}`);
		}
		const route = resumeRoute(events);
		if (route !== void 0 && !ctx.llm.listProviders().some((provider) => provider.id === route.provider)) throw new Error(`session is complete, but route is currently unavailable (${route.provider}/${route.model})`);
		const cwd = record.header.cwd;
		/* v8 ignore next -- summarizeResumeCandidate disables a cwd-less record, so the check above already rejected it */
		if (cwd === void 0) throw new Error(`Session "${sessionId}" has no recorded workspace to resume in.`);
		const finalStatus = deps.agentStatus();
		if (finalStatus !== "idle") throw new Error(`Resume requires an idle agent (status: ${finalStatus}).`);
		return {
			id: record.header.id,
			cwd
		};
	};
	const handoffResume = async (candidate, overlay) => {
		if (resumeInFlight) return;
		resumeInFlight = true;
		let terminalReleased = false;
		try {
			const checked = await preflightResume(candidate.record.header.id);
			const hostHandoff = runtime.handoffResume;
			if (hostHandoff === void 0) {
				await overlay.close();
				resumeOverlay = void 0;
				deps.appendNotice("Session is resumable, but this host cannot hand it off in place.", "warning");
				return;
			}
			/* v8 ignore next -- shutdown during preflight invalidates an awaited service read or reaches this guard */
			if (deps.isDisposed()) return;
			await ctx.sessions.flush(agent.session);
			if (deps.isDisposed()) return;
			if (agent.status !== "idle") throw new Error(`Resume requires an idle agent (status: ${agent.status}).`);
			await overlay.close();
			resumeOverlay = void 0;
			await runtime.terminal.drainInput(100, 20);
			if (deps.isDisposed()) return;
			ui.stop();
			terminalReleased = true;
			await hostHandoff(checked.id, checked.cwd);
			throw new Error("resume host returned without replacing the process");
		} catch (error) {
			if (!deps.isDisposed()) {
				if (terminalReleased) {
					ui.start();
					ui.setFocus(editor);
					deps.appendNotice(`Resume handoff failed: ${errorChain(error)}`, "error");
				} else {
					await overlay.close();
					resumeOverlay = void 0;
					deps.appendNotice(`Resume failed: ${errorChain(error)}`, "error");
				}
			}
		} finally {
			resumeInFlight = false;
		}
	};
	return { showResume(query = "") {
		if (agent.status !== "idle") {
			deps.appendNotice("Resume requires the current turn to finish or be cancelled first.", "warning");
			return;
		}
		const listQuery = sessionQuery();
		if (listQuery === void 0) {
			deps.appendNotice("Resume is not available: session query is not mounted.", "warning");
			return;
		}
		const scan = ++resumeScan;
		resumeOverlay?.close();
		let picker;
		let scanned;
		const session = overlayManager.open({
			create: (host) => {
				picker = new ResumePicker(scanned, resolved.maxResumeOptions, workspaceLabel(agent.session.header.cwd), () => host.viewport.rows, palette, (candidate) => {
					handoffResume(candidate, session);
				}, () => {
					session.close();
				});
				if (query !== "") picker.setQuery(query);
				return picker;
			},
			options: {
				width: "100%",
				maxHeight: "100%",
				anchor: "top-left",
				margin: 0
			}
		});
		resumeOverlay = session;
		const scanAbort = new AbortController();
		session.closed.then(() => {
			scanAbort.abort();
			/* v8 ignore next -- overlay FIFO closes this session before a replacement can become the tracked resume overlay */
			if (resumeOverlay === session) resumeOverlay = void 0;
		});
		deps.requestRender();
		/** Whether this scan's overlay, session generation, or TUI is gone. */
		const scanStale = () => deps.isDisposed() || scan !== resumeScan || scanAbort.signal.aborted;
		const scanCandidates = async () => {
			const records = (await listQuery.listSessions(scanAbort.signal)).filter((record) => record.header.id !== agent.session.id);
			if (scanStale()) return;
			const [titles, metadata] = await Promise.all([resolveTitles(listQuery, records, scanAbort.signal), Promise.all(records.map((record) => scanMetadata(record)))]);
			const candidates = records.map((record, index) => {
				const resolution = titles[index];
				const observed = metadata[index] ?? {};
				return "failure" in resolution ? unreadableCandidate(record, observed, resolution.failure) : summarize(record, resolution.title, observed);
			});
			candidates.sort((a, b) => b.lastActivityAt - a.lastActivityAt || a.record.header.id.localeCompare(b.record.header.id));
			if (scanStale()) return;
			scanned = candidates;
			picker?.setCandidates(candidates);
			deps.requestRender();
		};
		scanCandidates().catch((error) => {
			if (scanStale()) return;
			session.close();
			deps.appendNotice(`Resume session scan failed: ${errorChain(error)}`, "error");
		});
	} };
}
//#endregion
//#region src/chat/mcp.ts
/**
* Local `/mcp`: which MCP servers this session's tools came from.
*
* The harness has no MCP registry to ask. `@deepseek-ai/dsh-mcp-client` mounts
* one plugin instance per server and registers that server's tools on
* `ctx.tools` under the public name `mcp__<serverName>__<rawName>`, and nothing
* else records which row produced which tool. So the naming convention IS the
* inventory: this module reads the registered tool names the same panel that
* lists them (`/status`) reads, and folds them back into servers.
*
* That makes the panel read-only by construction — it cannot connect, restart,
* or authenticate a server, because the TUI holds no handle on one. A profile
* with no MCP row registers no such tool, so the panel says so and states how
* to mount one rather than showing an empty list.
* @module @deepseek-ai/dsh-tui/chat/mcp
*/
/** Prefix `@deepseek-ai/dsh-mcp-client` gives every tool it registers. */
const MCP_TOOL_PREFIX = "mcp__";
/** Separator between the server namespace and the raw MCP tool name. */
const MCP_NAME_SEPARATOR = "__";
/**
* Fold registered tool names into the servers their public names name.
*
* The split is on the FIRST `__` after the prefix, because a raw MCP name may
* contain `__` of its own and a server name is written by the deployment. A
* server whose configured `serverName` itself contains `__` would therefore be
* reported under its first segment; the client's own name normalization also
* appends a hash when it has to rewrite a name, so no grouping here is worth
* more than the convention it reads.
* @param names - every tool name visible to this agent, in any order.
* @returns one entry per server, servers and tools both sorted by name.
*/
function groupMcpTools(names) {
	const servers = /* @__PURE__ */ new Map();
	for (const name of names) {
		if (!name.startsWith(MCP_TOOL_PREFIX)) continue;
		const qualified = name.slice(5);
		const separator = qualified.indexOf(MCP_NAME_SEPARATOR);
		if (separator <= 0) continue;
		const tool = qualified.slice(separator + 2);
		if (tool === "") continue;
		const server = qualified.slice(0, separator);
		const tools = servers.get(server);
		if (tools === void 0) servers.set(server, [tool]);
		else tools.push(tool);
	}
	return [...servers].map(([server, tools]) => ({
		server,
		tools: [...tools].sort((a, b) => a.localeCompare(b))
	})).sort((a, b) => a.server.localeCompare(b.server));
}
/**
* The bundle row the empty panel offers to be copied.
*
* The client's own README row, kept exact and never translated: this is YAML a
* user pastes into a profile, so a "localized" field name would produce a
* config that does not load.
*/
const MCP_EXAMPLE_ROW = [
	"  - id: mcp-github",
	"    name: '@deepseek-ai/dsh-mcp-client'",
	"    config:",
	"      serverName: github",
	"      transport: stdio",
	"      command: npx",
	"      args: ['-y', '@modelcontextprotocol/server-github']"
];
/**
* What the panel says when this profile mounts no MCP client.
*
* Built per call rather than held in a module constant: a constant would freeze
* whichever locale happened to be active when this module was first imported,
* and `/lang` would never reach it again.
* @returns the block's lines, prose translated and the bundle row verbatim.
*/
function mcpNotMountedLines() {
	return [
		...t("mcp.empty.headline").split("\n"),
		"",
		...t("mcp.empty.howto").split("\n"),
		"",
		...MCP_EXAMPLE_ROW,
		"",
		...t("mcp.empty.transport").split("\n")
	];
}
/**
* The `/mcp` panel body.
* @param names - every tool name visible to this agent.
* @param palette - active role palette.
* @returns pre-rendered rows for the scrollable panel.
*/
function renderMcpPanel(names, palette) {
	const servers = groupMcpTools(names);
	if (servers.length === 0) return mcpNotMountedLines().map((line) => palette.dim(line));
	const total = servers.reduce((count, server) => count + server.tools.length, 0);
	return [palette.dim(t("mcp.summary", {
		servers: plural(servers.length, "mcp.servers"),
		tools: plural(total, "mcp.tools")
	})), ...servers.flatMap((server) => [
		"",
		`${palette.bold(palette.accent(displayInlineText(server.server)))} ${palette.dim(t("mcp.serverRow", { tools: plural(server.tools.length, "mcp.tools") }))}`,
		...server.tools.map((tool) => palette.dim(`  ${displayInlineText(tool)}`))
	])];
}
//#endregion
//#region src/chat/doctor.ts
/**
* Local `/doctor`: the environment checks a bug report starts with, run and
* answered on screen.
*
* `/status` describes the session; this describes what the session is running
* ON — the interpreter, the terminal, the model route, the services a terminal
* silently degrades without. Each check is one line the user can act on: a
* verdict, what was actually observed, and, when it is not a pass, the one
* thing to do about it.
*
* Every input arrives as a value or a callback rather than being read here, so
* the checks are a pure function of the environment they describe and a test
* can state any environment it wants to see reported.
* @module @deepseek-ai/dsh-tui/chat/doctor
*/
/**
* Node versions this bundle is published for, mirroring `engines.node`
* (`^22.19.0 || >=24.0.0`). Restated rather than parsed out of `package.json`:
* the built bundle does not ship its manifest beside the code that would read
* it, and a range this small is cheaper to keep honest than to resolve.
*/
const NODE_LTS_MAJOR = 22;
const NODE_LTS_MIN_MINOR = 19;
const NODE_CURRENT_MAJOR = 24;
/**
* The range, as `/doctor` states it when the running version misses it.
*
* Written as the semver range `package.json` already carries rather than as
* prose: it is interpolated into a translated sentence, and an English `or`
* inside it rendered as `Node 22.19+ or 24+` in the middle of a Chinese line.
*/
const NODE_SUPPORTED_RANGE = "^22.19.0 || >=24.0.0";
/** Below this many columns the transcript's cards and diffs wrap to unreadable. */
const NARROW_COLUMNS = 60;
/** Below this many rows the editor and a panel cannot both be on screen. */
const SHORT_ROWS = 10;
/** The error code a route whose adapter has not registered rejects with. */
const NO_ADAPTER = "NO_ADAPTER";
/**
* Whether a version string satisfies this bundle's `engines.node`.
* @param version - `process.version`, with or without its leading `v`.
* @returns true when the version is in range; false for out-of-range AND for
*   anything that does not parse, since an unreadable version is not a
*   supported one.
*/
function nodeVersionSupported(version) {
	const parsed = /^v?(\d+)\.(\d+)\./u.exec(version);
	if (parsed === null) return false;
	const major = Number(parsed[1]);
	const minor = Number(parsed[2]);
	if (major >= NODE_CURRENT_MAJOR) return true;
	return major === NODE_LTS_MAJOR && minor >= NODE_LTS_MIN_MINOR;
}
/**
* Whether a rejection means only that the route's adapter has not registered.
*
* Matched on `code`, never with `instanceof LlmError`: this bundle resolves
* `@deepseek-ai/dsh-llm` from its own installation while the host that mounts
* it resolves its own, so the two error classes are different objects and an
* `instanceof` guard is false for the very error it exists to recognize.
* @param error - the rejection from `resolveModelInfo`.
* @returns true when the failure is a missing adapter registration.
*/
function isMissingAdapter(error) {
	if (typeof error !== "object" || error === null) return false;
	return error.code === NO_ADAPTER;
}
/** The interpreter this process runs on. */
function nodeCheck(inputs) {
	const label = t("doctor.label.node");
	const detail = displayInlineText(inputs.nodeVersion);
	if (nodeVersionSupported(inputs.nodeVersion)) return {
		label,
		status: "pass",
		detail
	};
	return {
		label,
		status: "fail",
		detail,
		advice: t("doctor.node.advice", { range: NODE_SUPPORTED_RANGE })
	};
}
/**
* Whether both ends of the terminal are a TTY.
*
* A failure here is reported rather than acted on: the interactive entry point
* refuses a non-TTY invocation outright, so this check answers for an embedded
* host that drove the UI over something else.
*/
function terminalCheck(inputs) {
	const label = t("doctor.label.terminal");
	if (inputs.stdinTty && inputs.stdoutTty) return {
		label,
		status: "pass",
		detail: t("doctor.terminal.pass")
	};
	return {
		label,
		status: "fail",
		detail: inputs.stdinTty || inputs.stdoutTty ? t("doctor.terminal.failOne", { end: inputs.stdinTty ? "stdout" : "stdin" }) : t("doctor.terminal.failBoth"),
		advice: t("doctor.terminal.advice")
	};
}
/** How much screen the layout actually has. */
function screenCheck(inputs) {
	const label = t("doctor.label.screen");
	const detail = `${String(inputs.columns)}x${String(inputs.rows)}`;
	if (inputs.columns < NARROW_COLUMNS) return {
		label,
		status: "warn",
		detail,
		advice: t("doctor.screen.narrowAdvice", { columns: NARROW_COLUMNS })
	};
	if (inputs.rows < SHORT_ROWS) return {
		label,
		status: "warn",
		detail,
		advice: t("doctor.screen.shortAdvice", { rows: SHORT_ROWS })
	};
	return {
		label,
		status: "pass",
		detail
	};
}
/**
* What this terminal is allowed to render.
*
* Choice, not detection: the TUI emits the standard 16 colors and lets the
* terminal map them, so what matters is whether anything turned them off — a
* disabled palette is legible but flat, which is worth saying out loud before
* someone reports missing highlighting as a bug. The caller passes the
* *resolved* appearance rather than the deployment's `theme.color`, because
* `/theme no-color` puts the switch in the user's hands too, and a check that
* described the config would pass on a screen that is already plain text.
*/
function colorCheck(inputs) {
	const label = t("doctor.label.color");
	if (!inputs.color) return {
		label,
		status: "warn",
		detail: t("doctor.color.disabled"),
		advice: t("doctor.color.disabledAdvice")
	};
	return {
		label,
		status: "pass",
		detail: inputs.truecolor ? t("doctor.color.truecolor") : t("doctor.color.basic")
	};
}
/**
* Whether the selected route can actually be resolved.
*
* This is the one check that asks a service rather than reading a value: a
* provider list proves a plugin registered, and only a resolution proves the
* adapter behind it answers for THIS model.
*/
async function modelCheck(inputs) {
	const label = t("doctor.label.model");
	if (inputs.providers.length === 0) return {
		label,
		status: "fail",
		detail: t("doctor.model.noProvider"),
		advice: t("doctor.model.noProviderAdvice")
	};
	const providers = inputs.providers.map((provider) => displayInlineText(provider)).join(", ");
	if (inputs.route === void 0) return {
		label,
		status: "fail",
		detail: t("doctor.model.noRoute", { providers }),
		advice: t("doctor.model.noRouteAdvice")
	};
	const route = displayInlineText(`${inputs.route.provider}/${inputs.route.model}`);
	try {
		await inputs.resolveModelInfo(inputs.route.provider, inputs.route.model);
		return {
			label,
			status: "pass",
			detail: t("doctor.model.resolves", {
				route,
				providers
			})
		};
	} catch (error) {
		if (isMissingAdapter(error)) return {
			label,
			status: "fail",
			detail: t("doctor.model.noAdapter", { route }),
			advice: t("doctor.model.noAdapterAdvice", { provider: displayInlineText(inputs.route.provider) })
		};
		return {
			label,
			status: "fail",
			detail: t("doctor.model.failed", {
				route,
				error: displayInlineText(errorChain(error))
			}),
			advice: t("doctor.model.failedAdvice")
		};
	}
}
/** Whether anything writes this session down. */
function persistenceCheck(inputs) {
	const label = t("doctor.label.persistence");
	if (inputs.persistence) return {
		label,
		status: "pass",
		detail: t("doctor.persistence.mounted")
	};
	return {
		label,
		status: "warn",
		detail: t("doctor.persistence.missing"),
		advice: t("doctor.persistence.advice")
	};
}
/** Which composition this session's tools, prompt, and skills come from. */
function presetCheck(inputs) {
	const label = t("doctor.label.preset");
	if (!inputs.presets) return {
		label,
		status: "warn",
		detail: t("doctor.preset.noRoster"),
		advice: t("doctor.preset.noRosterAdvice")
	};
	if (inputs.preset === void 0) return {
		label,
		status: "warn",
		detail: t("doctor.preset.unjoined"),
		advice: t("doctor.preset.unjoinedAdvice")
	};
	return {
		label,
		status: "pass",
		detail: displayInlineText(inputs.preset)
	};
}
/**
* Run every check, in the order the panel prints them.
* @param inputs - the environment, read by the caller.
* @returns one answered check per row.
*/
async function runDoctorChecks(inputs) {
	return [
		nodeCheck(inputs),
		terminalCheck(inputs),
		screenCheck(inputs),
		colorCheck(inputs),
		await modelCheck(inputs),
		persistenceCheck(inputs),
		presetCheck(inputs)
	];
}
/** Verdict glyphs, one per status. */
const DOCTOR_GLYPHS = {
	pass: "✓",
	warn: "!",
	fail: "✗"
};
/**
* The `/doctor` panel body.
* @param checks - answered checks, in print order.
* @param palette - active role palette.
* @returns pre-rendered rows for the scrollable panel.
*/
function renderDoctorPanel(checks, palette) {
	const failed = checks.filter((check) => check.status === "fail").length;
	const warned = checks.filter((check) => check.status === "warn").length;
	const summary = failed === 0 && warned === 0 ? t("doctor.healthy") : [...failed === 0 ? [] : [t("doctor.summary.failed", { count: failed })], ...warned === 0 ? [] : [t("doctor.summary.warned", { count: warned })]].join(" · ");
	const labelWidth = Math.max(...checks.map((check) => visibleWidth(check.label)));
	return [
		palette.dim(summary),
		"",
		...checks.flatMap((check) => {
			const glyph = DOCTOR_GLYPHS[check.status];
			return [`${check.status === "pass" ? palette.success(glyph) : check.status === "warn" ? palette.warning(glyph) : palette.error(glyph)} ${palette.dim(check.label + " ".repeat(labelWidth - visibleWidth(check.label)))}  ${check.detail}`, ...check.advice === void 0 ? [] : [palette.dim(`${" ".repeat(labelWidth + 2)}→ ${check.advice}`)]];
		})
	];
}
//#endregion
//#region src/chat/fd.ts
/**
* Runtime discovery of the `fd` binary Pi's `@` file search shells out to.
*
* `fd` is not a dependency and never will be: this bundle installs as a profile
* into someone else's process, so it cannot add a platform binary to their
* install. It is a capability of the host machine instead — present, and the
* `@` menu inherits `fd`'s ignore-file semantics for free (`.gitignore`,
* `.ignore`, `.fdignore`); absent, and completion falls back to this bundle's
* own bounded walker.
*
* Discovery is a `PATH` lookup, not a probe subprocess: mounting a terminal
* must not wait on a spawn, and an executable bit is the same answer `spawn`
* would have reached one process later.
*
* @module @deepseek-ai/dsh-tui/chat/fd
*/
/**
* Command names searched on `PATH`, in order.
*
* Debian and Ubuntu ship the same binary as `fdfind` because `fd` was already
* taken by another package, so a machine that has it under the distribution
* name is not a machine without it.
*/
const FILE_SEARCH_COMMAND_NAMES = ["fd", "fdfind"];
/**
* Whether one absolute path is an executable file this process can run.
*
* A directory named `fd` on `PATH` satisfies neither, and a permission error
* is the same answer as a missing file: this host cannot run it.
* @param candidate - absolute path to test.
* @returns true when the path can be spawned.
*/
function isExecutableFile(candidate) {
	try {
		if (!statSync(candidate).isFile()) return false;
		accessSync(candidate, constants.X_OK);
		return true;
	} catch (_notExecutable) {
		return false;
	}
}
/**
* Resolve one command name against every `PATH` entry.
* @param name - bare command name, without a directory part.
* @param env - environment whose `PATH` is searched.
* @returns the absolute path of the first executable match, or `undefined`.
*/
function lookupOnPath(name, env) {
	const search = env["PATH"] ?? "";
	for (const directory of search.split(delimiter)) {
		if (directory === "") continue;
		const candidate = join(directory, name);
		if (isExecutableFile(candidate)) return candidate;
	}
}
/**
* Resolve the gitignore-aware file-search binary for this session.
*
* The configured value wins over discovery in both directions, because both
* directions are real deployments: an image that ships `fd` outside `PATH`
* pins its path, and a deployment that wants completion to see ignored build
* output — or refuses to let the terminal spawn anything — sets the empty
* string and gets the in-process walker.
* @param configured - deployment setting: a path, a command name, or `''` to disable.
* @param env - environment whose `PATH` is searched; defaults to this process's.
* @returns a spawnable path, or `undefined` when the walker must serve `@` instead.
*/
function resolveFileSearchCommand(configured, env = process.env) {
	if (configured !== void 0) {
		const setting = configured.trim();
		if (setting === "") return void 0;
		if (isAbsolute(setting) || setting.includes("/") || setting.includes(sep)) return isExecutableFile(setting) ? setting : void 0;
		return lookupOnPath(setting, env);
	}
	for (const name of FILE_SEARCH_COMMAND_NAMES) {
		const found = lookupOnPath(name, env);
		if (found !== void 0) return found;
	}
}
//#endregion
//#region src/chat/command-completions.ts
/**
* Reuse one asynchronous listing across the keystrokes of a single argument.
*
* The slash-argument path has no debounce and no `AbortSignal`: pi's editor
* issues the request on the keystroke, so a source that lists a provider
* catalog or a session store would pay one listing per character and the menu
* would trail the text. One short window collapses a burst of typing into a
* single read while still noticing what appeared while the terminal was idle.
* A rejection is never retained — the next keystroke gets a fresh attempt.
* @param read - the listing to reuse, keyed for sources listed per subject.
* @param ttlMs - how long one listing stays valid.
* @param now - clock, injectable so a test does not have to wait out the window.
* @returns the memoized listing.
*/
function memoizeListing(read, ttlMs, now = Date.now) {
	const entries = /* @__PURE__ */ new Map();
	return (key) => {
		const cached = entries.get(key);
		if (cached !== void 0 && now() - cached.at < ttlMs) return cached.value;
		const pending = read(key).catch((error) => {
			if (entries.get(key)?.value === pending) entries.delete(key);
			throw error;
		});
		entries.set(key, {
			at: now(),
			value: pending
		});
		return pending;
	};
}
/**
* Case-insensitive containment, the same match the pickers apply to their own
* search boxes. Deliberately not a fuzzy subsequence: an argument menu that
* matches `dc` against `deepseek-chat` reorders itself under the user's hands
* while they are typing a value they already know.
* @param haystack - candidate text.
* @param needle - what the user has typed so far.
* @returns true when the candidate is still a possible completion.
*/
function matches(haystack, needle) {
	return needle === "" || haystack.toLowerCase().includes(needle.toLowerCase());
}
/** A label pi will not mistake for a directory. */
function itemLabel(text) {
	const shown = displayInlineText(text);
	return shown.endsWith("/") ? shown.slice(0, -1) : shown;
}
/** `null` for an empty menu, so callers cannot accidentally open an empty one. */
function menu(items) {
	return items.length === 0 ? null : items;
}
/**
* Complete `/model [[provider/]model]` with every advertised route.
*
* Values are always fully qualified `provider/model`, even when the user typed
* a bare model name: the command resolves an unqualified name against the
* registered providers, and a menu that inserts the ambiguous form would make
* the terminal answer a question the user just answered.
* @param source - the LLM service.
* @param argumentPrefix - argument text typed so far.
* @param limit - maximum rows offered.
* @returns the routes still matching, or `null` for no menu.
*/
async function modelArgumentCompletions(source, argumentPrefix, limit) {
	const prefix = argumentPrefix.trim();
	const providers = source.listProviders();
	const listed = await Promise.all(providers.map(async (provider) => {
		try {
			return {
				provider: provider.id,
				models: await source.listModels(provider.id)
			};
		} catch (_providerCannotList) {
			return {
				provider: provider.id,
				models: []
			};
		}
	}));
	const items = [];
	for (const { provider, models } of listed) for (const model of models) {
		const route = `${provider}/${model.id}`;
		if (!matches(route, prefix)) continue;
		const description = model.description ?? (model.name === void 0 || model.name === model.id ? void 0 : model.name);
		items.push({
			value: route,
			label: itemLabel(route),
			...description === void 0 ? {} : { description: displayInlineText(description) }
		});
		if (items.length >= limit) return menu(items);
	}
	return menu(items);
}
/**
* Complete `/preset [<preset> | copy <preset> <new-id>]` with the roster's ids.
*
* The `copy` form's third token is a name the user is inventing, so only its
* source preset is completed; the verb itself is offered while the first token
* is still being typed.
* @param source - the preset roster.
* @param argumentPrefix - argument text typed so far.
* @param limit - maximum rows offered.
* @returns the presets still matching, or `null` for no menu.
*/
async function presetArgumentCompletions(source, argumentPrefix, limit) {
	const tokens = argumentPrefix.split(/\s+/u);
	const copying = tokens[0] === "copy";
	if (tokens.length > (copying ? 2 : 1)) return null;
	const typed = tokens[tokens.length - 1] ?? "";
	const presets = await source.list();
	const items = [];
	if (!copying && matches("copy", typed)) items.push({
		value: "copy ",
		label: "copy",
		description: "Copy an existing preset under a new id"
	});
	for (const preset of presets) {
		if (!matches(preset.id, typed)) continue;
		const detail = preset.broken === void 0 ? preset.description ?? preset.name : `unusable: ${preset.broken}`;
		const description = [preset.id === source.defaultId ? "default" : void 0, detail].filter((part) => part !== void 0 && part !== "").join(" · ");
		items.push({
			value: copying ? `copy ${preset.id}` : preset.id,
			label: itemLabel(preset.id),
			...description === "" ? {} : { description: displayInlineText(description) }
		});
		if (items.length >= limit) break;
	}
	return menu(items);
}
/**
* Complete `/theme [auto|light|dark|no-color]`.
*
* One slot with four values, each carrying the sentence the selector shows
* beside it, so the menu and the picker answer the same question the same way.
* @param argumentPrefix - argument text typed so far.
* @returns the matching themes, or `null` for no menu.
*/
function themeArgumentCompletions(argumentPrefix) {
	const typed = argumentPrefix.trim();
	const items = [];
	for (const id of THEME_PREFERENCES) {
		if (!matches(id, typed)) continue;
		items.push({
			value: id,
			label: id,
			description: themePreferenceDescription(id)
		});
	}
	return menu(items);
}
/**
* Complete `/lang [en|zh]` with the locales this terminal ships.
*
* The active one is marked rather than hidden: the menu is also how a user
* checks what the language currently is, and a list that dropped the answer
* would make them run the command to find out.
* @param argumentPrefix - argument text typed so far.
* @returns the matching locales, or `null` for no menu.
*/
function langArgumentCompletions(argumentPrefix) {
	const typed = argumentPrefix.trim();
	const active = currentLocale();
	const items = [];
	for (const locale of LOCALE_IDS) {
		if (!matches(locale, typed)) continue;
		items.push({
			value: locale,
			label: locale,
			description: locale === active ? `${localeName(locale)} · ${t("lang.active")}` : localeName(locale)
		});
	}
	return menu(items);
}
/**
* Complete `/resume [session]` with this workspace's resumable sessions.
*
* Scoped to the current workspace because that is the scope the picker opens
* in: an id from another directory would insert a query whose only match is
* hidden until the user widens the scope by hand. Ordered newest first by
* creation time — the picker orders by last activity, which costs one `stat`
* per session, and a menu that renders between two keystrokes cannot pay that.
* @param source - the session store, reduced to metadata already in memory.
* @param argumentPrefix - argument text typed so far.
* @param limit - maximum rows offered.
* @returns the matching sessions, or `null` for no menu.
*/
async function resumeArgumentCompletions(source, argumentPrefix, limit) {
	const prefix = argumentPrefix.trim();
	const sessions = (await source.list()).filter((session) => session.id !== source.currentSessionId && !session.live && session.cwd !== void 0 && session.cwd === source.cwd).sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id));
	const items = [];
	for (const session of sessions) {
		if (!matches(session.id, prefix) && !matches(session.title ?? "", prefix)) continue;
		items.push({
			value: session.id,
			label: itemLabel(session.title ?? session.id),
			description: `${displayInlineText(session.id)} · ${new Date(session.createdAt).toISOString()}`
		});
		if (items.length >= limit) break;
	}
	return menu(items);
}
//#endregion
//#region src/chat/lifecycle.ts
/**
* Bounded waits the interactive channel's lifecycle paths run on: the exit that
* cancels a turn before it leaves, and the mount that waits for its agent to
* exist. Both bounds live here rather than inline so the timing contract can be
* exercised without a mounted terminal.
* @module @deepseek-ai/dsh-tui/chat/lifecycle
*/
/**
* How long a graceful exit waits for a cancelled turn to reach idle before it
* leaves anyway.
*
* Long enough that an ordinary cancel — the driver finishing its in-flight tool
* call and closing the turn — completes inside it, short enough that a user who
* has already asked to quit is not left watching a terminal they can only kill
* from somewhere else.
*/
const EXIT_IDLE_TIMEOUT_MS = 5e3;
/**
* How long {@link ../index.ts | mountTui} waits for its configured agent to be
* created before it reports the stall and exits.
*
* The agent is created by another plugin (a provider adapter, a session
* restore), so this bound covers work the TUI cannot see: a provider whose
* initialization deadlocks emits neither `agent/created` nor
* `agent-loop/config-start-failed`, and every second past this one is a black
* screen with no explanation in it.
*/
const AGENT_START_TIMEOUT_MS = 3e4;
/**
* Settle when `idle` settles or when `timeoutMs` elapses, whichever is first.
*
* The exit path cancels the running turn and waits for the agent to report
* idle, so a session is never torn down mid-write. That wait is only as good as
* the driver's cancellation: an unbounded tool loop, or a stream that stalled
* without erroring, never reaches idle, and the wait then holds a terminal its
* user has already told to quit. Bounding it turns "wait for the turn" into
* "wait for the turn, but leave regardless", which is the only version of the
* promise the TUI can keep.
*
* A rejected `idle` counts as settled: the caller is leaving either way, and by
* then it has no surface left to report a failure on. The timer is unref'd
* because it exists to bound a wait, not to keep a process alive for one.
* @param idle - the agent's idle promise, already started by the caller.
* @param timeoutMs - how long the caller is willing to wait for it.
* @returns which of the two settled first.
*/
function whenIdleOrTimeout(idle, timeoutMs) {
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			resolve("timeout");
		}, timeoutMs);
		timer.unref();
		const settle = () => {
			clearTimeout(timer);
			resolve("idle");
		};
		idle.then(settle, settle);
	});
}
//#endregion
//#region src/i18n/persistence.ts
/**
* Where `/lang` keeps the language it was told, so the next process starts on
* it.
*
* Two stores, in this order:
*
* 1. **The harness settings document.** The Host owns a `locale` namespace with
*    one `preference` field (`@deepseek-ai/dsh-client-locale`), which is where
*    the web client's language switch already writes. When a settings provider
*    is mounted AND that namespace is registered, `/lang` writes there and the
*    two front doors agree about the language without either of them owning it.
* 2. **This bundle's own file**, `<dsh home>/tui-locale.json`. A terminal-only
*    deployment mounts neither the settings provider nor the locale plugin, and
*    a preference that survives only until exit is not a preference.
*
* The settings namespace is deliberately never registered from here. It belongs
* to the plugin that declares its schema; registering it as a side effect of
* opening a terminal would take the namespace away from its owner on the next
* mount and fail loud when both are present.
* @module @deepseek-ai/dsh-tui/i18n/persistence
*/
/** Settings namespace the Host's locale plugin owns; shared with the web client. */
const LOCALE_SETTINGS_NAMESPACE = "locale";
/** Field inside that namespace carrying an explicit selection. */
const LOCALE_PREFERENCE_FIELD = "preference";
/** Basename of the fallback document, under the harness home. */
const LOCALE_FILE_NAME = "tui-locale.json";
/**
* Absolute path of the fallback document.
*
* `$DSH_HOME` then `~/.dsh`, the harness's own precedence, so a deployment that
* relocated its home keeps every user file in one place. A blank override is
* treated as unset rather than resolving to the working directory.
* @returns the absolute document path.
*/
function localeFilePath() {
	const configured = process.env["DSH_HOME"]?.trim();
	const home = configured === void 0 || configured === "" ? join(homedir(), ".dsh") : configured;
	return resolve(join(home, LOCALE_FILE_NAME));
}
/**
* Read and write the preference as one small JSON document.
*
* Failures are swallowed on the read side and reported on the write side: a
* home directory that cannot be read is a terminal that starts in English,
* which is recoverable, while a `/lang` that silently failed to save would
* promise something it did not do.
* @param path - absolute document path.
* @returns the file-backed store.
*/
function fileLocaleStore(path) {
	return {
		origin: "file",
		load: () => {
			let raw;
			try {
				raw = readFileSync(path, "utf8");
			} catch (_neverWrittenOrUnreadable) {
				return;
			}
			try {
				const parsed = JSON.parse(raw);
				if (typeof parsed !== "object" || parsed === null) return void 0;
				const value = parsed["locale"];
				return isLocaleId(value) ? value : void 0;
			} catch (_malformedDocument) {
				return;
			}
		},
		save: async (locale) => {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, `${JSON.stringify({ locale }, void 0, 2)}\n`, "utf8");
			await Promise.resolve();
		}
	};
}
/**
* Read and write the preference through the Host's `locale` settings namespace.
* @param settings - the shape-checked settings service.
* @returns the settings-backed store.
*/
function settingsLocaleStore(settings) {
	return {
		origin: "settings",
		load: () => {
			const section = settings.get(LOCALE_SETTINGS_NAMESPACE);
			if (typeof section !== "object" || section === null) return void 0;
			const value = section[LOCALE_PREFERENCE_FIELD];
			return isLocaleId(value) ? value : void 0;
		},
		save: async (locale) => {
			await settings.update(LOCALE_SETTINGS_NAMESPACE, { [LOCALE_PREFERENCE_FIELD]: locale });
		}
	};
}
/**
* Pick the store this deployment can actually keep a preference in.
*
* The settings service wins only when the `locale` namespace is registered —
* `get` answers `undefined` for a namespace nobody owns, and `update` on one
* throws — so a settings provider mounted without the locale plugin still lands
* on the file rather than on a write that always fails.
* @param ctx - the runner context.
* @returns the store `/lang` reads and writes.
*/
function resolveLocaleStore(ctx) {
	const settings = ctx.get("settings");
	if (typeof settings?.get === "function" && typeof settings.update === "function" && settings.get("locale") !== void 0) return settingsLocaleStore(settings);
	return fileLocaleStore(localeFilePath());
}
//#endregion
//#region src/chat/lang-command.ts
/**
* Fold the spellings a user reasonably types into a shipped locale id.
*
* Region and script suffixes are dropped (`zh-CN`, `zh_Hans`, `en-US`) because
* this terminal ships one table per language and refusing `zh-CN` would be
* refusing the value the surrounding system already calls it.
* @param raw - the argument as typed.
* @returns the locale it names, or `undefined` when it names none.
*/
function normalizeLocaleInput(raw) {
	const base = raw.trim().toLowerCase().split(/[-_.]/u)[0] ?? "";
	return isLocaleId(base) ? base : void 0;
}
/** The locales `/lang` offers, as one list for the messages that name them. */
function localeOptions() {
	return LOCALE_IDS.join(", ");
}
/**
* Run one `/lang` invocation.
*
* Without an argument it reports the current language and what else is on
* offer; with one it switches, repaints (through the locale observers), and
* saves.
* @param rawInput - the argument text, exactly as typed.
* @param deps - the store and the warning sink.
* @returns the command result whose text the caller prints.
*/
function runLangCommand(rawInput, deps) {
	const typed = rawInput.trim();
	if (typed === "") {
		const active = currentLocale();
		return {
			kind: "success",
			text: t("lang.current", {
				name: localeName(active),
				id: active,
				options: localeOptions()
			})
		};
	}
	const next = normalizeLocaleInput(typed);
	if (next === void 0) return {
		kind: "error",
		text: t("lang.unknown", {
			value: displayInlineText(typed),
			options: localeOptions()
		})
	};
	if (!setLocale(next)) return {
		kind: "success",
		text: t("lang.unchanged", {
			name: localeName(next),
			id: next
		})
	};
	deps.store.save(next).catch((error) => {
		deps.reportSaveFailure(t("lang.saveFailed", { error: errorChain(error) }));
	});
	return {
		kind: "success",
		text: t("lang.switched", {
			name: localeName(next),
			id: next
		})
	};
}
//#endregion
//#region src/chat/modes.ts
/**
* The Shift+Tab mode cycle: one key over two axes the harness keeps apart.
*
* dsh has no "permission mode" enum. It has a permission preset table
* (`ctx.permissionPresets`, each name a `sandbox/mode` + `approval/policy`
* bundle) and, independently, plan mode (`ctx.planMode`, logged per agent as
* `plan/mode`). Claude Code's single Shift+Tab ladder is a *composition* of the
* two, so this module owns exactly that composition and nothing else: it reads
* the two axes as the services report them and answers which writes the next
* press should make. No mode is stored here — a terminal that kept its own
* copy would disagree with the session log the moment `/permission`, `/plan`,
* or another client moved an axis, and the badge above the prompt would be
* lying rather than reporting.
*
* The ladder is `normal → auto-accept → plan → normal`. Two deliberate holes
* in it:
*
* - **`danger-full-access` is not a rung.** A preset that turns the sandbox off
*   is a decision worth typing `/permission danger-full-access` for; reaching
*   it by pressing a key three times is how a user ends up there without
*   noticing. The cycle never selects it — and never selects *away* from it
*   either ({@link SessionMode} calls that state `other`): a session that opted
*   into a preset outside the ladder keeps it, and the key moves only plan mode.
* - **A missing axis collapses its rung.** A deployment that mounts no preset
*   table, or one without an `auto-accept` entry, still cycles plan mode; one
*   with no plan mode still toggles auto-accept. The key does what the mounted
*   services can do, rather than reporting an error the user cannot act on.
* @module @deepseek-ai/dsh-tui/chat/modes
*/
/**
* The preset the ladder treats as home: the workspace sandbox with approval
* asked for anything wider. `dsh-permission-presets` ships it as a default
* table entry, and the base bundle configures it by this name.
*/
const NORMAL_PRESET = "workspace-write";
/**
* The preset the auto-accept rung selects: the same workspace sandbox with the
* approval policy set to `never`, so tool calls inside it run unattended.
*
* Not a default of `dsh-permission-presets` — this bundle's `cordis.patch.yml`
* adds it to the table. Absent (an embedder composing the plugin itself), the
* rung drops out of the cycle instead of failing the press.
*/
const AUTO_ACCEPT_PRESET = "auto-accept";
/**
* Name the mode a pair of axis values composes to.
* @param axes - the two axes as the services report them.
* @returns the composed mode.
*/
function currentMode(axes) {
	if (axes.planActive) return "plan";
	if (axes.preset === "auto-accept") return "auto-accept";
	if (axes.preset === void 0 || axes.preset === "workspace-write") return "normal";
	return "other";
}
/**
* The next rung of the ladder from where the session is now.
* @param axes - the two axes as the services report them.
* @returns the writes to make and the mode they reach, or `undefined` when
* neither axis can move (no preset table with an auto-accept entry, and no plan
* mode) and the press has nothing to do.
*/
function nextMode(axes) {
	const canAutoAccept = axes.presets.includes(AUTO_ACCEPT_PRESET);
	const canNormal = axes.presets.includes(NORMAL_PRESET);
	let plan;
	let preset;
	switch (currentMode(axes)) {
		case "normal":
			if (canAutoAccept) preset = AUTO_ACCEPT_PRESET;
			else if (axes.planAvailable) plan = true;
			else return void 0;
			break;
		case "auto-accept":
			if (axes.planAvailable) plan = true;
			if (canNormal) preset = NORMAL_PRESET;
			if (plan === void 0 && preset === void 0) return void 0;
			break;
		case "plan":
			if (!axes.planAvailable) return void 0;
			plan = false;
			if (axes.preset === "auto-accept" && canNormal) preset = NORMAL_PRESET;
			break;
		case "other":
			if (!axes.planAvailable) return void 0;
			plan = true;
	}
	return {
		mode: currentMode({
			...axes,
			planActive: plan ?? axes.planActive,
			preset: preset ?? axes.preset
		}),
		...plan === void 0 ? {} : { plan },
		...preset === void 0 ? {} : { preset }
	};
}
//#endregion
//#region src/index.ts
/**
* Interactive pi-tui front door for DeepSeek Harness agents. It renders the
* durable session transcript, drives one agent it owns for the process, and
* provides keyboard-driven user-question dialogs.
*
* Unlike the upstream front door, this bundle owns the agent lifecycle: the
* `tui-runner` row reads the `tuiStartup` service parsed by `dsh-tui/startup`,
* creates or resumes the agent itself, and mounts the chat over it.
* @module dsh-tui
*/
/** First terminal Cordis state: FAILED, DISPOSED, and UNLOADING are unusable. */
const FIBER_FAILED = 3;
/**
* Context key a launcher sets before any Loader entry mounts
* (`ctx.provide(MAIN_SESSION_ID_KEY, identity)`) to fix the app agent's session
* identity, so an app bundle mounted from a `cordis.yml` binds a
* launcher-selected session without a config key. `ctx.provide` is the only
* channel from launcher argv into a Loader-mounted plugin, because config
* `!!js` expressions evaluate against the entry's context. Absent leaves the
* choice to the app (a `--resume`/`--continue` flag, else a fresh session).
*/
const MAIN_SESSION_ID_KEY = "mainSessionId";
/**
* Context key a launcher sets before any Loader entry mounts
* (`ctx.provide(TUI_GOODBYE_MESSAGE_KEY, line)`) to supply the line the TUI
* prints once the terminal is released on exit — for the shipped CLI, the
* command that resumes this session. The launcher owns the wording because only
* it knows how it was invoked; the TUI escapes terminal controls before
* rendering. Absent prints nothing.
*/
const TUI_GOODBYE_MESSAGE_KEY = "tuiGoodbyeMessage";
/**
* Context key a launcher sets before any Loader entry mounts
* (`ctx.provide(INITIAL_SKILL_KEY, name)`) to seed a fresh session's first user
* turn with `/skill:<name>`. The launcher sets it only when minting a fresh
* session, so it never re-fires on a resumed one. Absent leaves the first turn
* to the user.
*/
const INITIAL_SKILL_KEY = "tuiInitialSkill";
/**
* Optional terminal-local interaction service provided by one mounted TUI.
*
* The concrete provider retains pi-tui, focus, and terminal lifecycle state.
* Plugins receive only effect-owned overlay sessions.
*/
var TuiExtensionService = class extends Service {};
const name = "dsh-tui";
const inject = [
	"agents",
	"sessions",
	"commands",
	"userQuestions",
	"tools",
	"llm",
	"systemPrompt",
	"tokenMeter",
	"tuiStartup"
];
/** Model guidance for path-only file references selected through the TUI. */
const FILE_REFERENCE_PROMPT = "Paths prefixed with @ are files explicitly referenced by the user. Use the read tool when their contents are needed; do not claim to have inspected a file before reading it.";
/**
* Wall-clock time of the session's most recent logged event.
*
* Replaces the `lastActivityTime` helper the session package exported before
* rc.6: any append (including bookkeeping) moves it, and an empty log has none.
* @param session - the session whose log to read.
* @returns epoch milliseconds of the last event, or `undefined` for an empty log.
*/
function lastActivityTime(session) {
	return session.events.at(-1)?.time;
}
/**
* How long a transient confirmation (the Ctrl+O card cycle, the Ctrl+T thinking
* switch, the Ctrl+N plan toggle) stays on the status row before the row goes
* back to what it was showing.
*/
const STATUS_FLASH_MS = 1500;
/**
* How long a first Esc stays armed for the second one that clears the draft or
* opens Rewind. Claude Code's own double-press window, and short enough that
* two unrelated cancels are never mistaken for one gesture.
*/
const ESCAPE_DOUBLE_PRESS_MS = 800;
/**
* How long a first Ctrl+C at an empty prompt stays armed for the second one
* that exits. Long enough to be a deliberate second press, short enough that a
* Ctrl+C typed minutes later is a fresh intent rather than a stale half of one.
*/
const EXIT_CONFIRM_MS = 2e3;
/**
* Longest a "working on it" hint holds the status row when the command that
* armed it never settles. Not a deadline the command is held to — nothing is
* cancelled here — only the point past which an unanswered hint is more
* misleading than an empty row.
*/
const PENDING_HINT_MS = 3e4;
/**
* How long one listing serves slash-argument completion before it is read
* again. Long enough that typing a model name costs one provider catalog read
* rather than one per character, short enough that a session created in
* another window is offered by the time the user reaches for it.
*/
const ARGUMENT_COMPLETION_CACHE_MS = 3e3;
/**
* Smallest panel a short terminal still gets: three rows of chrome (the
* separating blank, the title, the hint) and two of content. A panel squeezed
* below this shows nothing it was opened for, which is worse than one that
* crowds the prompt.
*/
const MIN_PANEL_ROWS = 5;
/**
* How the debug and status surfaces name the Ctrl+T state.
*
* Message keys rather than the strings themselves: a `const` holding rendered
* text would freeze the locale it was imported under, so the lookup happens at
* render time through {@link t}.
*/
const THINKING_STATE_KEYS = {
	disabled: "status.thinking.disabled",
	pinned: "status.thinking.kept",
	live: "status.thinking.live"
};
/**
* Every key this terminal binds, as `/hotkeys`, `/help` and `?` list them.
*
* Built from the installed keybinding manager rather than written out, because
* a deployment can rebind any of these: a help page that named the default key
* after the user moved it would be worse than no help page. Only the keys this
* registry does not own — the editor's own, the ones a panel or a dialog binds
* while it has focus, and Ctrl+C, which is never rebindable — are spelled out.
* @param manager - the installed keybinding manager.
* @returns one line per group, in reading order.
*/
function keyboardShortcuts(manager) {
	const key = (action) => keyLabel(manager, action);
	return [
		t("hotkeys.editor"),
		t("hotkeys.entry"),
		t("hotkeys.history", {
			search: key("app.history.search"),
			transcript: key("app.transcript.search")
		}),
		t("hotkeys.cards", {
			cycle: key("app.tools.cycle"),
			thinking: key("app.thinking.toggle")
		}),
		t("hotkeys.modes", { mode: key("app.mode.cycle") }),
		t("hotkeys.copy", {
			todos: key("app.todos.toggle"),
			copy: key("app.message.copy"),
			redraw: key("app.screen.redraw")
		}),
		t("hotkeys.cancel", { cancel: key("app.cancel") }),
		t("hotkeys.exit", { exit: key("app.exit") }),
		t("hotkeys.interrupt"),
		t("hotkeys.interruptAgain"),
		t("hotkeys.panel"),
		t("hotkeys.question", { custom: t("dialog.question.customAnswer", { keys: CUSTOM_ANSWER_KEYS }) }),
		t("hotkeys.approval")
	];
}
/**
* Read the live default model selection, when a default-model service is
* mounted.
*
* Optional service: `agentDefaultModel` is not one of this bundle's injections,
* so it is read through the non-throwing accessor and shape-checked rather than
* typed. Called on every read of the selection, never cached: the service reads
* its user layer from a settings file that loads asynchronously, so a value
* captured while the TUI mounts is the bundle's inline default rather than the
* user's `agent-default-model`.
* @param ctx - the runner context.
* @returns the current default selection, or `undefined` when unavailable.
*/
function defaultModelSelection(ctx) {
	const selection = ctx.get("agentDefaultModel")?.currentSelection?.();
	if (selection === void 0) return void 0;
	const { provider, model, reasoningEffort } = selection;
	if (typeof provider !== "string" || typeof model !== "string") return void 0;
	return {
		provider,
		model,
		...typeof reasoningEffort === "string" ? { reasoningEffort } : {}
	};
}
/**
* The permission preset every tool call in this session is decided under, when
* a permission service is mounted.
*
* Optional service: `approval` is not one of this bundle's injections (a
* deployment can run without any permission seam), so it is read through the
* non-throwing accessor and shape-checked rather than typed. The session's own
* logged override wins over the deployment default, which is the same order the
* service resolves an ask under. Nothing readable prints no row at all: an
* invented "unknown" would read like a policy.
* @param ctx - the runner context.
* @param session - the session whose override applies.
* @returns the preset name, or `undefined` when no service reports one.
*/
function approvalPreset(ctx, session) {
	const service = ctx.get("approval");
	if (service === void 0) return void 0;
	const override = typeof service.overrideOf === "function" ? service.overrideOf(session) : void 0;
	const preset = typeof override === "string" ? override : service.config?.policy;
	return typeof preset === "string" && preset !== "" ? preset : void 0;
}
/**
* The events a permission switch writes: the recorded selection and the two
* knobs it bundles.
*
* Matched as strings rather than as event-map members because this bundle does
* not depend on the packages that declare them (`dsh-permission-presets`,
* `dsh-sandbox-policy`) — the same reason the service itself is read through
* `ctx.get`. A deployment without them simply never emits these.
*/
const PERMISSION_EVENTS = /* @__PURE__ */ new Set([
	"permission/preset",
	"approval/policy",
	"sandbox/mode"
]);
/**
* The route `--model` fixed for this process, when the flag was given.
*
* Read from the startup service rather than from {@link Config}: `Config` is
* the deployment's serializable presentation settings, while this is one
* process's command line, which is also why it is absent in an embedder.
* @param ctx - the runner context.
* @returns the explicit route, or `undefined` when none was given.
*/
function startupSelection(ctx) {
	const route = parseModelSelection(ctx.get("tuiStartup")?.model);
	return route === void 0 ? void 0 : {
		provider: route.provider,
		model: route.model
	};
}
/** Width/height adapter for a modal component rendered inside the base TUI flow. */
var InlineModalComponent = class extends Container {
	width;
	maxHeight;
	constructor(component, width, maxHeight) {
		super();
		this.width = width;
		this.maxHeight = maxHeight;
		this.addChild(component);
	}
	render(width) {
		return super.render(Math.max(1, Math.min(width, this.width))).slice(0, Math.max(1, this.maxHeight));
	}
};
/**
* Start the interactive pi-tui channel for an already-created target agent.
* @param ctx - agent, tools, session-event, and user-question context.
* @param config - target agent, banner, and TUI presentation config.
* @param runtime - terminal and process-exit boundary.
* @returns lifecycle controller used by the Cordis effect disposer.
*/
function createTuiChat(ctx, config, runtime) {
	const sessionId = SessionId(config.sessionId ?? "main");
	const agent = ctx.agents.get(sessionId);
	if (agent === void 0) throw new Error(`dsh-tui: session "${sessionId}" is not running`);
	const resolved = resolveTuiConfig(config);
	const keybindings = installKeybindings(resolved.keybindings);
	/**
	* The choices `/config` and `/theme` write, read once here so the first frame
	* is already painted in the theme the user picked in an earlier session.
	*
	* The report is deferred to a microtask: nothing exists to append a notice to
	* while the terminal is still being assembled.
	*/
	const preferences = openTuiPreferences(ctx, {}, (message) => {
		queueMicrotask(() => {
			if (!disposed) appendNotice(message, "warning");
		});
	});
	const storedPreferences = preferences.current();
	/**
	* The theme this terminal paints with, and the scheme the terminal itself
	* last reported. `auto` follows the report; the other three override it, so
	* both facts are kept — a user who returns to `auto` gets the terminal's own
	* answer back rather than whichever palette was forced over it.
	*/
	let themePreference = storedPreferences.theme;
	let reportedScheme = "dark";
	let appearance = resolveThemeAppearance(themePreference, reportedScheme, resolved.theme.color);
	const palette = createPalette(appearance.color, appearance.scheme);
	const mdTheme = markdownTheme(palette);
	const ui = new TuiMainScreen(runtime.terminal, resolved.showHardwareCursor);
	const chat = new Container();
	const todoContainer = new Container();
	const questionContainer = new Container();
	/**
	* Holds the mode badges — plan mode, auto-accept — while either is on, and
	* nothing at all otherwise: an empty container costs no row, which is what
	* keeps the prompt in the same place in the ordinary case.
	*
	* Both can be on at once. The Shift+Tab cycle never leaves them that way, but
	* `/permission auto-accept` and `/plan` are independent commands and the badge
	* strip reports what is true rather than what one key produces.
	*/
	const modeContainer = new Container();
	const inputTemplate = parseTuiPromptTemplate(displayInlineText(resolved.theme.inputPrompt));
	const renderInputPrompt = () => renderTuiPromptTemplate(inputTemplate, (valueName) => ctx.tuiPrompt.get(valueName));
	const editor = new HintEditor(ui, {
		borderColor: palette.dim,
		selectList: selectTheme(palette)
	}, { paddingX: 1 });
	editor.promptPrefix = renderInputPrompt();
	const todo = new TodoComponent(palette, () => runtime.terminal.rows);
	/**
	* The row above the prompt: a live compaction's stopwatch while one runs,
	* otherwise whatever transient confirmation is flashing, otherwise nothing.
	* View-state confirmations belong here rather than in the transcript — they
	* report the state of the screen, not something the conversation did.
	*/
	const statusLine = new Text("", 0, 0);
	let flashingStatus;
	/** Timer of an armed first Ctrl+C; while it runs, a second one exits. */
	let exitArmed;
	/** The status row's wording while that exit is armed, so disarming can take it down. */
	let armedAsk;
	/** Timer of an armed first Esc; while it runs, a second one clears or rewinds. */
	let escapeArmed;
	/** The status row's wording while that Esc is armed, so disarming can take it down. */
	let escapeAsk;
	/**
	* Whether the running turn has already been asked to stop (Esc, or a Ctrl+C
	* this terminal sent). Read by the Ctrl+C ladder to tell "cancel this turn"
	* from "this turn is not stopping, get me out"; cleared whenever the agent
	* leaves `running`.
	*/
	let cancelRequested = false;
	/**
	* The deployment's master switch over reasoning, read once and never moved.
	*
	* `showReasoning: false` means this transcript does not show reasoning at
	* all — no phase, no key, no command, no `/config` row — so it is a constant
	* here rather than the seed of a runtime toggle: a switch a user could flip
	* back on would make the setting a default rather than the policy it is meant
	* to be.
	*/
	const reasoningEnabled = resolved.showReasoning;
	/**
	* Ctrl+T and the `/config` panel's Thinking display row: whether finished
	* steps keep their thinking blocks on screen.
	*
	* A presentation switch and nothing else — the model reasons either way, and
	* flipping it re-renders the whole transcript, history included. Off (the
	* shipped default) is Claude Code's shape: thinking streams while the step
	* runs and goes with the step that produced it. A user who said otherwise in
	* `/config` opens on their own answer instead, unless the deployment took the
	* blocks away entirely.
	*/
	let thinkingPinned = reasoningEnabled && storedPreferences.thinkingPinned;
	let toolsVisibility = storedPreferences.toolCards;
	const stepTimingTracker = new StepTimingTracker();
	let runningStatus;
	let fadingStatus;
	/**
	* Live standalone compaction observed by this process. Never derive this
	* state from history: a resumed log may contain a stale orphaned start.
	*/
	let compacting;
	const pendingSteering = /* @__PURE__ */ new Map();
	let disposed = false;
	/**
	* Whether this terminal's agent left the registry while the terminal stayed.
	*
	* Separate from {@link disposed}, which means "this UI is going away" and
	* gates rendering: an agent can be retired under a live screen (an
	* agent-loop-only reload), and that screen still has to paint the refusal and
	* the `/resume` picker that gets the user out of it.
	*/
	let agentGone = false;
	let shuttingDown;
	const presetRoster = ctx.get("agentPresets");
	/**
	* The skill registry this session currently composes, resolved on every use.
	*
	* `serviceFor` returns the VALUE of whichever standing mount the agent's
	* scope pointed at when it was called, not a live handle: `/preset` re-links
	* a blank session to another preset's composition, and a registry captured
	* at mount would keep serving the preset the session opened on — `/skill:`
	* completion, invocation, and the banner would all name skills this agent no
	* longer has. Cheap enough to repeat: both arms are map lookups.
	* @returns the registry serving this agent now, or `undefined` when none is mounted.
	*/
	const skillRegistry = () => (typeof presetRoster?.serviceFor === "function" ? presetRoster.serviceFor(agent, "skills") : void 0) ?? ctx.get("skills");
	/**
	* Whether this deployment composes skills at all, decided once.
	*
	* Only the presence question is answered at mount — a profile without skills
	* never grows them, and a profile with them keeps the listener and the first
	* scan that a `/preset` switch later re-runs.
	*/
	const skillsAvailable = skillRegistry() !== void 0;
	const cwd = agent.session.header.cwd ?? process.cwd();
	/**
	* `fd` if this host has it, which is what makes `@` respect `.gitignore`:
	* pi's own provider shells out to it, and `fd` reads the ignore files the
	* repository already wrote. Resolved once per mount — a binary that appears
	* on `PATH` mid-session is not worth a `PATH` walk per keystroke.
	*/
	const fileSearchCommand = resolveFileSearchCommand(resolved.fileSearchCommand);
	/**
	* Where `/lang` keeps its answer for the next process. Resolved once: the
	* choice between the Host's settings document and this bundle's own file is a
	* property of the deployment, not of the moment the command runs.
	*/
	const localeStore = resolveLocaleStore(ctx);
	const storedLocale = localeStore.load();
	if (storedLocale !== void 0) setLocale(storedLocale);
	/**
	* The fallback index, used only when this host has no `fd`. It is built
	* either way so the tool-result listener can drop it without knowing which
	* source is live, and an unused index costs nothing: the traversal starts at
	* the first `@` query, which only the fallback ever issues.
	*/
	const fileSearch = new WorkspaceFileSearch(cwd, {
		maxResults: resolved.fileSearchMaxResults,
		maxEntries: resolved.fileSearchMaxEntries,
		excludedDirectories: resolved.fileSearchExcludedDirectories
	});
	/**
	* Name and arguments of every tool call this session has logged but not yet
	* answered, keyed by call id.
	*
	* The `@` index is dropped when a tool could have moved a file, and only
	* `tool/call` carries what tool that was — its `tool/result` names nothing
	* but the call id. Kept as narrowly as the question needs: entries are
	* removed as their results land (see the session listener).
	*/
	const inFlightToolCalls = /* @__PURE__ */ new Map();
	const skillAbort = new AbortController();
	const tokens = sessionTokens(agent.session);
	const commandControllers = /* @__PURE__ */ new Set();
	const referenceControllers = /* @__PURE__ */ new Set();
	let tuiServiceFiber;
	let pickedTarget = startupSelection(ctx);
	const target = {
		get current() {
			if (pickedTarget !== void 0) return pickedTarget;
			if (agent.session.requestHeader()?.config !== void 0) return initialTarget(agent);
			return defaultModelSelection(ctx) ?? initialTarget(agent);
		},
		set current(next) {
			pickedTarget = next;
		},
		assembled: void 0
	};
	let modelController;
	const now = () => runtime.now?.() ?? Date.now();
	const agentStatus = () => agent.status;
	const isDisposed = () => disposed;
	const store = new SessionStore(ctx, agent.session, agent);
	const transcript = new TranscriptReconciler(chat, {
		palette,
		mdTheme,
		scheme: () => appearance.scheme,
		markdown: {
			mode: resolved.markdownRenderer,
			theme: claudeMarkdownTheme,
			onError: (error) => {
				ctx.logger.warn(`dsh-tui: claude markdown renderer failed; falling back to pi for this process: ${errorChain(error)}`);
				queueMicrotask(() => {
					if (disposed) return;
					appendNotice(t("notice.markdownDegraded"), "warning");
				});
			}
		},
		maxToolOutputLines: resolved.maxToolOutputLines,
		maxDiffEditLength: resolved.maxDiffEditLength,
		events: () => agent.session.events,
		tracker: stepTimingTracker,
		now,
		toolDefinition: (name) => ctx.tools.get(name, agent),
		cwd,
		expandKey: () => keyLabel(keybindings, "app.tools.cycle")
	}, {
		showReasoning: reasoningEnabled,
		visibility: toolsVisibility,
		thinkingPinned
	});
	let sessionTitle = store.getSnapshot().title;
	const formattedCwd = displayText(runtime.formatCwd?.(agent.session.header.cwd) ?? formatCwd(agent.session.header.cwd));
	const resumedSessionId = agent.session.events.some((event) => event.type === "user/message") ? shortSessionId(agent.session.id) : void 0;
	const headerSkills = [];
	const header = new HeaderComponent({
		version: packageVersion(),
		model: () => {
			const current = target.current;
			return current === void 0 ? void 0 : compactTargetLabel(current);
		},
		cwd: formattedCwd,
		resumed: resumedSessionId,
		title: () => sessionTitle,
		...config.welcome === void 0 ? {} : { welcome: config.welcome },
		skills: headerSkills
	}, palette, () => appearance.color && resolved.theme.truecolor);
	const branch = runtime.gitBranch?.(cwd) ?? gitBranch(cwd);
	/**
	* The session's current goal, refolded only when a `goal/change` lands.
	*
	* `updatePromptValues` runs on every animation frame, so it must not fold the
	* whole log; a goal changes at most once per mutation, which is where the
	* refold belongs.
	*/
	let goalState = foldGoal(agent.session.events);
	/**
	* The session's measured context total, remeasured only when the log grew.
	*
	* `tokenMeter.measure` folds the whole session, and `updatePromptValues` runs
	* on every animation frame — 50 ms apart while a turn is live — so measuring
	* per frame is O(events) per frame on a log that a long session only makes
	* longer. A mounted chat's log is append-only, so its length is the version
	* of the thing being measured: same length, same measurement. The step-timing
	* tracker earns its frame budget the same way.
	*/
	let measuredContext;
	const contextTokens = () => {
		const events = agent.session.events.length;
		if (measuredContext?.events !== events) measuredContext = {
			events,
			totalTokens: ctx.tokenMeter.measure(agent.session).totalTokens
		};
		return measuredContext.totalTokens;
	};
	const promptValues = [
		ctx.tuiPrompt.register("cwd", palette.bold(palette.accent(formattedCwd))),
		ctx.tuiPrompt.register("git/worktree", branch === void 0 ? void 0 : palette.dim(` (${displayText(branch)})`)),
		ctx.tuiPrompt.register("token_meter/cache_hit_rate"),
		ctx.tuiPrompt.register("model"),
		ctx.tuiPrompt.register("context"),
		ctx.tuiPrompt.register("goal"),
		ctx.tuiPrompt.register("queued"),
		ctx.tuiPrompt.register("symbol", palette.bold(palette.accent("dsh"))),
		ctx.tuiPrompt.register("indicator", palette.dim("> "))
	];
	const [cwdValue, gitValue, tokenValue, modelValue, contextValue, goalValue, queuedValue, symbolValue, indicatorValue] = promptValues;
	/* v8 ignore next -- the fixed built-in registration list always supplies each handle. */
	if (cwdValue === void 0 || gitValue === void 0 || tokenValue === void 0 || modelValue === void 0 || contextValue === void 0 || goalValue === void 0 || queuedValue === void 0 || symbolValue === void 0 || indicatorValue === void 0) throw new Error("TUI prompt built-ins failed to initialize");
	const updatePromptValues = () => {
		const renderTime = now();
		cwdValue.set(palette.bold(palette.accent(formattedCwd)));
		gitValue.set(branch === void 0 ? void 0 : palette.dim(` (${displayText(branch)})`));
		const rate = cacheHitRate(tokens);
		const usage = `↑${formatTokens(tokens.input)} ↓${formatTokens(tokens.output)}`;
		modelValue.set(`  ${palette.dim(displayText(target.current === void 0 ? t("prompt.modelUnset") : compactTargetLabel(target.current)))}`);
		tokenValue.set(`  ${palette.dim(rate === void 0 ? usage : `${usage}  ${t("prompt.cache", { rate })}`)}`);
		const contextWindow = modelController.contextWindow();
		contextValue.set(contextWindow === void 0 ? void 0 : `  ${palette.dim(t("prompt.context", { percent: Math.min(100, Math.round(contextTokens() / contextWindow * 100)) }))}`);
		const goalFragment = formatGoalPrompt(goalState.goal);
		goalValue.set(goalFragment === void 0 ? void 0 : `  ${palette.dim(goalFragment)}`);
		const queued = runningStatus === void 0 ? void 0 : formatQueuedStatus(pendingSteering.size);
		queuedValue.set(queued === void 0 ? void 0 : palette.dim(queued));
		symbolValue.set(palette.bold(palette.accent("dsh")));
		statusLine.setText(compacting !== void 0 ? palette.dim(t("prompt.compacting", { duration: formatStatusDuration(renderTime - compacting.startedAt) })) : flashingStatus === void 0 ? "" : palette.dim(displayText(flashingStatus.text)));
		const statusGlyph = runningPhaseGlyph(agent.session.events, runningStatus !== void 0, compacting !== void 0);
		if (runningStatus !== void 0 && statusGlyph !== void 0) runningStatus.lastGlyph = statusGlyph;
		const activeSince = runningStatus?.startedAt ?? compacting?.startedAt;
		const envelope = activeSince !== void 0 && statusGlyph !== void 0 ? {
			glyph: statusGlyph,
			level: Math.min(1, (renderTime - activeSince) / 300)
		} : fadingStatus !== void 0 ? {
			glyph: fadingStatus.glyph,
			level: Math.max(0, 1 - (renderTime - fadingStatus.endedAt) / 300)
		} : void 0;
		const caret = envelope === void 0 ? palette.dim(">") : fadeGlyph(envelope.glyph, palette, appearance.color, appearance.color && resolved.theme.truecolor, envelope.level * pulseLevel(renderTime), envelope.level >= .5);
		indicatorValue.set(`${caret}${palette.dim(" ")}`);
	};
	const promptContext = new PromptContextComponent(parseTuiPromptTemplate(displayInlineText(resolved.theme.leftPrompt)), parseTuiPromptTemplate(displayInlineText(resolved.theme.rightPrompt)), (valueName) => ctx.tuiPrompt.get(valueName));
	ui.addChild(header);
	ui.addChild(chat);
	ui.addChild(new Spacer(1));
	todoContainer.addChild(todo);
	ui.addChild(todoContainer);
	ui.addChild(statusLine);
	ui.addChild(modeContainer);
	ui.addChild(promptContext);
	ui.addChild(editor);
	ui.addChild(questionContainer);
	ui.setFocus(editor);
	const updateTerminalTitle = () => {
		runtime.terminal.setTitle(displayText(sessionTitle === void 0 ? resolved.title : `${sessionTitle} — ${resolved.title}`));
	};
	updateTerminalTitle();
	/**
	* The editor's rendered height, measured at most once per frame.
	*
	* Every surface that shares the screen with the input frame sizes itself
	* against it, and each asks more than once per render (a panel derives its
	* viewport, the clamp on its scroll offset, and its page size from the same
	* budget) while `Editor.render` caches nothing. The measurement is dropped by
	* `requestRender` and re-taken on either terminal dimension, so an edit or a
	* resize cannot serve a stale height. Both dimensions, not just the width: a
	* draft taller than the editor's own scroll budget is clipped to a share of
	* the terminal's rows, so a purely vertical resize moves the height too, and
	* pi-tui's resize path asks the screen to repaint without coming through
	* `requestRender`.
	*/
	let editorRowsFrame;
	const editorRowCount = () => {
		const columns = runtime.terminal.columns;
		const terminalRows = runtime.terminal.rows;
		if (editorRowsFrame?.columns === columns && editorRowsFrame.terminalRows === terminalRows) return editorRowsFrame.rows;
		const rows = editor.render(columns).length;
		editorRowsFrame = {
			columns,
			terminalRows,
			rows
		};
		return rows;
	};
	const requestRender = () => {
		if (disposed) return;
		updatePromptValues();
		editor.promptPrefix = renderInputPrompt();
		editorRowsFrame = void 0;
		promptContext.invalidate();
		ui.requestRender();
	};
	const disposePromptChanges = ctx.tuiPrompt.subscribe(requestRender);
	/**
	* Report a terminal-local outcome (a command result, a failed skill load) in
	* the transcript. Anything the session log records instead reaches the screen
	* as a folded notice node; this is only for what the log never sees.
	*/
	const appendNotice = (message, kind = "info") => {
		transcript.appendLocal(() => {
			const color = kind === "error" ? palette.error : kind === "warning" ? palette.warning : palette.dim;
			return [new Spacer(1), new Text(color(displayText(message)), 0, 0)];
		});
		requestRender();
	};
	/**
	* The two ways out of a session whose agent is gone, named by every refusal
	* that mentions it.
	*
	* A disposed agent (an agent-loop reload, a host that retired it) leaves this
	* TUI mounted over a session that can still be read and can no longer run a
	* turn. Reporting only the refusal made that a dead end: every submission
	* failed and nothing on screen said what to do about it. `/resume` swaps this
	* chat for another session without leaving the process, and the exit key ends
	* it — read from the manager, since a deployment may have moved it.
	* @returns The recovery sentence, in the active locale.
	*/
	const disposedRecovery = () => t("notice.disposedRecovery", { exit: keyLabel(keybindings, "app.exit") });
	/** Stop the flash timer and clear the transient text it was showing. */
	const clearFlash = () => {
		if (flashingStatus === void 0) return;
		clearTimeout(flashingStatus.timer);
		flashingStatus = void 0;
	};
	/**
	* Confirm a view-state change on the status row for {@link STATUS_FLASH_MS},
	* then restore the row.
	*
	* View state (which cards are visible, whether reasoning renders) is a
	* property of the screen, not of the conversation: repeating its
	* confirmations into the transcript pushed the conversation up the screen
	* every time the user cycled Ctrl+O, which is exactly when they are reading
	* it. A later flash replaces an earlier one rather than queueing.
	* @param message - the confirmation to show.
	* @param duration - how long to hold the row; a message that announces a
	*   window the user can act inside must outlive that window rather than the
	*   default, or the row goes quiet while the key it named is still armed.
	*/
	const flashStatus = (message, duration = STATUS_FLASH_MS) => {
		clearFlash();
		flashingStatus = {
			text: message,
			timer: setTimeout(() => {
				flashingStatus = void 0;
				requestRender();
			}, duration)
		};
		requestRender();
	};
	/**
	* Say that an asynchronous command is working, and hand back the way to stop
	* saying it.
	*
	* `/status` folds the whole system prompt and `/model` reads every registered
	* provider's catalog; either can take a visible beat, and until its panel
	* opened the screen carried no evidence the key press had landed at all. The
	* ordinary flash window is the wrong shape for this — a hint that expires
	* mid-assembly reads as "your command was dropped" — so the row is held for
	* the work's own duration, with {@link PENDING_HINT_MS} only as a backstop.
	*
	* The settle callback clears the row only while it is still showing this
	* message: a later flash (a Ctrl+O cycle, an armed exit) owns the row from
	* the moment it lands, and a slow command settling afterwards must not wipe
	* something the user just did.
	* @param message - what the command is doing, in the present tense.
	* @returns the callback that takes the hint back down.
	*/
	const flashPending = (message) => {
		flashStatus(message, PENDING_HINT_MS);
		return () => {
			if (flashingStatus?.text !== message) return;
			clearFlash();
			requestRender();
		};
	};
	/**
	* The last answer this session produced, as plain text.
	*
	* Read from the store's own snapshot rather than the rendered rows: what the
	* user wants on their clipboard is the model's text, not the markdown the
	* terminal painted from it. Steps that produced only tool calls carry no
	* text, so the search walks back to the last one that did.
	* @returns the answer, or `undefined` before this session has one.
	*/
	const lastAnswerText = () => {
		const { nodes } = store.getSnapshot();
		for (let index = nodes.length - 1; index >= 0; index -= 1) {
			const node = nodes[index];
			if (node?.kind !== "assistant" || node.text.trim() === "") continue;
			return displayText(node.text);
		}
	};
	/**
	* Put the last answer on the system clipboard (`/copy`, Ctrl+X).
	*
	* The escape sequence the clipboard port returns is written straight to the
	* terminal, outside the frame: it is an instruction to the terminal
	* emulator, not a cell the renderer owns, and a synchronized update would
	* make it part of a frame that pi-tui may redraw. The confirmation names the
	* path the copy actually took, because on a remote host "copied" and "loaded
	* into the tmux buffer" are different things to the person reading it.
	*/
	const copyLastAnswer = () => {
		const text = lastAnswerText();
		if (text === void 0) {
			flashStatus(t("status.flash.nothingToCopy"));
			return;
		}
		const path = clipboardPath();
		copyToClipboard(text).then((sequence) => {
			if (disposed) return;
			runtime.terminal.write(sequence);
			flashStatus(path === "native" ? t("status.flash.copied", { count: text.length }) : t(path === "tmux-buffer" ? "status.flash.copiedTmux" : "status.flash.copiedOsc52"));
		}, (error) => {
			/* v8 ignore next 2 -- the clipboard port collapses every subprocess failure into an exit code. */
			if (!disposed) appendNotice(t("notice.copyFailed", { error: errorChain(error) }), "error");
		});
	};
	const extensionTheme = Object.freeze({
		text: (value) => palette.text(value),
		brand: (value) => appearance.color ? resolved.theme.truecolor ? brandText(value) : palette.brand(value) : value,
		dim: (value) => palette.dim(value),
		accent: (value) => palette.accent(value),
		success: (value) => palette.success(value),
		warning: (value) => palette.warning(value),
		error: (value) => palette.error(value),
		bold: (value) => palette.bold(value)
	});
	const overlayManager = new TuiOverlayManager({
		viewport: () => Object.freeze({
			columns: runtime.terminal.columns,
			rows: runtime.terminal.rows
		}),
		theme: () => extensionTheme,
		display: displayText,
		show: (component, options, placement) => {
			if (placement === "overlay") return ui.showOverlay(component, options === void 0 ? void 0 : {
				...options,
				...typeof options.margin === "object" ? { margin: { ...options.margin } } : {}
			});
			const modal = new InlineModalComponent(component, typeof options?.width === "number" ? options.width : resolved.questionDialogWidth, typeof options?.maxHeight === "number" ? options.maxHeight : resolved.questionDialogMaxHeight);
			questionContainer.clear();
			questionContainer.addChild(modal);
			ui.setFocus(component);
			return { hide() {
				questionContainer.clear();
				ui.setFocus(editor);
			} };
		},
		invalidate: requestRender,
		reportError: (error) => {
			const message = errorChain(error);
			ctx.logger.warn(`dsh-tui: overlay failed: ${message}`);
			/* v8 ignore next -- shutdown removes overlays before the terminal stops */
			if (disposed) return;
			appendNotice(t("notice.overlayFailed", { error: message }), "error");
		}
	});
	const disposeTargetListeners = installModelSelection(agent.ctx, target);
	modelController = createModelController({
		ctx,
		resolved,
		palette,
		overlayManager: dismissableOverlays(overlayManager),
		target,
		appendNotice,
		flashPending,
		requestRender,
		isDisposed
	});
	const presetController = createPresetController({
		ctx,
		resolved,
		palette,
		overlayManager: dismissableOverlays(overlayManager),
		agent,
		appendNotice,
		requestRender,
		isDisposed
	});
	updatePromptValues();
	const renderStatus = () => {
		transcript.invalidateOpenStep();
		requestRender();
	};
	/** Stop the turn-phase running and fade-out timers and drop both states. */
	const clearTurnStatus = () => {
		if (runningStatus !== void 0) {
			clearInterval(runningStatus.timer);
			runningStatus = void 0;
		}
		if (fadingStatus !== void 0) {
			clearInterval(fadingStatus.timer);
			fadingStatus = void 0;
		}
		runtime.terminal.setProgress(compacting !== void 0);
	};
	/** Hard clear: drop every indicator, including a live compaction bracket. */
	const clearStatus = () => {
		if (compacting !== void 0) {
			clearInterval(compacting.timer);
			compacting = void 0;
		}
		clearFlash();
		disarmExit();
		clearTurnStatus();
	};
	/**
	* Hand the last active glyph to a fade-out that re-renders until it settles
	* on the `>` caret, then stops its own timer. A hard clear (teardown) skips
	* this via {@link clearStatus}.
	*/
	const beginFadeOut = (glyph) => {
		clearTurnStatus();
		const fading = {
			glyph,
			endedAt: now(),
			timer: setInterval(() => {
				if (now() - fading.endedAt >= 300) clearTurnStatus();
				renderStatus();
			}, 50)
		};
		fadingStatus = fading;
	};
	const setStatus = (status) => {
		const priorTurn = runningStatus?.turn;
		const fadeOutGlyph = status !== "running" ? runningStatus?.lastGlyph : void 0;
		if (status !== "running") cancelRequested = false;
		if (status === "running") clearTurnStatus();
		else if (fadeOutGlyph !== void 0) beginFadeOut(fadeOutGlyph);
		else clearTurnStatus();
		editor.borderColor = status === "running" ? (text) => palette.accent(text) : (text) => palette.dim(text);
		editor.hint = status === "running" ? palette.dim(displayInlineText(resolved.theme.inputPlaceholder)) : void 0;
		if (status === "running") {
			runningStatus = {
				turn: priorTurn ?? openTurn(agent.session.events),
				startedAt: now(),
				lastGlyph: TIMING_BUCKET_GLYPHS[openStepPhase(agent.session.events) ?? "ttft"],
				timer: setInterval(renderStatus, 50)
			};
			runtime.terminal.setProgress(true);
		}
		requestRender();
	};
	const refreshStatus = () => {
		renderStatus();
	};
	/** Plan mode as the last published snapshot folded it out of the session log. */
	let loggedPlanMode = false;
	/**
	* The permission preset table and switch, when a deployment composes one.
	*
	* Resolved per call, not captured: `ctx.get` is a store lookup, and a service
	* that arrived or left through an HMR reload has to be seen by the next press
	* rather than by the next process.
	* @returns the service, or `undefined` when no preset table is mounted.
	*/
	const permissionPresets = () => ctx.get("permissionPresets");
	/**
	* The plan-mode service for THIS agent.
	*
	* Addressed through the preset roster first, for the same reason the skill
	* registry is: a preset composition mounts plan mode behind an `isolate`
	* realm (the shipped `standard` preset declares `isolate: { planMode: true }`),
	* which is invisible to a host context. The host lookup is the fallback for a
	* profile that mounts plan mode on the host plane instead.
	* @returns the service serving this agent now, or `undefined` when none is mounted.
	*/
	const planModeService = () => (typeof presetRoster?.serviceFor === "function" ? presetRoster.serviceFor(agent, "planMode") : void 0) ?? ctx.get("planMode");
	/**
	* Both axes as the services report them right now.
	*
	* Nothing here is remembered between calls — that is the whole point. The
	* permission axis is the service's own derivation over the session log, and
	* the plan axis is the logged fold widened by a queued selection, so a cycle
	* driven mid-turn advances instead of repeating its last transition.
	* @returns the axes {@link nextMode} decides from.
	*/
	const modeAxes = () => {
		const presets = permissionPresets();
		const plan = planModeService();
		const preset = typeof presets?.current === "function" ? presets.current(agent.session.events) : void 0;
		const state = typeof plan?.get === "function" ? plan.get(agent) : void 0;
		return {
			planActive: typeof state?.pending === "boolean" ? state.pending : typeof state?.active === "boolean" ? state.active : loggedPlanMode,
			planAvailable: typeof plan?.set === "function",
			preset: typeof preset === "string" && preset !== "" ? preset : void 0,
			presets: Array.isArray(presets?.names) ? presets.names : []
		};
	};
	/**
	* The hint the badges carry, naming whichever key the action resolved to.
	* @returns the parenthesised hint, or `undefined` when a deployment unbound
	* the action — a hint pointing at nothing is worse than no hint.
	*/
	const modeCycleHint = () => {
		return keybindings.getKeys("app.mode.cycle").length === 0 ? void 0 : t("transcript.modeCycleHint", { key: keyLabel(keybindings, "app.mode.cycle") });
	};
	/** The flash each reached mode reports itself with. */
	const MODE_FLASH = {
		normal: "status.flash.modeNormal",
		"auto-accept": "status.flash.modeAutoAccept",
		plan: "status.flash.modePlan",
		other: "status.flash.modePlanOff"
	};
	/**
	* Advance the composed mode one rung (Shift+Tab).
	*
	* The two writes are the services' own: `permissionPresets.set` records the
	* selection and moves whichever knob changed, `planMode.set` appends or queues
	* `plan/mode`. Nothing is written here, so `/permission`, `/plan`, a resumed
	* log, and this key all end up saying the same thing.
	*
	* The permission switch is deliberately the log-only `set(session, name)`
	* rather than the `/permission` command's live path: the difference is one
	* injected "the approval policy changed" user message aimed at the model, and
	* the model already reads the policy from its own prompt section on every
	* request. What the user needs to see is the badge, which this repaints.
	*/
	const cycleMode = () => {
		const next = nextMode(modeAxes());
		if (next === void 0) {
			flashStatus(t("status.flash.modeUnavailable"));
			return;
		}
		let queued = false;
		try {
			if (next.preset !== void 0) permissionPresets()?.set?.(agent.session, next.preset);
			if (next.plan !== void 0) queued = planModeService()?.set?.(agent, next.plan) === "queued";
		} catch (error) {
			appendNotice(t("status.flash.modeFailed", { error: errorChain(error) }), "error");
			applyModeBadges();
			requestRender();
			return;
		}
		applyModeBadges();
		requestRender();
		flashStatus(t(queued && next.mode === "plan" ? "status.flash.modePlanQueued" : MODE_FLASH[next.mode]));
	};
	/**
	* Mount or drop the mode badges for the axes as they stand now.
	*
	* Rebuilt rather than toggled so the rows are painted with whatever palette
	* and scheme are current — a color-scheme change goes through here on the same
	* snapshot every other row is remounted from.
	*
	* The plan axis comes from the fold ({@link loggedPlanMode}) widened by any
	* selection queued for the next step: pressing the key mid-turn has to move
	* the badge, or the key reads as broken. The permission axis is re-derived
	* from the service on every call rather than mirrored, because `/permission`,
	* a resumed log, and another client all move it without this terminal being
	* the one that asked.
	*/
	const applyModeBadges = () => {
		modeContainer.clear();
		const axes = modeAxes();
		const rows = [];
		if (axes.planActive) rows.push((hint) => planModeRow(palette, appearance.scheme, hint));
		if (axes.preset === "auto-accept") rows.push((hint) => autoAcceptRow(palette, appearance.scheme, hint));
		const hint = modeCycleHint();
		for (const [index, row] of rows.entries()) modeContainer.addChild(new Text(row(index === rows.length - 1 ? hint : void 0), 0, 0));
	};
	/**
	* Apply one published snapshot: the reconciler re-places the transcript, the
	* plan strip, the mode badges and header read the session aggregates.
	* This is the whole event-to-screen path — nothing else writes chat rows.
	* @param snapshot - The published snapshot.
	* @param options - `repaint` rebuilds rows that no aggregate reports moved:
	*   the mode badges hold the palette and the locale they were built under, so
	*   a theme or language change asks for them explicitly.
	*/
	const applySnapshot = (snapshot, options = {}) => {
		transcript.reconcile(snapshot.nodes);
		todo.update(snapshot.todos ?? []);
		const planChanged = snapshot.planMode !== loggedPlanMode;
		loggedPlanMode = snapshot.planMode;
		if (planChanged || options.repaint === true) applyModeBadges();
		if (snapshot.title !== sessionTitle) {
			sessionTitle = snapshot.title;
			header.invalidate();
			updateTerminalTitle();
		}
	};
	const disposeSnapshots = store.subscribe(() => {
		if (disposed) return;
		applySnapshot(store.getSnapshot());
		requestRender();
	});
	/**
	* Rows a question dialog may take: the configured ceiling, or whatever the
	* editor leaves when the terminal is shorter than that.
	*
	* Read per render rather than captured, because both terms move: the terminal
	* is resizable and the editor grows with the draft in it.
	* @returns the row budget, never below one.
	*/
	const questionMaxHeight = () => Math.max(1, Math.min(resolved.questionDialogMaxHeight, runtime.terminal.rows - editorRowCount()));
	const questions = createQuestionQueue({
		ctx,
		resolved,
		palette,
		overlayManager,
		requestRender,
		isDisposed,
		questionMaxHeight
	});
	/**
	* Tools the user granted for the rest of this session, by tool name.
	*
	* Terminal-side by necessity: rc.6's approval vocabulary is one-shot only
	* (`allowed-once` with no `allow-always`, no rule table, no grant store —
	* `@deepseek-ai/dsh-user-approval` README, "Only one-shot grants exist"), and
	* its session policy is the single `ask`/`never` switch `/permission` moves.
	* So "don't ask again" is remembered here and spent as one `'allowed-once'`
	* per later ask, which is exactly what the seam would have received had the
	* user answered each prompt by hand.
	*
	* Process-lifetime and this-agent only: it is not logged, so resuming the
	* session or opening it in another client starts from asking again. That is
	* the honest scope for a grant no durable layer can revoke.
	*/
	const sessionApprovals = /* @__PURE__ */ new Set();
	/**
	* Interactive answerer for this agent's permission questions. The dialog goes
	* through the same single-modal slot as the ask-user-question queue, so an
	* approval and a question can never occupy the prompt area at once and
	* concurrent asks are served FIFO.
	*
	* Every path that ends the dialog without an answer — the asker withdrawing
	* the request (`req.signal`), TUI teardown, a failed component — settles the
	* request as `'cancelled'`, so an unanswered prompt releases the tool call
	* instead of hanging the turn.
	*/
	const disposeApprovals = ctx.on("approval/request", (req, next) => {
		if (req.agent.session.id !== agent.session.id) return next();
		if (disposed) return next();
		if (sessionApprovals.has(req.toolName)) return Promise.resolve("allowed-once");
		return new Promise((resolveOutcome) => {
			let settled = false;
			let overlay;
			const settle = (outcome) => {
				if (settled) return;
				settled = true;
				overlay?.close();
				resolveOutcome(outcome);
			};
			overlay = overlayManager.open({
				...req.signal === void 0 ? {} : { signal: req.signal },
				create: () => new ApprovalDialog({
					toolName: req.toolName,
					...req.callId === void 0 ? {} : { callId: req.callId },
					...req.reason === void 0 ? {} : { reason: req.reason }
				}, palette, (decision) => {
					settle(decision.outcome);
					if (decision.outcome === "allowed-once") {
						if (!decision.remember) return;
						sessionApprovals.add(req.toolName);
						appendNotice(`Allowing ${displayText(req.toolName)} for the rest of this session in this terminal. Restarting or resuming asks again.`);
						return;
					}
					if (decision.feedback === void 0) return;
					dispatchMessage([{
						type: "text",
						text: decision.feedback
					}]);
				}),
				options: {
					width: resolved.questionDialogWidth,
					maxHeight: resolved.questionDialogMaxHeight
				}
			}, "inline");
			overlay.closed.then(() => {
				settle("cancelled");
			});
		});
	});
	const sessionQueryService = () => {
		const implementation = ctx.reflect._getImpl("sessionQuery", false);
		if (implementation === void 0 || implementation.fiber.state >= FIBER_FAILED) return void 0;
		return ctx.get("sessionQuery", false);
	};
	const resume = createResumeController({
		ctx,
		agent,
		runtime,
		resolved,
		palette,
		overlayManager,
		sessionQuery: sessionQueryService,
		ui,
		editor,
		appendNotice,
		requestRender,
		isDisposed,
		agentStatus
	});
	const shutdown = (exitProcess) => {
		shuttingDown ??= (async () => {
			disposed = true;
			overlayManager.beginShutdown();
			modelController.resetContextResolution();
			clearStatus();
			for (const controller of commandControllers) controller.abort(/* @__PURE__ */ new Error("TUI disposed"));
			commandControllers.clear();
			for (const controller of referenceControllers) controller.abort(/* @__PURE__ */ new Error("TUI disposed"));
			referenceControllers.clear();
			await tuiServiceFiber?.dispose();
			tuiServiceFiber = void 0;
			questions.rejectAll();
			await overlayManager.dispose();
			modelController.clearOverlay();
			presetController.clearOverlay();
			questions.unregister();
			await runtime.terminal.drainInput(100, 20);
			ui.stop();
			if (exitProcess) {
				if (runtime.goodbyeMessage !== void 0) runtime.terminal.write(`${palette.dim(displayText(runtime.goodbyeMessage))}\n`);
				if (ctx.get("sessionPersistence") !== void 0) {
					const command = resumeCommandLine(agent.session.id);
					runtime.terminal.write(`${palette.dim(displayText(t("exit.resumeHint", { command })))}\n`);
				}
				runtime.exit(0);
			}
		})();
		return shuttingDown;
	};
	/**
	* Leave, after the running turn has been cancelled and given a bounded chance
	* to end itself.
	*
	* The wait exists so a session is never torn down mid-write; the bound exists
	* because the wait is only as good as the driver's cancellation. An unbounded
	* tool loop or a stalled stream never reports idle, and the unbounded version
	* of this left the terminal owned by a TUI that had already said it was
	* leaving — an exit the user could only complete by killing the process from
	* somewhere else. `shutdown` is idempotent, so whichever of the two settles
	* first ends the session and the other becomes a no-op.
	*/
	const requestExit = () => {
		if (agent.status === "running") {
			cancelActiveTurn();
			appendNotice(t("status.flash.cancellingBeforeExit"), "warning");
			whenIdleOrTimeout(agent.whenIdle(), EXIT_IDLE_TIMEOUT_MS).then((outcome) => {
				if (outcome === "timeout") ctx.logger.warn(`dsh-tui: the cancelled turn did not reach idle within ${String(EXIT_IDLE_TIMEOUT_MS)}ms; exiting anyway`);
				shutdown(true);
			});
			return;
		}
		shutdown(true);
	};
	/**
	* Cancel the running turn and remember that a cancel is outstanding.
	*
	* The memory is what turns the Ctrl+C ladder into an escape hatch instead of
	* a loop: a driver that honors the cancel reaches idle and clears this (see
	* {@link setStatus}), so the next press starts the ordinary two-press exit,
	* while one that does not leaves it set — and the press after that can offer
	* to leave without it.
	*/
	const cancelActiveTurn = () => {
		cancelRequested = true;
		agent.cancel({ kind: "user" });
	};
	/**
	* Drop the armed first Ctrl+C, so the next one asks again instead of exiting.
	*
	* The row goes with it. An ask that outlives its window is the same lie in
	* reverse as one that expires early: it names a key that no longer exits,
	* while the press it invites now does something else entirely (cancel the
	* turn that just started).
	*/
	const disarmExit = () => {
		if (exitArmed === void 0) return;
		clearTimeout(exitArmed);
		exitArmed = void 0;
		if (flashingStatus?.text === armedAsk) {
			clearFlash();
			requestRender();
		}
		armedAsk = void 0;
	};
	/**
	* Arm the second Ctrl+C for {@link EXIT_CONFIRM_MS} and say so.
	*
	* Ctrl+C at an empty prompt used to end the session on the first press, which
	* is one mistyped Ctrl+V away from throwing away a conversation that is still
	* on screen. Claude Code asks for the key twice, and so does this: the first
	* press only arms the second, and the window closes on its own.
	*
	* The row holds the ask for the whole window rather than the default flash:
	* a hint that vanished half a second early left the exit armed with nothing
	* on screen saying so, which is the same surprise exit this replaced.
	* @param ask - the wording the row holds, which differs between the idle exit
	*   and the running session's escape hatch because the two do different
	*   things to the turn that is still open.
	*/
	const armExit = (ask) => {
		disarmExit();
		exitArmed = setTimeout(() => {
			exitArmed = void 0;
		}, EXIT_CONFIRM_MS);
		armedAsk = ask;
		flashStatus(ask, EXIT_CONFIRM_MS);
	};
	/**
	* Rebuild the palette and every theme derived from it, when the two inputs
	* that decide it — the stored `/theme` choice and the terminal's own report —
	* resolve to something other than what is on screen.
	*/
	const repaint = () => {
		const next = resolveThemeAppearance(themePreference, reportedScheme, resolved.theme.color);
		if (next.scheme === appearance.scheme && next.color === appearance.color) return;
		appearance = next;
		Object.assign(palette, createPalette(next.color, next.scheme));
		Object.assign(mdTheme, markdownTheme(palette));
		transcript.reset();
		applySnapshot(store.getSnapshot(), { repaint: true });
		setStatus(agent.status);
		requestRender();
	};
	/** Record what the terminal says about itself; `auto` is what acts on it. */
	const applyColorScheme = (scheme) => {
		reportedScheme = scheme;
		repaint();
	};
	/**
	* Paint one theme, without saving it — the preview the selector runs on every
	* highlight move, and the path `/theme <id>` and the `/config` row commit
	* through {@link saveThemePreference}.
	*/
	const applyThemePreference = (theme) => {
		themePreference = theme;
		repaint();
	};
	/** Paint one theme and keep it: the choice a user made outlives the process. */
	const saveThemePreference = (theme) => {
		applyThemePreference(theme);
		preferences.save({ theme });
		flashStatus(t("theme.applied", { theme }));
	};
	const disposeSchemeListener = ui.onTerminalColorSchemeChange(applyColorScheme);
	ui.queryTerminalColorScheme({ timeoutMs: 2e3 }).catch(() => {});
	/**
	* Move the tool-card phase, and optionally make it this user's default.
	*
	* The two callers want different reaches, which is why the write is a
	* parameter rather than a rule: Ctrl+O is a look at the conversation in front
	* of you and stays in this session, while the `/config` row is the phase
	* every future session opens on. A key that wants to write the default opts
	* in here rather than persisting behind the cycle.
	* @param next - the phase to enter.
	* @param options - `persist` writes it to the settings document as well.
	*/
	const setToolsVisibility = (next, options) => {
		toolsVisibility = next;
		transcript.setVisibility(toolsVisibility);
		if (options?.persist === true) preferences.save({ toolCards: toolsVisibility });
		flashStatus(cardPhaseNotice(toolsVisibility));
	};
	const toggleTools = () => {
		setToolsVisibility(toolsVisibility === "collapsed" ? "expanded" : toolsVisibility === "expanded" ? "hidden" : "collapsed");
	};
	/**
	* Show the plan's items or its one-line summary (Ctrl+N).
	*
	* The panel used to be unconditional, so a session with a long plan spent the
	* rows above the prompt on it from the moment the agent wrote one until the
	* moment it cleared it, with no key that took it back down.
	*/
	const toggleTodos = () => {
		if (!todo.hasTodos()) {
			flashStatus(t("status.flash.planEmpty"));
			return;
		}
		todo.setExpanded(!todo.isExpanded());
		todo.invalidate();
		flashStatus(t(todo.isExpanded() ? "status.flash.planExpanded" : "status.flash.planCollapsed"));
		requestRender();
	};
	/**
	* Keep or drop thinking blocks across the whole transcript (Ctrl+T, and the
	* `/config` panel's Thinking display row).
	*
	* Purely presentational: the model reasons whatever this says, and every
	* mounted step re-renders in place, so a running stream keeps streaming while
	* history gains or loses its asides. Independent of the Ctrl+O card cycle —
	* pinned thinking survives the hidden phase, and expanded still brings
	* thinking back on its own while the pin is off.
	* @param pinned - Whether a finished step keeps its thinking on screen.
	* @param options - `persist` writes the choice to the settings document as
	*   well, which is what `/config` means and what the key does not: Ctrl+T is
	*   "show me now", the panel row is "from now on".
	*/
	const setThinking = (pinned, options) => {
		if (!reasoningEnabled) {
			flashStatus(t("status.flash.thinkingDisabled"));
			return;
		}
		thinkingPinned = pinned;
		transcript.setThinkingPinned(thinkingPinned);
		if (options?.persist === true) preferences.save({ thinkingPinned });
		flashStatus(t(thinkingPinned ? "status.flash.thinkingPinned" : "status.flash.thinkingUnpinned"));
	};
	const toggleThinking = () => {
		setThinking(!thinkingPinned);
	};
	/** The Ctrl+T state as the debug and status surfaces report it. */
	const thinkingStateLabel = () => t(!reasoningEnabled ? THINKING_STATE_KEYS.disabled : thinkingPinned ? THINKING_STATE_KEYS.pinned : THINKING_STATE_KEYS.live);
	/**
	* The theme selector `/theme` opens and the `/config` panel's Theme row
	* enters, in the editor slot like every other interactive surface.
	*
	* One selector, two doors: a value picked here is painted while the highlight
	* moves and written on Enter, so the two entries cannot drift into two
	* different vocabularies for the same four themes.
	*
	* The preview is undone from here rather than from the dialog, because the
	* dialog is not told when it goes away: the surface is `dismissable`, so a
	* permission prompt or a question arriving mid-selection takes the slot back
	* through `close()` without routing a key through `handleInput`. Restoring on
	* `closed` covers that path and the dialog's own Esc alike — the screen and
	* the stored preference cannot end up disagreeing.
	*/
	let themeOverlay;
	const showThemeSelector = () => {
		themeOverlay?.close();
		const opened = themePreference;
		let committed = false;
		const session = overlayManager.open({
			create: () => new ThemeDialog(themePreference, palette, applyThemePreference, (theme) => {
				committed = true;
				saveThemePreference(theme);
			}, () => {
				session.close();
			}),
			options: { width: resolved.settingsDialogWidth },
			dismissable: true
		}, "inline");
		themeOverlay = session;
		session.closed.then(() => {
			if (themeOverlay === session) themeOverlay = void 0;
			if (!committed && themePreference !== opened) applyThemePreference(opened);
		});
		requestRender();
	};
	/**
	* `/theme [auto|light|dark|no-color]`: the selector without an argument, and
	* the named theme with one, so a user who knows what they want does not have
	* to walk a list to get it.
	* @param rawInput - everything typed after the command name.
	* @returns success, or the refusal naming the four values.
	*/
	const runTheme = (rawInput) => {
		const token = rawInput.trim();
		if (token === "") {
			showThemeSelector();
			return { kind: "success" };
		}
		if (!isThemePreference(token)) return {
			kind: "error",
			text: t("theme.unknown", {
				value: displayInlineText(token),
				options: THEME_PREFERENCES.join("|")
			})
		};
		saveThemePreference(token);
		return { kind: "success" };
	};
	/**
	* The row budget one panel may occupy, read per render so a resize applies.
	* Bounded by the inline slot's own clip, which is what actually decides how
	* much of a component the terminal shows.
	*/
	const panelRows = () => Math.max(MIN_PANEL_ROWS, Math.min(resolved.questionDialogMaxHeight, runtime.terminal.rows - editorRowCount()));
	let panelOverlay;
	/**
	* Show one page of pre-rendered lines under the editor, in the inline slot.
	*
	* These commands answer a question about the session — its status, its
	* palette, its keys — rather than adding to the conversation, so their output
	* is a view that opens and closes. Dumping it into the transcript pushed the
	* conversation off screen and left the answer stranded in the log above every
	* later reply.
	* @param title - the panel heading.
	* @param lines - already-rendered content rows.
	*/
	const showPanel = (title, lines) => {
		panelOverlay?.close();
		const session = overlayManager.open({
			create: () => new ScrollablePanel(title, lines, panelRows, palette, () => {
				session.close();
			}),
			dismissable: true
		}, "inline");
		panelOverlay = session;
		session.closed.then(() => {
			if (panelOverlay === session) panelOverlay = void 0;
		});
		requestRender();
	};
	const showHotkeys = () => {
		showPanel("/hotkeys", keyboardShortcuts(keybindings).map((line) => palette.dim(line)));
	};
	/**
	* What this terminal knows about itself (Shift+Ctrl+D).
	*
	* pi-tui dispatches that key ahead of focus and overlays, so this is the one
	* surface reachable from any state — which is exactly what a debug dump is
	* for. It reports what a bug report needs and nothing the transcript already
	* shows: identity, lifecycle, log size, screen, and the resolved keys, since a
	* rebound key is the first thing to suspect when a key "does nothing".
	*/
	const showDebug = () => {
		const conflicts = keybindings.getConflicts();
		const shadowed = keybindingCollisions(keybindings);
		showPanel("debug (shift+ctrl+d)", [
			`session ${displayText(agent.session.id)} · agent ${agent.status}${agentGone ? " · detached" : ""}`,
			`events ${String(agent.session.events.length)} · context ${String(Math.round(contextTokens()))} tokens`,
			`terminal ${String(runtime.terminal.columns)}x${String(runtime.terminal.rows)} · editor ${String(editorRowCount())} rows`,
			`theme ${themePreference} · painting ${appearance.scheme}${appearance.color ? "" : " · no color"} · terminal reports ${reportedScheme}`,
			`cards ${toolsVisibility} · thinking ${thinkingStateLabel()} · plan ${todo.isExpanded() ? "expanded" : "collapsed"}`,
			`overlay ${overlayManager.hasActiveOverlay() ? "active" : "none"} · pending steering ${String(pendingSteering.size)}`,
			`locale ${currentLocale()} · preference stored in ${localeStore.origin}`,
			"",
			...Object.keys(APP_KEYBINDINGS).map((action) => `${action} → ${keyLabel(keybindings, action)}`),
			...conflicts.length === 0 ? [] : ["", ...conflicts.map((conflict) => `conflict: ${conflict.key} claimed by ${conflict.keybindings.join(", ")}`)],
			...shadowed.length === 0 ? [] : ["", ...shadowed.map((hit) => `shadows pi-tui: ${hit.key} (${hit.action}) hides ${hit.shadowed.join(", ")}`)]
		].map((line) => palette.dim(line)));
	};
	ui.onDebug = showDebug;
	const showHelp = () => {
		const commandLines = ctx.commands.list(agent).map((command) => {
			const input = command.input === void 0 ? "" : ` ${command.input.hint}`;
			return `/${command.name}${input} — ${commandDescription(command.name, command.description)}`;
		});
		showPanel("/help", [
			...keyboardShortcuts(keybindings),
			"",
			...commandLines,
			t("help.skill")
		].map((line) => palette.dim(line)));
	};
	const showPalette = () => {
		showPanel("/palette", renderPalette(palette, appearance.scheme, appearance.color));
	};
	/**
	* The Loader inventory, read fresh on every `/plugins`.
	*
	* `pluginInventory` is a host mount the TUI never requires, so this is a
	* `ctx.get` rather than an injection, and the panel explains its own absence.
	* Unlike the pre-rendered panels above, this one keeps the keyboard for its
	* own filter box and per-entry detail, so it mounts its own component in the
	* same dismissable inline slot.
	*/
	const showPlugins = () => {
		const inventory = ctx.get("pluginInventory");
		panelOverlay?.close();
		const session = overlayManager.open({
			create: () => new PluginsPanel(inventory?.list(), panelRows, palette, () => {
				session.close();
			}),
			dismissable: true
		}, "inline");
		panelOverlay = session;
		session.closed.then(() => {
			if (panelOverlay === session) panelOverlay = void 0;
		});
		requestRender();
	};
	/**
	* Search this session's own messages (`/search`, the transcript-search key).
	*
	* The entries are flattened from the store's current snapshot rather than
	* kept as an index: the panel is opened by a keypress, the snapshot it reads
	* is the one on screen, and an index maintained beside the fold would be one
	* more thing that can disagree with the transcript. A session with nothing to
	* search still opens the panel, which says so — a keypress that appears to do
	* nothing teaches the wrong thing about the key.
	* @param query - the `/search` argument, prefilled into the panel's query box.
	*/
	const showTranscriptSearch = (query) => {
		const entries = transcriptEntries(store.getSnapshot().nodes);
		panelOverlay?.close();
		const session = overlayManager.open({
			create: () => new TranscriptSearchPanel(entries, query, panelRows, palette, () => {
				session.close();
			}),
			dismissable: true
		}, "inline");
		panelOverlay = session;
		session.closed.then(() => {
			if (panelOverlay === session) panelOverlay = void 0;
		});
		requestRender();
	};
	/**
	* The `/config` rows, rebuilt per open so a value changed elsewhere — Ctrl+O,
	* `/theme`, `/model` — is the value the panel shows.
	*
	* Deliberately short. This is the terminal's own presentation, not the
	* harness's configuration: everything a deployment sets in `cordis.yml` and
	* everything a session decides through its own command stays where it is, and
	* a row that another command owns says so rather than growing a second way to
	* set it.
	* @returns the entries in display order.
	*/
	const settingsEntries = () => [
		{
			kind: "toggle",
			label: t("settings.thinking"),
			value: () => thinkingPinned,
			set: (next) => {
				setThinking(next, { persist: true });
				requestRender();
			}
		},
		{
			kind: "choice",
			label: t("settings.toolCards"),
			options: TOOL_CARD_PHASES,
			value: () => toolsVisibility,
			format: (phase) => t(`settings.toolCards.${phase}`),
			set: (next) => {
				/* v8 ignore next -- the options are TOOL_CARD_PHASES, so every value is one. */
				if (next !== "collapsed" && next !== "expanded" && next !== "hidden") return;
				setToolsVisibility(next, { persist: true });
				requestRender();
			}
		},
		{
			kind: "submenu",
			label: t("settings.theme"),
			value: () => themePreference,
			open: showThemeSelector
		},
		{
			kind: "notice",
			label: t("settings.language"),
			value: () => localeName(currentLocale()),
			hint: "(/lang)"
		},
		{
			kind: "notice",
			label: t("settings.model"),
			value: () => target.current === void 0 ? t("settings.model.unset") : targetLabel(target.current),
			hint: "(/model)"
		}
	];
	/**
	* The settings panel, in the same inline slot every other panel takes.
	*
	* Changes apply as they are made — there is no OK button, because there is
	* nothing to confirm: each row is one value, already live on the screen
	* behind the panel, and already written.
	*/
	const showSettings = () => {
		panelOverlay?.close();
		const session = overlayManager.open({
			create: () => new SettingsPanel(settingsEntries(), panelRows, palette, () => {
				session.close();
			}),
			dismissable: true
		}, "inline");
		panelOverlay = session;
		session.closed.then(() => {
			if (panelOverlay === session) panelOverlay = void 0;
		});
		requestRender();
	};
	/**
	* The skill catalog behind `/skills`, scanned per open.
	*
	* Every read goes through {@link skillRegistry}, so the panel lists what this
	* agent composes right now — a `/preset` switch changes the answer, and a
	* catalog captured at mount would name skills `/skill:` refuses. Both the
	* listing and one skill's body are provider reads that can be slow or fail:
	* the panel opens first and is filled as they land, and a body that arrives
	* after its overlay closed is dropped by the aborted scan.
	*/
	const showSkills = () => {
		const registry = skillRegistry();
		if (registry === void 0) {
			appendNotice(t("skills.unavailable"), "warning");
			return;
		}
		panelOverlay?.close();
		const scan = new AbortController();
		let panel;
		let scanned;
		const lookup = () => ({
			cwd,
			scope: agent,
			signal: scan.signal
		});
		const session = overlayManager.open({
			create: () => {
				panel = new SkillsPanel(scanned, panelRows, palette, (name) => {
					registry.get(name, lookup()).then((skill) => {
						if (disposed || scan.signal.aborted) return;
						panel?.setDetail(name, skill === void 0 ? {
							kind: "failed",
							message: t("skills.unknown", { name })
						} : {
							kind: "ready",
							skill
						});
						requestRender();
					}, (error) => {
						if (disposed || scan.signal.aborted) return;
						panel?.setDetail(name, {
							kind: "failed",
							message: t("skills.loadFailed", {
								name,
								error: errorChain(error)
							})
						});
						requestRender();
					});
				}, () => {
					session.close();
				});
				return panel;
			},
			dismissable: true
		}, "inline");
		panelOverlay = session;
		session.closed.then(() => {
			scan.abort();
			if (panelOverlay === session) panelOverlay = void 0;
		});
		requestRender();
		registry.list(lookup()).then((summaries) => {
			if (disposed || scan.signal.aborted) return;
			scanned = [...summaries].sort((a, b) => a.name.localeCompare(b.name));
			panel?.setSkills(scanned);
			requestRender();
		}, (error) => {
			if (disposed || scan.signal.aborted) return;
			session.close();
			appendNotice(t("skills.scanFailed", { error: errorChain(error) }), "error");
		});
	};
	/**
	* The MCP inventory, folded out of the tool names this agent can see.
	*
	* The registry view is read directly rather than through the system prompt
	* assembly `/status` uses: the assembly runs every prompt section to get the
	* same names, and this panel needs nothing else from it. `schemas` is the
	* scoped view, so a preset that restricts a server's tools away reports what
	* this agent may actually call rather than what the process registered.
	*/
	const showMcp = () => {
		const names = agent.ctx.tools.schemas(agent).map((tool) => tool.name);
		showPanel("/mcp", [...renderMcpPanel(names, palette)]);
	};
	/**
	* Environment self-check (`/doctor`): what this session is running ON.
	*
	* Every input is read here and handed over as a value, so the checks stay a
	* pure function of the environment they describe. The one asynchronous check
	* is the route resolution, which is the only thing that proves an adapter
	* answers for the selected model rather than merely being registered.
	*/
	const showDoctor = async () => {
		const settleHint = flashPending(t("doctor.flash.running"));
		const checks = await runDoctorChecks({
			nodeVersion: process.version,
			stdinTty: process.stdin.isTTY === true,
			stdoutTty: process.stdout.isTTY === true,
			columns: runtime.terminal.columns,
			rows: runtime.terminal.rows,
			color: appearance.color,
			truecolor: appearance.color && resolved.theme.truecolor,
			providers: ctx.llm.listProviders().map((provider) => provider.id),
			route: target.current,
			resolveModelInfo: (provider, model) => ctx.llm.resolveModelInfo(provider, model),
			persistence: ctx.get("sessionPersistence") !== void 0,
			presets: ctx.get("agentPresets") !== void 0,
			preset: presetController.currentPreset()
		}).finally(settleHint);
		/* v8 ignore next -- disposal during the awaited resolution is covered by command-owner teardown tests. */
		if (disposed) return;
		showPanel("/doctor", [...renderDoctorPanel(checks, palette)]);
	};
	const showStatus = async (signal) => {
		const settleHint = flashPending(t("status.flash.collecting"));
		const assembly = await ctx.systemPrompt.assemble(assembleContextFor(agent, signal)).finally(settleHint);
		/* v8 ignore next -- disposal during the awaited assembly is covered by command-owner teardown tests. */
		if (disposed) return;
		/* v8 ignore next -- SystemPrompt always emits at least its required base section. */
		const systemPrompt = displayText(renderPrompt(assembly)) || "(empty)";
		const registeredTools = assembly.tools.map((tool) => displayText(tool.name)).join(", ") || "(none)";
		const events = agent.session.events;
		const latestActivity = lastActivityTime(agent.session) ?? agent.session.header.createdAt;
		const usedContext = Math.max(0, Math.round(contextTokens()));
		let context = t("status.contextUnknown", { used: formatDiagnosticNumber(usedContext) });
		const contextWindow = modelController.contextWindow();
		if (contextWindow !== void 0) {
			const contextPercent = Math.round(usedContext / contextWindow * 100);
			context = t("status.contextValue", {
				meter: diagnosticMeter(contextPercent, palette),
				percent: contextPercent,
				used: formatDiagnosticNumber(usedContext),
				capacity: formatDiagnosticNumber(contextWindow)
			});
		}
		const rate = cacheHitRate(tokens);
		const turns = events.filter((event) => event.type === "turn/start").length;
		const steps = events.filter((event) => event.type === "step/start").length;
		const toolCalls = events.filter((event) => event.type === "tool/call").length;
		const model = target.current === void 0 ? t("settings.model.unset") : displayText(targetLabel(target.current));
		const effort = target.current === void 0 ? t("settings.model.unset") : target.current.reasoningEffort === void 0 ? t("status.effort.default") : displayText(target.current.reasoningEffort);
		const stats = ctx.get("sessionProjections")?.snapshot(agent.session).values.sessionStats;
		const preset = modeAxes().preset ?? approvalPreset(ctx, agent.session);
		const agentPreset = presetController.currentPreset();
		const groups = [
			[
				[t("status.row.session"), displayText(agent.session.id)],
				[t("status.row.title"), displayText(sessionTitle ?? t("status.untitled"))],
				[t("status.row.directory"), displayText(cwd)],
				[t("status.row.model"), `${model} ${palette.dim(t("status.modelDetail", {
					effort,
					thinking: thinkingStateLabel()
				}))}`],
				...agentPreset === void 0 ? [] : [[t("status.row.preset"), displayText(agentPreset)]],
				...preset === void 0 ? [] : [[t("status.row.permission"), displayText(preset)]],
				...goalStatusRows(goalState.goal, goalState.roundsStarted)
			],
			[[t("status.row.agent"), [
				agent.status,
				formatDiagnosticCount(events.length, "status.count.event"),
				formatDiagnosticCount(turns, "status.count.turn"),
				formatDiagnosticCount(steps, "status.count.step"),
				formatDiagnosticCount(toolCalls, "status.count.toolCall")
			].join(" · ")], ...stats === void 0 ? [] : [[t("status.row.sessionTotals"), formatSessionStats(stats)]]],
			[
				[t("status.row.tokens"), t("status.tokensValue", {
					input: formatDiagnosticNumber(tokens.input),
					output: formatDiagnosticNumber(tokens.output)
				})],
				[t("status.row.kvCache"), rate === void 0 ? t("status.cacheUnavailable", {
					read: formatDiagnosticNumber(tokens.cacheRead),
					write: formatDiagnosticNumber(tokens.cacheWrite)
				}) : t("status.cacheValue", {
					meter: diagnosticMeter(rate, palette),
					rate,
					read: formatDiagnosticNumber(tokens.cacheRead),
					write: formatDiagnosticNumber(tokens.cacheWrite)
				})],
				[t("status.row.context"), context]
			],
			[[t("status.row.created"), formatDiagnosticTime(agent.session.header.createdAt)], [t("status.row.active"), formatDiagnosticTime(latestActivity)]]
		];
		const cardWidth = Math.max(8, runtime.terminal.columns - 2);
		showPanel("/status", [
			...new StatusCardComponent(groups, palette).render(cardWidth),
			"",
			palette.bold(palette.accent(t("status.systemPrompt"))),
			...systemPrompt.split("\n"),
			"",
			palette.bold(palette.accent(t("status.registeredTools"))),
			registeredTools
		]);
	};
	let skillCommands = [];
	let skillCommandScan = 0;
	/** Advertised routes, read once per typing burst rather than per keystroke. */
	const listModelRoutes = memoizeListing((provider) => ctx.llm.listModels(provider), ARGUMENT_COMPLETION_CACHE_MS);
	/**
	* Every persisted session reduced to metadata `/resume` completion can rank.
	*
	* Titles come from the projection cache's already-written checkpoint rows
	* only. A cold projection would fold a log tail, and a menu rendered between
	* two keystrokes has no business reading logs — an untitled row falls back
	* to its id, which is what the argument carries anyway.
	*/
	const listResumeSessions = memoizeListing(async () => {
		const service = sessionQueryService();
		if (service === void 0) return [];
		const cache = ctx.get("sessionProjectionCache");
		return (await service.listSessions()).map((record) => {
			const cached = cache?.cachedSnapshot(record.header);
			const title = cached !== void 0 && "title" in cached.values ? cached.values.title : void 0;
			return {
				id: record.header.id,
				...record.header.cwd === void 0 ? {} : { cwd: record.header.cwd },
				createdAt: record.header.createdAt,
				live: record.live,
				...typeof title === "string" ? { title } : {}
			};
		});
	}, ARGUMENT_COMPLETION_CACHE_MS);
	/**
	* The argument completion source for one command, or `undefined` for a
	* command whose argument is free text (or that takes none).
	*
	* `argumentHint` describes the shape of an argument; these say which values
	* exist in THIS session, so `/model `, `/preset `, `/theme `, and
	* `/resume ` offer the same rows their pickers would. Optional services are
	* read inside the closure, not captured: the roster and the session store
	* mount independently of the command registry, so a source resolved when the
	* provider was built could be stale by the time a user types.
	*
	* Skills need nothing here: they are commands named `skill:<name>`, so the
	* name-completion branch already lists them from `/skill:`.
	* @param name - the registered command name.
	* @returns the argument completion source, when this terminal has one.
	*/
	const argumentCompletionsFor = (name) => {
		switch (name) {
			case "model": return (prefix) => modelArgumentCompletions({
				listProviders: () => ctx.llm.listProviders(),
				listModels: listModelRoutes
			}, prefix, resolved.maxModelOptions);
			case "preset": return (prefix) => {
				const presets = ctx.get("agentPresets");
				return presets === void 0 ? null : presetArgumentCompletions(presets, prefix, resolved.maxModelOptions);
			};
			case "theme": return themeArgumentCompletions;
			case "lang": return langArgumentCompletions;
			case "resume": return (prefix) => resumeArgumentCompletions({
				list: () => listResumeSessions("sessions"),
				currentSessionId: agent.session.id,
				cwd: agent.session.header.cwd
			}, prefix, resolved.maxResumeOptions);
			default: return;
		}
	};
	const refreshCommandAutocomplete = () => {
		const base = new CombinedAutocompleteProvider([...ctx.commands.list(agent).map((command) => {
			const getArgumentCompletions = argumentCompletionsFor(command.name);
			return {
				name: command.name,
				description: commandDescription(command.name, command.description),
				...command.input === void 0 ? {} : { argumentHint: command.input.hint },
				...getArgumentCompletions === void 0 ? {} : { getArgumentCompletions }
			};
		}), ...skillCommands], agent.session.header.cwd ?? process.cwd(), fileSearchCommand ?? null);
		const sessionReferences = ctx.get("sessionReferenceResolver");
		editor.setAutocompleteProvider(new ReferenceAutocompleteProvider(base, fileSearchCommand === void 0 ? fileSearch : void 0, sessionReferences, agent));
	};
	const refreshVisibleSlashAutocomplete = () => {
		const cursor = editor.getCursor();
		const textBeforeCursor = editor.getLines().slice(cursor.line, cursor.line + 1).join("").slice(0, cursor.col);
		if (cursor.line === 0 && textBeforeCursor.startsWith("/") && !textBeforeCursor.includes(" ")) editor.handleInput("	");
	};
	const disposeCommandChanges = ctx.on("commands/change", refreshCommandAutocomplete);
	refreshCommandAutocomplete();
	/**
	* Repaint everything after a language switch.
	*
	* The same rebuild a color-scheme change does, and for the same reason:
	* transcript rows cache the strings they were built with, so a component that
	* is already mounted keeps rendering the previous language until it is
	* remounted from its node. The slash menu is rebuilt too, because its
	* descriptions are translated on the way into it.
	*/
	const disposeLocaleChanges = onLocaleChange(() => {
		if (disposed) return;
		transcript.reset();
		applySnapshot(store.getSnapshot(), { repaint: true });
		refreshCommandAutocomplete();
		requestRender();
	});
	const refreshSkillCommands = () => {
		const scan = ++skillCommandScan;
		const service = skillRegistry();
		if (service === void 0) return;
		service.snapshot({
			cwd,
			scope: agent,
			signal: skillAbort.signal
		}).then((snapshot) => {
			if (disposed || scan !== skillCommandScan || !snapshot.complete) return;
			const invocable = snapshot.skills.filter((skill) => skill.invocation.userInvocable);
			skillCommands = invocable.map((skill) => ({
				name: `skill:${skill.name}`,
				description: skill.description,
				argumentHint: skill.source.startsWith("project-") ? "(project)" : "(user)"
			}));
			headerSkills.length = 0;
			headerSkills.push(...invocable.map((skill) => skill.name));
			header.invalidate();
			refreshCommandAutocomplete();
			refreshVisibleSlashAutocomplete();
			requestRender();
		}, () => {});
	};
	const disposeSkillChanges = skillsAvailable ? ctx.on("skills/change", () => {
		refreshSkillCommands();
	}) : () => {};
	if (skillsAvailable) refreshSkillCommands();
	/**
	* Put a yes/no decision to the user on the same surface a model's question
	* uses, and answer it.
	*
	* The question dialog is reused rather than a confirmation widget of its own:
	* a user who has answered one option list in this terminal knows this one, and
	* the two would otherwise diverge on navigation, cancelling, and width. Every
	* way out that is not the affirmative option — Esc, a closed overlay, a
	* disposed terminal — answers no, because these prompts guard destructive
	* work and silence must never mean "go ahead".
	* @param question - the decision, phrased as a question.
	* @param confirmLabel - the option that means yes; every other answer means no.
	* @param declineLabel - the option that means no, offered so cancelling is not the only refusal.
	* @returns whether the user chose the affirmative option.
	*/
	const askConfirmation = (question, confirmLabel, declineLabel) => {
		if (disposed) return Promise.resolve(false);
		return new Promise((resolveAnswer) => {
			let settled = false;
			const settle = (answer) => {
				if (settled) return;
				settled = true;
				resolveAnswer(answer);
			};
			const session = overlayManager.open({
				create: () => new QuestionDialog({
					id: "tui-confirm",
					question,
					options: [{ label: confirmLabel }, { label: declineLabel }]
				}, 1, 1, 1, resolved.maxQuestionOptions, questionMaxHeight, palette, (selection) => {
					session.close();
					settle(selection.selected.includes(confirmLabel));
				}, () => {
					session.close();
					settle(false);
				}),
				options: {
					width: resolved.questionDialogWidth,
					maxHeight: resolved.questionDialogMaxHeight
				}
			}, "inline");
			session.closed.then(() => {
				settle(false);
			});
			requestRender();
		});
	};
	/**
	* Start over in a blank session (`/new`), leaving this one resumable.
	*
	* Deliberately not called "clear": nothing below this UI can truncate a
	* session log, so the only honest way to start with an empty context is a new
	* session, and the one being left is flushed and kept rather than emptied. A
	* host that cannot replace the mounted agent says so instead of clearing the
	* screen and leaving the model's context exactly as full as it was.
	* @returns the command result the notice column reports.
	*/
	const startNewSession = () => {
		const start = runtime.handoffNew;
		if (start === void 0) return {
			kind: "error",
			text: t("notice.newSessionUnsupported")
		};
		if (agent.status !== "idle") return {
			kind: "error",
			text: t("notice.newSessionBusy", { status: agent.status })
		};
		appendNotice(t("notice.newSession"));
		start().catch((error) => {
			/* v8 ignore next -- a handoff that fails after teardown has no screen left to report on. */
			if (!disposed) appendNotice(t("notice.newSessionFailed", { error: errorChain(error) }), "error");
		});
		return { kind: "success" };
	};
	const commandFiber = agent.ctx.inject(["commands"], (commandCtx) => {
		commandCtx.commands.register({
			name: "help",
			description: "Show keyboard shortcuts and commands",
			handler: () => {
				showHelp();
				return { kind: "success" };
			}
		});
		commandCtx.commands.register({
			name: "hotkeys",
			description: "Show the keyboard shortcuts alone",
			handler: () => {
				showHotkeys();
				return { kind: "success" };
			}
		});
		commandCtx.commands.register({
			name: "model",
			description: "Switch the model and save it as your default",
			input: { hint: "[[provider/]model]" },
			handler: ({ rawInput }) => {
				modelController.queueModelCommand(rawInput);
				return { kind: "success" };
			}
		});
		commandCtx.commands.register({
			name: "preset",
			description: "Show, switch, or copy this session's agent preset",
			input: { hint: "[<preset> | copy <preset> <new-id>]" },
			handler: ({ rawInput }) => {
				presetController.queuePresetCommand(rawInput);
				return { kind: "success" };
			}
		});
		commandCtx.commands.register({
			name: "copy",
			description: "Copy the last answer to the system clipboard",
			handler: () => {
				copyLastAnswer();
				return { kind: "success" };
			}
		});
		commandCtx.commands.register({
			name: "new",
			description: "Start a blank session in this workspace (this one stays resumable)",
			handler: () => startNewSession()
		});
		commandCtx.commands.register({
			name: "clear",
			description: "Clear the transcript view (session history is unchanged)",
			handler: () => {
				transcript.clearTranscript();
				requestRender();
				return { kind: "success" };
			}
		});
		commandCtx.commands.register({
			name: "config",
			description: "Change this terminal's settings, saved for your next session",
			handler: () => {
				showSettings();
				return { kind: "success" };
			}
		});
		commandCtx.commands.register({
			name: "theme",
			description: "Pick the palette this terminal paints with",
			input: { hint: "[auto|light|dark|no-color]" },
			handler: ({ rawInput }) => runTheme(rawInput)
		});
		commandCtx.commands.register({
			name: "lang",
			description: "Show or switch the interface language",
			input: { hint: "[en|zh]" },
			handler: ({ rawInput }) => runLangCommand(rawInput, {
				store: localeStore,
				reportSaveFailure: (message) => {
					appendNotice(message, "warning");
				}
			})
		});
		commandCtx.commands.register({
			name: "palette",
			description: "Show every color and attribute role this terminal renders",
			handler: () => {
				showPalette();
				return { kind: "success" };
			}
		});
		commandCtx.commands.register({
			name: "export",
			description: "Write this session's log to a file and report the path",
			input: { hint: "[path]" },
			handler: ({ rawInput, signal }) => exportSessionLog({
				persistence: ctx.get("sessionPersistence"),
				sessions: ctx.get("sessions"),
				cwd,
				confirmOverwrite: (destination) => askConfirmation(t("export.overwrite.question", { path: displayInlineText(destination) }), t("export.overwrite.replace"), t("export.overwrite.keep"))
			}, agent.session, rawInput, signal)
		});
		commandCtx.commands.register({
			name: "plugins",
			description: "Search and inspect the Loader's plugin entries",
			handler: () => {
				showPlugins();
				return { kind: "success" };
			}
		});
		if (config.experimentalCommands === true) commandCtx.commands.register({
			name: "reload",
			description: "EXPERIMENTAL (dev): re-read loader config files and apply the diff (idle only)",
			handler: () => {
				runReload();
				return { kind: "success" };
			}
		});
		commandCtx.commands.register({
			name: "search",
			description: "Search this session's messages",
			input: { hint: "[query]" },
			handler: ({ rawInput }) => {
				showTranscriptSearch(rawInput.trim());
				return { kind: "success" };
			}
		});
		commandCtx.commands.register({
			name: "rewind",
			description: "Go back to an earlier prompt in this session (files are never restored)",
			handler: () => {
				showRewind();
				return { kind: "success" };
			}
		});
		commandCtx.commands.register({
			name: "resume",
			description: "List this workspace's resumable sessions",
			input: { hint: "[session]" },
			handler: ({ rawInput }) => {
				resume.showResume(rawInput.trim());
				return { kind: "success" };
			}
		});
		commandCtx.commands.register({
			name: "skills",
			description: "Search this session's skills and read one in full",
			handler: () => {
				showSkills();
				return { kind: "success" };
			}
		});
		commandCtx.commands.register({
			name: "status",
			description: "Show session diagnostics, system prompt, and registered tools",
			handler: async ({ signal }) => {
				await showStatus(signal);
				return { kind: "success" };
			}
		});
		commandCtx.commands.register({
			name: "mcp",
			description: "Show the MCP servers this agent's tools come from",
			handler: () => {
				showMcp();
				return { kind: "success" };
			}
		});
		commandCtx.commands.register({
			name: "doctor",
			description: "Check the runtime, terminal, model route, and mounted services",
			handler: async () => {
				await showDoctor();
				return { kind: "success" };
			}
		});
		const exitHandler = () => {
			requestExit();
			return { kind: "success" };
		};
		commandCtx.commands.register({
			name: "exit",
			description: "Exit after the active turn reaches idle",
			handler: exitHandler
		});
		commandCtx.commands.register({
			name: "quit",
			description: "Exit after the active turn reaches idle",
			handler: exitHandler
		});
	});
	const fileReferencePromptFiber = agent.ctx.inject(["systemPrompt"], (promptCtx) => {
		promptCtx.systemPrompt.section({
			name: "ui:tui-file-reference",
			order: 99,
			text: () => agent.ctx.tools.get("read", agent) === void 0 ? "" : FILE_REFERENCE_PROMPT
		});
	});
	const runCommand = (text) => {
		const controller = new AbortController();
		commandControllers.add(controller);
		ctx.commands.execute(agent, text, controller.signal).then((execution) => {
			if (disposed) return;
			if (execution === void 0) appendNotice(t("notice.unknownCommand", { text }), "warning");
			else if (execution.result.text !== void 0 && execution.result.text !== "") appendNotice(execution.result.text, execution.result.kind === "error" ? "error" : "info");
		}, (error) => {
			if (!disposed) appendNotice(t("notice.commandFailed", { error: errorChain(error) }), "error");
		}).finally(() => {
			commandControllers.delete(controller);
			if (disposed) return;
			applyModeBadges();
			requestRender();
		});
	};
	/**
	* Deliver a user turn: steer a running driver, otherwise queue a follow-up.
	*
	* rc.6 removed `Agent.acceptsNextStep` and the `agent/prompt-submit`
	* admission waterfall, so the running check is the public status and an
	* attached reference snapshot rides `agent.inject()` beside the prompt
	* instead of inside its admission transaction.
	* @param content - the model-facing blocks of the user's turn.
	* @param attachedContext - optional session-reference snapshot delivered with it.
	*/
	const dispatchMessage = (content, attachedContext) => {
		if (disposed || agentGone) {
			appendNotice(t("notice.agentDisposed", {
				id: agent.id,
				recovery: disposedRecovery()
			}), "error");
			return;
		}
		if (attachedContext !== void 0) agent.inject(attachedContext);
		const message = createUserMessage({
			content,
			source: { kind: "user" }
		});
		const steering = agent.status === "running";
		store.appendOptimistic(message, steering ? "steering" : "user");
		if (steering) {
			agent.steer(message);
			pendingSteering.set(message.id, contentText(content).trim());
			refreshStatus();
			return;
		}
		agent.followup(message);
	};
	/** Deliver a user turn to the agent: steer while running, send while idle, or report a disposed agent. */
	const deliver = (payload) => {
		dispatchMessage([{
			type: "text",
			text: payload
		}]);
	};
	/**
	* Load a manually invoked skill and deliver its rendered body as a user turn,
	* reporting lookup outcomes as notices.
	*
	* The returned promise settles when the invocation is over — delivered,
	* refused, or failed — which is what the launcher-seeded first turn waits on
	* before it lets typed prompts through (see `initialSkillPending`). A typed
	* `/skill:` needs nothing from it.
	* @param name - the skill to look up in the registry.
	* @param instructions - extra text the user typed after the skill name.
	* @returns a promise that settles once the invocation has run its course.
	*/
	const invokeSkill = (name, instructions) => {
		const skills = skillRegistry();
		if (skills === void 0) {
			appendNotice(t("skills.unavailable"), "warning");
			return Promise.resolve();
		}
		const lookup = {
			cwd,
			scope: agent,
			signal: skillAbort.signal
		};
		const reportFailure = (error) => {
			if (disposed) return;
			appendNotice(t("skills.loadFailed", {
				name,
				error: errorChain(error)
			}), "error");
		};
		return skills.list(lookup).then((summaries) => {
			if (disposed) return;
			const summary = summaries.find((skill) => skill.name === name);
			if (summary === void 0) {
				appendNotice(t("skills.unknown", { name }), "warning");
				return;
			}
			if (!summary.invocation.userInvocable) {
				appendNotice(t("skills.notUserInvocable", { name }), "warning");
				return;
			}
			return skills.get(name, lookup).then((skill) => {
				if (disposed) return;
				if (skill === void 0) {
					appendNotice(t("skills.unknown", { name }), "warning");
					return;
				}
				if (!skill.invocation.userInvocable) {
					appendNotice(t("skills.notUserInvocable", { name }), "warning");
					return;
				}
				deliver(renderSkillInvocation(skill, instructions));
			}, reportFailure);
		}, reportFailure);
	};
	let reloadInFlight = false;
	const runReload = () => {
		if (agent.status !== "idle") {
			appendNotice(t("notice.reloadBusyAgent", { status: agent.status }), "warning");
			return;
		}
		if (reloadInFlight) {
			appendNotice(t("notice.reloadRunning"), "warning");
			return;
		}
		const loader = ctx.get("loader");
		if (loader === void 0) {
			appendNotice(t("notice.reloadNoLoader"), "warning");
			return;
		}
		const refreshes = [];
		for (const entry of loader.entries()) if (entry.subtree?.refresh !== void 0) refreshes.push(entry.subtree.refresh());
		reloadInFlight = true;
		appendNotice(t("notice.reloadStarted", { count: refreshes.length }));
		Promise.all(refreshes).then(() => {
			appendNotice(t("notice.reloadDone"));
		}).catch((error) => {
			appendNotice(t("notice.reloadFailed", { error: errorChain(error) }), "error");
		}).finally(() => {
			reloadInFlight = false;
		});
	};
	/**
	* Whether the launcher-seeded skill still owes this session its first turn.
	*
	* Only a `config.initialSkill` session ever has one, so an ordinary chat
	* never queues anything: the flag is false from the first submission on.
	*/
	let initialSkillPending = config.initialSkill !== void 0;
	/** Prompts submitted during that window, in the order they were typed. */
	const queuedSubmissions = [];
	const submitLine = (value) => {
		const text = value.trim();
		if (text === "") return;
		const restoreSubmittedInput = () => {
			if (editor.getText() === "") editor.setText(value);
		};
		const command = text.startsWith("/");
		if (initialSkillPending && (!command || text.startsWith("/skill:"))) {
			editor.addToHistory(text);
			editor.setText("");
			queuedSubmissions.push(value);
			flashStatus(t("status.flash.queuedForSkill"));
			return;
		}
		if (text.startsWith("/skill:")) {
			editor.addToHistory(text);
			editor.setText("");
			const { name: skillName, instructions } = parseSkillCommand(text);
			if (skillName === "") appendNotice(t("notice.skillUsage"), "warning");
			else invokeSkill(skillName, instructions);
			return;
		}
		if (command) {
			editor.addToHistory(text);
			editor.setText("");
			runCommand(text);
			return;
		}
		let parsed;
		try {
			parsed = parseSessionReferenceText(text);
		} catch (error) {
			restoreSubmittedInput();
			appendNotice(t("notice.referenceInvalid", { error: errorChain(error) }), "error");
			return;
		}
		if (parsed.references.length === 0) {
			editor.addToHistory(text);
			editor.setText("");
			dispatchMessage([{
				type: "text",
				text: parsed.text
			}]);
			return;
		}
		const sessionReferences = ctx.get("sessionReferenceResolver");
		if (sessionReferences === void 0) {
			restoreSubmittedInput();
			appendNotice(t("notice.referenceUnavailable"), "error");
			return;
		}
		const controller = new AbortController();
		referenceControllers.add(controller);
		editor.disableSubmit = true;
		sessionReferences.prepare(agent, [{
			type: "text",
			text: parsed.text
		}], parsed.references, controller.signal).then((prepared) => {
			if (disposed) return;
			editor.addToHistory(text);
			if (editor.getText() === value) editor.setText("");
			dispatchMessage(prepared.content, prepared.additionalContext);
		}, (error) => {
			if (!disposed && !controller.signal.aborted) {
				restoreSubmittedInput();
				appendNotice(t("notice.referenceFailed", { error: errorChain(error) }), "error");
			}
		}).finally(() => {
			referenceControllers.delete(controller);
			editor.disableSubmit = false;
			requestRender();
		});
	};
	editor.onSubmit = submitLine;
	/**
	* `?` on an empty prompt opens the shortcut list, and is not typed.
	*
	* Claude Code's rule exactly (`PromptInput.tsx`): the help opens only when the
	* whole input is a single `?`, and the character itself never lands in the
	* draft — a `?` typed inside a sentence is a question mark, not a keystroke.
	*/
	editor.onChange = (text) => {
		if (text !== "?") return;
		editor.setText("");
		showHotkeys();
		requestRender();
	};
	/**
	* Open the gate the launcher-seeded skill held, and replay what waited behind
	* it in submission order.
	*
	* A teardown mid-lookup drops the queue instead: those prompts were never
	* delivered, and re-submitting them against a disposed agent would answer the
	* user's typing with a row of refusals on a screen that is going away.
	*/
	const releaseInitialSkill = () => {
		initialSkillPending = false;
		const held = queuedSubmissions.splice(0, queuedSubmissions.length);
		if (disposed) return;
		for (const line of held) submitLine(line);
	};
	/**
	* Put every queued steering prompt back in the editor, newest submission last.
	*
	* Cancelling a turn empties the agent's inbox, so a prompt the user typed and
	* sent while the turn ran is discarded with it. Claude Code hands those back
	* to the input frame rather than dropping them, and so does this: the text is
	* prepended to whatever is being typed now, which is the order the user wrote
	* them in. The map itself is settled by the inbox's own discard events, not
	* here — until those land the prompts really are still queued.
	*/
	const popQueuedSteering = () => {
		if (pendingSteering.size === 0) return;
		const queued = [...pendingSteering.values()].filter((text) => text !== "");
		if (queued.length === 0) return;
		const draft = editor.getText();
		editor.setText(draft === "" ? queued.join("\n") : `${queued.join("\n")}\n${draft}`);
		requestRender();
	};
	/** Drop the armed first Esc, so the next one asks again instead of acting. */
	const disarmEscape = () => {
		if (escapeArmed === void 0) return;
		clearTimeout(escapeArmed);
		escapeArmed = void 0;
		if (flashingStatus?.text === escapeAsk) {
			clearFlash();
			requestRender();
		}
		escapeAsk = void 0;
	};
	/**
	* Arm the second Esc for {@link ESCAPE_DOUBLE_PRESS_MS} and say what it will do.
	* @param ask - the wording the status row holds for the whole window.
	*/
	const armEscape = (ask) => {
		disarmEscape();
		escapeArmed = setTimeout(() => {
			escapeArmed = void 0;
		}, ESCAPE_DOUBLE_PRESS_MS);
		escapeAsk = ask;
		flashStatus(ask, ESCAPE_DOUBLE_PRESS_MS);
	};
	/** Overlay of a live Ctrl+R search, so a second press replaces rather than stacks. */
	let historyOverlay;
	/**
	* Search the prompt history backwards (Ctrl+R).
	*
	* The draft is captured on the way in and restored by a cancel, which is the
	* half of Claude Code's behavior that matters most: a search entered by
	* accident must give back exactly what the user was typing.
	*/
	const showHistorySearch = () => {
		const entries = editor.historyEntries();
		if (entries.length === 0) {
			flashStatus(t("status.flash.historyEmpty"));
			return;
		}
		historyOverlay?.close();
		const draft = editor.getText();
		const session = overlayManager.open({
			create: () => new HistorySearchPanel(entries, palette, (text, outcome) => {
				session.close();
				editor.setText(text);
				requestRender();
				if (outcome === "submit") submitLine(text);
			}, () => {
				session.close();
				editor.setText(draft);
				requestRender();
			}),
			dismissable: true
		}, "inline");
		historyOverlay = session;
		session.closed.then(() => {
			if (historyOverlay === session) historyOverlay = void 0;
		});
		requestRender();
	};
	/**
	* Go back to an earlier prompt in this session (`/rewind`, double Esc on an
	* empty prompt).
	*
	* What "back" means depends on the host. One that can fork the session
	* branches it at the last completed turn before the chosen prompt and mounts
	* the branch, leaving this session whole and resumable. One that cannot only
	* puts the prompt's text back in the editor. Neither touches a file: dsh keeps
	* no working-tree snapshots, and the panel says so instead of implying one.
	* @param target - the prompt the user picked.
	*/
	const rewindTo = (target) => {
		const events = agent.session.events;
		const fork = runtime.handoffFork;
		const seedLength = fork === void 0 ? void 0 : forkSeedLength(events, target.seq);
		editor.setText(target.text);
		requestRender();
		if (fork === void 0 || seedLength === void 0) {
			appendNotice(t(fork === void 0 ? "notice.rewindNoFork" : "notice.rewindNoTurn"), "warning");
			return;
		}
		appendNotice(t("notice.rewindForking"));
		fork({
			seed: events.slice(0, seedLength),
			parentSession: agent.session.id,
			cwd,
			draft: target.text
		}).catch((error) => {
			/* v8 ignore next -- a fork that fails after teardown has no screen left to report on. */
			if (!disposed) appendNotice(t("notice.rewindFailed", { error: errorChain(error) }), "error");
		});
	};
	const showRewind = () => {
		if (agent.status === "running") {
			appendNotice(t("notice.rewindBusy"), "warning");
			return;
		}
		panelOverlay?.close();
		const targets = rewindTargets(agent.session.events);
		const session = overlayManager.open({
			create: () => new RewindPanel(targets, runtime.handoffFork !== void 0, panelRows, palette, (target) => {
				session.close();
				rewindTo(target);
			}, () => {
				session.close();
			}),
			dismissable: true
		}, "inline");
		panelOverlay = session;
		session.closed.then(() => {
			if (panelOverlay === session) panelOverlay = void 0;
		});
		requestRender();
	};
	/**
	* Esc, in Claude Code's own order.
	*
	* Running: cancel, and hand back whatever was queued behind the turn. Idle
	* with a draft: two presses clear it, and the cleared text goes into the
	* history first, so a draft abandoned by accident is one Ctrl+R away. Idle
	* with an empty prompt: two presses open Rewind — but only when there is a
	* prompt to go back to, since arming a key that opens an empty panel teaches
	* the wrong thing about it.
	*/
	const handleEscape = () => {
		if (agent.status === "running") {
			disarmEscape();
			popQueuedSteering();
			cancelActiveTurn();
			return;
		}
		const draft = editor.getText();
		if (draft !== "") {
			if (escapeArmed === void 0) {
				armEscape(t("status.flash.escDraft"));
				return;
			}
			disarmEscape();
			editor.addToHistory(draft);
			editor.setText("");
			requestRender();
			return;
		}
		if (!hasRewindTarget(agent.session.events)) return;
		if (escapeArmed === void 0) {
			armEscape(t("status.flash.escRewind"));
			return;
		}
		disarmEscape();
		showRewind();
	};
	const removeInputListener = ui.addInputListener((data) => {
		if (overlayManager.hasActiveOverlay()) return void 0;
		const press = !isKeyRelease(data) && !isKeyRepeat(data);
		if (keybindings.matches(data, "app.mode.cycle")) {
			if (press) cycleMode();
			return { consume: true };
		}
		if (keybindings.matches(data, "app.tools.cycle")) {
			if (press) toggleTools();
			return { consume: true };
		}
		if (keybindings.matches(data, "app.history.search")) {
			if (press) showHistorySearch();
			return { consume: true };
		}
		if (keybindings.matches(data, "app.transcript.search")) {
			if (press) showTranscriptSearch("");
			return { consume: true };
		}
		if (keybindings.matches(data, "app.todos.toggle")) {
			if (press) toggleTodos();
			return { consume: true };
		}
		if (keybindings.matches(data, "app.thinking.toggle")) {
			if (press) toggleThinking();
			return { consume: true };
		}
		if (keybindings.matches(data, "app.message.copy")) {
			if (press) copyLastAnswer();
			return { consume: true };
		}
		if (keybindings.matches(data, "app.screen.redraw")) {
			if (press) {
				ui.invalidate();
				ui.requestRender(true);
			}
			return { consume: true };
		}
		if (keybindings.matches(data, "app.cancel")) {
			if (editor.isShowingAutocomplete()) return void 0;
			if (press) handleEscape();
			return { consume: true };
		}
		if (matchesKey(data, Key.ctrl("c"))) {
			if (press) {
				if (agent.status === "running") {
					if (!cancelRequested) {
						cancelActiveTurn();
						disarmExit();
					} else if (exitArmed === void 0) {
						cancelActiveTurn();
						armExit(t("status.flash.exitWithoutTurn"));
					} else {
						disarmExit();
						shutdown(true);
					}
				} else if (editor.getText() !== "") {
					editor.setText("");
					disarmExit();
					requestRender();
				} else if (exitArmed !== void 0) requestExit();
				else armExit(t("status.flash.exitAgain"));
			}
			return { consume: true };
		}
		if (keybindings.matches(data, "app.exit")) {
			if (press) {
				if (agent.status === "running") appendNotice(t("status.flash.cancelBeforeExit"), "warning");
				else if (editor.getText() !== "") flashStatus(t("status.flash.draftBlocksExit"));
				else requestExit();
			}
			return { consume: true };
		}
	});
	const disposeSessionEvents = ctx.on("session/event", (session, event) => {
		if (session !== agent.session) return;
		if (event.type === "tool/call") inFlightToolCalls.set(event.data.callId, {
			name: event.data.name,
			arguments: event.data.arguments
		});
		if (event.type === "turn/end") inFlightToolCalls.clear();
		if (event.type === "tool/result") {
			const callId = event.data.message.content[0].toolCallId;
			const call = inFlightToolCalls.get(callId);
			inFlightToolCalls.delete(callId);
			if (call === void 0 || toolCallTouchesFiles(ctx.tools.get(call.name, agent), call.arguments)) fileSearch.invalidate();
		}
		if (event.type === "agent-preset/selected" && skillsAvailable) refreshSkillCommands();
		if (PERMISSION_EVENTS.has(event.type)) applyModeBadges();
		if (event.type === "goal/change") try {
			goalState = foldGoal(agent.session.events);
		} catch (error) {
			ctx.logger.warn(`dsh-tui: goal fold rejected a change; keeping the last goal: ${errorChain(error)}`);
		}
		recordEventUsage(tokens, event);
		if (event.type === "turn/start" && runningStatus !== void 0) runningStatus.turn = event.data.turn;
		if (event.type === "compaction/start" && event.data.turn === null) {
			if (compacting === void 0) {
				compacting = {
					startedAt: now(),
					timer: setInterval(renderStatus, 50)
				};
				runtime.terminal.setProgress(true);
			}
		} else if (event.type === "compaction/end" && event.data.turn === null && compacting !== void 0) {
			const fadeOutGlyph = runningPhaseGlyph(agent.session.events, false, true);
			clearInterval(compacting.timer);
			compacting = void 0;
			if (runningStatus === void 0 && fadeOutGlyph !== void 0) beginFadeOut(fadeOutGlyph);
		}
		requestRender();
	});
	const settlePendingSteering = (id) => {
		if (pendingSteering.delete(id)) refreshStatus();
	};
	const disposeClaimed = ctx.on("agent/inbox/claimed", (payload) => {
		if (payload.agent === agent) settlePendingSteering(payload.message.id);
	});
	const disposeDiscarded = ctx.on("agent/inbox/discarded", (payload) => {
		if (payload.agent !== agent) return;
		store.withdrawOptimistic(payload.message.id);
		settlePendingSteering(payload.message.id);
	});
	const disposeStatus = ctx.on("agent/status", (payload) => {
		if (payload.agent !== agent) return;
		if (payload.status !== "running") pendingSteering.clear();
		setStatus(payload.status);
	});
	const disposeError = ctx.on("agent/error", (payload) => {
		if (payload.agent !== agent) return;
		ctx.logger.warn(`dsh-tui: turn ${payload.turn} step ${payload.step} failed: ${errorChain(payload.error)}`);
	});
	const disposeAgent = ctx.on("agent/disposed", (payload) => {
		if (payload.agent !== agent) return;
		agentGone = true;
		clearStatus();
		appendNotice(t("notice.agentDisposedTurn", {
			id: agent.id,
			recovery: disposedRecovery()
		}), "warning");
	});
	const detachListeners = () => {
		skillAbort.abort();
		fileSearch.dispose();
		clearFlash();
		disarmEscape();
		removeInputListener();
		disposeCommandChanges();
		disposeLocaleChanges();
		disposeSkillChanges();
		disposePromptChanges();
		for (const value of promptValues) value.dispose();
		stopBannerReveal();
		disposeSnapshots();
		store.dispose();
		disposeSessionEvents();
		disposeClaimed();
		disposeDiscarded();
		disposeStatus();
		disposeError();
		disposeAgent();
		disposeSchemeListener();
		disposeTargetListeners();
		disposeApprovals();
		modelController.detach();
	};
	let revealTimer;
	const stopBannerReveal = () => {
		if (revealTimer === void 0) return;
		clearInterval(revealTimer);
		revealTimer = void 0;
		header.setRevealWidth(void 0);
	};
	const startBannerReveal = () => {
		if (config.welcome !== void 0) return;
		let frame = 0;
		header.setRevealWidth(0);
		revealTimer = setInterval(() => {
			frame += 1;
			const total = Math.max(1, runtime.terminal.columns);
			const shown = bannerRevealWidth(frame, total);
			if (shown >= total) stopBannerReveal();
			else header.setRevealWidth(shown);
			requestRender();
		}, 15);
	};
	const initial = store.getSnapshot();
	applySnapshot(initial, { repaint: true });
	for (const node of initial.nodes) if (node.kind === "user-message" && node.source === "user") editor.addToHistory(node.text);
	if (config.initialDraft !== void 0 && config.initialDraft !== "") editor.setText(config.initialDraft);
	const restoredGoal = goalState.goal;
	/* v8 ignore next -- goal replay coverage lives with the goal seam; the TUI only formats its startup notice. */
	if (restoredGoal !== void 0 && restoredGoal.phase !== "complete") appendNotice(`Goal restored (${restoredGoal.phase}) with automatic continuation disarmed. Human confirmation is required; send “继续” or run /goal resume.`, "warning");
	setStatus(agent.status);
	try {
		ui.start();
	} catch (error) {
		disposed = true;
		detachListeners();
		Promise.all([commandFiber.dispose(), fileReferencePromptFiber.dispose()]).catch(
			/* v8 ignore next 2 -- command registration cleanup is non-throwing; this guards a future disposer regression */
			(cleanupError) => {
				ctx.logger.warn(`dsh-tui: scoped cleanup after startup failure failed: ${errorChain(cleanupError)}`);
			}
		);
		clearStatus();
		questions.unregister();
		ui.stop();
		throw error;
	}
	tuiServiceFiber = ctx.inject([], (serviceCtx) => {
		new TuiExtensionServiceImpl(serviceCtx, agent, overlayManager);
	});
	startBannerReveal();
	if (config.initialSkill !== void 0) invokeSkill(config.initialSkill, "").finally(releaseInitialSkill);
	return {
		submit(text) {
			submitLine(text);
		},
		async dispose() {
			detachListeners();
			await shutdown(false);
			await Promise.all([commandFiber.dispose(), fileReferencePromptFiber.dispose()]);
		}
	};
}
/**
* Open the pi-tui channel once its configured agent exists. Kept for embedders
* that let a declarative agent row own the lifecycle; the shipped `apply`
* creates the agent itself and calls {@link createTuiChat} directly.
*
* @param ctx - Context supplying the agent registry, tools, and event stream.
* @param config - Target agent and presentation configuration.
* @param runtime - Terminal and process-exit boundary.
*/
function mountTui(ctx, config, runtime) {
	const sessionId = SessionId(config.sessionId ?? "main");
	const matchesConfiguredIdentity = (agent) => agent.id === sessionId && ctx.agents.roots().includes(agent);
	let settled = false;
	const stopWaiting = () => {
		clearTimeout(stallTimer);
		disposeCreated();
		disposeFailure();
	};
	const start = (agent) => {
		if (settled || !matchesConfiguredIdentity(agent)) return;
		settled = true;
		stopWaiting();
		ctx.effect(() => {
			const controller = createTuiChat(ctx, config, runtime);
			return () => controller.dispose();
		}, "dsh-tui");
	};
	const fail = (failedSessionId, error) => {
		if (settled || failedSessionId !== sessionId) return;
		settled = true;
		stopWaiting();
		runtime.terminal.write(displayText(`dsh-tui: session "${sessionId}" failed to start: ${errorChain(error)}\n`));
		runtime.exit(1);
	};
	const disposeCreated = ctx.on("agent/created", (payload) => {
		start(payload.agent);
	});
	const disposeFailure = ctx.on("agent-loop/config-start-failed", (payload) => {
		fail(payload.sessionId, payload.error);
	});
	const stallTimer = setTimeout(() => {
		fail(sessionId, /* @__PURE__ */ new Error(`no agent was created within ${String(AGENT_START_TIMEOUT_MS)}ms (the plugin that creates it reported neither success nor failure)`));
	}, AGENT_START_TIMEOUT_MS);
	stallTimer.unref();
	const existing = ctx.agents.roots().find((agent) => agent.id === sessionId);
	if (existing !== void 0) start(existing);
}
const ROOT_DISPOSE_TIMEOUT_MS = 5e3;
/**
* Dispose the whole application before process exit, with a bounded fallback.
* @param ctx - The TUI plugin context whose root owns sibling resources.
* @param code - Process status to report.
* @param exit - Exit boundary, replaceable by tests.
*/
function disposeRootAndExit(ctx, code, exit = (status) => {
	process.exit(status);
}) {
	let exited = false;
	const exitOnce = () => {
		if (exited) return;
		exited = true;
		exit(code);
	};
	const timeout = setTimeout(exitOnce, ROOT_DISPOSE_TIMEOUT_MS);
	ctx.root.fiber.dispose().then(() => {
		clearTimeout(timeout);
		exitOnce();
	}, () => {
		clearTimeout(timeout);
		exitOnce();
	});
}
/**
* End this run with `code`, through whichever exit the deployment owns.
*
* A launcher-provided bounded exit disposes the tree it owns; without one the
* app disposes its own root and exits. Shared by the interactive run and the
* one-shot `--print` run, which end for different reasons and must end the same
* way.
* @param ctx - the runner context.
* @param code - the process status to report.
*/
function requestExit(ctx, code) {
	const appExit = ctx.get("appExit");
	if (appExit === void 0) {
		disposeRootAndExit(ctx, code);
		return;
	}
	appExit(code);
}
/**
* Split a `provider/model` selection string.
* @param value - the raw `--model` argument, when one was given.
* @returns the route, or `undefined` when absent or not `provider/model`.
*/
function parseModelSelection(value) {
	if (value === void 0) return void 0;
	const slash = value.indexOf("/");
	if (slash <= 0 || slash === value.length - 1) return void 0;
	return {
		provider: value.slice(0, slash),
		model: value.slice(slash + 1)
	};
}
/**
* Resolve the per-agent model options for this run.
*
* Only an explicit `--model` fixes the agent's own options. A default-model
* service is deliberately NOT read here: it loads its user layer from settings
* asynchronously, so a route captured at startup is the bundle's inline default
* rather than the user's. The chat's model selection reads that service live
* instead (see `defaultModelSelection`) and applies it through the
* `agent/request` waterfall, which is the surface that actually routes a step.
* @param startup - the parsed command line.
* @returns agent options, or `undefined` to leave the route to the selection.
*/
function resolveAgentOptions(startup) {
	const route = parseModelSelection(startup.model);
	if (route === void 0) return void 0;
	return {
		provider: route.provider,
		model: route.model
	};
}
/**
* The most recent persisted session for this workspace, for `--continue`.
* @param ctx - the runner context.
* @returns the session id, or `undefined` without persistence or candidates.
*/
async function latestWorkspaceSession(ctx) {
	const persistence = ctx.get("sessionPersistence");
	if (persistence === void 0) return void 0;
	const cwd = process.cwd();
	return [...(await persistence.list()).filter((header) => header.cwd === void 0 || header.cwd === cwd)].sort((a, b) => b.createdAt - a.createdAt)[0]?.id;
}
/**
* Resolve the preset an agent will be composed from, and the setup that
* installs it.
*
* The id is resolved BEFORE the agent exists because the session boundary
* snapshots `meta` before asynchronous setup begins, so a preset discovered
* during setup could never reach the header. Mounting still happens inside
* setup, where a rejection rolls the whole creation back rather than leaving a
* published session whose capabilities are half-installed — which is also why
* an unknown `--preset` fails the start with the roster's own message and its
* list of ids that do exist.
*
* Optional service: the roster is a deployment choice, and a profile that
* mounts none composes nothing, exactly as this bundle behaved before.
* @param ctx - the runner context.
* @param presetId - the requested preset, or `undefined` for the roster default.
* @returns the header fact and the setup hook, both absent without a roster.
* @throws when the roster supplies no such preset.
*/
async function composeAgentPreset(ctx, presetId) {
	const presets = ctx.get("agentPresets");
	if (presets === void 0) return {};
	const resolvedId = (await presets.resolve(presetId)).id;
	return {
		agentPreset: resolvedId,
		setup: async (agentCtx) => {
			await presets.mount(agentCtx, resolvedId);
		}
	};
}
/**
* The composition a resumed session must be rebuilt under: the one its own log
* records, never the one this process was asked for.
*
* Read from the LOG rather than the header, because a session that switched
* preset while it was blank ran every one of its turns under the newer
* composition; rebuilding it from the header would restore that history under
* a tool set the model no longer has. The session is inspected cold — before
* `resume` publishes anything — because setup receives only the agent's scope
* and has nothing to read the log from.
*
* A session with no persistence to inspect (an embedder without the service, a
* log written before the roster existed) falls back to the roster default,
* which is what an unrecorded preset resolves to everywhere else.
* @param ctx - the runner context.
* @param sessionId - the session about to be resumed.
* @returns the setup hook, absent without a roster.
*/
async function composeResumedPreset(ctx, sessionId) {
	if (ctx.get("agentPresets") === void 0) return {};
	const persistence = ctx.get("sessionPersistence");
	let recorded;
	if (persistence !== void 0) {
		const { meta, events } = await persistence.inspect(sessionId);
		recorded = sessionAgentPreset({
			header: meta,
			events
		});
	}
	const composition = await composeAgentPreset(ctx, recorded);
	return composition.setup === void 0 ? {} : { setup: composition.setup };
}
/**
* Create or resume the single agent this terminal drives.
*
* Exported for the same reason {@link startupFailureMessage} is: the boot path
* settles facts a mounted chat can no longer be asked about — which preset the
* creation header records, and which composition a resumed session is rebuilt
* under — and both are decided before any terminal exists.
* @param ctx - the runner context.
* @param startup - the parsed command line.
* @param agentOptions - resolved model route, when one was selected.
* @returns the owned agent handle.
* @throws when `--resume`/`--continue` names no loadable session, or when
* `--preset` names one the roster does not supply.
*/
async function openStartupAgent(ctx, startup, agentOptions) {
	const options = agentOptions === void 0 ? {} : { agentOptions };
	const resumeOptions = async (resumeSessionId) => ({
		resumeSessionId,
		...options,
		...await composeResumedPreset(ctx, resumeSessionId)
	});
	const createOptions = async (sessionId) => {
		const composition = await composeAgentPreset(ctx, startup.preset);
		return {
			sessionId,
			meta: {
				cwd: process.cwd(),
				...composition.agentPreset === void 0 ? {} : { agentPreset: composition.agentPreset }
			},
			...options,
			...composition.setup === void 0 ? {} : { setup: composition.setup }
		};
	};
	if (startup.resume !== void 0) return ctx.agents.resume(await resumeOptions(SessionId(startup.resume)));
	if (startup.continueLatest) {
		const latest = await latestWorkspaceSession(ctx);
		if (latest === void 0) throw new Error("dsh-tui: --continue found no persisted session for this workspace");
		return ctx.agents.resume(await resumeOptions(latest));
	}
	const identity = ctx.get("mainSessionId");
	if (identity !== void 0) return identity.resume ? ctx.agents.resume(await resumeOptions(identity.id)) : ctx.agents.create(await createOptions(identity.id));
	return ctx.agents.create(await createOptions(SessionId(`session-${randomUUID()}`)));
}
/**
* What a start that could not open its session prints before exiting.
*
* The in-process resume path already answers a bad session id with one readable
* line (`handoff` below); the startup path let the same failure propagate out of
* the cordis effect, so `--resume <typo>` answered with a stack trace, or with
* whatever the loader logged around it. This says which session could not be
* opened, why, and the flag to change — the three things the user needs and a
* trace does not carry.
* @param startup - the parsed command line, for which selection failed.
* @param error - the rejection from the agent registry.
* @returns the message to write on the released terminal, newline included.
*/
function startupFailureMessage(startup, error) {
	const cause = errorChain(error);
	if (startup.resume !== void 0) return `dsh-tui: cannot resume session "${startup.resume}": ${cause}\nStart without --resume for a new session, or --continue for the most recent one in this workspace.
`;
	if (startup.continueLatest) return `dsh-tui: cannot continue the most recent session: ${cause}\nStart without --continue for a new session.
`;
	return `dsh-tui: cannot start a session: ${cause}\n`;
}
/**
* Why a parsed command line cannot be served at all, when it cannot be.
*
* The one line a `--print` run produces is the answer to its task, so a task
* that is only whitespace has no answer to produce: the model would be sent an
* empty turn and the caller would get a blank line and a success code. Refused
* on the command line instead, before an agent is created and while stderr is
* still the only thing anyone is reading.
* @param startup - the parsed command line.
* @returns the refusal to write on stderr, or `undefined` when the run may proceed.
*/
function startupRefusal(startup) {
	if (startup.print === void 0) return void 0;
	if (startup.print.trim() === "") return "dsh-tui: --print needs a task to run.\nPass one, e.g. dsh --profile tui --print \"run the tests\".\n";
	if (startup.initialPrompt !== void 0) return "dsh-tui: --print already carries the task; the prompt argument would be ignored.\nPass the task to --print alone.\n";
}
/**
* Own the process terminal for one run: open the startup agent, mount the chat
* over it, and keep an in-process resume host that swaps both without leaving
* the process.
* @param ctx - runner context with `tuiPrompt` available.
* @param config - presentation configuration from the bundle row.
*/
async function runTui(ctx, config) {
	const startup = ctx.tuiStartup;
	const truecolor = config.theme?.truecolor ?? ["truecolor", "24bit"].includes(process.env["COLORTERM"] ?? "");
	const initialSkill = config.initialSkill ?? ctx.get("tuiInitialSkill");
	const goodbyeMessage = ctx.get("tuiGoodbyeMessage");
	const terminal = new ProcessTerminal();
	const exit = (code) => {
		requestExit(ctx, code);
	};
	const agentOptions = resolveAgentOptions(startup);
	const hostResume = ctx.get("tuiResumeHost");
	let mounted;
	const runtime = {
		terminal,
		exit,
		formatCwd,
		gitBranch,
		...goodbyeMessage === void 0 ? {} : { goodbyeMessage },
		handoffResume: hostResume === void 0 ? (sessionId, cwd) => handoff(sessionId, cwd) : (sessionId, cwd) => hostResume.handoff(sessionId, cwd),
		handoffFork: (fork) => forkHandoff(fork),
		handoffNew: () => newSessionHandoff()
	};
	const mount = (handle, draft) => {
		mounted = {
			handle,
			controller: createTuiChat(ctx, {
				...config,
				theme: {
					...config.theme,
					truecolor
				},
				...initialSkill === void 0 ? {} : { initialSkill },
				...draft === void 0 || draft === "" ? {} : { initialDraft: draft },
				sessionId: handle.agent.session.id
			}, runtime)
		};
	};
	const teardown = async () => {
		const active = mounted;
		mounted = void 0;
		if (active === void 0) return;
		await active.controller.dispose();
		await active.handle.dispose();
	};
	/**
	* In-process resume: tear the current chat and agent down, resume the
	* selected session, and mount a fresh chat over it. Rejects before
	* committing teardown when the target workspace cannot be entered; a failure
	* after that point is fatal and reported on the released terminal.
	*/
	async function handoff(sessionId, cwd) {
		if (resolve(cwd) !== resolve(process.cwd())) try {
			process.chdir(cwd);
		} catch (error) {
			throw new Error(`dsh-tui: cannot enter workspace "${cwd}": ${errorChain(error)}`);
		}
		await teardown();
		let resumed;
		try {
			resumed = await ctx.agents.resume({
				resumeSessionId: sessionId,
				...agentOptions === void 0 ? {} : { agentOptions },
				...await composeResumedPreset(ctx, sessionId)
			});
		} catch (error) {
			terminal.write(`dsh-tui: failed to resume session "${sessionId}": ${errorChain(error)}\n`);
			exit(1);
			throw error;
		}
		mount(resumed);
		return await new Promise(() => {});
	}
	/**
	* In-process rewind: tear the current chat and agent down, create the fork the
	* rewind asked for, and mount a fresh chat over it.
	*
	* The parent session is never touched — it keeps its whole log and stays
	* resumable — so a rewind is a branch, not an edit. Files on disk are not part
	* of the fork in either direction: dsh snapshots no working tree, and the
	* Rewind panel says so rather than implying a restore this cannot do.
	* @param fork - The seed, lineage, workspace, and draft the new chat opens with.
	* @returns Never; the replacement chat owns the terminal from here.
	*/
	async function forkHandoff(fork) {
		await teardown();
		let forked;
		try {
			forked = await ctx.agents.create({
				sessionId: SessionId(`session-${randomUUID()}`),
				seed: fork.seed,
				meta: {
					cwd: fork.cwd,
					parentSession: fork.parentSession,
					seedLength: fork.seed.length
				},
				...agentOptions === void 0 ? {} : { agentOptions },
				...await composeResumedPreset(ctx, fork.parentSession)
			});
		} catch (error) {
			terminal.write(`dsh-tui: failed to fork session "${fork.parentSession}": ${errorChain(error)}\n`);
			exit(1);
			throw error;
		}
		mount(forked, fork.draft);
		return await new Promise(() => {});
	}
	/**
	* In-process `/new`: flush the session being left, tear the chat and agent
	* down, create a blank session in this workspace, and mount a fresh chat over
	* it.
	*
	* The session left behind keeps its whole log and stays resumable — there is
	* no truncating "clear" anywhere below this UI, and inventing one out of a
	* fresh create would be a lie about what the log holds. The new session is
	* composed exactly as a fresh start would compose it, so `--preset` and the
	* saved default still decide what it runs.
	* @returns Never; the replacement chat owns the terminal from here.
	*/
	async function newSessionHandoff() {
		const leaving = mounted?.handle.agent.session;
		if (leaving !== void 0) await ctx.sessions.flush(leaving);
		await teardown();
		let created;
		try {
			const composition = await composeAgentPreset(ctx, startup.preset);
			created = await ctx.agents.create({
				sessionId: SessionId(`session-${randomUUID()}`),
				meta: {
					cwd: process.cwd(),
					...composition.agentPreset === void 0 ? {} : { agentPreset: composition.agentPreset }
				},
				...agentOptions === void 0 ? {} : { agentOptions },
				...composition.setup === void 0 ? {} : { setup: composition.setup }
			});
		} catch (error) {
			terminal.write(`dsh-tui: failed to start a new session: ${errorChain(error)}\n`);
			exit(1);
			throw error;
		}
		mount(created);
		return await new Promise(() => {});
	}
	ctx.effect(() => () => teardown(), "dsh-tui/session");
	let handle;
	try {
		handle = await openStartupAgent(ctx, startup, agentOptions);
	} catch (error) {
		terminal.write(displayText(startupFailureMessage(startup, error)));
		exit(1);
		return;
	}
	mount(handle);
	if (startup.initialPrompt !== void 0) mounted?.controller.submit(startup.initialPrompt);
}
/**
* Cordis entry point (`tui-runner`): owns the process terminal, the startup
* agent, and the prompt-value registry this bundle's chat renders against —
* except under `--print`, which owns none of them and writes one answer on
* stdout instead.
* @param ctx - plugin context carrying the injected core services.
* @param config - presentation configuration from the bundle row.
*/
/* v8 ignore start -- production process wiring; fake-terminal tests cover createTuiChat, and the print suite covers runPrintTask */
function apply(ctx, config) {
	const storedLocale = resolveLocaleStore(ctx).load();
	if (storedLocale !== void 0) setLocale(storedLocale);
	const startup = ctx.tuiStartup;
	if (startup.print !== void 0) {
		const io = {
			stdout: process.stdout,
			stderr: process.stderr,
			exit: (code) => {
				requestExit(ctx, code);
			}
		};
		const refusal = startupRefusal(startup);
		if (refusal !== void 0) {
			io.stderr.write(refusal);
			io.exit(2);
			return;
		}
		startPrintRun(ctx, startup.print, { openAgent: () => openStartupAgent(ctx, startup, resolveAgentOptions(startup)) }, io);
		return;
	}
	if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("dsh-tui: both stdin and stdout must be TTYs; use a headless profile for pipes");
	ctx.plugin(TuiPromptService);
	ctx.inject(["tuiPrompt"], (uiCtx) => runTui(uiCtx, config));
}
/* v8 ignore stop */
//#endregion
export { Config, DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES, DEFAULT_FILE_SEARCH_MAX_ENTRIES, DEFAULT_FILE_SEARCH_MAX_RESULTS, FILE_REFERENCE_PROMPT, INITIAL_SKILL_KEY, MAIN_SESSION_ID_KEY, TUI_GOODBYE_MESSAGE_KEY, TuiConfigSchema, TuiExtensionService, TuiPromptService, apply, createTuiChat, disposeRootAndExit, inject, mountTui, name, openStartupAgent, renderSkillInvocation, resolveTuiConfig, startupFailureMessage, startupRefusal };

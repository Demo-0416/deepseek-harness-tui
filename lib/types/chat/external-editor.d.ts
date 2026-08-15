/**
 * `$VISUAL`/`$EDITOR` handoff for the input frame: which editor this host has,
 * and one round trip through a temp file.
 *
 * Ported from Claude Code's `src/utils/editor.ts` + `src/utils/promptEditor.ts`,
 * with two deliberate differences. The child is spawned by argv rather than
 * through a shell — the path is one this module invented, so a shell would only
 * add quoting bugs and an injection surface neither of us needs. And the
 * discovery fallback lists terminal editors only: a GUI editor that forks
 * returns before the user has typed anything, so the file comes back unchanged
 * and the draft looks like it was silently refused.
 * @module @deepseek-ai/dsh-tui/chat/external-editor
 */
/** One spawnable editor invocation. */
export interface ExternalEditorSpec {
    /** Absolute path of the binary, as `PATH` or the configuration answered it. */
    readonly command: string;
    /** Arguments placed before the temp-file path, e.g. `['-w']` for VS Code. */
    readonly args: readonly string[];
    /** Name shown to the user: the command's basename. */
    readonly name: string;
    /** Where the choice came from, so a refusal can name the reason. */
    readonly source: 'config' | 'visual' | 'editor' | 'fallback';
}
/** Why no editor can be launched, or which one will be. */
export type ExternalEditorResolution = {
    readonly kind: 'editor';
    readonly editor: ExternalEditorSpec;
}
/** `externalEditor: ""` — the deployment said "do not spawn one". */
 | {
    readonly kind: 'disabled';
}
/** No configuration, no `$VISUAL`/`$EDITOR`, and no fallback on `PATH`. */
 | {
    readonly kind: 'unset';
}
/** A name was given and `PATH` (or the filesystem) does not answer it. */
 | {
    readonly kind: 'unresolved';
    readonly command: string;
};
/** What one round trip through the editor produced. */
export type ExternalEditResult = 
/** The file as saved, with one trailing newline removed. */
{
    readonly kind: 'edited';
    readonly text: string;
}
/** A non-zero exit (`vim :cq`, a crash, a signal): the draft must not change. */
 | {
    readonly kind: 'exit';
    readonly code: number;
}
/** The child could not be spawned, or the temp file could not be read. */
 | {
    readonly kind: 'failed';
    readonly error: string;
};
/** Editors that return immediately unless told to wait for the window to close. */
export declare const EDITOR_WAIT_FLAGS: Readonly<Record<string, readonly string[]>>;
/** Terminal editors tried when nothing was configured, kindest first. */
export declare const FALLBACK_EDITORS: readonly string[];
/**
 * Split an editor command line into a command word and its arguments.
 *
 * `$EDITOR` is a command line rather than a path in most of the shells that set
 * it (`code -w`, `emacs -nw`, `"/Applications/…/bin/x" -f`), so quoted paths
 * with spaces have to survive. Escapes are deliberately not interpreted: this
 * is not a shell and must not start looking like one.
 * @param value - the configured or exported command line.
 * @returns the command word and everything after it.
 */
export declare function parseEditorCommandLine(value: string): {
    command: string;
    args: string[];
};
/**
 * Decide which editor this host hands a draft to.
 *
 * Never memoized, unlike upstream: a user who exports `$EDITOR` in another pane
 * and comes back to this one gets the editor they just set, and a test does not
 * have to defeat a cache to say what it means.
 * @param configured - the deployment's `externalEditor`; `''` disables the feature.
 * @param env - environment read for `$VISUAL`, `$EDITOR`, and `PATH`.
 * @returns the editor, or why there is none.
 */
export declare function resolveExternalEditor(configured: string | undefined, env?: NodeJS.ProcessEnv): ExternalEditorResolution;
/**
 * Hand `text` to an editor and take back what was saved.
 *
 * The file lives in the system temp directory rather than the workspace: a
 * draft in the working tree would be indexed by `@` completion and readable by
 * the agent's own file tools, which is not what someone typing into an input
 * frame is agreeing to. It is created `0600` and removed on both outcomes.
 * @param text - the draft to edit.
 * @param editor - the resolved invocation.
 * @param options - working directory and environment for the child.
 * @returns the saved text, the non-zero exit, or the failure.
 */
export declare function editTextExternally(text: string, editor: ExternalEditorSpec, options?: {
    readonly cwd?: string;
    readonly env?: NodeJS.ProcessEnv;
}): Promise<ExternalEditResult>;

/**
 * TUI-side presentation fallbacks for tools whose definitions ship without
 * `presentCall`/`presentResult`. The reconciler consults this table when it
 * mounts a tool card, so a tool the harness renders as raw JSON can still get
 * a purpose-built card here without a harness release. Entries fill only the
 * presenter a definition is missing: a definition that grows its own presenter
 * wins over the fallback.
 * @module @deepseek-ai/dsh-tui/components/tool-presenters
 */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
/**
 * Fill a definition's missing presenters from the fallback table.
 * @param name - Tool name the card was mounted for.
 * @param definition - The registered definition, when the tool is known.
 * @returns The definition, with fallback presenters where it had none.
 */
export declare function withTuiPresenters(name: string, definition: ToolDefinition | undefined): ToolDefinition | undefined;

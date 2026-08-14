/**
 * Content-block primitives shared across the terminal front door: flattening
 * session content to display text and parsing tool-call arguments.
 * @module @deepseek-ai/dsh-tui/components/content
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
/**
 * Flatten content blocks into a single display string, recursing into
 * tool-result content and naming unknown block types.
 * @param content - Content blocks to flatten.
 * @returns The concatenated display text.
 */
export declare function contentText(content: readonly ContentBlock[]): string;
/** A tool call's arguments parsed from their JSON source, with a validity flag. */
export interface ParsedArguments {
    value: unknown;
    valid: boolean;
}
/**
 * Parse tool-call arguments from their JSON source.
 * @param raw - Raw JSON arguments text.
 * @returns The parsed value, or the raw text with `valid: false` on parse failure.
 */
export declare function parseArguments(raw: string): ParsedArguments;

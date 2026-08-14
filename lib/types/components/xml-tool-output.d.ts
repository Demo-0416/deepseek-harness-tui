/**
 * Conservative readable-tree rendering for model-facing text containing one XML
 * document, used by the transcript's tool cards for unknown tool results. Injected
 * context is prose and is not parsed; only {@link preview} is shared with its card.
 * @module @deepseek-ai/dsh-tui/components/xml-tool-output
 */
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
export declare function preview(lines: readonly string[], limit: number, omitted: (count: number) => string): string[];
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
export declare function renderUnknownXml(source: string, maxChildLines: number, expanded: boolean, display: (text: string) => string, label: (text: string) => string, body: (text: string) => string, omitted: (count: number) => string): string[] | undefined;

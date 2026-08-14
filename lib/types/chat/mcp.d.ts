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
import type { Palette } from '../components/theme.ts';
/** One server's tools, as `/mcp` groups them. */
export interface McpServerTools {
    /** The `serverName` its plugin row was configured with. */
    readonly server: string;
    /** Raw MCP names, without the public prefix, sorted. */
    readonly tools: readonly string[];
}
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
export declare function groupMcpTools(names: readonly string[]): readonly McpServerTools[];
/**
 * What the panel says when this profile mounts no MCP client.
 *
 * Built per call rather than held in a module constant: a constant would freeze
 * whichever locale happened to be active when this module was first imported,
 * and `/lang` would never reach it again.
 * @returns the block's lines, prose translated and the bundle row verbatim.
 */
export declare function mcpNotMountedLines(): readonly string[];
/**
 * The `/mcp` panel body.
 * @param names - every tool name visible to this agent.
 * @param palette - active role palette.
 * @returns pre-rendered rows for the scrollable panel.
 */
export declare function renderMcpPanel(names: readonly string[], palette: Palette): readonly string[];

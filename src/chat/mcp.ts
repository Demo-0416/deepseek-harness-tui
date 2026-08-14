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

import { displayInlineText } from '../components/text.ts'
import { plural, t } from '../i18n/index.ts'
import type { Palette } from '../components/theme.ts'

/** Prefix `@deepseek-ai/dsh-mcp-client` gives every tool it registers. */
const MCP_TOOL_PREFIX = 'mcp__'

/** Separator between the server namespace and the raw MCP tool name. */
const MCP_NAME_SEPARATOR = '__'

/** One server's tools, as `/mcp` groups them. */
export interface McpServerTools {
  /** The `serverName` its plugin row was configured with. */
  readonly server: string
  /** Raw MCP names, without the public prefix, sorted. */
  readonly tools: readonly string[]
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
export function groupMcpTools(names: readonly string[]): readonly McpServerTools[] {
  const servers = new Map<string, string[]>()
  for (const name of names) {
    if (!name.startsWith(MCP_TOOL_PREFIX)) continue
    const qualified = name.slice(MCP_TOOL_PREFIX.length)
    const separator = qualified.indexOf(MCP_NAME_SEPARATOR)
    // A name with no separator, an empty namespace, or an empty raw name is not
    // a name this client produces: it is an ordinary tool that happens to open
    // with the prefix, and claiming a server for it would invent one.
    if (separator <= 0) continue
    const tool = qualified.slice(separator + MCP_NAME_SEPARATOR.length)
    if (tool === '') continue
    const server = qualified.slice(0, separator)
    const tools = servers.get(server)
    if (tools === undefined) servers.set(server, [tool])
    else tools.push(tool)
  }
  return [...servers]
    .map(([server, tools]) => ({ server, tools: [...tools].sort((a, b) => a.localeCompare(b)) }))
    .sort((a, b) => a.server.localeCompare(b.server))
}

/**
 * The bundle row the empty panel offers to be copied.
 *
 * The client's own README row, kept exact and never translated: this is YAML a
 * user pastes into a profile, so a "localized" field name would produce a
 * config that does not load.
 */
const MCP_EXAMPLE_ROW: readonly string[] = [
  '  - id: mcp-github',
  '    name: \'@deepseek-ai/dsh-mcp-client\'',
  '    config:',
  '      serverName: github',
  '      transport: stdio',
  '      command: npx',
  '      args: [\'-y\', \'@modelcontextprotocol/server-github\']',
]

/**
 * What the panel says when this profile mounts no MCP client.
 *
 * Built per call rather than held in a module constant: a constant would freeze
 * whichever locale happened to be active when this module was first imported,
 * and `/lang` would never reach it again.
 * @returns the block's lines, prose translated and the bundle row verbatim.
 */
export function mcpNotMountedLines(): readonly string[] {
  return [
    ...t('mcp.empty.headline').split('\n'),
    '',
    ...t('mcp.empty.howto').split('\n'),
    '',
    ...MCP_EXAMPLE_ROW,
    '',
    ...t('mcp.empty.transport').split('\n'),
  ]
}

/**
 * The `/mcp` panel body.
 * @param names - every tool name visible to this agent.
 * @param palette - active role palette.
 * @returns pre-rendered rows for the scrollable panel.
 */
export function renderMcpPanel(names: readonly string[], palette: Palette): readonly string[] {
  const servers = groupMcpTools(names)
  if (servers.length === 0) return mcpNotMountedLines().map(line => palette.dim(line))
  const total = servers.reduce((count, server) => count + server.tools.length, 0)
  return [
    palette.dim(t('mcp.summary', {
      servers: plural(servers.length, 'mcp.servers'),
      tools: plural(total, 'mcp.tools'),
    })),
    ...servers.flatMap(server => [
      '',
      `${palette.bold(palette.accent(displayInlineText(server.server)))} ${palette.dim(t('mcp.serverRow', { tools: plural(server.tools.length, 'mcp.tools') }))}`,
      ...server.tools.map(tool => palette.dim(`  ${displayInlineText(tool)}`)),
    ]),
  ]
}

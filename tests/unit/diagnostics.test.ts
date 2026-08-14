/**
 * The two read-only diagnostics panels, at their module boundary: how `/mcp`
 * folds tool names back into the servers that registered them, and what
 * `/doctor` decides about an environment.
 *
 * Both are pure functions of values the entry point reads, which is the point
 * of the split: a mounted terminal can only be asked about the one environment
 * the test process happens to have, while these cases can state a Node version,
 * a pipe, a missing adapter, or an unmounted service and read back the verdict.
 * @module dsh-tui/tests/unit/diagnostics
 */

import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { visibleWidth } from '@earendil-works/pi-tui'
import {
  createTuiTestHarness,
  disposeTuiTestHarness,
  tuiEntryAvailable,
  type TuiHarness,
} from '../harness.ts'
import { HeadlessTerminal } from '../headless-terminal.ts'
import {
  groupMcpTools,
  mcpNotMountedLines,
  renderMcpPanel,
} from '../../src/chat/mcp.ts'
import {
  nodeVersionSupported,
  renderDoctorPanel,
  runDoctorChecks,
  type DoctorCheck,
  type DoctorInputs,
  type DoctorStatus,
} from '../../src/chat/doctor.ts'
import { createPalette } from '../../src/components/theme.ts'
import { setLocale } from '../../src/i18n/index.ts'

/** Color disabled: every assertion here is about text, not escapes. */
const palette = createPalette(false)

/** `src/index.ts` is landed by a separate port; without it the mounted cases cannot run. */
const entryAvailable = await tuiEntryAvailable()
const skipWithoutEntry = entryAvailable
  ? false
  : 'requires src/index.ts to export createTuiChat(ctx, config, runtime)'

/** Literal editor prefix, so a frame assertion never depends on prompt-value registrations. */
const INPUT_PROMPT = 'doctor> '

/** A command handler awaits its own checks before the panel opens; outwait it. */
const SETTLE_MS = 60

/** `TuiController.submit` is the typed-line path; the harness handle only declares disposal. */
interface SubmitHandle {
  submit(text: string): void
}

/** An environment where every check passes, so a case states only its own fact. */
const HEALTHY: DoctorInputs = {
  nodeVersion: 'v22.19.0',
  stdinTty: true,
  stdoutTty: true,
  columns: 100,
  rows: 30,
  color: true,
  truecolor: false,
  providers: ['deepseek'],
  route: { provider: 'deepseek', model: 'deepseek-v4' },
  resolveModelInfo: () => Promise.resolve({}),
  persistence: true,
  presets: true,
  preset: 'standard',
}

/**
 * Run the checks over the healthy environment with `overrides` applied.
 * @param overrides - the facts this case is about.
 * @returns the answered checks, keyed by label for a single-check assertion.
 */
async function checks(overrides: Partial<DoctorInputs> = {}): Promise<Map<string, DoctorCheck>> {
  const answered = await runDoctorChecks({ ...HEALTHY, ...overrides })
  return new Map(answered.map(check => [check.label, check]))
}

/**
 * One check's verdict and the presence of its advice.
 * @param answered - the checks, keyed by label.
 * @param label - the check to read.
 * @returns the status, and the advice line when the check carries one.
 */
function verdict(answered: Map<string, DoctorCheck>, label: string): {
  status: DoctorStatus
  detail: string
  advice: string | undefined
} {
  const check = answered.get(label)
  assert.ok(check !== undefined, `/doctor answers for ${label}`)
  return { status: check.status, detail: check.detail, advice: check.advice }
}

describe('/mcp server grouping', () => {
  it('groups server-qualified names and leaves every other tool out', () => {
    const groups = groupMcpTools([
      'read',
      'mcp__github__create_issue',
      'bash',
      'mcp__web__search',
      'mcp__github__list_issues',
    ])
    assert.deepEqual(groups, [
      { server: 'github', tools: ['create_issue', 'list_issues'] },
      { server: 'web', tools: ['search'] },
    ])
  })

  it('sorts servers and their tools, so the panel does not reorder itself per run', () => {
    const groups = groupMcpTools(['mcp__zed__b', 'mcp__ansible__c', 'mcp__zed__a'])
    assert.deepEqual(groups.map(group => group.server), ['ansible', 'zed'])
    assert.deepEqual(groups[0]?.tools, ['c'])
    assert.deepEqual(groups[1]?.tools, ['a', 'b'])
  })

  it('splits on the first separator, so a raw name may carry one of its own', () => {
    // The client normalizes raw names into the function-name charset, which
    // keeps `_`: only the server namespace is written by the deployment, so
    // everything after the first `__` belongs to the server's own name.
    assert.deepEqual(groupMcpTools(['mcp__fs__read__file']), [
      { server: 'fs', tools: ['read__file'] },
    ])
  })

  it('claims no server for a name that only opens with the prefix', () => {
    // A half-formed name is an ordinary tool, not a server with no tools: an
    // invented namespace would be reported as a mounted server.
    assert.deepEqual(groupMcpTools(['mcp__lonely', 'mcp____empty', 'mcp__server__', 'mcp__']), [])
  })

  it('answers an empty registry with how to mount a server, not an empty list', () => {
    const lines = renderMcpPanel(['read', 'bash'], palette)
    assert.deepEqual(lines, mcpNotMountedLines())
    const text = lines.join('\n')
    assert.match(text, /@deepseek-ai\/dsh-mcp-client/u)
    assert.match(text, /serverName: github/u)
    assert.match(text, /mcp__<serverName>__<rawName>/u)
  })

  it('counts servers and tools above the list it renders', () => {
    const lines = renderMcpPanel(['mcp__github__create_issue', 'mcp__web__search', 'read'], palette)
    assert.equal(lines[0], '2 servers · 2 tools')
    const text = lines.join('\n')
    assert.match(text, /github \(1 tool\)/u)
    assert.match(text, /\n {2}create_issue/u)
  })
})

describe('/doctor Node check', () => {
  it('accepts exactly the versions this bundle is published for', () => {
    for (const version of ['v22.19.0', 'v22.20.1', 'v24.0.0', 'v26.1.0']) {
      assert.ok(nodeVersionSupported(version), `${version} is supported`)
    }
    for (const version of ['v22.18.9', 'v20.11.0', 'v23.5.0', 'not-a-version']) {
      assert.ok(!nodeVersionSupported(version), `${version} is not supported`)
    }
  })

  it('reports the running version and, when it is out of range, the range', async () => {
    assert.deepEqual(verdict(await checks(), 'Node'), {
      status: 'pass',
      detail: 'v22.19.0',
      advice: undefined,
    })
    const old = verdict(await checks({ nodeVersion: 'v20.11.0' }), 'Node')
    assert.equal(old.status, 'fail')
    // The range is stated as the semver range `engines.node` carries, with no
    // English connective in it: it is interpolated into a translated sentence.
    assert.match(old.advice ?? '', /\^22\.19\.0 \|\| >=24\.0\.0/u)
  })
})

describe('/doctor terminal checks', () => {
  it('names which end of the terminal is not a TTY', async () => {
    assert.equal(verdict(await checks(), 'Terminal').status, 'pass')
    const piped = verdict(await checks({ stdoutTty: false }), 'Terminal')
    assert.equal(piped.status, 'fail')
    assert.equal(piped.detail, 'stdout is not a TTY')
    assert.match(piped.advice ?? '', /--print/u)
    assert.equal(verdict(await checks({ stdinTty: false, stdoutTty: false }), 'Terminal').detail,
      'stdin and stdout are not a TTY')
  })

  it('warns about a window the layout does not fit in', async () => {
    assert.deepEqual(verdict(await checks(), 'Screen'), {
      status: 'pass',
      detail: '100x30',
      advice: undefined,
    })
    const narrow = verdict(await checks({ columns: 40 }), 'Screen')
    assert.equal(narrow.status, 'warn')
    assert.match(narrow.advice ?? '', /columns/u)
    const short = verdict(await checks({ rows: 6 }), 'Screen')
    assert.equal(short.status, 'warn')
    assert.match(short.advice ?? '', /rows/u)
  })

  it('says when the palette is off, and when the brand art may use truecolor', async () => {
    assert.equal(verdict(await checks(), 'Color').detail, '16-color palette')
    assert.equal(verdict(await checks({ truecolor: true }), 'Color').detail,
      '16-color palette, truecolor brand art')
    const off = verdict(await checks({ color: false }), 'Color')
    assert.equal(off.status, 'warn')
    assert.match(off.advice ?? '', /theme\.color/u)
  })
})

describe('/doctor model check', () => {
  it('passes only once the route actually resolves', async () => {
    const asked: string[] = []
    const answered = await checks({
      resolveModelInfo: (provider, model) => {
        asked.push(`${provider}/${model}`)
        return Promise.resolve({})
      },
    })
    assert.deepEqual(asked, ['deepseek/deepseek-v4'])
    const model = verdict(answered, 'Model')
    assert.equal(model.status, 'pass')
    assert.match(model.detail, /deepseek\/deepseek-v4 resolves \(providers: deepseek\)/u)
  })

  it('separates an empty provider list from an unselected route', async () => {
    const none = verdict(await checks({ providers: [], route: undefined }), 'Model')
    assert.equal(none.status, 'fail')
    assert.match(none.detail, /no LLM provider is registered/u)
    const unset = verdict(await checks({ route: undefined }), 'Model')
    assert.equal(unset.status, 'fail')
    assert.match(unset.advice ?? '', /\/model/u)
  })

  it('recognizes a missing adapter by its code, never by its class', async () => {
    // The bundle and its host each resolve their own `@deepseek-ai/dsh-llm`, so
    // an `instanceof LlmError` guard is false for the very error it exists to
    // recognize: the check reads `code`, which a plain object carries too.
    const missing = verdict(await checks({
      resolveModelInfo: () => Promise.reject(Object.assign(new Error('no adapter'), { code: 'NO_ADAPTER' })),
    }), 'Model')
    assert.equal(missing.status, 'fail')
    assert.match(missing.detail, /has no registered adapter/u)
    assert.match(missing.advice ?? '', /"deepseek"/u)
  })

  it('reports any other rejection as the adapter refusing the lookup', async () => {
    const refused = verdict(await checks({
      resolveModelInfo: () => Promise.reject(new Error('401 unauthorized')),
    }), 'Model')
    assert.equal(refused.status, 'fail')
    assert.match(refused.detail, /401 unauthorized/u)
    assert.match(refused.advice ?? '', /credentials/u)
  })
})

describe('/doctor mounted services', () => {
  it('warns when nothing writes the session down', async () => {
    assert.equal(verdict(await checks(), 'Persistence').status, 'pass')
    const memory = verdict(await checks({ persistence: false }), 'Persistence')
    assert.equal(memory.status, 'warn')
    assert.match(memory.advice ?? '', /resumed/u)
  })

  it('separates a missing roster from a session that joined no preset', async () => {
    assert.equal(verdict(await checks(), 'Preset').detail, 'standard')
    const rosterless = verdict(await checks({ presets: false, preset: undefined }), 'Preset')
    assert.equal(rosterless.status, 'warn')
    assert.match(rosterless.detail, /no agent-preset roster/u)
    const unjoined = verdict(await checks({ preset: undefined }), 'Preset')
    assert.equal(unjoined.status, 'warn')
    assert.match(unjoined.advice ?? '', /\/preset/u)
  })
})

describe('/doctor panel', () => {
  it('opens with the outcome and prints one row per check, advice indented under it', async () => {
    const answered = [...(await checks({ persistence: false, nodeVersion: 'v20.0.0' })).values()]
    const lines = renderDoctorPanel(answered, palette)
    assert.equal(lines[0], '1 failed · 1 to look at')
    const node = lines.find(line => line.includes('Node'))
    assert.ok(node?.startsWith('✗ '), `a failed check is marked: ${String(node)}`)
    assert.ok(lines.some(line => line.includes('✓ Terminal')), 'a passing check is marked')
    const advice = lines.findIndex(line => line.includes('→ this bundle is published for Node'))
    assert.ok(advice > 0 && lines[advice - 1] === node, 'the advice follows the row it belongs to')
    // The remedy starts in the detail column, under the observation it answers.
    assert.equal(
      lines[advice]?.indexOf('this bundle'),
      node?.indexOf('v20.0.0'),
      'the advice text lines up with the detail above it',
    )
  })

  it('says so plainly when nothing needs looking at', async () => {
    const lines = renderDoctorPanel([...(await checks()).values()], palette)
    assert.match(lines[0] ?? '', /Everything this terminal depends on is in place\./u)
    assert.ok(lines.every(line => !line.includes('→')), 'a healthy environment carries no advice')
  })
})

describe('both panels answer /lang', () => {
  // The locale is process-wide by design, and the rest of the suite renders its
  // fixtures in English.
  afterEach(() => { setLocale('en') })

  it('renders the empty-registry block in the active language, keeping the bundle row verbatim', () => {
    setLocale('zh')
    const text = renderMcpPanel(['read'], palette).join('\n')
    assert.match(text, /本 agent 没有注册任何 MCP 工具。/u)
    // The YAML is config a user pastes: a translated field name would produce a
    // profile that does not load.
    assert.match(text, /name: '@deepseek-ai\/dsh-mcp-client'/u)
    assert.match(text, /serverName: github/u)
  })

  it('counts servers and tools in the active language', () => {
    setLocale('zh')
    assert.equal(renderMcpPanel(['mcp__github__a', 'mcp__web__b'], palette)[0], '2 个 server · 2 个工具')
  })

  it('translates every /doctor row it prints, labels included', async () => {
    setLocale('zh')
    const answered = await checks({ persistence: false })
    const lines = renderDoctorPanel([...answered.values()], palette)
    assert.equal(lines[0], '1 项需要留意')
    const text = lines.join('\n')
    assert.match(text, /✓ 终端\s+stdin 与 stdout 都是 TTY/u)
    assert.match(text, /! 持久化\s+未挂载 sessionPersistence/u)
    assert.match(text, /→ 本会话只存在于内存中/u)
  })

  it('lines the detail column up when a label is CJK and costs two columns per character', async () => {
    setLocale('zh')
    // A healthy environment carries no advice, so the rows below the summary and
    // its blank line are one per check, in order.
    const answered = [...(await checks()).values()]
    const rows = renderDoctorPanel(answered, palette).slice(2)
    // `Node` is 4 columns and `持久化` is 6, but in code units both are 4 and 3:
    // padding by `length` would start every detail somewhere else.
    const columns = rows.map((row, index) => {
      const detail = answered[index]?.detail ?? ''
      const at = row.indexOf(detail)
      assert.ok(at > 0, `row ${index} states its detail: ${row}`)
      return visibleWidth(row.slice(0, at))
    })
    assert.equal(new Set(columns).size, 1, `every detail starts in one column: ${columns.join(', ')}`)
  })
})

describe('mounted /mcp and /doctor', { skip: skipWithoutEntry }, () => {
  /**
   * Mount a terminal whose registry carries `names` as tools.
   * @param names - tool names to register, MCP-qualified or otherwise.
   * @returns the mounted harness.
   */
  async function mount(names: readonly string[] = []): Promise<TuiHarness<HeadlessTerminal, (code: number) => void>> {
    const terminal = new HeadlessTerminal(100, 40)
    const before = terminal.frames
    const harness = await createTuiTestHarness(terminal, () => {}, {
      cwd: '/workspace/project',
      tools: Object.fromEntries(names.map(name => [name, defineTool({
        name,
        description: `${name} fixture`,
        parameters: {},
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        execute: () => Promise.resolve('done'),
      })])),
      config: {
        title: 'DSH diagnostics',
        welcome: 'ready.',
        theme: { color: false, inputPrompt: INPUT_PROMPT },
      },
    })
    await terminal.waitForFrame(before)
    return harness
  }

  /**
   * Submit a command and read the frame its panel settled on.
   * @param harness - the mounted terminal.
   * @param command - the command line to submit.
   * @returns the rendered screen.
   */
  async function run(
    harness: TuiHarness<HeadlessTerminal, (code: number) => void>,
    command: string,
  ): Promise<string> {
    ;(harness.controller as unknown as SubmitHandle).submit(command)
    await delay(SETTLE_MS)
    return harness.terminal.text()
  }

  it('reads the registry this agent sees, and groups it by server', async () => {
    const harness = await mount(['mcp__github__create_issue', 'mcp__github__list_issues', 'mcp__web__search'])
    try {
      const frame = await run(harness, '/mcp')
      assert.match(frame, /\/mcp/u, `the panel is titled by the command that opened it:\n${frame}`)
      assert.match(frame, /2 servers · 3 tools/u)
      assert.match(frame, /create_issue/u)
    } finally {
      await disposeTuiTestHarness(harness)
      await harness.terminal.dispose()
    }
  })

  it('tells a profile with no MCP row how to mount one', async () => {
    const harness = await mount()
    try {
      assert.match(await run(harness, '/mcp'), /@deepseek-ai\/dsh-mcp-client/u)
    } finally {
      await disposeTuiTestHarness(harness)
      await harness.terminal.dispose()
    }
  })

  it('answers /doctor with one row per check', async () => {
    const harness = await mount()
    try {
      const frame = await run(harness, '/doctor')
      for (const label of ['Node', 'Terminal', 'Screen', 'Color', 'Model', 'Persistence', 'Preset']) {
        assert.match(frame, new RegExp(`[✓!✗] ${label}`, 'u'), `/doctor answers for ${label}:\n${frame}`)
      }
    } finally {
      await disposeTuiTestHarness(harness)
      await harness.terminal.dispose()
    }
  })
})

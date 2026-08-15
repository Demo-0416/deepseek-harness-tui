/**
 * The update check: version ordering, the once-a-day throttle behind it, its
 * silence on every failure, and the one notice a mounted terminal writes when
 * there really is a newer release.
 *
 * No case here touches the network. The module cases inject `fetchLatest`; the
 * mounted cases replace the global `fetch` with one that counts its calls, so
 * "sends no request" is an assertion rather than a hope, and a regression that
 * reached the real registry would fail instead of quietly slowing CI down.
 * Every case that writes a cache points `$DSH_HOME` at a directory of its own.
 * @module dsh-tui/tests/unit/update-check
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import {
  createTuiTestHarness,
  disposeTuiTestHarness,
  tuiEntryAvailable,
  type TuiHarness,
  type TuiHarnessOptions,
} from '../harness.ts'
import { HeadlessTerminal } from '../headless-terminal.ts'
import { packageVersion } from '../../src/chat/helpers.ts'
import {
  checkForUpdate,
  compareSemver,
  updateCommandLine,
  UPDATE_CHECK_FILE_NAME,
  UPDATE_CHECK_PACKAGE_NAME,
  UPDATE_CHECK_TTL_MS,
  type UpdateCheckCache,
} from '../../src/chat/update-check.ts'

/** `src/index.ts` is landed by a separate port; without it the end-to-end suite cannot run. */
const entryAvailable = await tuiEntryAvailable()
const skipWithoutEntry = entryAvailable
  ? false
  : 'requires src/index.ts to export createTuiChat(ctx, config, runtime)'

/** A notice lands a few awaits after the first frame; outwait them. */
const SETTLE_MS = 120

/** A fixed clock, so "a day ago" is exact rather than approximate. */
const NOW = 1_700_000_000_000

/** Point `$DSH_HOME` at a directory of this case's own, and put it back afterwards. */
async function inTempHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-tui-update-home-'))
  const previous = process.env['DSH_HOME']
  process.env['DSH_HOME'] = home
  try {
    await run(home)
  } finally {
    if (previous === undefined) delete process.env['DSH_HOME']
    else process.env['DSH_HOME'] = previous
    await rm(home, { recursive: true, force: true })
  }
}

/** A `fetchLatest` that answers one version and counts how often it was asked. */
function counting(latest: string | undefined): {
  fetchLatest: (name: string, signal: AbortSignal | undefined) => Promise<string | undefined>
  calls: string[]
} {
  const calls: string[] = []
  return {
    calls,
    fetchLatest: (name) => {
      calls.push(name)
      return Promise.resolve(latest)
    },
  }
}

/** Write one cache file by hand, the way a previous process would have left it. */
async function seedCache(home: string, cache: UpdateCheckCache | string): Promise<string> {
  const path = join(home, UPDATE_CHECK_FILE_NAME)
  await writeFile(path, typeof cache === 'string' ? cache : JSON.stringify(cache), 'utf8')
  return path
}

describe('compareSemver', () => {
  it('orders releases by major, minor, then patch', () => {
    const cases: [string, string, 'older' | 'newer' | 'same'][] = [
      ['0.1.8', '0.2.0', 'older'],
      ['0.2.0', '0.1.8', 'newer'],
      ['1.0.0', '0.99.99', 'newer'],
      ['0.10.0', '0.9.0', 'newer'],
      ['0.1.10', '0.1.9', 'newer'],
      ['1.2.3', '1.2.3', 'same'],
      ['v1.2.3', '1.2.3', 'same'],
      // Build metadata is not part of the order, semver §10.
      ['1.2.3+build.5', '1.2.3', 'same'],
    ]
    for (const [a, b, expected] of cases) {
      const sign = compareSemver(a, b)
      const actual = sign < 0 ? 'older' : sign > 0 ? 'newer' : 'same'
      assert.equal(actual, expected, `${a} is ${expected} than ${b} (got ${String(sign)})`)
    }
  })

  it('puts a release above its own prereleases', () => {
    assert.ok(compareSemver('0.2.0', '0.2.0-rc.1') > 0)
    assert.ok(compareSemver('0.2.0-rc.1', '0.2.0') < 0)
    // …and above the previous release, prerelease or not.
    assert.ok(compareSemver('0.2.0-rc.1', '0.1.9') > 0)
  })

  it('orders prerelease identifiers the way semver §11 does', () => {
    assert.ok(compareSemver('1.0.0-alpha', '1.0.0-alpha.1') < 0)
    assert.ok(compareSemver('1.0.0-alpha.1', '1.0.0-alpha.beta') < 0)
    assert.ok(compareSemver('1.0.0-alpha.beta', '1.0.0-beta') < 0)
    assert.ok(compareSemver('1.0.0-beta.2', '1.0.0-beta.11') < 0)
    assert.ok(compareSemver('1.0.0-rc.1', '1.0.0') < 0)
    assert.equal(compareSemver('1.0.0-rc.1', '1.0.0-rc.1'), 0)
  })

  it('calls anything it cannot parse equal, so a strange version is never an update', () => {
    for (const bad of ['', 'latest', '1.2', '1.2.3.4', 'v', '1.2.x', 'not a version', '01.2.3-']) {
      assert.equal(compareSemver(bad, '1.0.0'), 0, `"${bad}" compares equal`)
      assert.equal(compareSemver('1.0.0', bad), 0, `"${bad}" compares equal on the right`)
    }
  })
})

describe('checkForUpdate throttling', () => {
  it('answers from the cache without asking the registry inside the ttl', async () => {
    await inTempHome(async (home) => {
      const path = await seedCache(home, { checkedAt: NOW - 60_000, latest: '9.9.9' })
      const registry = counting('7.7.7')
      const result = await checkForUpdate({
        name: UPDATE_CHECK_PACKAGE_NAME,
        currentVersion: '0.1.8',
        cachePath: path,
        fetchLatest: registry.fetchLatest,
        now: () => NOW,
      })

      assert.deepEqual(result, { latest: '9.9.9', hasUpdate: true })
      assert.deepEqual(registry.calls, [])
    })
  })

  it('asks again once the cached answer is older than the ttl', async () => {
    await inTempHome(async (home) => {
      const path = await seedCache(home, { checkedAt: NOW - UPDATE_CHECK_TTL_MS - 1, latest: '0.1.8' })
      const registry = counting('0.2.0')
      const result = await checkForUpdate({
        name: UPDATE_CHECK_PACKAGE_NAME,
        currentVersion: '0.1.8',
        cachePath: path,
        fetchLatest: registry.fetchLatest,
        now: () => NOW,
      })

      assert.deepEqual(result, { latest: '0.2.0', hasUpdate: true })
      assert.deepEqual(registry.calls, [UPDATE_CHECK_PACKAGE_NAME])
      // The fresh answer replaces the stale one, with the time it was taken.
      const written = JSON.parse(await readFile(path, 'utf8')) as UpdateCheckCache
      assert.deepEqual(written, { checkedAt: NOW, latest: '0.2.0' })
    })
  })

  it('treats a cache from the future as expired rather than as valid forever', async () => {
    await inTempHome(async (home) => {
      // A clock that moved backwards, or a home directory copied off another
      // machine: a plain `age < ttl` would have pinned this answer until the
      // clock caught up.
      const path = await seedCache(home, { checkedAt: NOW + UPDATE_CHECK_TTL_MS, latest: '9.9.9' })
      const registry = counting('0.2.0')
      const result = await checkForUpdate({
        name: UPDATE_CHECK_PACKAGE_NAME,
        currentVersion: '0.1.8',
        cachePath: path,
        fetchLatest: registry.fetchLatest,
        now: () => NOW,
      })

      assert.deepEqual(result, { latest: '0.2.0', hasUpdate: true })
      assert.deepEqual(registry.calls, [UPDATE_CHECK_PACKAGE_NAME])
    })
  })

  it('reads a corrupt or half-written cache as no cache at all', async () => {
    for (const corrupt of ['', '{', 'null', '[]', '{"checkedAt":"soon","latest":"1.0.0"}', '{"checkedAt":1}']) {
      await inTempHome(async (home) => {
        const path = await seedCache(home, corrupt)
        const registry = counting('0.2.0')
        const result = await checkForUpdate({
          name: UPDATE_CHECK_PACKAGE_NAME,
          currentVersion: '0.1.8',
          cachePath: path,
          fetchLatest: registry.fetchLatest,
          now: () => NOW,
        })

        assert.deepEqual(result, { latest: '0.2.0', hasUpdate: true }, `"${corrupt}" is not a cache`)
        assert.deepEqual(registry.calls, [UPDATE_CHECK_PACKAGE_NAME], `"${corrupt}" is asked past`)
      })
    }
  })

  it('starts the cache when there is no file yet', async () => {
    await inTempHome(async (home) => {
      const path = join(home, 'nested', UPDATE_CHECK_FILE_NAME)
      const registry = counting('0.1.8')
      const result = await checkForUpdate({
        name: UPDATE_CHECK_PACKAGE_NAME,
        currentVersion: '0.1.8',
        cachePath: path,
        fetchLatest: registry.fetchLatest,
        now: () => NOW,
      })

      // Same version: an answer, and not an update.
      assert.deepEqual(result, { latest: '0.1.8', hasUpdate: false })
      const written = JSON.parse(await readFile(path, 'utf8')) as UpdateCheckCache
      assert.deepEqual(written, { checkedAt: NOW, latest: '0.1.8' })
    })
  })

  it('does not call an older published version an update', async () => {
    await inTempHome(async (home) => {
      const result = await checkForUpdate({
        name: UPDATE_CHECK_PACKAGE_NAME,
        currentVersion: '0.3.0',
        cachePath: join(home, UPDATE_CHECK_FILE_NAME),
        fetchLatest: counting('0.2.0').fetchLatest,
        now: () => NOW,
      })

      assert.deepEqual(result, { latest: '0.2.0', hasUpdate: false })
    })
  })
})

describe('checkForUpdate silence', () => {
  it('answers nothing when the registry read fails', async () => {
    await inTempHome(async (home) => {
      const path = join(home, UPDATE_CHECK_FILE_NAME)
      const result = await checkForUpdate({
        name: UPDATE_CHECK_PACKAGE_NAME,
        currentVersion: '0.1.8',
        cachePath: path,
        fetchLatest: () => Promise.reject(new Error('getaddrinfo ENOTFOUND registry.npmjs.org')),
        now: () => NOW,
      })

      assert.equal(result, undefined)
      // Nothing is cached either: a failure must not throttle the next attempt.
      await assert.rejects(readFile(path, 'utf8'))
    })
  })

  it('answers nothing when the read is aborted, and leaves the cache alone', async () => {
    await inTempHome(async (home) => {
      const path = join(home, UPDATE_CHECK_FILE_NAME)
      const controller = new AbortController()
      const result = await checkForUpdate({
        name: UPDATE_CHECK_PACKAGE_NAME,
        currentVersion: '0.1.8',
        cachePath: path,
        signal: controller.signal,
        fetchLatest: (_name, signal) => new Promise((_resolve, reject) => {
          // What a timed-out or disposed read looks like from here.
          signal?.addEventListener('abort', () => { reject(new Error('This operation was aborted')) })
          controller.abort(new Error('TUI disposed'))
        }),
        now: () => NOW,
      })

      assert.equal(result, undefined)
      await assert.rejects(readFile(path, 'utf8'))
    })
  })

  it('answers nothing for a registry that names no version', async () => {
    await inTempHome(async (home) => {
      for (const answer of [undefined, '', '   ']) {
        const result = await checkForUpdate({
          name: UPDATE_CHECK_PACKAGE_NAME,
          currentVersion: '0.1.8',
          cachePath: join(home, UPDATE_CHECK_FILE_NAME),
          fetchLatest: () => Promise.resolve(answer),
          now: () => NOW,
        })
        assert.equal(result, undefined, `"${String(answer)}" is not a version`)
      }
    })
  })

  it('never speaks up about a version it cannot compare', async () => {
    await inTempHome(async (home) => {
      const result = await checkForUpdate({
        name: UPDATE_CHECK_PACKAGE_NAME,
        currentVersion: '0.1.8',
        cachePath: join(home, UPDATE_CHECK_FILE_NAME),
        fetchLatest: counting('nightly').fetchLatest,
        now: () => NOW,
      })

      assert.deepEqual(result, { latest: 'nightly', hasUpdate: false })
    })
  })
})

describe('updateCommandLine', () => {
  it('names the package the notice tells the user to install', () => {
    assert.equal(updateCommandLine(), `npm install -g ${UPDATE_CHECK_PACKAGE_NAME}@latest`)
    assert.equal(updateCommandLine('other-pkg'), 'npm install -g other-pkg@latest')
  })
})

type UpdateHarness = TuiHarness<HeadlessTerminal, (code: number) => void>

/**
 * Replace the global `fetch` for one case, answering the npm registry with a
 * fixed version and recording every URL that was asked for.
 * @param version - the `latest` version the fake registry publishes.
 * @param run - the case, given the list the requests land in.
 */
async function withFakeRegistry(version: string, run: (requests: string[]) => Promise<void>): Promise<void> {
  const requests: string[] = []
  const original = globalThis.fetch
  globalThis.fetch = ((input: unknown) => {
    requests.push(String(input))
    return Promise.resolve(new Response(JSON.stringify({ version }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
  }) as typeof fetch
  try {
    await run(requests)
  } finally {
    globalThis.fetch = original
  }
}

async function mount(options: TuiHarnessOptions = {}): Promise<UpdateHarness> {
  const terminal = new HeadlessTerminal(96, 32)
  const before = terminal.frames
  const harness = await createTuiTestHarness(terminal, () => {}, {
    ...options,
    config: {
      title: 'DSH update',
      welcome: 'ready.',
      ...options.config,
      theme: { color: false, ...options.config?.theme },
    },
  })
  await terminal.waitForFrame(before)
  return harness
}

async function unmount(harness: UpdateHarness): Promise<void> {
  await disposeTuiTestHarness(harness)
  await harness.terminal.dispose()
}

/** The frame with its own line wrapping collapsed, so a sentence reads as a sentence. */
function unwrapped(frame: string): string {
  return frame.replace(/\s+/gu, ' ')
}

describe('a terminal that mentions a newer release', { skip: skipWithoutEntry }, () => {
  it('writes one notice naming both versions and the command', async () => {
    await inTempHome(async (home) => {
      await withFakeRegistry('99.0.0', async (requests) => {
        const harness = await mount({ config: { updateCheck: true } })
        try {
          await delay(SETTLE_MS)
          const frame = unwrapped(harness.terminal.text())
          const current = packageVersion()
          assert.ok(current !== undefined, 'the bundle states its own version')
          assert.ok(
            frame.includes(`Update available: ${current} → 99.0.0`),
            `the terminal names both versions:\n${frame}`,
          )
          assert.ok(
            frame.includes(`npm install -g ${UPDATE_CHECK_PACKAGE_NAME}@latest`),
            `the terminal names the command:\n${frame}`,
          )
          // One question, asked of the registry this module documents.
          assert.equal(requests.length, 1)
          assert.equal(requests[0], `https://registry.npmjs.org/${UPDATE_CHECK_PACKAGE_NAME}/latest`)
        } finally {
          await unmount(harness)
        }
      })
      // …and the answer is on disk, so the next terminal today asks nothing.
      const cached = JSON.parse(await readFile(join(home, UPDATE_CHECK_FILE_NAME), 'utf8')) as UpdateCheckCache
      assert.equal(cached.latest, '99.0.0')
    })
  })

  it('says nothing when the published version is the one running', async () => {
    await inTempHome(async () => {
      const current = packageVersion()
      assert.ok(current !== undefined, 'the bundle states its own version')
      await withFakeRegistry(current, async (requests) => {
        const harness = await mount({ config: { updateCheck: true } })
        try {
          await delay(SETTLE_MS)
          assert.equal(requests.length, 1)
          assert.ok(
            !unwrapped(harness.terminal.text()).includes('Update available'),
            'an up-to-date terminal stays quiet',
          )
        } finally {
          await unmount(harness)
        }
      })
    })
  })

  it('answers from the day-old cache instead of asking again', async () => {
    await inTempHome(async (home) => {
      await seedCache(home, { checkedAt: Date.now(), latest: '99.0.0' })
      await withFakeRegistry('99.0.0', async (requests) => {
        const harness = await mount({ config: { updateCheck: true } })
        try {
          await delay(SETTLE_MS)
          assert.ok(
            unwrapped(harness.terminal.text()).includes('Update available'),
            'the cached answer still reaches the screen',
          )
          assert.deepEqual(requests, [], 'a fresh cache sends no request')
        } finally {
          await unmount(harness)
        }
      })
    })
  })

  it('sends no request at all when the deployment turned the check off', async () => {
    await inTempHome(async (home) => {
      // A cache that would have produced a notice, so the only thing keeping it
      // off the screen is the setting itself.
      await seedCache(home, { checkedAt: Date.now(), latest: '99.0.0' })
      await withFakeRegistry('99.0.0', async (requests) => {
        const harness = await mount({ config: { updateCheck: false } })
        try {
          await delay(SETTLE_MS)
          assert.deepEqual(requests, [], 'updateCheck: false reaches no registry')
          assert.ok(
            !unwrapped(harness.terminal.text()).includes('Update available'),
            'updateCheck: false writes no notice',
          )
        } finally {
          await unmount(harness)
        }
      })
    })
  })

  it('leaves a check running at disposal without writing to a terminal that is gone', async () => {
    await inTempHome(async () => {
      const original = globalThis.fetch
      let released = (): void => {}
      const held = new Promise<void>((resolve) => { released = resolve })
      globalThis.fetch = ((_input: unknown, init?: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
        // Never answers on its own; only the terminal's disposal ends it.
        init?.signal?.addEventListener('abort', () => {
          reject(new Error('This operation was aborted'))
          released()
        })
      })) as typeof fetch
      try {
        const harness = await mount({ config: { updateCheck: true } })
        await unmount(harness)
        await held
        // Nothing to assert on screen — the terminal is down. The point is that
        // the abort fired and the process is not still waiting on a socket.
        assert.ok(true)
      } finally {
        globalThis.fetch = original
      }
    })
  })
})

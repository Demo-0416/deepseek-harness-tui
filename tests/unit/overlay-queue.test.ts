/**
 * The inline modal slot's ordering rules, at the manager boundary rather than
 * through a mounted TUI.
 *
 * One surface owns the slot at a time. A surface a user merely reads (a command
 * panel, the model selector) is marked dismissable and yields it to an arriving
 * decision; a surface that carries a decision the agent is blocked on is not,
 * and concurrent asks keep queueing FIFO behind each other. The two rules have
 * to hold together — dismissal must not reorder the queue — which is what these
 * cases pin.
 * @module dsh-tui/tests/unit/overlay-queue
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  dismissableOverlays,
  TuiOverlayManager,
  type TuiOverlayDriver,
} from '../../src/extension/overlay-manager.ts'
import type { TuiComponent, TuiTheme, TuiViewport } from '../../src/extension/types.ts'

/** A component that renders only its own name: these cases are about ownership. */
function named(name: string): TuiComponent {
  return { render: () => [name], invalidate: () => true }
}

/** The mounted-surface log a driver records, newest last. */
interface Recorder {
  readonly manager: TuiOverlayManager
  /** Names of the surfaces shown, in the order the manager mounted them. */
  readonly shown: string[]
  /** Names of the surfaces hidden, in the order the manager took them down. */
  readonly hidden: string[]
  /** The surface currently holding the slot, or `undefined`. */
  current(): string | undefined
}

/** A manager over a driver that only records which surface owns the slot. */
function recorder(): Recorder {
  const shown: string[] = []
  const hidden: string[] = []
  let active: string | undefined
  const driver: TuiOverlayDriver = {
    viewport: (): TuiViewport => ({ columns: 80, rows: 24 }),
    theme: (): TuiTheme => ({} as TuiTheme),
    display: value => value,
    show: (component) => {
      // The manager wraps every component in its own guard, so the name travels
      // on the render call the guard forwards.
      const name = String(component.render(80)[0] ?? '?')
      shown.push(name)
      active = name
      return {
        hide: () => {
          hidden.push(name)
          if (active === name) active = undefined
        },
      }
    },
    invalidate: () => {},
    reportError: (error: unknown) => { throw error },
  }
  const manager = new TuiOverlayManager(driver)
  return { manager, shown, hidden, current: () => active }
}

/** Open one inline surface that renders its own name, so the driver can log it. */
function open(
  manager: TuiOverlayManager,
  name: string,
  options: { readonly dismissable?: boolean } = {},
): ReturnType<TuiOverlayManager['open']> {
  return manager.open({
    create: () => named(name),
    ...options.dismissable === true ? { dismissable: true } : {},
  }, 'inline')
}

/** Let every `queueMicrotask` the manager scheduled run. */
async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('inline overlay queue', () => {
  it('queues two blocking asks FIFO rather than letting one replace the other', async () => {
    const { manager, shown, current } = recorder()
    const question = open(manager, 'question')
    const approval = open(manager, 'approval')

    assert.equal(current(), 'question', 'the first ask owns the slot')
    assert.deepEqual(shown, ['question'], 'and the second one is not mounted over it')

    void question.close()
    await settle()
    assert.equal(current(), 'approval', 'the second ask follows the first')
    assert.deepEqual(shown, ['question', 'approval'])
    void approval.close()
    await settle()
    assert.equal(current(), undefined)
  })

  it('dismisses a panel for an arriving ask without jumping it over an earlier one', async () => {
    const { manager, shown, hidden, current } = recorder()
    open(manager, 'panel', { dismissable: true })
    const first = open(manager, 'first-ask')
    // The panel yielded, so the earlier ask took the slot; a second ask arriving
    // now must still wait for it.
    assert.equal(current(), 'first-ask')
    assert.deepEqual(hidden, ['panel'])

    open(manager, 'second-ask')
    assert.equal(current(), 'first-ask', 'a non-dismissable surface is not taken down')

    void first.close()
    await settle()
    assert.equal(current(), 'second-ask')
    assert.deepEqual(shown, ['panel', 'first-ask', 'second-ask'])
  })

  it('settles the dismissed panel rather than leaving its caller waiting', async () => {
    const { manager } = recorder()
    const panel = open(manager, 'panel', { dismissable: true })
    open(manager, 'question')

    assert.deepEqual(await panel.closed, { reason: 'closed' })
    assert.equal(panel.state, 'closed')
  })

  it('reopens a dismissed panel normally once the ask is answered', async () => {
    const { manager, shown, current } = recorder()
    open(manager, 'panel', { dismissable: true })
    const question = open(manager, 'question')
    void question.close()
    await settle()

    open(manager, 'panel', { dismissable: true })
    assert.equal(current(), 'panel')
    assert.deepEqual(shown, ['panel', 'question', 'panel'])
  })

  it('replaces one dismissable surface with the next, keeping a single slot', async () => {
    const { manager, hidden, current } = recorder()
    open(manager, 'help', { dismissable: true })
    open(manager, 'status', { dismissable: true })

    assert.equal(current(), 'status')
    assert.deepEqual(hidden, ['help'])
  })

  it('leaves an extension overlay alone: absent means not dismissable', async () => {
    const { manager, shown, hidden, current } = recorder()
    manager.open({ create: () => named('extension') }, 'overlay')
    open(manager, 'question')

    // The extension's caller is awaiting an outcome, so the inline request
    // queues behind it instead of taking it down.
    assert.equal(current(), 'extension')
    assert.deepEqual(hidden, [])
    assert.deepEqual(shown, ['extension'])
  })

  it('marks every surface a sub-controller opens through the forwarding view', async () => {
    const { manager, hidden, current } = recorder()
    open(dismissableOverlays(manager), 'model-selector')
    open(manager, 'approval')

    assert.equal(current(), 'approval')
    assert.deepEqual(hidden, ['model-selector'], 'the view marks what the controller never flags itself')
  })
})

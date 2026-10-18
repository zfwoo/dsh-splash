/**
 * Execute the injected controller against the harness DOM.
 *
 * This is the regression test for the part of the plugin that reading cannot
 * check: the pre-React controller, its animation timers, and — the reason this
 * file exists — `preview()`, which is only reachable from a settings-row click
 * and so had no test at all before a report that previewing did nothing.
 *
 * Usage:
 *   node tools/controller.test.mjs
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { after, createDom, runController } from './dom.mjs'

const plugin = await import('../index.js')

/** Drive `apply` against a stub Context and return the injection table. */
function collect(config, home) {
  const listeners = []
  plugin.apply({
    listeners,
    on(event, listener) { listeners.push({ event, listener }) },
    effect(callback) { return callback() },
    webServer: { register() { return () => {} } },
    connection: { requestRejection: () => undefined },
  }, { ...config, dshHome: home })
  const table = []
  for (const { event, listener } of listeners) {
    if (event === 'webserver/index-inject') listener(table)
  }
  return table
}

const home = mkdtempSync(join(tmpdir(), 'dsh-splash-controller-'))

/** The full injection table for one config. */
const tableFor = (config) => collect(config, home)

const overlay = (dom) => dom.document.getElementById('dsh-splash')
const logLines = (dom) => overlay(dom)?.querySelector('[data-dsh-splash-log]')?.childElementCount ?? 0

/** Run one scenario and always tear the timers down afterwards. */
async function scenario(name, config, body) {
  const table = tableFor(config)
  const html = table.find((row) => row.kind === 'html').html
  const dom = createDom(html)
  const run = runController(dom, table)
  try {
    assert.ok(
      run.executed.includes('global __DSH_SPLASH_CONFIG__'),
      'the config global lands before the controller, as the table order promises',
    )
    const prelude = table.find((row) => row.kind === 'global' && row.name === '__DSH_SPLASH_PRELUDE__').value
    await body({ dom, run, prelude, overlay: overlay(dom) })
  } finally {
    try { run.facade?.fade('test') } catch { /* already collapsed */ }
    run.restore()
  }
  process.stdout.write(`  ok  ${name}\n`)
}

try {
  await scenario('boot in progress: overlay mounts, hides the kernel card, streams the log',
    { enabled: true, preset: 'cyber', minDurationMs: 11000, maxTimeoutMs: 50000 },
    async ({ dom, run, prelude, overlay: el }) => {
      assert.ok(el !== null, 'the overlay is in the document')
      assert.equal(el.hidden, false, 'the overlay is visible')
      assert.equal(el.attrs.get('data-ds-preset'), 'cyber', 'the preset reached the markup')
      assert.equal(run.stateAttribute(), 'on', 'the kernel boot card is switched off')
      assert.equal(el.attrs.get('style'), '--dsh-hold:11000ms', 'the hold reaches the markup')
      assert.ok(run.facade !== undefined, 'the facade is published for the settings row')
      for (const entry of ['preview', 'fade', 'frameLive']) {
        assert.equal(typeof run.facade[entry], 'function', `facade exposes ${entry}()`)
      }
      assert.equal(el.classList.contains('is-leaving'), false, 'nothing is collapsing yet')

      // The meter is the animation's own timeline: with an 11s hold, one second
      // in is ~9%, and the log's first milestone is 1/11 of the animation — so
      // the bar and the log move together rather than on separate clocks.
      // One second in is ~9% of the animation: the first milestone has landed and
      // its result badge (140ms later) has settled.
      await after(1250)
      assert.equal(logLines(dom), 1, 'exactly the first milestone has landed')
      assert.equal(
        overlay(dom).querySelector('[data-dsh-splash-hint]').textContent,
        'BOOTING',
        'the status line is set from the locale-derived text',
      )

      // Rendered, not just written: the marker and badge are what the operator
      // actually reads, and an escape that survived one layer too many is only
      // visible here.
      const firstLine = overlay(dom).querySelector('[data-dsh-splash-log]').children[0]
      assert.equal(firstLine.children[0].textContent, '✓', 'the settled marker is a check mark')
      assert.equal(firstLine.children[1].textContent, prelude.log[0], 'the first line is the script\'s first step')
      assert.equal(firstLine.children[2].textContent, 'ok', 'and the result badge lands beside it')

      // The meter itself, read out of the overlay's own custom property.
      const shown = el.style.getPropertyValue('--dsh-progress')
      const shownPct = Number.parseFloat(shown)
      assert.ok(shownPct > 5 && shownPct < 20, `the meter sits near the one-second mark (got ${shown})`)
    })

  await scenario('ready: the overlay collapses at the hold and removes itself',
    { enabled: true, preset: 'matrix', minDurationMs: 300, maxTimeoutMs: 5000 },
    async ({ dom, run, overlay: el }) => {
      await after(450) // let the log get going, so the collapse interrupts real work
      dom.completeBoot()
      dom.mutate()
      assert.equal(run.stateAttribute(), 'on', 'still authoritative while the hold runs')

      await after(500) // hold + the two-frame paint check + the 400ms collapse
      assert.equal(run.stateAttribute(), undefined, 'the kernel card is handed back')
      assert.equal(el.isConnected, false, 'the overlay removed itself')
      assert.equal(el.classList.contains('is-leaving'), true, 'it left through the CRT collapse')
    })

  await scenario('preview: replays the animation on a collapsed overlay',
    { enabled: true, preset: 'amber', minDurationMs: 250, maxTimeoutMs: 5000 },
    async ({ dom, run, overlay: el }) => {
      // Get to the state the report describes: booted, overlay already gone.
      await after(350)
      dom.completeBoot()
      dom.mutate()
      await after(500)
      assert.equal(el.isConnected, false, 'precondition: the overlay collapsed')

      run.facade.preview()
      assert.equal(el.isConnected, true, 'preview re-attaches the overlay')
      assert.equal(el.hidden, false, 'preview un-hides it')
      assert.equal(el.classList.contains('is-leaving'), false, 'preview clears the collapse state')
      assert.equal(el.attrs.get('data-dsh-splash-stuck'), undefined, 'preview clears the stall state')
      assert.equal(run.stateAttribute(), 'on', 'preview takes the kernel card off again')
      assert.equal(logLines(dom), 0, 'preview restarts the log from empty')

      await after(500)
      assert.ok(logLines(dom) > 0, 'the replay really streams')
    })

  await scenario('preview: collapses again on its own, well before the boot hold',
    { enabled: true, preset: 'mono', minDurationMs: 60000, maxTimeoutMs: 60000 },
    async ({ dom, run, overlay: el }) => {
      // A hold of a minute proves the preview's own timer ends it, not the hold.
      await after(120)
      run.facade.preview()
      assert.equal(el.isConnected, true, 'preview shows even with a minute-long hold')

      await after(5200 + 900)
      assert.equal(el.isConnected, false, 'the preview collapsed on its own schedule')
      assert.equal(run.stateAttribute(), undefined, 'and handed the kernel card back')
    })

  await scenario('disabled: nothing is covered, but preview still demonstrates',
    { enabled: false, preset: 'cyber', minDurationMs: 300 },
    async ({ run, overlay: el }) => {
      assert.equal(run.stateAttribute(), 'off', 'the kernel card is left alone')
      assert.equal(el.hidden, true, 'the overlay ships hidden')
      assert.ok(run.facade !== undefined, 'the facade survives a disabled splash')

      run.facade.preview()
      assert.equal(el.hidden, false, 'preview un-hides a disabled splash')
      assert.equal(run.stateAttribute(), 'on', 'preview takes the card off while it runs')
    })

  await scenario('any key and any click both skip',
    { enabled: true, preset: 'cyber', minDurationMs: 60000, maxTimeoutMs: 60000 },
    async ({ dom, run, overlay: el }) => {
      assert.equal(el.isConnected, true, 'the overlay is up')

      // A modifier alone must not skip: the operator is aiming at a shortcut.
      dom.document.body.dispatch('keydown', { key: 'Control', ctrlKey: true })
      await after(60)
      assert.equal(el.isConnected, true, 'a modifier press does not skip')

      dom.document.body.dispatch('keydown', { key: 'q' })
      await after(500) // the collapse animation runs before the node is removed
      assert.equal(el.isConnected, false, 'an ordinary key skips')
      assert.equal(run.stateAttribute(), undefined, 'skipping hands the kernel card back')
    })

  await scenario('preview: shows the palette the row is holding, not the one the markup pinned',
    { enabled: true, preset: 'cyber', minDurationMs: 60000, maxTimeoutMs: 60000 },
    async ({ dom, run, overlay: el }) => {
      // This is the reported bug. The palette lives on the markup's
      // `data-ds-preset`, fixed when the Host rendered this index; the row writes
      // the new value to the Host and highlights the new chip immediately. Unless
      // the preview retargets the overlay, the chip and the animation disagree and
      // the preview "does not show the theme I picked".
      assert.equal(el.attrs.get('data-ds-preset'), 'cyber', 'the markup pinned cyber')

      run.facade.preview({ preset: 'synthwave' })
      assert.equal(el.attrs.get('data-ds-preset'), 'synthwave', 'preview adopts the picked palette')
      assert.equal(el.hidden, false, 'and shows')

      // The live retarget, used when the palette changes while the overlay stands.
      run.facade.apply({ preset: 'amber' })
      assert.equal(el.attrs.get('data-ds-preset'), 'amber', 'apply retargets a standing overlay')

      // A palette from outside the Host's list is refused rather than trusted into
      // a selector — the controller runs in the page.
      run.facade.apply({ preset: 'neon' })
      assert.equal(el.attrs.get('data-ds-preset'), 'amber', 'an unknown palette is refused')
      run.facade.preview({ preset: 'neon' })
      assert.equal(el.attrs.get('data-ds-preset'), 'amber', 'and refused through preview too')

      // No patch at all must not blank the attribute.
      run.facade.preview()
      assert.equal(el.attrs.get('data-ds-preset'), 'amber', 'a patch-free preview keeps the current palette')

      await after(500)
      assert.ok(logLines(dom) > 0, 'and it is a real replay, not just an attribute change')
    })

  await scenario('preview: repeated previews leave no second paint loop behind',
    { enabled: true, preset: 'cyber', minDurationMs: 60000, maxTimeoutMs: 60000 },
    async ({ dom, run }) => {
      // The meter is driven by a requestAnimationFrame loop that teardown has to
      // be able to stop. A preview restarting it without a guard would leave the
      // extra loop running for the life of the page, since both loops would share
      // one cancel handle.
      await after(80)
      run.facade.preview()
      await after(80)
      run.facade.preview()
      await after(80)
      run.facade.fade('test')
      await after(80)
      assert.equal(run.pendingFrames(), 0, 'no animation frame is still queued after teardown')
    })

  await scenario('a failed boot hands the screen back instead of hiding the report',
    { enabled: true, preset: 'cyber', minDurationMs: 60000, maxTimeoutMs: 60000 },
    async ({ dom, run, overlay: el }) => {
      const card = dom.document.querySelector('[data-dsh-boot]')
      const report = dom.document.createElement('div')
      report.ownText = 'Failed to load plugins'
      card.appendChild(report)

      dom.mutate()
      await after(500)
      assert.equal(el.isConnected, false, 'the overlay yields to the failure report')
      assert.equal(run.stateAttribute(), undefined, 'and un-hides the kernel card so it can be read')
    })
} finally {
  rmSync(home, { recursive: true, force: true })
}

process.stdout.write('dsh-splash controller: all scenarios passed\n')

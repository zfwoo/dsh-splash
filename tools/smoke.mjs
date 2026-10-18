/**
 * Host-half smoke test — no DSH, no DOM.
 *
 * Loads the plugin, drives `apply` against a stub Context, and asserts the
 * shape of the injection table it contributes. This is the cheap guard for the
 * two mistakes that are invisible until they break a boot: an unbalanced
 * wrapper in a generated script, and a `</script` or `</style` sequence inside
 * a row's text, which closes the element early in the served document.
 *
 * Usage:
 *   node --test tools/            (or)  node tools/smoke.mjs
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const plugin = await import('../index.js')

assert.equal(plugin.name, 'dsh-splash', 'plugin name')
assert.deepEqual(plugin.inject, ['webServer', 'connection'], 'declared services')

/** A Context stub that records what the plugin registers. */
function stubContext() {
  const listeners = []
  const routes = []
  return {
    listeners,
    routes,
    on(event, listener) { listeners.push({ event, listener }) },
    effect(callback) { return callback() },
    webServer: { register(route) { routes.push(route); return () => {} } },
    connection: { requestRejection: () => undefined },
  }
}

function collect(config, home) {
  const ctx = stubContext()
  plugin.apply(ctx, { ...config, dshHome: home })
  const table = []
  for (const { event, listener } of ctx.listeners) {
    if (event === 'webserver/index-inject') listener(table)
  }
  return { ctx, table }
}


/**
 * Row accessors. The injection table grows over time, so rows are addressed by
 * what they are, never by where they happen to sit: a positional assertion turns
 * every future addition into a silent renumbering.
 */
const rowOf = (table, kind, match = () => true) => {
  const found = table.filter((row) => row.kind === kind && match(row))
  assert.equal(found.length, 1, `exactly one ${kind} row matches`)
  return found[0]
}
const configOf = (table) => rowOf(table, 'global', (row) => row.name === '__DSH_SPLASH_CONFIG__')
const headOf = (table) => rowOf(table, 'script', (row) => row.placement === 'head')
const markupOf = (table) => rowOf(table, 'html')

const home = mkdtempSync(join(tmpdir(), 'dsh-splash-smoke-'))

try {
  // --- rows, enabled (default) ---------------------------------------------
  const enabled = collect({}, home)
  const kinds = enabled.table.map((row) => `${row.kind}${row.placement === undefined ? '' : `:${row.placement}`}`)
  assert.deepEqual(
    kinds,
    ['global', 'global', 'script:head', 'style', 'html:body', 'script:body'],
    'row kinds and order',
  )

  // Rows are looked up by role rather than by index: the table grows, and a
  // positional assertion would turn every addition into a silent renumbering.
  const rows = enabled.table
  const configRow = rows.find((row) => row.kind === 'global' && row.name === '__DSH_SPLASH_CONFIG__')
  const preludeRow = rows.find((row) => row.kind === 'global' && row.name === '__DSH_SPLASH_PRELUDE__')
  const headScript = rows.find((row) => row.kind === 'script' && row.placement === 'head')
  const styleRow = rows.find((row) => row.kind === 'style')
  const htmlRow = rows.find((row) => row.kind === 'html')
  const controllerRow = rows.filter((row) => row.kind === 'script' && row.placement === 'body').at(-1)
  for (const [label, row] of Object.entries({ configRow, preludeRow, headScript, styleRow, htmlRow, controllerRow })) {
    assert.ok(row !== undefined, `the table carries a ${label}`)
  }

  assert.equal(configRow.value.enabled, true, 'enabled default')
  assert.equal(configRow.value.preset, 'cyber', 'preset default')
  assert.equal(configRow.value.minDurationMs, 10000, 'default animation length is 10s')
  assert.ok(configRow.value.maxTimeoutMs > configRow.value.minDurationMs, 'the stall backstop outlasts the hold')

  // --- the prelude is what the controller file reads -------------------------
  // The controller had to move out of a template literal (a backtick in a
  // comment closed it early, three times over), so every build-time fact now
  // arrives through this row instead of substitution. It is a `global` row, so
  // anything the JSON round trip would drop is a fact the controller silently
  // loses at runtime.
  const prelude = preludeRow.value
  assert.equal(prelude.configGlobal, '__DSH_SPLASH_CONFIG__', 'prelude names the config global')
  assert.equal(prelude.facadeGlobal, '__DSH_SPLASH__', 'prelude names the facade global')
  assert.equal(prelude.stateAttribute, 'data-dsh-splash-state', 'prelude carries the state attribute')
  assert.deepEqual(prelude.presets, plugin.PRESETS, 'prelude carries the palette allowlist')
  assert.ok(Array.isArray(prelude.log) && prelude.log.length > 5, 'prelude carries the boot-log script')
  assert.ok(prelude.cap > 0, 'the prelude carries the log window size')
  assert.ok(prelude.defaultMin > 0 && prelude.defaultMax > prelude.defaultMin, 'prelude carries the durations')
  assert.deepEqual(
    JSON.parse(JSON.stringify(prelude)),
    prelude,
    'the prelude survives the JSON round trip a global row puts it through',
  )
  assert.ok(
    rows.indexOf(preludeRow) < rows.indexOf(controllerRow),
    'the prelude lands before the controller that reads it',
  )
  // The controller file is shipped verbatim: what is tested is what is served.
  assert.ok(controllerRow.text.includes("var PRELUDE='__DSH_SPLASH_PRELUDE__'"), 'the controller reads the prelude')
  assert.ok(controllerRow.text.includes('var P=globalThis[PRELUDE]||{}'), 'and tolerates a missing prelude')

  // Escapes that survived a layer too many.
  //
  // The controller used to be assembled inside a template literal, where a `\u`
  // escape needed a doubled backslash to come out as one. Lifting the text into
  // its own file kept the doubled form, so the log's status marker rendered the
  // literal characters `\u2713` instead of a check mark — visible only on screen,
  // and only after a boot. The intent assertion below is the real guard; the
  // heuristic catches the whole family.
  assert.ok(controllerRow.text.includes("mark.textContent='✓'"), 'the log marker is a real check mark')
  assert.ok(!/\\\\[nrtu]/.test(controllerRow.text), 'the controller carries no double-escaped sequence')

  assert.equal(headScript.text, 'document.documentElement.setAttribute("data-dsh-splash-state","on")', 'state attribute script')

  const html = htmlRow.html
  assert.ok(html.startsWith('<div id="dsh-splash"'), 'markup root')
  assert.ok(html.includes('data-ds-preset="cyber"'), 'markup preset')
  assert.ok(html.includes('<path d="M22.9168 1.43018'), 'official fish path inlined')

  // The 10s arc is carried by the markup: the timeline bar's animation duration
  // comes from the markup, so a reset here would silently drop the hold to the
  // stylesheet default.
  assert.ok(html.includes('style="--dsh-hold:10000ms"'), 'markup pins the hold duration')

  // The animation's furniture. `dsh-log` is where the boot log streams, and the
  // FX layers are what make it read as a terminal rather than a blank panel.
  for (const part of ['dsh-fx', 'dsh-grid', 'dsh-sweep', 'dsh-scan', 'dsh-vignette', 'dsh-hud',
    'dsh-log', 'dsh-track', 'dsh-fill', 'dsh-pct', 'dsh-timelineFill', 'dsh-skipnote']) {
    assert.ok(html.includes(part), `markup carries .${part}`)
  }

  /** The overlay root's opening tag — the only place `hidden` may not appear. */
  const rootTag = (markup) => markup.slice(0, markup.indexOf('>') + 1)
  assert.ok(!rootTag(html).includes(' hidden'), 'overlay is visible when enabled')
  assert.ok(!html.includes('data-dsh-splash-stuck'), 'stuck state is not shipped in the markup')

  /** The skip button ships hidden and is revealed only in the stuck state. */
  const skipTag = /<button[^>]*data-dsh-splash-skip[^>]*>/.exec(html)
  assert.ok(skipTag !== null && skipTag[0].includes(' hidden'), 'skip button starts hidden')

  // --- row text must not close its own element or carry stray escapes -------
  for (const row of rows) {
    const text = `${row.text ?? ''}${row.html ?? ''}`
    assert.ok(!text.includes('</script'), `row ${row.kind} must not contain </script`)
    assert.ok(!text.includes('</style'), `row ${row.kind} must not contain </style`)
    // A doubled escape is what an escape that passed through one layer too many
    // looks like: it renders as backslash-u-hex on screen instead of the
    // character, which is invisible to every check except a rendered one.
    assert.ok(!/\\\\[nrtu]/.test(text), `row ${row.kind} must not carry a double-escaped sequence`)
  }

  // The stylesheet is still a template literal in the source, so a backtick in
  // one of its comments closes the literal early and Node reports a bare
  // `Unexpected identifier` somewhere else entirely. The controller used to be
  // built that way and hit this three times; it now lives in its own file, which
  // `node --check` guards directly.
  assert.ok(!styleRow.text.includes('`'), 'the stylesheet must not contain a backtick')

  // --- generated scripts must parse ---------------------------------------
  assert.doesNotThrow(() => new Function(headScript.text), 'head script parses')
  assert.doesNotThrow(() => new Function(controllerRow.text), 'controller parses')

  // --- one balanced listener; a second apply must not stack rows -----------
  const twice = []
  for (const { listener } of enabled.ctx.listeners) listener(twice)
  assert.equal(twice.length, enabled.table.length, 'one listener contributes one row set')

  // --- routes --------------------------------------------------------------
  assert.deepEqual(enabled.ctx.routes.map((route) => `${route.kind} ${route.path}`), [
    'exact /dsh-splash.config',
    'exact /dsh-splash.set',
  ], 'registered routes')

  // --- rows, disabled ------------------------------------------------------
  const disabled = collect({ enabled: false }, home)
  assert.equal(configOf(disabled.table).value.enabled, false, 'row config reaches the global')
  assert.equal(headOf(disabled.table).text, 'document.documentElement.setAttribute("data-dsh-splash-state","off")', 'state attribute off')
  assert.ok(rootTag(markupOf(disabled.table).html).includes(' hidden'), 'overlay is hidden when disabled')

  // --- the persisted document outranks the row config ----------------------
  writeFileSync(join(home, 'dsh-splash.json'), JSON.stringify({ enabled: false, preset: 'matrix' }))
  const persisted = collect({ enabled: true, preset: 'mono' }, home)
  assert.equal(configOf(persisted.table).value.enabled, false, 'document outranks row config (enabled)')
  assert.equal(configOf(persisted.table).value.preset, 'matrix', 'document outranks row config (preset)')

  // --- a corrupt document must not break the boot --------------------------
  writeFileSync(join(home, 'dsh-splash.json'), '{ not json')
  const corrupt = collect({ enabled: false, preset: 'mono' }, home)
  assert.equal(configOf(corrupt.table).value.enabled, false, 'corrupt document falls back to row config')
  assert.equal(configOf(corrupt.table).value.preset, 'mono', 'corrupt document falls back to row config (preset)')

  // --- an unknown preset is not trusted into the markup --------------------
  const bogus = collect({ preset: 'neon' }, home)
  assert.equal(configOf(bogus.table).value.preset, 'cyber', 'unknown preset falls back')
  assert.ok(markupOf(bogus.table).html.includes('data-ds-preset="cyber"'), 'markup never carries an unknown preset')

  // --- every advertised preset is real -------------------------------------
  // The settings row offers whatever the route advertises, so a preset with no
  // palette block would show up as a chip that renders the default look.
  assert.ok(Array.isArray(plugin.PRESETS) && plugin.PRESETS.length > 1, 'the plugin exports its preset vocabulary')
  assert.equal(plugin.PRESETS[0], configRow.value.preset, 'the first preset is the default')
  const styleText = styleRow.text
  for (const preset of plugin.PRESETS) {
    assert.ok(
      styleText.includes(`data-ds-preset="${preset}"`),
      `the stylesheet defines a palette for ${preset}`,
    )
  }

  // --- the controller honours the two interaction requirements --------------
  const controller = controllerRow.text
  assert.ok(controller.includes('onKey'), 'the controller wires a key listener')
  assert.ok(
    /KEY TO SKIP|按任意键跳过/.test(controller),
    'the skip affordance says any key, not a named one',
  )
  assert.ok(controller.includes('prefers-reduced-motion') === false, 'reduced-motion handling lives in CSS, not the controller')
  assert.ok(controller.includes('timelineRatio()'), 'the meter is the animation\'s own timeline')
  assert.ok(!controller.includes('--dsh-boot-arc'), 'and no longer mirrors the kernel card\'s arc (it froze on a fast boot)')
  assert.ok(controller.includes('is-leaving'), 'the collapse relies on the stylesheet\'s leaving state')

  // --- the config routes: the only write path, so its checks are the contract
  // Placed last because these requests mutate the document the earlier
  // assertions read.
  const routeOf = (path) => {
    const found = enabled.ctx.routes.filter((route) => route.path === path)
    assert.equal(found.length, 1, `exactly one route for ${path}`)
    return found[0]
  }
  /** Drive a route handler with the smallest request/response pair it accepts. */
  const send = (path, { method = 'POST', body, headers = {} } = {}) => new Promise((resolve) => {
    const handlers = new Map()
    const req = {
      method,
      url: path,
      headers: { 'content-type': 'application/json', ...headers },
      on(event, handler) {
        handlers.set(event, [...(handlers.get(event) ?? []), handler])
        return req
      },
      destroy() {},
    }
    const res = {
      statusCode: 0,
      responseHeaders: {},
      setHeader(name, value) { this.responseHeaders[name.toLowerCase()] = value },
      end(payload) {
        resolve({
          status: this.statusCode,
          body: payload === undefined || payload === '' ? undefined : JSON.parse(payload),
        })
      },
    }
    routeOf(path).handler(req, res)
    // `readBody` registers `data` then `end`, so the body is fed only once the
    // handler has finished subscribing.
    process.nextTick(() => {
      if (body !== undefined) for (const handler of handlers.get('data') ?? []) handler(Buffer.from(body))
      for (const handler of handlers.get('end') ?? []) handler()
    })
  })

  const reads = await send('/dsh-splash.config', { method: 'GET' })
  assert.equal(reads.status, 200, 'the read route answers')
  assert.equal(typeof reads.body.configPath, 'string', 'the payload states where the config lives')
  assert.ok(reads.body.bounds !== undefined, 'the payload carries the numeric bounds')
  assert.deepEqual(
    reads.body.bounds.minDurationMs,
    plugin.BOUNDS.minDurationMs,
    'the advertised bounds are the Host\'s own',
  )
  assert.equal(
    reads.body.minGapMs,
    1000,
    'the payload ships the hold/backstop gap so the page narrows by the Host\'s own margin',
  )

  const accepted = await send('/dsh-splash.set', { body: JSON.stringify({ minDurationMs: 1234 }) })
  assert.equal(accepted.status, 200, 'an in-range number is accepted')
  assert.equal(accepted.body.minDurationMs, 1234, 'and echoed back as effective')

  for (const [label, patch] of [
    ['below the floor', { minDurationMs: -5 }],
    ['above the ceiling', { minDurationMs: plugin.BOUNDS.minDurationMs.max + 1 }],
    ['not an integer', { minDurationMs: 1.5 }],
    ['not a number', { minDurationMs: 'fast' }],
    ['under the backstop floor', { maxTimeoutMs: 10 }],
  ]) {
    const refused = await send('/dsh-splash.set', { body: JSON.stringify(patch) })
    assert.equal(refused.status, 400, `a duration ${label} is refused`)
    assert.ok(refused.body.error.includes('integer between'), 'and says what the range is')
  }

  // The hold must never outrun the stall backstop: that would declare the boot
  // stuck while the animation it guards is still legitimately running. A crossing
  // patch is refused, not silently corrected, because moving the field the
  // operator did not touch is the worse answer.
  const crossed = await send('/dsh-splash.set', {
    body: JSON.stringify({ minDurationMs: 60000, maxTimeoutMs: 30000 }),
  })
  assert.equal(crossed.status, 400, 'a hold longer than the backstop is refused')
  assert.ok(
    /minDurationMs \(60s\) must not exceed maxTimeoutMs \(30s\)/.test(crossed.body.error),
    `and names both sides in seconds (${crossed.body.error})`,
  )
  // The document was not written: a refused patch leaves it exactly as it was.
  assert.equal(
    JSON.parse(readFileSync(join(home, 'dsh-splash.json'), 'utf8')).minDurationMs,
    1234,
    'a refused patch does not reach the document',
  )

  // A crossing in the *document* (hand-edited) is healed on the read path rather
  // than refused, so it cannot break the boot or strand an unrelated write.
  writeFileSync(join(home, 'dsh-splash.json'), JSON.stringify({ minDurationMs: 60000, maxTimeoutMs: 30000 }))
  const healed = collect({}, home)
  assert.ok(
    configOf(healed.table).value.maxTimeoutMs > configOf(healed.table).value.minDurationMs,
    'a hand-edited crossing is healed to a legal pair on read',
  )
  const toggle = await send('/dsh-splash.set', { body: JSON.stringify({ enabled: false }) })
  assert.equal(toggle.status, 200, 'an unrelated write succeeds despite a healed crossing')

  const unknown = await send('/dsh-splash.set', { body: JSON.stringify({ preset: 'neon' }) })
  assert.equal(unknown.status, 400, 'an unknown palette is still refused')
  const wrongType = await send('/dsh-splash.set', { body: JSON.stringify({ reset: 'yes' }) })
  assert.equal(wrongType.status, 400, 'a non-boolean reset is refused')

  const reset = await send('/dsh-splash.set', { body: JSON.stringify({ reset: true }) })
  assert.equal(reset.status, 200, 'reset is accepted')
  assert.equal(reset.body.minDurationMs, 10000, 'and lands back on the default hold')
  assert.equal(reset.body.maxTimeoutMs, 30000, 'and on the default backstop')
  assert.equal(reset.body.preset, 'cyber', 'and on the default palette')
  assert.ok(
    !existsSync(join(home, 'dsh-splash.json')),
    'reset removes the document rather than writing defaults into it',
  )

  const wrongMethod = await send('/dsh-splash.set', { method: 'GET' })
  assert.equal(wrongMethod.status, 405, 'the write route rejects a GET')
  const wrongType2 = await send('/dsh-splash.set', {
    body: JSON.stringify({ enabled: true }),
    headers: { 'content-type': 'text/plain' },
  })
  assert.equal(wrongType2.status, 415, 'a non-JSON write is refused')

  // --- generated brand data is the committed data --------------------------
  const brand = await import('../fish-path.js')
  assert.equal(brand.FISH_LOGO_VIEWBOX.width, 23.16, 'brand viewBox')

  // --- the package name is declared once and mirrored, never re-invented ---
  // Three places cannot read the manifest — the browser bundle, the patch file
  // and the row id — so they mirror it. Renaming is a one-line edit plus this
  // check telling you which mirror was missed.
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.ok(manifest.name.length > 0, 'the manifest declares a name')

  // --- the shipped patch must survive a stranger's machine -----------------
  // Three things have bitten here: a mirror of the package name going stale, a
  // palette id that does not exist, and a watch root pointing at the machine it
  // was written on. None of them fail loudly at install time — the third one just
  // leaves you editing files and seeing nothing change.
  const patchText = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  const livePatch = patchText.replace(/^[ \t]*#.*$/gm, '')
  assert.ok(livePatch.includes(`name: '${manifest.name}'`), 'the patch mirrors the package name')
  assert.ok(livePatch.includes('id: dsh-splash'), 'and inserts the row id the Host looks up')
  const fallbackPreset = /preset:\s*([\w-]+)/.exec(livePatch)?.[1]
  assert.ok(
    fallbackPreset === undefined || plugin.PRESETS.includes(fallbackPreset),
    `the patch's fallback palette is a real one (got ${String(fallbackPreset)})`,
  )
  assert.ok(
    !/[A-Za-z]:\\|\/(?:home|Users)\//.test(livePatch),
    'the live patch carries no absolute path from one machine',
  )
  assert.ok(
    !/dsh-session-delete/.test(patchText),
    'the patch references no other local plugin',
  )

  // --- client half: load it the way the module host does -------------------
  // The bundle is not an ES module: it calls `window.__ModuleLoader__.load`
  // with a factory. Stand that up far enough to run `apply` end to end, which
  // is what catches a mistyped slot name or a missing locale registration —
  // both invisible until a real boot fails.
  let loaded
  globalThis.window = {
    __ModuleLoader__: { load(entry) { loaded = entry } },
  }
  await import('../client.js')
  assert.equal(loaded?.id, manifest.name, 'the client module id mirrors the package name')

  /** Stand-in for the platform seed words the factory may require. */
  const reactStub = {
    createElement: (...args) => ({ args }),
    useCallback: (fn) => fn,
    useEffect: () => undefined,
    useState: (initial) => [initial, () => undefined],
  }
  const contribution = loaded.factory((specifier) => {
    assert.equal(specifier, 'react', `client bundle may only require platform seed words (got ${specifier})`)
    return reactStub
  })
  assert.deepEqual(contribution.inject, ['slots', 'locale'], 'client-declared services')

  const effects = []
  const registered = []
  const injected = []
  const locales = []
  const documentStub = {
    head: { appendChild() {} },
    createElement: () => ({ dataset: {}, remove() {}, textContent: '' }),
  }
  globalThis.document = documentStub
  contribution.apply({
    effect(callback, label) { effects.push(label); return callback() },
    locale: {
      register(ns, id, dict) { locales.push({ ns, id, dict }) },
      bind: () => (key) => key,
    },
    slots: {
      inject(slot, callback) { injected.push(slot); for (const dispose of [callback()]) void dispose },
      register(options) { registered.push(options); return () => {} },
    },
  })

  assert.deepEqual(locales.map(({ ns, id }) => `${ns}:${id}`), ['dsh-splash:zh', 'dsh-splash:en'], 'locale dictionaries')
  for (const { dict } of locales) {
    assert.ok(Object.keys(dict).length > 0, 'no empty dictionary')
  }
  assert.deepEqual(injected, ['settings.section', 'shell.overlay'], 'slots injected into')
  assert.deepEqual(
    registered.map(({ name, id, order }) => `${name}#${id}@${order ?? '-'}`),
    ['settings.section#splash@100', 'shell.overlay#dsh-splash.signal@-'],
    'slot registrations',
  )
  assert.ok(effects.some((label) => label === 'dsh-splash: stylesheet'), 'stylesheet effect registered')
  assert.ok(
    !registered.some(({ name }) => name === 'root'),
    'never registers into `root` (it would replace the whole app frame)',
  )

  // --- the settings entry is a top-level page, not a row inside General -----
  // It is a sibling of General in the nav, so it must be a `settings.section`
  // contribution and must not also be registered as a General row. The shipped
  // section orders are General 0 and Models 10; the nav sorts by order, so 5 is
  // what places this page directly after General. `label` is a function because
  // the shell re-invokes it on every locale change; a captured string would
  // freeze the nav row in whichever language was active at registration.
  const section = registered.find(({ name }) => name === 'settings.section')
  assert.ok(section !== undefined, 'the page registers a settings section')
  assert.equal(typeof section.label, 'function', 'the nav label re-localizes through a function')
  assert.ok(
    section.order > 25,
    `the section order (${String(section.order)}) sits below every shipped section (Archived sessions is 25)`,
  )
  assert.ok(
    !registered.some(({ name }) => name === 'settings.general.item'),
    'the page is not also a row inside General (it moved out)',
  )

  // --- the page owns every value the config document holds ------------------
  const clientSource = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  for (const field of ['enabled', 'preset', 'minDurationMs', 'maxTimeoutMs']) {
    assert.ok(
      clientSource.includes(field),
      `the page exposes the \`${field}\` setting`,
    )
  }
  // The page renders its limits and its reset from what the Host reports, so a
  // bound cannot drift between the two halves.
  assert.ok(clientSource.includes('bounds.minDurationMs'), 'the steppers read the Host bounds')
  assert.ok(clientSource.includes('configPath'), 'the page shows where the config lives')
  assert.ok(clientSource.includes('reset: true'), 'the page can restore defaults')
  assert.ok(!clientSource.includes("'row."), 'no leftover keys from the old General row')

  // --- the durations speak seconds and accept typed input -------------------
  // The stored unit stays milliseconds (the document, the controller and the
  // markup's `--dsh-hold` are all milliseconds), so the conversion has to exist
  // somewhere; keeping it in the page is what lets the field show seconds
  // without the file disagreeing with the UI.
  assert.equal(plugin.BOUNDS.minDurationMs.step, 1000, 'the hold steps by a whole second')
  assert.equal(plugin.BOUNDS.maxTimeoutMs.step, 1000, 'so does the backstop')
  assert.ok(clientSource.includes('toSeconds'), 'the page converts milliseconds to seconds')
  assert.ok(clientSource.includes('* 1000'), 'and converts a typed value back')
  assert.ok(clientSource.includes("'unit.s'"), 'the field is labelled in seconds')
  assert.ok(!clientSource.includes("'unit.ms'"), 'and no longer in milliseconds')
  assert.ok(clientSource.includes("h('input'"), 'the duration is a typeable field, not a readout')
  assert.ok(clientSource.includes("inputMode: 'decimal'"), 'with a numeric keypad hint')
  assert.ok(clientSource.includes('parseSeconds'), 'typed text is parsed rather than coerced')
  assert.ok(clientSource.includes('error.number'), 'and a rejected entry says why')

  // --- the preview path must be reachable, and must say so when it is not ---
  // Host-side preview replays the animation whatever the stored `enabled` is,
  // and a click that silently no-ops is exactly how "preview does nothing" gets
  // reported with no clue. Both are regressions this test is here to catch.
  assert.ok(!clientSource.includes('disabled: !enabled'), 'preview is not gated on the enable switch')
  assert.ok(clientSource.includes('__DSH_SPLASH__?.preview'), 'the page reaches the Host facade')
  assert.ok(
    clientSource.includes('action.previewUnavailable'),
    'an unreachable preview explains itself instead of doing nothing',
  )

  delete globalThis.window
  delete globalThis.document
} finally {
  rmSync(home, { recursive: true, force: true })
}

process.stdout.write('dsh-splash smoke: all assertions passed\n')

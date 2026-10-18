/**
 * Render the settings page and drive its fields.
 *
 * The duration fields are typeable, which means real logic now sits behind them:
 * read the text, refuse what is not a number, clamp what is out of range, convert
 * seconds to the stored milliseconds, and revert a rejected entry with a reason.
 * None of that is visible to a source assertion, and the last two rounds of this
 * plugin both shipped a defect that a source assertion could not see — so the
 * page is rendered here and the handlers are called for real.
 *
 * The Host routes are emulated with the same rules the real ones enforce
 * (`tools/smoke.mjs` covers the real handlers); what is under test here is what
 * the *page* sends and what it shows afterwards.
 *
 * Usage:
 *   node tools/page.test.mjs
 */

import assert from 'node:assert/strict'

import { collect, createReact, textOf } from './react.mjs'

const plugin = await import('../index.js')

// --- load the bundle the way the module host does ---------------------------
let loaded
globalThis.window = { __ModuleLoader__: { load(entry) { loaded = entry } } }
await import('../client.js')
assert.ok(loaded !== undefined, 'the bundle announced itself to the module loader')

const { React, mount } = createReact()
const contribution = loaded.factory((specifier) => {
  assert.equal(specifier, 'react', 'the bundle may only require platform seed words')
  return React
})

// --- stand up the page's environment ---------------------------------------
const styleTags = []
globalThis.document = {
  createElement: () => ({ dataset: {}, remove() {}, textContent: '' }),
  head: { appendChild(tag) { styleTags.push(tag) } },
}

const previews = []
const applies = []
globalThis.__DSH_SPLASH__ = {
  apply: (patch) => { applies.push(patch) },
  preview: (patch) => { previews.push(patch) },
}

/** The keys the page asks for, as templates, so interpolation is observable. */
const TEMPLATES = {
  'hold.desc': 'range {min}-{max} seconds',
  'backstop.desc': 'range {min}-{max} seconds',
  'error.number': 'between {min} and {max} seconds',
}
const t = (key) => TEMPLATES[key] ?? key

/** Emulate the Host's routes: same pairing rule, same effective echo. */
const BOUNDS = plugin.BOUNDS
let stored = {}
const posted = []
const state = () => {
  const config = { enabled: true, preset: 'cyber', minDurationMs: 10000, maxTimeoutMs: 30000, ...stored }
  return { ...config, presets: [...plugin.PRESETS], bounds: BOUNDS, minGapMs: 1000, configPath: 'C:/fake/dsh-splash.json' }
}
globalThis.fetch = async (path, init) => {
  const reply = (status, payload) => ({ ok: status < 300, status, json: async () => payload })
  if (init === undefined) return reply(200, state())
  const patch = JSON.parse(init.body)
  posted.push(patch)
  if (patch.reset === true) {
    stored = {}
    return reply(200, state())
  }
  // Mirror the Host: a crossing patch is refused rather than silently corrected.
  const next = { ...state(), ...patch }
  if (next.minDurationMs > next.maxTimeoutMs) {
    return reply(400, {
      error: `minDurationMs (${String(next.minDurationMs / 1000)}s) must not exceed maxTimeoutMs (${String(next.maxTimeoutMs / 1000)}s)`,
    })
  }
  stored = { ...stored, ...patch }
  return reply(200, state())
}

// --- register the page ------------------------------------------------------
// Capture per slot name: the bundle registers twice (the page and the invisible
// overlay signal), and a single capture would keep whichever came last.
const registered = {}
let currentSlot = null
const slots = {
  inject(slot, callback) { currentSlot = slot; callback(); currentSlot = null; return () => {} },
  register(_options, component) { registered[currentSlot] = component; return () => {} },
}
contribution.apply({
  effect(callback) { return callback() },
  locale: { register() {}, bind: () => t },
  slots,
})
const Section = registered['settings.section']
assert.equal(typeof Section, 'function', 'the page registered a component')
assert.equal(typeof registered['shell.overlay'], 'function', 'and so did the frame-live signal')
assert.ok(styleTags.length > 0, 'the page installed its stylesheet')

const mounted = mount(React.createElement(Section, { t }))
await mounted.settle()

/** Re-collect after every pass: a render produces fresh element objects. */
const fields = () => collect(mounted.tree, 'input')
const field = (index) => {
  const found = fields()
  assert.ok(found[index] !== undefined, `duration field #${String(index)} is rendered`)
  return found[index]
}
const errors = () => collect(mounted.tree, 'div').filter((node) => node.props.className === 'dss-fieldError')
const type = (index, text) => {
  mounted.act(() => { field(index).props.onChange({ target: { value: text } }) })
}
const blur = async (index) => {
  field(index).props.onBlur()
  await mounted.settle()
}
const lastPost = () => posted.at(-1)

process.stdout.write('  ok  renders two typeable duration fields\n')
assert.equal(fields().length, 2, 'one field per duration')
assert.equal(field(0).props.type, 'text', 'the hold is a text field, not a readout')
assert.equal(field(0).props.inputMode, 'decimal', 'with a numeric keypad hint')
assert.equal(field(0).props.value, '10', 'the hold shows seconds')
assert.equal(field(1).props.value, '30', 'the backstop shows seconds')
assert.equal(collect(mounted.tree, 'input').length, 2, 'and nothing else is typeable')

// Each field's range is the Host's bounds narrowed against the other field's
// current value, converted to seconds: the hold may reach one gap short of the
// backstop (30s → 29s) and the backstop sits one gap above the hold (10s → 11s).
const pageText = textOf(mounted.tree)
assert.ok(pageText.includes('range 0-29 seconds'), 'the hold description quotes its narrowed ceiling')
assert.ok(pageText.includes('range 11-600 seconds'), 'the backstop description quotes its raised floor')

process.stdout.write('  ok  an untouched field writes nothing\n')
await blur(0)
assert.equal(posted.length, 0, 'blurring without an edit must not write')
assert.equal(field(0).props.value, '10', 'and leaves the value alone')

process.stdout.write('  ok  a typed value converts to the stored unit\n')
type(0, '2.5')
await blur(0)
assert.deepEqual(lastPost(), { minDurationMs: 2500 }, 'seconds are converted to milliseconds')
assert.equal(fields()[0].props.value, '2.5', 'and the field shows what was typed')

process.stdout.write('  ok  a pasted unit suffix is accepted\n')
type(0, '12秒')
await blur(0)
assert.deepEqual(lastPost(), { minDurationMs: 12000 }, 'a trailing unit is tolerated')

process.stdout.write('  ok  out-of-range input clamps to the field\'s current ceiling\n')
type(0, '9999')
await blur(0)
assert.deepEqual(
  lastPost(),
  { minDurationMs: 29000 },
  'with the backstop at 30s, a huge hold clamps to one gap below it (29s)',
)
assert.equal(field(0).props.value, '29', 'and the field shows the clamped value')

process.stdout.write('  ok  unparseable input is refused, reverted, and explained\n')
const before = fields()[0].props.value
type(0, 'abc')
await blur(0)
assert.equal(posted.filter((patch) => 'minDurationMs' in patch).length, 3, 'a non-number is never sent')
assert.equal(field(0).props.value, before, 'the field reverts to the last good value')
assert.ok(errors().length > 0, 'and says why')
assert.ok(textOf(errors()[0]).includes('between 0 and 29 seconds'), 'quoting the field\'s narrowed range')
assert.equal(field(0).props['aria-invalid'], 'true', 'and marks the field invalid')

process.stdout.write('  ok  Escape cancels the edit without writing\n')
type(0, '7')
mounted.act(() => { field(0).props.onKeyDown({ key: 'Escape', stopPropagation() {}, target: { blur() {} } }) })
assert.equal(field(0).props.value, before, 'Escape restores the committed value')
assert.equal(posted.filter((patch) => 'minDurationMs' in patch).length, 3, 'and writes nothing')

process.stdout.write('  ok  focusing seeds the field with the committed value\n')
// Reachable only through a blur: a focused field is never re-focused, so a draft
// can only exist while the field already has focus.
type(0, 'oops')
await blur(0)
assert.equal(field(0).props.value, before, 'a refused entry reverts on blur')
let selected = false
mounted.act(() => { field(0).props.onFocus({ target: { select() { selected = true } } }) })
assert.equal(field(0).props.value, before, 'focus seeds from the committed value')
assert.ok(selected, 'and selects it, so typing replaces rather than appends')

process.stdout.write('  ok  Enter commits\n')
type(0, '7.5')
mounted.act(() => {
  field(0).props.onKeyDown({ key: 'Enter', preventDefault() {}, stopPropagation() {}, target: {} })
})
await mounted.settle()
assert.deepEqual(lastPost(), { minDurationMs: 7500 }, 'Enter commits the typed value')

process.stdout.write('  ok  the arrows still step by one second\n')
const arrows = collect(mounted.tree, 'button').filter((node) => node.props.className === 'dss-arrow')
assert.equal(arrows.length, 4, 'two arrows per field')
arrows[0].props.onClick()
await mounted.settle()
assert.deepEqual(lastPost(), { minDurationMs: 8500 }, 'the up arrow adds one second')

process.stdout.write('  ok  the hold cannot outrun the backstop, nor the backstop undercut the hold\n')
type(0, '99')
await blur(0)
assert.deepEqual(lastPost(), { minDurationMs: 29000 }, 'a hold past the backstop clamps to one step below it')
assert.equal(field(0).props.value, '29', 'and the field shows the clamped value')
assert.ok(
  textOf(mounted.tree).includes('range 0-29 seconds'),
  'the hold description now quotes the narrowed ceiling',
)

type(1, '5')
await blur(1)
assert.equal(field(1).props.value, '30', 'a backstop under the hold clamps back up to the hold plus one')
assert.equal(
  posted.filter((patch) => 'maxTimeoutMs' in patch).length,
  0,
  'and landing on the current value means nothing is written',
)

process.stdout.write('  ok  with the backstop raised, the hold reaches the Host\'s own ceiling\n')
type(1, '600')
await blur(1)
assert.deepEqual(lastPost(), { maxTimeoutMs: 600000 }, 'the backstop goes to its ceiling')
type(0, '9999')
await blur(0)
assert.deepEqual(
  lastPost(),
  { minDurationMs: BOUNDS.minDurationMs.max },
  `the hold then clamps to the Host ceiling (${String(BOUNDS.minDurationMs.max / 1000)}s)`,
)
assert.equal(field(0).props.value, '599', 'and shows it in seconds')

process.stdout.write('  ok  the palette and reset paths survive the new layout\n')
const chips = collect(mounted.tree, 'button').filter((node) => node.props.className.startsWith('dss-chip'))
assert.equal(chips.length, plugin.PRESETS.length, 'one chip per advertised palette')
chips[1].props.onClick()
await mounted.settle()
assert.deepEqual(lastPost(), { preset: plugin.PRESETS[1] }, 'a chip writes its palette')
assert.deepEqual(applies.at(-1), { preset: plugin.PRESETS[1] }, 'and retargets the overlay on this page load')

const pills = collect(mounted.tree, 'button').filter((node) => node.props.className === 'dss-pill')
assert.equal(pills.length, 2, 'preview and reset')
pills[0].props.onClick()
assert.deepEqual(previews.at(-1), { preset: plugin.PRESETS[1] }, 'preview replays with the held palette')
pills[1].props.onClick()
await mounted.settle()
assert.deepEqual(lastPost(), { reset: true }, 'reset asks the Host to drop the document')
assert.equal(field(0).props.value, '10', 'and the page shows the defaults again')

process.stdout.write('  ok  the nav order is measured, not hardcoded\n')
// The section is contributed with an order one past the highest *other* entry in
// the ledger, so a shipped section moving — or a new one arriving — cannot
// unseat it. These apply the bundle against ledgers of different shapes.
const orderFor = (ledger) => {
  const seen = []
  contribution.apply({
    effect(callback) { return callback() },
    locale: { register() {}, bind: () => t },
    slots: {
      inject(_slot, callback) { callback(); return () => {} },
      register(options) { seen.push(options); return () => {} },
      entries(name) { return name === 'settings.section' ? ledger.map((options) => ({ options })) : [] },
    },
  })
  const section = seen.find((options) => options.name === 'settings.section')
  assert.ok(section !== undefined, 'a section was contributed')
  return section.order
}

const SHIPPED = [
  { name: 'settings.section', id: 'general', order: 0 },
  { name: 'settings.section', id: 'models', order: 10 },
  { name: 'settings.section', id: 'plugins', order: 15 },
  { name: 'settings.section', id: 'agent-presets', order: 20 },
  { name: 'settings.section', id: 'archived-sessions', order: 25 },
]
assert.equal(orderFor(SHIPPED), 26, 'one past the highest shipped section')
assert.equal(
  orderFor([...SHIPPED, { name: 'settings.section', id: 'splash', order: 40 }]),
  26,
  'our own earlier seat is excluded, so a re-run cannot chase itself upward',
)
assert.equal(
  orderFor([{ name: 'settings.section', id: 'mystery', order: 250 }]),
  251,
  'and follows any later contributor that claims a higher seat',
)
assert.equal(orderFor([]), 100, 'an empty ledger falls back to a seat that still sorts below everything shipped')


delete globalThis.window
delete globalThis.document
delete globalThis.fetch
delete globalThis.__DSH_SPLASH__

process.stdout.write('dsh-splash page: all scenarios passed\n')

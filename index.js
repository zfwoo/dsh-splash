/**
 * Splash — Host half.
 *
 * The only official seat that exists *before* React does is the Host's index
 * injection table: `@deepseek-ai/dsh-host-webserver` emits
 * `webserver/index-inject` on every index render and every worker boot-payload
 * request, and each listener pushes structured rows. This plugin pushes a
 * `global`, a `script`, a `style`, an `html` and a `script` row — so the
 * overlay is in the document, and the kernel's own boot card is hidden, before
 * the client bundle ever runs. Copying the shipped `ui-theme` bootstrap, which
 * uses the same event for the pre-plugin palette.
 *
 * Two delivery channels carry those rows and they are NOT equivalent:
 *
 *   - `dsh web` renders the rows into the index.html text, so the head style
 *     lands before the first paint: the native card never appears at all.
 *   - The desktop app serves a static index.html that inlines only
 *     `__DSH_BOOT_READY__`, then hands the collected rows to the renderer over
 *     IPC *after* the owned Host reports ready. So the native card is visible
 *     for the whole Host startup and is replaced in one microtask once the
 *     rows land. A plugin cannot move that boundary: it is a plugin surface,
 *     and the document is served by the desktop shell.
 *
 * Persistence cannot be the browser's: the host process decides the row
 * contents at emit time, and on the desktop it decides them once per Host
 * lifetime. So the config is a JSON document in the DSH home, written through
 * this plugin's own routes behind the connection's trust fence — the same seam
 * the other local plugins in this profile use.
 *
 * This half imports node builtins only. A `link:`-mounted zero-build local
 * plugin resolves no `@deepseek-ai/*` bare specifier: its realpath lands
 * outside the profile, so DSH's resolver falls back to native resolution and
 * misses. The brand geometry therefore ships as the generated `fish-path.js`
 * data module (see `tools/extract-fish-path.mjs`).
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'

import { FISH_LOGO_PATH, FISH_LOGO_VIEWBOX } from './fish-path.js'

/** Cordis plugin name. */
export const name = 'dsh-splash'

/**
 * `webServer` publishes the routes and raises the injection event;
 * `connection` fences the routes to the operator's own browser. Nothing else
 * is required, so the overlay works in any profile that serves a Web UI.
 */
export const inject = ['webServer', 'connection']

/** Route the settings row reads the current config from. */
const ROUTE_CONFIG = '/dsh-splash.config'
/** Route the settings row writes the config to. */
const ROUTE_SET = '/dsh-splash.set'

/** Config document name inside the DSH home directory. */
const CONFIG_FILE = 'dsh-splash.json'

/** Largest accepted request body; a settings write is a few dozen bytes. */
const MAX_BODY_BYTES = 4096

/**
 * Available palettes, in settings-row order. `cyber` is the shipped default, so
 * index 0 is the fallback everywhere. Exported because it is this plugin's one
 * public vocabulary: the settings row reads it over the config route, and the
 * tools assert the stylesheet really defines a palette for each entry.
 */
export const PRESETS = ['cyber', 'synthwave', 'matrix', 'amber', 'mono']

/** Backstop values; the persisted document and the row config both override them. */
const DEFAULTS = Object.freeze({ enabled: true, preset: 'cyber', minDurationMs: 10000, maxTimeoutMs: 30000 })

/** How far the stall backstop must clear the hold, so the pair is always satisfiable. */
const BACKSTOP_MARGIN_MS = 1000

/**
 * Accepted ranges for the numeric settings, exported because the settings page
 * renders its steppers from them: the page must not carry its own copy of a
 * limit the Host enforces. `minDurationMs` stops one margin short of the
 * ceiling so that keeping the backstop above the hold always has room.
 *
 * Milliseconds throughout, including the step: the stored unit, the controller
 * and the markup's `--dsh-hold` are all milliseconds, so a second is a
 * presentation choice the page makes and not a property of the value. Both steps
 * are one second, which is what the page's arrows move by.
 */
export const BOUNDS = Object.freeze({
  /** 0 is meaningful: the overlay collapses as soon as the interface is ready. */
  minDurationMs: Object.freeze({ min: 0, max: 600000 - BACKSTOP_MARGIN_MS, step: 1000 }),
  maxTimeoutMs: Object.freeze({ min: 1000, max: 600000, step: 1000 }),
})

/** How many boot lines the terminal keeps on screen. */
const LOG_LINES = 5

/** Global holding the config the controller reads. */
const CONFIG_GLOBAL = '__DSH_SPLASH_CONFIG__'
/** Global exposing the controller to the settings row (preview + frame-live handshake). */
const FACADE_GLOBAL = '__DSH_SPLASH__'
/** Global carrying the controller's build-time facts. */
const PRELUDE_GLOBAL = '__DSH_SPLASH_PRELUDE__'
/**
 * Document-element attribute that switches the native boot card off. Kept as
 * markup spelling because every read and write of it is a DOM attribute call —
 * the overlay's own stylesheet selects on it.
 */
const STATE_ATTRIBUTE = 'data-dsh-splash-state'

/**
 * The overlay's whole surface: palette tokens, the FX layers, the terminal
 * frames, and the two endings (CRT collapse on success, held frame on stall).
 *
 * Every colour is a token this rule defines, so a preset is a token swap and
 * nothing else — the geometry is shared. Palette values are fixed rather than
 * `--dsw-*` aliases because the neon look is the point (a theme-following
 * palette cannot be neon on black); `mono` is the exception and tracks
 * `body[data-ds-dark-theme]` so a light workspace still gets a sane splash.
 */
const SPLASH_CSS = `
#dsh-splash[data-dsh-splash]{
  position:fixed;inset:0;z-index:2147483000;
  display:flex;align-items:center;justify-content:center;
  margin:0;padding:0;border:0;overflow:hidden;
  font-family:ui-monospace,"SFMono-Regular","Cascadia Mono",Consolas,"Liberation Mono",monospace;
  font-size:13px;line-height:18px;
  background:var(--dsh-bg);color:var(--dsh-ink);
  -webkit-app-region:no-drag;user-select:none;-webkit-user-select:none;
  cursor:pointer;pointer-events:auto;
  opacity:1;transition:opacity 380ms ease;
  --dsh-progress:0%;
  --dsh-hold:${String(DEFAULTS.minDurationMs)}ms;
}
/* cyber — the shipped default, and the fallback arm so the overlay still has
   colours if it ever renders without a preset attribute. Every preset is an
   explicit block below; the geometry rule above carries no palette. */
#dsh-splash[data-dsh-splash][data-ds-preset="cyber"],
#dsh-splash[data-dsh-splash]:not([data-ds-preset]){
  --dsh-1:#22e8ff;--dsh-2:#ff3d9a;--dsh-3:#7cffb2;
  --dsh-ink:#dff4ff;--dsh-dim:#5c7d90;--dsh-bg:#05060a;
  --dsh-grid:rgb(34 232 255 / 14%);--dsh-line:rgb(34 232 255 / 26%);
  --dsh-glow:rgb(34 232 255 / 26%);--dsh-flash:rgb(34 232 255 / 10%);
  --dsh-fx:1;
}
/* synthwave — the violet/orange pair nothing else in the set uses, so the chips
   stay tellable apart at a glance rather than by shade. */
#dsh-splash[data-dsh-splash][data-ds-preset="synthwave"]{
  --dsh-1:#c56bff;--dsh-2:#ff9b3d;--dsh-3:#5ee6ff;
  --dsh-ink:#f2e9ff;--dsh-dim:#8d7ca8;--dsh-bg:#0a0416;
  --dsh-grid:rgb(197 107 255 / 16%);--dsh-line:rgb(197 107 255 / 28%);
  --dsh-glow:rgb(197 107 255 / 28%);--dsh-flash:rgb(197 107 255 / 12%);
  --dsh-fx:1;
}
#dsh-splash[data-dsh-splash][data-ds-preset="matrix"]{
  --dsh-1:#3dff77;--dsh-2:#c2ff3d;--dsh-3:#3dff77;
  --dsh-ink:#dcffe8;--dsh-dim:#4f7a5c;--dsh-bg:#030704;
  --dsh-grid:rgb(61 255 119 / 13%);--dsh-line:rgb(61 255 119 / 24%);
  --dsh-glow:rgb(61 255 119 / 24%);--dsh-flash:rgb(61 255 119 / 10%);
}
#dsh-splash[data-dsh-splash][data-ds-preset="amber"]{
  --dsh-1:#ffb03a;--dsh-2:#ff6a2a;--dsh-3:#ffd76a;
  --dsh-ink:#ffeede;--dsh-dim:#8a7255;--dsh-bg:#0a0603;
  --dsh-grid:rgb(255 176 58 / 12%);--dsh-line:rgb(255 176 58 / 24%);
  --dsh-glow:rgb(255 176 58 / 24%);--dsh-flash:rgb(255 176 58 / 10%);
}
#dsh-splash[data-dsh-splash][data-ds-preset="mono"]{
  --dsh-fx:0;
  --dsh-1:#2a2f3a;--dsh-2:#2a2f3a;--dsh-3:#1f7a4d;
  --dsh-ink:#12151b;--dsh-dim:#8b9199;--dsh-bg:#f7f8f9;
  --dsh-grid:transparent;--dsh-line:rgb(0 0 0 / 14%);
  --dsh-glow:rgb(0 0 0 / 10%);--dsh-flash:rgb(0 0 0 / 6%);
}
body[data-ds-dark-theme] #dsh-splash[data-dsh-splash][data-ds-preset="mono"]{
  --dsh-1:#d5d9de;--dsh-2:#d5d9de;--dsh-3:#5ad39a;
  --dsh-ink:#ededf0;--dsh-dim:#7d838b;--dsh-bg:#0b0b0c;
  --dsh-line:rgb(255 255 255 / 14%);
  --dsh-glow:rgb(255 255 255 / 12%);--dsh-flash:rgb(255 255 255 / 6%);
}
#dsh-splash[data-dsh-splash][hidden]{display:none}

/* --- decorative field ---------------------------------------------------- */
#dsh-splash .dsh-fx{position:absolute;inset:0;pointer-events:none;opacity:var(--dsh-fx)}
#dsh-splash .dsh-grid{
  position:absolute;left:-60%;right:-60%;bottom:-6%;height:52%;
  background-image:linear-gradient(var(--dsh-grid) 1px,transparent 1px),
                   linear-gradient(90deg,var(--dsh-grid) 1px,transparent 1px);
  background-size:60px 60px;
  transform:perspective(340px) rotateX(66deg);transform-origin:50% 100%;
  -webkit-mask-image:linear-gradient(to top,#000,transparent);
  mask-image:linear-gradient(to top,#000,transparent);
  animation:dshGrid 2.6s linear infinite;
}
@keyframes dshGrid{from{background-position:0 0,0 0}to{background-position:0 60px,0 0}}
#dsh-splash .dsh-scan{
  position:absolute;inset:0;opacity:.45;
  background:repeating-linear-gradient(0deg,rgb(0 0 0 / 0%) 0 2px,rgb(0 0 0 / 26%) 2px 4px);
}
#dsh-splash .dsh-sweep{
  position:absolute;left:0;right:0;height:160px;
  background:linear-gradient(to bottom,transparent,var(--dsh-glow),transparent);
  animation:dshSweep 5.2s linear infinite;
}
@keyframes dshSweep{from{top:-160px}to{top:100%}}
#dsh-splash .dsh-vignette{
  position:absolute;inset:0;
  background:radial-gradient(120% 92% at 50% 46%,transparent 42%,rgb(0 0 0 / 64%) 100%);
}
#dsh-splash .dsh-hud i{position:absolute;width:22px;height:22px;border:1px solid var(--dsh-line)}
#dsh-splash .dsh-hud i:nth-child(1){top:18px;left:18px;border-right:0;border-bottom:0}
#dsh-splash .dsh-hud i:nth-child(2){top:18px;right:18px;border-left:0;border-bottom:0}
#dsh-splash .dsh-hud i:nth-child(3){bottom:18px;left:18px;border-right:0;border-top:0}
#dsh-splash .dsh-hud i:nth-child(4){bottom:18px;right:18px;border-left:0;border-top:0}

/* --- stage --------------------------------------------------------------- */
#dsh-splash .dsh-stage{
  position:relative;z-index:1;
  display:flex;flex-direction:column;align-items:center;gap:15px;
  width:100%;max-width:min(92vw,720px);padding:0 32px;
}
#dsh-splash .dsh-kicker{
  display:flex;align-items:center;gap:9px;width:100%;
  font-size:10px;line-height:14px;letter-spacing:.24em;text-transform:uppercase;color:var(--dsh-dim);
}
#dsh-splash .dsh-dot{
  width:6px;height:6px;flex:none;border-radius:50%;background:var(--dsh-2);
  box-shadow:0 0 8px var(--dsh-2);animation:dshBlink 1.8s steps(1,end) infinite;
}
@keyframes dshBlink{0%,70%{opacity:1}71%,100%{opacity:.25}}
#dsh-splash .dsh-kickerMeta{margin-left:auto;color:var(--dsh-3)}
#dsh-splash .dsh-lockup{display:flex;align-items:center;gap:16px;margin-top:2px}
#dsh-splash .dsh-mark{display:flex;width:64px;color:var(--dsh-1)}
#dsh-splash .dsh-mark svg{
  width:100%;height:auto;display:block;
  filter:drop-shadow(-1.5px 0 0 var(--dsh-2)) drop-shadow(1.5px 0 0 var(--dsh-1)) drop-shadow(0 0 14px var(--dsh-glow));
  animation:dshGlitch 4.6s steps(1,end) infinite;
}
@keyframes dshGlitch{
  0%,86%{transform:translateX(0);filter:drop-shadow(-1.5px 0 0 var(--dsh-2)) drop-shadow(1.5px 0 0 var(--dsh-1)) drop-shadow(0 0 14px var(--dsh-glow))}
  87%{transform:translateX(2px);filter:drop-shadow(-6px 0 0 var(--dsh-2)) drop-shadow(6px 0 0 var(--dsh-1)) drop-shadow(0 0 22px var(--dsh-glow))}
  89%{transform:translateX(-2px);filter:drop-shadow(5px 0 0 var(--dsh-2)) drop-shadow(-5px 0 0 var(--dsh-1)) drop-shadow(0 0 22px var(--dsh-glow))}
  91%,100%{transform:translateX(0);filter:drop-shadow(-1.5px 0 0 var(--dsh-2)) drop-shadow(1.5px 0 0 var(--dsh-1)) drop-shadow(0 0 14px var(--dsh-glow))}
}
#dsh-splash .dsh-wordmark{
  font-size:26px;line-height:30px;font-weight:700;letter-spacing:.26em;
  color:var(--dsh-ink);text-shadow:0 0 20px var(--dsh-glow);
  animation:dshFlicker 7.2s linear infinite;
}
@keyframes dshFlicker{0%,95%{opacity:1}96%{opacity:.5}97%{opacity:1}98%{opacity:.72}99%,100%{opacity:1}}

/* --- terminal ------------------------------------------------------------ */
#dsh-splash .dsh-log{
  display:flex;flex-direction:column;justify-content:flex-end;gap:3px;
  width:100%;height:102px;overflow:hidden;
  font-size:12px;line-height:18px;
}
#dsh-splash .dsh-line{display:flex;align-items:center;gap:8px;animation:dshLineIn 220ms ease both}
@keyframes dshLineIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
#dsh-splash .dsh-lineMark{flex:none;width:9px;color:var(--dsh-dim)}
#dsh-splash .dsh-lineText{flex:1;min-width:0;color:var(--dsh-ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#dsh-splash .dsh-lineText::after{content:"";display:inline-block;width:7px;height:13px;margin-left:3px;vertical-align:-2px;background:var(--dsh-1);animation:dshCaret 1s steps(1,end) infinite}
#dsh-splash .dsh-line.is-ok .dsh-lineText::after{display:none}
@keyframes dshCaret{0%,50%{opacity:1}51%,100%{opacity:0}}
#dsh-splash .dsh-lineOk{flex:none;font-size:10px;line-height:14px;letter-spacing:.16em;color:var(--dsh-3)}
#dsh-splash .dsh-line.is-ok .dsh-lineMark{color:var(--dsh-3)}
#dsh-splash .dsh-line.is-ok{animation:dshOkFlash 340ms ease}
@keyframes dshOkFlash{0%{background:var(--dsh-flash)}100%{background:transparent}}
#dsh-splash .dsh-line.is-idle .dsh-lineText{color:var(--dsh-dim)}

/* --- meter --------------------------------------------------------------- */
#dsh-splash .dsh-meter{
  display:flex;align-items:center;gap:10px;width:100%;
  font-size:11px;line-height:16px;letter-spacing:.12em;color:var(--dsh-dim);
}
#dsh-splash .dsh-track{
  position:relative;flex:1;min-width:160px;height:10px;
  border:1px solid var(--dsh-line);background:rgb(255 255 255 / 3%);
}
#dsh-splash .dsh-fill{
  position:absolute;top:1px;bottom:1px;left:1px;width:var(--dsh-progress);
  background:repeating-linear-gradient(90deg,var(--dsh-1) 0 5px,transparent 5px 8px);
  box-shadow:0 0 12px var(--dsh-glow);
  transition:width 300ms linear;
}
#dsh-splash .dsh-pct{flex:none;min-width:46px;text-align:right;color:var(--dsh-ink);font-variant-numeric:tabular-nums}
#dsh-splash .dsh-hint{
  font-size:10px;line-height:14px;letter-spacing:.24em;text-transform:uppercase;color:var(--dsh-dim);
}
#dsh-splash .dsh-skipnote{
  position:absolute;left:0;right:0;bottom:34px;z-index:1;text-align:center;
  font-size:10px;line-height:14px;letter-spacing:.3em;text-transform:uppercase;color:var(--dsh-dim);
  opacity:0;transition:opacity 500ms ease;
  animation:dshPulse 2.6s ease-in-out infinite;
}
#dsh-splash[data-dsh-splash-elapsed] .dsh-skipnote{opacity:.85}
@keyframes dshPulse{0%,100%{opacity:inherit}50%{opacity:.35}}
#dsh-splash .dsh-skip{
  position:absolute;left:50%;bottom:58px;z-index:1;transform:translateX(-50%);
  font:inherit;font-size:11px;line-height:16px;letter-spacing:.2em;text-transform:uppercase;
  padding:6px 18px;border:1px solid var(--dsh-1);border-radius:2px;
  background:transparent;color:var(--dsh-1);cursor:pointer;
  box-shadow:0 0 14px var(--dsh-glow),inset 0 0 14px var(--dsh-flash);
}
#dsh-splash .dsh-skip:hover{background:var(--dsh-flash)}
#dsh-splash .dsh-timeline{position:absolute;left:0;right:0;bottom:0;height:2px;background:rgb(255 255 255 / 6%)}
#dsh-splash .dsh-timelineFill{
  display:block;height:100%;width:0;
  background:linear-gradient(90deg,var(--dsh-1),var(--dsh-2));
  box-shadow:0 0 10px var(--dsh-glow);
  animation:dshTimeline var(--dsh-hold) linear forwards;
}
@keyframes dshTimeline{to{width:100%}}

/* --- states -------------------------------------------------------------- */
#dsh-splash[data-dsh-splash-stuck] .dsh-hint{color:var(--dsh-2)}
#dsh-splash[data-dsh-splash-stuck] .dsh-skipnote{display:none}
#dsh-splash.is-leaving{opacity:0;pointer-events:none}
/* CRT collapse: the frame squeezes into its own scanline on the way out. */
#dsh-splash.is-leaving .dsh-stage{animation:dshCollapse 380ms steps(5,end) forwards}
@keyframes dshCollapse{
  0%{transform:none;opacity:1;filter:none}
  55%{transform:translateX(4px) scaleY(.9);opacity:.75;filter:brightness(1.6)}
  100%{transform:scaleY(.02);opacity:0;filter:brightness(2.4)}
}
#dsh-splash.is-leaving .dsh-fx{animation:dshFxOut 380ms ease forwards}
@keyframes dshFxOut{to{opacity:0}}

@media (prefers-reduced-motion:reduce){
  #dsh-splash .dsh-grid,#dsh-splash .dsh-sweep,#dsh-splash .dsh-dot,
  #dsh-splash .dsh-mark svg,#dsh-splash .dsh-wordmark,#dsh-splash .dsh-skipnote,
  #dsh-splash .dsh-line,#dsh-splash .dsh-line.is-ok{animation:none}
  #dsh-splash .dsh-lineText::after{animation:none;opacity:1}
  #dsh-splash .dsh-timelineFill{animation:none;width:100%}
  #dsh-splash.is-leaving .dsh-stage{animation:none;opacity:0}
}
`

/**
 * The boot log. Written as real toolchain output rather than translated prose,
 * the way a compiler or a package manager prints it — the terminal voice is the
 * code-development theme, and a translated build log reads like neither.
 */
const LOG_SCRIPT = [
  'boot :: deepseek-harness',
  'resolve profile bundles',
  'compose cordis layers',
  'scan dsh.client entries',
  'link client bundles',
  'mount webserver routes',
  'load design tokens',
  'hydrate boot page',
  'mount application frame',
  'await renderer handshake',
]

/**
 * Resolve the DSH home directory the way the shipped plugins do.
 * @param config - Row config, which may pin an explicit home.
 * @returns absolute home directory.
 */
function resolveDshHome(config) {
  const configured = typeof config?.dshHome === 'string' && config.dshHome.trim() !== ''
    ? config.dshHome.trim()
    : undefined
  if (configured !== undefined) return resolve(configured)
  const fromEnv = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  if (fromEnv !== '') return resolve(fromEnv)
  return resolve(join(homedir(), '.dsh'))
}

/**
 * Read the persisted document, treating every failure as "absent".
 * @param path - Config document path.
 * @returns the parsed object, or undefined.
 */
function readDocument(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined
  } catch {
    // Absent, unreadable, or corrupt: the caller falls back to defaults rather
    // than failing the boot it is decorating.
    return undefined
  }
}

/**
 * Coerce one numeric field into its accepted range.
 *
 * The document is hand-editable, so this is the boundary where a stray value
 * stops: an out-of-range `minDurationMs` would not fail loudly, it would just
 * produce an overlay that behaves oddly at boot, which is the worst place to
 * debug. Rounding to an integer also keeps the page's stepper and the file in
 * agreement.
 * @param field - `minDurationMs` or `maxTimeoutMs`.
 * @param value - Candidate value.
 * @returns the clamped integer, or undefined when the value is not a number.
 */
function clampDuration(field, value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  const bounds = BOUNDS[field]
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(value)))
}

/**
 * Keep the stall backstop above the hold.
 *
 * A backstop below the hold would declare the boot stuck while the animation it
 * guards is still legitimately running, so the pair can never be allowed to
 * cross — but the page narrows both fields against each other, which means the
 * only way to arrive here crossed is a hand-edited document or a direct route
 * call. In that case the backstop is raised rather than the write refused,
 * because refusing would strand a boot with no overlay at all over an ordering
 * the operator probably did not intend. The route refuses a crossing *patch*
 * instead; this is purely the read-side safety net.
 *
 * `minDurationMs` stops one margin short of the ceiling so raising the backstop
 * always has room, which is what makes this resolution total.
 * @param config - Config to adjust in place.
 * @returns the same config.
 */
function keepBackstopAboveHold(config) {
  if (config.maxTimeoutMs <= config.minDurationMs) {
    config.maxTimeoutMs = Math.min(BOUNDS.maxTimeoutMs.max, config.minDurationMs + BACKSTOP_MARGIN_MS)
  }
  return config
}

/**
 * Merge one source into the config under construction, ignoring wrong types.
 * @param base - Config so far.
 * @param source - Row config or persisted document.
 * @returns the config, unchanged when the source carries nothing usable.
 */
function mergeSource(base, source) {
  if (source === null || typeof source !== 'object') return base
  if (typeof source.enabled === 'boolean') base.enabled = source.enabled
  if (PRESETS.includes(source.preset)) base.preset = source.preset
  for (const field of ['minDurationMs', 'maxTimeoutMs']) {
    const clamped = clampDuration(field, source[field])
    if (clamped !== undefined) base[field] = clamped
  }
  return base
}

/**
 * Build the config for this render: defaults, then the row config, then the
 * persisted document. The document is read synchronously because the injection
 * event is synchronous and expects the rows to be final.
 * @param config - Row config from the bundle patch.
 * @param path - Config document path.
 * @returns the resolved config.
 */
function resolveConfig(config, path) {
  const base = mergeSource({ ...DEFAULTS }, config)
  // The invariant is applied last so no source can break the pair: neither the
  // row config nor a hand-edited document gets to leave a backstop under the hold.
  return keepBackstopAboveHold(mergeSource(base, readDocument(path)))
}

/**
 * Write the document atomically, so a crash cannot leave a half-written file
 * that the next boot would read as corrupt.
 * @param path - Config document path.
 * @param value - Document contents.
 */
function writeDocument(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${String(process.pid)}.tmp`
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    renameSync(temporary, path)
  } catch (error) {
    try { rmSync(temporary, { force: true }) } catch { /* best effort */ }
    throw error
  }
}

/**
 * Render the overlay markup.
 *
 * The `hidden` attribute is the whole "disabled" implementation: the markup
 * ships either way so the settings row can replay the animation on demand. The
 * style above re-states `[hidden]{display:none}` because the overlay's own
 * `display:flex` would otherwise win over the UA rule.
 * @param config - Resolved config.
 * @returns the markup fragment.
 */
function splashMarkup(config) {
  const preset = PRESETS.includes(config.preset) ? config.preset : DEFAULTS.preset
  const hidden = config.enabled === true ? '' : ' hidden'
  const hold = Number.isFinite(config.minDurationMs) ? config.minDurationMs : DEFAULTS.minDurationMs
  const svg = `<svg viewBox="0 0 ${String(FISH_LOGO_VIEWBOX.width)} ${String(FISH_LOGO_VIEWBOX.height)}" fill="none" aria-hidden="true"><path d="${FISH_LOGO_PATH}" fill="currentColor"/></svg>`
  return `<div id="dsh-splash" data-dsh-splash data-ds-preset="${preset}" aria-busy="true" style="--dsh-hold:${String(hold)}ms"${hidden}>`
    + '<div class="dsh-fx" aria-hidden="true">'
    + '<div class="dsh-grid"></div><div class="dsh-sweep"></div>'
    + '<div class="dsh-scan"></div><div class="dsh-vignette"></div>'
    + '<div class="dsh-hud"><i></i><i></i><i></i><i></i></div>'
    + '</div>'
    + '<div class="dsh-stage">'
    + '<div class="dsh-kicker"><span class="dsh-dot"></span><span>DEEPSEEK HARNESS</span>'
    + '<span class="dsh-kickerMeta">BOOT SEQUENCE</span></div>'
    + `<div class="dsh-lockup"><div class="dsh-mark">${svg}</div>`
    + '<div class="dsh-wordmark">HARNESS</div></div>'
    + '<div class="dsh-log" data-dsh-splash-log aria-hidden="true"></div>'
    + '<div class="dsh-meter">'
    + '<span class="dsh-track"><span class="dsh-fill"></span></span>'
    + '<span class="dsh-pct" data-dsh-splash-pct>0%</span></div>'
    + '<div class="dsh-hint" data-dsh-splash-hint role="status" aria-live="polite"></div>'
    + '</div>'
    + '<button type="button" class="dsh-skip" data-dsh-splash-skip hidden></button>'
    + '<div class="dsh-skipnote" data-dsh-splash-skipnote></div>'
    + '<div class="dsh-timeline"><span class="dsh-timelineFill" data-dsh-splash-timeline></span></div>'
    + '</div>'
}

/**
 * The controller's exact text, read from its own file at startup.
 *
 * It is a real file rather than a template literal here so that its comments are
 * unconstrained and `node --check controller.js` guards it directly. As a
 * literal, one backtick in a comment closed the string early and Node reported an
 * unrelated \`Unexpected identifier\` three separate times; reading the file also
 * makes the shipped row byte-identical to the reviewed one.
 *
 * A missing file is a broken install, and it fails here — at composition time,
 * loudly — rather than shipping a boot with no overlay and no explanation.
 */
const CONTROLLER_SOURCE = readFileSync(new URL('./controller.js', import.meta.url), 'utf8')

/**
 * The single JSON-safe `global` row the controller reads its build-time facts
 * from, so its own file needs no substitution.
 * @returns the prelude value.
 */
function prelude() {
  return {
    configGlobal: CONFIG_GLOBAL,
    facadeGlobal: FACADE_GLOBAL,
    stateAttribute: STATE_ATTRIBUTE,
    presets: PRESETS,
    log: LOG_SCRIPT,
    cap: LOG_LINES,
    defaultMin: DEFAULTS.minDurationMs,
    defaultMax: DEFAULTS.maxTimeoutMs,
  }
}

/**
 * Register the config routes.
 * @param ctx - Plugin context.
 * @param path - Config document path.
 * @param rowConfig - Row config from the bundle patch.
 */
function registerRoutes(ctx, path, rowConfig) {
  /** Apply the connection's trust fence so the routes answer this browser. */
  const rejected = (req, res) => {
    const rejection = ctx.connection.requestRejection(req)
    if (rejection === undefined) return false
    res.statusCode = rejection
    res.end()
    return true
  }
  const sendJson = (res, status, payload) => {
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(payload))
  }
  // Defense in depth behind the fence: the settings row is same-origin, so a
  // request the browser itself labels cross-site is refused.
  const crossSite = (req, res) => {
    const site = req.headers['sec-fetch-site']
    if (typeof site === 'string' && site.toLowerCase() === 'cross-site') {
      sendJson(res, 403, { error: 'cross-site request refused' })
      return true
    }
    return false
  }
  const readBody = (req) => new Promise((settle, fail) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > MAX_BODY_BYTES) {
        fail(new Error('body too large'))
        req.destroy()
      }
    })
    req.on('end', () => {
      try { settle(JSON.parse(raw === '' ? '{}' : raw)) } catch { fail(new Error('body is not JSON')) }
    })
    req.on('error', fail)
  })

  const state = () => {
    const config = resolveConfig(rowConfig, path)
    return {
      enabled: config.enabled,
      preset: config.preset,
      presets: PRESETS,
      minDurationMs: config.minDurationMs,
      maxTimeoutMs: config.maxTimeoutMs,
      // The page renders its steppers and its "where does this live" line from
      // these, so neither limit nor path is duplicated in the client bundle.
      bounds: BOUNDS,
      // How far the backstop must clear the hold. The page narrows each field
      // against the other by this much, so the crossing is unreachable from the
      // UI and this number has one home.
      minGapMs: BACKSTOP_MARGIN_MS,
      configPath: path,
    }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_CONFIG,
    handler: (req, res) => {
      if (rejected(req, res)) return
      if (crossSite(req, res)) return
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.statusCode = 405
        res.setHeader('allow', 'GET, HEAD')
        res.end()
        return
      }
      try { sendJson(res, 200, state()) } catch { sendJson(res, 500, { error: 'config unavailable' }) }
    },
  }), `dsh-splash: GET ${ROUTE_CONFIG}`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_SET,
    handler: async (req, res) => {
      if (rejected(req, res)) return
      if (crossSite(req, res)) return
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('allow', 'POST')
        res.end()
        return
      }
      // Requiring JSON keeps a form-encoded cross-site POST out: setting that
      // content type needs a preflight the fence would never answer.
      const contentType = String(req.headers['content-type'] ?? '').toLowerCase()
      if (!contentType.startsWith('application/json')) {
        sendJson(res, 415, { error: 'content-type must be application/json' })
        return
      }
      let patch
      try { patch = await readBody(req) } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : 'bad request' })
        return
      }
      if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
        sendJson(res, 400, { error: 'body must be an object' })
        return
      }
      if (patch.enabled !== undefined && typeof patch.enabled !== 'boolean') {
        sendJson(res, 400, { error: 'enabled must be a boolean' })
        return
      }
      if (patch.preset !== undefined && !PRESETS.includes(patch.preset)) {
        sendJson(res, 400, { error: `preset must be one of ${PRESETS.join(', ')}` })
        return
      }
      if (patch.reset !== undefined && typeof patch.reset !== 'boolean') {
        sendJson(res, 400, { error: 'reset must be a boolean' })
        return
      }
      // Range-check here rather than trusting the page: the route is reachable
      // by anything behind the fence, and a bad number would surface as a
      // misbehaving boot rather than as an error.
      for (const field of ['minDurationMs', 'maxTimeoutMs']) {
        const value = patch[field]
        if (value === undefined) continue
        const bounds = BOUNDS[field]
        if (!Number.isInteger(value) || value < bounds.min || value > bounds.max) {
          sendJson(res, 400, { error: `${field} must be an integer between ${bounds.min} and ${bounds.max}` })
          return
        }
      }
      // The hold must not outrun the stall backstop. Checked against the
      // *effective* current pair rather than the raw document, so a document that
      // was hand-edited into a crossing is healed on the read path and does not
      // make every unrelated write fail; only a crossing this patch introduces is
      // refused. Refusing beats silently moving the field the operator did not
      // touch, and the page narrows both fields so this is reachable only by
      // calling the route directly.
      if (patch.reset !== true) {
        const current = resolveConfig(rowConfig, path)
        const next = { ...current }
        for (const field of ['minDurationMs', 'maxTimeoutMs']) {
          if (patch[field] !== undefined) next[field] = patch[field]
        }
        if (next.minDurationMs > next.maxTimeoutMs) {
          sendJson(res, 400, {
            error: `minDurationMs (${String(next.minDurationMs / 1000)}s) must not exceed maxTimeoutMs (${String(next.maxTimeoutMs / 1000)}s)`,
          })
          return
        }
      }
      try {
        if (patch.reset === true) {
          // Defaults mean "no overrides", so resetting is removing the document
          // rather than writing every default into it.
          rmSync(path, { force: true })
        } else {
          const stored = readDocument(path) ?? {}
          if (patch.enabled !== undefined) stored.enabled = patch.enabled
          if (patch.preset !== undefined) stored.preset = patch.preset
          for (const field of ['minDurationMs', 'maxTimeoutMs']) {
            if (patch[field] !== undefined) stored[field] = patch[field]
          }
          // Heal a pair a hand-edit left crossed, so the document converges on
          // what the animation actually does. The check above has already refused
          // a crossing this request introduced, so anything left here predates it.
          if (Number.isInteger(stored.minDurationMs) && Number.isInteger(stored.maxTimeoutMs)
            && stored.maxTimeoutMs <= stored.minDurationMs) {
            stored.maxTimeoutMs = Math.min(BOUNDS.maxTimeoutMs.max, stored.minDurationMs + BACKSTOP_MARGIN_MS)
          }
          writeDocument(path, stored)
        }
      } catch (error) {
        sendJson(res, 500, { error: error instanceof Error ? error.message : 'write failed' })
        return
      }
      sendJson(res, 200, { ...state(), restartRequired: true })
    },
  }), `dsh-splash: POST ${ROUTE_SET}`)
}

/**
 * Register the injection rows and the config routes.
 * @param ctx - Plugin context.
 * @param config - Row config: `dshHome`, plus `enabled` / `preset` /
 *   `minDurationMs` / `maxTimeoutMs` fallbacks the persisted document overrides.
 */
export function apply(ctx, config) {
  const path = join(resolveDshHome(config), CONFIG_FILE)

  // Deliberately not `prepend`. The table order is the listener activation
  // order, and the shipped ui-theme bootstrap prepends its own head style to
  // colour the canvas first; appending keeps this overlay's style after that
  // one, where equal specificity resolves in our favour. Nothing here needs to
  // run earlier: the native card is switched off by attribute, not by order.
  ctx.on('webserver/index-inject', (table) => {
    let resolved
    try {
      resolved = resolveConfig(config, path)
    } catch {
      // A listener that throws would take the rows after it down with it, and
      // those include the module graph itself.
      return
    }
    try {
      table.push({ kind: 'global', name: CONFIG_GLOBAL, value: resolved })
      table.push({ kind: 'global', name: PRELUDE_GLOBAL, value: prelude() })
      // Head rows land before the client bundle on both channels, so the native
      // card is switched off before it can be created on the served form.
      table.push({ kind: 'script', placement: 'head', text: `document.documentElement.setAttribute(${JSON.stringify(STATE_ATTRIBUTE)},${JSON.stringify(resolved.enabled === true ? 'on' : 'off')})` })
      table.push({ kind: 'style', text: SPLASH_CSS })
      table.push({ kind: 'html', placement: 'body', html: splashMarkup(resolved) })
      table.push({ kind: 'script', placement: 'body', text: CONTROLLER_SOURCE })
    } catch {
      // Same reasoning: never let this plugin's rows break the boot.
    }
  })

  registerRoutes(ctx, path, config)
}

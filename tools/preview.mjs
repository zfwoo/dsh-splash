/**
 * Build `preview.html`: a live gallery of the splash the plugin actually ships.
 *
 * The gallery is not a mock-up. It drives the same `apply` the Host does and
 * takes the `global`, `style`, `html` and `script` rows straight out of the
 * injection table, so a panel can only ever show what a real index render would
 * emit — including the boot log, which is the controller's job and would be
 * missing from a hand-drawn copy. Each panel is an iframe running the real
 * controller, and the gallery calls the plugin's own `preview()` entry point on
 * a loop, so the rings restart instead of collapsing once and going blank.
 *
 * `minDurationMs` is stretched to 600s inside the frames: the real default would
 * collapse each panel for good after ten seconds.
 *
 * Usage:
 *   node tools/preview.mjs
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

const home = mkdtempSync(join(tmpdir(), 'dsh-splash-preview-'))

let table
try {
  table = collect({}, home)
  for (const kind of ['style', 'html']) {
    if (!table.some((row) => row.kind === kind)) throw new Error(`preview: the table carried no ${kind} row`)
  }
} finally {
  rmSync(home, { recursive: true, force: true })
}

const markupRow = table.find((row) => row.kind === 'html').html
const preset = (id) => markupRow.replace(/data-ds-preset="[^"]*"/, `data-ds-preset="${id}"`)

/** Escape a global row's value the way the served form does. */
const asScriptValue = (value) => JSON.stringify(value).replaceAll('<', '\\u003c')

/**
 * One iframe document: the whole injection table, replayed in order.
 *
 * Row order matters and is preserved: the controller reads
 * `__DSH_SPLASH_PRELUDE__` and `__DSH_SPLASH_CONFIG__`, which arrive as `global`
 * rows ahead of it. Emitting only the markup and the script would leave the
 * controller reading an empty prelude, which is silently a splash with no log.
 *
 * The hold is a hair over the shipped 10s so a panel plays a complete cycle —
 * boot log, ready, then the CRT collapse — and the gallery reloads the whole
 * document just after, which is what makes the loop seamless. Leaving the hold
 * at its real value is the point: the ending is part of what is being previewed.
 */
function frameDocument(id, dark) {
  const overrides = { preset: id, enabled: true, minDurationMs: 11000, maxTimeoutMs: 600000 }
  const head = []
  const body = []
  for (const row of table) {
    if (row.kind === 'global') {
      const value = row.name === '__DSH_SPLASH_CONFIG__' ? { ...row.value, ...overrides } : row.value
      head.push(`<script>globalThis[${JSON.stringify(row.name)}]=${asScriptValue(value)}</script>`)
    } else if (row.kind === 'style') {
      head.push(`<style>${row.text}</style>`)
    } else if (row.kind === 'script') {
      const tag = `<script>${row.text}</script>`
      if (row.placement === 'head') head.push(tag)
      else body.push(tag)
    } else if (row.kind === 'html') {
      body.push(preset(id))
    }
  }
  return '<!DOCTYPE html><html><head><meta charset="utf-8">'
    + head.join('') + '</head>'
    + `<body${dark ? ' data-ds-dark-theme' : ''}>` + body.join('') + '</body></html>'
}

const PANELS = [
  { id: 'cyber', dark: true, label: 'cyber · 默认' },
  { id: 'synthwave', dark: true, label: 'synthwave' },
  { id: 'matrix', dark: true, label: 'matrix' },
  { id: 'amber', dark: true, label: 'amber' },
  { id: 'mono', dark: false, label: 'mono · 浅色' },
  { id: 'mono', dark: true, label: 'mono · 深色' },
]

/** One full cycle plus the collapse, and the stagger between panels. */
const REPLAY_MS = 12600
const STAGGER_MS = 1100

// Built here rather than in the page: one place assembles a frame document, and
// the gallery script only has to hand it to an iframe.
const DOCS = PANELS.map((panel) => frameDocument(panel.id, panel.dark))

const out = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>dsh-splash · 启动动画预览</title>
<style>
  :root { color-scheme: dark light }
  body { margin:0; padding:28px; background:#141416; color:#e8e8ea;
         font:14px/22px -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif }
  h1 { font-size:16px; font-weight:600; letter-spacing:.02em; margin:0 0 6px }
  p { margin:0 0 22px; color:#8b8b90; font-size:12px; line-height:18px; max-width:820px }
  code { font-family:ui-monospace, Consolas, monospace; color:#c9cdd3 }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(340px,1fr)); gap:18px }
  figure { margin:0; display:flex; flex-direction:column; gap:8px }
  figcaption { font-size:12px; color:#8b8b90; letter-spacing:.04em }
  iframe { width:100%; aspect-ratio:16/10; border:1px solid #2c2c30; border-radius:10px; background:#000; display:block }
</style>
</head>
<body>
<h1>启动动画 · ${String(PANELS.length)} 个面板</h1>
<p>每一格都由插件的注入行原样运行：<code>global</code> / <code>style</code> / <code>html</code> / <code>script</code>
四行直接取自 <code>webserver/index-inject</code> 的表，连同控制器脚本一起放进 iframe——启动日志、进度计、霓虹故障、CRT 收场都是真的。
每格跑完整一圈（约 11 秒后收场）再整帧重载，所以循环里不会留空档。<code>mono</code> 跟随亮暗主题，所以给了浅色与深色两格。</p>
<div class="grid" id="grid"></div>
<script>
const DOCS = ${JSON.stringify(DOCS)};
const LABELS = ${JSON.stringify(PANELS.map((panel) => panel.label))};
const REPLAY_MS = ${String(REPLAY_MS)};
const STAGGER_MS = ${String(STAGGER_MS)};
const grid = document.getElementById('grid');
const frames = DOCS.map((doc, index) => {
  const frame = document.createElement('iframe');
  // Assigned as a property: the documents are large and need no attribute escaping.
  frame.srcdoc = doc;
  const figure = document.createElement('figure');
  const caption = document.createElement('figcaption');
  caption.textContent = LABELS[index];
  figure.append(frame, caption);
  grid.append(figure);
  return frame;
});
// Staggered reloads, so the panels are never all showing the same moment.
frames.forEach((frame, index) => {
  setTimeout(() => {
    setInterval(() => {
      try { frame.contentWindow.location.reload() } catch (error) { console.warn(error) }
    }, REPLAY_MS);
  }, index * STAGGER_MS);
});
</script>
</body>
</html>
`

const target = new URL('../preview.html', import.meta.url)
writeFileSync(target, out)
process.stdout.write(`dsh-splash preview: wrote preview.html (${String(PANELS.length)} live panels, replay every ${String(REPLAY_MS)}ms)\n`)

/**
 * Splash — Client half.
 *
 * Owns the settings page and nothing else. The overlay itself is the Host
 * half's: it has to exist before this bundle is even fetched, so its markup and
 * its controller are injected rows, not React. This half only talks to the Host
 * over the plugin's own routes, and adds one invisible entry to `shell.overlay`
 * that tells the controller the application frame really rendered — a second
 * readiness signal next to the kernel boot card leaving the document.
 *
 * The page is a top-level `settings.section`, a sibling of General rather than a
 * row inside it, because every value here is the splash's own and none of them
 * belongs in a list of application-wide preferences. The slot owner supplies
 * only `close`; the shell provides the content column's padding and scrolling,
 * so the page renders rows and nothing else.
 *
 * A hand-written bundle: `require` resolves platform seed words only, so the
 * page is drawn with plain React plus `--dsw-alias-*` design tokens, copying the
 * shipped settings-row geometry (title + description on the left, the control on
 * the right, a 0.5px hairline separator). Class names are prefixed `dss-`.
 */

/**
 * Page styles. Geometry copied from the shipped settings rows (title 14/22 +
 * description 12/18, control on the right, 0.5px hairline) and the font-size
 * row's stepper pill, so the page sits in the panel without looking foreign.
 * Only `--dsw-alias-*` tokens are referenced, so both themes come for free.
 */
const CSS = `
.dss-page{display:flex;flex-direction:column;width:100%;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary)}
.dss-lead{margin:0;padding:4px 0 16px;border-bottom:0.5px solid var(--dsw-alias-border-l2);font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dss-row,.dss-block{display:flex;gap:8px;padding:16px 0;border-bottom:0.5px solid var(--dsw-alias-border-l2)}
.dss-row{align-items:center}
.dss-block{flex-direction:column;gap:8px}
.dss-rowText{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px;padding-right:32px}
.dss-title{font-size:14px;font-weight:400;line-height:22px;color:var(--dsw-alias-label-primary)}
.dss-desc{font-size:12px;font-weight:400;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dss-chips{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dss-switch{
  flex:none;position:relative;width:40px;height:22px;padding:0;
  border:0.5px solid var(--dsw-alias-border-l3);border-radius:11px;
  background:var(--dsw-alias-bg-module-platform);cursor:pointer;
  transition:background 160ms ease,border-color 160ms ease;
}
.dss-switchOn{background:var(--dsw-alias-brand-primary);border-color:transparent}
.dss-knob{
  position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;
  background:var(--dsw-alias-label-primary);transition:transform 160ms ease,background 160ms ease;
}
.dss-switchOn .dss-knob{transform:translateX(18px);background:var(--dsw-alias-label-primary-foreground)}
.dss-chip{
  display:inline-flex;align-items:center;gap:6px;
  padding:5px 12px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:14px;
  background:transparent;font:inherit;font-size:12px;line-height:18px;
  color:var(--dsw-alias-label-primary);cursor:pointer;
}
.dss-chip:hover:not(.dss-chipOn){background:var(--dsw-alias-interactive-bg-hover)}
.dss-chipOn{
  background:var(--dsw-alias-bg-module-platform);
  border-color:var(--dsw-static-neutral-bluish-400);
}
.dss-swatch{
  width:10px;height:10px;flex:none;border-radius:50%;
  border:0.5px solid var(--dsw-alias-border-l3);
  /* A palette the page does not know still gets a neutral dot rather than a hole. */
  background:var(--dsw-alias-label-tertiary);
}
.dss-swatch[data-preset="cyber"]{background:linear-gradient(135deg,#22e8ff,#ff3d9a)}
.dss-swatch[data-preset="synthwave"]{background:linear-gradient(135deg,#c56bff,#ff9b3d)}
.dss-swatch[data-preset="matrix"]{background:linear-gradient(135deg,#3dff77,#030704)}
.dss-swatch[data-preset="amber"]{background:linear-gradient(135deg,#ffb03a,#ff6a2a)}
.dss-swatch[data-preset="mono"]{background:linear-gradient(135deg,#f7f8f9 0 50%,#0b0b0c 50% 100%)}
/* The field sits in a column so a rejected entry can explain itself under the
   pill, next to the thing it is about, instead of in the page-level notice. */
.dss-control{display:inline-flex;flex-direction:column;align-items:flex-end;gap:4px;flex:none}
.dss-pillRow{display:inline-flex;align-items:center;gap:8px}
.dss-stepper{
  position:relative;display:inline-flex;align-items:center;justify-content:center;
  min-width:118px;height:36px;border-radius:18px;
  background:var(--dsw-alias-bg-module-platform);
}
/* The value is typeable, so the pill carries a focus state of its own: without
   it a keyboard user cannot tell which field is being edited. */
.dss-stepper:focus-within{box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l4)}
.dss-input{
  width:72px;padding:0;border:none;background:transparent;text-align:center;
  font:inherit;font-size:14px;line-height:22px;
  font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);
  outline:none;
}
.dss-input[aria-invalid="true"]{color:var(--dsw-alias-state-error-primary)}
.dss-unit{font-size:14px;line-height:22px;color:var(--dsw-alias-label-secondary)}
/* The arrow column stays in the tab order while hidden: opacity, not visibility,
   so keyboard focus itself reveals it. */
.dss-arrows{position:absolute;right:8px;display:flex;flex-direction:column;gap:2px;opacity:0}
.dss-stepper:hover .dss-arrows,.dss-stepper:focus-within .dss-arrows{opacity:1}
.dss-arrow{
  display:inline-flex;align-items:center;justify-content:center;
  width:17px;height:12px;padding:0;border:none;border-radius:3px;
  background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);cursor:pointer;
}
.dss-arrow:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dss-arrow:disabled{color:var(--dsw-alias-label-caption);cursor:default}
.dss-chev{display:block;width:0;height:0;border-left:3.5px solid transparent;border-right:3.5px solid transparent}
.dss-chev[data-dir="up"]{border-bottom:5px solid currentColor}
.dss-chev[data-dir="down"]{border-top:5px solid currentColor}
.dss-fieldError{font-size:11px;line-height:16px;color:var(--dsw-alias-state-error-primary);text-align:right;max-width:220px}
.dss-actions{display:flex;justify-content:flex-end;gap:8px;padding:16px 0}
.dss-pill{
  height:32px;padding:0 16px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:16px;
  background:var(--dsw-alias-bg-module-platform);font:inherit;font-size:12px;line-height:18px;
  color:var(--dsw-alias-label-primary);cursor:pointer;
}
.dss-pill:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dss-notice{padding:0 0 12px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dss-where{display:flex;flex-direction:column;gap:4px;padding:16px 0 0}
.dss-path{
  font-family:ui-monospace,"SFMono-Regular","Cascadia Mono",Consolas,monospace;
  font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);word-break:break-all;
}
`

window.__ModuleLoader__.load({
  id: '@local/dsh-splash',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useState } = React

    /** Locale namespace owned by this plugin. */
    const NS = 'dsh-splash'
    /** Host routes, browser-relative so they resolve under any mount point. */
    const ROUTE_CONFIG = 'dsh-splash.config'
    const ROUTE_SET = 'dsh-splash.set'

    const DICTS = {
      zh: {
        'nav': '启动画面',
        'page.desc': '赛博朋克启动动画的全部设置。每一项都写在下面那个配置文档里，宿主在每次渲染索引时读取它。',
        'enable.title': '启用启动画面',
        'enable.desc': '关闭后不再覆盖内核加载卡片，改为显示产品原生的启动画面。',
        'preset.title': '霓虹配色',
        'preset.cyber': '赛博',
        'preset.synthwave': '合成波',
        'preset.matrix': '矩阵',
        'preset.amber': '琥珀',
        'preset.mono': '素色',
        'hold.title': '动画时长',
        'hold.desc': '浮层的最短展示时长：计时结束且界面已就绪才会收场。范围 {min}–{max} 秒，不得超过兜底超时，可直接输入。',
        'backstop.title': '兜底超时',
        'backstop.desc': '超过这个时间仍未就绪就改为显示「继续」，不会假装成功。范围 {min}–{max} 秒，始终保持在动画时长之上。',
        'unit.s': '秒',
        'increase': '增加一秒',
        'decrease': '减少一秒',
        'error.number': '请输入 {min}–{max} 之间的秒数',
        'action.preview': '预览',
        'action.reset': '恢复默认',
        'action.previewUnavailable': '预览入口还没就绪：宿主半侧的注入行尚未生效。桌面端重启应用，浏览器端刷新页面。',
        'notice.saved': '已保存，配色已应用到当前画面。桌面端需重启应用刷新宿主行，浏览器端刷新页面即可。',
        'notice.enabled': '已保存。桌面端需重启应用生效，浏览器端刷新页面即可。',
        'notice.reset': '已恢复默认值。',
        'state.loading': '正在读取…',
        'state.failed': '读取失败',
        'state.retry': '重试',
        'state.saveFailed': '保存失败',
        'where.label': '配置文件',
        'where.desc': '也可以直接编辑这个文件；宿主会在下次渲染索引时读到它。',
      },
      en: {
        'nav': 'Splash screen',
        'page.desc': 'Everything the cyberpunk boot animation reads. Each value lives in the config document below, which the Host reads on every index render.',
        'enable.title': 'Enable splash screen',
        'enable.desc': 'When off, the built-in loading card is left alone and the product\u2019s own boot screen shows instead.',
        'preset.title': 'Neon palette',
        'preset.cyber': 'Cyber',
        'preset.synthwave': 'Synthwave',
        'preset.matrix': 'Matrix',
        'preset.amber': 'Amber',
        'preset.mono': 'Plain',
        'hold.title': 'Animation length',
        'hold.desc': 'Shortest time the overlay stays up: it collapses once that has elapsed and the interface is ready. {min}–{max} seconds, never above the stall backstop; you can type a value.',
        'backstop.title': 'Stall backstop',
        'backstop.desc': 'If the app is still not ready by then, a continue button appears instead of pretending it succeeded. {min}–{max} seconds, always kept above the animation length.',
        'unit.s': 's',
        'increase': 'Increase by one second',
        'decrease': 'Decrease by one second',
        'error.number': 'Enter a number of seconds between {min} and {max}',
        'action.preview': 'Preview',
        'action.reset': 'Restore defaults',
        'action.previewUnavailable': 'Preview is not ready: the Host rows have not taken effect yet. Restart the desktop app, or reload the browser page.',
        'notice.saved': 'Saved, and the palette is applied on screen. The desktop app needs a restart to refresh the Host rows; a browser page just needs a reload.',
        'notice.enabled': 'Saved. The desktop app needs a restart; a browser page just needs a reload.',
        'notice.reset': 'Defaults restored.',
        'state.loading': 'Loading…',
        'state.failed': 'Could not read the settings',
        'state.retry': 'Retry',
        'state.saveFailed': 'Could not save',
        'where.label': 'Config file',
        'where.desc': 'You can edit this file directly; the Host reads it on the next index render.',
      },
    }

    /**
     * Name a palette, falling back to its id.
     *
     * The page renders whatever the Host advertises rather than a list kept here
     * in step with it: a palette added on the Host side shows up immediately, and
     * the only thing that has to exist per palette is a swatch colour, which the
     * stylesheet defaults when it does not recognise one.
     */
    const presetLabel = (t, id) => {
      const key = `preset.${id}`
      const text = t(key)
      return typeof text === 'string' && text !== '' && text !== key ? text : id
    }

    /**
     * Fill `{name}` placeholders in a dictionary string.
     *
     * The two duration descriptions quote the range the Host enforces, so those
     * numbers have to come from the Host's own bounds rather than from prose that
     * drifts away from them.
     */
    const fill = (template, values) => String(template).replace(
      /\{(\w+)\}/g,
      (whole, name) => (values[name] === undefined ? whole : String(values[name])),
    )

    /** Seconds, the unit the page speaks; the stored value stays milliseconds. */
    const toSeconds = (ms) => ms / 1000

    /**
     * Read a typed duration.
     *
     * A trailing `s` or `秒` is accepted so a value pasted from the config file or
     * from a friend still lands. Anything else non-numeric is refused rather than
     * coerced: silently turning `1O` into `0` would be worse than saying no.
     * @param text - Field contents.
     * @returns seconds, or undefined when the text is not a number.
     */
    const parseSeconds = (text) => {
      const trimmed = String(text).trim().replace(/[s秒]\s*$/i, '')
      if (!/^\d+(?:\.\d+)?$/.test(trimmed)) return undefined
      return Number(trimmed)
    }

    /** Send one request to a Host route, surfacing a non-2xx as an error. */
    const request = async (path, init) => {
      const response = await fetch(path, init)
      const payload = await response.json().catch(() => undefined)
      if (!response.ok) throw new Error(String(payload?.error ?? response.status))
      return payload
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const locale = ctx.locale
        const t = locale.bind(NS)
        for (const [id, dict] of Object.entries(DICTS)) {
          ctx.effect(() => locale.register(NS, id, dict), `dsh-splash: locale ${id}`)
        }

        ctx.effect(() => {
          const tag = document.createElement('style')
          tag.dataset.plugin = '@local/dsh-splash'
          tag.textContent = CSS
          document.head.appendChild(tag)
          return () => { tag.remove() }
        }, 'dsh-splash: stylesheet')

        /**
         * A duration field: the shipped selector-pill geometry holding a **typed**
         * value instead of a fixed one, with the arrow column anchored to its right
         * edge and the unit outside the pill.
         *
         * The value on screen is seconds and the value on the wire is
         * milliseconds; the conversion lives here and nowhere else. Bounds and step
         * come from the Host, so the page never carries its own copy of a limit the
         * Host enforces.
         *
         * The draft is `null` unless the field is being edited, and that is the
         * whole trick. While a draft existed for the field's lifetime, the display
         * had to be re-synced from the prop by an effect keyed on the rendered
         * value — and when the Host corrected a value back to what it had been
         * (a backstop raised above a longer hold lands on exactly the number the
         * field already showed) the key did not change, the effect did not run, and
         * the field kept showing the number the operator typed instead of the one in
         * effect. With a nullable draft, an unedited field simply renders the prop,
         * so no correction can be missed, and the effect disappears entirely.
         *
         * Out-of-range input is clamped rather than refused — the rest of the plugin
         * clamps too — while unparseable input is refused and reverted, with the
         * reason shown under the field.
         */
        function DurationField({ value, bounds, unit, label, onCommit, t }) {
          const committed = String(toSeconds(value))
          const [draft, setDraft] = useState(null)
          const [error, setError] = useState(null)
          const shown = draft === null ? committed : draft
          const range = { min: toSeconds(bounds.min), max: toSeconds(bounds.max) }

          const commit = () => {
            if (draft === null) return
            // Drop the draft first: whatever the Host ends up holding is what the
            // field must show, including when it equals what was there before.
            setDraft(null)
            const seconds = parseSeconds(draft)
            if (seconds === undefined) {
              setError(fill(t('error.number'), range))
              return
            }
            setError(null)
            const ms = Math.min(bounds.max, Math.max(bounds.min, Math.round(seconds * 1000)))
            if (ms !== value) onCommit(ms)
          }

          const nudge = (delta) => {
            setDraft(null)
            setError(null)
            onCommit(Math.min(bounds.max, Math.max(bounds.min, value + delta)))
          }
          const arrow = (direction, delta, disabled) => h('button', {
            type: 'button',
            className: 'dss-arrow',
            'aria-label': t(direction === 'up' ? 'increase' : 'decrease'),
            disabled,
            onClick: () => { nudge(delta) },
          }, h('span', { className: 'dss-chev', 'data-dir': direction }))

          return h('div', { className: 'dss-control' },
            h('div', { className: 'dss-pillRow' },
              h('div', { className: 'dss-stepper' },
                h('input', {
                  className: 'dss-input',
                  type: 'text',
                  inputMode: 'decimal',
                  value: shown,
                  'aria-label': label,
                  'aria-invalid': error === null ? undefined : 'true',
                  onFocus: (event) => {
                    // Seeded from the committed value so the selection below covers
                    // it and typing replaces rather than appends.
                    if (draft === null) setDraft(committed)
                    event.target.select()
                  },
                  onChange: (event) => { setError(null); setDraft(event.target.value) },
                  onBlur: commit,
                  onKeyDown: (event) => {
                    // Escape is the settings dialog's close gesture and Enter its
                    // submit gesture; inside a field they mean "cancel this edit" and
                    // "commit it". Stop them here, or cancelling a keystroke would
                    // close the whole panel.
                    if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); commit() }
                    else if (event.key === 'Escape') {
                      // Cancels in place rather than blurring: a blur dispatched
                      // before the next render would still see the old draft and
                      // commit the very edit being cancelled.
                      event.stopPropagation()
                      setDraft(null)
                      setError(null)
                    }
                  },
                }),
                h('span', { className: 'dss-arrows' },
                  arrow('up', bounds.step, value >= bounds.max),
                  arrow('down', -bounds.step, value <= bounds.min))),
              h('span', { className: 'dss-unit' }, unit)),
            error === null ? null : h('div', { className: 'dss-fieldError' }, error))
        }

        /** The settings page: every value the config document holds. */
        function SplashSection({ t }) {
          const [state, setState] = useState({ status: 'loading' })
          const [notice, setNotice] = useState(null)

          const load = useCallback(() => {
            setState({ status: 'loading' })
            request(ROUTE_CONFIG).then(
              (payload) => { setState({ status: 'ready', value: payload }) },
              (error) => { setState({ status: 'failed', error: String(error?.message ?? error) }) },
            )
          }, [])
          useEffect(() => { load() }, [load])

          const write = useCallback((patch, message) => {
            // A reset has no partial state to merge, so it waits for the Host's
            // answer like every other field waits for the effective pair back.
            setState((current) => (current.status === 'ready' && patch.reset !== true
              ? { status: 'ready', value: { ...current.value, ...patch } }
              : current))
            request(ROUTE_SET, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(patch),
            }).then(
              (payload) => {
                setState({ status: 'ready', value: payload })
                // Retarget the overlay on this page load as well: the palette was
                // pinned by the Host when it rendered this index, and only the
                // controller can move it now.
                globalThis.__DSH_SPLASH__?.apply?.({ preset: payload.preset })
                setNotice(message)
              },
              (error) => {
                setNotice(`${t('state.saveFailed')}: ${String(error?.message ?? error)}`)
                load()
              },
            )
          }, [load, t])

          if (state.status === 'loading') {
            return h('div', { className: 'dss-page' }, h('p', { className: 'dss-lead' }, t('state.loading')))
          }
          if (state.status === 'failed') {
            return h('div', { className: 'dss-page' },
              h('p', { className: 'dss-lead' }, `${t('state.failed')}: ${state.error}`),
              h('div', { className: 'dss-actions' },
                h('button', { type: 'button', className: 'dss-pill', onClick: load }, t('state.retry'))))
          }

          const { enabled, preset, presets, minDurationMs, maxTimeoutMs, bounds, minGapMs, configPath } = state.value
          const choices = Array.isArray(presets) && presets.length > 0 ? presets : [preset]
          /** A bound pair as seconds, for the descriptions that quote the range. */
          const range = (bound) => ({ min: toSeconds(bound.min), max: toSeconds(bound.max) })
          // The two durations constrain each other: the hold may not outrun the
          // backstop, so each field's far edge is the other field's current value
          // shifted by the Host's own gap. Narrowing here makes the crossing
          // unreachable from the page — typing or stepping past it clamps, exactly
          // like every other out-of-range value. The gap comes from the Host, so
          // the page still carries no copy of a limit the Host owns.
          const gap = typeof minGapMs === 'number' && minGapMs > 0 ? minGapMs : 1000
          const holdBounds = {
            ...bounds.minDurationMs,
            max: Math.max(bounds.minDurationMs.min, Math.min(bounds.minDurationMs.max, maxTimeoutMs - gap)),
          }
          const backstopBounds = {
            ...bounds.maxTimeoutMs,
            min: Math.min(bounds.maxTimeoutMs.max, Math.max(bounds.maxTimeoutMs.min, minDurationMs + gap)),
          }
          // Preview does not depend on the enable switch — the Host's preview
          // replays the animation whatever the stored value is, which is the whole
          // point of previewing a disabled splash. It depends only on the Host half
          // having run, and a button that silently no-ops when it has not is what
          // makes "preview does nothing" so hard to report.
          const canPreview = typeof globalThis.__DSH_SPLASH__?.preview === 'function'
          const preview = () => {
            if (!canPreview) { setNotice(t('action.previewUnavailable')); return }
            globalThis.__DSH_SPLASH__.preview({ preset })
          }

          return h('div', { className: 'dss-page' },
            h('p', { className: 'dss-lead' }, t('page.desc')),

            h('div', { className: 'dss-row' },
              h('div', { className: 'dss-rowText' },
                h('div', { className: 'dss-title' }, t('enable.title')),
                h('div', { className: 'dss-desc' }, t('enable.desc'))),
              h('button', {
                type: 'button',
                className: enabled ? 'dss-switch dss-switchOn' : 'dss-switch',
                role: 'switch',
                'aria-checked': enabled,
                'aria-label': t('enable.title'),
                onClick: () => { write({ enabled: !enabled }, t('notice.enabled')) },
              }, h('span', { className: 'dss-knob' }))),

            h('div', { className: 'dss-block' },
              h('div', { className: 'dss-title' }, t('preset.title')),
              h('div', { className: 'dss-chips' },
                choices.map((id) => h('button', {
                  key: id,
                  type: 'button',
                  className: preset === id ? 'dss-chip dss-chipOn' : 'dss-chip',
                  'aria-pressed': preset === id,
                  onClick: () => { write({ preset: id }, t('notice.saved')) },
                }, h('span', { className: 'dss-swatch', 'data-preset': id }), presetLabel(t, id))))),

            h('div', { className: 'dss-row' },
              h('div', { className: 'dss-rowText' },
                h('div', { className: 'dss-title' }, t('hold.title')),
                h('div', { className: 'dss-desc' }, fill(t('hold.desc'), range(holdBounds)))),
              h(DurationField, {
                value: minDurationMs,
                bounds: holdBounds,
                unit: t('unit.s'),
                label: t('hold.title'),
                t,
                onCommit: (next) => { write({ minDurationMs: next }, t('notice.saved')) },
              })),

            h('div', { className: 'dss-row' },
              h('div', { className: 'dss-rowText' },
                h('div', { className: 'dss-title' }, t('backstop.title')),
                h('div', { className: 'dss-desc' }, fill(t('backstop.desc'), range(backstopBounds)))),
              h(DurationField, {
                value: maxTimeoutMs,
                bounds: backstopBounds,
                unit: t('unit.s'),
                label: t('backstop.title'),
                t,
                onCommit: (next) => { write({ maxTimeoutMs: next }, t('notice.saved')) },
              })),

            h('div', { className: 'dss-actions' },
              h('button', { type: 'button', className: 'dss-pill', onClick: preview }, t('action.preview')),
              h('button', {
                type: 'button',
                className: 'dss-pill',
                onClick: () => { write({ reset: true }, t('notice.reset')) },
              }, t('action.reset'))),

            notice === null ? null : h('div', { className: 'dss-notice' }, notice),

            h('div', { className: 'dss-where' },
              h('div', { className: 'dss-title' }, t('where.label')),
              h('code', { className: 'dss-path' }, configPath),
              h('div', { className: 'dss-desc' }, t('where.desc'))))
        }

        /**
         * Invisible overlay entry. `shell.overlay` only renders once the
         * application frame does, so mounting this is proof the frame is live —
         * exactly the cross-check the injected controller wants.
         */
        function FrameLiveSignal() {
          useEffect(() => { globalThis.__DSH_SPLASH__?.frameLive?.() }, [])
          return null
        }

        // A top-level section, pinned to the **bottom** of the nav by
        // measurement, not by a hardcoded number. The shipped sections are
        // General 0, Models 10, Plugins 15, Agent presets 20 and Archived sessions
        // 25 today, and any of them moving — or a new one arriving — would
        // silently unseat a fixed order. So the ledger is read at registration
        // time and this section takes one past the highest *other* entry.
        //
        // Ours is excluded on purpose: if this contributor ever runs again with
        // its previous seat already in the ledger, counting it would make the
        // section chase its own tail upward. An empty ledger (nothing to measure)
        // falls back to a triple-digit seat, which still sorts below every
        // shipped section today.
        ctx.slots.inject('settings.section', () => {
          const BOTTOM_FALLBACK = 100
          const mine = 'splash'
          const others = (typeof ctx.slots.entries === 'function'
            ? ctx.slots.entries('settings.section')
            : [])
            .filter((entry) => entry?.options?.id !== mine)
            .map((entry) => (typeof entry?.options?.order === 'number' ? entry.options.order : 0))
          return ctx.slots.register({
            name: 'settings.section',
            id: mine,
            order: others.length > 0 ? Math.max(...others) + 1 : BOTTOM_FALLBACK,
            label: () => t('nav'),
            locale: NS,
          }, SplashSection)
        })

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'dsh-splash.signal',
          locale: NS,
        }, FrameLiveSignal))
      },
    }
  },
})

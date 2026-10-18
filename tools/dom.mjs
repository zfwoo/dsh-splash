/**
 * A minimal DOM good enough to execute the injected controller.
 *
 * The controller is the one piece of this plugin that cannot be checked by
 * reading it: it runs in the page before React, it owns the whole animation,
 * and `preview()` is only reachable from a settings-row click. Node has no DOM,
 * so this stands one up — element tree, attribute selectors, classList,
 * dataset, style, listeners, MutationObserver and rAF — covering exactly the
 * surface the controller touches, and nothing more. Deliberately not a general
 * DOM: a general one would be a dependency and a maintenance liability for a
 * plugin that must stay dependency-free.
 *
 * Everything the controller reads from markup is parsed out of the REAL
 * `html` row, so a markup change that breaks the controller breaks the test.
 */

/** One element node. */
class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase()
    this.attrs = new Map()
    this.childNodes = []
    this.parentNode = null
    this.ownText = ''
    this.listeners = new Map()
    this.style = makeStyle()
  }

  // `hidden` is an attribute-backed property in a real DOM; if the harness kept
  // it as a plain field, a `hidden` in the markup would read as false and the
  // disabled-splash path would test nothing.
  get hidden() { return this.attrs.has('hidden') }

  set hidden(value) {
    if (value) this.attrs.set('hidden', '')
    else this.attrs.delete('hidden')
  }

  get children() { return this.childNodes.filter((node) => node instanceof El) }

  get childElementCount() { return this.children.length }

  get firstChild() { return this.childNodes[0] ?? null }

  get textContent() {
    return this.ownText + this.children.map((child) => child.textContent).join('')
  }

  set textContent(value) {
    this.childNodes = []
    this.ownText = String(value)
  }

  get isConnected() {
    let node = this
    while (node.parentNode !== null) node = node.parentNode
    return node === this.ownerDocument?.documentElement
  }

  get dataset() {
    const self = this
    return new Proxy({}, {
      get: (_target, key) => self.attrs.get(attributeName(key)),
      set: (_target, key, value) => { self.attrs.set(attributeName(key), String(value)); return true },
      has: (_target, key) => self.attrs.has(attributeName(key)),
      // A DOMStringMap supports `delete el.dataset.x`; without this trap the
      // delete would "succeed" against the empty target and silently no-op,
      // which is exactly the kind of gap a harness must not have.
      deleteProperty: (_target, key) => { self.attrs.delete(attributeName(key)); return true },
    })
  }

  get classList() {
    const self = this
    const parts = () => (self.attrs.get('class') ?? '').split(/\s+/).filter(Boolean)
    return {
      add(...names) { self.attrs.set('class', [...new Set([...parts(), ...names])].join(' ')) },
      remove(...names) { self.attrs.set('class', parts().filter((part) => !names.includes(part)).join(' ')) },
      contains(name) { return parts().includes(name) },
    }
  }

  get offsetWidth() { return 0 }

  setAttribute(name, value) { this.attrs.set(name, String(value)) }

  getAttribute(name) { return this.attrs.get(name) ?? null }

  hasAttribute(name) { return this.attrs.has(name) }

  removeAttribute(name) { this.attrs.delete(name) }

  appendChild(node) {
    if (node.parentNode !== null) node.parentNode.removeChild(node)
    node.parentNode = this
    node.ownerDocument = this.ownerDocument
    // Nested nodes learn the document too, so isConnected resolves for them.
    for (const child of node.children) child.ownerDocument = this.ownerDocument
    this.childNodes.push(node)
    return node
  }

  removeChild(node) {
    this.childNodes = this.childNodes.filter((candidate) => candidate !== node)
    node.parentNode = null
    return node
  }

  remove() { this.parentNode?.removeChild(this) }

  addEventListener(type, listener) {
    const list = this.listeners.get(type) ?? []
    list.push(listener)
    this.listeners.set(type, list)
  }

  removeEventListener(type, listener) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((entry) => entry !== listener))
  }

  /** Test-side dispatch: walks up so a listener on an ancestor still fires. */
  dispatch(type, event = {}) {
    for (let node = this; node !== null; node = node.parentNode) {
      for (const listener of node.listeners.get(type) ?? []) {
        listener({ target: this, preventDefault() {}, stopPropagation() {}, ...event })
      }
    }
    return this
  }

  /** Attribute-presence selectors only — all the controller ever uses. */
  matches(selector) {
    const name = /^\[([^\]=]+)\]$/.exec(selector.trim())
    return name !== null && this.attrs.has(name[1])
  }

  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null }

  querySelectorAll(selector) {
    const found = []
    const walk = (node) => {
      for (const child of node.children) {
        if (child.matches(selector)) found.push(child)
        walk(child)
      }
    }
    walk(this)
    return found
  }

  closest(selector) {
    for (let node = this; node !== null; node = node.parentNode) {
      if (node.matches?.(selector)) return node
    }
    return null
  }
}

/** `data-dsh-boot` ⇄ `dshBoot`. */
function attributeName(datasetKey) {
  return `data-${String(datasetKey).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`
}

/** A `style` stand-in: the controller only uses custom properties and `animation`. */
function makeStyle() {
  const props = new Map()
  return {
    animation: '',
    setProperty(name, value) { props.set(name, String(value)) },
    getPropertyValue(name) { return props.get(name) ?? '' },
    removeProperty(name) { props.delete(name) },
  }
}

/** Parse a fragment of well-formed markup (no comments, no raw text nodes with `<`). */
function parseFragment(html, ownerDocument) {
  const root = new El('#fragment')
  root.ownerDocument = ownerDocument
  const stack = [root]
  const token = /<\/?([a-zA-Z][\w:-]*)((?:\s+[^\s"'>/=]+(?:="[^"]*")?)*)\s*(\/?)>|([^<]+)/g
  let match
  while ((match = token.exec(html)) !== null) {
    const [raw, tag, rawAttrs, selfClosing, text] = match
    if (text !== undefined) {
      const trimmed = text.trim()
      if (trimmed !== '') {
        const node = new El('#text')
        node.ownerDocument = ownerDocument
        node.ownText = trimmed
        stack.at(-1).appendChild(node)
      }
      continue
    }
    if (raw.startsWith('</')) {
      if (stack.length > 1) stack.pop()
      continue
    }
    const el = new El(tag)
    el.ownerDocument = ownerDocument
    for (const attr of rawAttrs.matchAll(/([^\s"'>/=]+)(?:="([^"]*)")?/g)) {
      el.attrs.set(attr[1], attr[2] ?? '')
    }
    stack.at(-1).appendChild(el)
    const void_ = selfClosing === '/' || ['path', 'br', 'img', 'input', 'link', 'meta'].includes(tag.toLowerCase())
    if (!void_) stack.push(el)
  }
  return root.children
}

/**
 * Build a document containing the real overlay markup plus a fake app mount
 * point: `#root > [data-dsh-boot]` while the kernel card is still up.
 * @param html - The `html` row from the injection table.
 * @returns handles the test drives the page with.
 */
export function createDom(html) {
  const documentElement = new El('html')
  const head = new El('head')
  const body = new El('body')
  documentElement.appendChild(head)
  documentElement.appendChild(body)

  const document = {
    documentElement,
    head,
    body,
    createElement: (tag) => {
      const el = new El(tag)
      el.ownerDocument = document
      return el
    },
    getElementById: (id) => {
      const walk = (node) => {
        for (const child of node.children) {
          if (child.attrs.get('id') === id) return child
          const found = walk(child)
          if (found !== null) return found
        }
        return null
      }
      return walk(documentElement)
    },
    querySelector: (selector) => documentElement.querySelector(selector),
    addEventListener: (type, listener) => body.addEventListener(type, listener),
    removeEventListener: (type, listener) => body.removeEventListener(type, listener),
  }
  documentElement.ownerDocument = document
  head.ownerDocument = document
  body.ownerDocument = document

  for (const node of parseFragment(html, document)) body.appendChild(node)

  const root = document.createElement('div')
  root.setAttribute('id', 'root')
  const boot = document.createElement('div')
  boot.setAttribute('data-dsh-boot', '')
  const spinner = document.createElement('div')
  spinner.setAttribute('data-dsh-boot-spinner', '')
  spinner.style.setProperty('--dsh-boot-arc', '72deg')
  boot.appendChild(spinner)
  root.appendChild(boot)
  body.appendChild(root)

  const observers = []
  return {
    document,
    root,
    boot,
    spinner,
    /** Simulate the kernel card leaving and React committing the app. */
    completeBoot() {
      boot.remove()
      const app = document.createElement('div')
      root.appendChild(app)
    },
    /** Fire every registered MutationObserver, as a real mutation would. */
    mutate() {
      for (const callback of observers) callback()
    },
    registerObserver: (callback) => { observers.push(callback) },
  }
}

/**
 * Install the harness on `globalThis` and execute an injection table the way
 * the page-side interpreter does.
 *
 * Order matters and is the point: the controller reads
 * `globalThis.__DSH_SPLASH_CONFIG__`, which arrives as a `global` row ahead of
 * it. Executing only the controller would silently test a disabled splash, so
 * the table is replayed row by row exactly as `applyIndexInjections` would.
 *
 * @param dom - Handle from {@link createDom} (`style` and `html` rows are
 *   already in its tree; they are DOM, not code).
 * @param table - The injection table from a real emit.
 */
export function runController(dom, table) {
  const saved = new Map()
  const install = (name, value) => {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
  }
  install('document', dom.document)
  install('navigator', { language: 'en-US' })
  install('MutationObserver', class {
    constructor(callback) { dom.registerObserver(callback) }
    observe() {}
    disconnect() {}
  })
  const frames = new Set()
  install('requestAnimationFrame', (callback) => {
    const handle = setTimeout(() => { frames.delete(handle); callback(Date.now()) }, 0)
    frames.add(handle)
    return handle
  })
  install('cancelAnimationFrame', (handle) => { frames.delete(handle); clearTimeout(handle) })

  const executed = []
  for (const row of table) {
    if (row.kind === 'global') {
      globalThis[row.name] = row.value
      executed.push(`global ${row.name}`)
    } else if (row.kind === 'script') {
      // The rows ship as source; evaluating them in order is the test.
      // eslint-disable-next-line no-new-func
      new Function(row.text)()
      executed.push(`script:${row.placement}`)
    }
  }

  return {
    executed,
    /** Frames still queued — a leaked paint loop shows up here. */
    pendingFrames: () => frames.size,
    restore() {
      // Drop any frame still queued, so nothing can fire against an uninstalled
      // global after the scenario ends.
      for (const handle of frames) clearTimeout(handle)
      frames.clear()
      for (const [name, descriptor] of saved) {
        if (descriptor === undefined) delete globalThis[name]
        else Object.defineProperty(globalThis, name, descriptor)
      }
    },
    facade: globalThis.__DSH_SPLASH__,
    stateAttribute: () => dom.document.documentElement.attrs.get('data-dsh-splash-state'),
  }
}

/** `setTimeout` as a promise, for stepping through the animation's real timers. */
export const after = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

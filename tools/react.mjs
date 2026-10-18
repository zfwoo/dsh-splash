/**
 * A minimal React: enough to render one settings page in Node and drive it.
 *
 * The hand-written client bundle cannot be imported as a module (it is a
 * classic script that calls `window.__ModuleLoader__.load`), and the page it
 * renders is where the typed-duration behaviour lives — parsing, clamping,
 * converting to the stored unit, reverting a rejected entry. Source assertions
 * cannot see any of that, and a real renderer would drag a dependency into a
 * plugin that must stay dependency-free.
 *
 * So this stands up only what the page uses: function components, `useState`
 * with a re-render loop, `useEffect` with shallow dependency comparison, and
 * `useCallback`. Hook slots are keyed by the component's path in the tree, which
 * is stable for a tree whose shape does not change between passes.
 */

/** Shallow dependency comparison, as `useEffect` defines it. */
function sameDeps(previous, next) {
  return previous.length === next.length && previous.every((value, index) => Object.is(value, next[index]))
}

/**
 * Build the mini renderer.
 * @returns `{ React, mount }` — hand `React` to the bundle's factory and `mount` the element.
 */
export function createReact() {
  const store = new Map()
  let dirty = false
  let pending = []
  let root = null
  let element = null

  const React = {
    createElement(type, props, ...children) {
      return { type, props: { ...(props ?? {}), children } }
    },
    useState(initial) {
      const slot = current.next()
      if (!('value' in slot)) slot.value = typeof initial === 'function' ? initial() : initial
      return [slot.value, (next) => {
        const value = typeof next === 'function' ? next(slot.value) : next
        if (Object.is(slot.value, value)) return
        slot.value = value
        dirty = true
      }]
    },
    useEffect(effect, deps) {
      const slot = current.next()
      if (slot.deps !== undefined && deps !== undefined && sameDeps(slot.deps, deps)) return
      slot.deps = deps
      pending.push(effect)
    },
    useCallback(fn, deps) {
      const slot = current.next()
      const key = deps ?? []
      if (slot.deps === undefined || !sameDeps(slot.deps, key)) {
        slot.fn = fn
        slot.deps = key
      }
      return slot.fn
    },
  }

  let current = null

  function renderNode(node, path) {
    if (node === null || node === undefined || typeof node === 'boolean') return null
    // Text children (and numbers) are leaves: they are not elements and have no
    // props to walk into.
    if (typeof node !== 'object') return node
    if (Array.isArray(node)) return node.map((child, index) => renderNode(child, `${path}.${String(index)}`))
    if (typeof node.type === 'function') {
      const slots = store.get(path) ?? []
      store.set(path, slots)
      let at = 0
      const previous = current
      current = { next: () => { const index = at++; while (slots.length <= index) slots.push({}); return slots[index] } }
      try {
        return renderNode(node.type({ ...node.props }), path)
      } finally {
        current = previous
      }
    }
    return {
      type: node.type,
      props: node.props,
      children: renderNode(node.props.children, `${path}.c`),
    }
  }

  function pass() {
    dirty = false
    pending = []
    root = renderNode(element, '0')
    const effects = pending
    pending = []
    for (const effect of effects) effect()
  }

  /** Render once, then keep rendering until nothing schedules another pass. */
  function settleSync() {
    let guard = 0
    do { pass() } while (dirty && guard++ < 25)
  }

  return {
    React,
    /**
     * Mount an element and settle it.
     * @param node - The element tree.
     * @returns the mount handle.
     */
    mount(node) {
      element = node
      settleSync()
      return {
        get tree() { return root },
        /** Run an interaction, then settle the renders it caused. */
        act(fn) { fn(); settleSync() },
        /** Same, for interactions that resolve a promise (a route write). */
        async actAsync(fn) {
          fn()
          await this.settle()
        },
        /** Let microtasks run and settle whatever they scheduled. */
        async settle() {
          for (let round = 0; round < 8; round += 1) {
            await new Promise((resolve) => { setImmediate(resolve) })
            settleSync()
          }
        },
      }
    },
  }
}

/**
 * Collect every host element of one tag from a rendered tree.
 * @param node - Rendered tree.
 * @param tag - Tag name to collect.
 * @returns the matching elements in document order.
 */
export function collect(node, tag) {
  const found = []
  const walk = (current) => {
    if (current === null || current === undefined) return
    if (Array.isArray(current)) {
      for (const child of current) walk(child)
      return
    }
    if (typeof current !== 'object') return
    if (current.type === tag) found.push(current)
    walk(current.children)
  }
  walk(node)
  return found
}

/** The concatenated text of a rendered subtree. */
export function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.children)
}

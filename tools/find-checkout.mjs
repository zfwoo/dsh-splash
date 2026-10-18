/**
 * Locate the DSH checkout this plugin was developed against.
 *
 * Two tools need it — `check-profile.mjs` to resolve profile bundles exactly the
 * way the Electron app does, and `extract-fish-path.mjs` to read the brand
 * source. Neither may ship a path from the machine it was written on, so the
 * checkout is discovered instead:
 *
 *   1. `DSH_CHECKOUT` when it points at a checkout;
 *   2. otherwise an ancestor of `startDir`, or an immediate child of one — the
 *      two layouts this plugin is developed in: **inside** a checkout
 *      (`<checkout>/…/local-plugins/<name>`) or **beside** one
 *      (`<parent>/<checkout>` next to `<parent>/work/local-plugins/<name>`).
 *
 * The probe is `apps/cli/package.json`, so the directory's name never matters.
 *
 * @param startDir - Absolute directory to search from, usually the tool's own.
 * @returns the checkout root, or undefined when there is none.
 */

import { existsSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/** Relative path proving a directory is a DSH checkout. */
export const CHECKOUT_ANCHOR = join('apps', 'cli', 'package.json')

/** How many ancestors to try before giving up. */
const MAX_DEPTH = 8

/**
 * Is this directory a checkout?
 * @param dir - Candidate.
 * @returns whether it holds the anchor.
 */
export function isCheckout(dir) {
  return existsSync(join(dir, CHECKOUT_ANCHOR))
}

/**
 * Search for the checkout.
 * @param startDir - Absolute directory to search from.
 * @returns the checkout root, or undefined.
 */
export function findCheckout(startDir) {
  const explicit = process.env.DSH_CHECKOUT?.trim()
  if (explicit !== undefined && explicit !== '') {
    const resolved = resolve(explicit)
    if (isCheckout(resolved)) return resolved
    process.stderr.write(`find-checkout: DSH_CHECKOUT=${explicit} is not a checkout; searching instead\n`)
  }
  let dir = resolve(startDir)
  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    if (isCheckout(dir)) return dir
    let children = []
    try {
      children = readdirSync(dir, { withFileTypes: true })
    } catch {
      children = []
    }
    const sibling = children.find((entry) => entry.isDirectory() && isCheckout(join(dir, entry.name)))
    if (sibling !== undefined) return join(dir, sibling.name)
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

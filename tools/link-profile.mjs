/**
 * Materialize this plugin's link inside a DSH profile.
 *
 * Why this exists: `pnpm` records a `link:` dependency in the profile's
 * lockfile and package.json, then reports success — `Already up to date`,
 * `+ @local/dsh-splash 1.0.0-local.1 <- D:\…` — while never actually creating
 * `node_modules/@local/dsh-splash`. Verified against pnpm 11.7.0 and 11.21.0
 * with `nodeLinker: hoisted`, a hoisted/isolated layout, a clean node_modules,
 * and a fresh scratch project: the scoped directory is created and left empty.
 * `resolveBundleDir` then throws "cannot resolve profile bundle", so the
 * profile refuses to boot.
 *
 * pnpm would create a directory junction here; this does exactly that, and
 * nothing else. Idempotent, and safe to re-run after any pnpm command.
 *
 * Usage:
 *   node tools/link-profile.mjs web
 *   node tools/link-profile.mjs desktop
 *   node tools/link-profile.mjs                        # both
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, unlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const pluginDir = resolve(join(here, '..'))

/** The package name the profiles depend on, taken from the manifest itself. */
const PACKAGE_NAME = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8')).name
const dshHome = process.env.DSH_HOME?.trim() !== undefined && process.env.DSH_HOME.trim() !== ''
  ? resolve(process.env.DSH_HOME.trim())
  : resolve(join(homedir(), '.dsh'))

const targets = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ['web', 'desktop']

let failures = 0
for (const profile of targets) {
  const profileDir = join(dshHome, 'profiles', profile)
  const manifestPath = join(profileDir, 'package.json')
  if (!existsSync(manifestPath)) {
    process.stderr.write(`link-profile: ${profile}: no profile at ${profileDir}\n`)
    failures += 1
    continue
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const declared = manifest.dependencies?.[PACKAGE_NAME]
  if (typeof declared !== 'string') {
    process.stderr.write(`link-profile: ${profile}: ${PACKAGE_NAME} is not a dependency; add it first\n`)
    failures += 1
    continue
  }
  const bundled = manifest.dsh?.profile?.bundles?.includes(PACKAGE_NAME) === true
  if (!bundled) {
    process.stderr.write(`link-profile: ${profile}: warning — ${PACKAGE_NAME} is not in dsh.profile.bundles, the profile will not load it\n`)
  }

  const link = join(profileDir, 'node_modules', ...PACKAGE_NAME.split('/'))
  mkdirSync(dirname(link), { recursive: true })
  let state = 'created'
  const existing = lstatOrUndefined(link)
  if (existing !== undefined) {
    if (!existing.isSymbolicLink()) {
      // Never delete a real directory here: this plugin's source is elsewhere,
      // so anything that is not a link was put here by something else.
      process.stderr.write(`link-profile: ${profile}: ${link} exists and is not a link; leaving it alone\n`)
      failures += 1
      continue
    }
    // Unlink the link itself. `rmSync(..., { recursive: true })` is deliberately
    // avoided: a junction must never be walked into, or this would delete the
    // plugin source it points at.
    unlinkSync(link)
    state = 'replaced'
  }
  symlinkSync(pluginDir, link, 'junction')

  // Resolve the way `resolveBundleDir` does: anchors first, then existence.
  const require = createRequire(manifestPath)
  const found = require.resolve(`${PACKAGE_NAME}/package.json`)
  process.stdout.write(`link-profile: ${profile}: ${state} ${link}\n  -> ${found}\n`)
}

/** lstat, tolerating a missing path (a dangling junction reports as absent to `existsSync`). */
function lstatOrUndefined(path) {
  try { return lstatSync(path) } catch { return undefined }
}

process.exitCode = failures === 0 ? 0 : 1

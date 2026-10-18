/**
 * Compose a DSH profile and prove this plugin's layer landed.
 *
 * The CLI refuses the desktop profile outright ("managed exclusively by the
 * Electron application"), so the profile cannot be checked with
 * `--dump-config`. This drives the same `loadProfileDirectory` the Electron app
 * uses instead: it resolves every bundle, loads each patch layer, and asserts
 * that this plugin's row is present, that the `hmr` root list still contains
 * every root it is supposed to, and that the client half is wired as a bundle
 * the module host will find.
 *
 * Usage:
 *   node tools/check-profile.mjs desktop
 *   node tools/check-profile.mjs web
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { CHECKOUT_ANCHOR, findCheckout } from './find-checkout.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const pluginDir = resolve(join(here, '..'))

/** The package name the profiles depend on, taken from the manifest itself. */
const PACKAGE_NAME = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8')).name
const ROW_ID = 'dsh-splash'

/**
 * The DSH checkout this profile's modules resolve against.
 *
 * A checkout is not part of this repository, so a missing one is a **skip, not a
 * failure**: `DSH_CHECKOUT` points at it explicitly, otherwise `find-checkout.mjs`
 * looks for one inside or beside this plugin.
 */
const HARNESS = findCheckout(here)
if (HARNESS === undefined) {
  process.stderr.write(
    'check-profile: skipped — no DSH checkout found.\n'
    + '  Set DSH_CHECKOUT to a deepseek-harness checkout to run this check.\n',
  )
  process.exit(0)
}
const INSTALL_ANCHOR = join(HARNESS, CHECKOUT_ANCHOR)

const profile = process.argv[2]
if (profile === undefined) {
  process.stderr.write('check-profile: pass a profile name (web | desktop)\n')
  process.exit(2)
}

const dshHome = process.env.DSH_HOME?.trim() !== undefined && process.env.DSH_HOME.trim() !== ''
  ? resolve(process.env.DSH_HOME.trim())
  : resolve(join(homedir(), '.dsh'))
const profileDir = join(dshHome, 'profiles', profile)
if (!existsSync(join(profileDir, 'package.json'))) {
  process.stderr.write(`check-profile: no profile at ${profileDir}\n`)
  process.exit(2)
}

const { loadProfileDirectory } = await import(new URL('file:///' + join(HARNESS, 'packages', 'boot', 'app-boot', 'lib', 'index.js').replaceAll('\\', '/')).href)

const loaded = loadProfileDirectory('dsh-splash-check', profileDir, INSTALL_ANCHOR)
const problems = []

const layer = loaded.layers.find((entry) => entry.packageName === PACKAGE_NAME)
if (layer === undefined) {
  problems.push(`${PACKAGE_NAME} is not among the profile's bundle layers: ${loaded.layers.map((l) => l.packageName).join(', ')}`)
} else {
  process.stdout.write(`layer: ${layer.packageName}\n  dir:   ${layer.packageDir}\n  patch: ${layer.patchPath}\n`)

  const manifest = JSON.parse(readFileSync(join(layer.packageDir, 'package.json'), 'utf8'))
  if (manifest.dsh?.bundle?.patch === undefined) problems.push('bundle declares no dsh.bundle.patch')
  if (manifest.dsh?.client?.platform !== 'web') problems.push('bundle declares no dsh.client with platform web')

  // The client half must exist where the export map points, or the module host
  // fails the whole boot with "client bundle not found".
  const clientEntry = join(layer.packageDir, manifest.exports?.['./client'] ?? '')
  if (!existsSync(clientEntry)) problems.push(`client bundle missing at ${clientEntry}`)

  const inserted = JSON.stringify(layer.patches).includes(`"${ROW_ID}"`)
  if (!inserted) problems.push(`this bundle's own rows do not mention the ${ROW_ID} row id`)

  // A bundle patch REPLACES the targeted row's whole config, so a patch that
  // re-declares `hmr` silently drops every root the profile had before. This
  // bundle ships that row commented out — a watch root only makes sense for the
  // directory you are developing in — so the assertion is conditional: if you
  // turn it on, it has to actually cover this plugin.
  const patchText = readFileSync(join(layer.packageDir, 'cordis.patch.yml'), 'utf8')
  const liveYaml = patchText.replace(/^[ \t]*#.*$/gm, '')
  const hmr = loaded.layers
    .flatMap((entry) => entry.patches ?? [])
    .flatMap((patch) => (Array.isArray(patch) ? patch : [patch]))
    .filter((entry) => entry?.id === 'hmr')
    .at(-1)
  const roots = hmr?.config?.root ?? []
  process.stdout.write(
    `hmr root (effective last write): ${roots.length === 0 ? '(none)' : ''}\n${roots.map((r) => `  - ${r}\n`).join('')}`,
  )
  if (/^\s*-?\s*id:\s*hmr\b/m.test(liveYaml) && !roots.some((root) => root.includes('dsh-splash'))) {
    problems.push('the patch declares an hmr row that does not include this plugin\'s directory')
  }
}

if (problems.length > 0) {
  process.stdout.write(`\ncheck-profile: ${profile}: FAILED\n${problems.map((p) => `  - ${p}\n`).join('')}`)
  process.exitCode = 1
} else {
  process.stdout.write(`\ncheck-profile: ${profile}: ok\n`)
}

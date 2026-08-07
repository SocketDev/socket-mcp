/*
 * @file Make the operator's password manager reachable inside the durable npm
 *   browser profile, without touching the launch shape.
 *
 *   The sanctioned launch (browser-session.mts) passes NO `args` array, which
 *   is what `--load-extension` would need, and that invariant is enforced by
 *   check/playwright-launches-are-sanctioned.mts and paid for in dated
 *   evidence: the two ignored Playwright defaults there are the difference
 *   between a live npmjs.com session and one the site drops mid-login.
 *
 *   A persistent Chrome profile loads the extensions it already has, so the
 *   supported path is to install into the durable profile ONCE. This module
 *   reports which of the three states the profile is in and hands back the
 *   install URL, so the caller can offer a single click instead of leaving an
 *   operator to hand-type a one-time password that a manager already holds.
 */

import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'

// Re-exported so the id set has ONE definition. browser-session.mts owns it
// because that is where the launch decision reads it; this module reports on
// the same ids rather than keeping a second copy that could drift.
export { ONE_PASSWORD_EXTENSION_IDS } from './browser-session.mts'

export type ExtensionState =
  // Installed in the durable profile: nothing to do, the manager autofills.
  | 'present'
  // Absent here but installed in the operator's own Chrome, so a one-click
  // install is a fair thing to offer.
  | 'installable'
  // Not installed anywhere on this machine — say nothing rather than pitch a
  // product the operator has not chosen.
  | 'absent'

/**
 * The `Extensions` directory inside every Chrome profile under `userDataDir`.
 * Chrome names profiles `Default`, `Profile 1`, `Profile 2`, and so on, so the
 * set is discovered rather than assumed. Pure apart from the directory read.
 */
export function chromeExtensionDirs(userDataDir: string): string[] {
  if (!existsSync(userDataDir)) {
    return []
  }
  const dirs: string[] = []
  for (const entry of readdirSync(userDataDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue
    }
    const candidate = path.join(userDataDir, entry.name, 'Extensions')
    if (existsSync(candidate)) {
      dirs.push(candidate)
    }
  }
  return dirs
}

/**
 * True when `extensionsDir` holds `id`. A profile that once had the extension
 * keeps an empty id directory after a removal, so an id with no version
 * subdirectory reads as absent rather than present.
 */
export function hasExtension(extensionsDir: string, id: string): boolean {
  const dir = path.join(extensionsDir, id)
  if (!existsSync(dir)) {
    return false
  }
  try {
    return readdirSync(dir).length > 0
  } catch {
    return false
  }
}

/**
 * Which of the three states the durable profile is in for `id`. Pure over the
 * two directory lists, so the decision is testable without a browser or a real
 * Chrome install.
 */
export function extensionState(config: {
  durableExtensionsDir: string
  id: string
  systemExtensionDirs: readonly string[]
}): ExtensionState {
  const cfg = { __proto__: null, ...config } as typeof config
  if (hasExtension(cfg.durableExtensionsDir, cfg.id)) {
    return 'present'
  }
  for (const dir of cfg.systemExtensionDirs) {
    if (hasExtension(dir, cfg.id)) {
      return 'installable'
    }
  }
  return 'absent'
}

/**
 * The Chrome Web Store page for `id`, which is where an install starts.
 */
export function extensionInstallUrl(id: string): string {
  return `https://chromewebstore.google.com/detail/${id}`
}

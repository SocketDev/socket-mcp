/**
 * @file Repo-owned path constants for socket-mcp's build outputs. Re-exports
 *   the fleet-canonical resolvers (REPO_ROOT, etc.) and adds the constants this
 *   repo's build needs. Mantra: 1 path, 1 reference — every build-output path
 *   is constructed once here; rolldown.config.mts and build.mts import the
 *   computed value.
 */

import path from 'node:path'

import { REPO_ROOT } from '../fleet/paths.mts'

export * from '../fleet/paths.mts'

/**
 * Absolute path to the build output directory for the published server bin.
 */
export const DIST_DIR = path.join(REPO_ROOT, 'dist')

/**
 * Absolute path to the bundled server entry (the `socket-mcp` bin).
 */
export const SERVER_BUNDLE = path.join(DIST_DIR, 'index.cjs')

/**
 * Absolute path to the socket-gate hook's SOURCE directory: the hook source
 * (`index.mts`) and its README. Dev/test content only — the published,
 * copyable unit is `SOCKET_GATE_DIST_DIR`.
 */
export const SOCKET_GATE_SRC_DIR = path.join(REPO_ROOT, 'hooks', 'socket-gate')

/**
 * Absolute path to the socket-gate hook's build-output directory. Holds the
 * bundled `socket-gate.cjs` plus a copy of the hook README, so the directory
 * is a self-contained unit: it ships in the npm package (`files:` lists
 * `dist/socket-gate`) and is what end users copy (recursively) into
 * `~/.claude/hooks/`.
 */
export const SOCKET_GATE_DIST_DIR = path.join(DIST_DIR, 'socket-gate')

/**
 * Absolute path to the bundled socket-gate hook.
 */
export const SOCKET_GATE_BUNDLE = path.join(
  SOCKET_GATE_DIST_DIR,
  'socket-gate.cjs',
)

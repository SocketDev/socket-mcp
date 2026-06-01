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
 * Absolute path to the socket-gate hook's directory. Holds the hook source
 * (`index.mts`), its README, and — after a build — the bundled `.cjs`. The
 * whole directory ships in the npm package and is what end users copy
 * (recursively) into `~/.claude/hooks/`.
 */
export const SOCKET_GATE_DIR = path.join(REPO_ROOT, 'hooks', 'socket-gate')

/**
 * Absolute path to the bundled socket-gate hook, emitted into its own directory
 * so the unit is self-contained and copyable.
 */
export const SOCKET_GATE_BUNDLE = path.join(SOCKET_GATE_DIR, 'socket-gate.cjs')

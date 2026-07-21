#!/usr/bin/env node
/**
 * @file `pnpm run test:fuzz` runner — the vitiate coverage-guided fuzz lane
 *   (Tier 2 of the property-and-fuzz-testing skill). Resolves the repo-root
 *   vitest binary directly (fleet `no-pm-exec-guard` bans `pnpm exec`) and runs
 *   `vitest run` with `VITIATE_FUZZ=1`, letting vitest AUTO-DISCOVER the
 *   repo-root `vitest.config.mts` (which loads the `vitiatePlugin`). We must
 *   NOT pass `--config`: vitiate's supervisor re-spawns a child `vitest run`
 *   for the coverage-guided pass without forwarding `--config`, so parent and
 *   child have to agree via auto-discovery on the same root config (see the
 *   header of vitest.config.mts). The `fuzz()` targets (`test/**\/*.fuzz.ts`)
 *   are then coverage-fuzzed with mutated inputs; without `VITIATE_FUZZ` they
 *   replay the committed seed corpus as fast regression checks. Budget via
 *   `FUZZ_TIME_MS` (default 15s; CI raises it). Exits with vitest's status —
 *   vitest reports a crash/hang as a failed test, which sidesteps the vitiate
 *   CLI exit-code nuances. Extra argv is forwarded (e.g. a single `*.fuzz.ts`
 *   path).
 */

import path from 'node:path'
import process from 'node:process'

import { spawnSync } from '@socketsecurity/lib-stable/process/spawn/child'
import type { SpawnSyncOptions } from '@socketsecurity/lib-stable/process/spawn/types'

const WIN32 = process.platform === 'win32'
// scripts/repo/fuzz.mts → repo root is two levels up.
const repoRoot = path.resolve(import.meta.dirname, '..', '..')
const VITEST_BIN = path.join(
  repoRoot,
  'node_modules',
  '.bin',
  WIN32 ? 'vitest.cmd' : 'vitest',
)

// oxlint-disable-next-line socket/prefer-async-spawn -- sync-required: top-level CLI runner, exits with the child's code
const result = spawnSync(
  VITEST_BIN,
  // No `--config`: vitest auto-discovers the repo-root vitest.config.mts, which
  // is the only config both this parent run and vitiate's re-spawned child agree
  // on (the child never receives --config). See vitest.config.mts header.
  ['run', ...process.argv.slice(2)],
  {
    __proto__: null,
    cwd: repoRoot,
    env: { __proto__: null, ...process.env, VITIATE_FUZZ: '1' },
    stdio: 'inherit',
  } as unknown as SpawnSyncOptions,
) as { status?: number | null | undefined }

process.exit(result.status ?? 1)

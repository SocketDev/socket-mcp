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

import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

import { WIN32 } from '@socketsecurity/lib-stable/constants/platform'
import { getDefaultLogger } from '@socketsecurity/lib-stable/logger/default'
import { spawnSync } from '@socketsecurity/lib-stable/process/spawn/child'
import type { SpawnSyncOptions } from '@socketsecurity/lib-stable/process/spawn/types'

import { isMainModule } from '../fleet/_shared/is-main-module.mts'

const logger = getDefaultLogger()

// scripts/repo/fuzz.mts → repo root is two levels up.
const repoRoot = path.resolve(import.meta.dirname, '..', '..')
const VITEST_BIN = path.join(
  repoRoot,
  'node_modules',
  '.bin',
  WIN32 ? 'vitest.cmd' : 'vitest',
)

/**
 * Parse `ipcs -ma` output into shm rows this sweep can judge. Exported for
 * unit tests. macOS columns: T ID KEY MODE OWNER GROUP CREATOR CGROUP NATTCH
 * SEGSZ CPID LPID …; Linux (util-linux) uses a different layout, but this
 * sweep only runs on darwin, where the leak occurs.
 */
export function parseShmRows(
  ipcsOutput: string,
): Array<{ cpid: number; nattch: number; owner: string; shmid: number }> {
  const rows: Array<{
    cpid: number
    nattch: number
    owner: string
    shmid: number
  }> = []
  const lines = ipcsOutput.split(/\r?\n/)
  for (let i = 0, { length } = lines; i < length; i += 1) {
    const line = lines[i]!
    const cols = line.trim().split(/\s+/u)
    // Data rows start with the type marker `m` (shared memory).
    if (cols[0] !== 'm' || cols.length < 11) {
      continue
    }
    const shmid = Number(cols[1])
    const nattch = Number(cols[8])
    const cpid = Number(cols[10])
    if (!Number.isInteger(shmid) || !Number.isInteger(nattch)) {
      continue
    }
    rows.push({ cpid, nattch, owner: cols[4] ?? '', shmid })
  }
  return rows
}

function pidIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false
  }
  try {
    // Signal 0 probes existence without sending anything.
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Sweep orphaned SysV shared-memory segments before the fuzz run. vitiate
 * 0.3.1 leaks one control segment per fuzz-target run on macOS (never
 * IPC_RMID'd); the default kern.sysv.shmmni=32 caps the table at ~32 runs,
 * after which every run dies with "shmem allocation failed … check OS limits
 * (shmall, shmmax)". A segment is an orphan only when it is OURS, has zero
 * attachments, and its creator PID is dead — live fuzz runs are untouched.
 */
export function sweepOrphanedShmSegments(): void {
  if (process.platform !== 'darwin') {
    return
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- null-proto options-bag idiom plus a narrowed result view of trusted ipcs output.
  const listing = spawnSync('ipcs', ['-ma'], {
    __proto__: null,
    stdio: ['ignore', 'pipe', 'ignore'],
    stdioString: true,
  } as unknown as SpawnSyncOptions) as {
    status?: number | null | undefined
    stdout?: string | undefined
  }
  if (listing.status !== 0 || typeof listing.stdout !== 'string') {
    return
  }
  const me = os.userInfo().username
  let swept = 0
  for (const row of parseShmRows(listing.stdout)) {
    if (row.owner !== me || row.nattch !== 0 || pidIsAlive(row.cpid)) {
      continue
    }
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- null-proto options-bag idiom: the double cast is required to pass a prototype-free literal as SpawnSyncOptions.
    const rm = spawnSync('ipcrm', ['-m', String(row.shmid)], {
      __proto__: null,
      stdio: 'ignore',
    } as unknown as SpawnSyncOptions) as { status?: number | null | undefined }
    if (rm.status === 0) {
      swept += 1
    }
  }
  if (swept > 0) {
    logger.log(
      `fuzz: swept ${swept} orphaned SysV shm segment(s) (vitiate 0.3.1 leaks one per run; macOS caps the table at kern.sysv.shmmni=32).`,
    )
  }
}

if (isMainModule(import.meta.url)) {
  sweepOrphanedShmSegments()

  // Sync-required: top-level CLI runner, exits with the child's code.
  // oxlint-disable-next-line socket/prefer-async-spawn -- sync CLI runner
  const result = spawnSync(
    VITEST_BIN,
    // No `--config`: vitest auto-discovers the repo-root vitest.config.mts, which
    // is the only config both this parent run and vitiate's re-spawned child agree
    // on (the child never receives --config). See vitest.config.mts header.
    ['run', ...process.argv.slice(2)],
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- null-proto options-bag idiom: `__proto__: null` keeps the options prototype-free but changes the literal's inferred type, so the double cast is required to pass it as SpawnSyncOptions.
    {
      __proto__: null,
      cwd: repoRoot,
      env: { __proto__: null, ...process.env, VITIATE_FUZZ: '1' },
      stdio: 'inherit',
    } as unknown as SpawnSyncOptions,
  ) as { status?: number | null | undefined }

  process.exit(result.status ?? 1)
}

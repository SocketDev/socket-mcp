/**
 * @file ROOT vitest config that exists ONLY for the vitiate coverage-guided
 *   fuzz lane (Tier 2 of the property-and-fuzz-testing skill). It is NOT the
 *   config `pnpm test` uses — `scripts/fleet/test.mts` passes `--config
 *   .config/repo/vitest.config.mts` explicitly whenever that file exists (it
 *   does here), so the normal suite never loads this file or the
 *   SWC-instrumenting `vitiatePlugin`. Why a ROOT config and not a custom-named
 *   one: vitiate's fuzz supervisor runs inside a vitest worker and re-spawns
 *   `vitest run <target>` for the coverage-guided child WITHOUT forwarding
 *   `--config` (its `getConfigFile()` is only populated in the main process,
 *   via the plugin's `configResolved`). The child therefore relies on vitest's
 *   config auto-discovery, which only finds a config at this repo-root name.
 *   Loading it re-runs the plugin's `config` hook in the child, which injects
 *   `@vitiate/core/setup` (initializes the shared-memory
 *   `globalThis.__vitiate_cov` map from the supervisor's `VITIATE_SHMEM` env)
 *   and the SWC instrument transform — without this file the child falls back
 *   to vitest defaults and dies with either "No test files found" or "coverage
 *   map not initialized". Run via `pnpm run test:fuzz` (scripts/repo/fuzz.mts),
 *   never `vitest` directly. In fuzzing mode (VITIATE_FUZZ=1, set by the
 *   runner) each `fuzz()` target (`test/**\/*.fuzz.ts`) is fed mutated Buffers;
 *   without it the targets replay the committed seed corpus as fast regression
 *   checks.
 */

import { defineConfig } from 'vitest/config'

import { vitiatePlugin } from '@vitiate/core/plugin'

// Non-`VITIATE_`-prefixed so vitiate's warnUnknownVitiateEnvVars() stays quiet;
// CI raises the budget by exporting FUZZ_TIME_MS before `pnpm run test:fuzz`.
const FUZZ_TIME_MS = Number(process.env['FUZZ_TIME_MS']) || 15_000

export default defineConfig({
  plugins: [
    vitiatePlugin({
      // Instrument this repo's OWN source — the fuzz targets import `lib/`
      // directly (there is no `src/` here); `packages` is only for
      // node_modules dependency instrumentation.
      instrument: { include: ['lib/**/*.ts'] },
      fuzz: {
        fuzzTimeMs: FUZZ_TIME_MS,
        stopOnCrash: true,
        detectors: { prototypePollution: true },
      },
    }),
  ],
  test: {
    include: ['test/**/*.fuzz.ts'],
  },
})

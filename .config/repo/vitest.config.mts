/**
 * @file Vitest configuration. Isolation: the fleet default is `isolate: true` —
 *   each test file gets a fresh module registry + globals, so cross-file
 *   leakage (process.env, path-rewire overrides, vi.mock state, nock
 *   interceptors) is impossible. Correctness by default. A repo that wants the
 *   faster shared-worker mode for a known-safe subset opts those files OUT by
 *   listing globs in a repo-owned `.config/repo/vitest-non-isolated.json` (`{
 *   "include": ["test/unit/pure/**"] }`). When that file exists, those globs
 *   run in a second, non-isolated project and the default isolated project
 *   excludes them. No file → everything isolated.
 */
import { existsSync, readFileSync } from 'node:fs'
import process from 'node:process'

import { envAsBoolean } from '@socketsecurity/lib-stable/env/boolean'
import { getCI } from '@socketsecurity/lib-stable/env/ci'
import { defineConfig } from 'vitest/config'

const isCoverageEnabled =
  envAsBoolean(process.env['COVERAGE']) ||
  process.argv.some(arg => arg.includes('coverage'))

// One repo-tunable vitest config, resolved fleet-default + repo-override (the
// same shape as .config/{fleet,repo}/git-authors.json):
//   nonIsolated     — globs safe to run in the faster non-isolated pool.
//   nodeTestExclude — extra node:test homes to exclude from vitest discovery
//                     (e.g. `tools/**/test/**` for a `node --test` tool corpus).
//                     prefer-vitest-guard reads the SAME key so its allowlist
//                     and this exclude never drift.
// Array values from both tiers are concatenated (a repo extends, never shrinks,
// the fleet defaults). Replaces the former vitest-non-isolated.json +
// vitest-extra-exclude.json sidecars.
export interface VitestRepoConfig {
  nonIsolated?: string[] | undefined
  nodeTestExclude?: string[] | undefined
}
export function readNonIsolatedGlobs(): string[] {
  return resolveVitestKey('nonIsolated')
}
export function readVitestConfigTier(file: string): VitestRepoConfig {
  if (!existsSync(file)) {
    return {}
  }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as VitestRepoConfig
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}
export function repoNodeTestExcludeGlobs(): string[] {
  return resolveVitestKey('nodeTestExclude')
}
export function resolveVitestKey(key: keyof VitestRepoConfig): string[] {
  const fleet = readVitestConfigTier('.config/fleet/vitest.json')[key]
  const repo = readVitestConfigTier('.config/repo/vitest.json')[key]
  return [
    ...(Array.isArray(fleet) ? fleet : []),
    ...(Array.isArray(repo) ? repo : []),
  ].filter(g => typeof g === 'string')
}
const nonIsolatedGlobs = readNonIsolatedGlobs()

export default defineConfig({
  test: {
    deps: {
      interopDefault: false,
    },
    globals: false,
    environment: 'node',
    // Test setup lives under test/scripts/{fleet,repo}/setup.mts — fleet-canonical
    // setup (nock fail-closed, env scrubbing) in fleet/, repo-specific setup in
    // repo/. Both are optional: vitest skips a setupFile that doesn't exist via
    // the existsSync filter so scaffolding-only repos don't error.
    setupFiles: [
      'test/scripts/fleet/setup.mts',
      'test/scripts/repo/setup.mts',
    ].filter(p => existsSync(p)),
    include: ['test/**/*.test.{js,ts,mjs,mts,cjs}'],
    // Vitest treats `test/**` as `**/test/**`, so without an explicit
    // exclude it picks up every nested `test/` directory in the repo
    // — including the `.git-hooks/test/`, the oxlint plugin's per-rule
    // `.config/oxlint-plugin/fleet/<id>/test/` suites,
    // and `scripts/**/test/` suites that run under `node --test`, not
    // vitest. Those tests use `import { test } from 'node:test'` and
    // produce zero vitest suites, which vitest reports as failures.
    // List the known node:test homes here so vitest skips them cleanly
    // (their own `node --test` runners pick them up separately).
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      // Vendored upstream submodules (and their test/fixtures) often
      // `import … from './foo.wasm'`; vite's default loader can't
      // transform those, so a module-graph walk (e.g. `vitest related`)
      // that reaches them fails with "ESM integration proposal for Wasm".
      // Keep discovery out of vendored trees entirely.
      '**/upstream/**',
      '**/test/fixtures/**',
      '**/.{idea,git,cache,output,temp}/**',
      '.git-hooks/**',
      '.config/oxlint-plugin/**',
      'scripts/**/test/**',
      '.claude/hooks/**/test/**',
      'template/**',
      // Repo-tunable node:test homes (e.g. `tools/**/test/**`) from the
      // `nodeTestExclude` key of .config/{fleet,repo}/vitest.json. The same key
      // feeds prefer-vitest-guard's allowlist so the two never drift.
      ...repoNodeTestExcludeGlobs(),
    ],
    // Some repos in the fleet (scaffolding-only, hook-only, etc.) ship
    // this config but don't yet have a `test/` directory — vitest's
    // default behavior would fail "no tests found" there. Repos that
    // do have tests still error on actual test failures; this flag
    // only affects the empty-suite case.
    passWithNoTests: true,
    reporters: ['default'],
    pool: 'threads',
    // Vitest 4 removed `poolOptions`; the per-pool worker knobs are now
    // top-level. `maxThreads`/`maxForks` → `maxWorkers`; `singleThread`/
    // `singleFork` → `fileParallelism: false` (forces maxWorkers to 1);
    // `minThreads` and `useAtomics` were dropped with no replacement.
    // Worker count tuned to physical CPUs: GH Actions ubuntu-latest has
    // 4 cores, dev laptops typically 8-16. `getCI()` (rewire-aware
    // presence check on `CI`) is truthy even for CI="" or CI=0, matching
    // the fleet convention that any CI value means CI.
    //
    // Isolation: true by default (correctness — no cross-file state leak). A
    // repo lists safe-to-share globs in .config/repo/vitest-non-isolated.json;
    // when present, this default project EXCLUDES them (the second project runs
    // them non-isolated). When absent, every file is isolated.
    isolate: true,
    ...(nonIsolatedGlobs.length
      ? {
          projects: [
            {
              extends: true,
              test: {
                name: 'isolated',
                isolate: true,
                exclude: nonIsolatedGlobs,
              },
            },
            {
              extends: true,
              test: {
                name: 'non-isolated',
                isolate: false,
                include: nonIsolatedGlobs,
              },
            },
          ],
        }
      : {}),
    fileParallelism: !isCoverageEnabled,
    maxWorkers: isCoverageEnabled ? 1 : getCI() ? 4 : 16,
    testTimeout: 10_000,
    hookTimeout: 10_000,
    bail: getCI() ? 1 : 0,
    coverage: {
      enabled: isCoverageEnabled,
      provider: 'v8',
      reporter: ['text', 'json', 'json-summary', 'html', 'lcov', 'clover'],
      exclude: [
        '**/*.config.*',
        '**/node_modules/**',
        '**/[.]**',
        '**/*.d.ts',
        '**/virtual:*',
        'coverage/**',
        'dist/**',
        'scripts/**',
        'test/**',
      ],
      all: true,
      clean: true,
      skipFull: false,
    },
  },
})

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

// Repo opt-out: globs that are safe to run in the faster non-isolated pool.
const NON_ISOLATED_CONFIG = '.config/repo/vitest-non-isolated.json'
function readNonIsolatedGlobs(): string[] {
  if (!existsSync(NON_ISOLATED_CONFIG)) {
    return []
  }
  try {
    const parsed = JSON.parse(readFileSync(NON_ISOLATED_CONFIG, 'utf8')) as {
      include?: string[] | undefined
    }
    return Array.isArray(parsed.include) ? parsed.include : []
  } catch {
    return []
  }
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
    // — including the `.git-hooks/test/`, `.config/fleet/oxlint-plugin/test/`,
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
      '.config/fleet/oxlint-plugin/test/**',
      'scripts/**/test/**',
      '.claude/hooks/**/test/**',
      'template/**',
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
      reporter: ['text', 'json', 'html', 'lcov', 'clover'],
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

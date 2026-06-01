/**
 * @file Vitest configuration.
 */
import { existsSync } from 'node:fs'
import process from 'node:process'

import { defineConfig } from 'vitest/config'

const isCoverageEnabled =
  process.env.COVERAGE === 'true' ||
  process.argv.some(arg => arg.includes('coverage'))

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
    poolOptions: {
      threads: {
        // Thread count tuned to physical CPUs. GH Actions ubuntu-latest
        // has 4 cores; dev laptops typically have 8-16. Use
        // `'CI' in process.env` (not truthy `process.env.CI`) so
        // self-hosted runners with CI="" or CI=0 still count.
        singleThread: isCoverageEnabled,
        maxThreads: isCoverageEnabled ? 1 : 'CI' in process.env ? 4 : 16,
        minThreads: isCoverageEnabled ? 1 : 'CI' in process.env ? 2 : 4,
        isolate: false,
        useAtomics: true,
      },
    },
    testTimeout: 10_000,
    hookTimeout: 10_000,
    bail: 'CI' in process.env ? 1 : 0,
    coverage: {
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

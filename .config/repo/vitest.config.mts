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

import { GENERATED_GLOBS } from '../../scripts/fleet/constants/generated-globs.mts'
import { resolveCoverageConfig } from '../fleet/vitest.coverage.fleet.config.mts'

// Coverage is on when the COVERAGE env is set (cover.mts) or the `--coverage`
// flag is passed. Match the FLAG, not any argv containing the substring
// "coverage" — a nested test run whose file-path args happen to include
// "coverage" must not silently turn coverage on and clean the shared
// coverage/.tmp (see test.mts resolveVitestEnv).
const isCoverageEnabled =
  envAsBoolean(process.env['COVERAGE']) ||
  process.argv.some(arg => arg.startsWith('--coverage'))

// One repo-tunable vitest config, resolved fleet-default + repo-override (the
// same shape as .config/{fleet,repo}/git-authors.json):
//   nonIsolated        — globs safe to run in the faster non-isolated pool.
//   nodeTestExclude    — extra node:test homes to exclude from vitest discovery
//                        (e.g. `tools/**/test/**` for a `node --test` tool corpus).
//                        prefer-vitest-guard reads the SAME key so its allowlist
//                        and this exclude never drift.
// Array values from both tiers are concatenated (a repo extends, never shrinks,
// the fleet defaults). Replaces the former vitest-non-isolated.json +
// vitest-extra-exclude.json sidecars.
export interface VitestRepoConfig {
  maxWorkers?: number | undefined
  nonIsolated?: string[] | undefined
  nodeTestExclude?: string[] | undefined
  pool?: 'forks' | 'threads' | undefined
}
/**
 * Heavy external-suite / cross-impl conformance wrapper globs from the
 * `vitest.conformanceExclude` section of the ONE per-repo settings file
 * (.config/socket-wheelhouse.json, or the root .socket-wheelhouse.json
 * alternative — see scripts/fleet/socket-wheelhouse-schema.mts). Excluded from
 * the DEFAULT (unit) + cover suites so the unit pass stays inside the fleet's
 * under-a-minute budget. A repo setting this MUST pair it with an explicit
 * `test:conformance` runner so the tier never silently drops.
 */
export function readConformanceExcludeGlobs(): string[] {
  for (const file of [
    '.config/socket-wheelhouse.json',
    '.socket-wheelhouse.json',
  ]) {
    if (!existsSync(file)) {
      continue
    }
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
        vitest?: { conformanceExclude?: string[] | undefined } | undefined
      }
      const globs = parsed?.vitest?.conformanceExclude
      return Array.isArray(globs)
        ? globs.filter(g => typeof g === 'string')
        : []
    } catch {
      return []
    }
  }
  return []
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
export function resolveMaxWorkers(): number | undefined {
  const fleet = readVitestConfigTier('.config/fleet/vitest.json').maxWorkers
  const repo = readVitestConfigTier('.config/repo/vitest.json').maxWorkers
  const candidates = [fleet, repo].filter(
    (v): v is number => typeof v === 'number' && v > 0,
  )
  return candidates.length > 0 ? Math.min(...candidates) : undefined
}
export function resolvePool(): 'forks' | 'threads' {
  const fleet = readVitestConfigTier('.config/fleet/vitest.json').pool
  const repo = readVitestConfigTier('.config/repo/vitest.json').pool
  const chosen = repo ?? fleet
  return chosen === 'forks' || chosen === 'threads' ? chosen : 'threads'
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
    server: {
      deps: {
        // Treat @socketsecurity/lib-stable as external — bypass vite's
        // transform pipeline so Node resolves it natively (CJS default
        // condition). Without this, vite's `development` condition resolves
        // lib-stable via its `source` exports field (TypeScript source), and
        // the TS source files reference `./external/semver` sub-paths that are
        // not listed in the lib-stable exports map, producing an unhandled
        // EnvironmentPluginContainer.resolveId error that kills the test run.
        external: [/node_modules\/@socketsecurity\/lib-stable/],
      },
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
    include: [
      // `**/`-anchored so a monorepo's nested `packages/<name>/test/**` trees
      // are discovered from this one root config, same as GENERATED_GLOBS
      // below — no per-package vitest config or test script needed. A bare
      // `test/**/*.test...` (no leading `**/`) only anchors at the repo root,
      // silently missing every sub-package's tests (each `vitest run <file>`
      // scoped to a nested package returns "No test files found", and a
      // full-suite run "passes" having executed zero of them).
      '**/test/**/*.test.{js,ts,mjs,mts,cjs}',
      // In-place canonical-test mode: also discover the template copies so
      // `pnpm test template/base/…` (which sets FLEET_TEST_TEMPLATE=1) can run
      // one before the cascade. The matching exclude of `template/**` is lifted
      // under the same flag; a normal run keeps both, so template never runs
      // twice in the full suite.
      ...(process.env['FLEET_TEST_TEMPLATE'] === '1'
        ? ['template/base/test/**/*.test.{js,ts,mjs,mts,cjs}']
        : []),
    ],
    // Vitest treats `test/**` as `**/test/**`, so without an explicit
    // exclude it picks up every nested `test/` directory in the repo
    // — including the `.git-hooks/test/`, the oxlint plugin's per-rule
    // `.config/fleet/oxlint-plugin/fleet/<id>/test/` suites,
    // and `scripts/**/test/` suites that run under `node --test`, not
    // vitest. Those tests use `import { test } from 'node:test'` and
    // produce zero vitest suites, which vitest reports as failures.
    // List the known node:test homes here so vitest skips them cleanly
    // (their own `node --test` runners pick them up separately).
    exclude: [
      '**/node_modules/**',
      // Generated/vendored trees (dist, build, upstream, test/fixtures, …) —
      // shared with lint + format from one source (constants/generated-globs.mts)
      // so the ignore surfaces can't drift. vite's default loader can't
      // transform many of these (a module-graph walk into a vendored tree or a
      // wasm blob fails "ESM integration proposal for Wasm"), so discovery AND
      // `vitest related` must skip them; scripts/fleet/test.mts filters the same
      // set from the staged pre-commit run.
      ...GENERATED_GLOBS,
      '**/.{idea,git,cache,output,temp}/**',
      '.git-hooks/**',
      '.config/fleet/oxlint-plugin/**',
      'scripts/**/test/**',
      '.claude/hooks/**/test/**',
      // `template/**` holds the CANONICAL copies; the cascaded LIVE copies are
      // what the suite runs, so template is excluded to avoid double-running
      // byte-identical files. `pnpm test template/base/…` sets
      // FLEET_TEST_TEMPLATE=1 to lift this one exclude and verify a canonical
      // test IN PLACE before the cascade — the blessed fast path
      // (scripts/fleet/test.mts). A full/scoped run never sets the flag.
      ...(process.env['FLEET_TEST_TEMPLATE'] === '1' ? [] : ['template/**']),
      // `test/isolated/**` is the isolated SUITE's turf — its own forks / longer
      // -timeout config (`vitest.config.isolated.mts`), run as a separate suite
      // by cover.mts. Exclude it from this shared suite ONLY when the repo ships
      // that config, so a repo without the isolated suite still runs any
      // `test/isolated` files here instead of silently dropping them. This is the
      // isolated DIRECTORY tier — distinct from the `isolate:` state-isolation
      // split (the `nonIsolated` projects) further down.
      ...(existsSync('.config/repo/vitest.config.isolated.mts')
        ? ['test/isolated/**']
        : []),
      // Repo-tunable node:test homes (e.g. `tools/**/test/**`) from the
      // `nodeTestExclude` key of .config/{fleet,repo}/vitest.json. The same key
      // feeds prefer-vitest-guard's allowlist so the two never drift.
      ...repoNodeTestExcludeGlobs(),
      // Heavy conformance/cross-impl wrapper globs from the settings file's
      // `vitest.conformanceExclude` section — kept out of the default (unit)
      // + cover suites so the unit pass stays inside the fleet's
      // under-a-minute budget. The repo's `test:conformance` script is the
      // explicit home that runs them.
      ...readConformanceExcludeGlobs(),
    ],
    // Some repos in the fleet (scaffolding-only, hook-only, etc.) ship
    // this config but don't yet have a `test/` directory — vitest's
    // default behavior would fail "no tests found" there. Repos that
    // do have tests still error on actual test failures; this flag
    // only affects the empty-suite case.
    passWithNoTests: true,
    // Reporters left unset so vitest applies its own default:
    // `[isAgent ? 'minimal' : 'default', ...(GITHUB_ACTIONS ? ['github-actions'] : [])]`
    // (vitest/src/defaults.ts). That yields the token-lean `minimal` reporter
    // inside an AI coding agent (std-env `isAgent`: CLAUDECODE/CURSOR_/…),
    // `default` for humans, and the `github-actions` annotations reporter in CI.
    // Hard-coding `reporters: ['default']` would override that default and
    // defeat all three. https://vitest.dev/guide/reporters
    pool: resolvePool(),
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
    // Coverage forces serial (maxWorkers: 1). Parallel is ~2.5x faster (~236s
    // vs the 600s cap) but currently ENOENTs coverage/.tmp/coverage-N.json — a
    // nested vitest still cleans the shared coverage dir mid-run. Confirmed NOT
    // a stale-node artifact (repro'd clean under the pinned 26.5.0), and NOT
    // closed by the test.mts COVERAGE strip or the flag-precise isCoverageEnabled
    // above. Serial hides it (the outer writes .tmp only at the end). Keep serial
    // until the leaking spawner is bisected — serial-slow beats parallel-broken.
    fileParallelism: !isCoverageEnabled,
    maxWorkers: isCoverageEnabled
      ? 1
      : (resolveMaxWorkers() ?? (getCI() ? 4 : 16)),
    testTimeout: 10_000,
    hookTimeout: 10_000,
    bail: getCI() ? 1 : 0,
    // Coverage shape comes from the fleet base merged with the repo-owned
    // `.config/repo/coverage.json` overlay (include replace, exclude
    // add/remove) — one canonical exclude list instead of a drifted copy here.
    coverage: {
      enabled: isCoverageEnabled,
      ...resolveCoverageConfig(),
    },
  },
})

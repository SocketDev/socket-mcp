#!/usr/bin/env node
/**
 * @file Coverage runner — builds with source maps, runs vitest with coverage,
 *   masks test output, and prints a coverage summary. Runs the main suite and,
 *   when the repo ships one, an isolated suite (forks, full isolation for tests
 *   that mock globals / chdir / mutate process.env); the two coverage reports
 *   are merged with a max-hit-count strategy. Byte-identical across every fleet
 *   repo (sync-scaffolding flags drift). Config discovery is repo-first:
 *   `.config/repo/vitest.config.mts` then legacy `.config/vitest.config.mts`;
 *   the isolated suite runs only when `.config/repo/vitest.config.isolated.mts`
 *   (or the legacy `.config/` location) exists. Options: --code-only run only
 *   code coverage (skip type coverage); --type-only run only type coverage;
 *   --summary hide the detailed v8 table, show only the summary.
 */

import { existsSync, readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import process from 'node:process'

import { stripAnsi } from '@socketsecurity/lib-stable/ansi/strip'
import { parseArgs } from '@socketsecurity/lib-stable/argv/parse'
import { errorMessage } from '@socketsecurity/lib-stable/errors/message'
import { getDefaultLogger } from '@socketsecurity/lib-stable/logger/default'
import { spawn } from '@socketsecurity/lib-stable/process/spawn/child'

import {
  registerActiveRun,
  unregisterActiveRun,
} from './_shared/active-run-marker.mts'
import { printHeader } from '@socketsecurity/lib-stable/stdio/header'

import type { AggregateCoverage } from './util/coverage-merge.mts'
import {
  MissingTierCoverageError,
  mergeCoverageFinal,
} from './util/coverage-merge.mts'
import type { CoverThresholds, ResolvedSuite } from './cover/discovery.mts'
import {
  readCoverConfig,
  resolveBuildEntry,
  resolveSuites,
} from './cover/discovery.mts'
import { ensurePinnedNode } from './lib/ensure-node.mts'
import { REPO_ROOT } from './paths.mts'

const rootPath = REPO_ROOT

const logger = getDefaultLogger()

export interface SuiteResult {
  exitCode: number
  stdout: string
  stderr: string
}

export interface TestSuitesResult {
  combined: SuiteResult
  isolatedResult: SuiteResult | undefined
  mainResult: SuiteResult
}

// Compare merged aggregate coverage against configured thresholds. Returns the
// list of metrics that fell short (empty when all pass or no thresholds set).
export function checkThresholds(
  aggregate: AggregateCoverage | undefined,
  thresholds: CoverThresholds | undefined,
): string[] {
  if (!thresholds) {
    return []
  }
  // Fail CLOSED: thresholds are configured, so a missing aggregate (e.g. a
  // tier clobbered coverage/coverage-final.json before the merge read it)
  // must fail the gate — returning "no failures" here shipped a false-green
  // run that reported success below its configured minimums.
  if (!aggregate) {
    return [
      'aggregate coverage unavailable (coverage-final.json missing or empty) — cannot verify thresholds',
    ]
  }
  const failures: string[] = []
  const metrics: ReadonlyArray<keyof CoverThresholds> = [
    'statements',
    'branches',
    'functions',
    'lines',
  ]
  for (let i = 0, { length } = metrics; i < length; i += 1) {
    const metric = metrics[i]!
    const min = thresholds[metric]
    if (min === undefined) {
      continue
    }
    const actual = Number.parseFloat(aggregate[metric])
    if (actual < min) {
      failures.push(`${metric} ${actual.toFixed(2)}% < ${min}%`)
    }
  }
  return failures
}

// Strip ANSI codes and decorative characters (✧, ︎ variation selector, ⚡) from
// text. Uses the canonical lib-stable stripAnsi so there's one ANSI definition
// fleet-wide (the test helper at test/_shared/fleet/lib/output.mts wraps the
// same).
export function cleanOutput(text: string): string {
  return stripAnsi(text)
    .replace(/(?:⚡|✧|︎)\s*/g, '')
    .trim()
}

// Run a command quietly, capturing stdout/stderr and never throwing — a
// non-zero exit becomes an exitCode in the returned result so callers can still
// parse coverage output. Replaces the old repo-local run-command helper with a
// direct lib-stable spawn so the runner is self-contained and cascade-portable.
export async function runQuiet(
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv | undefined },
): Promise<SuiteResult> {
  options = { __proto__: null, ...options } as typeof options
  try {
    const result = await spawn('pnpm', args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
    })
    return {
      exitCode: result.code ?? 0,
      stdout: String(result.stdout ?? ''),
      stderr: String(result.stderr ?? ''),
    }
  } catch (e) {
    const err = e as Record<string, unknown>
    return {
      exitCode: 1,
      stdout: (err['stdout'] as string) || '',
      stderr: (err['stderr'] as string) || (err['message'] as string) || '',
    }
  }
}

// Fleet default wall-clock budget for the unit suites: under a minute
// (operator directive 2026-07-10). Repos tune via `vitest.unitBudgetMs` in
// .config/socket-wheelhouse.json.
const DEFAULT_UNIT_BUDGET_MS = 60_000

/**
 * The unit-suite wall-clock budget from the per-repo settings file
 * (`vitest.unitBudgetMs`), falling back to the fleet default. Fail-open: a
 * missing or torn settings file yields the default.
 */
export function resolveUnitBudgetMs(): number {
  for (const file of [
    '.config/socket-wheelhouse.json',
    '.socket-wheelhouse.json',
  ]) {
    if (!existsSync(file)) {
      continue
    }
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
        vitest?: { unitBudgetMs?: number | undefined } | undefined
      }
      const ms = parsed?.vitest?.unitBudgetMs
      return typeof ms === 'number' && ms >= 1000 ? ms : DEFAULT_UNIT_BUDGET_MS
    } catch {
      return DEFAULT_UNIT_BUDGET_MS
    }
  }
  return DEFAULT_UNIT_BUDGET_MS
}

/**
 * Loud report-only budget warning (What / Where / Saw vs wanted / Fix). Stays
 * a warning until the fleet conforms, then ratchets to a hard failure.
 */
export function warnIfOverBudget(suiteMs: number, budgetMs: number): boolean {
  if (suiteMs <= budgetMs) {
    return false
  }
  logger.warn(
    `[cover] unit suites exceeded the wall-clock budget: ${(suiteMs / 1000).toFixed(1)}s > ${(budgetMs / 1000).toFixed(0)}s.`,
  )
  logger.warn(
    '  Fleet rule: unit tests conclude in under a minute. Move heavy external-suite /',
  )
  logger.warn(
    '  cross-impl / built-artifact tests to the conformance tier: list their globs under',
  )
  logger.warn(
    '  `vitest.conformanceExclude` in .config/socket-wheelhouse.json and pair them with a',
  )
  logger.warn(
    '  `test:conformance` runner script. Tune the budget via `vitest.unitBudgetMs`.',
  )
  return true
}

export function parseTypeCoveragePercent(output: string): number | undefined {
  // Extracts a floating-point percentage from type-coverage output.
  // \( ... \)  — literal parens wrapping the fraction, e.g. "(123 / 456)"
  // [\d\s/]+   — digits, spaces, and "/" inside the parens
  // \s+        — whitespace separator between fraction and percentage
  // ([\d.]+)%  — capture group 1: the percentage digits before the "%" sign
  const match = output.match(/\([\d\s/]+\)\s+([\d.]+)%/)
  return match?.[1] ? Number.parseFloat(match[1]) : undefined
}

// Explain a failing suite: vitest prints its per-config coverage-threshold
// misses (e.g. "ERROR: Coverage for branches (46.92%) does not meet global
// threshold (49%)") to the suite's own output, which the summary display
// filters out — a bare "Coverage failed" strands the operator without the
// failing metric. Returns the error-ish lines from the suite output (deduped,
// capped), falling back to the output tail; empty for a passing suite.
export function extractSuiteFailureLines(
  name: string,
  result: SuiteResult,
): string[] {
  if (result.exitCode === 0) {
    return []
  }
  const maxLines = 12
  const lines = cleanOutput(result.stdout + result.stderr)
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
  const errorLines = [
    ...new Set(
      lines.filter(line =>
        // `ERROR` keyword; vitest coverage threshold message ("does not meet"
        // / "threshold"); vitest final summary line ("Tests N failed").
        /\bERROR\b|does not meet|threshold|Tests\s+\d+\s+failed/i.test(line),
      ),
    ),
  ]
  const detail = (errorLines.length > 0 ? errorLines : lines.slice(-maxLines))
    .slice(0, maxLines)
    .map(line => `  ${line}`)
  return [`${name} suite failed (exit ${result.exitCode}):`, ...detail]
}

// Run the main suite and, when isolatedArgs is provided, the isolated suite.
// Returns individual results plus a combined view; isolatedResult is undefined
// when the repo ships no isolated suite.
export async function runTestSuites(
  mainArgs: string[],
  isolatedArgs: string[] | undefined,
): Promise<TestSuitesResult> {
  const run = (args: string[]): Promise<SuiteResult> =>
    runQuiet(args, {
      cwd: rootPath,
      env: { ...process.env, COVERAGE: 'true' },
    })

  const mainResult = await run(mainArgs)
  const isolatedResult = isolatedArgs ? await run(isolatedArgs) : undefined

  const exitCode =
    mainResult.exitCode !== 0
      ? mainResult.exitCode
      : (isolatedResult?.exitCode ?? 0)

  const combined: SuiteResult = {
    exitCode,
    stderr: mainResult.stderr + (isolatedResult?.stderr ?? ''),
    stdout: mainResult.stdout + (isolatedResult?.stdout ?? ''),
  }

  return { combined, isolatedResult, mainResult }
}

// Print the test summary, optional v8 detail table, and the coverage summary.
export function displayCodeCoverage(
  mainOutput: string,
  combinedOutput: string,
  aggregateCoverage: AggregateCoverage | undefined,
  {
    showDetail,
    typeCoveragePercent,
  }: { showDetail: boolean; typeCoveragePercent: number | undefined },
): void {
  if (showDetail) {
    const testSummaryMatch = combinedOutput.match(
      /Test Files\s+\d+[^\n]*\n[\s\S]*?Duration\s+[\d.]+m?s[^\n]*/,
    )
    if (testSummaryMatch) {
      logger.log('')
      logger.log(testSummaryMatch[0])
      logger.log('')
    }

    const coverageHeaderMatch = mainOutput.match(
      // Matches the v8 coverage table header block in full.
      // " % Coverage report from v8\n"  — literal heading line
      // ([-|]+)                          — capture group 1: separator row of dashes and pipes
      // \n([^\n]+)\n                     — capture group 2: the column-name row between separators
      // \1                               — backreference: the same separator row repeated below headers
      / % Coverage report from v8\n([-|]+)\n([^\n]+)\n\1/,
    )
    const allFilesMatch = mainOutput.match(
      /All files\s+\|\s+([\d.]+)\s+\|[^\n]*/,
    )
    if (coverageHeaderMatch && allFilesMatch) {
      logger.log(' % Coverage report from v8')
      logger.log(coverageHeaderMatch[1])
      logger.log(coverageHeaderMatch[2])
      logger.log(coverageHeaderMatch[1])
      logger.log(allFilesMatch[0])
      logger.log(coverageHeaderMatch[1])
      logger.log('')
    }
  }

  const codeCoveragePercent = aggregateCoverage
    ? Number.parseFloat(aggregateCoverage.statements)
    : (() => {
        const m = mainOutput.match(/All files\s+\|\s+([\d.]+)\s+\|/)
        return m?.[1] ? Number.parseFloat(m[1]) : 0
      })()

  logger.log(' Coverage Summary')
  logger.log(' ───────────────────────────────')

  if (typeCoveragePercent !== undefined) {
    logger.log(` Type Coverage: ${typeCoveragePercent.toFixed(2)}%`)
  }
  logger.log(` Code Coverage: ${codeCoveragePercent.toFixed(2)}%`)

  if (aggregateCoverage) {
    logger.log('')
    logger.log(' Aggregate Code Coverage (Main + Isolated):')
    logger.log(
      `   Statements: ${aggregateCoverage.statements}% | Branches: ${aggregateCoverage.branches}%`,
    )
    logger.log(
      `   Functions:  ${aggregateCoverage.functions}% | Lines:    ${aggregateCoverage.lines}%`,
    )
  }

  if (typeCoveragePercent !== undefined) {
    const cumulativePercent = (
      (codeCoveragePercent + typeCoveragePercent) /
      2
    ).toFixed(2)
    logger.log(' ───────────────────────────────')
    logger.log(` Cumulative:    ${cumulativePercent}%`)
  }

  logger.log('')
}

export async function main(): Promise<void> {
  // Re-exec under the pinned node when a stale PATH node (below the hook floor)
  // is active, so the coverage vitest + the hooks it spawns run on the fleet
  // runtime instead of failing "Hook requires Node >= 25".
  ensurePinnedNode()
  const { values } = parseArgs({
    options: {
      'code-only': { type: 'boolean', default: false },
      'type-only': { type: 'boolean', default: false },
      summary: { type: 'boolean', default: false },
    },
    strict: false,
  })

  printHeader('Test Coverage')
  logger.log('')

  const buildEntry = resolveBuildEntry(rootPath)
  let buildFailed = false
  if (buildEntry) {
    logger.info('Building with source maps for coverage…')
    const buildResult = await spawn('node', [buildEntry], {
      cwd: rootPath,
      stdio: 'inherit',
      env: {
        ...process.env,
        COVERAGE: 'true',
      },
    })
    buildFailed = buildResult.code !== 0
    if (buildFailed) {
      logger.error('Build with source maps failed')
      process.exitCode = 1
    }
    logger.log('')
  } else {
    logger.info(
      'No build entry (scripts/build.mts | bundle.mts) — instrumenting sources directly.',
    )
    logger.log('')
  }

  const customFlags = ['--code-only', '--type-only', '--summary']
  const passthroughArgs = process.argv
    .slice(2)
    .filter(arg => !customFlags.includes(arg))

  const coverConfig = readCoverConfig(rootPath)
  const suites = resolveSuites(rootPath, coverConfig)

  // Build the vitest argv for a resolved suite, threading the suite's
  // per-run --exclude globs (so a test that exercises another package is
  // skipped in this repo's coverage run).
  const suiteVitestArgs = (suite: ResolvedSuite): string[] => [
    'exec',
    'vitest',
    'run',
    ...(suite.config ? ['--config', suite.config] : []),
    '--coverage',
    ...suite.runExclude.flatMap(glob => ['--exclude', glob]),
    ...passthroughArgs,
  ]

  const sharedSuite = suites.find(s => s.name === 'shared')
  const isolatedSuite = suites.find(s => s.name === 'isolated')
  const mainVitestArgs = sharedSuite
    ? suiteVitestArgs(sharedSuite)
    : ['exec', 'vitest', 'run', '--coverage', ...passthroughArgs]
  const isolatedVitestArgs = isolatedSuite
    ? suiteVitestArgs(isolatedSuite)
    : undefined
  const typeCoverageArgs = ['exec', 'type-coverage']

  try {
    let exitCode = 0

    if (values['type-only']) {
      const typeCoverageResult = await runQuiet(typeCoverageArgs, {
        cwd: rootPath,
      })
      exitCode = typeCoverageResult.exitCode

      const typeCoverageOutput = (
        typeCoverageResult.stdout + typeCoverageResult.stderr
      ).trim()
      const typeCoveragePercent = parseTypeCoveragePercent(typeCoverageOutput)

      if (typeCoveragePercent !== undefined) {
        logger.log('')
        logger.log(' Coverage Summary')
        logger.log(' ───────────────────────────────')
        logger.log(` Type Coverage: ${typeCoveragePercent.toFixed(2)}%`)
        logger.log('')
      }
    } else {
      const suiteStart = performance.now()
      const { combined, isolatedResult, mainResult } = await runTestSuites(
        mainVitestArgs,
        isolatedVitestArgs,
      )
      warnIfOverBudget(performance.now() - suiteStart, resolveUnitBudgetMs())
      exitCode = combined.exitCode

      const mainOutput = cleanOutput(mainResult.stdout + mainResult.stderr)
      const combinedOutput = cleanOutput(combined.stdout + combined.stderr)

      let typeCoveragePercent: number | undefined
      if (!values['code-only']) {
        const typeCoverageResult = await runQuiet(typeCoverageArgs, {
          cwd: rootPath,
        })
        const typeCoverageOutput = (
          typeCoverageResult.stdout + typeCoverageResult.stderr
        ).trim()
        typeCoveragePercent = parseTypeCoveragePercent(typeCoverageOutput)
      }

      // Disabled seam (#213 step 1): strict-tier enforcement. A suite that ran
      // must have produced its tier's coverage-final.json; a dropped tier
      // silently narrows the merge and over-reports (a false-green). Gated OFF
      // by default — the 'shared' tier always runs, 'isolated' only when its
      // suite is resolved. Flip on with FLEET_COVER_STRICT_TIERS=1 once a
      // supervised `cover` run confirms the wheelhouse emits every resolved
      // tier; step 2 promotes this gate into `.config/repo/cover.json`.
      const expectedTiers =
        process.env['FLEET_COVER_STRICT_TIERS'] === '1'
          ? ['shared', ...(isolatedSuite ? ['isolated'] : [])]
          : undefined
      let aggregateCoverage: AggregateCoverage | undefined
      try {
        aggregateCoverage = await mergeCoverageFinal({
          expectedTiers,
          logger,
          rootPath,
        })
      } catch (e) {
        if (e instanceof MissingTierCoverageError) {
          logger.error(`Coverage tier dropped: ${errorMessage(e)}`)
          exitCode = exitCode === 0 ? 1 : exitCode
        } else {
          logger.warn(
            `Could not compute aggregate coverage: ${errorMessage(e)}`,
          )
        }
      }

      displayCodeCoverage(mainOutput, combinedOutput, aggregateCoverage, {
        showDetail: !values['summary'],
        typeCoveragePercent,
      })

      // Gate on configured thresholds: any metric under its minimum fails the
      // run. Repos with no thresholds in cover.json are report-only.
      const thresholdFailures = checkThresholds(
        aggregateCoverage,
        coverConfig.thresholds,
      )
      if (thresholdFailures.length) {
        logger.error(
          `Coverage below threshold: ${thresholdFailures.join(', ')}`,
        )
        exitCode = exitCode === 0 ? 1 : exitCode
      }

      // A failing suite must say WHY before the terminal "Coverage failed":
      // per-suite vitest errors (config-level threshold misses, test
      // failures) live only in the captured suite output.
      if (combined.exitCode !== 0) {
        const failureLines = [
          ...extractSuiteFailureLines('main', mainResult),
          ...(isolatedResult
            ? extractSuiteFailureLines('isolated', isolatedResult)
            : []),
        ]
        for (let i = 0, { length } = failureLines; i < length; i += 1) {
          const line = failureLines[i]!
          logger.error(line)
        }
      }
    }

    if (buildFailed) {
      exitCode = 1
    }

    if (exitCode === 0) {
      logger.success('Coverage completed successfully')
    } else {
      logger.error('Coverage failed')
    }

    process.exitCode = exitCode
  } catch (e) {
    logger.error(`Coverage script failed: ${errorMessage(e)}`)
    process.exitCode = 1
  }
}

// Coverage legitimately runs vitest workers hot for many minutes; the
// active-run marker tells the stale-process-sweeper's stuck heuristic this
// worker tree is healthy on-purpose work, not a wedge (see
// scripts/fleet/_shared/active-run-marker.mts for the contract).
registerActiveRun()
main()
  .catch((e: unknown) => {
    logger.error(`Coverage script failed: ${errorMessage(e)}`)
    process.exitCode = 1
  })
  .finally(() => {
    unregisterActiveRun()
  })

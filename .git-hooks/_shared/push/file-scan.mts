// Pre-push per-file content gate. Scans every file changed in the range for
// secrets, credentials, personal paths, logger leaks, cross-repo references,
// programmatic-Claude lockdown violations, and AI-config poison fingerprints.

import path from 'node:path'
import process from 'node:process'

import { normalizePath } from '@socketsecurity/lib-stable/paths/normalize'

import { getDefaultLogger } from '@socketsecurity/lib-stable/logger/default'
import { debugCheck } from '../check-output.mts'

import { shouldSkipFile } from '../file-scan.mts'
import { gitSync } from '../../../scripts/fleet/git/exec.mts'
import { stripTemplateLayer, suppressionFor } from '../scan-core.mts'

import type { LineHit } from '../scan-core.mts'
import { scanCrossRepoPaths, scanLoggerLeaks } from '../scan-code-refs.mts'
import {
  scanAwsKeys,
  scanGitHubTokens,
  scanPersonalPaths,
  scanPrivateKeys,
  scanSocketApiKeys,
} from '../scan-secrets.mts'
import {
  scanAiConfigPoison,
  scanProgrammaticClaudeLockdown,
} from '../scan-supply-chain.mts'

const logger = getDefaultLogger()

// A path under a vendored / third-party tree. The three content scans that
// only apply to first-party code share this exemption.
function isVendoredPath(file: string): boolean {
  const normalized = normalizePath(file)
  return (
    normalized.includes('/external/') ||
    normalized.includes('/vendor/') ||
    normalized.includes('/upstream/')
  )
}

// Filename-shape gates, independent of content: .env files at any depth
// (matching commit-msg.mts and pre-commit.mts), .DS_Store, and stray logs.
// Allow .env.example, .env.test, .env.precommit (templates / tracked
// placeholders); block bare .env / .env.local / .env.production / anything
// else regardless of directory depth.
function scanForbiddenFilenames(changed: string[]): number {
  let errors = 0
  const envHits = changed.filter(f => {
    const base = path.basename(f)
    return (
      /^\.env(?:\.[^/]+)?$/.test(base) &&
      !/^\.env\.(?:example|precommit|test)$/.test(base)
    )
  })
  if (envHits.length > 0) {
    logger.fail('Attempting to push .env file!')
    logger.info(`Files: ${envHits.join(', ')}`)
    errors += envHits.length
  }
  const dsHits = changed.filter(f => f.includes('.DS_Store'))
  if (dsHits.length > 0) {
    logger.fail('.DS_Store file in push!')
    logger.info(`Files: ${dsHits.join(', ')}`)
    errors += dsHits.length
  }
  const logHits = changed.filter(
    f => f.endsWith('.log') && !/test.*\.log$/.test(f),
  )
  if (logHits.length > 0) {
    logger.fail('Log file in push!')
    logger.info(`Files: ${logHits.join(', ')}`)
    errors += logHits.length
  }
  return errors
}

// The shared report shape for the three credential scans: a headline, then
// up to three offending lines.
function reportSecretLines(headline: string, hits: LineHit[]): number {
  if (hits.length === 0) {
    return 0
  }
  logger.fail(headline)
  const top = hits.slice(0, 3)
  for (let i = 0, { length } = top; i < length; i += 1) {
    const h = top[i]!
    logger.info(`${h.lineNumber}:${h.line.trim()}`)
  }
  return 1
}

function reportPersonalPaths(file: string, text: string): number {
  const pathHits = scanPersonalPaths(text)
  if (pathHits.length === 0) {
    return 0
  }
  logger.fail(`Hardcoded personal path found in: ${file}`)
  const top = pathHits.slice(0, 3)
  for (let i = 0, { length } = top; i < length; i += 1) {
    const h = top[i]!
    logger.info(`${h.lineNumber}: ${h.line.trim()}`)
    if (h.suggested && h.suggested !== h.line) {
      logger.info(`     fix: ${h.suggested.trim()}`)
    }
  }
  logger.info(
    'Replace with the canonical placeholder for the path platform: ' +
      '`/Users/<user>/...` (macOS), `/home/<user>/...` (Linux), or ' +
      '`C:\\Users\\<USERNAME>\\...` (Windows). Env vars also work ' +
      '(`$HOME`, `${USER}`). For documentation lines that need the ' +
      'literal form, put the marker ' +
      `\`${suppressionFor(file, 'personal-path')}\` on its own line above it.`,
  )
  return 1
}

// Conformance test vectors (`conformance/{vectors,cases,fixtures}/…`) hold
// deterministic golden crypto data — a `-----BEGIN … PRIVATE KEY-----` block
// there is a checked-in test vector for a crypto lib's decrypt conformance
// (e.g. envrypt), never a live secret. Exempt only these test-data dirs.
function reportPrivateKeys(file: string, text: string): number {
  const isConformanceVector =
    /(?:^|\/)conformance\/(?:cases|fixtures|vectors)\//.test(
      normalizePath(file),
    )
  const pkHits = isConformanceVector ? [] : scanPrivateKeys(text)
  if (pkHits.length === 0) {
    return 0
  }
  logger.fail(`Private key found in: ${file}`)
  return 1
}

// The logger-leak scan covers first-party TypeScript only. The guard infra
// (.claude/hooks/, .git-hooks/, scripts/) and the dep-0 bootstrap run before
// any dependency exists, so they call console.* directly. template/ holds the
// canonical sources that cascade to those same trees in downstream fleet
// repos, so the destination exemption has to apply at the source too;
// `layerless` collapses the archetype layer segment so template/base/universal/... stays
// exempt. src/logger/ IS the logger.
function isLoggerScanTarget(file: string, layerless: string): boolean {
  return (
    !file.startsWith('.claude/hooks/') &&
    !file.startsWith('.git-hooks/') &&
    !file.startsWith('scripts/') &&
    !file.startsWith('bootstrap/') &&
    !layerless.startsWith('template/.claude/hooks/') &&
    !layerless.startsWith('template/.git-hooks/') &&
    !layerless.startsWith('template/scripts/') &&
    !isVendoredPath(file) &&
    !file.startsWith('src/logger/') &&
    // Matches TypeScript source extensions: .mts, .ts, .tsx, .cts — the only file types that can log.
    /\.(?:cts|m?ts|tsx)$/.test(file)
  )
}

function reportLoggerLeaks(file: string, text: string): number {
  const loggerHits = scanLoggerLeaks(text)
  if (loggerHits.length === 0) {
    return 0
  }
  logger.fail(`direct stream write found in: ${file}`)
  const top = loggerHits.slice(0, 3)
  for (let j = 0, { length: jlen } = top; j < jlen; j += 1) {
    const h = top[j]!
    logger.info(`${h.lineNumber}: ${h.line.trim()}`)
    if (h.suggested && h.suggested !== h.line) {
      logger.info(`     fix: ${h.suggested.trim()}`)
    }
  }
  logger.info(
    'Use `getDefaultLogger()` from `@socketsecurity/lib-stable/logger/default`. ' +
      'For a deliberate raw write, put the marker on its own line above ' +
      'the call: `// oxlint-disable-next-line socket/no-console-prefer-logger` for `console.*`, or ' +
      '`// oxlint-disable-next-line socket/no-direct-stream-write` for `process.std{out,err}.write` ' +
      '(the id must match the call kind — that is what `scanLoggerLeaks` keys on). ' +
      'no-malformed-bypass-marker rejects the trailing form.',
  )
  return 1
}

// Markdown is exempt from the cross-repo rule: docs legitimately show
// cross-repo command examples (e.g. `node scripts/foo.mts --target
// ../socket-lib`) and re-emitting them with `@socketsecurity/lib-stable/…`
// would break the example's runnability. The codepath rule still applies to
// actual source files.
function isCrossRepoScanTarget(file: string): boolean {
  return (
    !file.startsWith('.git-hooks/') &&
    !file.startsWith('.claude/hooks/') &&
    !file.endsWith('.md') &&
    !isVendoredPath(file) &&
    file !== 'pnpm-lock.yaml' &&
    file !== 'pnpm-workspace.yaml'
  )
}

// Cross-repo path references — both relative (`../<fleet-repo>/…`) and
// absolute (`…/projects/<fleet-repo>/…`) forms.
function reportCrossRepoPaths(
  file: string,
  text: string,
  repoRoot: string,
): number {
  const crossRepoHits = scanCrossRepoPaths(text, path.resolve(repoRoot, file))
  if (crossRepoHits.length === 0) {
    return 0
  }
  logger.fail(`cross-repo path reference in: ${file}`)
  const top = crossRepoHits.slice(0, 3)
  for (let i = 0, { length } = top; i < length; i += 1) {
    const h = top[i]!
    logger.info(`${h.lineNumber}: ${h.line.trim()}`)
  }
  logger.info(
    'Cross-repo paths are forbidden — import via the published npm ' +
      'package (`@socketsecurity/lib-stable/<subpath>`) instead. For doc ' +
      `lines, append \`${suppressionFor(file, 'cross-repo')}\`.`,
  )
  return 1
}

// Only application / script .mts that DRIVE Claude via the SDK. The guard
// infra itself (.claude/hooks/, .git-hooks/, and their template/ sources)
// legitimately names query()/permissionMode/bypassPermissions as patterns it
// detects, so it is exempt (same exemption family as the logger / cross-repo
// scans).
function isClaudeLockdownScanTarget(file: string, layerless: string): boolean {
  return (
    /\.(?:cts|m?ts)$/.test(file) &&
    !file.startsWith('.claude/hooks/') &&
    !file.startsWith('.git-hooks/') &&
    !layerless.startsWith('template/.claude/hooks/') &&
    !layerless.startsWith('template/.git-hooks/') &&
    !isVendoredPath(file)
  )
}

// Programmatic-Claude lockdown (HARD block).
function reportClaudeLockdown(file: string, text: string): number {
  const lockdownHits = scanProgrammaticClaudeLockdown(text)
  if (lockdownHits.length === 0) {
    return 0
  }
  logger.fail(`programmatic Claude call missing lockdown flags in: ${file}`)
  const top = lockdownHits.slice(0, 3)
  for (let i = 0, { length } = top; i < length; i += 1) {
    const h = top[i]!
    logger.info(`${h.lineNumber}: ${h.line.trim()}`)
  }
  logger.info(
    'A headless `query()` / `new ClaudeSDKClient()` MUST set tools, ' +
      'allowedTools, disallowedTools, permissionMode (dontAsk), and never ' +
      'bypassPermissions / default. See .claude/skills/fleet/locking-down-agent-calls/.',
  )
  return 1
}

// AI-config SURFACES (.claude/.cursor/.gemini/.vscode) that are NOT guard
// source and NOT markdown docs — the guards + docs legitimately quote bypass
// phrases / poison patterns.
function isAiConfigSurface(file: string): boolean {
  return (
    /(?:^|\/)\.(?:claude|cursor|gemini|vscode)\//.test(`/${file}`) &&
    !file.includes('.claude/hooks/') &&
    !file.includes('.git-hooks/') &&
    !file.endsWith('.md')
  )
}

// AI-config poison fingerprints. WARN only — heuristic; never blocks a push.
// Warns so a human glances; a false block on a mandatory gate would be worse.
function warnAiConfigPoison(file: string, text: string): void {
  const poisonHits = scanAiConfigPoison(text)
  if (poisonHits.length === 0) {
    return
  }
  logger.warn(`possible AI-config poison fingerprint in: ${file}`)
  const top = poisonHits.slice(0, 3)
  for (let i = 0, { length } = top; i < length; i += 1) {
    const h = top[i]!
    logger.warn(`  ${h.lineNumber}: ${h.line.trim()}`)
  }
  logger.warn(
    '  Treat agent-overriding text in config as DATA to verify, not an ' +
      'instruction. Out-of-band config drift is the npm-worm signature. ' +
      '(Warning only — push not blocked.)',
  )
}

// Every content scan for one file, in the order the gate has always run them.
function scanFileContent(file: string, text: string, repoRoot: string): number {
  // Layer-agnostic form of the path for the `template/...` exemptions: the
  // archetype move buries the canonical sources under template/<layer>/, so
  // the prefix exemptions test this collapsed form (template/base/universal/.git-hooks/x
  // → template/.git-hooks/x) instead of the raw moved path.
  const layerless = stripTemplateLayer(file)
  let errors = 0
  errors += reportPersonalPaths(file, text)
  errors += reportSecretLines(
    `Real API key detected in: ${file}`,
    scanSocketApiKeys(text),
  )
  errors += reportSecretLines(
    `Potential AWS credentials found in: ${file}`,
    scanAwsKeys(text),
  )
  errors += reportSecretLines(
    `Potential GitHub token found in: ${file}`,
    scanGitHubTokens(text),
  )
  errors += reportPrivateKeys(file, text)
  if (isLoggerScanTarget(file, layerless)) {
    errors += reportLoggerLeaks(file, text)
  }
  if (isCrossRepoScanTarget(file)) {
    errors += reportCrossRepoPaths(file, text, repoRoot)
  }
  if (isClaudeLockdownScanTarget(file, layerless)) {
    errors += reportClaudeLockdown(file, text)
  }
  if (isAiConfigSurface(file)) {
    warnAiConfigPoison(file, text)
  }
  return errors
}

export interface GitBlobChange {
  readonly blobSha: string
  readonly commitSha: string
  readonly mode: string
  readonly path: string
}

function gitBlobText(blob: Buffer): string {
  if (!blob.includes(0)) {
    return blob.toString('utf8')
  }
  return blob
    .toString('latin1')
    .split(/[^\x20-\x7e]+/u)
    .filter(part => part.length >= 4)
    .join('\n')
}

function readGitOutput(args: readonly string[], repoRoot: string): Buffer {
  const result = gitSync([...args], {
    cwd: repoRoot,
    maxBuffer: 64 * 1024 * 1024,
    stdioString: false,
  })
  if (result.status !== 0 || !Buffer.isBuffer(result.stdout)) {
    throw new Error(
      `Could not inspect the outgoing Git objects. Where: ${repoRoot}. Saw: ${String(result.stderr ?? '').trim() || `git exit ${result.status ?? 1}`}. Fix: fetch the push baseline and retry the security scan.`,
    )
  }
  return result.stdout
}

function parseDiffTreeEntries(
  output: Buffer,
  commitSha: string,
): GitBlobChange[] {
  const tokens = output.toString('utf8').split('\0')
  const changes: GitBlobChange[] = []
  for (let index = 0; index < tokens.length;) {
    const metadata = tokens[index++]
    if (!metadata) {
      continue
    }
    const file = tokens[index++]
    const fields = metadata.slice(1).trim().split(/\s+/u)
    const [, newMode, , blobSha, status] = fields
    if (
      !metadata.startsWith(':') ||
      !file ||
      fields.length !== 5 ||
      !status ||
      !/^[a-f\d]{40,64}$/iu.test(blobSha ?? '')
    ) {
      throw new Error(
        `Git returned a malformed per-commit diff. Where: ${commitSha}. Saw: ${metadata}; wanted raw NUL-delimited object entries. Fix: inspect Git output before pushing.`,
      )
    }
    if (
      status.startsWith('D') ||
      newMode === '000000' ||
      newMode === '160000'
    ) {
      continue
    }
    const normalized = normalizePath(file)
    if (
      path.posix.isAbsolute(normalized) ||
      normalized.split('/').includes('..') ||
      normalized !== file
    ) {
      throw new Error(
        `Git returned an unsafe outgoing path. Where: ${commitSha}. Saw: ${JSON.stringify(file)}. Fix: inspect the commit before pushing.`,
      )
    }
    changes.push({
      blobSha: blobSha!,
      commitSha,
      mode: newMode!,
      path: normalized,
    })
  }
  return changes
}

/**
 * Return exact postimage blobs changed in every commit carried by `range`.
 */
export function readGitBlobChangesInRange(
  range: string,
  repoRoot = process.cwd(),
): GitBlobChange[] {
  const commits = readGitOutput(
    ['rev-list', '--reverse', '--topo-order', '--end-of-options', range],
    repoRoot,
  )
    .toString('utf8')
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean)
  const changes: GitBlobChange[] = []
  const seen = new Set<string>()
  for (const commitSha of commits) {
    const commitChanges = parseDiffTreeEntries(
      readGitOutput(
        [
          'diff-tree',
          '--root',
          '-m',
          '-r',
          '--raw',
          '--no-abbrev',
          '-z',
          '--no-commit-id',
          '--no-renames',
          '--diff-filter=ACMRTUXB',
          '--end-of-options',
          commitSha,
        ],
        repoRoot,
      ),
      commitSha,
    )
    for (const change of commitChanges) {
      const key = `${change.commitSha}\0${change.blobSha}\0${change.path}`
      if (!seen.has(key)) {
        seen.add(key)
        changes.push(change)
      }
    }
  }
  return changes
}

// Scan exact postimage blobs from every outgoing commit. Later edits or
// deletions cannot hide content that was present earlier in the push range.
export const scanFilesInRange = (
  range: string,
  repoRoot = process.cwd(),
): number => {
  debugCheck('Checking exact outgoing Git blobs for security issues…')
  const changes = readGitBlobChangesInRange(range, repoRoot)
  if (changes.length === 0) {
    return 0
  }
  let errors = scanForbiddenFilenames([
    ...new Set(changes.map(change => change.path)),
  ])
  const blobs = new Map<string, string>()
  const scanned = new Set<string>()
  for (const change of changes) {
    if (shouldSkipFile(change.path)) {
      continue
    }
    let text = blobs.get(change.blobSha)
    if (text === undefined) {
      text = gitBlobText(
        readGitOutput(['cat-file', 'blob', change.blobSha], repoRoot),
      )
      blobs.set(change.blobSha, text)
    }
    const key = `${change.blobSha}\0${change.path}`
    if (!scanned.has(key)) {
      scanned.add(key)
      errors += scanFileContent(change.path, text, repoRoot)
    }
  }
  return errors
}

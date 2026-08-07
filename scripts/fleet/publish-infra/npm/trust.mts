#!/usr/bin/env node
/*
 * @file Configure npm Trusted Publishers through `npm trust` — the registry
 *   API, not the website. The web UI sits behind bot management that
 *   challenges an automated session per page (see
 *   docs/agents.md/fleet/npm-anti-bot-rhythm.md); the registry endpoint
 *   `POST /-/package/<pkg>/trust` that `npm trust` drives has no such
 *   challenge, so a whole workspace configures in one pass.
 *   Three details this wrapper exists to own, so no operator hand-runs npm:
 *
 *   1. The npm that runs is the one bundled with the repo's PINNED Node
 *      (pinned-npm.mts), never a stray Homebrew npm — these writes are
 *      2FA-gated and irreversible.
 *   2. Every npm spawn runs from a NEUTRAL cwd. A fleet repo's package.json
 *      declares `devEngines.packageManager: pnpm`, which makes npm refuse to
 *      run at all (EBADDEVENGINES), so the package name travels as an argument
 *      instead of the cwd.
 *   3. The first write prompts for 2FA web-auth, which needs a TTY. The spawn goes
 *      through the fleet PTY seam (shared.mts) so the prompt works from a
 *      non-TTY session. npm then grants a ~5-minute skip-2FA window, so
 *      packages are written SEQUENTIALLY with a short sleep — npm's own
 *      rate-limit guidance. The desired shape per package comes from
 *      trusted-publisher-plan.mts, so the two-workflow rule holds here exactly
 *      as it does in the browser driver: a plain package publishes from
 *      `npm-publish.yml`, a napi `<base>-<platform>` package from
 *      `npm-publish-napi.yml`. Dry-run is the default: it prints the plan and
 *      writes nothing. `--apply` performs the writes, verifies each by
 *      re-reading, and reports a summary. A package whose re-read does not
 *      match never aborts the rest. Usage: node
 *      scripts/fleet/publish-infra/npm/trust.mts [<pkg>…] [--repo <owner/name>]
 *      [--apply]
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

import { WIN32 } from '@socketsecurity/lib-stable/constants/platform'
import { httpRequest } from '@socketsecurity/lib-stable/http-request'
import { spawn } from '@socketsecurity/lib-stable/process/spawn/child'
import { getDefaultLogger } from '@socketsecurity/lib-stable/logger/default'

import { isMainModule } from '../../_shared/is-main-module.mts'
import { openUrlInNewWindow } from '../../_shared/open-url.mts'
import { runMain } from '../../_shared/run-main.mts'
import { REPO_ROOT } from '../../paths.mts'
import { buildPtyInvocation, runCapture } from '../shared.mts'
import {
  openNpmBrowserSession,
  watchCooldownOptIn,
} from './browser-session.mts'
import type { CooldownTickablePage } from './browser-session.mts'
import { resolvePinnedNpm } from './pinned-npm.mts'
import { desiredTrustedPublisher } from './trusted-publisher-plan.mts'
import type { TrustedPublisherDesired } from './trusted-publisher-plan.mts'
import { resolveNpmWorkspaceLayout } from './workspace.mts'

import type { ScriptMeta } from '../../_shared/run-main.mts'

const logger = getDefaultLogger()

/**
 * `npm trust` landed in npm 11.10.0. An older npm has no subcommand to call,
 * so the run stops with the pinned-Node fix rather than a cryptic usage error.
 */
export const MIN_NPM_VERSION = '11.10.0'

/**
 * Pause between sequential writes. npm's trusted-publishing guidance pairs the
 * skip-2FA window with a short sleep so a batch does not trip rate limiting.
 */
export const WRITE_SPACING_MS = 2000

/**
 * A package's planned configuration, and whether the registry already carries
 * it. `matches` short-circuits the write: this flow is a reconciler, so an
 * already-correct row is a skip, not a rewrite.
 */
export interface TrustPlan {
  readonly desired: TrustedPublisherDesired
  readonly matches: boolean
  readonly pkg: string
  // Whether the `npm trust list` read ANSWERED. A refused or rate-limited
  // read says nothing about the row, so an unreadable package is neither
  // conforming nor pending — writing it blind would 409 on an existing
  // connection, and counting it "to configure" is the 2026-08-06 miscount.
  readonly readable: boolean
  // The connection already on the package, when it has one. Present means the
  // write is a REBIND and has to revoke before it creates.
  readonly trustId?: string | undefined
}

export interface TrustFlags {
  readonly apply: boolean
  readonly packages: readonly string[]
  readonly repo: string | undefined
}

export function parseTrustArgs(argv: readonly string[]): TrustFlags {
  const packages: string[] = []
  let apply = false
  let repo: string | undefined
  for (let i = 0, { length } = argv; i < length; i += 1) {
    const arg = argv[i]!
    if (arg === '--apply') {
      apply = true
    } else if (arg === '--repo') {
      repo = argv[i + 1]
      i += 1
    } else if (arg.startsWith('--repo=')) {
      repo = arg.slice('--repo='.length)
    } else if (!arg.startsWith('-')) {
      packages.push(arg)
    }
  }
  return { apply, packages, repo }
}

/**
 * Semver-ish "is `version` at least `minimum`" over the numeric prefix of each
 * part, which is all a floor check needs. Pure so the guard is unit-testable.
 */
export function meetsMinimumVersion(version: string, minimum: string): boolean {
  const parse = (v: string): number[] =>
    v
      .replace(/^v/, '')
      .split('.')
      .map(part => Number.parseInt(part, 10) || 0)
  const have = parse(version)
  const want = parse(minimum)
  for (let i = 0; i < 3; i += 1) {
    const a = have[i] ?? 0
    const b = want[i] ?? 0
    if (a !== b) {
      return a > b
    }
  }
  return true
}

/**
 * The napi platform tokens declared by the repo at `repoRoot`, or an empty
 * list. Drives the two-workflow rule: a package named `<base>-<platform>` for
 * one of these publishes from the napi workflow.
 *
 * The platforms belong to the repo the packages BELONG to, which is not always
 * the cwd — `--repo owner/name` configures another member's packages, and
 * reading the cwd's config there would plan every platform package onto the
 * plain workflow.
 */
export function readNapiPlatforms(repoRoot: string): string[] {
  const file = path.join(repoRoot, '.config', 'repo', 'socket-wheelhouse.json')
  if (!existsSync(file)) {
    return []
  }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
      napi?: { platforms?: unknown | undefined } | undefined
    }
    const platforms = parsed?.napi?.platforms
    return Array.isArray(platforms)
      ? platforms.filter((p): p is string => typeof p === 'string')
      : []
  } catch {
    return []
  }
}

/**
 * The checkout whose config declares the target packages' platforms. Without
 * `--repo` that is this repo; with it, the sibling checkout beside this one,
 * matching the layout every fleet member shares (`~/projects/<name>`). Falls
 * back to this repo when the sibling is not checked out, which yields the
 * plain workflow for every package — correct for a repo with no napi packages,
 * and visible in the printed plan when it is not.
 */
export function resolveTargetRepoRoot(repo: string | undefined): string {
  if (!repo) {
    return REPO_ROOT
  }
  const slash = repo.indexOf('/')
  const name = slash >= 0 ? repo.slice(slash + 1) : repo
  if (!name || name === path.basename(REPO_ROOT)) {
    return REPO_ROOT
  }
  const sibling = path.join(path.dirname(REPO_ROOT), name)
  return existsSync(sibling) ? sibling : REPO_ROOT
}

/**
 * The `owner/name` of a GitHub repo named by a package.json `repository`
 * value — the string form, the `github:owner/name` shortcut, or the object
 * form's `url` — or undefined for anything that names no GitHub repo. Pure —
 * exported for tests.
 */
export function repoFromRepositoryValue(value: unknown): string | undefined {
  const url =
    typeof value === 'string'
      ? value
      : value && typeof value === 'object'
        ? (value as { url?: unknown | undefined }).url
        : undefined
  if (typeof url !== 'string' || !url) {
    return undefined
  }
  // npm's `github:owner/repo` shorthand: the literal prefix, the owner up to
  // the slash, the repo lazily so a trailing `#branch` stays out of it, and an
  // optional `#branch` discarded.
  // `github:` shortcut — capture owner, then name up to an optional `#ref`.
  const shortcut = /^github:([^/]+)\/([^/#]+?)(?:#.*)?$/.exec(url)
  if (shortcut) {
    return `${shortcut[1]}/${shortcut[2]}`
  }
  // A full GitHub URL in any of its shapes. `[/:]` covers both https and the
  // scp-style git@ form, the owner runs to the next slash, the repo is lazy so
  // an optional `.git` suffix and any `/`, `#`, or `?` tail drop off rather
  // than landing in the name.
  const hosted =
    /github\.com[/:]([^/]+)\/([^/#?]+?)(?:\.git)?(?:[/#?].*)?$/i.exec(url)
  return hosted ? `${hosted[1]}/${hosted[2]}` : undefined
}

/**
 * Derive `owner/name` for `pkg` from the registry packument's `repository`
 * field. A fresh name reservation ships no repository metadata, so undefined
 * here is common and simply falls through to the sibling-checkout scan.
 */
export async function deriveRepoFromRegistry(
  npmPath: string,
  pkg: string,
  neutralCwd: string,
): Promise<string | undefined> {
  const run = await runCapture(
    npmPath,
    ['view', pkg, 'repository', '--json'],
    neutralCwd,
  ).catch(() => undefined)
  const body = run?.stdout.trim()
  if (!body) {
    return undefined
  }
  try {
    return repoFromRepositoryValue(JSON.parse(body))
  } catch {
    return undefined
  }
}

/**
 * Derive `owner/name` for `pkg` from the sibling checkouts beside this repo —
 * the layout every fleet member shares (`~/projects/<name>`). A sibling whose
 * root manifest names `pkg` answers with its own `repository` field, falling
 * back to its `origin` remote. This is what resolves a FRESH reservation whose
 * packument carries nothing yet. Pure over the filesystem — exported for
 * tests.
 */
export function deriveRepoFromSiblings(
  pkg: string,
  projectsDir: string,
): string | undefined {
  let entries: string[]
  try {
    entries = readdirSync(projectsDir)
  } catch {
    return undefined
  }
  for (let i = 0, { length } = entries; i < length; i += 1) {
    const dir = path.join(projectsDir, entries[i]!)
    const manifestPath = path.join(dir, 'package.json')
    if (!existsSync(manifestPath)) {
      continue
    }
    let manifest: {
      name?: unknown | undefined
      repository?: unknown | undefined
    }
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        // oxlint-disable-next-line typescript/no-redundant-type-constituents -- fleet optional-explicit-undefined convention: the explicit | undefined on an optional is intentional, not redundant.
        name?: unknown | undefined
        // oxlint-disable-next-line typescript/no-redundant-type-constituents -- fleet optional-explicit-undefined convention: the explicit | undefined on an optional is intentional, not redundant.
        repository?: unknown | undefined
      }
    } catch {
      continue
    }
    if (manifest.name !== pkg) {
      continue
    }
    const fromManifest = repoFromRepositoryValue(manifest.repository)
    if (fromManifest) {
      return fromManifest
    }
    const gitConfigPath = path.join(dir, '.git', 'config')
    if (existsSync(gitConfigPath)) {
      try {
        const urlLine = /^\s*url\s*=\s*(.+)$/m.exec(
          readFileSync(gitConfigPath, 'utf8'),
        )
        const fromRemote = repoFromRepositoryValue(urlLine?.[1]?.trim())
        if (fromRemote) {
          return fromRemote
        }
      } catch {
        // A malformed .git/config answers nothing; the scan continues.
      }
    }
  }
  return undefined
}

/**
 * Every package name a repo publishes: its workspace packages, including the
 * generated napi platform packages, or the single package a non-workspace repo
 * ships. This is what makes the bare `pnpm run npm:trust --apply` complete — an
 * operator naming nine packages by hand is nine chances to miss one, and a
 * missed platform package fails its publish at release time, not here.
 */
export function enumerateRepoPackages(repoRoot: string): string[] {
  const layout = resolveNpmWorkspaceLayout(repoRoot)
  const names = new Set<string>()
  if (layout.subject?.name) {
    names.add(layout.subject.name)
  }
  const { packages } = layout
  for (let i = 0, { length } = packages; i < length; i += 1) {
    const pkg = packages[i]!
    if (pkg.name) {
      names.add(pkg.name)
    }
  }
  return [...names].toSorted()
}

/**
 * The `npm trust github` argv for one package. The package name is an
 * ARGUMENT, never the cwd, because npm refuses to run inside a repo whose
 * devEngines names pnpm.
 */
/**
 * The `--id` of the trust connection currently on a package, read out of
 * `npm trust list` output, or undefined when the package carries none.
 *
 * `npm trust` has `github` (create) and `revoke`, and no update. Creating over
 * an existing connection answers 409 Conflict, so REBINDING a package that is
 * already trusted means revoking the old connection first, and revoking needs
 * this id. Pure — exported for tests.
 */
export function trustConnectionId(listOutput: string): string | undefined {
  // A v4 uuid on an `id` line, which is how `npm trust list` prints the
  // connection's identifier.
  const match =
    /\bid[:=\s]+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i.exec(
      listOutput,
    )
  return match?.[1]
}

/**
 * The argv that revokes `trustId` from `pkg`. Pure — exported for tests.
 */
export function buildTrustRevokeArgs(pkg: string, trustId: string): string[] {
  return ['trust', 'revoke', pkg, `--id=${trustId}`]
}

export function buildTrustWriteArgs(
  pkg: string,
  desired: TrustedPublisherDesired,
): string[] {
  return [
    'trust',
    'github',
    pkg,
    '--file',
    desired.workflowFilename,
    '--repository',
    `${desired.repositoryOwner}/${desired.repositoryName}`,
    '--environment',
    desired.environmentName,
    // Each grant flag rides only when the law wants that action — the write
    // is a full upsert of the row, so an omitted flag CLEARS the grant.
    ...(desired.allowNpmPublish ? ['--allow-publish'] : []),
    ...(desired.allowNpmStagePublish ? ['--allow-stage-publish'] : []),
    '--yes',
  ]
}

/**
 * Whether `listOutput` from `npm trust list <pkg>` already describes
 * `desired`. The output is human-formatted, so this looks for each field's
 * value rather than parsing a shape npm may restyle. The grants must match
 * too: the write is a full upsert where an omitted flag CLEARS a grant, so a
 * row still carrying direct publish is NOT the stage-only row we would write
 * and skipping it would leave the wide grant in place. npm prints the grants
 * on a `permissions:` line — `stage publish` for the staged grant, a bare
 * `publish` for direct publish — and a restyled or absent line reads as a
 * mismatch, which converges by rewriting rather than skipping.
 */
export function listOutputMatches(
  listOutput: string,
  desired: TrustedPublisherDesired,
): boolean {
  const haystack = listOutput.toLowerCase()
  const slug =
    `${desired.repositoryOwner}/${desired.repositoryName}`.toLowerCase()
  if (
    !haystack.includes(slug) ||
    !haystack.includes(desired.workflowFilename.toLowerCase()) ||
    !haystack.includes(desired.environmentName.toLowerCase())
  ) {
    return false
  }
  const permissionsLine =
    /^\s*permissions\s*:(.*)$/im.exec(listOutput)?.[1]?.toLowerCase() ?? ''
  const hasStagePublish = permissionsLine.includes('stage publish')
  // `publish` is a substring of `stage publish`, so the direct grant is only
  // what remains once every staged token is removed.
  const hasDirectPublish = /\bpublish\b/.test(
    permissionsLine.replaceAll('stage publish', ''),
  )
  return (
    hasStagePublish === desired.allowNpmStagePublish &&
    hasDirectPublish === desired.allowNpmPublish
  )
}

/**
 * The four-ingredient block for a write whose re-read did not come back as
 * planned. Named per field so the operator can finish the row by hand if npm
 * partially accepted it.
 */
export function formatVerifyFailure(
  pkg: string,
  desired: TrustedPublisherDesired,
  listOutput: string,
): string {
  return [
    `the trusted publisher for ${pkg} did not verify after the write.`,
    `  Where: https://www.npmjs.com/package/${pkg}/access`,
    `  Saw:   ${listOutput.trim() || '(no configuration)'}`,
    `  Wanted: repo ${desired.repositoryOwner}/${desired.repositoryName}, ` +
      `workflow ${desired.workflowFilename}, environment ${desired.environmentName}.`,
    `  Fix:   re-run this command for ${pkg} alone; if it fails again, the ` +
      'registry rejected the claim — check the workflow filename exists on the default branch.',
  ].join('\n')
}

/**
 * The report for a package whose verify read was REFUSED rather than answered.
 * `writeExitCode` is the only evidence about the write itself, and it is stated
 * as evidence rather than a verdict: the row may be set, and the next run's
 * read — once a session can read — settles it either way.
 */
export function formatUnverifiable(
  pkg: string,
  desired: TrustedPublisherDesired,
  writeExitCode: number,
): string {
  return [
    `${pkg}: the write ${writeExitCode === 0 ? 'reported success' : `exited ${writeExitCode}`}, ` +
      'but the verify read was refused for a one-time password, so this run ' +
      'cannot say whether the row is set.',
    `  Wanted: repo ${desired.repositoryOwner}/${desired.repositoryName}, ` +
      `workflow ${desired.workflowFilename}, environment ${desired.environmentName}.`,
    `  Check:  https://www.npmjs.com/package/${pkg}/access`,
    '  Next:   re-run once a session can read; an already-correct row reports ' +
      'as conforming and is never rewritten.',
  ].join('\n')
}

/**
 * The human gate for the first write. npm challenges the first
 * account-changing call with 2FA web-auth and then grants a short window, so
 * one approval covers the batch.
 */
export function formatAuthGate(count: number): string {
  return [
    '🖐  HUMAN GATE — npm 2FA for the trusted-publisher batch [1/1]',
    `  Need: npm gates account changes behind 2FA, so the first of ${count} ` +
      'write(s) prompts for browser approval.',
    '  Mind: this is the registry API, not the website — no bot-management ' +
      'challenge; 2FA-bypass tokens are refused here by design.',
    '  You: approve the npmjs.com URL npm prints below in your browser.',
    '  Me: I drive every write once approval lands — npm grants a ' +
      '~5-minute window, so one approval covers the whole batch. Each ' +
      'package is then written, re-read, and reported in the summary.',
  ].join('\n')
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Whether `output` is npm refusing an account operation for want of a
 * one-time password. Every `npm trust` call — the reads included — is an
 * account operation, so a session that has not authenticated sees this on the
 * FIRST read rather than at the first write.
 */
export function isOtpRequired(output: string): boolean {
  return /\bEOTP\b|requires a one-time password/i.test(output)
}

/**
 * Run npm and collect BOTH streams. npm reports an EOTP refusal — and the
 * approval URLs with it — on stderr, so a stdout-only capture reads as silence
 * and the caller concludes the session is authenticated when it is not.
 */
export async function runCaptureBoth(
  cmd: string,
  args: readonly string[],
  cwd: string,
): Promise<{ code: number; output: string }> {
  const child = spawn(cmd, [...args], {
    cwd,
    shell: WIN32,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.process.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8')
  })
  child.process.stderr?.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8')
  })
  const code = await new Promise<number>(resolve => {
    child.process.on('close', (exitCode: number | null) => {
      resolve(exitCode ?? 1)
    })
  })
  void child.catch(() => undefined)
  return { code, output }
}

/**
 * Npm's browser-approval URL and the endpoint that reports the approval, as
 * printed in an EOTP refusal. `npm trust` does NOT poll for the approval the
 * way `npm login` does — it refuses, names both URLs, and expects the next
 * call to find an elevated session. This flow closes that loop itself.
 */
/**
 * Run a `npm trust` write through a PTY and answer its prompts.
 *
 * With a TTY npm takes its INTERACTIVE OTP path instead of refusing: it prints
 * an approval URL, waits at `Press ENTER to open in the browser...`, then polls
 * for the approval itself. The fleet's PTY helper inherits stdin, which is
 * empty in a non-interactive session, so that wait never ends. This answers the
 * prompt and opens the URL directly — the difference between a hang and a
 * completed write.
 */
export async function runTrustWriteInteractive(
  npmPath: string,
  args: readonly string[],
  neutralCwd: string,
): Promise<number> {
  const runOnce = async (
    command: string,
    commandArgs: string[],
  ): Promise<{ code: number; seen: string }> => {
    const child = spawn(command, commandArgs, {
      cwd: neutralCwd,
      shell: WIN32,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let seen = ''
    let answered = false
    let opened = false
    const onChunk = (chunk: Buffer): void => {
      seen += chunk.toString('utf8')
      process.stdout.write(chunk)
      if (!answered && /press enter/i.test(seen)) {
        answered = true
        child.process.stdin?.write('\n')
      }
      if (!opened) {
        const url = urlAfterMarker(seen, 'auth/cli/')
        if (url) {
          opened = true
          void openApprovalUrl(url).catch(() => undefined)
        }
      }
    }
    child.process.stdout?.on('data', onChunk)
    child.process.stderr?.on('data', onChunk)
    const code = await new Promise<number>(resolve => {
      child.process.on('close', (exitCode: number | null) => {
        resolve(exitCode ?? 1)
      })
    })
    void child.catch(() => undefined)
    return { code, seen }
  }
  const pty = buildPtyInvocation(process.platform, npmPath, [...args])
  const attempt = await runOnce(
    pty?.command ?? npmPath,
    pty ? [...pty.args] : [...args],
  )
  if (!pty || !isPtyAllocationFailure(attempt.seen, attempt.code)) {
    return attempt.code
  }
  // script(1) refused the pseudo-terminal (socket/pipe stdio — an agent
  // session or a captured run) and npm never executed. expect(1) allocates
  // its own PTY pair without needing a controlling terminal, so npm takes its
  // INTERACTIVE OTP path: it prints a REAL approval URL (the non-interactive
  // EOTP refusal masks them to `***`) and polls for the approval itself. The
  // onChunk handler above opens that URL in the operator's browser.
  if (existsSync(EXPECT_PATH)) {
    logger.info(
      'script(1) refused a PTY here (no TTY); driving the write through ' +
        'expect(1) instead.',
    )
    const viaExpect = await runOnce(EXPECT_PATH, [
      '-c',
      buildExpectPtyScript(npmPath, [...args]),
    ])
    if (!isPtyAllocationFailure(viaExpect.seen, viaExpect.code)) {
      return viaExpect.code
    }
  }
  // Last resort — a plain spawn. npm may refuse a non-interactive WRITE with
  // EOTP even inside a primed session, so an EOTP refusal here drives the
  // same browser-approval loop the priming step uses — open the approval URL,
  // poll npm's done endpoint, then run the write once more against the
  // elevated session.
  logger.info(
    'PTY allocation failed here (no TTY); retrying the write with a plain spawn.',
  )
  const plain = await runOnce(npmPath, [...args])
  if (plain.code === 0 || !isOtpRequired(plain.seen)) {
    return plain.code
  }
  const challenge = parseOtpChallenge(plain.seen)
  if (!challenge) {
    return plain.code
  }
  logger.info(
    'npm wants a fresh browser approval for this write — opening the ' +
      'approval page and waiting.',
  )
  await openApprovalUrl(challenge.authUrl)
  const deadline = Date.now() + OTP_APPROVAL_BUDGET_MS
  let approved = false
  while (Date.now() < deadline) {
    // One operator, one approval.
    // eslint-disable-next-line no-await-in-loop -- serial
    const poll = await pollApproval(challenge.doneUrl, npmPath, neutralCwd)
    if (poll === 'complete') {
      approved = true
      break
    }
    if (poll === 'expired') {
      // npm dropped the approval session. Polling a dead authId for the rest
      // of the budget is a silent multi-minute hang; say so and stop.
      logger.warn(
        'the npm approval session expired before it was approved — re-run ' +
          'and approve the page as soon as it opens.',
      )
      break
    }
    // Not a retry ladder.
    // eslint-disable-next-line no-await-in-loop -- paced poll
    await sleep(OTP_POLL_MS)
  }
  if (!approved) {
    return plain.code
  }
  logger.success('approval received — repeating the write.')
  const retried = await runOnce(npmPath, [...args])
  return retried.code
}

/**
 * Where macOS and most Linuxes keep expect(1). Checked with existsSync rather
 * than PATH lookup so a missing expect falls through to the plain-spawn
 * ladder instead of a spawn ENOENT.
 */
export const EXPECT_PATH = '/usr/bin/expect'

/**
 * How long the expect(1)-driven write may run before expect gives up. Sized
 * for the human step it wraps — npm prints an approval URL and waits for the
 * browser — so this is the operator's OTP budget plus slack, not a network
 * timeout. `timeout -1` would hang the run on a wedged npm with only the
 * caller's own patience to end it.
 */
export const EXPECT_TIMEOUT_MS = 6 * 60_000

/**
 * A Tcl word for `value`: bare when it is plain command-argument text,
 * brace-quoted otherwise. Backslashes and braces are escaped so the value
 * survives brace-quoting verbatim. Pure — exported for tests.
 */
export function tclWord(value: string): string {
  if (/^[\w!%+,./:=@^-]+$/.test(value)) {
    return value
  }
  // Escape the three characters Tcl still interprets inside {braces}.
  return `{${value.replace(/[\\{}]/g, '\\$&')}}`
}

/**
 * The expect(1) program that runs `cmd args…` on a fresh PTY, answers npm's
 * `Press ENTER to open in the browser` prompt, and exits with the child's
 * exit code. expect allocates the PTY itself, so this works from a session
 * whose stdio is a socket or pipe — exactly where script(1) refuses. Pure —
 * exported for tests.
 */
export function buildExpectPtyScript(
  cmd: string,
  args: readonly string[],
): string {
  const words = [cmd, ...args].map(tclWord).join(' ')
  return [
    `set timeout ${Math.ceil(EXPECT_TIMEOUT_MS / 1000)}`,
    `spawn -noecho ${words}`,
    'expect {',
    '  -nocase -re {press enter} { send "\\r"; exp_continue }',
    '  eof',
    '}',
    'catch wait result',
    'exit [lindex $result 3]',
  ].join('\n')
}

/**
 * Whether a PTY-wrapped run died in the WRAPPER — the pseudo-terminal was
 * never allocated and the wrapped command never ran. Decided by EVIDENCE, not
 * by matching the wrapper's error wording (BSD and util-linux script(1)
 * phrase their failures differently, and both change): a nonzero exit where
 * nothing in the output came from the wrapped command means the command never
 * spoke, so the failure is the wrapper's. npm always identifies itself in its
 * output (banner, `npm notice`, `npm error`), and script(1) prefixes its own
 * complaints with `script:`, so stripping wrapper-origin lines and looking
 * for the wrapped binary's name is wording-independent. Pure — exported for
 * tests.
 */
export function isPtyAllocationFailure(
  output: string,
  code: number,
  wrappedBin = 'npm',
): boolean {
  if (code === 0) {
    return false
  }
  const trimmed = output.trim()
  if (trimmed === '') {
    // A nonzero exit with NO output at all: the wrapped command never ran —
    // it always says something, even failing.
    return true
  }
  // Drop the wrapper's own lines, then look for any evidence of the wrapped
  // command. An EOTP refusal or a usage error means it DID run and the
  // failure is its to report, not the wrapper's.
  const withoutWrapperLines = trimmed.replace(/^script:.*$/gm, '')
  return !new RegExp(`\\b${wrappedBin}\\b`, 'i').test(withoutWrapperLines)
}

export interface OtpChallenge {
  readonly authUrl: string
  readonly doneUrl: string
}

/**
 * The last whitespace-delimited token on the first line containing `marker`.
 * npm prints each URL alone at the end of its line, so the token IS the URL.
 *
 * Token scanning rather than a URL regex on purpose: these are URLs, not
 * filesystem paths, and normalizing them for a separator-regex match collapses
 * `https://` to `https:/` — which silently defeated the parse.
 */
export function urlAfterMarker(
  output: string,
  marker: string,
): string | undefined {
  const lines = output.split('\n')
  for (let i = 0, { length } = lines; i < length; i += 1) {
    const line = lines[i]!
    if (!line.includes(marker)) {
      continue
    }
    const token = line.trim().split(/\s+/).pop()
    if (token?.startsWith('https:')) {
      return token
    }
  }
  return undefined
}

export function parseOtpChallenge(output: string): OtpChallenge | undefined {
  const authUrl = urlAfterMarker(output, 'auth/cli/')
  const doneUrl = urlAfterMarker(output, 'v1/done?authId=')
  return authUrl && doneUrl ? { authUrl, doneUrl } : undefined
}

/**
 * Whether `url` resolves to something a person can approve. npm's CLI has
 * printed EOTP approval URLs for routes the website no longer serves — both the
 * `auth/cli` page and its paired done endpoint answered 404 on 2026-08-04 —
 * and opening a 404 tells the operator nothing. Checking first is what lets
 * this flow fall through to the login protocol that does work.
 */
export async function isUrlReachable(url: string): Promise<boolean> {
  try {
    const response = await httpRequest(url)
    return response.status < 400
  } catch {
    return false
  }
}

/**
 * A fresh approval flow from the registry's web-login protocol — the same
 * `/-/v1/login` call `login.mts` makes, whose URLs the website does serve.
 * `npm-auth-type: web` is load-bearing: the endpoint 401s a client that does
 * not declare web auth.
 */
export async function createLoginChallenge(): Promise<
  OtpChallenge | undefined
> {
  try {
    const created = await httpRequest('https://registry.npmjs.org/-/v1/login', {
      body: '{}',
      headers: {
        'content-type': 'application/json',
        'npm-auth-type': 'web',
        'npm-command': 'login',
      },
      method: 'POST',
    })
    if (!created.ok) {
      return undefined
    }
    const session = created.json<{
      doneUrl?: string | undefined
      loginUrl?: string | undefined
    }>()
    return session.loginUrl && session.doneUrl
      ? { authUrl: session.loginUrl, doneUrl: session.doneUrl }
      : undefined
  } catch {
    return undefined
  }
}

/**
 * A challenge whose URLs actually resolve. npm's own EOTP pair is preferred
 * when it works; when it 404s, the registry's web-login protocol
 * (`login.mts`, which posts `/-/v1/login` with `npm-auth-type: web`) issues a
 * session that does — and a completed web login elevates the account for the
 * same ~5-minute window an OTP would, which is all these writes need.
 */
export async function resolveUsableChallenge(
  probeOutput: string,
): Promise<OtpChallenge | undefined> {
  const printed = parseOtpChallenge(probeOutput)
  if (printed && (await isUrlReachable(printed.authUrl))) {
    return printed
  }
  if (printed) {
    logger.log(
      "npm's own approval URL is not reachable, so this run falls back to the " +
        'registry login protocol.',
    )
  }
  return await createLoginChallenge()
}

/**
 * How long to wait for the operator's browser approval, and how often to ask
 * the done endpoint. A person is opening a page and clicking, so the budget is
 * generous and the poll is slow.
 */
export const OTP_APPROVAL_BUDGET_MS = 5 * 60_000
export const OTP_POLL_MS = 3000

/**
 * Whether npm's done endpoint reports the approval as complete. It answers 202
 * while the operator has not finished and 200 with the token once they have.
 */
export type ApprovalPollResult = 'complete' | 'expired' | 'pending'

// The npm config key the elevated session token lands under, and the record
// of what was there before, so the run can put it back. A session token is a
// credential: leaving it persisted in the operator's npm config after the run
// would outlive the elevation it exists for.
const AUTH_TOKEN_KEY = '//registry.npmjs.org/:_authToken'
let persistedToken:
  | { neutralCwd: string; npmPath: string; prior: string | undefined }
  | undefined

/**
 * Restore the operator's npm config auth token to its pre-run value — the
 * prior token when one existed, deletion when the run introduced the key.
 * Safe to call when nothing was persisted. Runs in main's finally, so an
 * elevated session token never outlives the run that earned it.
 */
export async function restorePersistedAuthToken(): Promise<void> {
  const record = persistedToken
  persistedToken = undefined
  if (!record) {
    return
  }
  const { neutralCwd, npmPath, prior } = record
  const args = prior
    ? ['config', 'set', `${AUTH_TOKEN_KEY}=${prior}`]
    : ['config', 'delete', AUTH_TOKEN_KEY]
  await runCaptureBoth(npmPath, args, neutralCwd).catch(() => undefined)
  logger.info('restored the npm config auth token to its pre-run state.')
}

/**
 * One poll of the login protocol's done endpoint. `complete` persists the
 * elevated session token (recording what it replaced, for restore on exit);
 * `expired` means the approval session itself is GONE — npm expires them in
 * minutes, and polling a dead authId for the rest of the budget is the
 * 5-minute silent hang this state exists to kill; anything else is `pending`.
 */
export async function pollApproval(
  doneUrl: string,
  npmPath?: string | undefined,
  neutralCwd?: string | undefined,
): Promise<ApprovalPollResult> {
  try {
    const response = await httpRequest(doneUrl, {
      headers: { 'npm-auth-type': 'web', 'npm-command': 'login' },
    })
    if (response.status === 404 || response.status === 410) {
      return 'expired'
    }
    if (response.status !== 200) {
      return 'pending'
    }
    // The login protocol answers 200 with the session's token. Persisting it is
    // what makes the CLI use the newly elevated session; npm's own EOTP flow
    // returns no token and needs nothing saved.
    const { token } = response.json<{ token?: string | undefined }>()
    if (neutralCwd && npmPath && token) {
      if (!persistedToken) {
        const before = await runCaptureBoth(
          npmPath,
          ['config', 'get', AUTH_TOKEN_KEY],
          neutralCwd,
        ).catch(() => undefined)
        const prior = before?.output.trim()
        persistedToken = {
          neutralCwd,
          npmPath,
          prior: prior && prior !== 'undefined' ? prior : undefined,
        }
      }
      await runCaptureBoth(
        npmPath,
        ['config', 'set', `${AUTH_TOKEN_KEY}=${token}`],
        neutralCwd,
      )
      logger.info(
        'persisted the elevated npm session token (restored on exit).',
      )
    }
    return 'complete'
  } catch {
    return 'pending'
  }
}

export async function isApprovalComplete(
  doneUrl: string,
  npmPath?: string | undefined,
  neutralCwd?: string | undefined,
): Promise<boolean> {
  return (await pollApproval(doneUrl, npmPath, neutralCwd)) === 'complete'
}

/**
 * The slice of the sanctioned browser session the approval flow needs: a page
 * that can land on a URL, and a close. Structural on purpose, so a unit test
 * hands in a plain object instead of a playwright Page. `locator` is optional
 * — present on a real page, absent on a minimal fake — and gates the
 * cooldown opt-in tick.
 */
export interface ApprovalBrowserSession {
  close: () => Promise<void>
  page: CooldownTickablePage & { goto: (url: string) => Promise<unknown> }
}

// The one approval-browser session a run holds, launched lazily on the first
// approval URL and reused for every later one, so a batch's approvals land in
// ONE window.
let approvalSession: ApprovalBrowserSession | undefined

// The live cooldown watcher's stop handle, so a relaunch or a close never
// leaves an orphan pump ticking a dead page.
let stopCooldownWatch: (() => void) | undefined

/**
 * The injectable seam for the durable-profile launch, resolved to the real
 * sanctioned opener in production. A unit test swaps the property for a
 * scripted opener — plain assignment, no module mocking — so the approval
 * flow is testable without a browser.
 */
export const approvalSeams: {
  openSession: (options: { scope: string }) => Promise<ApprovalBrowserSession>
} = { openSession: openNpmBrowserSession }

/**
 * Open `url` where the operator can actually approve it. npm approval pages
 * only count when the viewing browser is signed in as the PUBLISH account,
 * and that session lives in the durable staged-browser profile — the
 * operator's default browser routinely is not (observed 2026-08-05: two runs
 * expired their approval budget on a page the default browser could not
 * approve). So: the sanctioned durable-profile session first, the default
 * browser as the fallback when that profile is held by another Chrome or
 * fails to launch.
 */
export async function openApprovalUrl(url: string): Promise<void> {
  if (!approvalSession) {
    // `scope` skips the sign-in wait: the approval PAGE is the destination,
    // and an operator who does need to sign in does it right there.
    approvalSession = await approvalSeams
      .openSession({ scope: 'otp-approval' })
      .catch(() => undefined)
  }
  if (approvalSession) {
    const landed = await approvalSession.page
      .goto(url)
      .then(() => true)
      .catch(() => false)
    if (landed) {
      logger.info('approval page opened in the durable npm profile window.')
      stopCooldownWatch?.()
      stopCooldownWatch = watchCooldownOptIn(approvalSession.page)
      return
    }
    // The window died — the operator closed it, or another Chrome took the
    // profile. Try ONE relaunch before the default-browser lane, whose lapsed
    // npm session is what expired two approval budgets (2026-08-05).
    approvalSession = await approvalSeams
      .openSession({ scope: 'otp-approval' })
      .catch(() => undefined)
    if (approvalSession) {
      const relanded = await approvalSession.page
        .goto(url)
        .then(() => true)
        .catch(() => false)
      if (relanded) {
        logger.info(
          'the approval window had closed; relaunched it in the durable profile.',
        )
        stopCooldownWatch?.()
        stopCooldownWatch = watchCooldownOptIn(approvalSession.page)
        return
      }
    }
  }
  // Last lane: the operator's DEFAULT browser, whose npm session may be
  // signed out or another account. Said out loud, because a page that CANNOT
  // approve looks identical to one nobody clicked.
  logger.warn(
    'the durable npm profile window is unavailable — opening the approval ' +
      'page in your DEFAULT browser. If it shows a sign-in, that is why the ' +
      'approval will not land.',
  )
  // A NEW WINDOW, not a tab: appended to the operator's own browsing session
  // this page is one tab among dozens, and it is the page the run is blocked
  // on. See _shared/open-url.mts for why the browser binary carries this and
  // the platform opener cannot.
  openUrlInNewWindow(url)
}

/**
 * Close the approval window once the run is done with approvals. Safe to call
 * when none was ever opened.
 */
export async function closeApprovalSession(): Promise<void> {
  stopCooldownWatch?.()
  stopCooldownWatch = undefined
  const session = approvalSession
  approvalSession = undefined
  if (session) {
    await session.close().catch(() => undefined)
  }
}

/**
 * Authenticate once before any read or write, so nine account operations cost
 * one approval — npm elevates the session for about five minutes.
 *
 * The probe is a read (`npm trust list`) because a read is idempotent: the
 * priming step must never be the thing that writes a row. On refusal this
 * OPENS the approval page in the operator's browser and polls npm's own done
 * endpoint until it reports success, so the URL never has to be copied out of
 * a log — which is what makes the flow work from a non-interactive session.
 */
export async function primeOtpSession(
  npmPath: string,
  probePkg: string,
  neutralCwd: string,
): Promise<boolean> {
  // Both streams: npm puts the refusal AND the approval URLs on stderr.
  const probe = await runCaptureBoth(
    npmPath,
    ['trust', 'list', probePkg],
    neutralCwd,
  )
  if (!isOtpRequired(probe.output)) {
    return true
  }
  const challenge = await resolveUsableChallenge(probe.output)
  if (!challenge) {
    logger.fail(
      'npm would not open an authentication flow this session.\n' +
        `  Where: ${npmPath} trust list ${probePkg}\n` +
        `  Saw:   ${probe.output.trim().slice(0, 200) || '(no output)'}\n` +
        "  Wanted: a reachable approval URL, from npm's EOTP message or the " +
        'registry login protocol.\n' +
        '  Fix:   configure the trusted publishers through the npmjs.com web UI ' +
        '(scripts/fleet/publish-infra/npm/trusted-publisher-browser.mts).',
    )
    return false
  }
  logger.log(
    'npm requires one browser approval before it will change trusted ' +
      'publishers. Opening the approval page now — approve it and this run ' +
      'continues on its own.',
  )
  // Open the page for the operator rather than printing a URL they would have
  // to copy: a redirected or piped run makes a printed URL unreachable.
  await openApprovalUrl(challenge.authUrl)
  const deadline = Date.now() + OTP_APPROVAL_BUDGET_MS
  while (Date.now() < deadline) {
    // One operator, one approval.
    // eslint-disable-next-line no-await-in-loop -- serial
    const poll = await pollApproval(challenge.doneUrl, npmPath, neutralCwd)
    if (poll === 'complete') {
      logger.success('approval received — continuing.')
      return true
    }
    if (poll === 'expired') {
      logger.fail(
        'the npm approval session expired before it was approved.\n' +
          '  What:  npm expires an approval page within minutes of opening it.\n' +
          `  Where: ${challenge.authUrl}\n` +
          '  Saw:   the done endpoint reported the session gone.\n' +
          '  Fix:   re-run and approve the page as soon as it opens.',
      )
      return false
    }
    // Not a retry ladder.
    // eslint-disable-next-line no-await-in-loop -- paced poll
    await sleep(OTP_POLL_MS)
  }
  return false
}

export async function main(): Promise<void> {
  try {
    await runTrust()
  } finally {
    // The approval window holds the durable profile's singleton lock; leaving
    // it open would make the NEXT run's approval fall back to the default
    // browser — the exact failure the window exists to prevent.
    await closeApprovalSession()
  }
}

async function runTrust(): Promise<void> {
  const flags = parseTrustArgs(process.argv.slice(2))
  // The target checkout owns both the package list and the platform tokens, so
  // it is resolved once and both reads follow it.
  const targetRepoRoot = resolveTargetRepoRoot(flags.repo)
  // No names given: configure everything the target repo publishes. Naming
  // packages stays supported for a one-off repair.
  const packages = flags.packages.length
    ? [...flags.packages]
    : enumerateRepoPackages(targetRepoRoot)
  if (!packages.length) {
    logger.fail(
      'no publishable packages found.\n' +
        '  What:  this flow configures a trusted publisher per published package.\n' +
        `  Where: ${targetRepoRoot}\n` +
        '  Saw:   no package arguments and no publishable manifest in the repo.\n' +
        '  Fix:   name the packages explicitly, or run from a repo that publishes — ' +
        'pnpm run npm:trust [@scope/pkg…] [--repo owner/name] [--apply]',
    )
    process.exitCode = 1
    return
  }
  const resolution = resolvePinnedNpm({
    home: os.homedir(),
    repoRoot: REPO_ROOT,
  })
  if (!resolution.npmPath) {
    logger.fail(`cannot resolve the pinned npm: ${resolution.refusal ?? ''}`)
    process.exitCode = 1
    return
  }
  const npmPath = resolution.npmPath
  // Neutral cwd: npm refuses to run inside a repo whose devEngines names pnpm.
  const neutralCwd = os.tmpdir()
  const versionRun = await runCapture(npmPath, ['--version'], neutralCwd)
  const npmVersion = versionRun.stdout.trim()
  if (!meetsMinimumVersion(npmVersion, MIN_NPM_VERSION)) {
    logger.fail(
      `the pinned npm is too old for \`npm trust\`.\n` +
        `  What:  trusted-publisher configuration needs npm ${MIN_NPM_VERSION} or newer.\n` +
        `  Where: ${npmPath}\n` +
        `  Saw:   npm ${npmVersion || '(unknown)'}; wanted >= ${MIN_NPM_VERSION}.\n` +
        `  Fix:   raise the .node-version pin to a Node whose bundled npm is ${MIN_NPM_VERSION}+.`,
    )
    process.exitCode = 1
    return
  }
  // `--repo owner/name` targets a SIBLING member's packages, so its platform
  // tokens come from that checkout — the cwd's config describes a different
  // repo and would plan every platform package onto the plain workflow.
  // Authenticate before the first read. Skipped for a dry run, which only
  // needs the plan — an unauthenticated dry run prints its packages as
  // "unreadable" and exits non-zero, never a fabricated "would configure".
  if (
    flags.apply &&
    !(await primeOtpSession(npmPath, packages[0]!, neutralCwd))
  ) {
    logger.fail(
      'npm did not accept a one-time password, so nothing was changed.\n' +
        '  What:  every `npm trust` call is an account operation and needs 2FA.\n' +
        `  Where: ${npmPath}\n` +
        '  Saw:   the authentication prompt did not complete.\n' +
        '  Fix:   run this command from an ATTACHED terminal — npm prints a URL ' +
        'and waits for the browser approval, which a detached/background run ' +
        'can never receive.',
    )
    process.exitCode = 1
    return
  }
  const napiPlatforms = readNapiPlatforms(targetRepoRoot)
  const plans: TrustPlan[] = []
  for (let p = 0, { length } = packages; p < length; p += 1) {
    const pkg = packages[p]!
    let desired = desiredTrustedPublisher({
      napiPlatforms,
      pkg,
      repoOverride: flags.repo,
    })
    if (!desired) {
      // No --repo and no rule matched the name. Two more contexts can answer:
      // the registry packument's `repository` field, then the sibling
      // checkouts (a FRESH reservation's packument carries nothing yet).
      // Npm rate-limits account reads.
      // eslint-disable-next-line no-await-in-loop -- sequential by design
      const derived =
        (await deriveRepoFromRegistry(npmPath, pkg, neutralCwd)) ??
        deriveRepoFromSiblings(pkg, path.dirname(REPO_ROOT))
      if (derived) {
        logger.info(`${pkg}: repository ${derived} (derived)`)
        desired = desiredTrustedPublisher({
          napiPlatforms: readNapiPlatforms(resolveTargetRepoRoot(derived)),
          pkg,
          repoOverride: derived,
        })
      }
    }
    if (!desired) {
      logger.fail(
        `cannot derive a repository for ${pkg}.\n` +
          '  What:  a trusted publisher names the GitHub repo that may publish.\n' +
          `  Where: ${pkg}\n` +
          '  Saw:   no --repo, the registry packument names no GitHub repository, ' +
          'and no sibling checkout publishes this name.\n' +
          '  Fix:   pass --repo <owner/name>.',
      )
      process.exitCode = 1
      continue
    }
    // Npm rate-limits account reads.
    // eslint-disable-next-line no-await-in-loop -- sequential by design
    let listRun = await runCaptureBoth(
      npmPath,
      ['trust', 'list', pkg],
      neutralCwd,
    )
    if (listRun.code !== 0 && !isOtpRequired(listRun.output)) {
      // One breath, one retry: npm's account-read rate limit recovers with a
      // pause; an OTP refusal does not, so it goes straight to unreadable.
      // The retry belongs to this package's turn.
      // eslint-disable-next-line no-await-in-loop -- the retry belongs
      await sleep(WRITE_SPACING_MS)
      // The retry belongs to this package's turn.
      // eslint-disable-next-line no-await-in-loop -- the retry belongs
      listRun = await runCaptureBoth(
        npmPath,
        ['trust', 'list', pkg],
        neutralCwd,
      )
    }
    const readable = listRun.code === 0 && !isOtpRequired(listRun.output)
    plans.push({
      desired,
      matches: readable && listOutputMatches(listRun.output, desired),
      pkg,
      readable,
      // Held from the read so a rebind can revoke the old connection first:
      // `npm trust` creates or revokes and never updates, so writing over an
      // existing connection answers 409 Conflict.
      trustId: trustConnectionId(listRun.output),
    })
  }
  const unreadable = plans.filter(plan => !plan.readable)
  const pending = plans.filter(plan => plan.readable && !plan.matches)
  logger.log(
    `npm trusted publishers — ${plans.length} package(s), ` +
      `${pending.length} to configure, ${unreadable.length} unreadable` +
      `${flags.apply ? '' : ' [dry-run]'}`,
  )
  for (let i = 0, { length } = plans; i < length; i += 1) {
    const plan = plans[i]!
    const label = plan.readable
      ? plan.matches
        ? 'conforms'
        : 'would configure'
      : 'unreadable'
    logger.log(
      `  ${plan.pkg}: ${label} — ${plan.desired.repositoryOwner}/` +
        `${plan.desired.repositoryName} ${plan.desired.workflowFilename} ` +
        `env ${plan.desired.environmentName}`,
    )
  }
  if (unreadable.length) {
    logger.fail(
      `${unreadable.length} package(s) could not be read.\n` +
        '  What:  every `npm trust list` is an account operation; a refused or ' +
        'rate-limited read says nothing about the row.\n' +
        `  Where: ${unreadable.map(plan => plan.pkg).join(', ')}\n` +
        '  Saw:   the read exited non-zero or asked for a one-time password.\n' +
        '  Fix:   authenticate (`pnpm run npm:login`) and re-run — an ' +
        'unreadable package is never written blind, a create over an existing ' +
        'connection answers 409.',
    )
    process.exitCode = 1
  }
  if (!flags.apply) {
    logger.log('Re-run with --apply to write these configurations.')
    return
  }
  if (!pending.length) {
    if (unreadable.length) {
      logger.log(
        'nothing to write — the unreadable package(s) above remain unproven.',
      )
    } else {
      logger.success('every named package already conforms — nothing to write.')
    }
    return
  }
  logger.log(formatAuthGate(pending.length))
  let configured = 0
  const failures: string[] = []
  // Packages whose write ran but whose result could not be read back. Held
  // apart from failures so the summary never claims a write failed when the
  // only thing that failed was reading it.
  const unverified: string[] = []
  for (let i = 0, { length } = pending; i < length; i += 1) {
    const plan = pending[i]!
    if (i > 0) {
      // One 2FA window, npm's own rate-limit guidance.
      // eslint-disable-next-line no-await-in-loop -- sequential
      await sleep(WRITE_SPACING_MS)
    }
    // A package that already carries a connection must lose it before the new
    // one is created: 409 Conflict is npm's answer to a create over an
    // existing trust, and it is what stopped 132 of 139 rebinds on 2026-08-06.
    if (plan.trustId) {
      // Shares the 2FA window with the write that follows.
      // eslint-disable-next-line no-await-in-loop -- sequential
      await runTrustWriteInteractive(
        npmPath,
        buildTrustRevokeArgs(plan.pkg, plan.trustId),
        neutralCwd,
      )
    }
    // A PTY makes npm take its interactive OTP path, which waits rather than
    // refusing; this answers that wait and opens the approval page.
    // Sequential writes share one 2FA window.
    // eslint-disable-next-line no-await-in-loop -- sequential writes share one
    const code = await runTrustWriteInteractive(
      npmPath,
      buildTrustWriteArgs(plan.pkg, plan.desired),
      neutralCwd,
    )
    // The verify belongs to this package's turn.
    // eslint-disable-next-line no-await-in-loop -- the verify belongs
    const verify = await runCaptureBoth(
      npmPath,
      ['trust', 'list', plan.pkg],
      neutralCwd,
    )
    if (code === 0 && listOutputMatches(verify.output, plan.desired)) {
      configured += 1
      logger.success(`${plan.pkg}: configured and verified.`)
      continue
    }
    // A REFUSED verify read is not a failed write. `npm trust list` needs the
    // same 2FA the write does, so a refusal says the row could not be READ —
    // reporting that as "did not verify" would claim knowledge this run does
    // not have, in the direction that hides a write that actually landed.
    if (isOtpRequired(verify.output)) {
      unverified.push(plan.pkg)
      logger.warn(formatUnverifiable(plan.pkg, plan.desired, code))
      continue
    }
    failures.push(plan.pkg)
    logger.fail(formatVerifyFailure(plan.pkg, plan.desired, verify.output))
  }
  const skipped = plans.length - pending.length - unreadable.length
  logger.log(
    `Trusted-publisher summary: ${configured} configured, ${skipped} already ` +
      `conforming, ${unreadable.length} unreadable, ` +
      `${unverified.length} unverifiable, ${failures.length} failed.`,
  )
  // An unverifiable package is an unfinished job, not a green one: the exit is
  // non-zero so a pipeline never treats "could not read" as "configured".
  if (failures.length || unverified.length) {
    process.exitCode = 1
  }
}

const SCRIPT_META: ScriptMeta = {
  describe:
    'configures npm trusted publishers for workspace packages through the npm trust registry API',
  help: `Usage: node scripts/fleet/publish-infra/npm/trust.mts [<pkg>…] [flags]

  --apply              perform the writes and verify each (dry-run by default)
  --repo <owner/name>  override the repository the trusted publisher binds to`,
}

if (isMainModule(import.meta.url)) {
  runMain(main, SCRIPT_META)
}

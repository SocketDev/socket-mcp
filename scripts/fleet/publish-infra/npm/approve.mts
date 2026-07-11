/**
 * @file `--approve` mode: list the user's staged packages, multi-select,
 *   run the pre-approve integrity gate, then batch-approve with one shared
 *   2FA OTP and create the git tag + GitHub release for each promoted
 *   package.
 */

import process from 'node:process'

import { checkbox, password } from '@socketsecurity/lib/stdio/prompts'

import { ensureTagAndRelease } from '../release.mts'
import { logger, rootPath, runInherit } from '../shared.mts'
import { isAlreadyPublished } from './registry.mts'
import type { StageListEntry } from './shared.mts'
import {
  fetchPriorProvenanceMap,
  formatPriorProvenance,
  listStagedPackages,
} from './shared.mts'
import { verifyStagedEntry } from './staged.mts'

/**
 * `--approve` mode: list the user's staged packages, multi-select, batch
 * approve with one OTP.
 *
 * Filters out any staged entries whose name@version is already public (e.g. a
 * re-stage after a partial approve). Empty selection is a no-op. The OTP is
 * read via a hidden-character prompt; a single OTP value is reused across all
 * approve calls in the same batch — npm accepts the same TOTP within its ~30s
 * validity window.
 */
export async function runApprove(options: {
  dryRun: boolean
  otpFromFlag: string | undefined
}): Promise<void> {
  const { dryRun, otpFromFlag } = {
    __proto__: null,
    ...options,
  } as typeof options
  const staged = await listStagedPackages()
  if (staged.length === 0) {
    logger.log('No packages currently staged.')
    return
  }

  // Filter out already-published versions. If a stage upload was
  // approved earlier but the entry lingers in stage list (registry
  // quirk), don't offer it for re-approval.
  const eligible: StageListEntry[] = []
  for (const entry of staged) {
    // eslint-disable-next-line no-await-in-loop
    if (
      entry.name &&
      entry.version &&
      !(await isAlreadyPublished(entry.name, entry.version, rootPath))
    ) {
      eligible.push(entry)
    }
  }
  if (eligible.length === 0) {
    logger.log('All staged entries are already published; nothing to approve.')
    return
  }

  // Fetch prior-version provenance for each unique package name so the
  // approver can spot regressions (last public version had provenance
  // but the staged one's parent name has lost trust metadata between
  // versions — a workflow drift signal). Cheap: one fetch per unique
  // name, abbreviated packument (no _npmUser needed; we only check
  // attestations presence as a proxy for "this name is OIDC-published").
  const priorProvenance = await fetchPriorProvenanceMap(eligible)

  const choices = eligible.map(e => ({
    name: `${e.name}@${e.version}${formatPriorProvenance(priorProvenance.get(e.name!))}`,
    value: e.stageId!,
    checked: true,
  }))
  const selected = (await checkbox({
    message: 'Select staged packages to approve:',
    choices,
  })) as string[] | undefined
  if (!selected || selected.length === 0) {
    logger.log('Nothing selected; exiting.')
    return
  }

  if (dryRun) {
    logger.log('[dry-run] would approve:')
    for (const stageId of selected) {
      const entry = eligible.find(e => e.stageId === stageId)
      logger.log(`  ${entry?.name}@${entry?.version} (id: ${stageId})`)
    }
    logger.success(
      `Dry-run complete. Re-run without --dry-run to prompt for OTP and promote.`,
    )
    return
  }

  // OTP resolution order:
  //   1. --otp <code> flag (CI / scripted use).
  //   2. Interactive prompt; entering a TOTP code uses it for all
  //      approvals; entering nothing falls through to pnpm's per-call
  //      web-OTP flow (the registry challenges and pnpm opens a browser
  //      window to npmjs.com for each approve call).
  // Passing the same TOTP to every approve in a batch is fine: npm
  // accepts the same code for the duration of its ~30s validity window.
  let otp = otpFromFlag
  if (!otp) {
    const entered = (await password({
      message:
        '2FA OTP (TOTP code for batch; leave blank for browser web-OTP):',
      mask: '*',
    })) as string | undefined
    if (entered) {
      otp = entered
    }
  }

  // Pre-approve integrity gate: verify EACH selected staged package before the
  // promote loop. A mismatch (or unresolvable staged digest) drops the entry;
  // if nothing survives, return before any `pnpm stage approve` runs so the
  // 2FA / OAuth promote is never reached on a divergent artifact.
  const verified: string[] = []
  for (const stageId of selected) {
    const entry = eligible.find(e => e.stageId === stageId)
    // eslint-disable-next-line no-await-in-loop
    if (entry && (await verifyStagedEntry(entry))) {
      verified.push(stageId)
    }
  }
  if (verified.length === 0) {
    logger.fail(
      'No selected package passed pre-approve verification; nothing approved.',
    )
    process.exitCode = 1
    return
  }
  if (verified.length < selected.length) {
    logger.fail(
      `${selected.length - verified.length}/${selected.length} failed pre-approve verify; ` +
        `approving only the ${verified.length} verified. Reject the rest (pnpm stage reject <id>).`,
    )
    process.exitCode = 1
  }

  let approved = 0
  let failed = 0
  const approvedEntries: StageListEntry[] = []
  for (let i = 0, { length } = verified; i < length; i += 1) {
    const stageId = verified[i]!
    const args = ['stage', 'approve', stageId]
    if (otp) {
      args.push('--otp', otp)
    }
    // eslint-disable-next-line no-await-in-loop
    const code = await runInherit('pnpm', args, rootPath)
    if (code === 0) {
      approved += 1
      const entry = eligible.find(e => e.stageId === stageId)
      if (entry) {
        approvedEntries.push(entry)
      }
    } else {
      failed += 1
      logger.fail(`Approve ${stageId} exited ${code}`)
    }
  }
  if (failed > 0) {
    logger.fail(`${failed}/${verified.length} failed; ${approved} approved`)
    process.exitCode = 1
    return
  }
  logger.success(`Approved ${approved} package${approved === 1 ? '' : 's'}`)

  // Approve is the moment a staged package becomes public, so the git tag +
  // GitHub release are created here rather than at --staged time. This runs
  // locally where git, gh, and npm are all authenticated; the CI --staged step
  // holds only an OIDC npm token (no contents:write / GH_TOKEN), so a release
  // attempt there fails and is also premature (nothing is public yet).
  for (let i = 0, { length } = approvedEntries; i < length; i += 1) {
    const entry = approvedEntries[i]!
    if (entry.name && entry.version) {
      // eslint-disable-next-line no-await-in-loop
      await ensureTagAndRelease({ name: entry.name, version: entry.version })
    }
  }
}

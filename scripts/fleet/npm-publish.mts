/*
 * @file Fleet-canonical publish runner. Three modes: --staged Upload this
 *   package's tarball to npm staging via `pnpm stage publish`. Designed to run
 *   in CI under the OIDC trusted-publisher token. Nothing publicly visible
 *   until --approve runs. Adds `--provenance` automatically when GITHUB_ACTIONS
 *   is set. THIS IS THE DEFAULT path — staging gives `pnpm stage reject` a
 *   server-side rescue for botched uploads (wrong file, wrong checksum, wrong
 *   version) before anything goes public. --approve Interactive multi-select
 *   over the user's currently-staged packages, then batch `pnpm stage approve
 *   <id>` with a single shared 2FA OTP. Designed to run locally. OTP resolution
 *   order:
 *
 *   1. `--otp <code>` flag (CI / scripted use).
 *   2. Interactive `password` prompt (lib/stdio/prompts).
 *   3. Empty prompt input → pnpm's per-call web-OTP flow (registry challenge opens
 *      a browser window to npmjs.com per approve call). --direct Classic
 *      single-step `pnpm publish` — uploads + makes public in one call, no
 *      stage/approve. Escape hatch for environments where the stage endpoint is
 *      unreachable (e.g. an SFW build without the `/-/stage/*` endpoint
 *      allowlist). Same provenance + OIDC token shape as --staged when
 *      GITHUB_ACTIONS is set. Trades server-side rejectability for fewer hops;
 *      only use when the stage path can't reach npm. Prefer --staged whenever
 *      the network allows it. --dry-run Forwarded to the underlying pnpm
 *      command. Used to preview the tarball + manifest without registry writes.
 *      The staged/approve split is a hard requirement of npm's staged-publish
 *      flow: the stage upload uses an OIDC token from CI; the approve step
 *      requires human 2FA. Combining them in one mode would either leak the OTP
 *      into CI logs or require a human at the CI keyboard. Repos with bespoke
 *      publish pipelines (socket-addon's 9-package OIDC + .node verification,
 *      socket-registry's monorepo package-npm-publish delegation, etc.) keep
 *      their own publish.mts and don't adopt this canonical version. Repos with
 *      simple single-package publishing consume this one byte-identical via the
 *      sync-scaffolding cascade.
 *
 *   This file is the thin entry: arg parsing + mode dispatch. The
 *   implementation lives under `publish-infra/`, organized in registry tiers
 *   so a future `cargo-publish.mts` slots in beside npm: the agnostic core
 *   (`publish-infra/shared.mts` — spawn/git/JSON helpers,
 *   `publish-infra/release.mts` — git tag + GitHub release) and the npm tier
 *   (`publish-infra/npm/` — registry reads, staged/direct modes, the bump
 *   step, and the approve flow).
 */

import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { parseArgs } from '@socketsecurity/lib-stable/argv/parse'

import { runApprove } from './publish-infra/npm/approve.mts'
import { resolveBumpScript, runBump } from './publish-infra/npm/bump.mts'
import {
  isStagingExpected,
  readStagedShasum,
} from './publish-infra/npm/shared.mts'
import {
  runDirect,
  runStaged,
  verifyStagedEntry,
} from './publish-infra/npm/staged.mts'
import {
  ensureTagAndRelease,
  extractChangelogSection,
} from './publish-infra/release.mts'
import { logger } from './publish-infra/shared.mts'

export {
  ensureTagAndRelease,
  extractChangelogSection,
  isStagingExpected,
  readStagedShasum,
  resolveBumpScript,
  verifyStagedEntry,
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      approve: { default: false, type: 'boolean' },
      bump: { default: false, type: 'boolean' },
      direct: { default: false, type: 'boolean' },
      'dry-run': { default: false, type: 'boolean' },
      help: { default: false, type: 'boolean' },
      otp: { type: 'string' },
      'release-as': { type: 'string' },
      staged: { default: false, type: 'boolean' },
      tag: { default: 'latest', type: 'string' },
    },
    allowPositionals: false,
    strict: false,
  })

  if (
    values['help'] ||
    (!values['staged'] && !values['approve'] && !values['direct'])
  ) {
    logger.log(
      'Usage: pnpm publish --staged | --approve | --direct [--dry-run] [--otp <code>]',
    )
    logger.log('')
    logger.log(
      '  --staged             CI: upload to npm staging via OIDC (recommended)',
    )
    logger.log('  --approve            local: multi-select + 2FA promote')
    logger.log(
      '  --direct             classic `pnpm publish` — public in one step,',
    )
    logger.log(
      '                       no stage/approve. Escape hatch when the stage',
    )
    logger.log(
      '                       endpoint is unreachable (errors if staging is',
    )
    logger.log('                       available — use --staged instead).')
    logger.log('  --dry-run            simulate; no registry writes')
    logger.log(
      '  --otp <code>         pre-supply 2FA (skips OTP prompt on --approve)',
    )
    logger.log('  --tag <tag>          dist-tag for --staged (default: latest)')
    logger.log(
      '  --bump               CI: bump version + CHANGELOG, commit via the',
    )
    logger.log(
      '                       release App (signed), then run the chosen mode',
    )
    logger.log(
      '  --release-as <lvl>   force bump level major|minor|patch (with --bump)',
    )
    process.exitCode = values['help'] ? 0 : 1
    return
  }

  const modes = [values['staged'], values['approve'], values['direct']].filter(
    Boolean,
  ).length
  if (modes > 1) {
    logger.fail('Pass exactly one of --staged / --approve / --direct.')
    process.exitCode = 1
    return
  }

  const dryRun = !!values['dry-run']
  const otpFromFlag =
    typeof values['otp'] === 'string' ? values['otp'] : undefined
  const releaseAs =
    typeof values['release-as'] === 'string' ? values['release-as'] : undefined
  // CI release path: `--staged --bump` bumps + commits (via the release App)
  // before staging, so the publish targets the bumped tree.
  if (values['bump']) {
    await runBump({ dryRun, releaseAs })
  }
  if (values['staged']) {
    await runStaged(String(values['tag']), { dryRun })
  } else if (values['direct']) {
    await runDirect(String(values['tag']), { dryRun })
  } else {
    await runApprove({ dryRun, otpFromFlag })
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e: unknown) => {
    logger.error(e)
    process.exitCode = 1
  })
}

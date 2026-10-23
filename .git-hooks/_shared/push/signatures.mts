// Pre-push commit-signature gate. Requires a verified signature on every commit
// pushed to a protected ref, default branch, and — when SSH signing is
// configured with an allowed_signers file — cross-checks each signing key
// against that allowlist.

import crypto from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'

import process from 'node:process'

import { getDefaultLogger } from '@socketsecurity/lib-stable/logger/default'
import { debugCheck } from '../check-output.mts'

import { git, gitLines } from '../git.mts'

const logger = getDefaultLogger()

// Scans every commit in the range to require a verified signature
// when pushing to a protected ref, default branch. Block on `N`
// no signature, and `B` (bad/unverifiable) — but allow other
// markers like `G` (good GPG sig), `U` (good GPG sig, unknown trust),
// `E`, missing-key but otherwise valid, `X` (good signature on
// expired key), `Y`/`R` (revoked/expired key with good signature).
//
// Why pre-push and not just rely on GitHub branch protection? The
// fleet enforces branch protection too (lint-github-settings.mts
// audits `required_signatures: true`), but a local pre-push fail
// gives faster feedback (no round-trip to GitHub) and catches the
// case where branch protection is being set up but not yet active
// on a freshly-created fleet repo.

// Parse the SSH allowed_signers file referenced by
// `git config --get gpg.ssh.allowedSignersFile`. Returns the set of
// SSH key fingerprints (the same format `git log --format=%GK` emits).
//
// Returns an empty set if:
//   - gpg.format isn't 'ssh', allowed-signers only applies to SSH-format
//   - gpg.ssh.allowedSignersFile is unset
//   - the file doesn't exist or can't be read
// An empty set means "don't enforce" — the %G? marker check alone
// remains active. This degrades gracefully on first install before
// the user has set up allowed_signers.
function decodeSignerKey(keyType: string, keyBlob: string): Buffer | undefined {
  const key = Buffer.from(keyBlob, 'base64')
  const canonicalBlob = key.toString('base64')
  if (
    key.length === 0 ||
    (keyBlob !== canonicalBlob &&
      keyBlob !== canonicalBlob.replace(/=+$/u, '')) ||
    key.length < 4
  ) {
    return
  }
  const keyTypeLength = key.readUInt32BE(0)
  if (
    keyTypeLength === 0 ||
    keyTypeLength > key.length - 4 ||
    key.toString('utf8', 4, 4 + keyTypeLength) !== keyType
  ) {
    return
  }
  return key
}

export function parseAllowedSignerFingerprints(contents: string): Set<string> {
  const out = new Set<string>()
  const rawLines = contents.split(/\r?\n/)
  for (let i = 0, { length } = rawLines; i < length; i += 1) {
    const rawLine = rawLines[i]!
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) {
      continue
    }
    const fields =
      /^(?<principal>\S+)\s+(?:(?<options>(?:[a-z][a-z-]*(?:=(?:"(?:[^"\\]|\\.)*"|[^,\s]+))?)(?:,(?:[a-z][a-z-]*(?:=(?:"(?:[^"\\]|\\.)*"|[^,\s]+))?))*)\s+)?(?<keyType>(?:ecdsa-|sk-|ssh-)[A-Za-z\d@._+-]+)\s+(?<keyBlob>[A-Za-z\d+/]+={0,2})(?:\s+.*)?$/u.exec(
        line,
      )
    const keyType = fields?.groups?.['keyType']
    const keyBlob = fields?.groups?.['keyBlob']
    if (!keyType || !keyBlob) {
      continue
    }
    const key = decodeSignerKey(keyType, keyBlob)
    if (!key) {
      continue
    }
    const digest = crypto.createHash('sha256').update(key).digest('base64')
    out.add(`SHA256:${digest.replace(/=+$/u, '')}`)
  }
  return out
}

export function readAllowedSignerFingerprints(): Set<string> {
  try {
    const fmt = git('config', '--get', 'gpg.format').trim()
    if (fmt !== 'ssh') {
      return new Set()
    }
    const file = git('config', '--get', 'gpg.ssh.allowedSignersFile').trim()
    if (!file) {
      return new Set()
    }
    const expanded = file.startsWith('~')
      ? file.replace(/^~/, () => process.env['HOME'] ?? '')
      : file
    if (!existsSync(expanded)) {
      return new Set()
    }
    return parseAllowedSignerFingerprints(readFileSync(expanded, 'utf8'))
  } catch {
    // best-effort; absence of allowed-signers shouldn't crash the hook
    return new Set()
  }
}

interface SignatureVerdict {
  unsigned: string[]
  unauthorized: string[]
}

// Sorts one `%H %G? %GK` line per commit into the two blocking buckets.
export function classifyCommitSignatures(
  lines: string[],
  allowedSigners: Set<string>,
): SignatureVerdict {
  const unsigned: string[] = []
  const unauthorized: string[] = []
  for (let i = 0, { length } = lines; i < length; i += 1) {
    const line = lines[i]!
    const parts = line.split(' ')
    const sha = parts[0]
    const marker = parts[1]
    const signerKey = parts.slice(2).join(' ').trim()
    if (!sha || !marker) {
      continue
    }
    // `N` = no signature. `B` = bad signature. Both block.
    if (marker === 'B' || marker === 'N') {
      unsigned.push(sha)
      continue
    }
    // Allowed-signers cross-check, SSH-signed commits only. `G`
    // means git verified the signature against SOME key it trusts —
    // but "any trusted key" includes attacker-controlled keys on a
    // compromised dev machine. The authorized-signer file pins down
    // which keys we accept for the protected branch.
    if (
      allowedSigners.size > 0 &&
      signerKey.startsWith('SHA256:') &&
      signerKey &&
      !allowedSigners.has(signerKey)
    ) {
      unauthorized.push(`${sha} (signed by ${signerKey.slice(0, 16)}…)`)
    }
  }
  return { unauthorized, unsigned }
}

// Prints the operator-facing failure report for both buckets.
function reportSignatureFailures(
  verdict: SignatureVerdict,
  refBase: string,
): void {
  const { unauthorized, unsigned } = verdict
  if (unauthorized.length > 0) {
    logger.error(
      `${unauthorized.length} commit(s) signed by a key NOT in gpg.ssh.allowedSignersFile:`,
    )
    for (let i = 0, { length } = unauthorized; i < length; i += 1) {
      const u = unauthorized[i]!
      logger.error(`  ${u}`)
    }
  }
  const errors = unsigned.length + unauthorized.length
  logger.fail(`${errors} unsigned commit(s) being pushed to ${refBase}.`)
  const shaList = unsigned.slice(0, 5)
  for (let j = 0, { length: jlen } = shaList; j < jlen; j += 1) {
    const sha = shaList[j]!
    const oneline = git('log', '-1', '--oneline', sha)
    logger.info(`  - ${oneline}`)
  }
  if (unsigned.length > 5) {
    logger.info(`  ... and ${unsigned.length - 5} more`)
  }
  logger.info('')
  logger.info('Fix: rebase + re-sign the commits.')
  logger.info(`  git rebase --exec 'git commit --amend --no-edit -S' <base>`)
}

export function scanSignedCommits(range: string, remoteRef: string): number {
  // Only enforce on default-branch refs (main / master). Feature
  // branches and topic branches can stay unsigned during development;
  // signing is required at the point of landing on the protected ref.
  const refBase = remoteRef.replace(/^refs\/heads\//, '')
  if (refBase !== 'main' && refBase !== 'master') {
    return 0
  }
  debugCheck('Checking commit signatures…')
  // %G? — signature verification marker (G/U/E/X/Y/R/N/B).
  // %GK — signing key fingerprint, empty if unsigned.
  // %GS — signer name, from key user-id.
  // Cross-check %GK against gpg.ssh.allowedSignersFile when configured
  // and `gpg.format = ssh`. For gpg-format signatures, %G? alone
  // reflects the local keyring's trust, which is sufficient for our
  // threat model (the attacker would need to control the dev's
  // ~/.gnupg, at which point the local box is fully owned).
  const lines = gitLines('log', '--format=%H %G? %GK', range)
  const allowedSigners = readAllowedSignerFingerprints()
  const verdict = classifyCommitSignatures(lines, allowedSigners)
  const errors = verdict.unsigned.length + verdict.unauthorized.length
  if (errors === 0) {
    return 0
  }
  reportSignatureFailures(verdict, refBase)
  return errors
}

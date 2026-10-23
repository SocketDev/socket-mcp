import { parseRemoteCiGitHubPushUrl } from '../../../scripts/fleet/ci/gates/remote-target.mts'
import {
  readInitializationReceipt,
  verifyLocalGenesis,
} from '../../../scripts/fleet/release/record/genesis.mts'
import { RELEASE_RECORD_BRANCH } from '../../../scripts/fleet/release/record/model.mts'

export async function verifyReleaseLedgerGenesisPush(
  lines: readonly string[],
  destination: string,
  repositoryPath: string,
): Promise<boolean> {
  if (lines.length !== 1) {
    return false
  }
  const fields = lines[0]!.trim().split(/\s+/u)
  const [, candidateSha, remoteRef, remoteSha] = fields
  if (
    fields.length !== 4 ||
    remoteRef !== `refs/heads/${RELEASE_RECORD_BRANCH}` ||
    remoteSha !== '0'.repeat(40)
  ) {
    return false
  }
  const repository = parseRemoteCiGitHubPushUrl(destination)
  if (!repository) {
    return false
  }
  const receipt = readInitializationReceipt(repository, repositoryPath)
  if (
    !receipt ||
    receipt.state !== 'pending' ||
    receipt.sha !== candidateSha ||
    receipt.ref !== remoteRef ||
    !receipt.freshSetup
  ) {
    return false
  }
  await verifyLocalGenesis(repository, candidateSha!, repositoryPath)
  return true
}

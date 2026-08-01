/*
 * @file The backup-branch retention policy, as pure data + pure functions —
 *   no git, no network, so every rule here is unit-testable without a fixture
 *   repo. `../prune-backup-branches.mts` supplies the discovered refs and
 *   performs the deletes.
 *
 *   A backup branch is a REWRITE SAFETY NET: something force-pushed history
 *   and parked the pre-rewrite tip so the old commits stay reachable. Once the
 *   rewrite is verified, the net is spent. They are never pruned by anything
 *   else, so they accumulate silently — 87 refs across 18 fleet repos when this
 *   was written, the oldest two weeks stale.
 *
 *   Two independent retention rules, and a ref must satisfy BOTH to be a
 *   candidate. Keeping the newest N covers "the rewrite was minutes ago and I
 *   may still need it"; the age window covers "this repo rewrites constantly,
 *   so N alone would keep a wall of same-day nets."
 */

// Backup refs the fleet creates, both shapes:
//   - `backup-<YYYYMMDD>-<HHMMSS>` — a scripted pre-rewrite snapshot.
//   - `backup/<slug>` — a hand-parked worktree tip.
// Anchored so a branch merely CONTAINING the word (`feat/backup-restore`) is
// never a candidate. Note: a miss here is safe because the branch is left
// alone, while a false match would delete a real branch, so the patterns stay
// narrow.
export const BACKUP_REF_PATTERNS: readonly RegExp[] = [
  /^backup-\d{8}-\d{6}$/,
  /^backup\/[\w.-]+$/,
]

export function isBackupBranchName(name: string): boolean {
  for (let i = 0, { length } = BACKUP_REF_PATTERNS; i < length; i += 1) {
    if (BACKUP_REF_PATTERNS[i]!.test(name)) {
      return true
    }
  }
  return false
}

// Newest N backup refs always survive, per repo, regardless of age. The most
// recent net is the one an operator is most likely to still want.
export const KEEP_DEFAULT = 3
// A backup younger than this is never pruned, even past --keep. Two weeks is
// past any plausible "I might still need to diff against that" window.
export const DAYS_DEFAULT = 14

export interface BackupRef {
  // Branch name without the remote prefix, e.g. `backup-20260801-104615`.
  readonly name: string
  // Commit date in epoch milliseconds; the sort key and the age input.
  readonly committedAtMs: number
}

export interface RetentionConfig {
  readonly keep?: number | undefined
  readonly days?: number | undefined
  readonly nowMs: number
}

export interface RetentionVerdict {
  readonly ref: BackupRef
  readonly prunable: boolean
  // Why it survived, for the report. Undefined when prunable.
  readonly keptBecause?: string | undefined
}

/**
 * Apply the retention policy to one repo's backup refs, newest first.
 *
 * A ref is prunable only when it is BOTH outside the newest `keep` AND older
 * than the `days` window. Anything the policy spares carries the reason, so a
 * dry run explains every survivor instead of silently listing a subset.
 */
export function applyRetention(
  refs: readonly BackupRef[],
  config: RetentionConfig,
): RetentionVerdict[] {
  const cfg = { __proto__: null, ...config } as RetentionConfig
  const keep = cfg.keep ?? KEEP_DEFAULT
  const days = cfg.days ?? DAYS_DEFAULT
  const cutoffMs = cfg.nowMs - days * 24 * 60 * 60 * 1000
  // Newest first, so index < keep is the survivor window. Ties broken by name
  // for a deterministic order — two snapshots can share a second.
  const sorted = [...refs].toSorted((a, b) => {
    const byDate = b.committedAtMs - a.committedAtMs
    return byDate === 0 ? a.name.localeCompare(b.name) : byDate
  })
  const verdicts: RetentionVerdict[] = []
  for (let i = 0, { length } = sorted; i < length; i += 1) {
    const ref = sorted[i]!
    if (i < keep) {
      verdicts.push({
        keptBecause: `within the newest ${keep}`,
        prunable: false,
        ref,
      })
      continue
    }
    if (ref.committedAtMs > cutoffMs) {
      verdicts.push({
        keptBecause: `younger than ${days} days`,
        prunable: false,
        ref,
      })
      continue
    }
    verdicts.push({ prunable: true, ref })
  }
  return verdicts
}

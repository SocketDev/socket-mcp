import { spawnSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'

import { isMainModule, runMain } from './cli.mts'
import type { ScriptMeta } from './cli.mts'
import { REPO_ROOT } from './paths.mts'
import { formatScanHits, readWorkingTreeFile, scanFiles } from './util/scan.mts'

export function main(): void {
  const listed = spawnSync('git', ['ls-files', '-z'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
  if (listed.status !== 0) {
    throw new Error(`git ls-files failed: ${listed.stderr.trim()}`)
  }
  const files = listed.stdout.split('\0').filter(Boolean)
  const hits = scanFiles(files, file =>
    readWorkingTreeFile(path.join(REPO_ROOT, file)),
  )
  if (hits.length > 0) {
    process.stderr.write(
      `Tracked files contain secrets, personal paths, or private names:\n${formatScanHits(hits)}\n`,
    )
    process.exitCode = 1
    return
  }
  process.stdout.write(`Scanned ${files.length} tracked files.\n`)
}

const SCRIPT_META: ScriptMeta = {
  describe:
    'scans tracked files for secrets, personal paths, and private names',
  help: 'Usage: pnpm run repo:scan',
}
if (isMainModule(import.meta.url)) {
  runMain(main, SCRIPT_META)
}

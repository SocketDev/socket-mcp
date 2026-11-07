import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { REPO_ROOT } from './paths.mts'

if (!existsSync(path.join(REPO_ROOT, '.git')) || process.env['CI']) {
  process.exit(0)
}
const result = spawnSync('git', ['config', 'core.hooksPath', '.git-hooks'], {
  cwd: REPO_ROOT,
  stdio: 'inherit',
})
process.exitCode = result.status ?? 1

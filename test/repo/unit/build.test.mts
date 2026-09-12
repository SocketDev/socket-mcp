import { spawnSync } from 'node:child_process'
import process from 'node:process'
import { expect, test } from 'vitest'
import { REPO_ROOT } from '../../../scripts/repo/paths.mts'

test('prints build command help', () => {
  const result = spawnSync(
    process.execPath,
    ['scripts/repo/build.mts', '--help'],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 10_000,
    },
  )
  expect(result.status).toBe(0)
  expect(result.stdout).toContain('Usage: pnpm run build:bundle')
})

import path from 'node:path'
import process from 'node:process'
import { spawn } from '@socketsecurity/lib-stable/process/spawn/child'
import { expect, test } from 'vitest'
import { main } from '../../../scripts/repo/fuzz.mts'

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..')

test('prints fuzz command help', async () => {
  const result = await spawn(
    process.execPath,
    ['scripts/repo/fuzz.mts', '--help'],
    {
      cwd: repoRoot,
      localTimeout: 10_000,
      stdio: 'pipe',
      throws: false,
    },
  )
  expect(main).toBeTypeOf('function')
  expect(result.code).toBe(0)
  expect(result.stdout).toContain('Usage: pnpm run test:fuzz')
})

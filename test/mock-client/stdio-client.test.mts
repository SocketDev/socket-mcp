import path from 'node:path'
import process from 'node:process'
import { spawn } from '@socketsecurity/lib-stable/process/spawn/child'
import { expect, test } from 'vitest'
import { main } from '../../mock-client/stdio-client.mts'

const repoRoot = path.resolve(import.meta.dirname, '..', '..')

test('prints stdio client help before connecting', async () => {
  const result = await spawn(
    process.execPath,
    ['mock-client/stdio-client.mts', '--help'],
    { cwd: repoRoot, localTimeout: 10_000, stdio: 'pipe', throws: false },
  )
  expect(main).toBeTypeOf('function')
  expect(result.code).toBe(0)
  expect(result.stdout).toContain('Usage: pnpm run debug-sdk')
})

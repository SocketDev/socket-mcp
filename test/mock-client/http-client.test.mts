import path from 'node:path'
import process from 'node:process'
import { spawn } from '@socketsecurity/lib-stable/process/spawn/child'
import { expect, test } from 'vitest'
import { testHTTPMode } from '../../mock-client/http-client.mts'

const repoRoot = path.resolve(import.meta.dirname, '..', '..')

test('prints http client help before connecting', async () => {
  const result = await spawn(
    process.execPath,
    ['mock-client/http-client.mts', '--help'],
    { cwd: repoRoot, localTimeout: 10_000, stdio: 'pipe', throws: false },
  )
  expect(testHTTPMode).toBeTypeOf('function')
  expect(result.code).toBe(0)
  expect(result.stdout).toContain('Usage: pnpm run debug-http')
})

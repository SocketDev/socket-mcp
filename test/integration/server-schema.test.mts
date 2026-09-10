import { spawn } from '@socketsecurity/lib-stable/process/spawn/child'
import { expect, test } from 'vitest'

import { REPO_ROOT } from '../../scripts/fleet/paths.mts'

test('MCP tool schemas match the reviewed contract', async () => {
  const result = await spawn('pnpm', ['run', 'mcp:schema:check'], {
    cwd: REPO_ROOT,
    stdio: 'pipe',
    throws: false,
    localTimeout: 15_000,
  })
  expect(result.code, result.stdout).toBe(0)
})

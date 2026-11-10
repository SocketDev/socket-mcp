import { afterEach, describe, expect, it, vi } from 'vitest'
const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawnSync: spawn }))
import { dispatchNpmPublish } from '../../../scripts/repo/npm/dispatch.mts'

afterEach(() => {
  spawn.mockReset()
  process.exitCode = undefined
})

describe('npm release dispatch', () => {
  it('dispatches the no-argument workflow on the default branch', () => {
    spawn
      .mockReturnValueOnce({ status: 0, stdout: 'SocketDev/socket-mcp' })
      .mockReturnValueOnce({ status: 0, stdout: 'main' })
      .mockReturnValueOnce({ status: 0 })
    dispatchNpmPublish()
    expect(spawn.mock.calls[2]?.[1]).toEqual([
      'workflow',
      'run',
      'publish-npm.yml',
      '--repo',
      'SocketDev/socket-mcp',
      '--ref',
      'main',
    ])
  })
})

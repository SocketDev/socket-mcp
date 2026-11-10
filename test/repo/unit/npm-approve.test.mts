import { expect, it, vi } from 'vitest'
import {
  approveNpmStage,
  validateStage,
} from '../../../scripts/repo/npm/approve.mts'
import type { ReleasePolicy } from '../../../scripts/repo/npm/release-policy.mts'

const id = '12345678-1234-4123-8123-123456789abc'
const prereleasePolicy: ReleasePolicy = {
  mode: 'prerelease-only',
  versionHint: '2.1.0',
  identifier: 'rc',
  distTag: 'prerelease-2.1.0',
}

it('validates npm stage identity while accepting a remote version ahead of the checkout', () => {
  expect(
    validateStage(
      {
        id,
        packageName: '@socketsecurity/mcp',
        version: '8.1.0',
        status: 'staged',
      },
      id,
      '@socketsecurity/mcp',
    ),
  ).toBe('8.1.0')
  expect(() =>
    validateStage(
      { id, packageName: 'other', version: '8.1.0' },
      id,
      '@socketsecurity/mcp',
    ),
  ).toThrow()
  expect(() =>
    validateStage(
      { id: 'bad', packageName: '@socketsecurity/mcp', version: '8.1.0' },
      id,
      '@socketsecurity/mcp',
    ),
  ).toThrow()
})

it('applies prerelease policy when validating the stage for approval', () => {
  expect(
    validateStage(
      {
        id,
        packageName: '@socketsecurity/mcp',
        version: '2.1.0-rc.3',
      },
      id,
      '@socketsecurity/mcp',
      prereleasePolicy,
    ),
  ).toBe('2.1.0-rc.3')
  expect(() =>
    validateStage(
      { id, packageName: '@socketsecurity/mcp', version: '2.1.0' },
      id,
      '@socketsecurity/mcp',
      prereleasePolicy,
    ),
  ).toThrow('must stay on the 2.1.0-rc.N prerelease track')
})

it('does not dispatch when npm approval fails', async () => {
  const calls: string[] = []
  const command = (name: string, args: string[]) => {
    calls.push(`${name} ${args.join(' ')}`)
    if (name === 'pnpm' && args[1] === 'approve')
      throw new Error('approval failed')
    if (name === 'pnpm')
      return JSON.stringify({
        id,
        packageName: '@socketsecurity/mcp',
        version: '8.1.0',
        status: 'staged',
      })
    if (name === 'gh' && args[0] === 'repo')
      return JSON.stringify({
        nameWithOwner: 'socketdev/socket-mcp',
        defaultBranchRef: { name: 'main' },
      })
    if (name === 'gh' && args[0] === 'api')
      return JSON.stringify({
        encoding: 'base64',
        content: Buffer.from(
          JSON.stringify({ name: '@socketsecurity/mcp', version: '8.1.0' }),
        ).toString('base64'),
      })
    return ''
  }
  await expect(
    approveNpmStage(id, '@socketsecurity/mcp', command),
  ).rejects.toThrow('approval failed')
  expect(calls.some(call => call.includes('workflow run'))).toBe(false)
})

it.each(['blocked', 'deleted'])(
  'does not approve or dispatch a %s stage',
  async status => {
    const calls: string[] = []
    const command = (name: string, args: string[]) => {
      calls.push(`${name} ${args.join(' ')}`)
      return JSON.stringify({
        id,
        packageName: '@socketsecurity/mcp',
        version: '8.1.0',
        status,
      })
    }
    await expect(
      approveNpmStage(id, '@socketsecurity/mcp', command),
    ).rejects.toThrow(`npm stage is ${status}`)
    expect(calls).toHaveLength(1)
  },
)

it('prints a concrete release-only retry after dispatch failure', async () => {
  const calls: string[] = []
  const command = (name: string, args: string[]) => {
    calls.push(`${name} ${args.join(' ')}`)
    if (name === 'gh' && args[0] === 'workflow')
      throw new Error('dispatch failed')
    if (name === 'pnpm')
      return JSON.stringify({
        id,
        packageName: '@socketsecurity/mcp',
        version: '8.1.0',
        status: 'staged',
      })
    if (name === 'gh' && args[0] === 'repo')
      return JSON.stringify({
        nameWithOwner: 'socketdev/socket-mcp',
        defaultBranchRef: { name: 'main' },
      })
    if (name === 'gh' && args[0] === 'api')
      return JSON.stringify({
        encoding: 'base64',
        content: Buffer.from(
          JSON.stringify({ name: '@socketsecurity/mcp', version: '8.1.0' }),
        ).toString('base64'),
      })
    return ''
  }
  const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  await expect(
    approveNpmStage(id, '@socketsecurity/mcp', command),
  ).rejects.toThrow('dispatch failed')
  expect(String(write.mock.calls[0]?.[0])).toContain(
    'gh workflow run release-github.yml --repo socketdev/socket-mcp --ref main -f tag=v8.1.0',
  )
  expect(calls.filter(call => call.includes('stage approve'))).toHaveLength(1)
  write.mockRestore()
})

it('waits for validating to become staged, then approves and dispatches once', async () => {
  const calls: Array<{ command: string; args: string[]; inherit: boolean }> = []
  const statuses = ['validating', 'staged']
  const command = (name: string, args: string[], inherit = false) => {
    calls.push({ command: name, args, inherit })
    if (name === 'pnpm' && args[1] === 'view')
      return JSON.stringify({
        id,
        packageName: '@socketsecurity/mcp',
        version: '8.1.0',
        status: statuses.shift(),
      })
    if (name === 'gh' && args[0] === 'repo')
      return JSON.stringify({
        nameWithOwner: 'socketdev/socket-mcp',
        defaultBranchRef: { name: 'main' },
      })
    if (name === 'gh' && args[0] === 'api')
      return JSON.stringify({
        encoding: 'base64',
        content: Buffer.from(
          JSON.stringify({ name: '@socketsecurity/mcp', version: '8.1.0' }),
        ).toString('base64'),
      })
    return ''
  }
  const waits: number[] = []
  await approveNpmStage(id, '@socketsecurity/mcp', command, async ms => {
    waits.push(ms)
  })
  expect(waits).toEqual([2000])
  expect(calls.filter(call => call.args[1] === 'approve')).toHaveLength(1)
  expect(calls.filter(call => call.args[1] === 'run')).toHaveLength(1)
  expect(calls.find(call => call.args[0] === 'api')?.args[1]).toContain(
    'ref=refs%2Ftags%2Fv8.1.0',
  )
  expect(calls.find(call => call.args[1] === 'approve')?.args).toContain(
    '--registry=https://registry.npmjs.org',
  )
  expect(calls.find(call => call.args[1] === 'view')?.args).toContain(
    '--registry=https://registry.npmjs.org',
  )
})

it('does not approve when the exact tag contains another version', async () => {
  const calls: string[] = []
  const command = (name: string, args: string[]) => {
    calls.push(`${name} ${args.join(' ')}`)
    if (name === 'pnpm')
      return JSON.stringify({
        id,
        packageName: '@socketsecurity/mcp',
        version: '8.1.0',
        status: 'staged',
      })
    if (args[0] === 'repo')
      return JSON.stringify({
        nameWithOwner: 'socketdev/socket-mcp',
        defaultBranchRef: { name: 'main' },
      })
    return JSON.stringify({
      encoding: 'base64',
      content: Buffer.from(
        JSON.stringify({ name: '@socketsecurity/mcp', version: '8.1.1' }),
      ).toString('base64'),
    })
  }
  await expect(
    approveNpmStage(id, '@socketsecurity/mcp', command),
  ).rejects.toThrow('does not contain @socketsecurity/mcp@8.1.0')
  expect(calls.some(call => call.includes('stage approve'))).toBe(false)
})

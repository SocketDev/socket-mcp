import path from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { readSocketApiTokenSync } from '@socketsecurity/lib-stable/secrets/socket-api-token'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

// End-to-end suite: spawns the real MCP server over stdio and exercises
// depscore against the live Socket API. Requires a Socket API token, so
// it skips cleanly when one isn't configured (e.g. CI without the
// secret). The stdio + client.callTool path makes no direct
// fetch/httpRequest call from this file, so it isn't a mock-the-network
// case — the network it touches is the live API behind a real token.
const apiToken = readSocketApiTokenSync()

interface TextContent {
  type: string
  text: string
}

describe.skipIf(!apiToken)('Socket MCP Server (live API)', () => {
  const serverPath = path.join(import.meta.dirname, '..', 'index.ts')
  const client = new Client(
    { name: 'test-mcp-client', version: '1.0.0' },
    { capabilities: {} },
  )

  beforeAll(async () => {
    const transport = new StdioClientTransport({
      command: 'node',
      args: [serverPath],
      env: {
        ...(Object.fromEntries(
          Object.entries(process.env).filter(
            ([, value]) => value !== undefined,
          ),
        ) as Record<string, string>),
        SOCKET_API_TOKEN: apiToken!,
      },
    })
    await client.connect(transport)
  })

  afterAll(async () => {
    await client.close().catch(() => {})
  })

  test('lists the depscore tool', async () => {
    const tools = await client.listTools()
    expect(tools.tools.length).toBeGreaterThan(0)
    expect(tools.tools.some(tool => tool.name === 'depscore')).toBe(true)
  })

  test('call depscore tool', async () => {
    const result = await client.callTool({
      name: 'depscore',
      arguments: {
        packages: [
          { depname: 'express', ecosystem: 'npm', version: '4.18.2' },
          { depname: 'lodash', ecosystem: 'npm', version: '4.17.21' },
          { depname: 'react', ecosystem: 'npm', version: '18.2.0' },
          { depname: 'requests', ecosystem: 'pypi', version: '2.31.0' },
          { depname: 'puma', ecosystem: 'gem', version: '6.4.0' },
          { depname: 'unknown-package', ecosystem: 'npm', version: 'unknown' },
        ],
      },
    })
    expect(result.content).toBeTruthy()
    expect(Array.isArray(result.content)).toBe(true)
    expect((result.content as unknown[]).length).toBeGreaterThan(0)
  })

  test('scoped npm package resolves to @babel/core', async () => {
    const result = await client.callTool({
      name: 'depscore',
      arguments: {
        packages: [
          { depname: '@babel/core', ecosystem: 'npm', version: '7.24.0' },
        ],
      },
    })
    const content = result.content as TextContent[]
    expect(content.length).toBeGreaterThan(0)
    const { text } = content[0]!
    expect(text.includes('@babel/core') || text.includes('%40babel/core')).toBe(
      true,
    )
  })

  test('pypi ecosystem produces pypi purls', async () => {
    const result = await client.callTool({
      name: 'depscore',
      arguments: {
        packages: [
          { depname: 'flask', ecosystem: 'pypi', version: '2.3.2' },
          { depname: 'requests', ecosystem: 'pypi', version: '2.31.0' },
        ],
      },
    })
    const content = result.content as TextContent[]
    expect(content.length).toBeGreaterThan(0)
    expect(content[0]!.text).toContain('pkg:pypi/')
  })

  test('pypi multi-artifact package is deduplicated to one result', async () => {
    const result = await client.callTool({
      name: 'depscore',
      arguments: {
        packages: [{ depname: 'numpy', ecosystem: 'pypi', version: '1.26.4' }],
      },
    })
    const content = result.content as TextContent[]
    const numpyLines = content[0]!.text
      .split('\n')
      .filter(line => line.includes('pkg:pypi/numpy'))
    expect(numpyLines.length).toBe(1)
  })

  test('accepts an optional platform parameter', async () => {
    const result = await client.callTool({
      name: 'depscore',
      arguments: {
        packages: [{ depname: 'numpy', ecosystem: 'pypi', version: '1.26.4' }],
        platform: 'darwin-arm64',
      },
    })
    const content = result.content as TextContent[]
    expect(content[0]!.text).toContain('pkg:pypi/numpy')
    const numpyLines = content[0]!.text
      .split('\n')
      .filter(line => line.includes('pkg:pypi/numpy'))
    expect(numpyLines.length).toBe(1)
  })

  test('maven ecosystem produces maven purls', async () => {
    const result = await client.callTool({
      name: 'depscore',
      arguments: {
        packages: [
          {
            depname: 'org.springframework.boot:spring-boot-starter-web',
            ecosystem: 'maven',
            version: '3.1.0',
          },
        ],
      },
    })
    const content = result.content as TextContent[]
    expect(content[0]!.text).toContain('pkg:maven/')
  })

  test('nuget ecosystem produces nuget purls', async () => {
    const result = await client.callTool({
      name: 'depscore',
      arguments: {
        packages: [
          { depname: 'Newtonsoft.Json', ecosystem: 'nuget', version: '13.0.3' },
        ],
      },
    })
    const content = result.content as TextContent[]
    expect(content[0]!.text).toContain('pkg:nuget/')
  })

  test('cargo ecosystem produces cargo purls', async () => {
    const result = await client.callTool({
      name: 'depscore',
      arguments: {
        packages: [
          { depname: 'serde', ecosystem: 'cargo', version: '1.0.193' },
          { depname: 'tokio', ecosystem: 'cargo', version: '1.30.0' },
        ],
      },
    })
    const content = result.content as TextContent[]
    expect(content[0]!.text).toContain('pkg:cargo/')
  })

  test('gem ecosystem produces gem purls with scores', async () => {
    const result = await client.callTool({
      name: 'depscore',
      arguments: {
        packages: [
          { depname: 'puma', ecosystem: 'gem', version: '6.4.0' },
          { depname: 'rails', ecosystem: 'gem', version: '7.1.0' },
          { depname: 'nokogiri', ecosystem: 'gem', version: '1.16.0' },
        ],
      },
    })
    const content = result.content as TextContent[]
    expect(content.length).toBeGreaterThan(0)
    expect(content[0]!.text).toContain('pkg:gem/')
    expect(content[0]!.text).not.toContain('No score found')
  })
})

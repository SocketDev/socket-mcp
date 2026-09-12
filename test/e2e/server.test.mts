import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { SERVER_SOURCE } from '../../scripts/repo/paths.mts'

const FIXTURE_RESPONSE = [
  { type: 'npm', namespace: '@babel', name: 'core', version: '7.24.0' },
  { type: 'pypi', name: 'numpy', version: '1.26.4' },
  {
    type: 'maven',
    namespace: 'org.springframework.boot',
    name: 'spring-boot-starter-web',
    version: '3.1.0',
  },
  { type: 'nuget', name: 'Newtonsoft.Json', version: '13.0.3' },
  { type: 'cargo', name: 'serde', version: '1.0.193' },
  { type: 'gem', name: 'puma', version: '6.4.0' },
]
  .map(item => JSON.stringify({ ...item, score: { overall: 0.9 } }))
  .join('\n')

function serveFixtureApi(
  request: IncomingMessage,
  response: ServerResponse,
): void {
  request.resume()
  response.writeHead(200, { 'content-type': 'application/x-ndjson' })
  response.end(FIXTURE_RESPONSE)
}

const fixtureApi = createServer(serveFixtureApi)

interface TextContent {
  type: string
  text: string
}

describe('Socket MCP Server', () => {
  const client = new Client(
    { name: 'test-mcp-client', version: '1.0.0' },
    { capabilities: {} },
  )

  beforeAll(async () => {
    await new Promise<void>((resolve, reject) => {
      fixtureApi.once('error', reject)
      fixtureApi.listen(0, '127.0.0.1', resolve)
    })
    const address = fixtureApi.address()
    if (!address || typeof address === 'string') {
      throw new TypeError('Fixture API did not bind to a TCP port')
    }
    const transport = new StdioClientTransport({
      command: 'node',
      args: [SERVER_SOURCE],
      env: {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double / fixture cast: the mock provides only the members the code under test touches.
        ...(Object.fromEntries(
          Object.entries(process.env).filter(
            ([, value]) => value !== undefined,
          ),
        ) as Record<string, string>),
        SOCKET_API_BASE_URL: `http://127.0.0.1:${address.port}/v0/purl`,
        SOCKET_API_TOKEN: 'socket_test_placeholder',
      },
    })
    await client.connect(transport)
  })

  afterAll(async () => {
    await client.close().catch(() => {})
    await new Promise<void>((resolve, reject) => {
      fixtureApi.close(error => (error ? reject(error) : resolve()))
    })
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
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double / fixture cast: the mock provides only the members the code under test touches.
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
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double / fixture cast: the mock provides only the members the code under test touches.
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
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double / fixture cast: the mock provides only the members the code under test touches.
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
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double / fixture cast: the mock provides only the members the code under test touches.
    const content = result.content as TextContent[]
    const numpyLines = content[0]!.text
      .split(/\r?\n/)
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
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double / fixture cast: the mock provides only the members the code under test touches.
    const content = result.content as TextContent[]
    expect(content[0]!.text).toContain('pkg:pypi/numpy')
    const numpyLines = content[0]!.text
      .split(/\r?\n/)
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
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double / fixture cast: the mock provides only the members the code under test touches.
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
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double / fixture cast: the mock provides only the members the code under test touches.
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
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double / fixture cast: the mock provides only the members the code under test touches.
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
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double / fixture cast: the mock provides only the members the code under test touches.
    const content = result.content as TextContent[]
    expect(content.length).toBeGreaterThan(0)
    expect(content[0]!.text).toContain('pkg:gem/')
    expect(content[0]!.text).not.toContain('No score found')
  })
})

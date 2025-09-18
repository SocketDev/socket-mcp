#!/usr/bin/env node
import { test } from 'node:test'
import assert from 'node:assert'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { join } from 'path'

test('Socket MCP Server', async (t) => {
  const apiKey = process.env['SOCKET_API_KEY']
  assert.ok(apiKey, 'We need an API key. Tests will not pass without it')
  const serverPath = join(import.meta.dirname, 'index.ts')

  const transport = new StdioClientTransport({
    command: 'node',
    args: ['--experimental-strip-types', serverPath],
    env: {
      ...process.env,
      SOCKET_API_KEY: apiKey
    }
  })

  const client = new Client({
    name: 'test-mcp-client',
    version: '1.0.0'
  }, {
    capabilities: {}
  })

  await t.test('connect to server', async () => {
    await client.connect(transport)
    assert.ok(true, 'Connected to MCP server')
  })

  await t.test('list available tools', async () => {
    const tools = await client.listTools()
    assert.ok(tools.tools.length > 0, 'Server should have tools')
    assert.ok(tools.tools.some(t => t.name === 'depscore'), 'Should have depscore tool')
  })

  await t.test('call depscore tool', async () => {
    const testPackages = [
      { depname: 'express', ecosystem: 'npm', version: '4.18.2' },
      { depname: 'lodash', ecosystem: 'npm', version: '4.17.21' },
      { depname: 'react', ecosystem: 'npm', version: '18.2.0' },
      { depname: 'requests', ecosystem: 'pypi', version: '2.31.0' },
      { depname: 'unknown-package', ecosystem: 'npm', version: 'unknown' }
    ]

    const result = await client.callTool({
      name: 'depscore',
      arguments: {
        packages: testPackages
      }
    })

    assert.ok(result, 'Should get a result from depscore')
    assert.ok(result.content, 'Result should have content')
    assert.ok(Array.isArray(result.content), 'Content should be an array')
    assert.ok(result.content.length > 0, 'Content should not be empty')
  })

  await t.test('close client', async () => {
    await client.close()
    assert.ok(true, 'Client closed successfully')
  })
})

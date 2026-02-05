#!/usr/bin/env node
import { test } from 'node:test'
import assert from 'node:assert'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { join } from 'path'
import { createServer } from 'node:http'

test('Socket MCP Server', async (t) => {
  // Start a local mock Socket API server so tests don't depend on network or real API keys.
  const mockApi = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost:8866')
    if (req.method !== 'POST' || url.pathname !== '/v0/purl') {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'not_found' }))
      return
    }

    let body = ''
    for await (const chunk of req) body += chunk

    let data: any
    try {
      data = JSON.parse(body)
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'bad_json' }))
      return
    }

    const components = Array.isArray(data?.components) ? data.components : []
    const responses: string[] = []

    for (const component of components) {
      const purl = typeof component?.purl === 'string' ? component.purl : ''
      const match = /^pkg:([^/]+)\\/(.+?)(?:@(.+))?$/.exec(purl)
      const type = match?.[1] || 'unknown'
      const rawName = match?.[2] || 'unknown'
      const version = match?.[3] || 'unknown'
      const name = decodeURIComponent(rawName)

      const supplyChain = name === 'unknown-package'
        ? 0.2
        : (name === 'malicious-pkg' ? 0 : 0.9)

      responses.push(JSON.stringify({
        type,
        name,
        version,
        score: {
          supply_chain: supplyChain,
          quality: 0.85,
          vulnerability: 1,
          maintenance: 0.9,
          license: 1
        },
        alerts: supplyChain === 0
          ? [{ type: 'obfuscatedCode', severity: 'CRITICAL', description: 'Fixture: known malware signal' }]
          : []
      }))
    }

    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
    res.end(`${responses.join('\\n')}\\n`)
  })

  await new Promise<void>((resolve) => {
    mockApi.listen(8866, () => resolve())
  })

  t.after(() => {
    mockApi.close()
  })

  const serverPath = join(import.meta.dirname, 'index.ts')

  const transport = new StdioClientTransport({
    command: 'node',
    args: ['--experimental-strip-types', serverPath],
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([, value]) => value !== undefined)
      ) as Record<string, string>,
      SOCKET_API_KEY: 'test-key',
      SOCKET_DEBUG: 'true'
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
    assert.ok(tools.tools.some(t => t.name === 'batch_check'), 'Should have batch_check tool')
    assert.ok(tools.tools.some(t => t.name === 'check_package'), 'Should have check_package tool')
    assert.ok(tools.tools.some(t => t.name === 'explain_alert'), 'Should have explain_alert tool')
  })

  await t.test('call explain_alert tool (no API call)', async () => {
    const result = await client.callTool({
      name: 'explain_alert',
      arguments: {
        alert_type: 'installScripts'
      }
    })

    assert.ok(result, 'Should get a result from explain_alert')
    assert.ok(Array.isArray(result.content), 'Content should be an array')
    assert.ok(result.content.length > 0, 'Content should not be empty')
  })

  await t.test('call check_package tool', async () => {
    const result = await client.callTool({
      name: 'check_package',
      arguments: {
        ecosystem: 'npm',
        name: 'express',
        version: '4.18.2'
      }
    })

    assert.ok(result, 'Should get a result from check_package')
    assert.ok(Array.isArray(result.content), 'Content should be an array')
    assert.ok(result.content.length > 0, 'Content should not be empty')
  })

  await t.test('call batch_check tool', async () => {
    const result = await client.callTool({
      name: 'batch_check',
      arguments: {
        packages: [
          { ecosystem: 'npm', name: 'express', version: '4.18.2' },
          { ecosystem: 'npm', name: 'lodash', version: '4.17.21' }
        ]
      }
    })

    assert.ok(result, 'Should get a result from batch_check')
    assert.ok(Array.isArray(result.content), 'Content should be an array')
    assert.ok(result.content.length > 0, 'Content should not be empty')
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

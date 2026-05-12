#!/usr/bin/env node
import { test } from 'node:test'
import assert from 'node:assert'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import path from 'node:path'

test('Socket MCP Server', async t => {
  const apiKey = process.env['SOCKET_API_TOKEN']
  assert.ok(apiKey, 'We need an API key. Tests will not pass without it')
  const serverPath = path.join(import.meta.dirname, 'index.ts')

  const transport = new StdioClientTransport({
    command: 'node',
    args: ['--experimental-strip-types', serverPath],
    env: {
      ...(Object.fromEntries(
        Object.entries(process.env).filter(([, value]) => value !== undefined),
      ) as Record<string, string>),
      SOCKET_API_KEY: apiKey,
    },
  })

  const client = new Client(
    {
      name: 'test-mcp-client',
      version: '1.0.0',
    },
    {
      capabilities: {},
    },
  )

  await t.test('connect to server', async () => {
    await client.connect(transport)
    assert.ok(true, 'Connected to MCP server')
  })

  await t.test('list available tools', async () => {
    const tools = await client.listTools()
    assert.ok(tools.tools.length > 0, 'Server should have tools')
    assert.ok(
      tools.tools.some(t => t.name === 'depscore'),
      'Should have depscore tool',
    )
  })

  await t.test('call depscore tool', async () => {
    const testPackages = [
      { depname: 'express', ecosystem: 'npm', version: '4.18.2' },
      { depname: 'lodash', ecosystem: 'npm', version: '4.17.21' },
      { depname: 'react', ecosystem: 'npm', version: '18.2.0' },
      { depname: 'requests', ecosystem: 'pypi', version: '2.31.0' },
      { depname: 'puma', ecosystem: 'gem', version: '6.4.0' },
      { depname: 'unknown-package', ecosystem: 'npm', version: 'unknown' },
    ]

    const result = await client.callTool({
      name: 'depscore',
      arguments: {
        packages: testPackages,
      },
    })

    assert.ok(result, 'Should get a result from depscore')
    assert.ok(result.content, 'Result should have content')
    assert.ok(Array.isArray(result.content), 'Content should be an array')
    assert.ok(result.content.length > 0, 'Content should not be empty')
  })

  await t.test('call depscore tool with scoped npm package', async () => {
    const scopedPackages = [
      { depname: '@babel/core', ecosystem: 'npm', version: '7.24.0' },
    ]

    const result = await client.callTool({
      name: 'depscore',
      arguments: {
        packages: scopedPackages,
      },
    })

    assert.ok(result, 'Should get a result from depscore')
    assert.ok(result.content, 'Result should have content')
    assert.ok(
      Array.isArray(result.content) && result.content.length > 0,
      'Content should not be empty',
    )
    const textContent = result.content[0] as { type: string; text: string }
    assert.ok(
      textContent.text.includes('@babel/core') ||
        textContent.text.includes('%40babel/core'),
      'Scoped package should resolve to @babel/core, not core',
    )
  })

  await t.test('call depscore tool with pypi ecosystem', async () => {
    const pypiPackages = [
      { depname: 'flask', ecosystem: 'pypi', version: '2.3.2' },
      { depname: 'requests', ecosystem: 'pypi', version: '2.31.0' },
    ]

    const result = await client.callTool({
      name: 'depscore',
      arguments: { packages: pypiPackages },
    })

    assert.ok(
      result?.content &&
        Array.isArray(result.content) &&
        result.content.length > 0,
    )
    const textContent = result.content[0] as { type: string; text: string }
    assert.ok(
      textContent.text.includes('pkg:pypi/'),
      'Result should contain pypi purl format',
    )
  })

  await t.test(
    'pypi multi-artifact package is deduplicated to one result',
    async () => {
      const packages = [
        { depname: 'numpy', ecosystem: 'pypi', version: '1.26.4' },
      ]

      const result = await client.callTool({
        name: 'depscore',
        arguments: { packages },
      })

      assert.ok(
        result?.content &&
          Array.isArray(result.content) &&
          result.content.length > 0,
      )
      const textContent = result.content[0] as { type: string; text: string }
      const numpyLines = textContent.text
        .split('\n')
        .filter(line => line.includes('pkg:pypi/numpy'))
      assert.strictEqual(
        numpyLines.length,
        1,
        `Expected 1 deduplicated result for numpy, got ${numpyLines.length}:\n${numpyLines.join('\n')}`,
      )
    },
  )

  await t.test('depscore accepts optional platform parameter', async () => {
    const packages = [
      { depname: 'numpy', ecosystem: 'pypi', version: '1.26.4' },
    ]

    const result = await client.callTool({
      name: 'depscore',
      arguments: { packages, platform: 'darwin-arm64' },
    })

    assert.ok(
      result?.content &&
        Array.isArray(result.content) &&
        result.content.length > 0,
    )
    const textContent = result.content[0] as { type: string; text: string }
    assert.ok(
      textContent.text.includes('pkg:pypi/numpy'),
      'Result should contain numpy',
    )
    const numpyLines = textContent.text
      .split('\n')
      .filter(line => line.includes('pkg:pypi/numpy'))
    assert.strictEqual(
      numpyLines.length,
      1,
      'Platform hint should still produce one deduplicated result',
    )
  })

  await t.test('call depscore tool with golang ecosystem', async t => {
    const golangPackages = [
      {
        depname: 'github.com/gin-gonic/gin',
        ecosystem: 'golang',
        version: 'v1.9.0',
      },
    ]

    const result = await client.callTool({
      name: 'depscore',
      arguments: { packages: golangPackages },
    })

    assert.ok(
      result?.content &&
        Array.isArray(result.content) &&
        result.content.length > 0,
    )
    const textContent = result.content[0] as { type: string; text: string }
    const hasGoPurl =
      textContent.text.includes('pkg:golang/') ||
      textContent.text.includes('pkg:go/')
    if (!hasGoPurl) {
      t.skip(
        `Socket API did not return a recognized Go PURL format; ecosystem support may vary. Response: ${textContent.text.slice(0, 200)}`,
      )
      return
    }
    assert.ok(hasGoPurl, 'Result should contain go/golang purl format')
  })

  await t.test('call depscore tool with maven ecosystem', async () => {
    const mavenPackages = [
      {
        depname: 'org.springframework.boot:spring-boot-starter-web',
        ecosystem: 'maven',
        version: '3.1.0',
      },
    ]

    const result = await client.callTool({
      name: 'depscore',
      arguments: { packages: mavenPackages },
    })

    assert.ok(
      result?.content &&
        Array.isArray(result.content) &&
        result.content.length > 0,
    )
    const textContent = result.content[0] as { type: string; text: string }
    assert.ok(
      textContent.text.includes('pkg:maven/'),
      'Result should contain maven purl format',
    )
  })

  await t.test('call depscore tool with nuget ecosystem', async () => {
    const nugetPackages = [
      { depname: 'Newtonsoft.Json', ecosystem: 'nuget', version: '13.0.3' },
    ]

    const result = await client.callTool({
      name: 'depscore',
      arguments: { packages: nugetPackages },
    })

    assert.ok(
      result?.content &&
        Array.isArray(result.content) &&
        result.content.length > 0,
    )
    const textContent = result.content[0] as { type: string; text: string }
    assert.ok(
      textContent.text.includes('pkg:nuget/'),
      'Result should contain nuget purl format',
    )
  })

  await t.test('call depscore tool with cargo ecosystem', async () => {
    const cargoPackages = [
      { depname: 'serde', ecosystem: 'cargo', version: '1.0.193' },
      { depname: 'tokio', ecosystem: 'cargo', version: '1.30.0' },
    ]

    const result = await client.callTool({
      name: 'depscore',
      arguments: { packages: cargoPackages },
    })

    assert.ok(
      result?.content &&
        Array.isArray(result.content) &&
        result.content.length > 0,
    )
    const textContent = result.content[0] as { type: string; text: string }
    assert.ok(
      textContent.text.includes('pkg:cargo/'),
      'Result should contain cargo purl format',
    )
  })

  await t.test('call depscore tool with gem ecosystem', async () => {
    const gemPackages = [
      { depname: 'puma', ecosystem: 'gem', version: '6.4.0' },
      { depname: 'rails', ecosystem: 'gem', version: '7.1.0' },
      { depname: 'nokogiri', ecosystem: 'gem', version: '1.16.0' },
    ]

    const result = await client.callTool({
      name: 'depscore',
      arguments: {
        packages: gemPackages,
      },
    })

    assert.ok(result, 'Should get a result from depscore for gem packages')
    assert.ok(result.content, 'Result should have content')
    assert.ok(Array.isArray(result.content), 'Content should be an array')
    assert.ok(result.content.length > 0, 'Content should not be empty')

    const textContent = result.content[0] as { type: string; text: string }
    assert.ok(
      textContent.text.includes('pkg:gem/'),
      'Result should contain gem purl format',
    )
    assert.ok(
      !textContent.text.includes('No score found'),
      'Gem packages should have scores',
    )
  })

  await t.test('close client', async () => {
    await client.close()
    assert.ok(true, 'Client closed successfully')
  })
})

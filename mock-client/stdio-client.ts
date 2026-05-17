#!/usr/bin/env node --experimental-strip-types
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import path from 'node:path'
import { getDefaultLogger } from '@socketsecurity/lib/logger'

const logger = getDefaultLogger()

async function main() {
  const serverPath = path.join(import.meta.dirname, '..', 'index.ts')
  logger.log(`Using server script: ${serverPath}`)

  const transport = new StdioClientTransport({
    command: 'node',
    args: ['--experimental-strip-types', serverPath],

    env: {
      ...(Object.fromEntries(
        Object.entries(process.env).filter(([, value]) => value !== undefined),
      ) as Record<string, string>),
      SOCKET_API_KEY: process.env['SOCKET_API_TOKEN'] || '',
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

  try {
    await client.connect(transport)
    logger.info('Connected to MCP server')

    // List available tools
    const tools = await client.listTools()
    logger.info(
      'Available tools:',
      tools.tools.map(t => t.name),
    )

    // Test the depscore tool
    const testPackages = [
      { depname: 'express', ecosystem: 'npm', version: '4.18.2' },
      { depname: 'lodash', ecosystem: 'npm', version: '4.17.21' },
      { depname: 'react', ecosystem: 'npm', version: '18.2.0' },
      { depname: 'requests', ecosystem: 'pypi', version: '2.31.0' },
      { depname: 'unknown-package', ecosystem: 'npm', version: 'unknown' },
    ]

    logger.error('')
    logger.info('Testing depscore with packages:', testPackages)

    const result = await client.callTool({
      name: 'depscore',
      arguments: {
        packages: testPackages,
      },
    })

    logger.error('')
    logger.info('Depscore results:')
    logger.info(JSON.stringify(result, null, 2))

    await client.close()
    logger.error('')
    logger.info('Client closed successfully')
  } catch (error) {
    logger.error('Error:', error)
    await client.close()
    process.exit(1)
  }
}

// Run the client
main().catch(e => logger.error(e))

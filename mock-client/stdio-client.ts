#!/usr/bin/env node
import path from 'node:path'
import process from 'node:process'

import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { getDefaultLogger } from '@socketsecurity/lib/logger/default'

const logger = getDefaultLogger()

// StdioClientTransport otherwise passes only its own safe-to-inherit
// allowlist, which drops SOCKET_API_TOKEN. Hand it the full environment so the
// spawned server resolves the token the same way `pnpm run server-stdio` does.
export function buildServerEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value
    }
  }
  return env
}

async function main(): Promise<void> {
  const serverPath = path.join(import.meta.dirname, '..', 'index.ts')
  logger.log(`Using server script: ${serverPath}`)

  const transport = new StdioClientTransport({
    command: 'node',
    args: [serverPath],
    env: buildServerEnv(),
    stderr: 'inherit',
  })

  const client = new Client(
    {
      name: 'test-mcp-client',
      version: '1.0.0',
    },
    {
      capabilities: {},
      // Probe `server/discover` at connect and negotiate the 2026-07-28 era.
      // A server that only speaks the 2025 protocol makes the client fall
      // back to the plain `initialize` handshake on its own.
      versionNegotiation: { mode: 'auto' },
    },
  )

  try {
    await client.connect(transport)
    logger.info('Connected to MCP server')
    logger.info(`Protocol era: ${client.getProtocolEra() ?? 'unknown'}`)
    logger.info(
      `Negotiated protocol version: ${client.getNegotiatedProtocolVersion() ?? 'unknown'}`,
    )

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

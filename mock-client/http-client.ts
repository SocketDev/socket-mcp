#!/usr/bin/env node
import path from 'node:path'
import process from 'node:process'

import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client'
import { getDefaultLogger } from '@socketsecurity/lib/logger/default'

const logger = getDefaultLogger()

// Exercises the Socket MCP server in HTTP mode over Streamable HTTP. No
// session id is supplied, so the connection stays stateless.
export async function testHTTPMode(): Promise<void> {
  // Remove the trailing slash so the URL matches the server's `/` route.
  const baseUrl = (process.env['MCP_URL'] || 'http://localhost:3000').replace(
    /\/$/,
    '',
  )

  logger.log('Testing Socket MCP in HTTP mode…')
  logger.info(`Server URL: ${baseUrl}`)

  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/`), {
    requestInit: {
      headers: {
        'User-Agent': 'socket-mcp-debug-client/1.0.0',
      },
    },
  })

  const client = new Client(
    {
      name: 'http-debug-client',
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
    // 1. Connect (stateless — no session id)
    logger.error('')
    logger.info('1. Initializing connection…')
    await client.connect(transport)
    logger.info(`Protocol era: ${client.getProtocolEra() ?? 'unknown'}`)
    logger.info(
      `Negotiated protocol version: ${client.getNegotiatedProtocolVersion() ?? 'unknown'}`,
    )
    logger.info('Initialized (stateless)')

    // 2. List tools
    logger.error('')
    logger.info('2. Listing available tools…')
    const toolsResult = await client.listTools()
    logger.info('Available tools:', JSON.stringify(toolsResult, null, 2))
    if (!toolsResult.tools.some(tool => tool.name === 'depscore')) {
      throw new Error('depscore tool not found in available tools')
    }

    // 3. Call depscore
    logger.error('')
    logger.info('3. Calling depscore tool…')
    const depscoreResult = await client.callTool({
      name: 'depscore',
      arguments: {
        packages: [
          { depname: 'express', ecosystem: 'npm', version: '4.18.2' },
          { depname: 'fastapi', ecosystem: 'pypi', version: '0.100.0' },
          { depname: 'react', ecosystem: 'npm', version: '18.2.0' },
        ],
      },
    })
    logger.info('Depscore result:', JSON.stringify(depscoreResult, null, 2))

    logger.error('')
    logger.info('4. HTTP mode test complete (no sessions)')
  } catch (error) {
    logger.error('Error:', error)
  } finally {
    await client.close()
  }
}

// Usage instructions
if (process.argv.includes('--help')) {
  const serverScript = path.join(import.meta.dirname, '..', 'index.ts')
  // oxlint-disable-next-line socket/no-logger-newline-literal -- multi-line help text; intentional newlines for readability.
  logger.info(`
Socket MCP HTTP Client Debugger

Usage:
  # Start the MCP server in HTTP mode first:
  MCP_HTTP_MODE=true SOCKET_API_TOKEN=your-api-token node ${serverScript}

  # Then run this client:
  node ./mock-client/http-client.ts

Environment variables:
  MCP_URL - Server URL (default: http://localhost:3000)

Example:
  MCP_URL=http://localhost:8080 node ./mock-client/http-client.ts
`)
  process.exit(0)
}

testHTTPMode().catch(e => logger.error(e))

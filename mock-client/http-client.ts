#!/usr/bin/env node --experimental-strip-types
import path from 'node:path'
import { getDefaultLogger } from '@socketsecurity/lib-stable/logger'

const logger = getDefaultLogger()

// Helper function to parse SSE or JSON response
async function parseResponse(response: any) {
  const contentType = response.headers.get('content-type')
  const text = await response.text()

  if (contentType?.includes('text/event-stream')) {
    // Parse SSE format: "event: message\ndata: {json}\n"
    const dataMatch = text.match(/data: (.+)/)
    if (dataMatch) {
      return JSON.parse(dataMatch[1])
    }
    return undefined
  } else {
    return JSON.parse(text)
  }
}

// Simple HTTP client for testing MCP server in HTTP mode
async function testHTTPMode() {
  const baseUrl = (process.env['MCP_URL'] || 'http://localhost:3000').replace(
    /\/$/,
    '',
  ) // Remove trailing slash

  logger.log('Testing Socket MCP in HTTP mode...')
  logger.info(`Server URL: ${baseUrl}`)

  try {
    // 1. Initialize connection (stateless)
    logger.error('')
    logger.info('1. Initializing connection...')
    const initRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '0.1.0',
        capabilities: {},
        clientInfo: {
          name: 'http-debug-client',
          version: '1.0.0',
        },
      },
    }

    const initResponse = await fetch(`${baseUrl}/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // SDK requires Accept to include both types even if server returns JSON
        Accept: 'application/json, text/event-stream',
        'User-Agent': 'socket-mcp-debug-client/1.0.0',
      },
      body: JSON.stringify(initRequest),
    })

    const initResult = await parseResponse(initResponse)
    logger.info('Initialize response:', JSON.stringify(initResult, null, 2))

    logger.info('Initialized (stateless)')

    // 2. List tools
    logger.error('')
    logger.info('2. Listing available tools...')
    const toolsRequest = {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    }

    const toolsResponse = await fetch(`${baseUrl}/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify(toolsRequest),
    })

    const toolsResult = await parseResponse(toolsResponse)
    logger.info('Available tools:', JSON.stringify(toolsResult, null, 2))
    // Assert that the 'depscore' tool exists in the toolsResult
    if (
      !toolsResult ||
      !toolsResult.result ||
      !Array.isArray(toolsResult.result.tools) ||
      !toolsResult.result.tools.some((tool: any) => tool.name === 'depscore')
    ) {
      throw new Error('depscore tool not found in available tools')
    }

    // 3. Call depscore
    logger.error('')
    logger.info('3. Calling depscore tool...')
    const depscoreRequest = {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'depscore',
        arguments: {
          packages: [
            { depname: 'express', ecosystem: 'npm', version: '4.18.2' },
            { depname: 'fastapi', ecosystem: 'pypi', version: '0.100.0' },
            { depname: 'react', ecosystem: 'npm', version: '18.2.0' },
          ],
        },
      },
    }

    const depscoreResponse = await fetch(`${baseUrl}/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify(depscoreRequest),
    })

    const depscoreResult = await parseResponse(depscoreResponse)
    logger.info('Depscore result:', JSON.stringify(depscoreResult, null, 2))

    logger.error('')
    logger.info('4. HTTP mode test complete (no sessions)')
  } catch (error) {
    logger.error('Error:', error)
  }
}

// Usage instructions
if (process.argv.includes('--help')) {
  const serverScript = path.join(import.meta.dirname, '..', 'index.ts')
  logger.info(`
Socket MCP HTTP Client Debugger

Usage:
  # Start the MCP server in HTTP mode first:
  MCP_HTTP_MODE=true SOCKET_API_KEY=your-api-key node --experimental-strip-types ${serverScript}

  # Then run this client:
  node --experimental-strip-types ./mock-client/http-client.ts

Environment variables:
  MCP_URL - Server URL (default: http://localhost:3000)

Example:
  MCP_URL=http://localhost:8080 node --experimental-strip-types ./mock-client/http-client.ts
`)
  process.exit(0)
}

testHTTPMode().catch(e => logger.error(e))

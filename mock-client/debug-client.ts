#!/usr/bin/env node
/**
 * @file Raw JSON-RPC debug client for the Socket MCP server.
 *   The frames here are hand-written on purpose. This client drives the
 *   legacy 2025 handshake — `initialize`, then the `notifications/initialized`
 *   notification, then ordinary requests — and never sends `server/discover`
 *   or a `_meta` envelope. That makes it the compat-path probe: it proves the
 *   server still answers a pre-2026 client exactly as it always did. The two
 *   SDK-backed clients in this directory cover the modern era.
 */
import path from 'node:path'
import process from 'node:process'
import readline from 'node:readline'

import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/client'
import { spawn } from '@socketsecurity/lib-stable/process/spawn/child'
import { getDefaultLogger } from '@socketsecurity/lib/logger/default'

const logger = getDefaultLogger()

export interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (reason?: unknown | undefined) => void
}

// Parse a stdout line into a plain object without asserting a wire shape the
// server under test may not honor.
export function parseJsonRpcFrame(
  line: string,
): Record<string, unknown> | undefined {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return undefined
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value))
  }
  return undefined
}

// Simple JSON-RPC client for testing MCP server
export class SimpleJSONRPCClient {
  private spawned: ReturnType<typeof spawn>
  private rl: readline.Interface
  private requestId = 1
  private pendingRequests = new Map<number, PendingRequest>()

  constructor(
    command: string,
    args: string[] = [],
    env: Record<string, string> = {},
  ) {
    this.spawned = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    })

    this.rl = readline.createInterface({
      input: this.spawned.process.stdout!,
      crlfDelay: Infinity,
    })

    this.rl.on('line', line => {
      const response = parseJsonRpcFrame(line)
      if (!response) {
        logger.error('Failed to parse response:', line)
        return
      }
      const id = response['id']
      const pending =
        typeof id === 'number' ? this.pendingRequests.get(id) : undefined
      if (pending && typeof id === 'number') {
        this.pendingRequests.delete(id)
        if (response['error']) {
          pending.reject(response['error'])
        } else {
          pending.resolve(response['result'])
        }
      } else if (response['method']) {
        logger.log('Notification:', response)
      }
    })

    this.spawned.process.stderr!.on('data', (data: Buffer) => {
      logger.error('Server stderr:', data.toString())
    })
  }

  async sendRequest(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<unknown> {
    const id = this.requestId++
    const request = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    }

    return await new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject })
      this.spawned.stdin?.write(`${JSON.stringify(request)}\n`)
    })
  }

  // Notifications carry no id and get no response.
  sendNotification(method: string, params: Record<string, unknown> = {}): void {
    const notification = {
      jsonrpc: '2.0',
      method,
      params,
    }
    this.spawned.stdin?.write(`${JSON.stringify(notification)}\n`)
  }

  close() {
    this.rl.close()
    this.spawned.process.kill()
  }
}

async function main() {
  // socket-api-token-getter: allow direct-env — mock client / dev tool, not the runtime auth path.
  const apiKey = process.env['SOCKET_API_TOKEN']
  if (!apiKey) {
    logger.error('Error: SOCKET_API_TOKEN environment variable is required')
    process.exit(1)
  }

  logger.info('Starting MCP server debug client…')

  const serverPath = path.join(import.meta.dirname, '..', 'index.ts')
  logger.info(`Using server script: ${serverPath}`)

  const client = new SimpleJSONRPCClient('node', [serverPath], {
    SOCKET_API_TOKEN: apiKey,
  })

  try {
    // Legacy 2025 handshake: `initialize` request, then the
    // `notifications/initialized` notification the spec requires before any
    // other request.
    logger.error('')
    logger.info('1. Initializing connection (legacy 2025 handshake)…')
    const initResult = await client.sendRequest('initialize', {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: 'debug-client',
        version: '1.0.0',
      },
    })
    logger.info('Initialize response:', JSON.stringify(initResult, null, 2))

    client.sendNotification('notifications/initialized')
    logger.info('Sent notifications/initialized')

    // List available tools
    logger.error('')
    logger.info('2. Listing available tools…')
    const toolsResult = await client.sendRequest('tools/list', {})
    logger.info('Available tools:', JSON.stringify(toolsResult, null, 2))

    // Call the depscore tool
    logger.error('')
    logger.info('3. Calling depscore tool…')
    const depscoreResult = await client.sendRequest('tools/call', {
      name: 'depscore',
      arguments: {
        packages: [
          { depname: 'express', ecosystem: 'npm', version: '5.0.1' },
          { depname: 'lodash', ecosystem: 'npm', version: '4.17.21' },
          { depname: 'react', ecosystem: 'npm', version: '18.2.0' },
          { depname: 'flask', ecosystem: 'pypi', version: '2.3.2' },
          { depname: 'unknown-package', ecosystem: 'npm', version: 'unknown' },
        ],
      },
    })
    logger.info('Depscore result:', JSON.stringify(depscoreResult, null, 2))

    // Test with minimal input
    logger.error('')
    logger.info('4. Testing with minimal input (default to npm)...')
    const minimalResult = await client.sendRequest('tools/call', {
      name: 'depscore',
      arguments: {
        packages: [{ depname: 'axios' }, { depname: 'typescript' }],
      },
    })
    logger.info('Minimal input result:', JSON.stringify(minimalResult, null, 2))

    // Test error handling
    logger.error('')
    logger.info('5. Testing error handling (empty packages)...')
    try {
      await client.sendRequest('tools/call', {
        name: 'depscore',
        arguments: {
          packages: [],
        },
      })
    } catch (error) {
      logger.info('Expected error:', error)
    }

    logger.error('')
    logger.info('Debug session complete!')
  } catch (error) {
    logger.error('Client error:', error)
  } finally {
    client.close()
  }
}

main().catch(e => logger.error(e))

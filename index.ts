#!/usr/bin/env -S node --experimental-strip-types
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import pino from 'pino'
import readline from 'readline'
import { join } from 'path'
import { readFileSync } from 'fs'
import { tmpdir } from 'os'
import { createServer } from 'http'

const __dirname = import.meta.dirname

// Extract version from package.json
const packageJson = JSON.parse(readFileSync(join(__dirname, './package.json'), 'utf8'))
const VERSION = packageJson.version || '0.0.1'

// Configure pino logger with cross-platform temp directory
const logger = pino({
  level: 'info',
  transport: {
    targets: [
      {
        target: 'pino/file',
        options: { destination: join(tmpdir(), 'socket-mcp-error.log') },
        level: 'error'
      },
      {
        target: 'pino/file',
        options: { destination: join(tmpdir(), 'socket-mcp.log') },
        level: 'info'
      }
    ]
  }
})

// Socket API URL - use localhost when debugging is enabled, otherwise use production
const SOCKET_API_URL = process.env['SOCKET_DEBUG'] === 'true'
  ? 'http://localhost:8866/v0/purl?alerts=false&compact=false&fixable=false&licenseattrib=false&licensedetails=false'
  : 'https://api.socket.dev/v0/purl?alerts=false&compact=false&fixable=false&licenseattrib=false&licensedetails=false'

// Function to get API key interactively (only for HTTP mode)
async function getApiKeyInteractively (): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr
  })

  const apiKey = await new Promise<string>((resolve) => {
    rl.question('Please enter your Socket API key: ', (answer: string | PromiseLike<string>) => {
      rl.close()
      resolve(answer)
    })
  })

  if (!apiKey) {
    logger.error('No API key provided')
    process.exit(1)
  }

  return apiKey
}

// Initialize API key
let SOCKET_API_KEY = process.env['SOCKET_API_KEY'] || ''

// Build headers dynamically to reflect current API key
function buildSocketHeaders (): Record<string, string> {
  return {
    'user-agent': `socket-mcp/${VERSION}`,
    accept: 'application/x-ndjson',
    'content-type': 'application/json',
    authorization: `Bearer ${SOCKET_API_KEY}`
  }
}

/** Creates a configured McpServer with tools. Used for stdio (single instance) and HTTP (one per session). */
function createConfiguredServer (): McpServer {
  const srv = new McpServer({ name: 'socket', version: VERSION })
  srv.registerTool(
    'depscore',
    {
      title: 'Dependency Score Tool',
      description: "Get the dependency score of packages with the `depscore` tool from Socket. Use 'unknown' for version if not known. Use this tool to scan dependencies for their quality and security on existing code or when code is generated. Stop generating code and ask the user how to proceed when any of the scores are low. When checking dependencies, make sure to also check the imports in the code, not just the manifest files (pyproject.toml, package.json, etc).",
      inputSchema: {
        packages: z.array(z.object({
          ecosystem: z.string().describe('The package ecosystem (e.g., npm, pypi)').default('npm'),
          depname: z.string().describe('The name of the dependency'),
          version: z.string().describe("The version of the dependency, use 'unknown' if not known").default('unknown'),
        })).describe('Array of packages to check'),
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ packages }) => {
      logger.info(`Received request for ${packages.length} packages`)

      // Build components array for the API request
      const components = packages.map((pkg: { ecosystem?: string; depname: string; version?: string }) => {
        const cleanedVersion = (pkg.version ?? 'unknown').replace(/[\^~]/g, '') // Remove ^ and ~ from version
        const ecosystem = pkg.ecosystem ?? 'npm'
        let purl: string
        if (cleanedVersion === '1.0.0' || cleanedVersion === 'unknown' || !cleanedVersion) {
          purl = `pkg:${ecosystem}/${pkg.depname}`
        } else {
          logger.info(`Using version ${cleanedVersion} for ${pkg.depname}`)
          purl = `pkg:${ecosystem}/${pkg.depname}@${cleanedVersion}`
        }
        return { purl }
      })

      try {
      // Make a POST request to the Socket API with all packages
        const response = await fetch(SOCKET_API_URL, {
          method: 'POST',
          headers: buildSocketHeaders(),
          body: JSON.stringify({ components })
        })

        const responseText = await response.text()

        if (response.status !== 200) {
          const errorMsg = `Error processing packages: [${response.status}] ${responseText}`
          logger.error(errorMsg)
          return {
            content: [{ type: 'text', text: errorMsg }],
            isError: true
          }
        } else if (!responseText.trim()) {
          const errorMsg = 'No packages were found.'
          logger.error(errorMsg)
          return {
            content: [{ type: 'text', text: errorMsg }],
            isError: true
          }
        }

        try {
        // Handle NDJSON (multiple JSON objects, one per line)
          const results: string[] = []

          if ((response.headers.get('content-type') || '').includes('x-ndjson')) {
            const jsonLines = responseText.split('\n')
              .filter(line => line.trim())
              .map(line => JSON.parse(line))

            if (!jsonLines.length) {
              const errorMsg = 'No valid JSON objects found in NDJSON response'
              return {
                content: [{ type: 'text', text: errorMsg }],
                isError: true
              }
            }

            // Process each result
            for (const jsonData of jsonLines) {
              const purl: string = `pkg:${jsonData.type || 'unknown'}/${jsonData.name || 'unknown'}@${jsonData.version || 'unknown'}`
              if (jsonData.score && jsonData.score.overall !== undefined) {
                const scoreEntries = Object.entries(jsonData.score)
                  .filter(([key]) => key !== 'overall' && key !== 'uuid')
                  .map(([key, value]) => {
                    const numValue = Number(value)
                    const displayValue = numValue <= 1 ? Math.round(numValue * 100) : numValue
                    return `${key}: ${displayValue}`
                  })
                  .join(', ')

                results.push(`${purl}: ${scoreEntries}`)
              } else {
                results.push(`${purl}: No score found`)
              }
            }
          } else {
            const jsonData = JSON.parse(responseText)
            const purl: string = `pkg:${jsonData.type || 'unknown'}/${jsonData.name || 'unknown'}@${jsonData.version || 'unknown'}`
            if (jsonData.score && jsonData.score.overall !== undefined) {
              const scoreEntries = Object.entries(jsonData.score)
                .filter(([key]) => key !== 'overall' && key !== 'uuid')
                .map(([key, value]) => {
                  const numValue = Number(value)
                  const displayValue = numValue <= 1 ? Math.round(numValue * 100) : numValue
                  return `${key}: ${displayValue}`
                })
                .join(', ')

              results.push(`${purl}: ${scoreEntries}`)
            } else {
              results.push(`${purl}: No score found`)
            }
          }

          return {
            content: [
              {
                type: 'text',
                text: results.length > 0
                  ? `Dependency scores:\n${results.join('\n')}`
                  : 'No scores found for the provided packages'
              }
            ]
          }
        } catch (e) {
          const error = e as Error
          const errorMsg = `JSON parsing error: ${error.message} -- Response: ${responseText}`
          logger.error(errorMsg)
          return {
            content: [{ type: 'text', text: 'Error parsing response from Socket API' }],
            isError: true
          }
        }
      } catch (e) {
        const error = e as Error
        const errorMsg = `Error processing packages: ${error.message}`
        logger.error(errorMsg)
        return {
          content: [{ type: 'text', text: 'Error connecting to Socket API' }],
          isError: true
        }
      }
    }
  )
  return srv
}

// Determine transport mode from environment or arguments
const useHttp = process.env['MCP_HTTP_MODE'] === 'true' || process.argv.includes('--http')
const port = parseInt(process.env['MCP_PORT'] || '3000', 10)

// Validate API key - in stdio mode, we can't prompt interactively
if (!SOCKET_API_KEY) {
  if (useHttp) {
    // In HTTP mode, we can prompt for the API key
    logger.error('SOCKET_API_KEY environment variable is not set')
    SOCKET_API_KEY = await getApiKeyInteractively()
  } else {
    // In stdio mode, we must have the API key as an environment variable
    logger.error('SOCKET_API_KEY environment variable is required in stdio mode')
    logger.error('Please set the SOCKET_API_KEY environment variable and try again')
    process.exit(1)
  }
}

if (useHttp) {
  // HTTP mode with Server-Sent Events
  logger.info(`Starting HTTP server on port ${port}`)

  // Per-session transports: each client gets its own transport, avoiding 409 Conflict
  // when Cursor reconnects or opens multiple GET requests (only one SSE stream per session)
  const transports: Record<string, StreamableHTTPServerTransport> = {}

  const httpServer = createServer(async (req, res) => {
    // Parse URL first to check for health endpoint
    let url: URL
    try {
      url = new URL(req.url!, `http://localhost:${port}`)
    } catch (error) {
      logger.warn(`Invalid URL in request: ${req.url} - ${error}`)
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Bad Request: Invalid URL' },
        id: null
      }))
      return
    }

    // Health check endpoint for K8s/Docker - bypass origin validation
    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        status: 'healthy',
        service: 'socket-mcp',
        version: VERSION,
        timestamp: new Date().toISOString()
      }))
      return
    }

    // Validate Origin header as required by MCP spec (for non-health endpoints)
    const origin = req.headers.origin

    // Check if origin is from localhost (any port) - safe for local development
    const isLocalhostOrigin = (originUrl: string): boolean => {
      try {
        const url = new URL(originUrl)
        return url.hostname === 'localhost' || url.hostname === '127.0.0.1'
      } catch {
        return false
      }
    }

    const allowedOrigins = [
      'https://mcp.socket.dev',
      'https://mcp.socket-staging.dev'
    ]

    // Check if request is from localhost (for same-origin requests that don't send Origin header)
    // Use strict matching to prevent spoofing via subdomains like "malicious-localhost.evil.com"
    const host = req.headers.host || ''

    // Extract hostnames from allowedOrigins for Host header validation
    const allowedHosts = allowedOrigins.map(o => new URL(o).hostname)

    const isAllowedHost = host === `localhost:${port}` ||
                            host === `127.0.0.1:${port}` ||
                            host === 'localhost' ||
                            host === '127.0.0.1' ||
                            allowedHosts.includes(host)

    // Allow requests:
    // 1. With Origin header from localhost (any port) or production domains
    // 2. Without Origin header if they're from localhost or allowed domains (same-origin requests)
    const isValidOrigin = origin
      ? (isLocalhostOrigin(origin) || allowedOrigins.includes(origin))
      : isAllowedHost

    if (!isValidOrigin) {
      logger.warn(`Rejected request from invalid origin: ${origin || 'missing'} (host: ${host})`)
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Forbidden: Invalid origin' },
        id: null
      }))
      return
    }

    // Set CORS headers for valid origins (only needed for cross-origin requests)
    // Mcp-Session-Id must be exposed for browser-based MCP clients
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Mcp-Session-Id')
      res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id')
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(200)
      res.end()
      return
    }

    if (url.pathname === '/') {
      // Ensure Accept header includes required MIME types for MCP Streamable HTTP spec.
      // Some clients (e.g. Cursor) may not send these, causing the SDK to reject with 406.
      // We patch both req.headers and rawHeaders because @hono/node-server reads rawHeaders.
      const accept = req.headers.accept || ''
      if (!accept.includes('application/json') || !accept.includes('text/event-stream')) {
        const requiredAccept = 'application/json, text/event-stream'
        req.headers.accept = requiredAccept
        const idx = req.rawHeaders.findIndex(h => h.toLowerCase() === 'accept')
        if (idx !== -1) {
          req.rawHeaders[idx + 1] = requiredAccept
        } else {
          req.rawHeaders.push('Accept', requiredAccept)
        }
      }

      if (req.method === 'POST') {
        // Buffer the body, then pass it as parsedBody so hono doesn't re-read the consumed stream.
        let body = ''
        req.on('data', (chunk: string) => { body += chunk })
        req.on('end', async () => {
          try {
            const jsonData = JSON.parse(body)
            const sessionId = (req.headers['mcp-session-id'] as string) || undefined
            let transport: StreamableHTTPServerTransport | undefined = sessionId ? transports[sessionId] : undefined

            if (!transport && isInitializeRequest(jsonData)) {
              const clientInfo = jsonData.params?.clientInfo
              logger.info(`Client connected: ${clientInfo?.name || 'unknown'} v${clientInfo?.version || 'unknown'} from ${origin || host}`)

              transport = new StreamableHTTPServerTransport({
                enableJsonResponse: true,
                sessionIdGenerator: () => randomUUID(),
                onsessioninitialized: (id) => { transports[id] = transport! },
                onsessionclosed: (id) => { delete transports[id] }
              })
              transport.onclose = () => {
                if (transport?.sessionId) delete transports[transport.sessionId]
              }
              const server = createConfiguredServer()
              await server.connect(transport as Transport)
            }

            if (!transport) {
              res.writeHead(400, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({
                jsonrpc: '2.0',
                error: { code: -32000, message: 'Bad Request: No valid session. Send initialize first.' },
                id: null
              }))
              return
            }

            await transport.handleRequest(req, res, jsonData)
          } catch (error) {
            logger.error(`Error processing POST request: ${error}`)
            if (!res.headersSent) {
              res.writeHead(500)
              res.end(JSON.stringify({
                jsonrpc: '2.0',
                error: { code: -32603, message: 'Internal server error' },
                id: null
              }))
            }
          }
        })
      } else if (req.method === 'GET') {
        const sessionId = (req.headers['mcp-session-id'] as string) || undefined
        const transport = sessionId ? transports[sessionId] : undefined
        if (!transport) {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Not Found: Invalid or expired session. Re-initialize.' },
            id: null
          }))
          return
        }
        await transport.handleRequest(req, res)
      } else if (req.method === 'DELETE') {
        const sessionId = (req.headers['mcp-session-id'] as string) || undefined
        const transport = sessionId ? transports[sessionId] : undefined
        if (!transport) {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Not Found: Invalid or expired session.' },
            id: null
          }))
          return
        }
        await transport.handleRequest(req, res)
      } else {
        res.writeHead(405)
        res.end('Method not allowed')
      }
    } else {
      res.writeHead(404)
      res.end('Not found')
    }
  })

  httpServer.listen(port, () => {
    logger.info(`Socket MCP HTTP server version ${VERSION} started successfully on port ${port}`)
    logger.info(`Connect to: http://localhost:${port}/`)
  })
} else {
  // Stdio mode (default)
  logger.info('Starting in stdio mode')
  const server = createConfiguredServer()
  const transport = new StdioServerTransport()
  server.connect(transport)
    .then(() => {
      logger.info(`Socket MCP server version ${VERSION} started successfully`)
    })
    .catch((error: Error) => {
      logger.error(`Failed to start Socket MCP server: ${error.message}`)
      process.exit(1)
    })
}

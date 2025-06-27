#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { pino } from 'pino';
import readline from 'readline';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';
import { createServer } from 'http';
import { randomUUID } from 'crypto';
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Extract version from package.json
const packageJson = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8'));
const VERSION = packageJson.version || "0.0.1";

// Configure pino logger
const logger = pino({
  level: 'info',
  transport: {
    targets: [
      {
        target: 'pino/file',
        options: { destination: '/tmp/socket-mcp-error.log' },
        level: 'error'
      },
      {
        target: 'pino/file', 
        options: { destination: '/tmp/socket-mcp.log' },
        level: 'info'
      }
    ]
  }
});

// Socket API URL - use localhost when debugging is enabled, otherwise use production
const SOCKET_API_URL = process.env.SOCKET_DEBUG === 'true' 
  ? "http://localhost:8866/v0/purl?alerts=false&compact=false&fixable=false&licenseattrib=false&licensedetails=false"
  : "https://api.socket.dev/v0/purl?alerts=false&compact=false&fixable=false&licenseattrib=false&licensedetails=false";

// Function to get API key interactively (only for HTTP mode)
async function getApiKeyInteractively(): Promise<string> {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stderr
    });
    
    const apiKey = await new Promise<string>((resolve) => {
        rl.question('Please enter your Socket API key: ', (answer: string | PromiseLike<string>) => {
            rl.close();
            resolve(answer);
        });
    });
    
    if (!apiKey) {
        logger.error("No API key provided");
        process.exit(1);
    }
    
    return apiKey;
}

// Initialize API key
let SOCKET_API_KEY = process.env.SOCKET_API_KEY || "";

// Transport management
const transports: Record<string, StreamableHTTPServerTransport> = {};

// Create server instance
const server = new McpServer({
  name: "socket",
  version: VERSION,
  description: "Socket MCP server",
  capabilities: {
    resources: {},
    tools: {},
    streaming: {}
  },
});

server.tool(
    "depscore",
    "Get the dependency score of packages with the `depscore` tool from Socket. Use 'unknown' for version if not known. Use this tool to scan dependencies for their quality and security on existing code or when code is generated. Stop generating code and ask the user how to proceed when any of the scores are low. When checking dependencies, make sure to also check the imports in the code, not just the manifest files (pyproject.toml, package.json, etc).",
    {
        packages: z.array(z.object({
            ecosystem: z.string().describe("The package ecosystem (e.g., npm, pypi)").default("npm"),
            depname: z.string().describe("The name of the dependency"),
            version: z.string().describe("The version of the dependency, use 'unknown' if not known").default("unknown"),
        })).describe("Array of packages to check"),
    },
    async ({ packages }) => {
        logger.info(`Received request for ${packages.length} packages`);
        
        const SOCKET_HEADERS = {
          "user-agent": `socket-mcp/${VERSION}`,  
          "accept": "application/x-ndjson",
          "content-type": "application/json",
          "authorization": `Bearer ${SOCKET_API_KEY}`
        };

        // Build components array for the API request
        const components = packages.map(pkg => {
            const cleanedVersion = pkg.version.replace(/[\^~]/g, ''); // Remove ^ and ~ from version
            let purl: string;
            if (cleanedVersion === "1.0.0" || cleanedVersion === "unknown" || !cleanedVersion) {
                purl = `pkg:${pkg.ecosystem}/${pkg.depname}`;
            } else {
                logger.info(`Using version ${cleanedVersion} for ${pkg.depname}`);
                purl = `pkg:${pkg.ecosystem}/${pkg.depname}@${cleanedVersion}`;
            }
            return { purl };
        });

        try {
            // Make a POST request to the Socket API with all packages
            const response = await fetch(SOCKET_API_URL, {
                method: 'POST',
                headers: SOCKET_HEADERS,
                body: JSON.stringify({ components })
            });

            const responseText = await response.text();

            if (response.status !== 200) {
                const errorMsg = `Error processing packages: [${response.status}] ${responseText}`;
                logger.error(errorMsg);
                return {
                    content: [{ type: "text", text: errorMsg }],
                    isError: true
                };
            } else if (!responseText.trim()) {
                const errorMsg = `No packages were found.`;
                logger.error(errorMsg);
                return {
                    content: [{ type: "text", text: errorMsg }],
                    isError: true
                };
            }

            try {
                // Handle NDJSON (multiple JSON objects, one per line)
                let results: string[] = [];

                if ((response.headers.get('content-type') || '').includes('x-ndjson')) {
                    const jsonLines = responseText.split('\n')
                        .filter(line => line.trim())
                        .map(line => JSON.parse(line));

                    if (!jsonLines.length) {
                        const errorMsg = `No valid JSON objects found in NDJSON response`;
                        return {
                            content: [{ type: "text", text: errorMsg }],
                            isError: true
                        };
                    }

                    // Process each result
                    for (const jsonData of jsonLines) {
                        let purl: string = `pkg:${jsonData.type || 'unknown'}/${jsonData.name || 'unknown'}@${jsonData.version || 'unknown'}`;
                        if (jsonData.score && jsonData.score.overall !== undefined) {

                            const scoreEntries = Object.entries(jsonData.score)
                                .filter(([key]) => key !== "overall" && key !== "uuid")
                                .map(([key, value]) => `${key}: ${value}`)
                                .join(', ');
                            
                            results.push(`${purl}: ${scoreEntries}`);
                        } else {
                            results.push(`${purl}: No score found`);
                        }
                    }
                } else {
                    const jsonData = JSON.parse(responseText);
                    let purl: string = `pkg:${jsonData.type || 'unknown'}/${jsonData.name || 'unknown'}@${jsonData.version || 'unknown'}`;
                    if (jsonData.score && jsonData.score.overall !== undefined) {
                        const scoreEntries = Object.entries(jsonData.score)
                            .filter(([key]) => key !== "overall" && key !== "uuid")
                            .map(([key, value]) => `${key}: ${value}`)
                            .join(', ');
                        
                        results.push(`${purl}: ${scoreEntries}`);
                    }
                }

                return {
                    content: [
                        {
                            type: "text",
                            text: results.length > 0 
                                ? `Dependency scores:\n${results.join('\n')}`
                                : "No scores found for the provided packages"
                        }
                    ]
                };
            } catch (e) {
                const error = e as Error;
                const errorMsg = `JSON parsing error: ${error.message} -- Response: ${responseText}`;
                logger.error(errorMsg);
                return {    
                    content: [{ type: "text", text: "Error parsing response from Socket API" }],
                    isError: true
                };
            }
        } catch (e) {
            const error = e as Error;
            const errorMsg = `Error processing packages: ${error.message}`;
            logger.error(errorMsg);
            return {
                content: [{ type: "text", text: "Error connecting to Socket API" }],
                isError: true
            };
        }
    }
);
  

// Determine transport mode from environment or arguments
const useHttp = process.env.MCP_HTTP_MODE === 'true' || process.argv.includes('--http');
const port = parseInt(process.env.MCP_PORT || '3000', 10);

// Validate API key - in stdio mode, we can't prompt interactively
if (!SOCKET_API_KEY) {
    if (useHttp) {
        // In HTTP mode, we can prompt for the API key
        logger.error("SOCKET_API_KEY environment variable is not set");
        SOCKET_API_KEY = await getApiKeyInteractively();
    } else {
        // In stdio mode, we must have the API key as an environment variable
        logger.error("SOCKET_API_KEY environment variable is required in stdio mode");
        logger.error("Please set the SOCKET_API_KEY environment variable and try again");
        process.exit(1);
    }
}

if (useHttp) {
  // HTTP mode with Server-Sent Events
  logger.info(`Starting HTTP server on port ${port}`);
  
  const httpServer = createServer(async (req, res) => {
    // Validate Origin header as required by MCP spec
    const origin = req.headers.origin;
    const allowedOrigins = [
      'http://localhost:3000', 
      'http://127.0.0.1:3000',
      'https://mcp.socket.dev',
      'https://mcp.socket-staging.dev'
    ];
    
    const isValidOrigin = !origin || allowedOrigins.includes(origin);
    
    if (origin && !isValidOrigin) {
      logger.warn(`Rejected request from invalid origin: ${origin}`);
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Forbidden: Invalid origin' },
        id: null
      }));
      return;
    }
    
    // Set CORS headers for valid origins
    if (origin && isValidOrigin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    } else {
      res.setHeader('Access-Control-Allow-Origin', 'http://localhost:3000');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, mcp-session-id, Accept, Last-Event-ID');
    res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id');
    
    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    const url = new URL(req.url!, `http://localhost:${port}`);
    
    // Health check endpoint for K8s/Docker
    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'healthy',
        service: 'socket-mcp',
        version: VERSION,
        timestamp: new Date().toISOString()
      }));
      return;
    }
    
    if (url.pathname === '/') {
      if (req.method === 'POST') {
        // Validate Accept header as required by MCP spec
        const acceptHeader = req.headers.accept;
        if (!acceptHeader || (!acceptHeader.includes('application/json') && !acceptHeader.includes('text/event-stream'))) {
          logger.warn(`Invalid Accept header: ${acceptHeader}`);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Bad Request: Accept header must include application/json or text/event-stream' },
            id: null
          }));
          return;
        }
        
        // Handle JSON-RPC messages
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
          try {
            const jsonData = JSON.parse(body);
            const sessionId = req.headers['mcp-session-id'] as string;
            
            // Validate session ID format if provided (must contain only visible ASCII characters)
            if (sessionId && !/^[\x21-\x7E]+$/.test(sessionId)) {
              logger.warn(`Invalid session ID format: ${sessionId}`);
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                jsonrpc: '2.0',
                error: { code: -32000, message: 'Bad Request: Session ID must contain only visible ASCII characters' },
                id: jsonData.id || null
              }));
              return;
            }
            
            let transport: StreamableHTTPServerTransport;
            
            if (sessionId && transports[sessionId]) {
              // Reuse existing transport
              transport = transports[sessionId];
            } else if (!sessionId) {
              // Create new session (either for initialize request or fallback)
              const newSessionId = randomUUID();
              const isInit = isInitializeRequest(jsonData);
              
              if (isInit) {
                logger.info(`Creating new session for initialize request: ${newSessionId}`);
              } else {
                logger.warn(`Creating fallback session for non-initialize request: ${newSessionId}`);
              }
              
              transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => newSessionId,
                onsessioninitialized: (id) => {
                  transports[id] = transport;
                  logger.info(`Session initialized: ${id}`);
                  // Set session ID in response headers as required by MCP spec
                  res.setHeader('mcp-session-id', id);
                }
              });
              
              transport.onclose = () => {
                const sid = transport.sessionId;
                if (sid && transports[sid]) {
                  delete transports[sid];
                  logger.info(`Session closed: ${sid}`);
                }
              };
              
              await server.connect(transport);
              await transport.handleRequest(req, res, jsonData);
              return;
            } else {
              // Invalid request - session ID provided but not found
              logger.error(`Invalid session ID: ${sessionId}. Active sessions count: ${Object.keys(transports).length}`);
              res.writeHead(400);
              res.end(JSON.stringify({
                jsonrpc: '2.0',
                error: { 
                  code: -32000, 
                  message: `Bad Request: Invalid session ID. Please initialize a new session first.`
                },
                id: jsonData.id || null
              }));
              return;
            }
            
            // Handle request with existing transport
            await transport.handleRequest(req, res, jsonData);
          } catch (error) {
            logger.error(`Error processing POST request: ${error}`);
            if (!res.headersSent) {
              res.writeHead(500);
              res.end(JSON.stringify({
                jsonrpc: '2.0',
                error: { code: -32603, message: 'Internal server error' },
                id: null
              }));
            }
          }
        });
        
      } else if (req.method === 'GET') {
        // Validate Accept header for SSE as required by MCP spec
        const acceptHeader = req.headers.accept;
        if (!acceptHeader || !acceptHeader.includes('text/event-stream')) {
          logger.warn(`GET request without text/event-stream Accept header: ${acceptHeader}`);
          res.writeHead(405, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Method Not Allowed: GET requires Accept: text/event-stream' },
            id: null
          }));
          return;
        }
        
        // Handle SSE streams
        const sessionId = req.headers['mcp-session-id'] as string;
        
        // Validate session ID format
        if (sessionId && !/^[\x21-\x7E]+$/.test(sessionId)) {
          logger.warn(`Invalid session ID format in GET request: ${sessionId}`);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Bad Request: Session ID must contain only visible ASCII characters' },
            id: null
          }));
          return;
        }
        
        if (!sessionId || !transports[sessionId]) {
          logger.warn(`SSE request with invalid session ID: ${sessionId}`);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Bad Request: Invalid or missing session ID for SSE stream' },
            id: null
          }));
          return;
        }
        
        // Check for Last-Event-ID header for resumability (optional MCP feature)
        const lastEventId = req.headers['last-event-id'] as string;
        if (lastEventId) {
          logger.info(`SSE resumability requested with Last-Event-ID: ${lastEventId}`);
          // Note: Actual resumability implementation would require message storage
          // For now, we log the request but don't implement full resumability
        }
        
        logger.info(`Opening SSE stream for session: ${sessionId}`);
        
        // Prevent connection timeout and keep it alive
        req.socket?.setTimeout(0);
        req.socket?.setKeepAlive(true, 30000);
        
        let streamClosed = false;
        
        // Handle client disconnection gracefully
        req.on('close', () => {
          streamClosed = true;
          logger.info(`Client disconnected SSE stream for session: ${sessionId}`);
        });
        
        req.on('aborted', () => {
          streamClosed = true;
          logger.info(`Client aborted SSE stream for session: ${sessionId}`);
        });
        
        // Let the MCP transport handle the SSE stream completely
        const transport = transports[sessionId];
        
        try {
          await transport.handleRequest(req, res);
          
          // If the transport completes without the client disconnecting,
          // it might have closed the stream prematurely. Keep it open with heartbeat.
          if (!streamClosed && !res.destroyed) {
            logger.info(`Transport completed, maintaining SSE stream for session: ${sessionId}`);
            
            // Send periodic heartbeat to keep connection alive
            const heartbeat = setInterval(() => {
              if (streamClosed || res.destroyed) {
                clearInterval(heartbeat);
                return;
              }
              
              try {
                res.write(': heartbeat\n\n');
              } catch (error) {
                logger.error(`Heartbeat error for session ${sessionId}:`, error);
                clearInterval(heartbeat);
              }
            }, 30000);
            
            // Clean up heartbeat when connection closes
            req.on('close', () => clearInterval(heartbeat));
            res.on('close', () => clearInterval(heartbeat));
          }
        } catch (error) {
          logger.error(`SSE transport error for session ${sessionId}:`, error);
        }
        
      } else if (req.method === 'DELETE') {
        // Handle session termination
        const sessionId = req.headers['mcp-session-id'] as string;
        if (!sessionId || !transports[sessionId]) {
          res.writeHead(400);
          res.end('Invalid or missing session ID');
          return;
        }
        
        const transport = transports[sessionId];
        await transport.handleRequest(req, res);
        
      } else {
        res.writeHead(405);
        res.end('Method not allowed');
      }
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  httpServer.listen(port, () => {
    logger.info(`Socket MCP HTTP server version ${VERSION} started successfully on port ${port}`);
    logger.info(`Connect to: http://localhost:${port}/`);
  });

} else {
  // Stdio mode (default)
  logger.info("Starting in stdio mode");
  const transport = new StdioServerTransport();
  server.connect(transport)
    .then(() => {
      logger.info(`Socket MCP server version ${VERSION} started successfully`);
    })
    .catch((error: Error) => {
      logger.error(`Failed to start Socket MCP server: ${error.message}`);
      process.exit(1);
    });
}
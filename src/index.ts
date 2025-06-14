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
                    isError: false
                };
            } else if (!responseText.trim()) {
                const errorMsg = `No packages were found.`;
                logger.error(errorMsg);
                return {
                    content: [{ type: "text", text: errorMsg }],
                    isError: false
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

// Now that we have the API key, set up the headers
const SOCKET_HEADERS = {
  "user-agent": `socket-mcp/${VERSION}`,  
  "accept": "application/x-ndjson",
  "content-type": "application/json",
  "authorization": `Bearer ${SOCKET_API_KEY}`
};

if (useHttp) {
  // HTTP mode with Server-Sent Events
  logger.info(`Starting HTTP server on port ${port}`);
  
  const httpServer = createServer(async (req, res) => {
    // Enable CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, mcp-session-id');
    
    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    const url = new URL(req.url!, `http://localhost:${port}`);
    
    if (url.pathname === '/mcp') {
      if (req.method === 'POST') {
        // Handle JSON-RPC messages
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
          try {
            const jsonData = JSON.parse(body);
            const sessionId = req.headers['mcp-session-id'] as string;
            
            let transport: StreamableHTTPServerTransport;
            
            if (sessionId && transports[sessionId]) {
              // Reuse existing transport
              transport = transports[sessionId];
            } else if (!sessionId && isInitializeRequest(jsonData)) {
              // New initialization request
              transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                onsessioninitialized: (id) => {
                  transports[id] = transport;
                  logger.info(`Session initialized: ${id}`);
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
              // Invalid request
              res.writeHead(400);
              res.end(JSON.stringify({
                jsonrpc: '2.0',
                error: { code: -32000, message: 'Bad Request: No valid session ID' },
                id: null
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
        // Handle SSE streams
        const sessionId = req.headers['mcp-session-id'] as string;
        if (!sessionId || !transports[sessionId]) {
          res.writeHead(400);
          res.end('Invalid or missing session ID');
          return;
        }
        
        const transport = transports[sessionId];
        await transport.handleRequest(req, res);
        
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
    logger.info(`Connect to: http://localhost:${port}/mcp`);
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
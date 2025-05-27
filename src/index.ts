#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fetch from 'node-fetch';
import winston from 'winston';

const VERSION = "0.0.1"; // Version of the MCP server

// Configure winston logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'socket-mcp-error.log', level: 'error' }),
    new winston.transports.File({ filename: 'socket-mcp.log' })
  ]
});

const SOCKET_API_URL = "https://api.socket.dev/v0/purl?alerts=false&compact=false&fixable=false&licenseattrib=false&licensedetails=false";

const SOCKET_API_KEY = process.env.SOCKET_API_KEY || "";
if (!SOCKET_API_KEY) {
  logger.error("SOCKET_API_KEY environment variable is not set");
  process.exit(1);
}

const SOCKET_HEADERS = {
  "user-agent": `socket-mcp/${VERSION}`,  
  "accept": "application/x-ndjson",
  "content-type": "application/json",
  "authorization": `Bearer ${SOCKET_API_KEY}`
};

// Create server instance
const server = new McpServer({
  name: "socket",
  version: VERSION,
  description: "Socket MCP server",
  capabilities: {
    resources: {},
    tools: {},
  },
});

server.tool(
    "depscore",
    "Get the dependency score of a package with the `depscore` tool from Socket. Use 'unknown' for version if not known. Use this tool to scan dependencies for their quality and security on existing code or when code is generated. Stop generating code and ask the user how to proceed when any of the scores are low. When checking dependencies, make sure to also check the imports in the code, not just the manifest files (pyproject.toml, package.json, etc).",
    {
        ecosystem: z.string().describe("The package ecosystem (e.g., npm, pypi)").default("npm"),
        depname: z.string().describe("The name of the dependency"),
        version: z.string().describe("The version of the dependency, use 'unknown' if not known").default("unknown"),
    },
    async ({ ecosystem, depname, version }) => {
        logger.info(`Received request for ${depname} (${version}) in ${ecosystem} ecosystem`);
        
        // cleanup version
        let purl: string;
        const cleanedVersion = version.replace(/[\^~]/g, ''); // Remove ^ and ~ from version
        if (cleanedVersion === "1.0.0" || cleanedVersion === "unknown" || !cleanedVersion) {
            purl = `pkg:${ecosystem}/${depname}`;
        } else {
            logger.info(`Using version ${cleanedVersion} for ${depname}`);
            purl = `pkg:${ecosystem}/${depname}@${cleanedVersion}`;
        }

        try {
            // Make a POST request to the Socket API
            const response = await fetch(SOCKET_API_URL, {
                method: 'POST',
                headers: SOCKET_HEADERS,
                body: JSON.stringify({ components: [{ purl }] })
            });

            const responseText = await response.text();

            if (response.status !== 200) {
                const errorMsg = `Error processing ${purl}: [${response.status}] ${responseText}`;
                logger.error(errorMsg);
                return {
                    content: [{ type: "text", text: errorMsg }],
                    isError: false
                };
            } else if (!responseText.trim()) {
                const errorMsg = `${purl} was not found.`;
                logger.error(errorMsg);
                return {
                    content: [{ type: "text", text: errorMsg }],
                    isError: false
                };
            }

            try {
                // Handle NDJSON (multiple JSON objects, one per line)
                let jsonData: any;

                if ((response.headers.get('content-type') || '').includes('x-ndjson')) {
                    const jsonLines = responseText.split('\n')
                        .filter(line => line.trim())
                        .map(line => JSON.parse(line));

                    if (!jsonLines.length) {
                        const errorMsg = `No valid JSON objects found in NDJSON response for ${purl}`;
                        return {
                            content: [{ type: "text", text: errorMsg }],
                            isError: true
                        };
                    }

                    jsonData = jsonLines[0];
                } else {
                    jsonData = JSON.parse(responseText);
                }

                if (jsonData.score && jsonData.score.overall !== undefined) {
                    // Unroll the jsonData.score object into key-value pairs
                    const scoreEntries = Object.entries(jsonData.score)
                        .filter(([key]) => key !== "overall" && key !== "uuid")
                        .map(([key, value]) => `${key}: ${value}`)
                        .join(', ');

                    return {
                        content: [
                            {
                                type: "text",
                                text: `Dependency scores for ${purl}: ${scoreEntries}`
                            }
                        ]
                    };
                } else {
                    return {
                        content: [
                            {
                                type: "text",
                                text: `No score found for ${purl}`
                            }
                        ]
                    };
                }
            } catch (e) {
                const error = e as Error;
                const errorMsg = `JSON parsing error for ${purl}: ${error.message} -- Response: ${responseText}`;
                logger.error(errorMsg);
                const llmResponse = `Package ${purl} not found.`;
                return {    
                    content: [{ type: "text", text: llmResponse }],
                    isError: true
                };
            }
        } catch (e) {
            const error = e as Error;
            const errorMsg = `Error processing ${purl}: ${error.message}`;
            logger.error(errorMsg);
            const llmResponse = `Package ${purl} not found.`;
            return {
                content: [{ type: "text", text: llmResponse }],
                isError: true
            };
        }
    }
);
  

// Create a stdio transport and start the server
const transport = new StdioServerTransport();
server.connect(transport)
  .then(() => {
    logger.info("Socket MCP server started successfully");
  })
  .catch((error: Error) => {
    logger.error(`Failed to start Socket MCP server: ${error.message}`);
    process.exit(1);
  });
#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import winston from 'winston';
import readline from 'readline';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Extract version from package.json
const packageJson = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8'));
const VERSION = packageJson.version || "0.0.1";
// Configure winston logger
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(winston.format.timestamp(), winston.format.errors({ stack: true }), winston.format.json()),
    transports: [
        new winston.transports.File({ filename: 'socket-mcp-error.log', level: 'error' }),
        new winston.transports.File({ filename: 'socket-mcp.log' })
    ]
});
logger.info(`Starting Socket MCP server version ${VERSION}`);
const SOCKET_API_URL = "https://api.socket.dev/v0/purl?alerts=false&compact=false&fixable=false&licenseattrib=false&licensedetails=false";
let SOCKET_API_KEY = process.env.SOCKET_API_KEY || "";
if (!SOCKET_API_KEY) {
    logger.error("SOCKET_API_KEY environment variable is not set");
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stderr
    });
    const apiKey = await new Promise((resolve) => {
        rl.question('Please enter your Socket API key: ', (answer) => {
            rl.close();
            resolve(answer);
        });
    });
    if (!apiKey) {
        logger.error("No API key provided");
        process.exit(1);
    }
    SOCKET_API_KEY = apiKey;
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
server.tool("depscore", "Get the dependency score of packages with the `depscore` tool from Socket. Use 'unknown' for version if not known. Use this tool to scan dependencies for their quality and security on existing code or when code is generated. Stop generating code and ask the user how to proceed when any of the scores are low. When checking dependencies, make sure to also check the imports in the code, not just the manifest files (pyproject.toml, package.json, etc).", {
    packages: z.array(z.object({
        ecosystem: z.string().describe("The package ecosystem (e.g., npm, pypi)").default("npm"),
        depname: z.string().describe("The name of the dependency"),
        version: z.string().describe("The version of the dependency, use 'unknown' if not known").default("unknown"),
    })).describe("Array of packages to check"),
}, async ({ packages }) => {
    logger.info(`Received request for ${packages.length} packages`);
    // Build components array for the API request
    const components = packages.map(pkg => {
        const cleanedVersion = pkg.version.replace(/[\^~]/g, ''); // Remove ^ and ~ from version
        let purl;
        if (cleanedVersion === "1.0.0" || cleanedVersion === "unknown" || !cleanedVersion) {
            purl = `pkg:${pkg.ecosystem}/${pkg.depname}`;
        }
        else {
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
        }
        else if (!responseText.trim()) {
            const errorMsg = `No packages were found.`;
            logger.error(errorMsg);
            return {
                content: [{ type: "text", text: errorMsg }],
                isError: false
            };
        }
        try {
            // Handle NDJSON (multiple JSON objects, one per line)
            let results = [];
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
                    let purl = `pkg:${jsonData.type || 'unknown'}/${jsonData.name || 'unknown'}@${jsonData.version || 'unknown'}`;
                    if (jsonData.score && jsonData.score.overall !== undefined) {
                        const scoreEntries = Object.entries(jsonData.score)
                            .filter(([key]) => key !== "overall" && key !== "uuid")
                            .map(([key, value]) => `${key}: ${value}`)
                            .join(', ');
                        const packageName = jsonData.name || 'unknown';
                        results.push(`${purl}: ${scoreEntries}`);
                    }
                    else {
                        const packageName = jsonData.name || 'unknown';
                        results.push(`${purl}: No score found`);
                    }
                }
            }
            else {
                const jsonData = JSON.parse(responseText);
                let purl = `pkg:${jsonData.type || 'unknown'}/${jsonData.name || 'unknown'}@${jsonData.version || 'unknown'}`;
                if (jsonData.score && jsonData.score.overall !== undefined) {
                    const scoreEntries = Object.entries(jsonData.score)
                        .filter(([key]) => key !== "overall" && key !== "uuid")
                        .map(([key, value]) => `${key}: ${value}`)
                        .join(', ');
                    const packageName = jsonData.package?.name || 'unknown';
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
        }
        catch (e) {
            const error = e;
            const errorMsg = `JSON parsing error: ${error.message} -- Response: ${responseText}`;
            logger.error(errorMsg);
            return {
                content: [{ type: "text", text: "Error parsing response from Socket API" }],
                isError: true
            };
        }
    }
    catch (e) {
        const error = e;
        const errorMsg = `Error processing packages: ${error.message}`;
        logger.error(errorMsg);
        return {
            content: [{ type: "text", text: "Error connecting to Socket API" }],
            isError: true
        };
    }
});
// Create a stdio transport and start the server
const transport = new StdioServerTransport();
server.connect(transport)
    .then(() => {
    logger.info("Socket MCP server started successfully");
})
    .catch((error) => {
    logger.error(`Failed to start Socket MCP server: ${error.message}`);
    process.exit(1);
});

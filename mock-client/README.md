# Socket MCP Debug Clients

Simple debug clients for testing the Socket MCP server in different modes.

## Quick Start

### 1. Build the project
```bash
npm run build
```

### 2. Start the MCP server

**STDIO mode:**
```bash
SOCKET_API_KEY=your-api-key ./build/index.js
```

**HTTP mode:**
```bash
MCP_HTTP_MODE=true SOCKET_API_KEY=your-api-key ./build/index.js
```

**HTTP mode with custom port:**
```bash
MCP_HTTP_MODE=true MCP_PORT=3901 SOCKET_API_KEY=your-api-key ./build/index.js
```

### 3. Test with debug clients

**Test STDIO mode:**
```bash
npm run debug:stdio
```

**Test HTTP mode (default port 3000):**
```bash
npm run debug:http
```

**Test HTTP mode (custom URL):**
```bash
MCP_URL="http://localhost:3901/" npm run debug:http
```

**Test with MCP SDK client:**
```bash
npm run debug:sdk
```

## What the debug clients test

- **Initialize**: Connect to MCP server and get server info
- **List tools**: Get available tools (should show `depscore`)
- **Call depscore**: Test dependency scoring with sample packages
- **Cleanup**: Close connection properly

## Troubleshooting

**Server not responding?**
- Check if server is running: `curl http://localhost:3000/health`
- Verify API key is set
- Check server logs for errors

**HTTP client getting 404?**
- Remove trailing slash from MCP_URL
- Verify server is in HTTP mode (`MCP_HTTP_MODE=true`)

**STDIO client hanging?**
- Ctrl+C to exit
- Check server is in STDIO mode (no `MCP_HTTP_MODE`)
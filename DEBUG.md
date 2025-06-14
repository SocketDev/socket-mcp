# Socket MCP Mock Client Tools

The `mock-client` directory contains debug clients for testing the Socket MCP server.

## Prerequisites

1. Build the project:

   ```bash
   npm run build
   ```

2. Set your Socket API key:

   ```bash
   export SOCKET_API_KEY="your-api-key-here"
   ```

## Debug Clients

### 1. Simple JSON-RPC Client (`mock-client/debug-client.ts`)

Direct stdio communication using JSON-RPC protocol:

```bash
npm run debug:stdio
```

This client:

- Sends raw JSON-RPC messages to the MCP server
- Tests initialization, tool listing, and depscore calls
- Useful for debugging protocol-level issues

### 2. MCP SDK Client (`mock-client/stdio-client.ts`)

Uses the official MCP SDK client library:

```bash
npm run debug:sdk
```

This client:

- Uses the same SDK that real MCP clients use
- Tests the server's compatibility with the SDK
- Good for integration testing

### 3. HTTP Mode Client (`mock-client/http-client.ts`)

Tests the HTTP/SSE transport mode:

```bash
# First, start the server in HTTP mode:
npm run server:http

# In another terminal:
npm run debug:http
```

This client:

- Tests HTTP POST requests and SSE streams
- Verifies session management
- Tests CORS and HTTP-specific features

## What Each Client Tests

All clients test the following scenarios:

1. **Connection initialization** - MCP protocol handshake
2. **Tool discovery** - Lists available tools
3. **Basic depscore call** - Tests with npm and PyPI packages
4. **Error handling** - Tests with invalid inputs
5. **Edge cases** - Unknown packages, minimal inputs

## Interpreting Results

### Successful Response

```json
{
  "content": [
    {
      "type": "text",
      "text": "Package: express@4.18.2\nScore: 0.85\n..."
    }
  ]
}
```

### Error Response

```json
{
  "error": {
    "code": -32602,
    "message": "Invalid params",
    "data": "Expected array with at least 1 element"
  }
}
```

## Common Issues

1. **API Key Missing**: Set `SOCKET_API_KEY` environment variable
2. **Build Errors**: Run `npm run build` first
3. **Permission Denied**: Check file permissions (should be executable)
4. **Connection Refused**: For HTTP mode, ensure server is running

## Advanced Usage

### Custom API Endpoint

To test against a local Socket API:

```bash
# Edit src/index.ts and change SOCKET_API_URL
# Then rebuild and test
```

### Verbose Logging

Check logs at:

- `/tmp/socket-mcp.log` - Info logs
- `/tmp/socket-mcp-error.log` - Error logs

### Testing Specific Packages

Edit the test clients to modify the `testPackages` array with your specific packages to test.

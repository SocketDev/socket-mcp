#!/usr/bin/env node --experimental-strip-types
import { join } from 'path';

// Helper function to parse SSE or JSON response
async function parseResponse(response: any) {
  const contentType = response.headers.get('content-type');
  const text = await response.text();

  if (contentType?.includes('text/event-stream')) {
    // Parse SSE format: "event: message\ndata: {json}\n"
    const dataMatch = text.match(/data: (.+)/);
    if (dataMatch) {
      return JSON.parse(dataMatch[1]);
    }
    return null;
  } else {
    return JSON.parse(text);
  }
}

// Simple HTTP client for testing MCP server in HTTP mode
async function testHTTPMode() {
  const baseUrl = (process.env['MCP_URL'] || 'http://localhost:3000').replace(/\/$/, ''); // Remove trailing slash
  const sessionId = `test-session-${Date.now()}`;

  console.log('Testing Socket MCP in HTTP mode...');
  console.log(`Server URL: ${baseUrl}`);
  console.log(`Session ID: ${sessionId}`);

  try {
    // 1. Initialize connection
    console.log('\n1. Initializing connection...');
    const initRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '0.1.0',
        capabilities: {},
        clientInfo: {
          name: 'http-debug-client',
          version: '1.0.0'
        }
      }
    };

    const initResponse = await fetch(`${baseUrl}/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'User-Agent': 'socket-mcp-debug-client/1.0.0'
      },
      body: JSON.stringify(initRequest)
    });

    const initResult = await parseResponse(initResponse);
    console.log('Initialize response:', JSON.stringify(initResult, null, 2));

    // Extract session ID from response headers
    const serverSessionId = initResponse.headers.get('mcp-session-id');
    const actualSessionId = serverSessionId || sessionId;
    console.log('Session ID:', actualSessionId);

    // 2. List tools
    console.log('\n2. Listing available tools...');
    const toolsRequest = {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {}
    };

    const toolsResponse = await fetch(`${baseUrl}/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'mcp-session-id': actualSessionId
      },
      body: JSON.stringify(toolsRequest)
    });

    const toolsResult = await parseResponse(toolsResponse);
    console.log('Available tools:', JSON.stringify(toolsResult, null, 2));

    // 3. Call depscore
    console.log('\n3. Calling depscore tool...');
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
            { depname: 'react', ecosystem: 'npm', version: '18.2.0' }
          ]
        }
      }
    };

    const depscoreResponse = await fetch(`${baseUrl}/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'mcp-session-id': actualSessionId
      },
      body: JSON.stringify(depscoreRequest)
    });

    const depscoreResult = await parseResponse(depscoreResponse);
    console.log('Depscore result:', JSON.stringify(depscoreResult, null, 2));

    // 4. Test SSE stream (optional)
    console.log('\n4. Testing SSE stream connection...');
    const sseResponse = await fetch(`${baseUrl}/`, {
      method: 'GET',
      headers: {
        'mcp-session-id': actualSessionId,
        'Accept': 'text/event-stream'
      }
    });

    if (sseResponse.ok) {
      console.log('SSE stream connected successfully');
      // Note: In a real implementation, you'd parse the SSE stream
    }

    // 5. Clean up session
    console.log('\n5. Cleaning up session...');
    const cleanupResponse = await fetch(`${baseUrl}/`, {
      method: 'DELETE',
      headers: {
        'mcp-session-id': actualSessionId
      }
    });

    console.log('Session cleanup:', cleanupResponse.status === 200 ? 'Success' : 'Failed');

  } catch (error) {
    console.error('Error:', error);
  }
}

// Usage instructions
if (process.argv.includes('--help')) {
  const serverScript = join(import.meta.dirname, '..', 'index.ts');
  console.log(`
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
`);
  process.exit(0);
}

testHTTPMode().catch(console.error);

#!/usr/bin/env node
import fetch from 'node-fetch';

// Simple HTTP client for testing MCP server in HTTP mode
async function testHTTPMode() {
  const baseUrl = process.env.MCP_URL || 'http://localhost:3000';
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

    const initResponse = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': sessionId
      },
      body: JSON.stringify(initRequest)
    });

    const initResult = await initResponse.json();
    console.log('Initialize response:', JSON.stringify(initResult, null, 2));

    // 2. List tools
    console.log('\n2. Listing available tools...');
    const toolsRequest = {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {}
    };

    const toolsResponse = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': sessionId
      },
      body: JSON.stringify(toolsRequest)
    });

    const toolsResult = await toolsResponse.json();
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

    const depscoreResponse = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': sessionId
      },
      body: JSON.stringify(depscoreRequest)
    });

    const depscoreResult = await depscoreResponse.json();
    console.log('Depscore result:', JSON.stringify(depscoreResult, null, 2));

    // 4. Test SSE stream (optional)
    console.log('\n4. Testing SSE stream connection...');
    const sseResponse = await fetch(`${baseUrl}/mcp`, {
      method: 'GET',
      headers: {
        'x-session-id': sessionId,
        'Accept': 'text/event-stream'
      }
    });

    if (sseResponse.ok) {
      console.log('SSE stream connected successfully');
      // Note: In a real implementation, you'd parse the SSE stream
    }

    // 5. Clean up session
    console.log('\n5. Cleaning up session...');
    const cleanupResponse = await fetch(`${baseUrl}/mcp`, {
      method: 'DELETE',
      headers: {
        'x-session-id': sessionId
      }
    });

    console.log('Session cleanup:', cleanupResponse.status === 200 ? 'Success' : 'Failed');

  } catch (error) {
    console.error('Error:', error);
  }
}

// Usage instructions
if (process.argv.includes('--help')) {
  console.log(`
Socket MCP HTTP Client Debugger

Usage:
  # Start the MCP server in HTTP mode first:
  MCP_HTTP_MODE=true SOCKET_API_KEY=your-api-key ./build/index.js

  # Then run this client:
  npm run build
  node ./build/http-client.js

Environment variables:
  MCP_URL - Server URL (default: http://localhost:3000)

Example:
  MCP_URL=http://localhost:8080 node ./build/http-client.js
`);
  process.exit(0);
}

testHTTPMode().catch(console.error);
#!/usr/bin/env node --experimental-strip-types
import { spawn } from 'child_process';
import readline from 'readline';
import { join } from 'path';

// Simple JSON-RPC client for testing MCP server
class SimpleJSONRPCClient {
  private process: any;
  private rl: readline.Interface;
  private requestId = 1;
  private pendingRequests = new Map();

  constructor(command: string, args: string[] = [], env: any = {}) {
    this.process = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env }
    });

    this.rl = readline.createInterface({
      input: this.process.stdout,
      crlfDelay: Infinity
    });

    this.rl.on('line', (line) => {
      try {
        const response = JSON.parse(line);
        if (response.id && this.pendingRequests.has(response.id)) {
          const { resolve, reject } = this.pendingRequests.get(response.id);
          this.pendingRequests.delete(response.id);

          if (response.error) {
            reject(response.error);
          } else {
            resolve(response.result);
          }
        } else if (response.method) {
          console.log('Notification:', response);
        }
      } catch (e) {
        console.error('Failed to parse response:', line);
      }
    });

    this.process.stderr.on('data', (data: Buffer) => {
      console.error('Server stderr:', data.toString());
    });
  }

  async sendRequest(method: string, params: any = {}) {
    const id = this.requestId++;
    const request = {
      jsonrpc: '2.0',
      id,
      method,
      params
    };

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      this.process.stdin.write(JSON.stringify(request) + '\n');
    });
  }

  close() {
    this.rl.close();
    this.process.kill();
  }
}



async function main() {
  const apiKey = process.env['SOCKET_API_KEY'];
  if (!apiKey) {
    console.error('Error: SOCKET_API_KEY environment variable is required');
    process.exit(1);
  }

  console.log('Starting MCP server debug client...');

  const serverPath = join(import.meta.dirname, '..', 'index.ts');
  console.log(`Using server script: ${serverPath}`);

  const client = new SimpleJSONRPCClient('node', ['--experimental-strip-types', serverPath], {
    SOCKET_API_KEY: apiKey
  });

  try {
    // Initialize the connection
    console.log('\n1. Initializing connection...');
    const initResult = await client.sendRequest('initialize', {
      protocolVersion: '0.1.0',
      capabilities: {},
      clientInfo: {
        name: 'debug-client',
        version: '1.0.0'
      }
    });
    console.log('Initialize response:', JSON.stringify(initResult, null, 2));

    // List available tools
    console.log('\n2. Listing available tools...');
    const toolsResult = await client.sendRequest('tools/list', {});
    console.log('Available tools:', JSON.stringify(toolsResult, null, 2));

    // Call the depscore tool
    console.log('\n3. Calling depscore tool...');
    const depscoreResult = await client.sendRequest('tools/call', {
      name: 'depscore',
      arguments: {
        packages: [
          { depname: 'express', ecosystem: 'npm', version: '5.0.1' },
          { depname: 'lodash', ecosystem: 'npm', version: '4.17.21' },
          { depname: 'react', ecosystem: 'npm', version: '18.2.0' },
          { depname: 'flask', ecosystem: 'pypi', version: '2.3.2' },
          { depname: 'unknown-package', ecosystem: 'npm', version: 'unknown' }
        ]
      }
    });
    console.log('Depscore result:', JSON.stringify(depscoreResult, null, 2));

    // Test with minimal input
    console.log('\n4. Testing with minimal input (default to npm)...');
    const minimalResult = await client.sendRequest('tools/call', {
      name: 'depscore',
      arguments: {
        packages: [
          { depname: 'axios' },
          { depname: 'typescript' }
        ]
      }
    });
    console.log('Minimal input result:', JSON.stringify(minimalResult, null, 2));

    // Test error handling
    console.log('\n5. Testing error handling (empty packages)...');
    try {
      await client.sendRequest('tools/call', {
        name: 'depscore',
        arguments: {
          packages: []
        }
      });
    } catch (error) {
      console.log('Expected error:', error);
    }

    console.log('\nDebug session complete!');
  } catch (error) {
    console.error('Client error:', error);
  } finally {
    client.close();
  }
}

main().catch(console.error);

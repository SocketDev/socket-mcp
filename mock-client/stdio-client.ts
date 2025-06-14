#!/usr/bin/env node
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

async function main() {
  const transport = new StdioClientTransport({
    command: './build/index.js',
    args: [],
    env: {
      ...process.env,
      SOCKET_API_KEY: process.env.SOCKET_API_KEY || ''
    }
  });

  const client = new Client({
    name: 'test-mcp-client',
    version: '1.0.0'
  }, {
    capabilities: {}
  });

  try {
    await client.connect(transport);
    console.log('Connected to MCP server');

    // List available tools
    const tools = await client.listTools();
    console.log('Available tools:', tools.tools.map(t => t.name));

    // Test the depscore tool
    const testPackages = [
      { depname: 'express', ecosystem: 'npm', version: '4.18.2' },
      { depname: 'lodash', ecosystem: 'npm', version: '4.17.21' },
      { depname: 'react', ecosystem: 'npm', version: '18.2.0' },
      { depname: 'requests', ecosystem: 'pypi', version: '2.31.0' },
      { depname: 'unknown-package', ecosystem: 'npm', version: 'unknown' }
    ];

    console.log('\nTesting depscore with packages:', testPackages);

    const result = await client.callTool({
      name: 'depscore',
      arguments: {
        packages: testPackages
      }
    });

    console.log('\nDepscore results:');
    console.log(JSON.stringify(result, null, 2));

    await client.close();
    console.log('\nClient closed successfully');
  } catch (error) {
    console.error('Error:', error);
    await client.close();
    process.exit(1);
  }
}

// Run the client
main().catch(console.error);
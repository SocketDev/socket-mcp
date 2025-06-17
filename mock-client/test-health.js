#!/usr/bin/env node

import http from 'http';

const port = process.env.MCP_PORT || 3000;

// Simple health check test
const options = {
  hostname: 'localhost',
  port: port,
  path: '/health',
  method: 'GET'
};

const req = http.request(options, (res) => {
  console.log(`Health check status: ${res.statusCode}`);
  console.log(`Headers:`, res.headers);
  
  let data = '';
  res.on('data', (chunk) => {
    data += chunk;
  });
  
  res.on('end', () => {
    try {
      const response = JSON.parse(data);
      console.log('Health response:', JSON.stringify(response, null, 2));
    } catch (e) {
      console.log('Raw response:', data);
    }
    process.exit(0);
  });
});

req.on('error', (err) => {
  console.error('Health check failed:', err.message);
  process.exit(1);
});

req.end();
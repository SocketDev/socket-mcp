import os from 'node:os'
import path from 'node:path'
import pino from 'pino'

import { envBool, envString } from './env.ts'

// Debug mode raises verbosity to `debug` and streams pretty logs to stderr
// so tool calls and error responses are visible live in the terminal.
// Enable with MCP_DEBUG=true (the `server-*:debug` scripts set it) or by
// setting LOG_LEVEL explicitly. stderr is safe in both stdio and HTTP modes
// — it is never the MCP protocol channel (stdout is).
const debug = envBool('MCP_DEBUG') || envString('LOG_LEVEL') === 'debug'
const level = envString('LOG_LEVEL') ?? (debug ? 'debug' : 'info')

// Pino logger writing the chosen level to socket-mcp.log and errors to
// socket-mcp-error.log under the platform tmp directory. Two file targets
// instead of one give grep-friendly error isolation without losing the
// info stream. A pretty stderr target surfaces errors to the terminal
// always, and the full debug stream when debug mode is on.
export const logger = pino({
  level,
  transport: {
    targets: [
      {
        target: 'pino/file',
        options: {
          destination: path.join(os.tmpdir(), 'socket-mcp-error.log'),
        },
        level: 'error',
      },
      {
        target: 'pino/file',
        options: { destination: path.join(os.tmpdir(), 'socket-mcp.log') },
        level: 'info',
      },
      {
        target: 'pino-pretty',
        options: { destination: 2 },
        level: debug ? 'debug' : 'error',
      },
    ],
  },
})

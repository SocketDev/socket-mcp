import os from 'node:os'
import path from 'node:path'
import pino from 'pino'

// Pino logger writing info-level to socket-mcp.log and errors to
// socket-mcp-error.log under the platform tmp directory. Two file targets
// instead of one give grep-friendly error isolation without losing the
// info stream.
export const logger = pino({
  level: 'info',
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
    ],
  },
})

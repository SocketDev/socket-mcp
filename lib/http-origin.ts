// Origin / CORS / Accept-header validation for the HTTP transport. These are
// pure request-shaping + same-origin-policy helpers the router and handlers
// call; they hold no session state, so they live apart from the request path
// in http-server.ts (keeps that module under the file-size cap).
import type { IncomingMessage, ServerResponse } from 'node:http'

const ALLOWED_ORIGINS = [
  'https://mcp.socket.dev',
  'https://mcp.socket-staging.dev',
]

// Check whether an Origin URL is a localhost variant; used to allow any
// localhost port during local development.
export function isLocalhostOrigin(originUrl: string): boolean {
  try {
    const originValue = new URL(originUrl)
    return (
      originValue.hostname === '127.0.0.1' ||
      originValue.hostname === 'localhost'
    )
  } catch {
    return false
  }
}

// Some MCP clients (e.g. Cursor) skip the required Accept header. The
// SDK rejects with 406 in that case. Patch req.headers and rawHeaders so
// downstream code sees the canonical pair.
export function patchAcceptHeader(req: IncomingMessage): void {
  const accept = req.headers.accept || ''
  if (
    accept.includes('application/json') &&
    accept.includes('text/event-stream')
  ) {
    return
  }
  const requiredAccept = 'application/json, text/event-stream'
  req.headers.accept = requiredAccept
  const idx = req.rawHeaders.findIndex(h => h.toLowerCase() === 'accept')
  if (idx !== -1) {
    req.rawHeaders[idx + 1] = requiredAccept
  } else {
    req.rawHeaders.push('Accept', requiredAccept)
  }
}

// Same-origin policy for the HTTP transport: allow localhost (any port),
// production hosts, or Origin-less same-origin requests from matching
// Host headers.
export function validateOriginAndHost(
  origin: string,
  host: string,
  port: number,
): boolean {
  const allowedHosts = ALLOWED_ORIGINS.map(o => new URL(o).hostname)
  const isAllowedHost =
    host === `localhost:${port}` ||
    host === `127.0.0.1:${port}` ||
    host === 'localhost' ||
    host === '127.0.0.1' ||
    allowedHosts.includes(host)
  return origin
    ? isLocalhostOrigin(origin) || ALLOWED_ORIGINS.includes(origin)
    : isAllowedHost
}

// Wire CORS response headers when the request carried an Origin. We
// expose Mcp-Session-Id + WWW-Authenticate explicitly because browser
// clients can't otherwise read them.
export function writeCorsHeaders(res: ServerResponse, origin: string): void {
  if (!origin) {
    return
  }
  res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Authorization, Content-Type, Accept, Mcp-Session-Id',
  )
  res.setHeader(
    'Access-Control-Expose-Headers',
    'Mcp-Session-Id, WWW-Authenticate',
  )
}

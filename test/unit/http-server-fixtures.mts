/**
 * @file Shared HTTP-transport test doubles: the ServerResponse capture the
 *   routing code writes into, plain and stream-backed IncomingMessage
 *   stand-ins, and a recording NodeMcpRequestHandler. Not a `*.test.mts` file,
 *   so vitest imports it rather than collecting it.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'

import type { NodeMcpRequestHandler } from '@modelcontextprotocol/node'

// The 4 MB cap `handleMcpRequest` enforces on a buffered request body.
export const MAX_POST_BODY_BYTES = 4 * 1024 * 1024

export interface CapturedRes {
  statusCode?: number | undefined
  body?: string | undefined
  headers: Record<string, string>
}

export interface HandlerCall {
  method: string | undefined
  url: string | undefined
  parsedBody: unknown
  auth: { token?: string | undefined } | undefined
}

// A stream-backed request: every body-bearing method reaches readPostBody,
// which async-iterates the request.
export function bodyReq(
  body: string,
  opts?:
    | {
        method?: string | undefined
        url?: string | undefined
        headers?: Record<string, string> | undefined
      }
    | undefined,
): IncomingMessage {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double / fixture cast: the mock provides only the members the code under test touches.
  const req = Readable.from([body]) as unknown as IncomingMessage & {
    url: string
    method: string
    headers: Record<string, string>
    rawHeaders: string[]
    socket: object
  }
  req.url = opts?.url ?? '/'
  req.method = opts?.method ?? 'POST'
  req.headers = { host: 'localhost:3000', ...opts?.headers }
  req.rawHeaders = []
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double / fixture cast: the mock provides only the members the code under test touches.
  req.socket = {} as unknown as IncomingMessage['socket']
  return req
}

// A request whose stream fails mid-read — the transport error readPostBody
// surfaces as something other than PayloadTooLargeError.
export function erroringReq(message: string): IncomingMessage {
  const stream = new Readable({
    read() {
      this.destroy(new Error(message))
    },
  })
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double / fixture cast: the mock provides only the members the code under test touches.
  const req = stream as unknown as IncomingMessage & {
    url: string
    method: string
    headers: Record<string, string>
    rawHeaders: string[]
    socket: object
  }
  req.url = '/'
  req.method = 'POST'
  req.headers = { host: 'localhost:3000' }
  req.rawHeaders = []
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double / fixture cast: the mock provides only the members the code under test touches.
  req.socket = {} as unknown as IncomingMessage['socket']
  return req
}

export function makeRes(
  opts?: { headersSent?: boolean | undefined } | undefined,
): { res: ServerResponse; captured: CapturedRes } {
  const captured: CapturedRes = { headers: {} }
  let sent = opts?.headersSent ?? false
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double / fixture cast: the mock provides only the members the code under test touches.
  const res = {
    get headersSent() {
      return sent
    },
    setHeader(name: string, value: string) {
      captured.headers[name] = value
    },
    writeHead(code: number, headers?: Record<string, string> | undefined) {
      captured.statusCode = code
      if (headers) {
        Object.assign(captured.headers, headers)
      }
      sent = true
      return res
    },
    end(chunk?: string | undefined) {
      if (chunk !== undefined) {
        captured.body = chunk
      }
      sent = true
    },
    write() {
      return true
    },
    on() {
      return res
    },
  } as unknown as ServerResponse
  return { res, captured }
}

export function plainReq(opts: {
  url: string
  method: string
  headers?: Record<string, string> | undefined
}): IncomingMessage {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double / fixture cast: the mock provides only the members the code under test touches.
  return {
    url: opts.url,
    method: opts.method,
    headers: opts.headers ?? {},
    rawHeaders: [],
    socket: {},
  } as unknown as IncomingMessage
}

// Stand-in for the adapter's NodeMcpRequestHandler: records what routeRequest
// handed over, so the routing contract can be asserted without spinning up
// the real MCP handler.
export function recordingMcpHandler(): {
  handler: NodeMcpRequestHandler
  calls: HandlerCall[]
} {
  const calls: HandlerCall[] = []
  const handler: NodeMcpRequestHandler = (req, _res, parsedBody) => {
    calls.push({
      method: req.method,
      url: req.url,
      parsedBody,
      auth: req.auth,
    })
    return Promise.resolve()
  }
  return { calls, handler }
}

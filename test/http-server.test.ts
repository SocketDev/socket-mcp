import type { IncomingMessage } from 'node:http'
import { Readable } from 'node:stream'

import { describe, expect, test } from 'vitest'

import {
  applyClientApiKey,
  PayloadTooLargeError,
  readPostBody,
} from '../lib/http-server.ts'
import type { AuthenticatedRequest } from '../lib/oauth.ts'

function reqWith(authorization?: string): AuthenticatedRequest {
  return {
    headers: authorization === undefined ? {} : { authorization },
  } as unknown as AuthenticatedRequest
}

test('applyClientApiKey forwards a Bearer token onto req.auth', () => {
  const req = reqWith('Bearer sk-abc')
  applyClientApiKey(req)
  expect(req.auth?.token).toBe('sk-abc')
  expect(req.auth?.clientId).toBe('socket-api-key')
})

test('applyClientApiKey is case-insensitive on the scheme', () => {
  const req = reqWith('bearer sk-xyz')
  applyClientApiKey(req)
  expect(req.auth?.token).toBe('sk-xyz')
})

test('applyClientApiKey ignores a missing Authorization header', () => {
  const req = reqWith()
  applyClientApiKey(req)
  expect(req.auth).toBeUndefined()
})

test('applyClientApiKey ignores a non-bearer scheme', () => {
  const req = reqWith('Basic dXNlcjpwYXNz')
  applyClientApiKey(req)
  expect(req.auth).toBeUndefined()
})

// A Readable stream doubles as a stand-in for IncomingMessage here:
// readPostBody only async-iterates the request and calls `.destroy()`,
// both of which Readable provides.
function mockReq(chunks: Array<string | Buffer>): IncomingMessage {
  return Readable.from(chunks) as unknown as IncomingMessage
}

const MAX = 4 * 1024 * 1024

describe('readPostBody', () => {
  test('returns the buffered body for a small payload', async () => {
    const body = await readPostBody(mockReq(['{"jsonrpc":', '"2.0"}']))
    expect(body).toBe('{"jsonrpc":"2.0"}')
  })

  test('concatenates Buffer chunks as UTF-8', async () => {
    const body = await readPostBody(mockReq([Buffer.from('café')]))
    expect(body).toBe('café')
  })

  test('throws PayloadTooLargeError when the body exceeds the cap', async () => {
    // One chunk just over the 4 MB limit.
    const huge = 'a'.repeat(MAX + 1)
    await expect(readPostBody(mockReq([huge]))).rejects.toBeInstanceOf(
      PayloadTooLargeError,
    )
  })

  test('counts bytes across chunks, not just the final chunk', async () => {
    // Each chunk is under the cap, but together they exceed it.
    const half = 'a'.repeat(MAX / 2 + 1)
    await expect(readPostBody(mockReq([half, half]))).rejects.toBeInstanceOf(
      PayloadTooLargeError,
    )
  })

  test('measures byte length, not char count, for multibyte payloads', async () => {
    // '€' is 3 UTF-8 bytes; MAX/2 + 1 of them exceeds MAX in bytes while
    // staying well under MAX in characters.
    const multibyte = '€'.repeat(Math.floor(MAX / 3) + 1)
    await expect(readPostBody(mockReq([multibyte]))).rejects.toBeInstanceOf(
      PayloadTooLargeError,
    )
  })

  test('a body exactly at the cap is accepted', async () => {
    const atLimit = 'a'.repeat(MAX)
    const body = await readPostBody(mockReq([atLimit]))
    expect(body.length).toBe(MAX)
  })
})

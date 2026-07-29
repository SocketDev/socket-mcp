/**
 * @file The buffered POST-body reader and its 4 MB cap. The cap is the
 *   heap-exhaustion guard on the pre-auth HTTP path, so the byte accounting
 *   and the boundary behavior are pinned here.
 */

import type { IncomingMessage } from 'node:http'
import { Readable } from 'node:stream'

import { describe, expect, test } from 'vitest'

import { PayloadTooLargeError, readPostBody } from '../../lib/http-server.ts'

// A Readable stream doubles as a stand-in for IncomingMessage here:
// readPostBody async-iterates the request via `.iterator()`, which Readable
// provides.
function mockReq(chunks: Array<string | Buffer>): IncomingMessage {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double / fixture cast: the mock provides only the members the code under test touches.
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

  test('leaves the request stream intact so the caller can answer 413', async () => {
    // Destroying the request here would kill the socket before the 413 could
    // be written, and the client would see a socket error instead.
    const req = mockReq(['a'.repeat(MAX + 1)])
    await expect(readPostBody(req)).rejects.toBeInstanceOf(PayloadTooLargeError)
    expect(req.destroyed).toBe(false)
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

import nock from 'nock'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { fetchBlob } from '../lib/blob.ts'

const HOST = 'https://socketusercontent.com'

beforeEach(() => {
  nock.disableNetConnect()
})

afterEach(() => {
  nock.cleanAll()
  nock.enableNetConnect()
})

describe('fetchBlob', () => {
  test('returns text for UTF-8 content', async () => {
    nock(HOST)
      .matchHeader('user-agent', 'socket-mcp/test')
      .get('/blob/Qabc')
      .reply(200, 'hello world', { 'content-type': 'text/plain' })

    const result = await fetchBlob('Qabc', {
      baseUrl: HOST,
      userAgent: 'socket-mcp/test',
    })

    expect(result.text).toBe('hello world')
    expect(result.bytes).toBe(11)
    expect(result.binary).toBe(false)
    expect(result.truncated).toBe(false)
    expect(result.contentType).toBe('text/plain')
  })

  test('flags content with NUL bytes as binary', async () => {
    const bytes = Buffer.from([0x48, 0x65, 0x00, 0x6c, 0x6c, 0x6f]) // "He\0llo"
    nock(HOST).get('/blob/Qbin').reply(200, bytes)

    const result = await fetchBlob('Qbin', { baseUrl: HOST })
    expect(result.binary).toBe(true)
    expect(result.text).toBe('')
    expect(result.bytes).toBe(6)
  })

  test('flags invalid UTF-8 as binary', async () => {
    // Invalid UTF-8: 0xC3 followed by an ASCII byte (continuation expected).
    // Pad to >4096 bytes so the NUL pre-check doesn't trigger.
    const bytes = Buffer.alloc(5000, 0x41) // 'A'
    bytes[4500] = 0xc3
    bytes[4501] = 0x28
    nock(HOST).get('/blob/Qbad').reply(200, bytes)

    const result = await fetchBlob('Qbad', { baseUrl: HOST })
    expect(result.binary).toBe(true)
  })

  test('truncates blobs larger than maxBytes', async () => {
    const big = Buffer.alloc(2048, 0x41)
    nock(HOST).get('/blob/Qbig').reply(200, big)

    const result = await fetchBlob('Qbig', { baseUrl: HOST, maxBytes: 1024 })
    expect(result.bytes).toBe(2048)
    expect(result.truncated).toBe(true)
    expect(result.text.length).toBe(1024)
  })

  test('throws on non-2xx with status and body', async () => {
    nock(HOST).get('/blob/Qmissing').reply(404, 'gone')
    await expect(fetchBlob('Qmissing', { baseUrl: HOST })).rejects.toThrow(
      /blob fetch 404 for .* gone/,
    )
  })

  test('merges extraHeaders into the request', async () => {
    nock(HOST)
      .matchHeader('user-agent', 'socket-mcp/test')
      .matchHeader('tuckner-mcp-test', 'abc123')
      .get('/blob/Qa')
      .reply(200, 'x')

    await fetchBlob('Qa', {
      baseUrl: HOST,
      userAgent: 'socket-mcp/test',
      extraHeaders: { 'tuckner-mcp-test': 'abc123' },
    })
    expect(nock.isDone()).toBe(true)
  })

  test('reassembles S-prefixed chunked blobs via the Q-swapped manifest', async () => {
    const sHash = 'Sxt09IczWTqd76A0fOmQ9RuiScBju_IEMV3495LjEG9k'
    const manifestHash = 'Qxt09IczWTqd76A0fOmQ9RuiScBju_IEMV3495LjEG9k'
    nock(HOST)
      .get(`/blob/${manifestHash}`)
      .reply(
        200,
        JSON.stringify({
          _version: '2',
          size: 12,
          chunks: ['Qchunk0', 'Qchunk1'],
          offset: [0, 6],
        }),
        { 'content-type': 'application/json' },
      )
    nock(HOST).get('/blob/Qchunk0').reply(200, 'hello ')
    nock(HOST).get('/blob/Qchunk1').reply(200, 'world!')

    const result = await fetchBlob(sHash, { baseUrl: HOST })

    expect(result.text).toBe('hello world!')
    expect(result.bytes).toBe(12)
    expect(result.binary).toBe(false)
    expect(result.truncated).toBe(false)
    expect(nock.isDone()).toBe(true)
  })

  test('chunked: stops fetching chunks past maxBytes when offsets are present', async () => {
    nock(HOST)
      .get('/blob/Qmid')
      .reply(
        200,
        JSON.stringify({
          _version: '2',
          size: 192,
          chunks: ['Qa', 'Qb', 'Qc'],
          offset: [0, 64, 128],
        }),
      )
    const chunk = Buffer.alloc(64, 0x41)
    // chunk 0 (offset 0) + chunk 1 (offset 64) needed for maxBytes 80; chunk 2
    // (offset 128 >= 80) must be skipped — register only the first two.
    nock(HOST).get('/blob/Qa').reply(200, chunk)
    nock(HOST).get('/blob/Qb').reply(200, chunk)

    const result = await fetchBlob('Smid', { baseUrl: HOST, maxBytes: 80 })

    expect(result.bytes).toBe(192)
    expect(result.truncated).toBe(true)
    expect(result.text.length).toBe(80)
    // All registered interceptors consumed → Qc was never requested.
    expect(nock.isDone()).toBe(true)
  })

  test('chunked: throws when manifest is not valid JSON', async () => {
    nock(HOST).get('/blob/Qbroken').reply(200, 'definitely not json')
    await expect(fetchBlob('Sbroken', { baseUrl: HOST })).rejects.toThrow(
      /chunked blob manifest.*not valid JSON/,
    )
  })

  test('encodes hash and strips trailing slash from baseUrl', async () => {
    const scope = nock(HOST).get('/blob/Qa%2Fb%2Bc').reply(200, 'x')
    await fetchBlob('Qa/b+c', { baseUrl: `${HOST}/` })
    expect(scope.isDone()).toBe(true)
  })
})

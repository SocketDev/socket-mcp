#!/usr/bin/env node
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fetchBlob } from './lib/blob.ts'

test('fetchBlob', async (t) => {
  await t.test('returns text for UTF-8 content', async () => {
    let capturedUrl = ''
    const stubFetch = async (input: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(input)
      assert.equal((init?.headers as Record<string, string>)?.['user-agent'], 'socket-mcp/test')
      return new Response('hello world', {
        status: 200,
        headers: { 'content-type': 'text/plain' }
      })
    }

    const result = await fetchBlob('Qabc', {
      baseUrl: 'https://socketusercontent.com',
      fetchFn: stubFetch as typeof fetch,
      userAgent: 'socket-mcp/test'
    })

    assert.equal(capturedUrl, 'https://socketusercontent.com/blob/Qabc')
    assert.equal(result.text, 'hello world')
    assert.equal(result.bytes, 11)
    assert.equal(result.binary, false)
    assert.equal(result.truncated, false)
    assert.equal(result.contentType, 'text/plain')
  })

  await t.test('flags content with NUL bytes as binary', async () => {
    const bytes = new Uint8Array([0x48, 0x65, 0x00, 0x6c, 0x6c, 0x6f]) // "He\0llo"
    const stubFetch = async () => new Response(bytes, { status: 200 })
    const result = await fetchBlob('Qbin', {
      baseUrl: 'https://socketusercontent.com',
      fetchFn: stubFetch as typeof fetch
    })
    assert.equal(result.binary, true)
    assert.equal(result.text, '')
    assert.equal(result.bytes, 6)
  })

  await t.test('flags invalid UTF-8 as binary', async () => {
    // Invalid UTF-8: 0xC3 followed by an ASCII byte (continuation expected).
    // Pad to >4096 bytes so the NUL pre-check doesn't trigger.
    const bytes = new Uint8Array(5000)
    bytes.fill(0x41) // 'A'
    bytes[4500] = 0xc3
    bytes[4501] = 0x28
    const stubFetch = async () => new Response(bytes, { status: 200 })
    const result = await fetchBlob('Qbad', {
      baseUrl: 'https://socketusercontent.com',
      fetchFn: stubFetch as typeof fetch
    })
    assert.equal(result.binary, true)
  })

  await t.test('truncates blobs larger than maxBytes', async () => {
    const big = new Uint8Array(2048)
    big.fill(0x41)
    const stubFetch = async () => new Response(big, { status: 200 })
    const result = await fetchBlob('Qbig', {
      baseUrl: 'https://socketusercontent.com',
      fetchFn: stubFetch as typeof fetch,
      maxBytes: 1024
    })
    assert.equal(result.bytes, 2048, 'reports the full size')
    assert.equal(result.truncated, true)
    assert.equal(result.text.length, 1024)
  })

  await t.test('throws on non-2xx with status and body', async () => {
    const stubFetch = async () => new Response('gone', { status: 404 })
    await assert.rejects(
      fetchBlob('Qmissing', {
        baseUrl: 'https://socketusercontent.com',
        fetchFn: stubFetch as typeof fetch
      }),
      /blob fetch 404 for .* gone/
    )
  })

  await t.test('merges extraHeaders into the request', async () => {
    let capturedHeaders: Record<string, string> | undefined
    const stubFetch = async (_input: string | URL | Request, init?: RequestInit) => {
      capturedHeaders = init?.headers as Record<string, string> | undefined
      return new Response('x', { status: 200 })
    }
    await fetchBlob('Qa', {
      baseUrl: 'https://socketusercontent.com',
      fetchFn: stubFetch as typeof fetch,
      userAgent: 'socket-mcp/test',
      extraHeaders: { 'tuckner-mcp-test': 'abc123' }
    })
    assert.equal(capturedHeaders?.['user-agent'], 'socket-mcp/test')
    assert.equal(capturedHeaders?.['tuckner-mcp-test'], 'abc123')
  })

  await t.test('reassembles S-prefixed chunked blobs via the Q-swapped manifest', async () => {
    const calls: string[] = []
    const sHash = 'Sxt09IczWTqd76A0fOmQ9RuiScBju_IEMV3495LjEG9k'
    const expectedManifestHash = 'Qxt09IczWTqd76A0fOmQ9RuiScBju_IEMV3495LjEG9k'
    const manifest = {
      _version: '2',
      size: 12,
      chunks: ['Qchunk0', 'Qchunk1'],
      offset: [0, 6]
    }
    const stubFetch = async (input: string | URL | Request) => {
      const url = String(input)
      calls.push(url)
      if (url.endsWith(`/blob/${expectedManifestHash}`)) {
        return new Response(JSON.stringify(manifest), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.endsWith('/blob/Qchunk0')) return new Response('hello ', { status: 200 })
      if (url.endsWith('/blob/Qchunk1')) return new Response('world!', { status: 200 })
      return new Response('not found', { status: 404 })
    }

    const result = await fetchBlob(sHash, {
      baseUrl: 'https://socketusercontent.com',
      fetchFn: stubFetch as typeof fetch
    })

    assert.equal(result.text, 'hello world!')
    assert.equal(result.bytes, 12, 'reports manifest size')
    assert.equal(result.binary, false)
    assert.equal(result.truncated, false)
    assert.equal(calls[0], `https://socketusercontent.com/blob/${expectedManifestHash}`, 'fetches manifest first')
    assert.ok(calls.includes('https://socketusercontent.com/blob/Qchunk0'))
    assert.ok(calls.includes('https://socketusercontent.com/blob/Qchunk1'))
  })

  await t.test('chunked: stops fetching chunks past maxBytes when offsets are present', async () => {
    const calls: string[] = []
    const manifest = {
      _version: '2',
      size: 192,
      chunks: ['Qa', 'Qb', 'Qc'],
      offset: [0, 64, 128]
    }
    const stubFetch = async (input: string | URL | Request) => {
      const url = String(input)
      calls.push(url)
      if (url.endsWith('/blob/Qmid')) {
        return new Response(JSON.stringify(manifest), { status: 200 })
      }
      const body = new Uint8Array(64)
      body.fill(0x41)
      return new Response(body, { status: 200 })
    }

    const result = await fetchBlob('Smid', {
      baseUrl: 'https://socketusercontent.com',
      fetchFn: stubFetch as typeof fetch,
      maxBytes: 80 // covers chunk 0 fully + part of chunk 1; chunk 2 starts at 128 >= 80 → skip
    })

    assert.equal(result.bytes, 192, 'reports full size from manifest')
    assert.equal(result.truncated, true)
    assert.equal(result.text.length, 80)
    assert.ok(calls.includes('https://socketusercontent.com/blob/Qa'))
    assert.ok(calls.includes('https://socketusercontent.com/blob/Qb'))
    assert.ok(!calls.includes('https://socketusercontent.com/blob/Qc'), 'skips chunks past maxBytes')
  })

  await t.test('chunked: throws when manifest is not valid JSON', async () => {
    const stubFetch = async () => new Response('definitely not json', { status: 200 })
    await assert.rejects(
      fetchBlob('Sbroken', {
        baseUrl: 'https://socketusercontent.com',
        fetchFn: stubFetch as typeof fetch
      }),
      /chunked blob manifest.*not valid JSON/
    )
  })

  await t.test('encodes hash and strips trailing slash from baseUrl', async () => {
    let capturedUrl = ''
    const stubFetch = async (input: string | URL | Request) => {
      capturedUrl = String(input)
      return new Response('x', { status: 200 })
    }
    await fetchBlob('Qa/b+c', {
      baseUrl: 'https://socketusercontent.com/',
      fetchFn: stubFetch as typeof fetch
    })
    assert.equal(capturedUrl, 'https://socketusercontent.com/blob/Qa%2Fb%2Bc')
  })
})

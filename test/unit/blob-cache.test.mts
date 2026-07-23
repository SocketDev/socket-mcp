import nock from 'nock'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import type { BlobResult } from '../../lib/blob.ts'

const BLOB_HOST = 'https://socketusercontent.com'

let savedCap: string | undefined

beforeEach(() => {
  savedCap = process.env['SOCKET_BLOB_CACHE_BYTES']
  nock.disableNetConnect()
  vi.resetModules()
})

afterEach(() => {
  if (savedCap === undefined) {
    delete process.env['SOCKET_BLOB_CACHE_BYTES']
  } else {
    process.env['SOCKET_BLOB_CACHE_BYTES'] = savedCap
  }
  nock.cleanAll()
  nock.enableNetConnect()
})

// Import a fresh blob-cache module (empty cache) with the cap configured. The
// cap is read at import time, so it must be set before the dynamic import.
async function freshCache(capBytes?: number) {
  if (capBytes !== undefined) {
    process.env['SOCKET_BLOB_CACHE_BYTES'] = String(capBytes)
  }
  vi.resetModules()
  return import('../../lib/blob-cache.ts')
}

describe('blobWeight', () => {
  test('weighs UTF-8 byte length plus fixed overhead', async () => {
    const { blobWeight } = await freshCache()
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double / fixture cast: the mock provides only the members the code under test touches.
    const blob = { text: 'abc', binary: false } as BlobResult
    expect(blobWeight(blob)).toBe(Buffer.byteLength('abc', 'utf8') + 512)
  })
})

describe('getOrFetchBlob', () => {
  test('fetches once then serves from cache (no second request)', async () => {
    const { getOrFetchBlob } = await freshCache()
    // A single interceptor: a second network hit would throw under
    // disableNetConnect, proving the second call was served from cache.
    nock(BLOB_HOST)
      .get('/blob/Qhit')
      .reply(200, 'cached body', { 'content-type': 'text/plain' })

    const first = await getOrFetchBlob('Qhit')
    const second = await getOrFetchBlob('Qhit')
    expect(first.text).toBe('cached body')
    expect(second).toBe(first)
  })

  test('coalesces concurrent misses onto one fetch', async () => {
    const { getOrFetchBlob } = await freshCache()
    nock(BLOB_HOST)
      .get('/blob/Qrace')
      .reply(200, 'shared', { 'content-type': 'text/plain' })

    const [a, b] = await Promise.all([
      getOrFetchBlob('Qrace'),
      getOrFetchBlob('Qrace'),
    ])
    expect(a.text).toBe('shared')
    expect(b).toBe(a)
  })

  test('does not cache a blob larger than the whole cache', async () => {
    const { getOrFetchBlob } = await freshCache(600)
    // 'a'.repeat(200) -> weight 200 + 512 = 712 > 600 cap, so it is returned
    // but never stored; a second call must hit the network again.
    nock(BLOB_HOST)
      .get('/blob/Qbig')
      .twice()
      .reply(200, 'a'.repeat(200), { 'content-type': 'text/plain' })

    const first = await getOrFetchBlob('Qbig')
    const second = await getOrFetchBlob('Qbig')
    expect(first.text).toBe('a'.repeat(200))
    expect(second.text).toBe('a'.repeat(200))
    expect(nock.isDone()).toBe(true)
  })

  test('evicts the oldest entry once the cap is exceeded', async () => {
    // Cap fits exactly one ~513-byte entry, so adding a second evicts the
    // first. Re-fetching the first must hit the network again.
    const { getOrFetchBlob } = await freshCache(560)
    nock(BLOB_HOST)
      .get('/blob/Qa')
      .twice()
      .reply(200, 'x', { 'content-type': 'text/plain' })
    nock(BLOB_HOST)
      .get('/blob/Qb')
      .reply(200, 'y', { 'content-type': 'text/plain' })

    await getOrFetchBlob('Qa')
    await getOrFetchBlob('Qb')
    // Qa was evicted by Qb, so this re-fetches Qa (the second Qa interceptor).
    await getOrFetchBlob('Qa')
    expect(nock.isDone()).toBe(true)
  })
})

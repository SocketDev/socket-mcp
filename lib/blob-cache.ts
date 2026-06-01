import { fetchBlob } from './blob.ts'
import type { BlobResult } from './blob.ts'
import {
  getSocketBlobCacheBytes,
  getSocketBlobUrl,
  getSocketBrowserUserAgent,
  getSocketBypassHeaderName,
  getSocketBypassHeaderValue,
} from './env.ts'
import { debug } from './logger.ts'

// Process-wide LRU blob cache keyed by content-addressed hash. Survives across
// stateless HTTP requests (each request gets a fresh McpServer) so repeated
// reads/greps of the same file skip the socketusercontent fetch.
const BLOB_CACHE_MAX_BYTES = getSocketBlobCacheBytes()
const SOCKET_BLOB_URL = getSocketBlobUrl()
const BROWSER_USER_AGENT = getSocketBrowserUserAgent()

// Optional WAF/Cloudflare bypass header sent on every socketusercontent.com
// request. Leave value empty to disable.
const SOCKET_BYPASS_HEADER_NAME = getSocketBypassHeaderName()
const SOCKET_BYPASS_HEADER_VALUE = getSocketBypassHeaderValue()
const BYPASS_HEADERS: Record<string, string> =
  SOCKET_BYPASS_HEADER_NAME && SOCKET_BYPASS_HEADER_VALUE
    ? { [SOCKET_BYPASS_HEADER_NAME]: SOCKET_BYPASS_HEADER_VALUE }
    : {}

const cache = new Map<string, BlobResult>()
// In-flight fetches, keyed by hash. Concurrent misses for the same hash share
// one promise so the blob is fetched + accounted exactly once (no double-count
// of cacheBytes, no duplicate network calls).
const inFlight = new Map<string, Promise<BlobResult>>()
let cacheBytes = 0

export function blobWeight(blob: BlobResult): number {
  // Weight by UTF-8 byte length (not UTF-16 .length) so the byte cap is
  // honored for multibyte content, plus a fixed overhead so binary entries
  // (empty text) still occupy a slot.
  return Buffer.byteLength(blob.text, 'utf8') + 512
}

export function evict(): void {
  while (cacheBytes > BLOB_CACHE_MAX_BYTES && cache.size > 0) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) {
      break
    }
    const victim = cache.get(oldest)
    cache.delete(oldest)
    if (victim) {
      cacheBytes = Math.max(0, cacheBytes - blobWeight(victim))
    }
    debug(
      { hash: oldest, cacheBytes, cacheSize: cache.size },
      'blob cache evict',
    )
  }
}

export async function getOrFetchBlob(hash: string): Promise<BlobResult> {
  const cached = cache.get(hash)
  if (cached) {
    // LRU bump: re-insert so this entry moves to the end of iteration order.
    cache.delete(hash)
    cache.set(hash, cached)
    return cached
  }
  // Coalesce concurrent misses for the same hash onto a single fetch.
  const pending = inFlight.get(hash)
  if (pending) {
    return pending
  }
  const fetchPromise = (async () => {
    try {
      const blob = await fetchBlob(hash, {
        baseUrl: SOCKET_BLOB_URL,
        userAgent: BROWSER_USER_AGENT,
        extraHeaders: BYPASS_HEADERS,
        onRequest: url => debug({ url }, 'blob request'),
      })
      const weight = blobWeight(blob)
      // Only cache blobs that fit under the cap; a single blob larger than the
      // whole cache is returned but never stored, so the cap invariant holds.
      if (weight <= BLOB_CACHE_MAX_BYTES) {
        cache.set(hash, blob)
        cacheBytes += weight
        evict()
      }
      return blob
    } finally {
      inFlight.delete(hash)
    }
  })()
  inFlight.set(hash, fetchPromise)
  return fetchPromise
}

import { fetchBlob, type BlobResult } from './blob.ts'
import { debug } from './logger.ts'

// Process-wide LRU blob cache keyed by content-addressed hash. Survives across
// stateless HTTP requests (each request gets a fresh McpServer) so repeated
// reads/greps of the same file skip the socketusercontent fetch.
const BLOB_CACHE_MAX_BYTES = (() => {
  const raw = process.env['SOCKET_BLOB_CACHE_BYTES']
  if (!raw) {
    return 64 * 1024 * 1024
  }
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : 64 * 1024 * 1024
})()

const SOCKET_BLOB_URL =
  process.env['SOCKET_BLOB_URL'] || 'https://socketusercontent.com'

const BROWSER_USER_AGENT =
  process.env['SOCKET_BROWSER_USER_AGENT'] ||
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36'

// Optional WAF/Cloudflare bypass header sent on every socketusercontent.com
// request. Leave value empty to disable.
const SOCKET_BYPASS_HEADER_NAME =
  process.env['SOCKET_BYPASS_HEADER_NAME'] || ''
const SOCKET_BYPASS_HEADER_VALUE =
  process.env['SOCKET_BYPASS_HEADER_VALUE'] || ''
const BYPASS_HEADERS: Record<string, string> =
  SOCKET_BYPASS_HEADER_NAME && SOCKET_BYPASS_HEADER_VALUE
    ? { [SOCKET_BYPASS_HEADER_NAME]: SOCKET_BYPASS_HEADER_VALUE }
    : {}

const cache = new Map<string, BlobResult>()
let cacheBytes = 0

function blobWeight(blob: BlobResult): number {
  // Account for a small fixed overhead so binary entries (empty text) still
  // occupy a slot.
  return blob.text.length + 256
}

function evict(): void {
  while (cacheBytes > BLOB_CACHE_MAX_BYTES && cache.size > 0) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) {
      break
    }
    const victim = cache.get(oldest)
    cache.delete(oldest)
    if (victim) {
      cacheBytes -= blobWeight(victim)
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
  const blob = await fetchBlob(hash, {
    baseUrl: SOCKET_BLOB_URL,
    userAgent: BROWSER_USER_AGENT,
    extraHeaders: BYPASS_HEADERS,
    onRequest: url => debug({ url }, 'blob request'),
  })
  cache.set(hash, blob)
  cacheBytes += blobWeight(blob)
  evict()
  return blob
}

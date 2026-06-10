import { httpRequest } from '@socketsecurity/lib/http-request/request'

export interface BlobResult {
  bytes: number
  contentType: string | undefined
  binary: boolean
  truncated: boolean
  text: string
}

export interface FetchBlobOptions {
  baseUrl: string
  userAgent?: string | undefined
  // Extra headers merged into the outbound request. Values overwrite
  // user-agent if it's set here.
  extraHeaders?: Record<string, string> | undefined
  // Hard cap on bytes returned. Larger blobs are truncated and flagged.
  maxBytes?: number | undefined
  // Called with the resolved URL right before each request is dispatched
  // (chunked blobs fire this multiple times).
  onRequest?: ((url: string) => void) | undefined
}

const DEFAULT_MAX_BYTES = 1024 * 1024 // 1 MB

export interface ChunkedManifest {
  _version?: string | undefined
  size?: number | undefined
  chunks?: unknown | undefined
  offset?: unknown | undefined
}

export interface RawFetchResult {
  bytes: Uint8Array
  contentType: string | undefined
}

export interface ChunkedFetchResult {
  // Concatenated chunk bytes, possibly less than `totalSize` when stopped
  // early at maxBytes.
  bytes: Uint8Array
  // Total file size from the manifest, regardless of how many chunks were
  // fetched.
  totalSize: number
}

/**
 * Fetch a content-addressed blob from socketusercontent.com (or compatible
 * host). Handles both single-blob (Q-prefixed) and chunked (S-prefixed) hashes:
 * chunked blobs are reconstructed by fetching the manifest at the Q-swapped
 * hash and then pulling each listed chunk. Returns text content when the bytes
 * decode as UTF-8 without NULs; otherwise marks the response as binary so
 * callers can refuse to ship it to an LLM. Bytes beyond `maxBytes` are
 * dropped.
 */
export async function fetchBlob(
  hash: string,
  options: FetchBlobOptions,
): Promise<BlobResult> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES

  let buf: Uint8Array
  let contentType: string | undefined
  let originalSize: number

  if (hash[0] === 'S') {
    const chunked = await fetchChunkedBytes(hash, options, maxBytes)
    buf = chunked.bytes
    originalSize = chunked.totalSize
    contentType = undefined
  } else {
    const raw = await fetchRawBytes(hash, options)
    buf = raw.bytes
    originalSize = buf.length
    contentType = raw.contentType
  }

  const truncated = originalSize > maxBytes
  const bodyBytes = buf.length > maxBytes ? buf.subarray(0, maxBytes) : buf
  const decoded = tryDecodeText(bodyBytes)

  return {
    bytes: originalSize,
    contentType,
    binary: decoded === undefined,
    truncated,
    text: decoded ?? '',
  }
}

/**
 * Resolve an S-prefixed chunked blob: fetch the manifest at the Q-swapped hash,
 * then fetch the chunks listed in the manifest and concatenate. Honors
 * `maxBytes` by stopping at the first chunk past the cap (using the manifest's
 * `offset` array when present, otherwise running totals).
 */
export async function fetchChunkedBytes(
  sHash: string,
  options: FetchBlobOptions,
  maxBytes: number,
): Promise<ChunkedFetchResult> {
  const manifestHash = `Q${sHash.slice(1)}`
  const manifestRaw = await fetchRawBytes(manifestHash, options)

  let manifest: ChunkedManifest
  try {
    manifest = JSON.parse(
      new TextDecoder('utf-8').decode(manifestRaw.bytes),
    ) as ChunkedManifest
  } catch (e) {
    throw new Error(
      `chunked blob manifest at ${manifestHash} is not valid JSON: ${(e as Error).message}`,
    )
  }
  if (
    !Array.isArray(manifest.chunks) ||
    manifest.chunks.some(c => typeof c !== 'string' || !c)
  ) {
    throw new Error(
      `chunked blob manifest at ${manifestHash} is missing a valid 'chunks' array`,
    )
  }
  const chunks = manifest.chunks as string[]
  const totalSize = typeof manifest.size === 'number' ? manifest.size : -1
  // Offsets are usable only when every entry is a number AND there's one per
  // chunk. Check both together so a single non-numeric entry yields undefined
  // (skip the optimization) rather than a short, mismatched array.
  const rawOffset = manifest.offset
  const offsets =
    Array.isArray(rawOffset) &&
    rawOffset.length === chunks.length &&
    rawOffset.every(n => typeof n === 'number')
      ? (rawOffset as number[])
      : undefined

  // Decide how many chunks we actually need. With offsets we can stop at the
  // first chunk whose start is at or past maxBytes; without, we fetch
  // everything and truncate after concatenation.
  let needed = chunks.length
  if (offsets) {
    needed = 0
    for (let i = 0; i < chunks.length; i += 1) {
      if (offsets[i]! >= maxBytes) {
        break
      }
      needed = i + 1
    }
  }

  const chunkBuffers = await Promise.all(
    chunks
      .slice(0, needed)
      .map(async c => (await fetchRawBytes(c, options)).bytes),
  )

  let total = 0
  for (const cb of chunkBuffers) {
    total += cb.length
  }
  const concat = new Uint8Array(total)
  let pos = 0
  for (const cb of chunkBuffers) {
    concat.set(cb, pos)
    pos += cb.length
  }

  return {
    bytes: concat,
    totalSize: totalSize >= 0 ? totalSize : total,
  }
}

// Single GET against `/blob/<hash>`. No prefix logic.
export async function fetchRawBytes(
  hash: string,
  options: FetchBlobOptions,
): Promise<RawFetchResult> {
  const url = `${options.baseUrl.replace(/\/$/u, '')}/blob/${encodeURIComponent(hash)}`

  const headers: Record<string, string> = {}
  if (options.userAgent) {
    headers['user-agent'] = options.userAgent
  }
  if (options.extraHeaders) {
    Object.assign(headers, options.extraHeaders)
  }

  options.onRequest?.(url)
  let res
  try {
    res = await httpRequest(url, { headers })
  } catch (e) {
    throw new Error(`blob request to ${url} failed: ${(e as Error).message}`)
  }
  if (!res.ok) {
    throw new Error(`blob fetch ${res.status} for ${url}: ${res.text()}`)
  }

  const contentTypeHeader = res.headers['content-type']
  return {
    bytes: new Uint8Array(res.arrayBuffer()),
    contentType:
      typeof contentTypeHeader === 'string' ? contentTypeHeader : undefined,
  }
}

/**
 * Decode bytes as UTF-8 in fatal mode to detect binary content. Returns
 * undefined if the bytes don't form valid UTF-8 or contain a NUL byte (typical
 * binary marker).
 */
export function tryDecodeText(bytes: Uint8Array): string | undefined {
  // NUL bytes inside the first 4 KB strongly suggest binary; cheap pre-check.
  const probeEnd = Math.min(bytes.length, 4096)
  for (let i = 0; i < probeEnd; i += 1) {
    if (bytes[i] === 0) {
      return undefined
    }
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return undefined
  }
}

import { httpRequest } from '@socketsecurity/lib/http-request/request'

import { buildJsonApiHeaders } from './http-helpers.ts'

export function buildTree(entries: FileListEntry[]): TreeNode {
  const root: TreeNode = { name: '', isFile: false, children: new Map() }
  for (let e = 0, { length } = entries; e < length; e += 1) {
    const entry = entries[e]!
    const parts = entry.path.split('/').filter(Boolean)
    if (!parts.length) {
      continue
    }
    let cur = root
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i]!
      let next = cur.children.get(part)
      if (!next) {
        next = { name: part, isFile: false, children: new Map() }
        cur.children.set(part, next)
      }
      const isLeaf = i === parts.length - 1
      if (isLeaf && entry.type === 'file') {
        next.isFile = true
        if (entry.size !== undefined) {
          next.size = entry.size
        }
        if (entry.hash !== undefined) {
          next.hash = entry.hash
        }
      }
      cur = next
    }
  }
  return root
}

export interface FileListEntry {
  path: string
  type: 'file' | 'dir'
  size?: number | undefined
  hash?: string | undefined
}

export interface FileListResult {
  purl: string
  fileCount: number
  totalBytes: number
  files: FileListEntry[]
  tree: string
}

export interface FetchFileListOptions {
  baseUrl: string
  includeHashes?: boolean | undefined
  userAgent?: string | undefined
  // Socket access token, sent as `Authorization: Bearer <token>` when set.
  authToken?: string | undefined
  // Extra headers merged into the outbound request (e.g. WAF bypass token).
  extraHeaders?: Record<string, string> | undefined
  // Called with the resolved URL right before the request is dispatched.
  onRequest?: ((url: string) => void) | undefined
}

interface RawFileEntry {
  path?: unknown | undefined
  type?: unknown | undefined
  size?: unknown | undefined
  hash?: unknown | undefined
}

interface RawFileListResponse {
  files?: RawFileEntry[] | undefined
}

interface TreeNode {
  name: string
  isFile: boolean
  size?: number | undefined
  hash?: string | undefined
  children: Map<string, TreeNode>
}

/**
 * Normalize the raw `files` array into a sorted, typed list. Hashes are dropped
 * unless `includeHashes` is set.
 */
export function extractFileList(
  response: RawFileListResponse,
  options: { includeHashes?: boolean | undefined } = {},
): FileListEntry[] {
  const raw = response.files ?? []
  const entries: FileListEntry[] = []
  for (let i = 0, { length } = raw; i < length; i += 1) {
    const item = raw[i]!
    if (!item || typeof item.path !== 'string' || !item.path) {
      continue
    }
    const type: 'file' | 'dir' = item.type === 'dir' ? 'dir' : 'file'
    const entry: FileListEntry = { path: item.path, type }
    if (typeof item.size === 'number') {
      entry.size = item.size
    }
    if (options.includeHashes && typeof item.hash === 'string') {
      entry.hash = item.hash
    }
    entries.push(entry)
  }
  entries.sort((a, b) => a.path.localeCompare(b.path))
  return entries
}

/**
 * Fetch the file manifest for a PURL from the Socket API's `GET
 * /v0/purl/file-list/{purl}` endpoint. The full PURL string is URL-encoded into
 * the path. Throws on non-2xx responses with the upstream status and body
 * text.
 */
export async function fetchFileList(
  purlStr: string,
  options: FetchFileListOptions,
): Promise<FileListResult> {
  const baseUrl = options.baseUrl.replace(/\/$/u, '')
  const url = `${baseUrl}/v0/purl/file-list/${encodeURIComponent(purlStr)}`

  const headers = buildJsonApiHeaders(options)
  options.onRequest?.(url)
  let res
  try {
    res = await httpRequest(url, { headers })
  } catch (e) {
    throw new Error(
      `file-list request to ${url} failed: ${(e as Error).message}`,
    )
  }
  if (!res.ok) {
    throw new Error(
      `file-list endpoint ${res.status} for ${url}: ${res.text()}`,
    )
  }

  const data = res.json<RawFileListResponse>()
  const includeHashes = options.includeHashes === true
  const files = extractFileList(
    data,
    includeHashes ? { includeHashes: true } : {},
  )
  const fileEntries = files.filter(f => f.type === 'file')
  const totalBytes = fileEntries.reduce((sum, f) => sum + (f.size ?? 0), 0)
  const tree = renderTree(files, { showSize: true, showHash: includeHashes })

  return {
    purl: purlStr,
    fileCount: fileEntries.length,
    totalBytes,
    files,
    tree,
  }
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes}B`
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)}K`
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`
}

/**
 * Render a sorted list of file entries as an indented tree using box-drawing
 * characters. Directories sort before files; siblings sort alphabetically.
 * Files include size and (optionally) hash inline.
 */
export function renderTree(
  entries: FileListEntry[],
  options: {
    showSize?: boolean | undefined
    showHash?: boolean | undefined
  } = {},
): string {
  const showSize = options.showSize !== false
  const showHash = options.showHash === true
  const root = buildTree(entries)
  const lines: string[] = []

  const walk = (node: TreeNode, prefix: string): void => {
    const kids = Array.from(node.children.values()).toSorted((a, b) => {
      if (a.isFile !== b.isFile) {
        return a.isFile ? 1 : -1
      }
      return a.name.localeCompare(b.name)
    })
    for (let i = 0; i < kids.length; i += 1) {
      const kid = kids[i]!
      const last = i === kids.length - 1
      const branch = last ? '└── ' : '├── '
      const cont = last ? '    ' : '│   '
      let line = prefix + branch + kid.name
      if (kid.isFile) {
        const meta: string[] = []
        if (showSize && kid.size !== undefined) {
          meta.push(formatSize(kid.size))
        }
        if (showHash && kid.hash) {
          meta.push(kid.hash)
        }
        if (meta.length) {
          line += `  ${meta.join('  ')}`
        }
      } else {
        line += '/'
      }
      lines.push(line)
      if (!kid.isFile && kid.children.size > 0) {
        walk(kid, prefix + cont)
      }
    }
  }

  walk(root, '')
  return lines.join('\n')
}

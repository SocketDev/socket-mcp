import nock from 'nock'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import {
  buildPurlForFiles,
  definePackageFileContentsTool,
  definePackageFileGrepTool,
  definePackageFilesTool,
} from '../lib/tool-package-files.ts'
import type { ToolHandlerExtra } from '../lib/tool-types.ts'

const API = 'https://api.socket.dev'
const BLOB_HOST = 'https://socketusercontent.com'

const withToken: ToolHandlerExtra = { authInfo: { token: 'tok' } }
const noToken: ToolHandlerExtra = {}

function fileListPath(purl: string): string {
  return `/v0/purl/file-list/${encodeURIComponent(purl)}`
}

// blob-cache keys by hash for the process lifetime, so every test uses a
// unique hash to avoid leaking a cached blob into the next case.
let hashCounter = 0
function uniqueHash(): string {
  hashCounter += 1
  return `Qtest${hashCounter}`
}

beforeEach(() => {
  nock.disableNetConnect()
})

afterEach(() => {
  nock.cleanAll()
  nock.enableNetConnect()
})

describe('buildPurlForFiles', () => {
  test('builds a bare purl with no qualifiers', () => {
    expect(buildPurlForFiles('npm', 'lodash', '4.17.21')).toBe(
      'pkg:npm/lodash@4.17.21',
    )
  })

  test('adds artifact_id and platform qualifiers when provided', () => {
    const purl = buildPurlForFiles(
      'openvsx',
      'meta/pyrefly',
      '1.0.0',
      'a1',
      'linux-x64',
    )
    expect(purl).toContain('artifact_id=a1')
    expect(purl).toContain('platform=linux-x64')
  })
})

describe('package_files tool handler', () => {
  test('returns AUTH_REQUIRED when no token is resolvable', async () => {
    const result = await definePackageFilesTool().handler(
      { depname: 'lodash', version: '4.17.21' },
      noToken,
    )
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toMatch(/Authentication is required/)
  })

  test('renders the file tree with a header on success', async () => {
    nock(API)
      .get(fileListPath('pkg:npm/lodash@4.17.21'))
      .reply(200, {
        files: [
          { path: 'package', type: 'dir' },
          { path: 'package/index.js', type: 'file', size: 100, hash: 'Qa' },
        ],
      })

    const result = await definePackageFilesTool().handler(
      { ecosystem: 'npm', depname: 'lodash', version: '4.17.21' },
      withToken,
    )
    expect(result.isError).toBeUndefined()
    expect(result.content[0]!.text).toMatch(/pkg:npm\/lodash@4.17.21 — 1 files/)
    expect(result.content[0]!.text).toMatch(/index\.js/)
  })

  test('reports "No files found" for an empty list', async () => {
    nock(API).get(fileListPath('pkg:npm/empty@2.0.0')).reply(200, { files: [] })

    const result = await definePackageFilesTool().handler(
      { depname: 'empty', version: '2.0.0' },
      withToken,
    )
    expect(result.isError).toBeUndefined()
    expect(result.content[0]!.text).toMatch(/No files found/)
  })

  test('returns an isError result on upstream failure', async () => {
    nock(API).get(fileListPath('pkg:npm/missing@2.0.0')).reply(404, 'not found')
    const result = await definePackageFilesTool().handler(
      { depname: 'missing', version: '2.0.0' },
      withToken,
    )
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toMatch(/Error fetching file list/)
  })
})

describe('package_file_contents tool handler', () => {
  test('returns the file text with a byte header', async () => {
    const hash = uniqueHash()
    nock(BLOB_HOST)
      .get(`/blob/${hash}`)
      .reply(200, 'line one\nline two', { 'content-type': 'text/plain' })

    const result = await definePackageFileContentsTool().handler(
      { hash, path: 'src/a.js' },
      withToken,
    )
    expect(result.isError).toBeUndefined()
    expect(result.content[0]!.text).toMatch(/src\/a\.js \(\d+ bytes\)/)
    expect(result.content[0]!.text).toMatch(/line one\nline two/)
  })

  test('refuses to return binary content', async () => {
    const hash = uniqueHash()
    nock(BLOB_HOST)
      .get(`/blob/${hash}`)
      .reply(200, Buffer.from([0x48, 0x00, 0x6c]))

    const result = await definePackageFileContentsTool().handler(
      { hash },
      withToken,
    )
    expect(result.content[0]!.text).toMatch(/appears to be binary/)
  })

  test('returns an isError result when the blob fetch fails', async () => {
    const hash = uniqueHash()
    nock(BLOB_HOST).get(`/blob/${hash}`).reply(404, 'gone')
    const result = await definePackageFileContentsTool().handler(
      { hash },
      withToken,
    )
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toMatch(/Error fetching blob/)
  })
})

describe('package_file_grep tool handler', () => {
  test('returns grep -n style matches', async () => {
    const hash = uniqueHash()
    nock(BLOB_HOST)
      .get(`/blob/${hash}`)
      .reply(200, 'import x\nconst y = 1\nimport z', {
        'content-type': 'text/plain',
      })

    const result = await definePackageFileGrepTool().handler(
      { hash, pattern: '^import' },
      withToken,
    )
    expect(result.isError).toBeUndefined()
    expect(result.content[0]!.text).toMatch(/2 matches for \/\^import\//)
    expect(result.content[0]!.text).toMatch(/1: import x/)
    expect(result.content[0]!.text).toMatch(/3: import z/)
  })

  test('reports no matches', async () => {
    const hash = uniqueHash()
    nock(BLOB_HOST)
      .get(`/blob/${hash}`)
      .reply(200, 'nothing here', { 'content-type': 'text/plain' })

    const result = await definePackageFileGrepTool().handler(
      { hash, pattern: 'zzz' },
      withToken,
    )
    expect(result.isError).toBeUndefined()
    expect(result.content[0]!.text).toMatch(/no matches for \/zzz\//)
  })

  test('honors contextLines and caseInsensitive', async () => {
    const hash = uniqueHash()
    nock(BLOB_HOST)
      .get(`/blob/${hash}`)
      .reply(200, 'a\nTARGET\nb\nc', { 'content-type': 'text/plain' })

    const result = await definePackageFileGrepTool().handler(
      { hash, pattern: 'target', caseInsensitive: true, contextLines: 1 },
      withToken,
    )
    expect(result.content[0]!.text).toMatch(/1- a/)
    expect(result.content[0]!.text).toMatch(/2: TARGET/)
    expect(result.content[0]!.text).toMatch(/3- b/)
  })

  test('caps results at maxMatches and notes the cap', async () => {
    const hash = uniqueHash()
    nock(BLOB_HOST)
      .get(`/blob/${hash}`)
      .reply(200, 'm\nm\nm\nm', { 'content-type': 'text/plain' })

    const result = await definePackageFileGrepTool().handler(
      { hash, pattern: 'm', maxMatches: 2 },
      withToken,
    )
    expect(result.content[0]!.text).toMatch(/stopped at maxMatches=2/)
  })

  test('rejects an invalid regular expression before fetching', async () => {
    const result = await definePackageFileGrepTool().handler(
      { hash: uniqueHash(), pattern: '(' },
      withToken,
    )
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toMatch(/Invalid regular expression/)
  })

  test('refuses to grep binary content', async () => {
    const hash = uniqueHash()
    nock(BLOB_HOST)
      .get(`/blob/${hash}`)
      .reply(200, Buffer.from([0x00, 0x01, 0x02]))

    const result = await definePackageFileGrepTool().handler(
      { hash, pattern: 'x' },
      withToken,
    )
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toMatch(/appears to be binary/)
  })
})

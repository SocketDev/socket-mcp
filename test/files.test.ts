import nock from 'nock'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { extractFileList, fetchFileList, renderTree } from '../lib/files.ts'

const API = 'https://api.socket.dev'

function filePath(purl: string): string {
  return `/v0/purl/file-list/${encodeURIComponent(purl)}`
}

beforeEach(() => {
  nock.disableNetConnect()
})

afterEach(() => {
  nock.cleanAll()
  nock.enableNetConnect()
})

describe('extractFileList', () => {
  test('parses array of file/dir entries', () => {
    const files = extractFileList({
      files: [
        { path: 'package', type: 'dir' },
        { path: 'package/LICENSE', type: 'file', size: 1952, hash: 'Q9x' },
        { path: 'package/index.js', type: 'file', size: 100, hash: 'Qab' },
      ],
    })
    expect(files.length).toBe(3)
    const license = files.find(f => f.path === 'package/LICENSE')!
    const dir = files.find(f => f.path === 'package')!
    expect(dir.type).toBe('dir')
    expect(license.type).toBe('file')
    expect(license.size).toBe(1952)
    expect(license.hash).toBe(undefined)
  })

  test('includes hashes when requested', () => {
    const files = extractFileList(
      { files: [{ path: 'a.js', type: 'file', size: 100, hash: 'Qa' }] },
      { includeHashes: true },
    )
    expect(files[0]!.hash).toBe('Qa')
  })

  test('skips entries without path', () => {
    const files = extractFileList({
      files: [
        { path: 'a.js', type: 'file', size: 1 },
        { type: 'file', size: 2 },
        { path: '', type: 'file', size: 3 },
      ],
    })
    expect(files.length).toBe(1)
    expect(files[0]!.path).toBe('a.js')
  })

  test('sorts entries by path', () => {
    const files = extractFileList({
      files: [
        { path: 'z.js', type: 'file' },
        { path: 'a.js', type: 'file' },
        { path: 'm.js', type: 'file' },
      ],
    })
    expect(files.map(f => f.path)).toEqual(['a.js', 'm.js', 'z.js'])
  })

  test('empty/missing files returns empty list', () => {
    expect(extractFileList({}).length).toBe(0)
    expect(extractFileList({ files: [] }).length).toBe(0)
  })
})

describe('renderTree', () => {
  test('flat layout under one directory', () => {
    const tree = renderTree([
      { path: 'package', type: 'dir' },
      { path: 'package/LICENSE', type: 'file', size: 1952 },
      { path: 'package/README.md', type: 'file', size: 1107 },
    ])
    expect(tree).toBe(
      ['└── package/', '    ├── LICENSE  1.9K', '    └── README.md  1.1K'].join(
        '\n',
      ),
    )
  })

  test('directories sort before files at same depth', () => {
    const tree = renderTree([
      { path: 'src/a.js', type: 'file', size: 100 },
      { path: 'index.js', type: 'file', size: 200 },
      { path: 'README.md', type: 'file', size: 50 },
    ])
    const lines = tree.split('\n')
    expect(lines[0]).toBe('├── src/')
    expect(lines[1]).toBe('│   └── a.js  100B')
    expect(lines[2]).toBe('├── index.js  200B')
    expect(lines[3]).toBe('└── README.md  50B')
  })

  test('formats sizes in B/K/M', () => {
    const tree = renderTree([
      { path: 'tiny.txt', type: 'file', size: 500 },
      { path: 'medium.bin', type: 'file', size: 2048 },
      { path: 'big.bin', type: 'file', size: 5 * 1024 * 1024 },
    ])
    expect(tree).toMatch(/tiny\.txt {2}500B/)
    expect(tree).toMatch(/medium\.bin {2}2\.0K/)
    expect(tree).toMatch(/big\.bin {2}5\.0M/)
  })

  test('shows hash when showHash enabled', () => {
    const tree = renderTree(
      [{ path: 'a.js', type: 'file', size: 100, hash: 'QabXYZ' }],
      { showHash: true },
    )
    expect(tree).toMatch(/a\.js {2}100B {2}QabXYZ/)
  })

  test('omits size when showSize false', () => {
    const tree = renderTree([{ path: 'a.js', type: 'file', size: 100 }], {
      showSize: false,
    })
    expect(tree).toBe('└── a.js')
  })

  test('infers nested directories from file paths alone', () => {
    const tree = renderTree([
      { path: 'src/utils/helper.js', type: 'file', size: 100 },
    ])
    expect(tree).toBe(
      ['└── src/', '    └── utils/', '        └── helper.js  100B'].join('\n'),
    )
  })

  test('empty input returns empty string', () => {
    expect(renderTree([])).toBe('')
  })
})

describe('fetchFileList', () => {
  test('builds correct URL and returns tree + totals', async () => {
    nock(API)
      .matchHeader('user-agent', 'socket-mcp/test')
      .matchHeader('authorization', 'Bearer secret-token')
      .get(filePath('pkg:npm/lodash@4.17.21'))
      .reply(
        200,
        {
          files: [
            { path: 'package', type: 'dir' },
            { path: 'package/index.js', type: 'file', size: 100, hash: 'Qa' },
          ],
        },
        { 'content-type': 'application/json' },
      )

    const result = await fetchFileList('pkg:npm/lodash@4.17.21', {
      baseUrl: API,
      userAgent: 'socket-mcp/test',
      authToken: 'secret-token',
    })

    expect(result.fileCount).toBe(1)
    expect(result.totalBytes).toBe(100)
    expect(result.tree).toMatch(/package\//)
    expect(result.tree).toMatch(/index\.js {2}100B/)
  })

  test('throws with status and body on non-2xx', async () => {
    nock(API).get(filePath('pkg:npm/missing@1.0.0')).reply(404, 'not found')
    await expect(
      fetchFileList('pkg:npm/missing@1.0.0', { baseUrl: API }),
    ).rejects.toThrow(/file-list endpoint 404 for .* not found/)
  })

  test('merges extraHeaders into the request', async () => {
    nock(API)
      .matchHeader('tuckner-mcp-test', 'abc123')
      .matchHeader('accept', 'application/json')
      .get(filePath('pkg:npm/lodash@4.17.21'))
      .reply(200, { files: [] })
    await fetchFileList('pkg:npm/lodash@4.17.21', {
      baseUrl: API,
      extraHeaders: { 'tuckner-mcp-test': 'abc123' },
    })
    expect(nock.isDone()).toBe(true)
  })

  test('strips trailing slash from baseUrl', async () => {
    const scope = nock(API)
      .get(filePath('pkg:npm/lodash@4.17.21'))
      .reply(200, { files: [] })
    await fetchFileList('pkg:npm/lodash@4.17.21', { baseUrl: `${API}/` })
    expect(scope.isDone()).toBe(true)
  })

  test('url-encodes PURL qualifiers in the path', async () => {
    const purl = 'pkg:pypi/numpy@1.26.0?artifact_id=numpy-1.26.0.tar.gz'
    const scope = nock(API).get(filePath(purl)).reply(200, { files: [] })
    await fetchFileList(purl, { baseUrl: API })
    // ? and = inside the PURL are percent-encoded so they don't get
    // interpreted as query-string delimiters.
    expect(encodeURIComponent(purl)).toContain('%3F')
    expect(scope.isDone()).toBe(true)
  })
})

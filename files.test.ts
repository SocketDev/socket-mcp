#!/usr/bin/env node
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  extractFileList,
  fetchFileList,
  renderTree
} from './lib/files.ts'

test('extractFileList', async (t) => {
  await t.test('parses array of file/dir entries', () => {
    const files = extractFileList({
      files: [
        { path: 'package', type: 'dir' },
        { path: 'package/LICENSE', type: 'file', size: 1952, hash: 'Q9x' },
        { path: 'package/index.js', type: 'file', size: 100, hash: 'Qab' }
      ]
    })
    assert.equal(files.length, 3)
    const license = files.find(f => f.path === 'package/LICENSE')!
    const dir = files.find(f => f.path === 'package')!
    assert.equal(dir.type, 'dir')
    assert.equal(license.type, 'file')
    assert.equal(license.size, 1952)
    assert.equal(license.hash, undefined, 'hash excluded by default')
  })

  await t.test('includes hashes when requested', () => {
    const files = extractFileList(
      { files: [{ path: 'a.js', type: 'file', size: 100, hash: 'Qa' }] },
      { includeHashes: true }
    )
    assert.equal(files[0]!.hash, 'Qa')
  })

  await t.test('skips entries without path', () => {
    const files = extractFileList({
      files: [
        { path: 'a.js', type: 'file', size: 1 },
        { type: 'file', size: 2 },
        { path: '', type: 'file', size: 3 }
      ]
    })
    assert.equal(files.length, 1)
    assert.equal(files[0]!.path, 'a.js')
  })

  await t.test('sorts entries by path', () => {
    const files = extractFileList({
      files: [
        { path: 'z.js', type: 'file' },
        { path: 'a.js', type: 'file' },
        { path: 'm.js', type: 'file' }
      ]
    })
    assert.deepEqual(files.map(f => f.path), ['a.js', 'm.js', 'z.js'])
  })

  await t.test('empty/missing files returns empty list', () => {
    assert.equal(extractFileList({}).length, 0)
    assert.equal(extractFileList({ files: [] }).length, 0)
  })
})

test('renderTree', async (t) => {
  await t.test('flat layout under one directory', () => {
    const tree = renderTree([
      { path: 'package', type: 'dir' },
      { path: 'package/LICENSE', type: 'file', size: 1952 },
      { path: 'package/README.md', type: 'file', size: 1107 }
    ])
    assert.equal(
      tree,
      [
        '└── package/',
        '    ├── LICENSE  1.9K',
        '    └── README.md  1.1K'
      ].join('\n')
    )
  })

  await t.test('directories sort before files at same depth', () => {
    const tree = renderTree([
      { path: 'src/a.js', type: 'file', size: 100 },
      { path: 'index.js', type: 'file', size: 200 },
      { path: 'README.md', type: 'file', size: 50 }
    ])
    const lines = tree.split('\n')
    assert.equal(lines[0], '├── src/')
    assert.equal(lines[1], '│   └── a.js  100B')
    assert.equal(lines[2], '├── index.js  200B')
    assert.equal(lines[3], '└── README.md  50B')
  })

  await t.test('formats sizes in B/K/M', () => {
    const tree = renderTree([
      { path: 'tiny.txt', type: 'file', size: 500 },
      { path: 'medium.bin', type: 'file', size: 2048 },
      { path: 'big.bin', type: 'file', size: 5 * 1024 * 1024 }
    ])
    assert.match(tree, /tiny\.txt {2}500B/)
    assert.match(tree, /medium\.bin {2}2\.0K/)
    assert.match(tree, /big\.bin {2}5\.0M/)
  })

  await t.test('shows hash when showHash enabled', () => {
    const tree = renderTree(
      [{ path: 'a.js', type: 'file', size: 100, hash: 'QabXYZ' }],
      { showHash: true }
    )
    assert.match(tree, /a\.js {2}100B {2}QabXYZ/)
  })

  await t.test('omits size when showSize false', () => {
    const tree = renderTree(
      [{ path: 'a.js', type: 'file', size: 100 }],
      { showSize: false }
    )
    assert.equal(tree, '└── a.js')
  })

  await t.test('infers nested directories from file paths alone', () => {
    const tree = renderTree([
      { path: 'src/utils/helper.js', type: 'file', size: 100 }
    ])
    assert.equal(
      tree,
      [
        '└── src/',
        '    └── utils/',
        '        └── helper.js  100B'
      ].join('\n')
    )
  })

  await t.test('empty input returns empty string', () => {
    assert.equal(renderTree([]), '')
  })
})

test('fetchFileList', async (t) => {
  await t.test('builds correct URL and returns tree + totals', async () => {
    let capturedUrl = ''
    let capturedHeaders: Record<string, string> | undefined
    const stubFetch = async (input: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(input)
      capturedHeaders = init?.headers as Record<string, string> | undefined
      return new Response(
        JSON.stringify({
          files: [
            { path: 'package', type: 'dir' },
            { path: 'package/index.js', type: 'file', size: 100, hash: 'Qa' }
          ]
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    }

    const result = await fetchFileList('pkg:npm/lodash@4.17.21', {
      baseUrl: 'https://api.socket.dev',
      fetchFn: stubFetch as typeof fetch,
      userAgent: 'socket-mcp/test',
      authToken: 'secret-token'
    })

    assert.equal(
      capturedUrl,
      'https://api.socket.dev/v0/purl/file-list/' + encodeURIComponent('pkg:npm/lodash@4.17.21')
    )
    assert.equal(capturedHeaders?.['user-agent'], 'socket-mcp/test')
    assert.equal(capturedHeaders?.['authorization'], 'Bearer secret-token')
    assert.equal(result.fileCount, 1, 'directory entries do not count toward fileCount')
    assert.equal(result.totalBytes, 100)
    assert.match(result.tree, /package\//)
    assert.match(result.tree, /index\.js {2}100B/)
  })

  await t.test('throws with status and body on non-2xx', async () => {
    const stubFetch = async () => new Response('not found', { status: 404 })
    await assert.rejects(
      fetchFileList('pkg:npm/missing@1.0.0', {
        baseUrl: 'https://api.socket.dev',
        fetchFn: stubFetch as typeof fetch
      }),
      /file-list endpoint 404 for .* not found/
    )
  })

  await t.test('merges extraHeaders into the request', async () => {
    let capturedHeaders: Record<string, string> | undefined
    const stubFetch = async (_input: string | URL | Request, init?: RequestInit) => {
      capturedHeaders = init?.headers as Record<string, string> | undefined
      return new Response(JSON.stringify({ files: [] }), { status: 200 })
    }
    await fetchFileList('pkg:npm/lodash@4.17.21', {
      baseUrl: 'https://api.socket.dev',
      fetchFn: stubFetch as typeof fetch,
      extraHeaders: { 'tuckner-mcp-test': 'abc123' }
    })
    assert.equal(capturedHeaders?.['tuckner-mcp-test'], 'abc123')
    assert.equal(capturedHeaders?.['accept'], 'application/json')
  })

  await t.test('strips trailing slash from baseUrl', async () => {
    let capturedUrl = ''
    const stubFetch = async (input: string | URL | Request) => {
      capturedUrl = String(input)
      return new Response(JSON.stringify({ files: [] }), { status: 200 })
    }
    await fetchFileList('pkg:npm/lodash@4.17.21', {
      baseUrl: 'https://api.socket.dev/',
      fetchFn: stubFetch as typeof fetch
    })
    assert.ok(capturedUrl.startsWith('https://api.socket.dev/v0/purl/file-list/'))
    assert.ok(!capturedUrl.includes('socket.dev//'))
  })

  await t.test('url-encodes PURL qualifiers in the path', async () => {
    let capturedUrl = ''
    const stubFetch = async (input: string | URL | Request) => {
      capturedUrl = String(input)
      return new Response(JSON.stringify({ files: [] }), { status: 200 })
    }
    await fetchFileList('pkg:pypi/numpy@1.26.0?artifact_id=numpy-1.26.0.tar.gz', {
      baseUrl: 'https://api.socket.dev',
      fetchFn: stubFetch as typeof fetch
    })
    // ? and = inside the PURL must be percent-encoded so they don't get
    // interpreted as query-string delimiters.
    assert.ok(capturedUrl.includes('%3F'), 'expected ? to be percent-encoded')
    assert.ok(capturedUrl.includes('%3D'), 'expected = to be percent-encoded')
    assert.equal(capturedUrl.split('?').length, 1, 'no query string on the request')
  })
})

// node --test specs for the cover.mts pure helpers (build-entry resolution).

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  BUILD_ENTRY_CANDIDATES,
  resolveBuildEntry,
} from '../cover.mts'

function makeRepo(entries: string[]): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cover-build-entry-'))
  mkdirSync(path.join(dir, 'scripts'), { recursive: true })
  for (let i = 0, { length } = entries; i < length; i += 1) {
    writeFileSync(path.join(dir, entries[i]!), '// stub\n')
  }
  return dir
}

test('resolveBuildEntry returns scripts/build.mts when present', () => {
  const dir = makeRepo(['scripts/build.mts'])
  try {
    assert.equal(resolveBuildEntry(dir), 'scripts/build.mts')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resolveBuildEntry returns scripts/bundle.mts when build.mts is absent', () => {
  const dir = makeRepo(['scripts/bundle.mts'])
  try {
    assert.equal(resolveBuildEntry(dir), 'scripts/bundle.mts')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resolveBuildEntry prefers build.mts over bundle.mts when both exist', () => {
  const dir = makeRepo(['scripts/build.mts', 'scripts/bundle.mts'])
  try {
    assert.equal(resolveBuildEntry(dir), 'scripts/build.mts')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resolveBuildEntry returns undefined for a tooling repo with no build entry', () => {
  // The wheelhouse itself: a scripts/ dir but no build/bundle entry. Coverage
  // must NOT try to spawn a non-existent build script.
  const dir = makeRepo([])
  try {
    assert.equal(resolveBuildEntry(dir), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('BUILD_ENTRY_CANDIDATES lists build.mts before bundle.mts', () => {
  // Precedence is load-bearing: the rename moved build→bundle, so a repo
  // mid-migration with both must pick the canonical build.mts first.
  assert.deepEqual(
    [...BUILD_ENTRY_CANDIDATES],
    ['scripts/build.mts', 'scripts/bundle.mts'],
  )
})

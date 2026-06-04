// node --test specs for the cover.mts discovery helpers (build-entry, config,
// and suite resolution). Pure path resolution against fixture repo dirs.

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  BUILD_ENTRY_CANDIDATES,
  readCoverConfig,
  resolveBuildEntry,
  resolveConfig,
  resolveSuites,
} from '../cover/discovery.mts'

// Build a throwaway repo dir, creating each listed repo-root-relative file
// (with its parent dirs) so the existsSync-based resolvers can find them.
function makeRepo(files: string[]): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cover-discovery-'))
  for (let i = 0, { length } = files; i < length; i += 1) {
    const full = path.join(dir, files[i]!)
    mkdirSync(path.dirname(full), { recursive: true })
    writeFileSync(full, '// stub\n')
  }
  return dir
}

function withRepo(files: string[], fn: (dir: string) => void): void {
  const dir = makeRepo(files)
  try {
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('resolveBuildEntry returns scripts/build.mts when present', () => {
  withRepo(['scripts/build.mts'], dir => {
    assert.equal(resolveBuildEntry(dir), 'scripts/build.mts')
  })
})

test('resolveBuildEntry returns scripts/bundle.mts when build.mts is absent', () => {
  withRepo(['scripts/bundle.mts'], dir => {
    assert.equal(resolveBuildEntry(dir), 'scripts/bundle.mts')
  })
})

test('resolveBuildEntry prefers build.mts over bundle.mts when both exist', () => {
  withRepo(['scripts/build.mts', 'scripts/bundle.mts'], dir => {
    assert.equal(resolveBuildEntry(dir), 'scripts/build.mts')
  })
})

test('resolveBuildEntry returns undefined for a tooling repo with no build entry', () => {
  // The wheelhouse itself: no build/bundle entry. Coverage must NOT try to
  // spawn a non-existent build script.
  withRepo([], dir => {
    assert.equal(resolveBuildEntry(dir), undefined)
  })
})

test('BUILD_ENTRY_CANDIDATES lists build.mts before bundle.mts', () => {
  // Precedence is load-bearing: the build→bundle rename means a repo
  // mid-migration with both must pick the canonical build.mts first.
  assert.deepEqual(
    [...BUILD_ENTRY_CANDIDATES],
    ['scripts/build.mts', 'scripts/bundle.mts'],
  )
})

test('resolveConfig prefers .config/repo over legacy .config', () => {
  withRepo(
    ['.config/repo/vitest.config.mts', '.config/vitest.config.mts'],
    dir => {
      assert.equal(
        resolveConfig(dir, 'vitest.config.mts'),
        path.join('.config', 'repo', 'vitest.config.mts'),
      )
    },
  )
})

test('resolveConfig falls back to legacy .config when repo-local is absent', () => {
  withRepo(['.config/vitest.config.mts'], dir => {
    assert.equal(
      resolveConfig(dir, 'vitest.config.mts'),
      path.join('.config', 'vitest.config.mts'),
    )
  })
})

test('resolveConfig returns undefined when neither location has the file', () => {
  withRepo([], dir => {
    assert.equal(resolveConfig(dir, 'vitest.config.mts'), undefined)
  })
})

test('readCoverConfig returns {} when no cover.json exists', () => {
  withRepo([], dir => {
    assert.deepEqual(readCoverConfig(dir), {})
  })
})

test('readCoverConfig reads .config/repo/cover.json', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cover-discovery-cfg-'))
  try {
    mkdirSync(path.join(dir, '.config', 'repo'), { recursive: true })
    writeFileSync(
      path.join(dir, '.config', 'repo', 'cover.json'),
      JSON.stringify({ thresholds: { lines: 90 } }),
    )
    assert.deepEqual(readCoverConfig(dir), { thresholds: { lines: 90 } })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readCoverConfig treats a malformed cover.json as empty', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cover-discovery-bad-'))
  try {
    mkdirSync(path.join(dir, '.config', 'repo'), { recursive: true })
    writeFileSync(path.join(dir, '.config', 'repo', 'cover.json'), '{ not json')
    assert.deepEqual(readCoverConfig(dir), {})
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resolveSuites includes only suites whose config resolves', () => {
  // Only the shared config exists → only the shared suite runs; isolated is
  // skipped because its config is absent.
  withRepo(['.config/repo/vitest.config.mts'], dir => {
    const suites = resolveSuites(dir, {})
    assert.equal(suites.length, 1)
    assert.equal(suites[0]!.name, 'shared')
    assert.equal(
      suites[0]!.config,
      path.join('.config', 'repo', 'vitest.config.mts'),
    )
    assert.deepEqual(suites[0]!.runExclude, [])
  })
})

test('resolveSuites runs both suites when both configs exist', () => {
  withRepo(
    [
      '.config/repo/vitest.config.mts',
      '.config/repo/vitest.config.isolated.mts',
    ],
    dir => {
      const suites = resolveSuites(dir, {})
      assert.deepEqual(
        suites.map(s => s.name),
        ['shared', 'isolated'],
      )
    },
  )
})

test('resolveSuites carries per-suite runExclude from cover.json', () => {
  withRepo(['.config/repo/vitest.config.mts'], dir => {
    const suites = resolveSuites(dir, {
      suites: { shared: { runExclude: ['test/slow/**'] } },
    })
    assert.deepEqual(suites[0]!.runExclude, ['test/slow/**'])
  })
})

test('resolveSuites honors an explicit config override even when standard is absent', () => {
  withRepo(['custom/vitest.mts'], dir => {
    const suites = resolveSuites(dir, {
      suites: { shared: { config: 'custom/vitest.mts' } },
    })
    assert.equal(suites.length, 1)
    assert.equal(suites[0]!.config, 'custom/vitest.mts')
  })
})

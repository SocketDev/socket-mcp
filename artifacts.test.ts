#!/usr/bin/env node
import { test } from 'node:test'
import assert from 'node:assert'
import { deduplicateArtifacts } from './lib/artifacts.ts'
import type { ArtifactData } from './lib/artifacts.ts'

function makeArtifact(overrides: Partial<ArtifactData> = {}): ArtifactData {
  return {
    type: 'pypi',
    name: 'numpy',
    version: '1.26.0',
    score: {
      overall: 0.95,
      supply_chain: 0.9,
      quality: 0.8,
      maintenance: 0.85,
      vulnerability: 1.0,
      license: 1.0,
    },
    ...overrides,
  }
}

test('deduplicateArtifacts', async t => {
  await t.test('single artifact passes through unchanged', () => {
    const artifacts = [makeArtifact({ release: 'numpy-1.26.0.tar.gz' })]
    const result = deduplicateArtifacts(artifacts)
    assert.strictEqual(result.length, 1)
    assert.strictEqual(result[0]!.release, 'numpy-1.26.0.tar.gz')
  })

  await t.test(
    'multiple artifacts for same package are deduplicated to one',
    () => {
      const artifacts = [
        makeArtifact({
          release:
            'numpy-1.26.0-cp312-cp312-manylinux_2_17_x86_64.manylinux2014_x86_64.whl',
        }),
        makeArtifact({
          release: 'numpy-1.26.0-cp312-cp312-macosx_14_0_arm64.whl',
        }),
        makeArtifact({ release: 'numpy-1.26.0-cp312-cp312-win_amd64.whl' }),
        makeArtifact({ release: 'numpy-1.26.0.tar.gz' }),
      ]
      const result = deduplicateArtifacts(artifacts)
      assert.strictEqual(result.length, 1)
    },
  )

  await t.test(
    'source dist is preferred over wheels when no platform specified',
    () => {
      const artifacts = [
        makeArtifact({
          release: 'numpy-1.26.0-cp312-cp312-manylinux_2_17_x86_64.whl',
        }),
        makeArtifact({ release: 'numpy-1.26.0.tar.gz' }),
        makeArtifact({ release: 'numpy-1.26.0-cp312-cp312-win_amd64.whl' }),
      ]
      const result = deduplicateArtifacts(artifacts)
      assert.strictEqual(result.length, 1)
      assert.strictEqual(result[0]!.release, 'numpy-1.26.0.tar.gz')
    },
  )

  await t.test('universal wheel is preferred when no sdist available', () => {
    const artifacts = [
      makeArtifact({
        release: 'requests-2.31.0-cp312-cp312-manylinux_2_17_x86_64.whl',
      }),
      makeArtifact({ release: 'requests-2.31.0-py3-none-any.whl' }),
      makeArtifact({ release: 'requests-2.31.0-cp312-cp312-win_amd64.whl' }),
    ]
    const result = deduplicateArtifacts(artifacts)
    assert.strictEqual(result.length, 1)
    assert.strictEqual(result[0]!.release, 'requests-2.31.0-py3-none-any.whl')
  })

  await t.test('platform hint selects darwin-arm64 wheel', () => {
    const artifacts = [
      makeArtifact({
        release: 'numpy-1.26.0-cp312-cp312-manylinux_2_17_x86_64.whl',
      }),
      makeArtifact({
        release: 'numpy-1.26.0-cp312-cp312-macosx_14_0_arm64.whl',
      }),
      makeArtifact({ release: 'numpy-1.26.0.tar.gz' }),
    ]
    const result = deduplicateArtifacts(artifacts, 'darwin-arm64')
    assert.strictEqual(result.length, 1)
    assert.strictEqual(
      result[0]!.release,
      'numpy-1.26.0-cp312-cp312-macosx_14_0_arm64.whl',
    )
  })

  await t.test('platform hint selects linux-x64 wheel', () => {
    const artifacts = [
      makeArtifact({
        release:
          'numpy-1.26.0-cp312-cp312-manylinux_2_17_x86_64.manylinux2014_x86_64.whl',
      }),
      makeArtifact({
        release: 'numpy-1.26.0-cp312-cp312-macosx_14_0_arm64.whl',
      }),
      makeArtifact({ release: 'numpy-1.26.0.tar.gz' }),
    ]
    const result = deduplicateArtifacts(artifacts, 'linux-x64')
    assert.strictEqual(result.length, 1)
    assert.strictEqual(
      result[0]!.release,
      'numpy-1.26.0-cp312-cp312-manylinux_2_17_x86_64.manylinux2014_x86_64.whl',
    )
  })

  await t.test('platform hint selects win32-x64 wheel', () => {
    const artifacts = [
      makeArtifact({
        release: 'numpy-1.26.0-cp312-cp312-manylinux_2_17_x86_64.whl',
      }),
      makeArtifact({ release: 'numpy-1.26.0-cp312-cp312-win_amd64.whl' }),
      makeArtifact({ release: 'numpy-1.26.0.tar.gz' }),
    ]
    const result = deduplicateArtifacts(artifacts, 'win32-x64')
    assert.strictEqual(result.length, 1)
    assert.strictEqual(
      result[0]!.release,
      'numpy-1.26.0-cp312-cp312-win_amd64.whl',
    )
  })

  await t.test('platform hint with no match falls back to source dist', () => {
    const artifacts = [
      makeArtifact({
        release: 'numpy-1.26.0-cp312-cp312-manylinux_2_17_x86_64.whl',
      }),
      makeArtifact({ release: 'numpy-1.26.0.tar.gz' }),
    ]
    const result = deduplicateArtifacts(artifacts, 'win32-x64')
    assert.strictEqual(result.length, 1)
    assert.strictEqual(result[0]!.release, 'numpy-1.26.0.tar.gz')
  })

  await t.test('different packages are not deduplicated', () => {
    const artifacts = [
      makeArtifact({ name: 'numpy', release: 'numpy-1.26.0.tar.gz' }),
      makeArtifact({ name: 'scipy', release: 'scipy-1.11.0.tar.gz' }),
    ]
    const result = deduplicateArtifacts(artifacts)
    assert.strictEqual(result.length, 2)
  })

  await t.test(
    'different versions of same package are not deduplicated',
    () => {
      const artifacts = [
        makeArtifact({ version: '1.26.0', release: 'numpy-1.26.0.tar.gz' }),
        makeArtifact({ version: '1.25.0', release: 'numpy-1.25.0.tar.gz' }),
      ]
      const result = deduplicateArtifacts(artifacts)
      assert.strictEqual(result.length, 2)
    },
  )

  await t.test('artifacts without release field use first-in-group', () => {
    const a1 = makeArtifact({ score: { overall: 0.9 } })
    const a2 = makeArtifact({ score: { overall: 0.8 } })
    const result = deduplicateArtifacts([a1, a2])
    assert.strictEqual(result.length, 1)
    assert.deepStrictEqual(result[0]!.score, { overall: 0.9 })
  })

  await t.test('works across different ecosystems', () => {
    const artifacts = [
      makeArtifact({ type: 'npm', name: 'express', version: '4.18.2' }),
      makeArtifact({
        type: 'pypi',
        name: 'numpy',
        version: '1.26.0',
        release: 'numpy-1.26.0-cp312-manylinux_x86_64.whl',
      }),
      makeArtifact({
        type: 'pypi',
        name: 'numpy',
        version: '1.26.0',
        release: 'numpy-1.26.0.tar.gz',
      }),
    ]
    const result = deduplicateArtifacts(artifacts)
    assert.strictEqual(result.length, 2)
    const types = result.map(r => r.type)
    assert.ok(types.includes('npm'))
    assert.ok(types.includes('pypi'))
  })

  await t.test('zip source distributions are recognized', () => {
    const artifacts = [
      makeArtifact({ release: 'package-1.0.0-cp312-win_amd64.whl' }),
      makeArtifact({ release: 'package-1.0.0.zip' }),
    ]
    const result = deduplicateArtifacts(artifacts)
    assert.strictEqual(result.length, 1)
    assert.strictEqual(result[0]!.release, 'package-1.0.0.zip')
  })

  await t.test('darwin-x64 platform matching', () => {
    const artifacts = [
      makeArtifact({ release: 'pkg-1.0-cp312-cp312-macosx_10_9_x86_64.whl' }),
      makeArtifact({ release: 'pkg-1.0-cp312-cp312-macosx_14_0_arm64.whl' }),
      makeArtifact({ release: 'pkg-1.0.tar.gz' }),
    ]
    const result = deduplicateArtifacts(artifacts, 'darwin-x64')
    assert.strictEqual(result.length, 1)
    assert.strictEqual(
      result[0]!.release,
      'pkg-1.0-cp312-cp312-macosx_10_9_x86_64.whl',
    )
  })

  await t.test('linux-arm64 platform matching', () => {
    const artifacts = [
      makeArtifact({
        release: 'pkg-1.0-cp312-cp312-manylinux_2_17_aarch64.whl',
      }),
      makeArtifact({
        release: 'pkg-1.0-cp312-cp312-manylinux_2_17_x86_64.whl',
      }),
      makeArtifact({ release: 'pkg-1.0.tar.gz' }),
    ]
    const result = deduplicateArtifacts(artifacts, 'linux-arm64')
    assert.strictEqual(result.length, 1)
    assert.strictEqual(
      result[0]!.release,
      'pkg-1.0-cp312-cp312-manylinux_2_17_aarch64.whl',
    )
  })

  await t.test('empty array returns empty', () => {
    const result = deduplicateArtifacts([])
    assert.strictEqual(result.length, 0)
  })

  await t.test('namespace is included in grouping key', () => {
    const artifacts = [
      makeArtifact({
        type: 'maven',
        namespace: 'org.apache',
        name: 'commons',
        version: '3.0',
      }),
      makeArtifact({
        type: 'maven',
        namespace: 'org.spring',
        name: 'commons',
        version: '3.0',
      }),
    ]
    const result = deduplicateArtifacts(artifacts)
    assert.strictEqual(result.length, 2)
  })
})

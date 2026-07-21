/**
 * @file Property/fuzz tests for lib/files (Tier-1 fast-check).
 *   `extractFileList` normalizes a loosely-typed Socket API `files` array (each
 *   field `unknown`) into a sorted, typed list; `formatSize` renders a byte
 *   count; `renderTree` draws a box-drawing tree. Contracts read from source:
 *
 *   - extractFileList never throws, drops entries without a non-empty string
 *     `path`, coerces `type` to 'dir' only when it is exactly 'dir', keeps
 *     numeric `size`, and includes `hash` only when `includeHashes` is set AND
 *     the raw hash is a string. Output is sorted by `path` (localeCompare).
 *   - formatSize always returns a string suffixed B / K / M.
 *   - renderTree never throws and every file's leaf name appears in the render.
 *     Arbitraries CONSTRUCT the raw entries so each expected outcome is known.
 */

import fc from 'fast-check'
import { describe, expect, test } from 'vitest'

import { extractFileList, formatSize, renderTree } from '../../lib/files.ts'
import type { FileListEntry, RawFileEntry } from '../../lib/files.ts'

const ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789'
const segment = fc
  .array(fc.constantFrom(...ALNUM), { minLength: 1, maxLength: 8 })
  .map(chars => chars.join(''))

// A non-empty path built from 1-4 slash-joined segments.
const pathString = fc
  .array(segment, { minLength: 1, maxLength: 4 })
  .map(parts => parts.join('/'))

// A raw entry with a valid (non-empty string) path but deliberately noisy
// type/size/hash so field-coercion rules are exercised.
const rawValidEntry: fc.Arbitrary<RawFileEntry> = fc.record(
  {
    path: pathString,
    type: fc.oneof(
      fc.constantFrom('file', 'dir'),
      fc.string(),
      fc.constant(undefined),
    ),
    size: fc.oneof(fc.nat(), fc.string(), fc.constant(undefined)),
    hash: fc.oneof(fc.string(), fc.integer(), fc.constant(undefined)),
  },
  { requiredKeys: ['path'] },
)

// A fully arbitrary raw entry — path may be a non-string or absent.
const rawNoisyEntry: fc.Arbitrary<RawFileEntry> = fc.record(
  {
    path: fc.oneof(fc.string(), fc.integer(), fc.constant(undefined)),
    type: fc.oneof(fc.string(), fc.integer(), fc.constant(undefined)),
    size: fc.oneof(fc.integer(), fc.string(), fc.constant(undefined)),
    hash: fc.oneof(fc.string(), fc.integer(), fc.constant(undefined)),
  },
  { requiredKeys: [] },
)

describe('lib/files extractFileList (fuzz)', () => {
  // NEVER-THROWS: any noisy `files` array yields a FileListEntry[].
  test('never throws and always returns an array on noisy input', () => {
    fc.assert(
      fc.property(fc.array(rawNoisyEntry), files => {
        const out = extractFileList({ files })
        expect(Array.isArray(out)).toBe(true)
        for (const entry of out) {
          expect(typeof entry.path).toBe('string')
          expect(entry.path.length).toBeGreaterThan(0)
          expect(entry.type === 'dir' || entry.type === 'file').toBe(true)
        }
      }),
    )
  })

  // A missing `files` key normalizes to an empty list.
  test('returns [] when files is absent', () => {
    expect(extractFileList({})).toEqual([])
  })

  // FILTER: exactly the entries with a non-empty string path survive. Expected
  // count computed here, not read from the SUT.
  test('keeps exactly the entries with a non-empty string path', () => {
    fc.assert(
      fc.property(fc.array(rawNoisyEntry), files => {
        const expected = files.filter(
          f => typeof f.path === 'string' && f.path.length > 0,
        ).length
        expect(extractFileList({ files }).length).toBe(expected)
      }),
    )
  })

  // SORTED INVARIANT: output is ascending by path (localeCompare).
  test('output is sorted by path', () => {
    fc.assert(
      fc.property(fc.array(rawValidEntry), files => {
        const out = extractFileList({ files })
        for (let i = 1; i < out.length; i += 1) {
          expect(
            out[i - 1]!.path.localeCompare(out[i]!.path),
          ).toBeLessThanOrEqual(0)
        }
      }),
    )
  })

  // FIELD COERCION: with unique paths we can map each output entry back to its
  // raw source and check the type/size/hash rules precisely.
  test('coerces type, keeps numeric size, and gates hash on includeHashes', () => {
    const uniqueByPath = fc.uniqueArray(rawValidEntry, {
      selector: e => e.path as string,
    })
    fc.assert(
      fc.property(uniqueByPath, fc.boolean(), (files, includeHashes) => {
        const bySource = new Map<string, RawFileEntry>(
          files.map(f => [f.path as string, f]),
        )
        const out = extractFileList(
          { files },
          includeHashes ? { includeHashes: true } : {},
        )
        for (const entry of out) {
          const raw = bySource.get(entry.path)!
          expect(entry.type).toBe(raw.type === 'dir' ? 'dir' : 'file')
          // size present iff the raw size was a number, and equal to it.
          if (typeof raw.size === 'number') {
            expect(entry.size).toBe(raw.size)
          } else {
            expect(entry.size).toBeUndefined()
          }
          // hash present iff includeHashes AND raw hash was a string.
          const hashExpected = includeHashes && typeof raw.hash === 'string'
          expect(entry.hash !== undefined).toBe(hashExpected)
        }
      }),
    )
  })
})

describe('lib/files formatSize (fuzz)', () => {
  // INVARIANT: always a string ending in B, K, or M.
  test('always returns a string suffixed B / K / M', () => {
    fc.assert(
      fc.property(fc.nat(), bytes => {
        expect(/^[\d.]+[BKM]$/u.test(formatSize(bytes))).toBe(true)
      }),
    )
  })

  // Exact form for sub-kilobyte counts.
  test('renders raw bytes below 1024 as `<n>B`', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1023 }), bytes => {
        expect(formatSize(bytes)).toBe(`${bytes}B`)
      }),
    )
  })

  // Megabyte-scale counts use the M suffix.
  test('uses the M suffix at >= 1 MiB', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1024 * 1024, max: 2 ** 40 }), bytes => {
        expect(formatSize(bytes).endsWith('M')).toBe(true)
      }),
    )
  })
})

describe('lib/files renderTree (fuzz)', () => {
  // NEVER-THROWS + coverage: every rendered file's leaf name appears in the
  // output string.
  test('never throws and renders every file leaf name', () => {
    const fileEntry: fc.Arbitrary<FileListEntry> = fc.record({
      path: pathString,
      type: fc.constant('file' as const),
      size: fc.nat(),
    })
    fc.assert(
      fc.property(
        fc.uniqueArray(fileEntry, { selector: e => e.path }),
        entries => {
          const rendered = renderTree(entries)
          expect(typeof rendered).toBe('string')
          for (const entry of entries) {
            const leaf = entry.path.split('/').filter(Boolean).at(-1)!
            expect(rendered.includes(leaf)).toBe(true)
          }
        },
      ),
    )
  })
})

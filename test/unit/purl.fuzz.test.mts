/**
 * @file Property/fuzz tests for lib/purl (Tier-1 fast-check).
 *   `buildPurl` turns loosely-typed tool-call arguments (ecosystem / depname /
 *   version, all model-supplied) into a canonical PURL string. The load-bearing
 *   contracts, read from source + probed against packageurl-js:
 *
 *   - For a valid PURL `type` (matches [A-Za-z0-9.-]) and a non-empty name the
 *     call returns a `pkg:<type>/...` string and never throws.
 *   - Case-preserving, non-normalizing ecosystems (cargo/gem/nuget) round-trip a
 *     safe alphanumeric name + numeric version verbatim — a clean oracle that
 *     does NOT reimplement the SUT (the expected string is built from inputs).
 *   - npm scoped `@scope/name`, composer `vendor/pkg`, golang `ns/.../name` split
 *     into namespace + name.
 *   - `''`, `'unknown'`, and (npm/pypi only) `'1.0.0'` are placeholder versions
 *     dropped from the output.
 *   - `openvsx` rewrites to the `vscode` type and injects a `repository_url`
 *     qualifier pointing at open-vsx.org.
 */

import fc from 'fast-check'
import { describe, expect, test } from 'vitest'

import { buildPurl } from '../../lib/purl.ts'

// Alphanumeric words: cargo/gem/nuget preserve these verbatim (case + digits),
// so the encoded PURL segment equals the input with no percent-encoding.
const ALNUM = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
const LOWER = 'abcdefghijklmnopqrstuvwxyz0123456789'

const nameWord = fc
  .array(fc.constantFrom(...ALNUM.split('')), { minLength: 1, maxLength: 20 })
  .map(chars => chars.join(''))

// Lowercase-only word for ecosystems that lowercase the name (npm/composer),
// so the input already equals its normalized form.
const lowerWord = fc
  .array(fc.constantFrom(...LOWER.split('')), { minLength: 1, maxLength: 20 })
  .map(chars => chars.join(''))

// A numeric version whose major is >= 2, so it is never the '1.0.0' placeholder
// (dropped for npm/pypi) — keeps the `@<version>` suffix present everywhere.
const realVersion = fc
  .tuple(fc.integer({ min: 2, max: 300 }), fc.nat(300), fc.nat(300))
  .map(([ma, mi, pa]) => `${ma}.${mi}.${pa}`)

// Ecosystems that preserve case and apply no name normalization.
const verbatimEco = fc.constantFrom('cargo', 'gem', 'nuget')

// Any ecosystem string that is a legal PURL type: packageurl-js validates the
// type against [A-Za-z0-9.-] AND forbids a leading digit, matching how real
// ecosystem names look (npm, pypi, cargo, ...). Build one so the first char is
// always a letter.
const LETTERS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
const validTypeEco = fc
  .tuple(
    fc.constantFrom(...LETTERS.split('')),
    fc.array(fc.constantFrom(...ALNUM.split(''), '.', '-'), { maxLength: 9 }),
  )
  .map(([head, rest]) => head + rest.join(''))

describe('lib/purl buildPurl (fuzz)', () => {
  // ORACLE (round-trip): a safe name + real version on a non-normalizing
  // ecosystem serializes to exactly `pkg:<eco>/<name>@<version>`.
  test('verbatim ecosystems round-trip name + version exactly', () => {
    fc.assert(
      fc.property(verbatimEco, nameWord, realVersion, (eco, name, version) => {
        expect(buildPurl(eco, name, version)).toBe(
          `pkg:${eco}/${name}@${version}`,
        )
      }),
    )
  })

  // Namespace split (npm scoped): `@scope/name` becomes `%40scope/name`.
  test('npm scoped names split into %40scope/name', () => {
    fc.assert(
      fc.property(lowerWord, lowerWord, realVersion, (scope, name, version) => {
        expect(buildPurl('npm', `@${scope}/${name}`, version)).toBe(
          `pkg:npm/%40${scope}/${name}@${version}`,
        )
      }),
    )
  })

  // Namespace split (composer): `vendor/pkg` keeps the slash as a real path
  // separator, never percent-encoded into the name.
  test('composer vendor/pkg splits into namespace + name', () => {
    fc.assert(
      fc.property(lowerWord, lowerWord, realVersion, (vendor, pkg, version) => {
        expect(buildPurl('composer', `${vendor}/${pkg}`, version)).toBe(
          `pkg:composer/${vendor}/${pkg}@${version}`,
        )
      }),
    )
  })

  // INVARIANT: for any legal type + non-empty name the output is a PURL string
  // beginning with the (lowercased) type, and never throws.
  test('always yields a pkg: string with the lowercased type prefix', () => {
    fc.assert(
      fc.property(validTypeEco, nameWord, realVersion, (eco, name, version) => {
        const purl = buildPurl(eco, name, version)
        expect(purl.startsWith('pkg:')).toBe(true)
        // packagist aliases to composer, openvsx aliases to vscode.
        const lower = eco.toLowerCase()
        const expectedType =
          lower === 'packagist'
            ? 'composer'
            : lower === 'openvsx'
              ? 'vscode'
              : lower
        expect(purl.startsWith(`pkg:${expectedType}/`)).toBe(true)
      }),
    )
  })

  // Placeholder versions are dropped for npm/pypi: the output carries no
  // `@version` suffix at all (an unscoped safe name contains no literal '@').
  test('npm/pypi drop placeholder versions', () => {
    const placeholder = fc.constantFrom('', 'unknown', '1.0.0')
    fc.assert(
      fc.property(
        fc.constantFrom('npm', 'pypi'),
        lowerWord,
        placeholder,
        (eco, name, version) => {
          expect(buildPurl(eco, name, version).includes('@')).toBe(false)
        },
      ),
    )
  })

  // 'unknown' and '' are placeholders for EVERY ecosystem (only '1.0.0' is
  // ecosystem-specific), so a verbatim ecosystem also drops them.
  test("empty and 'unknown' versions are dropped for verbatim ecosystems", () => {
    fc.assert(
      fc.property(
        verbatimEco,
        nameWord,
        fc.constantFrom('', 'unknown'),
        (eco, name, version) => {
          expect(buildPurl(eco, name, version)).toBe(`pkg:${eco}/${name}`)
        },
      ),
    )
  })

  // openvsx rewrites to the vscode type and injects the open-vsx repository_url
  // qualifier (encoding of '://' is left to packageurl-js; assert the key+host).
  test('openvsx rewrites to vscode with a repository_url qualifier', () => {
    fc.assert(
      fc.property(lowerWord, lowerWord, realVersion, (ns, name, version) => {
        const purl = buildPurl('openvsx', `${ns}/${name}`, version)
        expect(purl.startsWith(`pkg:vscode/${ns}/${name}@${version}`)).toBe(
          true,
        )
        expect(purl).toContain('repository_url=')
        expect(purl).toContain('open-vsx.org')
      }),
    )
  })

  // A caller-supplied qualifier survives into the query string.
  test('caller qualifiers appear in the output', () => {
    fc.assert(
      fc.property(verbatimEco, nameWord, realVersion, (eco, name, version) => {
        const purl = buildPurl(eco, name, version, { platform: 'linux-x64' })
        expect(purl).toContain('platform=linux-x64')
      }),
    )
  })
})

/**
 * @file Property/fuzz tests for lib/http-helpers (Tier-1 fast-check).
 *   Two untrusted-input surfaces plus two header pickers:
 *
 *   - `assertSafeHttpUrl` — the SSRF guard for operator/issuer-supplied URLs.
 *     Contract: returns a `URL` for public http(s) URLs; throws an `Error`
 *     (never any other type) for non-http(s) schemes, unparseable input, and
 *     loopback/private/link-local hosts (unless `allowLocalhost` opens the gate
 *     for `localhost`/`127.0.0.1`).
 *   - `parseJsonObject` — accepts only a JSON _object_; arrays, primitives, and
 *     invalid JSON throw an `Error`.
 *   - `getRequestHeaderValue` / `getForwardedHeaderValue` — total header pickers
 *     that never throw. Arbitraries CONSTRUCT hosts/values whose verdict is
 *     known up front.
 */

import fc from 'fast-check'
import { describe, expect, test } from 'vitest'

import {
  assertSafeHttpUrl,
  getForwardedHeaderValue,
  getRequestHeaderValue,
  parseJsonObject,
} from '../../lib/http-helpers.ts'

const ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789'
const word = fc
  .array(fc.constantFrom(...ALNUM.split('')), { minLength: 1, maxLength: 12 })
  .map(chars => chars.join(''))

const octet = fc.integer({ min: 0, max: 255 })

// A public host that matches none of the private/loopback patterns. The fixed
// `svc-` prefix guarantees it never begins with a private IPv4 octet (10., 127.,
// 192.168., 169.254., 172.x) or an IPv6 private prefix (fd/fe80/fc00/::1).
const publicHost = word.map(w => `svc-${w}.example.com`)

// URLs the guard must ACCEPT (public http/https).
const publicHttpUrl = fc
  .tuple(fc.constantFrom('http', 'https'), publicHost)
  .map(([s, h]) => `${s}://${h}/`)

// Private / loopback IPv4 + IPv6 hosts the guard must REJECT.
const privateHost = fc.oneof(
  fc.tuple(octet, octet, octet).map(([a, b, c]) => `10.${a}.${b}.${c}`),
  fc.tuple(octet, octet, octet).map(([a, b, c]) => `127.${a}.${b}.${c}`),
  fc.tuple(octet, octet).map(([a, b]) => `169.254.${a}.${b}`),
  fc.tuple(octet, octet).map(([a, b]) => `192.168.${a}.${b}`),
  fc
    .tuple(fc.integer({ min: 16, max: 31 }), octet, octet)
    .map(([a, b, c]) => `172.${a}.${b}.${c}`),
  fc.constant('0.0.0.0'),
  fc.constantFrom('[::1]', '[fd00::1]', '[fdab::7]', '[fe80::1]', '[fc00::1]'),
)

describe('lib/http-helpers assertSafeHttpUrl (fuzz)', () => {
  // Public http(s) URLs pass and return a URL whose hostname is preserved.
  test('accepts public http(s) URLs and returns a URL', () => {
    fc.assert(
      fc.property(publicHttpUrl, raw => {
        const url = assertSafeHttpUrl(raw, 'issuer')
        expect(url).toBeInstanceOf(URL)
        expect(raw.startsWith(`${url.protocol}//${url.hostname}`)).toBe(true)
      }),
    )
  })

  // Private / loopback hosts are refused (default: allowLocalhost = false).
  test('rejects private / loopback hosts', () => {
    fc.assert(
      fc.property(privateHost, host => {
        expect(() => assertSafeHttpUrl(`http://${host}/`, 'issuer')).toThrow(
          Error,
        )
      }),
    )
  })

  // Non-http(s) schemes are refused even for an otherwise-public host.
  test('rejects non-http(s) schemes', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('ftp', 'ws', 'wss', 'gopher', 'file'),
        publicHost,
        (proto, host) => {
          expect(() => assertSafeHttpUrl(`${proto}://${host}/`, 'x')).toThrow(
            Error,
          )
        },
      ),
    )
  })

  // allowLocalhost opens the gate for localhost / 127.0.0.1 only.
  test('allowLocalhost accepts localhost and 127.0.0.1', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('localhost', '127.0.0.1'),
        fc.constantFrom('http', 'https'),
        (host, proto) => {
          const url = assertSafeHttpUrl(`${proto}://${host}/`, 'x', true)
          expect(url).toBeInstanceOf(URL)
        },
      ),
    )
  })

  // INVARIANT: for ANY string the guard either returns a URL or throws an Error
  // — it never leaks a non-Error throw or a non-URL return.
  test('always returns a URL or throws an Error for arbitrary input', () => {
    fc.assert(
      fc.property(fc.string(), raw => {
        let result: unknown
        let thrown: unknown
        let threw = false
        try {
          result = assertSafeHttpUrl(raw, 'label')
        } catch (e) {
          threw = true
          thrown = e
        }
        if (threw) {
          expect(thrown).toBeInstanceOf(Error)
        } else {
          expect(result).toBeInstanceOf(URL)
        }
      }),
    )
  })
})

describe('lib/http-helpers getRequestHeaderValue (fuzz)', () => {
  // A plain string header is returned verbatim ('' || '' === '' too).
  test('returns any string header unchanged', () => {
    fc.assert(
      fc.property(fc.string(), s => {
        expect(getRequestHeaderValue(s)).toBe(s)
      }),
    )
  })

  // An array header collapses to its first entry (or '' when empty).
  test('collapses an array header to its first entry', () => {
    fc.assert(
      fc.property(fc.array(fc.string()), arr => {
        const expected = arr.length ? arr[0] || '' : ''
        expect(getRequestHeaderValue(arr)).toBe(expected)
      }),
    )
  })

  // undefined yields the empty string.
  test('returns empty string for undefined', () => {
    expect(getRequestHeaderValue(undefined)).toBe('')
  })
})

describe('lib/http-helpers getForwardedHeaderValue (fuzz)', () => {
  // The first comma-delimited hop is taken and trimmed. Construct a first hop
  // with no comma so the split boundary is known.
  test('returns the trimmed first hop of a comma list', () => {
    const noComma = fc.string().map(s => s.replaceAll(',', ''))
    fc.assert(
      fc.property(noComma, fc.string(), (first, rest) => {
        const expected = first.trim()
        expect(getForwardedHeaderValue(`${first},${rest}`)).toBe(expected)
      }),
    )
  })

  // NEVER-THROWS across the whole header union.
  test('returns a string and never throws for arbitrary header shapes', () => {
    const header = fc.oneof(
      fc.string(),
      fc.array(fc.string()),
      fc.constant(undefined),
    )
    fc.assert(
      fc.property(header, h => {
        expect(typeof getForwardedHeaderValue(h)).toBe('string')
      }),
    )
  })
})

// A JSON value with safe keys that round-trips through JSON.stringify -> parse.
const safeJsonValue = fc.letrec<{ node: unknown }>(tie => ({
  node: fc.oneof(
    { maxDepth: 3, depthSize: 'small' },
    fc.boolean(),
    fc.integer(),
    fc.string(),
    fc.array(tie('node')),
    fc.dictionary(
      fc.constantFrom('a', 'b', 'c', 'name', 'value', 'nested'),
      tie('node'),
      { noNullPrototype: true },
    ),
  ),
})).node

// A top-level JSON OBJECT (the only shape parseJsonObject accepts).
const safeJsonObject = fc.dictionary(
  fc.constantFrom('a', 'b', 'c', 'name', 'value', 'nested'),
  safeJsonValue,
  { noNullPrototype: true },
)

describe('lib/http-helpers parseJsonObject (fuzz)', () => {
  // ORACLE / round-trip: a stringified JSON object parses back deep-equal.
  test('round-trips a JSON object', () => {
    fc.assert(
      fc.property(safeJsonObject, obj => {
        expect(parseJsonObject(JSON.stringify(obj), 'ctx')).toStrictEqual(obj)
      }),
    )
  })

  // Non-object JSON (arrays, primitives, null) is rejected.
  test('rejects arrays, primitives, and null', () => {
    const nonObject = fc.oneof(
      fc.integer(),
      fc.double({ noNaN: true }),
      fc.string(),
      fc.boolean(),
      fc.array(safeJsonValue),
      // oxlint-disable-next-line socket/prefer-undefined-over-null -- JSON null is a rejected non-object under test
      fc.constant(null),
    )
    fc.assert(
      fc.property(nonObject, v => {
        expect(() => parseJsonObject(JSON.stringify(v), 'ctx')).toThrow(
          /invalid JSON/,
        )
      }),
    )
  })

  // INVARIANT: for ANY string the parser either returns a non-array object or
  // throws an Error — never a non-Error throw, never a primitive/array result.
  test('always returns an object or throws an Error for arbitrary input', () => {
    fc.assert(
      fc.property(fc.string(), s => {
        let result: unknown
        let thrown: unknown
        let threw = false
        try {
          result = parseJsonObject(s, 'ctx')
        } catch (e) {
          threw = true
          thrown = e
        }
        if (threw) {
          expect(thrown).toBeInstanceOf(Error)
        } else {
          expect(typeof result).toBe('object')
          expect(Array.isArray(result)).toBe(false)
          expect(result).not.toBeNull()
        }
      }),
    )
  })
})

/**
 * @file Property/fuzz tests for lib/http-origin (Tier-1 fast-check).
 *   These are the HTTP transport's same-origin / CORS gate — a security
 *   boundary fed attacker-controllable `Origin` and `Host` header strings. The
 *   contracts under test (read from source):
 *
 *   - `isLocalhostOrigin` returns a boolean for ANY string (never throws), true
 *     iff the URL's hostname is `localhost` or `127.0.0.1`.
 *   - `validateOriginAndHost` allows a request iff (origin present) the origin is
 *     localhost or on the production allow-list, or (origin absent) the host
 *     matches localhost / 127.0.0.1 (with or without the bound port) or an
 *     allow-listed production host. It never throws. Properties CONSTRUCT
 *     origins/hosts whose verdict is known up front rather than reimplementing
 *     the policy.
 */

import fc from 'fast-check'
import { describe, expect, test } from 'vitest'

import {
  isLocalhostOrigin,
  validateOriginAndHost,
} from '../../lib/http-origin.ts'

// The production allow-list, mirrored from the module as public config so the
// expected verdict is built here, not read back out of the SUT.
const ALLOWED_ORIGINS = [
  'https://mcp.socket.dev',
  'https://mcp.socket-staging.dev',
] as const
const ALLOWED_HOSTS = ['mcp.socket.dev', 'mcp.socket-staging.dev'] as const

const ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789'
const word = fc
  .array(fc.constantFrom(...ALNUM.split('')), { minLength: 1, maxLength: 15 })
  .map(chars => chars.join(''))

const scheme = fc.constantFrom('http', 'https')
const port = fc.integer({ min: 1, max: 65_535 })
const loopbackHost = fc.constantFrom('localhost', '127.0.0.1')

// A URL whose hostname is a loopback name, optionally with a port.
const localhostOrigin = fc
  .tuple(scheme, loopbackHost, fc.option(port, { nil: undefined }))
  .map(([s, h, p]) => (p === undefined ? `${s}://${h}` : `${s}://${h}:${p}`))

// A URL whose hostname is a non-loopback, non-allow-listed public domain.
const publicOrigin = fc
  .tuple(scheme, word, fc.option(port, { nil: undefined }))
  .map(([s, w, p]) => {
    const host = `${w}.example.com`
    return p === undefined ? `${s}://${host}` : `${s}://${host}:${p}`
  })

describe('lib/http-origin isLocalhostOrigin (fuzz)', () => {
  // INVARIANT: a loopback-hostname URL is always recognized as localhost.
  test('true for any localhost / 127.0.0.1 URL', () => {
    fc.assert(
      fc.property(localhostOrigin, origin => {
        expect(isLocalhostOrigin(origin)).toBe(true)
      }),
    )
  })

  // A public domain URL is never treated as localhost.
  test('false for any non-loopback public-domain URL', () => {
    fc.assert(
      fc.property(publicOrigin, origin => {
        expect(isLocalhostOrigin(origin)).toBe(false)
      }),
    )
  })

  // NEVER-THROWS: any string yields a boolean, never an exception.
  test('returns a boolean for arbitrary input and never throws', () => {
    fc.assert(
      fc.property(fc.string(), s => {
        expect(typeof isLocalhostOrigin(s)).toBe('boolean')
      }),
    )
  })
})

describe('lib/http-origin validateOriginAndHost (fuzz)', () => {
  // A localhost origin is accepted no matter what host / port is claimed.
  test('localhost origin is accepted regardless of host and port', () => {
    fc.assert(
      fc.property(localhostOrigin, fc.string(), port, (origin, host, p) => {
        expect(validateOriginAndHost(origin, host, p)).toBe(true)
      }),
    )
  })

  // An allow-listed production origin is accepted regardless of host / port.
  test('allow-listed production origin is accepted', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ALLOWED_ORIGINS),
        fc.string(),
        port,
        (origin, host, p) => {
          expect(validateOriginAndHost(origin, host, p)).toBe(true)
        },
      ),
    )
  })

  // A present-but-unlisted public origin is rejected regardless of host: when
  // an origin is sent the host branch is not consulted.
  test('an unlisted public origin is rejected regardless of host', () => {
    fc.assert(
      fc.property(publicOrigin, fc.string(), port, (origin, host, p) => {
        expect(validateOriginAndHost(origin, host, p)).toBe(false)
      }),
    )
  })

  // Origin absent: a loopback or allow-listed host is accepted. Construct the
  // exact host forms the policy accepts.
  test('with no origin, loopback / allow-listed hosts are accepted', () => {
    const acceptedHost = (p: number) =>
      fc.constantFrom(
        `localhost:${p}`,
        `127.0.0.1:${p}`,
        'localhost',
        '127.0.0.1',
        ...ALLOWED_HOSTS,
      )
    fc.assert(
      fc.property(
        port.chain(p => fc.tuple(fc.constant(p), acceptedHost(p))),
        ([p, host]) => {
          expect(validateOriginAndHost('', host, p)).toBe(true)
        },
      ),
    )
  })

  // Origin absent + an unrelated public host is rejected.
  test('with no origin, an unrelated public host is rejected', () => {
    fc.assert(
      fc.property(word, port, (w, p) => {
        expect(validateOriginAndHost('', `${w}.example.com`, p)).toBe(false)
      }),
    )
  })

  // NEVER-THROWS over arbitrary triples.
  test('returns a boolean for arbitrary input and never throws', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), port, (origin, host, p) => {
        expect(typeof validateOriginAndHost(origin, host, p)).toBe('boolean')
      }),
    )
  })
})

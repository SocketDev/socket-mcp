/**
 * @file Vitiate coverage-guided fuzz target (Tier 2) for lib/http-origin — the
 *   HTTP transport's same-origin / CORS gate, fed attacker-controllable
 *   `Origin` and `Host` header strings. Complements the fast-check property
 *   tests in http-origin.fuzz.test.mts: fast-check checks the verdict on
 *   constructed inputs; vitiate feeds SWC-coverage-guided mutated BYTES through
 *   `new URL()` to reach parser edges a spec-based test never hits. Both
 *   functions are documented-total (each wraps its URL parsing and returns a
 *   boolean for ANY input), so the targets wrap NOTHING — any thrown error is a
 *   crash vitiate reports as a real bug. Run via `pnpm run test:fuzz`.
 */

import { fuzz } from '@vitiate/core'

import {
  isLocalhostOrigin,
  validateOriginAndHost,
} from '../../lib/http-origin.ts'

// `isLocalhostOrigin` promises to NEVER throw — it catches `new URL()` failures
// and returns false. Any thrown error on arbitrary bytes is a crash.
fuzz('isLocalhostOrigin never throws on arbitrary bytes', data => {
  isLocalhostOrigin(data.toString('utf8'))
})

// `validateOriginAndHost` is likewise documented-total. Split the mutated bytes
// into an origin + host field (on NUL, which the mutator can grow
// independently) and derive a port from the leading bytes so all three args are
// fuzzed together.
fuzz('validateOriginAndHost never throws on arbitrary bytes', data => {
  const { 0: origin = '', 1: host = '' } = data.toString('utf8').split('\u0000')
  const port = data.length >= 2 ? data.readUInt16BE(0) : 0
  validateOriginAndHost(origin, host, port)
})

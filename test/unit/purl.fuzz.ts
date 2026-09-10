/**
 * @file Vitiate coverage-guided fuzz target (Tier 2) for lib/purl — the
 *   untrusted-input PURL boundary. `buildPurl` turns three model-supplied
 *   strings (ecosystem / depname / version) into a canonical PURL via
 *   packageurl-js. Complements the fast-check property tests in
 *   purl.fuzz.test.mts: fast-check checks correctness on generated values;
 *   vitiate feeds SWC-coverage-guided mutated BYTES to reach the
 *   namespace-splitting + placeholder-version branches a spec-based test never
 *   hits. Run via `pnpm run test:fuzz`.
 */

import { fuzz } from '@vitiate/core'
import { PurlError } from '@socketregistry/packageurl-js'

import { buildPurl } from '../../lib/purl.ts'

// `buildPurl` is a VALIDATING boundary: packageurl-js throws `PurlError` (its
// documented validation-failure type, and the parent of PurlInjectionError) for
// illegal types, empty names, injection characters, etc. Those throws are the
// contract. Anything that is NOT a PurlError — a TypeError, RangeError, or any
// other uncontrolled crash — is a real bug, so rethrow it and let vitiate
// report the crash.
fuzz('buildPurl throws only PurlError on arbitrary bytes', data => {
  const {
    0: ecosystem = '',
    1: depname = '',
    2: version = '',
  } = data.toString('utf8').split('\u0000')
  try {
    buildPurl(ecosystem, depname, version)
  } catch (e) {
    if (!(e instanceof PurlError)) {
      throw e
    }
  }
})

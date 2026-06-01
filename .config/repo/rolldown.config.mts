/**
 * @file Rolldown config for socket-mcp. Single-file CJS bundle to
 *   `dist/index.cjs` — every runtime dep gets inlined so the published package
 *   has zero runtime dependencies (all deps move to devDeps). Stub plugins
 *   mirror socket-sdk-js — `@socketsecurity/lib`'s module graph statically
 *   pulls in heavyweight files (globs.js → picomatch, sorts.js → semver +
 *   npm-pack, packages/licenses → spdx-expression-parse,
 *   external/{cacache,del,npm-pack,pico-pack} subgraphs, etc.) along paths mcp
 *   never traverses. Rolldown can't tree-shake those unreachable subgraphs
 *   because they look reachable to the static analyzer. The stubs replace them
 *   with empty CJS modules (LIB_STUB_PATTERN) or pure-function shims
 *   (OPERATIONS_STUB) so the bundle stays small + the eager-init crashes don't
 *   fire at startup.
 */

import { builtinModules } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Plugin, RolldownOptions } from 'rolldown'

import { createLibStubPlugin } from './rolldown/lib-stub.mts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootPath = path.join(__dirname, '..')
const distPath = path.join(rootPath, 'dist')

// Externalize Node builtins (with + without `node:` prefix). Everything
// else gets inlined into the bundle.
const externals = [...builtinModules, ...builtinModules.map(m => `node:${m}`)]

// Heavy lib modules eagerly required but never exercised by mcp's code
// paths. Verified unreachable from mcp's import surface (errors,
// env/socket, http-request/request, secrets/socket-api-token).
//
// `packages/licenses` pulls in spdx-expression-parse + spdx-correct +
// validate-npm-package-license + normalize-package-data — only used by
// lib's package-metadata helpers, which mcp doesn't reach.
//
// `packages/package-default-node-range` eagerly evaluates `semver.parse(...)`
// at module-load via the stubbed npm-pack — would crash; mcp never reads
// the export anyway.
//
// `external/{cacache,del,npm-pack,pico-pack}` + `globs.js` + `sorts.js`:
// same pattern as socket-sdk-js — unreachable from mcp.
const LIB_STUB_PATTERN =
  /@socketsecurity\/lib\/dist\/(?:constants\/package-default-node-range|external\/(?:cacache|del|npm-pack|pico-pack)|globs|packages\/licenses|sorts)\.js$/

// `packages/operations` is required only for `pkgNameToSlug` (used by
// http-request/user-agent to build the UA string). Its module body eagerly
// inits a make-fetch-happen fetcher from the stubbed npm-pack → crashes
// at load. Replace with just the pure helper. (lib 6.0.4+ makes that
// fetcher lazy; the stub stays for backward compat with 6.0.3.)
const OPERATIONS_PATTERN =
  /@socketsecurity\/lib\/dist\/packages\/operations\.js$/
const OPERATIONS_STUB = `'use strict'
function pkgNameToSlug(pkgName) {
  return pkgName.charCodeAt(0) === 64
    ? pkgName.slice(1).replace('/', '-')
    : pkgName
}
module.exports = { pkgNameToSlug }`

// 212KB mime-db reached via form-data → mime-types → mime-db. mcp only
// needs json + octet-stream. Same stub as socket-sdk-js.
const MIME_DB_PATTERN = /mime-db\/db\.json$/
const MIME_DB_STUB = `module.exports = {
  "application/json": { source: "iana", charset: "UTF-8", compressible: true },
  "application/octet-stream": { source: "iana", compressible: false },
  "multipart/form-data": { source: "iana" }
}`

export function createCodeStubPlugin(
  stubs: ReadonlyArray<{ pattern: RegExp; code: string }>,
): Plugin {
  return {
    name: 'stub-code-modules',
    load(id) {
      for (const { code, pattern } of stubs) {
        if (pattern.test(id)) {
          return { code, moduleType: 'js', moduleSideEffects: false }
        }
      }
      return undefined
    },
  }
}

export const buildConfig: RolldownOptions = {
  external: externals,
  input: { index: path.join(rootPath, 'index.ts') },
  output: {
    dir: distPath,
    format: 'cjs',
    entryFileNames: '[name].cjs',
    inlineDynamicImports: true,
    minify: false,
    banner: '"use strict";\n/* Socket MCP — bundled with rolldown */',
  },
  platform: 'node',
  plugins: [
    createLibStubPlugin({ stubPattern: LIB_STUB_PATTERN }),
    createCodeStubPlugin([
      { pattern: MIME_DB_PATTERN, code: MIME_DB_STUB },
      { pattern: OPERATIONS_PATTERN, code: OPERATIONS_STUB },
    ]),
  ],
}

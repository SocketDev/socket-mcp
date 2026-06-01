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

import type { Plugin, RolldownOptions } from 'rolldown'

import {
  DIST_DIR,
  REPO_ROOT,
  SOCKET_GATE_DIR,
} from '../../scripts/repo/paths.mts'
import { createLibStubPlugin } from './rolldown/lib-stub.mts'

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

// Shared bundling primitives. Each artifact is its own single-entry,
// dynamic-import-inlined CJS file (inlineDynamicImports forbids multi-entry
// outputs), so we emit one RolldownOptions per artifact.
const sharedPlugins: Plugin[] = [
  createLibStubPlugin({ stubPattern: LIB_STUB_PATTERN }),
  createCodeStubPlugin([
    { pattern: MIME_DB_PATTERN, code: MIME_DB_STUB },
    { pattern: OPERATIONS_PATTERN, code: OPERATIONS_STUB },
  ]),
]

function singleEntryConfig(
  name: string,
  inputPath: string,
  outDir: string,
  banner: string,
): RolldownOptions {
  return {
    external: externals,
    input: { [name]: inputPath },
    output: {
      dir: outDir,
      format: 'cjs',
      entryFileNames: '[name].cjs',
      inlineDynamicImports: true,
      minify: false,
      sourcemap: false,
      banner,
    },
    platform: 'node',
    plugins: sharedPlugins,
  }
}

// The server bundle (dist/index.cjs) — the published bin.
export const buildConfig: RolldownOptions = singleEntryConfig(
  'index',
  path.join(REPO_ROOT, 'index.ts'),
  DIST_DIR,
  '"use strict";\n/* Socket MCP — bundled with rolldown */',
)

// The optional Claude Code hook. Emitted into hooks/socket-gate/ alongside its
// source + README so the whole directory is a self-contained unit users copy
// recursively into ~/.claude/hooks/. Bundled because a Claude Code hook has no
// package.json/node_modules — its @socketsecurity/lib-stable import must be
// inlined. The shebang lets `node` / direct execution find the interpreter.
export const socketGateConfig: RolldownOptions = singleEntryConfig(
  'socket-gate',
  path.join(SOCKET_GATE_DIR, 'index.mts'),
  SOCKET_GATE_DIR,
  '#!/usr/bin/env node\n"use strict";\n/* Socket gate hook — bundled with rolldown */',
)

// Every artifact build.mts should emit, in order.
export const buildConfigs: RolldownOptions[] = [buildConfig, socketGateConfig]

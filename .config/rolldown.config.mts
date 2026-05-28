/**
 * @file Rolldown config for socket-mcp. Single-file CJS bundle to
 *   `dist/index.cjs` — every runtime dep gets inlined so the published
 *   package has zero runtime dependencies (all deps move to devDeps).
 *   Pattern mirrors socket-packageurl-js: only Node builtins are external.
 */

import { builtinModules } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { RolldownOptions } from 'rolldown'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootPath = path.join(__dirname, '..')
const distPath = path.join(rootPath, 'dist')

// Externalize Node builtins (with + without `node:` prefix). Everything
// else gets inlined into the bundle.
const externals = [
  ...builtinModules,
  ...builtinModules.map(m => `node:${m}`),
]

export const buildConfig: RolldownOptions = {
  input: { index: path.join(rootPath, 'index.ts') },
  platform: 'node',
  external: externals,
  output: {
    dir: distPath,
    format: 'cjs',
    entryFileNames: '[name].cjs',
    inlineDynamicImports: true,
    minify: false,
    banner: '"use strict";\n/* Socket MCP — bundled with rolldown */',
  },
}

#!/usr/bin/env node
/**
 * @file Build socket-mcp's CJS artifacts into `dist/`: the server bin
 *   (`index.cjs`) and the optional Claude Code hook (`socket-gate.cjs`). Each
 *   inlines every runtime dep (every entry from package.json `dependencies` is
 *   now a devDep — the published package has no runtime deps after bundling).
 *   Pattern: socket-packageurl-js + socket-sdk-js.
 */

import { chmod, copyFile } from 'node:fs/promises'
import path from 'node:path'

import { errorMessage } from '@socketsecurity/lib-stable/errors'
import { safeDelete } from '@socketsecurity/lib-stable/fs/safe'
import { getDefaultLogger } from '@socketsecurity/lib-stable/logger/default'
import { rolldown } from 'rolldown'

import { buildConfigs } from '../.config/repo/rolldown.config.mts'
import {
  DIST_DIR,
  SOCKET_GATE_DIST_DIR,
  SOCKET_GATE_SRC_DIR,
} from './repo/paths.mts'

import type { RolldownOptions } from 'rolldown'

const logger = getDefaultLogger()

async function buildOne(config: RolldownOptions): Promise<void> {
  const { output, ...inputOptions } = config
  const bundle = await rolldown(inputOptions)
  try {
    const outputs = Array.isArray(output) ? output : [output!]
    for (const outputOptions of outputs) {
      const { output: written } = await bundle.write(outputOptions)
      const outDir = outputOptions.dir ?? DIST_DIR
      // Make each emitted entry executable so direct invocation works without
      // a `node` prefix (the server bin + the hook both ship a shebang).
      for (const chunk of written) {
        if (chunk.type === 'chunk' && chunk.isEntry) {
          await chmod(path.join(outDir, chunk.fileName), 0o755)
        }
      }
    }
  } finally {
    await bundle.close()
  }
}

async function main(): Promise<void> {
  logger.log('Cleaning build outputs…')
  await safeDelete(DIST_DIR)

  logger.log('Bundling with rolldown…')
  for (const config of buildConfigs) {
    await buildOne(config)
  }

  // The hook README rides beside the bundle so dist/socket-gate/ is a
  // self-documenting, copyable unit.
  await copyFile(
    path.join(SOCKET_GATE_SRC_DIR, 'README.md'),
    path.join(SOCKET_GATE_DIST_DIR, 'README.md'),
  )

  logger.log(`Built ${buildConfigs.length} artifact(s)`)
}

main().catch(err => {
  logger.fail(`build: ${errorMessage(err)}`)
  process.exitCode = 1
})

#!/usr/bin/env node
/**
 * @file Build socket-mcp into a single CJS file at `dist/index.cjs`.
 *   Inlines every runtime dep (every entry from package.json
 *   `dependencies` is now a devDep — the published package has no
 *   runtime deps after bundling). Pattern: socket-packageurl-js +
 *   socket-sdk-js.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { rolldown } from 'rolldown'

import { getDefaultLogger } from '@socketsecurity/lib-stable/logger/default'

import { buildConfig } from '../.config/rolldown.config.mts'

const logger = getDefaultLogger()
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootPath = path.join(__dirname, '..')
const distPath = path.join(rootPath, 'dist')

async function main(): Promise<void> {
  logger.log('Cleaning dist/…')
  await fs.rm(distPath, { recursive: true, force: true })

  logger.log('Bundling with rolldown…')
  const { output, ...inputOptions } = buildConfig
  const bundle = await rolldown(inputOptions)
  try {
    await bundle.write(output!)
  } finally {
    await bundle.close()
  }

  // Make the bin executable so `pnpm exec socket-mcp` / direct invocation
  // works without `node` prefix.
  const binPath = path.join(distPath, 'index.cjs')
  await fs.chmod(binPath, 0o755)

  logger.log(`Built ${binPath}`)
}

main().catch(err => {
  logger.fail(`build: ${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
})

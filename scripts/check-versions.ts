#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { getDefaultLogger } from '@socketsecurity/lib/logger/default'

const logger = getDefaultLogger()

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.join(__dirname, '..')

interface PackageJson {
  version: string
  [key: string]: unknown
}

interface ManifestJson {
  version: string
  [key: string]: unknown
}

function readJsonFile<T>(filePath: string): T {
  try {
    const content = readFileSync(filePath, 'utf8')
    return JSON.parse(content) as T
  } catch (error) {
    logger.fail(`Error reading ${filePath}:`, (error as Error).message)
    process.exit(1)
  }
}

function main(): void {
  logger.log(
    'Checking version consistency between package.json and manifest.json…',
  )

  const packageJsonPath = path.join(projectRoot, 'package.json')
  const manifestJsonPath = path.join(projectRoot, 'manifest.json')

  const packageJson = readJsonFile<PackageJson>(packageJsonPath)
  const manifestJson = readJsonFile<ManifestJson>(manifestJsonPath)

  const packageVersion = packageJson.version
  const manifestVersion = manifestJson.version

  logger.log(`package.json version: ${packageVersion}`)
  logger.log(`manifest.json version: ${manifestVersion}`)

  if (packageVersion === manifestVersion) {
    logger.log('✅ Versions match!')
    process.exit(0)
  } else {
    logger.fail('❌ Version mismatch detected!')
    logger.fail('Expected both files to have the same version, but found:')
    logger.fail(`  package.json: ${packageVersion}`)
    logger.fail(`  manifest.json: ${manifestVersion}`)
    logger.fail('Please update both files to have matching versions.')
    process.exit(1)
  }
}

main()

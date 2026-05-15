#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { getDefaultLogger } from '@socketsecurity/lib-stable/logger'

const logger = getDefaultLogger()

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.join(__dirname, '..')

interface PackageJson {
  version: string
  [key: string]: any
}

interface ManifestJson {
  version: string
  [key: string]: any
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
  console.log(
    'Checking version consistency between package.json and manifest.json...',
  )

  const packageJsonPath = path.join(projectRoot, 'package.json')
  const manifestJsonPath = path.join(projectRoot, 'manifest.json')

  const packageJson = readJsonFile<PackageJson>(packageJsonPath)
  const manifestJson = readJsonFile<ManifestJson>(manifestJsonPath)

  const packageVersion = packageJson.version
  const manifestVersion = manifestJson.version

  console.log(`package.json version: ${packageVersion}`)
  console.log(`manifest.json version: ${manifestVersion}`)

  if (packageVersion === manifestVersion) {
    console.log('✅ Versions match!')
    process.exit(0)
  } else {
    console.error('❌ Version mismatch detected!')
    console.error('Expected both files to have the same version, but found:')
    console.error(`  package.json: ${packageVersion}`)
    console.error(`  manifest.json: ${manifestVersion}`)
    console.error('Please update both files to have matching versions.')
    process.exit(1)
  }
}

main()

#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { errorMessage } from '@socketsecurity/lib-stable/errors/message'
import { getDefaultLogger } from '@socketsecurity/lib-stable/logger/default'

const logger = getDefaultLogger()

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.join(__dirname, '..')

// oxlint-disable-next-line typescript/consistent-return -- the non-returning arm ends in process.exit(1); the analyzer cannot see the never.
function readJsonFile(filePath: string): Record<string, unknown> {
  try {
    const content = readFileSync(filePath, 'utf8')
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- both callers read a JSON object file; non-object JSON would fail their version checks anyway.
    return JSON.parse(content) as Record<string, unknown>
  } catch (error) {
    logger.fail(`Error reading ${filePath}:`, errorMessage(error))
    process.exit(1)
  }
}

function main(): void {
  logger.log(
    'Checking version consistency between package.json and manifest.json…',
  )

  const packageJsonPath = path.join(projectRoot, 'package.json')
  const manifestJsonPath = path.join(projectRoot, 'manifest.json')

  const packageJson = readJsonFile(packageJsonPath)
  const manifestJson = readJsonFile(manifestJsonPath)

  // A missing/non-string version renders as the literal fallback so the
  // mismatch report stays readable instead of stringifying `undefined`.
  const rawPackageVersion = packageJson['version']
  const packageVersion =
    typeof rawPackageVersion === 'string' ? rawPackageVersion : '(missing)'
  const rawManifestVersion = manifestJson['version']
  const manifestVersion =
    typeof rawManifestVersion === 'string' ? rawManifestVersion : '(missing)'

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

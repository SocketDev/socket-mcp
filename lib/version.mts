import { readFileSync } from 'node:fs'
import path from 'node:path'

// Pull the shipped version out of a parsed package.json. A manifest without a
// usable `version` string falls back to a placeholder so the server still
// reports something in its banner and `/health` payload.
export function resolvePackageVersion(
  packageJson: Record<string, unknown>,
): string {
  const version = packageJson['version']
  return typeof version === 'string' && version ? version : '0.0.1'
}

const packageJson: Record<string, unknown> = JSON.parse(
  readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8'),
)

export const VERSION: string = resolvePackageVersion(packageJson)

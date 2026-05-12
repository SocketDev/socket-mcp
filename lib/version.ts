import { readFileSync } from 'node:fs'
import path from 'node:path'

const packageJson = JSON.parse(
  readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8'),
)

export const VERSION: string = packageJson.version || '0.0.1'

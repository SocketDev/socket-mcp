import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { realpathSync } from 'node:fs'

export interface ScriptMeta {
  describe: string
  help: string
  json?: string
}

export function isMainModule(importMetaUrl: string): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return realpathSync(fileURLToPath(importMetaUrl)) === realpathSync(entry)
  } catch {
    return false
  }
}

export function runMain(
  main: () => void | Promise<void>,
  meta: ScriptMeta,
): void {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write(`${meta.help}\n`)
    return
  }
  if (process.argv.includes('--describe')) {
    process.stdout.write(`${meta.describe}\n`)
    return
  }
  Promise.resolve(main()).catch(error => {
    process.stderr.write(`${String(error)}\n`)
    process.exitCode = 1
  })
}

#!/usr/bin/env node

/**
 * @file Validate `plugins/chatgpt/` against the OpenAI plugin submission
 *   requirements and write the upload ZIP. The archive holds `plugin.json`,
 *   `mcp.json`, and `assets/icon.png` at its root, and is written OUTSIDE the
 *   repository (default: the OS temp directory) so a build artifact never
 *   lands in the tracked tree.
 *   The rules live in `requirements.mts`; this file is their IO shell. An
 *   error blocks the ZIP, a warning does not, and `--strict` promotes
 *   warnings to errors for the pre-submission gate.
 */

import { readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { getDefaultLogger } from '@socketsecurity/lib-stable/logger/default'

import {
  chatgptManifestVersion,
  ICON_ENTRY_NAME,
  inspectChatgptPluginPackage,
  MCP_CONFIG_NAME,
  PLUGIN_MANIFEST_NAME,
} from './requirements.mts'
import { createZipArchive } from '../../../fleet/artifact/zip.mts'
import { isMainModule } from '../../../fleet/process/is-main-module.mts'
import { runMain } from '../../../fleet/process/main/run.mts'
import { isJsonRequested } from '../../../fleet/process/script-meta.mts'
import { PLUGIN_CHATGPT_DIR } from '../../paths.mts'
import type { ChatgptPluginFindings } from './requirements.mts'
import type { ScriptMeta } from '../../../fleet/process/main/run.mts'
import type { ScriptResult } from '../../../fleet/process/script-result.mts'

const logger = getDefaultLogger()

export interface ChatgptPackConfig {
  readonly outputDir: string
  readonly strict: boolean
}

export interface ChatgptPackResult {
  readonly bytes: number
  readonly findings: ChatgptPluginFindings
  readonly outputPath: string | undefined
}

/**
 * Read `plugins/chatgpt/`, check it, and write the upload ZIP when nothing
 * blocks. Returns the findings either way so the caller sets the exit code.
 */
export async function packChatgptPlugin(
  config: ChatgptPackConfig,
): Promise<ChatgptPackResult> {
  const { outputDir, strict } = { __proto__: null, ...config }
  const manifestPath = path.join(PLUGIN_CHATGPT_DIR, PLUGIN_MANIFEST_NAME)
  const mcpConfigPath = path.join(PLUGIN_CHATGPT_DIR, MCP_CONFIG_NAME)
  const iconPath = path.join(PLUGIN_CHATGPT_DIR, 'assets', 'icon.png')

  const {
    0: pluginJson,
    1: mcpJson,
    2: iconBytes,
  } = await Promise.all([
    readFile(manifestPath, 'utf8'),
    readFile(mcpConfigPath, 'utf8'),
    readFile(iconPath),
  ])

  const findings = inspectChatgptPluginPackage({
    iconBytes,
    mcpJson,
    pluginJson,
  })
  const blocked =
    findings.errors.length > 0 || (strict && findings.warnings.length > 0)
  if (blocked) {
    return { bytes: 0, findings, outputPath: undefined }
  }

  const archive = createZipArchive([
    { name: PLUGIN_MANIFEST_NAME, data: Buffer.from(pluginJson, 'utf8') },
    { name: MCP_CONFIG_NAME, data: Buffer.from(mcpJson, 'utf8') },
    { name: ICON_ENTRY_NAME, data: iconBytes },
  ])
  const outputPath = path.join(
    outputDir,
    `socket-chatgpt-plugin-${chatgptManifestVersion(pluginJson)}.zip`,
  )
  await writeFile(outputPath, archive)
  return { bytes: archive.length, findings, outputPath }
}

function readOutputDir(argv: readonly string[]): string {
  const index = argv.indexOf('--out')
  const value = index === -1 ? undefined : argv[index + 1]
  return value === undefined ? os.tmpdir() : path.resolve(value)
}

// The payload rides back on ScriptResult.data so the fleet runner renders the
// one JSON document `json: 'result'` promises. Printing it here as well would
// put two documents on stdout and leave no parseable output.
export async function main(): Promise<ScriptResult> {
  const argv = process.argv.slice(2)
  const result = await packChatgptPlugin({
    outputDir: readOutputDir(argv),
    strict: argv.includes('--strict'),
  })
  const { errors, warnings } = result.findings
  const blocked = result.outputPath === undefined
  const data = {
    bytes: result.bytes,
    errors,
    outputPath: result.outputPath,
    warnings,
  }

  if (isJsonRequested(argv)) {
    return { data, exitCode: blocked ? 1 : 0 }
  }

  for (const warning of warnings) {
    logger.warn(warning)
  }
  for (const error of errors) {
    logger.fail(error)
  }
  if (blocked) {
    logger.fail(
      `Wrote no ZIP. Where: ${PLUGIN_CHATGPT_DIR}. Saw ${errors.length} error(s) and ${warnings.length} warning(s); wanted a package that satisfies the OpenAI submission requirements. Fix: resolve the findings above.`,
    )
    return { data, exitCode: 1 }
  }
  logger.success(`Wrote ${result.outputPath} (${result.bytes} bytes).`)
  return { data, exitCode: 0 }
}

const SCRIPT_META: ScriptMeta = {
  describe:
    'validates plugins/chatgpt against the OpenAI submission requirements and writes the upload ZIP',
  help:
    'Usage: pnpm run plugin:chatgpt:pack [--out <dir>] [--strict] [--json]\n\n' +
    '  --out <dir>  Directory for the ZIP. Defaults to the OS temp directory,\n' +
    '               keeping the artifact outside the repository.\n' +
    '  --strict     Treat submission warnings as errors. Use before submitting.\n' +
    '  --json       Print the findings and output path as JSON.',
  json: 'result',
}
if (isMainModule(import.meta.url)) {
  runMain(main, SCRIPT_META)
}

/**
 * @file The OpenAI plugin submission requirements for `plugins/chatgpt/`,
 *   encoded as pure checks over the package's in-memory contents. No
 *   filesystem or process access lives here - `pack.mts` owns the IO - so the
 *   rules stay unit-testable on their own.
 *   Findings split in two. An ERROR means the package is structurally wrong
 *   and no ZIP should be written. A WARNING means the package packs but is
 *   not submittable yet: `demo_recording_url` is the case that matters,
 *   because recording the demo requires first installing the ZIP in developer
 *   mode.
 */

import { errorMessage } from '@socketsecurity/lib-stable/errors/message'

export const PLUGIN_MANIFEST_NAME = 'plugin.json'
export const MCP_CONFIG_NAME = 'mcp.json'
export const ICON_ENTRY_NAME = 'assets/icon.png'

const OPENAI_NAMESPACE = 'com.openai'

const PLUGIN_SCHEMA_ID =
  'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json'
const MCP_SCHEMA_ID = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json'

const PLUGIN_NAME_MAX = 64
const DISPLAY_NAME_MAX = 30
const SHORT_DESCRIPTION_MAX = 30
const LONG_DESCRIPTION_MAX = 4000
const DEVELOPER_NAME_MAX = 80
const CAPABILITIES_MAX = 20
const CAPABILITY_LENGTH_MAX = 120
const URL_LENGTH_MAX = 1024
const POSITIVE_CASE_COUNT = 5
const NEGATIVE_CASE_COUNT = 3

const ICON_MIN_PIXELS = 48
const ICON_MAX_PIXELS = 4096
const ICON_MAX_BYTES = 5 * 1024 * 1024
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
])

const REQUIRED_URL_FIELDS = [
  'websiteURL',
  'supportURL',
  'privacyPolicyURL',
  'termsOfServiceURL',
] as const

const POSITIVE_CASE_FIELDS = [
  'description',
  'prompt',
  'tools_triggered',
  'expected_behavior',
] as const

const NEGATIVE_CASE_FIELDS = ['description', 'prompt'] as const

export interface ChatgptPluginSources {
  readonly iconBytes: Buffer
  readonly mcpJson: string
  readonly pluginJson: string
}

export interface ChatgptPluginFindings {
  readonly errors: string[]
  readonly warnings: string[]
}

function objectField(
  source: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = source[key]
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

// An empty string reads as absent, the same way envString treats an empty
// environment variable. The portal rejects a blank display name or review
// field exactly as it rejects a missing one, so a presence check that accepts
// '' would let --strict pass a package OpenAI still refuses.
function stringField(
  source: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = source[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function checkBoundedString(
  source: Record<string, unknown>,
  key: string,
  limit: number,
  where: string,
  errors: string[],
): void {
  const value = stringField(source, key)
  if (value === undefined || value.length === 0) {
    errors.push(`${where}.${key} is missing. Fix: add it to ${where}.`)
    return
  }
  if (value.length > limit) {
    errors.push(
      `${where}.${key} is ${value.length} characters; the limit is ${limit}. Fix: shorten it.`,
    )
  }
}

function checkReviewCases(
  cases: unknown,
  kind: 'positive' | 'negative',
  expectedCount: number,
  requiredFields: readonly string[],
  errors: string[],
): void {
  const where = `review.test_cases.${kind}`
  if (!Array.isArray(cases)) {
    errors.push(`${where} is missing. Fix: add ${expectedCount} ${kind} cases.`)
    return
  }
  if (cases.length !== expectedCount) {
    errors.push(
      `${where} holds ${cases.length} cases; OpenAI requires exactly ${expectedCount}. Fix: add or remove cases.`,
    )
  }
  for (const [index, entry] of cases.entries()) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      errors.push(`${where}[${index}] is not an object.`)
      continue
    }
    const record = entry as Record<string, unknown>
    for (const field of requiredFields) {
      if (stringField(record, field) === undefined) {
        errors.push(`${where}[${index}].${field} is missing.`)
      }
    }
  }
}

function checkInterface(
  openai: Record<string, unknown>,
  findings: ChatgptPluginFindings,
): void {
  const { errors } = findings
  const interfaceBlock = objectField(openai, 'interface')
  if (!interfaceBlock) {
    errors.push(
      `extensions.${OPENAI_NAMESPACE}.interface is missing. Fix: add the listing metadata block.`,
    )
    return
  }
  const where = 'interface'
  checkBoundedString(
    interfaceBlock,
    'displayName',
    DISPLAY_NAME_MAX,
    where,
    errors,
  )
  checkBoundedString(
    interfaceBlock,
    'shortDescription',
    SHORT_DESCRIPTION_MAX,
    where,
    errors,
  )
  checkBoundedString(
    interfaceBlock,
    'longDescription',
    LONG_DESCRIPTION_MAX,
    where,
    errors,
  )
  checkBoundedString(
    interfaceBlock,
    'developerName',
    DEVELOPER_NAME_MAX,
    where,
    errors,
  )
  for (const key of ['category', 'logo', 'composerIcon']) {
    if (stringField(interfaceBlock, key) === undefined) {
      errors.push(`${where}.${key} is missing.`)
    }
  }
  for (const key of REQUIRED_URL_FIELDS) {
    const value = stringField(interfaceBlock, key)
    if (value === undefined) {
      errors.push(`${where}.${key} is missing.`)
      continue
    }
    if (!value.startsWith('https://')) {
      errors.push(`${where}.${key} is not HTTPS. Saw ${value}.`)
    }
    if (value.length > URL_LENGTH_MAX) {
      errors.push(
        `${where}.${key} is ${value.length} characters; the limit is ${URL_LENGTH_MAX}.`,
      )
    }
  }
  const capabilities = interfaceBlock['capabilities']
  if (!Array.isArray(capabilities) || capabilities.length === 0) {
    errors.push(`${where}.capabilities is missing.`)
    return
  }
  if (capabilities.length > CAPABILITIES_MAX) {
    errors.push(
      `${where}.capabilities holds ${capabilities.length} items; the limit is ${CAPABILITIES_MAX}.`,
    )
  }
  for (const [index, capability] of capabilities.entries()) {
    if (
      typeof capability !== 'string' ||
      capability.length === 0 ||
      capability.length > CAPABILITY_LENGTH_MAX
    ) {
      errors.push(
        `${where}.capabilities[${index}] must be a non-empty string of at most ${CAPABILITY_LENGTH_MAX} characters.`,
      )
    }
  }
}

function checkReview(
  openai: Record<string, unknown>,
  findings: ChatgptPluginFindings,
): void {
  const { errors, warnings } = findings
  const review = objectField(openai, 'review')
  if (!review) {
    errors.push(
      `extensions.${OPENAI_NAMESPACE}.review is missing. Fix: add the review block with its test cases.`,
    )
    return
  }
  const testCases = objectField(review, 'test_cases')
  if (!testCases) {
    errors.push('review.test_cases is missing.')
  } else {
    checkReviewCases(
      testCases['positive'],
      'positive',
      POSITIVE_CASE_COUNT,
      POSITIVE_CASE_FIELDS,
      errors,
    )
    checkReviewCases(
      testCases['negative'],
      'negative',
      NEGATIVE_CASE_COUNT,
      NEGATIVE_CASE_FIELDS,
      errors,
    )
  }
  if (stringField(review, 'demo_recording_url') === undefined) {
    warnings.push(
      'review.demo_recording_url is missing. OpenAI requires a reviewer-accessible walkthrough video before submission. Fix: record the demo after installing this ZIP in developer mode, then add the URL.',
    )
  }
}

/**
 * Check the plugin manifest: the Agent Plugins root fields plus the
 * `com.openai` listing and review blocks OpenAI's submission review reads.
 */
export function checkChatgptManifest(
  manifest: Record<string, unknown>,
  findings: ChatgptPluginFindings,
): void {
  const { errors } = findings
  if (stringField(manifest, '$schema') !== PLUGIN_SCHEMA_ID) {
    errors.push(
      `${PLUGIN_MANIFEST_NAME} $schema must be ${PLUGIN_SCHEMA_ID}. Saw ${String(manifest['$schema'])}.`,
    )
  }
  checkBoundedString(manifest, 'name', PLUGIN_NAME_MAX, 'root', errors)
  for (const key of ['version', 'description']) {
    if (stringField(manifest, key) === undefined) {
      errors.push(`root.${key} is missing.`)
    }
  }
  if (!objectField(manifest, 'author')) {
    errors.push('root.author is missing.')
  }
  const extensions = objectField(manifest, 'extensions')
  const openai = extensions
    ? objectField(extensions, OPENAI_NAMESPACE)
    : undefined
  if (!openai) {
    errors.push(
      `extensions.${OPENAI_NAMESPACE} is missing. Fix: add the OpenAI extension block.`,
    )
    return
  }
  checkInterface(openai, findings)
  checkReview(openai, findings)
}

/**
 * Check the MCP configuration: one streamable-HTTP server over HTTPS, and no
 * `headers` block, which is where a credential would leak into the upload.
 */
export function checkChatgptMcpConfig(
  config: Record<string, unknown>,
  findings: ChatgptPluginFindings,
): void {
  const { errors } = findings
  if (stringField(config, '$schema') !== MCP_SCHEMA_ID) {
    errors.push(
      `${MCP_CONFIG_NAME} $schema must be ${MCP_SCHEMA_ID}. Saw ${String(config['$schema'])}.`,
    )
  }
  const servers = objectField(config, 'mcpServers')
  if (!servers) {
    errors.push(`${MCP_CONFIG_NAME} mcpServers is missing.`)
    return
  }
  const names = Object.keys(servers)
  if (names.length === 0) {
    errors.push(`${MCP_CONFIG_NAME} declares no server.`)
    return
  }
  for (let index = 0, { length } = names; index < length; index += 1) {
    const name = names[index]!
    const server = objectField(servers, name)
    if (!server) {
      errors.push(`mcpServers.${name} is not an object.`)
      continue
    }
    const type = stringField(server, 'type')
    if (type !== 'sse' && type !== 'streamable-http') {
      errors.push(
        `mcpServers.${name}.type must be streamable-http or sse. Saw ${String(type)}.`,
      )
    }
    const url = stringField(server, 'url')
    if (url === undefined || !url.startsWith('https://')) {
      errors.push(
        `mcpServers.${name}.url must be an HTTPS URL. Saw ${String(url)}.`,
      )
    }
    if (server['headers'] !== undefined) {
      errors.push(
        `mcpServers.${name}.headers is set. The upload must carry no credentials. Fix: remove the headers block.`,
      )
    }
  }
}

/**
 * Check the listing icon: a square PNG between 48 and 4096 pixels, under the
 * 5 MiB asset ceiling.
 */
export function checkChatgptIcon(
  iconBytes: Buffer,
  findings: ChatgptPluginFindings,
): void {
  const { errors } = findings
  if (iconBytes.length > ICON_MAX_BYTES) {
    errors.push(
      `${ICON_ENTRY_NAME} is ${iconBytes.length} bytes; the limit is ${ICON_MAX_BYTES}.`,
    )
  }
  if (
    iconBytes.length < 24 ||
    !iconBytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  ) {
    errors.push(`${ICON_ENTRY_NAME} is not a PNG file.`)
    return
  }
  const width = iconBytes.readUInt32BE(16)
  const height = iconBytes.readUInt32BE(20)
  if (width !== height) {
    errors.push(
      `${ICON_ENTRY_NAME} is ${width}x${height}; the icon must be square.`,
    )
  }
  const smallest = Math.min(width, height)
  const largest = Math.max(width, height)
  if (smallest < ICON_MIN_PIXELS) {
    errors.push(
      `${ICON_ENTRY_NAME} is ${width}x${height}; the minimum is ${ICON_MIN_PIXELS}x${ICON_MIN_PIXELS}.`,
    )
  }
  if (largest > ICON_MAX_PIXELS) {
    errors.push(
      `${ICON_ENTRY_NAME} is ${width}x${height}; the maximum is ${ICON_MAX_PIXELS} pixels.`,
    )
  }
}

/**
 * The manifest's declared version, used to name the upload ZIP. Falls back to
 * `0.0.0` only for a manifest that already failed its version check.
 */
export function chatgptManifestVersion(pluginJson: string): string {
  try {
    const manifest = JSON.parse(pluginJson) as Record<string, unknown>
    return stringField(manifest, 'version') ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/**
 * Inspect a ChatGPT plugin package held in memory. Pure - every filesystem
 * read happens in the pack entrypoint, so the rules stay testable without a
 * fixture directory.
 */
export function inspectChatgptPluginPackage(
  sources: ChatgptPluginSources,
): ChatgptPluginFindings {
  const findings: ChatgptPluginFindings = { errors: [], warnings: [] }
  let manifest: Record<string, unknown> | undefined
  let config: Record<string, unknown> | undefined
  try {
    manifest = JSON.parse(sources.pluginJson) as Record<string, unknown>
  } catch (error) {
    findings.errors.push(
      `${PLUGIN_MANIFEST_NAME} is not valid JSON: ${errorMessage(error)}`,
    )
  }
  try {
    config = JSON.parse(sources.mcpJson) as Record<string, unknown>
  } catch (error) {
    findings.errors.push(
      `${MCP_CONFIG_NAME} is not valid JSON: ${errorMessage(error)}`,
    )
  }
  if (manifest) {
    checkChatgptManifest(manifest, findings)
  }
  if (config) {
    checkChatgptMcpConfig(config, findings)
  }
  checkChatgptIcon(sources.iconBytes, findings)
  return findings
}

import { Type } from '@sinclair/typebox'

import { joinAnd } from '@socketsecurity/lib-stable/arrays/join'
import { getSocketDebug } from '@socketsecurity/lib/env/socket'
import { envAsBoolean } from '@socketsecurity/lib-stable/env/boolean'
import { isObject } from '@socketsecurity/lib-stable/objects/predicates'
import { httpRequest } from '@socketsecurity/lib/http-request/request'

import { deduplicateArtifacts } from './artifacts.mts'
import { getSocketApiUrl } from './env.mts'
import { buildSocketHeaders } from './http.mts'
import { logger } from './logger.mts'
import { buildPurl } from './purl.mts'
import { markToolOutcome } from './tool-outcome.mts'
import { AUTH_REQUIRED_MSG, errorResult, resolveAuthToken } from './server.mts'
import type { ToolErrorResult, ToolOkResult } from './server.mts'
import { buildSocketReportUrl } from './socket-url.mts'
import { defineToolSchema } from './tool-validation.mts'
import type { ValidatedToolSpec } from './tool-types.mts'

export interface DepscorePackageInput {
  ecosystem?: string | undefined
  depname: string
  version?: string | undefined
}

export interface DepscoreAlertTypeMetadata {
  description: string
  propLabels: ReadonlyMap<string, string>
  title: string
}

export interface DepscoreRequestOptions {
  accessTokenFromAuth?: string | undefined
  platform?: string | undefined
  userAgent?: string | undefined
}

// Default Socket API URL. SOCKET_DEBUG=true points at localhost for local
// stack development; the default targets production. Both env vars resolved
// via shared helpers. Alert summaries list returned types and severities
// without including the full alert payload in the tool response.
const DEFAULT_SOCKET_API_URL = envAsBoolean(getSocketDebug())
  ? 'http://localhost:8866/v0/purl?alerts=true&compact=false&fixable=false&licenseattrib=false&licensedetails=false'
  : 'https://api.socket.dev/v0/purl?alerts=true&compact=false&fixable=false&licenseattrib=false&licensedetails=false'

const SOCKET_API_URL = getSocketApiUrl() || DEFAULT_SOCKET_API_URL
const SOCKET_ALERT_TYPES_URL = new URL(
  '/v0/alert-types',
  SOCKET_API_URL,
).toString()
const MAX_ALERTS = 10
const MAX_ALERT_REASON_CHARS = 240
const MAX_ALERT_PROP_DETAILS = 2
const MAX_ALERT_PROP_VALUE_CHARS = 120
const ALERT_TYPE_METADATA_CACHE_TTL_MS = 60 * 60 * 1000
const ALERT_SEVERITY_RANK = new Map<string, number>([
  ['critical', 0],
  ['high', 1],
  ['middle', 2],
  ['low', 3],
])
const ALERT_TYPE_METADATA_CACHE = new Map<
  string,
  { metadata: DepscoreAlertTypeMetadata; expiresAt: number }
>()

// Single shared JSON Schema (via TypeBox) reused by both stdio and HTTP
// modes. TypeBox `Type.Object` returns native JSON Schema — the SDK ships
// it verbatim to clients as `Tool.inputSchema`.
const depscoreSchema = defineToolSchema(
  Type.Object(
    {
      packages: Type.Array(
        Type.Object(
          {
            ecosystem: Type.Optional(
              Type.String({
                description:
                  'Package ecosystem (PURL type): npm (JS/TS), pypi (Python), golang (Go), maven (Java/Scala/Kotlin), gem (Ruby), nuget (.NET), cargo (Rust), composer (PHP; "packagist" also accepted). See https://docs.socket.dev/docs/language-support',
                default: 'npm',
              }),
            ),
            depname: Type.String({ description: 'The name of the dependency' }),
            version: Type.Optional(
              Type.String({
                description:
                  "The version of the dependency, use 'unknown' if not known",
                default: 'unknown',
              }),
            ),
          },
          { additionalProperties: false },
        ),
        { description: 'Array of packages to check' },
      ),
      platform: Type.Optional(
        Type.String({
          description:
            "Optional OS-architecture hint (e.g., 'linux-x64', 'darwin-arm64', 'win32-x64'). Used to select the most relevant artifact when a package has platform-specific builds.",
        }),
      ),
    },
    { additionalProperties: false },
  ),
)

// Convert the depscore input list into PURLs ready for the components payload,
// stripping semver range prefixes from versions.
export function buildPackageComponents(
  packages: DepscorePackageInput[],
): Array<{ purl: string }> {
  return packages.map(pkg => {
    // Strip ^ and ~ range prefixes — depscore is a single-version lookup.
    const cleanedVersion = (pkg.version ?? 'unknown').replace(/[\^~]/g, '')
    const ecosystem = pkg.ecosystem ?? 'npm'
    const purl = buildPurl(ecosystem, pkg.depname, cleanedVersion)
    if (
      cleanedVersion !== '1.0.0' &&
      cleanedVersion !== 'unknown' &&
      cleanedVersion
    ) {
      logger.info({ tool: 'depscore' }, 'using explicit package version')
    }
    return { __proto__: null, purl }
  })
}

export function defineDepscoreTool(): ValidatedToolSpec {
  return {
    name: 'depscore',
    title: 'Dependency Score Tool',
    description:
      "Look up Socket scores when evaluating or adding dependencies. Returns available 0-100 supply chain, quality, maintenance, vulnerability, and license scores, plus report links and human-readable alert reasons. Lower scores mean higher risk. Use exact versions; ^ and ~ are stripped. Use 'unknown' to let Socket resolve a version, which may differ from the installed one. Missing scores are not a safety verdict.",
    ...depscoreSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
    handler(args, extra) {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- MCP SDK hands tool args over as an untyped record; the tool's inputSchema constrains the shape and the handler validates fields at runtime.
      const packages = args['packages'] as DepscorePackageInput[]
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- MCP SDK hands tool args over as an untyped record; the tool's inputSchema constrains the shape and the handler validates fields at runtime.
      const platform = args['platform'] as string | undefined
      return handleDepscoreRequest(packages, {
        platform,
        accessTokenFromAuth: extra.authInfo?.token,
        userAgent: extra.userAgent,
      })
    },
  }
}

// Render `Object.entries(score)` into a human-readable "k1: v1, k2: v2"
// summary. Sub-1 floats render as percentages (0–100); values >1 render raw so
// non-percentage metrics aren't distorted.
export function formatScoreEntries(score: Record<string, unknown>): string {
  return Object.entries(score)
    .filter(([key]) => key !== 'overall' && key !== 'uuid')
    .map(([key, value]) => {
      const numValue = Number(value)
      if (!Number.isFinite(numValue)) {
        // A non-numeric score field would render the literal "NaN";
        // pass the raw value through instead (JSON-encoded when non-string
        // so objects can't collapse to "[object Object]").
        return `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`
      }
      const displayValue = numValue <= 1 ? Math.round(numValue * 100) : numValue
      return `${key}: ${displayValue}`
    })
    .join(', ')
}

// Keep alert output bounded; the full payload can include file and props data.
export function formatAlerts(
  alerts: unknown,
  alertMetadata?: ReadonlyMap<string, DepscoreAlertTypeMetadata>,
): string {
  if (!Array.isArray(alerts)) {
    return ''
  }

  const summariesByType = new Map<
    string,
    { label: string; severityRank: number }
  >()
  for (let i = 0, { length } = alerts; i < length; i += 1) {
    const alert: unknown = alerts[i]
    if (!isObject(alert)) {
      continue
    }
    const type: unknown = Reflect.get(alert, 'type')
    const severity: unknown = Reflect.get(alert, 'severity')
    if (typeof type !== 'string') {
      continue
    }
    const cleanType = type
      .replace(/[\r\n\t]+/g, ' ')
      .trim()
      .slice(0, 100)
    if (!cleanType) {
      continue
    }

    const typeMetadata = alertMetadata?.get(cleanType)
    const reason = (
      typeMetadata?.description ||
      'Reason unavailable for ' + (typeMetadata?.title || cleanType)
    )
      .replace(/[\r\n\t]+/g, ' ')
      .trim()
      .slice(0, MAX_ALERT_REASON_CHARS)
    const details: string[] = []
    const props: unknown = Reflect.get(alert, 'props')
    if (isObject(props)) {
      const propNames = Object.keys(props)
      for (let i = 0, { length } = propNames; i < length; i += 1) {
        const propName = propNames[i]!
        if (propName.toLowerCase() === 'id') {
          continue
        }
        const propValue: unknown = Reflect.get(props, propName)
        if (
          typeof propValue !== 'string' &&
          typeof propValue !== 'number' &&
          typeof propValue !== 'boolean'
        ) {
          continue
        }
        const cleanValue = String(propValue)
          .replace(/[\r\n\t]+/g, ' ')
          .trim()
          .slice(0, MAX_ALERT_PROP_VALUE_CHARS)
        if (!cleanValue) {
          continue
        }
        const propLabel =
          typeMetadata?.propLabels.get(propName) ||
          propName.replace(/[A-Z]/g, letter => ' ' + letter.toLowerCase())
        details.push(propLabel + ': ' + cleanValue)
        if (details.length >= MAX_ALERT_PROP_DETAILS) {
          break
        }
      }
    }

    const reasonWithDetails = details.length
      ? reason + ' Details: ' + joinAnd(details)
      : reason
    const cleanSeverity =
      typeof severity === 'string'
        ? severity
            .replace(/[\r\n\t]+/g, ' ')
            .trim()
            .slice(0, 40)
        : ''
    const severityRank =
      ALERT_SEVERITY_RANK.get(cleanSeverity.toLowerCase()) ??
      Number.MAX_SAFE_INTEGER
    const previous = summariesByType.get(cleanType)
    if (!previous || severityRank < previous.severityRank) {
      summariesByType.set(cleanType, {
        label: cleanSeverity
          ? reasonWithDetails + ' (' + cleanSeverity + ')'
          : reasonWithDetails,
        severityRank,
      })
    }
  }

  const parts = [...summariesByType.values()]
    .sort((left, right) => left.severityRank - right.severityRank)
    .map(summary => summary.label)
  const shown = parts.slice(0, MAX_ALERTS)
  if (shown.length === 0) {
    return ''
  }
  const overflow = parts.length - shown.length
  return joinAnd(overflow > 0 ? shown.concat(overflow + ' more') : shown)
}

// Compose a "pkg:.../...@..." string + per-key score summary used by the
// depscore output. `score.overall` being defined gates whether we have real
// scores to render. The alert summary can help explain score deductions.
export function formatScoreLine(
  jsonData: Record<string, unknown>,
  alertMetadata?: ReadonlyMap<string, DepscoreAlertTypeMetadata>,
): string {
  // The API returns these purl parts as strings; anything else falls back so
  // the template can't stringify an object into "[object Object]".
  const nsRaw = jsonData['namespace']
  const ns = typeof nsRaw === 'string' && nsRaw ? `${nsRaw}/` : ''
  const typeRaw = jsonData['type']
  const type = typeof typeRaw === 'string' && typeRaw ? typeRaw : 'unknown'
  const nameRaw = jsonData['name']
  const name = typeof nameRaw === 'string' && nameRaw ? nameRaw : 'unknown'
  const versionRaw = jsonData['version']
  const version =
    typeof versionRaw === 'string' && versionRaw ? versionRaw : 'unknown'
  const purl = `pkg:${type}/${ns}${name}@${version}`
  const alertsSummary = formatAlerts(jsonData['alerts'], alertMetadata)
  const alertsLine = alertsSummary ? `\n  Reasons: ${alertsSummary}` : ''
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- JSON.parse returns any; the asserted record type is the loosest object view and every field read is type-guarded at use.
  const score = jsonData['score'] as Record<string, unknown> | undefined
  if (score && score['overall'] !== undefined) {
    const reportUrl = buildSocketReportUrl(jsonData)
    return `${purl}: ${formatScoreEntries(score)}\n  Report: ${reportUrl}${alertsLine}`
  }
  return `${purl}: No score found${alertsLine}`
}

export async function handleDepscore(
  packages: DepscorePackageInput[],
  platform: string | undefined,
  accessTokenFromAuth: string | undefined,
): Promise<ToolOkResult | ToolErrorResult> {
  return handleDepscoreRequest(packages, { platform, accessTokenFromAuth })
}

export async function handleDepscoreRequest(
  packages: DepscorePackageInput[],
  config: DepscoreRequestOptions,
): Promise<ToolOkResult | ToolErrorResult> {
  config = { __proto__: null, ...config } as DepscoreRequestOptions
  const { accessTokenFromAuth, platform, userAgent } = config
  logger.info(
    { tool: 'depscore', packageCount: Math.min(packages.length, 10_000) },
    'request received',
  )
  const accessToken = resolveAuthToken(accessTokenFromAuth)
  if (!accessToken) {
    logger.error({ tool: 'depscore' }, 'authentication required')
    return markToolOutcome(errorResult(AUTH_REQUIRED_MSG), 'denied')
  }

  const components = buildPackageComponents(packages)

  let response
  try {
    response = await httpRequest(SOCKET_API_URL, {
      method: 'POST',
      headers: buildSocketHeaders(accessToken, userAgent),
      body: JSON.stringify({ components }),
    })
  } catch {
    logger.error({ tool: 'depscore' }, 'upstream request failed')
    return errorResult('Error connecting to Socket API')
  }

  const responseText = response.text()

  if (response.status === 401) {
    const errorMsg = `Socket authentication failed [401]. Re-authenticate and retry. ${responseText}`
    logger.error({ tool: 'depscore', status: 401 }, 'upstream request denied')
    return markToolOutcome(errorResult(errorMsg), 'denied')
  }

  if (response.status === 403) {
    const errorMsg = `Socket denied access [403]. Re-authenticate with the correct organization or repository permissions and retry. ${responseText}`
    logger.error({ tool: 'depscore', status: 403 }, 'upstream request denied')
    return markToolOutcome(errorResult(errorMsg), 'denied')
  }

  if (response.status !== 200) {
    const errorMsg = `Error processing packages: [${response.status}] ${responseText}`
    logger.error(
      { tool: 'depscore', status: response.status },
      'upstream request failed',
    )
    return errorResult(errorMsg)
  }

  if (!responseText.trim()) {
    const errorMsg = 'No packages were found.'
    logger.error({ tool: 'depscore' }, 'empty upstream response')
    return errorResult(errorMsg)
  }

  try {
    const contentTypeValue = response.headers['content-type'] || ''
    const isNdjson = contentTypeValue.includes('x-ndjson')
    const alertTypes = collectDepscoreAlertTypes(responseText, isNdjson)
    const alertMetadata = await fetchDepscoreAlertTypeMetadata(
      alertTypes,
      accessToken,
      userAgent,
    )

    const parseResult = isNdjson
      ? parseNdjsonPackageBody(responseText, platform, alertMetadata)
      : parseSinglePackageBody(responseText, alertMetadata)

    if (!Array.isArray(parseResult)) {
      return errorResult(parseResult.error)
    }

    // Both parsers yield at least one line for a body that reached here:
    // the NDJSON parser returns an error object when no document parsed, and
    // the single-document parser always formats exactly one line.
    return {
      content: [
        {
          type: 'text',
          text: `Dependency scores:\n${parseResult.join('\n')}`,
        },
      ],
    }
  } catch {
    logger.error({ tool: 'depscore' }, 'response parse failed')
    return errorResult('Error parsing response from Socket API')
  }
}

// Parse an NDJSON response body — one JSON document per line — into result
// lines, dropping `_type`-tagged control frames and running the platform-aware
// artifact deduplication before formatting.
export function parseNdjsonPackageBody(
  responseText: string,
  platform: string | undefined,
  alertMetadata?: ReadonlyMap<string, DepscoreAlertTypeMetadata>,
): string[] | { error: string } {
  // Parse line-by-line so one malformed line doesn't discard the whole
  // batch — NDJSON is line-oriented, and a truncated/garbage line is skipped
  // (logged) rather than thrown.
  const jsonLines: Array<Record<string, unknown>> = []
  const lines = responseText.split(/\r?\n/)
  for (let i = 0, { length } = lines; i < length; i += 1) {
    const line = lines[i]!.trim()
    if (!line) {
      continue
    }
    let obj: Record<string, unknown>
    try {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- JSON.parse returns any; the asserted record type is the loosest object view and every field read is type-guarded at use.
      obj = JSON.parse(line) as Record<string, unknown>
    } catch {
      logger.error({ tool: 'depscore' }, 'skipping malformed NDJSON line')
      continue
    }
    if (!obj['_type']) {
      jsonLines.push(obj)
    }
  }

  if (!jsonLines.length) {
    return { error: 'No valid JSON objects found in NDJSON response' }
  }

  const deduplicated = deduplicateArtifacts(jsonLines, platform)
  const results: string[] = []
  for (let i = 0, { length } = deduplicated; i < length; i += 1) {
    results.push(formatScoreLine(deduplicated[i]!, alertMetadata))
  }
  return results
}

// Parse a non-NDJSON response (single JSON document) into one result line.
export function parseSinglePackageBody(
  responseText: string,
  alertMetadata?: ReadonlyMap<string, DepscoreAlertTypeMetadata>,
): string[] {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- JSON.parse returns any; the asserted record type is the loosest object view and every field read is type-guarded at use.
  const jsonData = JSON.parse(responseText) as Record<string, unknown>
  return [formatScoreLine(jsonData, alertMetadata)]
}

export function collectDepscoreAlertTypes(
  responseText: string,
  isNdjson: boolean,
): string[] {
  const types = new Set<string>()
  const documents = isNdjson ? responseText.split(/\r?\n/) : [responseText]
  for (let i = 0, { length } = documents; i < length; i += 1) {
    const document = documents[i]!.trim()
    if (!document) {
      continue
    }
    let artifact: unknown
    try {
      artifact = JSON.parse(document)
    } catch {
      continue
    }
    if (!isObject(artifact) || Reflect.get(artifact, '_type')) {
      continue
    }
    const alerts: unknown = Reflect.get(artifact, 'alerts')
    if (!Array.isArray(alerts)) {
      continue
    }
    for (let j = 0, { length: alertCount } = alerts; j < alertCount; j += 1) {
      const alert: unknown = alerts[j]
      if (!isObject(alert)) {
        continue
      }
      const type: unknown = Reflect.get(alert, 'type')
      if (typeof type === 'string' && type) {
        types.add(type)
      }
    }
  }
  return [...types]
}

export async function fetchDepscoreAlertTypeMetadata(
  alertTypes: string[],
  accessToken: string,
  userAgent: string | undefined,
): Promise<Map<string, DepscoreAlertTypeMetadata>> {
  const metadata = new Map<string, DepscoreAlertTypeMetadata>()
  if (!alertTypes.length) {
    return metadata
  }

  const uncachedTypes: string[] = []
  const now = Date.now()
  for (let i = 0, { length } = alertTypes; i < length; i += 1) {
    const type = alertTypes[i]!
    const cached = ALERT_TYPE_METADATA_CACHE.get(type)
    if (cached && cached.expiresAt > now) {
      metadata.set(type, cached.metadata)
    } else {
      ALERT_TYPE_METADATA_CACHE.delete(type)
      uncachedTypes.push(type)
    }
  }
  if (!uncachedTypes.length) {
    return metadata
  }

  try {
    const response = await httpRequest(SOCKET_ALERT_TYPES_URL, {
      method: 'POST',
      headers: buildSocketHeaders(accessToken, userAgent),
      body: JSON.stringify(uncachedTypes),
    })
    if (response.status !== 200) {
      logger.warn(
        { tool: 'depscore', status: response.status },
        'alert reasons unavailable',
      )
      return metadata
    }

    const parsed: unknown = JSON.parse(response.text())
    if (!Array.isArray(parsed)) {
      return metadata
    }
    for (let i = 0, { length } = parsed; i < length; i += 1) {
      const item: unknown = parsed[i]
      if (!isObject(item)) {
        continue
      }
      const type: unknown = Reflect.get(item, 'type')
      if (typeof type !== 'string') {
        continue
      }
      const description: unknown = Reflect.get(item, 'description')
      const title: unknown = Reflect.get(item, 'title')
      const rawPropLabels: unknown = Reflect.get(item, 'props')
      const propLabels = new Map<string, string>()
      if (isObject(rawPropLabels)) {
        const propNames = Object.keys(rawPropLabels)
        for (
          let j = 0, { length: propCount } = propNames;
          j < propCount;
          j += 1
        ) {
          const propName = propNames[j]!
          const label: unknown = Reflect.get(rawPropLabels, propName)
          if (typeof label === 'string' && label) {
            propLabels.set(propName, label)
          }
        }
      }
      const alertTypeMetadata = {
        description: typeof description === 'string' ? description : '',
        propLabels,
        title: typeof title === 'string' ? title : '',
      }
      metadata.set(type, alertTypeMetadata)
      ALERT_TYPE_METADATA_CACHE.set(type, {
        metadata: alertTypeMetadata,
        expiresAt: now + ALERT_TYPE_METADATA_CACHE_TTL_MS,
      })
    }
  } catch {
    logger.warn({ tool: 'depscore' }, 'alert reasons unavailable')
  }
  return metadata
}

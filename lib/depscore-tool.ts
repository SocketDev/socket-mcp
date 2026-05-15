import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  getSocketApiToken,
  getSocketApiUrl,
  getSocketDebug,
} from '@socketsecurity/lib-stable/env/socket'
import { httpRequest } from '@socketsecurity/lib-stable/http-request'
import { z } from 'zod'
import { deduplicateArtifacts } from './artifacts.ts'
import { buildSocketHeaders } from './http-helpers.ts'
import { logger } from './logger.ts'
import { buildPurl } from './purl.ts'
import { VERSION } from './version.ts'

interface DepscorePackageInput {
  ecosystem?: string | undefined
  depname: string
  version?: string | undefined
}

interface ToolErrorResult {
  [key: string]: unknown
  content: Array<{ type: 'text'; text: string }>
  isError: true
}

interface ToolOkResult {
  [key: string]: unknown
  content: Array<{ type: 'text'; text: string }>
}

// Default Socket API URL. SOCKET_DEBUG=true points at localhost for local
// stack development; the default targets production. Both env vars
// resolved via fleet-canonical helpers.
const DEFAULT_SOCKET_API_URL =
  getSocketDebug() === 'true'
    ? 'http://localhost:8866/v0/purl?alerts=false&compact=false&fixable=false&licenseattrib=false&licensedetails=false'
    : 'https://api.socket.dev/v0/purl?alerts=false&compact=false&fixable=false&licenseattrib=false&licensedetails=false'

const SOCKET_API_URL = getSocketApiUrl() || DEFAULT_SOCKET_API_URL

// Resolve via the fleet-canonical helper. Accepts SOCKET_API_TOKEN
// (canonical) + 4 legacy aliases (SOCKET_CLI_API_TOKEN,
// SOCKET_CLI_API_KEY, SOCKET_SECURITY_API_TOKEN, SOCKET_SECURITY_API_KEY).
let staticApiKey: string = getSocketApiToken() || ''

// Single shared schema reused by both stdio and HTTP modes; pulled out
// so the server creator stays compact.
const depscoreInputSchema = {
  packages: z
    .array(
      z.object({
        ecosystem: z
          .string()
          .describe(
            'The package ecosystem (e.g., npm, pypi, gem, golang, maven, nuget, cargo)',
          )
          .default('npm'),
        depname: z.string().describe('The name of the dependency'),
        version: z
          .string()
          .describe("The version of the dependency, use 'unknown' if not known")
          .default('unknown'),
      }),
    )
    .describe('Array of packages to check'),
  platform: z
    .string()
    .optional()
    .describe(
      "Optional OS-architecture hint (e.g., 'linux-x64', 'darwin-arm64', 'win32-x64'). Used to select the most relevant artifact when a package has platform-specific builds.",
    ),
}

// Convert the depscore input list into PURLs ready for the components
// payload, stripping semver range prefixes from versions.
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
      logger.info(`Using version ${cleanedVersion} for ${pkg.depname}`)
    }
    return { purl }
  })
}

// Build a configured McpServer with the depscore tool registered.
// Used for stdio (single instance) and HTTP (one per session).
export function createConfiguredServer(): McpServer {
  const srv = new McpServer({ name: 'socket', version: VERSION })
  srv.registerTool(
    'depscore',
    {
      title: 'Dependency Score Tool',
      description:
        "Get the dependency score of packages with the `depscore` tool from Socket. Use 'unknown' for version if not known. Use this tool to scan dependencies for their quality and security on existing code or when code is generated. Stop generating code and ask the user how to proceed when any of the scores are low. When checking dependencies, make sure to also check the imports in the code, not just the manifest files (pyproject.toml, package.json, etc).",
      inputSchema: depscoreInputSchema,
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ packages, platform }, extra) =>
      handleDepscore(packages, platform, extra.authInfo?.token),
  )
  return srv
}

export function errorResult(text: string): ToolErrorResult {
  return {
    content: [{ type: 'text', text }],
    isError: true,
  }
}

// Render `Object.entries(score)` into a human-readable "k1: v1, k2: v2"
// summary. Sub-1 floats render as percentages (0–100); values >1 render
// raw so non-percentage metrics aren't distorted.
export function formatScoreEntries(score: Record<string, unknown>): string {
  return Object.entries(score)
    .filter(([key]) => key !== 'overall' && key !== 'uuid')
    .map(([key, value]) => {
      const numValue = Number(value)
      const displayValue = numValue <= 1 ? Math.round(numValue * 100) : numValue
      return `${key}: ${displayValue}`
    })
    .join(', ')
}

// Compose a "pkg:.../...@..." string + per-key score summary used by the
// depscore output. `score.overall` being defined gates whether we have
// real scores to render.
export function formatScoreLine(jsonData: Record<string, unknown>): string {
  const ns = jsonData['namespace'] ? `${jsonData['namespace']}/` : ''
  const purl = `pkg:${jsonData['type'] || 'unknown'}/${ns}${jsonData['name'] || 'unknown'}@${jsonData['version'] || 'unknown'}`
  const score = jsonData['score'] as Record<string, unknown> | undefined
  if (score && score['overall'] !== undefined) {
    return `${purl}: ${formatScoreEntries(score)}`
  }
  return `${purl}: No score found`
}

// Build the depscore handler — pulled out so the MCP registration is
// readable. The handler closes over the access token retrieval chain
// (request authInfo → env token).
export async function handleDepscore(
  packages: DepscorePackageInput[],
  platform: string | undefined,
  accessTokenFromAuth: string | undefined,
): Promise<ToolOkResult | ToolErrorResult> {
  logger.info(`Received request for ${packages.length} packages`)
  const accessToken = accessTokenFromAuth || staticApiKey
  if (!accessToken) {
    const errorMsg =
      'Authentication is required. Configure SOCKET_API_TOKEN (or a legacy alias) for stdio mode or connect through OAuth-enabled HTTP mode.'
    logger.error(errorMsg)
    return errorResult(errorMsg)
  }

  const components = buildPackageComponents(packages)

  let response
  try {
    response = await httpRequest(SOCKET_API_URL, {
      method: 'POST',
      headers: buildSocketHeaders(accessToken),
      body: JSON.stringify({ components }),
    })
  } catch (e) {
    const error = e as Error
    logger.error(`Error processing packages: ${error.message}`)
    return errorResult('Error connecting to Socket API')
  }

  const responseText = response.text()

  if (response.status === 401) {
    const errorMsg = `Socket authentication failed [401]. Re-authenticate and retry. ${responseText}`
    logger.error(errorMsg)
    return errorResult(errorMsg)
  }

  if (response.status === 403) {
    const errorMsg = `Socket denied access [403]. Re-authenticate with the correct organization or repository permissions and retry. ${responseText}`
    logger.error(errorMsg)
    return errorResult(errorMsg)
  }

  if (response.status !== 200) {
    const errorMsg = `Error processing packages: [${response.status}] ${responseText}`
    logger.error(errorMsg)
    return errorResult(errorMsg)
  }

  if (!responseText.trim()) {
    const errorMsg = 'No packages were found.'
    logger.error(errorMsg)
    return errorResult(errorMsg)
  }

  try {
    const contentType = response.headers['content-type']
    const contentTypeValue = Array.isArray(contentType)
      ? contentType.join(',')
      : contentType || ''
    const isNdjson = contentTypeValue.includes('x-ndjson')

    const parseResult = isNdjson
      ? parseNdjsonPackageBody(responseText, platform)
      : parseSinglePackageBody(responseText)

    if (!Array.isArray(parseResult)) {
      return errorResult(parseResult.error)
    }

    return {
      content: [
        {
          type: 'text',
          text:
            parseResult.length > 0
              ? `Dependency scores:\n${parseResult.join('\n')}`
              : 'No scores found for the provided packages',
        },
      ],
    }
  } catch (e) {
    const error = e as Error
    const errorMsg = `JSON parsing error: ${error.message} -- Response: ${responseText}`
    logger.error(errorMsg)
    return errorResult('Error parsing response from Socket API')
  }
}

// Parse an NDJSON response body — one JSON document per line — into
// result lines, dropping `_type`-tagged control frames and running the
// platform-aware artifact deduplication before formatting.
export function parseNdjsonPackageBody(
  responseText: string,
  platform: string | undefined,
): string[] | { error: string } {
  const jsonLines = responseText
    .split('\n')
    .filter(line => line.trim())
    .map(line => JSON.parse(line))
    .filter((obj: Record<string, unknown>) => !obj['_type'])

  if (!jsonLines.length) {
    return { error: 'No valid JSON objects found in NDJSON response' }
  }

  const deduplicated = deduplicateArtifacts(jsonLines, platform)
  const results: string[] = []
  for (let i = 0, { length } = deduplicated; i < length; i += 1) {
    results.push(formatScoreLine(deduplicated[i]!))
  }
  return results
}

// Parse a non-NDJSON response (single JSON document) into one result line.
export function parseSinglePackageBody(responseText: string): string[] {
  const jsonData = JSON.parse(responseText) as Record<string, unknown>
  return [formatScoreLine(jsonData)]
}

// Set the static API key. Called once during boot from index.ts.
// Subsequent calls overwrite — only the most recent value is used.
export function setStaticApiKey(value: string): void {
  staticApiKey = value
}

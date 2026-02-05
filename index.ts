#!/usr/bin/env -S node --experimental-strip-types
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import pino from 'pino'
import readline from 'readline'
import { join } from 'path'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { createServer } from 'http'

const __dirname = import.meta.dirname

// Extract version from package.json
const packageJson = JSON.parse(readFileSync(join(__dirname, './package.json'), 'utf8'))
const VERSION = packageJson.version || '0.0.1'

// Configure pino logger with cross-platform temp directory
const logger = pino({
  level: 'info',
  transport: {
    targets: [
      {
        target: 'pino/file',
        options: { destination: join(tmpdir(), 'socket-mcp-error.log') },
        level: 'error'
      },
      {
        target: 'pino/file',
        options: { destination: join(tmpdir(), 'socket-mcp.log') },
        level: 'info'
      }
    ]
  }
})

// Socket API URL - use localhost when debugging is enabled, otherwise use production
const SOCKET_API_URL = process.env['SOCKET_DEBUG'] === 'true'
  ? 'http://localhost:8866/v0/purl?alerts=true&compact=true'
  : 'https://api.socket.dev/v0/purl?alerts=true&compact=true'

// Function to get API key interactively (only for HTTP mode)
async function getApiKeyInteractively (): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr
  })

  const apiKey = await new Promise<string>((resolve) => {
    rl.question('Please enter your Socket API key: ', (answer: string | PromiseLike<string>) => {
      rl.close()
      resolve(answer)
    })
  })

  if (!apiKey) {
    logger.error('No API key provided')
    process.exit(1)
  }

  return apiKey
}

// Initialize API key
let SOCKET_API_KEY = process.env['SOCKET_API_KEY'] || ''

// Build headers dynamically to reflect current API key
function buildSocketHeaders (): Record<string, string> {
  return {
    'user-agent': `socket-mcp/${VERSION}`,
    accept: 'application/x-ndjson',
    'content-type': 'application/json',
    authorization: `Bearer ${SOCKET_API_KEY}`
  }
}

type SocketVerdict = 'PASS' | 'WARN' | 'FAIL'

function normalizePypiName (name: string): string {
  return name.trim().toLowerCase().replace(/[._-]/g, '-')
}

function stripVersionOperators (version: string): string {
  return version.trim().replace(/^(?:\^|~|>=|<=|==|!=|>|<)+/, '')
}

function toPurl (ecosystem: string, name: string, version: string): string {
  const cleanedEcosystem = (ecosystem || 'npm').trim()
  let cleanedName = name.trim()
  const cleanedVersion = stripVersionOperators(version || 'unknown')

  if (cleanedEcosystem === 'npm' && cleanedName.startsWith('@')) {
    cleanedName = `%40${cleanedName.slice(1)}`
  }

  if (cleanedEcosystem === 'pypi') {
    cleanedName = normalizePypiName(cleanedName)
  }

  if (!cleanedVersion || cleanedVersion === 'unknown' || cleanedVersion === '1.0.0') {
    return `pkg:${cleanedEcosystem}/${cleanedName}`
  }

  return `pkg:${cleanedEcosystem}/${cleanedName}@${cleanedVersion}`
}

function scoreToPercent (score: unknown): number | undefined {
  if (typeof score !== 'number' || Number.isNaN(score)) return undefined
  const pct = score <= 1 ? score * 100 : score
  return Math.round(pct)
}

function scoreToNormalized (score: unknown): number | undefined {
  if (typeof score !== 'number' || Number.isNaN(score)) return undefined
  return score <= 1 ? score : score / 100
}

function getAlertSeverity (alert: unknown): string {
  if (!alert || typeof alert !== 'object') return 'UNKNOWN'
  const record = alert as Record<string, unknown>
  const value = record['severity'] ?? record['level'] ?? record['priority']
  if (typeof value !== 'string') return 'UNKNOWN'
  return value.trim().toUpperCase()
}

function hasHighOrCriticalAlerts (alerts: unknown): boolean {
  if (!Array.isArray(alerts)) return false
  return alerts.some(a => {
    const sev = getAlertSeverity(a)
    return sev === 'HIGH' || sev === 'CRITICAL'
  })
}

function verdictForComponent (component: any): SocketVerdict {
  const supplyChain = scoreToNormalized(component?.score?.supply_chain)
  if (supplyChain === 0) return 'FAIL'
  if (typeof supplyChain === 'number' && supplyChain < 0.4) return 'WARN'
  if (hasHighOrCriticalAlerts(component?.alerts)) return 'WARN'
  return 'PASS'
}

function formatAlertsInline (alerts: unknown): string {
  if (!Array.isArray(alerts) || alerts.length === 0) return ''
  const parts: string[] = []
  for (const alert of alerts) {
    if (!alert || typeof alert !== 'object') continue
    const record = alert as Record<string, unknown>
    const type = typeof record['type'] === 'string' ? record['type'] : 'unknown'
    const sev = getAlertSeverity(alert)
    parts.push(`${sev} ${type}`)
  }
  return parts.length > 0 ? parts.join(', ') : ''
}

function formatScoresInline (score: any): string {
  const supplyChain = scoreToPercent(score?.supply_chain)
  const quality = scoreToPercent(score?.quality)
  const vulnerability = scoreToPercent(score?.vulnerability)
  const maintenance = scoreToPercent(score?.maintenance)
  const license = scoreToPercent(score?.license)

  const parts: string[] = []
  if (typeof supplyChain === 'number') parts.push(`supply_chain=${supplyChain}`)
  if (typeof quality === 'number') parts.push(`quality=${quality}`)
  if (typeof vulnerability === 'number') parts.push(`vulnerability=${vulnerability}`)
  if (typeof maintenance === 'number') parts.push(`maintenance=${maintenance}`)
  if (typeof license === 'number') parts.push(`license=${license}`)
  return parts.join(', ')
}

async function querySocket (components: Array<{ purl: string }>): Promise<any[]> {
  const response = await fetch(SOCKET_API_URL, {
    method: 'POST',
    headers: buildSocketHeaders(),
    body: JSON.stringify({ components })
  })

  const responseText = await response.text()

  if (response.status !== 200) {
    throw new Error(`Socket API error [${response.status}]: ${responseText}`)
  }

  if (!responseText.trim()) {
    throw new Error('Socket API returned an empty response')
  }

  const contentType = response.headers.get('content-type') || ''
  if (contentType.includes('x-ndjson')) {
    return responseText
      .split('\n')
      .filter(line => line.trim())
      .map(line => JSON.parse(line))
  }

  // Fallback to single JSON object response.
  return [JSON.parse(responseText)]
}

async function renderBatchCheck (packages: Array<{ ecosystem: string, name: string, version: string }>): Promise<string> {
  const components = packages.map(pkg => ({ purl: toPurl(pkg.ecosystem, pkg.name, pkg.version) }))
  const results = await querySocket(components)

  let passed = 0
  let warned = 0
  let failed = 0

  const lines: string[] = ['Dependency check results:', '']

  for (const item of results) {
    const ecosystem = typeof item?.type === 'string' ? item.type : 'unknown'
    const name = typeof item?.name === 'string' ? item.name : 'unknown'
    const version = typeof item?.version === 'string' ? item.version : 'unknown'
    const purl = toPurl(ecosystem, name, version)
    const verdict = verdictForComponent(item)

    if (verdict === 'PASS') passed++
    if (verdict === 'WARN') warned++
    if (verdict === 'FAIL') failed++

    lines.push(`${purl}: ${verdict}`)
    const scoresInline = formatScoresInline(item?.score)
    if (scoresInline) lines.push(`  ${scoresInline}`)

    const alertsInline = formatAlertsInline(item?.alerts)
    if (alertsInline) lines.push(`  Alerts: ${alertsInline}`)

    lines.push('')
  }

  lines.push(`Summary: ${passed} passed, ${warned} warning, ${failed} failed`)
  return lines.join('\n')
}

function renderCheckPackage (item: any, requestedPurl: string): string {
  const ecosystem = typeof item?.type === 'string' ? item.type : undefined
  const name = typeof item?.name === 'string' ? item.name : undefined
  const version = typeof item?.version === 'string' ? item.version : undefined
  const purl = ecosystem && name ? toPurl(ecosystem, name, version || 'unknown') : requestedPurl

  const verdict = verdictForComponent(item)

  const supplyChain = scoreToPercent(item?.score?.supply_chain)
  const quality = scoreToPercent(item?.score?.quality)
  const vulnerability = scoreToPercent(item?.score?.vulnerability)
  const maintenance = scoreToPercent(item?.score?.maintenance)
  const license = scoreToPercent(item?.score?.license)

  const scoreLines: string[] = []
  const lowCutoff = 40
  if (typeof supplyChain === 'number') scoreLines.push(`  supply_chain: ${supplyChain}${supplyChain < lowCutoff ? ' (low)' : ''}`)
  if (typeof quality === 'number') scoreLines.push(`  quality: ${quality}${quality < lowCutoff ? ' (low)' : ''}`)
  if (typeof vulnerability === 'number') scoreLines.push(`  vulnerability: ${vulnerability}${vulnerability < lowCutoff ? ' (low)' : ''}`)
  if (typeof maintenance === 'number') scoreLines.push(`  maintenance: ${maintenance}${maintenance < lowCutoff ? ' (low)' : ''}`)
  if (typeof license === 'number') scoreLines.push(`  license: ${license}${license < lowCutoff ? ' (low)' : ''}`)

  const alertLines: string[] = []
  const alerts = Array.isArray(item?.alerts) ? item.alerts : []
  for (const alert of alerts) {
    if (!alert || typeof alert !== 'object') continue
    const record = alert as Record<string, unknown>
    const type = typeof record['type'] === 'string' ? record['type'] : 'unknown'
    const sev = getAlertSeverity(alert)
    const description = typeof record['description'] === 'string'
      ? record['description']
      : (typeof record['message'] === 'string' ? record['message'] : '')
    alertLines.push(`  - ${sev}: ${type}${description ? ` - ${description}` : ''}`)
  }

  const parts: string[] = [
    `Package: ${purl}`,
    `Verdict: ${verdict}`,
    '',
    'Scores:',
    ...(scoreLines.length ? scoreLines : ['  (no scores returned)'])
  ]

  if (alertLines.length) {
    parts.push('', `Alerts (${alertLines.length}):`, ...alertLines)
  }

  return parts.join('\n')
}

type ExplainAlertEntry = {
  severity: string
  category: string
  what: string
  why: string
  todo: string
}

const ALERT_KNOWLEDGE: Record<string, ExplainAlertEntry> = {
  typosquat: {
    severity: 'HIGH',
    category: 'Supply Chain',
    what: 'This package name looks like a misspelling of a popular package (typosquatting).',
    why: 'Attackers publish look-alike packages to steal secrets or run malicious install/runtime code.',
    todo: 'Double-check the intended package name and publisher. Prefer the known correct package.'
  },
  protestware: {
    severity: 'HIGH',
    category: 'Supply Chain',
    what: 'The maintainer may have introduced code intended to disrupt or make a political statement.',
    why: 'Protestware can add destructive behavior or unpredictable failures.',
    todo: 'Review recent changes and consider pinning/avoiding the package or switching alternatives.'
  },
  installScripts: {
    severity: 'MEDIUM',
    category: 'Supply Chain',
    what: 'This package runs scripts during installation (preinstall, postinstall, etc.).',
    why: 'Install scripts execute arbitrary code the moment you run an install command, before you import the package.',
    todo: 'Review package install scripts. If not required, consider using `--ignore-scripts` or an alternative package.'
  },
  networkAccess: {
    severity: 'MEDIUM',
    category: 'Supply Chain',
    what: 'The package performs network access.',
    why: 'Unexpected network calls can exfiltrate data or fetch/execute remote payloads.',
    todo: 'Audit where network calls occur and ensure they are expected for the package’s purpose.'
  },
  shellAccess: {
    severity: 'HIGH',
    category: 'Supply Chain',
    what: 'The package spawns shell commands.',
    why: 'Shell execution is a common technique for malware, persistence, and data exfiltration.',
    todo: 'Inspect the code paths spawning shells; avoid the package if this is unexpected.'
  },
  filesystemAccess: {
    severity: 'MEDIUM',
    category: 'Supply Chain',
    what: 'The package accesses the filesystem.',
    why: 'Unexpected file reads/writes can leak credentials or modify code/config.',
    todo: 'Confirm filesystem access is expected and constrained to safe locations.'
  },
  envVariableAccess: {
    severity: 'MEDIUM',
    category: 'Supply Chain',
    what: 'The package reads environment variables.',
    why: 'Environment variables often include tokens and secrets.',
    todo: 'Ensure the package does not read sensitive env vars unexpectedly; scope secrets where possible.'
  },
  unmaintained: {
    severity: 'MEDIUM',
    category: 'Maintenance',
    what: 'The package appears unmaintained.',
    why: 'Unmaintained packages accumulate vulnerabilities and compatibility issues over time.',
    todo: 'Prefer a maintained alternative, or pin the version and plan to replace it.'
  },
  deprecated: {
    severity: 'MEDIUM',
    category: 'Maintenance',
    what: 'The package is deprecated.',
    why: 'Deprecated packages may be unsupported and can contain unresolved security issues.',
    todo: 'Follow the maintainer’s recommended replacement or migrate to an alternative.'
  },
  noLicense: {
    severity: 'MEDIUM',
    category: 'License',
    what: 'The package does not declare a license.',
    why: 'Using unlicensed code can create legal risk for you and your organization.',
    todo: 'Prefer packages with clear licensing, or contact the maintainer for clarification.'
  },
  copyleftLicense: {
    severity: 'MEDIUM',
    category: 'License',
    what: 'The package uses a copyleft license.',
    why: 'Copyleft licenses can impose distribution obligations that may conflict with your project’s license.',
    todo: 'Review licensing requirements with legal counsel and consider alternatives if needed.'
  },
  nonpermissiveLicense: {
    severity: 'MEDIUM',
    category: 'License',
    what: 'The package license is non-permissive.',
    why: 'Non-permissive terms can limit how you can use, modify, or distribute the software.',
    todo: 'Review the license terms and consider a permissively licensed alternative.'
  },
  knownVulnerability: {
    severity: 'HIGH',
    category: 'Vulnerability',
    what: 'Known vulnerabilities are reported for this package/version.',
    why: 'Known CVEs can be exploited in production environments.',
    todo: 'Upgrade to a patched version or choose an alternative.'
  },
  criticalCVE: {
    severity: 'CRITICAL',
    category: 'Vulnerability',
    what: 'Critical vulnerabilities are reported for this package/version.',
    why: 'Critical issues are often easily exploitable and high impact.',
    todo: 'Do not use this version; upgrade immediately or select an alternative.'
  },
  highCVE: {
    severity: 'HIGH',
    category: 'Vulnerability',
    what: 'High severity vulnerabilities are reported for this package/version.',
    why: 'High severity issues can enable compromise depending on usage.',
    todo: 'Upgrade to a patched version or choose an alternative.'
  },
  obfuscatedCode: {
    severity: 'HIGH',
    category: 'Malware',
    what: 'The package contains obfuscated code.',
    why: 'Obfuscation is commonly used to hide malicious behavior.',
    todo: 'Treat as suspicious; investigate the code and prefer an alternative.'
  },
  suspiciousString: {
    severity: 'HIGH',
    category: 'Malware',
    what: 'Suspicious strings were detected in the package.',
    why: 'Suspicious strings can indicate malware indicators, backdoors, or credential theft.',
    todo: 'Audit the code, search for IOCs, and consider an alternative.'
  },
  dynamicRequire: {
    severity: 'LOW',
    category: 'Quality',
    what: 'The package uses dynamic imports/require patterns.',
    why: 'Dynamic loading can reduce analyzability and can hide behavior.',
    todo: 'Review dynamic import usage and ensure it is not used to load untrusted code.'
  },
  noTests: {
    severity: 'LOW',
    category: 'Quality',
    what: 'The package has little or no test coverage.',
    why: 'Lack of tests can correlate with lower reliability and slower vulnerability fixes.',
    todo: 'Prefer well-tested alternatives when possible.'
  },
  noREADME: {
    severity: 'LOW',
    category: 'Quality',
    what: 'The package has no README or minimal documentation.',
    why: 'Poor documentation can hide risky behavior and makes evaluation harder.',
    todo: 'Inspect the source and consider alternatives with better documentation.'
  },
  tooManyDependencies: {
    severity: 'LOW',
    category: 'Quality',
    what: 'The package has an unusually large dependency tree.',
    why: 'More dependencies increase supply-chain attack surface and maintenance burden.',
    todo: 'Consider a smaller alternative or vendor only what you need.'
  }
}

async function setupClaudeCode (): Promise<void> {
  const apiKey = process.env['SOCKET_API_KEY'] || await getApiKeyInteractively()

  const claudeDir = join(homedir(), '.claude')
  const hooksDir = join(claudeDir, 'hooks')
  mkdirSync(hooksDir, { recursive: true })

  const sourceHookPath = join(__dirname, 'hooks', 'socket-gate.sh')
  const destHookPath = join(hooksDir, 'socket-gate.sh')

  if (!existsSync(sourceHookPath)) {
    throw new Error(`Missing hook script in package: ${sourceHookPath}`)
  }

  copyFileSync(sourceHookPath, destHookPath)
  chmodSync(destHookPath, 0o755)

  const settingsPath = join(claudeDir, 'settings.json')
  let settings: any = {}
  if (existsSync(settingsPath)) {
    try {
      const content = readFileSync(settingsPath, 'utf8').trim()
      settings = content ? JSON.parse(content) : {}
    } catch (error) {
      logger.error(`Failed to parse ${settingsPath}: ${(error as Error).message}`)
      throw error
    }
  }

  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) settings = {}

  if (!settings.mcpServers || typeof settings.mcpServers !== 'object' || Array.isArray(settings.mcpServers)) {
    settings.mcpServers = {}
  }

  const existingSocket = settings.mcpServers.socket
  const existingEnv = (existingSocket && typeof existingSocket === 'object') ? (existingSocket.env || {}) : {}

  settings.mcpServers.socket = {
    ...(existingSocket && typeof existingSocket === 'object' ? existingSocket : {}),
    command: 'npx',
    args: ['-y', '@socketsecurity/mcp@latest'],
    env: {
      ...(existingEnv && typeof existingEnv === 'object' ? existingEnv : {}),
      SOCKET_API_KEY: apiKey
    }
  }

  if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) {
    settings.hooks = {}
  }

  const preToolUse = Array.isArray(settings.hooks.PreToolUse) ? settings.hooks.PreToolUse : []
  const hasGate = preToolUse.some((entry: any) => {
    if (!entry || typeof entry !== 'object') return false
    if (entry.matcher !== 'Bash') return false
    if (!Array.isArray(entry.hooks)) return false
    return entry.hooks.some((h: any) => h && typeof h === 'object' && h.type === 'command' && h.command === destHookPath)
  })

  if (!hasGate) {
    preToolUse.push({
      matcher: 'Bash',
      hooks: [
        {
          type: 'command',
          command: destHookPath,
          timeout: 30,
          statusMessage: 'Checking packages with Socket...'
        }
      ]
    })
  }

  settings.hooks.PreToolUse = preToolUse

  mkdirSync(claudeDir, { recursive: true })
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`)

  const claudeSnippetPath = join(__dirname, 'templates', 'CLAUDE.md')
  const snippet = existsSync(claudeSnippetPath) ? readFileSync(claudeSnippetPath, 'utf8') : ''

  console.log(`Updated ${settingsPath}`)
  console.log(`Installed hook ${destHookPath}`)
  if (snippet.trim()) {
    console.log('\nAdd this to your project rules file (.claude/CLAUDE.md):\n')
    console.log(snippet.trimEnd())
  }
}

// No session management: each HTTP request is handled statelessly

// Create server instance
const server = new McpServer({
  name: 'socket',
  version: VERSION,
})

server.registerTool(
  'check_package',
  {
    title: 'Check a package (verdict + alerts)',
    description: 'Check a single package using the Socket API. Returns a PASS/WARN/FAIL verdict, category scores, and alerts.',
    inputSchema: z.object({
      ecosystem: z.string().default('npm'),
      name: z.string(),
      version: z.string().default('unknown')
    }),
    annotations: {
      readOnlyHint: true,
    },
  },
  async ({ ecosystem, name, version }) => {
    logger.info(`check_package: ${ecosystem}/${name}@${version}`)
    try {
      const requestedPurl = toPurl(ecosystem, name, version)
      const [result] = await querySocket([{ purl: requestedPurl }])
      const text = renderCheckPackage(result, requestedPurl)
      return { content: [{ type: 'text', text }] }
    } catch (error) {
      const message = (error as Error).message || 'Unknown error'
      logger.error(`check_package error: ${message}`)
      return { content: [{ type: 'text', text: `Error checking package: ${message}` }], isError: true }
    }
  }
)

server.registerTool(
  'batch_check',
  {
    title: 'Batch dependency check (verdict + alerts)',
    description: 'Check multiple packages at once using the Socket API. Returns per-package verdicts, scores, alerts, and a summary.',
    inputSchema: z.object({
      packages: z.array(z.object({
        ecosystem: z.string().default('npm'),
        name: z.string(),
        version: z.string().default('unknown')
      }))
    }),
    annotations: {
      readOnlyHint: true,
    },
  },
  async ({ packages }) => {
    logger.info(`batch_check: ${packages.length} packages`)
    try {
      const text = await renderBatchCheck(packages)
      return { content: [{ type: 'text', text }] }
    } catch (error) {
      const message = (error as Error).message || 'Unknown error'
      logger.error(`batch_check error: ${message}`)
      return { content: [{ type: 'text', text: `Error processing packages: ${message}` }], isError: true }
    }
  }
)

server.registerTool(
  'explain_alert',
  {
    title: 'Explain a Socket alert type',
    description: 'Explain a Socket alert type in plain language (static knowledge base, no API call).',
    inputSchema: z.object({
      alert_type: z.string().describe('Socket alert type (e.g., "protestware", "installScripts", "networkAccess", "typosquat")'),
    }),
    annotations: {
      readOnlyHint: true,
    },
  },
  async ({ alert_type: alertType }) => {
    const key = alertType.trim()
    const entry = ALERT_KNOWLEDGE[key]
    if (!entry) {
      const known = Object.keys(ALERT_KNOWLEDGE).sort().join(', ')
      return {
        content: [{ type: 'text', text: `Unknown alert type: ${key}\nKnown alert types: ${known}` }],
        isError: false
      }
    }

    const text = [
      `Alert: ${key}`,
      `Severity: ${entry.severity}`,
      `Category: ${entry.category}`,
      '',
      `What: ${entry.what}`,
      `Why it matters: ${entry.why}`,
      `What to do: ${entry.todo}`,
    ].join('\n')

    return { content: [{ type: 'text', text }] }
  }
)

server.registerTool(
  'depscore',
  {
    title: 'Dependency Score Tool',
    description: "Deprecated: use `batch_check` instead. Get dependency verdicts, scores, and alerts for packages using the Socket API. Use 'unknown' for version if not known.",
    inputSchema: z.object({
      packages: z.array(z.object({
        ecosystem: z.string().describe('The package ecosystem (e.g., npm, pypi)').default('npm'),
        depname: z.string().describe('The name of the dependency'),
        version: z.string().describe("The version of the dependency, use 'unknown' if not known").default('unknown'),
      })).describe('Array of packages to check'),
    }),
    annotations: {
      readOnlyHint: true,
    },
  },
  async ({ packages }) => {
    logger.info(`depscore (deprecated): ${packages.length} packages`)
    try {
      const mapped = packages.map(p => ({ ecosystem: p.ecosystem ?? 'npm', name: p.depname, version: p.version ?? 'unknown' }))
      const text = `depscore is deprecated; use batch_check instead.\n\n${await renderBatchCheck(mapped)}`
      return { content: [{ type: 'text', text }] }
    } catch (e) {
      const error = e as Error
      logger.error(`depscore error: ${error.message}`)
      return {
        content: [{ type: 'text', text: `Error processing packages: ${error.message}` }],
        isError: true
      }
    }
  }
)

// Determine transport mode from environment or arguments
const useHttp = process.env['MCP_HTTP_MODE'] === 'true' || process.argv.includes('--http')
const port = parseInt(process.env['MCP_PORT'] || '3000', 10)

// CLI helper: set up Claude Code hook + MCP server config.
if (process.argv.includes('--setup-claude-code')) {
  try {
    await setupClaudeCode()
    process.exit(0)
  } catch (error) {
    logger.error(`Setup failed: ${(error as Error).message}`)
    process.exit(1)
  }
}

// Validate API key - in stdio mode, we can't prompt interactively
if (!SOCKET_API_KEY) {
  if (useHttp) {
    // In HTTP mode, we can prompt for the API key
    logger.error('SOCKET_API_KEY environment variable is not set')
    SOCKET_API_KEY = await getApiKeyInteractively()
  } else {
    // In stdio mode, we must have the API key as an environment variable
    logger.error('SOCKET_API_KEY environment variable is required in stdio mode')
    logger.error('Please set the SOCKET_API_KEY environment variable and try again')
    process.exit(1)
  }
}

if (useHttp) {
  // HTTP mode with Server-Sent Events
  logger.info(`Starting HTTP server on port ${port}`)

  // Singleton transport to preserve initialization state without explicit sessions
  let httpTransport: StreamableHTTPServerTransport | null = null

  const httpServer = createServer(async (req, res) => {
    // Parse URL first to check for health endpoint
    let url: URL
    try {
      url = new URL(req.url!, `http://localhost:${port}`)
    } catch (error) {
      logger.warn(`Invalid URL in request: ${req.url} - ${error}`)
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Bad Request: Invalid URL' },
        id: null
      }))
      return
    }

    // Health check endpoint for K8s/Docker - bypass origin validation
    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        status: 'healthy',
        service: 'socket-mcp',
        version: VERSION,
        timestamp: new Date().toISOString()
      }))
      return
    }

    // Validate Origin header as required by MCP spec (for non-health endpoints)
    const origin = req.headers.origin

    // Check if origin is from localhost (any port) - safe for local development
    const isLocalhostOrigin = (originUrl: string): boolean => {
      try {
        const url = new URL(originUrl)
        return url.hostname === 'localhost' || url.hostname === '127.0.0.1'
      } catch {
        return false
      }
    }

    const allowedOrigins = [
      'https://mcp.socket.dev',
      'https://mcp.socket-staging.dev'
    ]

    // Check if request is from localhost (for same-origin requests that don't send Origin header)
    // Use strict matching to prevent spoofing via subdomains like "malicious-localhost.evil.com"
    const host = req.headers.host || ''

    // Extract hostnames from allowedOrigins for Host header validation
    const allowedHosts = allowedOrigins.map(o => new URL(o).hostname)

    const isAllowedHost = host === `localhost:${port}` ||
                            host === `127.0.0.1:${port}` ||
                            host === 'localhost' ||
                            host === '127.0.0.1' ||
                            allowedHosts.includes(host)

    // Allow requests:
    // 1. With Origin header from localhost (any port) or production domains
    // 2. Without Origin header if they're from localhost or allowed domains (same-origin requests)
    const isValidOrigin = origin
      ? (isLocalhostOrigin(origin) || allowedOrigins.includes(origin))
      : isAllowedHost

    if (!isValidOrigin) {
      logger.warn(`Rejected request from invalid origin: ${origin || 'missing'} (host: ${host})`)
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Forbidden: Invalid origin' },
        id: null
      }))
      return
    }

    // Set CORS headers for valid origins (only needed for cross-origin requests)
    // Same-origin requests don't send Origin header and don't need CORS headers
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept')
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(200)
      res.end()
      return
    }

    if (url.pathname === '/') {
      if (req.method === 'POST') {
        // Handle JSON-RPC messages statelessly
        let body = ''
        req.on('data', chunk => (body += chunk))
        req.on('end', async () => {
          try {
            const jsonData = JSON.parse(body)

            // If this is an initialize, reset the singleton transport so clients can (re)initialize cleanly
            if (jsonData && jsonData.method === 'initialize') {
              const clientInfo = jsonData.params?.clientInfo
              logger.info(`Client connected: ${clientInfo?.name || 'unknown'} v${clientInfo?.version || 'unknown'} from ${origin || host}`)

              if (httpTransport) {
                try { httpTransport.close() } catch {}
              }
              httpTransport = new StreamableHTTPServerTransport({
                // Stateless mode: no session management required
                sessionIdGenerator: undefined,
                // Return JSON responses to avoid SSE streaming
                enableJsonResponse: true
              })
              await server.connect(httpTransport)
              await httpTransport.handleRequest(req, res, jsonData)
              return
            }

            // For non-initialize requests, ensure transport exists (client should have initialized already)
            if (!httpTransport) {
              httpTransport = new StreamableHTTPServerTransport({
                sessionIdGenerator: undefined,
                enableJsonResponse: true
              })
              await server.connect(httpTransport)
            }
            await httpTransport.handleRequest(req, res, jsonData)
          } catch (error) {
            logger.error(`Error processing POST request: ${error}`)
            if (!res.headersSent) {
              res.writeHead(500)
              res.end(JSON.stringify({
                jsonrpc: '2.0',
                error: { code: -32603, message: 'Internal server error' },
                id: null
              }))
            }
          }
        })
      } else {
        res.writeHead(405)
        res.end('Method not allowed')
      }
    } else {
      res.writeHead(404)
      res.end('Not found')
    }
  })

  httpServer.listen(port, () => {
    logger.info(`Socket MCP HTTP server version ${VERSION} started successfully on port ${port}`)
    logger.info(`Connect to: http://localhost:${port}/`)
  })
} else {
  // Stdio mode (default)
  logger.info('Starting in stdio mode')
  const transport = new StdioServerTransport()
  server.connect(transport)
    .then(() => {
      logger.info(`Socket MCP server version ${VERSION} started successfully`)
    })
    .catch((error: Error) => {
      logger.error(`Failed to start Socket MCP server: ${error.message}`)
      process.exit(1)
    })
}

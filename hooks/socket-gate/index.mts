/**
 * Socket-gate — Claude Code PreToolUse hook (source for the bundled
 * socket-gate.cjs).
 *
 * Intercepts package install commands across npm, PyPI, Cargo, RubyGems, Go,
 * and NuGet, and checks the target package against the public Socket MCP
 * server. Blocks installs when the supply chain score is below 20 (known
 * malware, typosquats, high-risk supply chain signals).
 *
 * No API key, no CLI, no registration beyond copying the bundled directory.
 *
 * Setup (see README.md):
 *
 * 1. Copy the whole hooks/socket-gate/ directory to ~/.claude/hooks/ (from a
 *    published @socketsecurity/mcp install, or build it here with `pnpm run
 *    build`).
 * 2. Point a PreToolUse Bash hook at ~/.claude/hooks/socket-gate/socket-gate.cjs
 *    in ~/.claude/settings.json.
 *
 * This source imports @socketsecurity/lib-stable; rolldown inlines it into the
 * bundled socket-gate.cjs so the copied-out hook stays self-contained (a Claude
 * Code hook has no package.json and no node_modules — it can only run what is
 * physically present in the file).
 *
 * Fails open on network, parse, and timeout errors so a Socket outage does not
 * block legitimate work.
 */

import { readFileSync } from 'node:fs'
import { argv } from 'node:process'
import { fileURLToPath } from 'node:url'

import { errorMessage } from '@socketsecurity/lib-stable/errors/message'

const MCP_URL = 'https://mcp.socket.dev/'
const SUPPLY_CHAIN_THRESHOLD = 20
const REQUEST_TIMEOUT_MS = 10_000

export type Ecosystem = 'npm' | 'pypi' | 'cargo' | 'gem' | 'golang' | 'nuget'

export interface HookInput {
  session_id: string
  tool_name: string
  tool_input: Record<string, unknown> | string
}

// Each pattern matches "<tool> <install-subcommand> <pkg>" and captures the
// first non-flag argument ([^\s-] rejects a leading dash, [^\s]* takes the
// rest) as the package spec to scan. The (?:…) groups list a tool's install
// aliases (npm add|i|install, cargo add|install, go get|install) without
// capturing them.
const INSTALL_PATTERNS: Array<{ ecosystem: Ecosystem; pattern: RegExp }> = [
  { ecosystem: 'npm', pattern: /\bnpm\s+(?:add|i|install)\s+([^\s-][^\s]*)/i }, // socket-lint: allow uncommented-regex
  { ecosystem: 'npm', pattern: /\byarn\s+add\s+([^\s-][^\s]*)/i },
  { ecosystem: 'npm', pattern: /\bpnpm\s+add\s+([^\s-][^\s]*)/i },
  { ecosystem: 'npm', pattern: /\bbun\s+add\s+([^\s-][^\s]*)/i },
  {
    ecosystem: 'pypi',
    pattern: /(?:\bpython3?\s+-m\s+)?\bpip3?\s+install\s+([^\s-][^\s]*)/i, // socket-lint: allow uncommented-regex
  },
  { ecosystem: 'pypi', pattern: /\buv\s+add\s+([^\s-][^\s]*)/i },
  { ecosystem: 'pypi', pattern: /\buv\s+pip\s+install\s+([^\s-][^\s]*)/i },
  { ecosystem: 'pypi', pattern: /\bpoetry\s+add\s+([^\s-][^\s]*)/i },
  { ecosystem: 'pypi', pattern: /\bpipenv\s+install\s+([^\s-][^\s]*)/i },
  {
    ecosystem: 'cargo',
    pattern: /\bcargo\s+(?:add|install)\s+([^\s-][^\s]*)/i, // socket-lint: allow uncommented-regex
  },
  { ecosystem: 'gem', pattern: /\bgem\s+install\s+([^\s-][^\s]*)/i },
  { ecosystem: 'gem', pattern: /\bbundle\s+add\s+([^\s-][^\s]*)/i },
  { ecosystem: 'golang', pattern: /\bgo\s+(?:get|install)\s+([^\s-][^\s]*)/i }, // socket-lint: allow uncommented-regex
  { ecosystem: 'nuget', pattern: /\bdotnet\s+add\s+package\s+([^\s-][^\s]*)/i },
  { ecosystem: 'nuget', pattern: /\bnuget\s+install\s+([^\s-][^\s]*)/i },
]

export async function checkPackage(
  ecosystem: Ecosystem,
  packageName: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ decision: 'allow' | 'deny'; reason: string }> {
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const commonHeaders = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  }

  const initRes = await fetchImpl(MCP_URL, {
    method: 'POST',
    headers: commonHeaders,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'socket-gate', version: '1.0' },
      },
    }),
    signal,
  })

  if (!initRes.ok) {
    throw new Error(`Socket MCP initialize returned ${initRes.status}`)
  }

  const sessionId = initRes.headers.get('mcp-session-id')
  if (!sessionId) {
    throw new Error('Socket MCP did not return a session id')
  }
  await initRes.text()

  const callRes = await fetchImpl(MCP_URL, {
    method: 'POST',
    headers: { ...commonHeaders, 'Mcp-Session-Id': sessionId },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'depscore',
        arguments: {
          packages: [{ ecosystem, depname: packageName }],
        },
      },
    }),
    signal,
  })

  if (!callRes.ok) {
    throw new Error(`Socket MCP depscore returned ${callRes.status}`)
  }

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- JSON.parse returns any; the asserted record type is the loosest object view and every field read is type-guarded at use.
  const payload = (await callRes.json()) as {
    result?:
      | {
          content?: Array<{ type: string; text: string }> | undefined
          isError?: boolean | undefined
        }
      | undefined
  }

  if (payload.result?.isError) {
    throw new Error(
      'Socket MCP reported a tool error (package likely not found)',
    )
  }

  const text = payload.result?.content?.[0]?.text ?? ''
  const score = parseSupplyChainScore(text)

  if (score === undefined) {
    throw new Error('Could not parse supplyChain score from MCP response')
  }

  if (score < SUPPLY_CHAIN_THRESHOLD) {
    return {
      decision: 'deny',
      reason: `Socket blocked "${packageName}" (${ecosystem}): supply chain score is ${score} (threshold ${SUPPLY_CHAIN_THRESHOLD}).\n\nReview: https://socket.dev/${ecosystem}/package/${packageName}`,
    }
  }

  return { decision: 'allow', reason: '' }
}

export function extractPackage(
  command: string,
): { ecosystem: Ecosystem; name: string } | undefined {
  for (const { ecosystem, pattern } of INSTALL_PATTERNS) {
    const match = command.match(pattern)
    if (match?.[1]) {
      const name = stripVersion(match[1], ecosystem)
      if (!name) {
        continue
      }
      return { ecosystem, name }
    }
  }
  return undefined
}

// stdout is the Claude Code hook IPC channel — the harness parses this exact
// JSON as the permission decision, so these must be raw writes (a logger would
// add formatting/timestamps and break the protocol).
export function outputAllow(): void {
  const payload = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
    },
  })
  process.stdout.write(payload) // socket-lint: allow process-stdio -- stdout is the hook decision protocol; raw write keeps the bundled hook free of logger indirection
}

export function outputDeny(reason: string): void {
  const payload = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  })
  process.stdout.write(payload) // socket-lint: allow process-stdio -- stdout is the hook decision protocol; raw write keeps the bundled hook free of logger indirection
}

export function parseSupplyChainScore(text: string): number | undefined {
  // "supplyChain:" then optional spaces, capturing an integer with an
  // optional ".<fraction>" decimal part (e.g. "supplyChain: 0.82").
  const match = text.match(/supplyChain:\s*(\d+(?:\.\d+)?)/i)
  return match ? Number(match[1]) : undefined
}

export function stripVersion(pkg: string, ecosystem: Ecosystem): string {
  switch (ecosystem) {
    case 'npm':
      return pkg.replace(/@[\d^~].*/u, '').replace(/@latest$/u, '')
    case 'pypi':
      return pkg.split(/[=<>!~[]/)[0] ?? pkg
    case 'cargo':
    case 'golang':
    case 'nuget':
      return pkg.replace(/@.*$/u, '')
    default:
      return pkg
  }
}

async function main(): Promise<void> {
  let raw: string
  try {
    raw = readFileSync(0, 'utf-8')
  } catch {
    outputAllow()
    return
  }

  if (!raw.trim()) {
    outputAllow()
    return
  }

  let input: HookInput
  try {
    input = JSON.parse(raw)
  } catch {
    outputAllow()
    return
  }

  if (input.tool_name !== 'Bash') {
    outputAllow()
    return
  }

  const rawCommand =
    typeof input.tool_input === 'string'
      ? input.tool_input
      : input.tool_input?.['command']
  const command = typeof rawCommand === 'string' ? rawCommand : ''

  if (!command) {
    outputAllow()
    return
  }

  const target = extractPackage(command)
  if (!target) {
    outputAllow()
    return
  }

  try {
    const result = await checkPackage(target.ecosystem, target.name)
    if (result.decision === 'deny') {
      outputDeny(result.reason)
    } else {
      outputAllow()
    }
  } catch (e) {
    // Deliberate fail-OPEN: a Socket outage / network error / parse failure
    // must not block legitimate installs (this hook is an advisory guardrail,
    // not a hard gate — see the file header). Surface the error on stderr so
    // the failure is observable; stdout stays the allow/deny IPC channel.
    const errLine = `socket-gate: check failed for ${target.ecosystem}/${target.name}, failing open: ${errorMessage(e)}\n`
    process.stderr.write(errLine) // socket-lint: allow process-stdio -- stderr feedback for the harness; raw write keeps the bundled hook free of logger indirection
    outputAllow()
  }
}

const isMainModule =
  argv[1] !== undefined && fileURLToPath(import.meta.url) === argv[1]

if (isMainModule) {
  main().catch(() => {
    outputAllow()
  })
}

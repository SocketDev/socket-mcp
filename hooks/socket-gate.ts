#!/usr/bin/env -S node --experimental-strip-types
/**
 * Socket-gate.ts — Claude Code PreToolUse hook.
 *
 * Intercepts package install commands across npm, PyPI, Cargo, RubyGems, Go,
 * and NuGet, and checks the target package against the public Socket MCP
 * server. Blocks installs when the supply chain score is below 20 (known
 * malware, typosquats, high-risk supply chain signals).
 *
 * No API key, no CLI, no registration beyond copying this file.
 *
 * Setup:
 *
 * 1. Copy this file to ~/.claude/hooks/socket-gate.ts
 * 2. Add to ~/.claude/settings.json (see README)
 *
 * Fails open on network, parse, and timeout errors so a Socket outage does not
 * block legitimate work.
 */

import { readFileSync } from 'node:fs'
import { argv } from 'node:process'
import { fileURLToPath } from 'node:url'

const MCP_URL = 'https://mcp.socket.dev/'
const SUPPLY_CHAIN_THRESHOLD = 20
const REQUEST_TIMEOUT_MS = 10_000

type Ecosystem = 'npm' | 'pypi' | 'cargo' | 'gem' | 'golang' | 'nuget'

interface HookInput {
  session_id: string
  tool_name: string
  tool_input: Record<string, unknown> | string
}

const INSTALL_PATTERNS: Array<{ ecosystem: Ecosystem; pattern: RegExp }> = [
  { ecosystem: 'npm', pattern: /\bnpm\s+(?:add|i|install)\s+([^\s-][^\s]*)/i },
  { ecosystem: 'npm', pattern: /\byarn\s+add\s+([^\s-][^\s]*)/i },
  { ecosystem: 'npm', pattern: /\bpnpm\s+add\s+([^\s-][^\s]*)/i },
  { ecosystem: 'npm', pattern: /\bbun\s+add\s+([^\s-][^\s]*)/i },
  {
    ecosystem: 'pypi',
    pattern: /(?:\bpython3?\s+-m\s+)?\bpip3?\s+install\s+([^\s-][^\s]*)/i,
  },
  { ecosystem: 'pypi', pattern: /\buv\s+add\s+([^\s-][^\s]*)/i },
  { ecosystem: 'pypi', pattern: /\buv\s+pip\s+install\s+([^\s-][^\s]*)/i },
  { ecosystem: 'pypi', pattern: /\bpoetry\s+add\s+([^\s-][^\s]*)/i },
  { ecosystem: 'pypi', pattern: /\bpipenv\s+install\s+([^\s-][^\s]*)/i },
  {
    ecosystem: 'cargo',
    pattern: /\bcargo\s+(?:add|install)\s+([^\s-][^\s]*)/i,
  },
  { ecosystem: 'gem', pattern: /\bgem\s+install\s+([^\s-][^\s]*)/i },
  { ecosystem: 'gem', pattern: /\bbundle\s+add\s+([^\s-][^\s]*)/i },
  { ecosystem: 'golang', pattern: /\bgo\s+(?:get|install)\s+([^\s-][^\s]*)/i },
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
  process.stdout.write(payload) // socket-hook: allow console
}

export function outputDeny(reason: string): void {
  const payload = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  })
  process.stdout.write(payload) // socket-hook: allow console
}

export function parseSupplyChainScore(text: string): number | undefined {
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

  const command =
    typeof input.tool_input === 'string'
      ? input.tool_input
      : (input.tool_input?.['command'] as string) || ''

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
    // oxlint-disable-next-line socket/prefer-error-message -- standalone copy-paste hook; cannot import @socketsecurity/lib.
    const msg = e instanceof Error ? e.message : String(e)
    const errLine = `socket-gate: check failed for ${target.ecosystem}/${target.name}, failing open: ${msg}\n`
    process.stderr.write(errLine) // socket-hook: allow console
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

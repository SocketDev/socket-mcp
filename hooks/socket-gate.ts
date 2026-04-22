#!/usr/bin/env -S node --experimental-strip-types
/**
 * socket-gate.ts — Claude Code PreToolUse hook
 *
 * Intercepts npm/yarn/bun/pnpm install commands and checks packages against
 * the Socket API. Blocks packages with a supply chain score below 0.2
 * (known malware, typosquats, high-risk supply chain signals).
 *
 * Setup:
 *   1. export SOCKET_API_KEY=... (same key used by the MCP server)
 *   2. Copy this file to ~/.claude/hooks/socket-gate.ts
 *   3. Add to ~/.claude/settings.json (see README)
 *
 * Denies when SOCKET_API_KEY is missing so users are not silently
 * unprotected. Fails open on network, parse, or timeout errors so a
 * Socket outage does not block legitimate work.
 */

import { readFileSync } from 'node:fs'

const SOCKET_API_URL = 'https://api.socket.dev/v0/purl'
const SUPPLY_CHAIN_THRESHOLD = 0.2
const REQUEST_TIMEOUT_MS = 10_000

interface HookInput {
  session_id: string
  tool_name: string
  tool_input: Record<string, unknown> | string
}

interface PurlResponse {
  score?: {
    supplyChain?: number
  }
}

function outputAllow (): void {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow'
    }
  }))
}

function outputDeny (reason: string): void {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason
    }
  }))
}

const INSTALL_PATTERNS = [
  /npm\s+(?:install|i|add)\s+([^\s-][^\s]*)/i,
  /yarn\s+add\s+([^\s-][^\s]*)/i,
  /bun\s+add\s+([^\s-][^\s]*)/i,
  /pnpm\s+add\s+([^\s-][^\s]*)/i
]

const LOCKFILE_PATTERNS = [
  /^npm\s+(install|i|ci)\s*$/i,
  /^yarn\s*(install)?\s*$/i,
  /^bun\s+install\s*$/i,
  /^pnpm\s+install\s*$/i
]

export function extractPackageName (command: string): string | null {
  if (LOCKFILE_PATTERNS.some(p => p.test(command.trim()))) {
    return null
  }

  for (const pattern of INSTALL_PATTERNS) {
    const match = command.match(pattern)
    if (match) {
      const pkg = match[1]
      return pkg.replace(/@[\d^~].*/u, '').replace(/@latest$/u, '')
    }
  }

  return null
}

export async function checkPackage (
  packageName: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ decision: 'allow' | 'deny', reason: string }> {
  const auth = Buffer.from(`${apiKey}:`).toString('base64')

  const res = await fetchImpl(SOCKET_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      components: [{ purl: `pkg:npm/${packageName}` }]
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  })

  if (!res.ok) {
    throw new Error(`Socket API returned ${res.status}`)
  }

  const text = await res.text()
  const line = text.split('\n').find(l => l.trim().length > 0)
  if (!line) {
    throw new Error('Empty response from Socket API')
  }

  const parsed: PurlResponse = JSON.parse(line)
  const score = parsed.score?.supplyChain

  if (typeof score !== 'number') {
    throw new Error('Missing supplyChain score in response')
  }

  if (score < SUPPLY_CHAIN_THRESHOLD) {
    return {
      decision: 'deny',
      reason: `Socket blocked "${packageName}": supply chain score is ${score.toFixed(2)} (threshold ${SUPPLY_CHAIN_THRESHOLD}).\n\nReview: https://socket.dev/npm/package/${packageName}`
    }
  }

  return { decision: 'allow', reason: '' }
}

async function main (): Promise<void> {
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

  const command = typeof input.tool_input === 'string'
    ? input.tool_input
    : (input.tool_input?.command as string) || ''

  if (!command) {
    outputAllow()
    return
  }

  const packageName = extractPackageName(command)
  if (!packageName) {
    outputAllow()
    return
  }

  const apiKey = process.env.SOCKET_API_KEY
  if (!apiKey) {
    outputDeny('SOCKET_API_KEY is not set. Export it in your shell (same key used by the Socket MCP server) or remove the hook from ~/.claude/settings.json.')
    return
  }

  try {
    const result = await checkPackage(packageName, apiKey)
    if (result.decision === 'deny') {
      outputDeny(result.reason)
    } else {
      outputAllow()
    }
  } catch {
    outputAllow()
  }
}

main().catch(() => {
  outputAllow()
})

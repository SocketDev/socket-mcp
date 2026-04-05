#!/usr/bin/env -S node --experimental-strip-types
/**
 * socket-gate.ts — Claude Code PreToolUse hook
 *
 * Intercepts npm/yarn/bun/pnpm install commands and checks packages against
 * the Socket API. Blocks packages with critical alerts (malware, typosquats)
 * and warns on high severity supply chain risks.
 *
 * Setup:
 *   1. Copy this file to ~/.claude/hooks/socket-gate.ts
 *   2. Add to ~/.claude/settings.json (see README)
 *   3. Set SOCKET_API_KEY env var
 *
 * Fails open on all errors (network, auth, parse) so it never blocks
 * legitimate work.
 */

import { readFileSync } from 'node:fs'

// ========================================
// Types
// ========================================

interface HookInput {
  session_id: string
  tool_name: string
  tool_input: Record<string, unknown> | string
}

interface SocketAlert {
  type: string
  severity: string
  category?: string
  props?: Record<string, unknown>
}

interface PurlResponseLine {
  _type?: string
  score?: Record<string, unknown>
  alerts?: SocketAlert[]
  name?: string
  namespace?: string
  type?: string
  version?: string
  [key: string]: unknown
}

// ========================================
// Hook output helpers (Claude Code PreToolUse format)
// ========================================

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

// ========================================
// Package extraction
// ========================================

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
      // Strip version specifiers: @scope/pkg@1.2.3 -> @scope/pkg
      return pkg.replace(/@[\d^~].*/u, '').replace(/@latest$/u, '')
    }
  }

  return null
}

// ========================================
// PURL construction (npm only, inline)
// ========================================

export function buildNpmPurl (packageName: string): string {
  if (packageName.startsWith('@') && packageName.includes('/')) {
    const slash = packageName.indexOf('/')
    const scope = encodeURIComponent(packageName.slice(0, slash))
    const name = packageName.slice(slash + 1)
    return `pkg:npm/${scope}/${name}`
  }
  return `pkg:npm/${packageName}`
}

// ========================================
// Socket API
// ========================================

const DEFAULT_SOCKET_API_URL = 'https://api.socket.dev/v0/purl'

function getSocketApiUrl (): string {
  if (process.env['SOCKET_API_URL']) {
    return process.env['SOCKET_API_URL']
  }
  return `${DEFAULT_SOCKET_API_URL}?alerts=true&compact=false&fixable=false&licenseattrib=false&licensedetails=false`
}

export async function checkPackage (packageName: string, apiKey: string): Promise<{ decision: 'allow' | 'deny', reason: string }> {
  const purl = buildNpmPurl(packageName)

  const response = await fetch(getSocketApiUrl(), {
    method: 'POST',
    headers: {
      'user-agent': 'socket-mcp-hook/1.0',
      accept: 'application/x-ndjson',
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({ components: [{ purl }] }),
    signal: AbortSignal.timeout(15_000)
  })

  if (!response.ok) {
    return { decision: 'allow', reason: '' }
  }

  const text = await response.text()
  if (!text.trim()) {
    return { decision: 'allow', reason: '' }
  }

  const lines: PurlResponseLine[] = text
    .split('\n')
    .filter(line => line.trim())
    .map(line => JSON.parse(line) as PurlResponseLine)
    .filter(obj => !obj._type)

  if (lines.length === 0) {
    return { decision: 'allow', reason: '' }
  }

  const pkg = lines[0]
  const alerts = pkg.alerts || []

  const critical = alerts.filter(a => a.severity === 'critical')
  const high = alerts.filter(a => a.severity === 'high')

  if (critical.length > 0) {
    const details = critical
      .map(a => `  - ${a.type}: ${a.category || 'detected'}`)
      .join('\n')

    return {
      decision: 'deny',
      reason: `Socket blocked "${packageName}" (${critical.length} critical alert${critical.length > 1 ? 's' : ''}):\n\n${details}\n\nReview: https://socket.dev/npm/package/${packageName}`
    }
  }

  if (high.length > 0) {
    const details = high
      .map(a => `  - ${a.type}: ${a.category || 'detected'}`)
      .join('\n')

    return {
      decision: 'deny',
      reason: `Socket blocked "${packageName}" (${high.length} high severity alert${high.length > 1 ? 's' : ''}):\n\n${details}\n\nReview: https://socket.dev/npm/package/${packageName}`
    }
  }

  return { decision: 'allow', reason: '' }
}

// ========================================
// Main
// ========================================

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

  const apiKey = process.env['SOCKET_API_KEY']
  if (!apiKey) {
    outputAllow()
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

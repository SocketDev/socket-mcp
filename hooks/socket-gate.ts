#!/usr/bin/env -S node --experimental-strip-types
/**
 * socket-gate.ts — Claude Code PreToolUse hook
 *
 * Intercepts npm/yarn/bun/pnpm install commands and checks packages against
 * Socket. Blocks packages with critical alerts (malware, typosquats)
 * and high severity supply chain risks.
 *
 * Uses the Socket CLI (`socket package score`) which handles its own auth
 * via `socket login`. No API key env var needed.
 *
 * Setup:
 *   1. Install Socket CLI: npm install -g @socketsecurity/cli && socket login
 *   2. Copy this file to ~/.claude/hooks/socket-gate.ts
 *   3. Add to ~/.claude/settings.json (see README)
 *
 * Fails open on all errors (CLI missing, network timeout, parse failures)
 * so it never blocks legitimate work.
 */

import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

// ========================================
// Types
// ========================================

interface HookInput {
  session_id: string
  tool_name: string
  tool_input: Record<string, unknown> | string
}

interface SocketAlert {
  name: string
  severity: string
  category?: string
}

interface SocketScoreResult {
  ok?: boolean
  data?: {
    self?: {
      alerts?: SocketAlert[]
    }
  }
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
// Socket CLI
// ========================================

function isSocketInstalled (): boolean {
  try {
    execFileSync('which', ['socket'], { encoding: 'utf-8', timeout: 5_000 })
    return true
  } catch {
    return false
  }
}

export function checkPackage (packageName: string): { decision: 'allow' | 'deny', reason: string } {
  const result = execFileSync(
    'socket',
    ['package', 'score', 'npm', packageName, '--json', '--no-banner'],
    { encoding: 'utf-8', timeout: 30_000, maxBuffer: 10 * 1024 * 1024 }
  )

  const parsed: SocketScoreResult = JSON.parse(result)
  const alerts = parsed.data?.self?.alerts || []

  const critical = alerts.filter(a => a.severity === 'critical')
  const high = alerts.filter(a => a.severity === 'high')

  if (critical.length > 0) {
    const details = critical
      .map(a => `  - ${a.name}: ${a.category || 'detected'}`)
      .join('\n')

    return {
      decision: 'deny',
      reason: `Socket blocked "${packageName}" (${critical.length} critical alert${critical.length > 1 ? 's' : ''}):\n\n${details}\n\nReview: https://socket.dev/npm/package/${packageName}`
    }
  }

  if (high.length > 0) {
    const details = high
      .map(a => `  - ${a.name}: ${a.category || 'detected'}`)
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

  if (!isSocketInstalled()) {
    // CLI not installed, fail open
    outputAllow()
    return
  }

  try {
    const result = checkPackage(packageName)
    if (result.decision === 'deny') {
      outputDeny(result.reason)
    } else {
      outputAllow()
    }
  } catch {
    // Fail open on any error
    outputAllow()
  }
}

main().catch(() => {
  outputAllow()
})

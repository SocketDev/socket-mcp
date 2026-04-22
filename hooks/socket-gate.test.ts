#!/usr/bin/env node
import { test } from 'node:test'
import assert from 'node:assert'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

const hookPath = join(import.meta.dirname, 'socket-gate.ts')

function runHook (input: string, env: Record<string, string | undefined> = {}): string {
  return execFileSync('node', ['--experimental-strip-types', hookPath], {
    input,
    encoding: 'utf-8',
    timeout: 30_000,
    env: { ...process.env, ...env }
  }).trim()
}

function parseOutput (output: string): { decision: string, reason?: string } {
  const parsed = JSON.parse(output)
  return {
    decision: parsed.hookSpecificOutput.permissionDecision,
    reason: parsed.hookSpecificOutput.permissionDecisionReason
  }
}

function makeInput (command: string): string {
  return JSON.stringify({
    session_id: 'test',
    tool_name: 'Bash',
    tool_input: { command }
  })
}

const hasApiKey = !!process.env.SOCKET_API_KEY

test('socket-gate hook', async (t) => {
  await t.test('allows non-Bash tools', () => {
    const input = JSON.stringify({ session_id: 'test', tool_name: 'Read', tool_input: { path: '/tmp/foo' } })
    const result = parseOutput(runHook(input))
    assert.strictEqual(result.decision, 'allow')
  })

  await t.test('allows non-install commands', () => {
    const result = parseOutput(runHook(makeInput('ls -la')))
    assert.strictEqual(result.decision, 'allow')
  })

  await t.test('allows lockfile-only installs', () => {
    for (const cmd of ['npm install', 'npm i', 'npm ci', 'yarn', 'yarn install', 'bun install', 'pnpm install']) {
      const result = parseOutput(runHook(makeInput(cmd)))
      assert.strictEqual(result.decision, 'allow', `should allow: ${cmd}`)
    }
  })

  await t.test('allows empty input', () => {
    const result = parseOutput(runHook(''))
    assert.strictEqual(result.decision, 'allow')
  })

  await t.test('allows invalid JSON', () => {
    const result = parseOutput(runHook('not json'))
    assert.strictEqual(result.decision, 'allow')
  })

  await t.test('denies when SOCKET_API_KEY is missing', () => {
    const result = parseOutput(runHook(makeInput('npm install lodash'), { SOCKET_API_KEY: '' }))
    assert.strictEqual(result.decision, 'deny')
    assert.ok(result.reason?.includes('SOCKET_API_KEY'), 'reason should mention the env var')
  })

  await t.test('allows safe package (lodash)', { skip: !hasApiKey && 'SOCKET_API_KEY not set' }, () => {
    const result = parseOutput(runHook(makeInput('npm install lodash')))
    assert.strictEqual(result.decision, 'allow')
  })

  await t.test('allows safe scoped package (@types/node)', { skip: !hasApiKey && 'SOCKET_API_KEY not set' }, () => {
    const result = parseOutput(runHook(makeInput('yarn add @types/node')))
    assert.strictEqual(result.decision, 'allow')
  })

  await t.test('blocks typosquat (browserlist)', { skip: !hasApiKey && 'SOCKET_API_KEY not set' }, () => {
    const result = parseOutput(runHook(makeInput('npm install browserlist')))
    assert.strictEqual(result.decision, 'deny')
    assert.ok(result.reason?.includes('browserlist'), 'reason should mention package name')
    assert.ok(result.reason?.includes('supply chain score'), 'reason should mention the score')
    assert.ok(result.reason?.includes('socket.dev'), 'reason should include review link')
  })

  await t.test('handles versioned install', { skip: !hasApiKey && 'SOCKET_API_KEY not set' }, () => {
    const result = parseOutput(runHook(makeInput('npm install express@4.18.2')))
    assert.strictEqual(result.decision, 'allow')
  })

  await t.test('handles pnpm add', { skip: !hasApiKey && 'SOCKET_API_KEY not set' }, () => {
    const result = parseOutput(runHook(makeInput('pnpm add express')))
    assert.strictEqual(result.decision, 'allow')
  })

  await t.test('handles bun add', { skip: !hasApiKey && 'SOCKET_API_KEY not set' }, () => {
    const result = parseOutput(runHook(makeInput('bun add express')))
    assert.strictEqual(result.decision, 'allow')
  })
})

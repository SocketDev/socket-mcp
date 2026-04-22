#!/usr/bin/env node
import { test } from 'node:test'
import assert from 'node:assert'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { extractPackage, parseSupplyChainScore } from './socket-gate.ts'

const hookPath = join(import.meta.dirname, 'socket-gate.ts')

function runHook (input: string): string {
  return execFileSync('node', ['--experimental-strip-types', hookPath], {
    input,
    encoding: 'utf-8',
    timeout: 30_000,
    env: { ...process.env }
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

test('extractPackage — npm ecosystem', () => {
  assert.deepStrictEqual(extractPackage('npm install lodash'), { ecosystem: 'npm', name: 'lodash' })
  assert.deepStrictEqual(extractPackage('npm i express'), { ecosystem: 'npm', name: 'express' })
  assert.deepStrictEqual(extractPackage('npm add react'), { ecosystem: 'npm', name: 'react' })
  assert.deepStrictEqual(extractPackage('yarn add vue'), { ecosystem: 'npm', name: 'vue' })
  assert.deepStrictEqual(extractPackage('pnpm add svelte'), { ecosystem: 'npm', name: 'svelte' })
  assert.deepStrictEqual(extractPackage('bun add zod'), { ecosystem: 'npm', name: 'zod' })
  assert.deepStrictEqual(extractPackage('npm install express@4.18.2'), { ecosystem: 'npm', name: 'express' })
  assert.deepStrictEqual(extractPackage('yarn add @types/node'), { ecosystem: 'npm', name: '@types/node' })
})

test('extractPackage — pypi ecosystem', () => {
  assert.deepStrictEqual(extractPackage('pip install requests'), { ecosystem: 'pypi', name: 'requests' })
  assert.deepStrictEqual(extractPackage('pip3 install flask'), { ecosystem: 'pypi', name: 'flask' })
  assert.deepStrictEqual(extractPackage('python -m pip install numpy'), { ecosystem: 'pypi', name: 'numpy' })
  assert.deepStrictEqual(extractPackage('python3 -m pip install pandas'), { ecosystem: 'pypi', name: 'pandas' })
  assert.deepStrictEqual(extractPackage('uv add httpx'), { ecosystem: 'pypi', name: 'httpx' })
  assert.deepStrictEqual(extractPackage('uv pip install fastapi'), { ecosystem: 'pypi', name: 'fastapi' })
  assert.deepStrictEqual(extractPackage('poetry add pydantic'), { ecosystem: 'pypi', name: 'pydantic' })
  assert.deepStrictEqual(extractPackage('pipenv install django'), { ecosystem: 'pypi', name: 'django' })
  assert.deepStrictEqual(extractPackage('pip install requests==2.31.0'), { ecosystem: 'pypi', name: 'requests' })
  assert.deepStrictEqual(extractPackage('pip install flask>=2.0'), { ecosystem: 'pypi', name: 'flask' })
})

test('extractPackage — cargo ecosystem', () => {
  assert.deepStrictEqual(extractPackage('cargo add serde'), { ecosystem: 'cargo', name: 'serde' })
  assert.deepStrictEqual(extractPackage('cargo install ripgrep'), { ecosystem: 'cargo', name: 'ripgrep' })
  assert.deepStrictEqual(extractPackage('cargo add tokio@1.0'), { ecosystem: 'cargo', name: 'tokio' })
})

test('extractPackage — gem ecosystem', () => {
  assert.deepStrictEqual(extractPackage('gem install rails'), { ecosystem: 'gem', name: 'rails' })
  assert.deepStrictEqual(extractPackage('bundle add rspec'), { ecosystem: 'gem', name: 'rspec' })
})

test('extractPackage — golang ecosystem', () => {
  assert.deepStrictEqual(extractPackage('go get github.com/pkg/errors'), { ecosystem: 'golang', name: 'github.com/pkg/errors' })
  assert.deepStrictEqual(extractPackage('go install github.com/charmbracelet/gum@latest'), { ecosystem: 'golang', name: 'github.com/charmbracelet/gum' })
})

test('extractPackage — nuget ecosystem', () => {
  assert.deepStrictEqual(extractPackage('dotnet add package Newtonsoft.Json'), { ecosystem: 'nuget', name: 'Newtonsoft.Json' })
  assert.deepStrictEqual(extractPackage('nuget install Serilog'), { ecosystem: 'nuget', name: 'Serilog' })
})

test('extractPackage — non-install commands return null', () => {
  assert.strictEqual(extractPackage('ls -la'), null)
  assert.strictEqual(extractPackage('npm install'), null)
  assert.strictEqual(extractPackage('npm ci'), null)
  assert.strictEqual(extractPackage('pip install'), null)
  assert.strictEqual(extractPackage('cargo build'), null)
  assert.strictEqual(extractPackage('bundle install'), null)
  assert.strictEqual(extractPackage('go mod tidy'), null)
})

test('parseSupplyChainScore', () => {
  assert.strictEqual(parseSupplyChainScore('supplyChain: 75'), 75)
  assert.strictEqual(parseSupplyChainScore('supplyChain: 0'), 0)
  assert.strictEqual(parseSupplyChainScore('supplyChain: 15.5'), 15.5)
  assert.strictEqual(parseSupplyChainScore('no score here'), null)
})

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
    for (const cmd of ['npm install', 'npm i', 'npm ci', 'yarn', 'yarn install', 'bun install', 'pnpm install', 'bundle install', 'go mod tidy', 'cargo build']) {
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

  await t.test('allows safe npm package (lodash)', () => {
    const result = parseOutput(runHook(makeInput('npm install lodash')))
    assert.strictEqual(result.decision, 'allow')
  })

  await t.test('allows safe scoped package (@types/node)', () => {
    const result = parseOutput(runHook(makeInput('yarn add @types/node')))
    assert.strictEqual(result.decision, 'allow')
  })

  await t.test('blocks typosquat (browserlist)', () => {
    const result = parseOutput(runHook(makeInput('npm install browserlist')))
    assert.strictEqual(result.decision, 'deny')
    assert.ok(result.reason?.includes('browserlist'), 'reason should mention package name')
    assert.ok(result.reason?.includes('supply chain score'), 'reason should mention the score')
    assert.ok(result.reason?.includes('socket.dev'), 'reason should include review link')
  })

  await t.test('handles versioned npm install', () => {
    const result = parseOutput(runHook(makeInput('npm install express@4.18.2')))
    assert.strictEqual(result.decision, 'allow')
  })

  await t.test('handles pnpm add', () => {
    const result = parseOutput(runHook(makeInput('pnpm add express')))
    assert.strictEqual(result.decision, 'allow')
  })

  await t.test('handles bun add', () => {
    const result = parseOutput(runHook(makeInput('bun add express')))
    assert.strictEqual(result.decision, 'allow')
  })

  await t.test('allows safe PyPI package (requests)', () => {
    const result = parseOutput(runHook(makeInput('pip install requests')))
    assert.strictEqual(result.decision, 'allow')
  })

  await t.test('allows safe cargo crate (serde)', () => {
    const result = parseOutput(runHook(makeInput('cargo add serde')))
    assert.strictEqual(result.decision, 'allow')
  })

  await t.test('allows safe gem (rails)', () => {
    const result = parseOutput(runHook(makeInput('gem install rails')))
    assert.strictEqual(result.decision, 'allow')
  })
})

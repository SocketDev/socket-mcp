import { describe, expect, test } from 'vitest'

import {
  checkPackage,
  extractPackage,
  parseSupplyChainScore,
  stripVersion,
} from '../hooks/socket-gate/index.mts'

// A fetch stub for checkPackage: first call is the MCP `initialize` (must
// return an mcp-session-id header), second is the depscore tool call whose
// body text we control. Keeps the decision logic under test off the network.
function stubFetch(depscoreText: string, isError = false): typeof fetch {
  let call = 0
  return (async () => {
    call += 1
    if (call === 1) {
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'mcp-session-id': 'test-session' }),
        text: async () => '',
      } as Response
    }
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({
        result: {
          isError,
          content: [{ type: 'text', text: depscoreText }],
        },
      }),
    } as Response
  }) as unknown as typeof fetch
}

describe('extractPackage', () => {
  test('npm ecosystem', () => {
    expect(extractPackage('npm install lodash')).toEqual({
      ecosystem: 'npm',
      name: 'lodash',
    })
    expect(extractPackage('npm i express')).toEqual({
      ecosystem: 'npm',
      name: 'express',
    })
    expect(extractPackage('npm add react')).toEqual({
      ecosystem: 'npm',
      name: 'react',
    })
    expect(extractPackage('yarn add vue')).toEqual({
      ecosystem: 'npm',
      name: 'vue',
    })
    expect(extractPackage('pnpm add svelte')).toEqual({
      ecosystem: 'npm',
      name: 'svelte',
    })
    expect(extractPackage('bun add zod')).toEqual({
      ecosystem: 'npm',
      name: 'zod',
    })
    expect(extractPackage('npm install express@4.18.2')).toEqual({
      ecosystem: 'npm',
      name: 'express',
    })
    expect(extractPackage('yarn add @types/node')).toEqual({
      ecosystem: 'npm',
      name: '@types/node',
    })
  })

  test('pypi ecosystem', () => {
    expect(extractPackage('pip install requests')).toEqual({
      ecosystem: 'pypi',
      name: 'requests',
    })
    expect(extractPackage('pip3 install flask')).toEqual({
      ecosystem: 'pypi',
      name: 'flask',
    })
    expect(extractPackage('python -m pip install numpy')).toEqual({
      ecosystem: 'pypi',
      name: 'numpy',
    })
    expect(extractPackage('python3 -m pip install pandas')).toEqual({
      ecosystem: 'pypi',
      name: 'pandas',
    })
    expect(extractPackage('uv add httpx')).toEqual({
      ecosystem: 'pypi',
      name: 'httpx',
    })
    expect(extractPackage('uv pip install fastapi')).toEqual({
      ecosystem: 'pypi',
      name: 'fastapi',
    })
    expect(extractPackage('poetry add pydantic')).toEqual({
      ecosystem: 'pypi',
      name: 'pydantic',
    })
    expect(extractPackage('pipenv install django')).toEqual({
      ecosystem: 'pypi',
      name: 'django',
    })
    expect(extractPackage('pip install requests==2.31.0')).toEqual({
      ecosystem: 'pypi',
      name: 'requests',
    })
    expect(extractPackage('pip install flask>=2.0')).toEqual({
      ecosystem: 'pypi',
      name: 'flask',
    })
  })

  test('cargo ecosystem', () => {
    expect(extractPackage('cargo add serde')).toEqual({
      ecosystem: 'cargo',
      name: 'serde',
    })
    expect(extractPackage('cargo install ripgrep')).toEqual({
      ecosystem: 'cargo',
      name: 'ripgrep',
    })
    expect(extractPackage('cargo add tokio@1.0')).toEqual({
      ecosystem: 'cargo',
      name: 'tokio',
    })
  })

  test('gem ecosystem', () => {
    expect(extractPackage('gem install rails')).toEqual({
      ecosystem: 'gem',
      name: 'rails',
    })
    expect(extractPackage('bundle add rspec')).toEqual({
      ecosystem: 'gem',
      name: 'rspec',
    })
  })

  test('golang ecosystem', () => {
    expect(extractPackage('go get github.com/pkg/errors')).toEqual({
      ecosystem: 'golang',
      name: 'github.com/pkg/errors',
    })
    expect(
      extractPackage('go install github.com/charmbracelet/gum@latest'),
    ).toEqual({ ecosystem: 'golang', name: 'github.com/charmbracelet/gum' })
  })

  test('nuget ecosystem', () => {
    expect(extractPackage('dotnet add package Newtonsoft.Json')).toEqual({
      ecosystem: 'nuget',
      name: 'Newtonsoft.Json',
    })
    expect(extractPackage('nuget install Serilog')).toEqual({
      ecosystem: 'nuget',
      name: 'Serilog',
    })
  })

  test('non-install commands return undefined', () => {
    expect(extractPackage('ls -la')).toBe(undefined)
    expect(extractPackage('npm install')).toBe(undefined)
    expect(extractPackage('npm ci')).toBe(undefined)
    expect(extractPackage('pip install')).toBe(undefined)
    expect(extractPackage('cargo build')).toBe(undefined)
    expect(extractPackage('bundle install')).toBe(undefined)
    expect(extractPackage('go mod tidy')).toBe(undefined)
  })
})

describe('stripVersion', () => {
  test('strips version specifiers per ecosystem', () => {
    expect(stripVersion('express@4.18.2', 'npm')).toBe('express')
    expect(stripVersion('@types/node', 'npm')).toBe('@types/node')
    expect(stripVersion('requests==2.31.0', 'pypi')).toBe('requests')
    expect(stripVersion('flask>=2.0', 'pypi')).toBe('flask')
    expect(stripVersion('tokio@1.0', 'cargo')).toBe('tokio')
    expect(stripVersion('github.com/x/y@latest', 'golang')).toBe(
      'github.com/x/y',
    )
  })
})

describe('parseSupplyChainScore', () => {
  test('parses the supplyChain field', () => {
    expect(parseSupplyChainScore('supplyChain: 75')).toBe(75)
    expect(parseSupplyChainScore('supplyChain: 0')).toBe(0)
    expect(parseSupplyChainScore('supplyChain: 15.5')).toBe(15.5)
    expect(parseSupplyChainScore('no score here')).toBe(undefined)
  })
})

describe('checkPackage (stubbed fetch)', () => {
  test('allows a high-scoring package', async () => {
    const result = await checkPackage(
      'npm',
      'express',
      stubFetch('pkg:npm/express: supplyChain: 97, quality: 0.9'),
    )
    expect(result.decision).toBe('allow')
  })

  test('denies a low-scoring package and explains why', async () => {
    const result = await checkPackage(
      'npm',
      'browserlist',
      stubFetch('pkg:npm/browserlist: supplyChain: 15'),
    )
    expect(result.decision).toBe('deny')
    expect(result.reason).toContain('browserlist')
    expect(result.reason).toContain('supply chain score')
    expect(result.reason).toContain('socket.dev')
  })

  test('throws when the score is unparseable', async () => {
    await expect(
      checkPackage('npm', 'mystery', stubFetch('no score in here')),
    ).rejects.toThrow(/Could not parse supplyChain score/)
  })

  test('throws when the MCP tool reports an error', async () => {
    await expect(
      checkPackage('npm', 'ghost', stubFetch('', true)),
    ).rejects.toThrow(/tool error/)
  })
})

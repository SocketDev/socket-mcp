import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import type { CallToolResult } from '@modelcontextprotocol/client'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import {
  buildToolSpecs,
  createConfiguredServer,
  setStaticApiKey,
} from '../../../lib/server.mts'
import type { ToolCallResult } from '../../../lib/tool-types.mts'

let auditDirectory: string | undefined
let originalAuditLog: string | undefined
let originalAuditSink: string | undefined

function firstText(result: CallToolResult | ToolCallResult): string {
  const { 0: block } = result.content
  return block?.type === 'text' ? block.text : ''
}

afterEach(async () => {
  setStaticApiKey('')
  if (originalAuditLog === undefined) {
    delete process.env['SOCKET_MCP_AUDIT_LOG']
  } else {
    process.env['SOCKET_MCP_AUDIT_LOG'] = originalAuditLog
  }
  if (originalAuditSink === undefined) {
    delete process.env['SOCKET_MCP_AUDIT_SINK']
  } else {
    process.env['SOCKET_MCP_AUDIT_SINK'] = originalAuditSink
  }
  originalAuditSink = undefined
  originalAuditLog = undefined
  const temporaryAuditDirectory = auditDirectory
  auditDirectory = undefined
  if (temporaryAuditDirectory) {
    await rm(temporaryAuditDirectory, { recursive: true, force: true })
  }
})

beforeEach(async () => {
  originalAuditLog = process.env['SOCKET_MCP_AUDIT_LOG']
  originalAuditSink = process.env['SOCKET_MCP_AUDIT_SINK']
  process.env['SOCKET_MCP_AUDIT_SINK'] = 'jsonl'
  const temporaryAuditDirectory = await mkdtemp(
    path.join(os.tmpdir(), 'socket-mcp-tool-validation-'),
  )
  auditDirectory = temporaryAuditDirectory
  process.env['SOCKET_MCP_AUDIT_LOG'] = path.join(
    temporaryAuditDirectory,
    'audit.jsonl',
  )
})

describe('tool argument validation over MCP transport', () => {
  test('rejects malformed arguments for every tool before handler execution', async () => {
    const server = createConfiguredServer()
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair()
    const client = new Client(
      { name: 'tool-validation-test', version: '0.0.0' },
      { capabilities: {} },
    )

    try {
      await server.connect(serverTransport)
      await client.connect(clientTransport)
      const names = buildToolSpecs().map(spec => spec.name)
      for (const name of names) {
        const result = await client.callTool({
          name,
          arguments: { unexpected: 'synthetic-value' },
        })
        expect(result.isError).toBe(true)
        expect(firstText(result)).toMatch(/^Invalid tool arguments\./u)
        expect(firstText(result)).not.toContain('synthetic-value')
      }
    } finally {
      try {
        await client.close()
      } finally {
        await server.close()
      }
    }
  })

  test('valid organizations arguments reach the existing auth check', async () => {
    const server = createConfiguredServer()
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair()
    const client = new Client(
      { name: 'tool-validation-test', version: '0.0.0' },
      { capabilities: {} },
    )

    try {
      await server.connect(serverTransport)
      await client.connect(clientTransport)
      const result = await client.callTool({
        name: 'organizations',
        arguments: {},
      })
      expect(result.isError).toBe(true)
      expect(firstText(result)).toMatch(/Authentication is required/u)
      const omittedArguments = await client.callTool({
        name: 'organizations',
      })
      expect(omittedArguments.isError).toBe(true)
      expect(firstText(omittedArguments)).toMatch(/Authentication is required/u)
      const omittedRequiredArguments = await client.callTool({
        name: 'alerts',
      })
      expect(omittedRequiredArguments.isError).toBe(true)
      expect(firstText(omittedRequiredArguments)).toMatch(
        /^Invalid tool arguments\./u,
      )
    } finally {
      try {
        await client.close()
      } finally {
        await server.close()
      }
    }
  })
})

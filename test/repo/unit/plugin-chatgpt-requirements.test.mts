import { readFileSync } from 'node:fs'
import path from 'node:path'

import { isPlainObject } from '@socketsecurity/lib-stable/objects/predicates'
import { describe, expect, test } from 'vitest'

import {
  createZipArchive,
  extractZipArchive,
} from '../../../scripts/fleet/artifact/zip.mts'
import {
  chatgptManifestVersion,
  checkChatgptIcon,
  checkChatgptMcpConfig,
  ICON_ENTRY_NAME,
  inspectChatgptPluginPackage,
  MCP_CONFIG_NAME,
  PLUGIN_MANIFEST_NAME,
} from '../../../scripts/repo/plugin/chatgpt/requirements.mts'
import type { ChatgptPluginFindings } from '../../../scripts/repo/plugin/chatgpt/requirements.mts'

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..')
const pluginDir = path.join(repoRoot, 'plugins', 'chatgpt')

function readShippedPackage() {
  return {
    iconBytes: readFileSync(path.join(pluginDir, 'assets', 'icon.png')),
    mcpJson: readFileSync(path.join(pluginDir, MCP_CONFIG_NAME), 'utf8'),
    pluginJson: readFileSync(
      path.join(pluginDir, PLUGIN_MANIFEST_NAME),
      'utf8',
    ),
  }
}

function squarePng(pixels: number, height = pixels): Buffer {
  const bytes = Buffer.alloc(24)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0)
  bytes.writeUInt32BE(pixels, 16)
  bytes.writeUInt32BE(height, 20)
  return bytes
}

function emptyFindings(): ChatgptPluginFindings {
  return { errors: [], warnings: [] }
}

function parseRecord(json: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(json)
  if (!isPlainObject(parsed)) {
    throw new Error('Fixture JSON is not an object.')
  }
  return parsed
}

function objectAt(
  node: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value = node[key]
  if (!isPlainObject(value)) {
    throw new Error(`Fixture holds no object at ${key}.`)
  }
  return value
}

function arrayAt(node: Record<string, unknown>, key: string): unknown[] {
  const value = node[key]
  if (!Array.isArray(value)) {
    throw new Error(`Fixture holds no array at ${key}.`)
  }
  return value
}

function openaiBlock(manifest: Record<string, unknown>) {
  return objectAt(objectAt(manifest, 'extensions'), 'com.openai')
}

function openaiInterface(manifest: Record<string, unknown>) {
  return objectAt(openaiBlock(manifest), 'interface')
}

function openaiReview(manifest: Record<string, unknown>) {
  return objectAt(openaiBlock(manifest), 'review')
}

function reviewCases(
  manifest: Record<string, unknown>,
  kind: 'negative' | 'positive',
): unknown[] {
  return arrayAt(objectAt(openaiReview(manifest), 'test_cases'), kind)
}

function withManifest(
  mutate: (manifest: Record<string, unknown>) => void,
): string {
  const manifest = parseRecord(readShippedPackage().pluginJson)
  mutate(manifest)
  return JSON.stringify(manifest)
}

describe('the shipped ChatGPT package', () => {
  test('has no structural errors', () => {
    const findings = inspectChatgptPluginPackage(readShippedPackage())
    expect(findings.errors).toStrictEqual([])
  })

  test('warns only that the demo recording is missing', () => {
    const findings = inspectChatgptPluginPackage(readShippedPackage())
    expect(findings.warnings).toHaveLength(1)
    expect(findings.warnings[0]).toContain('demo_recording_url')
  })

  test('stops warning once a demo recording URL is set', () => {
    const pluginJson = withManifest(manifest => {
      openaiReview(manifest)['demo_recording_url'] =
        'https://example.com/socket-plugin-walkthrough'
    })
    const findings = inspectChatgptPluginPackage({
      ...readShippedPackage(),
      pluginJson,
    })
    expect(findings.errors).toStrictEqual([])
    expect(findings.warnings).toStrictEqual([])
  })
})

describe('listing metadata limits', () => {
  test('rejects a short description over 30 characters', () => {
    const pluginJson = withManifest(manifest => {
      openaiInterface(manifest)['shortDescription'] =
        'Check dependency security posture continuously'
    })
    const findings = inspectChatgptPluginPackage({
      ...readShippedPackage(),
      pluginJson,
    })
    expect(findings.errors.join('\n')).toContain('shortDescription')
  })

  test('rejects a listing URL that is not HTTPS', () => {
    const pluginJson = withManifest(manifest => {
      openaiInterface(manifest)['privacyPolicyURL'] =
        'http://socket.dev/privacy'
    })
    const findings = inspectChatgptPluginPackage({
      ...readShippedPackage(),
      pluginJson,
    })
    expect(findings.errors.join('\n')).toContain('privacyPolicyURL')
  })

  test('rejects a missing OpenAI extension block', () => {
    const pluginJson = withManifest(manifest => {
      delete objectAt(manifest, 'extensions')['com.openai']
    })
    const findings = inspectChatgptPluginPackage({
      ...readShippedPackage(),
      pluginJson,
    })
    expect(findings.errors.join('\n')).toContain('com.openai')
  })
})

describe('a blank string reads as absent', () => {
  test('still warns when demo_recording_url is empty', () => {
    const pluginJson = withManifest(manifest => {
      openaiReview(manifest)['demo_recording_url'] = ''
    })
    const findings = inspectChatgptPluginPackage({
      ...readShippedPackage(),
      pluginJson,
    })
    expect(findings.warnings.join('\n')).toContain('demo_recording_url')
  })

  test('rejects a blank review-case field', () => {
    const pluginJson = withManifest(manifest => {
      const firstCase = reviewCases(manifest, 'positive')[0]
      if (!isPlainObject(firstCase)) {
        throw new Error('Fixture holds no first positive case.')
      }
      firstCase['expected_behavior'] = ''
    })
    const findings = inspectChatgptPluginPackage({
      ...readShippedPackage(),
      pluginJson,
    })
    expect(findings.errors.join('\n')).toContain('expected_behavior')
  })

  test('rejects a blank capability entry', () => {
    const pluginJson = withManifest(manifest => {
      const capabilities = arrayAt(openaiInterface(manifest), 'capabilities')
      capabilities[0] = ''
    })
    const findings = inspectChatgptPluginPackage({
      ...readShippedPackage(),
      pluginJson,
    })
    expect(findings.errors.join('\n')).toContain('capabilities[0]')
  })

  test('rejects a blank category', () => {
    const pluginJson = withManifest(manifest => {
      openaiInterface(manifest)['category'] = ''
    })
    const findings = inspectChatgptPluginPackage({
      ...readShippedPackage(),
      pluginJson,
    })
    expect(findings.errors.join('\n')).toContain('category')
  })
})

describe('review test cases', () => {
  test('requires exactly five positive cases', () => {
    const pluginJson = withManifest(manifest => {
      reviewCases(manifest, 'positive').pop()
    })
    const findings = inspectChatgptPluginPackage({
      ...readShippedPackage(),
      pluginJson,
    })
    expect(findings.errors.join('\n')).toContain('exactly 5')
  })

  test('requires exactly three negative cases', () => {
    const pluginJson = withManifest(manifest => {
      reviewCases(manifest, 'negative').push({
        description: 'Spurious extra case',
        prompt: 'Delete every dependency in my project.',
      })
    })
    const findings = inspectChatgptPluginPackage({
      ...readShippedPackage(),
      pluginJson,
    })
    expect(findings.errors.join('\n')).toContain('exactly 3')
  })

  test('requires the tools_triggered field on a positive case', () => {
    const pluginJson = withManifest(manifest => {
      const firstCase = reviewCases(manifest, 'positive')[0]
      if (!isPlainObject(firstCase)) {
        throw new Error('Fixture holds no first positive case.')
      }
      delete firstCase['tools_triggered']
    })
    const findings = inspectChatgptPluginPackage({
      ...readShippedPackage(),
      pluginJson,
    })
    expect(findings.errors.join('\n')).toContain('tools_triggered')
  })
})

describe('checkChatgptMcpConfig', () => {
  test('accepts a credential-free streamable HTTP server', () => {
    const findings = emptyFindings()
    checkChatgptMcpConfig(parseRecord(readShippedPackage().mcpJson), findings)
    expect(findings.errors).toStrictEqual([])
  })

  test('rejects a headers block, which would ship a credential', () => {
    const config = parseRecord(readShippedPackage().mcpJson)
    objectAt(objectAt(config, 'mcpServers'), 'socket')['headers'] = {
      authorization: 'Bearer placeholder-not-a-real-token',
    }
    const findings = emptyFindings()
    checkChatgptMcpConfig(config, findings)
    expect(findings.errors.join('\n')).toContain('headers')
  })

  test('rejects a plaintext HTTP server URL', () => {
    const config = parseRecord(readShippedPackage().mcpJson)
    objectAt(objectAt(config, 'mcpServers'), 'socket')['url'] =
      'http://mcp.socket.dev/'
    const findings = emptyFindings()
    checkChatgptMcpConfig(config, findings)
    expect(findings.errors.join('\n')).toContain('HTTPS')
  })
})

describe('checkChatgptIcon', () => {
  test('accepts a square 512 pixel PNG', () => {
    const findings = emptyFindings()
    checkChatgptIcon(squarePng(512), findings)
    expect(findings.errors).toStrictEqual([])
  })

  test('rejects a non-PNG asset', () => {
    const findings = emptyFindings()
    checkChatgptIcon(Buffer.from('this is not a png file at all'), findings)
    expect(findings.errors.join('\n')).toContain('not a PNG')
  })

  test('rejects a rectangular icon', () => {
    const findings = emptyFindings()
    checkChatgptIcon(squarePng(512, 256), findings)
    expect(findings.errors.join('\n')).toContain('square')
  })

  test('rejects an icon below the 48 pixel minimum', () => {
    const findings = emptyFindings()
    checkChatgptIcon(squarePng(32), findings)
    expect(findings.errors.join('\n')).toContain('minimum')
  })
})

describe('chatgptManifestVersion', () => {
  test('reads the declared version', () => {
    expect(chatgptManifestVersion('{"version":"1.2.3"}')).toBe('1.2.3')
  })

  test('falls back for unparseable JSON', () => {
    expect(chatgptManifestVersion('{ not json')).toBe('0.0.0')
  })
})

describe('the upload archive', () => {
  test('round-trips the three package entries at the archive root', () => {
    const sources = readShippedPackage()
    const archive = createZipArchive([
      {
        name: PLUGIN_MANIFEST_NAME,
        data: Buffer.from(sources.pluginJson, 'utf8'),
      },
      { name: MCP_CONFIG_NAME, data: Buffer.from(sources.mcpJson, 'utf8') },
      { name: ICON_ENTRY_NAME, data: sources.iconBytes },
    ])
    const entries = extractZipArchive(archive)
    expect(entries.map(entry => entry.name)).toStrictEqual([
      PLUGIN_MANIFEST_NAME,
      MCP_CONFIG_NAME,
      ICON_ENTRY_NAME,
    ])
    const manifestEntry = entries.find(
      entry => entry.name === PLUGIN_MANIFEST_NAME,
    )
    expect(manifestEntry?.data.toString('utf8')).toBe(sources.pluginJson)
    const iconEntry = entries.find(entry => entry.name === ICON_ENTRY_NAME)
    expect(iconEntry?.data.equals(sources.iconBytes)).toBe(true)
  })
})

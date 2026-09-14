import process from 'node:process'

import { describe, expect, test } from 'vitest'

import {
  buildMcpUserAgent,
  prependMcpUserAgent,
} from '../../lib/user-agent.mts'
import { VERSION } from '../../lib/version.mts'

const BASE_USER_AGENT = `socket-mcp/${VERSION} node/${process.version} ${process.platform}/${process.arch}`

describe('buildMcpUserAgent', () => {
  test('appends the sanitized inbound client user agent', () => {
    expect(buildMcpUserAgent(' client/1\r\nproxy/2\t')).toBe(
      `${BASE_USER_AGENT} client/1 proxy/2`,
    )
  })

  test('omits an empty inbound client user agent', () => {
    expect(buildMcpUserAgent('\r\n\t')).toBe(BASE_USER_AGENT)
  })
})

test('prependMcpUserAgent preserves the leading internal identity', () => {
  expect(prependMcpUserAgent('socket-internal-tool/1', BASE_USER_AGENT)).toBe(
    `socket-internal-tool/1 ${BASE_USER_AGENT}`,
  )
})

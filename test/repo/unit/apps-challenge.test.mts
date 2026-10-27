import process from 'node:process'

import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import {
  isAppsChallengeRequest,
  OPENAI_APPS_CHALLENGE_PATH,
  writeAppsChallenge,
} from '../../../lib/apps-challenge.mts'
import { routeRequest } from '../../../lib/http-server.mts'
import {
  makeRes,
  plainReq,
  recordingMcpHandler,
} from './http-server-fixtures.mts'

const TOKEN_ENV = 'SOCKET_MCP_APPS_CHALLENGE_TOKEN'
// A portal-issued token is an opaque string; this stands in for one and is
// not a credential.
const SAMPLE_TOKEN = 'openai-apps-challenge-sample-value'

let saved: string | undefined

beforeEach(() => {
  saved = process.env[TOKEN_ENV]
  delete process.env[TOKEN_ENV]
})

afterEach(() => {
  if (saved === undefined) {
    delete process.env[TOKEN_ENV]
  } else {
    process.env[TOKEN_ENV] = saved
  }
})

describe('isAppsChallengeRequest', () => {
  test('matches a GET of the challenge path', () => {
    expect(isAppsChallengeRequest('GET', OPENAI_APPS_CHALLENGE_PATH)).toBe(true)
  })

  test('matches a HEAD of the challenge path', () => {
    expect(isAppsChallengeRequest('HEAD', OPENAI_APPS_CHALLENGE_PATH)).toBe(
      true,
    )
  })

  test('rejects a write method on the challenge path', () => {
    expect(isAppsChallengeRequest('POST', OPENAI_APPS_CHALLENGE_PATH)).toBe(
      false,
    )
    expect(isAppsChallengeRequest('DELETE', OPENAI_APPS_CHALLENGE_PATH)).toBe(
      false,
    )
  })

  test('rejects a neighbouring well-known path', () => {
    expect(
      isAppsChallengeRequest('GET', '/.well-known/oauth-protected-resource'),
    ).toBe(false)
    expect(
      isAppsChallengeRequest('GET', `${OPENAI_APPS_CHALLENGE_PATH}/extra`),
    ).toBe(false)
  })
})

describe('writeAppsChallenge', () => {
  test('declines when no token is configured', () => {
    const { captured, res } = makeRes()
    expect(writeAppsChallenge(res, 'GET')).toBe(false)
    expect(captured.statusCode).toBeUndefined()
    expect(captured.body).toBeUndefined()
  })

  test('returns the token alone as plain text', () => {
    process.env[TOKEN_ENV] = SAMPLE_TOKEN
    const { captured, res } = makeRes()
    expect(writeAppsChallenge(res, 'GET')).toBe(true)
    expect(captured.statusCode).toBe(200)
    expect(captured.body).toBe(SAMPLE_TOKEN)
    expect(captured.headers['Content-Type']).toBe('text/plain; charset=utf-8')
  })

  test('adds no newline, envelope, or whitespace to the token', () => {
    process.env[TOKEN_ENV] = SAMPLE_TOKEN
    const { captured, res } = makeRes()
    writeAppsChallenge(res, 'GET')
    expect(captured.body).not.toContain('\n')
    expect(captured.body).not.toContain('{')
    expect(captured.body?.trim()).toBe(captured.body)
    expect(captured.headers['Content-Length']).toBe(
      String(Buffer.byteLength(SAMPLE_TOKEN)),
    )
  })

  test('answers HEAD with the headers and no body', () => {
    process.env[TOKEN_ENV] = SAMPLE_TOKEN
    const { captured, res } = makeRes()
    expect(writeAppsChallenge(res, 'HEAD')).toBe(true)
    expect(captured.statusCode).toBe(200)
    expect(captured.body).toBeUndefined()
    expect(captured.headers['Content-Type']).toBe('text/plain; charset=utf-8')
  })
})

describe('routeRequest serving the challenge', () => {
  test('answers the portal probe, which sends no Origin and no credential', async () => {
    process.env[TOKEN_ENV] = SAMPLE_TOKEN
    const { calls, handler } = recordingMcpHandler()
    const { captured, res } = makeRes()
    await routeRequest(
      handler,
      plainReq({
        url: OPENAI_APPS_CHALLENGE_PATH,
        method: 'GET',
        headers: { host: 'mcp.socket.dev' },
      }),
      res,
      3000,
    )
    expect(captured.statusCode).toBe(200)
    expect(captured.body).toBe(SAMPLE_TOKEN)
    expect(calls).toHaveLength(0)
  })

  test('serves the ordinary 404 when no token is configured', async () => {
    const { handler } = recordingMcpHandler()
    const { captured, res } = makeRes()
    await routeRequest(
      handler,
      plainReq({
        url: OPENAI_APPS_CHALLENGE_PATH,
        method: 'GET',
        headers: { host: 'mcp.socket.dev' },
      }),
      res,
      3000,
    )
    expect(captured.statusCode).toBe(404)
    expect(captured.body).toBe('Not found')
  })

  test('does not serve the token on a write method', async () => {
    process.env[TOKEN_ENV] = SAMPLE_TOKEN
    const { handler } = recordingMcpHandler()
    const { captured, res } = makeRes()
    await routeRequest(
      handler,
      plainReq({
        url: OPENAI_APPS_CHALLENGE_PATH,
        method: 'POST',
        headers: { host: 'mcp.socket.dev' },
      }),
      res,
      3000,
    )
    expect(captured.body).not.toBe(SAMPLE_TOKEN)
  })
})

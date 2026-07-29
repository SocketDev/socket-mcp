/**
 * @file RouteRequest behavior on an OAuth-ENABLED deployment: the RFC 9728
 *   protected-resource metadata endpoint, and the bearer pipeline standing
 *   between a request and the MCP handler. OAuth settings are read at module
 *   init, so each case stubs the env and re-imports the module pair.
 */

import nock from 'nock'
import { describe, expect, test, vi } from 'vitest'

import {
  bodyReq,
  makeRes,
  plainReq,
  recordingMcpHandler,
} from './http-server-fixtures.mts'

describe('routeRequest with OAuth enabled', () => {
  test('an OAuth-enabled server challenges a sktsec_ token instead of trusting the prefix', async () => {
    const issuer = 'https://issuer.example.test'
    vi.stubEnv('SOCKET_OAUTH_ISSUER', issuer)
    vi.stubEnv('SOCKET_OAUTH_INTROSPECTION_CLIENT_ID', 'introspection-client')
    vi.stubEnv(
      'SOCKET_OAUTH_INTROSPECTION_CLIENT_SECRET',
      'introspection-secret',
    )
    vi.resetModules()
    nock.disableNetConnect()
    try {
      // OAuth config is read at module init, so the enabled server needs a
      // freshly-evaluated module pair.
      const oauth = await import('../../lib/oauth.ts')
      const server = await import('../../lib/http-server.ts')
      expect(oauth.setOauthEnabled()).toEqual({ issuer })

      nock(issuer)
        .get('/.well-known/oauth-authorization-server')
        .reply(200, {
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          introspection_endpoint: `${issuer}/introspect`,
        })
      nock(issuer).post('/introspect').reply(200, { active: false })

      const { captured, res } = makeRes()
      const { calls, handler } = recordingMcpHandler()
      await server.routeRequest(
        handler,
        bodyReq('{"jsonrpc":"2.0","method":"tools/list","id":1}', {
          headers: { authorization: 'Bearer sktsec_zzzz' },
        }),
        res,
        3000,
      )

      // The prefix buys nothing: the token went through introspection and
      // came back inactive, so the caller gets a challenge, not a 200.
      expect(captured.statusCode).toBe(401)
      expect(captured.headers['WWW-Authenticate']).toMatch(
        /error="invalid_token"/,
      )
      expect(calls).toHaveLength(0)
    } finally {
      nock.cleanAll()
      nock.enableNetConnect()
      vi.unstubAllEnvs()
      vi.resetModules()
    }
  })

  test('an unreachable issuer answers 500 instead of taking the process down', async () => {
    const issuer = 'https://issuer.example.test'
    vi.stubEnv('SOCKET_OAUTH_ISSUER', issuer)
    vi.stubEnv('SOCKET_OAUTH_INTROSPECTION_CLIENT_ID', 'introspection-client')
    vi.stubEnv(
      'SOCKET_OAUTH_INTROSPECTION_CLIENT_SECRET',
      'introspection-secret',
    )
    vi.resetModules()
    nock.disableNetConnect()
    try {
      const oauth = await import('../../lib/oauth.ts')
      const server = await import('../../lib/http-server.ts')
      expect(oauth.setOauthEnabled()).toEqual({ issuer })
      // Every discovery candidate fails, so loadOAuthMetadata rejects rather
      // than resolving undefined.
      nock(issuer)
        .get(/\.well-known/u)
        .times(3)
        .reply(500)

      const { captured, res } = makeRes()
      const { calls, handler } = recordingMcpHandler()
      await expect(
        server.routeRequest(
          handler,
          plainReq({
            url: '/.well-known/oauth-protected-resource',
            method: 'GET',
            headers: { host: 'localhost:3000' },
          }),
          res,
          3000,
        ),
      ).resolves.toBeUndefined()

      expect(captured.statusCode).toBe(500)
      expect(JSON.parse(captured.body!)).toEqual({
        error: 'server_error',
        error_description: 'OAuth metadata is unavailable',
      })
      expect(calls).toHaveLength(0)
    } finally {
      nock.cleanAll()
      nock.enableNetConnect()
      vi.unstubAllEnvs()
      vi.resetModules()
    }
  })

  test('an OAuth-enabled server publishes RFC 9728 protected-resource metadata', async () => {
    const issuer = 'https://issuer.example.test'
    vi.stubEnv('SOCKET_OAUTH_ISSUER', issuer)
    vi.stubEnv('SOCKET_OAUTH_INTROSPECTION_CLIENT_ID', 'introspection-client')
    vi.stubEnv(
      'SOCKET_OAUTH_INTROSPECTION_CLIENT_SECRET',
      'introspection-secret',
    )
    vi.resetModules()
    nock.disableNetConnect()
    try {
      const oauth = await import('../../lib/oauth.ts')
      const server = await import('../../lib/http-server.ts')
      expect(oauth.setOauthEnabled()).toEqual({ issuer })
      nock(issuer)
        .get('/.well-known/oauth-authorization-server')
        .reply(200, {
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          introspection_endpoint: `${issuer}/introspect`,
        })

      const { captured, res } = makeRes()
      const { calls, handler } = recordingMcpHandler()
      await server.routeRequest(
        handler,
        plainReq({
          url: '/.well-known/oauth-protected-resource',
          method: 'GET',
          headers: { host: 'localhost:3000' },
        }),
        res,
        3000,
      )

      expect(captured.statusCode).toBe(200)
      // The published `resource` is the request's own base URL, so the
      // audience clients request is exactly the one introspection checks.
      expect(JSON.parse(captured.body!)).toEqual({
        resource: 'http://localhost:3000/',
        authorization_servers: [issuer],
        scopes_supported: [],
        bearer_methods_supported: ['header'],
        resource_name: 'Socket MCP Server',
      })
      // The metadata endpoint answers on its own; nothing reaches MCP.
      expect(calls).toHaveLength(0)
    } finally {
      nock.cleanAll()
      nock.enableNetConnect()
      vi.unstubAllEnvs()
      vi.resetModules()
    }
  })

  test('an OAuth-enabled server dispatches a request whose token passes introspection', async () => {
    const issuer = 'https://issuer.example.test'
    vi.stubEnv('SOCKET_OAUTH_ISSUER', issuer)
    vi.stubEnv('SOCKET_OAUTH_INTROSPECTION_CLIENT_ID', 'introspection-client')
    vi.stubEnv(
      'SOCKET_OAUTH_INTROSPECTION_CLIENT_SECRET',
      'introspection-secret',
    )
    vi.resetModules()
    nock.disableNetConnect()
    try {
      const oauth = await import('../../lib/oauth.ts')
      const server = await import('../../lib/http-server.ts')
      expect(oauth.setOauthEnabled()).toEqual({ issuer })
      nock(issuer)
        .get('/.well-known/oauth-authorization-server')
        .reply(200, {
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          introspection_endpoint: `${issuer}/introspect`,
        })
      nock(issuer).post('/introspect').reply(200, {
        active: true,
        aud: 'http://localhost:3000/',
        client_id: 'downstream-client',
        scope: 'packages:list',
      })

      const { res } = makeRes()
      const { calls, handler } = recordingMcpHandler()
      await server.routeRequest(
        handler,
        bodyReq('{"jsonrpc":"2.0","method":"tools/list","id":1}', {
          headers: { authorization: 'Bearer good-token' },
        }),
        res,
        3000,
      )

      // The introspected AuthInfo — not the raw header — is what the tool
      // layer sees.
      expect(calls).toHaveLength(1)
      expect(calls[0]!.auth?.token).toBe('good-token')
    } finally {
      nock.cleanAll()
      nock.enableNetConnect()
      vi.unstubAllEnvs()
      vi.resetModules()
    }
  })
})

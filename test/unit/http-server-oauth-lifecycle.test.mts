import nock from 'nock'
import { expect, test, vi } from 'vitest'

import {
  bodyReq,
  makeRes,
  plainReq,
  recordingMcpHandler,
} from './http-server-fixtures.mts'

test.each(['revoked', 'expired'] as const)(
  'OAuth credentials can be reused and replaced after becoming %s',
  async rejection => {
    const issuer = 'https://issuer.example.test'
    const resource = 'http://localhost:3000/'
    const metadataPath = '.well-known/oauth-protected-resource'
    const now = 1_800_000_000
    vi.stubEnv('SOCKET_OAUTH_ISSUER', issuer)
    vi.stubEnv('SOCKET_OAUTH_INTROSPECTION_CLIENT_ID', 'introspection-client')
    vi.stubEnv(
      'SOCKET_OAUTH_INTROSPECTION_CLIENT_SECRET',
      'introspection-secret',
    )
    vi.spyOn(Date, 'now').mockReturnValue(now * 1000)
    vi.resetModules()
    nock.disableNetConnect()
    try {
      const oauth = await import('../../lib/oauth.ts')
      const server = await import('../../lib/http-server.ts')
      expect(oauth.setOauthEnabled()).toEqual({ issuer })
      const discovery = nock(issuer)
        .get('/.well-known/oauth-authorization-server')
        .reply(200, {
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          introspection_endpoint: `${issuer}/introspect`,
        })
      const { calls, handler } = recordingMcpHandler()
      async function request(token?: string | undefined) {
        const { captured, res } = makeRes()
        await server.routeRequest(
          handler,
          bodyReq('{"jsonrpc":"2.0","method":"tools/list","id":1}', {
            headers: token ? { authorization: `Bearer ${token}` } : {},
          }),
          res,
          3000,
        )
        return captured
      }

      const initial = await request()
      expect(initial.statusCode).toBe(401)
      expect(initial.headers['WWW-Authenticate']).toContain(
        `resource_metadata="${resource}${metadataPath}"`,
      )
      expect(calls).toHaveLength(0)

      const active = {
        active: true,
        aud: resource,
        client_id: 'example-client',
        exp: now + 60,
      }
      const reuse = nock(issuer)
        .post('/introspect', 'token=example-access-token')
        .twice()
        .reply(200, active)
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const accepted = await request('example-access-token')
        expect(accepted.headers['WWW-Authenticate']).toBeUndefined()
        expect(calls).toHaveLength(attempt + 1)
      }
      expect(reuse.isDone()).toBe(true)

      const invalid = nock(issuer)
        .post('/introspect', 'token=example-access-token')
        .reply(
          200,
          rejection === 'revoked' ? { active: false } : { ...active, exp: now },
        )
      const rejected = await request('example-access-token')
      expect(rejected.statusCode).toBe(401)
      expect(rejected.headers['WWW-Authenticate']).toContain(
        'error="invalid_token"',
      )
      expect(rejected.headers['WWW-Authenticate']).toContain(
        `resource_metadata="${resource}${metadataPath}"`,
      )
      expect(calls).toHaveLength(2)
      expect(invalid.isDone()).toBe(true)

      const metadata = makeRes()
      await server.routeRequest(
        handler,
        plainReq({
          url: `/${metadataPath}`,
          method: 'GET',
          headers: { host: 'localhost:3000' },
        }),
        metadata.res,
        3000,
      )
      expect(metadata.captured.statusCode).toBe(200)
      expect(JSON.parse(metadata.captured.body!)).toMatchObject({
        resource,
        authorization_servers: [issuer],
      })

      const replacement = nock(issuer)
        .post('/introspect', 'token=example-replacement-token')
        .reply(200, active)
      const restored = await request('example-replacement-token')
      expect(restored.headers['WWW-Authenticate']).toBeUndefined()
      expect(calls).toHaveLength(3)
      expect(calls[2]!.auth?.token).toBe('example-replacement-token')
      expect(replacement.isDone()).toBe(true)
      expect(discovery.isDone()).toBe(true)
    } finally {
      nock.cleanAll()
      nock.enableNetConnect()
      vi.restoreAllMocks()
      vi.unstubAllEnvs()
      vi.resetModules()
    }
  },
)

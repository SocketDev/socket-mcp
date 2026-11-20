import { once } from 'node:events'
import { createServer } from 'node:http'

function sendJson(
  response: import('node:http').ServerResponse,
  body: Record<string, unknown>,
): void {
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

async function readBody(request: import('node:http').IncomingMessage) {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk))
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<
    string,
    unknown
  >
}

export async function createTestIssuer(
  options: { tokenEndpoint?: string } = {},
) {
  const server = createServer(async (request, response) => {
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Expected the fake OAuth issuer to listen on TCP')
    }
    const baseUrl = 'http://127.0.0.1:' + address.port + '/'
    if (request.url === '/.well-known/oauth-protected-resource') {
      sendJson(response, {
        resource: baseUrl,
        authorization_servers: [baseUrl.slice(0, -1)],
        scopes_supported: ['packages:list', 'alerts:list', 'threat-feed:list'],
      })
      return
    }
    if (request.url === '/.well-known/oauth-authorization-server') {
      sendJson(response, {
        issuer: baseUrl.slice(0, -1),
        authorization_endpoint: baseUrl + 'authorize',
        registration_endpoint: baseUrl + 'register',
        introspection_endpoint: baseUrl + 'introspect',
        token_endpoint: options.tokenEndpoint ?? baseUrl + 'token',
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      })
      return
    }
    if (request.method === 'POST' && request.url === '/register') {
      const registration = await readBody(request)
      sendJson(response, {
        client_id: 'loopback-test-client',
        redirect_uris: registration['redirect_uris'],
        grant_types: registration['grant_types'],
        response_types: registration['response_types'],
        token_endpoint_auth_method: 'none',
      })
      return
    }
    if (request.method === 'POST' && request.url === '/token') {
      sendJson(response, {
        access_token: 'loopback-access-token',
        refresh_token: 'loopback-refresh-token',
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'packages:list alerts:list threat-feed:list',
      })
      return
    }
    response.writeHead(404).end()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Expected the fake OAuth issuer to listen on TCP')
  }
  return { server, url: 'http://127.0.0.1:' + address.port }
}

/**
 * @file Browser sign-in for local stdio clients. The saved OAuth session is
 *   private to the current user and is refreshed before an access token
 *   expires.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { promises as fs, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { isIP } from 'node:net'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

import { httpRequest } from '@socketsecurity/lib/http-request/request'

import { getSocketApiUrl } from './env.mts'
import { parseJsonObject } from './http.mts'
import { logger } from './logger.mts'

const DEFAULT_OAUTH_BASE_URL = 'https://api.socket.dev'
const OAUTH_BASE_URL_ENV = 'SOCKET_MCP_OAUTH_BASE_URL'
const PROTECTED_RESOURCE_METADATA_PATH = '/.well-known/oauth-protected-resource'
const AUTHORIZATION_SERVER_METADATA_PATH =
  '/.well-known/oauth-authorization-server'
const REQUIRED_SCOPES = ['packages:list', 'alerts:list', 'threat-feed:list']
const REQUEST_TIMEOUT_MS = 20_000
const SIGN_IN_TIMEOUT_MS = 5 * 60_000
const RESPONSE_LIMIT_BYTES = 256 * 1024
const LOCK_TIMEOUT_MS = 60_000
const LOCK_INITIALIZATION_GRACE_MS = 5_000
const OAUTH_FILE = 'oauth.json'

interface LocalOAuthMetadata {
  issuer: string
  resource: string
  authorizationEndpoint: string
  registrationEndpoint: string
  tokenEndpoint: string
  revocationEndpoint: string | undefined
}

interface LocalOAuthCredentials {
  version: 1
  issuer: string
  resource: string
  clientId: string
  accessToken: string
  refreshToken: string | undefined
  expiresAt: number
  scopes: string[]
  tokenEndpoint: string
  revocationEndpoint: string | undefined
}

export interface LocalOAuthSession {
  readonly accessToken: string
  readonly expiresAt: number
}

function sessionDirectory(): string {
  const dataHome = process.env['XDG_DATA_HOME']
  if (dataHome && path.isAbsolute(dataHome)) {
    return path.join(dataHome, 'socket-mcp')
  }
  if (process.platform === 'win32') {
    return path.join(
      process.env['LOCALAPPDATA'] ||
        path.join(os.homedir(), 'AppData', 'Local'),
      'SocketMcp',
    )
  }
  if (process.platform === 'darwin') {
    return path.join(
      os.homedir(),
      'Library',
      'Application Support',
      'SocketMcp',
    )
  }
  return path.join(os.homedir(), '.local', 'share', 'socket-mcp')
}

function credentialPath(): string {
  return path.join(sessionDirectory(), OAUTH_FILE)
}

function oauthError(message: string): Error {
  return new Error(`Socket MCP browser sign-in: ${message}`)
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/u, '')
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return true
  }
  const address = host.replace(/^\[|\]$/gu, '')
  if (isIP(address) === 4) {
    return Number.parseInt(address.split('.')[0]!, 10) === 127
  }
  return address === '::1'
}

function isSecureOrLoopback(url: URL): boolean {
  return (
    url.protocol === 'https:' ||
    (url.protocol === 'http:' && isLoopbackHost(url.hostname))
  )
}

function configuredOAuthTarget(): { issuer: string; resource: string } {
  const configuredBaseUrl =
    process.env[OAUTH_BASE_URL_ENV] ||
    getSocketApiUrl() ||
    DEFAULT_OAUTH_BASE_URL
  let baseUrl: URL
  try {
    baseUrl = new URL(configuredBaseUrl)
  } catch {
    throw oauthError(`${OAUTH_BASE_URL_ENV} must be a valid URL.`)
  }
  if (
    !isSecureOrLoopback(baseUrl) ||
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.search ||
    baseUrl.hash
  ) {
    throw oauthError(
      `${OAUTH_BASE_URL_ENV} must use HTTPS, except for loopback HTTP URLs, and cannot include credentials, a query, or a fragment.`,
    )
  }

  const issuerUrl = new URL(baseUrl.origin)
  const resourceUrl = new URL(baseUrl.origin)
  if (resourceUrl.hostname.toLowerCase().startsWith('api.')) {
    resourceUrl.hostname = `mcp.${resourceUrl.hostname.slice(4)}`
  }
  return { issuer: issuerUrl.origin, resource: resourceUrl.href }
}

function metadataUrl(base: string, pathname: string): string {
  return new URL(pathname, base).href
}

function randomValue(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  return value as Record<string, unknown>
}

function trustedEndpoint(value: unknown, issuer: string): string {
  if (typeof value !== 'string') {
    throw oauthError('OAuth metadata is invalid.')
  }
  let endpoint: URL
  try {
    endpoint = new URL(value)
  } catch {
    throw oauthError('OAuth metadata is invalid.')
  }
  if (
    !isSecureOrLoopback(endpoint) ||
    endpoint.origin !== issuer ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw oauthError('OAuth metadata contains an untrusted endpoint.')
  }
  return endpoint.href
}

function isTrustedIssuer(value: unknown, expectedIssuer: string): boolean {
  if (typeof value === 'string') {
    try {
      const issuer = new URL(value)
      return (
        issuer.origin === expectedIssuer &&
        issuer.pathname === '/' &&
        !issuer.username &&
        !issuer.password &&
        !issuer.search &&
        !issuer.hash
      )
    } catch {}
  }
  return false
}

async function requestJson(
  url: string,
  options: {
    readonly method?: string
    readonly headers?: Record<string, string>
    readonly body?: string
    readonly signal?: AbortSignal
  } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await httpRequest(url, {
    ...(options.method ? { method: options.method } : {}),
    ...(options.headers ? { headers: options.headers } : {}),
    ...(options.body ? { body: options.body } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    timeout: REQUEST_TIMEOUT_MS,
    maxResponseSize: RESPONSE_LIMIT_BYTES,
    followRedirects: false,
  })
  return {
    status: response.status,
    body: parseJsonObject(response.text(), 'Socket MCP OAuth response'),
  }
}

async function discoverOAuthMetadata(
  signal: AbortSignal,
): Promise<LocalOAuthMetadata> {
  const target = configuredOAuthTarget()
  const resourceMetadataUrl = metadataUrl(
    target.resource,
    PROTECTED_RESOURCE_METADATA_PATH,
  )
  const resource = await requestJson(resourceMetadataUrl, { signal })
  const resourceMetadata = resource.body
  const authorizationServers = resourceMetadata['authorization_servers']
  const supportedScopes = resourceMetadata['scopes_supported']
  if (
    resource.status !== 200 ||
    resourceMetadata['resource'] !== target.resource ||
    !Array.isArray(authorizationServers) ||
    !authorizationServers.some(value =>
      isTrustedIssuer(value, target.issuer),
    ) ||
    !Array.isArray(supportedScopes) ||
    REQUIRED_SCOPES.some(scope => !supportedScopes.includes(scope))
  ) {
    throw oauthError('Socket OAuth resource metadata could not be verified.')
  }

  const issuer = await requestJson(
    metadataUrl(target.issuer, AUTHORIZATION_SERVER_METADATA_PATH),
    { signal },
  )
  const metadata = issuer.body
  if (
    issuer.status !== 200 ||
    metadata['issuer'] !== target.issuer ||
    !Array.isArray(metadata['grant_types_supported']) ||
    !metadata['grant_types_supported'].includes('authorization_code') ||
    !metadata['grant_types_supported'].includes('refresh_token') ||
    !Array.isArray(metadata['code_challenge_methods_supported']) ||
    !metadata['code_challenge_methods_supported'].includes('S256') ||
    !Array.isArray(metadata['token_endpoint_auth_methods_supported']) ||
    !metadata['token_endpoint_auth_methods_supported'].includes('none')
  ) {
    throw oauthError('Socket OAuth issuer metadata is invalid.')
  }

  return {
    issuer: target.issuer,
    resource: target.resource,
    authorizationEndpoint: trustedEndpoint(
      metadata['authorization_endpoint'],
      target.issuer,
    ),
    registrationEndpoint: trustedEndpoint(
      metadata['registration_endpoint'],
      target.issuer,
    ),
    tokenEndpoint: trustedEndpoint(metadata['token_endpoint'], target.issuer),
    revocationEndpoint:
      metadata['revocation_endpoint'] === undefined
        ? undefined
        : trustedEndpoint(metadata['revocation_endpoint'], target.issuer),
  }
}

function sameValue(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  )
}

function openBrowser(url: string): void {
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
        : ['xdg-open', [url]]
  try {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.once('error', () => {
      logger.warn(
        'Could not open a browser automatically. Use the sign-in URL printed above.',
      )
    })
    child.unref()
  } catch {
    logger.warn(
      'Could not open a browser automatically. Use the sign-in URL printed above.',
    )
  }
}

function validCredentials(value: unknown): value is LocalOAuthCredentials {
  const credentials = asRecord(value)
  const scopes = credentials?.['scopes']
  const target = configuredOAuthTarget()
  if (
    !credentials ||
    credentials['version'] !== 1 ||
    credentials['issuer'] !== target.issuer ||
    credentials['resource'] !== target.resource ||
    typeof credentials['clientId'] !== 'string' ||
    !credentials['clientId'] ||
    typeof credentials['accessToken'] !== 'string' ||
    !credentials['accessToken'] ||
    typeof credentials['expiresAt'] !== 'number' ||
    !Number.isFinite(credentials['expiresAt']) ||
    credentials['expiresAt'] <= 0 ||
    !Array.isArray(scopes) ||
    scopes.some(
      scope => typeof scope !== 'string' || !REQUIRED_SCOPES.includes(scope),
    ) ||
    REQUIRED_SCOPES.some(scope => !scopes.includes(scope)) ||
    (credentials['refreshToken'] !== undefined &&
      (typeof credentials['refreshToken'] !== 'string' ||
        !credentials['refreshToken']))
  ) {
    return false
  }
  try {
    trustedEndpoint(credentials['tokenEndpoint'], credentials['issuer'])
    if (credentials['revocationEndpoint'] !== undefined) {
      trustedEndpoint(credentials['revocationEndpoint'], credentials['issuer'])
    }
    return true
  } catch {
    return false
  }
}

function readCredentials(): LocalOAuthCredentials | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(credentialPath(), 'utf8'))
    if (!validCredentials(value)) {
      throw oauthError(
        'Saved session is invalid. Run `socket-mcp login` again.',
      )
    }
    return value
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined
    }
    if (error instanceof SyntaxError) {
      throw oauthError(
        'Saved session is corrupt. Run `socket-mcp login` again.',
      )
    }
    throw error
  }
}

async function writeCredentials(
  credentials: LocalOAuthCredentials,
): Promise<void> {
  const directory = sessionDirectory()
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  await fs.chmod(directory, 0o700).catch(() => {})
  const target = credentialPath()
  const temporary = `${target}.${process.pid}.${randomValue(6)}.tmp`
  try {
    await fs.writeFile(temporary, `${JSON.stringify(credentials, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    })
    await fs.chmod(temporary, 0o600)
    await fs.rename(temporary, target)
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {})
  }
}

async function withCredentialLock<T>(action: () => Promise<T>): Promise<T> {
  const directory = sessionDirectory()
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  const lockPath = `${credentialPath()}.lock`
  const ownerPath = path.join(lockPath, 'owner.json')
  const owner = { pid: process.pid, nonce: randomValue(12) }
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  while (true) {
    try {
      await fs.mkdir(lockPath, { mode: 0o700 })
      await fs.writeFile(ownerPath, JSON.stringify(owner), {
        flag: 'wx',
        mode: 0o600,
      })
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        let stale = false
        try {
          const lockOwner = JSON.parse(
            await fs.readFile(ownerPath, 'utf8'),
          ) as {
            pid?: unknown
          }
          if (
            Number.isSafeInteger(lockOwner.pid) &&
            typeof lockOwner.pid === 'number'
          ) {
            try {
              process.kill(lockOwner.pid, 0)
            } catch (signalError) {
              stale = (signalError as NodeJS.ErrnoException).code === 'ESRCH'
            }
          }
        } catch (ownerError) {
          if ((ownerError as NodeJS.ErrnoException).code === 'ENOENT') {
            const lockStat = await fs.stat(lockPath).catch(() => undefined)
            stale = Boolean(
              lockStat &&
              Date.now() - lockStat.mtimeMs > LOCK_INITIALIZATION_GRACE_MS,
            )
          }
        }
        if (stale) {
          await fs.rm(lockPath, { recursive: true, force: true })
          continue
        }
      } else {
        await fs.rm(lockPath, { recursive: true, force: true }).catch(() => {})
        throw error
      }
      if (Date.now() >= deadline) {
        throw oauthError(
          'Could not acquire the saved-session lock. Try `socket-mcp login` again.',
        )
      }
      await new Promise<void>(resolve => setTimeout(resolve, 100))
    }
  }
  try {
    return await action()
  } finally {
    try {
      const lockOwner = JSON.parse(await fs.readFile(ownerPath, 'utf8')) as {
        nonce?: unknown
      }
      if (lockOwner.nonce === owner.nonce) {
        await fs.rm(lockPath, { recursive: true, force: true })
      }
    } catch {
      // A stale-lock recovery may already have removed this lock.
    }
  }
}

function parseTokenResponse(
  response: { status: number; body: Record<string, unknown> },
  fallbackScopes: string[],
  metadata: Pick<LocalOAuthMetadata, 'tokenEndpoint' | 'revocationEndpoint'> & {
    issuer: string
    resource: string
    clientId: string
    fallbackRefreshToken?: string
  },
): LocalOAuthCredentials {
  const body = response.body
  const expiresIn = body['expires_in']
  if (
    response.status < 200 ||
    response.status >= 300 ||
    typeof body['access_token'] !== 'string' ||
    !body['access_token'].trim() ||
    typeof body['token_type'] !== 'string' ||
    body['token_type'].toLowerCase() !== 'bearer' ||
    typeof expiresIn !== 'number' ||
    !Number.isFinite(expiresIn) ||
    expiresIn <= 0 ||
    !Number.isSafeInteger(Date.now() + expiresIn * 1000) ||
    (body['refresh_token'] !== undefined &&
      (typeof body['refresh_token'] !== 'string' || !body['refresh_token']))
  ) {
    throw oauthError('Token exchange failed. Run `socket-mcp login` again.')
  }
  if (body['scope'] !== undefined && typeof body['scope'] !== 'string') {
    throw oauthError('The authorization server returned invalid permissions.')
  }
  const scopes =
    typeof body['scope'] === 'string'
      ? body['scope'].split(/\s+/u).filter(Boolean)
      : fallbackScopes
  if (
    REQUIRED_SCOPES.some(scope => !scopes.includes(scope)) ||
    scopes.some(scope => !REQUIRED_SCOPES.includes(scope))
  ) {
    throw oauthError(
      'The authorization server did not grant the required read-only permissions.',
    )
  }
  return {
    version: 1,
    issuer: metadata.issuer,
    resource: metadata.resource,
    clientId: metadata.clientId,
    accessToken: body['access_token'],
    refreshToken:
      typeof body['refresh_token'] === 'string'
        ? body['refresh_token']
        : metadata.fallbackRefreshToken,
    expiresAt: Date.now() + expiresIn * 1000,
    scopes,
    tokenEndpoint: metadata.tokenEndpoint,
    revocationEndpoint: metadata.revocationEndpoint,
  }
}

function formBody(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString()
}

export async function loginWithBrowserOAuth(): Promise<void> {
  const controller = new AbortController()
  const timeout = setTimeout(
    () =>
      controller.abort(
        oauthError('Sign-in timed out. Run `socket-mcp login` to try again.'),
      ),
    SIGN_IN_TIMEOUT_MS,
  )
  let callbackServer: ReturnType<typeof createServer> | undefined
  try {
    const metadata = await discoverOAuthMetadata(controller.signal)
    const state = randomValue()
    const verifier = randomValue(48)
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    let settleCode!: (code: string) => void
    let rejectCode!: (error: Error) => void
    let settled = false
    const codeResult = new Promise<string>((resolve, reject) => {
      settleCode = resolve
      rejectCode = reject
    })
    void codeResult.catch(() => {})

    callbackServer = createServer((request, response) => {
      let callback: URL
      try {
        callback = new URL(request.url ?? '/', 'http://127.0.0.1')
      } catch {
        response.writeHead(400).end('Invalid callback request.')
        return
      }
      if (request.method !== 'GET' || callback.pathname !== '/oauth/callback') {
        response.writeHead(404).end()
        return
      }
      if (settled) {
        response.writeHead(410).end()
        return
      }
      if (!sameValue(callback.searchParams.get('state') ?? '', state)) {
        response.writeHead(400).end('Sign-in state did not match.')
        return
      }
      if (
        callback.searchParams.has('error') ||
        !callback.searchParams.get('code')
      ) {
        settled = true
        response.writeHead(400).end('Sign-in was not completed.')
        rejectCode(oauthError('Authorization was declined.'))
        return
      }
      settled = true
      response
        .writeHead(200, {
          'cache-control': 'no-store',
          'content-type': 'text/html; charset=utf-8',
        })
        .end(
          '<!doctype html><title>Socket MCP</title><p>Sign-in complete. Return to your terminal.</p>',
        )
      settleCode(callback.searchParams.get('code')!)
    })

    controller.signal.addEventListener(
      'abort',
      () => {
        if (!settled) {
          settled = true
          rejectCode(
            controller.signal.reason instanceof Error
              ? controller.signal.reason
              : oauthError('Sign-in was cancelled.'),
          )
        }
      },
      { once: true },
    )

    const redirectUri = await new Promise<string>((resolve, reject) => {
      callbackServer!.once('error', () =>
        reject(oauthError('Could not start the local callback listener.')),
      )
      callbackServer!.listen(0, '127.0.0.1', () => {
        const address = callbackServer!.address()
        if (!address || typeof address === 'string') {
          reject(oauthError('Could not start the local callback listener.'))
        } else {
          resolve(`http://127.0.0.1:${address.port}/oauth/callback`)
        }
      })
    })

    const registration = await requestJson(metadata.registrationEndpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Socket MCP',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
    })
    const clientId = registration.body['client_id']
    const registeredUris = registration.body['redirect_uris']
    const registeredGrants = registration.body['grant_types']
    const registeredResponses = registration.body['response_types']
    if (
      registration.status < 200 ||
      registration.status >= 300 ||
      typeof clientId !== 'string' ||
      !clientId.trim() ||
      (registration.body['token_endpoint_auth_method'] !== undefined &&
        registration.body['token_endpoint_auth_method'] !== 'none') ||
      (registeredUris !== undefined &&
        (!Array.isArray(registeredUris) ||
          !registeredUris.includes(redirectUri))) ||
      (registeredGrants !== undefined &&
        (!Array.isArray(registeredGrants) ||
          !['authorization_code', 'refresh_token'].every(grant =>
            registeredGrants.includes(grant),
          ))) ||
      (registeredResponses !== undefined &&
        (!Array.isArray(registeredResponses) ||
          !registeredResponses.includes('code')))
    ) {
      throw oauthError('The OAuth client could not be registered.')
    }

    const authorizationUrl = new URL(metadata.authorizationEndpoint)
    authorizationUrl.search = formBody({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: REQUIRED_SCOPES.join(' '),
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: metadata.resource,
    })
    logger.info('Opening a browser for Socket MCP sign-in.')
    logger.info(`If the browser does not open, visit: ${authorizationUrl.href}`)
    openBrowser(authorizationUrl.href)

    const code = await codeResult
    const tokenResponse = await requestJson(metadata.tokenEndpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: formBody({
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        redirect_uri: redirectUri,
        code_verifier: verifier,
        resource: metadata.resource,
      }),
    })
    const credentials = parseTokenResponse(tokenResponse, REQUIRED_SCOPES, {
      ...metadata,
      clientId,
    })
    await withCredentialLock(() => writeCredentials(credentials))
    logger.info('Socket MCP browser sign-in saved for this user.')
  } finally {
    clearTimeout(timeout)
    callbackServer?.close()
    callbackServer?.closeAllConnections()
  }
}

export async function resolveLocalOAuthSession(): Promise<
  LocalOAuthSession | undefined
> {
  const current = readCredentials()
  if (!current) {
    return undefined
  }
  if (current.expiresAt > Date.now() + 30_000) {
    return { accessToken: current.accessToken, expiresAt: current.expiresAt }
  }
  return await refreshLocalOAuthSession()
}

export async function refreshLocalOAuthSession(): Promise<LocalOAuthSession> {
  return await withCredentialLock(async () => {
    const current = readCredentials()
    if (!current) {
      throw oauthError('No browser sign-in is saved. Run `socket-mcp login`.')
    }
    if (current.expiresAt > Date.now() + 30_000) {
      return { accessToken: current.accessToken, expiresAt: current.expiresAt }
    }
    if (!current.refreshToken) {
      throw oauthError(
        'The saved sign-in expired. Run `socket-mcp login` again.',
      )
    }

    const refreshToken = current.refreshToken
    const response = await requestJson(current.tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: formBody({
        grant_type: 'refresh_token',
        client_id: current.clientId,
        refresh_token: refreshToken,
        resource: current.resource,
      }),
    })
    const fresh = parseTokenResponse(response, current.scopes, {
      issuer: current.issuer,
      resource: current.resource,
      tokenEndpoint: current.tokenEndpoint,
      revocationEndpoint: current.revocationEndpoint,
      clientId: current.clientId,
      fallbackRefreshToken: current.refreshToken,
    })
    await writeCredentials(fresh)
    return { accessToken: fresh.accessToken, expiresAt: fresh.expiresAt }
  })
}

export async function logoutLocalOAuth(): Promise<void> {
  await withCredentialLock(() => fs.rm(credentialPath(), { force: true }))
  logger.info('Removed the saved Socket MCP browser sign-in.')
}

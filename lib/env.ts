/**
 * @fileoverview mcp-local env getters.
 *
 * Functions that `lib/*.ts` previously imported from
 * `@socketsecurity/lib/env/socket`, but which aren't exported
 * by `lib@5.28.0` (the version pinned in the catalog). The
 * functions fall into two groups:
 *
 *   1. mcp-specific (MCP_HTTP_MODE, MCP_PORT, TRUST_PROXY) — these
 *      will never live in the canonical socket-lib env surface; they
 *      belong here.
 *   2. naming drift (`getSocketApiUrl` → `getSocketApiBaseUrl` in
 *      lib@5.28+) and OAuth getters that haven't shipped upstream
 *      yet — re-exports / shims that keep the mcp call sites stable
 *      until lib catches up.
 *
 * When lib publishes the missing canonical getters, this file shrinks
 * to just the mcp-specific group.
 */

import process from 'node:process'

import { getSocketApiBaseUrl } from '@socketsecurity/lib/env/socket'

export function envBool(key: string): boolean {
  const v = process.env[key]
  if (v === undefined || v === '') {
    return false
  }
  return v === '1' || v.toLowerCase() === 'true'
}

export function envInt(key: string): number | undefined {
  const v = envString(key)
  if (v === undefined) {
    return undefined
  }
  const n = Number.parseInt(v, 10)
  return Number.isFinite(n) ? n : undefined
}

export function envString(key: string): string | undefined {
  const v = process.env[key]
  return v === undefined || v === '' ? undefined : v
}

export function getMcpHttpMode(): boolean {
  return envBool('MCP_HTTP_MODE')
}

export function getMcpPort(): number {
  return envInt('MCP_PORT') ?? 3000
}

// API URL — bridge for naming drift. lib@5.28.0 exposes
// `getSocketApiBaseUrl`; older mcp code asks for `getSocketApiUrl`.
// Both names resolve to the same value (SOCKET_API_BASE_URL or its
// legacy alias). Re-export under the legacy name so call sites
// don't have to change.
export const getSocketApiUrl = getSocketApiBaseUrl

// OAuth getters — not yet in the canonical lib surface. These read
// the same env vars that the future lib getters will read. Once
// lib ships them, this file's OAuth section can be replaced with
// a re-export from @socketsecurity/lib.

export function getSocketOauthIntrospectionClientId(): string | undefined {
  return envString('SOCKET_OAUTH_INTROSPECTION_CLIENT_ID')
}

export function getSocketOauthIntrospectionClientSecret(): string | undefined {
  return envString('SOCKET_OAUTH_INTROSPECTION_CLIENT_SECRET')
}

export function getSocketOauthIssuer(): string | undefined {
  return envString('SOCKET_OAUTH_ISSUER')
}

export function getSocketOauthRequiredScopes(): string[] {
  const raw = envString('SOCKET_OAUTH_REQUIRED_SCOPES')
  if (raw === undefined) {
    return []
  }
  return raw.split(/[\s,]+/).filter(Boolean)
}

export function getTrustProxy(): boolean {
  return envBool('TRUST_PROXY')
}

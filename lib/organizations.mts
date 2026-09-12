import { SocketSdk } from '@socketsecurity/sdk'

export interface FetchOrganizationsConfig {
  baseUrl: string
  userAgent?: string | undefined
  // Socket access token. The SDK sends it as HTTP Basic auth (token as the
  // username, empty password).
  authToken?: string | undefined
}

// The failure fields the SDK reports on a non-2xx `listOrganizations()`.
export interface OrganizationsFailure {
  cause?: string | undefined
  error: string
  status: number
}

// Render an SDK failure into the message `fetchOrganizations` throws. The SDK
// reports `cause` only for some failures, so it is appended in parentheses
// when present and omitted otherwise.
export function buildOrganizationsErrorMessage(
  failure: OrganizationsFailure,
): string {
  return `organizations endpoint ${failure.status}: ${failure.error}${
    failure.cause ? ` (${failure.cause})` : ''
  }`
}

/**
 * Fetch the organizations the authenticated user belongs to via the Socket
 * SDK's `listOrganizations()` (`GET /v0/organizations`). Returns the parsed
 * JSON body untouched — downstream callers decide how to render it. Throws with
 * the SDK-reported status + error on a non-2xx response.
 *
 * The SDK's `baseUrl` already carries the `/v0/` path segment, so the caller's
 * `baseUrl` (the bare API origin) gets `/v0/` appended.
 */
export async function fetchOrganizations(
  config: FetchOrganizationsConfig,
): Promise<unknown> {
  config = { __proto__: null, ...config } as typeof config
  const baseUrl = `${config.baseUrl.replace(/\/$/u, '')}/v0/`
  const sdk = new SocketSdk(config.authToken ?? '', {
    baseUrl,
    ...(config.userAgent ? { userAgent: config.userAgent } : {}),
  })

  const result = await sdk.listOrganizations()
  if (!result.success) {
    throw new Error(buildOrganizationsErrorMessage(result))
  }
  return result.data
}

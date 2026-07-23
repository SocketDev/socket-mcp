import { SocketSdk } from '@socketsecurity/sdk'

export interface FetchOrganizationsOptions {
  baseUrl: string
  userAgent?: string | undefined
  // Socket access token. The SDK sends it as HTTP Basic auth (token as the
  // username, empty password).
  authToken?: string | undefined
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
  config: FetchOrganizationsOptions,
): Promise<unknown> {
  config = { __proto__: null, ...config } as typeof config
  const baseUrl = `${config.baseUrl.replace(/\/$/u, '')}/v0/`
  const sdk = new SocketSdk(config.authToken ?? '', {
    baseUrl,
    ...(config.userAgent ? { userAgent: config.userAgent } : {}),
  })

  const result = await sdk.listOrganizations()
  if (!result.success) {
    throw new Error(
      `organizations endpoint ${result.status}: ${result.error}${
        result.cause ? ` (${result.cause})` : ''
      }`,
    )
  }
  return result.data
}

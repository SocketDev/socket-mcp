import { httpRequest } from '@socketsecurity/lib/http-request/request'
import { HttpResponseError } from '@socketsecurity/lib/http-request/response-types'

const MAX_RESPONSE_SIZE = 10 * 1024 * 1024

export interface FetchOrganizationsConfig {
  baseUrl: string
  userAgent?: string | undefined
  // Socket access token. HTTP Basic uses it as the username.
  authToken?: string | undefined
}

/**
 * Fetch the organizations the authenticated user belongs to from
 * `GET /v0/organizations`. Returns the parsed JSON body untouched.
 */
export async function fetchOrganizations(
  config: FetchOrganizationsConfig,
): Promise<unknown> {
  config = { __proto__: null, ...config } as typeof config
  const token = config.authToken?.trim()
  if (!token) {
    throw new Error('Socket API token is required for organizations')
  }
  const url = `${config.baseUrl.replace(/\/$/u, '')}/v0/organizations`
  try {
    const res = await httpRequest(url, {
      headers: {
        accept: 'application/json',
        authorization: `Basic ${Buffer.from(`${token}:`).toString('base64')}`,
        ...(config.userAgent ? { 'user-agent': config.userAgent } : {}),
      },
      maxResponseSize: MAX_RESPONSE_SIZE,
      onRetry: (_attempt, error, delay) => retryDelay(error, delay),
      retries: 3,
      throwOnError: true,
    })
    const body = res.text()
    return body === '' ? {} : JSON.parse(body)
  } catch (error) {
    if (error instanceof HttpResponseError) {
      throw new Error(
        `organizations endpoint ${error.response.status}: ${error.response.text()}`,
      )
    }
    throw error
  }
}

export function retryDelay(error: unknown, delay: number): boolean | number {
  if (!(error instanceof HttpResponseError)) {
    return delay
  }
  const { status, headers } = error.response
  if (status >= 400 && status < 500 && status !== 429) {
    return false
  }
  const retryAfter = headers['retry-after']
  if (status !== 429 || !retryAfter) {
    return delay
  }
  const value = Array.isArray(retryAfter) ? retryAfter[0] : retryAfter
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000
  }
  const dateDelay = Date.parse(value) - Date.now()
  return dateDelay > 0 ? dateDelay : delay
}

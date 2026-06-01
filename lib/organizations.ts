import { httpRequest } from '@socketsecurity/lib/http-request/request'

import { buildJsonApiHeaders } from './http-helpers.ts'

export interface FetchOrganizationsOptions {
  baseUrl: string
  userAgent?: string | undefined
  // Socket access token, sent as `Authorization: Bearer <token>` when set.
  authToken?: string | undefined
  extraHeaders?: Record<string, string> | undefined
}

/**
 * Fetch the organizations the authenticated user belongs to from `GET
 * /v0/organizations`. Returns the parsed JSON body untouched — downstream
 * callers decide how to render it.
 */
export async function fetchOrganizations(
  options: FetchOrganizationsOptions,
): Promise<unknown> {
  const baseUrl = options.baseUrl.replace(/\/$/u, '')
  const url = `${baseUrl}/v0/organizations`

  const res = await httpRequest(url, { headers: buildJsonApiHeaders(options) })
  if (!res.ok) {
    throw new Error(`organizations endpoint ${res.status}: ${res.text()}`)
  }
  return res.json<unknown>()
}

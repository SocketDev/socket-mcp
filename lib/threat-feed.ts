import { httpRequest } from '@socketsecurity/lib/http-request/request'

import { buildJsonApiHeaders } from './http-helpers.ts'

export interface ThreatFeedFilters {
  // 1..100. API caps at 100 and defaults to 30.
  perPage?: number | undefined
  // Pagination cursor from a previous response.
  cursor?: string | undefined
  // Sort field: id | created_at | updated_at (default updated_at).
  sort?: 'id' | 'created_at' | 'updated_at' | undefined
  // Sort direction: asc | desc (default desc).
  direction?: 'asc' | 'desc' | undefined
  // ISO timestamp; return items updated after this.
  updatedAfter?: string | undefined
  // ISO timestamp; return items created after this.
  createdAfter?: string | undefined
  // Threat category filter. Defaults to `mal`. Common values include `mal`
  // (malware), `vuln`, `typ` (typosquat), `obf` (obfuscated), `mjo` (malicious
  // javascript object), `kes` (known exploits), `spy`, `ano` (anomalous),
  // `ucf` (unverified code fetch), `ptp` (potential privilege escalation),
  // `ual` (unauthorized access logic).
  filter?: string | undefined
  // Filter by package name.
  name?: string | undefined
  // Filter by package version.
  version?: string | undefined
  // Defaults to false. When true, only items marked human-reviewed.
  isHumanReviewed?: boolean | undefined
  // Ecosystem filter: npm, pypi, gem, maven, golang, nuget, cargo, chrome,
  // openvsx, etc.
  ecosystem?: string | undefined
}

export interface FetchThreatFeedOptions {
  baseUrl: string
  orgSlug: string
  filters?: ThreatFeedFilters | undefined
  userAgent?: string | undefined
  // Socket access token, sent as `Authorization: Bearer <token>` when set.
  authToken?: string | undefined
  extraHeaders?: Record<string, string> | undefined
}

/**
 * Build the query string for the threat-feed endpoint. Only set values are
 * included — undefined keys are skipped.
 */
export function buildThreatFeedQuery(
  filters: ThreatFeedFilters | undefined,
): URLSearchParams {
  const params = new URLSearchParams()
  const f = filters ?? {}
  if (typeof f.perPage === 'number') {
    params.set('per_page', String(f.perPage))
  }
  if (f.cursor) {
    params.set('page_cursor', f.cursor)
  }
  if (f.sort) {
    params.set('sort', f.sort)
  }
  if (f.direction) {
    params.set('direction', f.direction)
  }
  if (f.updatedAfter) {
    params.set('updated_after', f.updatedAfter)
  }
  if (f.createdAfter) {
    params.set('created_after', f.createdAfter)
  }
  if (f.filter) {
    params.set('filter', f.filter)
  }
  if (f.name) {
    params.set('name', f.name)
  }
  if (f.version) {
    params.set('version', f.version)
  }
  if (typeof f.isHumanReviewed === 'boolean') {
    params.set('is_human_reviewed', String(f.isHumanReviewed))
  }
  if (f.ecosystem) {
    params.set('ecosystem', f.ecosystem)
  }
  return params
}

/**
 * Fetch threat-feed items for an organization from `GET
 * /v0/orgs/{org_slug}/threat-feed`. Returns the parsed JSON body untouched.
 */
export async function fetchThreatFeed(
  options: FetchThreatFeedOptions,
): Promise<unknown> {
  const baseUrl = options.baseUrl.replace(/\/$/u, '')
  const qs = buildThreatFeedQuery(options.filters).toString()
  const url = `${baseUrl}/v0/orgs/${encodeURIComponent(options.orgSlug)}/threat-feed${qs ? `?${qs}` : ''}`

  const res = await httpRequest(url, { headers: buildJsonApiHeaders(options) })
  if (!res.ok) {
    throw new Error(`threat-feed endpoint ${res.status}: ${res.text()}`)
  }
  return res.json<unknown>()
}

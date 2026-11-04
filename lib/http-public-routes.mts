// The endpoints that answer without an MCP credential, split by the trust
// stage they belong to rather than gathered behind one entry point.
//
// Two dispatchers, not one, because the stages are genuinely different.
// `/health` answers BEFORE origin validation so a container probe needs no
// origin configuration, while the metadata and challenge probes answer after
// CORS and before authentication. Collapsing them into a single dispatcher
// would either move a route across that boundary or take a stage flag, and
// the boundary is the part worth keeping legible.
//
// Each dispatcher reports whether it answered, so the caller's routing spine
// stays a list of `if (…) return` steps.
import { errorMessage } from '@socketsecurity/lib/errors/message'
import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  isAppsChallengeRequest,
  writeAppsChallenge,
} from './apps-challenge.mts'
import { getRequestBaseUrl, writeJson } from './http.mts'
import { logger } from './logger.mts'
import {
  buildProtectedResourceMetadata,
  isOauthEnabled,
  loadOAuthMetadata,
  OAUTH_PROTECTED_RESOURCE_METADATA_PATH,
} from './oauth.mts'
import { VERSION } from './version.mts'

/**
 * Answer the unauthenticated routes that run after origin validation and CORS
 * but before authentication, and report whether the response was written.
 *
 * Both probes here are issued by a third party that holds no credential: the
 * OAuth client reading protected-resource metadata, and the OpenAI plugin
 * portal verifying domain control. Placing them behind authentication would
 * make them unanswerable.
 */
export async function dispatchPublicRoute(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  port: number,
): Promise<boolean> {
  if (
    isAppsChallengeRequest(req.method, pathname) &&
    writeAppsChallenge(res, req.method)
  ) {
    return true
  }
  return await writeOauthMetadata(res, pathname, getRequestBaseUrl(req, port))
}

/**
 * Answer the routes that run before origin validation, and report whether the
 * response was written.
 *
 * Only `/health` qualifies: a Kubernetes or Docker probe reaches the server
 * without an `Origin` header and without per-deployment origin configuration,
 * so requiring either would make a healthy server look unhealthy. The handler
 * reads no request state beyond the path and exposes nothing an unauthorized
 * caller could not already learn from the server banner.
 */
export function dispatchUnvalidatedRoute(
  res: ServerResponse,
  pathname: string,
): boolean {
  if (pathname !== '/health') {
    return false
  }
  writeJson(res, 200, {
    status: 'healthy',
    service: 'socket-mcp',
    version: VERSION,
    timestamp: new Date().toISOString(),
  })
  return true
}

/**
 * Answer the RFC 9728 protected-resource metadata probe, and report whether
 * the response was written. Returns false on a deployment with OAuth off, or
 * for any other path, leaving the caller to continue routing.
 */
export async function writeOauthMetadata(
  res: ServerResponse,
  pathname: string,
  baseUrl: URL,
): Promise<boolean> {
  if (
    !isOauthEnabled() ||
    pathname !== OAUTH_PROTECTED_RESOURCE_METADATA_PATH
  ) {
    return false
  }
  // Discovery rejects when the issuer is unreachable or serves no usable
  // metadata. Answering from the catch keeps a down issuer from becoming an
  // unhandled rejection, which would hang the request and take the process
  // with it.
  try {
    await loadOAuthMetadata()
  } catch (error) {
    logger.error(`OAuth metadata discovery failed: ${errorMessage(error)}`)
    writeJson(res, 500, {
      error: 'server_error',
      error_description: 'OAuth metadata is unavailable',
    })
    return true
  }
  writeJson(res, 200, buildProtectedResourceMetadata(baseUrl))
  return true
}

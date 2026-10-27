// OpenAI apps domain verification: the plugin portal probes a fixed path on
// the MCP hostname (or an eligible parent domain) and compares the response
// body against the token it issued. The probe is unauthenticated and carries
// no Origin header, so the route answers ahead of the OAuth gate.
//
// The token is configuration, not a secret the server derives: it is issued
// by the portal and pasted into the deployment environment. A deployment with
// no token configured serves the ordinary 404 rather than an empty 200, so an
// unconfigured environment can never report itself as verified.
import type { ServerResponse } from 'node:http'

import { getSocketMcpAppsChallengeToken } from './env.mts'

export const OPENAI_APPS_CHALLENGE_PATH = '/.well-known/openai-apps-challenge'

/**
 * True when the request is the portal's verification probe: the exact
 * challenge path, read with a safe method. Any other method falls through to
 * the catch-all 404.
 */
export function isAppsChallengeRequest(
  method: string | undefined,
  pathname: string,
): boolean {
  if (pathname !== OPENAI_APPS_CHALLENGE_PATH) {
    return false
  }
  return method === 'GET' || method === 'HEAD'
}

/**
 * Answer the verification probe with the configured token and nothing else -
 * no JSON envelope, no trailing newline, no token list. Returns false when no
 * token is configured, leaving the caller to serve its 404.
 */
export function writeAppsChallenge(
  res: ServerResponse,
  method: string | undefined,
): boolean {
  const token = getSocketMcpAppsChallengeToken()
  if (token === undefined) {
    return false
  }
  res.writeHead(200, {
    'Content-Length': String(Buffer.byteLength(token)),
    'Content-Type': 'text/plain; charset=utf-8',
  })
  res.end(method === 'HEAD' ? undefined : token)
  return true
}

export type ToolOutcome = 'success' | 'failure' | 'denied' | 'invalid'

// Why an upstream call behind a tool result went wrong. `upstream_denied` and
// `upstream_4xx` are answers about the caller's request; the rest are
// failures on the server side of the call.
export type ToolFailureCause =
  | 'exception'
  | 'network'
  | 'timeout'
  | 'upstream_4xx'
  | 'upstream_5xx'
  | 'upstream_denied'

export interface ToolFailure {
  readonly cause: ToolFailureCause
  // The error the tool caught. Error reporting reads its stack and type, and
  // never its message.
  readonly error: unknown
  readonly status?: number | undefined
}

export interface ToolResultOutcomeInput {
  content?: readonly unknown[] | undefined
  isError?: boolean | undefined
}

export class UpstreamHttpError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'UpstreamHttpError'
    this.status = status
  }
}

const exceptionalOutcomes = new WeakMap<object, 'denied' | 'invalid'>()
const toolFailures = new WeakMap<object, ToolFailure>()

// Node and undici error codes for a connection that failed before an HTTP
// status came back.
const NETWORK_ERROR_CODES: ReadonlySet<string> = new Set([
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'EAI_AGAIN',
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'EPROTO',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UND_ERR_SOCKET',
])

const TIMEOUT_ERROR_CODES: ReadonlySet<string> = new Set([
  'ESOCKETTIMEDOUT',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
])

export function classifyToolFailure(result: object): ToolFailure | undefined {
  return toolFailures.get(result)
}

export function classifyToolOutcome(
  result: ToolResultOutcomeInput,
): ToolOutcome {
  const outcome = exceptionalOutcomes.get(result)
  if (outcome !== undefined) {
    return outcome
  }
  return result.isError === true ? 'failure' : 'success'
}

export function classifyUpstreamFailure(error: unknown): ToolFailureCause {
  if (error instanceof UpstreamHttpError) {
    if (error.status === 401 || error.status === 403) {
      return 'upstream_denied'
    }
    return error.status >= 500 ? 'upstream_5xx' : 'upstream_4xx'
  }
  // The shared HTTP client rejects a timeout with a plain Error that has no
  // code, so its message is the only marker. Callers that wrap an error keep
  // the original as `cause`, so walk a few links of the chain.
  let current: unknown = error
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    const code = errorCode(current)
    if (
      (code !== undefined && TIMEOUT_ERROR_CODES.has(code)) ||
      current.name === 'TimeoutError' ||
      /\btimed out\b/iu.test(current.message)
    ) {
      return 'timeout'
    }
    if (code !== undefined && NETWORK_ERROR_CODES.has(code)) {
      return 'network'
    }
    current = current.cause
  }
  return 'exception'
}

export function classifyUpstreamHttpError(
  error: unknown,
): 'denied' | 'failure' {
  return error instanceof UpstreamHttpError &&
    (error.status === 401 || error.status === 403)
    ? 'denied'
    : 'failure'
}

// The first string `code` on an error or its causes, e.g. `ECONNREFUSED`.
export function errorCode(error: unknown): string | undefined {
  let current: unknown = error
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    const code: unknown = Reflect.get(current, 'code')
    if (typeof code === 'string' && code) {
      return code
    }
    current = current.cause
  }
  return undefined
}

export function markToolOutcome<Result extends object>(
  result: Result,
  outcome: 'denied' | 'invalid',
): Result {
  exceptionalOutcomes.set(result, outcome)
  return result
}

// Record why an upstream call failed. A 401 or 403 also marks the result
// denied, which is what the audit outcome reads.
export function markUpstreamHttpOutcome<Result extends object>(
  result: Result,
  error: unknown,
): Result {
  toolFailures.set(result, {
    cause: classifyUpstreamFailure(error),
    error,
    ...(error instanceof UpstreamHttpError ? { status: error.status } : {}),
  })
  if (classifyUpstreamHttpError(error) === 'denied') {
    return markToolOutcome(result, 'denied')
  }
  return result
}

import { sanitizeToolArguments } from './tool-audit-sanitizer.mts'
import type { SanitizedToolArguments } from './tool-audit-sanitizer.mts'
import type { JsonValue } from './tool-types.mts'

export const TOOL_AUDIT_LIMITS: Readonly<{
  eventBytes: number
  idBytes: number
  resourceFieldBytes: number
  resources: number
  toolBytes: number
}> = Object.freeze({
  eventBytes: 16 * 1024,
  idBytes: 128,
  resourceFieldBytes: 256,
  resources: 32,
  toolBytes: 128,
})

const {
  resources: MAX_RESOURCE_COUNT,
  resourceFieldBytes: MAX_RESOURCE_FIELD_BYTES,
  eventBytes: MAX_EVENT_BYTES,
  toolBytes: MAX_TOOL_BYTES,
  idBytes: MAX_ID_BYTES,
} = TOOL_AUDIT_LIMITS

export function addResource(
  accumulator: ResourceAccumulator,
  resource: ToolAuditResource | undefined,
) {
  if (!resource || accumulator.resources.length >= MAX_RESOURCE_COUNT) {
    accumulator.truncated = true
    return
  }
  accumulator.resources.push(resource)
}

export function buildToolAuditEvent(
  eventId: string,
  timestamp: string,
  identity: ToolAuditIdentity,
  tool: string,
  outcome: ToolAuditOutcome,
  argumentsValue: unknown,
  options?:
    | {
        readonly inputValidated?: boolean | undefined
        readonly requestId?: string | number | undefined
      }
    | undefined,
): ToolAuditEventV1 {
  if (
    eventId.length === 0 ||
    eventId.length > MAX_ID_BYTES ||
    Buffer.byteLength(eventId, 'utf8') > MAX_ID_BYTES
  ) {
    throw new TypeError('Invalid tool audit event ID')
  }
  if (
    identity.kind === 'bearer' &&
    (identity.tokenHash.length > MAX_ID_BYTES ||
      Buffer.byteLength(identity.tokenHash, 'utf8') > MAX_ID_BYTES)
  ) {
    throw new TypeError('Invalid tool audit identity digest')
  }
  const boundedTool = utf8Prefix(tool, MAX_TOOL_BYTES)
  const safeOptions = { __proto__: null, ...options }
  const sanitized: SanitizedToolArguments =
    sanitizeToolArguments(argumentsValue)
  const extracted = extractToolAuditResources(tool, argumentsValue, {
    inputValidated:
      outcome !== 'invalid' &&
      outcome !== 'unknown' &&
      safeOptions.inputValidated,
  })
  const requestId = normalizeRequestId(safeOptions.requestId)
  const event: ToolAuditEventV1 = Object.setPrototypeOf(
    {
      event: 'socket.mcp.tool_call',
      version: 1,
      eventId,
      ...(requestId.value === undefined ? {} : { requestId: requestId.value }),
      timestamp: normalizeTimestamp(timestamp),
      identity: normalizeIdentity(identity),
      tool: boundedTool.value,
      outcome,
      resources: extracted.resources,
      args: sanitized.args,
      truncated: {
        arguments: sanitized.truncated,
        resources: extracted.truncated,
        requestId: requestId.truncated,
        tool: boundedTool.truncated,
        event: false,
      },
    },
    null,
  )
  if (Buffer.byteLength(JSON.stringify(event), 'utf8') <= MAX_EVENT_BYTES) {
    return event
  }
  return Object.setPrototypeOf(
    {
      ...event,
      args: Object.setPrototypeOf({}, null),
      resources: [],
      truncated: {
        arguments: true,
        resources: extracted.truncated || extracted.resources.length > 0,
        requestId: requestId.truncated,
        tool: boundedTool.truncated,
        event: true,
      },
    },
    null,
  )
}

export function extractDepscore(
  args: Record<string, unknown>,
  accumulator: ResourceAccumulator,
) {
  const packages = readData(args, 'packages')
  if (!Array.isArray(packages)) {
    return
  }
  const platform = readString(args, 'platform')
  for (let index = 0; index < packages.length; index += 1) {
    if (index >= MAX_RESOURCE_COUNT) {
      accumulator.truncated = true
      break
    }
    const descriptor = Object.getOwnPropertyDescriptor(packages, String(index))
    if (!descriptor || !('value' in descriptor)) {
      accumulator.truncated = true
      continue
    }
    const item = descriptor.value
    if (!isDataObject(item)) {
      accumulator.truncated = true
      continue
    }
    const name = readString(item, 'depname')
    if (!name) {
      accumulator.truncated = true
      continue
    }
    addResource(
      accumulator,
      makePackageResource(readString(item, 'ecosystem'), name, {
        version: readString(item, 'version'),
        platform,
      }),
    )
  }
}

export function extractFile(
  args: Record<string, unknown>,
  accumulator: ResourceAccumulator,
) {
  const hash = readString(args, 'hash')
  if (hash) {
    addResource(
      accumulator,
      resourceStringFits(hash) ? { kind: 'file', hash } : undefined,
    )
  }
}

export function extractOrganization(
  args: Record<string, unknown>,
  accumulator: ResourceAccumulator,
) {
  const orgSlug = readString(args, 'org_slug')
  if (orgSlug) {
    addResource(
      accumulator,
      resourceStringFits(orgSlug)
        ? { kind: 'organization', orgSlug }
        : undefined,
    )
  }
}

export function extractPackageFiles(
  args: Record<string, unknown>,
  accumulator: ResourceAccumulator,
) {
  const name = readString(args, 'depname')
  const version = readString(args, 'version')
  if (!name || !version) {
    return
  }
  addResource(
    accumulator,
    makePackageResource(readString(args, 'ecosystem'), name, {
      version,
      platform: readString(args, 'platform'),
      artifactId: readString(args, 'artifactId'),
    }),
  )
}

export function extractToolAuditResources(
  tool: string,
  argumentsValue: unknown,
  options?: { readonly inputValidated?: boolean | undefined } | undefined,
): {
  readonly resources: readonly ToolAuditResource[]
  readonly truncated: boolean
} {
  const opts = { __proto__: null, ...options }
  const accumulator: ResourceAccumulator = { resources: [], truncated: false }
  if (opts?.inputValidated !== true) {
    return accumulator
  }
  try {
    if (!isDataObject(argumentsValue)) {
      return accumulator
    }
    if (tool === 'alerts' || tool === 'threat_feed') {
      extractOrganization(argumentsValue, accumulator)
    } else if (tool === 'depscore') {
      extractDepscore(argumentsValue, accumulator)
    } else if (tool === 'package_files') {
      extractPackageFiles(argumentsValue, accumulator)
    } else if (
      tool === 'package_file_contents' ||
      tool === 'package_file_grep'
    ) {
      extractFile(argumentsValue, accumulator)
    }
  } catch {
    return { resources: [], truncated: true }
  }
  return accumulator
}

export type ToolAuditOutcome =
  | 'success'
  | 'failure'
  | 'denied'
  | 'invalid'
  | 'unknown'

export type ToolAuditIdentity =
  | { readonly kind: 'operator' }
  | { readonly kind: 'anonymous' }
  | { readonly kind: 'bearer'; readonly tokenHash: string }

export type ToolAuditResource =
  | { readonly kind: 'organization'; readonly orgSlug: string }
  | {
      readonly kind: 'package'
      readonly ecosystem?: string | undefined
      readonly name: string
      readonly version?: string | undefined
      readonly platform?: string | undefined
      readonly artifactId?: string | undefined
    }
  | { readonly kind: 'file'; readonly hash: string }

export interface ToolAuditTruncation {
  readonly arguments: boolean
  readonly resources: boolean
  readonly requestId: boolean
  readonly tool: boolean
  readonly event: boolean
}

export interface ToolAuditEventV1 {
  readonly event: 'socket.mcp.tool_call'
  readonly version: 1
  readonly eventId: string
  readonly requestId?: string | number | undefined
  readonly timestamp: string
  readonly identity: ToolAuditIdentity
  readonly tool: string
  readonly outcome: ToolAuditOutcome
  readonly resources: readonly ToolAuditResource[]
  readonly args: JsonValue
  readonly truncated: ToolAuditTruncation
}

export interface ResourceAccumulator {
  readonly resources: ToolAuditResource[]
  truncated: boolean
}

export function isDataObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export function makePackageResource(
  ecosystem: string | undefined,
  name: string,
  options?:
    | {
        readonly version?: string | undefined
        readonly platform?: string | undefined
        readonly artifactId?: string | undefined
      }
    | undefined,
): ToolAuditResource | undefined {
  const safeOptions = { __proto__: null, ...options }
  const fields = [
    ecosystem,
    name,
    safeOptions.version,
    safeOptions.platform,
    safeOptions.artifactId,
  ]
  if (fields.some(field => field !== undefined && !resourceStringFits(field))) {
    return undefined
  }
  const resource: ToolAuditResource = {
    kind: 'package',
    ...(ecosystem === undefined ? {} : { ecosystem }),
    name,
    ...(safeOptions.version === undefined
      ? {}
      : { version: safeOptions.version }),
    ...(safeOptions.platform === undefined
      ? {}
      : { platform: safeOptions.platform }),
    ...(safeOptions.artifactId === undefined
      ? {}
      : { artifactId: safeOptions.artifactId }),
  }
  return Object.setPrototypeOf(resource, null)
}

export function normalizeIdentity(identity: ToolAuditIdentity) {
  return identity.kind === 'bearer'
    ? {
        __proto__: null,
        kind: 'bearer',
        tokenHash: identity.tokenHash,
      }
    : { __proto__: null, kind: identity.kind }
}

export function normalizeRequestId(value: string | number | undefined) {
  if (typeof value === 'string') {
    return value.length <= MAX_ID_BYTES &&
      Buffer.byteLength(value, 'utf8') <= MAX_ID_BYTES
      ? { __proto__: null, value, truncated: false }
      : { __proto__: null, value: undefined, truncated: true }
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return { __proto__: null, value, truncated: false }
  }
  return { __proto__: null, value: undefined, truncated: value !== undefined }
}

export function normalizeTimestamp(value: string) {
  if (
    value.length > 64 ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value)
  ) {
    throw new TypeError('Invalid tool audit timestamp')
  }
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new TypeError('Invalid tool audit timestamp')
  }
  return value
}

export function readData(object: Record<string, unknown>, key: string) {
  const descriptor = Object.getOwnPropertyDescriptor(object, key)
  return descriptor && 'value' in descriptor ? descriptor.value : undefined
}

export function readString(object: Record<string, unknown>, key: string) {
  const value = readData(object, key)
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function resourceStringFits(value: string) {
  return (
    value.length <= MAX_RESOURCE_FIELD_BYTES &&
    Buffer.byteLength(value, 'utf8') <= MAX_RESOURCE_FIELD_BYTES
  )
}

export function utf8Prefix(
  value: string,
  maxBytes: number,
): { readonly value: string; readonly truncated: boolean } {
  let prefix = ''
  let byteLength = 0
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8')
    if (byteLength + characterBytes > maxBytes) {
      return { value: prefix, truncated: true }
    }
    prefix += character
    byteLength += characterBytes
    if (byteLength === maxBytes) {
      const next = value.codePointAt(prefix.length)
      return {
        value: prefix,
        truncated: next !== undefined,
      }
    }
  }
  return { value: prefix, truncated: false }
}

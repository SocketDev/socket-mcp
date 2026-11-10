import type { JsonObject, JsonValue } from './tool-types.mts'

const MAX_DEPTH = 6
const MAX_ITEMS = 128
const MAX_STRING_BYTES = 512
const MAX_KEY_BYTES = 128
const MAX_ARGUMENT_BYTES = 8 * 1024
const REDACTED = '[REDACTED]'
const OMITTED = '[OMITTED]'
const CIRCULAR = '[CIRCULAR]'
const ARRAY_TRUNCATED = '[TRUNCATED]'
const SENSITIVE_KEY_PARTS = [
  'token',
  'secret',
  'password',
  'passwd',
  'apikey',
  'authorization',
  'credential',
  'private',
]

export interface State {
  readonly seen: WeakSet<object>
  visited: number
  truncated: boolean
  bytes: number
  exhausted: boolean
}

export interface SanitizedToolArguments {
  readonly args: JsonValue
  readonly truncated: boolean
}

export function sanitizeToolArguments(value: unknown): SanitizedToolArguments {
  const state: State = {
    seen: new WeakSet<object>(),
    visited: 0,
    truncated: false,
    bytes: 0,
    exhausted: false,
  }

  const charge = (bytes: number): boolean => {
    if (state.bytes + bytes > MAX_ARGUMENT_BYTES - 32) {
      state.truncated = true
      state.exhausted = true
      return false
    }
    state.bytes += bytes
    return true
  }

  const marker = (markerValue: string): string => {
    charge(Buffer.byteLength(JSON.stringify(markerValue), 'utf8'))
    return markerValue
  }

  const isDataObject = (input: unknown): input is Record<string, unknown> => {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      return false
    }
    const prototype = Object.getPrototypeOf(input)
    return prototype === Object.prototype || prototype === null
  }

  const isSensitiveKey = (key: string): boolean => {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/gu, '')
    return SENSITIVE_KEY_PARTS.some(part => normalized.includes(part))
  }

  const keyFits = (key: string): boolean =>
    key.length <= MAX_KEY_BYTES &&
    Buffer.byteLength(key, 'utf8') <= MAX_KEY_BYTES

  const addProperty = (
    target: JsonObject,
    key: string,
    propertyValue: JsonValue,
  ): void => {
    Object.defineProperty(target, key, {
      configurable: true,
      enumerable: true,
      value: propertyValue,
      writable: true,
    })
  }

  const utf8Prefix = (input: string): { value: string; truncated: boolean } => {
    let result = ''
    let bytes = 0
    for (const character of input) {
      if (bytes >= MAX_STRING_BYTES) {
        return { value: result, truncated: true }
      }
      const size = Buffer.byteLength(character, 'utf8')
      if (bytes + size > MAX_STRING_BYTES) {
        return { value: result, truncated: true }
      }
      result += character
      bytes += size
    }
    return { value: result, truncated: false }
  }

  const visitArray = (input: unknown[], depth: number): JsonValue[] => {
    const output: JsonValue[] = []
    if (!charge(2)) {
      return [OMITTED]
    }
    for (let index = 0; index < input.length; index += 1) {
      if (
        state.exhausted ||
        state.visited >= MAX_ITEMS ||
        !charge(index === 0 ? 0 : 1)
      ) {
        state.truncated = true
        output.push(ARRAY_TRUNCATED)
        break
      }
      const descriptor = Object.getOwnPropertyDescriptor(input, String(index))
      state.visited += 1
      if (!descriptor || !('value' in descriptor)) {
        state.truncated = true
      }
      output.push(
        visit(
          descriptor && 'value' in descriptor ? descriptor.value : undefined,
          depth + 1,
        ),
      )
      if (state.exhausted) {
        if (index + 1 < input.length) {
          output.push(marker(ARRAY_TRUNCATED))
        }
        break
      }
    }
    return output
  }

  const visitObject = (
    input: Record<string, unknown>,
    depth: number,
  ): JsonObject => {
    const output: JsonObject = Object.setPrototypeOf({}, null)
    let propertyCount = 0
    if (!charge(2)) {
      addProperty(output, '[TRUNCATED]', OMITTED)
      return output
    }
    for (const key in input) {
      if (!Object.hasOwn(input, key)) {
        continue
      }
      const descriptor = Object.getOwnPropertyDescriptor(input, key)
      if (!descriptor?.enumerable) {
        continue
      }
      state.visited += 1
      if (state.visited > MAX_ITEMS) {
        state.truncated = true
        break
      }
      if (!keyFits(key)) {
        state.truncated = true
        continue
      }
      const keyBytes = Buffer.byteLength(JSON.stringify(key), 'utf8') + 1
      if (!charge(keyBytes + (propertyCount === 0 ? 0 : 1))) {
        break
      }
      if (!('value' in descriptor)) {
        state.truncated = true
        if (!charge(Buffer.byteLength(JSON.stringify(OMITTED), 'utf8'))) {
          break
        }
        addProperty(output, key, OMITTED)
        propertyCount += 1
        continue
      }
      if (isSensitiveKey(key)) {
        if (!charge(Buffer.byteLength(JSON.stringify(REDACTED), 'utf8'))) {
          break
        }
        addProperty(output, key, REDACTED)
        propertyCount += 1
        continue
      }
      addProperty(output, key, visit(descriptor.value, depth + 1))
      propertyCount += 1
      if (state.exhausted) {
        break
      }
    }
    return output
  }

  const visitPrimitive = (
    input: unknown,
  ): { readonly handled: boolean; readonly value: JsonValue } => {
    if (input === null || typeof input === 'boolean') {
      return {
        handled: true,
        value: charge(Buffer.byteLength(JSON.stringify(input), 'utf8'))
          ? input
          : marker(OMITTED),
      }
    }
    if (typeof input === 'string') {
      const prefix = utf8Prefix(input)
      state.truncated ||= prefix.truncated
      return {
        handled: true,
        value: charge(Buffer.byteLength(JSON.stringify(prefix.value), 'utf8'))
          ? prefix.value
          : marker(OMITTED),
      }
    }
    if (typeof input === 'number') {
      if (!Number.isFinite(input)) {
        state.truncated = true
        return { handled: true, value: marker(OMITTED) }
      }
      return {
        handled: true,
        value: charge(Buffer.byteLength(JSON.stringify(input), 'utf8'))
          ? input
          : marker(OMITTED),
      }
    }
    if (typeof input !== 'object') {
      state.truncated = true
      return { handled: true, value: marker(OMITTED) }
    }
    return { handled: false, value: OMITTED }
  }

  const visit = (input: unknown, depth: number): JsonValue => {
    state.visited += 1
    if (state.visited > MAX_ITEMS) {
      state.truncated = true
      return marker(OMITTED)
    }
    const primitive = visitPrimitive(input)
    if (primitive.handled) {
      return primitive.value
    }
    if (input === null || typeof input !== 'object') {
      state.truncated = true
      return marker(OMITTED)
    }
    if (depth >= MAX_DEPTH) {
      state.truncated = true
      return marker(OMITTED)
    }
    if (state.seen.has(input)) {
      state.truncated = true
      return marker(CIRCULAR)
    }
    state.seen.add(input)
    if (Array.isArray(input)) {
      return visitArray(input, depth)
    }
    if (!isDataObject(input)) {
      state.truncated = true
      return marker(OMITTED)
    }
    return visitObject(input, depth)
  }

  let args: JsonValue
  try {
    args = visit(value, 0)
  } catch {
    return { args: OMITTED, truncated: true }
  }
  if (Buffer.byteLength(JSON.stringify(args), 'utf8') > MAX_ARGUMENT_BYTES) {
    return { args: OMITTED, truncated: true }
  }
  return { args, truncated: state.truncated }
}

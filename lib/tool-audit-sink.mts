import { appendFileSync, mkdirSync, writeSync } from 'node:fs'
import path from 'node:path'

import { getSocketMcpAuditLogPath } from './env.mts'
import { TOOL_AUDIT_LIMITS } from './tool-audit-event.mts'
import type { ToolAuditEventV1 } from './tool-audit-event.mts'

export interface ToolAuditSinkOptions {
  readonly path?: string | undefined
}

export function emitToolAuditEvent(
  event: ToolAuditEventV1,
  options?: ToolAuditSinkOptions | undefined,
): void {
  try {
    const safeOptions = { __proto__: null, ...options }
    const encoded = JSON.stringify(event)
    if (encoded === undefined) {
      throw new TypeError('Invalid tool audit event')
    }
    if (Buffer.byteLength(encoded, 'utf8') > TOOL_AUDIT_LIMITS.eventBytes) {
      throw new RangeError('Tool audit event exceeds byte limit')
    }
    const filePath = safeOptions.path ?? getSocketMcpAuditLogPath()
    mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
    appendFileSync(filePath, `${encoded}\n`, {
      encoding: 'utf8',
      flag: 'a',
      mode: 0o600,
    })
  } catch {
    try {
      writeSync(2, 'mcp audit log write failed\n')
    } catch {
      return
    }
  }
}

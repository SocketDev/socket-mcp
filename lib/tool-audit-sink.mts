import { appendFileSync, mkdirSync, writeSync } from 'node:fs'
import path from 'node:path'

import { getSocketMcpAuditLogPath, getSocketMcpAuditSink } from './env.mts'
import { TOOL_AUDIT_LIMITS } from './tool-audit-event.mts'
import type { ToolAuditEventV1 } from './tool-audit-event.mts'

export interface ToolAuditSinkOptions {
  readonly path?: string | undefined
}

let invalidSinkSettingReported = false

export function emitToolAuditEvent(
  event: ToolAuditEventV1,
  options?: ToolAuditSinkOptions | undefined,
): void {
  const writeDiagnostic = (message: string): void => {
    try {
      writeSync(2, message)
    } catch {
      return
    }
  }
  try {
    const safeOptions = { __proto__: null, ...options }
    const encoded = JSON.stringify(event)
    if (encoded === undefined) {
      throw new TypeError('Invalid tool audit event')
    }
    if (Buffer.byteLength(encoded, 'utf8') > TOOL_AUDIT_LIMITS.eventBytes) {
      throw new RangeError('Tool audit event exceeds byte limit')
    }
    const sink = getSocketMcpAuditSink()
    if (sink === 'stderr') {
      const frame = Buffer.from(`${encoded}\n`, 'utf8')
      try {
        let offset = 0
        while (offset < frame.byteLength) {
          const bytesWritten = writeSync(
            2,
            frame,
            offset,
            frame.byteLength - offset,
          )
          if (bytesWritten <= 0) {
            throw new Error('Audit stderr write made no progress')
          }
          offset += bytesWritten
        }
      } catch {
        writeDiagnostic('mcp audit stderr write failed\n')
      }
      return
    }
    if (sink === 'unknown' && !invalidSinkSettingReported) {
      invalidSinkSettingReported = true
      writeDiagnostic('mcp audit sink setting invalid; using jsonl\n')
    }
    const filePath = safeOptions.path ?? getSocketMcpAuditLogPath()
    mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
    appendFileSync(filePath, `${encoded}\n`, {
      encoding: 'utf8',
      flag: 'a',
      mode: 0o600,
    })
  } catch {
    writeDiagnostic('mcp audit log write failed\n')
  }
}

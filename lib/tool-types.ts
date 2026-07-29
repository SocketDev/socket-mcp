/**
 * @file Internal types shared by every Socket tool module. The low-level
 *   `Server` lets each tool declare its input schema as raw JSON Schema, and
 *   TypeBox's `Type.*` constructors return JSON Schema directly, so a tool's
 *   `inputSchema` reaches clients verbatim — no zod, no conversion, no per-call
 *   validation layer. Every type here is structural, with no MCP SDK import, so
 *   the seam is portable across SDK majors and extractable into a shared
 *   package. Every `tool-*.ts` module exports a `define*Tool(): ToolSpec`. The
 *   server consumes the array via `server.ts` and dispatches `tools/list` +
 *   `tools/call` requests by name.
 */

/**
 * Any value JSON can carry. `null` appears because JSON Schema uses it — a
 * `default: null`, a `null` entry in an `enum` — so the type has to admit it
 * even though socket-mcp code prefers `undefined`.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

/**
 * MCP `Tool.inputSchema` shape: a JSON Schema object with `type: 'object'`, an
 * optional `properties` map and an optional `required` string array, plus any
 * further JSON Schema keywords a tool wants to set. Defined structurally so the
 * seam stays SDK-free; it is checked against the SDK's own
 * `Tool['inputSchema']` at the `tools/list` registration site in `server.ts`.
 */
export interface ToolInputSchema {
  type: 'object'
  properties?: Record<string, JsonValue> | undefined
  required?: string[] | undefined
  [key: string]: unknown
}

/**
 * Tool annotations the SDK forwards to clients. The only one socket-mcp sets
 * today is `readOnlyHint`; left open-ended so future flags don't need a type
 * bump.
 */
export interface ToolAnnotations {
  readOnlyHint?: boolean | undefined
  destructiveHint?: boolean | undefined
  idempotentHint?: boolean | undefined
  openWorldHint?: boolean | undefined
  title?: string | undefined
  [key: string]: unknown
}

/**
 * Per-request context the handler receives. `authInfo.token` carries the
 * per-request OAuth bearer (HTTP mode); stdio mode receives `undefined` and
 * falls back to the boot-time static key inside the tool body. The `unknown`
 * extras come from the SDK's pre-built `CallToolRequestSchema` and aren't read
 * by socket-mcp tools today.
 */
export interface ToolHandlerExtra {
  authInfo?: { token?: string | undefined } | undefined
  [key: string]: unknown
}

/**
 * What a tool handler returns. Mirrors the MCP `CallToolResult` shape —
 * `content` is an array of structured content blocks (only `type: 'text'` is
 * used today), `isError` marks a structured error response so the client knows
 * to surface it (vs a happy result that just happens to describe an error
 * condition). Optional extra keys pass through.
 */
export interface ToolCallResult {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean | undefined
  [key: string]: unknown
}

/**
 * One tool's full specification. `define*Tool()` returns one of these; the
 * server collects them into a name → spec map and dispatches `tools/call` by
 * name lookup.
 */
export interface ToolSpec {
  readonly name: string
  readonly title: string
  readonly description: string
  readonly inputSchema: ToolInputSchema
  readonly annotations?: ToolAnnotations | undefined
  readonly handler: (
    args: Record<string, unknown>,
    extra: ToolHandlerExtra,
  ) => Promise<ToolCallResult> | ToolCallResult
}

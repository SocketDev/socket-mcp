/**
 * @file Internal types shared by every Socket tool module. The high-level
 *   `McpServer.registerTool()` shape required zod (the MCP SDK v1 surface
 *   bakes zod adapters into the registration call path); migrating to the
 *   low-level `Server` lets each tool declare its input schema as raw JSON
 *   Schema. TypeBox's `Type.*` constructors return JSON Schema directly so
 *   `inputSchema` here matches the `Tool.inputSchema` shape the SDK ships
 *   to clients verbatim — no conversion, no per-call validation layer.
 *
 *   Every `tool-*.ts` module exports a `define*Tool(): ToolSpec`. The
 *   server consumes the array via `server.ts` and dispatches `tools/list`
 *   + `tools/call` requests by name.
 */

/**
 * MCP `Tool.inputSchema` shape: a JSON Schema object with `type: 'object'`,
 * optional `properties` map, optional `required` string array. TypeBox's
 * `Type.Object({...})` produces this exactly. Kept loose (`Record<string,
 * unknown>` properties) because the SDK passes the shape through to clients
 * without re-validating; the per-tool handler is responsible for guarding
 * the args it actually reads.
 */
export interface ToolInputSchema {
  type: 'object'
  properties?: Record<string, unknown> | undefined
  required?: string[] | undefined
  [key: string]: unknown
}

/**
 * Tool annotations the SDK forwards to clients. The only one socket-mcp
 * sets today is `readOnlyHint`; left open-ended so future flags don't need
 * a type bump.
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
 * per-request OAuth bearer (HTTP mode); stdio mode receives `undefined`
 * and falls back to the boot-time static key inside the tool body. The
 * `unknown` extras come from the SDK's pre-built `CallToolRequestSchema`
 * and aren't read by socket-mcp tools today.
 */
export interface ToolHandlerExtra {
  authInfo?: { token?: string | undefined } | undefined
  [key: string]: unknown
}

/**
 * What a tool handler returns. Mirrors the MCP `CallToolResult` shape —
 * `content` is an array of structured content blocks (only `type: 'text'`
 * is used today), `isError` marks a structured error response so the
 * client knows to surface it (vs a happy result that just happens to
 * describe an error condition). Optional extra keys pass through.
 */
export interface ToolCallResult {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean | undefined
  [key: string]: unknown
}

/**
 * One tool's full specification. `define*Tool()` returns one of these; the
 * server collects them into a name → spec map and dispatches `tools/call`
 * by name lookup.
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

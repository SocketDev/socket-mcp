# socket-mcp architecture

Detail extracted from `CLAUDE.md` to keep the in-context file under the 40 KB cap.

socket-mcp is the **Socket Model Context Protocol server** — exposes Socket dependency scanning + Socket.dev API surfaces to MCP-aware clients (Claude Desktop, Cursor, etc.).

## Layout

- `index.ts` — entry; registers MCP tools and starts the stdio server.
- `lib/` — tool implementations and Socket API wrappers.
- `artifacts.test.ts` — co-located unit tests; additional fixtures under `docs/`.

## Commands

- Install: `pnpm install`.
- Type check: `pnpm run type`.
- Test: `pnpm test` (vitest, single file: `pnpm test path/to/file.test.ts`).
- Lint: `pnpm run lint` ; Format: `pnpm run format` ; Check all: `pnpm run check` ; Fix: `pnpm run fix`.
- Build: `pnpm run build` ; Run locally: `node index.js`.

## MCP-specific notes

- The MCP protocol is stdio-framed JSON-RPC; nothing the server prints to stdout outside the framing is recoverable by the client. Use `getDefaultLogger()` (which writes to stderr) for diagnostics, never `console.log`.
- Tool descriptions are part of the wire contract — changing one is a breaking change for clients that key on the description text. Bump the server version when modifying tool descriptions or input schemas.
- Container image must include a CA bundle (the base image's `ca-certificates`) — the Socket API uses TLS and the MCP server can't prompt for a workaround at runtime.

## Testing

- Tests are `*.test.ts` co-located with sources (no `test/` dir convention).
- 🚨 **Never** use `--` before test paths — that runs ALL tests.
- Mock the Socket API surface; never let tests hit production.

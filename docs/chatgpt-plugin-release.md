# Socket plugin release

Prepared October 2, 2026.

**This package has not been uploaded, approved, or published.**

## Deliverables

The editable package is in `plugins/chatgpt/`. It contains `plugin.json`,
`mcp.json`, and Socket's existing 640x640 icon.

Generate the upload ZIP from that directory, with those files at the archive
root. Keep generated ZIP files outside the tracked source tree.

## Package decisions

- Display name and publisher: Socket.
- Plugin identifier: `socket`. Draft package version: 0.1.0.
- Remote MCP server: `https://mcp.socket.dev/` (Streamable HTTP).
- Category: Developer Tools.
- Support uses the public issues page. Privacy and terms use Socket's
  published URLs. Socket must confirm these are the listing URLs it wants.
- The package has no custom UI, screenshots, hooks, local runtime, embedded
  credentials, or registered-app references. Skills are optional and omitted.
- The package has five positive and three negative review cases. They are
  proposed cases, not completed ChatGPT evaluations. The expected results are
  qualitative, so a change in a security score does not make a case stale.
- The demo URL and country availability are left for the portal.

## Verification completed

These checks ran against the live server, which reported version 0.0.20:

- The public OAuth protected-resource metadata returned HTTP 200.
- The OAuth issuer `https://api.socket.dev` advertises the authorization-code
  flow, refresh tokens, PKCE `S256`, and dynamic client registration.
- MCP `initialize` succeeded with protocol version 2025-03-26.
- A session-based `tools/list` returned seven tools: `depscore`,
  `organizations`, `alerts`, `threat_feed`, `package_files`,
  `package_file_contents`, and `package_file_grep`.
- Every tool name in the review cases matches the live tool list.
- JSON syntax, listing text limits, image dimensions, asset references, review
  case counts, and ZIP contents and integrity passed local checks.

This is structural validation. It is not the OpenAI portal's validation or an
end-to-end ChatGPT installation test.

## Server findings

Each fix below is in the repository. None of them is live until a release that
contains it is deployed to `https://mcp.socket.dev/`.

| Finding                                                                                                                                                     | Status                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The seven tools set only `readOnlyHint: true`. Each tool needs `destructiveHint: false` and an explicit `openWorldHint`.                                    | Fixed in commit `f0881874`. `depscore` and the three package-file tools set `openWorldHint: true`, because they address any public package. `organizations`, `alerts`, and `threat_feed` set `false`, because each is limited to the connected organization.                                                              |
| The live `package_files` description says to pass a path to `package_file_contents`. That tool looks up a file by its blob hash.                            | Fixed in source since v0.2.0. Needs a deploy.                                                                                                                                                                                                                                                                             |
| The `depscore` description tells the model to stop all code generation on a low score. That is broader than the tool's purpose.                             | Fixed in commit `1a90356c`. The description now states what the scores mean and their limits.                                                                                                                                                                                                                             |
| The live server reports version 0.0.20. The repository package is 0.2.1.                                                                                    | Needs a deploy. The commits on this branch come after v0.2.1, so they need a new release first.                                                                                                                                                                                                                           |
| After a fresh `initialize`, a `depscore` call returned `No valid session`. An unauthenticated `organizations` call returned `Missing Authorization header`. | Explained. Version 0.0.20 keeps sessions in memory in each process, so a request that reaches another replica fails. The current server is stateless. `Missing Authorization header` is the expected 401 when OAuth is on. Commit `01277803` tests both across two replicas. Confirm on the live server after the deploy. |

Anonymous scoring does not work on an OAuth deployment. Every request needs an
OAuth access token, including `initialize` and `depscore`.

## Remaining publishing work

1. Use Socket's verified business identity in OpenAI Platform, and a project
   with the required plugin-management permissions.
2. Connect the endpoint in ChatGPT developer mode and complete the Socket
   sign-in. Verify account isolation, least-privilege scopes, refresh, expired
   tokens, and reconnect behavior. Confirm that token introspection returns an
   `aud` claim that names `https://mcp.socket.dev/`, or no `aud` claim. Never
   put API keys or OAuth secrets in the ZIP.
3. Release and deploy the server fixes above, then scan the production
   endpoint again.
4. Upload the ZIP through the MCP submission path in the Plugins dashboard.
   Complete any OAuth configuration that the dashboard shows. Host the exact
   domain-verification challenge token at the location that the portal names.
5. Give OpenAI a dedicated Socket reviewer account with sample organization
   data, through the secure dashboard form. Do not use a real customer's
   account.
6. Run all eight review cases in ChatGPT with that account and record the
   outcomes. The third case tests a multi-turn organization selection.
   Record an accessible demo and add its URL in the review details.
7. Confirm country availability, listing copy, the support route, and policy
   coverage for this integration. Resolve the portal's validation findings.
8. Submit for review. After approval, publish the approved version. Directory
   publication gives name search and a listing link. Featured placement is a
   separate OpenAI decision.

## Documentation

- <https://developers.openai.com/plugins/build/plugins>
- <https://developers.openai.com/plugins/deploy/submission>
- <https://developers.openai.com/plugins/deploy/submission-errors>
- <https://developers.openai.com/plugins/plugin-guidelines>
- <https://developers.openai.com/plugins/deploy/app-review>

## Documentation discrepancy

The submission-errors reference still mentions annotation justifications. The
current plugin-guidelines page says they are no longer required. Use explicit
boolean annotations and follow the portal's scan findings.

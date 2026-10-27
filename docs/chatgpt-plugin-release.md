# ChatGPT plugin release checklist

Use this checklist to prepare and publish the Socket plugin. Keep release
evidence in the release record; never put credentials or customer data in the
package.

## Release gates

- Deploy the MCP server changes before submitting the plugin. Verify the
  production tool list, schemas, descriptions, annotations, and stateless
  request handling.
- Complete OAuth sign-in for `https://mcp.socket.dev/`. Token introspection
  must return an `aud` claim naming that resource. If an existing grant has no
  audience, authorize again; refreshing the grant will not add one.
- Use the least-privilege scopes supported by the integration. Verify that
  organization data belongs to the signed-in account.
- Use a dedicated reviewer account with synthetic organization data. Never
  use a customer's account for review.

## Package and portal

1. Validate `plugins/chatgpt/plugin.json` and `mcp.json` against the current
   OpenAI plugin schemas. Confirm every referenced asset exists and uses the
   approved Socket brand asset.
2. Run `pnpm run plugin:chatgpt:pack` to check the package and build the
   upload ZIP, with `plugin.json`, `mcp.json`, and `assets/icon.png` at the
   archive root. The ZIP goes to the OS temp directory, outside the
   repository. Add `--strict` before submission to fail on an unmet
   submission gate, and `--out <dir>` to choose the destination.
3. Install the package in ChatGPT developer mode and sign in to Socket.
   Exercise the positive and negative review cases in `plugin.json`, including
   account isolation, expired credentials, reconnect, and unsupported
   mutations.
4. Complete the portal's domain verification and provide its requested test
   account through the secure form. Resolve validation findings and record the
   acceptance results.
5. Submit the reviewed package. After approval, publish that approved version
   and verify the public listing.

## Acceptance boundary

CI can validate package structure, assets, and repository tests. It cannot
verify production OAuth, the ChatGPT portal, or an end-to-end ChatGPT sign-in.
Record those checks separately before calling the integration ready.

## References

- <https://developers.openai.com/plugins/build/plugins>
- <https://developers.openai.com/plugins/deploy/submission>
- <https://developers.openai.com/plugins/deploy/submission-errors>
- <https://developers.openai.com/plugins/plugin-guidelines>
- <https://developers.openai.com/plugins/deploy/app-review>

I have all findings from the JSON. Let me compose the report directly.

# Socket MCP Tool Refactor — Quality Report

**Grade: D**

3 Critical and 8 High findings (several exploitable SSRF/fail-open paths plus a security gate that fails open) hold this below a passing grade. Medium/Low findings are mostly DRY/consistency debt. The Critical security and crash bugs must land before this refactor ships.

| Severity | Count |
| -------- | ----- |
| Critical | 3     |
| High     | 8     |
| Medium   | 13    |
| Low      | 9     |

---

## Critical

### 1. Fail-open security gate — `hooks/socket-gate.ts:261`

Any exception from `checkPackage()` (network, parse, auth, timeout) is caught and silently defaults to `outputAllow()`. An attacker can force a network failure to bypass the supply-chain gate entirely.
**Fix:** Fail closed — `outputDeny()` with the error reason; distinguish retryable (network) from terminal (malicious detected) before deciding. Log the error.

### 2. Unprotected `JSON.parse` in NDJSON map — `lib/register-depscore.ts:207`

`parseNdjsonPackageBody()` calls `JSON.parse(line)` inside `.map()` with no per-line guard. A single malformed line throws; the outer catch reports only a coarse "Error parsing response" with no line/package context.
**Fix:** Wrap per-line parse in try-catch — skip invalid lines or collect granular errors (e.g. `"Line 5: invalid JSON"`).

### 3. Blob cache exceeds byte cap — `lib/blob-cache.ts:38`

`evict()` runs only _after_ insertion (line 71). A single blob larger than `BLOB_CACHE_MAX_BYTES` pushes `cacheBytes` past the limit with no constraint, breaking the cache invariant (unbounded growth).
**Fix:** Check `cacheBytes + blobWeight(blob)` against the cap _before_ insert; reject/skip oversized blobs or evict-first-then-insert.

---

## High

### 4. SSRF via OAuth introspection endpoint — `lib/oauth.ts:327`

`oauthMetadata.introspection_endpoint` is fetched with no URL validation; `validateOAuthMetadataFields()` only checks it's a non-empty string. A malicious/MITM'd OAuth server can point it at internal services (e.g. `169.254.169.254`, `localhost:6379`).
**Fix:** Require HTTPS, reject loopback/private ranges (127/8, 10/8, 172.16/12, 192.168/16, 169.254/16), and confirm it belongs to the expected issuer domain.

### 5. SSRF via OAuth issuer — `lib/oauth.ts:220`

`config.issuer` (from `SOCKET_OAUTH_ISSUER`) builds a metadata-discovery URL with no validation. Setting it to `http://localhost:9000` or an internal host forces server-side requests there.
**Fix:** Validate issuer — HTTPS only (HTTP for localhost testing), reject private/loopback ranges and suspicious ports.

### 6. Host header injection under `TRUST_PROXY=true` — `lib/http-server.ts:349`

`getRequestBaseUrl()` trusts `X-Forwarded-Host` unvalidated; `validateOriginAndHost()` checks only the real `Host`. The poisoned baseUrl flows into OAuth metadata (lines 362, 378), redirecting clients to an attacker-controlled OAuth server.
**Fix:** When `TRUST_PROXY=true`, validate `X-Forwarded-Host` against an explicit allowlist; reject non-matching hosts.

### 7. Blob cache concurrent-fetch race — `lib/blob-cache.ts:55`

No dedup for concurrent `getOrFetchBlob(hash)` misses. Both callers fetch, both insert, the Map overwrites but `cacheBytes` is incremented twice — temporary overflow and inaccurate accounting across the shared module-scoped state (one per-session server, shared cache).
**Fix:** Track in-flight fetches in a `Map<string, Promise<BlobResult>>`; return the shared promise so only one insert per hash per cycle.

### 8. Offset filter breaks chunk-skip optimization — `lib/blob.ts:127`

`manifest.offset` is length-checked against `chunks.length` _before_ `.filter()` removes non-numeric entries. The post-filter check at line 134 then fails whenever any offset was non-numeric, so the optimization is skipped and all chunks are refetched.
**Fix:** Capture the original length before filtering (or validate all offsets are numbers up front) and compare against that.

### 9-12. Inline auth-missing / error responses bypass `errorResult()` — `lib/register-alerts.ts:95,122`, `register-organizations.ts:32`, `register-package-files.ts:158`

Four registrars hand-build `{ content: [{ type: 'text', text: AUTH_REQUIRED_MSG }], isError: true }` (and other error returns) inline instead of the exported `errorResult()` (server.ts:53-58) that `register-depscore.ts` uses consistently. Diverging shape + missing error logging.
**Fix:** Add a shared `authRequiredResult()` to server.ts; route all registrar error returns through `errorResult()` and add the missing `logger.error` on the auth-missing path.

### 13. Duplicated HTTP header construction — `lib/alerts.ts:86`

The accept/user-agent/authorization/extraHeaders-merge block is verbatim in `alerts.ts:86-95`, `organizations.ts:22-31`, `threat-feed.ts:99-108`, `files.ts:123-132` (blob.ts intentionally omits accept).
**Fix:** Add `buildHttpHeaders(userAgent?, authToken?, extraHeaders?)` to http-helpers.ts; use across the four data modules.

---

## Medium

- **`lib/blob.ts:144`** — `Promise.all` chunk fetch fails fast without chunk index/hash context. _Fix:_ wrap `fetchRawBytes` with index/hash in the error, or use `allSettled` if partial chunks are acceptable.
- **`hooks/socket-gate.ts:66`** — `AbortSignal.timeout()` per request; minor allocation churn under high volume. _Fix:_ acceptable for a hook; consider module-level controller if hot.
- **`lib/blob-cache.ts:31`** — `blobWeight` uses `string.length` (UTF-16 units), underestimating UTF-8 byte size; 256-byte overhead is arbitrary. _Fix:_ `TextEncoder().encode(text).length + overhead`; bump overhead to 512-1024.
- **`lib/blob-cache.ts:39`** — Eviction relies on undocumented Map insertion-order; collisions from the concurrent-fetch bug can mis-pick the LRU victim. _Fix:_ document the ordering assumption; fix #7.
- **`lib/blob-cache.ts:46`** — `cacheBytes` can go negative if victim is falsy or weight is 0. _Fix:_ guard victim truthiness, assert `blobWeight > 0`, clamp with `Math.max(0, …)`.
- **`lib/env.ts:92`** — `SOCKET_BLOB_URL` defaults to `https://socketusercontent.com` with no validation; an attacker-set value leaks file hashes/contents. _Fix:_ require HTTPS, reject private/loopback, prefer a hardcoded constant.
- **`lib/blob-cache.ts:23`** — `SOCKET_BYPASS_HEADER_NAME/VALUE` added unconditionally to all requests; leak/misconfig enables exfiltration. _Fix:_ restrict to the intended domain, validate header names, log usage.
- **`lib/register-depscore.ts:116` + `register-alerts.ts:79`** — Auth-token resolution `authInfo?.token || getStaticApiKey()` duplicated across all 5 registrars. _Fix:_ `resolveAuthToken(authInfoToken)` in server.ts.
- **`lib/alerts.ts:97`** — Endpoint-error message strings diverge across alerts/orgs/threat-feed/files/blob. _Fix:_ shared `buildHttpError(endpoint, response)` in http-helpers.ts.
- **`lib/register-alerts.ts:93`** — Auth-missing path logged in depscore but silent in 4 others. _Fix:_ standardize (log in all, or none).
- **`lib/register-alerts.ts:101`** — snake_case→camelCase filter mapping near-identical in alerts:106-116 and threat-feed:106-122. _Fix:_ extract typed `buildAlertsFilterFlags`/`buildThreatFeedFilterFlags`.
- **`lib/register-depscore.ts:128`** — depscore does manual status-code handling; other registrars delegate throw-on-`!res.ok`. _Fix:_ unify on one approach (shared `fetchWithErrorHandling` or push status handling down).
- **`lib/register-depscore.ts:137`** — depscore special-cased with raw `httpRequest` + content-type negotiation (NDJSON vs JSON) while others use higher-level modules. _Fix:_ pick one abstraction level; move NDJSON parsing to a shared parser or wrap depscore's own request.

---

## Low

- **`lib/blob-cache.ts:28`** — Same-key overwrite on hash collision (unlikely for crypto hashes). _Fix:_ document keys as trusted/content-addressed; optionally verify content on retrieval.
- **`lib/socket-url.ts:1`** — `SOCKET_REPORT_BASE` hardcoded `https://socket.dev`, not configurable. _Fix:_ optional HTTPS-validated env override for on-prem.
- **`lib/register-depscore.ts:116`** — Auth fallback chain (per-request OAuth token → static env token) undocumented; HTTP-without-OAuth start path. _Fix:_ document the chain (startup enforcement at index.ts:66-79 is acceptable).
- **`lib/http-server.ts:301`** — `req.url` parsed against `http://localhost:${port}`; a full absolute URL would win, but origin validation precedes this (line 329). _Fix:_ assert `req.url` starts with `/` before constructing.
- **`lib/oauth.ts:331`** — Introspection client secret base64-encoded (reversible) in Basic auth; acceptable per RFC 6749 over HTTPS. _Fix:_ ensure HTTPS-only (covered by #4).
- **`lib/register-alerts.ts:79`** — Divergent filter-logging patterns (some snapshot user input, some don't). _Fix:_ standardize and mask sensitive values.
- **`lib/register-depscore.ts:104`** — `socket-mcp/${VERSION}` user-agent built inline in 3 registrars; depscore uses `buildSocketHeaders`. _Fix:_ shared `SOCKET_MCP_USER_AGENT` constant.
- **`lib/register-organizations.ts:25`** — `void args` style for no-input tool is inconsistent with other registrars. _Fix:_ standardize and document.
- **`lib/register-package-files.ts:160`** — `package_file_contents` / `package_file_grep` skip auth validation (blob fetch is public/content-addressed). _Fix:_ confirm auth is genuinely optional and document, or add validation.

---

**Bottom line (D):** Ship-blocking before merge — fix the three Critical items (fail-open gate, NDJSON parse crash, cache cap) and the four SSRF/host-injection High items in oauth.ts and http-server.ts. The remaining High items are DRY consolidation (`errorResult()`, shared header builder) that are low-risk but should land in the same pass since they cluster. Once Criticals and the security Highs are fixed, this moves to a B; full consistency cleanup earns an A.

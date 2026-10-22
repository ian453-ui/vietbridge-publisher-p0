# V3 slice 13 — portable, read-only Facebook video receipt adapter

Base `7405029abd4b51d3ada6506c5691ffc87edddd81`, same V3 branch and private Site.
This package fills one concrete cloud dependency: reading the **known original
video receipt** without the native credential-file/MCP path. It does not add
upload, submit, discovery, token migration, account registration or a live route.

## Why this gap, and what is reused

The async quota ledger already preserves the original permit contract and UNKNOWN
occupancy. Live exclusive custody/history is still unavailable: no trusted live
provider or migrated token exists in this cloud environment. Inventing a second
writable authority would not solve it. The independently testable next step is
therefore an operation-specific readback adapter.

The existing `FacebookVideo` uses Node file/config/proxy dependencies. The original
`ApiDriver.readback` also opens its local MCP/config before reading a video, with
no cloud dependency seam. The acceptance test for an injected reader failed on
the original code (**0/1**, `LEGACY_LOCAL_CONFIG_MUST_NOT_RUN`). This is a missing
cloud interface, not a newly discovered live credential vulnerability.

The implementation adds an optional **server constructor dependency** to the
existing `ApiDriver`, ahead of that local access. Without it, all existing native
paths remain unchanged. Only single-video Facebook readback can use the seam.
`verifiedFacebookVideo` is moved unchanged into a pure module and re-exported from
its original TypeScript module, so existing consumers retain the same contract.
No original UI, account switching, platform upload or submission path is replaced.

## Source and protocol evidence

On 2026-10-22 the Meta Graph video-reference and Graph-overview documentation
returned **429** to the read-only browser tool. They were not repeatedly retried.
Current Page permission requirements and actual account/API-version availability
therefore remain unverified here. No scope/permission list was guessed.

Readable primary sources:

- [Meta generated AdVideo SDK](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/advideo.py): the object GET shape and selected id/from/title/description/published/status/permalink fields.
- [Meta video encoding checker](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/video_uploader.py): GET of a known video ID and status.video_status readiness check. Ad-account upload code is **not** treated as Page publishing authority.
- [Meta Messenger getting-started documentation](https://developers.facebook.com/documentation/business-messaging/messenger-platform/get-started): the available official search excerpt explains that `me` represents the Page when using its Page token. Full permissions were not inferred from that excerpt.
- [SDK license](https://github.com/facebook/facebook-python-business-sdk/blob/main/LICENSE): Meta license for use with Facebook APIs, subject to its platform policy; not described as MIT. No SDK code or dependency is copied or installed. The shared predicate comes from this repository.

The adapter fixes the origin to `https://graph.facebook.com`, requires an explicit
server-selected `vN.0` version, and performs at most two GET requests:
`/{version}/me?fields=id`, then `/{version}/{original-video-id}` with the same
explicit video fields already used by the native reader. Tests select v25.0,
matching the existing native default; this is not a claim that it is the latest
or currently enabled version for the user's app. No upload endpoint is added.

## Trust and bounded reads

`FacebookVideoReadback` has **no default provider**. Construction does not read
files, environment tokens, browser sessions or credentials. Its server-only
provider contract is:

1. `resolveReadback(binding, {signal})` independently resolves the original stored
   job, attempt, frozen snapshot and recorded receipt, verifies current scoped
   read authority, and supplies an in-memory Page credential and explicit API
   version. Binding includes the READBACK operation, workspace/account, distinct
   actor/Page IDs, full snapshot hash and original object ID.
2. `revalidateReadback(proof, {signal})` rechecks those exact records and the read
   grant revision before each GET and before returning evidence. Only literal
   `true` accepts. It must not conflate content approval withdrawal with loss of
   authority to inspect an already submitted result.

The provider must come from an existing trusted authority. This package supplies
**no production provider**, issuer or credential loading code. A caller supplying
an authenticated flag, content approval or import Bearer cannot configure it.
The test provider independently knows the expected frozen binding; the integration
fixture also reads the original SQLite job/attempt/receipt before resolving and
revalidating. This fixture is not silently registered in the app.

The snapshot is copied before asynchronous work. The returned grant is copied,
checked for exact binding, original job/attempt identifiers, expiry and revision.
The Page token is sent only in Authorization headers, not URLs or receipts. Page
identity must match before reading the video. Video ID, author Page, full title
and description, published flag, ready status and canonical original-ID link
must match. Unknown/processing/draft/missing objects cannot pass.

Reads share one deadline (default 10 s, hard configuration ceiling 15 s) and a
combined 256 KiB response ceiling. Streaming bodies, declared length, malformed
UTF-8/JSON, non-JSON content, redirects and transport errors are bounded or
rejected. Even a test provider/transport that ignores abort cannot produce a late
accepted result. No automatic retries, token refresh, account fallback, pagination
follow, feed scan or substitute object lookup occurs. Missing original ID stops
before HTTP. HTTP 401/403/404/429/5xx yields a sanitized failure and
RECONCILE_PENDING, never absence proof or permission to submit again.

Only matching, whitelisted observation fields and their SHA256 are returned.
Remote error text and arbitrary response properties are not logged or persisted.
Permalink tracking parameters are removed; foreign hosts/IDs are rejected and
links are never fetched. `mediaBytesVerified:false` is explicit: metadata/status
readback cannot prove the remote encoded bytes equal the original upload. The
hash covers the selected observation, not an invented whole remote-media digest.

## End-to-end acceptance and self-review

The controlled HTTP server binds loopback only. A test transport rewrites the
fixed Graph request to that server and checks method/header/query/redirect rules.
Only obviously synthetic token strings, IDs, media and task data are used. No
actual Facebook or user Drive request occurs in the tests.

Final targeted run: **33/33**, fail/cancel/skip 0, **1.256 s**. This includes the
original injection failure, success through the existing API driver, wrong
Page/content/ID/status/link, absent provider/receipt, cross-customer/account
concurrency, changed snapshot, revoked/expired read grant, 401/403/404/429/500,
redirect, response limits, bad UTF-8/JSON, slow stream and abort-ignoring transport.

The integration regression uses the **original UnifiedPublisher/UnifiedExecutor**
and file SQLite tables. It seeds an original UNKNOWN intent/receipt with frozen
synthetic video, observes a failed protocol read with UNKNOWN unchanged, reopens
the database, then reconciles the exact original object and persists its readback.
Repeated reconciliation cannot create a second effect. Actual submit calls: **0**;
original intent count: **1**; original receipt count: **1**. No mock successful
publication replaces the original executor's completion contract.

```sh
node --test test/facebook-cloud-video-readback.test.js test/unified-drivers.test.js

PUBLISHER_TEST_BROWSER_PATH=/usr/bin/chromium \
PUBLISHER_TEST_FFMPEG_PATH=/usr/bin/ffmpeg \
node --test --test-concurrency=4 test/*.test.js
```

The complete final regression passed **1181/1181**, fail/cancel/skip 0, in
**117.372 s**. Original failing output and source/log hashes are recorded
in [evidence](evidence/v3-slice-13-evidence.json). All five changed/new JS/TS files
pass syntax checks. Self-review confirms original submit/claim/quota, async
approval-withdrawal guards, and UNKNOWN transitions were not modified. The new
module has no mutation method or live routing registration.

## Remaining actual dependencies

This is an offline-verified protocol implementation, not real platform acceptance,
not hosted Sites, and not an automatic release of UNKNOWN quota. The existing
closed async executor remains synthetic-only; this adapter is not injected there
or used to settle its synthetic objects. Future cloud integration still needs the
existing trusted job/attempt/receipt + read-authority + in-memory credential
provider and its concurrency-safe persistence wiring. Read grants must remain
separate from publication permits. Real upload/submit, exclusive permit/history
custody, image/text/other-platform readback and general messaging remain separate
gaps in the complete product matrix.

The cloud environment restarted for this turn. One bounded read-only scan of
`/opt/codex`, `/workspace/.agents`, `/workspace/.codex`, `/workspace/sites` found no
`project-setup.mjs`, `site-workflow.mjs` or official worker-esm/Vinext starter.
No denied bundle/download was retried, and no network/security/sharing changes
were made. Same Site `appgprj_6ad97a034fd08191a8399eeda10f048c` is retained. Mac
remains unnecessary for development; its offline Group token is not available
here. Formal cloud deployment and real identity/D1/R2 acceptance remain blocked.

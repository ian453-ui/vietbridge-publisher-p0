# V3 slice 07 — Sites project and persistent authoring migration

Base: `31fcb41140b771bfc69221734209b0e82d3fbf96`, same independent branch
`publisher-v3/cloud-slice-01`. Formal delivery remains ChatGPT Sites plus cloud
services. This package creates the separate owner-private Site and implements
the portable customer → account → content version → platform preview → frozen
task path. It does not claim a hosted build or complete operations product.

## Reuse and minimum new interfaces

`src/sites/readonly-api.js`, `membership.js` and the existing isolated read
projection are reused. New writes populate the original `facebook_accounts`,
`publisher_content_sources` and `publisher_jobs` projections, including exact
workspace/account/content/snapshot identities. The historical account-table name
does not imply a Facebook login or permission. Native V1/V2 UI, executor, Review,
ZIP, metrics, permits, quota and UNKNOWN paths are untouched.

`createCloudAuthoringApi({db,origin,getTrustedIdentity,now})` is Worker-compatible
ESM using WebCrypto and Fetch APIs, without Node/SQLite/ffmpeg imports. The trusted
identity callback is mandatory and runs server-side per request. No header/body
claim, email, first-visitor global owner enrollment or `authenticated:true` unlocks
it. Official Sites dispatch integration is still required; the sole fixed-user
implementation lives under `test/`.

| Route | Behavior |
| --- | --- |
| GET `/api/sites/capabilities` | Explicit supported authoring and unavailable execution/media/approval/interaction capabilities |
| GET/POST `/api/sites/workspaces` | Owner-scoped list; explicit creation of a new customer resource |
| GET/POST `/api/sites/workspaces/:id/accounts` | Exact customer account mapping, UNCONFIGURED; adds only that existing user's READER membership for the new mapping |
| GET/POST `/api/sites/workspaces/:id/contents` | Exact account + full content ID + slug + revision; body/platform hashes and immutable versions |
| GET/POST `/api/sites/workspaces/:id/tasks` | Exact expected hash and explicit platform variant → frozen DRAFT; duplicate UNKNOWN returns UNKNOWN |
| GET `/api/unified/workspaces/:id/{jobs,source-ledger}` | Existing scoped read API, unchanged domain states |

GET content/task routes require `accountId`. POST commands require same Origin,
JSON, exact known fields and a client command UUID. Streaming input is capped at
128 KiB; full body/platform text at 20,000 characters each. Workspace/account lists
and content/task lists are capped at 200; pagination remains pending. There are no
credential, upload, approve, execute, reconcile, publish, reply or deletion routes.
All new responses retain `publish_allowed:false` and failed source-auth gates.

## Persistence, identity and concurrency

The additive candidate migration introduces customer ownership, scoped account
details, immutable content versions, job snapshots and command receipts. It is
**unapplied**, schema-only and not yet generated/registered with official Drizzle
metadata. It targets a new isolated Sites database, not the native Publisher DB.
No database provisioning or request-time DDL occurred.

A D1-shaped batch inserts the unique owner/command receipt and all dependent rows
atomically. Dependent inserts select the winning command's entity ID and hash;
two callers cannot use their losing UUID to create a second resource. Same command
with different bytes is rejected. A later insert failure rolls back receipt and
all rows. Existing content version with different bytes conflicts; existing task
keeps its actual state and attempt, including UNKNOWN. New content versions do not
rewrite earlier frozen payloads. Same intent submitted concurrently with different
command IDs may yield a safe uniqueness conflict; refresh before any user retry.

Owner and active account membership are checked before database operations.
Membership changes concurrent with a batch have not been proven to serialize with
that batch; no membership mutation endpoint exists here. Hosted D1 concurrency
semantics remain unverified. Stable Site user ID integration is code still to
connect, not evidence of independent tenant-login/RBAC acceptance.

`cloud-console.html/css/js` reads and writes these handlers. Business records live
in the database. LocalStorage stores only selected IDs. Generation checks drop
delayed responses from the old account/customer; switching also closes the old
content form and preview. Complete body and explicit platform text are rendered
with escaped content, frozen task hashes are visible, and missing operations are
labeled unavailable. Nine navigation destinations preserve the product structure;
their existence does not claim group/inbox/review/metric execution in Sites.

## Acceptance matrix and actual runs

All tests below ran this package in the cloud development environment with
synthetic data. Test fixture SQLite implements the async D1 method shape; **no
hosted D1 acceptance is inferred**. Browser tests use fresh Chromium contexts and
loopback servers. The final targeted run rejects all outside browser requests.

| Acceptance | Actual evidence | Status |
| --- | --- | --- |
| Separate owner-private Site, stable saved ID | Native create/get, redacted registration record | Passed registration; version 0, not deployed |
| Customer/account/content/platform/task writes and restart | Actual file SQLite, close/reopen, original projections | Passed synthetic |
| Two users, customers, accounts, revoked membership, forged claims | API negative cases | Passed synthetic; hosted identity not connected |
| Full 074 IDs, slug/revision/body conflict; explicit platform only | API exact-binding regression | Passed synthetic |
| Partial batch failure, same-command concurrent connections | Transaction fault + two SQLite connections | Passed synthetic; not real D1 concurrency proof |
| UNKNOWN duplicate, changed hash, prior-version preservation | Actual persisted snapshots and attempted duplicate | Passed synthetic; no executor call |
| Desktop/mobile full preview, reload and scope switching | Chromium 1440×1000 / 390×844, delayed responses | Passed; zero outside requests in final targeted run |
| V1/V2 and previous six-package gates | Complete current regression | 1042/1042 passed |
| Official starter/build/dispatch/D1/R2/private deployment | Required helper/starter missing | Not run; supported runtime unavailable |
| Media/ZIP/Review/metrics on hosted Sites | Native code retained; async/storage integration pending | Not implemented/verified in Sites |
| Real upload/publish/groups/replies/DM/live metrics | No new external operation | Not enabled or live verified |

Commands:

```sh
PUBLISHER_TEST_BROWSER_PATH=/usr/bin/chromium \
V3_SITES_EVIDENCE_DIR=/tmp/v3-sites-evidence \
node --test --test-concurrency=2 test/sites-cloud-*.test.js \
  test/sites-readonly-api.test.js test/sites-membership.test.js

PUBLISHER_TEST_BROWSER_PATH=/usr/bin/chromium \
PUBLISHER_TEST_FFMPEG_PATH=/usr/bin/ffmpeg \
V3_SITES_EVIDENCE_DIR=/tmp/v3-sites-evidence \
node --test --test-concurrency=4 test/*.test.js
```

Results: initial authoring **8/8**. Initial combined run **20/22** failed because
two UI assertions did not include the explicit Chinese unavailable phrase; the
assertion was corrected without weakening a product gate. Combined rerun **22/22**.
Full regression **1042/1042**, fail/cancel/skip 0, 104.737 seconds. Screenshot
inspection found insufficient contrast on a selected hovered tab; the CSS was
corrected. Following that CSS change, explicit list-limit copy, and the extra
external-request block on the delayed-scope test, the final targeted run was
**22/22**, 5.250 seconds. Full regression was not repeated for those changes.
Log hashes and exact final results are in
[v3-slice-07-evidence.json](evidence/v3-slice-07-evidence.json).

Screenshots are generated synthetic UI, not the live Site:
[desktop](evidence/v3-slice-07-desktop.png),
[mobile](evidence/v3-slice-07-mobile.png).
No actual customer media, credentials, profiles or login screens are included.

## Runtime status and next concrete step

Project **`appgprj_6ad97a034fd08191a8399eeda10f048c`** is already registered and
owner-only; do not recreate. `.openai/hosting.json` is durably saved in the separate
Sites checkout. No source push/save/deploy or hosted migration was attempted.

The official Sites instructions became readable, but required helper scripts,
complete Vinext starter, its server-only auth helper and Sites build integration
are absent. Later skill reads again returned `skill package is not available`.
The exact dependent blocker and resume steps are in
[Sites target](v3-sites-target.md). This is not a denied deployment or pending
approval. No extra user decision or permission scope is required at this point.

The next operation is restoring the supported starter/helpers, importing the
prepared portable source while keeping this project ID, integrating official
identity and generated D1 migrations, then building/private-deploying and testing
actual hosted persistence. R2/media transport, async Review/metric persistence,
cloud decoder service and real trusted producer/platform adapters remain concrete
integration work. No static shell or local demo is counted as formal delivery.

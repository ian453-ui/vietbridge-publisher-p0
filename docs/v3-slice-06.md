# V3 slice 06 — source evidence and independent publication authority

Base: `4f3ff071bc5ced5a7867a5d377e7d2182b8589f6`, existing independent
`publisher-v3/cloud-slice-01` branch. All implementation and tests run in the new
cloud development worktree. No Mac checkout, production service or credential is
changed. The formal V3 UI target is now **ChatGPT Sites**, with cloud services;
Node browser tests below are development evidence, not hosted delivery.

## Reuse and actual gap addressed

`production-artifact-contract.js` already binds original task/owner, bridge thread,
request revision and complete result hashes. It does not authenticate the author.
`gpt-drive-inbox.js` binds approved local body/image revisions to a particular
library root; its local approval marker is not authenticated producer transport.
Neither is promoted to identity evidence. No existing usable real provider was
found in this environment.

`ProductionSourceEvidence` adds server-injected, read-only source verification.
The existing `ProductionApprovalStore` remains responsible for human decisions,
version/account/media checks and revocation. `ProductionUploadPlans` and the native
executor/UNKNOWN ledger are reused without a new publish path. The original
administrator, JSON/Origin/CSRF and app-scope restrictions protect the added route.

## Adapter and binding contract

There is no production provider implementation, registration endpoint, automatic
credential discovery, OAuth flow, environment flag or fallback source transport.
The sole provider implementation is `test/fixtures/trusted-production-source.js`.
Server construction may inject `productionSourceEvidence: {providers, bindings}`;
no request can choose an adapter, author, submission reference or authentication
flag. `authenticated: true` and all extra command fields are rejected.

Each immutable server binding specifies the exact Review/workspace/account,
provider ID, original bridge task reference, expected submission reference,
task-author and producer principals (`issuer` + `subject`), permitted source
approver principals, and evidence lifetime (at most five minutes). Changing a
binding in place is refused. This is privileged adapter configuration, not a new
user authorization or an identity inferred from a name/email.

Adapter method:

```js
readSnapshot({task_reference, submission_reference, signal, maxBytes})
// => Promise<Buffer>, JSON, at most 1 MiB
```

The adapter must derive identity metadata from its existing authenticated read
transport independently of producer content. It must return complete ordered
approval history, not a cached title/PASS marker or truncated page. A source
without a trustworthy identity/history implementation remains unavailable.
No network adapter is installed or contacted in this package.

The snapshot has exact keys `schema_version:1`, `provider_id`, integer
`observed_at`, `history_complete:true`, `task`, `submission`, `decisions`.
Task includes reference, author principal and the original full request;
submission includes reference, author, original task reference and full result.
Every decision has ID, contiguous sequence starting at 1, APPROVED/REVOKED kind,
author, integer decision time and `binding_hash`. That digest covers the exact
Review, task/revision, workspace/account, request/result fingerprints and current
content subject. The existing subject in turn binds the account identity, platform
targets, full content revisions, source references and all artifact byte hashes.

The service validates full payload equality, identities, references, time bounds,
decision order, binding hashes and history completeness. Accepted source history
is append-only. Reusing a sequence/event identity with different bytes or omitting
previously seen decisions records a conflict instead of overwriting prior proof.
The bounded raw response and SHA256 are retained even for validation failures;
oversized data is not retained. Errors do not echo provider exception details.

Additive SQLite tables: `production_source_requirements`,
`production_source_attempts`, `production_source_receipts`,
`production_source_decisions`, `production_approval_source_bindings`. Attempts are
allocated before the asynchronous read. Latest-started generation controls status;
pending/failure/timeout never falls back to an old success. Independently, any
newer authoritative decision learned by an older request vetoes a receipt bound
to an earlier decision, so a late revocation cannot be ignored. Observed-time and
local attempt age both limit freshness. Restart without reattaching the trusted
provider is unavailable even when old evidence persists.

Timeout is an async response deadline with AbortSignal, not an OS sandbox or hard
CPU/memory limit on privileged adapter code. A late ignored-abort response cannot
write a second receipt. A real adapter must enforce network streaming/size limits
and cooperative cancellation itself. No automatic retry runs after a denial.

## Human decision and original UI connection

**POST `/api/production-reviews/<id>/verify-source?workspace=<id>&accountId=<id>`**
accepts only `{ "expected_subject": "<current SHA256>" }` from the existing admin.
The Review detail returns a small `source_verification` summary; raw transport
records and source principals are not sent to the browser. The existing Review
section shows source status and, only when configured, a deliberate read button.
It never approves content automatically.

For a Review with a source requirement, explicit local CONTENT_APPROVED records
the source attempt, decision digest and content binding in the same transaction.
An insert failure rolls both event and link back. New source revocation, changed
decision, stale proof, changed account/media/version or missing provider invalidates
the prior local approval at the next read/check. Re-reading the same source
approval does not create another human decision. In-flight reads can conservatively
invalidate an approval while evidence is pending; refreshing proof does not
automatically restore an invalidated human approval.

Real/unverified provenance remains `PRODUCER_AUTH_UNAVAILABLE` even after the
new observational interface verifies a test snapshot. All outputs retain
`producer_authenticated:false`, `source_gate_satisfied:false`,
`publish_allowed:false`. The existing SYNTHETIC_FIXTURE/closed-driver execution
guard is not removed. This package supplies missing binding code, **not a real
producer-authentication rollout**.

## Independent publication evidence

`observePublicationAuthority` reads the native job and exact existing
`SingleExecutionPermits`/`scopedOperations` capability. Any original single-use
record wins, including expired, revoked and consumed records; no fallback can
revive it. Scoped policy without a task permit is explicitly
`EXACT_CONFIRMATION_REQUIRED`, not an issued permit. The response includes the
frozen job/account/platform/snapshot digest and appears on upload-plan responses.
It never issues, consumes, renews, reserves quota, submits, reconciles or grants.
Its `can_execute`/`publish_allowed` are always false; `eligible` is an observation
of the existing mechanism only. The global execution switch supplies no evidence.

Existing single-use permits are for frozen **Facebook text-only Page** tasks.
They are deliberately not broadened to reviewed video/image jobs. Existing scoped
history, daily quota, duplicate, consumed-attempt and UNKNOWN checks are retained.
Source content approval never constitutes a publication permit.

## Acceptance matrix and execution evidence

| Case | Actual exercise | Expected/observed boundary |
| --- | --- | --- |
| Exact original request/result/source principals | Trusted provider fixture; mismatched task, author, submission, media hash | Verified only exact matching evidence; failures persisted |
| Client self-authentication and cross-scope | HTTP and service cases | Rejected before provider call; existing app scopes unchanged |
| Human decision binding/idempotency | Native Review/ZIP/frozen upload plan | Exact source receipt linked atomically; no automatic approval |
| New QA revokes old PASS | New source sequence then original Review/UI | Old local approval revoked; native plan unavailable |
| Timeout, throw, oversized output, old late response | Async fault injection | No old-success fallback, bounded receipt, no late second write |
| Attempt order and source-history order | Overlapping reads + two SQLite connections | Latest generation retained; any newer revocation vetoes old approval |
| Restart and missing provider | New SQLite connection/service | Evidence survives; unconfigured provider blocks; no automatic reapproval |
| Receipt/link transaction failure | SQLite triggers in mid-transaction | Receipt/history or human event/link rollback; pending state fails closed |
| Independent authority | Actual existing permits/scoped classes | Read-only; legacy revoke wins; no claim, quota or driver side effect |
| UNKNOWN after simulated submit | Source revokes before original reconcile | One simulated submit; retry denied; original readback succeeds |
| Desktop and phone | Original browser Review at 1440×1000 / 390×844 | Read source → explicit approve → new source revoke → reload |
| Real transport/platform/Sites | No provider/deployment/live operation | **UNVERIFIED / DISABLED**, not synthetic acceptance |

Final self-review reproduced one new status-read regression with a corrupted
stored Review BLOB: the new source summary threw before the UI could show its
blocked state. `ProductionSourceEvidence.view` now reuses the existing reconciled
approval view, keeps the error state readable and disables verification. The
negative test failed before this fix and is part of the final full run.

Reproduction (existing locked dependencies, ffmpeg/Pillow/Chromium):

```sh
PUBLISHER_TEST_BROWSER_PATH=/usr/bin/chromium PUBLISHER_TEST_FFMPEG_PATH=/usr/bin/ffmpeg node --test --test-concurrency=4 test/*.test.js
```

Run counts, durations, log hashes and synthetic screenshots are recorded in
`docs/evidence/v3-slice-06-evidence.json` after completion. Early failures are kept
there as execution history, not counted as passing runs. Prior 934/934, slice05
1013/1013 and independent static reviews are not this package's test execution.

## Sites handoff and remaining work

See [Sites target and runtime evidence](v3-sites-target.md). The formal UI is not
delivered by these Node tests. Real Sites identity, membership, supported build
packaging, D1/R2 bindings/migrations and cloud processing-service transport must
be implemented/verified before hosted business writes. The existing synchronous
claim/permit/quota transaction cannot simply be converted to an async D1 callback.

No real producer provider or source approval transport is connected. A next
provider implementation needs existing authenticated read access, exact immutable
task/submission identifiers and source approver identities, complete ordered
revocation history, bounded reads, and credential-free error handling. Those are
specific missing integration/code requirements, not solely a deployment issue.
There is no instruction here to create credentials or widen scopes.

The previously denied real Drive ZIP materialization is still stopped. No retry,
alternate download, original-media deletion, real publication/interaction, merge
or production service change occurred. Shared admin remains shared admin, not
per-tenant RBAC. SQL triggers do not protect against database owners. Source
revocation is detected by verification plus subsequent checks, not background
instant cancellation of already-running external activity.

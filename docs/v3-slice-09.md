# V3 slice 09 — asynchronous content decisions and platform preparation

Base: `0feb6c10e1451e036e1fc4aa9293cfced55f60c3`, following the separately
committed [authorization race repair](v3-sites-authorization-race.md). Same V3
branch and same private Site `appgprj_6ad97a034fd08191a8399eeda10f048c`.
This completes another portable application increment, **not a hosted delivery**.
No merge, production change, real platform request, new credential or Drive retry.

## Existing behavior reused

The original `ProductionApprovalStore` and native platform preparations remain in
place. Their command validation, four human review checks, exact `EXISTING_ADMIN`
actor requirement, account identity fields, platform capabilities, public-copy
parser and payload validation are now shared pure modules. Native callers use
these same exports. This is not a second interpretation of the approval rules.

The public-copy parser uses the existing locked `yaml@2.9.0` dependency (ISC
license, `node_modules/yaml/LICENSE`). No installation or third-party code copying
was performed. The official Worker build must bundle this dependency. A raw ESM
source directory containing its bare import is not a deployable Worker artifact.
The server graph has 14 local modules, no `node:` import, and `yaml` as the one
external dependency. Heavy ffmpeg/ZIP processing remains outside Workers.

New interfaces:

- `AsyncApprovalStore.view/decide`: original Review envelopes and object hashes →
  content-only approve/reject → immutable event and idempotent command receipt.
- `AsyncUploadPlans.choices/prepare/view`: explicit reviewed platform payload and
  selected media → **existing** Sites content rows/platform variants and DRAFT
  publication jobs/snapshots. No ZIP URL, filesystem path or public object URL is
  used as platform media. Object IDs and hashes refer to already extracted bytes.
- Existing `cloud-authoring-api.js`: server-only `resolveApprovalAuthority` optional
  dependency; approval and preparation routes. No default authority, user seed,
  credential, resolver based on request headers, real publish route or driver.
- Existing console: checklist, reason, approve/reject, durable history, prepare
  choice and exact media preview. Original content/preview/task destinations show
  the same prepared object references; generic draft freezing of bound content is
  refused so a caller cannot silently detach it from its approval.

All added tables are schema-only candidate migration `0005`; they have not been
applied to hosted D1. The official starter must generate/register their migration
metadata. No SQL DDL is run by request handlers.

## Authority and provenance remain separate

Site ownership plus active account membership grants the existing scoped app
access. It is **not** an `EXISTING_ADMIN` grant. A trusted server adapter must
resolve that original authority independently; absent adapter means HTTP 403 for
all decision/prepare requests. Passing `authenticated:true`, an actor ID or a
confirmation in JSON cannot supply it. Origin and JSON limits also apply.

`sites_approval_bindings` preserves a server-side original-account projection and
exact request/result/account hashes. The only implemented provisioning code is
`test/fixtures/sites-approval.js`. It inserts explicit SYNTHETIC_FIXTURE provenance,
requires SYNTHETIC task/source IDs, and declares no external source authority.
There is no HTTP binding write or production provisioning provider. Unknown/real
source provenance, enterprise source, unavailable source state, disabled/missing
identity, obsolete version or byte mismatch cannot approve. The native source
verification/decision provider from slice 06 is **not yet ported as a real Sites
provider**. This table is a binding contract, not an authentication substitute.

Shared administrator semantics do not provide individual tenant logins, RBAC or
per-person approval attribution. Database audit triggers reject ordinary updates
and deletes; they do not protect against a database owner replacing the database.

## Atomic asynchronous decisions

Asset verification runs against private exact-scope objects. Metadata count and
byte budgets are checked first; readback has a shared 30-second media deadline and
five-second object deadline. Text parsing for a platform preparation is limited
to 256 KiB. These application bounds do not certify hosted CPU/D1/subrequest
limits, forcibly terminate an injected provider, or make SQL and R2 one transaction.

After awaited reads, the decision batch rechecks **all** of:

- Current owner, exact workspace/account and unrevoked membership (repair 0004).
- Exact request/result/report envelope, scope and latest task revision.
- Exact server binding and current platform/external identity.
- Asset count, reference, object ID, hash, size, MIME, scope and READY state.
- The latest approval event, with compare-and-set semantics.

Only then can the event and command receipt commit. A second connection changing
membership, account, media state, result revision or approval after preflight
causes the complete transaction to roll back. Approval and platform preparation
both use these guards. The already persisted media is retained for reconciliation,
never deleted as compensation for a SQL failure.

Repeat commands are idempotent. Old approve commands do not resurrect a later
human rejection. Changed subjects append a system REVOKED event on next read or
decision; there is no claim of immediate background invalidation. Approval remains
content-only: `publish_allowed:false`, unverified source and unavailable independent
publication authority are preserved. A prepared DRAFT becomes `STALE_PREVIEW`
after rejection and cannot produce a second plan from the old event.

Lost acknowledgement after SQL commit returns the committed receipt/plan when it
can be read, rather than creating a second event/content/job. If optional readback
fails after known commit, the response retains `committed:true` and
`readback_pending:true`. The UI requests refresh; it never automatically retries
an uncertain mutation.

Object data can change outside D1 after a hash check; SQL cannot atomically lock
R2. Every scoped asset delivery and pre-submit rehearsal rechecks bytes. The future
real uploader must preserve this property. No claim of cross-service serializability
or object-owner tamper resistance is made.

## Closed synthetic execution and UNKNOWN

`AsyncSyntheticExecutor` is the asynchronous counterpart of the existing closed
synthetic driver. It consumes the **same** frozen plan/job, not a parallel demo
queue. There is no HTTP execution route, injected real driver, network callback,
browser or credential access. A separate explicit `SYNTHETIC_ONLY` confirmation of
the exact frozen hash and existing-admin test authority is required; CONTENT_ONLY
approval cannot start it. Synthetic provenance is an indelible prerequisite of
all prepared plans. This simulator neither issues nor consumes a real permit.

Preparation, unique attempt, submit intent, a separately committed simulated
platform object, and readback evidence persist asynchronously. Upload failure has
no submitted object. An intent without conclusive result stays UNKNOWN with
RECONCILE_PENDING; repeated delivery only reads the original attempt. Restart,
response loss, no object after intent, unavailable readback and later human
revocation never trigger a second submit. Readback binds the original task,
account, platform, job, snapshot, attempt and media. It remains explicitly
synthetic, including `PUBLISHED_ID_PENDING` for Channels and `DRAFT_WRITTEN` for
Official Account. Neither is presented as a real platform publication.

Native real daily limits, SingleExecutionPermits and scopedOperations are retained
and regression-tested; **their async live claim/consumption and real drivers are
not implemented by this simulator**. In particular, the existing real FB text-only
permit is not expanded to authorize reviewed media.

## Executed evidence and reproducibility

[Machine-readable evidence](evidence/v3-slice-09-evidence.json) records final counts,
commands and log hashes. This run uses actual file SQLite behind a D1-shaped async
adapter, file objects behind the R2 method shape, native ffmpeg/Pillow generated
media, and Linux Chromium desktop/mobile viewports. It is neither hosted D1/R2
acceptance nor a physical phone test. All data is synthetic and no user media is
committed.

The first complete command omitted the pre-existing Linux executable overrides.
It completed 1092 tests: 1069 passed and 23 failed, with missing default Mac Chrome,
Chrome distribution or Homebrew ffmpeg paths. It is retained as failed evidence,
not used as acceptance. No code or permission change was made to bypass this;
the final command specifies the installed cloud-development executables:

```sh
PUBLISHER_TEST_BROWSER_PATH=/usr/bin/chromium \
PUBLISHER_TEST_FFMPEG_PATH=/usr/bin/ffmpeg \
V3_SITES_EVIDENCE_DIR=/tmp/v3-slice-09-ui-final \
node --test --test-concurrency=4 test/*.test.js
```

Final complete regression: **1092/1092 passed**, fail/cancel/skip 0, **104.612 seconds**.
Final Sites-only suite: **71/71 passed**, fail/cancel/skip 0, **15.108 seconds**.
Syntax checks passed for 20 changed/new JS/TS files; `git diff --check` passed.

To reproduce just the Sites journey, failure cases and screenshots without keys:

```sh
PUBLISHER_TEST_BROWSER_PATH=/usr/bin/chromium \
PUBLISHER_TEST_FFMPEG_PATH=/usr/bin/ffmpeg \
V3_SITES_EVIDENCE_DIR=/tmp/v3-slice-09-ui \
node --test --test-concurrency=2 test/sites-*.test.js
```

The desktop and mobile journeys perform scoped content/task authoring, original
complete preview, decoded video playback, explicit content approval, preparation,
return to original content/task views, human rejection and stale-plan readback
after reload. They also read metric null/failure/history, change accounts/customers,
and delay old-scope responses. Browser requests outside loopback are aborted and
asserted absent. The UI never executes a simulation or real publication.

Screenshots: [mobile prepared video](evidence/v3-slice-09/mobile-approved-platform-plan.png),
[desktop prepared video](evidence/v3-slice-09/desktop-approved-platform-plan.png),
[mobile revoked plan](evidence/v3-slice-09/mobile-revoked-plan.png),
[desktop revoked plan](evidence/v3-slice-09/desktop-revoked-plan.png).

## Remaining delivery blockers

The formal target remains ChatGPT Sites plus cloud services, never Mac. The exact
existing Site is registered and not deployed. No initialization/build/source push
was attempted: official Vinext starter, `sites()` build integration, server-only
`getChatGPTUser` helper and supported build/source helpers were previously verified
absent. No new tool/mount evidence occurred in this package, so no mechanical
retry or guessed authentication/deployment metadata was attempted.

This is an environment/tool availability block, **not a rejected deployment
permission or an uncertain deployment**. Restore the official supported starter
and helpers in this environment, keep the saved project ID, then wire identity,
D1/R2 and run the official migration/build/private-deploy workflow. No additional
user decision is required to continue that already authorized scope.

Independently, real production/admin/source providers, durable heavy-media cloud
service/transport, real async permit/quota execution, cloud group/comment/message
providers, live metric collection and metric-to-production orchestration remain
concrete implementation/integration gaps. They are not all hosting issues. The
[whole-product matrix](v3-sites-acceptance.md) distinguishes each. The denied Study
sample download remains stopped; no real consumption acceptance is claimed.

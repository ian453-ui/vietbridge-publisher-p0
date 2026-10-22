# V3 slice 11 — truthful asynchronous execution recovery

Base `f670338da55537d28a93c40eafcffc869088a5a8`, same V3 branch and saved
private Site. This is a bounded repair to the **existing** prepared-job execution
and readback path, not a new app, live driver or publication permission.

## Targeted review and why this package

The preceding `653cecb` and `f670338` were reviewed for exact source identity,
newer-version/QA invalidation, transaction-scoped membership, partial Review
recovery and retained client compatibility. No new confirmed high-priority defect
was found in that review. Existing limitations remain: source changes must first
be observed, native legacy manifests without QA fields retain their old behavior,
cloud source/admin providers are not connected, and a catalogue change does not
claim retrospective cancellation of every existing native job.

Native SingleExecutionPermits already consumes permission in the original task
claim transaction. TaskActionPermits also enforces original operating-day budgets,
complete historical usage, pending/paused/duplicate guards and permanent claims.
Those mechanisms were not replaced or relaxed. The async closed executor still
has no real permit/quota provider; adding a second counter from an unverified
legacy snapshot would not establish atomic live authorization.

Inspection instead found a concrete execution-consistency gap in the current
AsyncSyntheticExecutor, which consumes the same reviewed upload plan/frozen job:
exceptions after SQL COMMIT were treated like failures before COMMIT, and cached
readback JSON was returned without checking its full binding.

## Exact failure evidence

Four deterministic regressions were run against the pre-fix code. **0/4 passed**:

| Injected event | Before | Required and now observed |
| --- | --- | --- |
| Submit-intent transaction commits, acknowledgement lost | Returned BLOCKED although job/attempt were SUBMITTING | UNKNOWN, original attempt retained, only reconciliation |
| Simulated platform object commits, acknowledgement lost | Uncaught error | Read original object and persist one verified synthetic readback |
| Readback/terminal transaction commits, acknowledgement lost | Uncaught error | Return the exact already committed terminal receipt |
| Cached receipt contains another account/attempt | Returned PUBLISHED | SYNTHETIC_READBACK_BINDING_INVALID, no success |

The original failures and post-fix evidence are recorded in
[evidence](evidence/v3-slice-11-evidence.json), including command and log hashes.
No external request, real platform object or user content was involved.

## Changes and invariants

Only the existing executor's recovery/observation helpers and its focused tests
changed. No schema, HTTP route, authentication provider, UI, account mapping,
credential or production configuration was added.

An error after asynchronous work first reads the durable original job, attempt,
object and receipt. A single joined SELECT observes their state consistently
across concurrent reconciler commits. Task, workspace/account, original attempt,
frozen snapshot, review, platform outcome and ordered media must still match.
A cached successful receipt also requires its matching simulated platform object,
VERIFIED attempt and the correct terminal job state. A receipt is not trusted
merely because its row exists. This detects accidental inconsistent writes; it
does not claim defense against a database owner rewriting every bound record.

Preparation can become BLOCKED only in a compare-and-set transaction that still
observes PREPARING, the original attempt/hash/scope and no object/readback. If a
submit intent is already durable, the same failure cannot take this branch.
UNKNOWN transitions and terminal readback commits also compare the exact observed
job/attempt states. A stale worker cannot revert a verified result or overwrite
another attempt. An existing conflicting receipt causes rollback, not replacement.

Recovery never calls `run`, upload or submit. Duplicate queue delivery reads the
original attempt. A missing object after a committed intent remains UNKNOWN; it
is not proof that no submission occurred. Database read failure returns explicit
UNKNOWN / RECONCILE_PENDING / readback_pending, with no claim of persistence or
success. A later authorized reconciliation can complete that original evidence.
No timeout, next day, lost heartbeat or permission change releases/recreates it.

The shared atomic live owner/membership guard still applies to every batch.
Authorization denials propagate; they are not converted into successful recovery.
A membership revocation during terminal commit leaves the intent and object intact
and rolls back the receipt. Authority can be restored only by the original access
mechanism, not this recovery code.

All outcomes retain `synthetic_only:true`, `publish_allowed:false` and
`real_execution_allowed:false`. Channels still yields PUBLISHED_ID_PENDING and
Official Account still yields DRAFT_WRITTEN. Neither is falsely called a public
post. The executor remains closed: no network callback, credential, real driver
or HTTP execution endpoint. It is a regression harness for the existing frozen
business flow, not the future live executor itself.

## Validation and reproducibility

The targeted executor suite passed **18/18**, covering the four original failures,
pre-commit intent rejection, lost claim/closure acknowledgements, unreadable storage
after commit, readback insertion followed by rollback, two-connection convergence,
revoked membership and the prior restart/UNKNOWN/platform-meaning tests.

```sh
node --test test/sites-async-synthetic-executor.test.js

PUBLISHER_TEST_BROWSER_PATH=/usr/bin/chromium \
PUBLISHER_TEST_FFMPEG_PATH=/usr/bin/ffmpeg \
node --test --test-concurrency=4 test/*.test.js
```

The complete regression passed **1124/1124**, fail/cancel/skip 0, **111.923 s**.
Final self-review then narrowed error classification so a known nonexistent plan
or attempt stays an explicit rejection, not UNKNOWN. After that small guard and
its assertions, **all 101/101 Sites tests passed** in **19.187 s**. The full-suite
number is from before this final guard; the affected suite is from the final code.
Both changed JS files passed syntax checks, and `git diff --check` passed.

The evidence is actual file SQLite through the D1-shaped adapter plus private
file objects, not hosted D1/R2. No extra screenshot run was needed because UI and
its routes did not change; the complete regression retains its original UI tests.

## Remaining priorities and blockers

This package repairs acknowledgement/receipt semantics; it does **not** implement
async live permission/quota ownership or authorize the user's requested enterprise
and real-estate posts. The parent reports both original website and `/api/health`
returned Cloudflare 1033 and actual submissions were zero. No endpoint was retried
or new credential requested by this package.

Next code priority is a single authoritative async permit/quota claim boundary,
bound to the exact frozen job and existing independent authorization, with original
account/day/history/dedup/UNKNOWN rules. A remote read of a Mac permit followed by
a D1 counter is not one transaction and must not be represented as atomic. Only
an existing trusted issuer/consumer integration can make that ledger live; default
must remain disabled, and content approval/import tokens must never grant it.

Formal delivery remains the same owner-private ChatGPT Sites project. Official
starter/helpers and the previously denied bundle acquisition remain unresolved;
this package did not mechanically retry them. Heavy cloud processing and trusted
source/admin transports, authorized upload/readback adapters, interactions and
real metric collection remain separate implementation/integration gaps in the
[whole-product matrix](v3-sites-acceptance.md). The native Mac version and original
branch are not modified, merged or deployed.

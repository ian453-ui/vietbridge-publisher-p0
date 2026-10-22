# V3 slice 12 — asynchronous execution permit and quota transactions

Base `dca8d9dc1e7e2698eb9c41afd12fe170ef5e3685`, same V3 branch and saved
owner-private Site. This package connects the existing reviewed upload plan and
frozen original job to a persistent permit/usage transaction. No live issuer,
credential, HTTP execution endpoint, external request or deployment is enabled.

## Confirmed gap and reused contracts

The native `TaskActionPermits` already consumed a one-use permit with the original
claim transaction and enforced scope, history, deduplication and operating-day
limits. `SingleExecutionPermits` already had its separate text-only boundary.
Neither needed replacing. The asynchronous executor, however, had no corresponding
permit/usage ledger: content approval plus a SYNTHETIC_ONLY confirmation could
complete its closed simulation without a separate task permit.

Before implementation, the new required-permit acceptance case failed **0/1**:
`Missing expected rejection`, expected `EXECUTION_PERMIT_UNAVAILABLE`. This proves
a missing asynchronous model, **not a previously enabled live authorization
bypass**. The original executor had no real driver or execution HTTP route.
The same case now rejects before creating any attempt or quota claim.

`task-action-policy.js` extracts the existing exact ordered scope serialization,
semantic action deduplication and constants from the native module. Native issue,
consume, history and permanent-claim logic are unchanged; hash parity is tested.
The original limits are Page 1, distinct groups 2, posts per group 1 and interaction
actions 3. Only **Facebook PAGE** is implemented by this async adapter. Sharing
these constants grants neither Group nor interaction authority. The operating day
continues to start at **07:00 Asia/Shanghai** using the original function.

The new `AsyncExecutionPermits` and candidate migration `0007` are used by the
existing `AsyncSyntheticExecutor`. No second task, review or upload system is
created. The executor now requires a permit by default. Existing format/recovery
rehearsals opt into a server-only `legacySyntheticRehearsal` option in their test
fixtures; a registered policy or permit always forces the permit path, even when
revoked or expired. There is no client-controlled bypass, real driver or route.

## Binding and atomic state changes

The permit preserves original workspace, account, actor/Page/target, platform,
transport/profile, snapshot/body/ordered-media hashes and exact action. Additional
binding records the original Review task/request revision, content row/version,
review, external identity, frozen job, plan and unique attempt. Authorization
references must include the exact original task. Content approval, import Bearer
and SYNTHETIC_ONLY confirmation cannot populate or replace this permit.

| Boundary | Transaction and resulting quota state |
| --- | --- |
| Claim | Recheck exact active owner/membership, current approval/version, permit/policy/history, database time and operating day; consume permit + claim original job/attempt + reserve quota + audit in one batch; `RESERVED` |
| Before submission | Verify original media, recheck approval and consumed permit/policy/day; persist original submit intent and `SUBMITTING` together |
| Closed simulated dispatch | Recheck permit/policy/expiry/day and exact claim in the same simulated-object transaction; no network or driver callback |
| Lost response or missing readback | Preserve original attempt and transition to `UNKNOWN`; reconcile only, no second insert or release |
| Exact readback | Original bound object/receipt, terminal job/attempt and `SETTLED` audit commit together |
| Proven failure before intent | SQL must still observe PREPARING with no object/readback, then BLOCKED/UPLOAD_FAILED + `RELEASED` + audit commit together |

Budget identity uses workspace + platform + original actor + Page, so an account
alias cannot reset the limit. Concurrent connections cannot both claim the last
slot. Complete same-operating-day legacy/global history is required, and pending,
paused, duplicate or incomplete history fails closed. Any unresolved reservation
or intent for that identity blocks a fresh claim even on a later day.

Releasing **unused capacity** does not refund the consumed permit or remove the
permanent semantic dedup key. It permits only a different, separately authorized
job within the original limit. The native ledger's permanent claim behavior is
unchanged. After a crash before intent, an explicit existing-admin cancellation
must identify the original attempt and snapshot; the transaction still proves no
intent. A caller's `not submitted` assertion, expiry, timeout, new day or missing
object after intent is never release evidence. There is no force-release path.

Database time is rechecked inside claim/intent/dispatch batches, not just in async
preflight. The synthetic clock exists only in the test SQLite adapter. Day change,
permit revocation/expiry or policy change between preflight and commit rolls back.
After intent it prevents simulated dispatch but keeps UNKNOWN occupancy. Readback
may settle the original claim after permission expiry/revocation; it does not
perform a new action or move usage to the new day.

Acknowledgement loss reads durable truth. Lost claim acknowledgement leaves the
original reservation; lost intent acknowledgement yields UNKNOWN; an already
committed exact settlement returns its receipt. Audit insertion faults roll back
job, attempt, permit, usage and receipt as applicable. Restart never renews a
permit or replays an intent. App-scoped authority cannot cancel or revoke grants.

## Actual validation

Final targeted run: **55/55**, 0 failed/cancelled/skipped, **2.312 s**. It includes
22 new permit/transaction tests, 18 existing async recovery tests and 15 original
native permit tests. Meaningful cases include deterministic two-connection quota
contention, account aliases, workspace mismatch, original native hash parity,
withdrawn membership at commit, binding/auth/history/limit mismatch, pre-submit
release, cross-day UNKNOWN/restart, expiry/revocation at multiple boundaries,
lost claim/intent/object/settlement acknowledgement and mid-transaction audit faults.

```sh
node --test test/sites-execution-permits.test.js \
  test/sites-async-synthetic-executor.test.js test/task-action-permit.test.js

PUBLISHER_TEST_BROWSER_PATH=/usr/bin/chromium \
PUBLISHER_TEST_FFMPEG_PATH=/usr/bin/ffmpeg \
node --test --test-concurrency=4 test/*.test.js
```

Full regression on the final implementation passed **1146/1146**, with 0
failed/cancelled/skipped, in **123.711 s**. All 9 changed/new JS files passed syntax
checks, and `git diff --check` passed. Exact commands, failure output, log hashes
and final source hashes are in the accompanying
[evidence](evidence/v3-slice-12-evidence.json). These tests use actual file SQLite
through the D1-shaped async adapter, private file objects, generated media and
synthetic policy/history/authorization. They are not hosted D1/R2, live issuer,
real platform or real account acceptance. No UI was changed; existing full-suite
browser regressions are retained, with no new screenshot claim.

## Self-review, remaining boundary and next priority

Self-review tightened original authorization task binding and the full claim
binding at intent/dispatch. The native limits and serialization remain shared;
no guessed account quotas or raised values were added. Audit triggers prevent
ordinary updates/deletes, not database-owner tampering. Shared administrator
semantics do not imply independent tenant users or individual approver RBAC.

Current policy custody can only be `SYNTHETIC_EXCLUSIVE`, and **only tests** insert
these policies/permits. There is no production issuer/provisioning interface.
Copying a live Mac permit into D1 would create competing spend authorities and is
not supported. Real integration needs one existing trusted issuer/consumer with
exclusive authoritative custody, complete current history and original identity
verification. A snapshot from another independently writable ledger is not an
atomic reservation. Historical imports must exclude exactly the local claims they
already contain; the fixture history is deliberately separate.

The next publication integration priority is that trusted custody/history provider
and an operation-specific upload/submit/readback adapter using the same original
claim boundary. The simulated dispatch transaction cannot prove atomicity with an
external platform: a live worker must retain durable intent and UNKNOWN on any
uncertain remote outcome, and cannot describe an expired/revoked in-flight network
request as cancelled. No actual provider is configured here. Group/private-message
and feedback gaps remain in the [complete matrix](v3-sites-acceptance.md).

Deployment remains blocked by the previously missing official Sites starter/helper
and denied official bundle download. This package did not retry that download,
Study ZIP, website or API; create credentials; change network/sharing; or deploy.
Same Site `appgprj_6ad97a034fd08191a8399eeda10f048c` is retained. Original branch and
Mac service are not changed. Formal Sites/cloud identity, D1/R2 and heavy-processing
acceptance remain unverified, not hidden behind these synthetic results.

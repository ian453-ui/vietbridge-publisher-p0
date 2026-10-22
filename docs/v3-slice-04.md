# V3 slice 04 — explicit content decisions, separate from publish authority

Work on the same independent V3 branch after b1f04ed. Prior committed acceptance
is attributed correctly: slice 01 943/943, slice 02 968/968, slice 03 984/984;
these are historical evidence, not this package's new results. Working tree was
clean, original publisher-unified still 4455a4b. No AGENTS.md applies.

## Source-backed implementation boundary

Reuse `PublisherAccess.authenticate/authorizeApp`, the existing admin identity,
Origin + X-Local-Token + JSON request check, and requestGuard. Do not change token
scopes, create credentials, relax maintenance permissions, or grant a producer
the administrator role. Existing `library.approveGpt`/enterprise-source rules
remain authoritative for original-library approval.

The production contract has no authenticated live-producer transport. Therefore
live-source approval remains disabled. A clearly labeled synthetic provenance
fixture exercises the entire decision path using the existing authentication
mechanism in isolated tests. No request-supplied origin/authentication flag may
enable approval. Approving fixture content is not authenticating a real producer.

Store the exact result envelope alongside immutable Review snapshots. A decision
binds request/result versions, all artifact hashes, source references, account
identity/target and platform declarations. Human actions are explicit APPROVE or
REJECT with a current fingerprint and optimistic event version. Store decisions,
idempotent command receipts and append-only audit events atomically. Reject stale,
cross-project, UNKNOWN/unverified or corrupt subjects. New validated revisions
revoke prior approval; changed account/platform identity invalidates the old
decision. Repeated commands cannot create a second decision or publish effect.

Expose decisions in the existing 制作审核 UI with visible fixture provenance,
review checklist, explicit action buttons and durable readback. Do not add job
creation, READY, import, scheduling or publication. All approval receipts retain
publish_allowed:false and source_gate_satisfied:false.

Acceptance: authenticated UI and origin/CSRF checks; no app-token permission gain;
real/unverified source disabled; approve/reject/repeat/restart; two-process race;
body/image/source/account/platform/revision invalidation; UNKNOWN and stale
decision rejection; transaction faults preserve old audit/receipt state; delayed
scope responses cannot act for a different customer/account. Existing previews,
platform entry points and inherited full regressions remain required.

The prior real Study ZIP transfer was denied by the network proxy (403). No
retry or alternative download route is permitted or attempted in this package;
real material consumption remains unverified.

## Metric time-order correction completed first

Commit `4f69e11` fixes two independently reproduced counterexamples supplied by
review: as-of :18 selected A's future :20 completion and lost B's :15 failure;
an older late failure also overrode a newer successful collection. The before
test run failed both cases. After correction, 25/25 metric tests passed, including
restart, old late success, duplicate-result linkage and legacy ordering uncertainty.
Persistent per-series start generations and attempt-to-observation links now
control selection. See the [slice-03 correction](v3-slice-03.md#temporal-selection-correction-start-of-slice-04).

## What is implemented

| Operation | Implementation | Authorization / live evidence |
| --- | --- | --- |
| Bind result to original request and exact frozen bytes | Additive result-envelope storage, canonical request/result fingerprints and saved report hash | Local intake only; no real producer identity inferred |
| View immutable production result | Existing authenticated Review text/media surface retained | Existing app authentication and customer/account data scope |
| Approve/reject a synthetic content version | Explicit admin POST, checklist, content-only acknowledgement, reason, optimistic version | Isolated synthetic producer only; real producer approval blocked |
| Persist receipt and audit | Transactional command receipts and append-only decision/revocation events | Audit attributes the existing shared admin identity, not individual-user RBAC |
| Revoke old approval | New accepted revision revokes atomically; account/target/bytes/proof drift invalidates at next inspection | No publishing consumer or authority is added |
| Publish/import/schedule from a decision | Not implemented | Always publish_allowed:false, import_allowed:false, source_gate_satisfied:false |

`production_review_envelopes` retains the exact result JSON plus the saved report
hash. Existing historical review rows without this envelope remain viewable but
cannot be approved; no unverified envelope is backfilled. New original intake
retains the envelope in the same transaction as its review receipt and BLOBs.

`production_review_provenance` supports only SYNTHETIC_FIXTURE. It has no HTTP
registration route. The fixture helper/demo can seed only SYNTHETIC task/source
IDs and bind the exact request/result/account fingerprint. This is a test marker,
not a signature, authenticated production sender or a general auth bypass.
producer_authenticated remains false. Unknown origin or identity blocks a human
decision even when the reader is the administrator. Enterprise libraries retain
their existing GPT approval prohibition.

`production_approval_events` retains CONTENT_APPROVED, CONTENT_REJECTED and REVOKED
events. `production_approval_commands` binds an idempotency key to the complete
command, scope and authenticated admin actor. Commands cannot silently change
meaning; stale event/subject versions reject. Exact retry or semantically equal
repeat approval returns DUPLICATE without another decision event. Replaying a
previous approve command after a later rejection returns its historical receipt
with the current rejected state; it never reapproves the content.

New valid content/source/platform revisions revoke prior approval within the
intake transaction. A failed intake cannot partially revoke the old immutable
version. Account/target drift, corruption, UNKNOWN state or revoked provenance
is reconciled on the next Review read/decision: a system REVOKED event can be
appended during inspection, and approval stays blocked. Even a denied decision
commits any discovered invalidation. This is not a background account watcher;
no other subsystem consumes these approvals as permission to act.

The audit tables reject UPDATE/DELETE through ordinary SQL operations. This is
an application integrity measure, not tamper-proof evidence against the database
owner. The UI shows the latest 100 events and explicitly indicates truncation;
the full event history remains in SQLite. Full audit export/pagination is later
work. Existing shared administrator authentication is reused; no separate tenant
login/RBAC or live creator identity is claimed.

## Existing UI and transport

Open 制作审核 and expand the original result to read its text, images and video.
For a synthetic fixture under an already authenticated administrator, the same
view shows the content checklist and two explicit buttons: 批准此合成版本 /
拒绝此合成版本. Nothing is pre-checked. Approval requires all review checks;
rejection requires a reason. Both require a content-only acknowledgement.

POST `/api/production-reviews/<review-id>/decision?workspace=...&accountId=...`
passes through the existing authenticated admin, exact Origin/local-token/JSON
checks and requestGuard. Application-token scopes are unchanged. Ordinary local
preview possession of the local token does not grant admin approval. No new
authentication setting or permission is required or created by this code.

The request fields are exactly `command_id`, `decision` (APPROVE/REJECT),
`expected_subject`, `expected_event_id`, `reason`, `checks` (the four existing
production-review requirements), and `confirmation:CONTENT_ONLY`. Actor and
provenance come from server-side state, never from request-supplied flags.
Successful UI actions are followed by a GET readback of the saved decision.
On an uncertain/failed response, action buttons stay disabled until explicit
state refresh; there is no automatic retry. Detached old-scope responses cannot
populate another customer's view.

Reproduce a new synthetic packet without keys or credentials:

```sh
node scripts/v3-approval-demo.mjs /tmp/my-new-v3-approval-demo
node scripts/v3-review-local.mjs /tmp/my-new-v3-approval-demo
```

The ordinary loopback preview intentionally has no authenticated admin and shows
the result without approval authority. Use the authenticated browser test below
to reproduce the complete synthetic workflow. It uses the repository's existing
ephemeral test-admin configuration/session mechanism, not a new real account,
token or saved production login configuration. Reusing an already authorized
admin deployment is separate from this local development package; nothing is
deployed or merged automatically.

## Executed acceptance

Executed on 2026-10-22 UTC in the isolated cloud worktree. Node 24.19.0,
Python 3.12.14, ffmpeg/ffprobe 7.1.5 and system Chromium.

```sh
# Before the metric correction: the two new counterexamples both FAILED.
node --test --test-name-pattern='as-of normalizes|late failure from' test/metric-observation-store.test.js
# After correction: 25/25 metric regressions passed, 8.832 seconds.
node --test test/metric-observation.test.js test/metric-observation-store.test.js
# Approval storage/HTTP/UI: 9/9 passed, 11.239 seconds.
PUBLISHER_TEST_BROWSER_PATH=/usr/bin/chromium V3_APPROVAL_SCREENSHOT=/tmp/v3-approval-synthetic.png node --test test/production-approval.test.js test/production-approval-http-ui.test.js
# Complete run including the late revocation-write fault: 997/997, 73.692 seconds.
PUBLISHER_TEST_BROWSER_PATH=/usr/bin/chromium PUBLISHER_TEST_FFMPEG_PATH=/usr/bin/ffmpeg V3_APPROVAL_SCREENSHOT=/tmp/v3-approval-synthetic.png node --test --test-concurrency=4 test/*.test.js
# Final UI/transport check after the isolated checkbox CSS correction: 3/3, 6.450 seconds.
PUBLISHER_TEST_BROWSER_PATH=/usr/bin/chromium V3_APPROVAL_SCREENSHOT=/tmp/v3-approval-synthetic.png node --test test/production-approval-http-ui.test.js
# Separately executed no-key synthetic packet creation.
node scripts/v3-approval-demo.mjs /tmp/publisher-v3-approval-demo
```

Final complete run had zero failed/cancelled/skipped tests. 328 tracked/new
JS/MJS/TS files passed `node --check`, Python extraction parsed, and
`git diff --check` passed. The generated demo remained REVIEW_REQUIRED/PENDING,
producer_authenticated:false and requires_existing_admin:true.

[Final synthetic approval screenshot](evidence/v3-approval-synthetic.png) and
[structured execution evidence](evidence/v3-slice-04-evidence.json) are committed.
Local full-run log `/tmp/v3-slice04-full.log` SHA256:
`70e61c50b70179858dd1d478cd41dfb241af6af710fd6b1c0f556317b18545a5`.
Other environment-local log hashes are in the evidence JSON. Historical reports
from slices 01–03 are not counted as new execution here.

All new identities, production results and admin actions are synthetic fixtures;
inherited platform execution tests retain their mock drivers. No real content
approval, publication, interaction, import or deletion was performed.

| Case | Executed evidence |
| --- | --- |
| Human decisions and restart | Approve → same/new-command duplicate → reject → replay old approve stays rejected; reopen SQLite retains both events |
| Authorization | Admin required, wrong Origin/token/content type denied, existing requestGuard rejection honored, app token denied, local-preview token insufficient |
| Source/identity | Unverified producer, fabricated auth field, wrong project/account, unknown/corrupt state and enterprise source blocked |
| Change invalidation | Body, image hash, platform declaration and source-reference revision revoke old approval; account/Page target changes revoke on inspection |
| Atomicity | Approval-command insertion fault rolls back the decision; BLOB fault and later revocation-event fault roll back the new review/envelope/media and preserve prior approval |
| Concurrency | Two independent Node/SQLite processes approve once; one RECORDED, one DUPLICATE, one decision event and two command receipts |
| Browser readback | Existing login → original Review → explicit approve/double-click guard → durable GET readback → reject → reload; delayed response ignored after customer switch |
| No publication | All new tests assert no publisher jobs; browser permits only login, decision and existing scope UI actions; external requests/page errors absent |

Initial tests found and corrected an incorrect assumption of a separate workspace
table (the repository uses its `records` registry), plus a fixture that mutated
the prior request through a shallow copy and correctly tripped its fingerprint
guard. The first cloud UI delay test also tried an account-preference write which
the existing disconnected-cloud policy denies. That policy was preserved; the
delay journey now switches customer using existing reads. Cross-account denial
and account-change invalidation have separate tests. No permission was relaxed.

## Remaining boundaries

Real production-sender authentication, real-content approval, original-library
approval integration, full audit export and real platform metric collection are
still unavailable/unverified. The previously denied real ZIP transfer stays
stopped. Cache threat-model/crash-reconciliation limits from slice 02 remain.
No real credentials, access grants or security/sharing settings were created or
changed, and no user asset bytes or signed URLs are committed to GitHub.

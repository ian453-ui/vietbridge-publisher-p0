# Shared media → independent target Review

2026-10-22; incremental change from `c984226` on `publisher-v3/cloud-slice-01`.
Formal delivery remains the saved private ChatGPT Site
`appgprj_6ad97a034fd08191a8399eeda10f048c`, **not deployed**. This is runnable
cloud-workspace application code with synthetic trusted providers, not live account
or hosted D1/R2 acceptance.

## Concrete change and reused contracts

Previously, a second account could preview another account's reviewed media but
had no path to create its own Review. The new same-workspace path is:

1. Choose an explicit target account for the existing platform variant and open
   the source's approved platform plan.
2. Request an independent target Review. The server resolves both scopes and
   existing admin authority; a server-injected target binding provider is required.
   Its only implementation today is `test/fixtures/sites-target-review.js`.
3. Reuse the original inspected bytes with verified hashes, under **new target
   object keys**, a new task/request/result fingerprint and an immutable source
   lineage. No original approval event or execution permit is copied.
4. The existing Review UI shows the exact target. It starts PENDING, with no
   events. A human must check the existing checklist and explicitly approve/reject.
5. Existing `AsyncUploadPlans` creates the original account-specific DRAFT and
   frozen platform/media snapshot. No real upload or publication route is enabled.

`POST /api/sites/workspaces/:workspace/plans/:id/retarget?accountId=:target`
accepts exactly `command_id`, `expected_subject`, `expected_event_id`, and
`expected_platform`. Client identity/provenance assertions are rejected. The
source account is resolved from the stored plan, not trusted client input. Both
source and target existing-admin resolutions are required. Content approval is
never publication authorization.

`AsyncReviewStore.intake` now accepts internal commit statements so its Review,
assets, lineage, new target binding and command receipt commit in **one atomic
batch**. Root subject/event, source and target membership, target platform and
identity are rechecked inside that batch. Objects written before an SQL failure
remain recoverable through the existing immutable object protocol; they cannot
become an approvable half-created Review. No originals are deleted.

Candidate migration `0008_target_review_candidate.sql` adds only immutable
lineage and command tables. It is not applied to a hosted service and does not
grant access. Original native request schema is unchanged: deterministic target
task ID binds lineage/identity, and the native `verifyProductionRequest` accepts
the resulting request. The report labels technical inspection as local hash-bound
reuse; it does not claim a new ffmpeg run or producer authentication.

## Source validity, revocation and recovery

`AsyncApprovalStore` checks a derived review's root subject and exact source
approval event without calling source `view()` or modifying its approval history.
Source revision, QA, identity, approval or membership change blocks the target;
an existing target approval receives its own REVOKED event on read/decision.
The same root guards run inside target decision, preparation, intent and actual
simulated dispatch batches, covering changes after asynchronous preflight.

The dependency is conservative: even reapproving the root with a new event does
not revive the old target approval. A fresh explicit request and target review
are required. Revocation is detected at read/decision/dispatch, not pushed by a
background watcher. Read-only historical target assets remain scoped to their
own target; revoked source access never permits a new derivation.

Only **one hop** is supported. Use the original source plan for a third account;
deriving from a derived review is rejected. This package supports a different
account on the plan's existing explicit platform. It does not translate a body,
fall back to another platform or implement multi-platform editing.

A durable command receipt is read after current source/target membership and
command-hash checks, before current provider/approval checks. Thus a lost reply
followed by source withdrawal still returns `committed: true` and the original
review ID, with `current_state: READBACK_REQUIRED`. It does not imply that content
is currently approved. UNKNOWN submission follows the unchanged executor's
original-attempt reconciliation; source withdrawal after actual commit does not
block reading the existing outcome or authorize another submit.

## Executed acceptance and evidence

[Execution record](evidence/v3-target-review-evidence.json) includes commands,
results, screenshot hashes and explicit execution boundaries. Evidence is from
this package's implementing agent; Astra reviewed source and failure logs but
did not independently rerun the suite.

| Case | Actual before / after or expected invariant |
| --- | --- |
| New target Review | Baseline returned 404 OPERATION_UNAVAILABLE; now independent PENDING review, no inherited events, original audit unchanged |
| New approval → freeze → target revoke | Own decision/plan/task/media; frozen exact target identity; target withdrawal makes its plan stale, original stays approved |
| Native compatibility | Fresh request passes original native request validator; old account-only routes and Tabs retained |
| Scope/provenance | Cross-workspace and wrong membership rejected; default provider/admin absent denies; client self-assertion and mismatched provider evidence rejected |
| Root update / latest QA / rejection | Target approval revokes or new request fails; no original audit mutation by target checking |
| Atomic races | Second connection changes source/target membership, identity, QA or approval before final intake; whole Review/binding/receipt rolls back. Decision and preparation races roll back too |
| Partial failures | Second object-put acknowledgement fails: no approvable Review; explicit retry recovers. SQL insert fault rolls back final rows; commit-ack loss returns saved receipt |
| Receipt recovery repair | Astra's case reproduced as APPROVAL_TARGET_PROVIDER_UNAVAILABLE after committed request and withdrawal; repaired original-command readback succeeds, revoked membership still denies |
| Duplicate/restart | Two connections and different commands converge on one deterministic target Review; restart retains PENDING/decisions; conflicting command rejected |
| UNKNOWN/quota | With existing synthetic permit fixture: withdrawal before dispatch leaves UNKNOWN, quota occupied, zero objects; after commit restart settles original object. No RELEASED event, no second attempt/submit |
| UI | Desktop 1440×1000/mobile 390×844: shared video → independent Review → decoded playback → human approval → frozen target → reload. Held old response cannot reopen preview or change account/draft |

Reproduce the bounded path (temporary loopback server and synthetic identities):

```sh
PUBLISHER_TEST_BROWSER_PATH=/usr/bin/chromium PUBLISHER_TEST_FFMPEG_PATH=/usr/bin/ffmpeg \
  node --test test/sites-target-review.test.js test/sites-cloud-console-ui.test.js
PUBLISHER_TEST_BROWSER_PATH=/usr/bin/chromium PUBLISHER_TEST_FFMPEG_PATH=/usr/bin/ffmpeg \
  node --test --test-concurrency=4 test/*.test.js
```

The focused suite passed **44/44**: 21 server cases and 23 UI cases. Full regression passed **1224/1224** in 138.95 seconds, with zero failures,
cancellations or skips. No executable code changed after this final run. Browser
screenshots are local synthetic artifacts, not a deployed Site or physical phone.

## Remaining code and environment work

Next bounded code priority is **editing multiple explicit platform variants**.
Actual V1 had platform selection; current Sites preview can switch explicit saved
variants, but `cloud-console.js` still saves only `[account.platform]` from the
manual form. The content API already supports a `variants` map and immutable
revision/hash. Reuse it for a per-platform editor and source/target-specific
re-review; do not silently rewrite an approved plan or duplicate a public post.
Bulk selection/file replacement and pagination beyond 200 rows also remain.
No implementation for these is included here.

Existing registered real source/producer/admin/target-binding providers, trusted
exclusive execution/history provider, cloud heavy inspection and authorized
upload/submit/readback still need integration. General group/inbox operations and
metric-driven reviewed iteration remain separate code gaps. Passing tests does
not close those product capabilities.

The official Sites helper/starter mount problem was not retried this package;
no new deployment attempt, network/permission change, credential/password read,
real media fetch, rejected download retry, real external post/message, production
merge or original-branch change occurred. There is no new user decision required
for this code package. The formal Sites delivery block remains outstanding.

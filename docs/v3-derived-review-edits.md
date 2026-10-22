# Repeated editing of a derived Review

2026-10-22, bounded continuation of `7bc777706377c26a696e8743fe140c547744403d`
on `publisher-v3/cloud-slice-01`. Saved Site remains
`appgprj_6ad97a034fd08191a8399eeda10f048c`; no deployment or external publication.

## Reproduced gap and resulting workflow

At the baseline, an original reviewed plan could be edited, freshly inspected,
independently approved and frozen. Editing that **new frozen plan** then failed
reinspection with `VARIANT_REVIEW_SOURCE_CHANGED`: `editedSource` explicitly
rejected edited/target-derived ancestors. The regression reproduced this at the
second full cycle, not merely another text revision of the original family.

The same editor and Review route now support repeated full cycles for an ordinary
or independently target-reviewed source on its existing platform. Each cycle
creates a new inspected snapshot, starts at PENDING with no decisions, requires
explicit human approval and freezes a distinct DRAFT with exact text and media.
Tests run three full ordinary cycles and two target-derived cycles. No table,
HTTP route, credential mechanism or execution permission is added.

Each newly frozen content family retains its own deterministic task identity.
Its first edited inspection points to the direct parent's item fingerprint;
later revisions of that family retain the prior committed request checks. The
immutable lineage records every parent. Displayed revision 2 can therefore be
the first edit of a newly frozen family, not global revision 2 of the entire
ancestry. Old requests, media, approval events, tasks and submission facts remain.

## Authority and version semantics

The existing two dependency types keep distinct requirements:

* An edit edge accepts only its original content approval followed by the exact
  edit-generated revocation, with the original manifest, media, account and
  source fingerprint. Arbitrary rejection or a later event does not qualify.
* A target-account edge still requires its source's exact **currently valid**
  approval, original account membership and identity. Editing a target-derived
  source does not authorize a second target hop. The restriction propagates
  through intervening edits, so editing cannot disguise account transfers.

All ancestor checks remain in the final creation/approval/freeze/dispatch atomic
batch. Root rejection, latest QA withdrawal, ancestor or target membership loss,
identity changes and newer content invalidate dependent operations. Historical
receipt lookups retain their existing current-scope and command-hash checks and
return committed facts before evaluating new-operation freshness. A prior approval
is not silently reused or removed from history.

UNKNOWN still holds its exact attempt and quota. Withdrawal before dispatch
prevents a simulated object and retains UNKNOWN; withdrawal after a committed
simulated submit permits only reconciliation of that object after restart.
There is no second submit or ambiguous quota refund.

## Bounded traversal and provenance

One validation traversal shares a path and budget across edited ancestors,
target edges and the source account's store. It rejects cycles, more than
**8 Review nodes including the current one**, over **128 MiB cumulative declared
asset bytes**, or an exhausted **30-second traversal deadline**. Existing per-node
artifact and object limits remain. Validation reads count again per ancestor;
this is deliberately conservative, not deduplicated byte accounting.

New edited and target snapshots reserve their own node and bytes before provider
or object writes. An independent review found that target creation initially
omitted this reservation; the new test reproduced a ninth snapshot being accepted.
The repair now permits 7→8 nodes and rejects 8→9 before creating the snapshot.

The deadline applies to a single ancestor-validation traversal. Edited inspection
uses that traversal's remaining time. Existing intake/object persistence retains
its separate budget; this is **not** a hard 30-second deadline for the entire HTTP
request or all repeated validations in approval/preparation. Hosted resource and
transaction limits still require actual Sites runtime acceptance.

Repeated edits replace only the direct edited parent's exact verified **last two
generated source markers**. Original references, including same-named original
markers, remain intact; the full ancestry is preserved by immutable lineage.
The native request/item fingerprints and fresh image/video decoder still validate
the new payload. Human semantic media/text review remains mandatory.

## Executed evidence

[Execution record](evidence/v3-derived-review-edits-evidence.json) records actual
commands, results, failure logs, source hashes and screenshots. This package ran
**166/166 targeted** and **1304/1304 full regression**, with zero failures,
cancellations or skips. These are current executions. Implementer ran
the tests. Astra performed design and final read-only reviews, found the target
budget omission, and confirmed its static repair; Astra did not rerun tests.

| Case | Verified result |
| --- | --- |
| Ordinary derived copy | Three full edit → fresh decode → independent approval → freeze cycles, exact body/media and item predecessors |
| Target-derived copy | Two full cycles in the new account; original account approval unchanged; no second target transfer |
| Original references | Same-named source markers and unrelated source refs preserved; generated marker pair replaced exactly |
| Scope and stale input | Wrong customer/account/body hash/media binding rejected; no approval transfer |
| Atomic source changes | Root rejection/QA/identity, ancestor/target membership and concurrent edit between preflight and batch roll back all Review/command writes |
| Decisions and dispatch | Ancestor withdrawal inside approval/freeze/actual dispatch blocks the side effect; UNKNOWN retains occupancy |
| Durability | Two connections converge; SQL failure leaves no Review; lost commit acknowledgement and restart return only original receipt; closed provider cannot create another snapshot |
| Reconciliation | Previously committed simulated object is read back after restart and ancestor withdrawal; one attempt/object, no RELEASED event |
| Limits | Real chain boundary; prospective target reservation; shared node/byte/deadline context; injected corrupt cycle fails without unbounded reads |
| Mobile | 390×844 Chromium: three complete cycles, new PENDING screens, synthetic video playback, exact final frozen text, refresh and old stale-preview history |

Reproduce in the same cloud workspace, with synthetic identity/providers/media
and loopback HTTP only:

```sh
PUBLISHER_TEST_FFMPEG_PATH=/usr/bin/ffmpeg \
  node --test test/sites-review-lineage.test.js
PUBLISHER_TEST_BROWSER_PATH=/usr/bin/chromium PUBLISHER_TEST_FFMPEG_PATH=/usr/bin/ffmpeg \
  node --test --test-name-pattern='mobile derived frozen copy' test/sites-cloud-console-ui.test.js
PUBLISHER_TEST_BROWSER_PATH=/usr/bin/chromium PUBLISHER_TEST_FFMPEG_PATH=/usr/bin/ffmpeg \
  node --test --test-concurrency=4 test/*.test.js
```

Screenshots remain under
`/workspace/sites/publisher-v3/review-lineage-evidence-20261022/`, with hashes in
the record. Viewport emulation is not physical-device, Safari or hosted acceptance.

## Remaining work

Cross-platform inspected-media adaptation, original bulk selection/file replacement,
cloud group/Inbox/reply/takeover workflows and live metric feedback remain code
or provider gaps in the [current acceptance matrix](v3-sites-acceptance.md).
Arbitrary account-transfer chains and unlimited lineage are intentionally disabled.
The real inspector, trusted source/admin/permit/upload/readback providers and
official Sites identity/D1/R2 deployment remain unconnected/unverified. This package
did not recheck or retry previously denied helper/media downloads.

No real token/password was read, no credential configured, no security or sharing
permission changed, no real post/message sent, and no production branch merged.
The original cloud workspace recovered with a clean 7bc7777 tree and no active
test process; the previous completed 1283-test log was read rather than rerun as
recovery. All results in this package's record are separate current executions.

# Edited reviewed copy → fresh inspection → independent Review

2026-10-22; bounded follow-up from `068b30cdb24563cfbf0281be3331deea71dfa0f8`
on `publisher-v3/cloud-slice-01`. Same saved private Site:
`appgprj_6ad97a034fd08191a8399eeda10f048c`. No deployment or external publication.

## Concrete gap and completed path

The previous editor preserved original reviewed media and revoked approval when
text changed, but its saved version could not return to inspection/Review. The
baseline POST returned **404 OPERATION_UNAVAILABLE**. This package adds that
missing connection to the existing content editor, production contract, scoped
object store, approval ledger, preparation and frozen-task paths.

On the original source account and platform, save a reviewed text edit, explicitly
choose “重新校验并创建独立审核”, review the new complete text and decoded media,
then explicitly approve or reject. Approval starts at **PENDING** with no copied
decisions. Only a new content approval can freeze its exact platform title/body
and original media as a distinct DRAFT. The original Review, media, frozen job
and committed receipts are retained. No publication permission is produced.

`POST /api/sites/workspaces/:workspace/contents/:id/review?accountId=:account`
accepts exactly `command_id`, `expected_payload_hash`, `expected_source_binding`.
It requires the existing server-resolved admin, exact active source account,
origin and trusted owner/membership context. Clients cannot self-report proof,
replace bytes or supply a target account's approval. Existing target-account
Review is a separate workflow and its approval is never copied here.

## Version, media and transaction binding

`AsyncVariantReview` retrieves the immutable original bytes from the scoped
object store. It substitutes only the explicitly saved platform payload as a
UTF-8 JSON envelope, retaining all platform fields, title and full body. It sends
that request and those bytes to an injected **server-side** inspector. The new
request binds the saved content revision/hash, exact account, platform and media
lineage. The inspector must produce a fresh request/result/report with matching
bytes and reference hashes and real image/video decode evidence. The fixture
executes the existing native `packageProductionInspection`; it does not copy an
old decode report. The portable application never imports native ffmpeg code.

The same root family uses one deterministic task identity. Later inspected
versions refer to the latest preceding committed item fingerprint. That previous
request and absence of an intervening version are checked in the final batch,
alongside source, latest content, account identity/membership, media state and
the exact original edit-revocation event. Review, lineage, source binding and
idempotent command receipt commit atomically. Object-write/SQL failures cannot
leave an approvable partial Review. The candidate migration
`0010_variant_review_candidate.sql` is tested locally, not applied to hosted D1.

Only the exact edit-generated revocation is accepted as provenance for this
handoff. Explicit rejection, later source QA withdrawal, changed identity or
permissions fail closed. The same lineage guards also apply to later approval,
preparation, submit intent and actual synthetic dispatch. A newer content version
invalidates the old edited Review on its next read/decision. This is not a
background instant push, independent tenant RBAC or database-owner tamper defense.

Same-command readback occurs after current scope/command checks and returns the
original committed receipt even after source withdrawal. It never creates a new
approval or job. UI retries keep the exact command and content ID after a lost
reply; no automatic retry occurs. Late creation replies cannot reopen another
account's Review or replace its unsaved content.

UNKNOWN retains its original attempt and reserved quota. A source update before
dispatch prevents the simulated remote object and leaves UNKNOWN occupied; an
update after a successful simulated submit still allows readback of that same
object after restart. Neither path refunds ambiguous work or resubmits it.

## Acceptance evidence

[Execution record](evidence/v3-edited-review-evidence.json) contains actual test
commands, current results, source/log hashes and screenshot paths. This package
actually ran **145/145 targeted** and **1283/1283 full regression** with zero
failures, cancellations or skips. These are current runs, not inherited totals. All test runs
are by the implementer. Astra performed read-only review and did not rerun them.

| Case | Reproduced or executed result |
| --- | --- |
| Missing handoff | Baseline 404; now original edit → fresh decoded PENDING → explicit approval → exact frozen DRAFT |
| Consecutive inspected edits | Initial implementation failed native `createProductionRequest(...,{priorRequest})` with ITEM_REVISION_CONFLICT; corrected previous-item selection and transactional guard pass the original case |
| Mobile long task ID | Initial new workflow exceeded the 390px document/dialog width; scoped heading wrapping passes the same width assertions |
| No approval transfer | New Review has zero decisions; independent approval and new DRAFT; original events/job/media unchanged |
| Scope/identity | Other customer/account, self-reported authentication, wrong hash and final-batch withdrawal/identity change rejected |
| Source changes | New revision, source rejection, latest QA withdrawal and corrupt original media reject; approved child becomes REVOKED while historical facts survive |
| Media/text mismatch | Wrong body/image bytes, reference hash, account, UNKNOWN report, hash-only image receipt and invalid MP4 rejected |
| Concurrency/durability | Two connections converge; old command survives restart/provider removal; SQL rollback/object acknowledgement loss leave no partial Review; committed-ack loss returns original receipt |
| Late update | New version between approval/preparation read and atomic commit causes rollback; before-dispatch guard prevents a new object |
| UNKNOWN | Only original attempt reconciles after restart; no second object or quota release |
| Browser | Desktop 1440×1000 and mobile 390×844 complete editing, fresh inspection, actual synthetic video playback, explicit approval, freeze and refresh readback; stale response and lost acknowledgement paths executed |

Reproduce in the original cloud workspace with generated media and loopback only:

```sh
PUBLISHER_TEST_BROWSER_PATH=/usr/bin/chromium PUBLISHER_TEST_FFMPEG_PATH=/usr/bin/ffmpeg \
  node --test --test-concurrency=2 test/sites-variant-review.test.js \
  test/sites-variant-edits.test.js test/sites-target-review.test.js \
  test/sites-async-approval.test.js test/sites-async-review-store.test.js \
  test/sites-async-upload-plans.test.js test/sites-async-synthetic-executor.test.js \
  test/sites-cloud-console-ui.test.js
PUBLISHER_TEST_BROWSER_PATH=/usr/bin/chromium PUBLISHER_TEST_FFMPEG_PATH=/usr/bin/ffmpeg \
  node --test --test-concurrency=4 test/*.test.js
```

Screenshots remain under
`/workspace/sites/publisher-v3/variant-review-evidence-20261022/` with hashes in
the record. They use generated fixtures and viewport emulation, not real user
media, a physical phone, Safari or hosted Sites.

## Deliberate limits and remaining inheritance gaps

This is a one-hop handoff from an ordinary original Review on its existing plan
platform. Repeated edits of that same original family are supported. Editing a
target-derived Review or a newly derived frozen plan into another derivation is
not supported; it fails closed. Cross-platform inspected-media adaptation and
original user-facing bulk/file replacement remain code gaps. The request deadline
uses the saved revision time and original request duration; an expired revision
cannot be silently renewed. A new revision/request is needed.

Decode proves usable bytes and reference binding, not semantic image/body
agreement, facts, aesthetics or subtitle synchronization. The human checklist
and new content approval remain mandatory.

No production `variantInspectionProvider` is configured. Its native decoder is
injected only by tests; the ordinary application keeps this action unavailable.
Official Sites runtime identity/D1/R2, supported build/deployment helpers, cloud
heavy processing and existing trusted real source/admin/permit/upload/readback
providers still need integration and hosted acceptance. Their earlier environment
blocks were not retried in this package. Groups/Inbox/replies, takeover and live
metric feedback still have business code/provider gaps in the current matrix.

No credentials were read/configured, no denied download retried, no network or
sharing permissions changed, no real posts/messages sent. The original branch
and Site are retained. This package ends here; no next feature was started.

# Bounded batch selection and per-item draft freezing

> Recovery note (2026-10-22): the implementation and this historical handoff were
> recovered from the [rescue Page](https://chatgpt.com/space/page_756d60e140d48191b54d6e2c0bcd3963).
> Six original evidence files and the original screenshots remain unavailable.
> References below to those archives describe the prior run, not recovered files.
> Current reruns and exact gaps are recorded in [the recovery record](v3-batch-recovery-20261022.md).

2026-10-22. Baseline `f6c61d3ab45c392ad31677f0d44c64c795bcaa6c`, same
`publisher-v3/cloud-slice-01` branch and Site
`appgprj_6ad97a034fd08191a8399eeda10f048c`. Development only; not deployed.

## Source-backed inheritance and reproduced failures

Actual V1 checkout `vietbridge-publisher-p0` at
`fe9b7ad05351001fb2cef6adb7f689ebc5c5cce1`, `src/web-ui.ts:12–37`, has a
`picked` set, select-all/clear, a creation mutex, per-item eligibility reasons and
sequential task creation. V2 checkout `vietbridge-social-operator-v2` at
`85e987a00876a94385c5b4e99be67a7347523457`, `src/unified-client.js:72,169–179`
and `src/unified-publisher.js:124–181`, establishes shared workspace sources and
exact immutable account/platform tasks; it does not establish a V2 bulk UI.
V1 platform-copy fallback is deliberately not inherited: missing copy stays missing.
Neither old checkout was edited.

Before this package the Sites console offered only individual freezing. Three
executable regressions failed at baseline: two preflight requests returned 404
`OPERATION_UNAVAILABLE`; a historical task-command retry after target identity
change returned `DRAFT` and a recomputed hash although the original task was
`UNKNOWN`. The latter is a response-integrity defect, not evidence that the
original database task was reset. The same-command changed-payload rejection is
now `COMMAND_CONFLICT` because history is checked before constructing new state.

During self-review a second deterministic two-connection case reproduced a new
receipt double-read race: the first command read was empty, a competing matching
command ID committed a different input, and the second read returned its receipt
without rechecking the input hash (200). The helper now validates kind and hash
on the single record it actually reads. The conflicting caller receives 409;
the valid original command retains its one task. Both failure and repair logs
are archived. No second task or external effect occurred in the failing fixture.

## Delivered workflow and boundaries

Select up to 20 content **rows/versions** from the currently loaded shared client
catalogue (maximum 200 rows). Choose one explicit platform and one target account.
Select-all means the first 20 loaded versions, not all library pages. Per-item
preflight reports availability or the exact reason for refusal. It is advisory,
not an approval or a reserved execution allowance.

`POST /api/sites/workspaces/:workspace/task-preflight` accepts only
`account_id`, `expected_platform`, and 1–20 unique
`{content_id: row_id, expected_payload_hash}` items. It requires the existing
trusted identity, exact owner/membership, same-origin request and body bound.
Every successful result returns its exact task input with latest revision and
server-derived target mapping hash. A foreign workspace row is unavailable.

The existing `/tasks` endpoint remains the only freezing write. No batch write,
upload, publishing, interaction or permission endpoint is introduced. Each item
has its own fixed command and transaction. Optional `preflight` fields enforce
optimistic revision/target-identity matching, and the atomic write rechecks owner,
active source and target memberships, exact content fields, platform/identity,
latest revision, review restrictions and absence of another task for this item.
Older single-item contracts remain accepted; batch inputs never silently upgrade
the selected revision.

| Selected item | Preflight / freeze behavior |
| --- | --- |
| Current manual copy for selected platform | Freeze DRAFT only; remains MANUAL_UNVERIFIED, no media, no publication authority |
| Missing platform copy / superseded version / changed hash | Unavailable with reason, never copy another platform or newer row |
| Already prepared reviewed media, original target | Display existing task receipt; do not make another task or duplicate its media |
| Reviewed media, different target | Independent target Review required; no approval transfer |
| Edited reviewed media | Fresh inspection and independent approval required |
| Existing UNKNOWN / SUBMITTING / RECONCILE_PENDING / PUBLISHED_ID_PENDING | Original task only, reconciliation required; no new attempt or quota release |
| Concurrent revoke/change/new task after preflight | Final transaction rejects and rolls back; re-preflight reads committed facts |
| Same command after committed response loss | Exact original task state/hash; no reconstructed DRAFT response |
| One failed or unconfirmed item | Preserve individual result; other selected eligible items processed separately |

Freezing DRAFT does not consume or reserve execution quota. Existing independent
permit/approval and atomic quota logic is unchanged. This package does not invoke
it or grant new allowances. Existing approval/media/source rules are not copied
into a parallel bulk approval system.

Changing customer, current account, target account or platform, refreshing, or
clearing replaces the current selection/preflight state. Old callbacks cannot
populate the new context or dispatch remaining items. Already dispatched requests
may commit in their original scope and must be read there; clearing is not a
rollback. Duplicate clicks are gated. Failed/unknown responses are never retried
automatically. Explicit re-preflight finds prior tasks; unresolved items reuse the
same in-page command/payload. A reload loses selection but durable tasks remain.

## Acceptance and evidence

See [machine-readable evidence](evidence/v3-batch-selection-evidence.json) for
exact commands, exit status, counts, log hashes and screenshot hashes. Only runs
from this package are listed there. The original three failures are retained in
`evidence/v3-batch-before.log`; the repaired cases are part of the passing API suite.

Coverage includes mixed eligibility, same-client shared sources, cross-client
refusal, missing platform copy, duplicate commands, restart UNKNOWN receipts,
two-connection concurrent creation, mid-transaction new revision/revoke/identity/
copy change, partial rollback, reviewed and edited media gates, late preflight,
late committed response, lost acknowledgment, desktop/mobile selection/clear and
original task preview. The full regression also runs the unchanged native permit,
quota, media, ZIP, source, approval and reconciliation tests.

Screenshots: `/workspace/sites/publisher-v3/batch-selection-evidence-20261022/`.
Desktop Chromium 1440×1000 and mobile viewport 390×844 use synthetic fixtures and
loopback-only HTTP with outside requests blocked. Actual SQLite implements the
async D1 shape. These are not physical-phone, hosted D1/R2, real Sites identity or
external-platform acceptance. Astra's independent review was static, not a rerun.

## Reproduce and inspect

```sh
PUBLISHER_TEST_BROWSER_PATH=/usr/bin/chromium \
PUBLISHER_TEST_FFMPEG_PATH=/usr/bin/ffmpeg \
V3_SITES_EVIDENCE_DIR=/tmp/publisher-batch-evidence \
node --test --test-concurrency=4 \
  test/sites-cloud-authoring.test.js test/sites-cloud-console-ui.test.js

PUBLISHER_TEST_BROWSER_PATH=/usr/bin/chromium \
PUBLISHER_TEST_FFMPEG_PATH=/usr/bin/ffmpeg \
node --test --test-concurrency=4 test/*.test.js
```

The existing cloud-console fixture starts its controlled server; it is not an
alternate product deployment. No user content, credentials or external sends are
part of the test. The saved Site and prepared migration source remain unbuilt.

## Remaining real gaps

File replacement/import UI and cross-platform media editing remain distinct code
gaps; pagination beyond the current window is also absent. This package does not
implement them. Formal delivery still requires official Sites starter/helpers,
identity and D1/R2 wiring in the original cloud environment. No helper download
or environment/security change was attempted here. Real producer/admin/exclusive
permit providers, cloud heavy media worker, authorized uploader/submit/readback,
group/Inbox/interaction business paths and live metrics integration remain open.
No Mac fallback, new credentials or real external publication is claimed.

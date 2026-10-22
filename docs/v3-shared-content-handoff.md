# Shared client sources → independent platform preview → explicit target

2026-10-22. Baseline `c5acafc3e97933b678128c6c6003c70c3e0015e0`, existing
`publisher-v3/cloud-slice-01` branch. Same private Site project
`appgprj_6ad97a034fd08191a8399eeda10f048c`; not deployed.

## Inherited behavior and bounded scope

Actual V1 `fe9b7ad` has independent platform selection and full platform preview in
`src/web-ui.ts:12,13,37`. Actual V2 `85e987a` selects content by workspace and then
the target account's platform in `src/unified-publisher.js:162–174`. Unified baseline
`4455a4b` separates source/platform/account UI in `src/unified-client.js:123–143`.
Those files were read, not modified or run. The previous
[inheritance review](v3-inheritance-review-20261022.md) recorded the Sites gap.

This package restores browsing **existing explicit variants** and creating a
manual, unverified DRAFT for an explicitly chosen same-client target. It does not
add a new content system or turn existing content approval into publish permission.
Hand-authored UI input still saves a variant for the header account's platform;
editing all variants of one source in the UI is a remaining feature.

## Existing modules and minimal interfaces

* `cloud-authoring-api.js`: `GET /api/sites/workspaces/:workspace/catalogue` returns
  existing `sites_contents` rows across active source accounts in that workspace.
  Optional `accountId` also validates the selected viewer account. Owner and source
  membership are joined in the same SELECT; no client-supplied source authority.
  Content IDs, slug, revision, original account, hashes and bodies are preserved.
  Records with the same numeric suffix are not combined.
* Original `GET /contents?accountId=…` retains exact account filtering. Original
  four-field `POST /tasks` retains its account-bound contract. No schema changes,
  migration, account grant or new credential is required.
* `POST /tasks` additionally accepts the exact five fields `command_id`,
  `account_id`, `content_id`, `expected_payload_hash`, `expected_platform`.
  `account_id` is the explicit target; the server resolves the source account.
  The requested platform must equal the target's stored platform and must have
  its own explicit variant. No text fallback. The frozen snapshot records target
  account/platform/identity, source row/version/hash, and `source_account_id` when
  the source and target differ. It remains DRAFT, UNCONFIGURED, with no approval,
  media-upload grant or publication authority.
* The existing atomic command batch now rechecks both active memberships, source
  identity/body/variants/hash, target platform/identity and absence of a Review
  preparation binding. It rolls back command/task/snapshot together on failure.
  Existing unique snapshot and command constraints remain. Duplicate requests
  recover the existing task; an UNKNOWN task and its original attempt stay UNKNOWN.
* `cloud-console.js/html`: independent platform selector, explicit target selector,
  shared source cards and missing-variant explanation in the existing Content Tab.
  Platform changes clear the target. Selecting a target synchronizes the header
  account so subsequent tasks/history are clearly scoped. No target is chosen
  merely because a platform has one account. A source may be previewed with no
  selected account or no account configured for that platform.

## Review/media boundary

The catalogue obtains `review_binding` by joining `sites_upload_plans`, not by
trusting a state label. Existing Review-prepared content also has
`source_status=MANUAL_UNVERIFIED`; that alone is not proof it is a plain source.

A prepared source can be viewed by an authorized owner in the same workspace,
including its original decoded video. Plan and media requests use the **original
source account**. The screen labels that origin, has no approval/prepare controls,
and never transfers approval to the selected target. Generic freeze rejects such
rows with `BOUND_REVIEW_TASK_REQUIRED`; the final batch also asserts that no plan
binding appeared after preflight. To use those media for a new target still needs
a separate target-bound request/inspection/review flow; this package does not
manufacture one by stripping the old approval.

All c5acafc draft and preview protections remain: separate per-account editing
state, exact unknown-save command, generation/preview-epoch rejection of stale
responses, close/Escape invalidation and guarded post-freeze navigation.

## Failure before / acceptance after

The unchanged c5acafc API produced two actual failures: catalogue GET returned
404; explicit cross-account platform freeze returned 400 INVALID_COMMAND.
[Corrected baseline output](evidence/v3-shared-content-before.log) records the run.

| Acceptance journey | Actual evidence / expected result |
| --- | --- |
| Same client, two accounts read one source | Same content row, full original body and variants; legacy account-only endpoint still filters |
| Cross-client source or target | Wrong target scope rejected; another workspace's catalogue contains no source |
| Independent platform; no matching account | Full explicit Channels text still previews; freeze disabled until an exact matching target is selected |
| Missing platform variant | Preview/freeze disabled, no fallback to Facebook copy |
| Explicit target freeze | XHS body goes to XHS target, source account retained; FB target gets a separate FB task; restart preserves snapshots |
| Approval separation | Prepared media can be read from source account; other account cannot approve, read the plan as its own or freeze that prepared source |
| Transaction races | Second connection revokes source/target or changes target identity/platform/source bytes after preflight; task/command/snapshot all roll back |
| Late Review binding | Fault injection attaches a plan after preflight; final NOT EXISTS assertion prevents an unapproved shared task |
| Duplicate / UNKNOWN | Two connections converge on one command/task; repeats cannot reset UNKNOWN or original attempt |
| Old UI responses | Delayed old-account task and old-client catalogue replies cannot replace current data; previous draft/preview regressions remain covered |
| Desktop/mobile | 1440×1000 and 390×844 Chromium, full workflow and source-bound decoded playback; no horizontal document overflow |

The original delayed-account test now holds the account-specific **tasks** reply:
same-client catalogue contents are intentionally shared. Its cross-client delayed
catalogue assertion remains strict. Tests seed explicit platform variants through
the existing API; this is not evidence of multi-variant UI editing.

Final source/authorization/handoff regression: **22/22 passed**. UI regression:
**20/20 passed**, including desktop/mobile source-bound video playback. Final
full run after the last authorization-ordering change: **1200/1200 passed**,
127.10 seconds, zero failures/cancellations/skips. No executable code changed
after that final run.

Commands and final results are in
[execution evidence](evidence/v3-shared-content-evidence.json). Tests run in the
selected cloud workspace with synthetic identities, actual SQLite behind the D1
shape, generated media and loopback HTTP. They are not hosted D1/R2, physical-phone,
real Drive, real Facebook/XHS/Channels/WOA or real publication acceptance.

```sh
node --test test/sites-cloud-authoring.test.js test/sites-handoff-api.test.js test/sites-authorization-race.test.js
PUBLISHER_TEST_BROWSER_PATH=/usr/bin/chromium PUBLISHER_TEST_FFMPEG_PATH=/usr/bin/ffmpeg \
  node --test test/sites-cloud-console-ui.test.js
PUBLISHER_TEST_BROWSER_PATH=/usr/bin/chromium PUBLISHER_TEST_FFMPEG_PATH=/usr/bin/ffmpeg \
  node --test --test-concurrency=4 test/*.test.js
```

The UI test starts the actual console/API on a temporary loopback server. Its
`shared client source previews…` case is a reproducible development demonstration:
read shared source, preview Channels without an account, reject missing WOA text,
choose XHS target, freeze/reload, choose a different FB target, and switch client.
It is not the formal Sites delivery.

## Review and next gap

Astra performed design and implementation read-only review; execution results
belong to the implementing agent. It identified the prepared-source status trap
and required the atomic plan-binding exclusion, now implemented and fault-tested.
It found no confirmed P1 in the bounded diff and highlighted the remaining
multi-variant editing limitation. A further error-ordering check reproduced
CONTENT_CHANGED instead of SCOPE_DENIED for a revoked source with a wrong hash.
Source authorization now precedes plan/hash/variant inspection; a focused test
confirms denial before detailed source status. The full suite was rerun after
this final code change, rather than reusing the earlier passing full result.

Next code priority is a target-specific handoff for a shared media source, producing
a **new** review subject without copying approval/permit; multi-platform variant
editing and original bulk/file input are also outstanding. Do not silently make
generic manual DRAFTs publishable. Real source/admin/permit providers, cloud heavy
inspection and upload/submit/readback integration still need existing authorized
transport and hosted wiring.

No deployment/helper download, password/token read, credential migration, network
or sharing change, real post/message, production merge or original branch change
was performed. The reported personal Facebook password change is not proof that
any API grant is available or valid. The previously denied downloads remain
untouched. Sites registration/prepared source remains distinct from deployment.

# V1 / V2 / unified baseline → V3: three-round review

2026-10-22. Review starts at V3 `713977f0162a883665c4fb712e8eea0bdc583d89`,
branch `publisher-v3/cloud-slice-01`. One `gpt-6-astra` agent performed three
different read-only reviews. The implementing agent ran the commands below.
Astra did not independently rerun those commands. The full-suite count is a
regression result, **not** completion of the operational product.

## Round 1 — actual source inheritance

All three baselines were read; old checkouts/services were not modified or run.

* **V1:** `ian453-ui/vietbridge-publisher-p0`,
  `fe9b7ad05351001fb2cef6adb7f689ebc5c5cce1`.
  [Platform selection and full preview](https://github.com/ian453-ui/vietbridge-publisher-p0/blob/fe9b7ad05351001fb2cef6adb7f689ebc5c5cce1/src/web-ui.ts#L12).
* **Actual V2:** `ian453-ui/vietbridge-social-operator-v2`,
  `85e987a00876a94385c5b4e99be67a7347523457`.
  [Workspace content → account platform](https://github.com/ian453-ui/vietbridge-social-operator-v2/blob/85e987a00876a94385c5b4e99be67a7347523457/src/unified-publisher.js#L162).
* **Unified baseline:** original `publisher-unified`,
  `4455a4b1faf40fedcd7020636999e165fa4a1386`.
  [Scoped drafts and independent platform UI](https://github.com/ian453-ui/vietbridge-publisher-p0/blob/4455a4b1faf40fedcd7020636999e165fa4a1386/src/unified-client.js#L3).

V2's original UI follows `account.platform`; independent platform selection and
`PublisherFormDrafts` in today's native UI must not all be attributed to V2.
The former is also in actual V1; both are in the unified baseline.

“Runnable” below means code exercised in this cloud workspace with synthetic
identity/storage/media and loopback services. No row is a hosted Sites or real
social account acceptance claim. Native modules remaining in the repository do
not automatically become callable from Sites.

| User operation | Source inheritance evidence | Current Sites outcome | Gap type / next step |
| --- | --- | --- | --- |
| Switch customers/accounts | V2 scoped accounts; unified client | Runnable exact owner/membership filtering and per-scope content/tasks. This package fixes unsaved-draft bleed and old save responses clearing the new account's draft | Hosted identity/D1 still unverified; shared admin is not independent tenant RBAC |
| Multiple tasks and immutable versions | V1 task queue; V2 unified executor | Runnable frozen independent DRAFT snapshots and idempotent creation | Actual execution is a separate missing integration |
| Original Tabs | Unified `client.js` navigation | Nine Sites destinations; native navigation retained | Groups/Inbox/engagement/verification descriptions are not working business screens |
| Shared client content → choose account | Actual V2 `unified-publisher.js:162–174`, content selected by workspace | **Regressed in Sites:** `cloud-authoring-api.js` filters `sites_contents` by account. A second account cannot browse the shared client catalogue | Code needed: workspace source catalogue, then explicit account-specific draft/approval/task; do not broaden approval ownership |
| Independent platform selection | Actual V1 `web-ui.ts:12,13,37`; unified `unified-client.js` | **Regressed in Sites:** editor follows selected account and saves only that platform variant | Code needed: browse explicit platform variants without implicit target selection; exact target still required to freeze/execute |
| Read full body and images/video | V1 `web-ui.ts:37`; unified preview | Runnable full text; Review decoded media; approved plan media and original task preview. This package fixes stale/closed preview replacement | Registered real source transport and hosted media service still missing; text-only manual entry is not a media upload UI |
| Upload new DOCX/image or select bulk source items | V1 `web-ui.ts:13,20,22,28` | Native route retained. Sites manual authoring + canonical contract import exist | Sites user-facing file replacement/bulk selection workflow is missing code, not merely missing token |
| Production handoff | Unified production request/result contracts | Synthetic exact request/source/result binding → stored inspection → Review works | Real producer orchestration and trusted delivery missing; no content production repeated in this package |
| ZIP / split parts / media QA | V3 resolver and original production inspection | Synthetic multipart/hash/path/bomb/budget/lease handling and decoded media accepted by Review | Cloud heavy service/transport not hosted. User ZIP denied 403 previously; real consumption remains unverified |
| Manual approve/reject/revoke | Existing Review gates and shared admin | Runnable immutable events, old-version denial, content/media/account changes invalidate approval; this package prevents late approval readback reopening a dismissed dialog | Existing real authority/source provider and official Site identity integration missing; invalidation occurs at read/decision, not a background instant push |
| Approved bytes → upload plan | Existing uploader/task boundaries | Runnable exact reviewed bytes + explicit variant → original DRAFT, no external upload | Real uploader and execution endpoint/provider missing; content approval ≠ publish permit |
| Per-platform publish/upload/readback | V1/V2 retained API/browser/Channels/WOA adapters | Closed synthetic executor only. Facebook known-video readback has a bounded offline HTTP adapter at the existing driver seam | Trusted permit/history custody, actual upload/submit adapters and hosted worker wiring missing. No usable live token here |
| UNKNOWN → reconcile only | Unified executor state contract | Native and async persistence tests retain original attempt, no second submit; UNKNOWN keeps quota | Real operation-specific reconciliation integration unverified; unavailable readback does not authorize replay |
| Channels ID pending / WOA draft | V2 `multiplatform-drivers.js`, retained unchanged | `PUBLISHED_ID_PENDING` and `DRAFT_WRITTEN` semantics retained and simulated | Actual platform acceptance missing; no invented public ID or public publish |
| Group reading and rules | V2 `facebook-browser.js`, `scoped-operations.js` | Native conditional discovery/scan and human rule confirmation retained | Sites list/rule/read business routes missing; no permission inferred from Page provider |
| Group active posts / interactions | V2 scoped/browser execution | Native per-scope opt-in, review and stop/limits retained | Sites workflow/provider missing. Official account capability must be verified per operation |
| Comments / registered-post replies | V2 `facebook-engagement.js`, retained unchanged | Native comment/read/reply code retained | Sites Inbox read/review/reply not implemented; comment code is not general chat |
| Direct/group messages and takeover | Not established as complete V1/V2 capability | Missing general conversation/message transport, durable assignment/internal notes/outbound interlock | New business implementation and authorized provider needed; no automatic messages |
| Daily budgets and durable ledger | Native task-action permit/claims; V3 async transaction | Runnable exact PAGE scope/attempt reservation, atomic cap, release only before proven submit, UNKNOWN retention, restart/day boundary | Only synthetic exclusive custody wired; existing real grant history/issuer must be integrated atomically |
| Metrics → iteration | V3 raw MetricObservation ledger | Runnable source/window/null/as-of/generation history and UI | Live collectors and scheduled feedback → reviewed next-version brief are missing |
| Formal delivery | User requires cloud ChatGPT Sites | Existing private Site remains registered, not deployed; prepared source is unbuilt | Official helpers/starter not mounted in the checked locations; official identity/D1/R2 and heavy service not accepted |

## Round 2 — reproduce and repair actual operations

At the unchanged production JS from `713977f`, the corrected focused run failed
all five assertions (desktop/mobile are separate):

| Operation | Before | After |
| --- | --- | --- |
| Fill A1, select A2, reopen content editor | A2 shows `A1 完整正文` | Blank A2 draft; returning restores each exact customer's/account's draft |
| Same test at 390×844 | Same bleed | Same isolation |
| A1 save committed, hold its response, edit A2, release A1 | A2 body becomes empty | A2 body and button state remain its own; both saves land under their original accounts |
| Hold Review GET, open metric history, release Review | Title becomes `制作素材快照` | Newer metric history stays open |
| Request refresh with an open preview | Old dialog remains open | Dialog/media/text cleared before new scope data is loaded |

The refresh case intentionally invokes the refresh handler behind a modal; it is
defensive cleanup coverage, not a claim of reproducing a real member revocation.

The first draft of the late-save test used an invalid uppercase slug, receiving
400 rather than a committed response. Astra caught it. That run is **not** used as
commit-loss evidence. The corrected test uses a lowercase slug, asserts HTTP 200
and original-account row existence before releasing the response, then demonstrates
the actual reset bug. The corrected failure log is retained in evidence.

Changes are confined to the existing console, its UI tests and documentation:

* Keep unsaved field values, command ID, submitted payload and pending state in an
  in-memory map keyed by the full `[workspace, account]` tuple. Submission locks
  that draft's fields. An old response cannot reset another draft. Unsaved drafts
  are not durable; the UI explicitly warns that page reload/navigation loses them.
* Unknown authoring acknowledgement keeps the exact command/payload for explicit
  idempotent save reconciliation. Changed payload is blocked. Definite input 400
  may be corrected. This is **not** a publication retry or a change to UNKNOWN policy.
* Give all previews a separate request epoch. New previews, Tabs, close/Escape,
  refresh and scope changes invalidate prior display work. Approval and preparation
  callbacks check it too. Pause discarded video elements. Freeze/prepare callbacks
  also recheck navigation after their secondary scope reload.
* Bound test barriers and close test server connections during cleanup. One
  intermediate UI run stalled during fixture teardown and was stopped; it is not
  counted as a pass. Final runs must complete normally.

No API scope, schema, grant, execution provider or real driver setting changed.

## Round 3 — review and verification

Astra reviewed the implementation diff, confirmed no service-side permission
expansion, and found one remaining navigation race in the freeze callback. Its
post-reload guard now checks both data generation and preview epoch, matching the
preparation callback. Baseline attribution was also corrected as described above.

Final UI run: **18/18 passed**, 28.49 seconds. Final full regression: **1190/1190 passed**, 127.37 seconds, zero failures/cancellations/skips. No executable file changed after these runs.

Actual final commands/results are recorded in
[machine-readable evidence](evidence/v3-inheritance-review-evidence.json).
The UI suite covers desktop/mobile isolated drafts, committed late responses,
lost acknowledgement with exact idempotent payload, invalid-input recovery,
button/Escape closure during approval readback, existing decoded video playback,
prepared media, revocation/reload and canonical QA withdrawal. The full suite
additionally exercises the retained native paths, cross-scope/old-version guards,
transaction/restart, permit/quota, UNKNOWN and dispatch-withdrawal cases.

Reproduction commands:

```sh
PUBLISHER_TEST_BROWSER_PATH=/usr/bin/chromium PUBLISHER_TEST_FFMPEG_PATH=/usr/bin/ffmpeg \
  node --test --test-name-pattern='unsaved content drafts|late committed content|late same-account|refresh closes' test/sites-cloud-console-ui.test.js
PUBLISHER_TEST_BROWSER_PATH=/usr/bin/chromium PUBLISHER_TEST_FFMPEG_PATH=/usr/bin/ffmpeg \
  node --test test/sites-cloud-console-ui.test.js
PUBLISHER_TEST_BROWSER_PATH=/usr/bin/chromium PUBLISHER_TEST_FFMPEG_PATH=/usr/bin/ffmpeg \
  node --test --test-concurrency=4 test/*.test.js
```

Screenshots use Chromium desktop 1440×1000 and mobile viewport 390×844, synthetic
content only. They are not physical-device, Safari or hosted Sites acceptance.

## Remaining priorities and exact environment boundary

1. **Code inheritance:** restore client-shared source browsing, explicit platform
   variants and account selection, then bulk selection/file replacement. Preserve
   account-specific approval and frozen version identity. This can be developed
   independently and is not blocked solely by credentials or deployment.
2. **Formal cloud delivery:** keep Site `appgprj_6ad97a034fd08191a8399eeda10f048c`.
   Shell recovered after the reported disconnect. Bounded read-only helper search
   under `/opt/codex`, `/workspace/.agents`, `/workspace/.codex`, `/workspace/sites`
   found no official `project-setup.mjs`, `site-workflow.mjs` or worker-esm/Vinext
   starter. Missing local mounts do not prove the old CONNECT403 caused them.
   Restore supported official components in this cloud environment, then wire
   official identity/storage and privately deploy. No denied download was retried.
3. **Real operational chain:** existing trusted source/admin/permit-history provider,
   heavy inspection service and authorized upload/submit/readback. A Group token
   on an offline Mac is not an available cloud credential. No real platform request
   was made in this review, and no Site deployment was attempted.
4. **Missing interaction/feedback product:** cloud group rules/reading, active posts,
   comments/Inbox, human takeover and metrics-to-next-version workflow remain code
   and provider work. A Tab or an offline test count cannot close those items.

The baseline branch, original checkouts and saved Site identity stay unchanged.
No merge, production deployment, real post/message, credential creation, security
setting change or real media mutation is part of this package.

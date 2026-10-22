# Publisher V3 bounded development acceptance — 2026-10-22

This records the first four slices. The subsequent [slice 05 business connection](v3-slice-05.md)
implements approved synthetic Review/ZIP bytes → native content/platform/job/upload
preparation and closed local simulated submission/readback. Its 1013-test regression
and remaining real-source authorization boundary supersede the earlier
“archive-to-uploader handoff not integrated” status below.

This closes the four development slices and the final integration pass on
`publisher-v3/cloud-slice-01`, based on `publisher-unified` commit
`4455a4b1faf40fedcd7020636999e165fa4a1386`. It is a runnable development increment,
not a declaration that the entire operations product is implemented or live-certified.
No merge, deployment, real publication, reply, credential provisioning, permission
change or original-media deletion was performed.

## What was actually exercised

The final integration fixture uses **one SQLite database**, two customers, two
accounts in the first customer and one in the second. Real local files pass through
the original customer library import/freezing mechanism. Two complete content IDs
share the suffix `074` but retain different bodies and independent pending jobs.
Another explicit synthetic input supplies Xiaohongshu copy. These are synthetic
library inputs, not automatically promoted production-review outputs.

The same database holds a separately scoped multipart ZIP production result,
decoded media, a human-flow synthetic approval receipt and metric observations.
The metric mapping explicitly represents a different synthetic published object;
the three original publication jobs remain `DRAFT`. This tests coexistence and
scope throughout the application without pretending approval caused publication
or that fixture metrics were collected from those unpublished jobs.

Chromium desktop **1440 × 1000** and mobile viewport **390 × 844** each exercised:

1. Existing administrator login using a disposable test fixture; full source text
   and decoded image preview; different full IDs despite repeated numeric suffix.
2. Facebook/Xiaohongshu account selection, separate task queues, missing platform
   copy refusal, and missing Channels account refusal.
3. Existing Tabs rendered with no browser errors: publishing, verification,
   groups, Inbox, topic replies, proactive interactions, accounts/settings,
   customers and access. Rendering alone is not business-function acceptance.
4. Multipart ZIP → exact member/hash → actual image/video decode → existing Review
   BLOB snapshot → browser video playback to completion → explicit checklist and
   content-only approval → durable receipt readback after reload.
5. Separate `views`/`reach` histories: latest permission failure displays unavailable
   views instead of the old 100; reach remains 40 with its own definition/window.
6. Same-customer account switch and another-customer switch clear review/metrics,
   contents and task views. No external browser requests or platform adapter calls.

The new tests are [v3-acceptance-journey.test.js](../test/v3-acceptance-journey.test.js).
Existing delayed-response and cross-scope suites also run in the full regression.
This is viewport emulation on Linux Chromium, not a physical phone or Safari test.

## Final acceptance matrix

“Synthetic passed” means code ran in this execution environment with generated
assets, local HTTP, injected responses or mock platform adapters. It neither
authenticates a real account nor certifies the current platform interface.

| Business path / inheritance | Existing implementation and executed tests | Acceptance and remaining boundary |
| --- | --- | --- |
| Customer/account isolation, multiple tasks | `store.js`, `unified-publisher.js`, `publisher-access.js`; final desktop/mobile journey, `publisher-integration.test.js`, `production-review-ui.test.js`, `metric-observation-http-ui.test.js` | Synthetic passed, including late old-context responses and separate queues. This is customer/account data isolation with a shared administrator, **not per-tenant individual login/RBAC**. |
| Original Tabs and navigation | `client.js`, `unified-client.js`; final journey plus existing UI journeys | All listed Tabs exercised; no removed V1 surface. A Tab is not evidence that every legacy operation was manually retested. |
| Source reading, original loose media, full preview, platform choice | `library.js`, `platform-copy-provenance.js`, `unified-client.js`; final journey, `review-v1-platform-copy-ui.test.js`, content reliability/catalogue suites | Synthetic library import, frozen-image decoding and complete text passed. Platform return preserves edits; missing platform copy blocks. Real Drive content was not accessed in this final pass. |
| Content production | `content-workbench`, `production-artifact-contract.js`; production contract/media/review tests | Request and supplied-result packaging implemented. Actual model/producer dispatch, authenticated result delivery and production orchestration remain missing. No synthetic output is represented as commissioned real content. |
| Media QA | `video-validation.js`, `image-validation.js`, production contract; video/production tests | Actual ffprobe and full ffmpeg decode, bad/truncated/audio-only MP4 negatives, timeout/output/abnormal-exit and pre-tool batch budget passed. Decode is not factual, aesthetic, subtitle-alignment or real-user visual QA. Legacy transport tests containing fake MP4 bytes do not count as media QA. |
| ZIP / split parts / hot cache | `archive-asset-resolver.js`, `archive-extract.py`, `archive-production-intake.js`; archive suites and final journey | Synthetic manifest/parts/hash/traversal/bomb/CRC/size/cache/lease/restart/rollback passed. Extracted bytes, never a ZIP URL, enter Review. Production uploader handoff for archive-resolved assets is **not yet integrated**. |
| Original retention and migration | `archive-asset-resolver.js` reference migration, `archive-retention-plan.js`; archive retention/resolver suites | Original loose path and rollback retained. Each library's latest 20 originals protected; image/text retained; all-target genuine readback required for older-video technical candidates. Pure fixture policy does not authenticate evidence or authorize deletion; permanent deletion remains unimplemented and paused. |
| Review → human decision → audit | `production-review-store.js`, `production-approval-store.js`, existing server/UI; approval suites and final journey | Synthetic fixture approved/rejected through existing admin path, receipt persisted; idempotency, old-command replay, two-process race and transaction rollback passed. Real producer authentication unavailable → real-source decisions disabled. Approval grants neither source-library approval nor import/publish authority. |
| Content/account/platform changes | Production/approval stores, frozen publication snapshots; approval store and unified tests | Changed body/image/source/result revision or account/target invalidates exact approval. Revision intake revokes in its transaction; other drift is detected on next read/decision, **not a background immediate invalidation service**. UNKNOWN and cross-project decisions rejected. |
| Facebook Page publishing/upload/readback | `unified-executor.js`, `unified-drivers.js`, `facebook-browser.js`; `unified-executor.test.js`, `scoped-ui-journey.test.js` and browser-skill publication tests | Existing adapter paths and exact confirmation preserved; synthetic submit-once/readback/identity/quota tests passed. Zero real Page publications in this work. Live account authorization and interface behavior remain unverified here. |
| Xiaohongshu publishing | `multiplatform-drivers.js`; `unified-multiplatform.test.js` | Synthetic separate image/video calls and full note/body identity readback passed. Real authorized connector/account operation unverified here. |
| WeChat Official Account | `WechatDraftPublishDriver` in `multiplatform-drivers.js`; multi-platform and V1 platform UI tests | Synthetic draft creation/readback passed; result is `DRAFT_WRITTEN`, **not public publication**. Public-publish closure is not supplied by this adapter. |
| WeChat Channels | `WechatChannelsPublishDriver`; multi-platform tests | Synthetic list readback retains `PUBLISHED_ID_PENDING`, including no fabricated public ID and no second submit on reconciliation. Real media upload/list identity unverified here. |
| Unknown outcomes, idempotency, quotas | `unified-executor.js`, `scoped-operations.js`, `interaction-budget.js`, `operating-day.js`; executor/scoped/quota suites | Synthetic submitted-then-disconnected cases retain unknown/pending locks; reconciliation only, no resend. Frozen identities cannot be reassigned between projects. This does not establish live throughput. |
| Group proactive posting | `facebook-browser.js`, group jobs and scoped operations; `integration.test.js`, `scoped-ui-journey.test.js`, browser-skill group suites | Existing selected-content→selected-group→independent task→rules/identity/confirmation→mock readback path passed. It is a conditional Facebook browser path, not a general official Groups API or all-platform group manager. No real group posts. |
| Group discovery / proactive comment interaction | `proactive-engagement.js`, browser scan, scoped execution; proactive-scan/proactive-engagement/browser-skill UI tests | Synthetic opt-in groups, classification, fact-source gating, likes/replies, caps, negative reply stop and UNKNOWN reconciliation passed. No real scan, like or reply in this work. |
| Inbox/comment replies | `facebook-engagement.js`, `engagement-review.js`, `client.js`; engagement review HTTP/UI, quota and scoped journey tests | Registered-post/comment reading, source-bound draft review and mock single reply paths exist. Body edits revoke review; ambiguity keeps quota reserved. General group-chat message transport is not implemented by this comment model. |
| Private/direct messages | No direct-message transport or normal authenticated route found in `src/` or `legacy-p0/src/`; Inbox is posts/comments | **Not implemented / not live tested.** Terms such as DM in spam classification or prototype labels do not supply messaging. |
| Human handoff / internal notes | Policy pause and negative-stop primitives exist; prototype `HUMAN_HANDOFF` labels are separate | Full conversation assignment, durable human takeover interlock and internal-note/outbound separation remain **unimplemented**. Do not infer Chatwoot capabilities from research references. |
| Metrics storage/readback | `metric-observation-store.js`, `metric-collector.js`, existing Review; metrics suites/final journey | Raw bytes, strict target mapping, duplicate/conflict persistence, null reasons, restart, generation/as-of selection and UI passed. Only an injected trusted read-only adapter interface/offline intake exists; no real platform collector, authorized polling scheduler or live collected data. |
| Iteration after metrics | Metric histories and versioned production requests exist | No automatic diagnosis→revised brief→new production task orchestration. This is an implementation gap, not merely hosting. |
| Reused 074/075 and latest QA revocation | Final fixture proves two different complete 074 IDs retain separate bodies; existing revisions/hashes enforce exact bindings | Actual inventory semantic matching (full ID + slug + body semantics + version), 075 inventory integration, and latest QA revocation overriding misleading 062 title flags remain pending. No claim that the real inventory was repaired. |

## Actual results and observed fixes

Final commands and log digests are in
[v3-final-evidence.json](evidence/v3-final-evidence.json). The full regression count
below is from this final pass, not the earlier 934/943/968/984/997 reports.

- Final integrated desktop/mobile tests: **2/2 passed**.
- Full regression: **999/999 passed**, zero failures/cancellations/skips; 78.389 seconds.
- Final syntax checks: **331 JavaScript/TypeScript files and one Python AST passed**.
- Read-only combined demo startup/media check: **passed**: local PNG HTTP 200, two metric series, approval PENDING and `can_decide:false`; service stopped after check.

The first integration run correctly rejected a fixture that bypassed the original
client-directory/frozen-media layout. The fixture was changed to call the existing
library import, with no production gate relaxation. Screenshot inspection then
found long hashes and preformatted review text exceeding the mobile panel. A new
assertion reproduced the failure; two scoped CSS rules wrap Review/metric text.
Desktop/mobile regression passed after that minimal production change.

Screenshots (all generated fixtures, no user media or credential screens):

| Surface | Desktop | Mobile viewport |
| --- | --- | --- |
| Original full preview | [desktop](evidence/v3-final/desktop-legacy-preview.png) | [mobile](evidence/v3-final/mobile-legacy-preview.png) |
| ZIP video in original Review | [desktop](evidence/v3-final/desktop-archive-video.png) | [mobile](evidence/v3-final/mobile-archive-video.png) |
| Content-only decision | [desktop](evidence/v3-final/desktop-approval.png) | [mobile](evidence/v3-final/mobile-approval.png) |
| Metric failure/history | [desktop](evidence/v3-final/desktop-metrics.png) | [mobile](evidence/v3-final/mobile-metrics.png) |

## Reproduce without keys or real platform access

Use the locked repository dependencies and existing Node >= 23.6, Python/Pillow,
ffprobe/ffmpeg and Chromium. No new software installation, account setup or secret
is required by these commands in the validated cloud environment.

```bash
node scripts/v3-acceptance-demo.mjs /tmp/publisher-v3-final-demo
node scripts/v3-review-local.mjs /tmp/publisher-v3-final-demo
```

The destination must be new. The second command prints a random **loopback-only**
URL; stop with Ctrl+C. Choose `Synthetic V3 customer`, inspect the original shared
content/preview and the three pending tasks across its accounts, then open 制作审核
and `SYNTHETIC-ARCHIVE-PRODUCTION`. Play the synthetic video and inspect metric
history. The unauthenticated local preview cannot approve; it does not create an
administrator, session or production credential. To reproduce the authenticated
approval flow safely, run the disposable browser tests instead:

```bash
PUBLISHER_TEST_BROWSER_PATH=/usr/bin/chromium \
PUBLISHER_TEST_FFMPEG_PATH=/usr/bin/ffmpeg \
V3_ACCEPTANCE_EVIDENCE_DIR=/tmp/v3-final-evidence \
node --test test/v3-acceptance-journey.test.js

PUBLISHER_TEST_BROWSER_PATH=/usr/bin/chromium \
PUBLISHER_TEST_FFMPEG_PATH=/usr/bin/ffmpeg \
node --test --test-concurrency=4 test/*.test.js
```

The test's disposable existing-admin config enables local preparation routes so
account switching can be exercised, but execution and scheduling are disabled and
an injected platform adapter fails if invoked. The tests assert zero adapter calls,
zero outside browser requests and exactly three unchanged DRAFT jobs. This flag
is not evidence that a Mac or real execution session was available.

For a separately authorized offline real packet, retain the no-key bounded import
entry and exact manifests in [slice 03](v3-slice-03.md). Offline intake itself does
not authenticate a producer or authorize publication.

## Remaining implementation and operational limits

The next work requires explicit prioritization, not more unbounded functionality:
authenticated producer request/result transport; approved artifact import with
original source-gate preservation; extracted-archive-media uploader integration;
real per-platform read-only metric adapters and their existing authorization;
conversation/direct-message and human-takeover primitives; metric-to-content
iteration orchestration; and real inventory QA/identity integration.

The authorized Study ZIP's connector metadata/reference was obtained in slice 03,
but materializing its bytes in this environment was denied by the proxy with
`Tunnel connection failed: 403 Forbidden`. That exact operation remains stopped;
no retry, alternate route or permission change was attempted in this final pass.
Real ZIP → Resolver → Review → browser acceptance and real Muse consumption remain
unverified. No actual sample bytes or signed download URL were committed.

Approval audit UI shows the latest 100 events, with explicit truncation; full DB
history is retained but audit export/pagination is future work. SQL append-only
triggers do not protect against the database owner. Archive cache assumes one
trusted local host/owner; crash lease reconciliation and rename-before-commit
cleanup are documented limitations, not proof against hostile same-UID writers.
The read-only metric adapter is trusted injected code; AbortSignal is not a process
sandbox for a non-cooperative adapter.

The parent reported an independent **static** fourth-slice review with no new
confirmed P0/P1. It checked generation/as-of, administrator route, replay/scope/
version gates and disabled real-source approval. The reviewer did **not rerun**
these test commands; execution counts above belong to this development environment.

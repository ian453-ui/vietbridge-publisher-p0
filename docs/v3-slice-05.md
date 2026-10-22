# V3 slice 05 — approved bytes to native upload preparation

Base: `6f628f5e041f2bf788c2dd3e30099e58d99c2149` on the existing independent
`publisher-v3/cloud-slice-01` branch. This package connects the four earlier slices
to the existing publishing workflow. It does not add a second application or a
standalone demo, and does not enable real external operations.

## Reused modules and smallest added interface

| Reused component | Role in this package |
| --- | --- |
| `ProductionReviewStore`, `ProductionApprovalStore` | Read exact reviewed request/result/BLOBs, current content decision, scope, account identity and revocations. No producer-authentication replacement. |
| `ArchiveAssetResolver` → `ingestArchiveProduction` | Existing ZIP extraction, checksum and actual image/video decoding before durable Review intake. No archive URL is accepted as upload media. |
| `sourcePlatformPayload`, `validatePlatformPayload` | Existing platform parsing and limits. Preserve separate platform copy; no Facebook-to-Xiaohongshu fallback. |
| `UnifiedPublisher.importContent`, variants and `createPageJob` | Stage the exact synthetic content and selected platform in the original registry; create an original `DRAFT` job with immutable review provenance. |
| `UnifiedExecutor.freezeMedia` | Freeze selected extracted media using the original uploader's local input boundary and `publisher_job_assets` ledger. |
| `UnifiedExecutor` submit intent, receipt, state machine and reconciliation | Exercise exactly one simulated submit and independent local readback; preserve UNKNOWN and pre-submit failure semantics. |
| Existing administrator authentication, Origin/CSRF, requestGuard and UI | One new guarded mutation in the existing Review detail, followed by the original content/platform/full-preview UI. App token scopes remain unchanged. |

New service: `ProductionUploadPlans` in `src/production-upload-plan.js`. One
endpoint, **POST `/api/production-reviews/<review-id>/upload-plan?workspace=<id>&accountId=<id>`**,
uses the same existing administrator requirement as content decisions. Exact body:

```json
{
  "source_id": "SYNTHETIC-VIDEO-001",
  "payload_artifact_id": "facebook",
  "expected_subject": "<current approval subject SHA256>",
  "expected_event_id": "<current CONTENT_APPROVED event UUID>"
}
```

No caller paths, media URLs, account override, permission flag, execution flag or
credentials are accepted. The target platform comes from the exact reviewed
account; the platform payload must explicitly target it. Only directly referenced
`cover`/`video` artifacts from that same content item become upload inputs. Scripts,
subtitles and article references are not silently uploaded as media. Video/image
mixing, unsupported media types, absent references and invalid platform payloads
are rejected. Titles/body/tags use the existing deterministic platform parser;
normalization is recorded as the frozen plan payload alongside the original
platform-file SHA256. This is not new human approval of generated variants.

The resulting plan returns content/job IDs, selected platform, canonical payload,
media MIME/size/SHA256, original payload SHA256, job state and
`status: UPLOAD_PREVIEW_ONLY`. `publish_allowed`, `source_gate_satisfied` and
`producer_authenticated` remain false. Only existing **SYNTHETIC_FIXTURE** provenance
with current explicit content approval can prepare a plan. Real unauthenticated
producer results remain blocked.

## Durable connection and execution separation

The additive tables `production_upload_plans`, `production_upload_bindings` and
`production_upload_jobs` bind the exact approval event/subject, review, full content
ID, selected platform file, account, generated content and native job. Plan IDs
are deterministic regardless of JSON key order. Repeated requests and concurrent
SQLite connections return the original job rather than creating another queue item.

Reviewed BLOBs are hash checked and materialized under a server-owned private
directory. Native content/variant/job rows and native frozen-media metadata commit
in the same transaction. `Store.tx` now uses savepoints for nested domain operations,
allowing import, job creation and media freezing to participate in that transaction.
A late injected DB failure rolls all of them back and removes the newly created
plan/media directories; original cold ZIPs and Review BLOBs are retained.

`production-handoff-guard.js` verifies that the selected account, platform, body,
media paths/hashes and current approval still match. Existing `assertCurrent`,
approval, execution, completion, reconciliation and default adapter construction
enforce the provenance boundary. The native snapshot includes `productionReview`.
Even enabling the existing global execution switch cannot execute these jobs with
a real adapter. Group jobs, external manual-complete and reimporting the known
planned/frozen media paths through ordinary content inputs cannot shed the binding.
Changing the reviewed account or bytes invalidates preparation; changing native
payload overrides is rejected. This does not defend against a malicious DB/file
owner who deliberately rewrites local storage and code.

The original Review detail now offers **生成上传准备与预览（不发布）** for eligible
approved synthetic platform payloads. It creates one local preparation plan, then
opens the existing publishing view. That view shows the existing native task and
plays media via the account-scoped Review asset route. The staged content is
filtered to its exact selected account. Its approved text is read-only, and native
publication approval controls do not open for the staged task. No background
submission or transport request follows the button click.

## Simulation acceptance, not platform certification

`synthetic-publication-driver.js` is a closed local adapter factory with no network,
browser, credential access or injected executable callbacks. A module-private
WeakSet recognizes this exact factory; a JSON flag or look-alike adapter cannot
grant the simulation exception. The application never constructs or exposes it
through an HTTP route. Tests inject it into the existing executor in disposable
databases; normal HTTP/UI behavior remains preparation-only.

The simulator's separate SQLite object table emulates an independent platform
readback source. Original `publisher_submit_intents`, receipts and job evidence
still record execution. Evidence is explicitly `syntheticOnly:true` and
`LOCAL_SYNTHETIC_READBACK`; it cannot count as genuine platform proof. The existing
verification UI returns `SYNTHETIC_ONLY` and excludes these rows from real published
totals. No metric target is automatically registered from simulation.

| Regression | Executed proof |
| --- | --- |
| Approved ZIP image and ZIP video → native content/platform variant → frozen input | Exact reviewed BLOB hash equals planned media and `publisher_job_assets`; real ZIP validation and ffmpeg decode occur during fixture intake. |
| Original UI consumer | Desktop 1440×1000 and mobile viewport 390×844 use existing login/Review, prepare once, open original preview and play the extracted 320×240 video to completion. No external browser request or adapter call. |
| Separate platform variant/account | Xiaohongshu uses its own reviewed request/account, parsed title/body/tags and image, with no Facebook variant copied in. |
| Duplicate queues | Concurrent execute calls yield one simulated submit; repeat delivery cannot submit again. Reordered request keys retain the same plan. Two independent Node/SQLite processes preparing concurrently produce one content/job/plan. |
| Unknown after successful submit | Local simulated object is committed, submit response is lost, native job becomes UNKNOWN. A **new Node process** reopens the database and reconciles with zero prepare/submit calls, including after later content-approval rejection. |
| Upload/preparation failure | Native preparation intent retained, job BLOCKED, zero submit intents or simulated submissions. Repeated preparation returns the same blocked task. |
| Approval/hash/account/target drift | Stale subject/event, wrong workspace/account/platform, body override, changed planned or frozen bytes and account identity changes are rejected. Unknown review evidence and unverified producer cannot prepare. |
| Late transaction failure | Failure inserting the final plan/job link rolls back plan/content/variants/job/asset metadata/audit; original approval survives; newly generated media directories are cleaned. |
| Auth and real-execution boundary | Missing authentication, wrong Origin/token, extra authority flags and app-token scope are rejected. Global-enabled executor, native manual-complete, default adapters, group creation and content cloning cannot publish the prepared source. |

Commands actually run in this environment:

```bash
PUBLISHER_TEST_BROWSER_PATH=/usr/bin/chromium \
PUBLISHER_TEST_FFMPEG_PATH=/usr/bin/ffmpeg \
V3_HANDOFF_EVIDENCE_DIR=/tmp/v3-handoff-evidence \
node --test --test-concurrency=2 \
  test/production-upload-plan.test.js test/production-upload-http-ui.test.js

PUBLISHER_TEST_BROWSER_PATH=/usr/bin/chromium \
PUBLISHER_TEST_FFMPEG_PATH=/usr/bin/ffmpeg \
V3_HANDOFF_EVIDENCE_DIR=/tmp/v3-handoff-evidence \
node --test --test-concurrency=4 test/*.test.js
```

- New targeted tests: **14/14 passed** before the final scope/hash self-review.
- Existing approval/executor/integration subset: **40/40 passed**.
- Final full regression: **1013/1013 passed**, zero failures/cancellations/skips; 91.613 seconds.
- Final syntax check: **337 JavaScript/TypeScript files and one Python AST passed**.
- Final UI-only clarification (disable native create/approval prompt for staged plans):
  **3/3 HTTP/desktop/mobile tests passed** after the full run; changed JS syntax
  rechecked. No subsequent executor/guard changes.
- [Execution evidence and log digests](evidence/v3-slice-05-evidence.json).
- Original preview screenshots: [desktop](evidence/v3-handoff-desktop-preview.png),
  [mobile viewport](evidence/v3-handoff-mobile-preview.png).

The initial failures were fixture/expectation errors: account-change rejection
returned the source-approval guard, not a stale-plan code; the Xiaohongshu fixture
needed the existing parser's explicit body format; `<option>` elements must be
waited for as attached rather than visible. Guards were retained. Self-review also
added request-key-order independence, frozen-copy checking on duplicate reads,
exact task/scope checking before simulation, and complete generated-file cleanup
after transaction failure.

## Can do, cannot do, next implementation gap

**Can do now:** take explicitly approved synthetic results, including decoded ZIP
media, and prepare inspectable native content/platform/job/upload inputs; view and
play them in the original application; demonstrate submission/reconciliation using
the same executor with a closed local simulator. No parallel demo registry is used.

**Cannot do now:** authenticate a real producer, satisfy the original real source
approval gate, authorize a real account to publish this new source type, or certify
an actual uploader/account against a platform. The source's lack of authenticated
transport is a real integration gap, not a hosting excuse. Existing per-account
publishing permissions are not reused as blanket approval for new producer data.
This slice does not complete real metrics collectors, direct messages, full human
handoff or metric-to-content iteration.

The next meaningful connection is an existing authenticated producer/source proof
and its explicit original-library approval semantics, then a separate exact-task
publication authorization through the existing account mechanism. That requires
real approved evidence; this package creates no credential or permission to fill
the gap. Until then the upload-preparation interface is useful and execution stays
disabled. The authorized Study ZIP transfer previously returned proxy **403**;
this operation was not retried and no alternate route was used.

Known bounded limits: local trusted-host/file-owner assumption; crash between file
rename and SQL commit may leave an orphan directory, which is refused with
`PRODUCTION_UPLOAD_ORPHAN_RECONCILE_PENDING` rather than overwritten. There is no
automatic orphan deletion/recovery in this package. Approval invalidation remains
on read/decision rather than an immediate background watcher. Existing audit/Review
limits and shared-administrator limitations remain as documented in slice 04.

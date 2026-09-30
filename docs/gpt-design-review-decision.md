# GPT Design Review Decision

- Task: `VB-PUBLISHER-DESIGN-REVIEW-003`
- Review date: 2026-09-01
- Status: `ACCEPTED_WITH_LOCAL_CORRECTIONS`
- Current owner: Codex local implementation

## Final product decision

Build a single-user local execution console, not a reduced Buffer/Hootsuite clone. Routine execution uses no generative AI. SQLite is operational authority, platform readback is side-effect authority, and Drive is an append-only mirror.

Keep `publication_batch → platform_job → platform_attempt → job_event`, but hide these technical objects and internal state names from the default UI. Show one compact task containing one independent row per selected platform.

`立即执行` means resolve the input, freeze an immutable content snapshot, validate each final platform payload and approval, then queue only eligible platform jobs. It never bypasses approval.

## Required changes before live execution

1. Remove the user-visible draft workflow and direct task creation into resolution/queueing.
2. Add immutable `content_snapshot` and `content_asset` records and copy selected assets into hash-addressed staging before execution.
3. Bind each platform job to one exact rendition and payload hash.
4. Add explicit attempts, receipts, attention requests and transactional outbox records.
5. Separate `BEFORE_EXTERNAL_SUBMIT` from `MAY_HAVE_SUBMITTED`; only proven pre-submit failures may receive bounded automatic retry.
6. Replace inferred percentages with discrete phases: 准备、上传、提交、平台处理、核对. Show a percentage only when a platform exposes real uploaded bytes.
7. Keep questions and actions inline on the affected platform row. Batch-level attention is only for unresolved content identity, whole-package drift, storage failure or batch pause/terminate.
8. Pause cooperatively; terminate means terminate unsubmitted jobs. Submitted jobs continue readback/reconciliation.
9. Limit P0 remote input to Google Drive URLs through fileId/API/revision/hash. Reject other HTTPS URLs without downloading.
10. Use deterministic exact matching first. Keyword search always returns candidates and never silently chooses one for publication.
11. Remove analytics collection from publication completion. P0 may schedule a non-blocking future analytics task.

## Local corrections accepted by GPT

- WeChat Channels authoritative readback without a platform ID becomes `PUBLISHED_ID_PENDING`, not `PUBLISHED`. UI: `已发布，编号不可用/待回填`. Later ID/URL discovery upgrades the same job idempotently without a new submit.
- Preserve `UNKNOWN` as an internal transient state and ordered audit event. A single SQLite transaction records `UNKNOWN → RECONCILE_PENDING`; the UI only shows `结果待核对：平台可能已收到提交，系统不会自动重发`.
- Google Drive URL is supported in P0; arbitrary HTTPS download is deferred.

## P0 implementation order

1. Schema migration: snapshots, assets, batch/job linkage, renditions, attempts, receipts, attention and event/outbox invariants.
2. Rebuildable resource index and deterministic resolver for ledger, article ID/version, allowlisted path/file, selected upload and Google Drive file ID.
3. Snapshot staging, MIME/hash/role/order validation and approval-scope hashing.
4. Minimal UI: one input area, platform eligibility checkboxes, immediate execution, one discrete-phase row per platform, inline actions, pause/continue/terminate-unsubmitted.
5. Platform adapters, locks/fencing, crash recovery and reconciliation.
6. Golden failure tests and live dry-run verification before any newly wired submit endpoint is enabled.

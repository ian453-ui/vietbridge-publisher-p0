# GPT content request / result correlation — first implementation slice

## Baseline and scope

Source baseline: Publisher `72ae7620a541aabe18d66bdc79306fdb414ddc3a`.
The previous **865/865** synthetic suite is not platform certification and does
not validate this new slice. The existing bridge checkout was read, not modified:
`ian453-ui/gpt-codex-claude-bridge`, `e17a76c09712af922c158515bb4c56c4efd45445`.
Its AGENTS.md, README, protocol/slack-tasks.md and scripts/bridge_agents.py define
Slack-first coordination, exact registered owners, explicit user-only transfer,
local authenticated claims and RESULT → REVIEW → independent verify → DONE.

`src/gpt-drive-inbox.js` already reads schema-v1 Facebook caption plus one image,
checks containment/bytes/image format and versions, and keeps results pending
user review. `library.js` already binds client roots and rejects enterprise GPT
approval. Existing revision tests preserve prior approved/frozen tasks, media,
UNKNOWN and account boundaries. We do not replace any of those safeguards.

Missing link: an incoming item did not itself identify the exact content request,
input fingerprint, designated GPT producer or original task thread. This slice
adds **local metadata correlation**, not a dispatcher, claim service or new queue.

## Implemented interfaces

- `createGptContentRequest(input, {priorRequest})`: canonical versioned envelope,
  SHA256 input fingerprint; same task/request revision cannot change silently.
  A higher request revision may change brief/input but not owner/account/source/thread.
  The current authenticated bridge must still decide whether any new request is allowed.
- `inspectGptContentResult(request,result,{now,priorReceipt})`: exact task, request,
  owner, GPT producer, workspace/account, source/version and original thread binding.
  Future/late/stale responses fail closed. FAILED/CANCELLED remain explicit and
  never cause a retry. Same receipt is DUPLICATE; a different result conflicts.
- `bindGptResultToInbox(request,result,candidate,context,options)`: matches an
  existing **fresh account-scoped** `readGptDriveInbox` candidate to title/body,
  content/visual versions, old revision and actual image hash. Returns a QA binding
  requiring fact review, visual QA and the existing user approval. No files opened
  or written by this function; no manifest READY or executor task is created.
- `scripts/gpt-content-contract.mjs`: reads specified local JSON metadata and
  prints request or inspection JSON. No HTTP, Slack, GitHub, Drive, database or
  browser mutation. It neither claims an external request was sent nor assigns work.

```sh
node scripts/gpt-content-contract.mjs --help
node scripts/gpt-content-contract.mjs request INPUT.json [PRIOR_REQUEST.json]
node scripts/gpt-content-contract.mjs inspect REQUEST.json RESULT.json [PRIOR_RECEIPT.json]
```

stdout export is deliberately explicit; the CLI does not auto-create files,
replace manifests or persist receipts. Protect any manually retained evidence
using the existing private artifact mechanism; do not commit real content or logs.

## Input example (synthetic, not a live task)

```json
{
  "schema_version": 1,
  "task_id": "EXISTING-TASK-001",
  "request_revision": 1,
  "current_owner": "MAC_CODEX",
  "producer": "GPT",
  "workspace": "client-fixture",
  "account_id": "account-fixture",
  "source_id": "FIXTURE-001",
  "content_revision": 1,
  "visual_revision": 1,
  "previous_revision": null,
  "created_at": "2026-10-20T10:00:00.000Z",
  "deadline_at": "2026-10-20T11:00:00.000Z",
  "bridge_ref": {
    "marker": "bridge-task:v1",
    "protocol_version": "2.0",
    "transport": "SLACK_FIRST",
    "slack_channel_id": "C0C6PRGNGLQ",
    "thread_ts": "1792490400.000001"
  },
  "input": {
    "kind": "image_text",
    "platform": "facebook",
    "brief": "Synthetic fictional client caption and primary image.",
    "language": "zh-CN",
    "source_refs": []
  }
}
```

Use real, explicitly authorized original task/thread references only when the
parent authorizes transport. Never send this fixture. Source references, when
present, require source_id/revision/sha256; this validator binds declared hashes
but does not fetch sources or independently verify them.

The exported envelope adds request_fingerprint, assignment_mode=STICKY and
handoff_policy=USER_EXPLICIT_ONLY. It is an **attachment to** the existing bridge
packet, not a replacement parent. Preserve that parent's cross_agent_read,
execution_target and other fields; no content metadata can relax them. The GPT
producer label is a correlation requirement, **not authenticated actor identity**
or permission for GPT to take over a MAC_CODEX task. Missing registered original
owner blocks; legacy aliases are not silently mapped. The existing integration
owner/task must never be rewritten just to satisfy this new contract.

## Result and QA contract

Result keys are exactly schema_version, task_id, request_revision,
request_fingerprint, current_owner, producer, workspace, account_id, source_id,
content_revision, visual_revision, bridge_ref, completed_at, status, output,
error_code. All binding fields echo the request. Timestamps use canonical UTC ISO
with milliseconds. `status` is content-result status SUCCEEDED/FAILED/CANCELLED,
not a bridge task transition. SUCCEEDED output contains exactly title,
facebook_caption, primary_image_sha256 and null error_code. Failure/cancellation
requires null output and a bounded symbolic error_code.

Results bind to the same original Slack thread. Only existing authenticated
transport/claim/owner checks can establish producer identity or authority.
No new endpoint, credential or always-on GPT worker is provisioned here.

A successful inspection yields REVIEW_REQUIRED, never READY/DONE/PUBLISHED.
Receipts identify request/result fingerprints only. They are **not signed,
trusted ledgers, execution locks or proof of receipt on Slack**. Exact duplicate
recognition may occur after expiry when a prior receipt is supplied; it cannot
produce a new review binding or execution. Without prior evidence, late results
are rejected even if they claim an earlier completion timestamp. This conservative
rule avoids silently adopting a result after an uncertain timeout.

Binding requires a freshly read pending/update inbox candidate and exact account
context from the existing authorized caller. Fabricated caller objects cannot be
made trustworthy by this function; no new public API exposes it. Actual structural
QA continues to use inbox path containment, file size, decoding/dimensions and
sha256 checks. Editorial/factual and visual QA are separate required human steps.
Existing approval refreshes candidate bytes/version again, preventing stale use.
Existing import/sourceProof/frozen executor creation remains downstream and is
**not called automatically** by this adapter.

## Failure / test evidence

Targeted command:

```sh
node --test test/gpt-content-contract.test.js test/gpt-revision-approval.test.js test/gpt-version-updates.test.js test/task-action-permit.test.js
```

First slice: **42/42 pass**, including 10 new tests. Covers canonical hashes,
changed input/version conflicts, exact owner/producer/account/thread, registry
case sensitivity, stale/future/expired result, duplicate/conflicting receipt,
failure/cancellation, real existing image decoding/hash matching, traversal,
missing/corrupt images, CLI malformed input non-echo and unchanged manifest/media.
Existing revision/permit regressions cover old frozen tasks/UNKNOWN and duplicate
approval. No live client files or accounts were read; fixture images only.

## Deferred boundaries / next useful integration

1. Independent platform review supplies official API eligibility; do not infer
   authorization from local adapter classes.
2. Existing bridge transport can attach a request and read the same thread only
   after explicit send/read scope and authenticated producer/claim checks. No
   recurring Drive queue, GitHub ingress or new owner selected here.
3. A future authenticated ingestion path must store receipts atomically with the
   existing artifact review record before claiming concurrent exactly-once intake.
   Current pure functions deliberately make **no concurrent persistence guarantee**.
4. Only then connect fresh scoped inbox binding to the current review UI. Keep
   enterprise approval rejection, sourceProof and frozen-task protections intact.
5. Scripts/video/subtitles need a separately reviewed artifact schema and ingest
   adapter. Current v1 inbox and single-image manifest sync cannot accept them.
   This slice explicitly rejects video/TikTok inputs rather than advertising support.

This is a code-level local content contract, not a changed agent harness, platform
certification, autonomous content producer, real dispatch or deployed service.

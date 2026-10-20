# Local content production workbench

This is the usable local entry for the existing GPT content contract, not a new
queue or model service. Start with `npm run content:workbench -- --help`.
It accepts a plain brief and optional reference text, exports the existing request
attachment, packages explicitly supplied producer output, and reads the existing
schema-v1 inbox to generate a human QA preview. No JSON authoring is needed for
that normal local path.

## Reproducible synthetic end-to-end case

Choose a new path; the command refuses existing outputs rather than overwriting.

```sh
npm run content:workbench -- demo --out /tmp/publisher-content-demo
```

Open `/tmp/publisher-content-demo/preview.html`. It is self-contained with the
actual fixture image, old/new text and content/image revision numbers. The case
changes a fictional workshop from Saturday to Sunday: title and body change,
image stays the same, content revision advances from 1 to 2 and visual revision
stays 1. The existing inbox supplies `UPDATE_AVAILABLE`, `previousVersion` and
`previousRevision`; the existing request/result adapter binds them and returns
`REVIEW_REQUIRED`. The manifest remains at approved content revision 1.

Artifacts include brief.txt, request.json, result.json, review.json, preview.html,
and a synthetic-client directory using the original publisher-manifest.json /
GPT-INBOX / READY structure. The demo uses a registered **synthetic** MAC_CODEX
owner and synthetic thread; never send these artifacts to a real task. No owner
is assigned by this command. It uses the repository's existing test image.

Deterministic failure demonstrations (within the normal demo's one-hour expiry):

```sh
# Missing result: WAITING_FOR_RESULT; exported does not mean dispatched.
npm run content:workbench -- review --request /tmp/publisher-content-demo/request.json
# Wrong request revision: RESULT_BINDING_MISMATCH, exit 1.
npm run content:workbench -- review --request /tmp/publisher-content-demo/request.json --result /tmp/publisher-content-demo/wrong-revision-result.json --root /tmp/publisher-content-demo/synthetic-client
# Expired request: RESULT_EXPIRED, exit 1, even with no supplied result.
npm run content:workbench -- review --request /tmp/publisher-content-demo/expired-request.json
# Existing output: OUTPUT_ALREADY_EXISTS, exit 1, existing files retained.
npm run content:workbench -- demo --out /tmp/publisher-content-demo
```

No failed command renews a request or retries production. After expiry create a
fresh synthetic demo at a different path for testing; actual task renewal belongs
to the original owner and authorized bridge workflow.

## Explicit brief → request attachment

Create a plain UTF-8 brief text file. Supply the **existing** task, owner, account
scope and original Slack thread explicitly; no guessing or automatic discovery.
For example, these placeholders are synthetic and not dispatchable:

```sh
npm run content:workbench -- request --task SYNTHETIC-CONTENT-001 --owner MAC_CODEX --workspace synthetic-client --account synthetic-account --source DEMO-002 --thread 1792490400.000001 --language zh-CN --brief-file /tmp/brief.txt --out /tmp/request.json
```

Optional `--source-file /tmp/reference.txt --source-revision r1` includes the exact
reference text in the brief and records its SHA256. It does not retrieve or verify
external facts. `--ttl-minutes` defaults to 60 and is bounded to 1–1440. Content is
currently Facebook single-image plus caption, matching the existing v1 inbox.
Request revision/content revision/visual revision default to 1. For an update,
provide `--prior` and explicit `--request-revision`, `--content-revision`,
`--visual-revision`, and the trusted old inbox `--previous-revision` token. The
contract rejects owner/thread changes and same-revision input mutations. No
existing task is updated and no canonical request ledger is inferred from files.

The result is an **attachment** for the original Slack bridge packet. Preserve
that packet's owner, task, cross-agent-read, execution target and claim rules.
The CLI does not dispatch, claim, authenticate a producer, call a model, incur
model fees, or configure a route. The current integration's CLOUD_CODEX owner is
not in the reviewed bridge registry: attempting that owner stops with
INVALID_BRIDGE_REFERENCE. Do not substitute MAC_CODEX/GPT to make a real task
pass. Resolving an actual route/registry is outside this local slice.

## Explicit producer artifacts → pending review

Given an actual returned caption and image in a permitted local export area:

```sh
npm run content:workbench -- package-result --request /tmp/request.json --title "Synthetic title" --caption-file /tmp/caption.txt --image /tmp/image.png --out /tmp/new-result-package
```

This computes image bytes/hash and produces result.json, submission.json and
primary image. It labels the metadata producer as required by the contract but
explicitly returns `producer_authenticated:false`: packaging is not evidence GPT
sent it. Completion time is this local packaging observation, not proof of model
completion. An existing authenticated producer result should instead be retained
verbatim and passed to review; never repackage a late result to hide its age.

For review, use an explicitly chosen **local isolated** client root containing
the matching package under GPT-INBOX and its existing manifest. The demo builds
that structure without manual JSON. `package-result` can also target a new folder
under an isolated root's GPT-INBOX. It never changes a manifest or imports content.

```sh
npm run content:workbench -- review --request /tmp/request.json --result /tmp/new-result-package/result.json --root /tmp/isolated-client --out /tmp/qa-preview.html
```

Review rereads the actual inbox and matches task/account metadata, old revision,
content/image versions, text and actual image hash. Wrong versions, changed base,
missing/corrupt images and expired requests stop before preview export. HTML
escapes supplied text, embeds the validated current image, disables scripts and
network through CSP, and provides no approve/submit button. It shows the old
image hash; if the image changed, inspect the old image in the original review UI.
The preview is a dated-by-file snapshot and must never be reused as approval.

## Existing review and security boundaries

The local root/account relationship is caller-declared, **not authenticated**.
This is why no HTTP upload/approval endpoint was added. Review uses
`readGptDriveInbox` and `bindGptResultToInbox`; it uses the same `previousVersion`,
revision and pending statuses as the existing `gptReviewArticle` interface.
Only the existing authorized library UI may re-read, approve and import content.
Its enterprise rejection, root ownership checks, sourceProof, CSRF/Host and frozen
publication-task rules remain unchanged. This CLI never calls approveGptDriveItem,
creates a READY manifest entry, opens a DB, starts a scheduler, or changes a task.

All outputs use exclusive creation. A failure partway through a multi-file export
may leave a partial **new** folder; nothing treats it as dispatched or approved.
Inspect it and choose a new output path. This is not atomic delivery or a receipt
ledger. Error messages use bounded codes, not file contents or paths. Do not commit
real briefs, reference text, images or preview reports to public Git.

## Regression and lessons

- The old metadata CLI required users to construct envelopes manually. Parameter
  entry and result packaging now cover the local end-to-end path without relaxing
  the underlying exact schema, registry or fingerprint checks.
- A successful result alone is insufficient: the fresh inbox can reject changed
  old content or damaged images. Tests mutate both and require rejection.
- Missing result is not a failed execution; the report explicitly says no dispatch
  occurred. Expired requests and wrong revisions have separate actionable errors.
- Manual review output is untrusted text: HTML escaping/CSP and an embedded image
  keep the preview from executing producer text or fetching external resources.

Tests use synthetic metadata and the existing image fixture. No real model call,
platform operation, production DB, permission change, Mac change or deployment.
This is an application CLI integration, not a modification of the agent harness.

### Final validation — 2026-10-20

On the final implementation above baseline
`ddee3c05897dd94961ec75dfd2c4751911c6c21c`:

- New workbench end-to-end tests: **5/5 passed**.
- Workbench + content contract + GPT revision approval/version updates + library
  + task permits: **56/56 passed**.
- Full project suite: **903/903 passed**, no failures/cancellations/skips,
  61.022 seconds. The three new JS/MJS files pass syntax checks; diff check passes.
- Actual npm demo produced REVIEW_REQUIRED, a read-only HTML preview and unchanged
  approved manifest revision. Actual wrong-revision and expiry commands both
  rejected with exit 1 and their distinct diagnostic messages.

```sh
node --test test/content-workbench.test.js test/gpt-content-contract.test.js test/gpt-revision-approval.test.js test/gpt-version-updates.test.js test/library.test.js test/task-action-permit.test.js
PUBLISHER_TEST_BROWSER_PATH=/usr/bin/chromium PUBLISHER_TEST_FFMPEG_PATH=/usr/bin/ffmpeg npm test -- --test-concurrency=4
```

Local evidence (not committed raw logs/content):
- `/tmp/publisher-workbench-regression.log`, SHA256 `04d04f2286e81bbfe796e647833a37c5154e16aded1bcf439014ce01a1a68fa0`.
- `/tmp/publisher-workbench-full.log`, SHA256 `1ec3017ebc6f0d4328f07664784399a28eed5f5c0a8c2b04ba5263fb315736e0`.
- `/tmp/publisher-content-workbench-demo-20261020/preview.html` and its synthetic
  request/result/review artifacts.

Visual screenshot check was **blocked**, not completed: cloud Chromium refused
navigation to that preview's `file://` URL with `ERR_BLOCKED_BY_ADMINISTRATOR`.
The browser was closed; no policy was changed and no alternate serving path was
used. HTML generation, escaping, CSP and image embedding have automated test
coverage, but rendered browser/visual acceptance is not claimed.

## Multi-item non-publishing production

The [schema-v2 production mode](production-artifacts.md) adds knowledge articles,
scripts, subtitles, videos, covers and separately referenced platform payloads.
It stays outside v1 inbox/import/approval and does not reduce enterprise guards.
The single-image path documented above remains unchanged.

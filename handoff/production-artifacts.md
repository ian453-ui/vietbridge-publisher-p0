# Non-publishing production artifacts — schema v2

## Scope and entry

`npm run content:workbench -- --help` now exposes `production-request`,
`production-package`, `production-review` and `production-demo`. These are local
commands attached to the existing bridge task, not a dispatcher, second queue,
claim service, publisher or model client. The schema-v1 FB caption/single-image
request, inbox, UI, approval and import contracts remain available unchanged.

Production output may be a knowledge article, script, subtitle, video, cover or
independent platform payload. Full articles are never coerced into captions.
The same bridge task can contain multiple independently identified content items.

## Reproducible demonstration

Choose a new output directory:

```sh
PUBLISHER_TEST_FFMPEG_PATH=/usr/bin/ffmpeg npm run content:workbench -- production-demo --out /tmp/production-demo
```

The demo contains **synthetic** `SYNTHETIC-KB-003`, `SYNTHETIC-KB-040` and
`SYNTHETIC-VIDEO-001`; these are not Study deliverables or the original Study task.
It creates two knowledge Markdown files, separate cover files and separate FB
text payloads; the third item contains script, SRT, one-second blue MP4 and cover.
Existing test image decoding is reused. Local ffmpeg generates the demo video;
no model API, network operation or fee is involved. In V3, ffprobe and ffmpeg are
also required for normal video inspection; unavailable decoders fail closed.
A failed demo may leave a partial
new directory; choose a new path, never overwrite existing artifacts.

Outputs: `plan.json`, `selections.json`, `request.json`, `result.json`, `report.json`
and `artifacts/`. The first two files are reusable schema examples for integration
code. Report is `structure:VALIDATED`, `status:REVIEW_REQUIRED`,
`publish_allowed:false`, `import_allowed:false`, `owner_changed:false`,
`producer_authenticated:false`. Scope remains UNKNOWN, even for this valid demo.

```sh
# Export a request from an explicit plan (new output path).
npm run content:workbench -- production-request --plan /tmp/production-demo/plan.json --out /tmp/production-request.json
# Package explicitly supplied local files; no production or authenticated receipt implied.
npm run content:workbench -- production-package --request /tmp/production-request.json --selections /tmp/production-demo/selections.json --root /tmp/production-demo/artifacts --out /tmp/production-result.json
# Re-read actual artifacts and inspect the returned result.
npm run content:workbench -- production-review --request /tmp/production-request.json --result /tmp/production-result.json --root /tmp/production-demo/artifacts
```

An actual producer-returned result must be inspected verbatim. Packaging timestamps
record local packaging, not authenticated producer completion. Never regenerate an
expired envelope to conceal a late or uncertain result. The demo expires in one
hour; its files are not live task evidence.

## Minimum request fields

Top level (exact keys):

- `schema_version:2`, `mode:PRODUCTION_ARTIFACTS`.
- `task_id`, `request_revision`, `current_owner`, `producer: GPT`.
- `workspace`, `account_id`: explicit IDs or null. An account cannot be specified
  without workspace. Any missing mapping yields UNKNOWN; complete values remain
  CALLER_DECLARED, not authenticated. No inferred Study IDs or copied engineering IDs.
- `bridge_ref`: original marker/protocol/Slack channel/thread, checked by the same
  `validateGptTaskIdentity` used by v1. GPT is already registered; the engineering
  owner CLOUD_CODEX is not substituted into a GPT content task.
- `created_at`, `deadline_at`: canonical UTC milliseconds; explicit valid interval.
- `items`: 1–50 unique source IDs.

Each item has exact keys `source_id`, `content_revision`, `visual_revision`,
`previous_revision`, `brief`, `source_refs`, `deliverables`. Source IDs reuse the
v1 uppercase content-ID format; revision numbers are positive integers. Brief is
bounded to 20,000 characters. Source refs use source_id/revision/sha256 and bind
caller-declared evidence; this module does not retrieve the source.

Each deliverable has `artifact_id`, `kind`, `language`, `platform`, `references`.
Kinds: `knowledge_article`, `script`, `subtitle`, `video`, `cover`,
`platform_payload`. Artifact IDs are unique **within their item**. Language is an
explicit label, not language detection. Platform is null except for a platform
payload, where it is an explicit ID (not proof of platform capability).
References are other artifact IDs in the same item. A platform payload requires
at least one such reference. Cycles are not an execution graph: no scheduler or
ordering is derived from references; no artifact can reference itself.

Example: item 003 owns article/cover/facebook. Its facebook artifact refers to
its own article and cover. Item 040 has separate files and independently bound
references; no source ID switch is treated as a revision of item 003.

The request adds a canonical fingerprint, STICKY assignment and USER_EXPLICIT_ONLY
handoff. `production-request --prior prior-request.json` preserves task, owner,
producer, scope and thread. Same request revision cannot change. Prior items
cannot disappear/rename silently. Changing an existing item requires a higher
content or visual revision, no revision regression, and `previous_revision`
equal to that prior item's canonical fingerprint. Unchanged items retain their
versions. **This v2 previous token is a production-item fingerprint, not the v1
inbox's previousRevision token. Do not interchange them.**

## Results, file binding and duplicate handling

Results echo schema/mode/task/request fingerprint/owner/producer/scope/thread,
then give canonical `completed_at` and exactly the requested items. Each item
carries source_id, content_revision, visual_revision, previous_revision,
item_fingerprint and artifacts. Each artifact carries artifact_id, root-relative
path, actual SHA256 and references with `{artifact_id,sha256}`. The inspector
matches reference hashes to the sibling artifacts and independently hashes each
file. Missing/extra/duplicate items or artifacts, cross-item references, mismatched
versions, owner/thread changes, modified files and reused file identities
reject. Distinct files may legitimately have identical bytes/hashes. File identity
uses device + inode from the same open descriptor used to read bytes, across the
whole result. Different hardlink or symlink names do not make independent files.
Shared assets are not implicitly supported: this version has no explicit shared
artifact reference contract. Matching hashes alone are not file-identity evidence.

Selections for packaging are arrays of `{source_id,files:[{artifact_id,path}]}`.
The packager fills envelope, item fingerprints, file hashes and reference hashes;
it does not author or transform artifacts, authenticate the actor or mark approval.

Paths must be relative without traversal; realpath containment rejects symlink
escapes using actual parent-directory segments (`..` or `../`), not any name
beginning with two dots. A root-local `..notes.md` is legal.
Every file must be regular, nonempty and size-bounded: text/SRT 1 MiB,
cover 20,000,000 bytes, video 100 MiB. JSON input uses the existing strict parser
and 1 MiB CLI cap, including duplicate decoded-key rejection. Output creation is
exclusive. No source file or original manifest is written by inspection.

A successful result returns a request/result fingerprint receipt. Supplying the
same receipt via `production-review --receipt receipt.json` returns DUPLICATE
with no review/import authority; a different result conflicts. Actual files are
still validated before duplicate recognition, including after expiry. Without a
prior receipt, expired requests/results reject. Receipts are caller-supplied,
unsigned correlation data, not an atomic delivery ledger or authenticated claim.

## What is actually validated

| Artifact | Validation performed | Still requires independent review |
| --- | --- | --- |
| knowledge_article | Actual `.md` bytes, UTF-8, nonempty/no NUL, hash | Facts, sources, full bilingual content, editorial quality |
| script | Actual `.md`/`.txt` bytes and same text checks | Story, claims, shot plan and executable suitability |
| subtitle | Actual `.srt`, sequential cues, time syntax, increasing start/nonnegative duration | Translation, overlap choices, alignment with actual speech/video |
| cover | Existing Pillow-backed image decoder, dimensions/format, actual byte hash | Visual/pixel quality, language accuracy and semantic fit |
| platform_payload | Separate `.md`/`.txt`, actual hash and explicit sibling references | Platform limits/policy, account selection and publishing permission |
| video | Actual hash-bound bytes, ffprobe stream/container metadata, full ffmpeg A/V decode to EOF, duration agreement, bounded resources | Human visual/audio QA, browser/platform playback compatibility, subtitle alignment |

V3 replaces the old `BYTES_HASH_ONLY` boundary with `VIDEO_DECODED`, `decoded:true`,
`duration_verified:true` after successful probing/full decode. The original fake
MP4 now rejects; the regression was reproduced before repair. Decoder absence,
truncation, audio-only and mismatched container reject. Validation accepts one
video and at most one audio stream, at most 10 minutes / 3840×2160 pixels / 60,000
decoded frames / 100 MiB, with 5-second probe and 20-second decode timeouts.
Decode uses a private copy of the exact hashed bytes, fixed container demuxer and
file-only protocol. Timeouts fail, never partially accept. Conservative bounds may
reject otherwise usable long/complex videos; do not relabel them validated.
V3 slice 02 adds whole-batch metadata preflight (100 artifacts, eight videos,
128 MiB) before bytes/decoders, a shared processing deadline and hard subprocess
termination. The validated buffers are reused for receipt/BLOB persistence;
one intake no longer reopens and decodes each video twice. See
[slice 02 resource limits and archive acceptance](../docs/v3-slice-02.md).
`playback_verified:false` and `browser_playback_verified:false` remain explicit:
decode is not human viewing or universal browser/platform compatibility. SRT reports
`video_alignment_verified:false`. No file-format check establishes producer identity.

## Original task and enterprise boundaries

The actual `GPT-DAILY-20261021-TOPICS` and its pending status inquiry are untouched.
Real workspace/account/source mapping, production session, artifact versions and
receipt remain unknown. No live request is fabricated, no duplicate content is
produced and dot's separate batch is not adopted as the original GPT result.

Production v2 does not call readGptDriveInbox/approveGptDriveItem or create READY
entries. Enterprise formal-source handling and `Library.approveGpt` guards remain
unchanged. A future approved adapter must independently verify the original
source, account and review gates; this report alone cannot authorize import.
V3 adds a pending inspection ledger and read-only HTTP preview protected by the
existing application authentication. It adds no permission scope or producer
authentication. The original maintenance wrapper remains unchanged and does not
expose this new Review API. See [V3 acceptance](../docs/v3-slice-01.md).

## Regression cases and observed design corrections

The previous single-image contract could not represent a batch or keep full
knowledge/script text separate from platform copy. V2 separates these roles and
binds references to per-item artifact hashes. It keeps v1 unchanged rather than
making legacy captions ambiguous or weakening their exact schema.

Synthetic tests cover the two knowledge items plus script/subtitle/video, missing
and duplicate parts, mixed revisions/fingerprints, wrong owner/thread/scope,
changed hashes, mismatched caption references, reused files, traversal/symlink
escapes, corrupt image, malformed UTF-8/SRT, duplicate/conflicting results, expiry,
item-by-item revision evolution, strict JSON and exclusive CLI outputs.

Final validation, 2026-10-20, implementation based on
`b298fb64d905b7ab6db4033c3e6d248a69e4304d`:

- Nine new artifact tests plus v1 contract/workbench: **27/27 passed**.
- Relevant artifact/workbench/contract/revision/library/permit regression:
  **65/65 passed**.
- Full project suite: **912/912 passed**, no failures, cancellations or skips,
  63.027 seconds.
- Tracked JS/MJS/TS (excluding `.d.ts`) plus three new files: **292/292 syntax
  checks passed**. `git diff --check` passed.
- Actual `production-demo` generated the three synthetic items and returned
  REVIEW_REQUIRED / VALIDATED / UNKNOWN with no import or publication authority.

```sh
node --test test/production-artifact-contract.test.js test/content-workbench.test.js test/gpt-content-contract.test.js test/gpt-revision-approval.test.js test/gpt-version-updates.test.js test/library.test.js test/task-action-permit.test.js
PUBLISHER_TEST_BROWSER_PATH=/usr/bin/chromium PUBLISHER_TEST_FFMPEG_PATH=/usr/bin/ffmpeg npm test -- --test-concurrency=4
```

Local evidence, not committed raw logs or runtime artifacts:
- `/tmp/publisher-production-regression.log`, SHA256 `8cd2f7aab2c62ef2908d3e904de1b797e540b41b2d0c218360c01c23c29166a3`.
- `/tmp/publisher-production-full.log`, SHA256 `c256a5fff92658fac0f858bd535a45c12485666fe113c51de5a20c8005d3a727`.
- `/tmp/publisher-production-demo-20261020/` contains the reproducible synthetic
  plan, selections, request, result, report and artifact files.

No image rebuild, browser screenshot retry, actual Study production, external
dispatch, model call, new credential or deployment was performed. The existing
enterprise approval guard and production database were not changed.

### Independent review: path segments and physical file identity

Review of `b79bd9ad363440f98cb28fcc899e0e40e439d21b` reproduced two defects:
a legitimate root-local `..notes.md` was rejected by an overly broad
`startsWith('..')` check, while two hardlinks to one inode were accepted as
independent artifacts because only canonical path strings were compared.
Two regression cases failed on that baseline before the fix.

Containment now checks actual parent-directory segments and still resolves
symlinks before checking the root boundary. Within one result, all artifacts
must have distinct `(device,inode)` identities, captured with bigint `fstat`
from the same descriptor used for reading their bytes; descriptors close on
success and failure. Internal filesystem identity is not exported in receipts
or reports. Hardlinks and symlink aliases reject as ARTIFACT_FILE_REUSED.
Independent files with equal bytes remain valid. This does not establish
editorial uniqueness or add an implicit shared-asset mode.
Opening uses O_NONBLOCK before fstat so a FIFO cannot hang while waiting for a
writer; non-regular files still reject before any byte read.

Synthetic positive/negative cases cover the double-dot filename, outside-root
symlink, independent equal-byte covers, same-inode hardlinks across two items,
root-contained symlink alias, and rejection during both packaging and inspection.
An additional bounded subprocess test verifies FIFO rejection without a writer.
No publish/import gate, original inbox, enterprise guard or real artifact changed.

Final correction validation (2026-10-20): relevant regression **68/68 passed**;
full suite **915/915 passed**, no failures/cancellations/skips, 64.524 seconds.
Both changed JS files passed syntax checks; diff check passed. The full suite was
run on the final O_NONBLOCK version, not reused from the earlier correction run.
Commands are the same relevant/full commands above, including the expanded tests.

Local evidence:
- Reproduction before repair: `/tmp/publisher-artifact-path-before.log` (both
  reviewer cases failed as expected).
- `/tmp/publisher-artifact-path-regression.log`, SHA256 `990c1dbcd03c8d1bb68ce3f4f72f912a3a463dc29e9b4988a5d72e35889dd11b`.
- `/tmp/publisher-artifact-path-full.log`, SHA256 `194ce87ddb93892b81f7e213918859132627320883f8f7dae1d5edfd8fc9ffe8`.

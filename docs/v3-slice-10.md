# V3 slice 10 — canonical source → persistent Review

Base `770f4664d76975555ed7428a0e16dc85d305ede2`, same V3 branch and private
Site `appgprj_6ad97a034fd08191a8399eeda10f048c`. This is cloud development
and synthetic acceptance, **not hosted delivery or actual Drive recognition**.
No article/image production, credential, real social action or user-file deletion.

## Confirmed defect and reused paths

The existing `ManifestDriveSync` ignored `body_source_sha256`: a manifest declaring
one body hash could download different bytes and still leave that entry READY.
The exact new regression failed before the fix (`actual READY`, expected BLOCKED)
and passed after supplying the declared hash to the existing download verifier.
Loose-file compatibility and the original source registration/transport remain.

`CanonicalSourceInspector` consumes existing canonical manifest concepts: full
content_id/article_id, slug, source folder/document and anchor, body_source,
content_drive_file_id, primary image or explicit active_assets/asset_sources,
content/visual versions and latest qa_status. It does not infer identity from 074
or a filename/title PASS flag. Unicode slugs remain exact identities.

It reuses the original ProductionRequest fingerprint, sticky task ownership,
source_refs, item revision chain, media decoders and ArchiveAssetResolver. The
new `packageProductionInspection` returns result/report/snapshots from one bounded
inspection pass; the original `packageProductionResult` API retains its behavior.
The importer does not package, then decode the same media again.

## Interfaces and strict source contract

The native heavy-service adapter takes only server-injected `binding`,
`readManifest`, `readFile`, `getRequest`, optional existing `resolver` and clock.
There is no connector implementation, client authenticated flag, public import
endpoint or default real provider. Do not configure it with browser-supplied IDs
or a client-generated ProductionRequest. Account/project/source registration and
producer authentication remain independent trusted-provider responsibilities.

The registered binding is workspace/account + business project + source folder +
manifest file ID + full content ID + slug. Manifest reads return exact registered
file/project/folder, positive monotonic revision and bytes. The manifest's project
must match. A successful candidate must declare content/visual revisions and
source_doc_id, with a matching content anchor if supplied. Loose artifacts must
have file ID, upstream revision, bytes, SHA256 and document association; returned
metadata must exactly match workspace/account/project/folder/document/content and
requested file/revision. Required strict metadata may be absent in historical
files; these fail this new importer rather than fabricate it or break V1 reading.

Original source_refs must bind manifest file ID, revision and raw-byte SHA256.
Artifact IDs/kinds must match the original request. No arbitrary filename lookup,
short-ID merging, image fallback or silent body-to-platform-copy conversion.
This increment imports body plus explicitly associated image/video artifacts;
existing platform preparations still require an explicit platform_payload result.
Generating platform copy or selecting another account is not an import side effect.

Optional body_archive or asset archive values use the unchanged ZIP_BYTE_PARTS
contract. The Archive resolver binds its project_id to the registered workspace;
the source business project is separately verified by the canonical adapter.
Split parts, archive/member SHA, traversal/bomb checks, cache/leases and extraction
are reused. Only extracted, hashed, decoded bytes enter Review; ZIP URLs never
become platform media. Loose body plus ZIP media works in the same intake.

Budgets: manifest 256 KiB/1000 candidates; at most 32 artifacts, 16 MiB per file,
32 MiB total snapshots and 256 MiB conservative archive transfer sum. Original
kind-specific limits still apply. Five-second cooperative source reads and a
30-second inspection deadline bound work; injected readers must honor AbortSignal
and streaming size limits. These are not a sandbox for malicious/non-cooperative
providers. Native ffmpeg/Pillow/ZIP processing remains outside Workers.

## Source observation, approvals and recovery

`AsyncSourceImport` uses the existing AsyncReviewStore and private object store.
Schema-only candidate migration `0006` adds source heads, attempts, Review-source
bindings and import receipts. It grants no permissions and is not applied to D1.

A recognized new source version is recorded **before** media IO. Failed media,
missing/empty associations, removed exact content, corrupt ZIP or withdrawn QA
therefore block old approval even if replacement intake fails. Same upstream
version with changed hash becomes CONFLICT; older versions cannot roll it back.
Only exact latest QA PASS can enter media inspection; title flags are irrelevant.
The source record is provenance metadata, never producer authentication or approval.

Existing approval reads append REVOKED when a current source is blocked/changed.
Approve, prepare and synthetic submit batches now also compare-and-set the exact
source version/hash/attempt and IMPORTED state. Live owner/membership checks still
run in the same SQL transaction. A newer source/QA observation cannot be overwritten
by a slower old intake. Changes are observed on import/read/decision; no background
Drive polling or instantaneous external-change invalidation is claimed.

Duplicate import reuses its durable receipt without fetching media. A failure
after Review commit retains the immutable bytes and reuses them on safe retry.
A lost final SQL acknowledgement reads the receipt rather than repeating work.
A crashed READING attempt requires explicit `reconcile(reference)`: it verifies
the exact already stored request, artifact hashes/sizes and private bytes, then
completes the same attempt. It never calls media inspection. Without a complete
Review it remains RECONCILE_PENDING; no TTL reset or automatic second import.
The partial objects/attempt remain for operator investigation, never deletion.

Original publication jobs, attempts, quotas and UNKNOWN reservations are not
mutated by import. Import is not publication recovery. Existing synthetic executor
regressions still require UNKNOWN→RECONCILE_PENDING and no second submission.

The existing Review UI now shows full ID/slug, snapshot versus latest source
version, latest QA and blocked reason. It retains original body/image preview,
checklist, audit and content-only approval. Real provenance and original admin
providers remain unavailable; only test fixtures can approve these test packets.

## Executed acceptance

[Machine-readable evidence](evidence/v3-slice-10-evidence.json) records current
commands, actual results, reproduction logs and screenshot hashes. Current full
regression: **1113/1113 passed**, fail/cancel/skip 0, **105.927 seconds**.
Targeted importer: **18/18**; targeted desktop/mobile source journey: **2/2**.
Thirteen changed/new JS/TS files passed syntax checks; `git diff --check` passed. Local SQLite
uses the asynchronous D1 method shape; private file objects use the R2 method
shape. These are **not hosted D1/R2**. Browser routes are confined to loopback.

Reproduce the import, ZIP, failure/recovery and original console journey:

```sh
PUBLISHER_TEST_BROWSER_PATH=/usr/bin/chromium \
PUBLISHER_TEST_FFMPEG_PATH=/usr/bin/ffmpeg \
V3_SITES_EVIDENCE_DIR=/tmp/v3-slice-10-ui \
node --test --test-concurrency=2 test/sites-canonical-import.test.js \
  test/sites-cloud-console-ui.test.js test/content-sync.test.js
```

This command supplies explicit synthetic providers in test/fixtures only, without
keys, downloading user data or enabling any external action. No standalone mock
application was added. The original console/API and production contracts execute.

Screenshots: [mobile source](evidence/v3-slice-10/mobile-canonical-review.png),
[desktop source](evidence/v3-slice-10/desktop-canonical-review.png),
[mobile withdrawn QA](evidence/v3-slice-10/mobile-canonical-qa-withdrawn.png),
[desktop withdrawn QA](evidence/v3-slice-10/desktop-canonical-qa-withdrawn.png).

## Deployment and remaining work

A bounded read-only mount check again found no official Sites starter/helpers.
The saved Site was read again: version 0, no preview/live URL, owner-only policy,
no external visitors. It was not recreated or modified. The existing official
bundle download CONNECT 403 remains denied and was not retried or routed around.
Cloud skills also became unavailable during this turn; no guessed build/auth was
substituted. Continue setup already failed in the parent environment and is not
presented as a sufficient recovery instruction.

Required recovery is actual platform restoration of the official helpers/bundle
access in this selected cloud environment. No user credential, Mac wake-up or
sharing change is needed. Independent remaining code gaps include trusted real
source/admin/producer transport, strict metadata projection for historical Drive
inventories, explicit platform-result import, durable cloud heavy-media execution,
async real permit/quota and uploader/readback, interaction/messaging providers,
and metrics-to-next-brief workflow. The [whole-chain matrix](v3-sites-acceptance.md)
prioritizes these separately from deployment. The previously denied Study sample
stays untested; no real bytes or signed URLs are committed.

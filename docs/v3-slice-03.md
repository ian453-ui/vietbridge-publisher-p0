# V3 slice 03 — durable metric evidence and offline intake

Incremental implementation on the existing V3 branch after e770bfa. Resource
and cleanup follow-up fixes are separately committed as 0926b58.
Source contracts: `src/metric-observation.js`, `handoff/metric-observation.md`,
`src/production-review-store.js`, `src/unified-publisher.js` and existing
`PublisherAccess` authentication. No new platform definitions or permissions.

## Slice 02 final review

Verified committed head e770bfa and its actual 968/968 test result, syntax checks,
ZIP-to-Review screenshot and structured evidence. Original publisher-unified
remains 4455a4b. No unfinished test process or working-tree edit remained.

Residual limits: private single-host cache, trusted local owner (not proof against
same-UID hostile races); conservative leases survive restart; byte parts of one
ZIP only; per-member materialization can re-fetch the same archive; processing
budgets may reject large otherwise valid packages. Real Drive transport, Muse
consumption and live social publication were not part of slice-02 acceptance.
Source references/ZIP success never authorize deletion. No original deletion
interface exists; latest-20 protection and global deletion pause remain.

## Implemented behavior and acceptance

* Freeze task/workspace/account/platform/post/content-revision/publication-job
  bindings independently of observation values. Reject reassignment.
* Persist canonical observations and raw evidence in one transaction. Exact
  duplicates do not create another row. Same-series/time conflicts retain both
  versions and expose null/CONFLICT, with no silent overwrite.
* Preserve null, explicit unavailable reason, original definition/window/timezone
  and separate reach/views series. Latest failure/pending collection suppresses
  stale values; history remains accessible. No automatic totals.
* A bounded injected read-only collector records one attempt, with no scheduler,
  automatic retry or credential setup. Offline/synthetic provenance stays visible;
  an enum/hash is not platform authentication.
* Extend the existing production Review read surface. Existing authentication and
  account scope apply; application-token scopes and all approval/publish gates
  remain unchanged. Test delayed scope switching and real Chromium rendering.
* Offline ZIP and metric import commands accept bounded local files and exact
  manifests, never remote URLs or keys. Real sample bytes remain outside Git.
* Test restart, two-connection duplicate race, conflict, storage corruption,
  transaction failure, wrong scope/identity, latest failure, incompatible windows,
  missing raw bytes and importer path/size rejection.

The parent authorized one existing Study ZIP for read-only consumption testing
after slice 02. Existing Drive connector metadata/raw-reference reads succeeded.
Materializing that authenticated reference into this execution environment was
denied by its network proxy: `Tunnel connection failed: 403 Forbidden`. The
transfer was stopped, without alternate routes or credentials. No sample bytes
reached disk; actual Resolver/browser consumption remains unverified. Exact file
IDs, signed URLs, filenames and user media are excluded from committed evidence.

## Data and trust boundaries

`metric_targets` freezes the full content ID, task, workspace, account, platform,
post, publication job, content revision, actor, business asset, source account,
source object, source reference and source transport. A publication-job ID cannot
be reassigned; a task cannot move to another workspace. Existing production-task
bindings and account platform/known actor/Page mappings are checked. If a local
publisher job exists, its workspace/account/content and snapshot hash must match;
for that case content_revision is the immutable publisher snapshot hash. External
job/post mappings are explicitly caller-declared; no synthetic publication job is
created merely to satisfy metric ingestion.

Registration accepts only `SYNTHETIC` or `OFFLINE_UNVERIFIED` origin. No `LIVE`
origin or authenticated-source stamp is available in this slice. Hash matching,
identity enums and a locally supplied mapping do not authenticate a platform.
Source reference/transport are independently frozen in the target and compared
on every observation; the observation cannot choose its own expected source.

`metric_series` separates exact definitions, versions, units and time windows.
`metric_observations` and `metric_raw_evidence` commit together, with immutable
canonical entries and bounded raw BLOBs. Same-slot conflicts append both versions;
current value becomes null/CONFLICT. Exact repeat delivery is DUPLICATE. Stored
hashes are checked on read and before acknowledging a duplicate. Original pure
in-memory APIs retain their original reject-on-conflict behavior.

`metric_collection_attempts` records RUNNING, RECORDED or FAILED. Explicit single
collection calls use an injected read-only adapter and finite timeout/AbortSignal,
without retries, scheduling, API tokens or remote configuration. Adapter code is
trusted and must itself obey its authorization; `readOnly:true` is an interface
declaration, not a sandbox for arbitrary code. Async timeout cannot interrupt a
blocking synchronous adapter. Failed/pending attempts newer than an observation
return null with their actual reason, including across restart. Running attempts
are not silently replayed or presumed failed; explicit reconciliation is needed.
Errors are stored as bounded reason codes, not arbitrary exception/secret text.

`/api/metric-observations`, `/series/<id>` and `/evidence/<id>` are authenticated,
account-scoped GET routes. Other methods return 405; existing application tokens
gain no scope. Raw evidence downloads as an attachment, never executable HTML.
The existing 制作审核 surface shows provenance, separate values/windows, conflicts,
null reasons and paged history. There are no automatic totals or metric-to-publish
actions. The tested boundary is customer/account data isolation, not separate
tenant login/RBAC. Account switching retains its existing local preference POST.

## No-key offline import

Use an existing, explicitly selected **isolated** unified database with its
customer/account already registered. The CLI does not create credentials,
accounts, production services or authorization. A local administrator selects
the DB and trusted private packet root; no HTTP endpoint accepts these paths.

```sh
node scripts/v3-metric-demo.mjs /tmp/my-new-v3-metric-demo
node scripts/v3-review-local.mjs /tmp/my-new-v3-metric-demo
# Explicit repeat of the generated local packet: returns DUPLICATE receipts.
node scripts/v3-offline-intake.mjs --kind metrics --db /tmp/my-new-v3-metric-demo/publisher-unified.sqlite --root /tmp/my-new-v3-metric-demo

# Authorized local ZIP sample packet, once actually present in this environment:
node scripts/v3-offline-intake.mjs --kind archive --db /absolute/isolated.sqlite --root /absolute/private-packet --cache /absolute/private-hot-cache
```

Metric root contains `offline-metrics.json` (or `--manifest RELATIVE_FILE`) and
raw evidence files. Exact top-level shape:

```json
{"schema_version":1,"kind":"METRIC_OBSERVATIONS","targets":[],"entries":[]}
```

Both arrays must be nonempty, at most 100 each. Each target requires exactly:
`schema_version:1`, `task_id`, `workspace`, `account_id`, `platform`, `object_id`,
`content_id`, `content_revision`, `publication_job_id`, `operator_actor_id`,
`business_asset_id`, `source_account_id`, `source_object_id`, `source_reference`,
`source_transport`, `origin`, `mapping_reference`. All non-version fields are
nonempty strings. Use OFFLINE_UNVERIFIED for user-exported evidence; synthetic
fixture IDs must never stand in for missing real identities. Missing mapping
blocks intake. Each entry is exactly:

```json
{"target_index":0,"observation":{},"evidence_path":"evidence/observation.json","unavailable_reason":null}
```

`observation` is the complete existing [MetricObservation v1](../handoff/metric-observation.md)
contract. Evidence bytes must match its SHA256; AVAILABLE requires integer value
and null reason, all unavailable statuses require null value and a nonempty
reason. JSON manifests are at most 1 MiB; each raw file at most 5 MiB, aggregate
accepted raw evidence at most 10 MiB. The whole metric packet, including target
registration, is transactional. A later entry failure rolls back earlier entries.
The synthetic demo writes a complete valid manifest for inspection/reproduction.

Archive root contains `offline-archive.json`, a valid existing production request,
its archive manifest and local ZIP/byte-part files. Exact minimal wrapper:

```json
{"schema_version":1,"kind":"ARCHIVE_PRODUCTION","request":"request.json","archive_manifest":"archive-manifest.json","parts":[{"file_id":"opaque-authorized-file-id","path":"cold/source.zip"}]}
```

The request must be created/verified by the existing `createProductionRequest`
contract, with an exact existing workspace/account, full source IDs, versions,
owner/thread, deadline and deliverable declarations. The archive manifest is
`{schema_version:1,request_fingerprint,completed_at,items:[{source_id,files:[{artifact_id,archive}]}]}`.
Each archive reference requires schema/type, project/account/full-content binding,
archive file ID/size/SHA256, member path/size/SHA256, kind and ordered parts with
index/file_id/bytes/SHA256, as specified in [slice 02](v3-slice-02.md). For one part,
the part ID/hash equal archive ID/hash. The local part map must match exactly;
missing/extra/duplicate IDs reject. Never replace an unknown ID or full content
identity with a three-digit folder suffix. The original source-approval gate
remains independent and every receipt stays REVIEW_REQUIRED.

Local files must be bounded regular files inside the trusted root. Traversal,
absolute paths, URLs and escapes reject; no remote downloader is included.
Snapshots and hashes protect the bytes consumed, subject to the same trusted
local-owner boundary as slice 02. No cold file is deleted or shared. Release
failures return cleanup_pending alongside the committed receipt; retrying the
same valid packet does not create a second review or publication.

## Remaining work

Real platform metric adapters, authenticated producer/approval transport,
source-inventory semantic/QA-revocation integration, Muse consumption and the
blocked real-sample materialization remain unverified. No credential creation,
permission/security change, real posting/interaction, original deletion, merge
or deployment occurred. No platform API capability is inferred from fixtures.

## Executed results

Executed in this isolated cloud environment on 2026-10-22 UTC. Node 24.19.0,
Python 3.12.14, ffmpeg/ffprobe 7.1.5 and system Chromium. No prior report count is
substituted for these runs. All metrics/new account fixtures are synthetic;
inherited platform execution tests use their existing mock drivers.

```sh
# Archive review corrections: 15/15, zero failed/skipped, 6.477 seconds.
node --test test/archive-asset-resolver.test.js test/archive-production-intake.test.js
# Durable metric, HTTP/UI and offline intake integration: 14/14, 7.363 seconds.
PUBLISHER_TEST_BROWSER_PATH=/usr/bin/chromium V3_METRIC_SCREENSHOT=/tmp/v3-metric-synthetic.png node --test test/metric-observation-store.test.js test/metric-observation-http-ui.test.js test/offline-intake.test.js
# Final complete run after frozen-source binding correction: 984/984, 66.276 seconds.
PUBLISHER_TEST_BROWSER_PATH=/usr/bin/chromium PUBLISHER_TEST_FFMPEG_PATH=/usr/bin/ffmpeg V3_METRIC_SCREENSHOT=/tmp/v3-metric-synthetic.png node --test --test-concurrency=4 test/*.test.js
# Also separately executed: generated demo and explicit offline repeat intake.
node scripts/v3-metric-demo.mjs /tmp/publisher-v3-metric-demo
node scripts/v3-offline-intake.mjs --kind metrics --db /tmp/publisher-v3-metric-demo/publisher-unified.sqlite --root /tmp/publisher-v3-metric-demo
```

Final full run: zero failed/cancelled/skipped. 323 JS/MJS/TS files passed syntax
checks; Python extraction parsed and `git diff --check` passed. Manual offline
repeat produced three DUPLICATE receipts, preserving two series and three raw
observations, with publish_allowed/source_authenticated both false.

| Acceptance | Actual coverage |
| --- | --- |
| Immutable binding | Wrong project/account/platform/post/job/revision/source and known account actor rejected; task cannot move workspace |
| Durable observations | Restart, immutable raw bytes, repeat receipt, same-time conflict retained with null current value |
| Atomicity/concurrency | Raw-BLOB insertion fault rolls back observation/series; two Node/SQLite processes leave one row/raw BLOB |
| Metric semantics | Null reason, genuine zero, independent reach/views/definition versions/windows; as-of history and explicit pagination |
| Collector failure | Thrown/timeout/invalid result persisted; one read only; newer failure/pending suppresses old value across restart; explicit later success restores availability |
| Read surface | Existing authentication, cross-account denial, no write endpoints or added app-token scopes, raw attachment response |
| Real Chromium | Synthetic provenance and null shown; history retained; delayed old-account/customer responses cannot fill new scope; no external requests/page errors |
| Offline intake | Local metric/ZIP CLI, exact duplicate, bad evidence causes whole metric-packet rollback, traversal/size/symlink escape rejected, original cold parts retained |

Initial UI integration run was 4/5: the test mistakenly forbade the two inherited
account-selection preference POSTs. It now asserts those exact local endpoints
and denies any other mutation, without changing application behavior. Self-review
also caught expected source reference/transport being derived from the incoming
observation; both are now frozen independently in target registration and the
final full run includes source substitution rejection.

[Synthetic Review screenshot](evidence/v3-metric-review-synthetic.png) and
[structured evidence](evidence/v3-slice-03-evidence.json) are committed. Local full
log `/tmp/v3-slice03-full.log` SHA256:
`c55050411d3436464141dadd8b38206cb7570ddaf8d1a2288e31a117ec4d5ca0`.
The evidence JSON records other environment-local log hashes. The authorized
real-sample transport denial above is not counted as successful media acceptance.

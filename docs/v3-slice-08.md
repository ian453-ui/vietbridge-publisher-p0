# V3 slice 08 — asynchronous Review, objects and metric evidence

Base `9c5fd5486b9617553adc4988aeb98c75f0cf05fa`, same V3 branch and existing
owner-private Site `appgprj_6ad97a034fd08191a8399eeda10f048c`. This increment moves
actual evidence persistence and readback into the portable Sites application.
It does not provision D1/R2, authenticate a producer, or enable publication.

## Supported workflow recheck

Using the complete package
`skill://plugin_connector_1p_689987207de08191979cf68eca2941c6/sites` successfully
read the main skill, troubleshooting, storage, identity and portable-preview
references in this turn. The current alias is `c10`; `c6` is another plugin.
The prior `skill package is not available` read error is historical. After these
successful reads, a later tool-catalog update again reported no cloud skills. No
helper recovery followed; catalog availability and actual executable files are
recorded separately.

The supported execution files remain absent. Checked `/opt/codex`,
`/workspace/.agents`, `/workspace/.codex`, and `/workspace/sites` for
`project-setup.mjs`, `site-workflow.mjs`, `build-site.mjs`,
`install-dependencies.mjs` and `chatgpt-auth.ts`: no matches. The installed
`/opt/codex/runtimes/codex-primary-runtime/plugins/openai-primary-runtime/plugins`
contains only documents, pdf, presentations, spreadsheets and template-creator.
An initial broader `/opt` enumeration encountered a read denial at `/opt/containerd`;
that directory was not opened or retried and is not a supported Sites plugin path.
No additional permissions were sought.

Resource reads for each of these exact paths returned `failed to read skill resource`:

- `skill://plugin_connector_1p_689987207de08191979cf68eca2941c6/scripts/project-setup.mjs`
- `skill://plugin_connector_1p_689987207de08191979cf68eca2941c6/sites/scripts/project-setup.mjs`
- `skill://plugin_connector_1p_689987207de08191979cf68eca2941c6/sites/templates/vinext-starter/app/chatgpt-auth.ts`

[The current skill](skill://plugin_connector_1p_689987207de08191979cf68eca2941c6/sites/SKILL.md)
requires the supplied Vinext starter for server behavior and says: “Preserve the
starter's `sites()` build integration.” Its source helper owns build, commit/push
and packaging. These missing components are not replaced with guessed credentials,
identity headers or deployment metadata. No Site recreation, source push or deploy
was attempted. The independent storage implementation continued below.

## Reuse and interfaces

- `metric-observation-core.js` extracts the original pure field validation and
  canonical record ordering. The original Node validator wraps it with the same
  Buffer restriction and SHA256/observation IDs; the async store uses WebCrypto.
  No new metric definition, aggregation or authentication is inferred.
- `AsyncMetricStore` ports target, series, raw observation, collection generation,
  failure, as-of snapshot and paginated history persistence to D1-shaped async SQL.
  It uses the original ledger table names and exact observation/series identities.
- `AsyncReviewStore` stores the existing production request/result/inspection
  envelope, immutable asset references and revision history. It consumes snapshots
  from a **server-injected** `readInspection(reference)` provider. The only provider
  implemented here is a test fixture calling the original image/video inspection
  code. There is no real transport, provider registration or HTTP import endpoint.
- `ScopedObjectStore` persists exact object intents, writes through R2-shaped
  `put/get`, checks actual returned bytes and records readiness. No signed public
  URL, archive URL substitution, original deletion or garbage-collection job exists.
- Existing `cloud-authoring-api.js` and console now connect these stores to the
  original customer/account selection and Review/metric destinations. They do not
  introduce another application or a client-side sample-data store.

SQL uses one statement per prepare and transactional batch, consistent with the
[official D1 interface](https://developers.cloudflare.com/d1/worker-api/d1-database/).
Object calls use the documented body stream, put checksum and readback shape from
[the R2 Worker interface](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/).
The candidate migration is unapplied; official Drizzle generation/metadata and
actual hosted runtime limits still require the restored starter.

## Review and object recovery protocol

`intake({workspace,accountId,task_id,request_revision})` requires an explicit trusted
server provider and bucket. Without either, it stops. Input from a browser cannot
supply a decoded report, authenticated flag or provider identity. Before object
writes, it checks the whole batch: exact scope/task/request/result fingerprints,
review state, every artifact identity/hash/size and native decode receipt. Native
`VIDEO_DECODED` is a receipt from the cloud processor, not ffmpeg running in Workers
or proof of producer identity. Result bytes are hashed again before persistence.

Project/account/task identity cannot be overwritten. A task's original owner,
producer and bridge reference are bound by a persisted identity hash. Same request
revision with changed result/envelope conflicts; a newer revision never edits old
objects. Superseded Review versions remain readable and explicitly marked.

1. Persist a scoped STAGED intent before attempting an object put. The deterministic
   key binds workspace/account/review/source/artifact/hash/size/MIME.
2. Read the exact key. If present, verify bytes instead of rewriting it. If missing,
   put exactly those bytes with checksum metadata and read them back.
3. Only successful bounded readback/hash verification may mark the object READY.
   READY describes stored bytes, never content approval or publication readiness.
4. Commit Review envelope and all asset references in a single guarded SQL batch.
   A later reference insertion failure rolls back the receipt and earlier links.
   Already written immutable objects remain available for reconciliation. A committed
SQL receipt followed by a lost acknowledgement is found as the same duplicate
on the next explicit intake, with no second receipt or object put.
5. After interruption, inspect `recoveryPlan()` and verify the saved ID. Put success
   followed by transport failure is an uncertain write, not permission to delete.
   Missing object stays unready; transient read failure/timeout does not mark
   correct bytes CORRUPT. A positively verified size/hash mismatch does.

Recovery plans are scoped and report truncation after 100 records. They never
remove objects, originals or active leases. There is no TTL-based lease takeover,
background repair, automatic clearing of CORRUPT, or invented cross-system atomic
transaction. The no-delete protocol avoids deleting an object another writer has
successfully referenced. Full retention/latest-20 rules remain in the PRD; no
original-media cleanup is part of this store.

Current application bounds: 32 artifacts, 32 MiB per Review, 16 MiB per object,
256 KiB metadata, five-second object operation deadline within a 30-second intake
budget. These are conservative application bounds, not proof of every hosted
CPU/query/subrequest quota. D1 round trips and trusted provider CPU are not an OS
sandbox; actual runtime limits need hosted validation and potentially staged
request scheduling. Uncooperative provider work is not forcibly killed.

## Metrics persistence and as-of behavior

Targets bind existing frozen job, content/snapshot, workspace/account/platform,
post and explicit source identity. Unknown job mappings are refused in this port.
Mappings remain caller-declared; they are not independent real publication proof.
Raw observation records retain origin, source, definition/version, exact window,
null availability and reason. Cloud raw evidence is bounded to 256 KiB per record;
large export/R2 metric evidence is not implemented. Reach/views and different
windows remain separate, with no automatic aggregation.

A guarded batch stores observation + raw bytes + collection link/state atomically.
Begin-collection allocates generation inside the SQL batch; two connections cannot
choose the same generation. Completion never changes the original generation.
Snapshots normalize state at `asOf` before applying generation ordering, preserve
latest failures/pending as null, and exclude older collector generations even when
they return late. Raw conflicts remain in history. An additional native regression reproduced a same-timestamp older-generation
selection defect: expected 200, actual null. Both implementations now apply the
eligible collector-generation predicate to timestamp selection and selected rows.
Both observations remain in history; an older late collection cannot contaminate
the newer generation merely by sharing its observation timestamp.

`sites_write_assertions` enforces preconditions inside the same SQL batch through
CHECK constraints and is emptied before successful commit. It is not request-time
DDL or a replacement for access checks. All request routes first verify the trusted
Site user, customer ownership and active account membership. Storage classes are
privileged server interfaces, not public authorization providers.

## Read routes and UI

All added routes are GET-only under
`/api/sites/workspaces/:workspace`, with required `accountId`:

| Route suffix | Result |
| --- | --- |
| `/reviews` | 20-entry scoped page; explicit next cursor |
| `/reviews/:id` | Original report, exact asset identities and unavailable approval transport |
| `/reviews/:id/assets/:source/:artifact` | Rehashed scoped bytes; private/no-store, nosniff; no public object key |
| `/metrics` | 20 series snapshots, as-of and next cursor |
| `/metrics/:id` | Exact series snapshot |
| `/metrics/:id/history` | Raw observation history, 20 entries/page |

The existing console now reads Review snapshots, images, video and complete text;
metrics show source origin, null/failure, definition and window plus history.
Current UI displays the first page; API pagination is implemented. Late old-scope
responses remain guarded by the existing generation check. No approve/import/
collect/publish/reconcile route was added. `publish_allowed:false`, unverified
source flags and `can_decide:false` remain explicit. Native approval/source/audit
logic is retained; its async authenticated decision transport is still work to do.

## Executed acceptance

Commands, actual log hashes, failures and screenshots are recorded in
[evidence](evidence/v3-slice-08-evidence.json). All inputs are synthetic. Database
coverage uses real file SQLite with an async D1-shaped interface; object coverage
uses a file-backed R2-method fixture. Neither is actual hosted D1/R2 acceptance.

```sh
PUBLISHER_TEST_BROWSER_PATH=/usr/bin/chromium \
PUBLISHER_TEST_FFMPEG_PATH=/usr/bin/ffmpeg \
V3_SITES_EVIDENCE_DIR=/tmp/v3-sites-storage-evidence \
node --test --test-concurrency=2 test/sites-async-*.test.js \
  test/sites-evidence-api.test.js test/sites-cloud-console-ui.test.js \
  test/metric-observation.test.js

PUBLISHER_TEST_BROWSER_PATH=/usr/bin/chromium \
PUBLISHER_TEST_FFMPEG_PATH=/usr/bin/ffmpeg \
V3_SITES_EVIDENCE_DIR=/tmp/v3-sites-storage-evidence \
node --test --test-concurrency=4 test/*.test.js
```

The first metric run exposed Node Buffer slicing retaining extra backing-buffer
bytes. Exact Uint8Array copying corrected the BLOB; hash/restart regressions pass.
A concurrency test initially assumed Promise array order was database generation
order; it now reads the actual committed order. First browser evidence assertions
ran before the asynchronous history dialog opened; the test now awaits that UI.
No gate was relaxed to make these checks pass.

Final complete regression: **1059/1059 passed**, fail/cancel/skip 0, 107.165 seconds.
The earlier full pass was 1056/1056 before the newly reproduced metric fix; final
1059 includes that fix and the additional SQL-commit acknowledgement failure test.
Final targeted acceptance was **46/46**, including original metric HTTP/UI and
new browser journeys. Syntax: **16 changed JS files passed**. The server module
graph has eight local modules and no Node import. No earlier 934/999/1042 count
is reused as this package's evidence.

| Acceptance | Evidence | Result |
| --- | --- | --- |
| Native canonical observation IDs and validation | Shared core; native/async ledger read parity | Passed synthetic |
| Exact job/task/project/account scope | Mapping and API denial, revoked membership, forged identity | Passed synthetic |
| Raw receipt/BLOB rollback and restart | Injected write failure, file DB reopen, hash verification | Passed synthetic |
| A/B as-of timeline and same-time old generation | Exact original counterexample and new reproduced failure | Passed after minimal native selection fix |
| Object commit before SQL, timeout, real corruption | File object fault/reopen and scoped recovery plan | Passed; no automatic deletion |
| Second reference failure, commit acknowledgement lost | Receipt/reference rollback or duplicate reconciliation | Passed; no second receipt/object put |
| Two connections and immutable revisions | Concurrent ingest, conflicting result, superseded view | Passed synthetic |
| Desktop/mobile decoded media and null metrics | Native ffmpeg/Pillow fixtures, browser playback, full text, history, reload | Passed; zero outside browser requests |
| Actual hosted identity/D1/R2/deployment | Official execution helpers absent | Not attempted/unverified |

Screenshots (all synthetic):
[desktop Review](evidence/v3-slice-08/desktop-review.png),
[mobile Review](evidence/v3-slice-08/mobile-review.png),
[desktop video](evidence/v3-slice-08/desktop-video.png),
[mobile video](evidence/v3-slice-08/mobile-video.png),
[desktop metrics](evidence/v3-slice-08/desktop-metrics.png),
[mobile metrics](evidence/v3-slice-08/mobile-metrics.png).

## Remaining concrete implementation

Restore official starter/helpers and use the existing project ID; connect official
server identity, generated D1 schema and R2 bindings; build/private-deploy and test
real persistence. Then add authenticated heavy-service/source transport and async
approval/revocation decisions and Review-to-content/platform/task preparation
using the already implemented native evidence gates.
Live metric collectors, operations permissions, group/DM/human takeover and
metrics-to-production iteration remain separate code/integration work. No Mac
fallback, real-platform action, new persistent credential or denied-download retry
was performed.

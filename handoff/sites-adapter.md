# Sites adapter boundary — local-only, not deployed

Baseline: 126af7cf371c0fd825ca06a45435beec9f1d77c5 on publisher-unified.
The existing Node/SQLite entry, schema, UI, guards and dependencies are unchanged.
No Site, project, credential, D1/R2 resource, migration or deployment is created.

## Executable minimum

`src/sites/readonly-api.js` is a dependency-free Worker-compatible module factory,
not a production Worker entry. It reads the existing publisher_jobs,
facebook_accounts and publisher_content_sources tables through async D1-shaped
prepare/bind/all. It preserves existing IDs, hashes, state and attempt IDs, scopes
both workspace and account in SQL, and supplies the existing jobs API envelope
with execution disabled. The source-ledger view includes only sources referenced
by jobs for that account; it is not the entire workspace content catalogue.

Synthetic loop: original Store/UnifiedPublisher imports the same source twice →
one original ledger record → creates frozen job → fixture marks it UNKNOWN →
async API reads job and source ledger twice → unchanged state/attempt and no writes.
The fixture's UNKNOWN assignment is test setup, not an exposed transition.
Tests use actual original SQLite schema through a D1-shaped async facade. They
prove query and boundary behavior, NOT hosted D1 compatibility, latency, concurrency,
backup durability, platform authentication or cross-device availability.

Wire only after the parent identifies the existing/private Site and verifies its
access policy. Factory requires explicit canonical origin, D1 binding, and a
server-only resolveScope(request) callback returning trusted userId, workspace,
accountIds after identity AND membership verification. Missing binding fails 503,
missing identity 401, wrong workspace/account 403, wrong origin 409. Do not implement
membership from browser-supplied headers, account IDs or email alone. No default
identity parser is provided because this checkout has no verified Sites identity
integration. Service access alone does not establish a user or workspace scope.

Every non-GET fails 405 before storage. There is no approval, import, claim, cancel,
result ingestion, UNKNOWN reconciliation, quota reservation, permit issuance or
consumption. Existing quota/permit tables cannot be modified by this adapter.
No raw snapshot/evidence blobs, profile paths or credential references are returned.
Results are no-store and errors do not leak database details. This is a reduced
read projection, not a drop-in replacement for the full existing UI state API.
No second UI is created; integrating the current UI requires scoped state loading
and disabling/hiding unsupported controls after the actual identity boundary exists.

## Precise incompatibilities and next acceptance gates

| Original component | Why not portable unchanged | Required next work |
| --- | --- | --- |
| Store.tx / UnifiedExecutor.claim | BEGIN IMMEDIATE plus synchronous JS branches between reads, guards and writes; native isTransaction | Design D1 conditional SQL/batch transaction with checked outcomes, concurrency/rollback tests for claim + permit + quota together; no async callback substitution |
| SingleExecutionPermits | Native transaction evidence and managed Store transaction required | Keep unavailable; never fake isTransaction or rely on a process-local flag across Worker isolates |
| Store/UnifiedPublisher constructors | Request-time CREATE/ALTER, PRAGMA inspection and synchronous getters | Reviewed schema-only migrations and async repository extraction; do not mechanically run constructors in requests |
| Source revision ledger | Original unique key and conflicting payload semantics | Atomic conditional insert plus conflict hash readback tested under concurrency before enabling imports |
| BrowserResources / drivers | Filesystem locks, local browser process, CDP and local session paths | Remain unsupported; do not advertise publishing capability or copy Mac session |
| Image/video production validation | fs, Pillow/ffmpeg child processes, realpath/inode checks | Explicit R2 object hash/version semantics and separate decoder path before accepting artifacts; metadata-only validation cannot substitute |
| Authentication / UI | Node parent provides Host/auth/Origin/CSRF; UI expects wider state routes | Verified Sites identity + workspace membership and readonly UI integration; no write route until CSRF and authorization contract is accepted |
| D1 + R2 result intake | No shared atomic transaction across object upload and SQL ledger | Immutable object references, conditional ledger transition and orphan/retry protocol required; currently no uploads |

Sites storage guidance requires one statement per prepare and batch for multiple
statements, and schema migration outside handlers. A batch is not evidence that
the current read/check/write JavaScript transaction can be ported without redesign.
This package deliberately issues one SELECT per request and makes no transactional
write claim. It also does not claim snapshot consistency across separate jobs and
ledger requests. UNKNOWN and duplicate constraints remain original data, never
inferred safe to reset due to missing runtime support.

Minimum next deployment decision belongs to parent: confirmed private Site identity,
existing source integration, actual identity/membership mapping and an isolated
synthetic D1 binding/schema. Then test this API on the real Worker/D1 path before
any UI or production data integration. Do not copy a real DB or provision new
credentials merely to complete the local test. R2 is not needed for this slice.

## Hosting provenance and publication handoff

Parent verified the current production topology on Mac: publisher.vietbridge.one
routes through the remotely managed Tunnel to localhost:17882; public/local SHA
672dd974. Stopping the Mac stops that origin and Tunnel. This is parent-supplied
read-only evidence, not a fresh network probe from this environment.

Native Sites list lookup in this turn returned only the unrelated public OpenSky
travel site (appgprj_6ac8fba756b88191b2b75122e8212d48), no Publisher project. Do not
reuse or alter its audience. No Publisher registration was attempted. Native Sites
tools are exposed, but the required project-setup/site-workflow helpers and hosting
manifest were not found in the inspected /workspace and /opt trees. Cloud skill
availability was removed after reading the storage/identity references. Therefore
this environment has not completed the supported Sites build/source packaging
workflow; tool presence alone is not a tested deploy pipeline.

The parent can carry this same source slice into its supported Sites workflow,
select/create one owner-private Publisher Site, preserve the project identity,
provide trusted identity/membership binding, review isolated synthetic schema
migrations and test real D1 before publishing. This package alone is not a complete
hosted console, migrated business application or multi-day service guarantee.

Validation: five focused adapter tests pass. Full local regression uses the
existing npm test command with installed Chromium and ffmpeg selected explicitly;
logs are /tmp/sites-adapter-targeted.log and /tmp/sites-adapter-full.log. No new
package dependency, local entry modification or underlying harness change.

## Offline preparation: schema and membership contract

`src/sites/migrations/0001_readonly_projection.sql` is a reviewed candidate SQL
migration for a NEW isolated read-projection database. It contains four tables:
the three original-named read projections plus sites_project_memberships. It does
not reproduce the complete local schema or claim local constructors can run on it.
No credentials, sessions, quota/permit tables or content/media blobs are copied.
Original source revision and frozen-job unique keys and all original job states
are retained. Composite foreign keys prevent a membership/job from pairing an
account with another workspace. It has no seed/backfill, no IF NOT EXISTS masking
schema collision, and must never be applied to the local production database.

This SQL is NOT yet a Drizzle-generated, registered or deployed Sites migration.
When official tooling becomes available, express the four-table projection in its
schema, run the official generator, compare generated SQL constraints against this
candidate, then register/apply via the supported workflow to isolated synthetic D1.
Record applied migration identity; never replay or edit an applied migration.

`createSitesScopeResolver` binds the existing read API to persisted READER membership
for exact trusted user ID + workspace + account. The binding is dedicated to one
Site/project; do not share membership data across Sites or infer identity equivalence
from matching email. Its getTrustedIdentity callback
must be implemented with the official server-only Sites identity helper behind
verified dispatch, never direct browser input. Email is not an authorization key.
A private Site does not automatically insert members, nor does its first visitor
become owner. No registration/grant endpoint exists. Membership provisioning is
pending operator-reviewed mapping after the actual Site identity is known; all
current tests use synthetic identities only. Missing trusted integration refuses
construction; missing user returns 401; absent/revoked membership, scope mismatch
or membership-store failure returns 403. Storage details are not exposed.
Membership is queried on every request, not cached; a revocation concurrent with
an already authorized in-flight read is not claimed to cancel that response.

Tests use an async D1-shaped facade over actual SQLite: cross-workspace/account
reads, forged identity headers and member query parameters, revoked membership,
foreign key and READER role checks, paging limits, denied writes, duplicate and
conflicting source keys/job keys, and file-backed reopen preserving UNKNOWN and
attempt ID. Native original-model duplicate-import idempotence remains covered by
sites-readonly-api.test.js. SQL uniqueness rejecting a duplicate is not itself a
D1 idempotent importer: no cloud importer or concurrent write protocol is enabled.
No quota consumption or permit writes are possible through this slice. These tests
do not validate real D1, Worker auth header injection, deployment or browser execution.

Offline follow-up acceptance: focused Sites adapter/membership suite 10/10;
full original local regression 933/933 with zero failures/skips. Evidence:
/tmp/sites-membership-targeted.log and /tmp/sites-membership-full.log. No network
download retry, Sites resource provisioning, production DB access, Mac changes,
credentials or social publication occurred in this follow-up.

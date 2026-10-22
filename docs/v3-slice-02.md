# V3 slice 02 — ZIP materialization and review-budget corrections

Incremental work on `publisher-v3/cloud-slice-01`, after `1c5682d`; no new system,
production service, credential, permission or Drive sharing change.

## Actual usable path

```sh
node scripts/v3-archive-demo.mjs /tmp/my-new-v3-archive-demo
node scripts/v3-review-local.mjs /tmp/my-new-v3-archive-demo
```

The first command produces a real synthetic ZIP split into three ordered byte
parts, an exact `archive-manifest.json`, the original loose-file reference case,
and ten extracted/validated attachments in the existing pending Review ledger.
The second prints a loopback URL. Select **Synthetic V3 customer → 制作审核 →
SYNTHETIC-ARCHIVE-PRODUCTION**. Articles/platform copy, images, script/SRT and video
use the existing Review surface. Both loose and archived source cases remain
REVIEW_REQUIRED, with no publishing/import authority and no publication jobs.

`ingestArchiveProduction` validates the manifest/request fingerprint, all source
IDs, artifact IDs, workspace/account bindings, declared member sizes and batch
budgets before transport. It resolves each exact member and supplies actual local
media to the original package/inspection/Review path. It never supplies a ZIP URL
to a platform. A stable manifest completion timestamp makes repeat delivery
idempotent without refreshing the original deadline. Staging copies are removed
after intake; retained review bytes are evidence snapshots, separate from the
evictable hot cache. No cold or original file is deleted.

## Sources and implementation scope

Uses the installed Python standard library; no third-party archive package or
copied project code. [Python zipfile documentation](https://docs.python.org/3/library/zipfile.html)
describes ZIP/CRC behavior and explicitly excludes native multipart ZIP support.
This slice supports ordered, hash-bound **byte parts of one ordinary ZIP**; native
multi-disk ZIP, encryption, unsupported compression and recursive archive
extraction are rejected. [Python resource documentation](https://docs.python.org/3/library/resource.html)
informs the separate extraction process CPU/address-space/output limits.
The runtime tested here is Python 3.12; no 3.15-only ZIP feature is used.

Transport is injected as an already authorized byte/stream supplier receiving
opaque file ID, exact expected scope, AbortSignal and maximum bytes. The demo's
transport reads only its synthetic files. There is no real Drive transport,
credential acquisition, network retry or source mutation in this package.
The caller must establish authorization; matching IDs are not authentication.

## ZIP, cache and reference rules

* Exact ordered part indexes, unique part IDs, per-part length/SHA256, assembled
  length/SHA256 and selected-member length/SHA256 must match. Partial transfers
  have no READY entry. Empty/oversized streams and transfer timeout reject.
* Inspect every central-directory name before extraction: absolute paths, drive
  paths, backslashes, traversal, NUL, non-NFC names, duplicate normalized members,
  symlinks/special files and nested archive extensions reject. The selected member
  is streamed to a generated filename in a private staging directory, never to a
  ZIP-controlled path. Selected-member CRC is checked; this is not a claim that
  all unselected members were decoded or semantically inspected.
* Limits: 128 MiB compressed archive, 32 parts, 1,000 ZIP entries, 100 MiB per ZIP
  member, 256 MiB declared expanded archive total, 100:1 expansion ratio, 5 CPU
  seconds/512 MiB address space/8-second subprocess timeout for extraction. Media
  kinds additionally retain their original text/image/video byte and decode caps.
* Cache identity contains project, account, full content ID, archive/member and
  hashes. SQLite coordinates BUILDING/READY/CORRUPT state and durable leases.
  Parallel claims return CACHE_BUSY without another transfer. Capacity reserves
  at most 128 entries, 256 MiB hot members and 256 MiB compressed staging.
* Leases protect active materialization/upload use even after cache TTL. Explicit
  scoped release is required. Expired unleased hot entries may be swept; cold
  originals never are. A dead local process's unfinished BUILDING row is marked
  INTERRUPTED and its staging cleaned by an explicit sweep. Existing issued
  leases are conservatively retained across restart until reconciled/released.
* A source reference may be registered from actual verified loose bytes, migrated
  to a matching leased archive member with expected-revision checking, and rolled
  back by appending a history revision. Old references/bytes remain. Every result
  says `delete_original_allowed:false`.

Cache operation assumes a private, trusted-owner, single-host local directory.
Generated staging filenames, exclusive creation, no-follow opens, descriptor
reads and hash checks reduce path hazards; static realpath checks are **not** a
proof against an arbitrary concurrent hostile writer with the same filesystem
privileges. Shared multi-host caches and malicious local owner races are outside
this slice. No claim of tenant-specific login/RBAC is made: tested isolation is
customer/account data isolation under the existing app authentication boundary.

## First-package review corrections

The reviewer's budget finding was valid: the old intake first inspected every
file, then accumulated bytes and decoded them again. Now every batch preflights
all file descriptors/counts/sizes before reading or launching media tools. Limits
are 100 artifacts, eight videos, 128 MiB total and a shared 30-second processing
budget. Reads use bounded buffers from the preflight sizes; all hashes are checked
before decoder work. The exact validated snapshots are inserted into SQLite,
without reopening/redecoding them during that intake. A distinct later packaging
or intake operation still independently revalidates its own trust boundary.

Media subprocess timeouts use SIGKILL, including the image process. Tests use an
actual SIGTERM-ignoring process, excess output and abnormal exit. The deadline is
propagated across probe/decode and checked between local I/O operations; it is not
a claim that a blocked kernel/filesystem call can always be interrupted in-process.

A SQLite trigger aborting the **second BLOB insertion** proves the already
inserted receipt and first BLOB roll back together. Two separate Node/SQLite
processes released from a common barrier produce exactly one REVIEW_REQUIRED and
one DUPLICATE, one receipt and one BLOB set. UI tests delay the old account's list
and old customer's detail, then switch accounts/customers before returning them;
stale content cannot fill the newly selected scope. Existing Tabs are retained;
Tab visibility alone is not manual acceptance of every inherited business flow.

## Retention policy — no deletion implementation

`archiveRetentionPlan` is pure planning with a non-disableable permanent-deletion
pause. It protects the newest 20 original media files per project/library, all
cutoff ties, and whole libraries with uncertain timestamps. New ZIPs, ledger
updates and another project's files cannot displace that protected set. Image/text
media stay retained. Only older videos whose declared frozen targets all have
matching latest PUBLISHED/live-readback evidence enter a technical review list;
UNKNOWN, missing, submit-click, synthetic-test, wrong-account/revision and newer
failed observations block them. The helper does **not authenticate** supplied
evidence, and its synthetic test records are not actual platform observations.
Actual deletion candidates remain empty; exact batch confirmation and real
Publisher/Muse consumer acceptance are still absent. Real consumer capability
is explicitly LIVE_UNVERIFIED.

## Executed evidence

Executed on 2026-10-22 UTC in this isolated cloud worktree, with Node 24.19.0,
Python 3.12.14, ffmpeg/ffprobe 7.1.5 and system Chromium. All new accounts, ZIPs,
content and evidence records are synthetic; existing platform tests use their
mock drivers. None is real platform publication/readback acceptance.

```sh
# Final complete run: 968/968, zero failed/cancelled/skipped, 62.479 seconds.
PUBLISHER_TEST_BROWSER_PATH=/usr/bin/chromium PUBLISHER_TEST_FFMPEG_PATH=/usr/bin/ffmpeg node --test --test-concurrency=4 test/*.test.js
# Executed local demo, ten archived attachments and original loose case retained.
node scripts/v3-archive-demo.mjs /tmp/publisher-v3-archive-demo
```

314 tracked/new JS/MJS/TS files passed `node --check`; Python extraction passed
`ast.parse`; `git diff --check` passed. The final complete run includes:

| Acceptance | Executed test file / cases |
| --- | --- |
| Whole-batch preflight, one probe/decode per intake, kill timeout, output overflow, abnormal exit | `production-resource-limits.test.js` / 4 |
| Durable review, identity protection, second-BLOB rollback, two-process duplicate race | `production-review.test.js` / 6 |
| Browser playback, retained Tabs, delayed account/customer responses | `production-review-ui.test.js` / 2 |
| Real parts/ZIP/media, hash/path/bomb/CRC/size rejection, cache lease/capacity/restart, dead build, migration rollback | `archive-asset-resolver.test.js` / 11 |
| Actual ZIP-to-review path, repeat intake, pre-transport manifest rejection | `archive-production-intake.test.js` / 2 |
| Per-library latest 20, all-target video evidence, newer failure priority, image retention, deletion pause | `archive-retention-plan.test.js` / 5 |

A separate loopback Chromium run opened the actual archived demo receipt and
played its extracted video to the end: ten archived members, no page errors,
no external requests, `publish_allowed:false`. [Screenshot](evidence/v3-archive-review-synthetic.png)
and [structured execution evidence](evidence/v3-slice-02-evidence.json) are committed.
Full-run log `/tmp/v3-slice02-accepted-full.log` SHA256:
`6d19e32d38b68cf34634bbdf91f945360d9877d21dd0388233fa10d6dd14f80f`.
The evidence JSON records other local log hashes; those `/tmp` files are
environment-local logs, not claims of external hosted artifacts.

Initial development caught a synthetic fixture reusing an XHS connection across
two customers; the inherited identity guard correctly rejected it. The fixture
now uses distinct synthetic inactive endpoints and explicitly selects its default
account. No guard was relaxed and no endpoint was contacted.

Remaining work at e770bfa (metric storage/offline intake subsequently implemented
in [slice 03](v3-slice-03.md)): real authorized Drive byte transport and actual
Publisher/Muse consumption acceptance, source-inventory semantic identity/QA
revocation integration, durable MetricObservation collector/ledger, and
authenticated producer/approval transport. No deployment, merge, real publishing,
interaction, source migration or deletion has been performed.

## Follow-up review fixes (start of slice 03)

The second review found two reproducible failure paths. A cached validation
timeout used to mark intact bytes CORRUPT until expiry/sweep; now only affirmative
hash/structure/path damage marks corruption. Budget/tool failures release the new
lease and leave cached bytes available for full revalidation. No validation is
skipped on the next resolve.

An exception from the first lease release used to skip later releases and mask a
committed review receipt. Intake now attempts every release, reports scoped
`cleanup_pending` with `cleanup_status:RECONCILE_PENDING`, and preserves the actual
REVIEW_REQUIRED/DUPLICATE receipt. Primary intake failure stays a failure with
cleanup details attached. Cleanup pending never creates another publish attempt.

Executed `node --test test/archive-asset-resolver.test.js test/archive-production-intake.test.js`:
15/15 passed, 6.477 seconds. Fault injection covers transient cache validation,
first/second release failure, all ten releases attempted, persisted receipt/BLOBs,
repeat intake DUPLICATE and zero publication jobs. This is additional synthetic
evidence; it does not replace or relabel the historical 968-test slice-02 run.

Lease reconciliation after a crash must not assume TTL means the holder is dead.
The rename-before-SQL-commit crash window still relies on BUILDING/dead-owner
sweep; finer crash-point injection remains follow-up work. Repeated archive
fetches for multiple members are conservatively budgeted and may be optimized
later without changing authority or validation semantics.

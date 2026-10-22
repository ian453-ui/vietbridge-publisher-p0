# Publisher V3 — PRD / architecture / acceptance plan

Current correction: [dispatch withdrawal repair](v3-dispatch-approval-repair.md)
closes the reproduced rejection/source-QA race between intent and actual dispatch;
readback of already committed results remains available.

Latest package: [slice 12](v3-slice-12.md) adds the original PAGE permit/limit
contract to the asynchronous claim, UNKNOWN occupancy and readback settlement
transactions. Real authority/provider custody remains disabled and unverified.
[Slice 11](v3-slice-11.md) repairs committed-outcome acknowledgement
loss and exact readback binding in the existing async prepared-job path.
[Slice 10](v3-slice-10.md) connects canonical source identity,
versions, exact body/media and ZIP references to the existing persistent Review,
with source-change invalidation and explicit crash reconciliation. Native loose
body sync now enforces its declared SHA256. The [whole-product matrix](v3-sites-acceptance.md)
is current; the formal Sites delivery and real-provider gaps remain explicit.
The follow-up [client QA repair](v3-client-qa-repair.md) also fixes a reproduced
withdrawal bypass in both retained native client catalogue paths.
Historical test counts below are not this package's execution evidence.

Baseline checked against GitHub on 2026-10-21 UTC: `publisher-unified` =
`4455a4b1faf40fedcd7020636999e165fa4a1386`. Development branch:
`publisher-v3/cloud-slice-01`, new worktree `/workspace/publisher-v3`.
The supplied V1 worktree (`fe9b7ad`) and Social Operator V2 (`85e987a`) were
clean and remain untouched. No repository/ancestor AGENTS.md was present.
GitHub returned no open issues/PRs for Publisher during this check. Original
handoff documents and their historical counts are evidence of prior work only.

## Product and release boundary

**Formal delivery target (user direction 2026-10-22 02:17:41 UTC): ChatGPT Sites
UI plus cloud services, independent of the Mac.** Native Node/SQLite/decoder tests
are development evidence, not formal hosted delivery. Preserve the old Mac/V1/V2
installations. [Sites target, current official evidence, missing code and workflow
blocker](v3-sites-target.md) separates the portable API from native heavy processing.
Do not port native transactions/ffmpeg by assumption or ship a static shell as V3.

One workspace/account context, multiple tasks, existing Tabs, complete content
reading/previews and per-platform publishing paths must survive. V3 incrementally
extends the unified baseline; it does not replace V1/V2 with an empty dashboard.
The lifecycle is brief → production → asset intake → review → frozen publication
intent → authorized submission → independent readback → scoped interactions →
metric observations → next revision. Local/cloud development works with the Mac
off. Live browser operations still require their original executor, independent
account authorization, identity evidence and quota. There is no feature-parity
promise across platforms.

Slice 01: real video validation, durable production inspection receipts and a
scoped read-only Review surface in the existing application. A valid video stays
REVIEW_REQUIRED. Human visual/audio/subtitle/claim review and existing source
approval remain separate. No new publication authority or synthetic-to-live
conversion is introduced. Persist before showing success; a process restart must
retain the exact scope, revision, hash and pending state.

Slice 04 adds a separate content-decision ledger and explicit administrator UI
flow, verified only with synthetic producer fixtures. Real producer identity is
not authenticated by the existing contract, so real-source approval remains
disabled. No content decision satisfies original-library approval or publication
authorization. Version/hash/account/target changes invalidate earlier decisions;
see [implemented boundary and executed acceptance](v3-slice-04.md).

Slice 06 adds server-injected source identity/request/result verification,
append-only approval/revocation evidence and exact human-decision links. Only a
test fixture implements a provider; real producer authentication stays disabled.
Existing publication permit/scoped authority is observed independently, never
issued by content approval. [Contracts and failure acceptance](v3-slice-06.md).

Slice 07 registers the separate owner-private Publisher Site and implements the
portable customer/account/content-version/platform-preview/frozen-task API and UI.
Commands persist atomically through a D1-shaped interface and preserve original
job/source projections. Local SQLite and browser acceptance pass; official Sites
identity/build/D1 integration remains blocked by missing starter/helpers. The
registered Site is still version 0, not a hosted delivery. See the
[actual migration matrix](v3-slice-07.md); unsupported operations stay disabled.

Slice 08 connects asynchronous Review snapshots, scoped object recovery, metric
observations/history and their read UI. Native validator rules are shared rather
than copied; native media decoding is consumed as an explicit server-side receipt.
Trusted heavy-service transport, hosted identity/storage and async approval decisions
remain unconnected. [Storage protocol and current acceptance](v3-slice-08.md).

## Source-backed architecture and reuse decisions

Reviewed 2026-10-21; these are design references, not installed dependencies or
code copied into this branch:

| Primary source | License / boundary | Reuse decision |
| --- | --- | --- |
| [Postiz](https://github.com/gitroomhq/postiz-app), [license](https://github.com/gitroomhq/postiz-app/blob/main/LICENSE) | AGPL-3.0; no code copied | Separate provider adapters, scheduling and analytics; preserve our stricter UNKNOWN reconciliation and per-account approvals |
| [Mixpost](https://github.com/inovector/mixpost), [license](https://github.com/inovector/mixpost/blob/main/LICENSE.md) | Public repository MIT; paid Pro is a different scope | Workspace/account context and media/library workflow; no commercial purchase or installation |
| [Chatwoot](https://github.com/chatwoot/chatwoot), [license](https://github.com/chatwoot/chatwoot/blob/develop/LICENSE) | MIT outside excluded enterprise content; enterprise has separate terms | Conversation/assignment/reply-intent separation; no autonomous reply authority inferred |
| [ffprobe](https://ffmpeg.org/ffprobe.html), [ffmpeg](https://ffmpeg.org/ffmpeg.html) | Existing system binaries invoked; no vendoring | Probe actual stream/container metadata, then decode actual audio/video to null; metadata alone cannot prove decoding |
| [Meta Pages API](https://developers.facebook.com/documentation/pages-api/overview) | Official Page API, app/token permissions still required | Page publishing/readback adapter only where authorized |
| [Meta v19 changelog](https://developers.facebook.com/docs/graph-api/changelog/version19.0/) | Groups API removed across versions 2024-04-22 | Do not invent a Groups API replacement; retained browser path is conditional on account/session/authorization evidence |

Parent research supplied these pinned implementation references; design inference
only, no copied code: [Postiz workflow c06abc3](https://github.com/gitroomhq/postiz-app/blob/c06abc3d786b8f719ced5716ccc70dd8a7251a05/apps/orchestrator/src/workflows/post-workflows/post.workflow.v1.1.2.ts)
separates a single irreversible publish attempt from pending polling; missing
heartbeat alone is never proof to retry. [Mixpost account job df57648](https://github.com/inovector/mixpost/blob/df57648b866310446703f5294350552b62735df5/src/Jobs/AccountPublishPostJob.php)
suggests per-account/post queue isolation; Lite does not supply Pro multi-tenancy
or approval features. [Chatwoot message a8487ab](https://github.com/chatwoot/chatwoot/blob/a8487abf5c5b54960f2375e8c613fe72711077fa/app/models/message.rb)
suggests Account → Inbox → Conversation → Message with internal-note separation
and human takeover. These are architecture choices for later packages.
Every operation separately tracks IMPLEMENTED, ACCOUNT_AUTHORIZED and
LIVE_VERIFIED. Page publishing does not unlock group messaging; draft writing
does not imply public publication. TikTok remains outside the implemented slice;
its [official sharing requirements](https://developers.tiktok.com/docs/en/content-sharing-guidelines)
must be reviewed for creator/consent/privacy/audit restrictions before any adapter
is enabled. No Messenger or Chinese-platform live API certification is claimed.

Meta's blog fetch returned HTTP 429; the official changelog search result was
available. No claim of newly certified Chinese-platform APIs: current
`publisher-platforms.js`, `multiplatform-drivers.js`, capability facts and genuine
account evidence govern WeChat/XHS paths. Documentation is not account consent.

Architecture: keep `Store`/`UnifiedPublisher` as publishing authority; attach
production inspection storage separately from publication jobs. Authentication
uses existing `PublisherAccess`; application tokens do not gain new scopes.
Scope is always workspace + account + platform target, never a display name.
Local artifact inspection may bind caller-declared scope but does not authenticate
the producer. Server account lookup must reject cross-workspace binding.
Metric storage and an injected read-only collector now wrap `metric-observation.js`
in [slice 03](v3-slice-03.md), with immutable raw evidence, explicit availability
and retained conflicts. Live collection remains unverified. Never sum
incompatible windows/definitions or turn unavailable metrics into zero.

## Inheritance / acceptance matrix

| Capability | Baseline source evidence | V3 acceptance |
| --- | --- | --- |
| Customers, accounts, tab navigation, multiple tasks | `src/client.js`, `store.js`, `unified-client.js`, `unified-publisher.js` | Existing tabs and context remain; test two clients/accounts; no cross-context stale view |
| Full content, media previews, platform variants | `library.js`, `gpt-drive-inbox.js`, `unified-client.js`, `legacy-p0/` | Keep existing routes and fixtures; add review without removing library paths |
| Review gates / enterprise source restrictions | `library.js`, `gpt-content-contract.js` | Valid production receipt never calls approve/import/create job |
| Content decision transport | Existing `PublisherAccess`, requestGuard and production review snapshots | Synthetic-only authenticated admin approve/reject, immutable receipts/audit, revision/identity invalidation; no new app scope or live producer authorization |
| Unknown publication | `unified-executor.js`, `publication-verifier.js` | UNKNOWN remains RECONCILE_PENDING; normal retry cannot submit again |
| WeChat Channels | `publisher-platforms.js`, `multiplatform-drivers.js` | PUBLISHED_ID_PENDING retained; no fabricated public ID |
| Identity | `unified-publisher.js`, `publisher-access.js` | Cross-project/account identity cannot overwrite; app token scope unchanged |
| Idempotency / daily limits | `scoped-operations.js`, `interaction-budget.js`, `operating-day.js` | Existing reservations/unknown outcomes stay consumed/pending until reconciliation |
| Groups / proactive / Inbox | `facebook-browser.js`, `proactive-engagement.js`, `engagement-review.js` | Keep drafts, target review, quotas and independent readback; cloud fixtures never publish |
| Video QA | `production-artifact-contract.js` previously BYTES_HASH_ONLY | Fake MP4, truncated video, audio-only, wrong container and missing decoder fail; real video decodes; review remains pending |
| Persistence | New production review ledger | Restart, duplicate receipt and conflicting result; no silent overwrite; account-scoped reads |
| Metrics | Pure `metric-observation.js` retained; slice 03 adds SQLite ledger and read-only adapter interface | Immutable task/account/post/source mapping, raw evidence, duplicates/conflicts/restart, newest failure without stale fallback; live collection explicitly unverified |
| Full content identity | Parent inventory: 074 identifies distinct trade, permit-rule and Luxshare articles across dates; 075 also repeats | Use full content_id + slug + body semantics + version; never merge or attach images by a three-digit suffix/folder alone. Inventory-semantic implementation remains future work |
| QA revocation precedence | Parent inventory: 062 title suggests pass, latest QA revoked old mobile PASS | New QA revocation / MOBILE_READABILITY_RETEST_PENDING overrides title markers and historic PASS; no inferred approval. Add actual inventory integration regression before rollout |

## Archive Asset Resolver (user addition)

Cold storage may primarily be ZIP; permanent loose files are not required.
Reference v1: `{content_id, archive_file_id, member_path, member_size, sha256, project_id,
account_id, archive_size, archive_sha256, kind, parts}` plus schema/type. Archive IDs are opaque storage IDs, never
platform media URLs. Existing loose-file reading remains a supported resolver.

Flow: resolve authorized project/account binding → fetch exact archive/ordered
parts via existing authorized transport → verify per-part and assembled hashes →
inspect ZIP central directory → extract the selected regular member into bounded
hot cache → verify bytes/hash/type/decode → return local media to the normal
platform upload path. Transport retries must not repeat publication.

Reject absolute/drive/backslash/traversal/NUL paths, duplicate normalized members,
symlinks, encrypted/unsupported entries, excessive entries, total expanded bytes,
compression ratio and recursive archives. Bound download, disk, decompression CPU
and timeout; verify CRC and SHA256; partial/cache-corrupt data never becomes READY.
Split archives require explicit order/count/size/hash; missing/duplicate/conflicting
parts fail. No heuristic filename regrouping.

Hot cache keys include project/account/content/archive/member/hash; acquire a
lease for active uploads and delete only expired unleased cache entries. Atomic
rename after validation; restart cleans incomplete staging only. Cache eviction
does not delete cold originals. Reference migration is additive/versioned with
old reference and rollback mapping retained. Deleting an original requires a
separate explicit action plus manifest/hash/decode/readback acceptance proof;
this release never deletes originals or changes Drive sharing.

Synthetic acceptance cases: ZIP and multipart reassembly success; wrong account,
missing part, checksum failure, zip-slip, symlink, duplicate member, ZIP bomb,
CRC failure, cache expiry/lease/restart, unchanged loose-file path, failed decode
does not mark READY, upload gets extracted media rather than ZIP URL, rollback
restores old reference. [Slice 02](v3-slice-02.md) implements these against synthetic
ZIPs and the existing Review ledger. Real Drive transport and Publisher/Muse real
asset consumption remain unverified. Muse capability is handled by the parent.

Retention update (user 2026-10-22): protect at least the latest 20 original media
files **per project/media library**. Use original media timestamps, never fresh
archive or ledger timestamps. Protect all cutoff ties and the whole library when
original times are uncertain. Prioritize only older videos for technical review;
image/text media stay retained. A video requires matching real publication and
readback evidence for every frozen target platform/account/content revision/job;
missing, UNKNOWN, click-only and test-only evidence do not qualify. Newer failed
readback overrides older success. Protected files never enter candidates.
Permanent deletion remains globally paused, requires separate exact batch
confirmation, and is not implemented. ZIP resolution alone grants no deletion
eligibility. The pure synthetic policy tests do not authenticate actual evidence.

## Delivery sequence and evidence rules

1. Slice 01: video gate + durable review surface + synthetic end-to-end/restart.
2. Archive resolver with synthetic adversarial ZIP corpus and compatibility path.
3. Durable metric ledger and authorized/manual collector boundary, then metrics UI.
4. Review decision transport bound to exact revisions, existing approval gates and
   authenticated actor; platform-specific live acceptance only under prior grants.

Each package records commit, exact commands/results, failed checks and remaining
work. Separate current executed tests, synthetic/local tests and unverified live
platforms. Historical 934/934 is never a current test result. No merge, production
service change, credential creation, purchase or real external interaction is
part of cloud acceptance.

## Final bounded development acceptance

[The final acceptance matrix](v3-final-acceptance.md) records the 2026-10-22
executed desktop/mobile integration, complete regression, screenshots, local demo
and remaining implementation gaps across the full business chain. The four slices
are a development increment; direct messaging, full human handoff, authenticated
producer transport, real source-to-publication authorization, live metric adapters and automated
metric-to-production iteration are not completed by these slices. No new live
authorization, merge or deployment follows from passing synthetic tests.

## Approved content to native upload preparation

[Slice 05](v3-slice-05.md) connects approved synthetic Review BLOBs (including ZIP
media) to the original content variants, DRAFT jobs and freezeMedia uploader input.
It reuses the original executor for a closed local simulation of one submit and
readback, including UNKNOWN reconciliation in a fresh process. The application
only prepares inspectable plans; real producer authentication, original source
approval and separate per-account/task publication authority remain required and
unavailable for this new source path. No new live execution permission is inferred.

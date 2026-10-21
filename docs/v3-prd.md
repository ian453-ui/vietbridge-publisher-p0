# Publisher V3 — PRD / architecture / acceptance plan

Baseline checked against GitHub on 2026-10-21 UTC: `publisher-unified` =
`4455a4b1faf40fedcd7020636999e165fa4a1386`. Development branch:
`publisher-v3/cloud-slice-01`, new worktree `/workspace/publisher-v3`.
The supplied V1 worktree (`fe9b7ad`) and Social Operator V2 (`85e987a`) were
clean and remain untouched. No repository/ancestor AGENTS.md was present.
GitHub returned no open issues/PRs for Publisher during this check. Original
handoff documents and their historical counts are evidence of prior work only.

## Product and release boundary

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
Metric storage/collectors are a later adapter over `metric-observation.js`, with
immutable observations, explicit availability and conflict detection. Never sum
incompatible windows/definitions or turn unavailable metrics into zero.

## Inheritance / acceptance matrix

| Capability | Baseline source evidence | V3 acceptance |
| --- | --- | --- |
| Customers, accounts, tab navigation, multiple tasks | `src/client.js`, `store.js`, `unified-client.js`, `unified-publisher.js` | Existing tabs and context remain; test two clients/accounts; no cross-context stale view |
| Full content, media previews, platform variants | `library.js`, `gpt-drive-inbox.js`, `unified-client.js`, `legacy-p0/` | Keep existing routes and fixtures; add review without removing library paths |
| Review gates / enterprise source restrictions | `library.js`, `gpt-content-contract.js` | Valid production receipt never calls approve/import/create job |
| Unknown publication | `unified-executor.js`, `publication-verifier.js` | UNKNOWN remains RECONCILE_PENDING; normal retry cannot submit again |
| WeChat Channels | `publisher-platforms.js`, `multiplatform-drivers.js` | PUBLISHED_ID_PENDING retained; no fabricated public ID |
| Identity | `unified-publisher.js`, `publisher-access.js` | Cross-project/account identity cannot overwrite; app token scope unchanged |
| Idempotency / daily limits | `scoped-operations.js`, `interaction-budget.js`, `operating-day.js` | Existing reservations/unknown outcomes stay consumed/pending until reconciliation |
| Groups / proactive / Inbox | `facebook-browser.js`, `proactive-engagement.js`, `engagement-review.js` | Keep drafts, target review, quotas and independent readback; cloud fixtures never publish |
| Video QA | `production-artifact-contract.js` previously BYTES_HASH_ONLY | Fake MP4, truncated video, audio-only, wrong container and missing decoder fail; real video decodes; review remains pending |
| Persistence | New production review ledger | Restart, duplicate receipt and conflicting result; no silent overwrite; account-scoped reads |
| Metrics | `metric-observation.js` is in-memory only | Future durable collector: duplicates/conflicts/restart/source hashes; real collection explicitly unverified |

## Archive Asset Resolver (user addition)

Cold storage may primarily be ZIP; permanent loose files are not required.
Reference v1: `{content_id, archive_file_id, member_path, sha256, project_id,
account_id, archive_sha256, parts?}`. Archive IDs are opaque storage IDs, never
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
restores old reference. Implementation is a subsequent package; no real Drive
access is needed. Muse capability is being handled by the parent task.

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

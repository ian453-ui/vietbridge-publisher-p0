# Publisher V3 current user-visible acceptance matrix

2026-10-22, slice 09. Formal target: owner-private ChatGPT Sites UI with cloud
services. Existing project `appgprj_6ad97a034fd08191a8399eeda10f048c` is registered,
not deployed. The table below supersedes earlier slices' *current* status without
rewriting their historical evidence. [Slice 09 evidence](v3-slice-09.md) identifies
this run; [original matrix](v3-final-acceptance.md) retains V1/V2 module references.

“Executed synthetic” means this cloud workspace ran code with generated inputs and
closed adapters. ACCOUNT_AUTHORIZED and LIVE_VERIFIED are **not established here**
for any external operation. A UI Tab is never business-function completion.

| User-visible capability | Existing native V1/V2/V3 path retained | Current Sites application code / acceptance | Remaining work |
| --- | --- | --- | --- |
| Customer/account switching and multiple tasks | Existing scoped store and shared-admin UI | Owner + exact active membership; persistent independent scopes; delayed old-customer/account replies cannot replace current view; transactional revocation races executed | Official hosted identity/bindings; no per-tenant individual RBAC claim |
| Tabs/navigation | Original native Tabs and tests retained | Nine operating destinations, with unavailable actions explicitly marked; desktop/mobile exercised | The blocked destinations below still need business code/integration |
| Content reading and complete preview | Library/Drive reading, loose media and original preview | Manual immutable content versions, full body/platform preview, reviewed content/media returns to original content and task views | Real Drive/library projection and transport into Sites |
| Content identity | Full IDs/revisions/hash in native library | Full content_id + slug + account + revision, no three-digit merging | Actual inventory semantic matching and 074/075 real-content integration; latest 062 QA withdrawal must override title flag, not yet wired to actual inventory |
| Platform variants | FB/XHS/WOA/Channels payloads/drivers retained | Same parser and validation; only explicit deliverable for chosen account/platform accepted; 4-platform synthetic preparation/terminal semantics | Real account transport/capability verification per operation |
| Content production | Production request/result contract and content workbench | Original request/result/inspection envelopes persisted and displayed | Real producer dispatch/orchestration and authenticated delivery; no automatic model production claimed |
| Video/image QA | Real bounded ffprobe/full decode/Pillow; bad MP4 regressions | Accepts exact server inspection receipt and bytes; browser playback exercised | Durable cloud heavy service; cannot execute native ffmpeg in Workers; factual/aesthetic/subtitle QA remains human |
| ZIP/parts/hot cache | Synthetic resolver, exact hash/member, lease, recovery and loose compatibility | Decoded extracted result is persisted as immutable objects and consumed in plans | Resolver service and authenticated transport not hosted/integrated with Sites; actual user ZIP consumption unverified after 403 |
| Retention/deletion | Per-library latest 20 originals protected; older videos need all-target genuine readback; image/text retained | No deletion route or grant | Actual inventory/evidence proof and separate exact batch approval; permanent deletion remains paused |
| Review and human decisions | Native shared-admin approve/reject/audit retained | Async event/command ledger, explicit checklist/reason, reject/revoke, restart, replay defense and races executed; only fixture authority/provenance provider available | Official Site identity + existing admin resolution and trusted real source decision provider; owner is not auto-admin |
| Change invalidation | Native exact version/body/media/account guards | Same binding fields plus atomic live scope/version/event/object checks; old plans display STALE_PREVIEW after read/rejection | Background immediate invalidation not implemented; DB triggers are not owner-tamper protection |
| Approved media → upload preparation | Native Review/ZIP bytes to original upload/task freeze | Exact reviewed bytes → platform variant → existing content → frozen original DRAFT; SQL rollback/lost ack/duplicate preparation exercised | Actual upload worker/provider; content approval never grants publication permission |
| Publish/unique submit/readback | Existing per-account native adapters, permits, quotas and executor retained | No HTTP execute route; closed async synthetic rehearsal on same frozen job demonstrates independent confirmation, unique attempt and readback | Async real permit/quota claim, account verification, authorized uploader/driver and actual independent readback |
| UNKNOWN handling | UNKNOWN→RECONCILE_PENDING, reservation retained | Restart/lost response/missing object/readback unavailable only reconcile original intent; later rejection cannot cause resubmit | Real cloud executor/reconciler and operation-specific proof |
| WeChat Channels / WOA | PUBLISHED_ID_PENDING / DRAFT_WRITTEN retained | Shared terminal meanings executed in closed simulation | Real verification remains absent; no public ID/publication invented |
| Group active posting | Native conditional Facebook browser group path retained and synthetic regression | Unavailable UI destination; no group provider or send route | Supported authorized cloud executor/API where available, rule/identity/per-account approval and readback; Page authorization cannot unlock Groups |
| Proactive search/likes/replies | Native scoped opt-in scan, draft review, quota/stop path retained | Unavailable destination | Cloud discovery/interaction provider and original scoped approval/quota integration |
| Inbox/comments | Native registered-post/comment read and review/reply paths retained | Unavailable destination | Read and reply provider; group chat is not implemented by comment paths |
| Private/group messages | No general authenticated messaging transport | Not implemented | Conversation/message model and authorized provider, independent from comments/Page permissions |
| Human takeover/internal notes | Limited pause/negative-stop policy exists | Full conversation assignment/internal-note/outbound interlock not implemented | Durable ownership, explicit takeover and send prohibition logic; research does not supply it |
| Metrics | Native raw ledger and injectable read-only collector interface | Async exact task/job/post/account/source/window observations, null reasons, history/generation/as-of and read UI; persistence and failure tests executed | Real authorized platform collectors, scheduling and live provenance |
| Metrics → next revision | Existing histories and production revisions | No automated diagnosis/new-brief orchestration | Define scoped human-reviewed iteration workflow and implement it |
| Hosted delivery | Cloud development independent of Mac | Portable application works under synthetic D1/R2-shaped tests; prepared source is not a build | Official Sites starter/helpers, generated migration metadata, identity/D1/R2 runtime wiring, private deployment and hosted acceptance |

No real account login, publication, group post, reply, direct message or metric
collection was used as a test. No real user file bytes are in this repository.
Tests use Chromium viewport emulation; Safari and physical phones remain untested.

Next concrete dependency: restore supported Sites starter/helpers for the saved
project, connect official identity/storage and privately deploy this functional
application. Continue independently with server-to-server real source/inspection
providers only when existing trusted transport and authorization are available.
Do not silently turn on the synthetic provider or create credentials to bridge
those gaps. Original `publisher-unified` stays unchanged and unmerged.

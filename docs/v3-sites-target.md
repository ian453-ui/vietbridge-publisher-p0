# V3 formal target: private ChatGPT Sites + cloud processing

User direction received 2026-10-22 02:17:41 UTC: the formal V3 interaction UI must
be ChatGPT Sites and its service must operate in the cloud, independent of the
Mac. Node localhost demos are development/test tools only. Existing Mac/V1/V2
installations stay untouched. This supersedes any interpretation that the cloud
development checkout alone is the delivery or that the formal interface will be
another Mac deployment. No original-domain requirement exists.

## Evidence actually available in this turn

* No `.openai/hosting.json` exists in this worktree. Existing repository source
  already contains `src/sites/readonly-api.js`, `src/sites/membership.js` and a
  candidate projection migration; reuse them rather than build a second mock.
* Current Sites connector descriptions expose create/version/private-deploy/status
  and database-read tools. They require the exact saved `project_id`, pushed
  commit, build artifact/hosting metadata and saved version before deployment.
* Current Sites skill read returned `skill package is not available`; both cloud
  and executor skills lists are empty. No project-setup/site-workflow helper was found in the
  inspected workspace/opt paths. Thus the mandatory current skill/build workflow
  could not be read. No Site creation or deployment was attempted speculatively.
* Parent's current read-only list identified only unrelated public OpenSky; it is
  not a Publisher project and must never be overwritten. A future Publisher Site
  must be separate and owner-private. Persist the returned opaque ID atomically
  before any further operation and never create twice.
* Current official [Sites overview](https://learn.chatgpt.com/docs/sites) describes
  hosted web apps. The official [Sparkboard example](https://developers.openai.com/showcase/idea-intake)
  specifies a Worker-compatible ESM build, a logical D1 `DB` binding and generated
  Drizzle migrations; its R2 binding is null. This confirms those technologies are
  used by Sites, **not** that this account has provisioned bindings, that all Node
  APIs work there, or that its example identity header is sufficient for Publisher
  authorization. Its workspace-wide sharing instructions do not apply here.
* Direct retrieval of the official overview Markdown from the executor was denied
  by the proxy (`Tunnel connection failed: 403 Forbidden`). It produced no file;
  that retrieval was stopped. Web search/open had already supplied the official
  overview/example. No workaround for this denial was attempted.

## Concrete minimum and layers

| Layer | Reuse / minimum implementation | Actual state |
| --- | --- | --- |
| Sites UI | Port the existing Tab/content/platform/Review/metric views to supported Sites starter; same scope selectors and frozen IDs | Existing browser UI tested in cloud Node; Sites entry/build and capability-aware API wiring still missing |
| Sites identity + API | Existing async read adapter + exact membership resolver; integrate official server-only Sites identity and owner mapping | Local SQLite facade tests run; real Sites dispatch/auth integration unavailable |
| Persistent reads | Existing `publisher_jobs`, `facebook_accounts`, source-ledger projection; generate/review official D1 migration, no copied real DB | Candidate migration/local tests only; no live D1 |
| Human decisions / source evidence / metrics | Reuse domain contracts and exact hashes; async repository layer with immutable receipts and concurrency checks | Native cloud Node/SQLite implementation tested; D1 write migration not implemented |
| Heavy media service | Cloud Linux process with real ffprobe/ffmpeg/Pillow and bounded ZIP extraction; immutable content hash and scoped receipt transport | Runs in development environment; managed durable cloud service not provisioned/connected |
| Media storage | Versioned immutable objects, hash/size verification, lease/cache lifecycle; use actual R2 only after supported binding contract is known | Local private BLOB/cache proven; R2 transport and object/SQL recovery protocol missing |
| Publish / interactions | Existing independent per-account permits, quota, submit intent and UNKNOWN reconciliation; separate authorized platform adapters | Synthetic execution proven; no new live authority or cloud browser/official API rollout |

The existing executable minimum is the **real read API factory**
`createSitesReadonlyApi({db,origin,resolveScope})` with
`createSitesScopeResolver({db,getTrustedIdentity})`, not static sample JSON. It
performs scoped persisted queries and returns original frozen task/attempt state,
including UNKNOWN. Its local acceptance command is:

```sh
node --test test/sites-readonly-api.test.js test/sites-membership.test.js
```

It is a prerequisite, not a complete hosted console. The deployment minimum is:
read the current Sites skill/starter → create one separate private Publisher Site
after local build exists → persist project ID → integrate verified dispatch identity
and explicit owner membership → register generated isolated projection migration
→ wire the existing UI's scoped jobs/source views to the read API → build/package
exact pushed commit → save/private-deploy → verify hosted identity denial and
account isolation plus actual D1 reads on desktop/phone. No dummy auth, static
shell or public seeded customer data substitutes for these gates. First writes
require a separate verified transaction design, not just successful read hosting.

Native `DatabaseSync`, BEGIN IMMEDIATE/read-check-write callbacks, filesystem
locks, native subprocess decoders and local browser/CDP profiles are not assumed
portable to Workers. D1 batch behavior does not prove the atomic native
claim+permit+quota sequence. No native ffmpeg or persistent Node server is claimed
to run inside Sites. Cloud heavy processing and Sites API/UI need an explicit
trusted transport boundary; lack of a current authorized provider keeps it shut.

## Exact outstanding blocker and next authorized work

The blocked dependent step is **supported Sites initialization/build packaging
and identity integration**, because the current required Sites skill package and
helpers are unavailable. This is a missing runtime workflow, not a denied Site
create/deploy request: none was sent, no uncertain Site resource exists, and no
Publisher project ID was invented. Existing source evidence package, cloud tests
and PRD continued independently. No extra permissions were requested.

Once supported instructions become readable, use the already authorized new
private V3 Site scope; do not ask again merely because it is a Site. Do not reuse
OpenSky, expose real customer materials, or generate separate OAuth/service-account
credentials. If the supported flow itself needs additional credentials/access,
identify that exact step and stop it while continuing local migration work.

Remaining work is explicitly both **code** (Sites UI/API wiring, async repository,
write-transaction design, object recovery, trusted cloud/media transports) and
**runtime acceptance** (current build helpers, identity dispatch, provisioned
bindings, deployment tests). It is not all attributed to Mac availability or hosting.

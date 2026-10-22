# V3 formal target: private ChatGPT Sites + cloud processing

Updated 2026-10-22, slice 07. The user requires the formal UI on ChatGPT Sites
and services in the cloud, independent of the Mac. Local Node demonstrations are
only development tests. Existing V1/V2/Mac installations and unrelated sites remain
untouched. No original-domain requirement exists.

## Actual registration and current blocker

A new, separate **VietBridge Publisher V3** Site was created with the native Sites
connector at `2026-10-22T02:50:43.614152+00:00`:

- Project: `appgprj_6ad97a034fd08191a8399eeda10f048c`.
- Expected URL: `https://vietbridge-publisher-v3.ardenttang64.chatgpt.site`.
- Native readback: `current_user_role:owner`, access mode `custom`, allowed role
  only `owner`, no external visitors, version **0**, `live_url:null`.
- ID persisted immediately in `/workspace/sites/publisher-v3/.openai/hosting.json`.
  Reuse this ID; never create a second project for a failed build.
- [Redacted registration evidence](evidence/v3-sites-registration.json) contains no
  credentials. The source credential issued by the native Sites flow is ephemeral,
  held in tool memory only, and has not been used to push. No persistent social,
  OAuth or service-account credential was created.

**The Site is registered, not deployed.** No source push, saved build, hosted
migration, D1/R2 provisioning or deployment has been attempted. The expected URL
is not proof of a working product. The unrelated OpenSky site was only identified
in the read-only listing and was never modified.

The Sites skill recovered and its main instructions, storage, identity,
app-integration and local-preview references and starter README were read. Native
creation followed those instructions. However, the executor does not have the
plugin directory, `scripts/project-setup.mjs`, `scripts/site-workflow.mjs`,
`install-dependencies.mjs`, `build-site.mjs`, or complete Vinext starter. Attempts
to read required script/starter resources returned `failed to read skill resource`.
A later main-skill read again returned **`skill package is not available`**; both
skill catalogs then returned zero entries. These are missing workflow resources,
not a rejected create/deploy permission request or an uncertain deployment.

Instruction source:
[Sites SKILL.md](skill://plugin_connector_1p_689987207de08191979cf68eca2941c6/sites/SKILL.md)
and its
[Vinext starter README](skill://plugin_connector_1p_689987207de08191979cf68eca2941c6/sites/templates/vinext-starter/README.md).
The readable starter explicitly says: “When using the Sites plugin, follow its
skill instructions for installation, builds, and publishing.” It also identifies
`app/chatgpt-auth.ts`, maintained Sites Vite integration and the production Worker
entry as starter components. Those missing components were not replaced with
invented authentication headers or a guessed deployment manifest.

The dependent blocked action is supported initialization/build/source publication
for this exact project, including official identity and binding integration. No
new user permission is needed to restore those existing tools. Parent instructions
already authorize a new owner-private V3 Site. The supported helper/starter needs
to become available in this environment; then continue against the saved ID.

## Supported layers and implemented migration

| Layer | Implemented and tested | Remaining before hosted acceptance |
| --- | --- | --- |
| Sites-oriented UI | `cloud-console.html/css/js`: customer/account switching, nine inherited navigation destinations, complete content/platform preview, new immutable versions, multiple frozen tasks and reload | Official starter entry/assets wiring and hosted desktop/mobile tests; unsupported tabs explicitly say so |
| Identity/API | Pure ESM `cloud-authoring-api.js`; server-only identity callback required; existing membership/read API reused; missing identity/bindings fail closed | Official `getChatGPTUser()` integration in the dispatch-owned server context; no browser-provided identity fallback |
| Persistent authoring | Async D1-shaped SQL, atomic command batches, customer/account/version/frozen-task writes, original source/job projections | Real D1 binding, generated Drizzle schema/migrations and hosted rollback/concurrency validation |
| Review/source/metrics | Original Node/SQLite implementations and all prior gates retained; current full regression passes | Async persistence port, exact identity/receipt transport and UI connection to the cloud authority boundary |
| Heavy media | Bounded ZIP/hash/ffprobe/ffmpeg/Pillow implemented and tested in cloud development | A durable authorized cloud Linux service with authenticated receipt transport; no Mac fallback or native ffmpeg inside Workers |
| Media objects | Original immutable BLOB/cache and lease checks retained | Actual R2 binding, scoped upload/read transport, object/SQL recovery and hosted media acceptance |
| Publishing/interactions | Existing per-account permits, quotas, idempotency and UNKNOWN reconciliation retained | Separate authorized official/API or cloud executor integrations; this Site has no execution routes |

Current Sites instructions describe Workers with 128 MB memory and HTTP outbound
access, not raw TCP or a persistent Node process. Native SQLite transactions,
filesystem locks and subprocess decoders must remain separated or be deliberately
ported. D1 batch tests on SQLite are not hosted D1 acceptance. R2 is not provisioned
merely because its name appears in an architecture document.

The authored console calls real API handlers and persists to the injected database;
it does not keep business data in browser localStorage or static fixture JSON.
Only selected customer/account preferences use localStorage. New manual content
stays `MANUAL_UNVERIFIED`, account mappings stay `UNCONFIGURED`, and frozen tasks
stay DRAFT with `publish_allowed:false`. Creating a mapping grants no platform
access. Current lists are bounded to 200 items; pagination remains to implement.

## Resume path without rebuilding or weakening gates

1. Restore the official Sites plugin/helper directory and Vinext starter. Preserve
   the existing project ID during initialization; do not overwrite unrelated sites.
2. Import the prepared portable source from `/workspace/sites/publisher-v3/migration-source`.
   This is source staging, not a build artifact. The hosting file still declares
   `d1:null,r2:null`; change them only using the verified supported binding schema.
3. Connect official server-only Sites identity and D1, generate schema-only Drizzle
   migrations from the reviewed candidate SQL, and validate with the official
   local runtime. Do not run DDL or seed users in request handlers.
4. Use official install/build/source-workflow helpers and native private deployment
   against the exact pushed commit and artifact. Credentials go only through the
   helper's supported secret input, never arguments, files, logs or Git remotes.
5. Verify hosted owner-only access, forged identity denial, customer/account scope,
   durable reload, duplicate commands, failure rollback and actual D1 reads on
   desktop/mobile. Only then report a working private URL.
6. Port Review/metric persistence and connect the separately authorized cloud media
   service. Keep real source verification, approval and publication authority
   separate. Unsupported operations remain closed, even on a successful UI deploy.

[Slice 07](v3-slice-07.md) supplies actual commands, failures, screenshots and the
acceptance matrix. Native cloud-development regression remains intact; formal
hosted V3 delivery remains incomplete. This is both a missing supported workflow
and unfinished integration code, not a Mac availability issue.

The earlier denied real Study ZIP download and official overview Markdown executor
request remain stopped. No retry, alternate route, sharing change or original
media deletion was made as part of this migration.

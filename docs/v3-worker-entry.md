# V3 Worker application entry and runtime binding handoff

2026-10-22. Continues `b16eeabf24b599702ce956ce4e6ed4f950edbccd` on
`publisher-v3/cloud-slice-01`. Reuse Site
`appgprj_6ad97a034fd08191a8399eeda10f048c`; do not register another project.
This package adds application integration code, not a replacement Sites starter,
authentication provider, build helper or deployment artifact.

## Implemented entry

`src/sites/worker-entry.js` exports `createPublisherSite(options)`, returning a
Worker-shaped object with `fetch(request, env, ctx)`. It also exports a default
Worker which deliberately refuses service until official identity integration
is supplied through the factory. There is no header parser, default user,
first-visitor enrollment, credential loader, in-memory business store or network
fallback.

| Input | Behavior |
| --- | --- |
| `options.origin` or `env.PUBLISHER_CANONICAL_ORIGIN` | Required exact canonical HTTPS origin; never inferred from Host, forwarding headers or the request URL. Explicit factory configuration takes precedence. HTTP loopback requires the code-only `allowLoopback:true` test option. |
| `options.getTrustedIdentity(request, env, ctx)` | Required server-only function supplied by the verified official identity integration. Null/invalid user returns 401; missing integration or provider failure returns distinct 503 errors. No bearer token, email, cookie or browser header becomes identity here. |
| `env.DB` | Required D1 `prepare`/`batch` binding, passed directly into the existing API per request. No global database or identity caching. Missing DB returns 503 even for the document. |
| `env.BUCKET` | Optional R2 `get`/`put` binding passed directly to existing scoped object/review stores. Manual text authoring can operate without it; media reads remain unavailable. A configured malformed binding fails 503. |
| `options.readAsset(path, {request,env,ctx})` | Server-only official-framework asset adapter, when available. Otherwise the handler requires `env.ASSETS.fetch`. |
| Approval/target/variant providers | Explicit server-code options passed to existing stores; absent providers remain absent. This entry adds no admin authority, real producer or publication transport. |

`/` serves the existing `cloud-console.html`; `/cloud-console.js` and
`/cloud-console.css` serve the existing source assets. All three require resolved
identity and valid database binding. GET/HEAD, exact content types, no-store,
nosniff and a same-origin CSP are enforced. Only those paths reach the asset
provider, through new internal GET requests without browser cookies or credentials.
Redirects, missing assets and HTML fallbacks for JS/CSS fail closed. Source files,
configuration files and unknown paths are not served.

`/api/sites/*` and `/api/unified/*` call the original authoring/read API, preserving
workspace/account authorization, Origin checks, atomic rollback, frozen receipts,
per-item batch limits and UNKNOWN behavior. Unsupported API routes return API
errors, never the static document. Only this request's validated identity and
bindings are captured. Other methods and routes remain unavailable. No execution,
upload, publication, permission, migration or enrollment endpoint is introduced.

Cloudflare documents the [`ASSETS.fetch` binding](https://developers.cloudflare.com/workers/static-assets/binding/).
If using that binding, the eventual hosting setup **must route these paths through
the Worker first** so asset-first serving cannot bypass this handler's checks.
This repository does not invent the missing Sites-generated configuration.
An official Vinext integration may instead supply `readAsset` from its supported
server asset path. Dispatch-owned sign-in/callback routes must remain upstream;
the application must run inside the official request/identity context.

## Executed local verification

The new entry has direct API tests using actual file-backed SQLite behind the
existing D1 method-shape fixture, file-backed R2 method-shape fixtures and the
unchanged production UI assets. Desktop and mobile Chromium journeys serve the
document, JS, CSS and APIs through this single entry, reload durable task data,
read original task previews and reject anonymous document requests. Outside
browser requests are blocked. Fixed synthetic identity exists only in tests.

Tests exercise missing/malformed bindings, forged identity headers, provider
failure, MIME/redirect/path rejection, concurrent identities/databases on one
Worker instance, persisted UNKNOWN receipts after reopen, wrong workspace/account,
revoked membership, foreign-origin writes, transaction rollback, exact scoped
media bytes and absent-schema failure without request-time DDL.

Reproduce the new entry tests:

```sh
PUBLISHER_TEST_BROWSER_PATH=/usr/bin/chromium \
PUBLISHER_TEST_FFMPEG_PATH=/usr/bin/ffmpeg \
node --test test/sites-worker-entry.test.js test/sites-worker-ui.test.js
```

Current runs both exited 0 with no failures, cancellations, skips or TODOs:

| Run | UTC interval | Passed | Duration |
| --- | --- | ---: | ---: |
| [Affected](evidence/v3-worker-entry-20261022-focused.json) | 22:05:44–22:06:50 | 99/99 | 66346.207350 ms |
| [Final full regression](evidence/v3-worker-entry-20261022-full.json) | 22:07:21–22:09:59 | 1339/1339 | 157928.288521 ms |

Complete commands, timestamps, exit codes, changed input hashes and log hashes
are recorded in those manifests. Complete [affected log](evidence/v3-worker-entry-20261022-focused.log)
and [full log](evidence/v3-worker-entry-20261022-full.log) are archived separately.
Input and log hashes were rechecked after completion. These runs do not replace
the preceding batch recovery evidence.

## Remaining deployment gates and failure classification

The selected new cloud instance can run shell and the repository tests. A fresh
search of `/workspace`, `/opt/codex`, `/mnt` and `/usr/local/share` found no official
`project-setup.mjs`, `site-workflow.mjs`, `build-site.mjs` or `chatgpt-auth.ts`.
The current Sites skill and Worker starter README were readable. Exact official
Vinext auth/Worker source reads returned `failed to read skill resource`.
This is an unavailable resource, not an automatic approval denial.

Fresh native readback of the existing Site: active, current role owner, access
mode custom with only owner, zero external visitors, version 0, saved versions
empty, live/preview/expected URLs null. Runtime variable keys and visible D1
bindings are empty. The original local hosting manifest/staging directory is
absent in this instance. No new manifest with guessed bindings was fabricated.
See `evidence/v3-worker-entry-20261022-platform.json` for redacted observations.

To continue deployment:

1. Restore the complete official Sites helper/starter in this instance and the
   original hosting configuration for the same Site. Do not create another Site,
   download around an earlier denial or alter network/security/sharing settings.
2. In that supported starter, import the application factory, connect the official
   server-only identity helper and verified canonical origin, and map the existing
   three assets through its supported routing. Do not deploy the intentionally
   unconfigured default export as a working service.
3. Declare and verify dedicated D1/R2 bindings through the official manifest
   contract. Convert the ten candidate SQL files into reviewed generated schema
   migrations/metadata and validate them through the official local runtime.
   No real database, membership, object store or migration has been created here.
4. Validate real dispatch identity, owner/workspace/account isolation, asset-first
   bypass prevention, persistence, revocation and rollback on actual Worker/D1/R2.
   Synthetic SQLite/R2 tests cannot establish those hosted properties.
5. Only with the complete official workflow and already authorized source access,
   build/package the exact pushed source and deploy privately to the same Site.
   Any required credential creation/configuration remains a specific stop point
   under the user's instruction. Read back the actual deployment/URL before
   claiming delivery; an expected address or static shell is not acceptance.

No Site was created, saved or deployed in this package. No source credential,
runtime credential or social credential was created/configured. No real social
send, Mac operation, sharing change or `publisher-unified` modification occurred.

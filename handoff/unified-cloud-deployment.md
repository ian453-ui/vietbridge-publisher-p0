# Unified cloud startup and Mac synchronization

This is a cloud control-plane startup package, not evidence of persistent hosting.
The Mac entry (`npm start` / `src/unified-server.js`) is unchanged. Cloud startup
uses `npm run start:cloud` and does not impersonate a connected Mac executor.
No platform execution, scan scheduler, content synchronization, startup recovery,
scoped publication authority or browser-reopen authority is enabled by this entry.
Existing authentication, HTTPS-origin validation and Host checks still apply.

## Reproduce and validate

Use Node 24 and an isolated checkout of the exact reviewed `publisher-unified`
commit. Record `git rev-parse HEAD` and compare it with the approved commit;
`main` is the separate old implementation.

```sh
npm ci --ignore-scripts --no-audit --no-fund --cache /tmp/vietbridge-npm-cache
node --test test/unified-cloud-entry.test.js test/cloud.test.js test/unified-handler.test.js test/maintenance-readonly.test.js
```

No transpilation/build script is required. Entry tests spawn the actual cloud CLI,
use disposable fixture authentication and temporary databases, verify auth/Host
rejection, unified UI/state, disabled execution/scheduler, rejection of capability
flags and incompatible databases, clean shutdown and reopening the same database.
The existing handler tests also cover CSRF. No real social platform is contacted.

On an **already authorized host**, supply the existing access configuration through
its established secret mechanism; never put passwords in this document or Git.
Required configuration: `PUBLISHER_MODE=cloud`, approved HTTPS `PUBLIC_ORIGIN`,
absolute `DATA_DIR`, and existing `ADMIN_ACCESS_FILE` or `ADMIN_PASSWORD` with the
appropriate `ADMIN_USER`. Use a dedicated directory and database; do not rename
or reuse a legacy V1/V2 database.

```sh
npm run start:cloud -- /absolute/authorized-data/publisher-unified.sqlite
```

Default bind is `127.0.0.1:17882`. Only for a reviewed container/proxy setup,
`PUBLISHER_CLOUD_BIND_HOST=0.0.0.0` can expose the listener inside the container;
keep the host port private. Execution flags must be absent or `0`. Local scoped,
diagnostic and browser-reopen authorization files are rejected, not consumed.

## Container package

```sh
docker build -f Dockerfile.unified-cloud -t publisher-unified-cloud:reviewed .
```

`compose.unified-cloud.yaml` is an opt-in deployment template using an independent
volume and host-loopback port `18082`. It requires the approved HTTPS origin and
existing password configuration, and publishes no public port. A host using an
existing access file should use its established private mount/secret mechanism
instead of inventing a password. Do not run Compose against a production target
until its exact host, volume, authentication and proxy mapping are confirmed.
The existing Dockerfile/compose.cloud.yaml retain their legacy behavior.

## What has actually been verified

The prior source baseline `9f84bde371e9071284552753b6e6e99e3fa61ffe` was independently
exported, installed (109 locked packages), and started with unified cloud options
on loopback; eight smoke assertions and ten existing targeted tests passed. This
package makes that startup reproducible through a committed CLI. Its targeted
suite passed 12/12 on Node 24.19.0, including the two new real-process tests.
Container follow-up completed on 2026-10-20. The earlier cancellation was clean
(no surviving npm/build container). A default-network registry probe returned
`EAI_AGAIN: getaddrinfo EAI_AGAIN registry.npmjs.org`; the online build was stopped
rather than treating silence as proof of failure. No DNS/network settings changed.
An offline build using the already installed lockfile dependency cache succeeded.
Its first runtime check exposed root-owned source files unreadable by the `node`
user; `COPY --chown=node:node` fixes image ownership without changing host modes
or running the service as root.

Validated image: `sha256:e8f441c67bbedf89c16f4aecf3e091d12b892bde29f173eb46fceda326f2a77b`
(Node 24.22.0 base; image User=node). With a synthetic tmpfs database and a host
loopback port, actual container HTTP checks passed: unauthenticated 401, wrong
Host 409, authenticated unified state/UI/client asset 200, healthy unified mode,
execution/page-execution/scheduler false, and local group-library blocked (409).
A separate container with `PUBLISHER_ENABLE_EXECUTION=1` exited nonzero with
`CLOUD_EXECUTION_DISABLED`. Both containers and their temporary data were removed.
No persistent deployment or public URL was created.

For environments where the normal registry route fails, a complete existing npm
cache can be used without changing the lockfile or network configuration. This
only changes the installation step of a temporary Dockerfile; cache contents are
mounted for the build and not copied into the final image. Missing cache entries
fail closed under `--offline`. Do not use a cache containing private material.

```sh
# First obtain the lockfile packages through the normal authorized install path.
npm ci --ignore-scripts --no-audit --no-fund --cache /tmp/vietbridge-npm-cache
python3 - <<'PYCODE'
from pathlib import Path
source = Path('Dockerfile.unified-cloud').read_text()
source = source.replace(
    'RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund',
    'RUN --mount=type=bind,from=npm_cache,target=/npm-cache,rw npm ci --offline --cache=/npm-cache --omit=dev --ignore-scripts --no-audit --no-fund')
Path('/tmp/Dockerfile.publisher-offline').write_text(source)
PYCODE
mkdir -p /tmp/publisher-docker-build-config
docker --config /tmp/publisher-docker-build-config build --progress=plain \
  --build-context npm_cache=/tmp/vietbridge-npm-cache \
  -f /tmp/Dockerfile.publisher-offline -t publisher-unified-cloud:reviewed .
```

The application health field `persistent:true` is metadata, not a hosting guarantee.

No Publisher hosting descriptor exists in this checkout. The reviewed environment
exposed no deployment-target configuration names, and the available Sites account
contained no Publisher project. An authorized persistent Node24/container target,
durable storage, existing authentication and an approved HTTPS proxy remain
necessary. A successful local process or image build is not a public deployment.
No permanent URL has been provisioned, and no Mac access is needed to run the
isolated cloud checks.

## Mac follow-up

1. The cloud handoff must provide the exact resulting commit SHA. Verify origin
   `https://github.com/ian453-ui/vietbridge-publisher-p0`, then fetch
   `publisher-unified`. Compare its SHA with the handoff; review intervening changes.
2. Preserve any local uncommitted work. Prepare that exact commit in an isolated
   release/worktree of the existing repository; do not reset the live checkout,
   merge into old main, or create another code repository.
3. Run the commands above. Keep local databases, browser profiles, CDP ports,
   customer content, service configuration and credentials in their existing
   private locations. Do not upload them or point tests at production data.
4. Confirm which service is unified versus independent V1 before any later switch.
   Verify database identity/schema, workspace/account/actor/Page/profile binding,
   authentication, CSRF and disabled execution flags. The unchanged Mac entry and
   its original confirmation/authorization checks remain the Mac startup path.
5. Record the currently running exact SHA, entry and release path before an
   authorized switch. Roll back code by selecting that recorded release; do not
   restore an old database, delete hidden-history markers or replay tasks. This
   startup package requires no new data migration. The prior cloud code point is
   `9f84bde371e9071284552753b6e6e99e3fa61ffe`, not a claim about Mac's live version.

This handoff does not authorize production restart, real publication or interaction.

## Release-wide quality checkpoint — 2026-10-20

Tested source: `a5844c9ec6616e17581435bccc201b38be199b96` on
`publisher-unified`. The follow-up commit adding this section changes documentation
only. Node 24.19.0, npm 11.9.0, `/usr/bin/chromium`, `/usr/bin/ffmpeg`.
No applicable AGENTS.md or .agents skill instructions were present in this checkout
or its workspace ancestors; the repository's browser-action skill is not needed
for synthetic test execution. No independent CI workflow, lint command or
TypeScript type-check configuration is defined in the repository.

| Check | Result | Scope / limits |
| --- | --- | --- |
| Full npm test suite | **855/855 pass**, 0 fail/cancel/skip/todo; 65.852s | Includes browser fixtures and targeted tests below; synthetic data only |
| Node parser checks | **273/273 pass** | All tracked .js/.mjs/.ts except declaration files; syntax, not type checking |
| Compose contract | Pass | YAML parses, host-loopback port, all five execution/sync/scheduler flags are `0` |
| Whitespace check | Pass | `git diff --check` |
| Mac entry source compatibility | No diff | `src/unified-server.js` unchanged from `9f84bde` through the tested commit |
| Container acceptance | Already passed; not repeated | See image digest and runtime checks above |

Full-suite coverage includes registered account/batch ownership, UNKNOWN and
RECONCILE_PENDING protections, safe history hiding, synthetic old hidden markers,
unchanged stored job/history records, cloud CLI auth/Host guards, disabled execution,
rejected capability flags, database identity checks, process restart and existing
Mac-tunnel authentication/CSRF and read-only maintenance contracts. No new or old
failures appeared in this run; no production-code changes were needed.

Reproduce from the exact checkout (do not run against a live database):

```sh
npm ci --ignore-scripts --no-audit --no-fund --cache /tmp/vietbridge-npm-cache
PUBLISHER_TEST_BROWSER_PATH=/usr/bin/chromium \
PUBLISHER_TEST_FFMPEG_PATH=/usr/bin/ffmpeg npm test -- --test-concurrency=4
python3 - <<'PYCODE'
import pathlib, subprocess
paths = subprocess.check_output(['git', 'ls-files'], text=True).splitlines()
files = [p for p in paths if pathlib.Path(p).suffix in {'.js', '.mjs', '.ts'}
         and not p.endswith('.d.ts')]
for path in files:
    subprocess.run(['node', '--check', path], check=True)
print(f'{len(files)} syntax checks passed')
PYCODE
node --input-type=module - <<'JSCODE'
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import YAML from 'yaml';
const service = YAML.parse(readFileSync('compose.unified-cloud.yaml','utf8')).services.publisher;
assert.deepEqual(service.ports, ['127.0.0.1:18082:8080']);
for (const key of ['PUBLISHER_ENABLE_EXECUTION','PUBLISHER_ENABLE_PAGE_EXECUTION',
  'PUBLISHER_ENABLE_GROUP_INTERACTION','PUBLISHER_ENABLE_SCAN_SCHEDULER',
  'PUBLISHER_ENABLE_CONTENT_SYNC']) assert.equal(service.environment[key], '0');
console.log('Compose contract passed');
JSCODE
git diff --check
```

Evidence retained in the execution environment (raw logs are not committed):
- `/tmp/publisher-release-full.log`, SHA256 `7f8a3f90ee3cfc89c5fb167ba77086ecbf2e62a0101275995f7275fb131df560`.
- `/tmp/publisher-release-static.log`, SHA256 `1e8c7bf3b67c1a68963553430d4752783b4728b1ba9f5036dcead9ffbd09ac93`.

Remaining blind spots: no independent static type analysis (no configured checker),
no real Mac launchd/service restart or live database/browser integration, no
independent old V1 release validation, no actual platform publishing, no sustained
load/endurance run, and no persistent HTTPS deployment target. These are not
reported as passed, nor as failures of the synthetic release suite. Existing
container DNS limitations and the validated offline build path remain documented
above. User confirmation and original execution permissions still apply to any
future production actions.

Before a later Mac handoff, use the [read-only continuation checklist](continuation-readiness.md)
via `npm run check:continuation -- --text /absolute/path/to/evidence.json`.
It separates cloud-independent work from Mac dependencies without granting any
execution or synchronization authority.

### Continuation additions: final aggregate checkpoint

The subsequent continuation changes through `5d776401979d6b088a4c1db4c05b46ca12a5b82b`
were independently revalidated: **865/865 full tests**, **277/277 syntax checks**,
Compose safe defaults and npm entry contracts passed on 2026-10-20. The previous
855-test checkpoint above applies only to its stated baseline. See
[final continuation evidence and exclusions](continuation-readiness.md#final-aggregate-verification--2026-10-20).
No product fixes were needed; the image was not rebuilt for these unrelated additions.

## Mac-offline cloud acceptance — 2026-10-20 follow-up

Baseline `672dd9745e475c9f0b2a28700f53bf2fa1595699` was clean when this environment
actually reached READY. The checked-out branch remains publisher-unified. No Mac,
real Facebook browser session, cookie, token, production DB or platform operation
was accessed. This follow-up addresses deployment packaging and isolated evidence,
not a claim of three-to-four-day hosting availability.

### Packaging correction

The previous unified Dockerfile omitted `scripts/`, so its advertised npm
workbench entry could not run in the image. It now copies those scripts and the
one explicitly synthetic demo image (the rest of test/ stays excluded). The full
image also declares Python/Pillow for existing image validation and ffmpeg for the
synthetic video demo. No browser executor is added. The startup and five disabled
execution/sync/scheduler flags are unchanged.

The **full image build was attempted and failed**: the Docker build could not
resolve deb.debian.org; apt repositories were unavailable and installation exited
100. No DNS, proxy, credentials or permission settings were changed to bypass it.
The full workbench image is therefore not accepted or deployed yet. The normal
authorized build host needs access to its existing Debian/npm dependency sources
(or a separately verified preprovisioned image/cache); do not label a partial
image as complete.

An isolated **control-plane-only** acceptance image was successfully built with
network disabled from the already cached validation image and current source:
`sha256:3284e41acf157c1fcd583e9ef2ea546314cdfa41fde5a02d003c14a90196aaad`.
That cache path does not install the new Python/Pillow/ffmpeg dependencies and
must not be represented as a successful full workbench Docker build. Native cloud
Node/Python/Pillow/ffmpeg were already available and ran both workbench demos.

### What was actually run

```sh
node --test test/unified-cloud-entry.test.js test/cloud.test.js test/gpt-revision-approval.test.js test/unified-executor.test.js test/production-artifact-contract.test.js test/content-workbench.test.js
```

**61/61 passed**, including a new real-process cloud-entry persistence test:

1. Generate a synthetic request/result and QA preview through the actual CLI.
2. Read the existing v1 inbox, approve only the isolated synthetic item, and verify
   repeated acceptance is already_applied without duplicate manifest changes.
3. Import that source through the existing UnifiedPublisher core; repeated source
   revision maps to one content record. Create one synthetic frozen DRAFT, no permit.
4. Start the actual cloud CLI twice against the same nonempty database; authenticate
   HTTP readback and verify the exact draft ID/body/snapshot remains stable.
5. Reopen storage, verify one source ledger row and one draft, zero attempts, and
   unchanged approved manifest. Local library HTTP remains blocked with 409;
   execution-capability remains false. No gate was opened for the test.

Existing executor regression uses **mocked drivers** to verify result recovery,
UNKNOWN handling and submit/receipt idempotence. This is separate from actual
platform operation. Production-v2 receipts remain unsigned caller-held correlation
records, not a durable ingestion ledger. The new v2 mode still never imports.

A separate real Docker exercise used a new synthetic named volume and two
successive containers. After stopping/removing the first container, the second
read the same single DRAFT and snapshot from that volume. Both returned 401
without auth, 409 for local library, and false execution capability. All temporary
containers and the test volume were removed. This proves **container recreation**
persistence only, not host/environment restart, backup recovery or an uptime SLA.

Native synthetic artifacts were retained outside Git at:
`/workspace/shared/publisher-cloud-acceptance-20261020/content-demo/` and
`/workspace/shared/publisher-cloud-acceptance-20261020/production-demo/`.
The former contains preview.html; the latter contains report.json and synthetic
knowledge/script/subtitle/video files. They are not real task evidence. Workspace
snapshot retention is not a continuously running server or a three-day guarantee.
No screenshot retry was attempted after the prior administrator-policy rejection.

### Current hosting evidence and minimum missing target

- No running Docker service or volume existed at inspection time. No recognized
  Publisher deployment configuration names were set (values/secrets not read).
- No Publisher hosting manifest or persistent target descriptor was found in the
  checked workspace. Sites lookup returned only an unrelated OpenSky site. Sites
  is Worker-based; it is not a drop-in host for this Node/SQLite/Python process.
  No new site, repository, credentials or access grant was created.
- Personal-context lookup was unavailable. This is not proof no external host
  exists; the specific already-authorized host is not identified in this task.
- An unauthenticated read of `https://publisher.vietbridge.one/api/health` was
  **denied by the outbound proxy: CONNECT 403**, before any application response.
  No alternate route or authentication attempt followed. The hostname is an
  existing Mac-tunnel reference, not a verified independent cloud URL.

To complete real hosting, the original cloud operator must identify the existing
Node24/container service or VM, its durable storage binding, and the already
configured HTTPS/authentication deployment control. Do not ask the user to copy
Mac cookies or invent new credentials. Reuse that authorized target and existing
access configuration; do not replace the independently running Facebook service.
The dependency build path must also work. If those already exist elsewhere, a
read-only target identification/readback is the next step, not new provisioning.

**Current permanent Publisher URL: none verified.** The localhost endpoints used
in acceptance have been stopped. Public HTTPS deployment, host restart persistence,
production data import and live platform execution remain unperformed.

Evidence retained locally (no raw logs, credentials or customer data committed):
- `/tmp/publisher-cloud-offline-acceptance.log`: 61/61 native/module regression.
- `/tmp/publisher-cloud-current-build.log`: full image build failure.
- `/tmp/publisher-cached-control-build.log`: cached control-plane image build.
- `/tmp/publisher-volume-acceptance.json`: two-container volume readback results.


## 2026-10-21 build classification and target handoff

Baseline: d3a1e3b037f2b711de4d0c48ede9f8afbdd68fef; publisher-unified,
with main unchanged. Default host lookup of deb.debian.org returned no address;
default Docker bridge lookup returned EAI_AGAIN. This is dependency-source DNS
failure before package download, not a missing Debian package or application test
failure. No alternative DNS, mirror, host networking, proxy override or privilege
change was attempted. The installed host tools do not constitute a compatible
Debian package cache; apt archives contain no installable packages.

The Dockerfile now uses APT::Update::Error-Mode=any so missing indexes fail at
update itself instead of continuing to misleading “Unable to locate package”
errors. This improves diagnosis; it does not repair the environment resolver.
Reproduce using the unchanged default network and official sources:

```sh
docker build --progress=plain -f Dockerfile.unified-cloud -t publisher-unified-cloud:reviewed .
```

Do not proceed to deployment until this full build passes on the existing
approved build host. Verify Python/Pillow and ffmpeg inside that exact image,
then run both synthetic workbench demos in disposable storage. Record source
SHA and immutable image ID, and retain the previous accepted image for rollback.
The cached control-only image is not a substitute for this acceptance.

### Resource inventory and minimum decision

| Requirement | Current evidence | Required existing target information |
| --- | --- | --- |
| Always-on compute | Only this temporary development environment verified | Operator identifies authorized Linux VM/container host and deployment interface |
| Persistent volume | Synthetic container recreation tested; test volume deleted | Exact dedicated volume/path, capacity, retention and backup destination |
| HTTPS | Domain exists; historical endpoint was Mac Tunnel-to-17882 | Existing independent cloud reverse proxy and approved origin mapping |
| Authentication | App supports existing access configuration; none provisioned here | Operator confirms existing mechanism already authorized for this service |
| Dependency builds | Debian DNS fails on default route | Working normal build runner or verified complete dependency cache |

Historical Mac Tunnel evidence: https://vietbridge.slack.com/archives/C0C6A5D7QAC/p1791195214706459?thread_ts=1791172648.041409&cid=C0C6A5D7QAC .
Domain registration/Cloudflare DNS alone establish no compute resource. No repeat
request to the previously CONNECT-403-denied publisher domain was made.

If no existing target is found, the user decision is whether to authorize a
specific persistent host and its ongoing cost/access scope. No purchase or new
credential is authorized by this package. Suggested starting capacity for the
control plane and small synthetic artifact workloads: Linux x86_64, 2 vCPU,
4 GiB RAM, 20 GiB persistent SSD plus separately retained backups. This is an
engineering starting estimate, not a measured production sizing guarantee;
video retention and concurrent encoding need separate sizing. Browser publishing
and the independently running Facebook session are outside this deployment.

### Deployment and recovery sequence for the original operator

1. Confirm exact host, independent volume, current backup, existing HTTPS/auth
   mechanism, approved source SHA and accepted immutable image. Keep original
   Compose project identity stable; changing it can silently select a new volume.
2. Use compose.unified-cloud.yaml with its existing secret injection mechanism.
   Review rendered configuration privately; do not print secret values into logs.
   Keep host port loopback-only and all five execution flags at zero. Do not mount
   Mac data, production sessions or another application's database.
3. Start on the approved target only after those checks. Verify unauthenticated
   401, authenticated UI/state, wrong Host rejection, local-only endpoints 409,
   disabled execution, and synthetic request/result/preview acceptance. No real
   publishing or task dispatch is part of acceptance.
4. Stop the service gracefully before a file-level backup. Copy the entire data
   directory including any SQLite WAL/SHM companions to the approved backup
   destination; preserve ownership. Never copy only a live SQLite main file.
   Record image/source SHA and a checksum manifest without exposing credentials.
5. Restore a backup into a different empty isolated volume, using the matching
   accepted image and existing authorized access mechanism. Check SQLite integrity
   and expected synthetic ledger/job IDs before declaring recovery successful.
   Test restart and eventual host reboot only on the identified authorized host;
   container recreation here does not prove host restart or multi-day uptime.
6. On failed upgrade, stop the new service; retain its volume for diagnosis and
   restore the pre-upgrade backup into an isolated replacement volume with the
   prior accepted image. Do not run an older binary against an upgraded database
   without a compatibility check. Never use compose down -v on retained data.

These are ready-to-execute operator steps, not a record of production deployment
or completed backup restoration. No permanent Publisher URL is verified.


Follow-up verification: the fail-fast full build exited 100 at apt update with
explicit DNS errors (no package installation attempted). An initial Docker client
attempt could not write its default read-only ~/.docker/buildx directory; using
an empty disposable DOCKER_CONFIG under /tmp allowed the same default-network
build without copying credentials or changing permissions. Evidence:
/tmp/publisher-cloud-build-classified.log. Default Docker DNS lookup for
registry.npmjs.org also returned EAI_AGAIN. The focused cloud entry/runtime suite
passed 5/5, including isolated restart/import idempotence, in 7.89 seconds:
/tmp/publisher-cloud-followup-tests.log. No full suite rerun was needed for this
Dockerfile error-reporting/documentation change. No service or test volume remains.

Mac follow-up is separately pending: the reported 27 failures are not a cloud
regression result. Eleven permit cases were reproduced on the older Mac baseline;
the other sixteen have no such baseline comparison. SingleExecutionPermits.consume
reads db.isTransaction directly. Here Node v24.19.0 reports false outside and true
inside BEGIN IMMEDIATE; the Mac Node/SQLite property behavior is not yet known.
This is a concrete diagnostic hypothesis, not a confirmed root cause. Preserve
atomic claim/permit consumption and UNKNOWN semantics in any compatibility fix.

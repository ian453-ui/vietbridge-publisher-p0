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

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
The new Docker build pulled the Node24 base and reached its `npm ci` step, but
produced no further output for roughly a minute and was explicitly cancelled
(exit 130). An initial attempt had failed on the read-only default Docker build
cache; a temporary Docker config directory allowed the subsequent attempt.
No finished image/container acceptance is claimed; complete it on the approved
host. This observation does not establish the cause of the npm delay.
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

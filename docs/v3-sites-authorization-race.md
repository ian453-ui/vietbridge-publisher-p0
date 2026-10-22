# Sites authorization race — reproduced and repaired

Base: `9bbddd349a478640e55b83c257e4c7f1bfa565fb`. This focused repair precedes the
async approval/preparation package; it does not add a role, grant endpoint or
identity mechanism.

## Reproduction

A deterministic barrier pauses `db.batch` after the existing `owned()/account()`
checks and asynchronous hashing/reads. A second SQLite connection commits a
membership revocation (content/task), or transfers the customer owner (account
creation), before the first request's batch begins.

All three original cases failed before the repair: HTTP 200 was returned, a command
receipt was committed, and the content/source projection, task/snapshot, or
account/membership rows increased. The expected result was HTTP 403 and unchanged
row counts. The reproduction log is `/tmp/v3-sites-authorization-race-before.log`.
This is an executed defect, not merely a static possibility.

## Repair and boundary

`authorizationGuard` now evaluates the current owner, exact workspace/account,
current user's READER membership and `revoked_at IS NULL` **inside the same SQL
batch** as each authoring write and its command receipt. Account creation checks
current workspace ownership within its batch. An assertion failure aborts the
whole transaction, maps to SCOPE_DENIED/403, and leaves no command or partial
business rows. No request field supplies the trusted user ID.

The assertion uses a named CHECK constraint in the unapplied schema-only
`0004_authorization_guard_candidate.sql`. Successful batches clear the assertion
row. Migration remains subject to official starter/Drizzle generation and actual
hosted D1 acceptance; no production database was altered.

Shared AsyncStorage also accepts a fixed server-derived authorization context.
Every batch from such a store repeats its exact authorization inside the batch.
The existing HTTP metric/Review readers pass that context; Review propagates it
to object readback state writes. Additional barrier tests prove raw metric ingest
rolls back series/observation/BLOB rows and object verification cannot commit
STAGED → READY after revocation.

Privileged inspection/collector storage interfaces without a user context remain
internal server interfaces, with no public import/ingest routes and no real
provider configured. The forthcoming approval/preparation HTTP writes must use
this fixed context in addition to the original independent administrator gate.
This does not turn Sites sign-in into administrator authority or a publishing
permit. It also does not claim a distributed D1/R2 transaction: object bytes from
an already-started operation can remain private/unreferenced, while a revoked
request cannot commit READY or its business receipt. No cleanup deletes them.

## Actual acceptance

```sh
node --test test/sites-authorization-race.test.js

PUBLISHER_TEST_BROWSER_PATH=/usr/bin/chromium \
PUBLISHER_TEST_FFMPEG_PATH=/usr/bin/ffmpeg \
node --test --test-concurrency=2 test/sites-*.test.js
```

- Before fix: **0/3**, all three expected-denial cases wrote data.
- First repair run with existing authoring/evidence tests: **25/25**.
- Final complete Sites tests: **43/43**, fail/cancel/skip 0, including five race
  cases and desktop/mobile media/metric UI.
- Scope: file SQLite/D1-shaped synthetic testing. No hosted D1, real account,
  credentials or publication was used. Full-repository regression will run with
  the following approval/preparation package; the earlier 1059 count is not a
  claim about this repair.

[Machine-readable evidence](evidence/v3-sites-authorization-race.json) records log
hashes and exact commands. Original branch, old worktrees and the existing Site
identity remain unchanged.

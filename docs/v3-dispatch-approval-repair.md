# Dispatch-time content withdrawal repair

Base `6aa7d8da8adeaa605ff4a1f857431cc30dafa882`, same V3 branch. This is a
bounded correction to slice 12, not a new feature or live-driver enablement.

The independent review was reproduced with two deterministic failures. A second
SQLite connection committed a change after the original submit intent, and after
dispatch preflight had built its statements, but before the object transaction:

| Change | Before fix | After fix |
| --- | --- | --- |
| Existing approval API records CONTENT_REJECTED | PUBLISHED | UNKNOWN, no simulated object/receipt |
| Bound canonical source head becomes QA_BLOCKED | PUBLISHED | UNKNOWN, no simulated object/receipt |

Both original cases failed (**0/2**) with `actual: PUBLISHED, expected: UNKNOWN`.
They used generated content and synthetic permits. Source QA uses the canonical
source-head schema/state with an exact Review binding; no real Drive access or
live source recognition is claimed. The log is preserved in the evidence JSON.

Previously, `AsyncSyntheticExecutor.run` rechecked execution permit/policy at
actual dispatch but rechecked content approval only at claim and submit intent.
The dispatch batch now also includes the original `subjectGuards(subject)` and
`latestGuard(review, approvedEvent)` alongside the existing permit/attempt guards
and simulated-object insert. This repeats the same exact version, account,
source-head, media/object and approval-event constraints at the side-effect
boundary, inside one transaction. A JavaScript preflight re-read alone would not
close the second-writer race demonstrated here.

On rejection, the existing recovery path retains the durable original intent as
UNKNOWN / RECONCILE_PENDING and leaves its consumed permit/quota occupied. It
neither refunds nor retries. Restart and duplicate queue delivery still reconcile
only the original attempt. No object is manufactured to make reconciliation pass.

The change deliberately does not add approval guards to observation/readback.
If the original simulated object committed *before* rejection or QA invalidation,
a restart must still be able to verify that object and settle its original claim.
Two converse regressions prove this after lost response: exactly one original
object, readback and attempt, SETTLED quota, no RELEASED event. An unchanged bound
source and approval also complete normally with duplicate delivery idempotent.

Targeted suite: **45/45**, fail/cancel/skip 0, **2.379 s** (five focused cases plus
all existing async quota and executor regressions). The complete final regression
passed **1151/1151**, fail/cancel/skip 0, in **115.869 s**. Source/log hashes and
original failure output are recorded in [evidence](evidence/v3-dispatch-approval-repair.json).

```sh
node --test test/sites-dispatch-approval.test.js \
  test/sites-execution-permits.test.js test/sites-async-synthetic-executor.test.js

PUBLISHER_TEST_BROWSER_PATH=/usr/bin/chromium \
PUBLISHER_TEST_FFMPEG_PATH=/usr/bin/ffmpeg \
node --test --test-concurrency=4 test/*.test.js
```

Self-review confirms only the dispatch batch changed; quota transitions and
readback logic were not broadened. Both changed/new JavaScript files pass syntax
checks. This is actual cloud-workspace execution against SQLite with D1-shaped
transactions, not hosted D1/R2 or live platform acceptance. A remote platform
cannot share this SQL transaction: eventual real dispatch still needs the trusted
provider/identity checks and durable UNKNOWN handling already listed in slice 12.
No credential, permission, network setting, deployment or external publication
was created or changed. Existing Sites/environment blockers are unchanged and
were not retried for this repair.

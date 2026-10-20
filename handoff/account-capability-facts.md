# Account/action capability facts — P0-D read-only diagnosis

## Why this layer exists

`publisher-platforms.js` already owns the implemented platform/transport/outcome
registry. `publisher-automation.js` describes UI/API entry points and their gates.
Neither alone proves official platform eligibility, an app approval, a particular
account's permission or a successful real acceptance test. The new diagnostic
imports the existing registry; it does not duplicate it or add platform drivers.

`src/account-capability-facts.js` and its CLI inspect explicitly supplied evidence
without networking, database access, configuration changes, claims or execution.
The existing executor and task permit checks remain the only action decision path.
There is no HTTP registration or change to authentication/CSRF/Host checks.

## Independent dimensions

| Dimension | Expected source kind | What it must establish outside this validator |
| --- | --- | --- |
| platform_support | OFFICIAL_DOCUMENTATION | Exact public capability/eligibility for this operation |
| app_approval | APP_REVIEW_RECORD | The exact app has the required approval |
| account_permission | ACCOUNT_PERMISSION_READBACK | Exact account has the needed permission |
| implementation | CODE_REVIEW | Exact build implements the exact operation |
| runtime | RUNTIME_PROBE | Current runtime and dependency are actually available |
| live_acceptance | LIVE_ACCEPTANCE | Authorized real acceptance of the exact operation |
| policy | POLICY_REVIEW | Applicable platform/data-use policy conditions are satisfied |

Each dimension reports VERIFIED, UNSUPPORTED, DENIED, UNKNOWN or NOT_VERIFIED.
Only current VERIFIED evidence can complete a dimension; missing, unknown,
not-verified, denied, future, expired or incompatible evidence blocks it. No
NOT_APPLICABLE shortcut synthesizes app permission or policy approval.

Source kinds and reported VERIFIED labels are **claims supplied by the caller**,
not proof this module authenticated the source or audited its substance. Official
references must be credential-free HTTPS URLs, but URL syntax does not establish
that the host is official. That review belongs to the original authorized auditor.
The module makes no external request and contains no hardcoded platform PASS facts.

## Exact scope and operation granularity

Every evidence item binds all of:
`workspace`, `account_id`, `platform`, `app_id`, `action`, `operation`, `transport`,
`build_sha` (40 lowercase hex). Supported action categories are prepare, publish,
readback, reply, react, insights, content_ingest. `operation` is the exact reviewed
sub-operation; generic category evidence must not substitute for a specific one.

For example, Facebook Page post versus Group post must be distinct operations;
WeChat draft write, public publication and broadcast must be distinct; TikTok
account-management eligibility is not direct-post eligibility; a share SDK is not
unattended execution; an insights permission is not permission to reuse data for
AI replies. These are scope distinctions, **not claims those operations are
supported or approved**. Await official evidence for actual capability facts.

`scope` must match the supplied `frozen_scope` in every field. Evidence for another
account, app, operation, transport or build is rejected as mismatched. Do not change
frozen transport to make a diagnostic pass. The caller must read frozen scope from
the existing trusted record; this function cannot authenticate caller JSON.

The local registry contributes platform/transport existence and the existing
publication outcome only. That outcome metadata is not an action-specific public
support assertion. Unknown platforms/transports remain blocked despite supplied
VERIFIED labels. No registry entry for a new platform is created by this package.

## Input and local CLI

```sh
node scripts/check-account-capability.mjs --help
node scripts/check-account-capability.mjs /absolute/path/to/evidence.json
```

Input keys are exactly `scope`, `frozen_scope`, `job_state`,
`submit_safety_domain`, `evidence`. Both scope objects use the fields above. Each
evidence object has exactly `dimension`, `status`, `scope`, `observed_at`,
`valid_until`, `source:{kind,reference}`. Times use canonical UTC ISO with milliseconds,
observation <= now < expiry and expiry > observation. Duplicate dimensions reject
instead of choosing the most favorable/latest record. CLI uses strict duplicate-key
JSON parsing, limits the file to1 MiB and does not echo malformed contents or paths.

Use synthetic fixtures as examples (`test/account-capability-facts.test.js`), not
real identifiers in public Git. To represent an unverified account, supply an empty
evidence array: every dimension becomes MISSING_EVIDENCE. Never fill synthetic
VERIFIED values into a real handoff or invent expiry to avoid a blocker.

Output is BLOCKED or EVIDENCE_COMPLETE with per-dimension reasons and registry
metadata. **Always** `advisory_only:true`, `can_execute:false`, `owner_changed:false`.
EVIDENCE_COMPLETE means only that declared evidence fields satisfy this contract.
It is not a permit, successful execution, authenticated ownership or live test.

UNKNOWN/RECONCILE_PENDING/submitted/existing-success states and MAY_HAVE_SUBMITTED
block prepare/publish/reply/react replay diagnosis. Readback can still be diagnosed,
but never changes the result state, resets a task, releases quota or switches mode.
Existing enterprise restrictions and discovery-only scheduler remain untouched.

## Validation

```sh
node --test test/account-capability-facts.test.js test/task-action-permit.test.js test/unified-execution-confirmation.test.js
node --check src/account-capability-facts.js
node --check scripts/check-account-capability.mjs
```

2026-10-20: **31/31 passed**, including eight new tests. Covers dimension separation,
missing permissions, UNKNOWN/NOT_VERIFIED, stale/future/malformed evidence,
source-kind mismatch, account/app/action/operation/transport/build isolation,
frozen scope, UNKNOWN/readback boundary, no inferred platform/SDK support,
draft-vs-publication mismatch, duplicate facts, strict CLI parsing, credential-bearing
URL rejection and unchanged input. Existing task permits/confirmation regressions
pass. No real accounts, evidence collection, platform activity or deployment.

This remains an advisory local contract. Official-platform review, authenticated
app/account permission checks, real acceptance and any future read-only UI adapter
are separate work. No unverified evidence is converted into platform support here.

## Final combined verification — 2026-10-20

The six P0-D files were verified on top of Metric correction
`6cd380b516e66e29e7332e97ec0df7ad65b774a9`. That separate correction binds metrics
to the real source account/business asset and expected content revision/publication
job; it is not an account-capability grant.

- P0-D, task permits, execution confirmation, MetricObservation, publication
  verifier and engagement quota together: **53/53 passed**.
- Full project suite on the final implementation: **898/898 passed**, no failures,
  cancellations or skips, 66.712 seconds.
- Syntax checks: **286/286 passed** for tracked JS/MJS/TS (excluding `.d.ts`) plus
  the three new P0-D executable/test files. `git diff --check` passed.

```sh
node --test test/account-capability-facts.test.js test/task-action-permit.test.js test/unified-execution-confirmation.test.js test/metric-observation.test.js test/publication-verifier.test.js test/engagement-quota.test.js
PUBLISHER_TEST_BROWSER_PATH=/usr/bin/chromium PUBLISHER_TEST_FFMPEG_PATH=/usr/bin/ffmpeg npm test -- --test-concurrency=4
```

Local test evidence, not committed raw logs:
- `/tmp/publisher-p0d-metric-final.log`, SHA256 `0df474d0a0e1f154cabf6f74e11e1097b125797fc4b82734164d5d2edc73c3e3`.
- `/tmp/publisher-p0d-full-final.log`, SHA256 `c305141900d48fadf0af1afefc56353e6e5990db7401125da439f306db63d583`.

These are synthetic/local regression results, not live platform acceptance.
No image rebuild, deployment, production scheduler, account probe or real media
publication was performed. No authentication, CSRF or Host gate was changed.

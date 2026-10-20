# Offline/cloud continuation readiness

## Existing contracts and the smallest gap

- `scan-scheduler.js` is discovery only. This addition neither calls nor changes it.
- `unified-executor.js`, task permits and registered account/batch ownership already
  protect real actions, replay and uncertain outcomes. They remain authoritative.
- `unified-cloud-deployment.md` specifies exact Git synchronization and preservation
  of Mac data/configuration, but previously offered no executable prerequisite check.
- Platform/browser diagnostics require their own local observations. They do not
  answer whether unrelated cloud code review/build/test must wait for Mac.

This package adds a pure diagnostic function and a local CLI, not a task queue,
owner registry, scheduler, publication fallback, database migration or new service.
Repository code/docs had no equivalent continuation checker. GitHub issue-list
query returned `Forbidden`; issue-level deduplication could not be completed and
was not retried through another access path.

## Usage and input contract

Run from the existing Publisher checkout:

```sh
node scripts/check-continuation.mjs /absolute/path/to/continuation-evidence.json
```

The CLI observes only local Git origin, branch, HEAD and clean/dirty status. Repository identity accepts the exact `ian453-ui/vietbridge-publisher-p0`
path at `github.com` via HTTPS, `git@github.com:owner/repo` or
`ssh://git@github.com/owner/repo`, with an optional `.git` suffix. Host aliases,
other owners/repositories, URL credentials, ports, queries and extra paths are
rejected. This transport normalization grants no additional authority. It does
not fetch, pull, switch branches, contact Mac, read databases or open a browser.
Place the evidence JSON outside the working tree; do not include secrets or
customer content. Example shape (replace placeholders with known evidence):

```json
{
  "version": 1,
  "originalOwner": "original-task-owner",
  "currentOwner": "original-task-owner",
  "targetCommit": "FULL_40_CHARACTER_REVIEWED_COMMIT_SHA",
  "workspace": "workspace-id",
  "accountId": "account-id",
  "mac": {
    "online": false,
    "observedAt": "ACTUAL_ISO_TIMESTAMP",
    "validUntil": "EXPLICIT_EVIDENCE_EXPIRY_ISO_TIMESTAMP",
    "worktreeClean": false,
    "preserveDataAndConfig": false,
    "commit": "ACTUALLY_OBSERVED_MAC_COMMIT",
    "localDependenciesVerified": false
  },
  "history": {
    "complete": false,
    "observedAt": "ACTUAL_ISO_TIMESTAMP",
    "validUntil": "EXPLICIT_EVIDENCE_EXPIRY_ISO_TIMESTAMP",
    "jobs": []
  }
}
```

A history item uses `{workspace, accountId, state, submitSafetyDomain,
preparationEffectsMayRemain}`; the final two fields carry known safety evidence.
This is a curated diagnostic snapshot, not a live ledger. Missing/stale evidence
is reported, not filled with assumed success. Caller-supplied owner, Mac and
history evidence is not authenticated authority; the checker cannot establish
real owner identity or prove a history export complete. It does not read or
modify conversation ownership. Delegation continues under the original owner;
changing the owner field cannot transfer any task.

## Decision contract

| Step | Checks | Mac offline |
| --- | --- | --- |
| Cloud review/build/test | Same reported owner; exact repository, publisher-unified branch and target SHA; clean tree | Does not block |
| Manual Mac sync | Cloud/source checks plus fresh online observation, clean local tree and explicit data/config preservation | Blocks |
| Mac local verification | Manual-sync checks plus matching target SHA and verified local prerequisites | Blocks |
| Publication | Always blocked by this tool; adds history/scope/replay reasons | Never authorizes fallback |

`CHECKABLE` only means the supplied prerequisites allow a person to review that
step; it is not execution or deployment permission. All decisions are advisory.
A Mac on an older SHA can be ready for manual sync but not local verification.
Unknown/RECONCILE_PENDING/submitted/completed records and remaining preparation
side effects produce `EXISTING_OR_UNCERTAIN_RESULT_NO_REPLAY`. Empty history never
removes the existing-publication-confirmation requirement. Original APIs, safety
checks and user confirmations remain necessary regardless of diagnostic output.
Old data, browser configuration, owner and scheduler are never changed.

## Validation and limits

```sh
node --test test/continuation-readiness.test.js test/task-action-permit.test.js test/publisher-integration.test.js
node --check src/continuation-readiness.js
node --check scripts/check-continuation.mjs
```

2026-10-20: **38/38 passed**, including seven new pure/CLI checks plus existing
permit/account-isolation/history regressions. Synthetic evidence demonstrates
Mac-offline independence, owner mismatch, source mismatch, expired observations,
separate sync/verify requirements, uncertain/completed result blocking and
wrong-account rejection. CLI tests verify unchanged Git status and no echo of
extra input secrets or malformed JSON content. No live database or platform used.
The earlier 855-test suite was not rerun for this isolated addition.

Current owner continuity is based on the delegated task history; local agent
inventory showed only the active owner-side worker, and the checkout was clean
at the verified remote base `9cdaf2513eb48f51438dab639cabf3a045f8059e`.
This cannot prove no external machine will write later; normal non-force push
and remote readback are required. The CLI deliberately does not claim remote
freshness: fetch/identity review belongs to the original handoff workflow.

## Discoverable handoff workflow and human-readable diagnostics

```sh
npm run check:continuation -- --help
npm run check:continuation -- --text /absolute/path/to/evidence.json
# Existing JSON consumers keep their original output mode:
npm run check:continuation -- /absolute/path/to/evidence.json
```

The README now links this workflow. The web application's existing diagnostics
are account/job/browser observations; attaching arbitrary local Git/owner evidence
to those APIs would mix contracts. No HTTP endpoint, authentication change or UI
upload is introduced. This is a repository handoff capability, not a change to
the agent harness or proof that caller-supplied owner evidence is authoritative.

For a Mac-offline review, the minimal input can omit unavailable Mac/history
observations entirely. Create a file outside the checkout with `version:1`,
`originalOwner`, `currentOwner`, and `targetCommit` (the reviewed full SHA).
For example, start from this deliberately incomplete object and replace the
owner and commit placeholders with verified values:

```json
{"version":1,"originalOwner":"original-owner","currentOwner":"original-owner","targetCommit":"REPLACE_WITH_REVIEWED_FULL_SHA"}
```

Do not invent an online timestamp, empty-complete history or data-preservation
confirmation merely to make a check pass. With a clean exact source checkout,
missing Mac/history observations leave the independent cloud review step
checkable while Mac steps/publication remain blocked. The example as printed
also blocks source checks because its SHA is intentionally not valid.

The JSON adds `evidence.mac` and `evidence.history` without removing existing
step statuses/reason codes. Text output translates both evidence and next actions:

| Evidence code | Meaning / response |
| --- | --- |
| MISSING | No observation supplied; retain the gap rather than inventing one |
| INVALID_TIME_RANGE | Missing/unparseable dates or expiry at/before observation; correct evidence |
| FUTURE_OBSERVATION | Observation is in the future; check clock/source before relying on it |
| EXPIRED | Validity ended; obtain a fresh authorized observation when possible |
| FRESH | Within caller-declared validity; not independent authentication |

CLI usage/read/JSON/Git/version errors now explain the failing stage without
echoing file paths, raw JSON, credentials or child-process stderr. Exit 1 means
no valid report was produced. Exit 0 means a report was produced, **not** that
all steps passed: examine each status. `CHECKABLE` means only that a human can
review the step, never that it ran. Publication always remains blocked.

## Reusable lessons from observed failures

- The initial exact-origin comparison rejected standard SSH for the same repo.
  HTTPS/SCP-style SSH/SSH URL positive tests and wrong-host/owner/repo negative
  tests now guard identity normalization; do not loosen it into arbitrary URL matching.
- A single generic CLI error made malformed input and missing files indistinguishable.
  Stage-specific sanitized messages plus CLI tests now cover those failures.
- A combined missing/expired reason concealed the action needed from the operator.
  Separate evidence codes/text now distinguish missing, malformed, future and
  expired observations. They do not let a stale Mac observation block cloud work.
- Browser/platform diagnostics cannot substitute for repository handoff evidence;
  reuse the right contract rather than adding a new scheduler or publishing fallback.

Final targeted validation for this extension: **41/41 passed** using the existing
continuation/permit/publisher-integration command above. New coverage includes
human-readable evidence explanations, help outside a repository, missing files,
malformed JSON, text-mode invocation and secret non-echo. Synthetic inputs only;
no live accounts, media, databases or deployment. Prior image acceptance and
unrelated full-suite results were not rerun or relabeled as this extension's tests.

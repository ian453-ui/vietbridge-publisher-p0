# MetricObservation — local evidence contract (P0-C)

## Position in the existing architecture

Baseline `25917a3655c76ed4b9d12772fa7120ff72907736`. Existing `store.js` records
published posts/comments and observations; `publication-verifier.js` reports
publication evidence; engagement quota is an action budget. None is a universal
analytics ledger with metric definitions, availability and reporting windows.
This module therefore does not reinterpret those tables or migrate them.

`src/metric-observation.js` supplies pure validation, in-memory evidence import /
deduplication, as-of selection and conservative count aggregation. It has no DB,
network, file reader/writer, collector, scheduler, HTTP route or platform operation.
Only explicitly supplied synthetic/local evidence is inspected by callers. No
live account identifiers, private statistics or screenshots are in the repository.

## APIs

```js
validateMetricObservation(observation, {binding, evidenceBytes, now});
inspectMetricEvidence([{observation, binding, evidenceBytes}], {now, asOf});
aggregateMetricEvidence([{observation, binding, evidenceBytes}], {now, asOf});
```

`evidenceBytes` is a nonempty Buffer, at most 5 MiB, whose SHA256 must match source.
Every import revalidates its entries. The caller supplies the exact expected
workspace/account/platform/object, content_revision/publication_job_id, source reference/transport and separate
operator actor, business asset, source account and source object identifiers.
Reported profile and business-asset IDs are never substituted or required equal.
If a required identity or publication mapping is unknown, this first version
rejects it; do not invent a value to pass. Unmapped content collection is deferred.

This check compares supplied identity evidence with the expected binding; it
cannot authenticate a caller or semantically prove that screenshot text belongs
to an account. A valid hash proves bytes matched, not that the platform reported
truth. Existing authenticated collection and human identity review must supply
trustworthy bindings in any later integration. No new authority is established.

## Observation v1 fields

| Field | Required meaning |
| --- | --- |
| schema_version | `1` |
| workspace/account_id/platform/object_id | Exact scoped source object, no name-based matching |
| content_revision/publication_job_id | Explicit immutable publication linkage; nonempty strings |
| observed_at | Canonical UTC ISO with milliseconds; not future |
| source | transport (`BROWSER_READBACK`, `API_READBACK`, `MANUAL_EXPORT`), reference, sha256 |
| window | kind (`BOUNDED` or `UNKNOWN`), start/end and timezone |
| metric | name, definition_id, definition_version, definition_text, value, unit, availability |
| coverage | scope=`OBJECT`, completeness=`COMPLETE`, `PARTIAL` or `UNKNOWN` |
| identity_evidence | operator_actor_id, business_asset_id, source_account_id, source_object_id, verified_at, method, reference |

Identity method is declared `AUTHENTICATED_UI`, `AUTHENTICATED_API` or
`MANUAL_REVIEW`; the enum does not itself authenticate anything. Identity evidence
must not postdate the observation. Expected source reference and transport must
also match, preventing accidental cross-source substitution.

BOUNDED windows require canonical start/end, start < end <= observed_at. Timezone
must be a valid explicit IANA name or null when unknown. UNKNOWN requires all
three window details null; no implicit local timezone, rolling period or lifetime
interpretation. Lifetime/other window semantics are not implemented in v1.

Supported names are `views`, `viewers`, `reach`, `impressions`, `engagements`,
`link_clicks`; they are separate keys, not aliases. Definition text/version must
be explicit; this library does not supply platform meanings or infer one from a
UI label. V1 supports safe nonnegative integer `count` only, not rates/currency.

Availability is exactly:
`AVAILABLE`, `UNAVAILABLE`, `NOT_SUPPORTED`, `PERMISSION_DENIED`,
`INSUFFICIENT_DATA`, `NOT_COLLECTED`.
Only AVAILABLE accepts a numeric value (including genuine zero). Every other
status requires **null**. A UI unavailable field must never become a numeric zero.

## History and aggregation semantics

- Canonical data produces a stable observation_id; exact duplicates count once.
- Same account/object/revision/job/definition/window/observed_at with differing
  value or provenance is a conflict, not silent last-write-wins.
- Distinct later observations remain in history. As-of chooses the latest record
  at/before the requested timestamp per series, even when its value is lower or
  newly unavailable. It does not take max, sum snapshots or fall back to old values.
- Aggregation requires same workspace/account/platform and real source-account/business-asset target, **exact name and definition**,
  unit and exact window including timezone. Unknown window/timezone, incomplete
  coverage or any unavailable value gives NOT_AGGREGATED and null.
- Viewers/reach are conservatively non-additive across objects; no audience total
  is invented. Mixing two content/job revisions of the same object also blocks.
- Successful sums cover `OBSERVED_OBJECTS_ONLY`, with object_count and the exact
  observation_ids; they do not claim full account coverage. Different observed_at
  timestamps remain visible in the as-of report. Integer overflow is rejected.
- This is an in-memory contract, not durable or concurrent exactly-once storage.
  No real history is rewritten and no receipt is treated as a publication ledger.

## Reproducible evidence and boundaries

```sh
node --test test/metric-observation.test.js test/publication-verifier.test.js test/engagement-quota.test.js
node --check src/metric-observation.js
```

2026-10-20: **20/20 pass**, including 10 new metric tests. Tests use synthetic
object/actor/asset IDs and generated bytes, never copied real account metrics.
Coverage: identity distinction, scope/source/hash mismatch, six availability
states, actual zero vs missing, unknown window/timezone, invalid/future dates,
duplicate/conflicting snapshots, down-revision and as-of read, no stale fallback
when newer data is unavailable, incompatible definitions/windows, non-additive
audience, cross-account/platform separation and integer overflow. Existing
publication-verifier and engagement-quota regressions remain green.

No external collection, new permissions, production DB schema/import, platform
certification, publishing or deployment was run. The separate content-contract
review remains independent. Next integration requires an authorized collector
and exact trusted binding, then an existing durable ledger transaction design;
this slice does not create either automatically.


## Independent-review identity corrections

Two synthetic counterexamples exposed gaps in the initial pure contract: local
account equality alone could sum two distinct platform targets, and job/revision
strings were not compared to an expected mapping. Both are now fail-closed.

`binding` must include exact `content_revision` and `publication_job_id`; an absent
mapping or differing value rejects rather than claiming attributed metrics. The
caller still must establish that mapping independently; this validator does not
query or authenticate a ledger. Both snapshot series and aggregate compatibility
include `source_account_id` and `business_asset_id`. Operator actor remains a
separate audit identity, may differ between observations and is not equated to
the target asset. Original distinct observations remain retained.

After correction: **22/22 related tests pass**, including 12 metric tests. New
counterexamples cover same-local-account/different-platform-target sums, separate
same-object target snapshots, valid same-target/different-operator counts and
arbitrary/missing publication mapping rejection. Production analytics is still
not integrated or certified.

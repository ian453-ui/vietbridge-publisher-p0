# Same source → independent platform text revisions

2026-10-22; bounded follow-up from `d634567` on `publisher-v3/cloud-slice-01`.
This package changes the existing Sites content tab and immutable content store.
It does not deploy the saved private Site `appgprj_6ad97a034fd08191a8399eeda10f048c`,
enable a real provider or alter a native V1/V2 entry point.

## Verified inheritance and concrete change

The actual V1 `fe9b7ad` `src/web-ui.ts:12,13,37` provides explicit platform choice
and complete preview. Actual V2 `85e987a` `src/unified-publisher.js:124–181`
imports immutable `platform_payloads` and freezes per-platform task overrides.
Neither proves that the previous Sites console already had an independent editor.
At this package's baseline it only created a row for the current account platform;
the new variant route returned 404. V2's client fallback (`variant || content`) is
deliberately not inherited: a missing platform draft stays missing.

The existing content card now opens a platform selector with complete title/body.
Each platform can be saved as a new immutable content revision. The server copies
all other variants and non-text fields from the stored row; clients cannot submit
a replacement variants object or media list. Full original body, full content ID,
slug, source account and source/media lineage remain bound. No abbreviated number
is used as source identity.

`GET/POST /api/sites/workspaces/:workspace/contents/:id/variants?accountId=:viewer`
reuse the existing trusted identity, active owner/membership guards and authoring
command ledger. POST accepts exactly `command_id`, `expected_payload_hash`,
`expected_source_binding`, `platform`, `title`, `body`. The platform must be an own
key in the existing platform policy. Source/viewer authorization, exact source
row, latest family revision, lineage, approval event and media state are checked
again inside the atomic batch. No execution permission is created.

The new candidate migration `0009_variant_edits_candidate.sql` records immutable
parent/source lineage and Review edit invalidations. It is tested in the local
D1-shaped fixture, not applied to hosted D1. Saving two platforms from the same
base concurrently permits one winner; the other gets a conflict. The user must
explicitly read the new base, retain their unsaved text and save again. This
prevents a successful later save from erasing the first platform's work.

Unsaved drafts are page-memory only, keyed by workspace, viewer account, root
content and platform. Switching preserves those drafts; a page reload does not.
Late read/save callbacks cannot overwrite another scope's form. Rebase and save
are mutually exclusive even for keyboard/programmatic submit. An uncertain save
keeps its original source row, command and payload, locks edits and offers an
explicit receipt retry; it never auto-retries.

## Reviewed media, invalidation and historical facts

An already reviewed plan supports text editing on its **existing plan platform**.
Its original media manifest/hash and root Review binding are inherited as
provenance, not as approval. A change atomically records a persistent invalidation
and a REVOKED event. Further edits retain that lineage; they cannot be downgraded
through the generic manual-task freeze route. A new approval on the old snapshot
is blocked. Dependent target-account Reviews also fail their original-source
guard; the original frozen jobs/media are never overwritten.

Manual sources support all four explicit platform drafts. Translating an inspected
media source into a different platform or accepting an edited platform payload
through fresh inspection/Review is still missing integration. The UI labels edited
media as needing fresh inspection; it can preview the old bytes for comparison
but cannot turn them into an approved edited draft. This is a code/workflow gap,
not merely a missing deployment or token.

Historical command receipts are checked after current scope and command binding,
before current freshness. A prior approval or preparation remains a committed
historical fact after text changes, with the current REVOKED/STALE_PREVIEW state.
No new approval or frozen job is created by retrying that command. A submission
already at UNKNOWN retains its exact attempt and quota. Editing before actual
dispatch prevents a new simulated object; editing after a committed submit still
allows reconciliation of the old object. Neither releases UNKNOWN quota nor
permits replay. The real driver remains disabled.

## Executed cases and failure evidence

[Execution record](evidence/v3-platform-variant-edits-evidence.json) contains actual
commands, counts, failure logs and screenshot hashes. Implementer executed all
tests; Astra performed read-only reviews and did not independently rerun them.

Final executed results: **69/69 targeted** and **1253/1253 full regression**, with
zero failures, cancellations or skips. After a transport disconnect, the original
workspace recovered; the complete session-6874 log established the targeted
result, so that run was not duplicated. The final full suite ran after confirming
no test process remained. Earlier 68/68 and 1252/1252 runs predate the last two UI
repairs and are not the final acceptance result.

| Case | Before / after evidence or verified invariant |
| --- | --- |
| Missing editor API | Baseline GET returned 404 OPERATION_UNAVAILABLE; now explicit source/variant read and immutable single-platform save |
| Prototype platform names | First implementation accepted `__proto__` and created a meaningless revision; own-key validation now rejects it, `constructor` and `toString` without writes |
| Historical approval/preparation | Earlier ordering hid the committed receipt behind edit invalidation; same commands now return the original fact plus revoked/stale state |
| Rebase/save race | Held rebase GET allowed one POST before fix; now zero, including requestSubmit; later lost reply retries identical URL/payload and leaves one revision |
| Returning to a pending draft | Leaving and returning before a save reply left its own fields locked; now completion unlocks only that exact draft, retaining the other platform's unsaved text |
| Mobile long source ID | Screenshot exposed a 531px-wide document at a 390px viewport; source label now wraps and a whole-document width assertion prevents regression |
| Independent copy | Facebook edit preserves XHS and full original body; absent Channels draft is blank/no fallback; explicit conflict/rebase preserves both edits |
| Scope and revocation | Another customer denied; source/viewer membership withdrawn before batch rolls everything back; revoked scope cannot read a duplicate receipt |
| Version and media | Source body/variant/hash changes and late lineage changes rejected; wrong binding rejected; CORRUPT object blocks reviewed edit; edit-of-edit retains original media |
| Atomicity/restart | Two connections converge on one command; different commands conflict; injected SQL fault rolls back; commit-ack loss and restart recover committed receipt |
| Approval/target | Source edit revokes current approval and blocks old reapproval; independently approved target becomes invalid; original target-creation receipt remains readable |
| UNKNOWN | Edit before dispatch leaves UNKNOWN/occupied quota/no object; after actual synthetic submit restart settles the one original object, with no release/replay |
| Browser | Desktop 1440×1000/mobile 390×844: edit/switch/save/conflict/rebase/full preview; account/customer draft isolation, held old responses, media preview and reload/freeze denial |

Reproduce the bounded workflow in this cloud workspace (loopback and synthetic
identities only):

```sh
PUBLISHER_TEST_BROWSER_PATH=/usr/bin/chromium PUBLISHER_TEST_FFMPEG_PATH=/usr/bin/ffmpeg \
  node --test test/sites-variant-edits.test.js test/sites-async-approval.test.js \
  test/sites-async-upload-plans.test.js test/sites-cloud-console-ui.test.js
PUBLISHER_TEST_BROWSER_PATH=/usr/bin/chromium PUBLISHER_TEST_FFMPEG_PATH=/usr/bin/ffmpeg \
  node --test --test-concurrency=4 test/*.test.js
```

Screenshots use generated content and Chromium viewport emulation, not a physical
phone, Safari, hosted Sites or a real account. They are kept in the cloud workspace
at `/workspace/sites/publisher-v3/variant-edit-evidence-20261022/` with hashes in
the execution record. No user media bytes are committed.

The next useful code package is a fresh inspection/Review handoff for edited
platform payloads using the existing request/result pipeline, with no approval
copy. Original bulk selection/file replacement remains another inheritance gap.
Official Sites runtime identity/storage, cloud heavy inspection and trusted real
source/admin/permit/upload/readback providers remain unverified/unconnected. No
blocked download or real platform operation was attempted in this package.

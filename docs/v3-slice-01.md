# V3 slice 01 — video validation and durable production review

New branch `publisher-v3/cloud-slice-01`, based on verified `4455a4b`.
Architecture, inherited capability matrix, source/license research and archive
acceptance plan: [PRD](v3-prd.md). This is a usable development slice, not the
complete V3 operating chain or a production deployment.

## Reproduce in this new cloud workspace

Prerequisites: locked npm dependencies, Node >=23.6 (tested 24.19.0), existing
Python/Pillow image validator, ffprobe/ffmpeg. No additional project or platform
credentials are needed for the synthetic demo.

```sh
npm ci --cache /tmp/publisher-v3-npm-cache --ignore-scripts --no-audit --no-fund
node scripts/v3-review-demo.mjs /tmp/my-new-v3-demo
node scripts/v3-review-local.mjs /tmp/my-new-v3-demo
```

The last command prints a loopback URL with a random port. Select **Synthetic V3
customer → 制作审核 → SYNTHETIC-MULTI-CONTENT-DEMO**. Read the complete two
knowledge articles, independent platform text, script/SRT, images and actual
video. Other V1/V2 Tabs remain available. The second synthetic customer has a
separate account and no review records. Stop/restart against the same directory
to verify persistence. Original artifact paths can change without altering the
stored snapshot. The demo refuses an existing output directory and starts no
browser profile, background scan or social publisher.

Explicit local intake of another already scoped request into an existing
isolated unified database:

```sh
node scripts/production-review-intake.mjs --db /tmp/my-new-v3-demo/publisher-unified.sqlite --request /tmp/my-new-v3-demo/request.json --result /tmp/my-new-v3-demo/result.json --root /tmp/my-new-v3-demo/production/artifacts
```

The repeated packet returns DUPLICATE while it is still valid. Expired envelopes
are not renewed; this intake command revalidates rather than using a stale receipt.
The API accepts no file-system path or ingestion mutation. The real cloud entry
continues to require its existing PublisherAccess login. No new token scope or
credential was added. The original maintenance wrapper stays unchanged; its UI
states that the new Review API is unavailable under that maintenance policy.

## Implemented behavior

* Actual hashed bytes are copied into a private temporary snapshot and probed,
  then all audio/video streams are decoded to EOF with finite limits. Missing
  tools and any decode failure reject. No partial-duration success is possible.
* Review receipt + exact media bytes are stored in one SQLite transaction in
  additive `production_reviews` / `production_review_assets` tables. No existing
  production database has been migrated by this task. Stored media hashes are
  rechecked on read. Inspection total is bounded to 128 MiB; lists to 100 records.
* Task owner, original thread, request revision, project and account cannot be
  silently reassigned. Repeated identical packets do not duplicate records;
  conflicting same-version results reject. Account lookup is server-side.
* The new Tab reads complete text/images/video for the selected customer/account
  and discards detached asynchronous responses after context switches. Text is
  rendered as text; media uses authenticated same-origin endpoints.
* Every record remains REVIEW_REQUIRED. No approval button, import, READY state,
  job creation, publishing or interaction is added. Existing original-source and
  enterprise Review restrictions still decide any later approval.

## Executed acceptance (2026-10-22 UTC)

All platform
identities/content used by new tests are synthetic. Tests that exercise original
submit paths use their existing mock drivers; they are not live platform proof.

| Case | Evidence / expected behavior |
| --- | --- |
| Original invalid MP4 | New assertion failed on baseline because packaging accepted it; now fails before review persistence |
| Actual MP4 + audio, truncated media, audio-only, wrong container, missing decoder | `test/video-validation.test.js` uses real ffprobe/ffmpeg |
| Restart, duplicate, conflict, exact-media snapshot, storage corruption | `test/production-review.test.js`; independent SQLite reopen |
| Cross-workspace/account read and reassignment | Denied; legitimate second customer remains empty |
| HTTP authentication / writes | Existing auth required; app-token scopes unchanged; all new API mutations return 405 |
| Actual browser journey | `test/production-review-ui.test.js` launches system Chromium, plays synthetic video to end, verifies original Tabs and customer switch; external network requests blocked |
| Maintenance regression | First full run caught 6 failures from a new static module outside the original allowlist; UI moved into existing module, wrapper/permissions unchanged; focused rerun 9/9 |
| Full inherited regressions | See final results below; do not substitute historical 934/934 |

Actual runs in this new environment:

```sh
# 20/20 passed, 0 failed/skipped (6.804 seconds)
node --test test/production-review.test.js test/production-artifact-contract.test.js test/video-validation.test.js
# 1/1 passed: real Chromium synthetic playback, 6.276 seconds
PUBLISHER_TEST_BROWSER_PATH=/usr/bin/chromium V3_REVIEW_SCREENSHOT=/tmp/publisher-v3-review-final.png node --test test/production-review-ui.test.js
# 943/943 passed, 0 failed/cancelled/skipped, 59.734 seconds
PUBLISHER_TEST_BROWSER_PATH=/usr/bin/chromium PUBLISHER_TEST_FFMPEG_PATH=/usr/bin/ffmpeg node --test --test-concurrency=4 test/*.test.js
# Final empty-context UI guard and original maintenance UI: 4/4, 0 failed/skipped
PUBLISHER_TEST_BROWSER_PATH=/usr/bin/chromium node --test test/production-review-ui.test.js test/browser-reopen-ui.test.js
```

The first full run was 936/942 with six maintenance UI failures; they were fixed
by packaging the new UI inside the already served module, without changing the
maintenance allowlist. A subsequent run was 942/943 because the new test counted
navigation during a legitimate workspace loading render; it now waits for that
render to complete. Final full run above is 943/943. No previous test report is
reused. Local intake CLI was separately executed and returned DUPLICATE with
`publish_allowed:false` and `import_allowed:false`.

Node v24.19.0, ffmpeg/ffprobe 7.1.5; 305 tracked/new JS/MJS/TS syntax checks passed
(declaration files excluded), and `git diff --check` passed. Committed synthetic
UI evidence: [screenshot](evidence/v3-review-synthetic.png). Local raw evidence:

| File | SHA256 |
| --- | --- |
| `/tmp/publisher-v3-video-red.log` | `36d87f96d1513f37fa3527a543dce2dd3e17a946f277a03e5316548544222328` |
| `/tmp/publisher-v3-final-targeted.log` | `b76f81f4b91759a494aa87eb35d1a276d16ce050ea5b93d47faeffba47ae15df` |
| `/tmp/publisher-v3-ui-final.log` | `c8d052b8d44fa5110048073064262be079d9e2bd3ce6dd6b36f04b86502dd164` |
| `/tmp/publisher-v3-accepted-full.log` | `494d61976aeb2ab832a0c71af440c2fe5e04f98522f00426354c76fb2b4b4326` |
| `/tmp/publisher-v3-final-ui-guard.log` | `109133ed04b8e9c0ee35daad4bac877a0439e9cf3885d77bd901e076c43d1c63` |
| Screenshot | `9a0a797f6d673a7a791580e42a0f30cfdab35f4646c014cdba5d4cc1dbd9cfd1` |

## Remaining work

Archive Asset Resolver has a complete design and adversarial acceptance-case
matrix in the PRD, but no ZIP implementation/test execution in this package.
No Drive download, share change, reference migration or deletion was attempted.
The next package should implement and run those synthetic ZIP cases first.

MetricObservation still has no durable collector/metric ledger. Production review
is durable, but is not metrics storage. Producer-authenticated transport and
revision-bound human approval submission remain pending; this UI only previews
pending results. General image/video semantics and subtitle alignment remain
human QA; the browser test certifies only its particular synthetic MP4 on system
Chromium. Actual customer assets, real accounts, external publishing, Groups,
Inbox and metric collection remain LIVE_UNVERIFIED in this new environment.

No production service, Mac process, existing branch, security configuration,
sharing permission or real platform credential was changed. No PR was merged.

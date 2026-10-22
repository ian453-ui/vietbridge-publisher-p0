# Retained client library QA withdrawal repair

Base: slice 10 `653cecb327958140c590151ae317951173851272`.
Same V3 branch, no original branch change, external action or deployment.

The full-chain inheritance audit found another concrete gap in the **existing**
client manifest paths, separate from the new canonical importer. GroupLibrary's
client catalogue and ContentLibrary's client projection checked `status: READY`
but ignored `qa_status`. Both therefore kept a synthetic 062 item available after
its latest QA changed from PASS to MOBILE_READABILITY_RETEST_PENDING. The title
and image filename still contained QA_PASS. The reproduction returned
`[true, 'READY']` instead of `[false, 'BLOCKED']` before the fix.

A shared pure `clientManifestQa` now rejects any explicit manifest/item QA other
than PASS. Pending/unknown become UNKNOWN media QA; FAIL stays FAIL. The explicit
QA state also participates in each path's version fingerprint, so a previous
selection cannot silently import a changed QA version. A withdrawn candidate
cannot generate a new public platform-copy file. Existing frozen copies and jobs
are retained, and no job is reset/retried by catalogue reading.

Legacy manifests without QA fields retain their existing READY-based behavior;
this is compatibility, not a claim that those files have new QA evidence. Both
manifest-level and item-level withdrawal override a PASS elsewhere. This small
repair does not claim retrospective cancellation of every old publication job:
existing per-task approval/source revalidation remains a separate gate.

The deterministic original-path regression uses the real native catalogue/import
classes. It proves both failures before the fix, both blocked after, changed
version, UNKNOWN/FAIL media status and rejection of the old import selection.
Related library/GPT/source-approval tests passed **76/76**. Final complete
regression passed **1114/1114**, fail/cancel/skip 0, **108.301 seconds**. Four
changed/new JS/TS files passed syntax checks and `git diff --check` passed.
Actual log hashes and before/after evidence are in [evidence](evidence/v3-client-qa-repair.json).
All fixtures are synthetic. Neither the real 062 inventory nor any user account
was read or changed, and no platform request was sent.

```sh
PUBLISHER_TEST_BROWSER_PATH=/usr/bin/chromium \
PUBLISHER_TEST_FFMPEG_PATH=/usr/bin/ffmpeg \
node --test --test-concurrency=4 test/*.test.js
```

This is a value-prioritized inheritance repair, not another standalone demo or a
hosting workaround. Formal Sites delivery is still blocked at official tooling;
real source transport, cloud media execution, live authorization/uploader/readback,
interactions and metric-driven production remain in the whole-product matrix.

# Publisher V3 batch-selection recovery — 2026-10-22

This resumes the existing `ian453-ui/vietbridge-publisher-p0` repository on
`publisher-v3/cloud-slice-01`. The selected replacement cloud instance executed
`pwd` and `git status` successfully. The existing checkout initially held clean
branch `work` at `fe9b7ad05351001fb2cef6adb7f689ebc5c5cce1`; it was switched to the
fetched original V3 branch, whose remote head was still
`f6c61d3ab45c392ad31677f0d44c64c795bcaa6c`. No reset or replacement project was used.

## Recovery integrity

The [rescue Page](https://chatgpt.com/space/page_756d60e140d48191b54d6e2c0bcd3963)
was read in full using the Page tool. Its eleven complete diff blocks were
concatenated in order, retaining LF endings (including nested Markdown fences).
The resulting patch SHA256 was exactly
`6bcb3d1fb83db51dd33f68724251fb0372948501f71fa0357c853a97f34e9d7d`.
`git apply --check` passed before applying it to the verified clean baseline.

All eleven recovered files initially matched both the Page's recovered SHA256
and its historical decoded character counts. All six core code/test files remain
byte-identical to those recovered versions. The recovered batch-selection
handoff now has a recovery note distinguishing prior evidence from current runs.
[Source manifest](evidence/v3-batch-recovery-20261022-source.json) records the
recovered hashes and exact missing files. These are rescued-content hashes,
not hashes retrieved from the lost original evidence JSON.

## Preserved gaps

The following original files remain absent; no current run is substituted for
their original bytes:

* `docs/evidence/v3-batch-api-final.log`
* `docs/evidence/v3-batch-before.log`
* `docs/evidence/v3-batch-focused.log`
* `docs/evidence/v3-batch-full.log`
* `docs/evidence/v3-batch-race-before.log`
* `docs/evidence/v3-batch-selection-evidence.json`

The original four screenshots and their dynamic hashes remain unavailable.
`docs/evidence/v3-batch-race-after.log` is the one complete historical log rescued
from the Page. The old seventeen-file tree
`aefa47d9941ebe0844bb5c92afda6e22e3980455` has not been reconstructed or claimed.
The old 1327-test report is historical context only.

## Current validation and scope

No applicable `AGENTS.md` was present in the repository or workspace; the
workspace `.agents` and `.codex` directories were empty. The repository's
`skills/publisher-browser/SKILL.md` was reviewed: it governs authenticated live
browser operations, which this recovery does not perform. README requirements
for Node, locked dependencies, explicit browser/media paths and isolated fixtures
were followed. Dependencies were installed with
`npm ci --ignore-scripts --no-audit --no-fund --cache /tmp/vietbridge-npm-cache`.

Runtime: Node 24.19.0, npm 11.9.0, Chromium 154.0.8037.57, ffmpeg 7.1.5 and
Python 3.12.14. Both changed JavaScript modules passed `node --check`;
`git diff --check` passed. Tests use temporary synthetic databases, controlled
loopback services and mocked providers; browser fixtures reject outside requests.
This does not establish hosted D1/R2, real identity or real-platform acceptance.

The restored package keeps selection bounded to twenty exact content versions
within one customer, explicit platform/account, per-item advisory preflight and
original atomic DRAFT freezing. Independent review/revocation, immutable command
receipts, UNKNOWN reconciliation and scope-change callback isolation remain
covered by tests. No batch publication endpoint is added. File replacement,
cross-platform media editing and catalogue pagination remain outside this package.

New logs and JSON manifests use `v3-batch-recovery-20261022-*` names. The focused
run also generated fresh screenshots; four batch-specific desktop/mobile images
are archived under `evidence/v3-batch-recovery-20261022/` and recorded with SHA256
in its manifest. All four were visually inspected. They are newly executed
synthetic evidence, not restored original screenshots.

Both current runs completed with exit code 0 and no failures, cancellations,
skips or TODOs:

| Run | UTC interval | Passed | Duration |
| --- | --- | ---: | ---: |
| [Focused API/UI](evidence/v3-batch-recovery-20261022-focused.json) | 21:38:04–21:39:15 | 75/75 | 71520.742149 ms |
| [Final full regression](evidence/v3-batch-recovery-20261022-full.json) | 21:39:20–21:42:08 | 1327/1327 | 168123.516343 ms |

The focused command was
`PUBLISHER_TEST_BROWSER_PATH=/usr/bin/chromium PUBLISHER_TEST_FFMPEG_PATH=/usr/bin/ffmpeg V3_SITES_EVIDENCE_DIR=/tmp/publisher-v3-recovery-screenshots node --test --test-concurrency=4 test/sites-cloud-authoring.test.js test/sites-cloud-console-ui.test.js`.
The full run used the same browser/media environment with
`node --test --test-concurrency=4 test/*.test.js`; the manifest preserves every
expanded test filename. Complete current [focused log](evidence/v3-batch-recovery-20261022-focused.log)
and [full log](evidence/v3-batch-recovery-20261022-full.log) are archived with byte
counts and SHA256 in those manifests. Their hashes were checked after completion.

No deployment, real external send, Mac operation, shared permission change,
credential/configuration change or modification of `publisher-unified` occurred.

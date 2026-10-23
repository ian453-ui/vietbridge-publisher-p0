# V3 content production: durable intake slice 01

2026-10-23, original `publisher-v3/cloud-slice-01` branch, starting at `18bb520168592019c0238e283c175cbc48fe3d85`. This is the first executable slice of the [content-production PRD](v3-content-production-prd.md), not completion of its URL research → authored article → imagegen → QA → Review MVP.

## User-visible and persistent behavior

The existing V3 console now has **线索与生产** in the same customer/account shell. It accepts a URL or hand-entered tip, shows exact customer scope and an explicit unconfigured-provider notice, lists durable production jobs, and supports pause, resume, cancel and read-only handoff checks. It does not display a produced article, image, READY badge or publication action. The lead is workspace-wide; switching the task/review account does not transfer a content approval or create account-specific output.

The new candidate migration `0011_production_intake_candidate.sql` belongs to the same Sites D1 candidate chain. It adds scoped leads, jobs and exact command receipts. A URL is normalized as an identity hint (common tracking parameters/fragment removed, semantic query preserved) without fetching it; unsafe local/credential URL forms are rejected. `(workspace,connector_id,event_id)` is unique and replay returns the original receipt. A repeated URL with a new event creates a separate lead and offers same-source candidates; an explicit parent points only to a lead in the same workspace. Raw source rights remain `UNVERIFIED`.

Jobs begin at `WAITING_PROVIDER` with provider `UNCONFIGURED` and QA `BLOCKED`. Pause/resume/cancel use expected revision and a persisted command ID in an atomic write batch, with a second owner-scope assertion at commit. A lost acknowledgement can be read back under the original command; batch failure rolls back both job and receipt. Result-unknown publication semantics are not weakened. Handoff to the existing Review chain is a **denial gate** until research, draft, real image and QA evidence exist; the API cannot create an approved content version or freeze a publishing task from this lead.

The provider interface currently exports an explicit `UNCONFIGURED` adapter with research, draft, image and receipt methods that fail closed. This instance exposed no user-authorized model API configuration in the safe names-only check; no secret contents were opened, no persistent credentials created and no billable request made. Budget, provider identity and permitted source/image services need a separate user decision before live integration. The site worker still needs the supported official identity and D1/R2 deployment path; this migration has not been applied to a hosted database.

## API and evidence

Under `/api/sites/workspaces/:workspace/production/`: `POST leads`; `GET jobs` (50-item keyset pages); `GET jobs/:id`; `POST jobs/:id/actions`; `GET jobs/:id/handoff-check`. `POST jobs/:id/handoff` rejects while evidence is missing. All writes require same-origin and trusted server identity. Browser/client-supplied workspace or account names never grant access.

The [backend focused log](evidence/v3-production-intake-20261023/api-focused.log) covers URL safety, event replay/conflict, same-source new lineage, cross-workspace denial, restart readback, transaction rollback, revision conflict and blocked handoff. The [real Chromium browser log](evidence/v3-production-intake-20261023/browser-focused.log) covers 390px create/pause/reload/account switch/workspace switch and a delayed old-workspace response. The [mobile screenshot](evidence/v3-production-intake-20261023/mobile-production-unconfigured.png) shows the saved synthetic lead and no generated content. [Existing UI regression](evidence/v3-production-intake-20261023/old-ui-regression.log) exercises the original content/editor/batch routes after adding the new tab. These are synthetic SQLite/D1-shaped and loopback browser checks, not a hosted Site or real user/account acceptance.

Final [full test log](evidence/v3-production-intake-20261023/full-test.log): 1359/1359 passed with the cloud runner's Chromium and ffmpeg paths supplied through `PUBLISHER_TEST_BROWSER_PATH=/usr/bin/chromium` and `PUBLISHER_TEST_FFMPEG_PATH=/usr/bin/ffmpeg`. These variables select installed test binaries; they do not configure production media processing.

## Next blockers and sequence

1. Through the supported official Sites path, register migration 0011, bind trusted identity and D1/R2, and verify owner/workspace isolation and restart on the registered private Site. There is no V3 live URL to claim here.
2. Resolve whether to reuse an already authorized provider integration or obtain a new one, along with a concrete budget, model/tool eligibility, source rights and image-generation service. The ChatGPT subscription alone does not authorize or fund API calls. Until then, no model call may advance a job.
3. Add source evidence and claim-level research receipts, immutable body/platform versions, actual image bytes/hash/size/role and version-dependent QA. Only then implement an exact handoff to the existing independent Review/content approval chain; no approval or account publish permit is inherited automatically.

No Mac operation, Drive modification, credential update, media replacement, social post, comment or message occurred in this slice. Previously published TCL/BYD/Goertek remain untouched.

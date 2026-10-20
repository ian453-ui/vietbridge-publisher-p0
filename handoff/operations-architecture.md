# Publisher operations roadmap: preserve the existing execution boundary

This first-pass inventory is backed by repository code, not platform certification.
Baseline is 72ae762; independent official-platform capability review is still
pending incorporation. Do not interpret an implementation path as current account
permission, successful live testing or a supported public-platform automation API.

## Existing chain and first batch

Original sticky-owner task / existing Slack bridge
→ content request manifest (new local contract)
→ designated GPT via existing authorized transport (not connected in this batch)
→ correlated result / explicit error or timeout (new local inspection)
→ existing client Drive inbox structural checks
→ separate facts + visual review and original user approval
→ immutable library content/sourceProof
→ unified account-scoped frozen task
→ existing approval / permit / execution gates
→ platform readback / UNKNOWN reconciliation
→ local ledger and available account-specific observations.

GitHub remains code/audit, Slack ordinary task coordination and Drive large
artifacts. No replacement queue, automatic owner change, model fallback or new
poller. ScanScheduler continues discovery only.

## Capability matrix (code inventory; real acceptance not established here)

| Platform / area | Existing implementation | Conditions / limits | Evidence this batch |
| --- | --- | --- | --- |
| Facebook Page publication | Unified API/BROWSER paths | Explicit account/actor/Page binding, original approval and execution gate; transport changes manual | Existing synthetic regression only; no real publish |
| Facebook comments / proactive interaction | Page feed/comments API adapter, browser group discovery/interactions | Configured authorized identity, quotas, original confirmation and UNKNOWN guards; scheduler discovery only | Code reviewed, not live exercised |
| Xiaohongshu | Configured MCP image/single-video publisher | Actual MCP availability, login and identity required; uncertain outcomes need readback | No real account acceptance in this batch |
| WeChat Official Account | Draft path | DRAFT_WRITTEN is not public publication; credentials/permissions external | Existing code/test contract only |
| WeChat Channels | Dedicated browser publication path | PUBLISHED_ID_PENDING may lack public link; no presumed API parity | No real upload; lower priority remains |
| TikTok / other networks | No verified end-to-end implementation established | Eligibility, approved APIs and account permissions require independent review | Unsupported by this first slice |
| Cross-platform analytics | Local verification summary/ledger; FB observations | Publication verification is not a general insights/ROI collector; no uniform collection contract shown | No universal analytics claim |
| GPT content intake | Existing Facebook caption + one-image inbox; new request/result binding | Client libraries only, enterprise guard remains, editorial and visual QA still required | Synthetic contract + real fixture decoding |
| Script/video/subtitle production | Not wired into current inbox | Requires reviewed artifact schemas and existing approved producer; do not force videos into v1 | Deferred |

## Batch order and acceptance gates

1. **Implemented local slice:** request fingerprint, original task/thread/owner
   correlation, result freshness/idempotence and existing inbox QA binding. See
   [schema, CLI and tests](gpt-content-contract.md). No external actions.
2. **Transport integration design:** use existing bridge validators and authenticated
   claims, attach manifest to original thread and read exact result. Must resolve
   actual transport authorization and atomic receipt persistence first.
3. **Review UI integration:** expose producer evidence and fact/visual review with
   fresh candidate readback; must preserve client isolation and enterprise restriction.
4. **Platform acceptance:** per-account known-content authorization, initially
   bounded cases; prepared/approved/submitted/readback are distinct outcomes.
   Parent controls live execution. No result ambiguity triggers automatic retry.
5. **Metrics:** define platform-specific observable fields, collection permissions,
   identity, timestamp and missingness before any cross-platform analytics dashboard.

No step is marked live merely because synthetic tests pass. This roadmap does
not request credentials, purchase services, create hosting or change posting cadence.

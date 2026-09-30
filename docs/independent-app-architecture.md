# Independent App Architecture

## Product goal

Run routine multi-platform publication without an AI model or token usage. AI may prepare an approved package earlier, but the publication runtime is a deterministic local application that Liu can start from a desktop shortcut and operate through a local Web UI.

Target platforms:

- Xiaohongshu: image and local MP4 through the existing MCP binary.
- Facebook: photo and Reel through the existing Graph/MCP connector; Reel uses a hash-verified public HTTPS MP4.
- WeChat Channels: local MP4 through a persistent, account-scoped Chrome profile and deterministic browser adapter.
- WeChat Official Account: article/image package to Draft API; this remains a draft, not a formal group-send publication.

## Runtime boundary

The app owns package validation, approval capture, deduplication, locks, browser/API calls, readback, SQLite transitions and ledger mirroring. It does not ask Codex, Claude or ChatGPT to decide selectors, copy, retries or outcomes during a normal run.

AI is optional and outside the runtime:

- ChatGPT: high-level strategy research and challenges.
- Codex: local fact verification, capability probing, implementation and QA.
- Publisher app: deterministic execution only.

## Local topology

```text
Browser at http://127.0.0.1:17880
              |
       Local Publisher daemon
       /       |       |       \
  SQLite    XHS MCP  Meta MCP  Chrome adapter
                                      |
                       managed WeChat Channels profile
              |
       append-only mirror outbox
              |
      Google Drive shared ledger
```

The first UI milestone should be server-rendered HTML plus a small amount of browser JavaScript. React/Tauri and AI chat are unnecessary for P0.

## UI screens

1. **Queue**: approved packages, per-platform readiness, duplicate warnings and current terminal state.
2. **Package review**: exact title/body/tags/media hash/account/visibility per platform; one approval record can enumerate multiple exact targets.
3. **Run**: one card per platform with independent progress. Partial success is normal.
4. **Needs attention**: login QR, CAPTCHA, account mismatch, unknown submit and reconciliation.
5. **History**: platform ID/URL when available, sanitized readback evidence and ledger mirror status.

There is no free-form AI prompt box in the publishing UI.

## WeChat Channels adapter

Historical evidence already validates the browser workflow on account `山石ly的视频号` (`sph42vLa6y4BW9x`), collection `来越企业全知道`, including list-count readbacks `5→6`, `6→7`, `7→8`, `8→9` and `9→10`. The migration therefore replaces the Claude-controlled browser driver, not the proven publication workflow.

The independent adapter must:

1. Start or attach only to the app-managed persistent Chrome profile.
2. Acquire the exclusive profile lock and check DevTools/editor health.
3. Navigate to `https://channels.weixin.qq.com/` and verify both display name and account ID.
4. Capture the video-list count before opening the editor.
5. Commit publication intent in SQLite before upload or any other live side effect.
6. Upload exactly one approved local MP4; wait for upload completion.
7. Fill and read back title, 1–3 sentence description, collection and empty location; persist the form snapshot.
8. Click publish once and enter `SUBMITTED_PENDING_CONFIRMATION` immediately.
9. Open a separate list/history surface and match the exact title. Confirm using title plus either list-count increment or an `已发表/已发布` marker.
10. Record `PUBLISHED_ID_PENDING` because this path exposes no API media ID. Never retry only to obtain an ID.

Any disconnect, timeout, ambiguous toast/redirect or missing list evidence after the click becomes `UNKNOWN → RECONCILE_PENDING`; the app disables the publish button for that identity until reconciliation.

## Browser implementation choice

P0 should use Playwright over Chrome DevTools Protocol with a dedicated persistent profile. Existing `open-claude-in-chrome` code is evidence and a selector reference, but the production app must not invoke Claude tools or require an AI conversation. If the platform blocks direct CDP automation, the fallback is a small local Chrome extension whose commands are fixed JSON operations from the daemon—not natural-language instructions.

Selectors must be stored as versioned platform fixtures with multiple stable signals (role, visible label, nearby heading) and screenshot/DOM evidence on failure. A selector failure stops before submit; it never triggers exploratory AI at runtime.

## Truth and analytics

- SQLite is operational authority.
- Platform readback is side-effect authority.
- Google Drive YAML/JSONL is an append-only analytics and cross-agent mirror.
- Upload completion and DOM success text are not publication evidence.
- Missing native analytics remain null with `collection_method` and `access_note`; screenshots/exports are fallback evidence, never invented MCP telemetry.
- Account-level follower changes are signals only and are not attributed to one post without native attribution.

## Delivery sequence

1. Local daemon + Queue/History UI over the current SQLite store.
2. WeChat Channels deterministic adapter and replay tests from historical traces.
3. Wire existing Xiaohongshu and Facebook connectors behind the same job API.
4. Add WeChat Official Account draft adapter.
5. Add desktop launcher, login-attention notifications and Google Drive mirror worker.

## Multi-platform completion, exceptions and human interaction

### Four levels of truth

Do not store one mutable result for a multi-platform task. Use four linked levels:

1. `publication_batch`: the user's content source, selected targets and control request.
2. `platform_job`: one independently approved target platform/account/payload identity.
3. `platform_attempt`: one authorized execution attempt. A later authorized retry creates a new attempt and never overwrites the first.
4. `job_event`: append-only transitions, evidence and timestamps within an attempt.

An `attention_request` links to the smallest applicable scope: batch, platform job or attempt. It records category, prompt, safe choices, blocking scope, creation/deadline/resolution times, responder and decision evidence.

### Derived batch state

The UI derives the batch state from child jobs; it must not write success down into them.

- `DRAFT`: selection is editable and exact payload approval is incomplete.
- `QUEUED`: approved and waiting for dispatch.
- `RUNNING`: at least one platform is active and none needs user action.
- `RUNNING_WITH_ATTENTION`: some platforms continue while at least one independent platform needs a person.
- `PAUSE_REQUESTED`: no new safe step may start; already-submitted jobs continue to readback/reconciliation.
- `PAUSED`: every unfinished job is at a safe checkpoint and no submit/readback operation is in flight.
- `PARTIAL_COMPLETE_NEEDS_ACTION`: no platform is actively running, at least one succeeded/drafted, and at least one remains blocked or needs a decision.
- `COMPLETED`: every selected platform reached its platform-appropriate successful terminal state.
- `COMPLETED_WITH_ISSUES`: all selected jobs are terminal, but at least one ended failed or blocked after an explicit final decision.

Platform-appropriate success remains explicit: Facebook `PUBLISHED`, Xiaohongshu/视频号 may be `PUBLISHED_ID_PENDING` with authoritative success evidence, and WeChat Official Account is `DRAFT_API_WRITTEN_NOT_PUBLISHED`. The batch may display “4/4 finished” while still showing that the Official Account result is a draft.

### Ordering and concurrency

Dispatch platform jobs independently after the shared approval snapshot is frozen. API jobs may run concurrently when they do not share credentials, quotas or profiles. Browser jobs sharing a managed Chrome profile run serially behind a profile lock. One platform's failure or login request does not stop other approved independent jobs unless the user selected `stop_all_on_attention`.

Every event contains both an append sequence and UTC timestamp. The UI renders a merged batch timeline ordered by committed sequence, shows local time plus elapsed duration, and retains platform-local timelines. Arrival order, completion order and target-list order may differ and must not be normalized into a fictitious sequence.

### Safe pause

Pause is a cooperative checkpoint, not process termination.

- Before `PUBLICATION_INTENT_COMMITTED`: pause immediately.
- After intent but before submit: finish the current atomic fill/save step, persist the form snapshot and pause at a reconstructable checkpoint.
- At or after `SUBMITTED_PENDING_CONFIRMATION`: set `PAUSE_REQUESTED`, prohibit every new submit, but continue readback or reconciliation until the side effect is classified.
- Never kill Chrome, switch profiles or discard a form during an unresolved submit.

Resume starts only unfinished safe jobs. It never repeats a successful, ID-pending, unknown or reconcile-pending submit.

### Attention categories and interactions

Render each request as an action card with the affected platform, last safe state, plain-language consequence and only valid choices. Never use a generic “confirm” dialog.

- `LOGIN_REQUIRED`: “Open login window”; after login, run identity preflight again. No auto-publish follows merely from scanning QR.
- `ACCOUNT_MISMATCH`: show expected and observed non-secret identities; choices are “switch account” or “remove this platform”.
- `DUPLICATE_OR_OLDER_REVISION`: show old/new hashes, post ID/URL and revision; choices are keep old, publish alongside or delete-and-repost. Deletion requires a separate confirmation.
- `CONTENT_APPROVAL`: display exact per-platform payload/media/account/visibility; approval is scoped and hash-bound.
- `UNKNOWN_SUBMIT`: show sanitized submit and readback evidence. The first action is “reconcile again”, never “retry”. Offer a new submit only after absence is authoritatively proven and a new attempt is explicitly authorized.
- `CAPABILITY_BLOCKED`: offer remove platform or change to a truthful supported operation; never silently substitute an article draft for a video publication.
- `PLATFORM_REJECTION`: show platform error and whether a side effect is proven absent; allow correction to create a new payload revision and attempt.

Resolving one platform request resumes only that platform unless the user chooses an explicit batch action. All questions and answers are appended to the audit trail.

### UI presentation

The batch page has a fixed summary header and one platform card per selected target. Each card displays account, exact operation, current state, progress phase, start/update/finish times, duration, platform ID/URL, readback strength, last error and next action. Cards update independently.

Above the cards show counters such as `2 successful · 1 processing · 1 needs login`, not a single green/red status. Below them show the merged timeline and an “Attention required” drawer. A finished platform card remains stable while slower platforms continue.

### Example asynchronous run

At 10:00 all four targets start. At 10:01 Xiaohongshu reaches `PUBLISHED_ID_PENDING`; at 10:02 Official Account reaches `DRAFT_API_WRITTEN_NOT_PUBLISHED`; 视频号 requests QR login; Facebook Reel remains processing. The batch is `RUNNING_WITH_ATTENTION`, displayed as `2 finished · 1 processing · 1 needs login`.

At 10:06 Facebook readback succeeds. The batch becomes `PARTIAL_COMPLETE_NEEDS_ACTION`: three platform-appropriate successes, one login request. The user logs in at 10:15; only 视频号 re-runs preflight and proceeds. After matching-title list readback confirms it, the batch becomes `COMPLETED`. The completion order and each duration remain visible.

## Unified content resolution

All task inputs feed one deterministic resolver. Keyword search, default-ledger selection, a resource-library row, local path/file picker and cloud URL are locators for a `ContentPackage`; they are not separate publication workflows.

Build a derived, rebuildable `content-index.json` from the shared ledger plus package manifests. It is a search/cache layer, never a new source of truth. Each indexed revision links `article_id`, title, aliases, keywords/tags, content type, local and cloud locators, source URLs, mother draft, public platform payloads, ordered media/cover roles, hashes, QA manifest, approval identity and per-platform publication history.

Resolution order is exact article/revision locator, indexed local/cloud URL, media SHA-256, stable filename/article ID, then deterministic keyword ranking over ID/title/aliases/tags/filenames. Do not use an AI model for routine search. Multiple credible matches pause selection and show a compact candidate list; never guess.

Selecting one image or video does not make that file the whole package. After matching it to a package, hydrate the platform title, body/description, tags, ordered images, head image/cover, source evidence, account, visibility, originality/products/theme and approval/hash records from the library. Keep this detail collapsed during task creation, but make the exact platform payload available at the approval gate. A valid existing hash-bound approval permits immediate queueing; missing or changed approval pauses only at `CONTENT_APPROVAL` before any side effect.

For an unmatched locator, create a temporary staged package and request only the missing required fields. Image/article tasks require public title, body, ordered images and explicit cover/head-image role plus platform metadata. Video tasks require title, description, MP4 properties/hash, cover/first-frame QA and platform metadata. Missing fields remain missing; the runtime never generates copy through AI. The user may publish the exact temporary package after approval and optionally promote it into the resource library.

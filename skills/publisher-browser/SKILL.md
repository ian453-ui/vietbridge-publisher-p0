---
name: publisher-browser
version: 1.2.0
description: Let dot operate the unified Publisher through its authenticated browser UI, with explicit account scope and verifiable task results.
---

# Publisher browser capability for dot

This is capability source in the repository, not evidence that the skill is installed in dot or Mac. Use available browser tooling; this skill does not provision a browser, session, credentials or new permissions.

The deployment entry is `https://publisher.vietbridge.one`. The unified version is not yet deployed/accepted. Check the running build and authenticated `/api/automation/capabilities` before acting. If the endpoint is unavailable, stop and report the running version mismatch. Never operate a legacy iframe integration as if it were the unified app.

## Required task input

The original task ID remains `VB-PUBLISHER-V1-V2-INTEGRATION-PLAN-20261005-001`; implementation owner remains CLOUD_CODEX. Use the existing Slack-first task thread if the user authorized a task-bus reply. Do not create a new integration task or silently transfer ownership.

For each operation require exact `workspace_id`, `account_id`, requested action and user authorization scope. Content input requires cloud `source_id`, `revision`, title/body and approved media references. Do not infer customer ownership from names, and do not invent V1/V2 account mappings.

## Browser workflow

1. Open Publisher with an existing authorized browser session. If login is needed, report the supported login step; do not retrieve, print or provision credentials.
2. Select the exact customer in `#ws`, wait for its account list, then select the exact account in `#operating-account`. Verify both selected values after each re-render and before every write. Stop if either ID is absent or changes.
3. Open the native publishing tab `[data-route="v1"]`. Check `#unified-publisher` attributes `data-workspace` and `data-account` against the task. Do not guess selectors if the UI is a different version.
4. For browser publishing, choose `BROWSER` in `#unified-transport`, click `#unified-switch-transport`, wait for reload and verify the saved mode. API is also supported as a manual preference but needs an existing secure local configuration reference; never put token/password contents into any field.
5. Import the approved cloud content snapshot through `#unified-content-form`. Same source/version must stay identical. Select its content ID in `#unified-content`. Verify preview/body/media before creating the task with `#unified-create`.
6. Read the matching job in `#unified-jobs`; retain its exact ID, workspace, account, frozen mode, content hash and state. A click is not success evidence. Use authenticated scoped job readback to resolve ambiguous task creation; do not resend blindly.
7. Only with explicit authorization to approve that content/task, inspect the frozen preview and use `[data-approve="<job_id>"]`. Approval means READY, not a platform submission. Do not claim published without independent platform readback.
8. Check capabilities before submission. `submit_to_facebook.supported` reflects the deployment execution switch (off by default). When false, report execution disabled. When true and the user explicitly authorized this exact task, click its `[data-execute="<job_id>"]` control and confirm the frozen account/content/mode. Never bypass Publisher by opening Facebook to submit yourself. READY is not PUBLISHED. UNKNOWN requires `[data-reconcile="<job_id>"]` readback; never retry or change transport to resend. If a platform ID is requested, use independently obtained evidence, never invent one.
9. For one-shot random group selection open `[data-route="groups"]`, enter a bounded count in `#random-group-count` and click `#random-select-groups`. Inspect the actual chosen groups; random selection does not imply authorization to post. Each random round replaces old checks; successful task creation clears group/content selection.

## Results and failures

Return exact task IDs and states with non-secret evidence. Clearly distinguish content imported, task created, task approved, submission accepted and independently confirmed publication. Never expose local credential values or browser session data. UNKNOWN/SUBMITTING/PROCESSING results require readback, not transport switching and retry. Facebook account restrictions, checkpoint or unexpected identity stop the action; a different transport is not a way to bypass them.

Record blockers specifically: unavailable deployment, login required, missing account, invalid content/media, missing API configuration, unavailable executor or uncertain result. Real posting/liking/replying remains outside the current integration-test scope.

## Unified platform and identity rules

Facebook freezes `operatorActorId` (browser /me identity) and `targetPageId` (Business/Graph asset) separately. They may legitimately differ; never bind V2 to V1 or substitute one ID for the other. API/BROWSER remains a manual Facebook-only choice; other platforms use their configured executor. Confirm exact platform/title/body/tags/media before approval. Existing local config paths are references only; do not read secret contents.

Xiaohongshu supports image or single video; WeChat Official Account writes drafts only (`DRAFT_WRITTEN`, never public publication); WeChat Channels uses its dedicated browser and may return `PUBLISHED_ID_PENDING` without a public link. `submit_platform_task.supported` is the runtime execution gate. All real uploads/submissions remain outside this integration-test authorization. Interrupted preparation with no final submission intent requires explicit human acknowledgment through the UI before return to review; already submitted UNKNOWN requires readback and cannot be reset this way.

## Login, all-selection and recommendation (2.3.0-alpha.2)

Publisher uses the normal /login form and authenticated browser session. The user enters/saves their own password; never retrieve it from Keychain or transmit it to Cloud/Slack. “登录与应用” configures password/app access. A forgotten password is reset only when the user enters and confirms it through the reviewed Mac local helper; do not generate or set one autonomously. Server applications may receive separate customer-scoped expiring Bearer tokens via the administrator, not the administrator password. They can read/import/create pending tasks only, not approve/execute or change configuration. Treat one-time token displays as secrets and do not copy them into chat, logs or evidence.

All/clear controls select current eligible visible groups/contents; radar processes selected groups in bounded sequential batches and stops on context changes or errors. Proactive all-selection is staged; saving group switches is separate from any scan/interaction. Next-article recommendations are UI suggestions, never publication authorization. Previously published items/pairs remain selectable with labels, but duplicate/UNKNOWN guards still apply. Verify exact customer/account/content/target after any recommendation. Do not bulk approve action switches or bypass validation of unavailable items.

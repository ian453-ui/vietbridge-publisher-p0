# VietBridge Social Operator V2 — Mock Prototype

Current: 2.1.0-alpha.1 for task `SMO-FB-GROUPS-20260913-002`. The previous abstract mock dashboard is no longer the default product direction.

On this Mac, `com.vietbridge.social-operator-v2` runs the local service automatically and restarts it after an unexpected exit. The browser address is always `http://127.0.0.1:17882/` while the user is logged in.

The app does not import, write, migrate, or replace the Publisher-P0 database. Facebook Groups uses a separate browser adapter and local state boundary.

The app keeps V1 Publisher isolated and provides V2 Facebook Groups, Inbox, proactive engagement, publication verification, and account settings. V1 remains isolated at port 17880 with its own database and tests. V2 uses an independent local database for tenant Facebook mappings, managed Chrome execution profiles, joined groups, frozen content, per-group jobs, post evidence, comments, reply intents, proactive candidates, actions, conversations, fact sources, and daily per-post quota reservations.

The proactive engagement engine is fail-closed. It scans only joined groups that are explicitly enabled, ranks candidates instead of acting in DOM order, keeps like and initial reply as separate actions sharing one daily post slot, and requires browser readback for every write. Ambiguous results remain `RECONCILE_PENDING` and cannot be retried normally. External writes still require a configured authorized execution mode, matching Facebook identity, enabled global/account/group switches, and an exact permitted account/group scope.

## Facebook setup

1. Select the tenant in the upper-right corner.
2. In Accounts/Settings create a managed Chrome execution profile, then create the expected Facebook identity mapping.
3. Start the execution profile. If Facebook shows its login screen, the human logs in directly in Chrome; this app never reads or stores the password.
4. Use `Sync joined groups`. Identity mismatch or expired login fails closed before any composer text is inserted.
5. In Facebook Groups choose existing text/media, select groups, and create independent jobs. P0 prepares the composer but preserves the human final click.

Runtime blocker on 2026-09-13: the newly created managed profile is reachable over local CDP but is not logged into Facebook. Real joined-group, composer, post-readback, and Inbox gates remain blocked until the human completes this one-time login.

## Start

```sh
npm start
```

Open `http://127.0.0.1:17882`.

## Validate

```sh
npm test
```

The prototype keeps product lifecycle state separate from the proven Publisher-P0 execution state. Real integration stays disabled until the M0 review and mock QA are accepted.

## Operating account execution preference

The header's “运营账号” selector chooses the Facebook account for Groups and proactive interaction. In Accounts/Settings, “此运营账号的执行方式” saves `API` or `BROWSER` on that account. Switching accounts restores its preference; editing another account does not overwrite the selected account's form. Existing databases receive a nullable column and preserve legacy `FB_API_ENABLED` configuration until a preference is explicitly saved. An explicit browser choice never connects to the Page API adapter.

The API option applies to the existing Facebook Page API operations. Joined-group discovery and group proactive interactions use the selected account's bound Chrome profile in either preference; this release has no Groups API adapter. Browser mode requires that profile to be running, logged in and independently identity-verified. Hosted cloud control-plane mode still requires a connected local executor and rejects proactive browser scans.

Proactive scans support stable `posts` and `permalink` links and numeric, ISO, Chinese, Vietnamese and English relative publication times. Unknown dates are counted and remain excluded from writes; unreadable/empty feeds report a blocker rather than a successful empty scan. Fact-sensitive posts expose a human source-verification form. Action records show pending reconciliation separately from independently confirmed actions; unknown actions cannot be retried through the ordinary execution path.

Validation in the isolated Cloud Codex workspace: 59 dependency-compatible regression tests passed. Full server/DOM-composer tests could not run because locked npm dependencies were unavailable and network installation was blocked. Real Mac Chrome / Facebook scanning and interaction readback remain pending. No live interaction or publication was performed by Cloud Codex.

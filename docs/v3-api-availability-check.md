# Existing Publisher API — read-only cloud-environment check

2026-10-22. Requested by the parent operator; **no real submission performed**.
No token value, password, cookie, credential file or actual account data is in
this report. No credential creation, server start, login, token registration,
permission change or endpoint probe was performed. Scope is this selected cloud
workspace, not an assertion about all services the user may own.

## Confirmed from existing source and configuration presence

- `src/publisher-automation.js` declares an application API at
  `https://publisher.vietbridge.one` using existing Bearer application tokens.
- `PublisherAccess.authorizeApp` permits only exact workspace collection routes:
  GET jobs with `jobs:read`, POST content with `content:import`, POST jobs with
  `jobs:create`. A token is **not** a production submit/admin grant. Even health
  or capability routes are not in this app-token allowlist; their denial alone
  would not prove a token invalid.
- `src/unified-server.js` requires `PUBLISHER_MODE=mac-tunnel` and listens on
  loopback port 17882 by default. `cloud-runtime.js` binds that mode to the known
  publisher.vietbridge.one origin. This implemented entry depends on the original
  Mac tunnel; that is not proof that an independent API does not exist elsewhere.
- `src/unified-cloud-server.js` is a separate cloud entry, but explicitly rejects
  enabled execution and local authorization capabilities. It is not running here
  with production configuration, and starting it would not recover real accounts.
- In this process no Publisher/VietBridge/Social Operator environment variables
  were configured. PUBLIC_ORIGIN, ADMIN_PASSWORD, ADMIN_ACCESS_FILE, ADMIN_USER,
  DATA_DIR, CONTENT_ROOTS_JSON, GPT_INBOX_BASE and PORT were also absent. Only
  presence, never values, was reported.
- Publisher V3 has no local .env/config credentials or data directory. Read-only
  existence checks on the two supplied baseline/config repositories also found
  no .env files or data directory. Their integration JSON is an example containing
  ABSOLUTE/EXISTING paths and EXISTING_* account-ID placeholders.
- No Publisher-specific connected tool was exposed in current tool discovery.
  The registered private V3 Site still has version 0 and no live/preview URL;
  D1/R2 are unconfigured. It is not an alternate live API.

## Unknown, not denied

An independent existing API origin and reusable configured authentication were
**not found here**. No enterprise/real-estate target ID can be reliably resolved
from these example configurations. Study/LP were not touched. The user's Facebook
share link was not followed; account resolution belongs to the parent operator.

The parent observed Cloudflare 1033 on the website. That observation is not used
to conclude an independent API is down. The minimum missing information for the
operator is the actual already-existing API base URL, its supported read-only
account/job discovery method and existing narrowly scoped authentication delivered
through an approved secret channel. This developer task neither requests tokens
in chat nor creates any. If the origin is the same Mac-backed tunnel, a token
alone will not restore that server. If another origin is confirmed, the operator
can first read its account mapping/capabilities and coordinate any authorized
publication under the original account-specific permit and quota mechanisms.

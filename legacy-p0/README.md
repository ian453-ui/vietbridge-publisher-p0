# Local Publisher P0 source dependency

The unified Publisher integration imports `src/web-server.ts` from this directory. Selected unified tests also import `src/database.ts` and `src/publisher-store.ts`. These 46 source files come from the Mac's existing Publisher P0 checkout at commit `7e1d265b66d358bc6f07975b892f1d8d343f46f3`, which includes five local commits not pushed to the older P0 branch. Only source and its package manifest are included; no database, browser state, media, credentials, logs, or runtime files were copied.

The directory has its own package metadata for ESM interpretation. Root `npm ci` supplies the same runtime dependencies. This copy does not change the existing GitHub `main` or its branch history.

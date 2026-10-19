# Publisher unified public source snapshot

This branch is a source-only export of the Mac production commit `7422a4166b382572ba57470ba12948b0de7dca7e` (2026-10-19). The exact original Git history is preserved in a local Git bundle on the source Mac. This snapshot omits operational documents, runtime data, credentials, browser profiles, local media, and the machine-specific `node_modules` symlink. Install dependencies with `npm ci`.

The older P0 `main` branch has a separate history and implementation. Do not merge this root commit into it without a deliberate migration. The V1 task visibility patch under `handoff/` is informational and requires porting against the exact V1 release.

This is code availability for review and build. It does not establish a cloud publication runtime or migrate Mac browser sessions and content files.

## Local P0 dependency

The initial source snapshot still imported a sibling Publisher P0 directory. A follow-up commit vendors the 46 P0 `src` files under `legacy-p0/src` and changes the imports to stay within this checkout. See `legacy-p0/README.md` for provenance. This makes the code dependency reconstructable from this branch, while runtime databases, platform sessions, local media, and service configuration remain external.

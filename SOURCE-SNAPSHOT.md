# Publisher unified public source snapshot

This branch is a source-only export of the Mac production commit `7422a4166b382572ba57470ba12948b0de7dca7e` (2026-10-19). The exact original Git history is preserved in a local Git bundle on the source Mac. This snapshot omits operational documents, runtime data, credentials, browser profiles, local media, and the machine-specific `node_modules` symlink. Install dependencies with `npm ci`.

The older P0 `main` branch has a separate history and implementation. Do not merge this root commit into it without a deliberate migration. The V1 task visibility patch under `handoff/` is informational and requires porting against the exact V1 release.

This is code availability for review and build. It does not establish a cloud publication runtime or migrate Mac browser sessions and content files.

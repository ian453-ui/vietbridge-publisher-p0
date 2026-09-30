import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/database.ts";
import { PublisherStore } from "../src/publisher-store.ts";
import { syncOutboxToJsonl } from "../src/jsonl-mirror.ts";

test("JSONL mirror is append-only and idempotent", () => {
  const root = mkdtempSync(join(tmpdir(), "publisher-mirror-"));
  const db = openDatabase(join(root, "publisher.sqlite"));
  try {
    const store = new PublisherStore(db);
    const id = store.createJob({ articleId: "A-1", platform: "xhs", accountId: "acct", packageHash: "h" });
    store.transition(id, "FACT_CHECK");
    const mirror = join(root, "events.jsonl");
    assert.deepEqual(syncOutboxToJsonl(store, mirror), { mirrored: 1, skipped: 0, failed: 0 });
    assert.equal(store.pendingOutbox().length, 0);
    assert.deepEqual(syncOutboxToJsonl(store, mirror), { mirrored: 0, skipped: 0, failed: 0 });
    const lines = readFileSync(mirror, "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).job_id, id);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/database.ts";
import { PublisherStore } from "../src/publisher-store.ts";
import { inspectResourceHealth } from "../src/resource-monitor.ts";

test("critical outbox pressure is measurable without pruning evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "publisher-resource-"));
  const path = join(root, "publisher.sqlite");
  const db = openDatabase(path);
  try {
    const store = new PublisherStore(db);
    const id = store.createJob({ articleId: "A-1", platform: "xhs", accountId: "acct", packageHash: "h" });
    store.transition(id, "FACT_CHECK");
    const health = inspectResourceHealth(db, path, { maxPendingOutboxEvents: 1, maxDatabaseBytes: Number.MAX_SAFE_INTEGER, minFreeDiskBytes: 0, warningRatio: 0.8 });
    assert.equal(health.critical, true);
    assert.ok(health.reasons.includes("pending_outbox_limit"));
    assert.equal(store.pendingOutbox().length, 1);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

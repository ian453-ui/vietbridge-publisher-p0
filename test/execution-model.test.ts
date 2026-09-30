import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/database.ts";
import { PublisherStore } from "../src/publisher-store.ts";
import { ExecutionModel } from "../src/execution-model.ts";

test("attempt fencing, submit safety domain, receipt and outbox are durable", () => {
  const root = mkdtempSync(join(tmpdir(), "publisher-execution-")); const db = openDatabase(join(root, "db.sqlite"));
  try {
    const store = new PublisherStore(db); const jobId = store.createJob({ articleId: "A", platform: "facebook", accountId: "page", packageHash: "h" });
    const model = new ExecutionModel(db); const first = model.createAttempt(jobId, "initial approval");
    model.markSubmitStarted(jobId, String(first.attempt_id));
    assert.equal(store.getJob(jobId).submit_safety_domain, "MAY_HAVE_SUBMITTED");
    model.recordReceipt(jobId, String(first.attempt_id), { type: "processing", rawStatus: "IN_PROGRESS", evidence: { id: "safe" } });
    assert.ok(store.pendingOutbox().some(x => x.event_type === "RECEIPT_RECORDED"));
    assert.throws(() => model.createAttempt(jobId, "retry without reconciliation"), /attempt forbidden/);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

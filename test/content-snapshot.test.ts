import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/database.ts";
import { ContentSnapshotStore } from "../src/content-snapshot.ts";

test("content snapshot stages immutable hash-addressed assets and is idempotent", () => {
  const root = mkdtempSync(join(tmpdir(), "publisher-snapshot-"));
  const db = openDatabase(join(root, "db.sqlite"));
  try {
    const source = join(root, "post.txt"); writeFileSync(source, "approved public text");
    const snapshots = new ContentSnapshotStore(db, join(root, "staging"));
    const input = { articleId: "Daily-100", contentVersion: "v1", canonicalPayload: { title: "测试", body: "正文" }, sourceKind: "library", assets: [{ role: "attachment" as const, ordinal: 1, path: source }] };
    const first = snapshots.create(input); const second = snapshots.create(input);
    assert.equal(first.snapshot_id, second.snapshot_id);
    const asset = (first.assets as Record<string, unknown>[])[0];
    assert.equal(readFileSync(String(asset.staging_path), "utf8"), "approved public text");
    writeFileSync(source, "changed later");
    assert.equal(readFileSync(String(asset.staging_path), "utf8"), "approved public text");
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("snapshot rejects empty assets", () => {
  const root = mkdtempSync(join(tmpdir(), "publisher-snapshot-")); const db = openDatabase(join(root, "db.sqlite"));
  try { assert.throws(() => new ContentSnapshotStore(db, join(root, "staging")).create({ articleId: "A", contentVersion: "v1", canonicalPayload: {}, sourceKind: "library", assets: [] }), /at least one asset/); }
  finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

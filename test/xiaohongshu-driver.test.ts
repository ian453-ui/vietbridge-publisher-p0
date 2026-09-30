import test from "node:test";
import assert from "node:assert/strict";
import { XiaohongshuDriver } from "../src/xiaohongshu-driver.ts";

test("XHS preflight verifies exact logged-in account", async () => {
  const driver = new XiaohongshuDriver({
    async loginStatus() { return { loggedIn: true, accountId: "expected" }; },
    async findPublished() { return { status: "absent" }; }
  });
  assert.deepEqual(await driver.preflight("expected"), { ok: true });
  assert.deepEqual(await driver.preflight("other"), { ok: false, reason: "ACCOUNT_IDENTITY_MISMATCH" });
});

test("XHS dry-run normalizes tags and rejects body hashtag lines", () => {
  const driver = new XiaohongshuDriver({
    async loginStatus() { return { loggedIn: true, accountId: "expected" }; },
    async findPublished() { return { status: "absent" }; }
  });
  const result = driver.dryRun({ title: "越南政策", body: "正文\n#越南政策", tags: ["越南", " 越南 "], images: ["/approved/a.png"], visibility: "public", isOriginal: true, products: [] });
  assert.equal(result.ok, false);
  assert.deepEqual(result.normalized.tags, ["越南"]);
  assert.ok(result.errors.some(x => x.includes("hashtag lines")));
});

test("XHS readback is independent and live submit remains unwired", async () => {
  let readbackCalls = 0;
  const driver = new XiaohongshuDriver({
    async loginStatus() { return { loggedIn: true, accountId: "expected" }; },
    async findPublished(input) { readbackCalls++; return { status: "match", noteId: input.returnedId, url: "https://example.test/note" }; }
  });
  const result = await driver.readback("expected", "fingerprint", "note-1");
  assert.equal(result.status, "match");
  assert.equal(readbackCalls, 1);
  await assert.rejects(() => driver.submit(), /BLOCKED_CAPABILITY/);
});

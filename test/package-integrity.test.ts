import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sha256 } from "../src/util.ts";
import { verifyPackage } from "../src/package-integrity.ts";

test("manifest detects package mutation", () => {
  const root = mkdtempSync(join(tmpdir(), "publish-package-"));
  try {
    const path = join(root, "post.txt");
    writeFileSync(path, "approved payload");
    const manifest = { articleId: "A-1", revision: "r1", files: [{ path: "post.txt", bytes: 16, sha256: sha256("approved payload") }] };
    assert.equal(verifyPackage(root, manifest).ok, true);
    writeFileSync(path, "changed payload");
    const result = verifyPackage(root, manifest);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(x => x.includes("sha256 changed")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

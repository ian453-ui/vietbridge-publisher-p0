import test from "node:test";
import assert from "node:assert/strict";
import { chooseAssetCandidate, dedupeAssetCandidates, orderedInlineAssets } from "../src/doc-inline-assets.ts";

test("inline objects are ordered by body occurrence and deduplicated", () => {
  const doc = { body: { content: [
    { startIndex: 20, inlineObjectElement: { inlineObjectId: "b" } },
    { startIndex: 2, inlineObjectElement: { inlineObjectId: "a" } },
    { startIndex: 30, inlineObjectElement: { inlineObjectId: "a" } }
  ]}, inlineObjects: {
    a: { inlineObjectProperties: { embeddedObject: { imageProperties: { contentUri: "https://a" }}}},
    b: { inlineObjectProperties: { embeddedObject: { imageProperties: { contentUri: "https://b" }}}}
  }};
  assert.deepEqual(orderedInlineAssets(doc).map(x => x.inlineObjectId), ["a", "b"]);
});

test("inline candidate wins, then Drive, then local; missing fails closed", () => {
  assert.equal(chooseAssetCandidate({ inline: { inlineObjectId: "a", startIndex: 1, contentUri: "u" }, driveFileId: "d", localPath: "p" })?.source, "DOC_INLINE");
  assert.equal(chooseAssetCandidate({ driveFileId: "d", localPath: "p" })?.source, "DRIVE_MATCH");
  assert.equal(chooseAssetCandidate({ localPath: "p" })?.source, "LOCAL_MATCH");
  assert.equal(chooseAssetCandidate({}), undefined);
});

test("asset candidates dedupe by bytes hash instead of becoming content items", () => {
  assert.deepEqual(dedupeAssetCandidates([{ sha256: "x", n: 1 }, { sha256: "x", n: 2 }, { sha256: "y", n: 3 }]).map(x => x.n), [2, 3]);
});

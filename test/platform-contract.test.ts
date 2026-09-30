import test from "node:test";
import assert from "node:assert/strict";
import { planPublication, type UnifiedPublication } from "../src/platform-contract.ts";

const video = "/Users/a1-6/Library/CloudStorage/GoogleDrive/My Drive/Codex/VietBridge-Enterprise-Training/TT-20260831-ENT-12-Daily017-Overtime-v2/final/Daily-017-vietnam-overtime-controls-video-v2.mp4";
const base: UnifiedPublication = {
  articleId: "Daily-017", mediaRevision: "v2", platform: "xiaohongshu", accountId: "acct",
  mediaType: "video", title: "300小时加班，你理解反了", body: "正文", tags: ["越南用工"],
  localMedia: [video], visibility: "public", products: [], approvalRef: "approval-1"
};

test("XHS accepts one local video and keeps hashtags outside body", () => {
  const result = planPublication(base, { loggedInAccountId: "acct" });
  assert.equal(result.ok, true);
  assert.equal(result.operation, "publish_with_video");
  assert.equal(result.expectedOutcome, "PUBLISHED");
});

test("Facebook Reel requires reachable HTTPS staging with matching hash", () => {
  const blocked = planPublication({ ...base, platform: "facebook" });
  assert.equal(blocked.ok, false);
  assert.ok(blocked.errors.some(x => x.includes("public HTTPS URL")));
  const ready = planPublication({ ...base, platform: "facebook", publicMediaUrl: "https://cdn.example.test/video.mp4" }, { publicUrlReachable: true, publicUrlHashMatches: true });
  assert.equal(ready.ok, true);
  assert.equal(ready.operation, "fb_publish_reel");
});

test("WeChat Channels is gated on Chrome and never confuses upload with publish", () => {
  const blocked = planPublication({ ...base, platform: "wechat_channels" });
  assert.equal(blocked.ok, false);
  assert.ok(blocked.errors.includes("CHROME_NOT_CONNECTED"));
  const ready = planPublication({ ...base, platform: "wechat_channels" }, { chromeConnected: true, loggedInAccountId: "acct" });
  assert.equal(ready.ok, true);
  assert.ok(ready.warnings.some(x => x.includes("separate states")));
});

test("Official Account is draft-only and refuses MP4 substitution", () => {
  const videoResult = planPublication({ ...base, platform: "wechat_official_account", theme: "default" });
  assert.equal(videoResult.ok, false);
  assert.ok(videoResult.errors.some(x => x.includes("cannot publish this MP4")));
  const article = planPublication({ ...base, platform: "wechat_official_account", mediaType: "article", localMedia: [], theme: "default" });
  assert.equal(article.ok, true);
  assert.equal(article.expectedOutcome, "DRAFT_API_WRITTEN_NOT_PUBLISHED");
});

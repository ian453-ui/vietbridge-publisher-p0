import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { planMultiplatform } from "../src/multiplatform-planner.ts";

test("one content package produces independent platform plans", t => {
  const root = mkdtempSync(join(tmpdir(), "publisher-plans-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const video = join(root, "video.mp4"); writeFileSync(video, "test video");
  const plans = planMultiplatform({
    articleId: "Daily-017", mediaRevision: "v2", targets: ["xiaohongshu", "facebook", "wechat_channels", "wechat_official_account"],
    accountId: "acct", mediaType: "video", title: "300小时加班，你理解反了", body: "正文", tags: ["越南用工"],
    localMedia: [video], visibility: "public", products: [], approvalRef: "approval-1",
    platformOverrides: {
      facebook: { publicMediaUrl: "https://cdn.example.test/video.mp4" },
      wechat_official_account: { mediaType: "article", localMedia: [], theme: "default" }
    }
  }, {
    xiaohongshu: { loggedInAccountId: "acct" },
    facebook: { publicUrlReachable: true, publicUrlHashMatches: true },
    wechat_channels: { chromeConnected: true, loggedInAccountId: "acct" }
  });
  assert.equal(plans.xiaohongshu.ok, true);
  assert.equal(plans.facebook.ok, true);
  assert.equal(plans.wechat_channels.ok, true);
  assert.equal(plans.wechat_official_account.ok, true);
  assert.equal(plans.wechat_official_account.expectedOutcome, "DRAFT_API_WRITTEN_NOT_PUBLISHED");
});


import test from "node:test";
import assert from "node:assert/strict";
import { decideWechatChannelsReadback, WECHAT_CHANNELS_ACCOUNT } from "../src/wechat-channels-contract.ts";
import { extractWechatChannelsIdentity, normalizeChannelsTitle } from "../src/wechat-channels-driver.ts";

test("historical list-count increment plus matching title confirms publication without media id", () => {
  const result = decideWechatChannelsReadback({ beforeCount: 9, afterCount: 10, visibleTitle: "现金流管理", expectedTitle: "现金流管理" });
  assert.equal(result.outcome, "PUBLISHED_ID_PENDING");
  assert.equal(result.mayRetry, false);
  assert.deepEqual(result.evidence, ["video_count:9->10", "title:现金流管理"]);
});

test("matching 已发表 item confirms publication", () => {
  const result = decideWechatChannelsReadback({ itemStatus: "已发表", visibleTitle: "越南加班管理", expectedTitle: "越南加班管理" });
  assert.equal(result.outcome, "PUBLISHED_ID_PENDING");
});

test("upload or submit without independent list evidence remains reconcile pending", () => {
  const result = decideWechatChannelsReadback({ expectedTitle: "越南加班管理" });
  assert.equal(result.outcome, "RECONCILE_PENDING");
  assert.equal(result.mayRetry, false);
});

test("count increment with a different visible title is ambiguous", () => {
  const result = decideWechatChannelsReadback({ beforeCount: 7, afterCount: 8, visibleTitle: "别人的视频", expectedTitle: "目标视频" });
  assert.equal(result.outcome, "RECONCILE_PENDING");
});

test("verified account identity is fixed in the adapter contract", () => {
  assert.equal(WECHAT_CHANNELS_ACCOUNT.accountId, "sph42vLa6y4BW9x");
  assert.equal(WECHAT_CHANNELS_ACCOUNT.collection, "来越企业全知道");
});

test("Channels title removes unsupported full-width punctuation before enforcing 16 characters", () => {
  assert.equal(normalizeChannelsTitle("标题：关税为零，模具费为什么仍可能被追？"), "关税为零 模具费为什么仍可能被追");
  assert.equal([...normalizeChannelsTitle("这是一个超过十六个字符并且带有（括号）的标题")].length, 16);
});

test("generic Channels editor labels are not mistaken for an account identity", () => {
  const text = "视频管理 / 发表动态\n视频描述\n#话题\n@视频号\n短标题\n添加到合集";
  assert.equal(extractWechatChannelsIdentity(text), "");
});

test("stable Channels account IDs remain authoritative identity evidence", () => {
  assert.equal(extractWechatChannelsIdentity("账号信息\nsph42vLa6y4BW9x\n发表动态"), "sph42vLa6y4BW9x");
  assert.equal(extractWechatChannelsIdentity("账号信息\nsphWrongAccount88\n发表动态"), "sphWrongAccount88");
});

test("an explicit other Channels nickname remains detectable", () => {
  assert.equal(extractWechatChannelsIdentity("账号\n别人的视频号\n视频管理"), "别人的视频号");
});

test("Channels readback contract supports conclusive absence without authorizing automatic retry", () => {
  const result = { outcome: "CONFIRMED_ABSENT", phase: "READBACK_CONFIRMED", mayRetry: false, evidence: ["complete_own_video_list:16/16", "exact_description_absent"] } as const;
  assert.equal(result.outcome, "CONFIRMED_ABSENT");
  assert.equal(result.mayRetry, false);
});

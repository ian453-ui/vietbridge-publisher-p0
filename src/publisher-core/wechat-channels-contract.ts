export const WECHAT_CHANNELS_ACCOUNT = {
  displayName: "山石ly的视频号",
  accountId: "sph42vLa6y4BW9x",
  collection: "来越企业全知道"
} as const;

export const WECHAT_CHANNELS_PHASES = [
  "SESSION_CHECK",
  "ACCOUNT_VERIFIED",
  "EDITOR_READY",
  "UPLOADING",
  "UPLOAD_COMPLETE",
  "FORM_VERIFIED",
  "SUBMIT_CLICKED",
  "READBACK_PENDING",
  "READBACK_CONFIRMED",
  "READBACK_AMBIGUOUS"
] as const;

export type WechatChannelsPhase = typeof WECHAT_CHANNELS_PHASES[number];

export type WechatChannelsReadback = {
  beforeCount?: number;
  afterCount?: number;
  itemStatus?: string;
  visibleTitle?: string;
  expectedTitle: string;
};

export type WechatChannelsReadbackDecision = {
  outcome: "PUBLISHED_ID_PENDING" | "RECONCILE_PENDING" | "CONFIRMED_ABSENT";
  phase: "READBACK_CONFIRMED" | "READBACK_AMBIGUOUS";
  mayRetry: false;
  evidence: string[];
};

/**
 * Decide publication truth from the independent list/history surface.
 * Upload progress, a submit click, toast text, or navigation alone are not accepted.
 */
export function decideWechatChannelsReadback(input: WechatChannelsReadback): WechatChannelsReadbackDecision {
  const evidence: string[] = [];
  const countIncremented = Number.isInteger(input.beforeCount) && Number.isInteger(input.afterCount)
    && input.afterCount! > input.beforeCount!;
  const titleMatches = Boolean(input.visibleTitle?.trim()) && input.visibleTitle!.trim() === input.expectedTitle.trim();
  const publishedMarker = /已发表|已发布/u.test(input.itemStatus ?? "");

  if (countIncremented) evidence.push(`video_count:${input.beforeCount}->${input.afterCount}`);
  if (titleMatches) evidence.push(`title:${input.visibleTitle}`);
  if (publishedMarker) evidence.push(`status:${input.itemStatus}`);

  if ((countIncremented && titleMatches) || (publishedMarker && titleMatches)) {
    return { outcome: "PUBLISHED_ID_PENDING", phase: "READBACK_CONFIRMED", mayRetry: false, evidence };
  }
  return {
    outcome: "RECONCILE_PENDING",
    phase: "READBACK_AMBIGUOUS",
    mayRetry: false,
    evidence: evidence.length ? evidence : ["no_authoritative_list_readback"]
  };
}


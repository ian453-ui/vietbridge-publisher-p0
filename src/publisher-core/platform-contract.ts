import { existsSync } from "node:fs";
import { canonicalJson, sha256 } from "./util.ts";

export const SUPPORTED_PLATFORMS = ["xiaohongshu", "facebook", "wechat_channels", "wechat_official_account"] as const;
export type SupportedPlatform = typeof SUPPORTED_PLATFORMS[number];
export type MediaType = "image" | "video" | "article";

export type UnifiedPublication = {
  articleId: string;
  mediaRevision: string;
  platform: SupportedPlatform;
  accountId: string;
  mediaType: MediaType;
  title: string;
  body: string;
  tags: string[];
  localMedia: string[];
  publicMediaUrl?: string;
  visibility: string;
  products: unknown[];
  isOriginal?: boolean;
  theme?: string;
  approvalRef: string;
};

export type Capability = {
  image: boolean;
  video: boolean;
  article: boolean;
  execution: "mcp" | "graph_api" | "chrome" | "draft_api";
  terminalSemantics: "live_post" | "draft_only";
  validation: "live_verified" | "historically_verified_browser_flow";
};

export const PLATFORM_CAPABILITIES: Record<SupportedPlatform, Capability> = {
  xiaohongshu: { image: true, video: true, article: false, execution: "mcp", terminalSemantics: "live_post", validation: "live_verified" },
  facebook: { image: true, video: true, article: false, execution: "graph_api", terminalSemantics: "live_post", validation: "live_verified" },
  wechat_channels: { image: false, video: true, article: false, execution: "chrome", terminalSemantics: "live_post", validation: "historically_verified_browser_flow" },
  wechat_official_account: { image: true, video: false, article: true, execution: "draft_api", terminalSemantics: "draft_only", validation: "live_verified" }
};

export type ValidationContext = {
  chromeConnected?: boolean;
  managedProfileHealthy?: boolean;
  loggedInAccountId?: string;
  publicUrlReachable?: boolean;
  publicUrlHashMatches?: boolean;
};

export type PublicationPlan = {
  ok: boolean;
  errors: string[];
  warnings: string[];
  fingerprint: string;
  operation: string;
  expectedOutcome: "PUBLISHED" | "DRAFT_API_WRITTEN_NOT_PUBLISHED";
  normalized: UnifiedPublication;
};

export function planPublication(input: UnifiedPublication, context: ValidationContext = {}): PublicationPlan {
  const normalized = { ...input, tags: [...new Set(input.tags.map(x => x.trim()).filter(Boolean))] };
  const capability = PLATFORM_CAPABILITIES[input.platform];
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!input.articleId) errors.push("articleId required");
  if (!input.mediaRevision) errors.push("mediaRevision required");
  if (!input.accountId) errors.push("accountId required");
  if (!input.approvalRef) errors.push("approvalRef required");
  if (!input.title.trim()) errors.push("title required");
  if (!input.body.trim()) errors.push("body required");
  if (!input.visibility) errors.push("visibility required");
  if (context.loggedInAccountId && context.loggedInAccountId !== input.accountId) errors.push("ACCOUNT_IDENTITY_MISMATCH");
  if (!capability[input.mediaType]) errors.push(`BLOCKED_CAPABILITY: ${input.platform} does not support ${input.mediaType}`);
  for (const path of input.localMedia) if (!existsSync(path)) errors.push(`media missing: ${path}`);

  if (input.platform === "xiaohongshu") {
    if ([...input.title].length > 20) errors.push("title exceeds 20 characters");
    if (/(^|\n)\s*#[^\s#]+/u.test(input.body)) errors.push("body contains hashtag lines; use tags array");
    if (input.mediaType === "video" && input.localMedia.length !== 1) errors.push("XHS video requires exactly one local video");
    if (input.mediaType === "image" && input.localMedia.length < 1) errors.push("XHS image post requires local images");
  }

  if (input.platform === "facebook" && input.mediaType === "video") {
    if (!input.publicMediaUrl) errors.push("Facebook video requires a public HTTPS URL");
    if (input.publicMediaUrl && !input.publicMediaUrl.startsWith("https://")) errors.push("Facebook video URL must use HTTPS");
    if (context.publicUrlReachable === false) errors.push("public video URL is not reachable");
    if (context.publicUrlHashMatches === false) errors.push("public video hash mismatch");
  }

  if (input.platform === "wechat_channels") {
    if (!context.chromeConnected) errors.push("CHROME_NOT_CONNECTED");
    if (context.managedProfileHealthy === false) errors.push("MANAGED_PROFILE_UNHEALTHY");
    if (input.mediaType !== "video" || input.localMedia.length !== 1) errors.push("WeChat Channels requires exactly one local video");
    warnings.push("Historically verified browser flow; independent local adapter migration is in progress");
    warnings.push("Upload, submit and authoritative list readback are separate states");
  }

  if (input.platform === "wechat_official_account") {
    if (input.mediaType === "video") errors.push("BLOCKED_CAPABILITY: Official Account connector cannot publish this MP4");
    if (!input.theme) errors.push("WeChat Official Account theme required");
    warnings.push("Draft API success is not formal publication or group send");
  }

  const operation = operationFor(input.platform, input.mediaType);
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    fingerprint: sha256(canonicalJson(normalized)),
    operation,
    expectedOutcome: capability.terminalSemantics === "draft_only" ? "DRAFT_API_WRITTEN_NOT_PUBLISHED" : "PUBLISHED",
    normalized
  };
}

function operationFor(platform: SupportedPlatform, mediaType: MediaType): string {
  if (platform === "xiaohongshu") return mediaType === "video" ? "publish_with_video" : "publish_content";
  if (platform === "facebook") return mediaType === "video" ? "fb_publish_reel" : "fb_publish_photo";
  if (platform === "wechat_channels") return "chrome_upload_and_publish_video";
  return "wenyan_publish_article_to_draft";
}


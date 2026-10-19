import { canonicalJson, sha256 } from "./util.ts";

export type XiaohongshuPayload = {
  title: string;
  body: string;
  tags: string[];
  images: string[];
  visibility: string;
  isOriginal: boolean;
  products: unknown[];
};

export type XiaohongshuReadConnector = {
  loginStatus(): Promise<{ loggedIn: boolean; accountId?: string }>;
  findPublished(input: { accountId: string; payloadFingerprint: string; returnedId?: string; title?: string; xsecToken?: string }): Promise<{
    status: "match" | "absent" | "unavailable";
    noteId?: string;
    url?: string;
    evidence?: unknown;
  }>;
};

export class XiaohongshuDriver {
  private connector: XiaohongshuReadConnector;

  constructor(connector: XiaohongshuReadConnector) {
    this.connector = connector;
  }

  async preflight(expectedAccountId: string): Promise<{ ok: boolean; reason?: string }> {
    const status = await this.connector.loginStatus();
    if (!status.loggedIn) return { ok: false, reason: "SESSION_EXPIRED" };
    if (!status.accountId || status.accountId !== expectedAccountId) return { ok: false, reason: "ACCOUNT_IDENTITY_MISMATCH" };
    return { ok: true };
  }

  dryRun(payload: XiaohongshuPayload): { ok: boolean; fingerprint: string; errors: string[]; normalized: XiaohongshuPayload } {
    const normalized = { ...payload, tags: [...new Set(payload.tags.map(x => x.trim()).filter(Boolean))] };
    const errors: string[] = [];
    if (!normalized.title.trim()) errors.push("title required");
    if ([...normalized.title].length > 20) errors.push("title exceeds 20 characters");
    if (!normalized.body.trim()) errors.push("body required");
    if (/(^|\n)\s*#[^\s#]+/u.test(normalized.body)) errors.push("body contains hashtag lines; use tags array");
    if (normalized.images.length === 0) errors.push("at least one image required");
    if (!normalized.visibility) errors.push("visibility required");
    return { ok: errors.length === 0, fingerprint: sha256(canonicalJson(normalized)), errors, normalized };
  }

  async readback(accountId: string, payloadFingerprint: string, returnedId?: string, title?: string, xsecToken?: string) {
    return this.connector.findPublished({ accountId, payloadFingerprint, returnedId, title, xsecToken });
  }

  async submit(): Promise<never> {
    throw new Error("BLOCKED_CAPABILITY: live Xiaohongshu submit is not wired in P0 milestone 1");
  }
}


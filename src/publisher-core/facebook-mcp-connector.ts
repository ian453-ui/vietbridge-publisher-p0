import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export class FacebookMcpConnector {
  private client = new Client({ name: "vietbridge-publisher-p0", version: "0.2.0" });
  private connected = false;
  private configFile?: string;

  async useConfig(configFile:string):Promise<void>{if(this.configFile===configFile)return;await this.close();this.configFile=configFile;}

  async connect(): Promise<void> {
    if (this.connected) return;
    const transport = new StdioClientTransport({
      command: "/Users/a1-6/claude/fb-mcp/run-facebook-secure.sh",
      args: [],
      env: { ...process.env, VIETBRIDGE_SOCIAL_CREDENTIALS_FILE: this.configFile ?? process.env.VIETBRIDGE_SOCIAL_CREDENTIALS_FILE ?? "" } as Record<string,string>
    });
    await this.client.connect(transport);
    this.connected = true;
  }

  async close(): Promise<void> {
    if (!this.connected) return;
    await this.client.close();
    this.connected = false;
  }

  async call(name: "fb_get_auth_status" | "fb_publish_post" | "fb_publish_photo" | "fb_publish_photos" | "fb_publish_reel" | "fb_get_video_status" | "fb_get_post_details" | "fb_get_page_feed" | "fb_get_post_comments" | "fb_search_public_posts" | "fb_check_interaction_rules" | "fb_comment_on_post" | "fb_get_interaction_log", args: Record<string, unknown> = {}): Promise<unknown> {
    // Authorization can be updated outside this long-running worker. Reload
    // secure credentials before preflight, never during an uncertain submission.
    if (name === "fb_get_auth_status") await this.close();
    await this.connect();
    // Multi-photo publication uploads up to ten photos sequentially (each
    // request may take 60s), then creates the post. A 3-minute RPC deadline
    // abandons a still-running operation before it returns its receipt.
    const timeout = name === "fb_publish_photos" && args.dry_run !== true ? 720_000 : 180_000;
    const result = await this.client.callTool({ name, arguments: args }, undefined, { timeout });
    const content = Array.isArray(result.content) ? result.content : [];
    const text = content
      .filter((item): item is { type: "text"; text: string } => item.type === "text" && typeof item.text === "string")
      .map(item => item.text).join("\n");
    let parsed: unknown;
    try { parsed = JSON.parse(text); }
    catch { parsed = { text }; }
    const value = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : { text: String(parsed ?? text) };
    if (result.isError || value.isError === true) {
      throw new Error(facebookToolError(value));
    }
    return value;
  }
}

export function assertFacebookReady(auth: unknown): void {
  const value = auth && typeof auth === "object" ? auth as Record<string, unknown> : {};
  if (value.status === "ready") return;
  const reason = String(value.reason ?? "授权状态无法确认")
    .replace(/EAA[A-Za-z0-9_-]+/g, "[REDACTED]");
  throw new Error(`Facebook 授权未就绪（${String(value.status ?? "unknown")}）：${reason}`);
}

export function facebookToolError(value: Record<string, unknown>): string {
  const message = String(value.text ?? value.message ?? "Facebook connector returned an error")
    .replace(/^[\s❌]+/u, "").trim();
  if (/timeout|timed out|ECONN|ENET|EAI_AGAIN|network/i.test(message)) {
    return `FACEBOOK_TEMPORARILY_UNAVAILABLE: ${message}`;
  }
  return message;
}


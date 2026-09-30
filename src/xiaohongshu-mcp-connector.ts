import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { XiaohongshuReadConnector } from "./xiaohongshu-driver.ts";

const READ_TOOLS = new Set(["check_login_status", "get_my_profile", "list_feeds", "search_feeds", "get_feed_detail", "user_profile"]);
const WRITE_TOOLS = new Set(["publish_content", "publish_with_video"]);

export class XiaohongshuToolError extends Error {
  readonly tool: string;
  readonly category: 'TIMEOUT'|'LOGIN_REQUIRED'|'TOOL_ERROR';
  constructor(tool: string, category: 'TIMEOUT'|'LOGIN_REQUIRED'|'TOOL_ERROR') {
    super(category==='TIMEOUT'
      ? `小红书${tool}读取超时；未提交，请检查创作者平台网络及登录后重试`
      : category==='LOGIN_REQUIRED'
      ? `小红书需要重新登录（${tool}）；未提交`
      : `小红书读取失败（${tool}）；未提交，不能据此判定平台状态`);
    this.name='XiaohongshuToolError';
    this.tool=tool;
    this.category=category;
  }
}

export class XiaohongshuMcpConnector implements XiaohongshuReadConnector {
  private client: Client;
  private connected = false;
  private endpoint: string;

  constructor(endpoint = "http://127.0.0.1:18060/mcp") {
    this.endpoint = endpoint;
    this.client = this.newClient();
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    try {
      await this.client.connect(new StreamableHTTPClientTransport(new URL(this.endpoint)));
      this.connected = true;
    } catch (error) {
      await this.client.close().catch(() => undefined);
      this.client = this.newClient();
      this.connected = false;
      throw error;
    }
  }

  async close(): Promise<void> {
    try { await this.client.close(); }
    finally { this.connected = false; this.client = this.newClient(); }
  }

  async availableReadTools(): Promise<string[]> {
    await this.connect();
    const result = await this.client.listTools();
    return result.tools.map(t => t.name).filter(name => READ_TOOLS.has(name)).sort();
  }

  async publishVideo(input: {
    title: string; content: string; video: string; tags: string[];
    visibility: string; products: unknown[];
  }): Promise<{ text: string; raw: unknown }> {
    await this.connect();
    const result = await this.client.callTool({ name: "publish_with_video", arguments: input }, undefined, { timeout: 600_000 });
    const content = Array.isArray(result.content) ? result.content : [];
    const text = content
      .filter((item): item is { type: "text"; text: string } => item.type === "text" && typeof item.text === "string")
      .map(item => item.text).join("\n");
    return { text, raw: result };
  }

  async publishImages(input: {
    title: string; content: string; images: string[]; tags: string[];
    visibility: string; is_original: boolean; products: unknown[];
  }): Promise<{ text: string; raw: unknown }> {
    await this.connect();
    // Image notes also spend several minutes resolving topic suggestions.
    // A timeout remains ambiguous and must never trigger another publish call.
    const result = await this.client.callTool({ name: "publish_content", arguments: input }, undefined, { timeout: 600_000 });
    const content = Array.isArray(result.content) ? result.content : [];
    const text = content.filter((item): item is { type: "text"; text: string } => item.type === "text" && typeof item.text === "string").map(item => item.text).join("\n");
    return { text, raw: result };
  }

  async loginStatus(): Promise<{ loggedIn: boolean; accountId?: string }> {
    const text = await this.callText("check_login_status", {});
    const loggedIn = /已登录|logged\s*in/i.test(text) && !/未登录|not\s*logged/i.test(text);
    if(!loggedIn)return {loggedIn:false};
    // The connector can report an empty username followed by a success hint.
    // Never treat the hint on the next line as the account identity.
    const username = text.match(/用户名[ \t]*[:：][ \t]*([^\n\r]*)/)?.[1]?.trim();
    if(username)return {loggedIn:true,accountId:`username:${username}`};
    const nicknameFrom=(raw:string)=>{try{const profile=JSON.parse(raw) as {userBasicInfo?:{nickname?:unknown}};return typeof profile.userBasicInfo?.nickname==='string'?profile.userBasicInfo.nickname.trim():'';}catch{return '';}};
    let nickname=nicknameFrom(await this.readOnceMoreOnTimeout("get_my_profile",{tab:"note"}));
    if(!nickname){
      // A page that has not finished loading may return valid JSON without
      // identity. Reconnect and try one more read, but never invent an account.
      await this.close();
      nickname=nicknameFrom(await this.readOnceMoreOnTimeout("get_my_profile",{tab:"note"}));
    }
    return {loggedIn:true,accountId:nickname?`username:${nickname}`:undefined};
  }

  async readbackHealth(): Promise<{ ok: boolean; feedCount: number }> {
    // The upstream personal-profile tool navigates via a brittle sidebar selector.
    // Search uses a separate route and is also the bounded post-submit readback.
    const text=await this.readOnceMoreOnTimeout("search_feeds",{keyword:"越南",filters:{sort_by:"最新",publish_time:"不限",note_type:"不限",search_scope:"不限",location:"不限"}});
    try {
      const parsed=JSON.parse(text) as {feeds?:unknown[]};
      return {ok:Array.isArray(parsed.feeds),feedCount:Array.isArray(parsed.feeds)?parsed.feeds.length:0};
    } catch { return {ok:false,feedCount:0}; }
  }

  async findPublished(input: { accountId: string; payloadFingerprint: string; returnedId?: string; title?: string; xsecToken?: string }): Promise<{
    status: "match" | "absent" | "unavailable"; noteId?: string; url?: string; evidence?: unknown;
  }> {
    if (input.returnedId && input.xsecToken) {
      const text = await this.callText("get_feed_detail", { feed_id: input.returnedId, xsec_token: input.xsecToken, load_all_comments: false });
      if (text.includes(input.returnedId)) return { status: "match", noteId: input.returnedId, evidence: { method: "get_feed_detail" } };
    }
    if (!input.title) return { status: "unavailable", evidence: { reason: "title_or_detail_token_required" } };
    const text = await this.callText("search_feeds", { keyword: input.title, filters: { sort_by: "最新", publish_time: "不限", note_type: "不限", search_scope: "不限", location: "不限" } }).catch(()=>"");
    const expectedUsername = input.accountId.replace(/^username:/, "");
    const match = findOwnFeed(text,input.title,expectedUsername);
    if (match && (!input.returnedId || match.id===input.returnedId)) {
      return { status: "match", noteId:match.id,url:`https://www.xiaohongshu.com/discovery/item/${match.id}`, evidence: { method: "search_feeds_exact_title_author_same_item" } };
    }
    // The upstream sidebar selector can time out; only visit it when search
    // cannot establish an exact own-author match.
    const ownProfile = await this.callText("get_my_profile", { tab: "note" }).catch(() => "");
    const ownFeed = findOwnFeed(ownProfile, input.title, expectedUsername);
    if (ownFeed && (!input.returnedId || ownFeed.id === input.returnedId)) {
      return {
        status: "match", noteId: ownFeed.id,
        url: `https://www.xiaohongshu.com/discovery/item/${ownFeed.id}`,
        evidence: { method: "get_my_profile_exact_title_author", xsecTokenPresent: Boolean(ownFeed.xsecToken) }
      };
    }
    if(!text)return {status:"unavailable",evidence:{reason:"own_profile_checked_search_temporarily_unavailable",ownProfileReadback:Boolean(ownProfile)}};
    return { status: "unavailable", evidence: { reason: "bounded_search_cannot_prove_absence" } };
  }

  private async callText(name: string, args: Record<string, unknown>): Promise<string> {
    if (!READ_TOOLS.has(name)) throw new Error(`Read-only connector refuses tool: ${name}`);
    await this.connect();
    // Browser-backed reads can stall after a VPN flap; never leave the local
    // worker waiting indefinitely before it can report a safe preflight error.
    let result;
    try {
      result = await this.client.callTool({ name, arguments: args }, undefined, { timeout: 75_000 });
    } catch (error) {
      if (/timeout|timed out|deadline|超时|-32001/i.test(String(error))) {
        throw new XiaohongshuToolError(name, 'TIMEOUT');
      }
      throw error;
    }
    if(result.isError){
      const diagnostic=Array.isArray(result.content)?result.content.filter((item):item is {type:'text';text:string}=>item.type==='text'&&typeof item.text==='string').map(item=>item.text).join(' '):'';
      const category=/timeout|timed out|deadline|超时/i.test(diagnostic)?'TIMEOUT':/未登录|扫码登录|login required|not logged in/i.test(diagnostic)?'LOGIN_REQUIRED':'TOOL_ERROR';
      throw new XiaohongshuToolError(name,category);
    }
    const content = Array.isArray(result.content) ? result.content : [];
    return content.filter((item): item is { type: "text"; text: string } => item.type === "text" && typeof item.text === "string").map(item => item.text).join("\n");
  }

  private async readOnceMoreOnTimeout(name:string,args:Record<string,unknown>):Promise<string>{
    try{return await this.callText(name,args);}
    catch(error){
      if(!(error instanceof XiaohongshuToolError)||error.category!=='TIMEOUT')throw error;
      // A stalled Streamable HTTP session can outlive a VPN interruption.
      // Reset only the local client, then retry this read-only probe once.
      await this.close();
      return this.callText(name,args);
    }
  }

  private newClient(): Client {
    return new Client({ name: "vietbridge-publisher-p0", version: "0.1.0" });
  }
}

export function findOwnFeed(text: string, expectedTitle: string, expectedAuthor: string): { id: string; xsecToken?: string } | undefined {
  try {
    const parsed = JSON.parse(text) as { feeds?: Array<{ id?: unknown; xsecToken?: unknown; noteCard?: { displayTitle?: unknown; user?: { nickname?: unknown; nickName?: unknown } } }> };
    const matches = parsed.feeds?.filter(feed => {
      const author = String(feed.noteCard?.user?.nickname ?? feed.noteCard?.user?.nickName ?? "");
      return String(feed.noteCard?.displayTitle ?? "").trim() === expectedTitle.trim() && author.trim() === expectedAuthor.trim();
    });
    const match = matches?.length===1 ? matches[0] : undefined;
    if (!match?.id) return undefined;
    return { id: String(match.id), xsecToken: match.xsecToken ? String(match.xsecToken) : undefined };
  } catch { return undefined; }
}

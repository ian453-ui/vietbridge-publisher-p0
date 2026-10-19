import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {resolve} from 'node:path';

export class WenyanMcpConnector {
  private client = new Client({ name: "vietbridge-publisher-p0", version: "0.3.0" });
  private connected = false;

  private options:{configPath:string;expectedAppId:string;entry:string};
  constructor(options:{configPath:string;expectedAppId:string;entry:string}) {this.options=options;}

  async connect(): Promise<void> {
    if (this.connected) return;
    const env = {...process.env} as Record<string,string>;
    try {
      const text=readFileSync(this.options.configPath,'utf8');
      for(const key of ['WECHAT_APP_ID','WECHAT_APP_SECRET']) {
        delete env[key];
        const match=text.match(new RegExp('^(?:export\\s+)?'+key+'\\s*=\\s*(.*)$','m'));
        if(match) env[key]=match[1].trim().replace(/^(["'])(.*)\1$/,'$2');
      }
    } catch { throw new Error("公众号授权配置不可读取"); }
    if(env.WECHAT_APP_ID!==this.options.expectedAppId||!env.WECHAT_APP_SECRET)throw new Error("公众号授权身份不匹配");
    await this.client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [this.options.entry],
      env
    }));
    this.connected = true;
  }

  async close(): Promise<void> { if (this.connected) await this.client.close(); this.connected = false; }

  async call(name: "list_themes" | "publish_article", args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
    await this.connect();
    const result = await this.client.callTool({ name, arguments: args }, undefined, { timeout: 180_000 });
    const text = (Array.isArray(result.content) ? result.content : [])
      .filter((item): item is { type: "text"; text: string } => item.type === "text" && typeof item.text === "string")
      .map(item => item.text).join("\n");
    return { text, isError: Boolean(result.isError) };
  }
}


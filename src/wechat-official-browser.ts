import {existsSync,mkdirSync} from 'node:fs';
import {homedir} from 'node:os';
import {resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {chromium} from 'playwright-core';

export type WechatBrowserStatus={running:boolean;loggedIn:boolean;loginRequired:boolean;url?:string;title?:string;account?:string;profileDir:string;message:string};

export class WechatOfficialBrowser {
  readonly port:number;
  readonly profileDir:string;
  readonly executable:string;
  constructor(options:{port?:number;profileDir?:string;executable?:string}={}){
    this.port=options.port??17922;
    this.profileDir=options.profileDir??resolve(homedir(),'Library/Application Support/VietBridgePublisher/chrome-profiles/vietbridge-wechat');
    this.executable=options.executable??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  }
  async launch():Promise<WechatBrowserStatus>{
    const current=await this.status();if(current.running)return current;
    if(!existsSync(this.executable))throw Error('未找到 Google Chrome');
    mkdirSync(this.profileDir,{recursive:true});
    const child=spawn(this.executable,[`--remote-debugging-port=${this.port}`,`--user-data-dir=${this.profileDir}`,'--no-first-run','--no-default-browser-check','--new-window','https://mp.weixin.qq.com/'],{detached:true,stdio:'ignore'});child.unref();
    for(let i=0;i<20;i++){await new Promise(r=>setTimeout(r,250));const state=await this.status();if(state.running)return state;}
    throw Error('公众号专用 Chrome 启动超时');
  }
  async status():Promise<WechatBrowserStatus>{
    const base={profileDir:this.profileDir};
    try{
      const response=await fetch(`http://127.0.0.1:${this.port}/json/version`,{signal:AbortSignal.timeout(800)});if(!response.ok)throw Error('not running');
      const browser=await chromium.connectOverCDP(`http://127.0.0.1:${this.port}`);
      try{
        const pages=browser.contexts().flatMap(context=>context.pages()),page=pages.find(p=>/mp\.weixin\.qq\.com/.test(p.url()))??pages[0];
        if(!page)return {running:true,loggedIn:false,loginRequired:true,...base,message:'窗口已打开，请登录公众号'};
        const url=page.url(),title=await page.title().catch(()=>''),body=(await page.locator('body').innerText({timeout:2500}).catch(()=>'' )).slice(0,12000);
        const loginRequired=/扫码登录|使用微信扫一扫|登录公众号|安全验证/.test(body)||/\/cgi-bin\/loginpage/.test(url);
        const loggedIn=!loginRequired&&(/公众号设置|首页|内容与互动|新的创作|发表记录|数据与增长/.test(body)||/cgi-bin\/home/.test(url));
        const account=body.match(/(?:公众号|账号名称)[:：\s]*([^\n]{2,40})/)?.[1]?.trim();
        return {running:true,loggedIn,loginRequired:!loggedIn,url,title,account,...base,message:loggedIn?'已连接公众号后台，可执行只读校验':'专用窗口已打开，请在该窗口完成一次扫码登录'};
      } finally {await browser.close();}
    }catch{return {running:false,loggedIn:false,loginRequired:true,...base,message:'公众号专用 Chrome 尚未启动'};}
  }
  async readVisibleInventory():Promise<{status:WechatBrowserStatus;items:{title:string;url:string;channel:'published'|'draft'|'visible'}[];checked_at:string}>{
    const status=await this.status();if(!status.running||!status.loggedIn)return {status,items:[],checked_at:new Date().toISOString()};
    const browser=await chromium.connectOverCDP(`http://127.0.0.1:${this.port}`);
    try{
      const context=browser.contexts()[0],home=context.pages().find(p=>/mp\.weixin\.qq\.com/.test(p.url()));if(!home)throw Error('公众号后台页面不存在');
      const readSection=async(label:string,channel:'published'|'draft',selectors:string[])=>{
        const href=await home.locator('a',{hasText:label}).first().getAttribute('href').catch(()=>null);if(!href)return [];
        const page=await context.newPage();
        try{
          const base=new URL(href,home.url()),all:{title:string;url:string;channel:'published'|'draft'}[]=[],seen=new Set<string>();
          for(let pageIndex=0;pageIndex<50;pageIndex++){
            base.searchParams.set('begin',String(pageIndex*10));base.searchParams.set('count','10');
            await page.goto(base.href,{waitUntil:'domcontentloaded',timeout:15000});await page.waitForTimeout(500);
            const selector=selectors.join(','),rows=await page.locator(selector).evaluateAll(nodes=>nodes.map(node=>{const anchor=node.closest('a')??node.querySelector('a');return {title:(node.textContent||'').replace(/\s+/g,' ').trim(),url:anchor instanceof HTMLAnchorElement?anchor.href:''};}).filter(x=>x.title.length>=4&&x.title.length<=180));
            const normalized=rows.map(x=>({...x,title:channel==='published'?x.title.replace(/\s+(?:原创|已修改)(?:\s|$).*/,'').trim():x.title,channel}));
            const fresh=normalized.filter(x=>{const key=x.title+'\0'+x.url;if(seen.has(key))return false;seen.add(key);return true});all.push(...fresh);
            if(rows.length<10||fresh.length===0)break;
          }
          return all;
        } finally {await page.close();}
      };
      const rows=[...await readSection('发表记录','published',['a.weui-desktop-mass-appmsg__title']),...await readSection('草稿箱','draft',['.weui-desktop-appmsg__title','.weui-desktop-card__title','[class*="appmsg"] [class*="title"]'])];
      const seen=new Set<string>(),items=rows.filter(x=>{const key=x.channel+'\0'+x.title+'\0'+x.url;if(seen.has(key))return false;seen.add(key);return true});
      return {status,items,checked_at:new Date().toISOString()};
    } finally {await browser.close();}
  }
}

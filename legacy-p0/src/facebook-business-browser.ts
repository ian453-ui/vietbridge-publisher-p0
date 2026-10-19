import {chromium, type Browser, type Page} from 'playwright-core';
import {parseConfig, type FacebookAccount} from './facebook-accounts.ts';

const clean=(value:string)=>value.replace(/\s+/g,' ').trim();

export function browserPageConfig(account:FacebookAccount):{port:number;browserPageId:string}|null{
  const config=parseConfig(account.config_url);
  if(!['false','0','off','no'].includes(String(config.FB_API_ENABLED||'').toLowerCase()))return null;
  const port=Number(config.FB_BROWSER_CDP_PORT),browserPageId=String(config.FB_BROWSER_PAGE_ID||'');
  if(!Number.isInteger(port)||port<1024||port>65535||!/^\d+$/.test(browserPageId))throw Error('Facebook 浏览器模式缺少有效端口或主页身份 ID');
  if(String(config.FB_PAGE_ID)!==account.page_id)throw Error('Facebook 浏览器模式的 Page ID 与任务账号不一致');
  return {port,browserPageId};
}

export class FacebookBusinessBrowser {
  private browser?:Browser;
  private composer?:Page;
  private readonly account:FacebookAccount;
  private readonly port:number;
  private readonly browserPageId:string;
  constructor(account:FacebookAccount,port:number,browserPageId:string){this.account=account;this.port=port;this.browserPageId=browserPageId}
  async connect():Promise<void>{this.browser=await chromium.connectOverCDP(`http://127.0.0.1:${this.port}`,{noDefaults:true,timeout:12000});if(!this.browser.contexts()[0])throw Error('Facebook 浏览器会话未就绪');}
  private async page(url:string):Promise<Page>{if(!this.browser)throw Error('Facebook 浏览器未连接');const page=await this.browser.contexts()[0].newPage();try{await page.goto(url,{waitUntil:'domcontentloaded',timeout:30000});return page}catch(error){await page.close();throw error}}
  private listUrl():string{return `https://business.facebook.com/latest/posts/published_posts/?asset_id=${this.account.page_id}`}
  private composerUrl():string{return `https://business.facebook.com/latest/composer?asset_id=${this.account.page_id}`}
  async publishedMatch(caption:string):Promise<{id:string;url:string}|null>{
    const page=await this.page(this.listUrl());try{
      await page.getByRole('grid',{name:'Published posts'}).waitFor({timeout:20000});
      const normalized=clean(caption),prefix=normalized.slice(0,110),suffix=normalized.slice(-90);
      const rows=page.getByRole('grid',{name:'Published posts'}).getByRole('row');
      for(let i=0;i<12&&await rows.count()<2;i++)await page.waitForTimeout(500);
      for(let i=0;i<await rows.count();i++){
        const row=rows.nth(i),text=clean(await row.innerText());
        if(!text.includes(prefix)||!text.includes(suffix))continue;
        const checkbox=row.getByRole('checkbox');if(!await checkbox.count())continue;
        const label=await checkbox.getAttribute('aria-label');
        const id=label?.match(/Select item with id (\d+)/)?.[1];
        if(!id)continue;
        return {id,url:`https://www.facebook.com/${this.browserPageId}/posts/${id}`};
      }
      return null;
    }finally{await page.close()}
  }
  async fill(caption:string,images:string[]):Promise<void>{
    if(!images.length)throw Error('Facebook 浏览器发布需要图片');
    this.composer=await this.page(this.composerUrl());const page=this.composer;
    const editor=page.getByLabel('Write into the dialogue box to include text with your post.');
    await editor.waitFor({timeout:20000});
    const body=clean(await page.locator('body').innerText());
    if(!body.includes('Post to')||!body.includes(this.account.page_name)||!body.includes('Public')||!await page.getByRole('combobox',{name:`Post to ${this.account.page_name}`}).count())throw Error('Facebook 浏览器 Page 身份或公开可见性未核实');
    await editor.fill(caption,{timeout:15000});
    if(clean(await editor.innerText())!==clean(caption))throw Error('Facebook 浏览器正文回读与已批准文案不一致');
    const chooser=page.waitForEvent('filechooser',{timeout:10000});
    await page.getByText('Add photo/video',{exact:true}).click({timeout:10000});
    await(await chooser).setFiles(images);
    const publish=page.getByRole('button',{name:'Publish',exact:true});
    await page.waitForTimeout(2000);
    for(let i=0;i<15&&!await publish.isEnabled();i++)await page.waitForTimeout(1000);
    if(await page.getByRole('button',{name:'Remove photo'}).count()!==images.length)throw Error('Facebook 浏览器图片数量与已批准内容不一致');
    if(!await page.getByRole('radio',{name:/^Public Anyone/}).isChecked())throw Error('Facebook 浏览器公开范围未核实');
    for(const name of ['Share to Facebook Story','Make this an ad post','Set date and time','Boost'])if(await page.getByRole('switch',{name}).isChecked())throw Error(`Facebook 浏览器意外开启了 ${name}`);
    if(!await publish.isEnabled())throw Error(`Facebook 浏览器发布按钮未就绪：${clean(await page.locator('body').innerText()).slice(-300)}`);
  }
  async submit():Promise<void>{if(!this.composer)throw Error('Facebook 发布表单未准备');await this.composer.getByRole('button',{name:'Publish',exact:true}).click({timeout:15000})}
  async readback(caption:string):Promise<{id:string;url:string}>{for(let i=0;i<8;i++){const match=await this.publishedMatch(caption).catch(()=>null);if(match)return match;await new Promise(resolve=>setTimeout(resolve,2500))}throw Error('Facebook 已点击发布，但未从已发表列表读回匹配内容')}
  async close():Promise<void>{await this.composer?.close().catch(()=>{});await this.browser?.close().catch(()=>{})}
}

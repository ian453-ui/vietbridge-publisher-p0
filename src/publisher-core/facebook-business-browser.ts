import {chromium, type Browser, type BrowserContext, type Page} from 'playwright-core';
import {createHash} from 'node:crypto';
import {basename} from 'node:path';
import {readFileSync} from 'node:fs';
import {parseConfig, type FacebookAccount} from './facebook-accounts.ts';
import {boundedRead,waitForImageReadiness,recheckImageReadiness,captureReadinessFailure,defaultReadinessBudget,type ReadinessBudget} from './facebook-readiness-observation.ts';

const clean=(value:string)=>value.replace(/\s+/g,' ').trim();
export async function waitForImageAttachmentCount(page:Page,expected:number,timeoutMs=12000):Promise<void>{
  const controls=page.getByRole('button',{name:'Remove photo'}),deadline=Date.now()+timeoutMs;
  for(;;){
    const count=await controls.count();
    if(count===expected)return;
    if(count>expected||Date.now()>=deadline)throw Error('Facebook 浏览器图片数量与已批准内容不一致');
    await page.waitForTimeout(Math.min(250,Math.max(1,deadline-Date.now())));
  }
}
export function guardBrowserDialogs(context:BrowserContext,onDialog:()=>void):void{
  context.on('dialog',dialog=>{onDialog();void dialog.dismiss().catch(()=>{});});
}
const pngDimensions=(path:string):{width:number;height:number}|null=>{
  if(!path.toLowerCase().endsWith('.png'))return null;
  const bytes=readFileSync(path);if(bytes.length<24||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||bytes.toString('ascii',12,16)!=='IHDR')return null;
  const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20);return width>0&&height>0?{width,height}:null;
};

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
  private prepared?:{caption:string;images:number;video:boolean;mediaNames?:string[];mediaDimensions?:Array<{width:number;height:number}|null>};
  private verified=false;
  private lastEvidence:Record<string,unknown>={};
  private finalFormCheck?:()=>Promise<void>;
  private previewBinding?:string;
  private unexpectedDialog=false;
  private readinessBudget:ReadinessBudget=defaultReadinessBudget;
  private readonly account:FacebookAccount;
  private readonly port:number;
  private readonly browserPageId:string;
  constructor(account:FacebookAccount,port:number,browserPageId:string){this.account=account;this.port=port;this.browserPageId=browserPageId}
  async connect():Promise<void>{this.browser=await chromium.connectOverCDP(`http://127.0.0.1:${this.port}`,{noDefaults:true,timeout:12000});const context=this.browser.contexts()[0];if(!context)throw Error('Facebook 浏览器会话未就绪');guardBrowserDialogs(context,()=>{this.unexpectedDialog=true;});}
  private assertNoDialog():void{if(this.unexpectedDialog)throw Error('FACEBOOK_BROWSER_UNEXPECTED_DIALOG');}
  diagnosticContext(){if(!this.browser)throw Error('只读诊断会话未连接');return this.browser.contexts()[0];}
  private async page(url:string):Promise<Page>{if(!this.browser)throw Error('Facebook 浏览器未连接');const page=await this.browser.contexts()[0].newPage();try{await page.goto(url,{waitUntil:'domcontentloaded',timeout:30000});return page}catch(error){await page.close();throw error}}
  private listUrl():string{return `https://business.facebook.com/latest/posts/published_posts/?asset_id=${this.account.page_id}`}
  private composerUrl():string{return `https://business.facebook.com/latest/composer?asset_id=${this.account.page_id}`}
  async publishedMatch(caption:string,{video=false}:{video?:boolean}={}):Promise<{id:string;url:string}|null>{
    this.assertNoDialog();
    const page=await this.page(this.listUrl());try{
      await page.getByRole('grid',{name:'Published posts'}).waitFor({timeout:20000});
      const rows=page.getByRole('grid',{name:'Published posts'}).getByRole('row');
      for(let i=0;i<12&&await rows.count()<2;i++)await page.waitForTimeout(500);
      for(let i=0;i<await rows.count();i++){
        const row=rows.nth(i),text=clean(await row.innerText());
        if(!await row.getByText(caption,{exact:true}).count())continue;
        if(video&&!await row.getByText(/^(Video|视频)$/u).count()&&!await row.locator('video,a[href*="/videos/"]').count())continue;
        if(/Processing|Failed|处理中|失败/u.test(text))continue;
        const checkbox=row.getByRole('checkbox');if(!await checkbox.count())continue;
        const label=await checkbox.getAttribute('aria-label');
        const id=label?.match(/Select item with id (\d+)/)?.[1];
        if(!id)continue;
        this.assertNoDialog();return {id,url:`https://www.facebook.com/${this.browserPageId}/posts/${id}`};
      }
      return null;
    }finally{await page.close()}
  }
  async fill(caption:string,images:string[],{video=false,title=''}:{video?:boolean;title?:string}={}):Promise<void>{
    if(video&&(images.length!==1||!images[0].toLowerCase().endsWith('.mp4')))throw Error('Facebook 视频必须为单个已批准 MP4');
    this.prepared={caption,images:images.length,video,mediaNames:images.map(path=>basename(path)),mediaDimensions:images.map(pngDimensions)};this.previewBinding=undefined;this.verified=false;
    this.composer=await this.page(this.composerUrl());const page=this.composer;
    const editor=page.getByLabel('Write into the dialogue box to include text with your post.');
    await editor.waitFor({timeout:20000});
    const body=clean(await page.evaluate(() => document.body?.innerText ?? ''));
    if(!body.includes('Post to')||!body.includes(this.account.page_name)||!body.includes('Public')||!await page.getByRole('combobox',{name:`Post to ${this.account.page_name}`}).count())throw Error('Facebook 浏览器 Page 身份或公开可见性未核实');
    await editor.fill(caption,{timeout:15000});
    if(clean(await editor.innerText())!==clean(caption))throw Error('Facebook 浏览器正文回读与已批准文案不一致');
    if(images.length){if(await page.getByRole('button',{name:'Remove photo'}).count())throw Error('新编辑器已有媒体，禁止追加上传');const chooser=page.waitForEvent('filechooser',{timeout:10000});
    await page.getByText('Add photo/video',{exact:true}).click({timeout:10000});
    await(await chooser).setFiles(images);}
    const publish=page.getByRole('button',{name:'Publish',exact:true});
    await page.waitForTimeout(2000);
    for(let i=0;i<(video?180:15)&&!await publish.isEnabled();i++)await page.waitForTimeout(1000);
    if(video){
      const titleInput=page.getByRole('textbox',{name:/^(Video title|Title|视频标题|标题)$/u});
      if(await titleInput.count()){await titleInput.fill(title);if(clean(await titleInput.inputValue())!==clean(title))throw Error('视频标题回读不一致');}
      if(!await page.getByRole('button',{name:/^(Remove video|删除视频|移除视频)$/u}).count()&&!await page.locator('video').count())throw Error('未核实上传的视频预览');
      if(await page.getByRole('progressbar').count()||/Uploading|Processing video|上传中|视频处理中/u.test(await page.evaluate(() => document.body?.innerText ?? '')))throw Error('视频仍在上传或处理，未点击发布');
    }else if(images.length)await waitForImageAttachmentCount(page,images.length);
    if(!await page.getByRole('radio',{name:/^Public Anyone/}).isChecked())throw Error('Facebook 浏览器公开范围未核实');
    for(const name of ['Share to Facebook Story','Make this an ad post','Set date and time','Boost'])if(await page.getByRole('switch',{name}).isChecked())throw Error(`Facebook 浏览器意外开启了 ${name}`);
    await this.readiness();this.assertNoDialog();
  }
  /** Adopt only the one retained, already prepared composer for its original attempt. */
  async adoptPrepared(caption:string,images:string[]):Promise<void>{
    this.assertNoDialog();
    if(!this.browser||this.composer||!images.length||images.some(path=>!path.toLowerCase().endsWith('.png')))throw Error('RETAINED_COMPOSER_SCOPE_REQUIRED');
    const matches=this.browser.contexts()[0].pages().filter(page=>{
      try{const u=new URL(page.url());return u.hostname==='business.facebook.com'&&u.pathname==='/latest/composer'&&u.searchParams.get('asset_id')===this.account.page_id;}catch{return false;}
    });
    if(matches.length!==1)throw Error('RETAINED_COMPOSER_NOT_UNIQUE');
    this.composer=matches[0];this.prepared={caption,images:images.length,video:false,mediaNames:images.map(path=>basename(path)),mediaDimensions:images.map(pngDimensions)};
    this.previewBinding=undefined;this.verified=false;
    await this.readiness();this.assertNoDialog();
  }
  /** No force or synthetic click. Trial checks visibility/enabled/stability/occlusion without dispatch. */
  async readiness():Promise<Record<string,unknown>>{
    this.assertNoDialog();
    if(!this.composer||!this.prepared)throw Error('Facebook 发布表单未准备');
    const page=this.composer,expected=this.prepared,publish=page.getByRole('button',{name:'Publish',exact:true});
    await page.bringToFront?.();
    const evidence:Record<string,unknown>={checkedAt:new Date().toISOString(),targetPageId:this.account.page_id,operatorActorId:this.browserPageId,phase:'READINESS',finalClickAttempted:false};
    this.lastEvidence=evidence;
    try{
      const checkFrozen=async()=>{
      const url=new URL(page.url());evidence.composerTargetMatches=url.hostname==='business.facebook.com'&&url.pathname.startsWith('/latest/composer')&&url.searchParams.get('asset_id')===this.account.page_id;
      evidence.destinationCount=await page.getByRole('combobox',{name:`Post to ${this.account.page_name}`}).count();
      const editor=page.getByLabel('Write into the dialogue box to include text with your post.');
      const body=clean(await editor.innerText());evidence.bodyMatches=body===clean(expected.caption);evidence.bodySha256=createHash('sha256').update(body).digest('hex');
      evidence.publicChecked=await page.getByRole('radio',{name:/^Public Anyone/}).isChecked();
      const switches:Record<string,boolean>={};for(const name of ['Share to Facebook Story','Make this an ad post','Set date and time','Boost'])switches[name]=await page.getByRole('switch',{name}).isChecked();evidence.switches=switches;
      evidence.mediaCount=expected.video?await page.getByRole('button',{name:/^(Remove video|删除视频|移除视频)$/u}).count():await page.getByRole('button',{name:'Remove photo'}).count();
      evidence.mediaReady=expected.video?(evidence.mediaCount===1||await page.locator('video').count()===1)&&await page.getByRole('progressbar').count()===0&&!/Uploading|Processing video|上传中|视频处理中/u.test(await page.evaluate(() => document.body?.innerText ?? '')):evidence.mediaCount===expected.images;
      evidence.buttonCount=await publish.count();
      if(evidence.buttonCount!==1)throw Error('Facebook Publish 按钮不唯一，未点击');
      evidence.buttonVisible=await publish.isVisible();evidence.buttonEnabled=await publish.isEnabled();
      if(!evidence.composerTargetMatches||evidence.destinationCount!==1||!evidence.bodyMatches||!evidence.publicChecked||Object.values(switches).some(Boolean)||!evidence.mediaReady)throw Error('Facebook 冻结表单、目标或公开范围核对失败，未点击');
      if(!evidence.buttonVisible||!evidence.buttonEnabled)throw Error('Facebook Publish 按钮不可见或不可用，未点击');
      };
      this.finalFormCheck=checkFrozen;
      await boundedRead(checkFrozen,this.readinessBudget.callMs);
      // Meta's fixed footer already places Publish inside the viewport. Do
      // not wait for an unrelated animated region to stabilize just to scroll
      // a visible button. Offscreen buttons still use ordinary bounded scroll.
      const inViewport=page.bringToFront?await boundedRead(()=>page.evaluate(()=>{
        const buttons=[...document.querySelectorAll('[role="button"],button')].filter(e=>(e.getAttribute('aria-label')||e.textContent||'').replace(/[\u200b-\u200d\ufeff]/gu,'').trim()==='Publish');
        if(buttons.length!==1)return false;const r=buttons[0].getBoundingClientRect();
        return r.width>0&&r.height>0&&r.x>=0&&r.y>=0&&r.right<=innerWidth&&r.bottom<=innerHeight;
      }),this.readinessBudget.callMs):false;
      if(!inViewport)try{await boundedRead(()=>publish.scrollIntoViewIfNeeded({timeout:5000}),5100);}catch(error){evidence.failureReason='PUBLISH_BUTTON_SCROLL_FAILED';throw error;}
      if(!expected.video){evidence.previewSignature=this.previewBinding;await waitForImageReadiness(page,expected.images,evidence,this.readinessBudget,expected.mediaNames,expected.mediaDimensions);this.previewBinding=evidence.previewSignature as string|undefined;}
      // Re-read the frozen form after waiting, and after trial; an editor or
      // identity/target change during either interval must fail before dispatch.
      await boundedRead(checkFrozen,this.readinessBudget.callMs);
      try{await boundedRead(()=>publish.click({trial:true,timeout:5000}),5500);}catch(error){evidence.failureReason='ACTIONABILITY_TRIAL_FAILED';throw error;}
      evidence.actionabilityTrialPassed=true;
      await boundedRead(checkFrozen,this.readinessBudget.callMs);
      if(!expected.video)await recheckImageReadiness(page,expected.images,evidence,this.readinessBudget.callMs,expected.mediaNames,expected.mediaDimensions);
      this.assertNoDialog();return {...evidence};
    }catch(error){evidence.actionabilityTrialPassed=false;
      evidence.failureReason||=(error instanceof Error&&error.message==='READINESS_OBSERVATION_TIMEOUT')?'READINESS_OBSERVATION_TIMEOUT':'FROZEN_FORM_OR_BUTTON_CHANGED';
      await captureReadinessFailure(page,evidence,this.readinessBudget.callMs).catch(()=>{evidence.diagnosticCollection='FAILED';});throw error;}
  }
  failureEvidence():Record<string,unknown>{return {...this.lastEvidence,composerRetained:Boolean(this.composer&&!this.verified)};}
  async submit({verifyIdentity}:{verifyIdentity?:()=>Promise<void>}={}):Promise<void>{
    await this.readiness();
    if(verifyIdentity)try{await boundedRead(verifyIdentity,12000);}catch(error){this.lastEvidence.failureReason='IDENTITY_RECHECK_FAILED';await captureReadinessFailure(this.composer!,this.lastEvidence,this.readinessBudget.callMs).catch(()=>{this.lastEvidence.diagnosticCollection='FAILED';});throw error;}
    // Identity readback may take time; revalidate form and image state again.
    if(verifyIdentity){
      await this.readiness();
      // No further trial or stabilization wait after the last actor readback.
      try{await boundedRead(verifyIdentity,12000);await this.composer!.bringToFront?.();await boundedRead(this.finalFormCheck!,this.readinessBudget.callMs);
        if(!this.prepared!.video)await recheckImageReadiness(this.composer!,this.prepared!.images,this.lastEvidence,this.readinessBudget.callMs,this.prepared!.mediaNames,this.prepared!.mediaDimensions);
      }catch(error){this.lastEvidence.failureReason||='FINAL_IDENTITY_OR_FORM_CHANGED';await captureReadinessFailure(this.composer!,this.lastEvidence,this.readinessBudget.callMs).catch(()=>{});throw error;}
    }
    this.assertNoDialog();this.lastEvidence={...this.lastEvidence,phase:'FINAL_CLICK',finalClickAttempted:true};
    await this.composer!.getByRole('button',{name:'Publish',exact:true}).click({timeout:15000});
    this.lastEvidence={...this.lastEvidence,clickCallCompleted:true};
  }
  async readback(caption:string,options:{video?:boolean}={}):Promise<{id:string;url:string}>{for(let i=0;i<8;i++){this.assertNoDialog();const match=await this.publishedMatch(caption,options).catch(()=>null);this.assertNoDialog();if(match){this.verified=true;return match;}await new Promise(resolve=>setTimeout(resolve,2500))}throw Error('Facebook 提交结果未从已发表列表确认，保留 UNKNOWN，禁止重发')}
  async close():Promise<void>{if(this.verified)await this.composer?.close().catch(()=>{});await this.browser?.close().catch(()=>{})}
}

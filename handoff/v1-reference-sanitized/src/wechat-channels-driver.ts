import { classifyChannelsUpload, observeChannelsUpload, type UploadObservation } from "./channels-upload-observer.ts";
import { mkdirSync } from "node:fs";
import { hashFile } from "./file-hash.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type Frame, type Locator, type Page } from "playwright-core";
import { WECHAT_CHANNELS_ACCOUNT, channelsControlDisabled, parseChannelsVideoTotal, decideChannelsDescriptionReadback, decideWechatChannelsReadback, type WechatChannelsReadbackDecision } from "./wechat-channels-contract.ts";

const CHANNELS_URL = "https://channels.weixin.qq.com/platform";
const CHANNELS_CREATE_URL = "https://channels.weixin.qq.com/platform/post/create";

export type ChannelsPreflight = {
  ok: boolean;
  reason?: "LOGIN_REQUIRED" | "ACCOUNT_MISMATCH" | "EDITOR_UNAVAILABLE";
  observedIdentity?: string;
  beforeCount?: number;
  chromeVersion?: string;
  identityEvidence?: "PAGE_TEXT" | "USER_VERIFIED_MANAGED_PROFILE";
};

export type ChannelsSubmitObservation = { status: "ACKNOWLEDGED" | "BLOCKED" | "UNCONFIRMED"; message?:string; evidence:string[] };

export type ChannelsPreparedForm = {
  title: string;
  description: string;
  collection: string;
  location: "";
  beforeCount?: number;
};

/**
 * Deterministic WeChat Channels browser adapter. It owns a dedicated persistent
 * Chrome profile and never attaches to the user's everyday Chrome session.
 */
export class WechatChannelsDriver {
  readonly profileId = "wechat-channels-managed-v1";
  readonly profilePath: string;
  private context?: BrowserContext;
  private browser?: Browser;
  private chromeProcess?: ChildProcess;
  private page?: Page;
  private uploadReadActive=false;

  constructor(profilePath = resolve(homedir(), ".config/vietbridge-social/chrome/wechat-channels")) {
    this.profilePath = profilePath;
  }

  async close(): Promise<void> {
    await this.browser?.close().catch(() => undefined);
    if (this.chromeProcess && !this.chromeProcess.killed) this.chromeProcess.kill("SIGTERM");
    this.browser = undefined;
    this.chromeProcess = undefined;
    this.context = undefined;
    this.page = undefined;
  }

  async inspect(surface: "editor" | "works" = "editor"): Promise<{ url: string; text: string; html: string; htmlTail: string; customElements: unknown[]; frames: string[]; markers: Record<string, number>; controls: unknown[]; screenshot: string }> {
    const page = await this.ensurePage();
    if (surface === "works") await this.openVideoList(page);
    else if (!page.url().startsWith(CHANNELS_CREATE_URL)) {
      await page.goto(CHANNELS_CREATE_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
      await page.waitForTimeout(2_000);
    }
    if(surface === "editor") await waitForFileInput(page, 20_000);
    await dismissKnownOverlays(page);
    const text = await visibleText(page);
    const markers: Record<string, number> = {};
    for (const selector of ["iframe", "wujie-app", '[class*="account"]', '[class*="video"]', "button", "a"]) {
      markers[selector] = await page.locator(selector).count().catch(() => 0);
    }
    const controls: unknown[] = [];
    for (const root of allRoots(page)) {
      const frameControls = await root.locator('button,input,textarea,[role="button"],[role="textbox"],[contenteditable],[data-placeholder]').evaluateAll(elements => elements.slice(0, 80).map(el => ({
        tag: el.tagName, text: (el.textContent ?? "").trim().slice(0, 120), aria: el.getAttribute("aria-label"),
        title: el.getAttribute("title"), type: el.getAttribute("type"), placeholder: el.getAttribute("placeholder"),
        dataPlaceholder: el.getAttribute("data-placeholder"), role: el.getAttribute("role"), contenteditable: el.getAttribute("contenteditable"),
        className: String(el.className).slice(0, 180),
        style: { display: getComputedStyle(el).display, visibility: getComputedStyle(el).visibility, opacity: getComputedStyle(el).opacity },
        rect: { x: el.getBoundingClientRect().x, y: el.getBoundingClientRect().y, width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height }
      }))).catch(() => []);
      controls.push(...frameControls);
    }
    const html = await page.locator("body").innerHTML().catch(() => "");
    const customElements = await page.locator("body").evaluate(body => {
      const seen = new Map<string, { count: number; shadow: number }>();
      for (const el of body.querySelectorAll("*")) {
        const tag = el.tagName.toLowerCase(); if (!tag.includes("-")) continue;
        const value = seen.get(tag) ?? { count: 0, shadow: 0 }; value.count++; if (el.shadowRoot) value.shadow++;
        seen.set(tag, value);
      }
      return [...seen.entries()].map(([tag, value]) => ({ tag, ...value }));
    }).catch(() => []);
    const output = resolve(process.cwd(), "output/playwright"); mkdirSync(output, { recursive: true });
    const screenshot = resolve(output, surface === "works" ? "wechat-channels-works-diagnostic.png" : "wechat-channels-diagnostic.png");
    await page.screenshot({ path: screenshot, fullPage: true }).catch(() => undefined);
    return { url: page.url(), text: text.slice(0, 8_000), html: html.slice(0, 12_000), htmlTail: html.slice(-20_000), customElements, frames: page.frames().map(frame => frame.url()), markers, controls, screenshot };
  }

  async preflight(): Promise<ChannelsPreflight> {
    const page = await this.ensurePage();
    // The current Channels UI does not reliably render the account name/ID on
    // the create route. Go to the real editor first and use the editor itself
    // as login evidence. Only reject identity when another identity is
    // explicitly observable; absence of identity text is not a mismatch.
    if (!page.url().startsWith(CHANNELS_CREATE_URL)) await page.goto(CHANNELS_CREATE_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForTimeout(2_000);
    await dismissKnownOverlays(page);
    const text = await visibleText(page);
    const chromeVersion = this.context?.browser()?.version();
    if (/扫码登录|微信扫码|登录视频号助手|请使用微信扫码/u.test(text) || /login/i.test(page.url())) {
      return { ok: false, reason: "LOGIN_REQUIRED", chromeVersion };
    }
    let fileInput = await waitForFileInput(page, 20_000);
    if (!fileInput) {
      await page.reload({ waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => undefined);
      fileInput = await waitForFileInput(page, 15_000);
    }
    if (!fileInput) return { ok: false, reason: "EDITOR_UNAVAILABLE", chromeVersion };
    const hasName = text.includes(WECHAT_CHANNELS_ACCOUNT.displayName);
    const hasId = text.includes(WECHAT_CHANNELS_ACCOUNT.accountId);
    const observedIdentity = extractWechatChannelsIdentity(text);
    if (observedIdentity && !hasName && !hasId) {
      return { ok: false, reason: "ACCOUNT_MISMATCH", observedIdentity, chromeVersion };
    }
    // Capture the authoritative list count before upload. The previous adapter
    // always returned undefined, making count-increment readback impossible.
    await this.openVideoList(page);
    await page.waitForTimeout(1_000);
    const beforeCount = await countVideoItems(page);
    await page.goto(CHANNELS_CREATE_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
    if (!await waitForFileInput(page, 20_000)) return { ok: false, reason: "EDITOR_UNAVAILABLE", chromeVersion };
    return {
      ok: true, beforeCount, chromeVersion,
      observedIdentity: hasName || hasId ? WECHAT_CHANNELS_ACCOUNT.displayName : undefined,
      identityEvidence: hasName || hasId ? "PAGE_TEXT" : "USER_VERIFIED_MANAGED_PROFILE"
    };
  }

  async recheckUpload(expectedHash:string,timeoutMs=10000):Promise<UploadObservation> {
    if(this.uploadReadActive)throw Error('CHANNELS_RECOVERY_READ_BUSY');
    this.uploadReadActive=true;
    const deadline=Date.now()+Math.min(Math.max(timeoutMs,1),10000);
    let cancelled=false,attached:Browser|undefined;
    const check=()=>{if(cancelled||Date.now()>=deadline){cancelled=true;throw Error('CHANNELS_UPLOAD_READ_TIMEOUT');}};
    const read=async<T>(operation:()=>Promise<T>):Promise<T>=>{
      check();let timer:ReturnType<typeof setTimeout>|undefined;
      try{const value=await Promise.race([operation(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{cancelled=true;reject(Error('CHANNELS_UPLOAD_READ_TIMEOUT'));},Math.max(1,deadline-Date.now()));})]);check();return value;}
      finally{if(timer)clearTimeout(timer);}
    };
    const detach=async(browser:Browser)=>{
      // connectOverCDP Browser.close disconnects this connection, not the
      // external Chrome process. Never close an existing context/page/profile.
      let timer:ReturnType<typeof setTimeout>|undefined;
      try{await Promise.race([browser.close().catch(()=>undefined),new Promise<void>(resolve=>{timer=setTimeout(resolve,500);})]);}finally{if(timer)clearTimeout(timer);}
    };
    try {
      let context=this.context;
      if(!context){
        const connection=chromium.connectOverCDP('http://127.0.0.1:19224',{timeout:Math.min(5000,deadline-Date.now())});
        // A connection completing after its deadline never becomes shared state.
        connection.then(browser=>{if(cancelled)void detach(browser);else attached=browser;},()=>undefined);
        attached=await read(()=>connection);context=attached.contexts()[0];
      }
      check();const pages=context?.pages().filter(page=>page.url().startsWith(CHANNELS_CREATE_URL))||[];
      if(pages.length!==1)throw Error('CHANNELS_RECOVERY_EDITOR_UNAVAILABLE');
      const page=pages[0],text=await read(()=>visibleText(page,check));
      if(!text.includes(WECHAT_CHANNELS_ACCOUNT.accountId)){
        // The editor does not expose account ID. Read the signed-in home page
        // in another tab while preserving the exact stalled upload form.
        const identityPage=await read(()=>context!.newPage());
        try{
          await read(()=>identityPage.goto(CHANNELS_URL,{waitUntil:'domcontentloaded',timeout:Math.max(1000,deadline-Date.now())}));
          // The home shell renders before the signed-in account card. Wait
          // within the same bounded read deadline for both exact identifiers.
          try{
            await read(()=>identityPage.waitForFunction(({name,id})=>{
              const value=document.body?.innerText||'';
              return value.includes(name)&&value.includes(id);
            },{name:WECHAT_CHANNELS_ACCOUNT.displayName,id:WECHAT_CHANNELS_ACCOUNT.accountId},
            {timeout:Math.max(1000,deadline-Date.now())}));
          }catch{throw Error('CHANNELS_RECOVERY_IDENTITY_UNVERIFIED');}
          const homeText=await read(()=>visibleText(identityPage,check));
          if(!homeText.includes(WECHAT_CHANNELS_ACCOUNT.displayName)||!homeText.includes(WECHAT_CHANNELS_ACCOUNT.accountId))
            throw Error('CHANNELS_RECOVERY_IDENTITY_UNVERIFIED');
        }finally{await identityPage.close().catch(()=>undefined);}
      }
      if(!await read(()=>uploadedVideoMatches(page,expectedHash,check)))throw Error('CHANNELS_RECOVERY_VIDEO_UNVERIFIED');
      const submit=await read(()=>findByText(page,/^(发表|发布)$/u,['button','[role="button"]'],check));
      const disabled=submit?await read(()=>controlDisabled(submit,check)):true;
      check();
      // Publish shared recovery state only after every bounded read succeeds.
      if(attached){this.browser=attached;this.context=context;attached=undefined;}
      this.page=page;
      return classifyChannelsUpload(text,Boolean(submit&&!disabled));
    }finally{
      cancelled=true;
      if(attached)await detach(attached);
      this.uploadReadActive=false;
    }
  }
  async recoveryPreflight(expectedHash:string,beforeCount?:number):Promise<ChannelsPreflight>{
    await this.recheckUpload(expectedHash);
    return {ok:true,beforeCount,observedIdentity:WECHAT_CHANNELS_ACCOUNT.accountId,identityEvidence:'PAGE_TEXT'};
  }

  async prepare(input: { videoPath: string; title: string; description: string; beforeCount?: number; recovery?:boolean }, checkContinue:()=>void=()=>{},onProgress?:(state:UploadObservation&{elapsedMs:number;readCount:number})=>void): Promise<ChannelsPreparedForm> {
    checkContinue();
    const page = input.recovery?this.page:await this.ensurePage();
    if(!page||page.isClosed())throw Error("CHANNELS_RECOVERY_EDITOR_UNAVAILABLE");
    if(!input.recovery)await this.openPublisher(page);
    checkContinue();
    const file = await findFileInput(page);
    if (!file&&!input.recovery) throw new Error("CHANNELS_FILE_INPUT_NOT_FOUND");
    const expectedHash=hashFile(input.videoPath).sha256;
    if (!await uploadedVideoMatches(page,expectedHash)) {
      if(input.recovery)throw Error("CHANNELS_RECOVERY_VIDEO_UNVERIFIED");
      try { await file!.setInputFiles(input.videoPath,{timeout:60_000}); }
      catch(error) {
        // The micro-frontend replaces its file input after accepting the file.
        // Resume only when the visible blob has the exact approved bytes.
        if (!await uploadedVideoMatches(page,expectedHash)) throw error;
      }
    }
    checkContinue();

    const title = normalizeChannelsTitle(input.title);
    const description = input.description.trim();
    const titleInput = await findEditable(page, [
      'input[placeholder*="标题"]', 'textarea[placeholder*="标题"]', 'input[maxlength="16"]'
    ], /标题/u);
    if (!titleInput) throw new Error("CHANNELS_TITLE_INPUT_NOT_FOUND");
    checkContinue();
    await titleInput.fill(title);

    const descriptionInput = await findEditable(page, [
      '[contenteditable]:not([contenteditable="false"])[data-placeholder="添加描述"]',
      '[contenteditable="true"][data-placeholder*="描述"]', '.ql-editor[contenteditable="true"]',
      '[role="textbox"][data-placeholder*="描述"]', '[role="textbox"][aria-label*="描述"]',
      '[contenteditable="true"][aria-label*="描述"]', 'textarea[placeholder*="描述"]',
      '[role="textbox"]', '[contenteditable="true"]'
    ], /描述|说点什么/u);
    if (!descriptionInput) throw new Error("CHANNELS_DESCRIPTION_INPUT_NOT_FOUND");
    checkContinue();
    await fillEditable(descriptionInput, description);

    checkContinue();
    await selectCollection(page, WECHAT_CHANNELS_ACCOUNT.collection);
    await clearLocation(page);
    // Controls are present while upload/transcoding is still in progress. Fill
    // required fields first, then wait for the real (including CSS) button state.
    await waitForUploadReady(page, 180_000,checkContinue,onProgress);

    const actualTitle = (await titleInput.inputValue().catch(() => titleInput.textContent()))?.trim() ?? "";
    const actualDescription = (await editableValue(descriptionInput)).trim();
    const normalize=(value:string)=>value.replace(/\s+/gu,' ').trim();
    if (actualTitle !== title.trim() || normalize(actualDescription)!==normalize(description)) {
      throw new Error("CHANNELS_FORM_READBACK_MISMATCH");
    }
    return { title, description, collection: WECHAT_CHANNELS_ACCOUNT.collection, location: "", beforeCount: input.beforeCount };
  }

  async assertSubmitReady(): Promise<void> {
    const page=await this.ensurePage();
    const button=await findByText(page,/^(发表|发布)$/u,["button",'[role="button"]']);
    if(!button)throw new Error('CHANNELS_SUBMIT_BUTTON_NOT_FOUND');
    if(await controlDisabled(button))throw new Error('CHANNELS_SUBMIT_BUTTON_DISABLED');
  }

  async submitOnce(): Promise<ChannelsSubmitObservation> {
    const page=await this.ensurePage();
    await this.assertSubmitReady();
    const button=await findByText(page,/^(发表|发布)$/u,["button",'[role="button"]']);
    if(!button)throw new Error('CHANNELS_SUBMIT_BUTTON_NOT_FOUND');
    await button.scrollIntoViewIfNeeded();
    await button.click({timeout:15_000});
    // Do not navigate away from the form while the platform is still handling
    // the click. Record visible validation/confirmation, never click a second time.
    const deadline=Date.now()+45_000;
    while(Date.now()<deadline){
      const messages=await visibleSubmitMessages(page);
      const blocked=messages.find(message=>/请(?:输入|填写|选择|上传|添加)|不得|不支持|失败|超出|未完成|需要.*验证|确认发表|继续发表/u.test(message));
      if(blocked)return {status:'BLOCKED',message:blocked,evidence:['submit_clicked_once','platform_visible_validation_or_confirmation:'+blocked]};
      if(page.url().startsWith(`${CHANNELS_URL}/post/list`)||messages.some(message=>/发表成功|发布成功/u.test(message)))return {status:'ACKNOWLEDGED',evidence:['submit_clicked_once','platform_submit_acknowledgement']};
      await page.waitForTimeout(500);
    }
    const output=resolve(process.cwd(),'output/playwright');mkdirSync(output,{recursive:true});
    await page.screenshot({path:resolve(output,'wechat-channels-submit-unconfirmed.png'),fullPage:true}).catch(()=>undefined);
    return {status:'UNCONFIRMED',message:'平台在45秒内未返回发表确认；已保留原发表页',evidence:['submit_clicked_once','platform_submit_acknowledgement_timeout','original_form_preserved']};
  }

  async readback(input: { expectedTitle: string; expectedDescription?: string; beforeCount?: number; allowConclusiveAbsence?: boolean; submittedAt?:string }): Promise<WechatChannelsReadbackDecision> {
    await this.ensurePage();
    if(!this.context)throw new Error('CHANNELS_CHROME_CONTEXT_UNAVAILABLE');
    // A separate read page must not abort a pending submission or erase its
    // validation dialog. Keep the original editor available for diagnosis.
    const page=await this.context.newPage();
    page.setDefaultTimeout(15_000);
    let last:WechatChannelsReadbackDecision={outcome:'RECONCILE_PENDING',phase:'READBACK_AMBIGUOUS',mayRetry:false,evidence:['own_video_list_not_loaded']};
    let previousAbsence:string|undefined;
    const submittedAt=Date.parse(input.submittedAt||'');
    const allowAbsence=Boolean(input.allowConclusiveAbsence)&&Number.isFinite(submittedAt)&&Date.now()-submittedAt>=60_000;
    try {
      for(let pass=0;pass<3;pass++) {
        if(pass)await page.waitForTimeout(3_000);
        await this.openVideoList(page);
        const text=await visibleText(page);
        const afterCount=await countVideoItems(page);
        if(/扫码登录|微信扫码|登录视频号助手/u.test(text)||/login/i.test(page.url()))return {...last,evidence:['own_video_list_login_required']};
        if(input.expectedDescription) {
          const rawCards=[] as Array<{description:string;time:string;text:string}>;
          for(const root of allRoots(page))rawCards.push(...await root.locator('.post-feed-item').evaluateAll(es=>es.map(e=>({description:(e.querySelector('.post-title') as HTMLElement)?.innerText||'',time:(e.querySelector('.time-label') as HTMLElement)?.innerText||'',text:(e as HTMLElement).innerText}))).catch(()=>[]));
          last=decideChannelsDescriptionReadback({cards:rawCards,expectedDescription:input.expectedDescription,afterCount:parseChannelsVideoTotal(text),allowConclusiveAbsence:allowAbsence});
          if(last.outcome==='PUBLISHED_ID_PENDING')return last;
          if(last.outcome==='CONFIRMED_ABSENT') {
            const fingerprint=JSON.stringify([...new Set(rawCards.map(card=>card.description+'|'+card.time))].sort());
            if(previousAbsence===fingerprint)return {...last,evidence:[...last.evidence,'two_independent_complete_list_reads']};
            previousAbsence=fingerprint;
            last={...last,outcome:'RECONCILE_PENDING',phase:'READBACK_AMBIGUOUS',evidence:[...last.evidence,'awaiting_second_complete_list_read']};
          } else previousAbsence=undefined;
          // With a known description, a whole-page title match is insufficient
          // and can belong to an unrelated card or another render of the UI.
          continue;
        }
        const titleVisible=text.includes(input.expectedTitle);
        last=decideWechatChannelsReadback({beforeCount:input.beforeCount,afterCount,expectedTitle:input.expectedTitle,visibleTitle:titleVisible?input.expectedTitle:undefined,itemStatus:titleVisible?nearbyStatus(text,input.expectedTitle):undefined});
        if(last.outcome==='PUBLISHED_ID_PENDING')return last;
      }
      return last;
    } finally {await page.close().catch(()=>undefined);}
  }

  private async ensurePage(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;
    mkdirSync(this.profilePath, { recursive: true, mode: 0o700 });
    const endpoint = "http://127.0.0.1:19224";
    try { this.browser = await chromium.connectOverCDP(endpoint); }
    catch {
      this.chromeProcess = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
        `--user-data-dir=${this.profilePath}`, "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=19224",
        "--no-first-run", "--no-default-browser-check", "--start-maximized", CHANNELS_URL
      ], { stdio: "ignore" });
      for (let i = 0; i < 30; i++) {
        await new Promise(resolveWait => setTimeout(resolveWait, 300));
        try { this.browser = await chromium.connectOverCDP(endpoint); break; } catch { /* browser is still starting */ }
      }
      if (!this.browser) throw new Error("CHANNELS_CHROME_DEVTOOLS_UNAVAILABLE");
    }
    this.context = this.browser.contexts()[0];
    if (!this.context) throw new Error("CHANNELS_CHROME_CONTEXT_UNAVAILABLE");
    this.page = this.context.pages()[0] ?? await this.context.newPage();
    this.page.setDefaultTimeout(15_000);
    return this.page;
  }

  private async openVideoList(page: Page): Promise<void> {
    // Menu entries may be collapsed after submit; navigate to the verified
    // own-works route instead of silently remaining on the publishing form.
    await page.goto(`${CHANNELS_URL}/post/list`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    const deadline=Date.now()+20_000;
    while(Date.now()<deadline){
      for(const root of allRoots(page))if(await root.locator('.post-feed-item').first().isVisible().catch(()=>false))return;
      const text=await visibleText(page);
      if(/扫码登录|微信扫码|登录视频号助手/u.test(text)||/login/i.test(page.url()))return;
      await page.waitForTimeout(500);
    }
    return;
  }

  private async openPublisher(page: Page): Promise<void> {
    if (!page.url().startsWith(CHANNELS_CREATE_URL)) {
      await page.goto(CHANNELS_CREATE_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
    }
    await page.waitForTimeout(1_000);
    await dismissKnownOverlays(page);
    if (!await findFileInput(page)) throw new Error("CHANNELS_PUBLISH_EDITOR_NOT_READY");
  }
}

function allRoots(page: Page): Array<Page | Frame> { return [page, ...page.frames().filter(frame => frame !== page.mainFrame())]; }

async function uploadedVideoMatches(page:Page, expectedHash:string,check:()=>void=()=>{}):Promise<boolean> {
  for(const root of allRoots(page)) {
    check();const hashes:string[]=await root.locator('video').evaluateAll(async elements=>{
      const urls=[...new Set(elements.map(el=>(el as HTMLVideoElement).currentSrc).filter(url=>url.startsWith('blob:')))];
      return Promise.all(urls.map(async url=>{
        try {const bytes=await (await fetch(url)).arrayBuffer();const digest=await crypto.subtle.digest('SHA-256',bytes);return Array.from(new Uint8Array(digest)).map(x=>x.toString(16).padStart(2,'0')).join('');}catch{return '';}
      }));
    }).catch(()=>[]);
    check();if(hashes.includes(expectedHash)) return true;
  }
  return false;
}

async function visibleText(page: Page,check:()=>void=()=>{}): Promise<string> {
  const chunks: string[] = [];
  for (const root of allRoots(page)) {check();chunks.push(await root.locator("body").evaluateAll(elements => elements.map(el => (el as HTMLElement).innerText).join('\n')).catch(() => ""));check();}
  return chunks.join("\n");
}

async function dismissKnownOverlays(page: Page): Promise<void> {
  const acknowledge = await findByText(page, /^我知道了$/u, ["button"]);
  if (acknowledge) {
    await acknowledge.click().catch(() => undefined);
    await page.waitForTimeout(500);
  }
}

async function findByText(page: Page, pattern: RegExp, selectors = ["button", '[role="button"]', "a", "span", "div"],check:()=>void=()=>{}): Promise<Locator | null> {
  for (const root of allRoots(page)) {
    for (const selector of selectors) {
      check();const items = root.locator(selector).filter({ hasText: pattern });
      const count = Math.min(await items.count().catch(() => 0), 20);
      check();for (let i = 0; i < count; i++) {
        check();const item = items.nth(i);
        const text = (await item.innerText().catch(() => "")).trim();
        check();const visible=pattern.test(text)&&await item.isVisible().catch(() => false);check();if(visible)return item;
      }
    }
  }
  return null;
}

async function findFileInput(page: Page): Promise<Locator | null> {
  for (const root of allRoots(page)) {
    const inputs = root.locator('input[type="file"]');
    if (await inputs.count().catch(() => 0)) return inputs.first();
  }
  return null;
}

async function waitForFileInput(page: Page, timeoutMs: number): Promise<Locator | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const input = await findFileInput(page);
    if (input) return input;
    await page.waitForTimeout(500);
  }
  return null;
}

async function findEditable(page: Page, selectors: string[], nearby: RegExp): Promise<Locator | null> {
  for (const root of allRoots(page)) {
    for (const selector of selectors) {
      const items = root.locator(selector);
      const count = Math.min(await items.count().catch(() => 0), 20);
      for (let i = 0; i < count; i++) if (await items.nth(i).isVisible().catch(() => false)) return items.nth(i);
    }
    const labels = root.locator("label,div,span").filter({ hasText: nearby });
    const labelCount = Math.min(await labels.count().catch(() => 0), 30);
    for (let i = 0; i < labelCount; i++) {
      const label = labels.nth(i);
      if (!await label.isVisible().catch(() => false)) continue;
      for (const candidate of [
        label.locator('input,textarea,[contenteditable="true"],[role="textbox"]').first(),
        label.locator('xpath=following::*[self::input or self::textarea or @contenteditable="true" or @role="textbox"][1]').first()
      ]) {
        if (await candidate.isVisible().catch(() => false)) return candidate;
      }
    }
  }
  return null;
}

async function fillEditable(locator: Locator, value: string): Promise<void> {
  const tag = await locator.evaluate(el => el.tagName.toLowerCase());
  if (tag === "input" || tag === "textarea") await locator.fill(value);
  else { await locator.click(); await locator.press("Meta+A"); await locator.pressSequentially(value, { delay: 5 }); }
}

async function editableValue(locator: Locator): Promise<string> {
  return await locator.inputValue().catch(async () => (await locator.textContent()) ?? "");
}

async function waitForUploadReady(page:Page,timeoutMs:number,checkContinue:()=>void=()=>{},onProgress?:(state:UploadObservation&{elapsedMs:number;readCount:number})=>void):Promise<void>{
 await observeChannelsUpload({budgetMs:timeoutMs,stallMs:135_000,onProgress,wait:ms=>page.waitForTimeout(ms),probe:async()=>{
   checkContinue();const text=await visibleText(page),submit=await findByText(page,/^(发表|发布)$/u,['button','[role="button"]']);
   return classifyChannelsUpload(text,Boolean(submit&&!await controlDisabled(submit)));
 }});
}

async function selectCollection(page: Page, name: string): Promise<void> {
  const existing=page.getByText(name,{exact:true}).first();
  if (await existing.isVisible().catch(()=>false)) { await existing.click(); return; }
  const trigger = await findByText(page, /^选择合集$/u);
  if (!trigger) throw new Error("CHANNELS_COLLECTION_TRIGGER_NOT_FOUND");
  await trigger.click();
  const option = page.getByText(name,{exact:true}).first();
  await option.waitFor({state:'visible',timeout:15_000}).catch(()=>{throw new Error('CHANNELS_COLLECTION_NOT_FOUND');});
  await option.click();
}

async function clearLocation(page: Page): Promise<void> {
  for (const root of allRoots(page)) {
    const control = root.locator('.position-display-wrap').first();
    if (!await control.isVisible().catch(()=>false)) continue;
    if ((await control.innerText()).includes('不显示位置')) return;
    await control.click();
    // The location popup mounts asynchronously; the old one-shot text scan
    // ran before its option existed and incorrectly failed preflight.
    const none = page.getByText('不显示位置', { exact: true }).first();
    await none.waitFor({ state: 'visible', timeout: 15_000 }).catch(() => { throw new Error('CHANNELS_LOCATION_CLEAR_UNAVAILABLE'); });
    await none.click();
    await control.filter({ hasText: '不显示位置' }).waitFor({ state: 'visible', timeout: 10_000 }).catch(() => { throw new Error('CHANNELS_LOCATION_READBACK_MISMATCH'); });
    return;
  }
  throw new Error('CHANNELS_LOCATION_CONTROL_NOT_FOUND');
}

async function countVideoItems(page: Page): Promise<number | undefined> {
  const text = await visibleText(page);
  for (const pattern of [/视频\s*[（(]?\s*(\d+)\s*[）)]?/u, /共\s*(\d+)\s*个?视频/u]) {
    const match = text.match(pattern); if (match) return Number(match[1]);
  }
  let maximum = 0;
  for (const root of allRoots(page)) maximum = Math.max(maximum, await root.locator('[class*="video-item"], [class*="video-card"], [class*="feed-item"]').count().catch(() => 0));
  return maximum || undefined;
}

function nearbyStatus(text: string, title: string): string | undefined {
  const index = text.indexOf(title); if (index < 0) return undefined;
  const nearby = text.slice(index, index + title.length + 180);
  return nearby.match(/已发表|已发布|审核中|发表中/u)?.[0];
}

/**
 * Extract only an explicitly rendered account identity.
 *
 * The editor contains generic controls such as `@视频号`, `视频号助手` and
 * navigation labels. Treating every line containing “视频号” as an account
 * name caused a false ACCOUNT_MISMATCH on a healthy, logged-in editor. A
 * stable sph ID is authoritative; otherwise accept only a concise name that
 * actually ends in “的视频号”. No explicit identity means that the dedicated,
 * user-verified managed profile remains the identity evidence.
 */
export function extractWechatChannelsIdentity(text: string): string {
  const lines = text.split(/\r?\n/u).map(value => value.trim()).filter(Boolean);
  const stableIds = [...new Set(lines.flatMap(line => line.match(/\bsph[A-Za-z0-9]{8,}\b/gu) ?? []))];
  if (stableIds.length) return stableIds.slice(0, 4).join(" · ").slice(0, 300);

  const names = lines.filter(line => {
    if (line.length > 80 || !/^.{1,40}的视频号$/u.test(line)) return false;
    if (/^(?:@?视频号|微信视频号|登录视频号|视频号助手|视频号小店)的视频号?$/u.test(line)) return false;
    return !/^[@#]/u.test(line);
  });
  return [...new Set(names)].slice(0, 4).join(" · ").slice(0, 300);
}
export function normalizeChannelsTitle(value: string): string {
  const normalized = value.normalize("NFKC")
    .replace(/^(?:title|标题)\s*[:：]\s*/iu, "")
    .replace(/[,，、。；;！!…—–\-()（）[\]【】{}<>]/gu, " ")
    .replace(/[^\p{L}\p{N}\s《》“”'":+?%℃°]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return truncate(normalized, 16);
}
function truncate(value: string, max: number): string { return [...value].slice(0, max).join(""); }
function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }


async function controlDisabled(control:Locator,check:()=>void=()=>{}):Promise<boolean>{
  check();const nativeDisabled=await control.isDisabled().catch(()=>true);
  check();const ariaDisabled=await control.getAttribute('aria-disabled').catch(()=>null);
  check();const className=await control.getAttribute('class').catch(()=>null);check();
  return channelsControlDisabled({nativeDisabled,ariaDisabled,className});
}
async function visibleSubmitMessages(page:Page):Promise<string[]>{
  const messages:string[]=[];
  for(const root of allRoots(page))messages.push(...await root.locator('.weui-desktop-toast__content,.weui-desktop-dialog,.weui-desktop-form__msg,.ant-message-error,[role="alert"]').evaluateAll(es=>es.filter(e=>{const r=e.getBoundingClientRect();const s=getComputedStyle(e);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'}).map(e=>(e as HTMLElement).innerText.trim().slice(0,300)).filter(Boolean)).catch(()=>[]));
  return [...new Set(messages)];
}

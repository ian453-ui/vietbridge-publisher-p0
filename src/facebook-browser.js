import {facebookPostTarget,facebookCommentAnchorBoundToPost,verifiedProactiveGroupUrl} from './interaction-target.js';
import {pendingPublisherProfileRows} from './publisher-profile-pending.js';
import {assertNotChannelsProfile} from './channels-profile-isolation.js';
import {spawn} from 'node:child_process';
import {request} from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {groupNameMatches} from './group-filters.js';
import {boundedDiagnosticCleanup} from './facebook-readonly-diagnostics.js';
import {BrowserSkillFacebook} from './browser-skill-facebook.js';
import {BrowserSkillClient} from './browser-skill-binding.js';
import {homedir} from 'node:os';
import {join} from 'node:path';

const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const execFileAsync=promisify(execFile);
export class FacebookBrowser {
  constructor(store,{browserSkillBinding=null,browserSkillClient=null,browserSkillGroupIds=null}={}){this.store=store;this.processes=new Map();this.activeProfiles=new Set();this.manualWatchers=new Set();this.browserSkill=browserSkillBinding?new BrowserSkillFacebook(store,{binding:browserSkillBinding,approvedGroupIds:browserSkillGroupIds,client:browserSkillClient||new BrowserSkillClient({executable:join(homedir(),'.local/bin/bsk')})}):null;if(this.browserSkill)this.browserSkill.current();}
  async launch(workspace,profileId){const p=this.profile(workspace,profileId);if(await cdpReady(p.cdp_port)){if(!await portMatchesProfile(p))throw new Error('调试端口被另一个 Chrome 数据目录占用；请关闭旧窗口或更换端口，不能复用其他账号会话');await this.openFacebook(p);return {status:'READY',cdp_port:p.cdp_port};}const child=spawn(CHROME,[`--remote-debugging-port=${p.cdp_port}`,`--user-data-dir=${p.user_data_dir}`,'--no-first-run','https://www.facebook.com/groups/joins/'],{detached:true,stdio:'ignore'});let startupError=null;child.once('error',error=>{startupError=error;});child.unref();this.processes.set(profileId,child.pid);for(let i=0;i<160;i++){await new Promise(r=>setTimeout(r,250));if(await cdpReady(p.cdp_port)){if(!await portMatchesProfile(p))throw new Error('Chrome 已启动但端口与数据目录不匹配；已停止授权');this.store.db.prepare("UPDATE execution_profiles SET status='READY',last_error=NULL WHERE id=?").run(profileId);return {status:'READY',cdp_port:p.cdp_port};}if(startupError||child.exitCode!==null)break;}const reason=startupError?`Chrome 启动失败：${startupError.code||startupError.message}`:child.exitCode!==null?`Chrome 提前退出：${child.exitCode}`:'Chrome CDP 40 秒未就绪';this.store.db.prepare("UPDATE execution_profiles SET status='BLOCKED',last_error=? WHERE id=?").run(reason,profileId);throw new Error(`${reason}；请检查专用浏览器，不会自动提交`);}
  async openFacebook(profile){const release=this.resources?.acquire(profile.user_data_dir,'operator:'+profile.id,()=>this.resourcePending(profile));let browser;try{const {chromium}=await import('playwright-core');browser=await chromium.connectOverCDP(`http://127.0.0.1:${profile.cdp_port}`,{noDefaults:true,timeout:15000});const context=browser.contexts()[0];if(!context)throw Error('Chrome 没有可连接的会话');const page=context.pages().find(p=>p.url().startsWith('https://www.facebook.com/'))||await context.newPage();if(!page.url().startsWith('https://www.facebook.com/'))await page.goto('https://www.facebook.com/',{waitUntil:'domcontentloaded',timeout:30000});await page.bringToFront();}finally{try{await browser?.close();}finally{release?.();}}}
  async inspect(workspace,accountId,{leaseHeld=false,session=null}={}){
    const account=this.store.account(workspace,accountId),profile=this.profile(workspace,account.profile_id);
    const {browser,page}=session||await (leaseHeld?this.connectPage(profile):this.page(profile));
    try{
      await page.goto('https://www.facebook.com/me',{waitUntil:'domcontentloaded',timeout:45000});
      await page.locator('h1,input[name="email"],[aria-label="Your profile"]').first().waitFor({state:'visible',timeout:15000}).catch(()=>{});
      const url=page.url(),title=await page.title(),body=await facebookDocumentText(page).catch(()=>'');
      if(await page.locator('input[name="email"],input[name="pass"]').count()||/login|checkpoint/i.test(url)||/Log in to Facebook|登录 Facebook/i.test(body)){
        this.health(account.id,'LOGIN_REQUIRED',false);return {healthy:false,actualIdentity:null,url,title,blocker:'FACEBOOK_LOGIN_REQUIRED'};
      }
      // The /me link in the account menu identifies the current actor. The
      // first h1 can be "Manage Page", or a page being viewed by a different actor.
      const identity=await currentActorName(page);
      const externalId=profileIdFromUrl(url);
      if(!identity||!externalId){this.health(account.id,'IDENTITY_UNVERIFIED',false);return {healthy:false,actualIdentity:identity||null,url,title,blocker:'FACEBOOK_IDENTITY_NOT_OBSERVABLE'};}
      const matches=identityMatches(identity,externalId,account);
      if(matches&&!account.external_id)this.store.db.prepare('UPDATE facebook_accounts SET external_id=? WHERE id=?').run(externalId,account.id);
      this.health(account.id,matches?'HEALTHY':'WRONG_IDENTITY',matches);
      return {healthy:matches,actualIdentity:identity,externalId,url,title,identityEvidence:'CURRENT_ACTOR_MENU_AND_ME_URL',blocker:matches?null:'WRONG_IDENTITY'};
    }finally{if(!session)await browser.close();}
  }
  async assertDiagnosticProfile(snapshot){
    const account=this.store.account(snapshot.workspace,snapshot.accountId),profile=this.profile(snapshot.workspace,snapshot.profileId);
    if(account.profile_id!==profile.id||profile.cdp_port!==snapshot.cdpPort||profile.user_data_dir!==snapshot.profileDir||account.external_id!==snapshot.operatorActorId)throw Error('只读诊断的冻结账号或执行环境不匹配');
    if(!await cdpReady(profile.cdp_port)||!await portMatchesProfile(profile))throw Error('只读诊断端口未就绪或不属于冻结专用目录');
  }
  async inspectDiagnostic(snapshot,context){
    const account=this.store.account(snapshot.workspace,snapshot.accountId),page=await context.newPage();
    try{
      await page.goto('https://www.facebook.com/me',{waitUntil:'domcontentloaded',timeout:7000});
      const url=page.url();if(/login|checkpoint/i.test(url)||await page.locator('input[name="email"],input[name="pass"]').count())throw Error('只读诊断需登录或安全验证，不会代填凭据');
      const actualIdentity=await currentActorName(page,3000),externalId=profileIdFromUrl(url);
      if(!identityMatches(actualIdentity,externalId,account)||externalId!==snapshot.operatorActorId)throw Error('只读诊断实际操作身份未核实或不一致');
      return {healthy:true,actualIdentity,externalId,targetPageId:snapshot.targetPageId,method:'ISOLATED_ME_ACTOR_READBACK'};
    }finally{await boundedDiagnosticCleanup(()=>page.close(),1500);}
  }
  async discoverGroups(workspace,accountId){
    const account=this.store.account(workspace,accountId),profile=this.profile(workspace,account.profile_id);
    // Read-only discovery may inspect a pending profile, but must retain its
    // durable pending lease and never navigate an existing filled composer.
    const session=await this.page(profile,{reconcile:true,isolated:true});
    const {browser,page}=session;
    try{
    const checked=await this.inspect(workspace,accountId,{session});
    if(!checked.healthy){
      if(checked.blocker==='WRONG_IDENTITY')throw new Error(`请在 V2 专用 Chrome 从“${checked.actualIdentity}”切换为企业 Page“${account.expected_identity}”，再同步群组`);
      if(checked.blocker==='FACEBOOK_LOGIN_REQUIRED')throw new Error('V2 专用 Chrome 尚未登录 Facebook；请先登录，再切换为企业 Page 后同步。V1 API 授权不等于 V2 浏览器登录。');
      throw new Error('Facebook 身份尚未加载或无法核验，请在 V2 专用 Chrome 打开企业 Page 后重试');
    }
      await page.goto('https://www.facebook.com/groups/joins/',{waitUntil:'domcontentloaded',timeout:45000});
      const actor=await currentActorName(page);
      if(!actor)throw new Error('群组页面的当前身份尚未加载，无法安全同步；原群组记录未改动');
      if(actor!==checked.actualIdentity)throw new Error('同步前 Facebook 身份发生变化；已停止，原群组记录未改动');
      await page.locator('a[href*="/groups/"]').first().waitFor({state:'visible',timeout:15000}).catch(()=>{});
      let previous=0,stable=0;
      for(let i=0;i<30&&stable<5;i++){
        await page.mouse.wheel(0,1600);
        await page.waitForTimeout(500);
        const count=await page.locator('a[href*="/groups/"]').count();
        stable=count>previous?0:stable+1;
        previous=Math.max(previous,count);
      }
      const links=await page.locator('a[href*="/groups/"]').evaluateAll(es=>es.map(a=>({name:(a.textContent||'').trim(),url:a.href})));
      const groups=normalizeGroupLinks(links);
      if(!groups.length)throw new Error('企业 Page 的“你的群组”中未识别到群组；请确认该 Page 已加入群组，或手工添加链接。原群组记录未删除。');
      return {identity:checked.actualIdentity,groups};
    }finally{try{await page.close();}finally{await browser.close();}}
  }
  async searchGroupTopics(workspace,accountId,input={}){
    const account=this.store.account(workspace,accountId),profile=this.profile(workspace,account.profile_id),policy=this.store.engagementPolicy(workspace,account.id);
    if(!policy)throw new Error('请先保存主题与额度规则');
    if(policy.paused||(policy.cooldown_until&&policy.cooldown_until>new Date().toISOString()))throw new Error('账号已暂停或处于冷却期，不能启动搜索');
    const groupIds=[...new Set(input.group_ids||[])].slice(0,5),topics=[...new Set((input.topics||policy.topics).map(String).map(x=>x.trim()).filter(Boolean))].slice(0,5);
    if(!groupIds.length||!topics.length)throw new Error('请选择白名单群组并配置至少一个主题');
    const groups=groupIds.map(id=>this.store.db.prepare('SELECT * FROM facebook_groups WHERE id=? AND workspace=? AND account_id=? AND enabled=1').get(id,workspace,account.id)||(()=>{throw new Error('搜索范围包含未授权或已停用群组')})());
    if(this.activeProfiles.has(profile.id))throw new Error('该 Facebook 执行环境正在执行其他任务');
    this.activeProfiles.add(profile.id);let browser;
    try{
      let checked=await this.inspect(workspace,account.id);if(!checked.healthy&&checked.blocker==='FACEBOOK_IDENTITY_NOT_OBSERVABLE'){await new Promise(r=>setTimeout(r,1000));checked=await this.inspect(workspace,account.id)}if(!checked.healthy)throw new Error(`Facebook 身份核验失败（${checked.blocker||'UNKNOWN'}），主题雷达已停止`);
      let page;({browser,page}=await this.page(profile));const found=[];
      for(const group of groups)for(const topic of topics){
        const url=`${group.url}/search/?q=${encodeURIComponent(topic)}`;await page.goto(url,{waitUntil:'domcontentloaded',timeout:45000});
        if(!page.url().includes(new URL(group.url).pathname))throw new Error('Facebook 未停留在白名单群组，主题雷达已停止');
        if(/checkpoint|login/i.test(page.url()))throw new Error('Facebook 要求重新登录或安全验证，主题雷达已停止');
        await page.locator('div[role="article"]').first().waitFor({state:'visible',timeout:12000}).catch(()=>{});
        const pageText=await facebookDocumentText(page);
        if(/temporarily blocked|try again later|security check|暂时封锁|稍后再试|安全验证/i.test(pageText))throw new Error('Facebook 访问受限，搜索已停止');
        if(await currentActorName(page)!==checked.actualIdentity)throw new Error('搜索过程中身份发生变化或无法确认，已停止');
        const raw=await page.locator('div[role="article"]').evaluateAll(nodes=>nodes.slice(0,12).map(node=>({body:(node.innerText||'').trim(),links:[...node.querySelectorAll('a[href]')].map(a=>({url:a.href,text:(a.textContent||'').trim()}))})));
        found.push(...normalizeRadarResults(raw,group,topic,10));
        if(!raw.length&&!/no results|没有找到|找不到结果|无搜索结果/i.test(pageText))throw new Error('无法识别搜索结果页面，不能将读取失败当作零结果');
      }
      const unique=[...new Map(found.map(x=>[x.external_id,x])).values()],stored=this.store.ingestRadarPosts(workspace,account.id,unique),candidates=this.store.buildEngagementCandidates(workspace,account.id);
      return {identity:checked.actualIdentity,groups:groups.length,topics:topics.length,found:unique.length,stored:stored.length,candidates:candidates.length,limited:true};
    }finally{await browser?.close().catch(()=>{});this.activeProfiles.delete(profile.id);}
  }
  async replyRadarCandidate(workspace,candidateId){
    const candidate=this.store.engagementCandidate(workspace,candidateId),comment=this.store.comment(workspace,candidate.comment_id),radar=this.store.db.prepare('SELECT * FROM radar_posts WHERE workspace=? AND account_id=? AND external_id=?').get(workspace,candidate.account_id,comment.external_id);
    if(!radar)throw new Error('候选没有可核验的群组帖子来源');
    const account=this.store.account(workspace,candidate.account_id),profile=this.profile(workspace,account.profile_id),group=this.store.db.prepare('SELECT * FROM facebook_groups WHERE id=? AND workspace=? AND account_id=? AND enabled=1').get(radar.group_id,workspace,account.id);
    if(!group)throw new Error('目标群组已停用或不属于当前账号');
    if(candidate.state!=='REPLY_CANDIDATE')throw Error('只有待执行候选可以回复；UNKNOWN 必须核对');
    const reviewed=this.store.assertEngagementReviewed(workspace,candidate.id);if(reviewed.kind!=='RADAR')throw Error('候选不是群组帖子');
    const target=reviewed.permalink,frozenReview={draft:candidate.draft,scope_hash:this.store.engagementCandidateView(workspace,candidate.id).scope_hash};
    if(this.activeProfiles.has(profile.id))throw new Error('该 Facebook 执行环境正在执行其他任务');
    const policy=this.store.engagementPolicy(workspace,account.id);if(policy?.mode!=='AUTO_LOW_RISK')throw new Error('当前为影子模式，只生成候选，不会发送');
    this.activeProfiles.add(profile.id);let browser,reservation,submitted=false;
    try{
      const checked=await this.inspect(workspace,account.id);if(!checked.healthy)throw new Error('Facebook 身份核验失败，主题回复已停止');
      let page;({browser,page}=await this.page(profile));await page.goto(target,{waitUntil:'domcontentloaded',timeout:45000});await page.waitForTimeout(1000);await assertSafeFacebookPage(page,group.url);
      if(canonicalGroupPostUrl(page.url(),group.url)!==target)throw new Error('未停留在目标帖子，已阻止回复');
      if(!identityMatches(await currentActorName(page),checked.externalId,account))throw new Error('写入前 Facebook 身份发生变化');
      const text=normalize(await facebookDocumentText(page));if(!text.includes(normalize(radar.body).slice(0,45)))throw new Error('目标帖子正文不匹配，已阻止回复');
      if(text.includes(normalize(candidate.draft)))throw new Error('页面已有相同回复，须先人工核对，禁止重复发送');
      const box=page.locator('[role="textbox"][contenteditable="true"]').last();if(!await box.count())throw new Error('未找到评论输入框，未发送');
      reservation=this.store.reserveReplyQuota(workspace,candidate.id,frozenReview).reservation;
      await box.fill(candidate.draft);if(normalize(await box.textContent())!==normalize(candidate.draft))throw new Error('回复正文完整性核对失败');
      if(!identityMatches(await currentActorName(page),checked.externalId,account))throw Error('提交前实际 actor 身份发生变化');
      this.store.beginAutoReply(workspace,candidate.id,reservation.id);submitted=true;await box.press('Enter');await page.waitForTimeout(1500);
      const fresh=await browser.contexts()[0].newPage();let evidence;
      try{await fresh.goto(target,{waitUntil:'domcontentloaded',timeout:45000});await fresh.waitForTimeout(1200);await assertSafeFacebookPage(fresh,group.url);if(canonicalGroupPostUrl(fresh.url(),group.url)!==target)throw new Error('回读目标帖子不匹配');evidence=await radarReplyReadback(fresh,candidate.draft,checked.actualIdentity);}finally{await fresh.close().catch(()=>{})}
      if(!evidence.readback_verified)throw new Error('回复已提交，但独立页面未确认，禁止重发');
      return this.store.finishAutoReply(workspace,candidate.id,reservation.id,evidence);
    }catch(error){if(reservation){if(submitted)return this.store.markAutoReplyUnknown(workspace,candidate.id,reservation.id,String(error));this.store.releaseQuota(workspace,reservation.id,'提交前失败：'+String(error));}throw error;}
    finally{await browser?.close().catch(()=>{});this.activeProfiles.delete(profile.id);}
  }
  async scanProactiveEngagement(workspace,accountId){
    if(this.browserSkill?.matches(workspace,accountId)){
      const runtime=this.browserSkill.current();if(!this.resources)throw Error('BSK_DURABLE_RESOURCE_REQUIRED');
      const release=this.resources.acquireInstance(runtime.instanceId,'operator:'+runtime.profileId,()=>Boolean(this.store.db.prepare("SELECT 1 FROM engagement_actions WHERE workspace=? AND account_id=? AND state IN ('ATTEMPTING','RECONCILE_PENDING')").get(workspace,accountId)));
      try{return await this.browserSkill.scan(workspace,accountId);}finally{release();}
    }
    const account=this.store.account(workspace,accountId),settings=this.store.proactiveSettings(workspace,account.id);
    if(!settings?.enabled||!settings.global_enabled||!settings.account_enabled)throw new Error('主动互动 GLOBAL 或 ACCOUNT 开关未开启');
    const groups=this.store.db.prepare("SELECT * FROM facebook_groups WHERE workspace=? AND account_id=? AND enabled=1 AND membership_status='JOINED' AND proactive_engagement_enabled=1 ORDER BY name").all(workspace,account.id);
    if(!groups.length)throw new Error('没有已加入且开启主动互动的群组');
    const profile=this.profile(workspace,account.profile_id);if(this.activeProfiles.has(profile.id))throw new Error('该 Facebook 执行环境正在执行其他任务');
    this.activeProfiles.add(profile.id);let browser;
    try{
      const checked=await this.inspect(workspace,account.id);if(!checked.healthy)throw new Error(`Facebook 身份核验失败（${checked.blocker||'UNKNOWN'}），主动扫描已停止`);
      let page;({browser,page}=await this.page(profile));const found=[];let observed=0,unreadableTime=0;
      for(const group of groups){
        await page.goto(group.url+'?sorting_setting=CHRONOLOGICAL',{waitUntil:'domcontentloaded',timeout:45000});await page.waitForTimeout(1200);
        await assertSafeFacebookPage(page,group.url);
        const actor=await currentActorName(page);if(!identityMatches(actor,checked.externalId,account))throw new Error('扫描过程中 Facebook 身份发生变化，已停止');
        await page.locator('div[role="article"]').first().waitFor({state:'visible',timeout:12000}).catch(()=>{});
        await page.locator('a[href*="/posts/"],a[href*="/permalink/"],a[href*="set=gm."]').first().waitFor({state:'visible',timeout:8000}).catch(()=>{});
        const targetGroupUrl=verifiedProactiveGroupUrl(group),numericGroupId=new URL(targetGroupUrl).pathname.split('/')[2],vanityGroupId=new URL(group.url).pathname.split('/')[2];
        const raw=await page.evaluate(({max,groupId,vanityId})=>{
          const canonicalPostLink=url=>{try{const parsed=new URL(url),direct=parsed.pathname.match(/^\/groups\/([^/]+)\/(?:posts|permalink)\/(\d+)\/?$/);const id=direct?.[1],post=direct?.[2];if(parsed.protocol!=='https:'||!['facebook.com','www.facebook.com','m.facebook.com','mbasic.facebook.com'].includes(parsed.hostname))return null;if(post&&(id===groupId||id===vanityId))return `https://www.facebook.com/groups/${groupId}/posts/${post}/`;const photo=parsed.pathname==='/photo/'&&parsed.searchParams.get('set')?.match(/^gm\.(\d+)$/),photoGroup=parsed.searchParams.get('idorvanity');return photo&&(photoGroup===groupId||photoGroup===vanityId)?`https://www.facebook.com/groups/${groupId}/posts/${photo[1]}/`:null}catch{return null}};
          const visible=e=>Boolean(e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden');
          const rows=[],seen=new Set();
          for(const card of document.querySelectorAll('[role="article"]')){
            if(!visible(card))continue;
            const links=[...card.querySelectorAll('a[href]')].filter(visible).map(a=>({url:a.href,text:(a.innerText||a.textContent||'').trim(),label:a.getAttribute('aria-label')}));
            const postLinks=links.filter(link=>canonicalPostLink(link.url)),targets=[...new Set(postLinks.map(link=>canonicalPostLink(link.url)))];
            if(targets.length!==1||seen.has(targets[0]))continue;
            const messages=[...card.querySelectorAll('[data-ad-preview="message"],[data-ad-comet-preview="message"]')].filter(e=>visible(e)&&e.closest('[role="article"]')===card);
            const leafTexts=messages.length?messages:[...card.querySelectorAll('[dir="auto"]')].filter(e=>visible(e)&&e.closest('[role="article"]')===card&&!e.querySelector('[dir="auto"]'));
            const bodies=[...new Set(leafTexts.map(e=>(e.innerText||e.textContent||'').trim()).filter(x=>x.length>=25&&!/^Number of unread notifications\b/i.test(x)))].sort((a,b)=>b.length-a.length);
            if(messages.length>1||!bodies.length||bodies.length>1&&bodies[0].length<bodies[1].length*1.4)continue;
            const body=bodies[0];
            const markers=[...card.querySelectorAll('abbr,time,[data-utime]')].filter(visible).flatMap(node=>[node.getAttribute('data-utime'),node.getAttribute('datetime'),node.getAttribute('aria-label'),node.getAttribute('title'),node.textContent]).map(x=>(x||'').trim()).filter(Boolean);
            rows.push({body,links,time:card.querySelector('abbr[data-utime]')?.getAttribute('data-utime')||card.querySelector('time[datetime]')?.getAttribute('datetime')||null,times:[...postLinks.flatMap(a=>[a.label,a.text]),...markers]});seen.add(targets[0]);
            if(rows.length>=max)break;
          }
          // Facebook sometimes places the real feed card outside the empty
          // role=article skeleton. Accept it only with one exact post target,
          // one author link, one post-actions control, and one isolated body.
          if(!rows.length&&/^\d+$/.test(groupId))for(const anchor of document.querySelectorAll('a[href]')){
            if(!visible(anchor))continue;const target=canonicalPostLink(anchor.href);if(!target||seen.has(target))continue;
            let card=anchor;for(let depth=0;depth<8&&card;depth++,card=card.parentElement){
              const actions=[...card.querySelectorAll('[role="button"][aria-label^="Actions for this post"],button[aria-label^="Actions for this post"]')].filter(visible),authors=[...card.querySelectorAll('a[href*="/user/"]')].filter(visible);
              if(actions.length!==1||authors.length<1)continue;
              const links=[...card.querySelectorAll('a[href]')].filter(visible).map(a=>({url:a.href,text:(a.innerText||a.textContent||'').trim(),label:a.getAttribute('aria-label')})),targets=[...new Set(links.map(l=>canonicalPostLink(l.url)).filter(Boolean))];
              if(targets.length!==1||targets[0]!==target)break;
              const messages=[...card.querySelectorAll('[data-ad-preview="message"],[data-ad-comet-preview="message"]')].filter(visible);
              const leaves=messages.length?messages:[...card.querySelectorAll('[dir="auto"]')].filter(e=>visible(e)&&!e.querySelector('[dir="auto"]'));
              const bodies=[...new Set(leaves.map(e=>(e.innerText||e.textContent||'').trim()).filter(x=>x.length>=25&&!/\u034f/.test(x)&&!/^Number of unread notifications\b/i.test(x)))];
              if(messages.length>1||bodies.length!==1)break;
              const author=authors.map(a=>(a.innerText||a.getAttribute('aria-label')||'').trim()).find(Boolean);if(!author)break;
              const markers=[...card.querySelectorAll('abbr,time,[data-utime]')].filter(visible).flatMap(node=>[node.getAttribute('data-utime'),node.getAttribute('datetime'),node.getAttribute('aria-label'),node.getAttribute('title'),node.textContent]).map(x=>(x||'').trim()).filter(Boolean);
              rows.push({body:bodies[0],links:[{url:authors[0].href,text:author},...links],time:card.querySelector('abbr[data-utime]')?.getAttribute('data-utime')||card.querySelector('time[datetime]')?.getAttribute('datetime')||null,times:[...links.flatMap(l=>[l.label,l.text]),...markers]});seen.add(target);break;
            }
            if(rows.length>=max)break;
          }
          return rows;
        },{max:settings.max_posts_per_group,groupId:numericGroupId,vanityId:vanityGroupId});
        const readAt=Date.now();observed+=raw.length;
        if(!raw.length)throw new Error('未识别到带有稳定群组帖子链接和正文的帖子；页面内容可能尚未加载或 Facebook 页面结构已变化，不能将读取失败当作零结果');
        unreadableTime+=raw.filter(row=>!proactivePublishedAt(row,readAt)).length;
        found.push(...normalizeProactiveResults(raw,{...group,url:targetGroupUrl},settings.lookback_hours,readAt));
      }
      const stored=this.store.ingestEngagementPosts(workspace,account.id,found),ranked=this.store.rankedEngagementCandidates(workspace,account.id);
      return {identity:checked.actualIdentity,groups:groups.length,observed,unreadableTime,scanned:found.length,candidates:ranked.length,items:ranked};
    }catch(error){if(/checkpoint|login challenge|temporarily blocked|suspicious activity|安全验证|访问受限/i.test(String(error)))this.store.saveProactiveSettings(workspace,{...settings,account_id:account.id,account_enabled:false});throw error}
    finally{await browser?.close().catch(()=>{});this.activeProfiles.delete(profile.id);}
  }
  async executeProactiveEngagement(workspace,postId,replyBody,{scopedSession=null,scopedPlan=null,assertScoped=null}={}){
    const post=this.store.proactivePost(workspace,postId),account=this.store.account(workspace,post.account_id),profile=this.profile(workspace,account.profile_id),group=this.store.db.prepare('SELECT * FROM facebook_groups WHERE id=? AND workspace=?').get(post.group_id,workspace);
    const targetGroupUrl=verifiedProactiveGroupUrl(group),frozenTarget=facebookPostTarget(post.permalink,{externalId:post.external_id||'',groupUrl:targetGroupUrl}),frozenScope={scope_hash:this.store.proactiveScopeHash(workspace,post.id,replyBody)};if(!scopedSession&&this.activeProfiles.has(profile.id))throw new Error('该 Facebook 执行环境正在执行其他任务');
    if(!scopedSession)this.activeProfiles.add(profile.id);let browser,plan,currentAction,submitted=false;
    try{
      const checked=await this.inspect(workspace,account.id,scopedSession?{session:scopedSession}:{});if(!checked.healthy)throw new Error('Facebook 身份核验失败，主动互动已停止');
      let page;({browser,page}=scopedSession||await this.page(profile));await page.goto(frozenTarget.permalink,{waitUntil:'domcontentloaded',timeout:45000});await page.waitForTimeout(1000);await assertSafeFacebookPage(page,targetGroupUrl);
      const actor=await currentActorName(page);if(!identityMatches(actor,checked.externalId,account))throw new Error('写入前 Facebook 身份发生变化，已阻止操作');
      const body=normalize(await facebookDocumentText(page));if(!body.includes(scopedSession?normalize(post.body):normalize(post.body).slice(0,Math.min(45,normalize(post.body).length))))throw new Error('帖子正文回读不匹配，已阻止操作');
      const settings=this.store.proactiveSettings(workspace,account.id),effective=effectiveAction(post.proposed_action,settings),article=page.locator('div[role="article"]').filter({hasText:normalize(post.body).slice(0,45)}).first(),likeButton=article.getByRole('button',{name:/^(Like|点赞|赞|Thích|Unlike|取消赞|Bỏ thích)$/i}).first(),commentBox=article.locator('[role="textbox"][contenteditable="true"]').last();
      if(effective.includes('LIKE')&&!await likeButton.count())throw new Error('未找到稳定的点赞按钮，未执行任何写操作');
      if(effective.includes('REPLY')&&!await commentBox.count())throw new Error('未找到稳定的评论输入框，未执行任何写操作');
      assertScoped?.();plan=scopedPlan||this.store.reserveProactivePost(workspace,post.id,replyBody,frozenScope);const results=[];
      for(const action of plan.actions){currentAction=action;submitted=false;
        assertScoped?.();this.store.assertProactiveActionScope(workspace,action.id);if(!identityMatches(await currentActorName(page),checked.externalId,account))throw Error('提交前实际 actor 身份发生变化');
        if(action.action_type==='LIKE'){const label=await likeButton.getAttribute('aria-label')||await likeButton.innerText();if(!/Unlike|取消赞|Bỏ thích/i.test(label)){if(!identityMatches(await currentActorName(page),checked.externalId,account))throw Error('提交前 actor 变化');assertScoped?.();this.store.assertProactiveActionScope(workspace,action.id);submitted=true;await likeButton.click({timeout:10000});}}
        else {await commentBox.fill(replyBody);const actual=normalize(await commentBox.textContent());if(actual!==normalize(replyBody))throw new Error('回复文本完整性核对失败');if(!identityMatches(await currentActorName(page),checked.externalId,account))throw Error('提交前 actor 变化');assertScoped?.();this.store.assertProactiveActionScope(workspace,action.id);submitted=true;await commentBox.press('Enter');}
        await page.waitForTimeout(1500);const fresh=await browser.contexts()[0].newPage();let evidence;try{await fresh.goto(post.permalink,{waitUntil:'domcontentloaded',timeout:45000});await fresh.waitForTimeout(900);await assertSafeFacebookPage(fresh,targetGroupUrl);if(canonicalGroupPostUrl(fresh.url(),targetGroupUrl)!==canonicalGroupPostUrl(post.permalink,targetGroupUrl))throw Error('独立回读没有停留在目标帖子');evidence=await proactiveReadback(fresh,action.action_type,replyBody,checked.actualIdentity)}finally{await fresh.close().catch(()=>{})}
        if(!evidence.readback_verified)throw new Error('Facebook 写操作后未获得独立页面回读');results.push(this.store.finishProactiveAction(workspace,action.id,evidence));currentAction=null;
      }
      return {decision:plan.decision,actions:results};
    }catch(error){
      if(currentAction){if(!submitted)return this.store.failProactiveBeforeSubmit(workspace,post.id,String(error));return this.store.markProactiveUnknown(workspace,currentAction.id,String(error));}
      if(/checkpoint|login challenge|temporarily blocked|suspicious activity|安全验证|访问受限/i.test(String(error))){const settings=this.store.proactiveSettings(workspace,account.id);this.store.saveProactiveSettings(workspace,{...settings,account_id:account.id,account_enabled:false})}
      throw error;
    }finally{await browser?.close().catch(()=>{});if(!scopedSession)this.activeProfiles.delete(profile.id);}
  }
  async reconcileProactiveBrowser(workspace,actionId){
    const action=this.store.proactiveAction(workspace,actionId);if(action.state!=='RECONCILE_PENDING')throw Error('动作当前不需要核对');
    const post=this.store.proactivePost(workspace,action.post_id),account=this.store.account(workspace,action.account_id),profile=this.profile(workspace,account.profile_id),group=this.store.db.prepare('SELECT * FROM facebook_groups WHERE id=? AND workspace=?').get(post.group_id,workspace),targetGroupUrl=verifiedProactiveGroupUrl(group);
    if(this.activeProfiles.has(profile.id))throw Error('该账号正在执行任务');
    this.activeProfiles.add(profile.id);let browser;
    try{const session=await this.page(profile,{reconcile:true});browser=session.browser;const page=session.page;
      const checked=await this.inspect(workspace,account.id,{leaseHeld:true});if(!checked.healthy)throw Error('身份核验失败');
      await page.goto(post.permalink,{waitUntil:'domcontentloaded',timeout:45000});await assertSafeFacebookPage(page,targetGroupUrl);
      if(canonicalGroupPostUrl(page.url(),targetGroupUrl)!==canonicalGroupPostUrl(post.permalink,targetGroupUrl))throw Error('核对目标不匹配');
      const evidence=await proactiveReadback(page,action.action_type,action.reply_body,checked.actualIdentity);
      if(!evidence.readback_verified)throw Error('尚未找到完整回读证据，继续保留待核对，不能据此认定未发生');
      return this.store.reconcileProactiveAction(workspace,action.id,{...evidence,found:true});
    }finally{await browser?.close().catch(()=>{});this.activeProfiles.delete(profile.id);}
  }
  async syncBrowserInbox(workspace,accountId){
    const account=this.store.account(workspace,accountId),profile=this.profile(workspace,account.profile_id);
    if(this.activeProfiles.has(profile.id))throw Error('该账号正在执行任务');
    this.activeProfiles.add(profile.id);let browser;
    try{
      const checked=await this.inspect(workspace,accountId);if(!checked.healthy)throw Error('Facebook 实际操作身份尚未核实');
      const session=await this.page(profile);browser=session.browser;const page=session.page;
      const posts=this.store.rows('published_posts',workspace).filter(p=>p.account_id===accountId&&!/^radar-/.test(p.job_id)).slice(0,25),verifiedPublisherUrls=new Set();
      // Unified Page publications have their own durable, readback-verified ledger.
      // Project only exact confirmed actor/Page/post bindings into the Inbox index.
      for(const job of this.store.db.prepare("SELECT * FROM publisher_jobs WHERE workspace=? AND account_id=? AND state='PUBLISHED' ORDER BY updated_at DESC LIMIT 25").all(workspace,accountId)){
        let frozen,evidence;try{frozen=JSON.parse(job.snapshot_json);evidence=JSON.parse(job.evidence_json);}catch{continue;}
        if(!evidence?.verified||frozen.platform!=='facebook'||frozen.identityType!=='PAGE'||frozen.operatorActorId!==account.external_id||frozen.targetPageId!==account.target_page_id||!/^[1-9]\d*$/.test(evidence.id||''))continue;
        const expected=`https://www.facebook.com/${frozen.operatorActorId}/posts/${evidence.id}`;
        if(evidence.url?.replace(/\/$/,'')!==expected)continue;
        const post=this.store.upsertPagePost(workspace,accountId,{id:`${frozen.operatorActorId}_${evidence.id}`,permalink_url:expected});verifiedPublisherUrls.add(expected);if(!posts.some(p=>p.id===post.id))posts.push(post);
      }
      if(account.identity_type==='PAGE'){
        const pageId=account.target_page_id||account.external_id;if(!/^[1-9]\d*$/.test(pageId||''))throw Error('目标 Page ID 尚未绑定');
        await page.goto(`https://www.facebook.com/profile.php?id=${pageId}`,{waitUntil:'domcontentloaded',timeout:45000});await page.waitForTimeout(1200);
        if(await currentActorName(page)!==checked.actualIdentity)throw Error('读取期间身份变化');
        const urls=await page.locator('a[href]').evaluateAll((links,id)=>[...new Set(links.flatMap(link=>{try{const u=new URL(link.href),m=u.pathname.match(/^\/(\d+)\/posts\/(\d+)\/?$/);if(m&&m[1]===id)return [u.href];if(u.pathname==='/permalink.php'&&u.searchParams.get('id')===id&&/^\d+$/.test(u.searchParams.get('story_fbid')||''))return [u.href];return [];}catch{return [];}}))].slice(0,25),pageId);
        for(const url of urls){const u=new URL(url),id=u.pathname.match(/\/posts\/(\d+)/)?.[1]||u.searchParams.get('story_fbid');const post=this.store.upsertPagePost(workspace,accountId,{id:pageId+'_'+id,permalink_url:facebookPostTarget(url,{externalId:pageId+'_'+id}).permalink});if(!posts.some(p=>p.id===post.id))posts.push(post);}
      }
      let comments=0,read=0,skippedVanityGroups=0;
      for(const post of posts.slice(0,25)){
        const group=post.group_id==='PAGE'?null:this.store.db.prepare('SELECT * FROM facebook_groups WHERE id=? AND workspace=? AND account_id=? AND enabled=1').get(post.group_id,workspace,account.id);if(post.group_id!=='PAGE'&&!group)throw Error('帖子来源群组未绑定到当前账号');
        // Historical group URLs may use a vanity slug while Facebook returns a numeric
        // group ID in the post permalink. Do not infer that these are the same group.
        // Keep the read-only Inbox moving so one unverifiable group row cannot hide
        // Page comments; the group remains unavailable until its binding is verified.
        if(group){const expected=new URL(group.url).pathname.match(/^\/groups\/([^/]+)\/?$/)?.[1],observed=new URL(post.post_url).pathname.match(/^\/groups\/([^/]+)\/(?:posts|permalink)\/[1-9]\d*\/?$/)?.[1];if(expected&&!/^\d+$/.test(expected)&&observed&&/^\d+$/.test(observed)&&expected!==observed){skippedVanityGroups++;continue;}}
        const observed=facebookPostTarget(post.post_url,{externalId:post.job_id.startsWith('page:')?post.job_id.split(':').at(-1):undefined,groupUrl:group?.url});if(post.group_id==='PAGE'&&account.target_page_id&&observed.ownerId!==account.target_page_id&&!verifiedPublisherUrls.has(observed.permalink.replace(/\/$/,'')))throw Error('帖子不属于绑定的 Business Page');const target=new URL(observed.permalink);
        await page.goto(target.href,{waitUntil:'domcontentloaded',timeout:45000});await page.waitForTimeout(900);
        if(await currentActorName(page)!==checked.actualIdentity||/login|checkpoint/i.test(page.url()))throw Error('读取期间需要重新核实身份');
        const rows=await page.locator('div[role="article"]').evaluateAll((nodes,{postId,ownerId})=>nodes.flatMap(node=>{
          const links=[...node.querySelectorAll('a[href]')],comment=links.find(a=>{try{const u=new URL(a.href),linkedPost=u.pathname.match(/\/(?:posts|permalink)\/([1-9]\d*)\/?$/)?.[1]||u.searchParams.get('story_fbid'),opaquePagePermalink=ownerId&&u.pathname==='/permalink.php'&&u.searchParams.get('id')===ownerId&&/^pfbid[A-Za-z0-9]+$/.test(linkedPost||'');return ['facebook.com','www.facebook.com','m.facebook.com','mbasic.facebook.com'].includes(u.hostname)&&u.searchParams.has('comment_id')&&(linkedPost===postId||opaquePagePermalink);}catch{return false;}});
          if(!comment)return [];const u=new URL(comment.href),author=links.find(a=>a!==comment&&/\/user\/|profile.php|\/people\//.test(a.href));
          const texts=[...node.querySelectorAll('[dir="auto"]')].filter(x=>x.closest('[role="article"]')===node).map(x=>(x.innerText||'').trim()).filter(Boolean);
          const body=texts.sort((a,b)=>b.length-a.length)[0];return body?[{external_id:u.searchParams.get('reply_comment_id')||u.searchParams.get('comment_id'),parent_id:u.searchParams.get('reply_comment_id')?u.searchParams.get('comment_id'):null,author:(author?.innerText||'Facebook 用户').trim(),body}]:[];
        }),{postId:observed.postId,ownerId:post.group_id==='PAGE'?observed.ownerId:null});
        const unique=[...new Map(rows.map(row=>[row.external_id,row])).values()];this.store.upsertComments(workspace,post.id,unique);comments+=unique.length;read++;
      }
      return {mode:'BROWSER',posts:read,comments,limited:true,...(skippedVanityGroups?{skippedVanityGroups}:{})};
    }finally{await browser?.close().catch(()=>{});this.activeProfiles.delete(profile.id);}
  }
  async replyInboxCandidate(workspace,candidateId,{reconcile=false}={}){
    const candidate=this.store.engagementCandidate(workspace,candidateId),comment=this.store.comment(workspace,candidate.comment_id),account=this.store.account(workspace,candidate.account_id),profile=this.profile(workspace,account.profile_id),post=this.store.db.prepare('SELECT * FROM published_posts WHERE id=? AND workspace=?').get(comment.post_id,workspace);
    const resolved=reconcile?this.store.themeTarget(workspace,candidate.id):this.store.assertEngagementReviewed(workspace,candidate.id),frozenReview={draft:candidate.draft,scope_hash:reconcile?null:this.store.engagementCandidateView(workspace,candidate.id).scope_hash};if(resolved.kind!=='INBOX')throw Error('候选不是评论目标');if(resolved.parentCommentId)throw Error('嵌套评论缺少精确回复关联证据，保留当前状态');
    if(!reconcile&&candidate.state!=='REPLY_CANDIDATE')throw Error('只有待执行候选可以回复；UNKNOWN 必须核对');
    if(reconcile&&candidate.state!=='UNKNOWN')throw Error('候选当前不需要核对');
    if(this.activeProfiles.has(profile.id))throw Error('该账号正在执行任务');
    this.activeProfiles.add(profile.id);let browser,reservation,submitted=false;
    try{
      const session=await this.page(profile,{reconcile});browser=session.browser;const page=session.page;
      const checked=await this.inspect(workspace,account.id,{leaseHeld:true});if(!checked.healthy)throw Error('浏览器身份核验失败');
      const target=new URL(resolved.url);
      await page.goto(target.href,{waitUntil:'domcontentloaded',timeout:45000});await page.waitForTimeout(1000);
      if(await currentActorName(page)!==checked.actualIdentity||/checkpoint|login/i.test(page.url()))throw Error('当前操作身份发生变化');
      if(facebookPostTarget(page.url()).permalink!==resolved.permalink)throw Error('未停留在冻结目标帖子');
      const anchor=page.locator(`a[href*="${comment.parent_id?'reply_comment_id':'comment_id'}=${comment.external_id}"]`).first();
      const anchorUrl=new URL(await anchor.getAttribute('href'),page.url());if(!facebookCommentAnchorBoundToPost(anchorUrl.href,resolved,comment.parent_id||comment.external_id))throw Error('评论链接不属于冻结帖子');if((anchorUrl.searchParams.get('reply_comment_id')||anchorUrl.searchParams.get('comment_id'))!==comment.external_id)throw Error('评论链接 ID 不精确匹配');
      const article=anchor.locator('xpath=ancestor::div[@role="article"][1]');
      if(!await article.count()||!normalize(await article.innerText()).includes(normalize(comment.body)))throw Error('目标评论正文无法独立核实');
      if(reconcile){
        const evidence=await radarReplyReadback(page,candidate.draft,checked.actualIdentity,comment.parent_id||comment.external_id);
        if(!evidence.readback_verified)throw Error('未找到完整回复证据，继续保留待核对');
        reservation=this.store.db.prepare("SELECT * FROM quota_events WHERE workspace=? AND subject_id=? AND state='RESERVED'").get(workspace,candidate.id);if(!reservation)throw Error('原额度预留不存在');
        return this.store.finishAutoReply(workspace,candidate.id,reservation.id,evidence);
      }
      reservation=this.store.reserveReplyQuota(workspace,candidate.id,frozenReview).reservation;
      const reply=article.getByRole('button',{name:/^(Reply|回复|Trả lời)$/i}).first();if(!await reply.count())throw Error('没有可核实的评论回复按钮');await reply.click();
      const box=article.locator('[role="textbox"][contenteditable="true"]').last();if(!await box.count())throw Error('没有目标评论的回复输入框');
      await box.fill(candidate.draft);if(normalize(await box.textContent())!==normalize(candidate.draft))throw Error('回复正文核对失败');
      if(!identityMatches(await currentActorName(page),checked.externalId,account))throw Error('提交前实际 actor 身份发生变化');
      this.store.beginAutoReply(workspace,candidate.id,reservation.id);submitted=true;await box.press('Enter');
      const fresh=await browser.contexts()[0].newPage();let evidence;try{await fresh.goto(target.href,{waitUntil:'domcontentloaded',timeout:45000});await fresh.waitForTimeout(1200);if(facebookPostTarget(fresh.url()).permalink!==resolved.permalink||await currentActorName(fresh)!==checked.actualIdentity)throw Error('独立回读目标或身份不一致');evidence=await radarReplyReadback(fresh,candidate.draft,checked.actualIdentity,comment.external_id);}finally{await fresh.close().catch(()=>{});}
      if(!evidence.readback_verified)throw Error('已提交，但回复作者或正文未被独立确认');
      return this.store.finishAutoReply(workspace,candidate.id,reservation.id,evidence);
    }catch(error){if(reservation&&!reconcile){if(submitted)return this.store.markAutoReplyUnknown(workspace,candidate.id,reservation.id,String(error));this.store.releaseQuota(workspace,reservation.id,'提交前失败');}throw error;}
    finally{await browser?.close().catch(()=>{});this.activeProfiles.delete(profile.id);}
  }
  async reconcileThemeReply(workspace,candidateId){
    const candidate=this.store.engagementCandidate(workspace,candidateId),comment=this.store.comment(workspace,candidate.comment_id),source=this.store.db.prepare('SELECT * FROM published_posts WHERE id=? AND workspace=?').get(comment.post_id,workspace);
    if(!/^radar-(group|post):/.test(source.job_id))return this.replyInboxCandidate(workspace,candidateId,{reconcile:true});
    if(candidate.state!=='UNKNOWN')throw Error('候选当前不需要核对');
    const account=this.store.account(workspace,candidate.account_id),profile=this.profile(workspace,account.profile_id);
    if(this.activeProfiles.has(profile.id))throw Error('该账号正在执行任务');
    this.activeProfiles.add(profile.id);let browser;
    try{const session=await this.page(profile,{reconcile:true});browser=session.browser;const page=session.page;
      const checked=await this.inspect(workspace,account.id,{leaseHeld:true});if(!checked.healthy)throw Error('浏览器身份核验失败');
      const group=this.store.db.prepare('SELECT * FROM facebook_groups WHERE id=? AND workspace=? AND account_id=?').get(source.group_id,workspace,account.id);
      const target=this.store.themeTarget(workspace,candidate.id).permalink;await page.goto(target,{waitUntil:'domcontentloaded',timeout:45000});await page.waitForTimeout(1200);await assertSafeFacebookPage(page,group.url);
      if(canonicalGroupPostUrl(page.url(),group.url)!==target)throw Error('回读目标帖子不匹配');
      const evidence=await radarReplyReadback(page,candidate.draft,checked.actualIdentity);if(!evidence.readback_verified)throw Error('未找到完整回复证据，继续待核对');
      const held=this.store.db.prepare("SELECT * FROM quota_events WHERE workspace=? AND subject_id=? AND state='RESERVED'").get(workspace,candidate.id);if(!held)throw Error('原额度预留不存在');
      return this.store.finishAutoReply(workspace,candidate.id,held.id,evidence);
    }finally{await browser?.close().catch(()=>{});this.activeProfiles.delete(profile.id);}
  }
  async prepareJob(workspace,jobId){const job=this.store.job(workspace,jobId),account=this.store.account(workspace,job.account_id),profile=this.profile(workspace,job.profile_id),group=this.store.db.prepare('SELECT * FROM facebook_groups WHERE id=?').get(job.group_id),content=this.store.db.prepare('SELECT * FROM group_content WHERE id=?').get(job.content_id);const checked=await this.inspect(workspace,account.id);this.store.beginPrepare(workspace,job.id,checked.actualIdentity);let browser;try{let page;({browser,page}=await this.page(profile));await page.goto(group.url,{waitUntil:'domcontentloaded',timeout:45000});if(!page.url().includes(new URL(group.url).pathname))throw new Error('Facebook 未停留在目标群组，已阻止写入');await page.waitForTimeout(1000);const preexisting=await groupPostCandidates(page,group.url,content.body,account.expected_identity);if(preexisting.length)throw new Error('目标群组已有相同正文帖子，请先核对，禁止重复准备');const {dialog,box}=await openPostComposer(page);await box.fill(content.body,{timeout:10000});const actual=await box.textContent();if(normalize(actual)!==normalize(content.body))throw new Error('正文完整性核对失败，已阻止提交');const media=JSON.parse(content.media_json);if(media.length){const input=dialog.locator('input[type=file]').last();if(!await input.count())throw new Error('未找到媒体附件入口');await input.setInputFiles(media);await page.waitForTimeout(1000);}const evidence={target_url:page.url(),group_name:group.name,actual_identity:checked.actualIdentity,text_hash:content.content_hash,media_count:media.length,prepared_at:new Date().toISOString(),human_final_click_required:true,preexisting_post_urls:preexisting};this.store.finishPrepare(workspace,job.id,evidence);setTimeout(()=>this.watchManualPost(workspace,job.id).catch(()=>{}),0).unref();return evidence;}catch(error){if(this.store.job(workspace,job.id).state==='PREPARING')this.store.failBeforeSubmit(workspace,job.id,String(error));throw error;}finally{await browser?.close().catch(()=>{});}}
  async watchManualPost(workspace,jobId){
    if(this.manualWatchers.has(jobId))return;this.manualWatchers.add(jobId);
    const job=this.store.job(workspace,jobId),account=this.store.account(workspace,job.account_id),profile=this.profile(workspace,job.profile_id),group=this.store.db.prepare('SELECT * FROM facebook_groups WHERE id=? AND workspace=?').get(job.group_id,workspace),content=this.store.db.prepare('SELECT * FROM group_content WHERE id=? AND workspace=?').get(job.content_id,workspace);
    let browser;
    try{const session=await this.page(profile,{reconcile:true});browser=session.browser;const page=session.page,deadline=Date.now()+180000;
      while(Date.now()<deadline&&this.store.job(workspace,jobId).state==='WAITING_FOR_USER'){
        if(page.url().startsWith(group.url)){
          const baseline=new Set(JSON.parse(this.store.job(workspace,jobId).evidence_json||'{}').preexisting_post_urls||[]);
          const urls=(await groupPostCandidates(page,group.url,content.body,account.expected_identity)).filter(url=>!baseline.has(url));
          if(urls.length===1&&await this.verifyGroupPost(browser,urls[0],group,content,account)){
            this.store.claimPost(workspace,jobId,urls[0],{method:'MANUAL_POST_BROWSER_READBACK',checked_at:new Date().toISOString()});return;
          }
        }
        await new Promise(r=>setTimeout(r,4000));
      }
    }finally{await browser?.close().catch(()=>{});this.manualWatchers.delete(jobId);}
  }
  async reconcileJob(workspace,jobId,suppliedUrl){
    const job=this.store.job(workspace,jobId);
    if(job.state==='PUBLISHED'&&JSON.parse(job.evidence_json||'{}').readback)return job;
    if(!['WAITING_FOR_USER','UNKNOWN','FAILED','PUBLISHED'].includes(job.state))throw new Error('当前任务尚未进入可核对状态');
    const account=this.store.account(workspace,job.account_id),profile=this.profile(workspace,job.profile_id),group=this.store.db.prepare('SELECT * FROM facebook_groups WHERE id=? AND workspace=?').get(job.group_id,workspace),content=this.store.db.prepare('SELECT * FROM group_content WHERE id=? AND workspace=?').get(job.content_id,workspace);
    let browser,page;
    try{const session=await this.page(profile,{reconcile:true});browser=session.browser;page=await browser.contexts()[0].newPage();
      let urls;
      if(suppliedUrl||job.post_url){
        const input=String(suppliedUrl||job.post_url).trim();
        const provided=new URL(input);
        if(provided.protocol!=='https:'||!/(^|\.)facebook\.com$/.test(provided.hostname))throw new Error('请粘贴 Facebook 帖子的完整 https 链接');
        await page.goto(input,{waitUntil:'domcontentloaded',timeout:45000});
        urls=[canonicalGroupPostUrl(page.url(),group.url)];
      }else{
        const baseline=JSON.parse(job.evidence_json||'{}').preexisting_post_urls||[];
        await page.goto(group.url,{waitUntil:'domcontentloaded',timeout:45000});await page.waitForTimeout(1500);
        urls=(await groupPostCandidates(page,group.url,content.body,account.expected_identity)).filter(url=>!baseline.includes(url));
      }
      if(urls.length!==1)throw new Error(urls.length?'发现多个相似帖子，请粘贴准确帖子链接逐一核对':'群组当前可见页面未找到匹配帖子；可能仍在审核、未发布或被隐藏。任务保持待核对，绝不会自动重发');
      if(!await this.verifyGroupPost(browser,urls[0],group,content,account))throw new Error('帖子链接与群组、作者或正文不一致；未更改任务状态');
      return this.store.claimPost(workspace,jobId,urls[0],{method:'MANUAL_POST_BROWSER_READBACK',checked_at:new Date().toISOString()});
    }finally{await page?.close().catch(()=>{});await browser?.close().catch(()=>{});}
  }
  async verifyGroupPost(browser,url,group,content,account,{fullBody=false}={}){
    const page=await browser.contexts()[0].newPage();
    try{await page.goto(url,{waitUntil:'domcontentloaded',timeout:45000});await page.waitForTimeout(1000);
      if(canonicalGroupPostUrl(page.url(),group.url)!==url)return false;
      const body=normalize(await facebookDocumentText(page));
      const expected=normalize(content.body),opening=expected.slice(0,Math.min(70,expected.length));
      const authorLink=account.external_id?await page.locator(`a[href*="/user/${account.external_id}"]`).count():0;
      return Boolean(opening&&body.includes(fullBody?expected:opening)&&body.includes(normalize(account.expected_identity))&&(!account.external_id||authorLink>0));
    }catch{return false;}finally{await page.close().catch(()=>{});}
  }
  enqueueJobs(workspace,jobIds,filters={}){
    const jobs=[...new Set(jobIds)].map(id=>this.store.job(workspace,id));
    if(!jobs.length)throw new Error('没有可自动发布的新任务');
    if(jobs.some(j=>!['PENDING','FAILED','BLOCKED'].includes(j.state)||this.store.db.prepare('SELECT 1 FROM publication_intents WHERE job_id=? LIMIT 1').get(j.id)))throw new Error('只能发布未提交过的任务；已提交或结果不确定的任务必须先核对');
    if(jobs.some(j=>{const group=this.store.db.prepare('SELECT name FROM facebook_groups WHERE id=? AND workspace=?').get(j.group_id,workspace);return !group||!groupNameMatches(group.name,filters)}))throw new Error('任务包含被当前群组名称筛选排除的群组，已阻止发布');
    const profileIds=[...new Set(jobs.map(j=>j.profile_id))];
    if(profileIds.some(id=>this.activeProfiles.has(id)))throw new Error('该 Facebook 执行环境已有自动发布队列，请等待完成');
    profileIds.forEach(id=>this.activeProfiles.add(id));
    void this.runQueue(workspace,jobs,profileIds);
    return {accepted:jobs.length,job_ids:jobs.map(j=>j.id)};
  }
  async runQueue(workspace,jobs,profileIds){
    try{for(let index=0;index<jobs.length;index++){try{await this.publishJob(workspace,jobs[index].id)}catch(error){
      for(const remaining of jobs.slice(index+1))this.store.blockUnstarted(workspace,remaining.id,`同批前序任务失败，尚未提交：${String(error.message||error)}`);
      break;
    }}}
    finally{profileIds.forEach(id=>this.activeProfiles.delete(id));}
  }
  async publishJob(workspace,jobId,{scopedSession=null,scopedMedia=null,assertScoped=null}={}){
    const job=this.store.job(workspace,jobId),account=this.store.account(workspace,job.account_id),profile=this.profile(workspace,job.profile_id);
    const group=this.store.db.prepare('SELECT * FROM facebook_groups WHERE id=? AND workspace=?').get(job.group_id,workspace);
    const content=this.store.db.prepare('SELECT * FROM group_content WHERE id=? AND workspace=?').get(job.content_id,workspace);
    let submitted=false,browser;
    try{
      const checked=await this.inspect(workspace,account.id,scopedSession?{session:scopedSession}:{}),verifiedAccount=this.store.account(workspace,account.id);
      if(!checked.healthy)throw new Error('Facebook 发布身份核验失败，自动发布已停止');
      if(!scopedSession)this.store.beginPrepare(workspace,job.id,checked.actualIdentity);else {assertScoped();if(this.store.job(workspace,job.id).state!=='PREPARING')throw Error('SCOPED_CLAIM_REQUIRED');}
      let page;({browser,page}=scopedSession||await this.page(profile));await page.bringToFront();
      await page.goto(group.url,{waitUntil:'domcontentloaded',timeout:45000});
      if(!page.url().includes(new URL(group.url).pathname))throw new Error('Facebook 未停留在目标群组，已阻止提交');
      const actor=await currentActorName(page);if(!identityMatches(actor,verifiedAccount.external_id,verifiedAccount))throw new Error('提交前 Facebook 身份发生变化，已阻止提交');
      const preexisting=await groupPostCandidates(page,group.url,content.body,verifiedAccount.expected_identity);
      if(preexisting.length)throw new Error('目标群组已有相同正文帖子；自动发布已停止，请先核对');
      assertScoped?.();const {dialog,box}=await openPostComposer(page);await box.fill(content.body,{timeout:10000});
      const actual=await box.textContent();if(normalize(actual)!==normalize(content.body))throw new Error('正文完整性核对失败，已阻止提交');
      const media=scopedMedia||JSON.parse(content.media_json);if(media.length){const input=dialog.locator('input[type=file]').last();if(!await input.count())throw new Error('未找到媒体附件入口');await input.setInputFiles(media);await page.waitForTimeout(Math.min(15000,2000+media.length*1500));}
      const snapshot={target_url:page.url(),group_name:group.name,actual_identity:actor,text_hash:content.content_hash,media_count:media.length,prepared_at:new Date().toISOString(),automatic:true,preexisting_post_urls:preexisting};
      this.store.finishPrepare(workspace,job.id,snapshot);
      const publish=dialog.getByRole('button',{name:/^(发布|Post)$/i}).last();await publish.waitFor({state:'visible',timeout:15000});if(await publish.isDisabled())throw new Error('Facebook 发布按钮不可用，媒体可能仍在处理');if(scopedSession)await publish.click({trial:true,timeout:10000});
      assertScoped?.();this.store.beginSubmit(workspace,job.id,snapshot);submitted=true;await publish.click({timeout:15000});
      await dialog.waitFor({state:'hidden',timeout:30000}).catch(()=>{});
      const postUrl=await findPublishedPostUrl(page,group.url,content.body,45000,verifiedAccount);
      if(!postUrl||!await this.verifyGroupPost(browser,postUrl,group,content,verifiedAccount,{fullBody:Boolean(scopedSession)}))throw new Error('Facebook 已接收提交，但尚未独立回读到匹配帖子；任务已转为待核对，禁止自动重发');
      return this.store.claimPost(workspace,job.id,postUrl,{method:'AUTO_POST_BROWSER_READBACK',checked_at:new Date().toISOString()});
    }catch(error){
      const current=this.store.job(workspace,job.id);
      if(submitted||current.state==='PROCESSING'||scopedSession&&['PREPARING','WAITING_FOR_USER'].includes(current.state))this.store.markUnknown(workspace,job.id,String(error));
      else if(['PREPARING','WAITING_FOR_USER'].includes(current.state))this.store.failBeforeSubmit(workspace,job.id,String(error));
      else if(current.state==='PENDING')this.store.blockUnstarted(workspace,job.id,String(error));
      throw error;
    }finally{await browser?.close().catch(()=>{});}
  }
  health(accountId,status,verified){this.store.db.prepare('UPDATE facebook_accounts SET session_health=?,identity_verified_at=? WHERE id=?').run(status,verified?new Date().toISOString():null,accountId);}
  profile(workspace,id){const profile=this.store.db.prepare('SELECT * FROM execution_profiles WHERE id=? AND workspace=?').get(id,workspace);if(!profile)throw Error('执行环境不存在');assertNotChannelsProfile(this.store.db,profile);return profile;}
  resourcePending(profile){
    const pageTable=this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='publisher_jobs'").get();
    const publication=pageTable&&pendingPublisherProfileRows(this.store.db,profile.id).length>0;
    const group=this.store.db.prepare("SELECT 1 FROM group_jobs WHERE profile_id=? AND state IN ('UNKNOWN','PROCESSING','WAITING_FOR_USER') LIMIT 1").get(profile.id);
    const action=this.store.db.prepare("SELECT 1 FROM engagement_actions e JOIN facebook_accounts a ON a.id=e.account_id AND a.workspace=e.workspace WHERE a.profile_id=? AND e.state IN ('ATTEMPTING','RECONCILE_PENDING') LIMIT 1").get(profile.id);
    const reply=this.store.db.prepare("SELECT 1 FROM engagement_candidates e JOIN facebook_accounts a ON a.id=e.account_id AND a.workspace=e.workspace WHERE a.profile_id=? AND e.state IN ('SUBMITTING','UNKNOWN') LIMIT 1").get(profile.id);
    return Boolean(publication||group||action||reply);
  }
  async page(profile,{reconcile=false,isolated=false}={}){const release=this.resources?.acquire(profile.user_data_dir,'operator:'+profile.id,()=>this.resourcePending(profile),{reconcile});try{return await this.connectPage(profile,release,{isolated});}catch(error){release?.();throw error;}}
  async connectPage(profile,release,{isolated=false}={}){if(!await cdpReady(profile.cdp_port))throw new Error('执行环境未连接，请到“账号与设置”启动 Chrome');if(!await portMatchesProfile(profile))throw Error('调试端口不属于当前客户的 Chrome 数据目录；已阻止跨账号操作');const {chromium}=await import('playwright-core');const browser=await chromium.connectOverCDP(`http://127.0.0.1:${profile.cdp_port}`,{noDefaults:true,timeout:15000});const close=browser.close.bind(browser);browser.close=async()=>{try{return await close();}finally{release?.();}};try{const context=browser.contexts()[0];if(!context)throw new Error('Chrome 没有可连接的会话');const page=isolated?await context.newPage():context.pages().find(p=>/^https:\/\/(www\.)?facebook\.com\//.test(p.url()))||await context.newPage();if(!isolated)await page.bringToFront();return {browser,page};}catch(error){await browser.close();throw error;}}
}
export function postComposer(page){
  // Facebook nests a second role=dialog around the "Create post" heading.
  // The last dialog is that header, not the modal containing the editor.
  const dialog=page.locator('[role="dialog"][aria-modal="true"]').last();
  const box=dialog.locator('[role="textbox"][contenteditable="true"]').last();
  return {dialog,box};
}
async function openPostComposer(page){
  const trigger=page.getByRole('button',{name:/写点什么|Write something|Viết gì đó/i}).first();
  await trigger.waitFor({state:'visible',timeout:15000});
  // domcontentloaded precedes Facebook's client-side hydration. Clicking the
  // placeholder immediately can open an editor that is replaced seconds later.
  await page.waitForTimeout(1500);
  for(let attempt=0;attempt<2;attempt++){
    const current=postComposer(page);
    if(await current.box.isVisible().catch(()=>false))return current;
    if(attempt){const close=current.dialog.getByRole('button',{name:/Close composer dialog|关闭/i});if(await close.count())await close.click().catch(()=>{});}
    await trigger.click({timeout:15000});
    const opened=postComposer(page);
    if(await opened.box.waitFor({state:'visible',timeout:10000}).then(()=>true).catch(()=>false)){
      await page.waitForTimeout(500);
      if(await opened.box.isVisible().catch(()=>false))return opened;
    }
  }
  throw new Error('Facebook Create post 编辑器未稳定加载；未提交，可安全重试');
}
export function chromeCommandMatchesProfile(command,profile){
  const args=String(command||'').trim();
  return args.startsWith(`${CHROME} `)&&args.includes(`--remote-debugging-port=${profile.cdp_port} `)&&
    (args.includes(`--user-data-dir=${profile.user_data_dir} `)||args.endsWith(`--user-data-dir=${profile.user_data_dir}`));
}
async function portMatchesProfile(profile){try{const {stdout}=await execFileAsync('/usr/sbin/lsof',['-t','-nP',`-iTCP:${profile.cdp_port}`,'-sTCP:LISTEN'],{timeout:3000});const pid=stdout.trim().split(/\s+/)[0];if(!/^\d+$/.test(pid))return false;const process=await execFileAsync('/bin/ps',['-p',pid,'-o','command='],{timeout:3000});return chromeCommandMatchesProfile(process.stdout,profile);}catch{return false;}}
function normalize(x){return String(x||'').replace(/\s+/g,' ').trim();}
export function profileIdFromUrl(value){try{const u=new URL(value);if(!/^(www\.)?facebook\.com$/.test(u.hostname))return null;return u.pathname==='/profile.php'?u.searchParams.get('id'):null;}catch{return null;}}
export function identityMatches(name,id,account){return normalize(name)===normalize(account.expected_identity)&&Boolean(id)&&(!account.external_id||String(account.external_id)===String(id));}
async function currentActorName(page,timeout=15000){
  const trigger=page.getByRole('button',{name:/^(Your profile|你的个人主页|你的个人资料|你的主页|账户|账号|Trang cá nhân của bạn|Hồ sơ của bạn|Tài khoản)$/i}).first();
  if(!await trigger.waitFor({state:'visible',timeout}).then(()=>true).catch(()=>false))return '';
  const opened=await trigger.getAttribute('aria-expanded')!=='true';
  try{
    if(opened)await trigger.click({timeout});
    const me=page.getByRole('dialog').locator('a[href="/me/"],a[href="/me"],a[href="https://www.facebook.com/me/"],a[href="https://www.facebook.com/me"]').first();
    await me.waitFor({state:'visible',timeout});
    return normalize(await me.innerText());
  }catch{return '';}finally{if(opened)await trigger.click({timeout}).catch(()=>{});}
}
async function findPublishedPostUrl(page,groupUrl,body,timeout,account){
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline){
    const urls=await groupPostCandidates(page,groupUrl,body,account.expected_identity);
    if(urls.length===1)return urls[0];
    await page.waitForTimeout(2000);await page.reload({waitUntil:'domcontentloaded',timeout:30000}).catch(()=>{});
  }
  return null;
}
export function canonicalGroupPostUrl(value,groupUrl){
  const url=new URL(String(value)),group=new URL(groupUrl);
  let match=url.pathname.match(/^\/groups\/([^/]+)\/(?:posts|permalink)\/(\d+)\/?$/);
  if(!match&&/^\/photo\/?$/.test(url.pathname)){const photo=url.searchParams.get('set')?.match(/^gm\.(\d+)$/),photoGroup=url.searchParams.get('idorvanity');if(photo&&photoGroup)match=[null,photoGroup,photo[1]];}
  if(!match&&url.pathname==='/story.php'){const story=url.searchParams.get('story_fbid'),storyGroup=url.searchParams.get('id');if(/^\d+$/.test(story||'')&&storyGroup)match=[null,storyGroup,story];}
  if(url.protocol!=='https:'||!/(^|\.)facebook\.com$/.test(url.hostname)||!match)throw new Error('请提供目标 Facebook 群组的帖子链接（帖子、permalink 或照片链接）');
  const groupId=group.pathname.match(/^\/groups\/([^/]+)/)?.[1];
  if(/^\d+$/.test(groupId||'')&&match[1]!==groupId)throw new Error('帖子链接不属于目标群组');
  return `https://www.facebook.com/groups/${match[1]}/posts/${match[2]}/`;
}
export async function groupPostCandidates(page,groupUrl,body,author){
  const prefix=normalize(body).slice(0,Math.min(55,normalize(body).length));
  if(!prefix)return [];
  const groupId=new URL(groupUrl).pathname.match(/^\/groups\/([^/]+)/)?.[1]||'';
  const links=await page.evaluate(({prefix,author,groupId})=>{
    const result=[];
    for(const anchor of document.querySelectorAll('a[href]')){
      let url;try{url=new URL(anchor.href);}catch{continue;}
      let postId='',postGroup='';
      const direct=url.pathname.match(/^\/groups\/([^/]+)\/posts\/(\d+)\/?$/);
      if(direct){postGroup=direct[1];postId=direct[2];}
      else if(url.pathname==='/photo/'&&/^gm\.\d+$/.test(url.searchParams.get('set')||'')){
        postId=url.searchParams.get('set').slice(3);postGroup=url.searchParams.get('idorvanity')||groupId;
      }
      if(!postId||(/^\d+$/.test(groupId)&&postGroup!==groupId))continue;
      let node=anchor,matched=false;
      for(let i=0;i<18&&node;i++,node=node.parentElement){
        const text=(node.innerText||'').replace(/\s+/g,' ').trim();
        if(text.length>8000)break;
        if(text.includes(prefix)&&text.includes(author)){matched=true;break;}
      }
      if(matched)result.push(`https://www.facebook.com/groups/${postGroup}/posts/${postId}/`);
    }
    return [...new Set(result)];
  },{prefix,author,groupId});
  return links;
}
export function normalizeGroupLinks(links){const seen=new Set();return links.map(x=>({name:normalize(x.name),url:String(x.url).split(/[?#]/)[0].replace(/\/$/,'')})).filter(x=>{const m=x.url.match(/^https:\/\/(?:www\.)?facebook\.com\/groups\/([^/]+)$/);return x.name&&m&&!['joins','feed','discover','create','notifications','search','your_groups'].includes(m[1])&&!seen.has(x.url)&&seen.add(x.url);});}
export function normalizeRadarResults(rows,group,topic,limit=10){const seen=new Set();return rows.flatMap(row=>{const link=(row.links||[]).find(x=>{try{canonicalGroupPostUrl(x.url,group.url);return true}catch{return false}});if(!link)return [];const permalink=canonicalGroupPostUrl(link.url,group.url),externalId=new URL(permalink).pathname.match(/\/posts\/(\d+)/)?.[1],key=group.id+':'+externalId,body=normalize(row.body),author=normalize((row.links||[]).find(x=>x.text&&!/\/(posts|permalink)\//.test(String(x.url)))?.text)||'Facebook 用户';if(!externalId||!body||seen.has(key))return [];seen.add(key);return [{group_id:group.id,external_id:externalId,permalink,author,body:body.slice(0,4000),topic}] }).slice(0,Math.min(10,limit));}
export function parseFacebookPostTime(value,now=Date.now()){
  const text=normalize(value).toLowerCase();if(!text)return null;
  const numeric=Number(text);let timestamp;
  if(/^\d{10,13}$/.test(text)&&Number.isFinite(numeric))timestamp=text.length<=10?numeric*1000:numeric;
  else if(/^\d{4}-\d{2}-\d{2}t.*(?:z|[+-]\d{2}:?\d{2})$/i.test(text))timestamp=Date.parse(text);
  else if(/^(just now|刚刚|剛剛|vừa xong)$/.test(text))timestamp=now;
  else {
    const relative=text.match(/^(\d+)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|秒钟?|分鐘|分钟|小时|小時|天|giây|phút|giờ|ngày)(?:\s*(ago|前|trước))?$/i);
    if(!relative)return null;
    const unit=relative[2],seconds=/^(s|seconds?|secs?|秒钟?|giây)$/.test(unit)?1:/^(m|minutes?|mins?|分鐘|分钟|phút)$/.test(unit)?60:/^(h|hours?|hrs?|小时|小時|giờ)$/.test(unit)?3600:86400;
    timestamp=now-Number(relative[1])*seconds*1000;
  }
  return Number.isFinite(timestamp)&&timestamp>0&&timestamp<=now+60000?new Date(timestamp).toISOString():null;
}
function proactivePublishedAt(row,now){return [row.time,...(row.times||[])].map(value=>parseFacebookPostTime(value,now)).find(Boolean)||null;}
export function normalizeProactiveResults(rows,group,lookbackHours=24,now=Date.now()){
  const seen=new Set(),cutoff=now-lookbackHours*3600000;
  return rows.flatMap(row=>{
    const link=(row.links||[]).map(x=>String(x.url||'')).find(value=>{try{canonicalGroupPostUrl(value,group.url);return true}catch{return false}});
    if(!link)return [];
    let permalink;try{permalink=canonicalGroupPostUrl(link,group.url)}catch{return []}
    const externalId=new URL(permalink).pathname.match(/\/posts\/(\d+)/)?.[1],body=normalize(row.body),publishedAt=proactivePublishedAt(row,now);
    if(!publishedAt||Date.parse(publishedAt)<cutoff||!externalId||!body||seen.has(externalId))return [];
    seen.add(externalId);
    const author=normalize((row.links||[]).find(x=>x.text&&!/\/(posts|permalink)\//.test(String(x.url)))?.text)||'Facebook 用户';
    return [{group_id:group.id,external_id:externalId,permalink,author,body:body.slice(0,4000),published_at:publishedAt}];
  });
}

export async function facebookDocumentText(page){return page.evaluate(() => document.body?.innerText ?? '');}
async function assertSafeFacebookPage(page,groupUrl){const target=new URL(groupUrl),current=new URL(page.url());if(!/^(www\.)?facebook\.com$/.test(current.hostname)||!(/^(www\.)?facebook\.com$/.test(target.hostname))||current.pathname.match(/^\/groups\/([^/]+)/)?.[1]!==target.pathname.match(/^\/groups\/([^/]+)/)?.[1])throw new Error('Facebook 未停留在授权群组，已停止');const body=await facebookDocumentText(page);if(/checkpoint|login challenge|temporarily blocked|suspicious activity|security check|安全验证|可疑活动|暂时封锁|访问受限/i.test(page.url()+' '+body))throw new Error('Facebook checkpoint 或访问限制，已暂停账号自动化');}
function effectiveAction(action,settings){let out=action;if(out.includes('LIKE')&&!settings?.auto_like)out=out==='LIKE_AND_REPLY'?'REPLY_ONLY':'SKIP';if(out.includes('REPLY')&&!settings?.auto_reply)out=out==='LIKE_AND_REPLY'?'LIKE_ONLY':'SKIP';if(out==='SKIP')throw new Error('当前自动开关没有允许的动作');return out;}
async function proactiveReadback(page,action,replyBody,actor){let liked=true,replied=true;if(action.includes('LIKE')){const unlike=page.locator('div[role="article"]').first().getByRole('button',{name:/^(Unlike|取消赞|Bỏ thích)$/i}).first();liked=Boolean(await unlike.count())}if(action.includes('REPLY')){replied=(await radarReplyReadback(page,replyBody,actor)).readback_verified;}return {readback_verified:liked&&replied,liked,replied,author_verified:action.includes('REPLY')?replied:undefined,checked_at:new Date().toISOString(),method:'FRESH_POST_BROWSER_READBACK'};}
function cdpReady(port){return new Promise(resolve=>{const req=request({host:'127.0.0.1',port,path:'/json/version',timeout:500},res=>{res.resume();resolve(res.statusCode===200)});req.on('error',()=>resolve(false));req.on('timeout',()=>{req.destroy();resolve(false)});req.end();});}


async function radarReplyReadback(page,replyBody,actor,parentId=null){
 const verified=await page.locator('div[role="article"]').evaluateAll((nodes,{text,author,parentId})=>nodes.some(node=>{
  const normalize=value=>String(value||'').replace(/\s+/g,' ').trim();
  const authored=[...node.querySelectorAll('a[href]')].some(link=>link.closest('[role="article"]')===node&&normalize(link.innerText||link.textContent)===author);
  const exact=[...node.querySelectorAll('[dir="auto"],p,span')].some(element=>element.closest('[role="article"]')===node&&normalize(element.innerText||element.textContent)===text);
  const parent=!parentId||[...node.querySelectorAll('a[href]')].some(link=>{try{return new URL(link.href).searchParams.get('comment_id')===parentId;}catch{return false;}});
  return authored&&exact&&parent;
 }),{text:normalize(replyBody),author:normalize(actor),parentId});
 return {readback_verified:verified,replied:verified,checked_at:new Date().toISOString(),method:'FRESH_POST_BROWSER_READBACK',author_verified:verified};
}

import { spawn, type ChildProcess } from "node:child_process";
import type { Db } from "./database.ts";
import { ExecutionModel } from "./execution-model.ts";
import { FacebookMcpConnector, assertFacebookReady } from "./facebook-mcp-connector.ts";
import { PublisherStore } from "./publisher-store.ts";
import { XiaohongshuMcpConnector, XiaohongshuToolError } from "./xiaohongshu-mcp-connector.ts";
import { WenyanMcpConnector } from "./wenyan-mcp-connector.ts";
import { WechatChannelsDriver } from "./wechat-channels-driver.ts";
import { now, sha256 } from "./util.ts";
import { syncOutboxToJsonl } from "./jsonl-mirror.ts";
import {parse as parseYaml,stringify as stringifyYaml} from 'yaml';
import {WechatDraftReader,verifyWechatDraft} from './wechat-draft-reader.ts';
import {FacebookVideo,verifiedFacebookVideo} from './facebook-video.ts';
import {ContentLibrary} from './content-library.ts';
import {classifyXhsSubmit} from './xhs-submit-result.ts';
import {dirname,resolve} from 'node:path';
import {FacebookAccounts} from './facebook-accounts.ts';
import {FacebookBusinessBrowser,browserPageConfig} from './facebook-business-browser.ts';
import {colorWechatHeadings,normalizeWechatHeadings,validWechatHeadingColor} from './wechat-heading-structure.ts';

type JobRow = Record<string, unknown> & { job_id: string; batch_id: string; platform: string; state: string; approval_ref: string };
type Snapshot = { canonicalPayload: { title?: string; contentType?: string; payloads?: Record<string, string> }; assets: Record<string, unknown>[] };

export class PlatformWorker {
  private timer?: NodeJS.Timeout;
  private busy = false;
  private stopped = false;
  private xhsProcess?: ChildProcess;
  private xhsEnsurePromise?: Promise<void>;
  private readonly autoReconcileAt = new Map<string,number>();
  private readonly store: PublisherStore;
  private readonly execution: ExecutionModel;
  private readonly facebook = new FacebookMcpConnector();
  private readonly facebookAccounts:FacebookAccounts;
  private readonly xhs = new XiaohongshuMcpConnector();
  private readonly wenyan = new WenyanMcpConnector();
  private readonly channels = new WechatChannelsDriver();

  private readonly db: Db;
  private readonly mirrorPath?: string;
  constructor(db: Db, mirrorPath?: string) {
    this.db = db;
    this.mirrorPath = mirrorPath;
    this.store = new PublisherStore(db);
    this.execution = new ExecutionModel(db);
    this.facebookAccounts=new FacebookAccounts(db);
  }

  start(): void {
    this.stopped = false;
    this.timer = setInterval(() => void this.tick(), 1200);
    void this.tick();
  }

  async inspectWechatChannels(): Promise<unknown> { return this.channels.inspect(); }
  async reconcileWechatChannels(jobId: string): Promise<unknown> {
    const job = this.store.getJob(jobId);
    if (job.platform !== 'wechat_channels' || job.state !== 'RECONCILE_PENDING') throw new Error('此任务不需要视频号结果核对');
    const form = this.store.latestFormSnapshot(jobId);
    if (!form) throw new Error('缺少原始发布表单，不能可靠核对');
    const fields = JSON.parse(String(form.fields_json));
    if (!this.store.acquireProfile(this.channels.profileId, jobId)) throw new Error('视频号浏览器正在被其他任务使用');
    try {
      const result = await this.channels.readback({ expectedTitle: fields.title, expectedDescription: fields.description, beforeCount: fields.beforeCount, allowConclusiveAbsence: true });
      if (result.outcome === 'CONFIRMED_ABSENT') {
        this.db.prepare("UPDATE jobs SET submit_safety_domain='BEFORE_EXTERNAL_SUBMIT' WHERE job_id=?").run(jobId);
        this.store.transition(jobId, 'FAILED', { confirmedNoExternalVideo: true, completeOwnVideoList: true, evidence: result.evidence, automaticRetry: false });
        this.db.prepare("UPDATE attention_requests SET status='RESOLVED',resolved_at=?,resolution=? WHERE job_id=? AND status='OPEN'").run(now(), 'CHANNELS_COMPLETE_LIST_CONFIRMED_ABSENT', jobId);
        return { matched: false, retryable: true, message: '已完整核对视频号作品列表，确认没有这条作品；现在可以安全重试。' };
      }
      if (result.outcome !== 'PUBLISHED_ID_PENDING') return { matched: false, message: '尚未取得匹配作品证据；没有重发。' };
      this.execution.recordReceipt(jobId, String(job.current_attempt_id), { type: 'WECHAT_CHANNELS_RECONCILED_LIST', rawStatus: 'PUBLISHED', evidence: result.evidence });
      this.store.transition(jobId, 'PUBLISHED', { independentReadback: true, evidence: result.evidence, publicLinkUnavailable: true, automaticRetry: false });
      this.db.prepare('UPDATE jobs SET last_verified_at=? WHERE job_id=?').run(now(), jobId);
      this.db.prepare("UPDATE attention_requests SET status='RESOLVED',resolved_at=?,resolution=? WHERE job_id=? AND status='OPEN'").run(now(), 'CHANNELS_LIST_READBACK', jobId);
      this.db.prepare("UPDATE publication_batches SET control_state='RUNNING' WHERE batch_id=? AND control_state='NEEDS_ATTENTION'").run(String(job.batch_id));
      this.updateBatch(String(job.batch_id));
      return { matched: true, message: '已核实视频号作品，任务完成；没有重复发布。' };
    } finally { this.store.releaseProfile(this.channels.profileId, jobId); }
  }
  async reconcileWechatDraft(jobId:string):Promise<unknown> {
    const job=this.store.getJob(jobId);
    if(job.platform!=='wechat_official_account'||job.state!=='RECONCILE_PENDING') throw new Error('此任务当前不需要公众号草稿核对');
    const rejected=this.store.jobHistory(jobId).some(row=>{
      try{return isWechatIpWhitelistRejection(String(JSON.parse(String(row.evidence_json||'{}')).error||''));}catch{return false;}
    });
    if(rejected&&!job.platform_id){
      // 40164 is an explicit WeChat API rejection, not a transport timeout.
      // The draft-add request was denied before an article could be stored.
      this.db.prepare("UPDATE jobs SET submit_safety_domain='BEFORE_EXTERNAL_SUBMIT' WHERE job_id=?").run(jobId);
      this.store.transition(jobId,'FAILED',{error:'公众号 IP 白名单未包含当前网络出口；未写入草稿。修复白名单后在原任务重试。',confirmedNoExternalDraft:true,wechatRejection:'IP_NOT_WHITELISTED',automaticRetry:false});
      this.db.prepare("UPDATE attention_requests SET status='RESOLVED',resolved_at=?,resolution=? WHERE job_id=? AND status='OPEN'").run(now(),'WECHAT_IP_WHITELIST_REJECTED',jobId);
      return {matched:false,retryable:true,requiresWhitelist:true,message:'微信明确拒绝了该次请求，未写入草稿；请先修复公众号 IP 白名单，再在原任务中重试。'};
    }
    const snapshot=this.loadSnapshot(String(job.batch_id));
    const sourceMarkdown=snapshot.canonicalPayload.payloads?.wechat_official_account;
    if(!sourceMarkdown)throw new Error('任务缺少公众号原稿');
    const markdown=prepareWechatDraftMarkdown(sourceMarkdown,String(snapshot.canonicalPayload.title||''),snapshot.assets);
    const reader=new WechatDraftReader(), matches:string[]=[];
    let complete=false;
    for(let offset=0;offset<200;offset+=20){
      const page=await reader.list(offset);
      for(const item of page.item||[]) if(verifyWechatDraft(markdown,item.content)) matches.push(String(item.media_id));
      if(offset+Number(page.item_count??page.item?.length??0)>=Number(page.total_count)){complete=true;break;}
    }
    if(complete&&matches.length===0&&this.store.jobHistory(jobId).some(row=>String(row.evidence_json).includes('未能找到文章标题'))){
      // Wenyan raises this deterministic local parsing error before invoking the
      // WeChat Draft API. A complete draft-list readback with no exact match
      // therefore proves that this attempt had no external submit side effect.
      this.db.prepare("UPDATE jobs SET submit_safety_domain='BEFORE_EXTERNAL_SUBMIT' WHERE job_id=?").run(jobId);
      this.store.transition(jobId,'FAILED',{error:'公众号原稿缺少结构化标题；现已自动补齐，可安全重试',confirmedNoExternalSubmit:true,completeDraftListReadback:true});
      return {matched:false,retryable:true,message:'已确认旧任务没有写入微信草稿箱；标题格式已修复，现在可安全点击“重试此平台”。'};
    }
    if(!complete||matches.length!==1)return {matched:false,message:'未取得唯一、完整的草稿证据；仍待核对，不会重新上传。'};
    const mediaId=matches[0], draft=await reader.get(mediaId);
    if(!verifyWechatDraft(markdown,draft))throw new Error('草稿详情发生变化，保留待核对');
    this.execution.recordReceipt(jobId,String(job.current_attempt_id),{type:'WECHAT_EXISTING_DRAFT_READBACK',platformPostId:mediaId,rawStatus:'DRAFT_API_WRITTEN_NOT_PUBLISHED',evidence:{existingDraft:true,titleAuthorCoverBodyVerified:true}});
    this.store.recordPlatformResult(jobId,mediaId,'');
    this.store.transition(jobId,'DRAFT_API_WRITTEN_NOT_PUBLISHED',{existingDraft:true,independentReadback:true,formalPublication:false});
    this.db.prepare('UPDATE jobs SET last_verified_at=? WHERE job_id=?').run(now(),jobId);
    this.db.prepare("UPDATE attention_requests SET status='RESOLVED',resolved_at=?,resolution=? WHERE job_id=? AND status='OPEN'").run(now(),'EXACT_WECHAT_DRAFT_READBACK',jobId);
    return {matched:true,message:'已核实同一篇文章在草稿箱，任务完成；未重复上传。'};
  }
  async deleteWechatDraft(jobId:string):Promise<unknown>{
    const job=this.store.getJob(jobId);
    if(job.platform!=='wechat_official_account'||job.state!=='DRAFT_API_WRITTEN_NOT_PUBLISHED'||!job.platform_id)throw new Error('这条记录当前不是可删除的公众号草稿');
    let alreadyAbsent=false;
    const reader=new WechatDraftReader(),mediaId=String(job.platform_id);
    let before:Record<string,unknown>|undefined;
    try{before=await reader.get(mediaId);}catch(error){if(/40007/.test(String(error)))alreadyAbsent=true;else throw error;}
    if(!alreadyAbsent){
      if(!Array.isArray(before?.news_item)||before.news_item.length!==1)throw new Error('草稿结构与记录不一致，已停止删除');
      try{await reader.delete(mediaId);}catch(error){
        if(!/40007/.test(String(error)))throw error;
        alreadyAbsent=true;
      }
    }
    let found=false,complete=false;
    for(let offset=0;offset<500;offset+=20){
      const page=await reader.list(offset);
      if((page.item||[]).some((item:Record<string,unknown>)=>String(item.media_id)===mediaId)){found=true;break;}
      if(offset+Number(page.item_count??page.item?.length??0)>=Number(page.total_count)){complete=true;break;}
    }
    if(found||!complete)throw new Error('删除请求已发送，但未能完成草稿箱回读；请人工核对，暂不更改本地状态');
    this.execution.recordReceipt(jobId,String(job.current_attempt_id),{type:'WECHAT_DRAFT_DELETED',platformPostId:mediaId,rawStatus:'PLATFORM_DELETED',evidence:{completeDraftListReadback:true,formalPublication:false,alreadyAbsent}});
    this.store.transition(jobId,'PLATFORM_DELETED',{userRequested:true,completeDraftListReadback:true,formalPublication:false,alreadyAbsent});
    return {deleted:true,articleId:job.article_id,message:'已从公众号草稿箱删除并回读确认，本地状态已改为未发布。'};
  }
  async ensureXiaohongshuReady(): Promise<unknown> {
    await this.ensureXhs();
    const login=await this.xhs.loginStatus().catch(async(error)=>{
      if(error instanceof XiaohongshuToolError)throw error;
      // A restarted local service invalidates the previous MCP session. Only retry this read.
      await this.xhs.close();
      await this.ensureXhs();
      return this.xhs.loginStatus();
    });
    if(!login.loggedIn)return {endpoint:'http://127.0.0.1:18060/mcp',service:'LOGIN_REQUIRED',login};
    if(login.accountId!=='username:Vietbridge 越南商学院')return {endpoint:'http://127.0.0.1:18060/mcp',service:'ACCOUNT_UNVERIFIED',login,reason:'小红书已登录，但尚未确认是 Vietbridge 越南商学院；未提交'};
    try{
      const readback=await this.xhs.readbackHealth();
      return {endpoint:'http://127.0.0.1:18060/mcp',service:readback.ok?'READY':'READBACK_UNAVAILABLE',login,readback};
    }catch(error){
      return {endpoint:'http://127.0.0.1:18060/mcp',service:'READBACK_UNAVAILABLE',login,reason:error instanceof XiaohongshuToolError?error.message:'小红书搜索回读失败；未提交，请检查网络或重新登录'};
    }
  }

  async reconcileXiaohongshu(jobId:string):Promise<unknown> {
    const job=this.store.getJob(jobId);
    if(job.platform!=='xiaohongshu'||!['PUBLISHED_ID_PENDING','RECONCILE_PENDING','JOB_WAITING_HUMAN'].includes(String(job.state))) throw new Error('此任务当前不需要小红书结果核对');
    if(job.state==='JOB_WAITING_HUMAN'){
      if(job.submit_safety_domain!=='MAY_HAVE_SUBMITTED') throw new Error('此任务需要先处理登录或账号问题，不能按发布结果核对');
      this.store.transition(jobId,'RECONCILE_PENDING',{action:'USER_REQUESTED_READ_ONLY_RECHECK',automaticResubmit:false});
    }
    const form=this.store.latestFormSnapshot(jobId);
    const title=form ? String(JSON.parse(String(form.fields_json)).title||'') : '';
    if(!title) throw new Error('历史任务缺少标题，无法自动核对');
    await this.ensureXhs();
    const result=await this.xhs.findPublished({accountId:String(job.account_id),payloadFingerprint:String(job.payload_hash||''),title}).catch(() => {throw new Error('小红书平台记录读取失败或超时；任务仍待核对，未重新发布。请稍后点击核对平台记录。');});
    if(result.status!=='match'||!result.noteId) return {matched:false,message:'暂未取得精确作品证据；保留待核对，不会重新发布。'};
    const url=result.url||`https://www.xiaohongshu.com/discovery/item/${result.noteId}`;
    this.store.recordPlatformResult(jobId,result.noteId,url);
    this.store.transition(jobId,'PUBLISHED',{independentReadback:true,evidence:result.evidence,postId:result.noteId});
    this.db.prepare('UPDATE jobs SET last_verified_at=? WHERE job_id=?').run(now(),jobId);
    this.db.prepare("UPDATE attention_requests SET status='RESOLVED',resolved_at=?,resolution=? WHERE job_id=? AND status='OPEN'").run(now(),'EXACT_PLATFORM_READBACK',jobId);
    if(job.batch_id) this.db.prepare("UPDATE publication_batches SET control_state='COMPLETED',updated_at=? WHERE batch_id=? AND NOT EXISTS(SELECT 1 FROM jobs WHERE batch_id=? AND state<>'PUBLISHED')").run(now(),String(job.batch_id),String(job.batch_id));
    return {matched:true,url,message:'已核实发布成功，链接已回填。'};
  }

  async reconcileFacebook(jobId: string): Promise<unknown> {
    const job = this.store.getJob(jobId);
    if (job.platform !== 'facebook' || job.state !== 'RECONCILE_PENDING') throw new Error('此任务不需要 Facebook 结果核对');
    const form = this.store.latestFormSnapshot(jobId);
    const fields = form ? JSON.parse(String(form.fields_json)) : {};
    if (!fields.caption) throw new Error('缺少原始文案，不能可靠核对');
    const account=this.facebookAccounts.resolveJobIdentity(String(job.account_id));
    if(fields.operation==='facebook_business_browser_photo'){
      const config=browserPageConfig(account);if(!config)throw Error('Facebook 浏览器账号配置已改变，无法安全核对');
      const browser=new FacebookBusinessBrowser(account,config.port,config.browserPageId);
      try{
        await browser.connect();const match=await browser.publishedMatch(String(fields.caption));
        if(!match)return {matched:false,message:'已发表列表尚未找到同正文帖子；任务继续待核对，不会自动重发。'};
        this.execution.recordReceipt(jobId,String(job.current_attempt_id),{type:'FACEBOOK_BROWSER_RECONCILED_READBACK',platformPostId:match.id,platformUrl:match.url,rawStatus:'PUBLISHED',evidence:{page_id:account.page_id,captionMatch:true,publishedList:true}});
        this.store.recordPlatformResult(jobId,match.id,match.url);this.store.transition(jobId,'PUBLISHED',{independentReadback:true,source:'facebook-business-suite',automaticRetry:false});
        this.db.prepare('UPDATE jobs SET published_at=?,last_verified_at=? WHERE job_id=?').run(now(),now(),jobId);
        this.db.prepare("UPDATE attention_requests SET status='RESOLVED',resolved_at=?,resolution=? WHERE job_id=? AND status='OPEN'").run(now(),'FACEBOOK_BROWSER_EXACT_READBACK',jobId);
        return {matched:true,url:match.url,message:'已从 Facebook 已发表列表核实发布成功，没有重复发布。'};
      }finally{await browser.close()}
    }
    if(fields.operation==='facebook_page_video_local'){
      if(String(fields.page)!==account.page_id)throw new Error('任务原 Page 与当前账号映射不一致，已阻止核对');
      const api=new FacebookVideo(undefined,account.config_url,account.page_name);await api.connect(String(fields.page));
      const list=await api.list(),candidates=findFacebookVideoCandidates(list,String(fields.title),String(fields.caption));
      if(candidates.length===0&&facebookVideoAbsenceIsConclusive(list,String(job.submitted_at||job.updated_at))){
        this.db.prepare("UPDATE jobs SET submit_safety_domain='BEFORE_EXTERNAL_SUBMIT' WHERE job_id=?").run(jobId);
        this.store.transition(jobId,'FAILED',{error:'Facebook 完整视频列表确认不存在匹配作品；可安全重试',confirmedNoExternalVideo:true,completeList:true,automaticRetry:false});
        return {matched:false,retryable:true,message:'已完整核对 Facebook 视频列表，确认没有这条作品；现在可以安全重试，不会造成重复发布。'};
      }
      if(candidates.length!==1)return {matched:false,message:candidates.length?'读到多个相同视频，无法自动确认；未重发。':list.paging?.next?'Facebook 视频记录超过本次完整核对范围；仍不重发。':'尚未在 Facebook 视频列表读到匹配作品；未重发。请稍后再次核对。'};
      let video;
      try{video=await api.get(candidates[0]);}
      catch(error){
        if(facebookVideoProcessingReadbackError(error))return {matched:false,message:'匹配视频已在 Page 列表中，但详情仍在处理；未重发。请稍后再次核对。'};
        throw error;
      }
      if(!verifiedFacebookVideo(video,candidates[0],String(fields.page),String(fields.title),String(fields.caption)))return {matched:false,message:'匹配视频仍在处理或内容尚未完整回读；未重发。请稍后再次核对。'};
      const url=String(video.permalink_url);
      this.execution.recordReceipt(jobId,String(job.current_attempt_id),{type:'FACEBOOK_VIDEO_RECONCILED_READBACK',platformPostId:candidates[0],platformUrl:url,rawStatus:'PUBLISHED',evidence:{exactTitle:true,exactDescription:true,ownerVerified:true,processingReady:true}});
      this.store.recordPlatformResult(jobId,candidates[0],url);this.store.transition(jobId,'PUBLISHED',{independentReadback:true,exactTitleDescriptionAndOwner:true,automaticRetry:false});
      this.db.prepare('UPDATE jobs SET published_at=?,last_verified_at=? WHERE job_id=?').run(now(),now(),jobId);
      this.db.prepare("UPDATE attention_requests SET status='RESOLVED',resolved_at=?,resolution=? WHERE job_id=? AND status='OPEN'").run(now(),'FACEBOOK_VIDEO_EXACT_READBACK',jobId);
      return {matched:true,url,message:'已从 Facebook 视频列表核实发布成功，没有重复上传。'};
    }
    await this.facebook.useConfig(account.config_url);
    assertFacebookReady(await this.facebook.call('fb_get_auth_status'));
    const feed = await this.facebook.call('fb_get_page_feed', { limit: 50, since_hours: 168 }) as { posts?: { id: string }[] };
    const ids = job.platform_id ? [String(job.platform_id)] : (feed.posts ?? []).map(p => p.id);
    const matches: Record<string, unknown>[] = [];
    for (const id of ids) {
      const post = await this.facebook.call('fb_get_post_details', { post_id: id }) as Record<string, unknown>;
      const created = Date.parse(String(post.created_time));
      const started = Date.parse(String(job.created_at));
      const owner = (post.from as { id?: string } | undefined)?.id;
      if (String(post.message).trim() === String(fields.caption).trim() && owner === id.split('_')[0] && created >= started - 60_000) matches.push(post);
    }
    if (matches.length !== 1) return { matched: false, message: '尚未读到唯一匹配帖子；未重发。请稍后再次核对。' };
    const post = matches[0], id = String(post.id), url = String(post.permalink_url || `https://www.facebook.com/${id.replace('_', '/posts/')}`);
    this.execution.recordReceipt(jobId, String(job.current_attempt_id), { type: 'FACEBOOK_RECONCILED_READBACK', platformPostId: id, platformUrl: url, rawStatus: 'PUBLISHED', evidence: post });
    this.store.recordPlatformResult(jobId, id, url);
    this.store.transition(jobId, 'PUBLISHED', { independentReadback: true, exactCaptionAndOwner: true, automaticRetry: false });
    this.db.prepare("UPDATE attention_requests SET status='RESOLVED',resolved_at=?,resolution=? WHERE job_id=? AND status='OPEN'").run(now(), 'FACEBOOK_EXACT_READBACK', jobId);
    return { matched: true, url, message: '已核实帖子并完成任务，没有重复发布。' };
  }

  private assertNotStopped(job: JobRow): void {
    const batch = this.db.prepare('SELECT control_state,pause_requested FROM publication_batches WHERE batch_id=?').get(job.batch_id) as Record<string,unknown>;
    if (batch?.pause_requested || batch?.control_state !== 'RUNNING') throw new Error('USER_STOPPED_BEFORE_SUBMIT');
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await Promise.allSettled([this.facebook.close(), this.xhs.close(), this.wenyan.close(), this.channels.close()]);
    if (this.xhsProcess && !this.xhsProcess.killed) this.xhsProcess.kill("SIGTERM");
  }

  async tick(): Promise<void> {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      // PROFILE_LOCKED is a transient scheduling condition, not a terminal
      // publication result. Recover pre-submit jobs as soon as the durable
      // lock is gone (for example after a service restart or a readback job).
      const stranded = this.db.prepare(`SELECT j.job_id,j.batch_id FROM jobs j
        JOIN publication_batches b ON b.batch_id=j.batch_id
        WHERE j.platform='wechat_channels' AND j.state='PROFILE_LOCKED'
        AND j.submit_safety_domain='BEFORE_EXTERNAL_SUBMIT' AND b.pause_requested=0
        AND NOT EXISTS(SELECT 1 FROM profile_locks l WHERE l.profile_id=?)
        ORDER BY j.updated_at LIMIT 1`).get(this.channels.profileId) as {job_id:string;batch_id:string}|undefined;
      if(stranded) {
        this.store.transition(stranded.job_id,'PLATFORM_PREFLIGHT',{action:'PROFILE_LOCK_RELEASED_AUTO_RESUME',liveRequestSent:false});
        this.db.prepare("UPDATE publication_batches SET control_state='RUNNING',updated_at=? WHERE batch_id=? AND control_state='NEEDS_ATTENTION'").run(now(),stranded.batch_id);
      }
      this.db.prepare(`UPDATE publication_batches SET control_state='RUNNING',updated_at=?
        WHERE control_state='NEEDS_ATTENTION' AND pause_requested=0
        AND EXISTS(SELECT 1 FROM jobs j WHERE j.batch_id=publication_batches.batch_id AND j.state='PLATFORM_PREFLIGHT')`).run(now());
      const job = this.db.prepare(`SELECT j.* FROM jobs j JOIN publication_batches b ON b.batch_id=j.batch_id
        WHERE j.state='PLATFORM_PREFLIGHT' AND b.control_state='RUNNING'
        ORDER BY j.created_at,j.platform LIMIT 1`).get() as JobRow | undefined;
      if (job) {
        await this.runJob(job);
        this.updateBatch(job.batch_id);
      } else {
        await this.autoReconcileOne();
        this.updateStrandedBatches();
      }
      if (this.mirrorPath) syncOutboxToJsonl(this.store, this.mirrorPath);
    } finally { this.busy = false; }
  }

  private updateBatch(batchId: string): void {
    const counts = this.db.prepare(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN state='PLATFORM_PREFLIGHT' THEN 1 ELSE 0 END) AS runnable,
      SUM(CASE WHEN state IN ('PUBLISHED','PUBLISHED_ID_PENDING','DRAFT_API_WRITTEN_NOT_PUBLISHED','PLATFORM_DELETED','FAILED_PREFLIGHT','FAILED','BLOCKED_CAPABILITY') THEN 1 ELSE 0 END) AS terminal,
      SUM(CASE WHEN state IN ('UNKNOWN','RECONCILE_PENDING','JOB_WAITING_HUMAN','SESSION_EXPIRED','PROFILE_LOCKED') THEN 1 ELSE 0 END) AS attention
      FROM jobs WHERE batch_id=?`).get(batchId) as { total: number; runnable: number; terminal: number; attention: number };
    if (!counts.total || counts.runnable > 0) return;
    const state = counts.terminal === counts.total ? "COMPLETED" : counts.attention > 0 ? "NEEDS_ATTENTION" : "RUNNING";
    this.db.prepare("UPDATE publication_batches SET control_state=?,updated_at=? WHERE batch_id=? AND control_state='RUNNING'").run(state, now(), batchId);
  }

  private updateStrandedBatches(): void {
    const rows = this.db.prepare("SELECT batch_id FROM publication_batches WHERE control_state='RUNNING'").all() as { batch_id: string }[];
    for (const row of rows) this.updateBatch(row.batch_id);
  }

  private async autoReconcileOne():Promise<void>{
    const job=this.db.prepare(`SELECT j.* FROM jobs j JOIN publication_batches b ON b.batch_id=j.batch_id
      WHERE j.platform='xiaohongshu' AND j.state='RECONCILE_PENDING'
      AND b.control_state IN ('RUNNING','NEEDS_ATTENTION') AND b.pause_requested=0
      ORDER BY j.updated_at LIMIT 1`).get() as JobRow|undefined;
    if(!job)return;
    const last=this.autoReconcileAt.get(job.job_id)??0;
    if(Date.now()-last<60_000)return;
    this.autoReconcileAt.set(job.job_id,Date.now());
    // The Xiaohongshu readback connector opens a visible Chromium window.
    // Background ticks must never steal focus or relaunch the app. Exact
    // platform readback is therefore user-triggered through the reconcile
    // button; this loop only advances the durable timeout state.
    const pendingFor=Date.now()-Date.parse(String(job.updated_at));
    if(pendingFor<30*60_000)return;
    this.store.transition(job.job_id,'JOB_WAITING_HUMAN',{reason:'AUTOMATIC_RECONCILIATION_DEADLINE_EXCEEDED',automaticRetriesWereReadOnly:true,automaticResubmit:false});
    this.db.prepare(`UPDATE attention_requests SET message_code=?,detail_json=? WHERE job_id=? AND status='OPEN'`)
      .run('自动核对超过30分钟仍未取得唯一作品证据；请在小红书作品列表确认，程序没有重复发布',JSON.stringify({automaticResubmit:false}),job.job_id);
    this.updateBatch(job.batch_id);
  }

  private async runJob(job: JobRow): Promise<void> {
    try {
    const snapshot = this.loadSnapshot(job.batch_id);
    if(snapshot.assets.filter(a=>a.mime_detected==='video/mp4').length>1) throw new Error('内容包混有多个视频版本，必须重新匹配单一版本，未提交');
    const payload = snapshot.canonicalPayload.payloads?.[job.platform] ?? "";
    const canonicalTitle = cleanTitle(snapshot.canonicalPayload.title ?? "");
    // Platform-specific public copy is the first authority for the visible title.
    const payloadTitle = cleanTitle(firstLine(payload));
    const title = payloadTitle || canonicalTitle;
    if (!payload.trim() || !title || /^TT-|^Daily-\d+$/i.test(title)) {
      this.store.transition(job.job_id, "FAILED_PREFLIGHT", { reason: "INCOMPLETE_CONTENT_PACKAGE", liveRequestSent: false });
      return;
    }
    const explicitRepublish=hasExplicitRepublishEvidence(this.store.jobHistory(job.job_id));
    const duplicate = this.db.prepare(`SELECT job_id,state FROM jobs WHERE job_id<>? AND article_id=? AND platform=? AND account_id=?
      AND state IN ('PUBLISHED','PUBLISHED_ID_PENDING','DRAFT_API_WRITTEN_NOT_PUBLISHED','SUBMITTED_PENDING_CONFIRMATION','UNKNOWN','RECONCILE_PENDING') LIMIT 1`)
      .get(job.job_id, String(job.article_id), job.platform, String(job.account_id));
    if (!explicitRepublish&&duplicate) {
      this.store.transition(job.job_id, "FAILED_PREFLIGHT", { reason: "DUPLICATE_OR_UNRESOLVED_JOB", existing: duplicate, liveRequestSent: false });
      return;
    }
    if(this.mirrorPath&&!explicitRepublish){
      const ledger=new ContentLibrary({roots:[],ledgerPath:resolve(dirname(this.mirrorPath),'shared-publication-ledger.yaml')}).readPublishedPlatforms();
      if(ledger.get(String(job.article_id))?.includes(job.platform as any)){
        this.store.transition(job.job_id,'FAILED_PREFLIGHT',{reason:'DUPLICATE_OR_UNRESOLVED_JOB',source:'shared_publication_ledger',liveRequestSent:false});return;
      }
    }
      if (job.platform === "facebook") await this.publishFacebook(job, snapshot, payload, title);
      else if (job.platform === "xiaohongshu") await this.publishXiaohongshu(job, snapshot, payload, title);
      else if (job.platform === "wechat_official_account") await this.publishWechatDraft(job, snapshot, payload);
      else await this.publishWechatChannels(job, snapshot, payload, title);
    } catch (error) {
      const current = this.store.getJob(job.job_id);
      if (current.submit_safety_domain === "MAY_HAVE_SUBMITTED") {
        if (current.state === "PUBLICATION_INTENT_COMMITTED" || current.state === "FORM_FILLED") this.store.transition(job.job_id, "SUBMITTED_PENDING_CONFIRMATION", { recoveredAfterError: true });
        if (this.store.getJob(job.job_id).state === "SUBMITTED_PENDING_CONFIRMATION") this.store.transition(job.job_id, "UNKNOWN", { error: safeError(error) });
        if (this.store.getJob(job.job_id).state === "UNKNOWN") this.store.transition(job.job_id, "RECONCILE_PENDING", { automaticRetry: false });
        this.execution.openAttention(job.batch_id, { jobId: job.job_id, attemptId: String(current.current_attempt_id ?? "") || undefined, kind: "RECONCILIATION", messageCode: "平台结果不明确；请核对平台列表，禁止自动重发", detail: { error: safeError(error) } });
        // Leave an uncertain browser submission alive for independent readback.
      } else if (["PLATFORM_PREFLIGHT", "PUBLICATION_INTENT_COMMITTED", "FORM_FILLING", "FORM_FILLED"].includes(String(current.state))) {
        this.store.transition(job.job_id, "FAILED_PREFLIGHT", { error: safeError(error), liveRequestSent: false });
      }
    }
  }

  private async publishFacebook(job: JobRow, snapshot: Snapshot, caption: string, title: string): Promise<void> {
    const account=this.facebookAccounts.resolveJobIdentity(String(job.account_id));
    const images = snapshot.assets.filter(a => String(a.mime_detected).startsWith("image/") && a.role !== 'article_inline').map(a => String(a.staging_path));
    const video = snapshot.assets.find(a => a.mime_detected === "video/mp4");
    const browserConfig=browserPageConfig(account);
    if(browserConfig){
      if(video)throw Error('当前 Facebook 浏览器模式尚未验证视频发布；该任务未提交');
      return this.publishFacebookBrowser(job,snapshot,caption,title,images,account,browserConfig);
    }
    await this.facebook.useConfig(account.config_url);
    if (video) {
      await this.publishFacebookVideo(job,snapshot,String(video.staging_path),caption,title);
      return;
    }
    if (!images.length) throw new Error("Facebook image asset missing");
    const auth = await this.facebook.call("fb_get_auth_status");
    assertFacebookReady(auth);
    // This read-only Graph request proves current network and Page access before
    // publication intent is committed. A cached local auth result is not enough.
    await this.facebook.call("fb_get_page_feed", { limit: 1, since_hours: 1 });
    const tool = images.length > 1 ? "fb_publish_photos" : "fb_publish_photo";
    const args = images.length > 1
      ? { image_urls: images, message: caption, dry_run: true }
      : { image_url: images[0], caption, alt_text: title, dry_run: true };
    const dry = await this.facebook.call(tool, args);
    if (!/dry_run/i.test(JSON.stringify(dry))) throw new Error("Facebook dry run failed");
    const attempt = this.execution.createAttempt(job.job_id, "approved_local_ui", "platform-worker");
    this.store.commitIntent(job.job_id, tool, String(job.payload_hash), snapshot.assets.map(a => String(a.sha256)), job.approval_ref);
    this.store.saveFormSnapshot(job.job_id, { tool, title, caption, images });
    this.assertNotStopped(job);
    this.store.transition(job.job_id, "SUBMITTED_PENDING_CONFIRMATION", { intentCommitted: true, submitCount: 1 });
    this.execution.markSubmitStarted(job.job_id, String(attempt.attempt_id));
    const liveArgs = { ...args, dry_run: false };
    const result = await this.facebook.call(tool, liveArgs);
    const receipt = objectFrom(result);
    const postId = String(receipt.post_id ?? "");
    if (!postId) throw new Error(`Facebook returned no post id: ${JSON.stringify(receipt)}`);
    // Persist acceptance before the independent read can timeout.
    this.execution.recordReceipt(job.job_id, String(attempt.attempt_id), { type: "FACEBOOK_SUBMIT_ACCEPTED", platformPostId: postId, rawStatus: "ACCEPTED", evidence: receipt });
    this.store.recordPlatformResult(job.job_id, postId, `https://www.facebook.com/${postId.replace("_", "/posts/")}`);
    const readback = await this.facebook.call("fb_get_post_details", { post_id: postId });
    if (!JSON.stringify(readback).includes(postId)) throw new Error("Facebook readback did not match returned post id");
    const url = `https://www.facebook.com/${postId.replace("_", "/posts/")}`;
    this.execution.recordReceipt(job.job_id, String(attempt.attempt_id), { type: "FACEBOOK_POST_READBACK", platformPostId: postId, platformUrl: url, rawStatus: "PUBLISHED", evidence: readback });
    this.store.recordPlatformResult(job.job_id, postId, url);
    this.db.prepare("UPDATE jobs SET published_at=?,last_verified_at=? WHERE job_id=?").run(now(), now(), job.job_id);
    this.store.transition(job.job_id, "PUBLISHED", { postId, url, readback: true });
  }

  private async publishFacebookBrowser(job:JobRow,snapshot:Snapshot,caption:string,title:string,images:string[],account:ReturnType<FacebookAccounts['selected']>,config:{port:number;browserPageId:string}):Promise<void>{
    if(!images.length)throw Error('Facebook 图片资源缺失');
    const lockId=`facebook-browser:${config.port}`;
    if(!this.store.acquireProfile(lockId,job.job_id))throw Error('Facebook 浏览器正在执行另一个任务');
    const browser=new FacebookBusinessBrowser(account,config.port,config.browserPageId);
    try{
      await browser.connect();
      const prior=await browser.publishedMatch(caption);
      if(prior)throw Error(`Facebook 已发表列表存在相同正文（${prior.id}），请先核对，未再次发布`);
      const attempt=this.execution.createAttempt(job.job_id,'approved_local_ui','platform-worker');
      this.store.commitIntent(job.job_id,'facebook_business_browser_photo',String(job.payload_hash),snapshot.assets.map(a=>String(a.sha256)),job.approval_ref);
      this.store.transition(job.job_id,'FORM_FILLING',{browser:'facebook-business-suite',profileId:lockId});
      this.store.saveFormSnapshot(job.job_id,{title,caption,images,page_id:account.page_id,browser_page_id:config.browserPageId,visibility:'Public'});
      await browser.fill(caption,images);
      this.store.transition(job.job_id,'FORM_FILLED',{verified:true,captionAndImageCount:true,visibility:'Public'});
      this.assertNotStopped(job);
      this.execution.markSubmitStarted(job.job_id,String(attempt.attempt_id));
      this.store.transition(job.job_id,'SUBMITTED_PENDING_CONFIRMATION',{submitCount:1,browser:'facebook-business-suite'});
      await browser.submit();
      const result=await browser.readback(caption);
      this.execution.recordReceipt(job.job_id,String(attempt.attempt_id),{type:'FACEBOOK_BROWSER_PUBLISHED_READBACK',platformPostId:result.id,platformUrl:result.url,rawStatus:'PUBLISHED',evidence:{page_id:account.page_id,captionMatch:true,publishedList:true}});
      this.store.recordPlatformResult(job.job_id,result.id,result.url);
      this.db.prepare('UPDATE jobs SET published_at=?,last_verified_at=? WHERE job_id=?').run(now(),now(),job.job_id);
      this.store.transition(job.job_id,'PUBLISHED',{postId:result.id,url:result.url,readback:true,source:'facebook-business-suite'});
    }finally{await browser.close();this.store.releaseProfile(lockId,job.job_id)}
  }

  private async publishFacebookVideo(job:JobRow,snapshot:Snapshot,file:string,caption:string,title:string):Promise<void>{
    const account=this.facebookAccounts.resolveJobIdentity(String(job.account_id));
    const api=new FacebookVideo(undefined,account.config_url,account.page_name),page=account.page_id;
    await api.connect(page);
    const list=await api.list();
    if(!Array.isArray(list.data))throw new Error('Facebook 视频列表未完整返回，未提交');
    if(list.data.some((v:Record<string,unknown>)=>v.title===title||v.description===caption))throw new Error('Facebook 已存在同标题或同文案视频；需先核对，不重复发布');
    if(list.paging?.next)throw new Error('Facebook 历史超过当前核对范围，未提交，需完整查重');
    const attempt=this.execution.createAttempt(job.job_id,'approved_local_ui','platform-worker');
    this.store.commitIntent(job.job_id,'facebook_page_video_local',String(job.payload_hash),snapshot.assets.map(a=>String(a.sha256)),job.approval_ref);
    this.store.saveFormSnapshot(job.job_id,{title,caption,file,page,operation:'facebook_page_video_local'});
    this.assertNotStopped(job);
    this.execution.markSubmitStarted(job.job_id,String(attempt.attempt_id));
    this.store.transition(job.job_id,'SUBMITTED_PENDING_CONFIRMATION',{submitCount:1,localVideo:true});
    const result=await api.upload(file,title,caption),id=String(result.id||'');
    if(!/^\d+$/.test(id))throw new Error('Facebook 未返回有效视频 ID，禁止自动重发');
    this.store.recordPlatformResult(job.job_id,id,'');
    this.execution.recordReceipt(job.job_id,String(attempt.attempt_id),{type:'FACEBOOK_VIDEO_ACCEPTED',platformPostId:id,rawStatus:'PROCESSING',evidence:{id}});
    // Processing probes are read-only; failures keep the persisted ID for reconciliation.
    for(let i=0;i<18;i++){
      let readback;
      try{readback=await api.get(id);}
      catch(error){
        // A newly accepted video can be absent from the object endpoint while
        // Meta is processing it. Keep the accepted ID and poll; never upload again.
        if(facebookVideoProcessingReadbackError(error)){await new Promise(resolve=>setTimeout(resolve,10_000));continue;}
        throw error;
      }
      if(verifiedFacebookVideo(readback,id,page,title,caption)){
        this.store.recordPlatformResult(job.job_id,id,String(readback.permalink_url));
        this.execution.recordReceipt(job.job_id,String(attempt.attempt_id),{type:'FACEBOOK_VIDEO_READBACK',platformPostId:id,platformUrl:readback.permalink_url,rawStatus:'PUBLISHED',evidence:readback});
        this.db.prepare('UPDATE jobs SET published_at=?,last_verified_at=? WHERE job_id=?').run(now(),now(),job.job_id);
        this.store.transition(job.job_id,'PUBLISHED',{id,independentReadback:true});return;
      }
      if(readback.status?.video_status==='error')throw new Error('Facebook 视频处理失败，保留视频 ID 待核对');
      await new Promise(resolve=>setTimeout(resolve,10_000));
    }
    throw new Error('Facebook 视频仍在处理，已保留 ID；等待回读，不重新上传');
  }

  private async publishXiaohongshu(job: JobRow, snapshot: Snapshot, text: string, title: string): Promise<void> {
    await this.ensureXhs();
    const login = await this.xhs.loginStatus().catch(async(error)=>{
      if(error instanceof XiaohongshuToolError)throw error;
      // Retry only the read-only login probe on a stale MCP connection.
      await this.xhs.close();await this.ensureXhs();
      return this.xhs.loginStatus();
    });
    const identityError=xiaohongshuIdentityError(login,String(job.account_id));
    if(identityError)throw new Error(identityError);
    // The frozen, approved title must be publishable as-is. Never silently
    // truncate it after approval or mark a connector rejection as submitted.
    if(Array.from(title.trim()).length>20)throw new Error('XHS_TITLE_TOO_LONG');
    const readbackHealth=await this.xhs.readbackHealth();
    if(!readbackHealth.ok)throw new Error('小红书搜索回读当前不可用，可能是网络/VPN异常；已在提交前停止，没有发布');
    const parsed = parseXhs(text);
    const images = snapshot.assets.filter(a => String(a.mime_detected).startsWith("image/") && a.role !== "video_cover" && a.role !== 'article_inline').map(a => String(a.staging_path));
    const video = snapshot.assets.find(a => a.mime_detected === "video/mp4");
    const operation = video ? "publish_with_video" : "publish_content";
    if (!video && !images.length) throw new Error("Xiaohongshu media missing");
    const attempt = this.execution.createAttempt(job.job_id, "approved_local_ui", "platform-worker");
    this.store.commitIntent(job.job_id, operation, String(job.payload_hash), snapshot.assets.map(a => String(a.sha256)), job.approval_ref);
    this.store.transition(job.job_id, "FORM_FILLING", { browser: "xiaohongshu-mcp" });
    this.store.saveFormSnapshot(job.job_id, { title, body: parsed.body, tags: parsed.tags, media: video ? [video.staging_path] : images, visibility: "公开可见", products: [] });
    this.store.transition(job.job_id, "FORM_FILLED", { verified: false, scope: 'connector_input_only', visibleFormNotVerified: true });
    this.assertNotStopped(job);
    this.execution.markSubmitStarted(job.job_id, String(attempt.attempt_id));
    this.store.transition(job.job_id, "SUBMITTED_PENDING_CONFIRMATION", { connectorInvocationCount: 1, actualClickNotObserved: true });
    const result = video
      ? await this.xhs.publishVideo({ title, content: parsed.body, video: String(video.staging_path), tags: parsed.tags, visibility: "公开可见", products: [] })
      : await this.xhs.publishImages({ title, content: parsed.body, images, tags: parsed.tags, visibility: "公开可见", is_original: false, products: [] });
    const id = result.text.match(/(?:PostID|note[_ ]?id|笔记ID)\s*[:：]?\s*([a-zA-Z0-9]+)/i)?.[1];
    const outcome = classifyXhsSubmit(result.text, result.raw);
    this.execution.recordReceipt(job.job_id, String(attempt.attempt_id), { type: "XHS_AUTHORITATIVE_SUCCESS", platformPostId: id, rawStatus: outcome, evidence: { sanitizedText: result.text.slice(0, 500), deliveryCompleted: true } });
    if (id) this.store.recordPlatformResult(job.job_id, id, `https://www.xiaohongshu.com/discovery/item/${id}`);
    this.db.prepare("UPDATE jobs SET published_at=?,last_verified_at=? WHERE job_id=?").run(now(), now(), job.job_id);
    this.store.transition(job.job_id, outcome, { id: id ?? null, authoritativeSuccess: true, deliveryCompleted: true, moderationPending: outcome === 'PUBLISHED_ID_PENDING', automaticRetry: false });
  }

  private async publishWechatDraft(job: JobRow, snapshot: Snapshot, markdown: string): Promise<void> {
    for(const asset of snapshot.assets) if(asset.original_locator) markdown=markdown.split(String(asset.original_locator)).join(String(asset.staging_path));
    markdown=prepareWechatDraftMarkdown(markdown,String(snapshot.canonicalPayload.title||''),snapshot.assets);
    // For a video package this payload is the separately approved companion article;
    // the MP4 itself is never represented as an Official Account publication.
    const themes = await this.wenyan.call("list_themes");
    if (themes.isError) throw new Error("WeChat theme preflight failed");
    // A read-only Draft API call checks token, IP whitelist and draft-list
    // permission before the publication intent or connector submit begins.
    await new WechatDraftReader().list(0);
    const attempt = this.execution.createAttempt(job.job_id, "approved_local_ui", "platform-worker");
    this.store.commitIntent(job.job_id, "publish_article", String(job.payload_hash), snapshot.assets.map(a => String(a.sha256)), job.approval_ref);
    this.store.saveFormSnapshot(job.job_id, { theme: "default", markdownHash: sha256(markdown) });
    this.assertNotStopped(job);
    this.store.transition(job.job_id, "SUBMITTED_PENDING_CONFIRMATION", { submitCount: 1 });
    this.execution.markSubmitStarted(job.job_id, String(attempt.attempt_id));
    const result = await this.wenyan.call("publish_article", { content: markdown, theme_id: "default" });
    const mediaId = result.text.match(/media ID is\s+([^\s.]+)/i)?.[1];
    if (result.isError || !mediaId) throw new Error(`WeChat draft response ambiguous: ${result.text}`);
    // Preserve the returned ID even when independent verification fails.
    this.store.recordPlatformResult(job.job_id,mediaId,'');
    const readback=await new WechatDraftReader().get(mediaId);
    if(!verifyWechatDraft(markdown,readback)) throw new Error('公众号草稿回读不一致，保留草稿ID等待核对，禁止重复上传');
    this.execution.recordReceipt(job.job_id, String(attempt.attempt_id), { type: "WECHAT_DRAFT_READBACK", platformPostId: mediaId, rawStatus: "DRAFT_API_WRITTEN_NOT_PUBLISHED", evidence: { mediaIdPresent: true,titleAuthorCoverBodyVerified:true } });
    this.store.recordPlatformResult(job.job_id, mediaId, "");
    this.db.prepare("UPDATE jobs SET published_at=?,last_verified_at=? WHERE job_id=?").run(now(), now(), job.job_id);
    this.store.transition(job.job_id, "DRAFT_API_WRITTEN_NOT_PUBLISHED", { mediaId, formalPublication: false });
  }

  private async publishWechatChannels(job: JobRow, snapshot: Snapshot, text: string, title: string): Promise<void> {
    const video = snapshot.assets.find(a => a.mime_detected === "video/mp4");
    if (!video) {
      this.store.transition(job.job_id, "BLOCKED_CAPABILITY", { reason: "WECHAT_CHANNELS_REQUIRES_VIDEO", liveRequestSent: false });
      return;
    }
    if (!this.store.acquireProfile(this.channels.profileId, job.job_id)) {
      // Keep the job runnable. A concurrent readback or a prior process may
      // hold the profile briefly; the next serialized tick will try again.
      return;
    }
    try {
      const preflight = await this.channels.preflight();
      this.store.recordProfileHealth(this.channels.profileId, "sph42vLa6y4BW9x", {
        status: preflight.ok ? "READY" : String(preflight.reason),
        chromeVersion: preflight.chromeVersion,
        devtoolsReady: true,
        editorReady: preflight.ok,
        detail: { observedIdentity: preflight.observedIdentity, identityEvidence: preflight.identityEvidence }
      });
      if (!preflight.ok) {
        if (preflight.reason === "LOGIN_REQUIRED") {
          this.store.transition(job.job_id, "SESSION_EXPIRED", { reason: "CHANNELS_LOGIN_REQUIRED", liveRequestSent: false });
          this.store.transition(job.job_id, "JOB_WAITING_HUMAN", { reason: "CHANNELS_LOGIN_REQUIRED", liveRequestSent: false });
          this.execution.openAttention(job.batch_id, { jobId: job.job_id, kind: "LOGIN_REQUIRED", messageCode: "请在已打开的视频号专用窗口扫码登录，然后点“我已登录，继续此平台”", detail: { account: "山石ly的视频号", accountId: "sph42vLa6y4BW9x" } });
          return;
        }
        const accountMismatch = preflight.reason === "ACCOUNT_MISMATCH";
        this.store.transition(job.job_id, "JOB_WAITING_HUMAN", { reason: preflight.reason, observedIdentity: preflight.observedIdentity, liveRequestSent: false });
        this.execution.openAttention(job.batch_id, {
          jobId: job.job_id,
          kind: accountMismatch ? "ACCOUNT_MISMATCH" : "EDITOR_UNAVAILABLE",
          messageCode: accountMismatch
            ? "视频号明确显示为其他账号，请切换到山石ly的视频号"
            : "视频号发布页暂时没有加载完成，请刷新专用窗口后继续",
          detail: { expected: "山石ly的视频号 (sph42vLa6y4BW9x)", observed: preflight.observedIdentity }
        });
        return;
      }

      const description = channelsDescription(text);
      const attempt = this.execution.createAttempt(job.job_id, "approved_local_ui", "platform-worker");
      this.store.commitIntent(job.job_id, "chrome_upload_and_publish_video", String(job.payload_hash), snapshot.assets.map(a => String(a.sha256)), job.approval_ref);
      this.store.transition(job.job_id, "FORM_FILLING", { browser: "managed-playwright", profileId: this.channels.profileId });
      const form = await this.channels.prepare({ videoPath: String(video.staging_path), title, description, beforeCount: preflight.beforeCount },()=>this.assertNotStopped(job));
      this.store.saveFormSnapshot(job.job_id, { ...form, videoPath: video.staging_path, videoSha256: video.sha256, accountId: "sph42vLa6y4BW9x" });
      this.store.transition(job.job_id, "FORM_FILLED", { verified: true, title: form.title, collection: form.collection });
      this.assertNotStopped(job);
      this.execution.markSubmitStarted(job.job_id, String(attempt.attempt_id));
      this.store.transition(job.job_id, "SUBMITTED_PENDING_CONFIRMATION", { submitCount: 1, browser: "managed-playwright" });
      await this.channels.submitOnce();
      const readback = await this.channels.readback({ expectedTitle: form.title, expectedDescription:form.description, beforeCount: form.beforeCount });
      if (readback.outcome === "PUBLISHED_ID_PENDING") {
        this.execution.recordReceipt(job.job_id, String(attempt.attempt_id), { type: "WECHAT_CHANNELS_LIST_READBACK", rawStatus: "PUBLISHED_ID_PENDING", evidence: readback.evidence });
        this.db.prepare("UPDATE jobs SET published_at=?,last_verified_at=? WHERE job_id=?").run(now(), now(), job.job_id);
        this.store.transition(job.job_id, "PUBLISHED", { accountId: "sph42vLa6y4BW9x", evidence: readback.evidence, publicLinkUnavailable:true, automaticRetry: false });
      } else {
        this.store.transition(job.job_id, "UNKNOWN", { evidence: readback.evidence, automaticRetry: false });
        this.store.transition(job.job_id, "RECONCILE_PENDING", { evidence: readback.evidence, automaticRetry: false });
        this.execution.openAttention(job.batch_id, { jobId: job.job_id, attemptId: String(attempt.attempt_id), kind: "RECONCILIATION", messageCode: "视频号已点击发表但列表回读不明确；请核对，禁止自动重发", detail: { evidence: readback.evidence } });
      }
    } finally {
      this.store.releaseProfile(this.channels.profileId, job.job_id);
    }
  }

  private loadSnapshot(batchId: string): Snapshot {
    const row = this.db.prepare(`SELECT cs.canonical_payload_json,cs.snapshot_id FROM publication_batches b
      JOIN content_snapshots cs ON cs.snapshot_id=b.content_snapshot_id WHERE b.batch_id=?`).get(batchId) as { canonical_payload_json: string; snapshot_id: string } | undefined;
    if (!row) throw new Error("content snapshot missing");
    const assets = this.db.prepare("SELECT * FROM content_assets WHERE snapshot_id=? ORDER BY ordinal").all(row.snapshot_id) as Record<string, unknown>[];
    return { canonicalPayload: JSON.parse(row.canonical_payload_json), assets };
  }

  private ensureXhs(): Promise<void> {
    if(this.xhsEnsurePromise)return this.xhsEnsurePromise;
    const pending=this.ensureXhsOnce();
    this.xhsEnsurePromise=pending;
    void pending.finally(()=>{if(this.xhsEnsurePromise===pending)this.xhsEnsurePromise=undefined;}).catch(()=>undefined);
    return pending;
  }

  private async ensureXhsOnce(): Promise<void> {
    try { await this.xhs.availableReadTools(); return; } catch { await this.xhs.close().catch(()=>undefined); }
    let startupError = '';
    this.xhsProcess = spawn("/Users/a1-6/claude/xiaohongshu-mcp/xiaohongshu-mcp-darwin-arm64", ["-headless=false", "-port", ":18060"], {
      cwd: "/Users/a1-6/claude/xiaohongshu-mcp", stdio: ['ignore','ignore','pipe']
    });
    this.xhsProcess.once('error', error => {startupError=error.message;});
    this.xhsProcess.stderr?.on('data', chunk => {startupError=(startupError+String(chunk)).slice(-1500);});
    for (let i = 0; i < 60; i++) {
      await new Promise(resolve => setTimeout(resolve, 500));
      try { await this.xhs.availableReadTools(); return; } catch { /* retry before any submit */ }
      if (this.xhsProcess.exitCode !== null || this.xhsProcess.signalCode) break;
    }
    throw new Error('小红书服务自动启动失败：' + safeError(startupError || this.xhsProcess.signalCode || '30秒内没有响应，请检查本地程序权限'));
  }
}

export function facebookVideoProcessingReadbackError(error:unknown):boolean{
  return /Facebook 接口错误 HTTP 400 code 100 subcode 33/.test(String(error));
}

export function xiaohongshuIdentityError(login:{loggedIn:boolean;accountId?:string},expectedAccountId:string):string|undefined{
  if(!login.loggedIn)return 'XHS_LOGIN_REQUIRED';
  if(!login.accountId)return 'XHS_ACCOUNT_UNVERIFIED';
  if(login.accountId!==expectedAccountId)return 'XHS_ACCOUNT_MISMATCH';
  return undefined;
}

export function isWechatIpWhitelistRejection(message:string):boolean{
  return /(?:^|\D)40164(?:\D|$)/.test(message)&&/invalid\s+ip|not\s+in\s+whitelist/i.test(message);
}

export function prepareWechatDraftMarkdown(markdown:string,fallbackTitle:string,assets:Record<string,unknown>[]):string{
  const front=markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/),body=front?markdown.slice(front[0].length):markdown;
  let metadata:Record<string,unknown>={};
  if(front){
    const parsed=parseYaml(front[1]);
    if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))metadata=parsed as Record<string,unknown>;
  }
  const plainTitle=body.split(/\r?\n/).map(line=>line.trim()).find(Boolean)?.replace(/^#{1,6}\s+/u,'')||'';
  const title=String(metadata.title||fallbackTitle||plainTitle).trim();
  if(!title)throw new Error('公众号文章缺少正式标题，尚未提交');
  const cover=String(metadata.cover||assets.find(asset=>asset.role==='cover')?.staging_path||assets.find(asset=>String(asset.mime_detected||'').startsWith('image/'))?.staging_path||'').trim();
  if(!cover)throw new Error('公众号文章缺少封面，尚未提交');
  const headingColor=validWechatHeadingColor(metadata.heading_color);
  delete metadata.heading_color;
  metadata={...metadata,title,author:String(metadata.author||'驻越经营实录'),cover};
  // Old production documents used these standalone lines as image-placement
  // instructions. They are not public copy. Remove them deterministically;
  // the canonical body assets below are then appended in sequence.
  let assembledBody=body
    .replace(/^\s*【正文高密度信息(?:主图(?:｜[^】]+)?|图)】\s*$/gmu,'')
    .replace(/^\s*【VISUAL_ASSET_MANIFEST[^】]*】\s*$/gimu,'')
    .replace(/^\s*active_assets\s*:[^\r\n]*$/gimu,'')
    .replace(/\n{3,}/g,'\n\n')
    .replace(/^\s+/,'');
  const firstPublicLine=assembledBody.split(/\r?\n/u).find(line=>line.trim())?.trim()??'';
  const firstPublicLineText=firstPublicLine.replace(/^#{1,6}\s+/u,'').replace(/<[^>]*>/gu,'').trim();
  if(firstPublicLineText===title)assembledBody=assembledBody.replace(/^\s*[^\r\n]*(?:\r?\n|$)/u,'').replace(/^\s+/,'');
  const orderedBodyImages=assets.filter(asset=>asset.role==='gallery_image'&&String(asset.mime_detected||'').startsWith('image/'))
    .sort((a,b)=>Number(a.sequence??a.ordinal??0)-Number(b.sequence??b.ordinal??0));
  // Library payloads use portable relative image paths. Resolve those paths
  // against the frozen asset set before the WeChat renderer sees the Markdown,
  // so images stay at their authored position instead of being lost or
  // appended as a detached gallery.
  const bodyImagesByName=new Map<string,string>();
  // An authored inline reference may deliberately reuse the cover bytes in
  // the article body. Resolve against every frozen image, while still only
  // auto-inserting assets explicitly classified as gallery images below.
  // This preserves dual-use GPT/Docs images without duplicating the cover at
  // the end of articles that never referenced it inline.
  for(const asset of assets.filter(asset=>String(asset.mime_detected||'').startsWith('image/'))){
    const filename=String(asset.filename||'').toLowerCase(),staged=String(asset.staging_path||'');
    if(filename&&staged)bodyImagesByName.set(filename,staged);
  }
  assembledBody=assembledBody.replace(/(!\[[^\]]*\]\()<?([^)>\n]+)>?(\))/gu,(match,prefix,source,suffix)=>{
    const cleanSource=String(source).split(/[?#]/u,1)[0].replace(/\\/g,'/');
    const filename=cleanSource.slice(cleanSource.lastIndexOf('/')+1).toLowerCase();
    const staged=bodyImagesByName.get(filename);
    return staged?String(prefix)+'<'+staged+'>'+String(suffix):match;
  });
  const missingBodyImages=orderedBodyImages.filter(asset=>{
    const staged=String(asset.staging_path||''),original=String(asset.original_locator||''),filename=String(asset.filename||'');
    return staged&&!assembledBody.includes(staged)&&(!original||!assembledBody.includes(original))&&(!filename||!assembledBody.includes(filename));
  });
  if(missingBodyImages.length){
    let blocks=assembledBody.split(/\n\s*\n/u).map(block=>block.trim()).filter(Boolean)
      .flatMap(block=>{const lines=block.split(/\n/u).map(line=>line.trim()).filter(Boolean);return lines.length>=5?lines:[block];});
    // Older public copy often has authored paragraphs separated by single
    // newlines only. Restore those boundaries before placing unanchored legacy
    // images; otherwise the preview and WeChat renderer collapse the whole
    // article into one paragraph and can only append every image at the end.
    const insertionSlots=blocks.map((block,index)=>({block,index}))
      .filter(({block})=>!/^#{1,6}\s/u.test(block)&&!/^【[^】]+】$/u.test(block)&&!/^!\[/u.test(block))
      .map(({index})=>index);
    const insertAfter=new Map<number,string[]>();
    missingBodyImages.forEach((asset,index)=>{
      const targetOrdinal=Math.min(insertionSlots.length-1,Math.max(0,Math.floor((index+1)*insertionSlots.length/(missingBodyImages.length+1))-1));
      const target=insertionSlots[targetOrdinal]??blocks.length-1;
      const list=insertAfter.get(target)??[];
      list.push(`![正文图片 ${String(Number(asset.sequence??index+1)).padStart(2,'0')}](<${String(asset.staging_path)}>)`);
      insertAfter.set(target,list);
    });
    blocks=blocks.flatMap((block,index)=>[block,...(insertAfter.get(index)??[])]);
    assembledBody=blocks.join('\n\n');
  }
  return '---\n'+stringifyYaml(metadata,{lineWidth:0}).trimEnd()+'\n---\n\n'+colorWechatHeadings(normalizeWechatHeadings(assembledBody),headingColor);
}

export function hasExplicitRepublishEvidence(history:Record<string,unknown>[]):boolean{
  return history.some(row=>{try{return JSON.parse(String(row.evidence_json||'{}')).republish===true;}catch{return false;}});
}

export function findFacebookVideoCandidates(list:unknown,title:string,description:string):string[]{const data=objectFrom(list).data;return Array.isArray(data)?data.filter((item:Record<string,unknown>)=>item.title===title&&String(item.description||'').trim()===description.trim()).map((item:Record<string,unknown>)=>String(item.id)).filter(id=>/^\d+$/.test(id)):[];}
export function facebookVideoAbsenceIsConclusive(list:unknown,submittedAt:string,at=Date.now()):boolean{
  const value=objectFrom(list),data=value.data;
  return Array.isArray(data)&&!objectFrom(value.paging).next&&Number.isFinite(Date.parse(submittedAt))&&at-Date.parse(submittedAt)>=60*60*1000;
}

function firstLine(text: string): string {
  const lines = text.split(/\r?\n/).map(x => x.trim());
  const declared = lines.find(line => /^(?:title|标题)\s*[:：]\s*\S/iu.test(line));
  if (declared) return declared;
  const heading = lines.find(line => /^#{1,6}\s+\S/u.test(line));
  if (heading) return heading.replace(/^#{1,6}\s+/, "");
  return lines.find(line => line && line !== "---" && !line.startsWith("#")) ?? "";
}
function cleanTitle(value: string): string { return [...value.replace(/^(?:title|标题)\s*[:：]\s*/iu, "").trim()].slice(0, 20).join(""); }
function isPlaceholderTitle(value: string): boolean { return !value || /^(?:TT-\d{8}-[A-Z]+-\d+|Daily-?\d+)$/iu.test(value); }
export function parseXhs(text: string): { body: string; tags: string[] } {
  let document:{body?:unknown;content?:unknown;tags?:unknown}={};
  try { document=parseYaml(text) as typeof document; } catch { /* legacy public files use loose sections */ }
  const yamlBody=typeof document?.body==='string'?document.body:typeof document?.content==='string'?document.content:'';
  if(yamlBody.trim()) {
    const yamlTags=Array.isArray(document?.tags)?document.tags.map(String):[];
    return validateXhsPublicPayload(yamlBody,yamlTags);
  }
  const lines = text.split(/\r?\n/); const tags: string[] = []; const body: string[] = [];
  let section:'header'|'body'|'tags'='header'; let skippedPlainTitle=false;
  for (const line of lines) {
    const trimmed=line.trim();
    if (/^(?:body|content)\s*[:：]\s*$/iu.test(trimmed)) { section='body'; continue; }
    if (/^(?:tags?|话题|独立话题数组)\s*[:：]\s*$/iu.test(trimmed)) { section='tags'; continue; }
    if (/^(?:title|标题)\s*[:：]/iu.test(trimmed)) continue;
    if(section==='header'&&/^(?:visibility|products|is_original|schedule(?:d_at)?)\s*[:：]/iu.test(trimmed))continue;
    if(section==='tags') { if(trimmed) tags.push(trimmed.replace(/^[-*•\s#]+/u,'')); continue; }
    if(section==='header'&&!skippedPlainTitle&&trimmed&&!/^---$/.test(trimmed)) { skippedPlainTitle=true; continue; }
    const hashTags = [...line.matchAll(/#([^#\s]+)/g)].map(match => match[1]);
    if (hashTags.length && line.trim().startsWith("#")) tags.push(...hashTags); else body.push(line);
  }
  return validateXhsPublicPayload(body.join("\n"),tags);
}

function validateXhsPublicPayload(bodyValue:string,tagValues:string[]):{body:string;tags:string[]}{
  const body=bodyValue.trim();
  if(/^(?:body|content|tags?)\s*[:：]/imu.test(body))throw new Error('小红书公开正文含内部字段 body/content/tags，已阻止发布');
  const supplied=tagValues.map(t=>t.replace(/^[-*•\s#]+/u,'').trim()).filter(Boolean);
  const tags=completeXhsTags(body,[...new Set(supplied)]).slice(0,12);
  return {body,tags};
}

export function completeXhsTags(body:string,supplied:string[]):string[]{
  const tags=[...new Set(supplied)];
  const add=(tag:string,pattern:RegExp)=>{if(pattern.test(body)&&!tags.includes(tag))tags.push(tag);};
  add('驻越经营实录',/越南|驻越/u); add('越南经营',/越南.*(?:经营|公司|企业|投资)|(?:经营|公司|企业|投资).*越南/u);
  add('中国企业出海',/中国(?:企业|品牌)|出海/u); add('越南投资',/投资/u); add('越南公司',/公司/u);
  add('越南电商',/电商|直播销售/u); add('跨境电商',/跨境|电商/u); add('越南税务',/税务|纳税|发票/u);
  add('越南用工',/用工|劳动|员工/u); add('越南工厂',/工厂|厂房/u); add('越南财务',/财务|利润|现金|分红/u);
  return tags;
}
function objectFrom(input: unknown): Record<string, unknown> { return input && typeof input === "object" ? input as Record<string, unknown> : {}; }
function safeError(error: unknown): string { return String(error instanceof Error ? error.message : error).replace(/access_token=[^&\s]+/gi, "access_token=[redacted]").slice(0, 1000); }
export function channelsDescription(text: string): string {
  const parsed = parseXhs(text);
  const body=parsed.body.trim();
  const tags=[...new Set(parsed.tags.map(t=>t.replace(/^#+/u,'').trim()).filter(Boolean))];
  if(!body)throw new Error('视频号缺少完整公开正文，请补齐后重新确认');
  if(!tags.length)throw new Error('视频号文案缺少相关话题，请补齐后重新确认');
  const description=body+'\n\n'+tags.map(t=>'#'+t).join(' ');
  // Conservative application budget, not a claim about the platform maximum.
  if([...description].length>600)throw new Error('视频号文案及话题超过本程序600字预算，请精简并重新确认；未自动截断');
  return description;
}

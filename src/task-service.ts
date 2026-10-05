import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { Db } from "./database.ts";
import { transaction } from "./database.ts";
import { ContentLibrary, canStageWechatDraft, type ContentPackage, type ResolveRequest, type ResolveResult } from "./content-library.ts";
import { ContentSnapshotStore } from "./content-snapshot.ts";
import { PublisherStore } from "./publisher-store.ts";
import { automaticTitle } from "./publication-control.ts";
import { SUPPORTED_PLATFORMS, type SupportedPlatform } from "./platform-contract.ts";
import { canonicalJson, newId, now, sha256 } from "./util.ts";
import { prepareWechatMedia } from './wechat-media.ts';
import { parseXhs, completeXhsTags } from './platform-worker.ts';
import { FacebookAccounts } from './facebook-accounts.ts';

const ACCOUNTS: Record<SupportedPlatform, string> = {
  xiaohongshu: "username:Vietbridge 越南商学院",
  facebook: "VietBridge Group",
  wechat_channels: "sph42vLa6y4BW9x",
  wechat_official_account: "configured-vietbridge-official-account"
};

export type ExecuteTaskInput = ResolveRequest & {
  title?: string;
  platforms?: SupportedPlatform[];
  selectedArticleId?: string;
  selectedPackageRoot?: string;
  selectedVersion?: string;
  republish?: boolean;
  facebookAccountId?: string;
};

export class TaskService {
  readonly library: ContentLibrary;
  private readonly db: Db;
  private readonly snapshots: ContentSnapshotStore;
  private readonly store: PublisherStore;
  readonly facebookAccounts: FacebookAccounts;

  constructor(db: Db, options: { roots: string[]; ledgerPath?: string; stagingRoot: string }) {
    this.db = db;
    this.library = new ContentLibrary({ roots: options.roots, ledgerPath: options.ledgerPath });
    this.snapshots = new ContentSnapshotStore(db, options.stagingRoot);
    this.store = new PublisherStore(db);
    this.facebookAccounts = new FacebookAccounts(db);
  }

  preview(input: ResolveRequest): ResolveResult {
    const platforms=input.platforms?.length?input.platforms:[...SUPPORTED_PLATFORMS];
    if(input.mode==='ledger'){
      for(const candidate of this.library.index()){
        const result=this.withSqliteStatus({status:'MATCHED',package:candidate,disabledPlatforms:[]},platforms);
        if(result.status==='MATCHED'&&platforms.some(p=>!result.package.publishedPlatforms.includes(p)&&!result.package.draftPlatforms?.includes(p)&&Boolean(result.package.payloads[p])&&(p!=='wechat_channels'||result.package.assets.some(a=>a.role==='video'))))return result;
      }
      return {status:'NEEDS_SUPPLEMENT',reason:'当前所选平台没有剩余的可匹配内容；已排除已发布及结果待核对的内容。'};
    }
    return this.withSqliteStatus(this.library.resolve(input),platforms);
  }

  candidates(platforms: SupportedPlatform[] = [...SUPPORTED_PLATFORMS], includePublished = false, includeIncomplete = false): ResolveResult {
    const selected=normalizePlatforms(platforms.length?platforms:[...SUPPORTED_PLATFORMS]);
    const result=this.withSqliteStatus({status:'CANDIDATES',candidates:this.library.index(),reason:'选择内容，创建后逐篇确认；不会立即发布'},selected);
    if(result.status==='CANDIDATES'&&!includeIncomplete)result.candidates=result.candidates.filter(p=>selected.some(x=>isPublishableCandidate(p,x,includePublished)));
    return result;
  }

  execute(input: ExecuteTaskInput, indexedPackages?: ContentPackage[]): Record<string, unknown> {
    if(!Array.isArray(input.platforms)||input.platforms.length===0)throw new Error("请明确选择至少一个发布平台；未创建任务");
    const platforms = normalizePlatforms(input.platforms);
    const facebookAccount=platforms.includes('facebook')?(input.facebookAccountId?this.facebookAccounts.get(input.facebookAccountId):this.facebookAccounts.selected()):undefined;
    const accountFor=(platform:SupportedPlatform)=>platform==='facebook'&&facebookAccount?this.facebookAccounts.jobIdentity(facebookAccount):ACCOUNTS[platform];
    if (!platforms.length) throw new Error("至少选择一个平台");
    const request: ResolveRequest = input.selectedArticleId
      ? { mode: "article_id", value: input.selectedArticleId, platforms }
      : { mode: input.mode, value: input.value, platforms };
    const selectedPackage = input.selectedArticleId && input.selectedPackageRoot
      ? (indexedPackages ?? this.library.index()).find(item => item.articleId === input.selectedArticleId && item.packageRoot === input.selectedPackageRoot && item.version === input.selectedVersion)
      : undefined;
    if(input.selectedPackageRoot&&!selectedPackage)throw new Error('所选内容版本已变化，请刷新候选列表重新选择');
    const rawResult: ResolveResult = selectedPackage
      ? { status: "MATCHED", package: selectedPackage, disabledPlatforms: platforms.filter(platform => selectedPackage.publishedPlatforms.includes(platform)) }
      : this.preview(request);
    const result = this.withSqliteStatus(rawResult, platforms);
    if (result.status !== "MATCHED") return { resolution: result };
    if(result.package.readiness!=='READY'&&!(platforms.length===1&&platforms[0]==='wechat_official_account'&&canStageWechatDraft(result.package)))return {resolution:result,error:'内容包未通过消费校验：'+result.package.blockingReasons.join('、')+'；未创建发布任务'};
    const selected = platforms.filter(platform => input.republish || (!result.package.draftPlatforms?.includes(platform) && !result.package.publishedPlatforms.includes(platform)));
    if (!selected.length) return { resolution: result, error: "所选平台已有发布记录或公众号草稿；请在原任务处理，未创建重复任务" };
    if (!input.republish && selected.includes('wechat_official_account')) {
      const latestWechat = this.db.prepare(`SELECT state FROM jobs WHERE article_id=? AND platform='wechat_official_account' AND account_id=?
        AND state IN ('DRAFT_API_WRITTEN_NOT_PUBLISHED','PLATFORM_DELETED') ORDER BY updated_at DESC,created_at DESC LIMIT 1`)
        .get(result.package.articleId, accountFor('wechat_official_account')) as {state:string}|undefined;
      if (latestWechat?.state==='DRAFT_API_WRITTEN_NOT_PUBLISHED')
        return {resolution:result,error:'公众号已有回读成功的草稿。请使用原草稿，或确认已手工删除后再创建；其他平台请取消公众号后单独创建。未创建任务。'};
    }
    const canonicalPayload = {
      articleId: result.package.articleId,
      version: result.package.version,
      title: result.package.title,
      contentType: result.package.contentType,
      payloads: Object.fromEntries(Object.entries(result.package.payloads).map(([platform, path]) => [platform, readFileSync(path, "utf8")])),
      payloadSources: Object.fromEntries(Object.keys(result.package.payloads).map(platform=>[platform,'library_platform_file'])) as Record<string,string>
    };
    supplementShortFormPayloads(canonicalPayload,result.package.title,selected);
    const missing = selected.filter(platform => !canonicalPayload.payloads[platform]?.trim());
    if (missing.length) return {resolution: result, error: '内容包缺少以下平台的文案：' + missing.join('、') + '。请补齐文案或取消这些平台，尚未创建发布任务。'};
    if (result.package.assets.filter(a=>a.role==='video').length>1) return {resolution:result,error:'内容包包含多个视频版本，请明确选择单一版本后再发布。尚未创建发布任务。'};
    const assets=[...result.package.assets];
    if(selected.includes('wechat_official_account')) {
      const prepared=prepareWechatMedia(canonicalPayload.payloads.wechat_official_account!,result.package.payloads.wechat_official_account!,result.package.packageRoot);
      canonicalPayload.payloads.wechat_official_account=prepared.markdown;
      for(const path of prepared.paths) if(!assets.some(a=>a.path===path)) {const data=readFileSync(path),hash=sha256(data);assets.push({assetId:sha256(result.package.articleId+'\0'+basename(path).toLowerCase()),contentId:result.package.articleId,path,filename:basename(path),sourcePath:path,sourceModifiedTime:0,sizeBytes:data.length,sha256:hash,revision:hash,qaState:'UNKNOWN',role:'article_inline',ordinal:assets.length+1,sequence:assets.length+1});}
    }
    if (selected.includes('wechat_channels') && !result.package.assets.some(asset => asset.role === 'video')) return {resolution: result, error:'视频号需要视频素材。当前是图文包，请选择视频内容或取消视频号，尚未创建发布任务。'};
    if (!canonicalPayload.title.trim() || /^(TT-\d{8}-[A-Z]+-\d+|Daily-\d+)$/i.test(canonicalPayload.title)) return {resolution: result,error:'内容包缺少正式标题，请补齐后执行，尚未创建发布任务。'};
    const snapshot = this.snapshots.create({
      articleId: result.package.articleId,
      contentVersion: result.package.version,
      canonicalPayload,
      sourceKind: input.mode,
      sourceLocator: input.value,
      sourceRevision: result.package.version,
      assets
    });
    const batchId = newId();
    if(input.republish){
      const pending=this.db.prepare(`SELECT j.platform,b.batch_id FROM jobs j JOIN publication_batches b ON b.batch_id=j.batch_id
        WHERE j.article_id=? AND j.platform IN (${selected.map(()=>'?').join(',')})
        AND j.state='READY_FOR_USER_APPROVAL' AND b.control_state='AWAITING_APPROVAL'`).all(result.package.articleId,...selected) as {platform:string;batch_id:string}[];
      if(pending.length)throw new Error('已有待确认的重复发布任务，请先处理原任务；未再次创建：'+pending.map(row=>row.platform).join('、'));
      const ambiguous=this.db.prepare(`SELECT platform,state FROM jobs WHERE article_id=? AND platform IN (${selected.map(()=>'?').join(',')})
        AND state IN ('SUBMITTED_PENDING_CONFIRMATION','UNKNOWN','RECONCILE_PENDING')`).all(result.package.articleId,...selected) as {platform:string;state:string}[];
      if(ambiguous.length)throw new Error('以下平台仍有提交结果待核对，不能重新发布：'+ambiguous.map(row=>row.platform).join('、'));
    }
    const existing=selected.map(platform=>this.db.prepare('SELECT * FROM jobs WHERE article_id=? AND platform=? AND account_id=? AND package_hash=?').get(result.package.articleId,platform,accountFor(platform),String(snapshot.manifest_hash)) as Record<string,unknown>|undefined).filter((j):j is Record<string,unknown>=>Boolean(j));
    if(existing.length&&!input.republish){
      if(new Set(existing.map(j=>j.batch_id)).size!==1)throw new Error('所选平台分散在多个历史任务中，请分别处理原任务；未创建重复任务');
      const originalId=String(existing[0].batch_id),original=this.rawBatch(originalId);
      if(existing.some(j=>j.submit_safety_domain==='MAY_HAVE_SUBMITTED'))throw new Error('原任务可能已提交，必须先核对平台记录，不能重新创建');
      const missing=selected.filter(platform=>!existing.some(job=>job.platform===platform));
      if(original.content_snapshot_id!==snapshot.snapshot_id)throw new Error('原任务与当前内容版本不一致，请先处理旧任务；未混合两个版本');
      if(original.control_state==='RUNNING')throw new Error('原任务正在运行，请在当前任务中处理；未追加新平台');
      if(original.control_state==='AWAITING_APPROVAL'&&!missing.length)return this.getBatch(originalId);
      if(existing.some(j=>!['FAILED_PREFLIGHT','FAILED','BLOCKED_CAPABILITY','READY_FOR_USER_APPROVAL'].includes(String(j.state))))throw new Error('原任务需要登录或结果核对，请处理原任务，未重复创建');
      transaction(this.db,()=>{
        for(const job of existing){
          if(this.store.jobHistory(String(job.job_id)).some(h=>String(h.evidence_json).includes('VISUAL_LAYOUT_FAIL')))throw new Error('原素材未通过验收，请先修复');
          if(job.state!=='READY_FOR_USER_APPROVAL')transitionUnsafe(this.db,String(job.job_id),String(job.state),'READY_FOR_USER_APPROVAL',{action:'REUSE_FAILED_TASK',newSubmission:false});
        }
        this.db.prepare("UPDATE publication_batches SET control_state='AWAITING_APPROVAL',platforms_json=?,default_all_platforms=?,pause_requested=0,pause_requested_at=NULL,terminated_at=NULL,updated_at=? WHERE batch_id=?")
          .run(canonicalJson(selected),platforms.length===SUPPORTED_PLATFORMS.length?1:0,now(),originalId);
      });
      for(const platform of missing){
        const allPayloads=canonicalPayload.payloads as Record<string,string>;
        const payload=allPayloads[platform]??(platform==='wechat_channels'?allPayloads.xiaohongshu:undefined)??'';
        const jobId=this.store.createJob({articleId:result.package.articleId,platform,accountId:accountFor(platform),packageHash:String(snapshot.manifest_hash)});
        this.db.prepare('UPDATE jobs SET batch_id=?,rendition_type=?,payload_hash=? WHERE job_id=?').run(originalId,result.package.contentType,sha256(payload),jobId);
        this.store.transition(jobId,'FACT_CHECK',{source:'content_snapshot',snapshotId:snapshot.snapshot_id,addedToExistingBatch:true});
        this.store.transition(jobId,'EDITORIAL_REVIEW',{deterministicPackageMatch:true});
        this.store.transition(jobId,'READY_FOR_USER_APPROVAL',{exactPayloadRequired:true});
      }
      return this.getBatch(originalId);
    }
    const time = now();
    const title = input.title?.trim() || (input.republish?'重新发布 · ':'')+automaticTitle(input.mode === "article_id" ? "search" : input.mode, result.package.title, new Date(time));
    transaction(this.db, () => this.db.prepare(`INSERT INTO publication_batches
      (batch_id,title,source_mode,source_value,platforms_json,default_all_platforms,control_state,pause_requested,content_snapshot_id,created_at,updated_at)
      VALUES(?,?,?,?,?,?, 'AWAITING_APPROVAL',0,?,?,?)`).run(batchId, title, input.mode, input.value ?? null,
        canonicalJson(selected), platforms.length === SUPPORTED_PLATFORMS.length ? 1 : 0, String(snapshot.snapshot_id), time, time));
    for (const platform of selected) {
      const allPayloads = canonicalPayload.payloads as Record<string, string>;
      const payload = allPayloads[platform]
        ?? (platform === "wechat_channels" ? allPayloads.xiaohongshu : undefined)
        ?? (platform === "wechat_official_account" ? allPayloads.wechat_official_account : undefined)
        ?? "";
      const jobId = this.store.createJob({
        articleId: result.package.articleId,
        platform,
        accountId: accountFor(platform),
        packageHash: input.republish ? sha256(String(snapshot.manifest_hash)+'\0REPUBLISH\0'+batchId) : String(snapshot.manifest_hash)
      });
      this.db.prepare(`UPDATE jobs SET batch_id=?,rendition_type=?,payload_hash=? WHERE job_id=?`)
        .run(batchId, result.package.contentType, sha256(payload), jobId);
      this.store.transition(jobId, "FACT_CHECK", { source: "content_snapshot", snapshotId: snapshot.snapshot_id, republish: Boolean(input.republish) });
      this.store.transition(jobId, "EDITORIAL_REVIEW", { deterministicPackageMatch: true });
      this.store.transition(jobId, "READY_FOR_USER_APPROVAL", { exactPayloadRequired: true });
    }
    return this.getBatch(batchId);
  }

  approve(batchId: string): Record<string, unknown> {
    return transaction(this.db, () => {
      const batch = this.rawBatch(batchId);
      if (batch.control_state !== "AWAITING_APPROVAL") throw new Error("任务当前不等待确认");
      const jobs = this.db.prepare("SELECT * FROM jobs WHERE batch_id=?").all(batchId) as Record<string, unknown>[];
      const approvable=jobs.filter(job=>job.state==='READY_FOR_USER_APPROVAL');
      if(!approvable.length)throw new Error('当前没有等待确认的平台；待核对平台不会被重复提交');
      const time = now();
      for (const job of approvable) {
        const scope = sha256(canonicalJson({ jobId: job.job_id, packageHash: job.package_hash, platform: job.platform, account: job.account_id, payloadHash: job.payload_hash }));
        const approvalId = newId();
        this.db.prepare(`INSERT INTO approval_records
          (approval_id,approval_scope_hash,platform,account_id,visibility,payload_hash,approved_by,approved_at)
          VALUES(?,?,?,?,?,?,?,?)`).run(approvalId, scope, String(job.platform), String(job.account_id), "configured-default", String(job.payload_hash), "local-user", time);
        this.db.prepare("UPDATE jobs SET approval_ref=?,approval_scope_hash=? WHERE job_id=?").run(approvalId, scope, String(job.job_id));
        transitionUnsafe(this.db, String(job.job_id), "READY_FOR_USER_APPROVAL", "USER_APPROVED", { approvalId, scope });
        transitionUnsafe(this.db, String(job.job_id), "USER_APPROVED", "PLATFORM_PREFLIGHT", { queuedBy: "local-ui" });
      }
      this.db.prepare("UPDATE publication_batches SET control_state='RUNNING',updated_at=? WHERE batch_id=?").run(time, batchId);
      return this.getBatch(batchId);
    });
  }

  pauseOrTerminate(batchId: string): Record<string, unknown> {
    const batch = this.rawBatch(batchId);
    const time = now();
    if (batch.control_state === "PAUSED" || batch.control_state === "PAUSE_REQUESTED") {
      // Terminating stops local automation only. It must not erase or reinterpret
      // a platform job whose submit result is still unknown.
      this.db.prepare("UPDATE publication_batches SET control_state='TERMINATED',terminated_at=?,updated_at=? WHERE batch_id=?").run(time, time, batchId);
    } else if (["RUNNING", "AWAITING_APPROVAL"].includes(String(batch.control_state))) {
      this.db.prepare("UPDATE publication_batches SET control_state='PAUSED',pause_requested=1,pause_requested_at=?,updated_at=? WHERE batch_id=?").run(time, time, batchId);
    } else throw new Error("当前状态不能暂停或终止");
    return this.getBatch(batchId);
  }

  resume(batchId: string): Record<string, unknown> {
    const batch = this.rawBatch(batchId);
    if (!['PAUSED','TERMINATED'].includes(String(batch.control_state))) throw new Error("只有暂停或终止的任务可以继续；失败任务请点击重试此平台");
    return transaction(this.db,()=>{
    const rows=this.db.prepare('SELECT * FROM jobs WHERE batch_id=?').all(batchId) as Record<string,unknown>[];
    const safe=rows.filter(j=>j.submit_safety_domain==='BEFORE_EXTERNAL_SUBMIT'&&['FAILED_PREFLIGHT','FAILED','BLOCKED_CAPABILITY','PLATFORM_PREFLIGHT','READY_FOR_USER_APPROVAL'].includes(String(j.state))&&!this.store.jobHistory(String(j.job_id)).some(h=>String(h.evidence_json).includes('DUPLICATE_OR_UNRESOLVED_JOB')));
    if(!safe.length)throw new Error('没有可安全恢复的平台；已提交、待核对或等待登录的任务需先处理对应平台，不能重新发布');
    for(const job of safe){
      if(this.store.jobHistory(String(job.job_id)).some(h=>String(h.evidence_json).includes('VISUAL_LAYOUT_FAIL')))throw new Error('素材未通过验收，不能恢复');
      if(job.state!=='READY_FOR_USER_APPROVAL')transitionUnsafe(this.db,String(job.job_id),String(job.state),'READY_FOR_USER_APPROVAL',{action:'USER_RESUME_REQUIRES_APPROVAL',preservedSnapshot:true});
    }
    const jobs = this.db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE batch_id=? AND state='READY_FOR_USER_APPROVAL'").get(batchId) as { count: number };
    const next = jobs.count ? "AWAITING_APPROVAL" : "RUNNING";
    this.db.prepare("UPDATE publication_batches SET control_state=?,pause_requested=0,pause_requested_at=NULL,terminated_at=NULL,updated_at=? WHERE batch_id=?").run(next, now(), batchId);
    return this.getBatch(batchId);
    });
  }

  retryLoginPreflight(jobId: string): Record<string, unknown> {
    return transaction(this.db, () => {
      const job = this.store.getJob(jobId);
      if (job.state !== "JOB_WAITING_HUMAN") throw new Error("这个平台当前不等待登录");
      if (job.submit_safety_domain === "MAY_HAVE_SUBMITTED") throw new Error("平台可能已经提交，禁止重新发布；请先核对结果");
      const attention = this.db.prepare(`SELECT * FROM attention_requests WHERE job_id=? AND status='OPEN'
        AND kind IN ('LOGIN','LOGIN_REQUIRED','ACCOUNT_MISMATCH','EDITOR_UNAVAILABLE') ORDER BY created_at DESC LIMIT 1`).get(jobId) as Record<string, unknown> | undefined;
      if (!attention) throw new Error("没有可恢复的登录问询");
      this.db.prepare("UPDATE attention_requests SET status='RESOLVED',resolved_at=?,resolution=? WHERE attention_id=?")
        .run(now(), canonicalJson({ action: "LOGIN_COMPLETED_RECHECK", responder: "local-user" }), String(attention.attention_id));
      transitionUnsafe(this.db, jobId, "JOB_WAITING_HUMAN", "PLATFORM_PREFLIGHT", { action: "LOGIN_COMPLETED_RECHECK" });
      this.db.prepare("UPDATE publication_batches SET control_state='RUNNING',updated_at=? WHERE batch_id=?")
        .run(now(), String(job.batch_id));
      return this.getBatch(String(job.batch_id));
    });
  }

  listBatches(batchIds?:string[]): Record<string, unknown>[] {
    if(batchIds?.length===0)return [];
    const scope=batchIds===undefined?undefined:JSON.stringify(batchIds);
    const batches = this.db.prepare(`SELECT * FROM publication_batches ${scope===undefined?'':'WHERE batch_id IN (SELECT value FROM json_each(?))'} ORDER BY created_at DESC`).all(...(scope===undefined?[]:[scope])) as Record<string, unknown>[];
    const jobs = this.batchJobs(batchIds);
    const histories = new Map<string, Record<string, unknown>[]>();
    for (const row of this.db.prepare(`SELECT * FROM state_transitions ${scope===undefined?'':'WHERE job_id IN (SELECT job_id FROM jobs WHERE batch_id IN (SELECT value FROM json_each(?)))'} ORDER BY transition_id`).all(...(scope===undefined?[]:[scope])) as Record<string, unknown>[]) {
      const id = String(row.job_id), history = histories.get(id) ?? [];
      history.push(row); histories.set(id, history);
    }
    const grouped = new Map<string, Record<string, unknown>[]>();
    for (const job of jobs) {
      const id = String(job.batch_id), group = grouped.get(id) ?? [];
      group.push(job); grouped.set(id, group);
    }
    return batches.map(batch => this.describeBatch(batch, grouped.get(String(batch.batch_id)) ?? [], histories));
  }

  clearHistory(): {hidden:number} {
    const r=this.db.prepare("INSERT OR IGNORE INTO hidden_history(job_id,hidden_at) SELECT j.job_id,? FROM jobs j LEFT JOIN publication_batches b ON b.batch_id=j.batch_id WHERE j.state IN ('PUBLISHED','DRAFT_API_WRITTEN_NOT_PUBLISHED') OR b.control_state='TERMINATED'").run(now());
    return {hidden:Number(r.changes)};
  }

  restoreHistory(): void { this.db.prepare('DELETE FROM hidden_history').run(); }

  confirmWechatDraftDeleted(jobId: string): Record<string, unknown> {
    const job=this.store.getJob(jobId);
    if(job.platform!=='wechat_official_account'||job.state!=='DRAFT_API_WRITTEN_NOT_PUBLISHED')throw new Error('这条记录当前不是等待删除确认的公众号草稿');
    this.store.transition(jobId,'PLATFORM_DELETED',{userConfirmedManualDeletion:true,externalAction:true,noNewSubmission:true});
    return this.getBatch(String(job.batch_id));
  }

  retryFailed(jobId: string): Record<string, unknown> {
    const original=this.store.getJob(jobId);
    const explicitlyAuthorizedRepublish=this.store.jobHistory(jobId).some(row=>{try{return JSON.parse(String(row.evidence_json||'{}')).republish===true;}catch{return false;}});
    if(original.platform==='wechat_official_account'&&!explicitlyAuthorizedRepublish&&this.db.prepare("SELECT 1 FROM jobs WHERE article_id=? AND platform='wechat_official_account' AND state='DRAFT_API_WRITTEN_NOT_PUBLISHED' AND job_id<>? LIMIT 1").get(String(original.article_id),jobId))
      throw new Error('这篇文章已有公众号草稿并已回读；请使用原草稿，不要重复上传。');
    if (original.state==='FAILED_PREFLIGHT' && original.submit_safety_domain!=='MAY_HAVE_SUBMITTED' && original.batch_id) {
      const batch=this.rawBatch(String(original.batch_id));
      const row=this.db.prepare('SELECT canonical_payload_json FROM content_snapshots WHERE snapshot_id=?').get(String(batch.content_snapshot_id)) as {canonical_payload_json:string};
      if (!JSON.parse(row.canonical_payload_json).payloads?.[String(original.platform)]?.trim()) {
        const result=this.execute({mode:'article_id',value:String(original.article_id),platforms:[original.platform as SupportedPlatform]});
        if (!result.batch_id) throw new Error(String(result.error || (result.resolution as {reason?:string})?.reason || '无法补齐历史内容包，请从资源库选择正确版本'));
        return {...result,repairedFromJobId:jobId};
      }
    }
    return transaction(this.db, () => {
      const job = this.store.getJob(jobId);
      if (!['FAILED_PREFLIGHT', 'FAILED', 'BLOCKED_CAPABILITY'].includes(String(job.state))) throw new Error('此任务不能直接重试，请先核对平台结果');
      if (job.submit_safety_domain === 'MAY_HAVE_SUBMITTED') throw new Error('上次可能已提交，请先核对作品列表，避免重复发布');
      const history = this.store.jobHistory(jobId);
      if (history.some(row => String(row.evidence_json).includes('VISUAL_LAYOUT_FAIL'))) throw new Error('素材排版未通过验收，请修复素材后重新创建任务');
      const batch = this.rawBatch(String(job.batch_id));
      if (['RUNNING','AWAITING_APPROVAL'].includes(String(batch.control_state))) throw new Error('任务正在执行或等待确认，请勿重复重试');
      const snapshot = this.db.prepare('SELECT canonical_payload_json FROM content_snapshots WHERE snapshot_id=?').get(String(batch.content_snapshot_id)) as {canonical_payload_json: string};
      const payload = JSON.parse(snapshot.canonical_payload_json).payloads?.[String(job.platform)];
      if (!payload?.trim()) throw new Error('历史任务没有完整平台文案，请从资源库重新选择完整内容包');
      if (!job.approval_ref) throw new Error('历史任务缺少发布确认，请重新创建任务');
      transitionUnsafe(this.db, jobId, String(job.state), 'PLATFORM_PREFLIGHT', {action:'USER_RETRY', preservedSnapshot:true});
      this.db.prepare("UPDATE attention_requests SET status='RESOLVED',resolved_at=?,resolution=? WHERE job_id=? AND status='OPEN'").run(now(), 'USER_RETRY', jobId);
      this.db.prepare("UPDATE publication_batches SET control_state='RUNNING',pause_requested=0,pause_requested_at=NULL,terminated_at=NULL,updated_at=? WHERE batch_id=?").run(now(), String(job.batch_id));
      return this.getBatch(String(job.batch_id));
    });
  }

  stopBatch(batchId: string): Record<string, unknown> {
    return transaction(this.db, () => {
      this.rawBatch(batchId);
      this.db.prepare("UPDATE publication_batches SET control_state='TERMINATED',pause_requested=1,terminated_at=?,updated_at=? WHERE batch_id=?").run(now(),now(),batchId);
      return this.getBatch(batchId);
    });
  }

  private batchJobs(batchId?: string|string[]): Record<string, unknown>[] {
    // Select one current attention request; multiple OPEN rows must not duplicate jobs.
    return this.db.prepare(`SELECT j.*, ar.message_code AS attention_code, ar.detail_json AS attention_detail,
      EXISTS(SELECT 1 FROM hidden_history h WHERE h.job_id=j.job_id) AS history_hidden
      FROM jobs j LEFT JOIN attention_requests ar ON ar.attention_id=(
        SELECT a.attention_id FROM attention_requests a WHERE a.job_id=j.job_id AND a.status='OPEN'
        ORDER BY a.created_at DESC, a.attention_id DESC LIMIT 1)
      ${batchId === undefined ? '' : Array.isArray(batchId)?'WHERE j.batch_id IN (SELECT value FROM json_each(?))':'WHERE j.batch_id=?'} ORDER BY j.created_at`).all(...(batchId === undefined ? [] : [Array.isArray(batchId)?JSON.stringify(batchId):batchId])) as Record<string, unknown>[];
  }

  getBatch(batchId: string): Record<string, unknown> {
    return this.describeBatch(this.rawBatch(batchId), this.batchJobs(batchId));
  }

  private describeBatch(batch: Record<string, unknown>, jobs: Record<string, unknown>[], histories?: Map<string, Record<string, unknown>[]>): Record<string, unknown> {
    const detailedJobs = jobs.map(job => {
      const history = histories ? histories.get(String(job.job_id)) ?? [] : this.store.jobHistory(String(job.job_id));
      // Only the latest state transition may explain the current state. Using
      // the last non-empty error from the whole history kept a resolved
      // ACCOUNT_MISMATCH visible after the job had already submitted.
      let latestCause=''; let latestEvidence:Record<string,unknown>={};
      try { latestEvidence=JSON.parse(String(history.at(-1)?.evidence_json||'{}')); latestCause=String(latestEvidence.error||latestEvidence.reason||latestEvidence.code||latestEvidence.wechatRejection||''); } catch { /* malformed historical evidence */ }
      const code = String(latestCause || '').replace(/\u001b\[[0-9;]*m/g,'');
      const duplicateState=String((latestEvidence.existing as Record<string,unknown>|undefined)?.state||'');
      const duplicateReason=job.platform==='wechat_official_account'&&duplicateState==='DRAFT_API_WRITTEN_NOT_PUBLISHED'
        ? '公众号已有草稿并已回读；请使用原草稿，禁止重复上传。'
        : job.platform==='facebook'&&duplicateState==='PUBLISHED'
        ? 'Facebook 已有发布记录；请核对原帖子，禁止重复发布。'
        : job.platform==='xiaohongshu'&&duplicateState==='PUBLISHED_ID_PENDING'
        ? '小红书旧任务可能已成功；请先核对作品列表，禁止再次提交。'
        : '这篇文章在该平台已有任务或结果待核对；请先核对原任务，禁止重复提交。';
      const explanations: Record<string,string> = {
        'Facebook account is not ready':'上次发布前的授权检查失败（历史记录，不代表当前账号不存在）。已修复授权缓存与系统代理读取，可重试未提交任务；结果待核对的任务不可重发。',
        'Facebook 授权未就绪（temporarily-unavailable）：Token 校验遇到网络或 Meta 服务错误；未自动启动 OAuth':'Facebook 发布前的网络或 Meta 授权检查暂时不可用；没有提交，可在网络恢复后安全重试。',
        INCOMPLETE_CONTENT_PACKAGE:'历史内容包缺少平台文案或正式标题，需要重新匹配完整素材包',
        CHANNELS_DESCRIPTION_INPUT_NOT_FOUND:'视频号描述输入框未识别，需重新登录后验证编辑器',
        'Xiaohongshu MCP did not start':'小红书本地服务启动失败；程序签名已修复，可重试',
        VISUAL_LAYOUT_FAIL:'素材存在截断或文字不可读，需要重新制作',
        WECHAT_CHANNELS_REQUIRES_VIDEO:'视频号需要视频文件，当前内容包只有图文',
        DUPLICATE_OR_UNRESOLVED_JOB:duplicateReason,
        FACEBOOK_REEL_REQUIRES_VERIFIED_PUBLIC_HTTPS_URL:'Facebook 视频尚缺可用的视频上传地址',
        IP_NOT_WHITELISTED:'公众号 IP 白名单未包含当前网络出口；微信拒绝了请求，未写入草稿。修复白名单后在原任务重试。',
        '微信接口错误码 40164':'公众号接口拒绝当前网络出口 IP（40164）；未提交文章。请在公众号后台把当前出口 IP 加入开发者白名单，再重试原任务。',
        XHS_LOGIN_REQUIRED:'小红书登录已失效；请在专用浏览器重新登录后，重试原任务。未提交。',
        XHS_ACCOUNT_UNVERIFIED:'小红书页面无法确认当前账号昵称；请先登录并确认是 Vietbridge 越南商学院，未提交。',
        XHS_ACCOUNT_MISMATCH:'小红书当前登录的不是 Vietbridge 越南商学院；请切换正确账号后重试，未提交。',
        XHS_TITLE_TOO_LONG:'小红书标题超过 20 字；请缩短标题并重新确认发布内容。未提交。',
        'Xiaohongshu login/account mismatch':'历史任务的登录或账号核验失败；请重新登录并确认 Vietbridge 越南商学院后重试，未提交。'
      };
      const friendly = /setInputFiles.*Timeout/s.test(code) ? '上传控件响应超时。重试时将核验已上传的视频，匹配后继续填写和发布。'
        : /UNIQUE constraint failed: publication_intents/.test(code) ? '旧版重试记录冲突，已修复，可重试当前平台。'
        : /MCP.*timed out/i.test(code) ? (job.submit_safety_domain==='BEFORE_EXTERNAL_SUBMIT'?'小红书账号资料读取超时，尚未提交；恢复读取后可重试。':'平台响应超时，提交结果待核对。')
        : /fetch failed/i.test(code) ? '网络或 VPN 在提交后中断；程序只会自动回读，不会自动重发。'
        : /locator\./.test(code) ? '平台页面控件未就绪，请查看详情中的具体步骤。' : '';
      const hasProblem=['FAILED_PREFLIGHT','FAILED','BLOCKED_CAPABILITY','RECONCILE_PENDING','UNKNOWN','JOB_WAITING_HUMAN','SESSION_EXPIRED'].includes(String(job.state));
      return {...job, history_hidden:Boolean(job.history_hidden), failure_reason: hasProblem ? (explanations[code] || friendly || code || job.attention_code || '') : '', failure_code:code,
        can_retry:['FAILED_PREFLIGHT','FAILED','BLOCKED_CAPABILITY'].includes(String(job.state)) && job.submit_safety_domain !== 'MAY_HAVE_SUBMITTED' && !['VISUAL_LAYOUT_FAIL','DUPLICATE_OR_UNRESOLVED_JOB'].includes(code),
        can_resume_stopped:job.submit_safety_domain==='BEFORE_EXTERNAL_SUBMIT'&&['FAILED_PREFLIGHT','FAILED','BLOCKED_CAPABILITY','PLATFORM_PREFLIGHT','READY_FOR_USER_APPROVAL'].includes(String(job.state))&&!['VISUAL_LAYOUT_FAIL','DUPLICATE_OR_UNRESOLVED_JOB'].includes(code),
        history: history.map(row=>({state:row.to_state,time:row.created_at,evidence:row.evidence_json}))};
    });
    return { ...batch, platforms: JSON.parse(String(batch.platforms_json)), jobs: detailedJobs };
  }

  private rawBatch(batchId: string): Record<string, unknown> {
    const batch = this.db.prepare("SELECT * FROM publication_batches WHERE batch_id=?").get(batchId) as Record<string, unknown> | undefined;
    if (!batch) throw new Error(`未知任务：${batchId}`);
    return batch;
  }

  private withSqliteStatus(result: ResolveResult, requested: SupportedPlatform[]): ResolveResult {
    const enrich = (item: import("./content-library.ts").ContentPackage) => {
      const rows = this.db.prepare(`SELECT platform,state FROM jobs WHERE article_id=? AND state IN
        ('PUBLISHED','PUBLISHED_ID_PENDING','DRAFT_API_WRITTEN_NOT_PUBLISHED','PLATFORM_DELETED')
        ORDER BY updated_at ASC, created_at ASC`).all(item.articleId) as { platform: SupportedPlatform;state:string }[];
      const platforms=new Set(item.publishedPlatforms);
      const drafts=new Set(item.draftPlatforms||[]);
      for(const row of rows){
        if(row.state==='PUBLISHED'||row.state==='PUBLISHED_ID_PENDING')platforms.add(row.platform);
        else if(row.state==='DRAFT_API_WRITTEN_NOT_PUBLISHED')drafts.add(row.platform);
        else if(row.state==='PLATFORM_DELETED'){
          drafts.delete(row.platform);
          if(row.platform!=='wechat_official_account')platforms.delete(row.platform);
        }
      }
      return { ...item, publishedPlatforms: [...platforms], draftPlatforms:[...drafts] };
    };
    if (result.status === "MATCHED") {
      const item = enrich(result.package);
      return { status: "MATCHED", package: item, disabledPlatforms: requested.filter(platform => item.publishedPlatforms.includes(platform)||item.draftPlatforms.includes(platform)) };
    }
    if (result.status === "CANDIDATES") return { ...result, candidates: result.candidates.map(enrich) };
    return result;
  }
}

function supplementShortFormPayloads(
  canonical:{payloads:Record<string,string>;payloadSources:Record<string,string>},
  title:string,
  selected:SupportedPlatform[]
):void{
  const payloads=canonical.payloads;
  if(selected.includes('xiaohongshu')&&!payloads.xiaohongshu?.trim()&&payloads.facebook?.trim()){
    const parsed=parseSocialText(payloads.facebook);
    const tags=completeXhsTags(parsed.body,parsed.tags);
    payloads.xiaohongshu=`title: ${title}\nbody:\n${parsed.body}\n\ntags:\n${tags.map(tag=>`- ${tag}`).join('\n')}`;
    canonical.payloadSources.xiaohongshu='derived_from_library_facebook_copy';
  }
  if(selected.includes('facebook')&&!payloads.facebook?.trim()&&payloads.xiaohongshu?.trim()){
    const parsed=parseXhs(payloads.xiaohongshu);
    const tags=completeXhsTags(parsed.body,parsed.tags).slice(0,5);
    payloads.facebook=`${title}\n${parsed.body}\n\n${tags.map(tag=>`#${tag}`).join(' ')}`;
    canonical.payloadSources.facebook='derived_from_library_xiaohongshu_copy';
  }
  if(selected.includes('wechat_channels')&&!payloads.wechat_channels?.trim()&&payloads.xiaohongshu?.trim()){
    payloads.wechat_channels=payloads.xiaohongshu;
    canonical.payloadSources.wechat_channels='derived_from_library_xiaohongshu_copy';
  }
}

function isPublishableCandidate(item: import('./content-library.ts').ContentPackage, platform: SupportedPlatform, includePublished=false): boolean {
  if(!includePublished&&item.draftPlatforms?.includes(platform))return false;
  if(!includePublished&&item.publishedPlatforms.includes(platform))return false;
  const hasVideo=item.assets.some(asset=>asset.role==='video');
  if(platform==='wechat_channels')return hasVideo&&Boolean(item.payloads.wechat_channels||item.payloads.xiaohongshu);
  if(platform==='xiaohongshu')return Boolean(item.payloads.xiaohongshu||item.payloads.facebook);
  if(platform==='facebook')return Boolean(item.payloads.facebook||item.payloads.xiaohongshu);
  return Boolean(item.payloads.wechat_official_account);
}

function parseSocialText(text:string):{body:string;tags:string[]}{
  const lines=text.split(/\r?\n/); const tags:string[]=[]; const body:string[]=[];
  let skippedTitle=false;
  for(const line of lines){
    const trimmed=line.trim();
    if(!skippedTitle&&trimmed){skippedTitle=true;continue;}
    const found=[...trimmed.matchAll(/#([^#\s]+)/gu)].map(x=>x[1]);
    if(found.length&&trimmed.startsWith('#'))tags.push(...found);else body.push(line);
  }
  return {body:body.join('\n').trim(),tags:[...new Set(tags)]};
}

function transitionUnsafe(db: Db, jobId: string, from: string, to: string, evidence: unknown): void {
  const time = now();
  const eventId = newId();
  const changed = db.prepare("UPDATE jobs SET state=?,updated_at=? WHERE job_id=? AND state=?").run(to, time, jobId, from);
  if (changed.changes !== 1) throw new Error(`作业状态已经变化，不能从 ${from} 更新到 ${to}`);
  db.prepare(`INSERT INTO state_transitions(job_id,from_state,to_state,event_id,evidence_json,created_at) VALUES(?,?,?,?,?,?)`)
    .run(jobId, from, to, eventId, canonicalJson(evidence), time);
  const payload = canonicalJson({ from, to, evidence, time });
  db.prepare(`INSERT INTO outbox_events(event_id,job_id,event_type,payload_json,payload_hash,created_at) VALUES(?,?,?,?,?,?)`)
    .run(eventId, jobId, "STATE_TRANSITION", payload, sha256(payload), time);
}

function normalizePlatforms(input: SupportedPlatform[]): SupportedPlatform[] {
  return [...new Set(input)].filter(platform => SUPPORTED_PLATFORMS.includes(platform));
}

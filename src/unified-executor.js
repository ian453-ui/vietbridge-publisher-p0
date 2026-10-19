import {matchesRetainedFacebookPublication} from './facebook-preparation-duplicate.js';
import {randomUUID,createHash} from 'node:crypto';
import {operatingDay} from './operating-day.js';
import {realpathSync,statSync,existsSync,mkdirSync,copyFileSync,chmodSync} from 'node:fs';
import {dirname,join,relative,extname} from 'node:path';
import {hashFile} from './publisher-core/file-hash.ts';
import {platformOf,guardedStates,terminalStates,retainsPreparationEffects} from './publisher-platforms.js';
import {assertPendingObservationLease} from './composer-observation.js';
import {SingleExecutionPermits} from './single-execution-permit.js';
import {auditPublisherHistory} from './scoped-operations.js';
import {pendingPublisherProfileRows,provenPristinePreSubmit} from './publisher-profile-pending.js';

const safeError=error=>String(error?.message||error).replace(/EAA[A-Za-z0-9_-]+|Bearer\s+\S+/g,'[REDACTED]').slice(0,800);
const pending=new Set(['PREPARING','SUBMITTING','UNKNOWN']);

export class UnifiedExecutor {
  constructor(publisher,{resources,drivers,enabled=false,pageExecution=null,mediaRoots=[],snapshotRoot,now=()=>Date.now()}={}) {
    this.publisher=publisher;this.db=publisher.db;this.resources=resources;this.drivers=drivers;this.enabled=enabled;this.pageExecution=pageExecution;this.now=now;
    this.mediaRoots=mediaRoots;this.snapshotRoot=snapshotRoot;
    this.active=new Set();
    this.db.exec(`CREATE TABLE IF NOT EXISTS publisher_submit_intents(job_id TEXT PRIMARY KEY REFERENCES publisher_jobs(id),attempt_id TEXT NOT NULL,transport TEXT NOT NULL,snapshot_hash TEXT NOT NULL,prepared_json TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS publisher_submit_receipts(job_id TEXT PRIMARY KEY REFERENCES publisher_jobs(id),platform_id TEXT NOT NULL,platform_url TEXT NOT NULL,evidence_json TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS publisher_job_assets(job_id TEXT NOT NULL REFERENCES publisher_jobs(id),ordinal INTEGER NOT NULL,path TEXT NOT NULL,sha256 TEXT NOT NULL,size INTEGER NOT NULL,PRIMARY KEY(job_id,ordinal));`);
    this.db.exec('CREATE TABLE IF NOT EXISTS publisher_prepare_intents(job_id TEXT PRIMARY KEY REFERENCES publisher_jobs(id),created_at TEXT NOT NULL)');
    this.permits=new SingleExecutionPermits(publisher);
  }
  freezeMedia(job) {
    const old=this.db.prepare('SELECT * FROM publisher_job_assets WHERE job_id=? ORDER BY ordinal').all(job.id);
    if(old.length) {
      if(old.length!==job.snapshot.media.length)throw Error('媒体快照不完整');
      for(const asset of old)if(hashFile(asset.path).sha256!==asset.sha256)throw Error('媒体快照已变化');
      return old.map(x=>x.path);
    }
    const assets=job.snapshot.media.map((value,ordinal)=>{
      const source=realpathSync(value);
      const roots=(typeof this.mediaRoots==='function'?this.mediaRoots(job):this.mediaRoots).filter(existsSync).map(path=>realpathSync(path));
      if(!roots.some(root=>{const rel=relative(root,source);return rel&&!rel.startsWith('..')&&!rel.startsWith('/');}))throw Error('媒体不属于已配置客户内容目录');
      const ext=extname(source).toLowerCase();if(!['.png','.jpg','.jpeg','.webp','.mp4'].includes(ext))throw Error('媒体格式不支持');
      const meta=hashFile(source),h=meta.header;
      const valid=ext==='.png'?h.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):['.jpg','.jpeg'].includes(ext)?h[0]===255&&h[1]===216&&h[2]===255:ext==='.webp'?h.toString('ascii',0,4)==='RIFF'&&h.toString('ascii',8,12)==='WEBP':h.toString('ascii',4,8)==='ftyp';
      if(!valid||!meta.sizeBytes)throw Error('媒体文件签名无效');
      const directory=join(this.snapshotRoot,job.id);mkdirSync(directory,{recursive:true,mode:0o700});
      const path=join(directory,ordinal+ext);copyFileSync(source,path);chmodSync(path,0o600);
      if(hashFile(path).sha256!==meta.sha256)throw Error('媒体在冻结期间发生变化');
      return {ordinal,path,sha256:meta.sha256,size:meta.sizeBytes};
    });
    this.publisher.store.tx(()=>{for(const a of assets)this.db.prepare('INSERT INTO publisher_job_assets VALUES(?,?,?,?,?)').run(job.id,a.ordinal,a.path,a.sha256,a.size);});
    return assets.map(x=>x.path);
  }
  approve(workspace,id,hash) {
    const job=this.publisher.job(workspace,id);if(job.state!=='DRAFT')throw Error('只能批准待确认任务');
    if(job.snapshot_hash!==hash)throw Error('预览版本已失效');
    this.publisher.assertCurrent(job);
    const scopedApproval=this.scopedOperations?.policy.approved_targets?.some(t=>t.subject_id==='PAGE:'+id);
    if(scopedApproval)this.scopedOperations.describeApproval(id);
    this.freezeMedia(job);
    if(scopedApproval)this.scopedOperations.describe('PAGE',id);
    return this.publisher.approve(workspace,id,hash);
  }
  reopen(workspace,id){
    return this.publisher.store.tx(()=>{
      const job=this.publisher.job(workspace,id);
      if(retainsPreparationEffects(job))throw Error('准备副作用仍待人工核对，不能重新审核或重发此任务');
      if(job.state!=='BLOCKED'||this.db.prepare('SELECT 1 FROM publisher_submit_intents WHERE job_id=?').get(id))throw Error('只有确认未提交的阻断任务可以重新审核');
      this.publisher.assertCurrent(job);
      const boundedPage=this.pageExecution&&job.account_id===this.pageExecution.accountId&&
        job.snapshot.platform==='facebook'&&job.snapshot.transport==='BROWSER'&&
        job.snapshot.operation==='FACEBOOK_PAGE_PUBLISH';
      if(boundedPage){
        if(!provenPristinePreSubmit(this.db,{...job,evidence_json:JSON.stringify(job.evidence)}))throw Error('原尝试尚未证明为提交前且无准备副作用，不能释放执行资格');
        const at=new Date().toISOString(),evidence={...job.evidence,preSubmissionRecovery:{attemptId:job.attempt_id,snapshotHash:job.snapshot_hash,at,reason:'PROVEN_BEFORE_EXTERNAL_SUBMIT'}};
        const changed=this.db.prepare("UPDATE publisher_jobs SET state='DRAFT',attempt_id=NULL,evidence_json=?,updated_at=? WHERE id=? AND state='BLOCKED' AND attempt_id=?").run(JSON.stringify(evidence),at,id,job.attempt_id);
        if(changed.changes!==1)throw Error('原任务状态已改变，不能恢复');
        this.publisher.store.event(workspace,'publisher_pristine_pre_submit_recovered',{job_id:id,attempt_id:job.attempt_id,snapshot_hash:job.snapshot_hash,reason:'PROVEN_BEFORE_EXTERNAL_SUBMIT'});
      }else this.db.prepare("UPDATE publisher_jobs SET state='DRAFT',updated_at=? WHERE id=?").run(new Date().toISOString(),id);
      return this.publisher.job(workspace,id);
    });
  }
  executionKey(snapshot){
    if(snapshot.platform!=='xiaohongshu')return snapshot.profileId;
    if(!snapshot.options?.mcp_endpoint)throw Error('原MCP连接未冻结');
    const url=new URL(snapshot.options.mcp_endpoint);if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.pathname!=='/mcp'||!url.port||url.search||url.hash||url.username||url.password)throw Error('原MCP连接无效');
    return 'xhs:'+url.href;
  }
  mcpPending(endpoint){
    const target=new URL(endpoint).href;
    return this.db.prepare("SELECT json_extract(snapshot_json,'$.options.mcp_endpoint') endpoint FROM publisher_jobs WHERE json_extract(snapshot_json,'$.platform')='xiaohongshu' AND state IN ('SUBMITTING','UNKNOWN')").all().some(row=>{try{return this.executionKey({platform:'xiaohongshu',options:{mcp_endpoint:row.endpoint}}).slice(4)===target;}catch{return true;}});
  }
  profilePending(profileId) {
    return pendingPublisherProfileRows(this.db,profileId).length>0;
  }
  interactivePage(job){
    const p=this.pageExecution,s=job.snapshot;
    return Boolean(p&&job.account_id===p.accountId&&s.platform==='facebook'&&s.transport==='BROWSER'&&s.identityType==='PAGE'&&s.operation==='FACEBOOK_PAGE_PUBLISH'&&Date.parse(job.created_at)>=p.newJobsAfter&&job.attempt_id===null);
  }
  assertInteractivePage(job){
    if(!this.interactivePage(job))throw Error('此任务不属于新建的浏览器 Page 发布入口');
    const s=job.snapshot,day=operatingDay(this.now());
    if(this.pageExecution.blockedOperatingDay===day)throw Error('当前运营日 Page 发布额度已用完；每日北京时间 07:00 重置，届时仍需重新核对并人工确认');
    const history=auditPublisherHistory(this.db,this.pageExecution.additionalHistory,{kind:'PAGE',workspace:job.workspace,actor_id:s.operatorActorId,target_page_id:s.targetPageId,body_hash:createHash('sha256').update(s.body).digest('hex')},day,this.now);
    if(history.pending||history.paused||history.duplicate)throw Error('跨入口历史存在未核对提交、暂停或重复正文；请先只读核验');
    if(history.page>=1)throw Error('当前运营日同一 Page 已有手工、V1 或统一入口发布尝试');
    const attempts=this.db.prepare("SELECT j.*,(SELECT MIN(created_at) FROM publisher_prepare_intents p WHERE p.job_id=j.id) prepare_at,(SELECT MIN(created_at) FROM publisher_submit_intents s WHERE s.job_id=j.id) submit_at FROM publisher_jobs j WHERE j.id<>? AND j.workspace=? AND j.attempt_id IS NOT NULL").all(job.id,job.workspace);
    if(attempts.some(row=>{if(provenPristinePreSubmit(this.db,row))return false;const other=JSON.parse(row.snapshot_json);return other.platform==='facebook'&&other.operatorActorId===s.operatorActorId&&other.targetPageId===s.targetPageId&&operatingDay(row.prepare_at||row.submit_at||row.updated_at)===day;}))throw Error('本地防重保护：当前运营日此 Page 已有提交或待核对记录');
    if(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='task_action_daily_claims'").get()&&this.db.prepare("SELECT created_at FROM task_action_daily_claims WHERE workspace=? AND actor_id=? AND target_page_id=? AND kind='PAGE'").all(job.workspace,s.operatorActorId,s.targetPageId).some(row=>operatingDay(row.created_at)===day))throw Error('当前运营日此 Page 已有单次任务额度记录');
  }
  acquireResources(snapshot,{reconcile=false}={}){
    const held=[];
    try{
      if(snapshot.transport==='BROWSER_SKILL'){
        if(reconcile)throw Error('BSK_EXPLICIT_READBACK_REQUIRED');
        this.publisher.assertCurrent(this.publisher.job(snapshot.workspace,snapshot.jobId));
        return this.resources.acquireInstance(snapshot.executionRef.instanceId,'operator:'+snapshot.profileId,()=>this.scopedOperations.browserSkillPending(snapshot.profileId));
      }
      // A shared MCP sidecar is a session resource even with distinct UI profiles.
      if(snapshot.platform==='xiaohongshu'){
        const endpoint=this.executionKey(snapshot).slice(4),key=createHash('sha256').update(endpoint).digest('hex');
        held.push(this.resources.acquire(join(this.resources.directory,'mcp-sessions',key),'xhs:'+endpoint,()=>this.mcpPending(endpoint),{reconcile}));
      }
      if(snapshot.profileDir)held.push(this.resources.acquire(snapshot.profileDir,'operator:'+snapshot.profileId,()=>this.profilePending(snapshot.profileId)||this.drivers.pending?.(snapshot.profileId),{reconcile}));
      if(!snapshot.profileDir&&snapshot.platform!=='xiaohongshu')throw Error('原浏览器环境缺失');
      return ()=>{for(const release of held.reverse())release();};
    }catch(error){for(const release of held.reverse())release();throw error;}
  }
  async inspectAccount(workspace,id){
    const {account,profile}=this.publisher.context(workspace,id);
    const snapshot={workspace,accountId:id,platform:account.platform,operatorActorId:account.operator_actor_id,targetPageId:account.target_page_id,externalId:account.external_id,expectedIdentity:account.expected_identity,profileId:profile?.id??null,profileDir:profile?.user_data_dir??null,cdpPort:profile?.cdp_port??null,...(!profile?{executionRef:{kind:'MCP',endpoint:account.publisher_options.mcp_endpoint}}:{}),transport:account.publisher_transport,credentialRef:account.config_url,options:account.publisher_options};
    let release,driver;try{
      release=this.acquireResources(snapshot,{reconcile:true});
      driver=await this.drivers.create(snapshot);if(!driver.inspect)throw Error('只读预检未接入');return await driver.inspect();
    }finally{try{await driver?.close();}finally{release?.();}}
  }
  executionCapability(workspace,id) {
    const job=this.publisher.job(workspace,id);
    if(job.snapshot.transport==='BROWSER_SKILL'){
      try{if(!this.scopedOperations||this.permits.record(id))throw Error('BSK_ORIGINAL_SCOPED_CONFIRMATION_REQUIRED');this.assertClaimable(job);return this.scopedOperations.capability('PAGE',id);}catch(error){return {canExecute:false,mode:'TASK_CONFIRM',reason:error.message};}
    }
    if(this.permits.record(id)){
      const result=this.permits.capability(job);if(!result.canExecute)return result;
      try{this.assertClaimable(job);this.scopedOperations?.legacyBudget(job);return result;}catch(error){return {...result,canExecute:false,reason:error.message};}
    }
    if(!this.enabled){if(this.scopedOperations){try{this.assertClaimable(job);return this.scopedOperations.capability('PAGE',id);}catch(e){return {canExecute:false,mode:'TASK_CONFIRM',reason:e.message};}}if(this.pageExecution){try{this.assertClaimable(job);this.assertInteractivePage(job);return {canExecute:true,mode:'PAGE_INTERACTIVE'};}catch(e){return {canExecute:false,mode:'PAGE_INTERACTIVE',reason:e.message};}}return {canExecute:false,mode:'DISABLED',reason:'验收模式未开启真实提交'};}
    try{this.assertClaimable(job);return {canExecute:true,mode:'GLOBAL'};}
    catch(error){return {canExecute:false,mode:'GLOBAL',reason:error.message};}
  }
  assertClaimable(job) {
    if(job.state!=='READY')throw Error('只有确认后的任务可执行；未知结果必须核对');
    this.publisher.assertCurrent(job);
    if(this.db.prepare('SELECT id,snapshot_json,evidence_json,state FROM publisher_jobs WHERE workspace=? AND id<>?').all(job.workspace,job.id).some(row=>matchesRetainedFacebookPublication(this.db,row,job.snapshot,job.id)))throw Error('相同实际正文与媒体仍有准备副作用待核对，不能重发');
    const duplicate=this.db.prepare('SELECT id,snapshot_json,evidence_json,state FROM publisher_jobs WHERE workspace=? AND id<>?').all(job.workspace,job.id).find(row=>{const s=JSON.parse(row.snapshot_json);return (guardedStates.includes(row.state)||retainsPreparationEffects(row))&&platformOf(s)===platformOf(job.snapshot)&&(platformOf(s)==='facebook'?(s.targetPageId||s.externalId):s.externalId)===(job.snapshot.targetPageId||job.snapshot.externalId)&&(s.payloadHash||s.contentHash)===(job.snapshot.payloadHash||job.snapshot.contentHash);});
    if(duplicate)throw Error('同一身份与内容已有提交或待核对任务，不能切换模式重发');
    if(job.snapshot.platform==='xiaohongshu'&&this.mcpPending(this.executionKey(job.snapshot).slice(4)))throw Error('该MCP连接存在提交中或UNKNOWN任务；请先核对原结果');
    if(this.profilePending(job.snapshot.profileId))throw Error('该浏览器账号存在提交中或 UNKNOWN 待核对任务；请先只读核对旧任务，不会自动重发或清锁');
  }
  claim(workspace,id,input={}) {
    return this.publisher.store.tx(()=>{
      const job=this.publisher.job(workspace,id);this.assertClaimable(job);
      const attemptId=randomUUID();
      // A scoped record always wins over the global switch, including spent/revoked records.
      if(job.snapshot.transport==='BROWSER_SKILL'){if(!this.scopedOperations||this.permits.record(id))throw Error('BSK_ORIGINAL_SCOPED_CONFIRMATION_REQUIRED');this.scopedOperations.confirmAndConsume('PAGE',id,input,attemptId);}
      else if(this.permits.record(id)){this.scopedOperations?.legacyBudget(job);this.permits.consume(job,attemptId);}
      else if(!this.enabled){if(this.scopedOperations)this.scopedOperations.confirmAndConsume('PAGE',id,input,attemptId);else{this.assertInteractivePage(job);if(input.confirm!==true||input.snapshot_hash!==job.snapshot_hash||Object.keys(input).sort().join(',')!=='confirm,snapshot_hash')throw Error('请确认当前冻结版本后再提交');}}
      if(!this.enabled&&this.pageExecution&&!this.scopedOperations&&!this.permits.record(id))this.assertInteractivePage(job);
      const changed=this.db.prepare("UPDATE publisher_jobs SET state='PREPARING',attempt_id=?,updated_at=? WHERE id=? AND state='READY'").run(attemptId,new Date().toISOString(),id);
      if(changed.changes!==1)throw Error('任务已被其他执行者领取');
      return this.publisher.job(workspace,id);
    });
  }
  async execute(workspace,id,input={}) {
    const initial=this.publisher.job(workspace,id),profile=this.executionKey(initial.snapshot);
    if(!this.enabled&&!this.permits.record(id)&&!this.scopedOperations&&!this.pageExecution)throw Error('验收模式未开启真实提交');
    if(this.active.has(profile))throw Error('该浏览器账号正在执行任务');
    this.active.add(profile);let job,driver,release;
    try {
      job=this.claim(workspace,id,input);
      const resources=this.resources; if(!resources)throw Error('缺少统一浏览器互斥配置');
      release=this.acquireResources({...job.snapshot,jobId:job.id});
      const assets=this.db.prepare('SELECT * FROM publisher_job_assets WHERE job_id=? ORDER BY ordinal').all(id);
      if(assets.length!==job.snapshot.media.length)throw Error('未保存批准时的媒体快照');
      for(const asset of assets)if(hashFile(asset.path).sha256!==asset.sha256)throw Error('已批准媒体发生变化');
      driver=await this.drivers.create(job.snapshot,job.snapshot.transport==='BROWSER_SKILL'?{assertScope:()=>this.scopedOperations.assertClaimed('PAGE',id,input),proveHistory:()=>this.scopedOperations.assertPublicationHistory('PAGE',id,input)}:undefined);
      const prepared=await driver.prepare(job.snapshot,assets.map(x=>x.path),()=>{
        this.publisher.assertCurrent(job);
        this.db.prepare('INSERT OR IGNORE INTO publisher_prepare_intents VALUES(?,?)').run(id,new Date().toISOString());
      });
      this.publisher.assertCurrent(job);
      for(const asset of assets)if(hashFile(asset.path).sha256!==asset.sha256)throw Error('准备期间已批准媒体发生变化，未最终提交');
      this.publisher.store.tx(()=>{
        this.db.prepare('INSERT INTO publisher_submit_intents VALUES(?,?,?,?,?,?)').run(id,job.attempt_id,job.snapshot.transport,job.snapshot_hash,JSON.stringify(prepared),new Date().toISOString());
        this.db.prepare("UPDATE publisher_jobs SET state='SUBMITTING',updated_at=? WHERE id=? AND state='PREPARING'").run(new Date().toISOString(),id);
      });
      const receipt=await driver.submit();
      if(receipt?.id)this.db.prepare('INSERT INTO publisher_submit_receipts VALUES(?,?,?,?,?)').run(id,String(receipt.id),String(receipt.url||''),JSON.stringify({accepted:true,transport:job.snapshot.transport}),new Date().toISOString());
      const evidence=await driver.readback(job.snapshot,receipt);
      this.complete(workspace,id,evidence);
    } catch(error) {this.scopedOperations?.stopForWarning(error);
      let browserDiagnostics;try{browserDiagnostics=driver?.failureEvidence?.();}catch{/* Diagnostic collection must not mask the original uncertain outcome. */}
      if(job){const current=this.publisher.job(workspace,id);if(['PREPARING','SUBMITTING'].includes(current.state)){
        const hasSubmitIntent=Boolean(this.db.prepare('SELECT 1 FROM publisher_submit_intents WHERE job_id=?').get(id));
        const hasSubmitReceipt=Boolean(this.db.prepare('SELECT 1 FROM publisher_submit_receipts WHERE job_id=?').get(id));
        const hasPrepareIntent=Boolean(this.db.prepare('SELECT 1 FROM publisher_prepare_intents WHERE job_id=?').get(id));
        // The submit-intent and SUBMITTING transition commit together before
        // driver.submit(). A PREPARING failure in this live call never reached
        // that call, even if a composer or upload was already prepared.
        const submitMayHaveStarted=current.state==='SUBMITTING'||hasSubmitIntent||hasSubmitReceipt;
        const state=submitMayHaveStarted?'UNKNOWN':'BLOCKED';
        const evidence={...current.evidence,error:safeError(error),stage:current.state,submissionIntent:hasSubmitIntent,
          submitCallMayHaveStarted:submitMayHaveStarted,browserDiagnostics,
          ...(!submitMayHaveStarted?{preparationFailure:{attemptId:current.attempt_id,snapshotHash:current.snapshot_hash,at:new Date().toISOString(),finalSubmitNotCalled:true,preparationEffectsMayRemain:hasPrepareIntent},preparationEffectsMayRemain:hasPrepareIntent}: {})};
        this.publisher.store.tx(()=>{this.db.prepare('UPDATE publisher_jobs SET state=?,evidence_json=?,updated_at=? WHERE id=? AND state=?').run(state,JSON.stringify(evidence),new Date().toISOString(),id,current.state);this.publisher.store.event(workspace,'publisher_attempt_failed',{job_id:id,attempt_id:current.attempt_id,from_state:current.state,to_state:state,submit_intent:hasSubmitIntent,submit_receipt:hasSubmitReceipt,prepare_intent:hasPrepareIntent});});
      }}
      throw Error(safeError(error));
    } finally {
      try{await driver?.close();}finally{try{release?.();}finally{this.active.delete(profile);}}
    }
    return this.publisher.job(workspace,id);
  }
  canResumePrepared(job){
    const s=job.snapshot,e=job.evidence,attempt=job.attempt_id;
    const priorSafeResume=Boolean(this.db.prepare("SELECT 1 FROM events WHERE workspace=? AND event='publisher_retained_composer_failed' AND json_extract(value,'$.job_id')=? AND json_extract(value,'$.attempt_id')=? AND json_extract(value,'$.submit_intent')=0 LIMIT 1").get(job.workspace,job.id,attempt));
    return Boolean(this.pageExecution&&job.account_id===this.pageExecution.accountId&&s.platform==='facebook'&&s.transport==='BROWSER'&&s.identityType==='PAGE'&&s.operation==='FACEBOOK_PAGE_PUBLISH'&&Date.parse(job.created_at)>=this.pageExecution.newJobsAfter&&
      job.state==='BLOCKED'&&attempt&&e.stage==='PREPARING'&&e.submissionIntent===false&&e.submitCallMayHaveStarted===false&&e.preparationFailure?.attemptId===attempt&&e.preparationFailure?.snapshotHash===job.snapshot_hash&&e.preparationFailure?.finalSubmitNotCalled===true&&e.preparationEffectsMayRemain===true&&e.browserDiagnostics?.finalClickAttempted===false&&e.browserDiagnostics?.composerRetained===true&&(e.error==='MEDIA_COUNT_CHANGED'||priorSafeResume)&&
      this.db.prepare('SELECT 1 FROM publisher_prepare_intents WHERE job_id=?').get(job.id)&&!this.db.prepare('SELECT 1 FROM publisher_submit_intents WHERE job_id=?').get(job.id)&&!this.db.prepare('SELECT 1 FROM publisher_submit_receipts WHERE job_id=?').get(job.id));
  }
  async resumePrepared(workspace,id,input={}){
    const job=this.publisher.job(workspace,id),s=job.snapshot,e=job.evidence,attempt=job.attempt_id;
    if(Object.keys(input).sort().join(',')!=='attempt_id,confirm,snapshot_hash'||input.confirm!==true||input.attempt_id!==attempt||input.snapshot_hash!==job.snapshot_hash)throw Error('原任务、attempt 与冻结版本必须逐项确认');
    if(!this.canResumePrepared(job))throw Error('原任务没有可恢复的确定准备阶段证据');
    if(this.active.has(this.executionKey(s)))throw Error('原浏览器账号正在执行任务');
    this.publisher.assertCurrent(job);
    const day=operatingDay(this.now()),history=auditPublisherHistory(this.db,this.pageExecution.additionalHistory,{kind:'PAGE',workspace,actor_id:s.operatorActorId,target_page_id:s.targetPageId,body_hash:createHash('sha256').update(s.body).digest('hex')},day,this.now);
    // This exact retained attempt is the sole local Page attempt for today.
    if(history.pending||history.paused||history.page!==1)throw Error('跨入口发布历史已改变，不能继续原编辑器');
    this.active.add(this.executionKey(s));let release,driver,submitted=false;
    try{
      release=this.acquireResources({...s,jobId:id},{reconcile:true});
      const assets=this.db.prepare('SELECT * FROM publisher_job_assets WHERE job_id=? ORDER BY ordinal').all(id);
      if(assets.length!==s.media.length||assets.some(a=>hashFile(a.path).sha256!==a.sha256))throw Error('原任务批准媒体已变化');
      driver=await this.drivers.create(s);
      if(typeof driver.adoptPrepared!=='function')throw Error('原编辑器恢复执行器不可用');
      const prepared=await driver.adoptPrepared(s,assets.map(a=>a.path));
      this.publisher.assertCurrent(job);
      for(const asset of assets)if(hashFile(asset.path).sha256!==asset.sha256)throw Error('原任务批准媒体在核对期间变化');
      this.publisher.store.tx(()=>{
        const current=this.publisher.job(workspace,id);
        if(current.state!=='BLOCKED'||current.attempt_id!==attempt||this.db.prepare('SELECT 1 FROM publisher_submit_intents WHERE job_id=?').get(id))throw Error('原任务在核对期间已改变');
        this.db.prepare('INSERT INTO publisher_submit_intents VALUES(?,?,?,?,?,?)').run(id,attempt,s.transport,job.snapshot_hash,JSON.stringify(prepared),new Date().toISOString());
        this.db.prepare("UPDATE publisher_jobs SET state='SUBMITTING',updated_at=? WHERE id=? AND state='BLOCKED' AND attempt_id=?").run(new Date().toISOString(),id,attempt);
        this.publisher.store.event(workspace,'publisher_retained_composer_submitting',{job_id:id,attempt_id:attempt,snapshot_hash:job.snapshot_hash,reason:'MEDIA_COUNT_CHANGED'});
      });
      submitted=true;
      const receipt=await driver.submit();
      if(receipt?.id)this.db.prepare('INSERT INTO publisher_submit_receipts VALUES(?,?,?,?,?)').run(id,String(receipt.id),String(receipt.url||''),JSON.stringify({accepted:true,transport:s.transport}),new Date().toISOString());
      const evidence=await driver.readback(s,receipt);this.complete(workspace,id,evidence);
      return this.publisher.job(workspace,id);
    }catch(error){
      let browserDiagnostics;try{browserDiagnostics=driver?.failureEvidence?.();}catch{}
      const current=this.publisher.job(workspace,id),maySubmit=submitted||Boolean(this.db.prepare('SELECT 1 FROM publisher_submit_intents WHERE job_id=?').get(id));
      if(['BLOCKED','SUBMITTING'].includes(current.state))this.publisher.store.tx(()=>{
        this.db.prepare('UPDATE publisher_jobs SET state=?,evidence_json=?,updated_at=? WHERE id=?').run(maySubmit?'UNKNOWN':'BLOCKED',JSON.stringify({...current.evidence,error:safeError(error),stage:maySubmit?'SUBMITTING':'PREPARING',submissionIntent:maySubmit,submitCallMayHaveStarted:maySubmit,browserDiagnostics:browserDiagnostics||current.evidence.browserDiagnostics,preparationEffectsMayRemain:true}),new Date().toISOString(),id);
        this.publisher.store.event(workspace,'publisher_retained_composer_failed',{job_id:id,attempt_id:attempt,submit_intent:maySubmit});
      });
      throw Error(safeError(error));
    }finally{try{await driver?.close();}finally{try{release?.();}finally{this.active.delete(this.executionKey(s));}}}
  }
  complete(workspace,id,evidence) {
    const job=this.publisher.job(workspace,id);
    if(!['SUBMITTING','UNKNOWN'].includes(job.state))throw Error('任务不在可核对状态');
    const submitIntent=this.db.prepare('SELECT 1 FROM publisher_submit_intents WHERE job_id=?').get(id);
    if(!submitIntent){
      const manual=job.evidence.humanConfirmation,expected=`https://www.facebook.com/${job.snapshot.operatorActorId}/posts/${evidence?.id}`;
      if(job.state!=='UNKNOWN'||platformOf(job.snapshot)!=='facebook'||job.snapshot.transport!=='BROWSER'||
        !manual||manual.previousState!=='BLOCKED'||manual.snapshotHash!==job.snapshot_hash||manual.accountId!==job.account_id||
        manual.platformId!==evidence?.id||manual.url!==expected||evidence?.url!==expected||
        job.evidence.stage!=='PREPARING'||job.evidence.submissionIntent!==false||job.evidence.submitCallMayHaveStarted!==false||
        job.evidence.preparationFailure?.finalSubmitNotCalled!==true||job.evidence.preparationFailure?.snapshotHash!==job.snapshot_hash)
        throw Error('准备阶段中断，未记录最终提交意图；不能标记已发布或重新提交');
      evidence={...job.evidence,...evidence,externalManualVerified:true,humanConfirmation:manual,previousError:job.evidence.error};
    }
    const platform=platformOf(job.snapshot),outcome=evidence?.outcome||'PUBLISHED';
    if(platform==='facebook'&&(!job.snapshot.operatorActorId||!job.snapshot.targetPageId))throw Error('旧任务缺少独立冻结身份，保留记录并人工核对');
    if(!evidence?.verified||(platform==='facebook'?(evidence.targetPageId!==job.snapshot.targetPageId||evidence.operatorActorId!==job.snapshot.operatorActorId):(evidence.accountId||evidence.pageId)!==job.snapshot.externalId)||evidence.contentHash!==job.snapshot.contentHash||evidence.platform&&evidence.platform!==platform)throw Error('没有完整的平台身份与内容回读证据');
    if(evidence.payloadHash&&evidence.payloadHash!==job.snapshot.payloadHash)throw Error('平台回读与冻结文案不一致');
    if(job.snapshot.transport==='BROWSER_SKILL'&&(!evidence.mediaVerified||evidence.mediaCount!==job.snapshot.assetMetadata.length||evidence.payloadHash!==job.snapshot.payloadHash||!evidence.url||!Array.isArray(evidence.observedTimes)||!evidence.observedTimes.length))throw Error('BSK_COMPLETE_MEDIA_AND_TIME_READBACK_REQUIRED');
    if(platform!=='facebook'&&evidence.payloadHash!==job.snapshot.payloadHash)throw Error('缺少平台冻结文案回读证据');
    if(platform==='wechat_official_account'&&(outcome!=='DRAFT_WRITTEN'||!evidence.id||evidence.formalPublication!==false))throw Error('公众号只能确认草稿，不能标记公开发表');
    if(platform==='wechat_channels'&&(outcome!=='PUBLISHED_ID_PENDING'||!evidence.publicLinkUnavailable))throw Error('视频号缺少准确的列表回读状态');
    if(!terminalStates.includes(outcome)||!evidence.id&&outcome!=='PUBLISHED_ID_PENDING')throw Error('没有作品 ID 或平台终态无效');
    this.db.prepare('UPDATE publisher_jobs SET state=?,evidence_json=?,updated_at=? WHERE id=?').run(outcome,JSON.stringify(evidence),new Date().toISOString(),id);
    if(!submitIntent)this.publisher.store.event(workspace,'publisher_external_manual_verified',{job_id:id,attempt_id:job.attempt_id,snapshot_hash:job.snapshot_hash,platform_id:evidence.id,original_stage:job.evidence.stage});
  }
  async resolvePreparation(workspace,id,input={}){
    const validate=job=>{
      if(input.acknowledge_preparation_effects!==true||!job.attempt_id||input.expected_attempt_id!==job.attempt_id||input.snapshot_hash!==job.snapshot_hash)throw Error('PREPARATION_EXACT_ATTEMPT_AND_HASH_REQUIRED');
      if(job.snapshot.platform!=='facebook'||job.snapshot.transport!=='BROWSER')throw Error('PREPARATION_FACEBOOK_BROWSER_REQUIRED');
      const e=job.evidence;
      if(e.stage!=='PREPARING'||e.submissionIntent!==false||e.browserDiagnostics?.finalClickAttempted!==false)throw Error('PREPARATION_FINAL_SUBMISSION_NOT_EXCLUDED');
      if(this.db.prepare('SELECT 1 FROM publisher_submit_intents WHERE job_id=?').get(id)||this.db.prepare('SELECT 1 FROM publisher_submit_receipts WHERE job_id=?').get(id))throw Error('PREPARATION_SUBMIT_RECORD_EXISTS');
      if(!this.db.prepare('SELECT 1 FROM publisher_prepare_intents WHERE job_id=?').get(id))throw Error('PREPARATION_INTENT_REQUIRED');
      const resolution=e.preparationResolution;
      if(job.state==='BLOCKED'&&resolution?.attemptId===input.expected_attempt_id&&resolution?.snapshotHash===input.snapshot_hash)return true;
      if(job.state!=='UNKNOWN'||resolution)throw Error('PREPARATION_UNKNOWN_REQUIRED');
      return false;
    };
    const busy=job=>{
      const profile=job.snapshot.profileId;
      if(this.active.has(profile)||this.db.prepare("SELECT 1 FROM publisher_jobs WHERE json_extract(snapshot_json,'$.profileId')=? AND state IN ('PREPARING','SUBMITTING')").get(profile))throw Error('PREPARATION_PROFILE_ACTIVE');
      for(const table of ['publisher_diagnostic_runs','publisher_composer_observations'])if(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)&&this.db.prepare(`SELECT 1 FROM ${table} WHERE state='RUNNING' AND job_id IN (SELECT id FROM publisher_jobs WHERE json_extract(snapshot_json,'$.profileId')=?)`).get(profile))throw Error('PREPARATION_READBACK_ACTIVE');
    };
    const job=this.publisher.job(workspace,id);if(validate(job))return job;busy(job);
    this.publisher.assertCurrent(job);assertPendingObservationLease(this,job.snapshot);
    const release=this.acquireResources(job.snapshot,{reconcile:true});this.active.add(this.executionKey(job.snapshot));
    try{
      return this.publisher.store.tx(()=>{
        const current=this.publisher.job(workspace,id);if(validate(current))return current;
        // Own active reservation is expected; every other persisted execution is rechecked.
        if(this.db.prepare("SELECT 1 FROM publisher_jobs WHERE json_extract(snapshot_json,'$.profileId')=? AND state IN ('PREPARING','SUBMITTING')").get(current.snapshot.profileId))throw Error('PREPARATION_PROFILE_ACTIVE');
        for(const table of ['publisher_diagnostic_runs','publisher_composer_observations'])if(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)&&this.db.prepare(`SELECT 1 FROM ${table} WHERE state='RUNNING' AND job_id IN (SELECT id FROM publisher_jobs WHERE json_extract(snapshot_json,'$.profileId')=?)`).get(current.snapshot.profileId))throw Error('PREPARATION_READBACK_ACTIVE');
        this.publisher.assertCurrent(current);
        const at=new Date().toISOString(),resolution={attemptId:current.attempt_id,snapshotHash:current.snapshot_hash,at,previousState:'UNKNOWN',outcome:'PREPARATION_INTERRUPTED_NO_FINAL_SUBMIT',platformAbsenceProven:false,note:'准备中断已人工确认未调用最终提交；上传或草稿可能残留，旧任务继续阻断审核，不自动重发。'};
        const evidence={...current.evidence,preparationResolution:resolution,finalSubmissionNotCalled:true,preparationEffectsMayRemain:true};
        const changed=this.db.prepare("UPDATE publisher_jobs SET state='BLOCKED',evidence_json=?,updated_at=? WHERE id=? AND state='UNKNOWN' AND attempt_id=? AND snapshot_hash=?").run(JSON.stringify(evidence),at,id,input.expected_attempt_id,input.snapshot_hash);if(changed.changes!==1)throw Error('PREPARATION_STALE_REQUEST');
        this.publisher.store.event(workspace,'publisher_preparation_resolved',{job_id:id,...resolution,preparationEffectsMayRemain:true});
        return this.publisher.job(workspace,id);
      });
    }finally{try{release();}finally{this.active.delete(this.executionKey(job.snapshot));}}
  }
  async reconcile(workspace,id,input={}) {
    const job=this.publisher.job(workspace,id);if(job.state!=='UNKNOWN')throw Error('任务当前不需要核对');
    if(this.active.has(this.executionKey(job.snapshot)))throw Error('该账号正在执行任务');
    this.active.add(this.executionKey(job.snapshot));let driver,release;
    try {
      release=this.acquireResources(job.snapshot,{reconcile:true});
      driver=await this.drivers.create(job.snapshot);
      const assets=this.db.prepare('SELECT * FROM publisher_job_assets WHERE job_id=? ORDER BY ordinal').all(id);
      if(assets.length!==job.snapshot.media.length||assets.some(a=>hashFile(a.path).sha256!==a.sha256))throw Error('核对媒体快照不完整或已变化');
      const intent=this.db.prepare('SELECT prepared_json FROM publisher_submit_intents WHERE job_id=?').get(id);
      driver.restore?.(job.snapshot,assets.map(x=>x.path),intent?JSON.parse(intent.prepared_json):null);
      let receipt=this.db.prepare('SELECT platform_id AS id,platform_url AS url FROM publisher_submit_receipts WHERE job_id=?').get(id);
      if(!receipt&&input.platform_id){if(!/^[A-Za-z0-9_-]{1,160}$/.test(String(input.platform_id)))throw Error('平台作品 ID 格式无效');receipt={id:String(input.platform_id),url:''};}
      if(!intent&&!receipt?.id)throw Error('人工平台作品 ID 未提供，不能核对准备中断任务');
      if(!intent&&job.evidence.humanConfirmation?.platformId!==receipt.id)throw Error('平台作品 ID 与原人工确认不一致');
      const evidence=await driver.readback(job.snapshot,receipt);
      this.complete(workspace,id,{...evidence,...(job.evidence.humanConfirmation?{humanConfirmation:job.evidence.humanConfirmation,previousError:job.evidence.error}:{} )});
      return this.publisher.job(workspace,id);
    }finally{try{await driver?.close();}finally{try{release?.();}finally{this.active.delete(this.executionKey(job.snapshot));}}}
  }
  resolveNotPublished(workspace,id,input={}) {
    const job=this.publisher.job(workspace,id);
    if(job.state!=='UNKNOWN'||input.confirm_not_published!==true||input.snapshot_hash!==job.snapshot_hash||typeof input.authorization_source!=='string'||!input.authorization_source.trim()||input.authorization_source.length>500)throw Error('需要用户明确确认该冻结任务未发布，并提供授权来源');
    if(this.active.has(this.executionKey(job.snapshot)))throw Error('该账号仍在执行任务，不能人工解除');
    const release=this.acquireResources(job.snapshot,{reconcile:true});
    try{
      return this.publisher.store.tx(()=>{
        const current=this.publisher.job(workspace,id);
        if(current.state!=='UNKNOWN'||current.snapshot_hash!==input.snapshot_hash)throw Error('任务状态或冻结版本已改变');
        const time=new Date().toISOString(),evidence={...current.evidence,operatorFinished:true,humanResolution:{outcome:'NOT_PUBLISHED',at:time,source:input.authorization_source.trim(),previousState:'UNKNOWN',snapshotHash:current.snapshot_hash,accountId:current.account_id}};
        this.db.prepare("UPDATE publisher_jobs SET state='CANCELLED',evidence_json=?,updated_at=? WHERE id=? AND state='UNKNOWN'").run(JSON.stringify(evidence),time,id);
        this.publisher.store.event(workspace,'publisher_unknown_resolved_not_published',{job_id:id,snapshot_hash:current.snapshot_hash,authorization_source:input.authorization_source.trim()});
        return this.publisher.job(workspace,id);
      });
    }finally{release();}
  }
}

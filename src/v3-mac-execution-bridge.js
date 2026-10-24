import {requireProductionAdmin} from './production-approval-policy.js';
import {createHash} from 'node:crypto';
import {verifyV3StagedMedia} from './v3-media-staging.js';

const sha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const fail=code=>{throw Error(code);};
const preparedManifestHash=input=>createHash('sha256').update(JSON.stringify({platform:input.platform,external_identity:input.external_identity,title:input.title,body:input.body,payload:input.payload,media:input.media})).digest('hex');

/** A dormant Mac-side adapter. It never opens a browser or changes an execution
 * switch by itself. The local Publisher remains the sole authority for quota,
 * profile locks, media hashes, submit intent, and UNKNOWN reconciliation.
 * The Sites job ID is a correlation key, never an execution permission.
 */
export class V3MacExecutionBridge {
 constructor(publisher,executor,{siteProjectId,mediaRoot}={}){
  if(!publisher?.store?.tx||!publisher?.db||!executor||typeof siteProjectId!=='string'||!/^appgprj_[a-f0-9]{32}$/.test(siteProjectId))fail('V3_BRIDGE_CONFIGURATION_REQUIRED');
  this.publisher=publisher;this.executor=executor;this.db=publisher.db;this.siteProjectId=siteProjectId;this.mediaRoot=mediaRoot;
  this.db.exec(`CREATE TABLE IF NOT EXISTS publisher_v3_job_bindings(
    site_project_id TEXT NOT NULL,site_job_id TEXT NOT NULL PRIMARY KEY,
    site_workspace_id TEXT NOT NULL,site_account_id TEXT NOT NULL,site_snapshot_hash TEXT NOT NULL,
    local_workspace_id TEXT NOT NULL,local_account_id TEXT NOT NULL,local_job_id TEXT NOT NULL UNIQUE,
    local_snapshot_hash TEXT NOT NULL,created_at TEXT NOT NULL,
    FOREIGN KEY(local_job_id) REFERENCES publisher_jobs(id));`);
  this.db.exec(`CREATE TABLE IF NOT EXISTS publisher_v3_account_mappings(
    site_workspace_id TEXT NOT NULL,site_account_id TEXT NOT NULL,local_workspace_id TEXT NOT NULL,
    local_account_id TEXT NOT NULL UNIQUE,platform TEXT NOT NULL,external_identity TEXT NOT NULL,target_page_id TEXT,
    created_at TEXT NOT NULL,PRIMARY KEY(site_workspace_id,site_account_id));
    CREATE TABLE IF NOT EXISTS publisher_v3_prepare_requests(site_job_id TEXT PRIMARY KEY,request_hash TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS publisher_v3_task_approvals(site_job_id TEXT PRIMARY KEY,site_workspace_id TEXT NOT NULL,site_account_id TEXT NOT NULL,site_snapshot_hash TEXT NOT NULL,qa_receipt_hash TEXT NOT NULL,manifest_hash TEXT NOT NULL,approved_by TEXT NOT NULL,approved_at TEXT NOT NULL,revoked_at TEXT);`);
 }
 bindAccount(input,{authority}={}){
  requireProductionAdmin(authority);
  const keys=['site_workspace_id','site_account_id','local_workspace_id','local_account_id','platform','external_identity','target_page_id'];
  if(!input||Object.keys(input).sort().join()!==keys.sort().join()||!uuid(input.site_workspace_id)||!uuid(input.site_account_id)||typeof input.local_workspace_id!=='string'||!input.local_workspace_id||typeof input.local_account_id!=='string'||!input.local_account_id||typeof input.platform!=='string'||!input.platform||typeof input.external_identity!=='string'||!input.external_identity)fail('V3_ACCOUNT_MAPPING_INVALID');
  const account=this.publisher.account(input.local_workspace_id,input.local_account_id);
  if(account.platform!==input.platform||account.external_id!==input.external_identity||!account.enabled||(input.platform==='facebook'?(input.target_page_id!==account.target_page_id||!/^\d+$/.test(String(input.target_page_id||''))):input.target_page_id!==null))fail('V3_ACCOUNT_IDENTITY_MISMATCH');
  return this.publisher.store.tx(()=>{
   const prior=this.db.prepare('SELECT * FROM publisher_v3_account_mappings WHERE (site_workspace_id=? AND site_account_id=?) OR local_account_id=?').all(input.site_workspace_id,input.site_account_id,input.local_account_id);
   if(prior.length){if(prior.length!==1||keys.some(key=>prior[0][key]!==input[key]))fail('V3_ACCOUNT_MAPPING_CONFLICT');return {mapped:true,duplicate:true};}
   this.db.prepare('INSERT INTO publisher_v3_account_mappings VALUES(?,?,?,?,?,?,?,?)').run(input.site_workspace_id,input.site_account_id,input.local_workspace_id,input.local_account_id,input.platform,input.external_identity,input.target_page_id,new Date().toISOString());
   return {mapped:true,duplicate:false};
  });
 }
 approveSiteTask(input,{authority}={}){
  requireProductionAdmin(authority);
  const keys=['site_job_id','site_workspace_id','site_account_id','site_snapshot_hash','qa_receipt_hash','manifest_hash'];
  if(!input||Object.keys(input).sort().join()!==keys.sort().join()||!uuid(input.site_job_id)||!uuid(input.site_workspace_id)||!uuid(input.site_account_id)||!sha(input.site_snapshot_hash)||!sha(input.qa_receipt_hash)||!sha(input.manifest_hash))fail('V3_TASK_APPROVAL_INVALID');
  const mapping=this.db.prepare('SELECT 1 FROM publisher_v3_account_mappings WHERE site_workspace_id=? AND site_account_id=?').get(input.site_workspace_id,input.site_account_id);if(!mapping)fail('V3_ACCOUNT_MAPPING_REQUIRED');
  return this.publisher.store.tx(()=>{const prior=this.db.prepare('SELECT * FROM publisher_v3_task_approvals WHERE site_job_id=?').get(input.site_job_id);if(prior){if(keys.some(k=>prior[k]!==input[k])||prior.revoked_at)fail('V3_TASK_APPROVAL_CONFLICT');return {approved:true,duplicate:true};}this.db.prepare('INSERT INTO publisher_v3_task_approvals VALUES(?,?,?,?,?,?,?,?,NULL)').run(input.site_job_id,input.site_workspace_id,input.site_account_id,input.site_snapshot_hash,input.qa_receipt_hash,input.manifest_hash,authority.actor_id,new Date().toISOString());return {approved:true,duplicate:false};});
 }
 revokeSiteTask(siteJobId,{authority}={}){
  requireProductionAdmin(authority);if(!uuid(siteJobId))fail('V3_JOB_ID_INVALID');
  return this.publisher.store.tx(()=>{const changed=this.db.prepare('UPDATE publisher_v3_task_approvals SET revoked_at=? WHERE site_job_id=? AND revoked_at IS NULL').run(new Date().toISOString(),siteJobId);if(changed.changes!==1)fail('V3_TASK_APPROVAL_NOT_ACTIVE');return {revoked:true,site_job_id:siteJobId};});
 }
 async prepare(input,{allowedWorkspace}={}){
  const keys=['site_job_id','site_workspace_id','site_account_id','site_snapshot_hash','platform','external_identity','qa_receipt_hash','title','body','payload','media'];
  if(!input||Object.keys(input).sort().join()!==keys.sort().join()||!uuid(input.site_job_id)||!uuid(input.site_workspace_id)||!uuid(input.site_account_id)||!sha(input.site_snapshot_hash)||!sha(input.qa_receipt_hash)||typeof input.title!=='string'||!input.title.trim()||typeof input.body!=='string'||!input.body.trim()||!input.payload||typeof input.payload!=='object'||Array.isArray(input.payload)||!Array.isArray(input.media)||input.media.length>10||!this.mediaRoot)fail('V3_PREPARE_INVALID');
  const mapping=this.db.prepare('SELECT * FROM publisher_v3_account_mappings WHERE site_workspace_id=? AND site_account_id=?').get(input.site_workspace_id,input.site_account_id);
  if(!mapping||mapping.local_workspace_id!==allowedWorkspace||mapping.platform!==input.platform||mapping.external_identity!==input.external_identity)fail('V3_ACCOUNT_MAPPING_REQUIRED');
  const approval=this.db.prepare('SELECT * FROM publisher_v3_task_approvals WHERE site_job_id=?').get(input.site_job_id);
  if(!approval||approval.revoked_at||approval.site_workspace_id!==input.site_workspace_id||approval.site_account_id!==input.site_account_id||approval.site_snapshot_hash!==input.site_snapshot_hash||approval.qa_receipt_hash!==input.qa_receipt_hash||approval.manifest_hash!==preparedManifestHash(input))fail('V3_TASK_APPROVAL_REQUIRED');
  const account=this.publisher.account(mapping.local_workspace_id,mapping.local_account_id);
  if(!account.enabled||account.platform!==input.platform||account.external_id!==input.external_identity||input.platform==='facebook'&&account.target_page_id!==mapping.target_page_id)fail('V3_ACCOUNT_IDENTITY_MISMATCH');
  if(input.media.some((m,i)=>!m||typeof m!=='object'||Array.isArray(m)||Object.keys(m).sort().join()!=='mime,ordinal,sha256,size'||m.ordinal!==i))fail('V3_MEDIA_ORDER_INVALID');
  const media=[];for(const m of input.media)media.push(await verifyV3StagedMedia({ordinal:m.ordinal,mime:m.mime,sha256:m.sha256,size:m.size,root:this.mediaRoot,siteJobId:input.site_job_id}));
  const requestHash=createHash('sha256').update(JSON.stringify(input)).digest('hex');
  this.publisher.store.tx(()=>{const old=this.db.prepare('SELECT request_hash FROM publisher_v3_prepare_requests WHERE site_job_id=?').get(input.site_job_id);if(old&&old.request_hash!==requestHash)fail('V3_PREPARE_CONFLICT');if(!old)this.db.prepare('INSERT INTO publisher_v3_prepare_requests VALUES(?,?,?)').run(input.site_job_id,requestHash,new Date().toISOString());});
  const content=this.publisher.importContent(mapping.local_workspace_id,{source_id:'sites:'+this.siteProjectId+':'+input.site_job_id,revision:input.site_snapshot_hash,title:input.title,body:input.body,media,platform_payloads:{[input.platform]:{...input.payload,media}}});
  const job=this.publisher.createPageJob(mapping.local_workspace_id,{account_id:mapping.local_account_id,content_id:content.id});
  if(job.state==='DRAFT')this.executor.approve(mapping.local_workspace_id,job.id,job.snapshot_hash);
  this.#bind({site_project_id:this.siteProjectId,site_job_id:input.site_job_id,site_workspace_id:input.site_workspace_id,site_account_id:input.site_account_id,site_snapshot_hash:input.site_snapshot_hash,local_workspace_id:mapping.local_workspace_id,local_account_id:mapping.local_account_id,local_job_id:job.id,local_snapshot_hash:job.snapshot_hash});
  return this.capability(input.site_job_id);
 }
 /** Only an existing local admin may bind a previously reviewed local job to
  * one exact Sites draft. No HTTP body may supply the admin authority object.
  */
 bind(input,{authority}={}){
  requireProductionAdmin(authority);
  fail('V3_LEGACY_BIND_DISABLED');
 }
 #bind(input){
  const keys=['site_project_id','site_job_id','site_workspace_id','site_account_id','site_snapshot_hash','local_workspace_id','local_account_id','local_job_id','local_snapshot_hash'];
  if(!input||Object.keys(input).sort().join()!==keys.sort().join()||input.site_project_id!==this.siteProjectId||!uuid(input.site_job_id)||!uuid(input.site_workspace_id)||!uuid(input.site_account_id)||!sha(input.site_snapshot_hash)||!sha(input.local_snapshot_hash)||!input.local_workspace_id||!input.local_account_id||!uuid(input.local_job_id))fail('V3_BINDING_INVALID');
  return this.publisher.store.tx(()=>{
   const job=this.publisher.job(input.local_workspace_id,input.local_job_id);
   if(job.account_id!==input.local_account_id||job.snapshot_hash!==input.local_snapshot_hash||!['DRAFT','READY'].includes(job.state))fail('V3_LOCAL_JOB_CHANGED');
   const source=this.db.prepare('SELECT content_id FROM publisher_content_sources WHERE workspace=? AND source_id=? AND revision=?').get(input.local_workspace_id,'sites:'+this.siteProjectId+':'+input.site_job_id,input.site_snapshot_hash);
   if(!source||source.content_id!==job.content_id)fail('V3_SITE_SOURCE_NOT_IMPORTED');
   this.publisher.assertCurrent(job);
   const prior=this.db.prepare('SELECT * FROM publisher_v3_job_bindings WHERE site_job_id=? OR local_job_id=?').all(input.site_job_id,input.local_job_id);
   if(prior.length){if(prior.length!==1||keys.some(key=>prior[0][key]!==input[key]))fail('V3_BINDING_CONFLICT');return {site_job_id:input.site_job_id,local_job_id:input.local_job_id,duplicate:true};}
   this.db.prepare('INSERT INTO publisher_v3_job_bindings VALUES(?,?,?,?,?,?,?,?,?,?)').run(input.site_project_id,input.site_job_id,input.site_workspace_id,input.site_account_id,input.site_snapshot_hash,input.local_workspace_id,input.local_account_id,input.local_job_id,input.local_snapshot_hash,new Date().toISOString());
   return {site_job_id:input.site_job_id,local_job_id:input.local_job_id,duplicate:false};
  });
 }
 binding(siteJobId){if(!uuid(siteJobId))fail('V3_JOB_ID_INVALID');const row=this.db.prepare('SELECT * FROM publisher_v3_job_bindings WHERE site_project_id=? AND site_job_id=?').get(this.siteProjectId,siteJobId);if(!row)fail('V3_BINDING_NOT_FOUND');return row;}
 current(siteJobId){
  const link=this.binding(siteJobId),job=this.publisher.job(link.local_workspace_id,link.local_job_id);
  if(job.account_id!==link.local_account_id||job.snapshot_hash!==link.local_snapshot_hash)fail('V3_LOCAL_JOB_CHANGED');
  return {link,job};
 }
 status(siteJobId){
  const {link,job}=this.current(siteJobId),receipt=this.db.prepare('SELECT platform_id,platform_url,created_at FROM publisher_submit_receipts WHERE job_id=?').get(job.id);
  const publicationVerified=['PUBLISHED','PUBLISHED_ID_PENDING'].includes(job.state)&&job.evidence?.verified===true&&job.evidence?.syntheticOnly!==true&&!job.snapshot?.productionReview;
  return {site_job_id:siteJobId,site_workspace_id:link.site_workspace_id,site_account_id:link.site_account_id,site_snapshot_hash:link.site_snapshot_hash,local_job_id:job.id,local_snapshot_hash:job.snapshot_hash,state:job.state,attempt_id:job.attempt_id,platform_id:publicationVerified?(job.evidence?.id||receipt?.platform_id||null):null,platform_url:publicationVerified?(job.evidence?.url||receipt?.platform_url||null):null,platform_time:publicationVerified?(job.evidence?.publishedAt||job.evidence?.published_at||null):null,verified:publicationVerified,draft_verified:job.state==='DRAFT_WRITTEN'&&job.evidence?.verified===true,pending_receipt:!!receipt&&!publicationVerified,evidence_origin:publicationVerified?'MAC_UNIFIED_EXECUTOR_READBACK':null,readback:publicationVerified?{content_hash:job.evidence.contentHash||null,payload_hash:job.evidence.payloadHash||null,media_verified:job.evidence.mediaVerified===true,observed_times:job.evidence.observedTimes||null}:null,updated_at:job.updated_at};
 }
 capability(siteJobId){const {link,job}=this.current(siteJobId);return {...this.status(siteJobId),capability:this.executor.executionCapability(link.local_workspace_id,job.id)};}
 async dispatch(siteJobId,input={}){
  const {link,job}=this.current(siteJobId);
  const approval=this.db.prepare('SELECT revoked_at,site_snapshot_hash FROM publisher_v3_task_approvals WHERE site_job_id=?').get(siteJobId);
  if(!approval||approval.revoked_at||approval.site_snapshot_hash!==link.site_snapshot_hash)fail('V3_TASK_APPROVAL_REQUIRED');
  if(Object.keys(input).sort().join()!=='confirm,local_snapshot_hash,site_snapshot_hash'||input.confirm!==true||input.local_snapshot_hash!==link.local_snapshot_hash||input.site_snapshot_hash!==link.site_snapshot_hash)fail('V3_EXACT_CONFIRMATION_REQUIRED');
  if(job.state!=='READY')return {...this.status(siteJobId),already_claimed:true};
  const capability=this.executor.executionCapability(link.local_workspace_id,job.id);
  if(capability.canExecute!==true)fail('V3_LOCAL_EXECUTION_UNAVAILABLE');
  await this.executor.execute(link.local_workspace_id,job.id,{confirm:true,snapshot_hash:job.snapshot_hash});
  return this.status(siteJobId);
 }
 async reconcile(siteJobId,input={}){
  const {link,job}=this.current(siteJobId);
  if(job.state!=='UNKNOWN')return this.status(siteJobId);
  if(Object.keys(input).some(key=>!['platform_id','local_snapshot_hash','site_snapshot_hash'].includes(key))||input.local_snapshot_hash!==link.local_snapshot_hash||input.site_snapshot_hash!==link.site_snapshot_hash)fail('V3_EXACT_RECONCILIATION_REQUIRED');
  await this.executor.reconcile(link.local_workspace_id,job.id,input.platform_id?{platform_id:input.platform_id}:{});
  return this.status(siteJobId);
 }
}

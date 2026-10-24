import {requireProductionAdmin} from './production-approval-policy.js';

const sha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const fail=code=>{throw Error(code);};

/** A dormant Mac-side adapter. It never opens a browser or changes an execution
 * switch by itself. The local Publisher remains the sole authority for quota,
 * profile locks, media hashes, submit intent, and UNKNOWN reconciliation.
 * The Sites job ID is a correlation key, never an execution permission.
 */
export class V3MacExecutionBridge {
 constructor(publisher,executor,{siteProjectId}={}){
  if(!publisher?.store?.tx||!publisher?.db||!executor||typeof siteProjectId!=='string'||!/^appgprj_[a-f0-9]{32}$/.test(siteProjectId))fail('V3_BRIDGE_CONFIGURATION_REQUIRED');
  this.publisher=publisher;this.executor=executor;this.db=publisher.db;this.siteProjectId=siteProjectId;
  this.db.exec(`CREATE TABLE IF NOT EXISTS publisher_v3_job_bindings(
    site_project_id TEXT NOT NULL,site_job_id TEXT NOT NULL PRIMARY KEY,
    site_workspace_id TEXT NOT NULL,site_account_id TEXT NOT NULL,site_snapshot_hash TEXT NOT NULL,
    local_workspace_id TEXT NOT NULL,local_account_id TEXT NOT NULL,local_job_id TEXT NOT NULL UNIQUE,
    local_snapshot_hash TEXT NOT NULL,created_at TEXT NOT NULL,
    FOREIGN KEY(local_job_id) REFERENCES publisher_jobs(id));`);
 }
 /** Only an existing local admin may bind a previously reviewed local job to
  * one exact Sites draft. No HTTP body may supply the admin authority object.
  */
 bind(input,{authority}={}){
  requireProductionAdmin(authority);
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
  return {site_job_id:siteJobId,site_workspace_id:link.site_workspace_id,site_account_id:link.site_account_id,site_snapshot_hash:link.site_snapshot_hash,local_job_id:job.id,local_snapshot_hash:job.snapshot_hash,state:job.state,attempt_id:job.attempt_id,platform_id:receipt?.platform_id||job.evidence?.id||null,platform_url:receipt?.platform_url||job.evidence?.url||null,platform_time:job.evidence?.publishedAt||job.evidence?.published_at||null,verified:job.evidence?.verified===true,updated_at:job.updated_at};
 }
 capability(siteJobId){const {link,job}=this.current(siteJobId);return {...this.status(siteJobId),capability:this.executor.executionCapability(link.local_workspace_id,job.id)};}
 async dispatch(siteJobId,input={}){
  const {link,job}=this.current(siteJobId);
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

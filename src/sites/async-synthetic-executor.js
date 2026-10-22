import {AsyncExecutionPermits} from './async-execution-permits.js';
import {AsyncStorage,exact,fail} from './async-storage.js';
import {AsyncUploadPlans} from './async-upload-plans.js';
import {requireProductionAdmin} from '../production-approval-policy.js';
import {publishingPlatforms} from '../publisher-platform-policy.js';
const flags={synthetic_only:true,publish_allowed:false,real_execution_allowed:false};
const pending=()=>({state:'UNKNOWN',next_action:'RECONCILE_PENDING',readback_pending:true,reason:'STORAGE_OUTCOME_UNCONFIRMED',...flags});
const fatal=error=>/EXECUTION_CLAIM_(?:REQUIRED|BINDING_INVALID)|SCOPE_DENIED|SYNTHETIC_(?:(?:ATTEMPT|READBACK)_BINDING_INVALID|ATTEMPT_REQUIRED)|PRODUCTION_(?:FROZEN_SNAPSHOT_CHANGED|PLAN_(?:CORRUPT|NOT_FOUND))/.test(error.message);
/** Closed counterpart of synthetic-publication-driver. No injected driver,
 * fetch, browser, credentials, HTTP route or real quota/permit is accepted.
 * Uses the prepared original job. Confirmation is separately SYNTHETIC_ONLY.
 */
export class AsyncSyntheticExecutor extends AsyncStorage {
 constructor(db,options={}){super(db,options);this.plans=new AsyncUploadPlans(db,options);this.permits=new AsyncExecutionPermits(db,options);this.requireExecutionPermit=options.requireExecutionPermit===true||options.legacySyntheticRehearsal!==true;this.fault='NONE';}
 setFault(fault){if(!['NONE','UPLOAD_FAILED','SUBMIT_RESPONSE_LOST','READBACK_UNAVAILABLE','CRASH_AFTER_INTENT'].includes(fault))fail('SYNTHETIC_FAULT_INVALID');this.fault=fault;}
 async attempt(id){return this.one('SELECT * FROM sites_synthetic_attempts WHERE plan_id=?',[id]);}
 async run(id,input,scope,{authority}={}){
  requireProductionAdmin(authority);exact(input,['confirmation','snapshot_hash'],'SYNTHETIC_CONFIRMATION_REQUIRED');if(input.confirmation!=='SYNTHETIC_ONLY')fail('SYNTHETIC_CONFIRMATION_REQUIRED');
  const {p,manifest,job}=await this.plans.read(id,scope);if(input.snapshot_hash!==job.snapshot_hash)fail('PRODUCTION_FROZEN_SNAPSHOT_CHANGED');
  if(await this.attempt(id))return this.reconcile(id,scope);
  const view=await this.plans.view(id,scope);if(view.status!=='UPLOAD_PREVIEW_ONLY')fail('PRODUCTION_APPROVAL_CHANGED');const subject=await this.plans.approvals.subject(p.review_id,scope);if(subject.blocked||subject.fingerprint!==p.subject_fingerprint)fail('PRODUCTION_APPROVAL_CHANGED');
  const attempt=crypto.randomUUID(),at=new Date().toISOString(),data={p,manifest,job};
  const quotaStatements=this.requireExecutionPermit||await this.permits.required(job)?await this.permits.claimStatements(data,scope,attempt):[];
  try{await this.batch([...this.plans.approvals.subjectGuards(subject),this.plans.approvals.latestGuard(p.review_id,p.approval_event_id),this.guard("EXISTS(SELECT 1 FROM publisher_jobs WHERE id=? AND state='DRAFT' AND attempt_id IS NULL AND snapshot_hash=?)",[job.id,job.snapshot_hash]),this.statement("INSERT INTO sites_synthetic_attempts VALUES(?,?,?,?,?,'PREPARING',?)",[id,attempt,job.id,job.snapshot_hash,authority.actor_id,at]),this.statement("UPDATE publisher_jobs SET state='PREPARING',attempt_id=?,updated_at=? WHERE id=?",[attempt,at,job.id]),...quotaStatements]);}
  catch(error){if(fatal(error))throw error;let claimed;try{claimed=await this.attempt(id);}catch(readError){if(fatal(readError))throw readError;return pending();}if(!claimed)throw error;return this.recover(id,scope);}
  try{
   for(const a of manifest.media){const read=await this.plans.approvals.reviews.objects.verify(a.object_id,scope);if(read.sha256!==a.sha256||read.data.byteLength!==a.bytes)fail('PRODUCTION_MEDIA_CHANGED');}
   if(this.fault==='UPLOAD_FAILED')fail('SYNTHETIC_UPLOAD_FAILED');
   // Recheck approval and consumed permit after media IO, atomically with intent.
   const quotaIntent=await this.permits.intentStatements(data,scope,attempt);
   await this.batch([...this.plans.approvals.subjectGuards(subject),this.plans.approvals.latestGuard(p.review_id,p.approval_event_id),this.guard("EXISTS(SELECT 1 FROM sites_synthetic_attempts WHERE plan_id=? AND attempt_id=? AND state='PREPARING')",[id,attempt]),this.statement("UPDATE sites_synthetic_attempts SET state='SUBMITTING' WHERE plan_id=?",[id]),this.statement("UPDATE publisher_jobs SET state='SUBMITTING' WHERE id=? AND attempt_id=?",[job.id,attempt]),...quotaIntent]);
  }catch(error){if(fatal(error))throw error;return this.recover(id,scope,{closePreparation:true});}
  if(this.fault!=='CRASH_AFTER_INTENT'){
   // A separate closed simulated platform commit: lost response cannot justify
   // another INSERT. There is no automatic retry at this boundary.
   try{const dispatch=await this.permits.dispatchStatements(data,scope,attempt);await this.batch([...dispatch,this.guard("EXISTS(SELECT 1 FROM sites_synthetic_attempts WHERE plan_id=? AND attempt_id=? AND state='SUBMITTING')",[id,attempt]),this.statement('INSERT INTO sites_synthetic_objects VALUES(?,?,?,?,?)',[id,attempt,'synthetic-'+id,job.snapshot_hash,JSON.stringify(manifest.media)])]);}
   catch(error){if(fatal(error))throw error;return this.recover(id,scope);}
  }
  if(['SUBMIT_RESPONSE_LOST','CRASH_AFTER_INTENT'].includes(this.fault)){try{await this.markUnknown(await this.context(id,scope));return {state:'UNKNOWN',next_action:'RECONCILE_PENDING',...flags};}catch(error){if(fatal(error))throw error;return this.observeAfterError(id,scope);}}
  return this.reconcile(id,scope);
 }

 // Every outcome read joins job/attempt/object/receipt in one SQL statement, so
 // another reconciler cannot make a mixed-version read look like corruption.
 async context(id,scope){
  const {p,manifest,job}=await this.plans.read(id,scope);
  const row=await this.one(`SELECT a.*,j.state job_state,j.attempt_id job_attempt_id,j.snapshot_hash job_snapshot_hash,r.evidence_json,o.object_id,o.attempt_id object_attempt_id,o.snapshot_hash object_snapshot_hash,o.media_json,v.task_id,q.state quota_state,q.attempt_id quota_attempt,q.permit_id quota_permit,q.scope_hash quota_scope_hash,q.snapshot_hash quota_snapshot_hash,q.workspace quota_workspace,q.account_id quota_account,ep.scope_hash permit_scope_hash,ep.status permit_status,ep.attempt_id permit_attempt
   FROM sites_synthetic_attempts a JOIN publisher_jobs j ON j.id=a.job_id
   JOIN sites_reviews v ON v.id=? AND v.workspace=j.workspace AND v.account_id=j.account_id
   LEFT JOIN sites_synthetic_readbacks r ON r.plan_id=a.plan_id
   LEFT JOIN sites_synthetic_objects o ON o.plan_id=a.plan_id
   LEFT JOIN sites_execution_claims q ON q.job_id=j.id LEFT JOIN sites_execution_permits ep ON ep.id=q.permit_id
   WHERE a.plan_id=? AND j.id=? AND j.workspace=? AND j.account_id=?`,[p.review_id,id,job.id,scope.workspace,scope.accountId]);
  if(!row)fail('SYNTHETIC_ATTEMPT_REQUIRED');
  if(row.snapshot_hash!==job.snapshot_hash||row.job_snapshot_hash!==job.snapshot_hash||row.attempt_id!==row.job_attempt_id||row.job_id!==job.id)fail('SYNTHETIC_ATTEMPT_BINDING_INVALID');
  if(this.requireExecutionPermit&&row.quota_state===null)fail('EXECUTION_CLAIM_REQUIRED');
  if(row.quota_state!==null&&(row.quota_attempt!==row.attempt_id||row.permit_attempt!==row.attempt_id||row.permit_status!=='CONSUMED'||row.quota_scope_hash!==row.permit_scope_hash||row.quota_snapshot_hash!==job.snapshot_hash||row.quota_workspace!==scope.workspace||row.quota_account!==scope.accountId||row.quota_state!==({PREPARING:'RESERVED',SUBMITTING:'SUBMITTING',UNKNOWN:'UNKNOWN',VERIFIED:'SETTLED',UPLOAD_FAILED:'RELEASED'}[row.state])))fail('EXECUTION_CLAIM_BINDING_INVALID');
  return {id,p,manifest,job:{...job,state:row.job_state,attempt_id:row.job_attempt_id},row,scope};
 }
 expectedEvidence(c){const {p,manifest,job,row,scope}=c;return {verified:true,syntheticOnly:true,method:'LOCAL_SYNTHETIC_READBACK',workspace:scope.workspace,account_id:scope.accountId,platform:manifest.platform,task_id:row.task_id,publication_job_id:job.id,attempt_id:row.attempt_id,review_id:p.review_id,snapshot_hash:job.snapshot_hash,object_id:row.object_id,media:manifest.media,outcome:publishingPlatforms[manifest.platform].outcome,...(manifest.platform==='wechat_official_account'?{formalPublication:false}:{}),...(manifest.platform==='wechat_channels'?{publicLinkUnavailable:true}:{})};}
 objectMatches(c){const {row,job,manifest}=c;return row.object_id==='synthetic-'+c.id&&row.object_attempt_id===row.attempt_id&&row.object_snapshot_hash===job.snapshot_hash&&row.media_json===JSON.stringify(manifest.media);}
 observed(c){const {row,job}=c;
  if(row.evidence_json!==null){const expected=this.expectedEvidence(c);if(!this.objectMatches(c)||row.evidence_json!==JSON.stringify(expected)||row.state!=='VERIFIED'||job.state!==expected.outcome)fail('SYNTHETIC_READBACK_BINDING_INVALID');return {state:expected.outcome,evidence:expected,...flags};}
  if(row.state==='VERIFIED'||['PUBLISHED','DRAFT_WRITTEN','PUBLISHED_ID_PENDING'].includes(job.state))fail('SYNTHETIC_READBACK_BINDING_INVALID');
  if(row.state==='UPLOAD_FAILED'){if(job.state!=='BLOCKED'||row.object_id!==null)fail('SYNTHETIC_ATTEMPT_BINDING_INVALID');return {state:'BLOCKED',...flags};}
  if(row.state==='PREPARING'){if(job.state!=='PREPARING'||row.object_id!==null)fail('SYNTHETIC_ATTEMPT_BINDING_INVALID');return {state:'PREPARING',next_action:'RECONCILE_PENDING',...flags};}
  if(!['SUBMITTING','UNKNOWN'].includes(row.state)||!['SUBMITTING','UNKNOWN'].includes(job.state))fail('SYNTHETIC_ATTEMPT_BINDING_INVALID');
  return {state:'UNKNOWN',next_action:'RECONCILE_PENDING',...flags};
 }
 contextGuard(c){return this.guard('EXISTS(SELECT 1 FROM sites_synthetic_attempts a JOIN publisher_jobs j ON j.id=a.job_id WHERE a.plan_id=? AND a.attempt_id=? AND a.snapshot_hash=? AND a.state=? AND j.id=? AND j.workspace=? AND j.account_id=? AND j.snapshot_hash=? AND j.attempt_id=? AND j.state=?)',[c.id,c.row.attempt_id,c.job.snapshot_hash,c.row.state,c.job.id,c.scope.workspace,c.scope.accountId,c.job.snapshot_hash,c.row.attempt_id,c.job.state]);}
 async markUnknown(c){await this.batch([this.contextGuard(c),this.guard("EXISTS(SELECT 1 FROM sites_synthetic_attempts WHERE plan_id=? AND state IN ('SUBMITTING','UNKNOWN'))",[c.id]),this.statement("UPDATE sites_synthetic_attempts SET state='UNKNOWN' WHERE plan_id=?",[c.id]),this.statement("UPDATE publisher_jobs SET state='UNKNOWN' WHERE id=?",[c.job.id]),...this.permits.transitionStatements(c,'UNKNOWN')]);}
 async observeAfterError(id,scope){try{const outcome=this.observed(await this.context(id,scope));return ['UNKNOWN','PREPARING'].includes(outcome.state)?{...outcome,readback_pending:true}:outcome;}catch(error){if(fatal(error))throw error;return pending();}}
 async cancelPreparation(id,input,scope,{authority}={}){
  requireProductionAdmin(authority);exact(input,['expected_attempt_id','snapshot_hash','reason'],'SYNTHETIC_PREPARATION_CANCELLATION_REQUIRED');
  const c=await this.context(id,scope);if(c.row.state!=='PREPARING'||c.job.state!=='PREPARING'||input.expected_attempt_id!==c.row.attempt_id||input.snapshot_hash!==c.job.snapshot_hash||typeof input.reason!=='string'||!input.reason.trim()||input.reason.length>500)fail('SYNTHETIC_PREPARATION_CANCELLATION_REQUIRED');
  return this.recover(id,scope,{closePreparation:true,reason:input.reason});
 }
 async recover(id,scope,{closePreparation=false,reason=null}={}){
  try{
   const c=await this.context(id,scope),outcome=this.observed(c);
   if(closePreparation&&outcome.state==='PREPARING'){
    try{await this.batch([this.contextGuard(c),this.guard('NOT EXISTS(SELECT 1 FROM sites_synthetic_objects WHERE plan_id=?) AND NOT EXISTS(SELECT 1 FROM sites_synthetic_readbacks WHERE plan_id=?)',[id,id]),this.statement("UPDATE sites_synthetic_attempts SET state='UPLOAD_FAILED' WHERE plan_id=?",[id]),this.statement("UPDATE publisher_jobs SET state='BLOCKED' WHERE id=?",[c.job.id]),...this.permits.transitionStatements(c,'RELEASED',{reason})]);}
    catch(error){if(fatal(error))throw error;return this.observeAfterError(id,scope);}
   }
   return await this.reconcile(id,scope);
  }catch(error){if(fatal(error))throw error;return pending();}
 }
 async reconcile(id,scope){
  // Reads or reconciles only the original intent. No path calls run/submit.
  let c;try{c=await this.context(id,scope);}catch(error){if(fatal(error)||error.message==='SYNTHETIC_ATTEMPT_REQUIRED')throw error;return pending();}const observed=this.observed(c);
  if(c.row.evidence_json!==null||['BLOCKED','PREPARING'].includes(observed.state))return observed;
  if(this.fault==='READBACK_UNAVAILABLE'||!this.objectMatches(c)){
   if(c.row.state==='UNKNOWN'&&c.job.state==='UNKNOWN')return observed;
   try{await this.markUnknown(c);return observed;}catch(error){if(fatal(error))throw error;return this.observeAfterError(id,scope);}
  }
  const evidence=this.expectedEvidence(c),encoded=JSON.stringify(evidence);
  try{await this.batch([this.contextGuard(c),this.guard('EXISTS(SELECT 1 FROM sites_synthetic_objects WHERE plan_id=? AND attempt_id=? AND object_id=? AND snapshot_hash=? AND media_json=?)',[id,c.row.attempt_id,c.row.object_id,c.job.snapshot_hash,c.row.media_json]),this.statement('INSERT INTO sites_synthetic_readbacks VALUES(?,?) ON CONFLICT(plan_id) DO NOTHING',[id,encoded]),this.guard('EXISTS(SELECT 1 FROM sites_synthetic_readbacks WHERE plan_id=? AND evidence_json=?)',[id,encoded]),this.statement("UPDATE sites_synthetic_attempts SET state='VERIFIED' WHERE plan_id=?",[id]),this.statement('UPDATE publisher_jobs SET state=? WHERE id=? AND attempt_id=?',[evidence.outcome,c.job.id,c.row.attempt_id]),...this.permits.transitionStatements(c,'SETTLED')]);}
  catch(error){if(fatal(error))throw error;return this.observeAfterError(id,scope);}
  return {state:evidence.outcome,evidence,...flags};
 }
}

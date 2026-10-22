import {AsyncStorage,exact,fail} from './async-storage.js';
import {AsyncUploadPlans} from './async-upload-plans.js';
import {requireProductionAdmin} from '../production-approval-policy.js';
import {publishingPlatforms} from '../publisher-platform-policy.js';
const flags={synthetic_only:true,publish_allowed:false,real_execution_allowed:false};
/** Closed counterpart of synthetic-publication-driver. No injected driver,
 * fetch, browser, credentials, HTTP route or real quota/permit is accepted.
 * Uses the prepared original job. Confirmation is separately SYNTHETIC_ONLY.
 */
export class AsyncSyntheticExecutor extends AsyncStorage {
 constructor(db,options={}){super(db,options);this.plans=new AsyncUploadPlans(db,options);this.fault='NONE';}
 setFault(fault){if(!['NONE','UPLOAD_FAILED','SUBMIT_RESPONSE_LOST','READBACK_UNAVAILABLE','CRASH_AFTER_INTENT'].includes(fault))fail('SYNTHETIC_FAULT_INVALID');this.fault=fault;}
 async attempt(id){return this.one('SELECT * FROM sites_synthetic_attempts WHERE plan_id=?',[id]);}
 async run(id,input,scope,{authority}={}){
  requireProductionAdmin(authority);exact(input,['confirmation','snapshot_hash'],'SYNTHETIC_CONFIRMATION_REQUIRED');if(input.confirmation!=='SYNTHETIC_ONLY')fail('SYNTHETIC_CONFIRMATION_REQUIRED');
  const {p,manifest,job}=await this.plans.read(id,scope);if(input.snapshot_hash!==job.snapshot_hash)fail('PRODUCTION_FROZEN_SNAPSHOT_CHANGED');
  if(await this.attempt(id))return this.reconcile(id,scope);
  const view=await this.plans.view(id,scope);if(view.status!=='UPLOAD_PREVIEW_ONLY')fail('PRODUCTION_APPROVAL_CHANGED');const subject=await this.plans.approvals.subject(p.review_id,scope);if(subject.blocked||subject.fingerprint!==p.subject_fingerprint)fail('PRODUCTION_APPROVAL_CHANGED');
  const attempt=crypto.randomUUID(),at=new Date().toISOString();
  try{await this.batch([...this.plans.approvals.subjectGuards(subject),this.plans.approvals.latestGuard(p.review_id,p.approval_event_id),this.guard("EXISTS(SELECT 1 FROM publisher_jobs WHERE id=? AND state='DRAFT' AND attempt_id IS NULL AND snapshot_hash=?)",[job.id,job.snapshot_hash]),this.statement("INSERT INTO sites_synthetic_attempts VALUES(?,?,?,?,?,'PREPARING',?)",[id,attempt,job.id,job.snapshot_hash,authority.actor_id,at]),this.statement("UPDATE publisher_jobs SET state='PREPARING',attempt_id=?,updated_at=? WHERE id=?",[attempt,at,job.id])]);}
  catch(error){if(await this.attempt(id))return this.reconcile(id,scope);throw error;}
  try{
   for(const a of manifest.media){const read=await this.plans.approvals.reviews.objects.verify(a.object_id,scope);if(read.sha256!==a.sha256||read.data.byteLength!==a.bytes)fail('PRODUCTION_MEDIA_CHANGED');}
   if(this.fault==='UPLOAD_FAILED')fail('SYNTHETIC_UPLOAD_FAILED');
   // Recheck approval after asynchronous media preparation, atomically with intent.
   await this.batch([...this.plans.approvals.subjectGuards(subject),this.plans.approvals.latestGuard(p.review_id,p.approval_event_id),this.guard("EXISTS(SELECT 1 FROM sites_synthetic_attempts WHERE plan_id=? AND attempt_id=? AND state='PREPARING')",[id,attempt]),this.statement("UPDATE sites_synthetic_attempts SET state='SUBMITTING' WHERE plan_id=?",[id]),this.statement("UPDATE publisher_jobs SET state='SUBMITTING' WHERE id=? AND attempt_id=?",[job.id,attempt])]);
  }catch(error){await this.batch([this.statement("UPDATE sites_synthetic_attempts SET state='UPLOAD_FAILED' WHERE plan_id=? AND state='PREPARING'",[id]),this.statement("UPDATE publisher_jobs SET state='BLOCKED' WHERE id=? AND state='PREPARING' AND attempt_id=?",[job.id,attempt])]);return {state:'BLOCKED',reason:'SYNTHETIC_PREPARATION_FAILED',...flags};}
  if(this.fault!=='CRASH_AFTER_INTENT'){
   // A separate closed simulated platform commit: lost response cannot justify
   // another INSERT. There is no automatic retry at this boundary.
   await this.batch([this.guard("EXISTS(SELECT 1 FROM sites_synthetic_attempts WHERE plan_id=? AND attempt_id=? AND state='SUBMITTING')",[id,attempt]),this.statement('INSERT INTO sites_synthetic_objects VALUES(?,?,?,?,?)',[id,attempt,'synthetic-'+id,job.snapshot_hash,JSON.stringify(manifest.media)])]);
  }
  if(['SUBMIT_RESPONSE_LOST','CRASH_AFTER_INTENT'].includes(this.fault)){await this.markUnknown(id,job.id);return {state:'UNKNOWN',next_action:'RECONCILE_PENDING',...flags};}
  return this.reconcile(id,scope);
 }
 async markUnknown(id,jobId){await this.batch([this.statement("UPDATE sites_synthetic_attempts SET state='UNKNOWN' WHERE plan_id=? AND state IN ('SUBMITTING','UNKNOWN')",[id]),this.statement("UPDATE publisher_jobs SET state='UNKNOWN' WHERE id=? AND state='SUBMITTING'",[jobId])]);}
 async reconcile(id,scope){
  // Reconcile the original frozen submission even after content approval is
  // withdrawn; current scope is still mandatory. Never calls run or submit.
  const {p,manifest,job}=await this.plans.read(id,scope),attempt=await this.attempt(id);if(!attempt)fail('SYNTHETIC_ATTEMPT_REQUIRED');
  const recorded=await this.one('SELECT evidence_json FROM sites_synthetic_readbacks WHERE plan_id=?',[id]);if(recorded)return {state:JSON.parse(recorded.evidence_json).outcome,evidence:JSON.parse(recorded.evidence_json),...flags};
  if(attempt.state==='UPLOAD_FAILED')return {state:'BLOCKED',...flags};if(attempt.state==='PREPARING')return {state:'PREPARING',next_action:'RECONCILE_PENDING',...flags};
  const object=this.fault==='READBACK_UNAVAILABLE'?null:await this.one('SELECT * FROM sites_synthetic_objects WHERE plan_id=?',[id]);
  if(!object||object.attempt_id!==attempt.attempt_id||object.snapshot_hash!==job.snapshot_hash||object.media_json!==JSON.stringify(manifest.media)){await this.markUnknown(id,job.id);return {state:'UNKNOWN',next_action:'RECONCILE_PENDING',...flags};}
  const review=await this.one('SELECT task_id FROM sites_reviews WHERE id=?',[p.review_id]),evidence={verified:true,syntheticOnly:true,method:'LOCAL_SYNTHETIC_READBACK',workspace:scope.workspace,account_id:scope.accountId,platform:manifest.platform,task_id:review.task_id,publication_job_id:job.id,attempt_id:attempt.attempt_id,review_id:p.review_id,snapshot_hash:job.snapshot_hash,object_id:object.object_id,media:manifest.media,outcome:publishingPlatforms[manifest.platform].outcome,...(manifest.platform==='wechat_official_account'?{formalPublication:false}:{}),...(manifest.platform==='wechat_channels'?{publicLinkUnavailable:true}:{})};
  await this.batch([this.guard('EXISTS(SELECT 1 FROM sites_synthetic_objects WHERE plan_id=? AND attempt_id=? AND snapshot_hash=? AND media_json=?)',[id,attempt.attempt_id,job.snapshot_hash,object.media_json]),this.statement('INSERT INTO sites_synthetic_readbacks VALUES(?,?) ON CONFLICT(plan_id) DO NOTHING',[id,JSON.stringify(evidence)]),this.statement("UPDATE sites_synthetic_attempts SET state='VERIFIED' WHERE plan_id=?",[id]),this.statement('UPDATE publisher_jobs SET state=? WHERE id=? AND attempt_id=?',[evidence.outcome,job.id,attempt.attempt_id])]);return {state:evidence.outcome,evidence,...flags};
 }
}

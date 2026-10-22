import {AsyncStorage,digest,sha256,fail} from './async-storage.js';
import {taskActionScopeEntries,taskActionDedupValue,scopedOperationLimits} from '../task-action-policy.js';
import {operatingDay} from '../operating-day.js';
import {requireProductionAdmin} from '../production-approval-policy.js';
// SQL checks time again INSIDE the transaction. Tests replace this expression only
// in their SQLite adapter with a synthetic DB clock; production has no clock knob.
export const executionClockSql="CAST(round((julianday('now')-2440587.5)*86400000) AS INTEGER)";
const flags={synthetic_only:true,real_execution_allowed:false,publish_allowed:false};
export const asyncScopeDigest=scope=>digest(taskActionScopeEntries(scope));
const parse=s=>{try{return JSON.parse(s);}catch{fail('EXECUTION_RECORD_INVALID');}};
const bounds=day=>{const start=Date.parse(day+'T07:00:00+08:00');return [start,start+86400000];};
/** Async adapter for the existing PAGE TaskActionPermits contract. No issuer or
 * real provider is supplied. Records can currently have only SYNTHETIC_EXCLUSIVE
 * custody; neither an HTTP body nor a copied live permit can activate this API. */
export class AsyncExecutionPermits extends AsyncStorage {
 async has(jobId){return !!await this.one('SELECT 1 FROM sites_execution_permits WHERE job_id=?',[jobId]);}
 async required(job){return await this.has(job.id)||!!await this.one('SELECT 1 FROM sites_execution_policies WHERE workspace=? AND account_id=?',[job.workspace,job.account_id]);}
 async record(jobId){return this.one('SELECT * FROM sites_execution_permits WHERE job_id=?',[jobId]);}
 async clock(){return (await this.one('SELECT '+executionClockSql+' now_ms')).now_ms;}
 async binding(data,native){
  const {p,job,manifest}=data,snapshot=parse(job.snapshot_json),review=await this.one('SELECT task_id,request_revision FROM sites_reviews WHERE id=? AND workspace=? AND account_id=?',[p.review_id,job.workspace,job.account_id]);
  if(!review||snapshot.workspace!==job.workspace||snapshot.account_id!==job.account_id||snapshot.content_row_id!==job.content_id||snapshot.platform!==manifest.platform)fail('EXECUTION_FROZEN_BINDING_INVALID');
  const body_hash=await sha256(manifest.payload.body),media_hashes=manifest.media.map((m,ordinal)=>({ordinal,sha256:m.sha256,size:m.bytes}));
  if(native.kind!=='PAGE'||native.subject_id!=='PAGE:'+job.id||native.workspace!==job.workspace||native.account_id!==job.account_id||native.platform!==manifest.platform||native.platform!=='facebook'||native.snapshot_hash!==job.snapshot_hash||native.body_hash!==body_hash||JSON.stringify(native.media_hashes)!==JSON.stringify(media_hashes))fail('EXECUTION_FROZEN_BINDING_INVALID');
  return {job_id:job.id,task_id:review.task_id,request_revision:review.request_revision,review_id:p.review_id,content_id:job.content_id,content_revision:snapshot.revision,external_identity:snapshot.external_identity,platform:manifest.platform,snapshot_hash:job.snapshot_hash,scope_hash:await asyncScopeDigest(native)};
 }
 async load(data,scope,{status='AVAILABLE',attemptId=null}={}){
  await this.scope(scope.workspace,scope.accountId);const {job}=data;if(job.workspace!==scope.workspace||job.account_id!==scope.accountId)fail('EXECUTION_SCOPE_DENIED');
  const permit=await this.record(job.id);if(!permit)fail('EXECUTION_PERMIT_UNAVAILABLE');
  const policy=await this.one('SELECT * FROM sites_execution_policies WHERE id=? AND workspace=? AND account_id=?',[permit.policy_id,scope.workspace,scope.accountId]);
  if(!policy||policy.custody!=='SYNTHETIC_EXCLUSIVE')fail('EXECUTION_AUTHORITY_UNAVAILABLE');
  const native=parse(permit.scope_json),hash=await asyncScopeDigest(native),binding=await this.binding(data,native),p=parse(policy.policy_json),limits=parse(policy.limits_json),history=parse(policy.history_json),auth=parse(permit.authorization_json),now=await this.clock(),day=operatingDay(now);
  if(hash!==permit.scope_hash||JSON.stringify(binding)!==permit.binding_json)fail('EXECUTION_FROZEN_BINDING_INVALID');
  if(permit.status!==status||status==='CONSUMED'&&permit.attempt_id!==attemptId||!Number.isSafeInteger(permit.issued_at)||!Number.isSafeInteger(permit.expires_at)||permit.issued_at>now||permit.expires_at<=now||permit.expires_at>permit.issued_at+86400000)fail('EXECUTION_PERMIT_SPENT_OR_EXPIRED');
  if(policy.revoked_at!==null||p.workspace!==native.workspace||p.account_id!==native.account_id||p.actor_id!==native.actor_id||p.target_page_id!==native.target_page_id||!Number.isSafeInteger(p.expires_at)||p.expires_at<=now||permit.expires_at>p.expires_at||!Array.isArray(p.allowed_scope_hashes)||!p.allowed_scope_hashes.includes(hash))fail('EXECUTION_POLICY_REVOKED_OR_CHANGED');
  if(auth.task_id!==binding.task_id||['task_id','approval_thread_id','approval_message_id'].some(k=>typeof auth[k]!=='string'||!auth[k].trim()||auth[k].length>200))fail('EXECUTION_AUTHORIZATION_REQUIRED');
  if(Object.keys(limits).length!==Object.keys(scopedOperationLimits).length||Object.entries(scopedOperationLimits).some(([k,v])=>limits[k]!==v))fail('EXECUTION_EXISTING_LIMITS_REQUIRED');
  if(policy.history_day!==day||!Number.isSafeInteger(history.page)||history.page<0||!Number.isSafeInteger(history.interaction)||history.interaction<0||!Array.isArray(history.groups)||history.groups.some(g=>typeof g!=='string')||typeof history.pending!=='boolean'||typeof history.paused!=='boolean'||typeof history.complete!=='boolean'||!history.complete)fail('EXECUTION_COMPLETE_HISTORY_REQUIRED');
  if(history.pending||history.paused||permit.prior_duplicate)fail('HISTORICAL_PENDING_PAUSED_OR_DUPLICATE');
  return {permit,policy,native,binding,p,limits,history,day,now,budgetKey:await digest([native.workspace,native.platform,native.actor_id,native.target_page_id]),dedupKey:await digest(taskActionDedupValue(native,'PUBLISH'))};
 }
 guards(v,status,attemptId=null){const {permit:r,policy:p,day}=v,[start,end]=bounds(day);return [
  this.guard('EXISTS(SELECT 1 FROM sites_execution_permits WHERE id=? AND job_id=? AND policy_id=? AND scope_json=? AND scope_hash=? AND binding_json=? AND authorization_json=? AND status=? AND attempt_id IS ? AND issued_at=? AND expires_at=? AND prior_duplicate=0 AND issued_at<= '+executionClockSql+' AND expires_at> '+executionClockSql+')',[r.id,r.job_id,r.policy_id,r.scope_json,r.scope_hash,r.binding_json,r.authorization_json,status,attemptId,r.issued_at,r.expires_at]),
  this.guard('EXISTS(SELECT 1 FROM sites_execution_policies WHERE id=? AND workspace=? AND account_id=? AND policy_json=? AND limits_json=? AND history_json=? AND history_day=? AND revision=? AND revoked_at IS NULL AND custody=?) AND '+executionClockSql+' < ?',[p.id,p.workspace,p.account_id,p.policy_json,p.limits_json,p.history_json,day,p.revision,'SYNTHETIC_EXCLUSIVE',v.p.expires_at]),
  this.guard(executionClockSql+'>=? AND '+executionClockSql+'<?',[start,end])];}
 event(jobId,permitId,attempt,event,detail={}){return this.statement('INSERT INTO sites_execution_events(job_id,permit_id,attempt_id,event,detail_json,created_at) VALUES(?,?,?,?,?,'+executionClockSql+')',[jobId,permitId,attempt,event,JSON.stringify(detail)]);}
 async claimStatements(data,scope,attemptId){
  const v=await this.load(data,scope),{job,p}=data;
  return [...this.guards(v,'AVAILABLE'),this.guard("EXISTS(SELECT 1 FROM publisher_jobs j JOIN sites_synthetic_attempts a ON a.job_id=j.id WHERE j.id=? AND j.workspace=? AND j.account_id=? AND j.content_id=? AND j.snapshot_hash=? AND j.state='PREPARING' AND j.attempt_id=? AND a.attempt_id=j.attempt_id AND a.snapshot_hash=j.snapshot_hash AND a.plan_id=?)",[job.id,scope.workspace,scope.accountId,job.content_id,job.snapshot_hash,attemptId,p.id]),
   this.guard("NOT EXISTS(SELECT 1 FROM sites_execution_claims WHERE budget_key=? AND state IN ('RESERVED','SUBMITTING','UNKNOWN'))",[v.budgetKey]),
   this.guard("(SELECT count(*) FROM sites_execution_claims WHERE budget_key=? AND day=? AND state<>'RELEASED')+?<?",[v.budgetKey,v.day,v.history.page,v.limits.page]),
   this.guard('NOT EXISTS(SELECT 1 FROM sites_execution_claims WHERE budget_key=? AND dedup_key=?)',[v.budgetKey,v.dedupKey]),
   this.statement("UPDATE sites_execution_permits SET status='CONSUMED',attempt_id=? WHERE id=?",[attemptId,v.permit.id]),
   this.statement("INSERT INTO sites_execution_claims VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'RESERVED',"+executionClockSql+','+executionClockSql+')',[job.id,v.permit.id,p.id,attemptId,scope.workspace,scope.accountId,v.native.platform,v.budgetKey,v.permit.scope_hash,job.snapshot_hash,job.content_id,v.binding.content_revision,v.day,v.dedupKey]),
   this.event(job.id,v.permit.id,attemptId,'RESERVED',{scope_hash:v.permit.scope_hash,day:v.day})];
 }
 claimGuard(data,v,attemptId,state){return this.guard("EXISTS(SELECT 1 FROM sites_execution_claims WHERE job_id=? AND permit_id=? AND plan_id=? AND attempt_id=? AND workspace=? AND account_id=? AND platform=? AND state=? AND day=? AND scope_hash=? AND snapshot_hash=? AND content_id=? AND content_revision=?)",[data.job.id,v.permit.id,data.p.id,attemptId,data.job.workspace,data.job.account_id,v.native.platform,state,v.day,v.permit.scope_hash,data.job.snapshot_hash,data.job.content_id,v.binding.content_revision]);}
 async intentStatements(data,scope,attemptId){
  const claim=await this.one('SELECT * FROM sites_execution_claims WHERE job_id=?',[data.job.id]);if(!claim){if(await this.required(data.job))fail('EXECUTION_CLAIM_REQUIRED');return [];}
  const v=await this.load(data,scope,{status:'CONSUMED',attemptId});if(claim.day!==v.day||claim.attempt_id!==attemptId)fail('EXECUTION_RESERVED_DAY_OR_ATTEMPT_CHANGED');
  return [...this.guards(v,'CONSUMED',attemptId),this.claimGuard(data,v,attemptId,'RESERVED'),this.transition(claim,'RESERVED','SUBMITTING'),this.event(claim.job_id,claim.permit_id,attemptId,'SUBMIT_INTENT')];
 }
 async dispatchStatements(data,scope,attemptId){
  const claim=await this.one('SELECT * FROM sites_execution_claims WHERE job_id=?',[data.job.id]);if(!claim){if(await this.required(data.job))fail('EXECUTION_CLAIM_REQUIRED');return [];}
  const v=await this.load(data,scope,{status:'CONSUMED',attemptId});if(claim.day!==v.day)fail('EXECUTION_RESERVED_DAY_OR_ATTEMPT_CHANGED');
  return [...this.guards(v,'CONSUMED',attemptId),this.claimGuard(data,v,attemptId,'SUBMITTING')];
 }
 transition(claim,from,to){return this.statement("UPDATE sites_execution_claims SET state=?,updated_at="+executionClockSql+" WHERE job_id=? AND attempt_id=? AND state=?",[to,claim.job_id,claim.attempt_id,from]);}
 // Added to the original executor batch AFTER its phase mutation. Never accepts
 // a client 'not submitted' flag; SQL must prove the durable before-submit state.
 transitionStatements(c,to,detail={}){if(!c.row.quota_state)return [];
  const claim={job_id:c.job.id,attempt_id:c.row.attempt_id,permit_id:c.row.quota_permit},from=c.row.quota_state;
  if(to==='RELEASED'&&from!=='RESERVED'||to==='UNKNOWN'&&!['SUBMITTING','UNKNOWN'].includes(from)||to==='SETTLED'&&!['SUBMITTING','UNKNOWN'].includes(from))fail('EXECUTION_CLAIM_BINDING_INVALID');
  const proof=to==='RELEASED'?"j.state='BLOCKED' AND a.state='UPLOAD_FAILED' AND NOT EXISTS(SELECT 1 FROM sites_synthetic_objects WHERE plan_id=a.plan_id) AND NOT EXISTS(SELECT 1 FROM sites_synthetic_readbacks WHERE plan_id=a.plan_id)":to==='SETTLED'?"j.state='PUBLISHED' AND a.state='VERIFIED' AND EXISTS(SELECT 1 FROM sites_synthetic_readbacks WHERE plan_id=a.plan_id)":"j.state='UNKNOWN' AND a.state='UNKNOWN'";
  return [this.guard('EXISTS(SELECT 1 FROM sites_execution_claims q JOIN publisher_jobs j ON j.id=q.job_id JOIN sites_synthetic_attempts a ON a.job_id=j.id WHERE q.job_id=? AND q.attempt_id=? AND q.state=? AND q.snapshot_hash=j.snapshot_hash AND q.workspace=j.workspace AND q.account_id=j.account_id AND j.attempt_id=q.attempt_id AND a.attempt_id=q.attempt_id AND '+proof+')',[claim.job_id,claim.attempt_id,from]),this.transition(claim,from,to),this.event(claim.job_id,claim.permit_id,claim.attempt_id,to,detail)];
 }
 async revoke(jobId,scope,reason,{authority}={}){
  requireProductionAdmin(authority);await this.scope(scope.workspace,scope.accountId);const job=await this.one('SELECT * FROM publisher_jobs WHERE id=? AND workspace=? AND account_id=?',[jobId,scope.workspace,scope.accountId]),permit=job&&await this.record(jobId);
  if(!permit||permit.status!=='AVAILABLE'||typeof reason!=='string'||!reason.trim()||reason.length>500)fail('ONLY_AVAILABLE_MAY_REVOKE');
  await this.batch([this.guard("EXISTS(SELECT 1 FROM sites_execution_permits WHERE id=? AND job_id=? AND status='AVAILABLE')",[permit.id,jobId]),this.statement("UPDATE sites_execution_permits SET status='REVOKED' WHERE id=?",[permit.id]),this.event(jobId,permit.id,null,'REVOKED',{reason})]);return {status:'REVOKED',...flags};
 }
}

import {createHash,randomUUID} from 'node:crypto';
import {operatingDay} from './operating-day.js';
import {taskActionScopeEntries,taskActionDedupValue,scopedOperationLimits} from './task-action-policy.js';
const digest=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const fail=message=>{throw Error(message);};
export const scopeDigest=scope=>digest(taskActionScopeEntries(scope));
/** Preparation for reviewed adapters: no browser or HTTP route is created here.
 * current() must independently reconstruct scope from the original task/assets and
 * enforce existing profile/UNKNOWN/group-opt-in/risk/pause guards. Default is deny.
 */
export class TaskActionPermits{
 constructor(store,{policy=null,current=null,priorUsage=null,now=()=>Date.now()}={}){
  this.store=store;this.db=store.db;this.policy=policy?structuredClone(policy):null;this.current=current;this.priorUsage=priorUsage;this.now=now;
  this.db.exec(`CREATE TABLE IF NOT EXISTS task_action_permits(id TEXT PRIMARY KEY,subject_id TEXT NOT NULL UNIQUE,scope_json TEXT NOT NULL,scope_hash TEXT NOT NULL,authorization_json TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('AVAILABLE','CONSUMED','REVOKED')),issued_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,attempt_id TEXT);
   CREATE TABLE IF NOT EXISTS task_action_permit_events(seq INTEGER PRIMARY KEY,permit_id TEXT NOT NULL,event TEXT NOT NULL,detail_json TEXT NOT NULL,created_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS task_action_daily_claims(id TEXT PRIMARY KEY,permit_id TEXT NOT NULL,workspace TEXT NOT NULL,account_id TEXT NOT NULL,actor_id TEXT NOT NULL,target_page_id TEXT NOT NULL,kind TEXT NOT NULL,target_id TEXT NOT NULL,day TEXT NOT NULL,action TEXT NOT NULL,dedup_key TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(workspace,actor_id,target_page_id,dedup_key));`);
 }
 read(subject){return this.db.prepare('SELECT * FROM task_action_permits WHERE subject_id=?').get(subject);}
 assertScope(scope){
  const hash=scopeDigest(scope),p=this.policy,n=this.now();
  if(!p||typeof this.current!=='function'||typeof this.priorUsage!=='function')fail('SCOPED_ADAPTER_NOT_CONFIGURED');
  if(p.workspace!==scope.workspace||p.account_id!==scope.account_id||p.actor_id!==scope.actor_id||p.target_page_id!==scope.target_page_id||!Number.isSafeInteger(p.expires_at)||p.expires_at<=n||!Array.isArray(p.allowed_scope_hashes)||!p.allowed_scope_hashes.includes(hash))fail('OUTSIDE_EXPLICIT_AUTHORITY');
  const observed=this.current(scope.subject_id);if(!observed||observed.fresh!==true||observed.blocked!==false||scopeDigest(observed.scope)!==hash)fail('CURRENT_TASK_GUARD_OR_SCOPE_MISMATCH');
  if(scope.kind==='GROUP'&&(observed.joined!==true||observed.opted_in!==true||observed.posting_allowed!==true))fail('GROUP_NOT_EXPLICITLY_ALLOWED');
  if(scope.kind==='INTERACTION'&&(observed.helpful!==true||observed.risk!=='LOW'||observed.complaint!==false||observed.platform_warning!==false))fail('INTERACTION_NOT_REVIEWED_SAFE');
  return hash;
 }
 issue(scope,{expiresAt,authorization}={}){const tx=fn=>this.store.transactionActive?fn():this.store.tx(fn);return tx(()=>{
  const hash=this.assertScope(scope),n=this.now();if(this.read(scope.subject_id))fail('PERMANENT_SUBJECT_PERMIT_EXISTS');
  if(!Number.isSafeInteger(expiresAt)||expiresAt<=n||expiresAt>this.policy.expires_at||expiresAt>n+86400000)fail('EXPLICIT_EXPIRY_REQUIRED');
  if(!authorization||['task_id','approval_thread_id','approval_message_id'].some(k=>typeof authorization[k]!=='string'||!authorization[k].trim()||authorization[k].length>200))fail('AUDITABLE_AUTHORIZATION_REQUIRED');
  const id=randomUUID();this.db.prepare("INSERT INTO task_action_permits VALUES(?,?,?,?,?,'AVAILABLE',?,?,NULL)").run(id,scope.subject_id,JSON.stringify(scope),hash,JSON.stringify(authorization),n,expiresAt);this.event(id,'ISSUED',{scope,authorization},n);return this.capability(scope.subject_id);
 });}
 capability(subject){const row=this.read(subject);if(!row)return {canExecute:false,reason:'NO_TASK_PERMIT'};try{if(row.status!=='AVAILABLE'||row.expires_at<=this.now())fail('PERMIT_SPENT_OR_EXPIRED');const scope=JSON.parse(row.scope_json);if(this.assertScope(scope)!==row.scope_hash)fail('PERMIT_HASH_MISMATCH');this.assertBudget(scope);return {canExecute:true,mode:'TASK_SINGLE_USE',permitId:row.id,scope,expiresAt:row.expires_at};}catch(e){return {canExecute:false,reason:e.message,permitId:row.id,status:row.status};}}
 assertBudget(scope){
  const day=operatingDay(this.now()),rows=this.db.prepare('SELECT * FROM task_action_daily_claims WHERE workspace=? AND actor_id=? AND target_page_id=?').all(scope.workspace,scope.actor_id,scope.target_page_id).filter(row=>operatingDay(row.created_at)===day);
  // Adapter MUST include legacy/global/shared history, excluding these exact permit IDs.
  const prior=this.priorUsage({scope,day,excludedPermitIds:[...new Set(rows.map(r=>r.permit_id))]});
  if(!prior||!Number.isSafeInteger(prior.page)||prior.page<0||!Number.isSafeInteger(prior.interaction)||prior.interaction<0||!Array.isArray(prior.groups)||prior.groups.some(g=>typeof g!=='string')||typeof prior.duplicate!=='boolean'||typeof prior.pending!=='boolean'||typeof prior.paused!=='boolean')fail('COMPLETE_PRIOR_USAGE_REQUIRED');
  if(prior.pending||prior.paused||prior.duplicate)fail('HISTORICAL_PENDING_PAUSED_OR_DUPLICATE');
  if(scope.kind==='PAGE'&&prior.page+rows.filter(r=>r.kind==='PAGE').length>=scopedOperationLimits.page)fail('PAGE_DAILY_LIMIT_1');
  if(scope.kind==='GROUP'){const groups=[...prior.groups,...rows.filter(r=>r.kind==='GROUP').map(r=>r.target_id)];if(groups.includes(scope.target_id))fail('GROUP_DAILY_LIMIT_1');if(new Set(groups).size>=scopedOperationLimits.groups)fail('GROUP_DAILY_LIMIT_2');}
  if(scope.kind==='INTERACTION'&&prior.interaction+rows.filter(r=>r.kind==='INTERACTION').length+scope.actions.length>scopedOperationLimits.interactionActions)fail('INTERACTION_DAILY_LIMIT_3');
  for(const action of scope.actions){const key=this.dedup(scope,action);if(this.db.prepare('SELECT 1 FROM task_action_daily_claims WHERE workspace=? AND actor_id=? AND target_page_id=? AND dedup_key=?').get(scope.workspace,scope.actor_id,scope.target_page_id,key))fail('EXACT_ACTION_ALREADY_CLAIMED');}
  return day;
 }
 dedup(scope,action){return digest(taskActionDedupValue(scope,action));}
 /** Must be called inside the SAME existing task claim transaction, before driver creation. */
 consume(scope,attemptId){if(!this.store.transactionActive)fail('ATOMIC_TASK_CLAIM_REQUIRED');if(typeof attemptId!=='string'||!attemptId)fail('ATTEMPT_REQUIRED');const row=this.read(scope.subject_id);if(!row||row.status!=='AVAILABLE'||row.expires_at<=this.now())fail('PERMIT_SPENT_OR_EXPIRED');if(this.assertScope(scope)!==row.scope_hash)fail('PERMIT_SCOPE_MISMATCH');const day=this.assertBudget(scope),n=this.now();
  const changed=this.db.prepare("UPDATE task_action_permits SET status='CONSUMED',attempt_id=? WHERE id=? AND status='AVAILABLE' AND expires_at>?").run(attemptId,row.id,n);if(changed.changes!==1)fail('PERMIT_SPENT_OR_EXPIRED');
  for(const action of scope.actions)this.db.prepare('INSERT INTO task_action_daily_claims VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),row.id,scope.workspace,scope.account_id,scope.actor_id,scope.target_page_id,scope.kind,scope.target_id,day,action,this.dedup(scope,action),n);
  this.event(row.id,'CONSUMED',{attempt_id:attemptId,scope_hash:row.scope_hash,day},n);
 }
 revoke(subject,reason){return this.store.tx(()=>{const row=this.read(subject);if(!row||row.status!=='AVAILABLE'||typeof reason!=='string'||!reason.trim())fail('ONLY_AVAILABLE_MAY_REVOKE');this.db.prepare("UPDATE task_action_permits SET status='REVOKED' WHERE id=?").run(row.id);this.event(row.id,'REVOKED',{reason},this.now());});}
 event(id,event,detail,n){this.db.prepare('INSERT INTO task_action_permit_events(permit_id,event,detail_json,created_at) VALUES(?,?,?,?)').run(id,event,JSON.stringify(detail),n);}
}

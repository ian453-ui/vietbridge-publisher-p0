import {createHash,randomUUID} from 'node:crypto';
import {productionReviewChecks,requireProductionAdmin,validateProductionDecision,approvalIdentityFields} from './production-approval-policy.js';
export {productionReviewChecks} from './production-approval-policy.js';
import {verifyProductionRequest,productionResultFingerprint,PRODUCTION_BATCH_LIMITS} from './production-artifact-contract.js';
import {publishingPlatforms} from './publisher-platforms.js';
import {sourceEvidenceState,approvalSourceChanged,bindApprovalSource} from './production-source-state.js';

const fail=code=>{throw Error(code);};
const hash=x=>createHash('sha256').update(x).digest('hex');
const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const digest=x=>hash(JSON.stringify(canonical(x)));
const flags={publish_allowed:false,import_allowed:false,source_gate_satisfied:false,producer_authenticated:false};

/** Content decisions only. No production producer-authentication or publication authority. */
export class ProductionApprovalStore {
 constructor(db){
  this.db=db;db.exec(`
   CREATE TABLE IF NOT EXISTS production_review_envelopes(review_id TEXT PRIMARY KEY REFERENCES production_reviews(id) ON DELETE CASCADE,result_json TEXT NOT NULL,report_sha256 TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS production_review_provenance(review_id TEXT PRIMARY KEY,kind TEXT NOT NULL CHECK(kind='SYNTHETIC_FIXTURE'),request_fingerprint TEXT NOT NULL,result_fingerprint TEXT NOT NULL,account_hash TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS production_approval_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,review_id TEXT NOT NULL,subject_fingerprint TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('CONTENT_APPROVED','CONTENT_REJECTED','REVOKED')),actor_id TEXT NOT NULL,reason TEXT NOT NULL,checks_json TEXT NOT NULL,created_at TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS production_approval_history ON production_approval_events(review_id,sequence);
   CREATE TABLE IF NOT EXISTS production_approval_commands(command_id TEXT PRIMARY KEY,command_hash TEXT NOT NULL,event_id TEXT NOT NULL);
   CREATE TRIGGER IF NOT EXISTS production_approval_event_no_update BEFORE UPDATE ON production_approval_events BEGIN SELECT RAISE(ABORT,'APPROVAL_AUDIT_IMMUTABLE'); END;
   CREATE TRIGGER IF NOT EXISTS production_approval_event_no_delete BEFORE DELETE ON production_approval_events BEGIN SELECT RAISE(ABORT,'APPROVAL_AUDIT_IMMUTABLE'); END;
   CREATE TRIGGER IF NOT EXISTS production_approval_command_no_update BEFORE UPDATE ON production_approval_commands BEGIN SELECT RAISE(ABORT,'APPROVAL_AUDIT_IMMUTABLE'); END;
   CREATE TRIGGER IF NOT EXISTS production_approval_command_no_delete BEFORE DELETE ON production_approval_commands BEGIN SELECT RAISE(ABORT,'APPROVAL_AUDIT_IMMUTABLE'); END;`);
 }
 tx(fn){const nested=this.db.isTransaction,name='approval_'+randomUUID().replaceAll('-','');this.db.exec(nested?'SAVEPOINT '+name:'BEGIN IMMEDIATE');try{const value=fn();this.db.exec(nested?'RELEASE '+name:'COMMIT');return value;}catch(error){this.db.exec(nested?'ROLLBACK TO '+name:'ROLLBACK');if(nested)this.db.exec('RELEASE '+name);throw error;}}
 row(id,{workspace,accountId}={}){
  if(typeof workspace!=='string'||typeof accountId!=='string'||!this.db.prepare('SELECT 1 FROM facebook_accounts WHERE workspace=? AND id=?').get(workspace,accountId))fail('APPROVAL_SCOPE_DENIED');
  const row=this.db.prepare('SELECT * FROM production_reviews WHERE id=? AND workspace=? AND account_id=?').get(id,workspace,accountId);if(!row)fail('APPROVAL_NOT_FOUND');return row;
 }
 accountHash(workspace,accountId){
  const row=this.db.prepare('SELECT * FROM facebook_accounts WHERE workspace=? AND id=?').get(workspace,accountId);if(!row)fail('APPROVAL_SCOPE_DENIED');
  return digest(Object.fromEntries(approvalIdentityFields.map(k=>[k,row[k]??null])));
 }
 latest(id){return this.db.prepare('SELECT * FROM production_approval_events WHERE review_id=? ORDER BY sequence DESC LIMIT 1').get(id)||null;}
 append(id,fingerprint,kind,actorId,reason,checks={},now=Date.now()){
  const event={id:randomUUID(),review_id:id,subject_fingerprint:fingerprint,kind,actor_id:actorId,reason,checks_json:JSON.stringify(checks),created_at:new Date(now).toISOString()};
  this.db.prepare('INSERT INTO production_approval_events(id,review_id,subject_fingerprint,kind,actor_id,reason,checks_json,created_at) VALUES(?,?,?,?,?,?,?,?)').run(...Object.values(event));return this.latest(id);
 }
 revoke(id,reason,now){const prior=this.latest(id);if(prior?.kind==='CONTENT_APPROVED')this.append(id,prior.subject_fingerprint,'REVOKED','SYSTEM_VALIDATOR',reason,{},now);}
 invalidateTask(taskId,currentId,now=Date.now()){
  for(const row of this.db.prepare('SELECT id FROM production_reviews WHERE task_id=? AND id<>?').all(taskId,currentId))this.revoke(row.id,'SUPERSEDED_REVIEW_VERSION',now);
 }
 subject(id,scope,now=Date.now()){
  const row=this.row(id,scope),request=JSON.parse(row.request_json),report=JSON.parse(row.report_json),envelope=this.db.prepare('SELECT * FROM production_review_envelopes WHERE review_id=?').get(id);
  verifyProductionRequest(request);
  if(request.request_fingerprint!==id||request.task_id!==row.task_id||request.request_revision!==row.request_revision||request.workspace!==row.workspace||request.account_id!==row.account_id)fail('APPROVAL_STORAGE_CORRUPT');
  if(!envelope)fail('APPROVAL_ENVELOPE_UNAVAILABLE');
  const result=JSON.parse(envelope.result_json);if(hash(row.report_json)!==envelope.report_sha256||productionResultFingerprint(result)!==row.result_fingerprint||result.request_fingerprint!==id||report.receipt?.request_fingerprint!==id||report.receipt?.result_fingerprint!==row.result_fingerprint)fail('APPROVAL_STORAGE_CORRUPT');
  if(report.status!=='REVIEW_REQUIRED'||report.structure!=='VALIDATED'||report.scope_status==='UNKNOWN')fail('APPROVAL_STATE_UNKNOWN');
  const meta=this.db.prepare('SELECT source_id,artifact_id,sha256,length(data) bytes FROM production_review_assets WHERE review_id=?').all(id);
  if(meta.length>PRODUCTION_BATCH_LIMITS.artifacts||meta.reduce((sum,a)=>sum+a.bytes,0)>PRODUCTION_BATCH_LIMITS.bytes)fail('APPROVAL_STORAGE_CORRUPT');
  const expected=result.items.flatMap(item=>item.artifacts.map(a=>({source_id:item.source_id,artifact_id:a.artifact_id,sha256:a.sha256})));
  if(meta.length!==expected.length)fail('APPROVAL_STORAGE_CORRUPT');
  for(const a of expected){const stored=meta.find(x=>x.source_id===a.source_id&&x.artifact_id===a.artifact_id);if(!stored||stored.sha256!==a.sha256)fail('APPROVAL_STORAGE_CORRUPT');const raw=this.db.prepare('SELECT data FROM production_review_assets WHERE review_id=? AND source_id=? AND artifact_id=?').get(id,a.source_id,a.artifact_id);if(hash(raw.data)!==a.sha256)fail('APPROVAL_STORAGE_CORRUPT');}
  const provenance=this.db.prepare('SELECT * FROM production_review_provenance WHERE review_id=?').get(id),account=this.db.prepare('SELECT * FROM facebook_accounts WHERE id=? AND workspace=?').get(row.account_id,row.workspace),accountHash=this.accountHash(row.workspace,row.account_id);
  const targets=[...new Set([account.platform,...request.items.flatMap(x=>x.deliverables.map(a=>a.platform).filter(Boolean))])].sort();
  let blocked=null;
  if(!provenance||provenance.kind!=='SYNTHETIC_FIXTURE'||provenance.request_fingerprint!==id||provenance.result_fingerprint!==row.result_fingerprint)blocked='PRODUCER_AUTH_UNAVAILABLE';
  else if(!request.task_id.startsWith('SYNTHETIC-')||request.items.some(x=>!x.source_id.startsWith('SYNTHETIC-')))blocked='SYNTHETIC_PROVENANCE_INVALID';
  else if(provenance.account_hash!==accountHash)blocked='ACCOUNT_TARGET_CHANGED';
  const workspaceRow=this.db.prepare("SELECT value FROM records WHERE kind='workspaces' AND id=?").get(row.workspace),workspace=workspaceRow?JSON.parse(workspaceRow.value):null;
  if(workspace?.id!==row.workspace)fail('APPROVAL_SCOPE_DENIED');
  if(row.workspace==='ws-vietbridge'||workspace?.library_kind==='enterprise')blocked='ENTERPRISE_SOURCE_APPROVAL_FORBIDDEN';
  if(!account.enabled||!account.external_id||targets.some(p=>!publishingPlatforms[p]))blocked='TARGET_IDENTITY_UNKNOWN';
  if(this.db.prepare('SELECT max(request_revision) revision FROM production_reviews WHERE task_id=?').get(row.task_id).revision!==row.request_revision)blocked='STALE_REVIEW_VERSION';
  const fingerprint=digest({request_fingerprint:id,result_fingerprint:row.result_fingerprint,account_hash:accountHash,target_platforms:targets,artifacts:expected,source_refs:request.items.map(x=>({source_id:x.source_id,refs:x.source_refs}))});
  const source=sourceEvidenceState(this.db,id,fingerprint,now);if(!blocked&&source.blocked)blocked=source.blocked;
  return {fingerprint,blocked,source_verification:source,target_platforms:targets,provenance:provenance?'SYNTHETIC_FIXTURE':'UNVERIFIED',task_id:row.task_id,request_revision:row.request_revision};
 }
 reconcile(id,scope,now=Date.now()){
  this.row(id,scope);let subject;
  try{subject=this.subject(id,scope,now);}catch(error){if(!(error instanceof SyntaxError)&&!/^(APPROVAL_|REQUEST_|RESULT_|INVALID_)/.test(error.message))throw error;subject={fingerprint:null,blocked:error instanceof SyntaxError?'APPROVAL_STORAGE_CORRUPT':error.message,provenance:'UNKNOWN',target_platforms:[]};}
  const latest=this.latest(id);if(latest?.kind==='CONTENT_APPROVED'&&(subject.blocked||latest.subject_fingerprint!==subject.fingerprint||approvalSourceChanged(this.db,latest.id,subject.source_verification)))this.revoke(id,subject.blocked||(latest.subject_fingerprint!==subject.fingerprint?'APPROVAL_SUBJECT_CHANGED':'APPROVAL_SOURCE_CHANGED'),now);
  return subject;
 }
 view(id,scope,{admin=false,now=Date.now()}={}){return this.tx(()=>{
  const subject=this.reconcile(id,scope,now),latest=this.latest(id),events=this.db.prepare('SELECT * FROM production_approval_events WHERE review_id=? ORDER BY sequence DESC LIMIT 101').all(id);
  return {state:subject.blocked?(latest?.kind==='REVOKED'?'REVOKED':'BLOCKED'):(latest?.kind||'PENDING'),blocked_reason:subject.blocked,subject_fingerprint:subject.fingerprint,latest_event_id:latest?.id||null,target_platforms:subject.target_platforms,provenance:subject.provenance,source_verification:subject.source_verification,can_decide:admin&&!subject.blocked,required_checks:productionReviewChecks,history:events.slice(0,100),history_truncated:events.length>100,...flags};
 });}
 decide(id,input,scope,{authority,now=Date.now()}={}){
  requireProductionAdmin(authority);validateProductionDecision(input);
  // A denial still commits any newly discovered invalidation; no approval command is recorded.
  const outcome=this.tx(()=>{
   const subject=this.reconcile(id,scope,now);if(subject.blocked)return {denied:subject.blocked};if(subject.fingerprint!==input.expected_subject)return {denied:'APPROVAL_STALE_SUBJECT'};
   const commandHash=digest({review_id:id,scope,input,actor:authority.actor_id}),prior=this.db.prepare('SELECT * FROM production_approval_commands WHERE command_id=?').get(input.command_id),latest=this.latest(id);
   if(prior){if(prior.command_hash!==commandHash)fail('APPROVAL_COMMAND_CONFLICT');return {status:'DUPLICATE',event_id:prior.event_id,approval:this.view(id,scope,{admin:true,now}),...flags};}
   const kind=input.decision==='APPROVE'?'CONTENT_APPROVED':'CONTENT_REJECTED';
   const same=latest&&latest.kind===kind&&latest.subject_fingerprint===subject.fingerprint&&latest.actor_id===authority.actor_id&&latest.reason===input.reason&&digest(JSON.parse(latest.checks_json))===digest(input.checks);
   if(!same&&(latest?.id||null)!==input.expected_event_id)fail('APPROVAL_STALE_DECISION');
   const event=same?latest:this.append(id,subject.fingerprint,kind,authority.actor_id,input.reason,input.checks,now);
   if(!same&&kind==='CONTENT_APPROVED')bindApprovalSource(this.db,event.id,subject.source_verification);
   this.db.prepare('INSERT INTO production_approval_commands VALUES(?,?,?)').run(input.command_id,commandHash,event.id);
   return {status:same?'DUPLICATE':'RECORDED',event_id:event.id,approval:this.view(id,scope,{admin:true,now}),...flags};
  });if(outcome.denied)fail(outcome.denied);return outcome;
 }
}

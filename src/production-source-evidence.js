import {createHash} from 'node:crypto';
import {ProductionApprovalStore} from './production-approval-store.js';
import {productionResultFingerprint} from './production-artifact-contract.js';
import {initializeSourceEvidence,activateSourceProvider,resetSourceProviders,sourceDigest,sourceEvidenceState} from './production-source-state.js';

const fail=code=>{throw Error(code);};
const exact=(value,keys)=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key)))fail('SOURCE_SCHEMA_INVALID');};
const text=value=>typeof value==='string'&&value.length>0&&value.length<=300;
const principal=value=>{exact(value,['issuer','subject']);if(!text(value.issuer)||!text(value.subject))fail('SOURCE_IDENTITY_INVALID');};
const same=(a,b)=>sourceDigest(a)===sourceDigest(b);
const safeReason=error=>/^SOURCE_[A-Z_]+$/.test(error?.message||'')?error.message:'SOURCE_PROVIDER_READ_FAILED';
const noExecution={producer_authenticated:false,source_gate_satisfied:false,publish_allowed:false};

/** Adapters are privileged server dependencies, never JSON/client claims. No provider ships here. */
export class ProductionSourceEvidence {
 constructor(db,{providers={},bindings=[],timeoutMs=5000,maxBytes=1048576,now=()=>Date.now()}={}){
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>1048576)fail('SOURCE_BUDGET_INVALID');
  this.db=db;this.approvals=new ProductionApprovalStore(db);initializeSourceEvidence(db);resetSourceProviders(db);this.providers=providers;this.timeoutMs=timeoutMs;this.maxBytes=maxBytes;this.now=now;this.configured=new Map();
  for(const binding of bindings)this.attach(binding);
 }
 attach(input){
  exact(input,['review_id','workspace','account_id','provider_id','task_reference','submission_reference','task_author','producer','approvers','max_age_ms']);
  const config=structuredClone(input),scope={workspace:config.workspace,accountId:config.account_id},row=this.approvals.row(config.review_id,scope),request=JSON.parse(row.request_json);
  if(!/^[a-z][a-z0-9_-]{0,63}$/.test(config.provider_id)||!text(config.submission_reference)||!same(config.task_reference,request.bridge_ref)||!Number.isSafeInteger(config.max_age_ms)||config.max_age_ms<1||config.max_age_ms>300000||!Array.isArray(config.approvers)||!config.approvers.length||config.approvers.length>20)fail('SOURCE_BINDING_INVALID');
  principal(config.task_author);principal(config.producer);config.approvers.forEach(principal);
  const digest=sourceDigest(config),prior=this.db.prepare('SELECT * FROM production_source_requirements WHERE review_id=?').get(config.review_id);
  if(prior&&prior.config_hash!==digest)fail('SOURCE_BINDING_CONFLICT');
  if(!prior)this.db.prepare('INSERT INTO production_source_requirements VALUES(?,?,?)').run(config.review_id,JSON.stringify(config),digest);
  const provider=Object.hasOwn(this.providers,config.provider_id)&&this.providers[config.provider_id];
  if(provider&&typeof provider.readSnapshot==='function'){this.configured.set(config.review_id,{config,provider});activateSourceProvider(this.db,config.review_id,digest);}
 }
 expected(id,scope){
  const row=this.approvals.row(id,scope),subject=this.approvals.subject(id,scope,this.now()),request=JSON.parse(row.request_json),result=JSON.parse(this.db.prepare('SELECT result_json FROM production_review_envelopes WHERE review_id=?').get(id).result_json);
  if(subject.blocked&&!/^(SOURCE_|PRODUCER_AUTH_UNAVAILABLE$)/.test(subject.blocked))fail('SOURCE_REVIEW_INELIGIBLE');
  const binding={review_id:id,task_id:row.task_id,request_revision:row.request_revision,workspace:row.workspace,account_id:row.account_id,request_fingerprint:request.request_fingerprint,result_fingerprint:row.result_fingerprint,subject_fingerprint:subject.fingerprint};
  return {binding,binding_hash:sourceDigest(binding),request,result};
 }
 view(id,scope){const approval=this.approvals.view(id,scope,{now:this.now()}),eligible=!approval.blocked_reason||/^(SOURCE_|PRODUCER_AUTH_UNAVAILABLE$)/.test(approval.blocked_reason);return {...sourceEvidenceState(this.db,id,approval.subject_fingerprint,this.now()),can_verify:eligible&&this.configured.has(id),...noExecution};}
 validate(raw,config,expected,startedAt){
  if(!Buffer.isBuffer(raw)||raw.length>this.maxBytes)fail('SOURCE_RESPONSE_BUDGET');
  let snapshot;try{snapshot=JSON.parse(raw.toString('utf8'));}catch{fail('SOURCE_SCHEMA_INVALID');}
  exact(snapshot,['schema_version','provider_id','observed_at','history_complete','task','submission','decisions']);
  if(snapshot.schema_version!==1||snapshot.provider_id!==config.provider_id||snapshot.history_complete!==true||!Number.isSafeInteger(snapshot.observed_at)||snapshot.observed_at>this.now()||snapshot.observed_at<startedAt-config.max_age_ms)fail('SOURCE_SNAPSHOT_INVALID');
  exact(snapshot.task,['reference','author','request']);exact(snapshot.submission,['reference','author','task_reference','result']);principal(snapshot.task.author);principal(snapshot.submission.author);
  if(!same(snapshot.task.reference,config.task_reference)||snapshot.submission.reference!==config.submission_reference||!same(snapshot.submission.task_reference,config.task_reference))fail('SOURCE_REFERENCE_MISMATCH');
  if(!same(snapshot.task.author,config.task_author)||!same(snapshot.submission.author,config.producer))fail('SOURCE_IDENTITY_MISMATCH');
  if(!same(snapshot.task.request,expected.request)||productionResultFingerprint(snapshot.submission.result)!==expected.binding.result_fingerprint||!same(snapshot.submission.result,expected.result))fail('SOURCE_PAYLOAD_MISMATCH');
  if(!Array.isArray(snapshot.decisions)||!snapshot.decisions.length||snapshot.decisions.length>1000)fail('SOURCE_APPROVAL_HISTORY_REQUIRED');
  let sequence=0,decisionAt=0;const ids=new Set();
  for(const decision of snapshot.decisions){
   exact(decision,['id','sequence','kind','author','binding_hash','decided_at']);principal(decision.author);
   if(!text(decision.id)||ids.has(decision.id)||decision.sequence!==++sequence||!['APPROVED','REVOKED'].includes(decision.kind)||decision.binding_hash!==expected.binding_hash||!Number.isSafeInteger(decision.decided_at)||decision.decided_at>snapshot.observed_at||decision.decided_at<decisionAt||!config.approvers.some(p=>same(p,decision.author)))fail('SOURCE_APPROVAL_INVALID');ids.add(decision.id);decisionAt=decision.decided_at;
  }
  return snapshot;
 }
 async verify(id,input,scope,{authority}={}){
  if(authority?.kind!=='EXISTING_ADMIN'||!/^admin:[a-f0-9]{64}$/.test(authority.actor_id||''))fail('SOURCE_ADMIN_REQUIRED');
  exact(input,['expected_subject']);const expected=this.expected(id,scope);
  if(input.expected_subject!==expected.binding.subject_fingerprint)fail('SOURCE_STALE_SUBJECT');
  const registered=this.configured.get(id);if(!registered)fail('SOURCE_PROVIDER_UNAVAILABLE');
  const {config,provider}=registered,startedAt=this.now(),attempt=Number(this.db.prepare('INSERT INTO production_source_attempts(review_id,subject_fingerprint,started_at) VALUES(?,?,?)').run(id,input.expected_subject,startedAt).lastInsertRowid);
  let raw=null,snapshot=null,reason=null,timer;const controller=new AbortController();
  try{
   raw=await Promise.race([Promise.resolve().then(()=>provider.readSnapshot(Object.freeze({task_reference:structuredClone(config.task_reference),submission_reference:config.submission_reference,signal:controller.signal,maxBytes:this.maxBytes}))),new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('SOURCE_PROVIDER_TIMEOUT'));},this.timeoutMs);})]);
   snapshot=this.validate(raw,config,expected,startedAt);
   if(!same(this.expected(id,scope).binding,expected.binding))fail('SOURCE_SUBJECT_CHANGED');
  }catch(error){reason=safeReason(error);}finally{clearTimeout(timer);controller.abort();}
  // Retain bounded raw failures for audit, never credentials/headers from the adapter.
  const captured=Buffer.isBuffer(raw)&&raw.length<=this.maxBytes?raw:null;
  this.approvals.tx(()=>{
   if(snapshot&&!reason){
    const prior=this.db.prepare('SELECT * FROM production_source_decisions WHERE review_id=? ORDER BY sequence').all(id);
    if(prior.some(row=>!snapshot.decisions[row.sequence-1]||row.record_hash!==sourceDigest(snapshot.decisions[row.sequence-1])))reason='SOURCE_HISTORY_CONFLICT';
    if(!reason){for(const decision of snapshot.decisions.slice(prior.length))this.db.prepare('INSERT INTO production_source_decisions VALUES(?,?,?,?,?)').run(id,decision.sequence,decision.id,JSON.stringify(decision),sourceDigest(decision));if(snapshot.decisions.at(-1).kind==='REVOKED')reason='SOURCE_APPROVAL_REVOKED';}
   }
   const decision=snapshot?.decisions?.at(-1);
   this.db.prepare('INSERT INTO production_source_receipts VALUES(?,?,?,?,?,?,?,?,?)').run(attempt,this.now(),reason?'FAILED':'VERIFIED',reason,captured,captured?createHash('sha256').update(captured).digest('hex'):null,expected.binding_hash,decision?JSON.stringify(decision):null,snapshot?.observed_at??null);
   this.approvals.reconcile(id,scope,this.now());
  });
  return {attempt_id:attempt,attempt_status:reason?'FAILED':'VERIFIED',attempt_reason:reason,current:this.view(id,scope),...noExecution};
 }
}

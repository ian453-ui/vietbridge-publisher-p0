import {AsyncStorage,digest,fail} from './async-storage.js';
import {AsyncReviewStore} from './async-review-store.js';
import {approvalDigest} from './async-approval-store.js';
import {bounded} from './scoped-object-store.js';
const identityFields=['workspace','accountId','project_id','source_folder_id','manifest_file_id','content_id','slug'];
const flags={publish_allowed:false,producer_authenticated:false,source_gate_satisfied:false,originals_deleted:false};
/** Existing Review intake orchestration. No HTTP transport or production provider
 * is configured. A source observation supersedes approval even if media later fail.
 */
export class AsyncSourceImport extends AsyncStorage {
 constructor(db,{provider=null,...options}={}){super(db,options);this.provider=provider;this.options=options;}
 async reconcile(reference){return this.import(reference,{reconcileOnly:true});}
 async import(reference,{reconcileOnly=false}={}){
  await this.scope(reference.workspace,reference.accountId);if(!this.provider?.describe||!this.provider?.inspect)fail('SOURCE_PROVIDER_UNAVAILABLE');
  const d=await bounded(this.provider.describe({...reference}),15000),s=d.summary,scope={workspace:reference.workspace,accountId:reference.accountId};
  if(!s||s.workspace!==scope.workspace||s.accountId!==scope.accountId||!Number.isSafeInteger(s.source_revision)||s.source_revision<1||identityFields.some(k=>typeof s[k]!=='string'||!s[k])||!d.request||d.request.workspace!==scope.workspace||d.request.account_id!==scope.accountId||d.request.task_id!==reference.task_id||d.request.request_revision!==reference.request_revision||await approvalDigest(s)!==d.descriptor_hash)fail('SOURCE_DESCRIPTION_INVALID');
  const identity=Object.fromEntries(identityFields.map(k=>[k,s[k]])),identityJson=JSON.stringify(identity),key=await digest(identity),summaryJson=JSON.stringify(s),id=d.request.request_fingerprint,prior=await this.one('SELECT * FROM sites_source_heads WHERE source_key=?',[key]);
  if(prior&&prior.source_revision>s.source_revision)fail('SOURCE_STALE_VERSION');
  if(prior&&prior.source_revision===s.source_revision&&prior.descriptor_hash!==d.descriptor_hash){await this.batch([this.statement("UPDATE sites_source_heads SET state='CONFLICT',reason='SOURCE_VERSION_CONFLICT' WHERE source_key=? AND source_revision=?",[key,s.source_revision])]);fail('SOURCE_VERSION_CONFLICT');}
  if(prior?.state==='CONFLICT'&&prior.source_revision===s.source_revision)fail('SOURCE_VERSION_CONFLICT');
  if(prior?.state==='IMPORTED'&&prior.source_revision===s.source_revision){const receipt=await this.one('SELECT * FROM sites_source_import_receipts WHERE source_key=? AND source_revision=?',[key,s.source_revision]);if(!receipt||receipt.descriptor_hash!==d.descriptor_hash||receipt.review_id!==id)fail('SOURCE_REVIEW_BINDING_CONFLICT');return {status:'DUPLICATE',id,source_key:key,...flags};}
  const resuming=prior?.state==='READING'&&prior.source_revision===s.source_revision;
  if(resuming&&!reconcileOnly||reconcileOnly&&!resuming)fail('SOURCE_IMPORT_RECONCILE_PENDING');
  const attempt=resuming?prior.attempt_id:crypto.randomUUID(),at=new Date().toISOString(),qa=s.qa_status==='PASS',reason=d.preflight_error||(!qa?'SOURCE_QA_REVIEW_REQUIRED':null),state=d.preflight_error?'FAILED':qa?'READING':'QA_BLOCKED';
  if(!resuming)await this.batch([this.guard('NOT EXISTS(SELECT 1 FROM sites_source_heads WHERE source_key=?) OR EXISTS(SELECT 1 FROM sites_source_heads WHERE source_key=? AND attempt_id=?)',[key,key,prior?.attempt_id??'']),
   this.statement('INSERT INTO sites_source_heads VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source_key) DO UPDATE SET source_revision=excluded.source_revision,descriptor_hash=excluded.descriptor_hash,summary_json=excluded.summary_json,state=excluded.state,attempt_id=excluded.attempt_id,reason=excluded.reason,updated_at=excluded.updated_at',[key,scope.workspace,scope.accountId,identityJson,s.source_revision,d.descriptor_hash,summaryJson,state,attempt,reason,at]),
   this.statement('INSERT INTO sites_source_attempts VALUES(?,?,?,?,?,?,?)',[attempt,key,s.source_revision,d.descriptor_hash,state,reason,at]),
   ...(state==='READING'?[this.statement('INSERT INTO sites_review_sources VALUES(?,?,?,?) ON CONFLICT(review_id) DO NOTHING',[id,key,s.source_revision,d.descriptor_hash]),this.guard('EXISTS(SELECT 1 FROM sites_review_sources WHERE review_id=? AND source_key=? AND source_revision=? AND descriptor_hash=?)',[id,key,s.source_revision,d.descriptor_hash])]:[])]);
  if(state!=='READING')return {status:state==='QA_BLOCKED'?'QA_BLOCKED':'SOURCE_BLOCKED',reason,source_key:key,qa_status:s.qa_status,...flags};
  let receipt;
  try{
   const existing=await this.one('SELECT request_json FROM sites_reviews WHERE id=? AND workspace=? AND account_id=?',[id,scope.workspace,scope.accountId]);
   if(existing){
    if(await approvalDigest(JSON.parse(existing.request_json))!==await approvalDigest(d.request))fail('SOURCE_REVIEW_BINDING_CONFLICT');
    const reviews=new AsyncReviewStore(this.db,this.options),detail=await reviews.detail(scope.workspace,scope.accountId,id);
    if(detail.assets.length!==d.files.length)fail('SOURCE_REVIEW_BINDING_CONFLICT');
    for(const file of d.files){const asset=detail.assets.find(a=>a.source_id===s.content_id&&a.artifact_id===file.artifact_id);if(!asset||asset.sha256!==file.sha256||asset.bytes!==file.bytes)fail('SOURCE_REVIEW_BINDING_CONFLICT');await reviews.objects.verify(asset.object_id,scope);}
    receipt={id,status:'DUPLICATE'};
   }else{
    if(reconcileOnly)fail('SOURCE_IMPORT_RECONCILE_PENDING');
    const packet=await bounded(this.provider.inspect(d),35000);
    if(packet?.request?.request_fingerprint!==id)fail('SOURCE_REQUEST_BINDING');
    const reviews=new AsyncReviewStore(this.db,{...this.options,inspectionProvider:{readInspection:async()=>packet}});receipt=await reviews.intake(reference);
   }
   await this.batch([this.currentGuard(key,attempt,d.descriptor_hash),this.statement('INSERT INTO sites_source_import_receipts VALUES(?,?,?,?)',[key,s.source_revision,d.descriptor_hash,receipt.id]),this.statement("UPDATE sites_source_heads SET state='IMPORTED',reason=NULL WHERE source_key=? AND attempt_id=?",[key,attempt]),this.statement("UPDATE sites_source_attempts SET state='IMPORTED' WHERE id=?",[attempt])]);
  }catch(error){
   if(error.message==='SOURCE_IMPORT_RECONCILE_PENDING')throw error;
   const saved=await this.one('SELECT * FROM sites_source_import_receipts WHERE source_key=? AND source_revision=? AND descriptor_hash=?',[key,s.source_revision,d.descriptor_hash]);if(saved)return {status:'DUPLICATE',id:saved.review_id,source_key:key,...flags};
   const reason=/^(SOURCE|ARCHIVE|REVIEW|OBJECT|VIDEO|IMAGE|INVALID)_[A-Z_]+$/.test(error.message)?error.message:'SOURCE_IMPORT_FAILED';
   await this.batch([this.statement("UPDATE sites_source_heads SET state='FAILED',reason=? WHERE source_key=? AND attempt_id=?",[reason,key,attempt]),this.statement("UPDATE sites_source_attempts SET state='FAILED',reason=? WHERE id=?",[reason,attempt])]);throw error;
  }
  return {...receipt,status:'REVIEW_REQUIRED',source_key:key,...flags};
 }
 currentGuard(key,attempt,hash){return this.guard("EXISTS(SELECT 1 FROM sites_source_heads WHERE source_key=? AND attempt_id=? AND descriptor_hash=? AND state='READING')",[key,attempt,hash]);}
}


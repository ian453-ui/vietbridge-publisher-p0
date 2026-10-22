import {sourceImportState} from './source-import-state.js';
import {AsyncStorage,bytes,digest,sha256,text,exact,fail} from './async-storage.js';
import {ScopedObjectStore,CLOUD_OBJECT_LIMIT,bounded} from './scoped-object-store.js';

const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const fingerprint=x=>digest(canonical(x));
const flags={publish_allowed:false,import_allowed:false,producer_authenticated:false,source_gate_satisfied:false,can_decide:false};
export const CLOUD_REVIEW_LIMITS=Object.freeze({artifacts:32,bytes:32*1024*1024,metadata:256*1024,wallMs:30000});

/** Async persistence for native inspection snapshots from a SERVER-INJECTED
 * provider. No production provider exists; the only provider is a test fixture.
 * Readback is never approval/source authentication, and never re-runs ffmpeg here.
 */
export class AsyncReviewStore extends AsyncStorage {
 constructor(db,{bucket,inspectionProvider=null,timeoutMs=5000,authorization=null}={}){super(db,{authorization});this.objects=bucket?new ScopedObjectStore(db,bucket,{timeoutMs,authorization}):null;this.provider=inspectionProvider;}
 async intake(reference,{commitStatements=[]}={}){
  exact(reference,['workspace','accountId','task_id','request_revision']);if(!text(reference.task_id)||!Number.isSafeInteger(reference.request_revision)||reference.request_revision<1)fail('REVIEW_REFERENCE_INVALID');await this.scope(reference.workspace,reference.accountId);
  if(!this.provider?.readInspection)fail('CLOUD_INSPECTOR_UNAVAILABLE');if(!this.objects)fail('R2_BINDING_REQUIRED');const deadline=performance.now()+CLOUD_REVIEW_LIMITS.wallMs;
  const packet=await bounded(this.provider.readInspection({...reference}),CLOUD_REVIEW_LIMITS.wallMs);
  exact(packet,['request','result','report','assets']);const {request,result,report,assets}=packet;
  const metadata=JSON.stringify({request,result,report});if(new TextEncoder().encode(metadata).length>CLOUD_REVIEW_LIMITS.metadata)fail('REVIEW_METADATA_LIMIT');
  if(!request||!result||!report||!Array.isArray(request.items)||!Array.isArray(result.items)||!Array.isArray(report.items)||!Array.isArray(assets)||assets.length<1||assets.length>CLOUD_REVIEW_LIMITS.artifacts)fail('REVIEW_PACKET_INVALID');
  const {request_fingerprint,assignment_mode,handoff_policy,...payload}=request;
  if(await fingerprint(payload)!==request_fingerprint||assignment_mode!=='STICKY'||handoff_policy!=='USER_EXPLICIT_ONLY'||request.schema_version!==2||request.mode!=='PRODUCTION_ARTIFACTS'||request.workspace!==reference.workspace||request.account_id!==reference.accountId||request.task_id!==reference.task_id||request.request_revision!==reference.request_revision)fail('REVIEW_REQUEST_BINDING');
  for(const k of ['schema_version','mode','task_id','request_revision','request_fingerprint','current_owner','producer','workspace','account_id'])if(result[k]!==request[k])fail('REVIEW_RESULT_BINDING');
  if(await fingerprint(result.bridge_ref)!==await fingerprint(request.bridge_ref))fail('REVIEW_RESULT_BINDING');
  const resultHash=await fingerprint(result);if(report.status!=='REVIEW_REQUIRED'||report.structure!=='VALIDATED'||report.scope_status!=='CALLER_DECLARED'||report.receipt?.request_fingerprint!==request_fingerprint||report.receipt?.result_fingerprint!==resultHash||report.publish_allowed!==false||report.import_allowed!==false||report.producer_authenticated!==false)fail('REVIEW_INSPECTION_UNVERIFIED');
  const expected=[];for(const item of result.items){const ri=report.items.find(x=>x.source_id===item.source_id);if(!ri||!Array.isArray(item.artifacts))fail('REVIEW_ASSET_BINDING');for(const artifact of item.artifacts){const meta=ri.artifacts.find(x=>x.artifact_id===artifact.artifact_id);if(!meta||meta.sha256!==artifact.sha256)fail('REVIEW_ASSET_BINDING');expected.push({source_id:item.source_id,...meta});}}
  if(expected.length!==assets.length||new Set(expected.map(x=>JSON.stringify([x.source_id,x.artifact_id]))).size!==assets.length)fail('REVIEW_ASSET_BINDING');let total=0;
  for(const a of assets){exact(a,['source_id','artifact_id','mime','data']);const matches=expected.filter(x=>x.source_id===a.source_id&&x.artifact_id===a.artifact_id);if(matches.length!==1)fail('REVIEW_ASSET_BINDING');const meta=matches[0],raw=bytes(a.data);total+=raw.length;
   if(raw.length<1||raw.length>CLOUD_OBJECT_LIMIT||raw.length!==meta.bytes||total>CLOUD_REVIEW_LIMITS.bytes)fail('REVIEW_ASSET_BUDGET');
   if(meta.kind==='video'&&(meta.validation?.level!=='VIDEO_DECODED'||meta.validation.decoded!==true)||meta.kind==='cover'&&meta.validation?.level!=='IMAGE_DECODED')fail('REVIEW_DECODE_RECEIPT_REQUIRED');
   if(await sha256(raw)!==meta.sha256)fail('REVIEW_ASSET_HASH_MISMATCH');
  }
  if(new Set(assets.map(x=>JSON.stringify([x.source_id,x.artifact_id]))).size!==assets.length)fail('REVIEW_ASSET_BINDING');
  const identity=await fingerprint(Object.fromEntries(['task_id','current_owner','producer','workspace','account_id','bridge_ref'].map(k=>[k,request[k]]))),envelopeHash=await digest(metadata);
  const prior=await this.one('SELECT * FROM sites_reviews WHERE task_id=? ORDER BY request_revision DESC LIMIT 1',[request.task_id]);
  if(prior){if(prior.workspace!==request.workspace||prior.account_id!==request.account_id)fail('REVIEW_TASK_SCOPE_CONFLICT');if(prior.request_revision>request.request_revision)fail('STALE_REVIEW_VERSION');if(prior.request_revision===request.request_revision&&prior.envelope_hash!==envelopeHash)fail('CONFLICTING_REVIEW_RESULT');}
  // Validate the whole packet before any object writes. Keep immutable objects
  // after a later SQL failure for explicit reconciliation; never delete originals.
  const references=[];for(const a of assets){const stored=await this.objects.put({workspace:request.workspace,accountId:request.account_id,review_id:request_fingerprint,source_id:a.source_id,artifact_id:a.artifact_id},a.data,a.mime,{deadline:Math.min(deadline,performance.now()+this.objects.timeoutMs)});references.push({...a,object_id:stored.id});}
  const statements=[this.scopeGuard(request.workspace,request.account_id),...this.taskBinding(request.task_id,request.workspace,request.account_id),
   this.statement('UPDATE sites_task_bindings SET identity_hash=? WHERE task_id=? AND identity_hash IS NULL',[identity,request.task_id]),this.guard('EXISTS(SELECT 1 FROM sites_task_bindings WHERE task_id=? AND identity_hash=?)',[request.task_id,identity]),
   this.guard('NOT EXISTS(SELECT 1 FROM sites_reviews WHERE task_id=? AND request_revision>?)',[request.task_id,request.request_revision]),
   this.statement("INSERT INTO sites_reviews VALUES(?,?,?,?,?,?,?,?,?,?,'REVIEW_REQUIRED',?) ON CONFLICT(task_id,request_revision) DO NOTHING",[request_fingerprint,request.task_id,request.request_revision,request.workspace,request.account_id,JSON.stringify(request),JSON.stringify(result),JSON.stringify(report),envelopeHash,resultHash,new Date().toISOString()]),
   this.guard('EXISTS(SELECT 1 FROM sites_reviews WHERE id=? AND envelope_hash=?)',[request_fingerprint,envelopeHash])];
  for(const a of references)statements.push(this.guard("EXISTS(SELECT 1 FROM sites_objects WHERE id=? AND workspace=? AND account_id=? AND state='READY')",[a.object_id,request.workspace,request.account_id]),this.statement('INSERT INTO sites_review_assets VALUES(?,?,?,?) ON CONFLICT(review_id,source_id,artifact_id) DO NOTHING',[request_fingerprint,a.source_id,a.artifact_id,a.object_id]));
  // Internal caller may bind lineage in this SAME transaction; never client SQL.
  await this.batch([...statements,...commitStatements]);return {id:request_fingerprint,status:prior?.id===request_fingerprint?'DUPLICATE':'REVIEW_REQUIRED',...flags};
 }
 async list(workspace,accountId,{cursor=''}={}){await this.scope(workspace,accountId);if(cursor&&!/^[a-f0-9]{64}$/.test(cursor))fail('REVIEW_CURSOR_INVALID');const rows=await this.rows('SELECT id,task_id,request_revision,state,created_at FROM sites_reviews WHERE workspace=? AND account_id=? AND id>? ORDER BY id LIMIT 21',[workspace,accountId,cursor]);return {reviews:rows.slice(0,20),next_cursor:rows.length>20?rows[19].id:null,...flags};}
 async detail(workspace,accountId,id){
  await this.scope(workspace,accountId);const row=await this.one('SELECT * FROM sites_reviews WHERE id=? AND workspace=? AND account_id=?',[id,workspace,accountId]);if(!row)fail('REVIEW_NOT_FOUND');
  const request=JSON.parse(row.request_json),result=JSON.parse(row.result_json),report=JSON.parse(row.report_json);if(await digest(JSON.stringify({request,result,report}))!==row.envelope_hash)fail('REVIEW_STORAGE_CORRUPT');
  const assets=await this.rows('SELECT a.source_id,a.artifact_id,a.object_id,o.sha256,o.bytes,o.mime,o.state FROM sites_review_assets a JOIN sites_objects o ON o.id=a.object_id WHERE a.review_id=? AND o.workspace=? AND o.account_id=? ORDER BY a.source_id,a.artifact_id',[id,workspace,accountId]);
  const latest=await this.one('SELECT max(request_revision) revision FROM sites_reviews WHERE task_id=?',[row.task_id]);
  const source=await sourceImportState(this,id),source_import=source.required?{state:source.state,blocked_reason:source.blocked,source_revision:source.source_revision,current_revision:source.current_revision,summary:JSON.parse(source.summary_json)}:null;
  return {id,source_import,task_id:row.task_id,request_revision:row.request_revision,state:latest.revision===row.request_revision?'REVIEW_REQUIRED':'SUPERSEDED',report,assets,blocked_reason:'CLOUD_APPROVAL_TRANSPORT_UNAVAILABLE',...flags};
 }
 async asset(workspace,accountId,id,source,artifact){
  const review=await this.detail(workspace,accountId,id),asset=review.assets.find(a=>a.source_id===source&&a.artifact_id===artifact);if(!asset)fail('REVIEW_ASSET_NOT_FOUND');if(!this.objects)fail('R2_BINDING_REQUIRED');return this.objects.verify(asset.object_id,{workspace,accountId});
 }
}

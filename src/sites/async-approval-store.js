import {sourceImportState} from './source-import-state.js';
import {AsyncStorage,digest,fail,authorizationGuard} from './async-storage.js';
import {CLOUD_REVIEW_LIMITS,AsyncReviewStore} from './async-review-store.js';
import {productionReviewChecks,requireProductionAdmin,validateProductionDecision,approvalIdentityFields} from '../production-approval-policy.js';
import {publishingPlatforms} from '../publisher-platform-policy.js';
const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
export const approvalDigest=x=>digest(canonical(x));
const flags={publish_allowed:false,import_allowed:false,source_gate_satisfied:false,producer_authenticated:false};
export const APPROVAL_LINEAGE_LIMITS=Object.freeze({nodes:8,bytes:128*1024*1024,wallMs:CLOUD_REVIEW_LIMITS.wallMs});
function enterLineage(resolution,scope,id){
 const r=resolution||{path:[],budget:{nodes:0,bytes:0,deadline:performance.now()+APPROVAL_LINEAGE_LIMITS.wallMs}},key=JSON.stringify([scope.workspace,scope.accountId,id]);
 if(r.path.includes(key))fail('APPROVAL_LINEAGE_CYCLE');
 if(++r.budget.nodes>APPROVAL_LINEAGE_LIMITS.nodes)fail('APPROVAL_LINEAGE_LIMIT');
 if(performance.now()>=r.budget.deadline)fail('APPROVAL_LINEAGE_TIME_LIMIT');
 return {path:[...r.path,key],budget:r.budget};
}
const lineageFailure=error=>{if(/^APPROVAL_LINEAGE_/.test(error.message))throw error;};

/** Same content-only decision policy as ProductionApprovalStore. No Site owner
 * is promoted to admin. Binding rows and authorities are server dependencies;
 * the only current binding/authority provider is under test/fixtures. */
export class AsyncApprovalStore extends AsyncStorage {
 constructor(db,options={}){super(db,options);this.options=options;this.reviews=new AsyncReviewStore(db,options);}
 async latest(id){return this.one('SELECT * FROM sites_approval_events WHERE review_id=? ORDER BY sequence DESC LIMIT 1',[id]);}
 async subject(id,scope,{allowDerivation=true,allowEdited=true,resolution=null}={}){
  const traversal=enterLineage(resolution,scope,id);
  const detail=await this.reviews.detail(scope.workspace,scope.accountId,id),row=await this.one('SELECT * FROM sites_reviews WHERE id=?',[id]);
  const request=JSON.parse(row.request_json),result=JSON.parse(row.result_json),account=await this.scope(scope.workspace,scope.accountId);
  if(request.request_fingerprint!==id||request.task_id!==row.task_id||request.request_revision!==row.request_revision||request.workspace!==scope.workspace||request.account_id!==scope.accountId||await approvalDigest(result)!==row.result_fingerprint||result.request_fingerprint!==id||detail.report.receipt?.result_fingerprint!==row.result_fingerprint)fail('APPROVAL_STORAGE_CORRUPT');
  if(detail.report.status!=='REVIEW_REQUIRED'||detail.report.structure!=='VALIDATED'||detail.report.scope_status==='UNKNOWN')fail('APPROVAL_STATE_UNKNOWN');
  const expected=result.items.flatMap(item=>item.artifacts.map(a=>({source_id:item.source_id,artifact_id:a.artifact_id,sha256:a.sha256})));
  const totalBytes=detail.assets.reduce((n,a)=>n+a.bytes,0);
  if(expected.length!==detail.assets.length||detail.assets.length>CLOUD_REVIEW_LIMITS.artifacts||totalBytes>CLOUD_REVIEW_LIMITS.bytes)fail('APPROVAL_STORAGE_CORRUPT');
  traversal.budget.bytes+=totalBytes;if(traversal.budget.bytes>APPROVAL_LINEAGE_LIMITS.bytes)fail('APPROVAL_LINEAGE_BYTE_LIMIT');
  if(performance.now()>=traversal.budget.deadline)fail('APPROVAL_LINEAGE_TIME_LIMIT');const deadline=traversal.budget.deadline;
  for(const a of expected){const stored=detail.assets.find(x=>x.source_id===a.source_id&&x.artifact_id===a.artifact_id);if(!stored||stored.sha256!==a.sha256)fail('APPROVAL_STORAGE_CORRUPT');await this.reviews.objects.verify(stored.object_id,scope,{deadline:Math.min(deadline,performance.now()+this.reviews.objects.timeoutMs)});}
  const binding=await this.one('SELECT binding_json FROM sites_approval_bindings WHERE review_id=?',[id]);let b=null;try{b=binding?JSON.parse(binding.binding_json):null;}catch{fail('APPROVAL_STORAGE_CORRUPT');}
  const native=b?.account,accountHash=await approvalDigest(Object.fromEntries(approvalIdentityFields.map(k=>[k,native?.[k]??null]))),targets=[...new Set([account.platform,...request.items.flatMap(x=>x.deliverables.map(a=>a.platform).filter(Boolean))])].sort();
  let blocked=null;
  if(!b||b.kind!=='SYNTHETIC_FIXTURE'||b.request_fingerprint!==id||b.result_fingerprint!==row.result_fingerprint)blocked='PRODUCER_AUTH_UNAVAILABLE';
  else if(!request.task_id.startsWith('SYNTHETIC-')||request.items.some(x=>!x.source_id.startsWith('SYNTHETIC-')))blocked='SYNTHETIC_PROVENANCE_INVALID';
  else if(b.account_hash!==accountHash||native.id!==scope.accountId||native.workspace!==scope.workspace||native.platform!==account.platform||native.external_id!==account.external_identity)blocked='ACCOUNT_TARGET_CHANGED';
  else if(b.source_state!=='SYNTHETIC_NO_EXTERNAL_SOURCE')blocked='SOURCE_PROVIDER_UNAVAILABLE';
  if(scope.workspace==='ws-vietbridge'||b?.workspace_kind==='enterprise')blocked='ENTERPRISE_SOURCE_APPROVAL_FORBIDDEN';
  if(b&&(!native?.enabled||!native?.external_id||targets.some(p=>!publishingPlatforms[p])))blocked='TARGET_IDENTITY_UNKNOWN';
  if(detail.state==='SUPERSEDED')blocked='STALE_REVIEW_VERSION';
  const fingerprint=await approvalDigest({request_fingerprint:id,result_fingerprint:row.result_fingerprint,account_hash:accountHash,target_platforms:targets,artifacts:expected,source_refs:request.items.map(x=>({source_id:x.source_id,refs:x.source_refs}))});
  const source_import=await sourceImportState(this,id);if(source_import.blocked)blocked=source_import.blocked;
  const platform_edit=await this.one('SELECT * FROM sites_review_edit_invalidations WHERE review_id=?',[id]);if(platform_edit&&!blocked)blocked='APPROVAL_PLATFORM_EDIT_REVIEW_REQUIRED';
  const derivation=await this.derivationSubject(id,scope,request,{allowDerivation,accountHash,platform:account.platform,resolution:traversal});if(derivation.blocked)blocked=derivation.blocked;
  const edited=await this.editedSubject(id,scope,request,{allowEdited,allowDerivation,resolution:traversal});if(edited.blocked)blocked=edited.blocked;
  if(derivation.row&&edited.row)fail('APPROVAL_LINEAGE_AMBIGUOUS');
  if(performance.now()>=traversal.budget.deadline)fail('APPROVAL_LINEAGE_TIME_LIMIT');
  return {fingerprint,blocked,platform_edit,derivation,edited,source_import,lineage_usage:{...traversal.budget},target_platforms:targets,provenance:b?.kind==='SYNTHETIC_FIXTURE'?'SYNTHETIC_FIXTURE':'UNVERIFIED',row,request,result,assets:detail.assets,account,binding:binding?.binding_json??null};
 }
 // Each edit edge accepts only its exact edit-generated revocation. Ancestors
 // retain their own edit/target semantics and share one bounded traversal.
 async editedSource(contentId,scope,{resolution=null,allowDerivation=true}={}){
  await this.scope(scope.workspace,scope.accountId);
  const row=await this.one('SELECT * FROM sites_contents WHERE id=? AND workspace=? AND account_id=?',[contentId,scope.workspace,scope.accountId]),edit=await this.one('SELECT * FROM sites_content_edits WHERE content_id=?',[contentId]);
  if(!row||!edit?.source_plan_id)fail('VARIANT_REVIEW_EDIT_REQUIRED');const variants=JSON.parse(row.variants_json);
  if(await approvalDigest({content_id:row.content_id,slug:row.slug,revision:row.revision,title:row.title,body:row.body,variants})!==row.payload_hash)fail('VARIANT_SOURCE_CORRUPT');
  const latest=await this.one('SELECT id FROM sites_contents WHERE workspace=? AND account_id=? AND content_id=? AND slug=? ORDER BY revision DESC LIMIT 1',[row.workspace,row.account_id,row.content_id,row.slug]);if(latest.id!==row.id)fail('VARIANT_VERSION_CONFLICT');
  const plan=await this.one('SELECT * FROM sites_upload_plans WHERE id=? AND workspace=? AND account_id=?',[edit.source_plan_id,scope.workspace,scope.accountId]);if(!plan||await digest(plan.manifest_json)!==plan.manifest_hash)fail('VARIANT_MEDIA_BINDING_CHANGED');
  const manifest=JSON.parse(plan.manifest_json),binding={root_content_id:plan.content_id,source_plan_id:plan.id,source_review_id:plan.review_id,source_subject:plan.subject_fingerprint,source_event_id:plan.approval_event_id,manifest_hash:plan.manifest_hash,platform:manifest.platform,media:manifest.media};
  if(await approvalDigest(JSON.parse(edit.source_json))!==await approvalDigest(binding))fail('VARIANT_MEDIA_BINDING_CHANGED');
  const source=await this.subject(plan.review_id,scope,{allowDerivation,resolution});
  if(source.blocked!=='APPROVAL_PLATFORM_EDIT_REVIEW_REQUIRED'||source.provenance!=='SYNTHETIC_FIXTURE'||source.fingerprint!==plan.subject_fingerprint||source.account.platform!==manifest.platform||edit.platform!==manifest.platform||!variants[manifest.platform])fail('VARIANT_REVIEW_SOURCE_CHANGED');
  const mark=source.platform_edit,anchor=mark&&await this.one('SELECT c.*,e.source_json FROM sites_content_edits e JOIN sites_contents c ON c.id=e.content_id WHERE e.content_id=?',[mark.content_id]);
  if(!anchor||anchor.workspace!==row.workspace||anchor.account_id!==row.account_id||anchor.content_id!==row.content_id||anchor.slug!==row.slug||anchor.revision>row.revision||anchor.source_json!==edit.source_json||mark.platform!==manifest.platform)fail('VARIANT_REVIEW_SOURCE_CHANGED');
  const events=await this.rows('SELECT * FROM sites_approval_events WHERE review_id=? AND sequence>=(SELECT sequence FROM sites_approval_events WHERE id=?) ORDER BY sequence',[plan.review_id,plan.approval_event_id]);
  if(events.length!==2||events[0].id!==plan.approval_event_id||events[0].kind!=='CONTENT_APPROVED'||events[0].subject_fingerprint!==source.fingerprint||events[1].kind!=='REVOKED'||events[1].reason!=='PLATFORM_TEXT_EDIT_REQUIRES_NEW_INSPECTION'||events[1].subject_fingerprint!==source.fingerprint)fail('VARIANT_REVIEW_SOURCE_CHANGED');
  const lineage={workspace:row.workspace,account_id:row.account_id,content_id:row.id,content_revision:row.revision,payload_hash:row.payload_hash,source_binding:binding,source_binding_hash:await approvalDigest(binding),revocation_id:events[1].id,payload:variants[manifest.platform]};
  return {row,edit,plan,manifest,source,lineage,revocation:events[1]};
 }
 editedSourceGuards(c){const {row:r,edit:e,plan:p,source:s,revocation:v}=c;return [...this.subjectGuards(s),this.latestGuard(s.row.id,v.id),
  this.guard('EXISTS(SELECT 1 FROM sites_contents WHERE id=? AND workspace=? AND account_id=? AND content_id=? AND slug=? AND revision=? AND title=? AND body=? AND variants_json=? AND payload_hash=?)',[r.id,r.workspace,r.account_id,r.content_id,r.slug,r.revision,r.title,r.body,r.variants_json,r.payload_hash]),
  this.guard('NOT EXISTS(SELECT 1 FROM sites_contents WHERE workspace=? AND account_id=? AND content_id=? AND slug=? AND revision>?)',[r.workspace,r.account_id,r.content_id,r.slug,r.revision]),
  this.guard('EXISTS(SELECT 1 FROM sites_content_edits WHERE content_id=? AND parent_content_id=? AND platform=? AND source_plan_id=? AND source_json=?)',[r.id,e.parent_content_id,e.platform,e.source_plan_id,e.source_json]),
  this.guard('EXISTS(SELECT 1 FROM sites_upload_plans WHERE id=? AND workspace=? AND account_id=? AND review_id=? AND content_id=? AND subject_fingerprint=? AND approval_event_id=? AND manifest_hash=? AND manifest_json=?)',[p.id,p.workspace,p.account_id,p.review_id,p.content_id,p.subject_fingerprint,p.approval_event_id,p.manifest_hash,p.manifest_json])];}
 async editedSubject(id,scope,request,{allowEdited,allowDerivation,resolution}){
  const row=await this.one('SELECT * FROM sites_variant_reviews WHERE review_id=?',[id]);if(!row)return {blocked:request.task_id.startsWith('SYNTHETIC-EDIT-')?'APPROVAL_EDIT_LINEAGE_MISSING':null};
  if(!allowEdited)return {row,blocked:'APPROVAL_EDIT_CHAIN_UNSUPPORTED'};
  try{const source=await this.editedSource(row.content_id,scope,{resolution,allowDerivation}),lineage=JSON.parse(row.lineage_json);
   if(await approvalDigest(source.lineage)!==await approvalDigest(lineage)||request.task_id!=='SYNTHETIC-EDIT-'+await approvalDigest({workspace:scope.workspace,account_id:scope.accountId,root_content_id:source.plan.content_id})||request.request_revision!==source.row.revision)fail('APPROVAL_EDIT_SOURCE_CHANGED');
   return {row,source,lineage,blocked:null};
  }catch(error){lineageFailure(error);return {row,blocked:'APPROVAL_EDIT_SOURCE_CHANGED'};}
 }
 editedGuards(s){const e=s.edited;if(!e?.row)return [this.guard('NOT EXISTS(SELECT 1 FROM sites_variant_reviews WHERE review_id=?)',[s.row.id])];if(e.blocked||!e.source)fail('APPROVAL_EDIT_SOURCE_CHANGED');return [this.guard('EXISTS(SELECT 1 FROM sites_variant_reviews WHERE review_id=? AND content_id=? AND lineage_json=?)',[s.row.id,e.row.content_id,e.row.lineage_json]),...this.editedSourceGuards(e.source)];}
 async derivationSubject(id,scope,request,{allowDerivation,accountHash,platform,resolution}){
  const row=await this.one('SELECT * FROM sites_review_derivations WHERE review_id=?',[id]);
  if(!row)return {blocked:request.task_id.startsWith('SYNTHETIC-TARGET-')?'APPROVAL_SOURCE_LINEAGE_MISSING':null};
  if(!allowDerivation)return {blocked:'APPROVAL_SOURCE_CHAIN_UNSUPPORTED'};
  try{
   const lineage=JSON.parse(row.lineage_json);
   if(request.task_id!=='SYNTHETIC-TARGET-'+await approvalDigest({lineage,target:scope.accountId,accountHash,platform})||lineage.workspace!==scope.workspace||lineage.source_account_id===scope.accountId||!this.authorization)fail('APPROVAL_SOURCE_LINEAGE_INVALID');
   const authorization={...this.authorization,accountId:lineage.source_account_id},store=new AsyncApprovalStore(this.db,{...this.options,authorization});
   const source=await store.subject(lineage.source_review_id,{workspace:scope.workspace,accountId:lineage.source_account_id},{allowDerivation:false,resolution}),latest=await store.latest(lineage.source_review_id);
   const plan=await store.one('SELECT * FROM sites_upload_plans WHERE id=?',[lineage.source_plan_id]);
   if(source.blocked||source.fingerprint!==lineage.source_subject||latest?.id!==lineage.source_event_id||latest.kind!=='CONTENT_APPROVED'||!plan||plan.workspace!==scope.workspace||plan.account_id!==lineage.source_account_id||plan.review_id!==lineage.source_review_id||plan.manifest_hash!==lineage.source_manifest_hash||plan.subject_fingerprint!==lineage.source_subject||plan.approval_event_id!==lineage.source_event_id)fail('APPROVAL_SOURCE_CHANGED');
   return {row,lineage,store,source,authorization,blocked:null};
  }catch(error){lineageFailure(error);return {row,blocked:'APPROVAL_SOURCE_CHANGED'};}
 }
 derivationGuards(s){
  const d=s.derivation;if(!d?.row)return [this.guard('NOT EXISTS(SELECT 1 FROM sites_review_derivations WHERE review_id=?)',[s.row.id])];
  if(d.blocked||!d.source)fail('APPROVAL_SOURCE_CHANGED');const l=d.lineage;
  return [this.guard('EXISTS(SELECT 1 FROM sites_review_derivations WHERE review_id=? AND lineage_json=?)',[s.row.id,d.row.lineage_json]),authorizationGuard(this.db,d.authorization),...d.store.subjectGuards(d.source),d.store.latestGuard(l.source_review_id,l.source_event_id),this.guard('EXISTS(SELECT 1 FROM sites_upload_plans WHERE id=? AND workspace=? AND account_id=? AND review_id=? AND manifest_hash=? AND subject_fingerprint=? AND approval_event_id=?)',[l.source_plan_id,l.workspace,l.source_account_id,l.source_review_id,l.source_manifest_hash,l.source_subject,l.source_event_id])];
 }
 subjectGuards(s){return [...this.editedGuards(s),...(s.platform_edit?[this.guard('EXISTS(SELECT 1 FROM sites_review_edit_invalidations WHERE review_id=? AND content_id=?)',[s.row.id,s.platform_edit.content_id])]:[this.guard('NOT EXISTS(SELECT 1 FROM sites_review_edit_invalidations WHERE review_id=?)',[s.row.id])]),...this.derivationGuards(s),...(s.source_import?.required?[this.guard("EXISTS(SELECT 1 FROM sites_source_heads WHERE source_key=? AND attempt_id=? AND source_revision=? AND descriptor_hash=? AND state='IMPORTED')",[s.source_import.source_key,s.source_import.attempt_id,s.source_import.source_revision,s.source_import.descriptor_hash])]:[this.guard('NOT EXISTS(SELECT 1 FROM sites_review_sources WHERE review_id=?)',[s.row.id])]),this.guard('EXISTS(SELECT 1 FROM sites_reviews WHERE id=? AND workspace=? AND account_id=? AND envelope_hash=? AND request_json=? AND result_json=? AND report_json=? AND request_revision=(SELECT max(request_revision) FROM sites_reviews WHERE task_id=?))',[s.row.id,s.row.workspace,s.row.account_id,s.row.envelope_hash,s.row.request_json,s.row.result_json,s.row.report_json,s.row.task_id]),this.guard('EXISTS(SELECT 1 FROM sites_approval_bindings WHERE review_id=? AND binding_json=?)',[s.row.id,s.binding]),this.guard('EXISTS(SELECT 1 FROM sites_account_details WHERE workspace=? AND account_id=? AND platform=? AND external_identity IS ?)',[s.row.workspace,s.row.account_id,s.account.platform,s.account.external_identity]),this.guard('(SELECT count(*) FROM sites_review_assets WHERE review_id=?)=?',[s.row.id,s.assets.length]),...s.assets.map(a=>this.guard("EXISTS(SELECT 1 FROM sites_review_assets a JOIN sites_objects o ON o.id=a.object_id WHERE a.review_id=? AND a.source_id=? AND a.artifact_id=? AND o.id=? AND o.sha256=? AND o.bytes=? AND o.mime=? AND o.state='READY' AND o.workspace=? AND o.account_id=?)",[s.row.id,a.source_id,a.artifact_id,a.object_id,a.sha256,a.bytes,a.mime,s.row.workspace,s.row.account_id]))];}
 latestGuard(id,eventId){return this.guard('(SELECT id FROM sites_approval_events WHERE review_id=? ORDER BY sequence DESC LIMIT 1) IS ?',[id,eventId]);}
 eventStatement(id,fingerprint,kind,actor,reason,checks,eventId=crypto.randomUUID()){return {eventId,statement:this.statement('INSERT INTO sites_approval_events(id,review_id,subject_fingerprint,kind,actor_id,reason,checks_json,created_at) VALUES(?,?,?,?,?,?,?,?)',[eventId,id,fingerprint,kind,actor,reason,JSON.stringify(checks),new Date().toISOString()])};}
 async view(id,scope,{admin=false}={}){
  for(let retry=0;retry<3;retry++){
   let subject;try{subject=await this.subject(id,scope);}catch(error){if(!/^(APPROVAL_|REVIEW_STORAGE|OBJECT_)/.test(error.message))throw error;subject={fingerprint:null,blocked:error.message,provenance:'UNKNOWN',target_platforms:[]};}
   let latest=await this.latest(id);
   if(latest?.kind==='CONTENT_APPROVED'&&(subject.blocked||latest.subject_fingerprint!==subject.fingerprint)){
    const event=this.eventStatement(id,latest.subject_fingerprint,'REVOKED','SYSTEM_VALIDATOR',subject.blocked||'APPROVAL_SUBJECT_CHANGED',{});
    try{await this.batch([this.latestGuard(id,latest.id),event.statement]);}catch(error){if(error.message==='SCOPE_DENIED')throw error;if(/CHECK constraint/.test(error.message))continue;throw error;}latest=await this.latest(id);
   }
   const history=await this.rows('SELECT * FROM sites_approval_events WHERE review_id=? ORDER BY sequence DESC LIMIT 101',[id]);
   return {state:subject.blocked?(latest?.kind==='REVOKED'?'REVOKED':'BLOCKED'):(latest?.kind||'PENDING'),blocked_reason:subject.blocked,subject_fingerprint:subject.fingerprint,latest_event_id:latest?.id||null,target_platforms:subject.target_platforms,provenance:subject.provenance,can_decide:admin&&!subject.blocked,required_checks:productionReviewChecks,history:history.slice(0,100),history_truncated:history.length>100,...flags};
  }fail('APPROVAL_CONCURRENT_CHANGE');
 }
 async decide(id,input,scope,{authority}={}){
  requireProductionAdmin(authority);validateProductionDecision(input);
  await this.scope(scope.workspace,scope.accountId);if(!await this.one('SELECT 1 FROM sites_reviews WHERE id=? AND workspace=? AND account_id=?',[id,scope.workspace,scope.accountId]))fail('REVIEW_NOT_FOUND');
  const commandHash=await approvalDigest({review_id:id,scope,input,actor:authority.actor_id});
  const receipt=async()=>{const p=await this.one('SELECT * FROM sites_approval_commands WHERE command_id=?',[input.command_id]);if(p&&p.command_hash!==commandHash)fail('APPROVAL_COMMAND_CONFLICT');return p;};
  const respond=async(p,status)=>{let approval=null,readback_pending=false;try{approval=await this.view(id,scope,{admin:true});}catch{readback_pending=true;}return {status,committed:true,event_id:p.event_id,approval,readback_pending,...flags};};
  const prior=await receipt();if(prior)return respond(prior,'DUPLICATE');
  const view=await this.view(id,scope,{admin:true});if(view.blocked_reason)fail(view.blocked_reason);if(view.subject_fingerprint!==input.expected_subject)fail('APPROVAL_STALE_SUBJECT');
  const s=await this.subject(id,scope);if(s.blocked||s.fingerprint!==input.expected_subject)fail(s.blocked||'APPROVAL_STALE_SUBJECT');
  const latest=await this.latest(id),kind=input.decision==='APPROVE'?'CONTENT_APPROVED':'CONTENT_REJECTED';
  const same=latest&&latest.kind===kind&&latest.subject_fingerprint===s.fingerprint&&latest.actor_id===authority.actor_id&&latest.reason===input.reason&&await approvalDigest(JSON.parse(latest.checks_json))===await approvalDigest(input.checks);
  if(!same&&(latest?.id||null)!==input.expected_event_id)fail('APPROVAL_STALE_DECISION');
  const e=same?{eventId:latest.id}:this.eventStatement(id,s.fingerprint,kind,authority.actor_id,input.reason,input.checks);
  try{await this.batch([...this.subjectGuards(s),this.latestGuard(id,latest?.id||null),...(same?[]:[e.statement]),this.statement('INSERT INTO sites_approval_commands VALUES(?,?,?)',[input.command_id,commandHash,e.eventId])]);}
  catch(error){const committed=await receipt();if(committed)return respond(committed,'DUPLICATE');if(/CHECK constraint/.test(error.message))fail('APPROVAL_CONCURRENT_CHANGE');throw error;}
  return respond({event_id:e.eventId},same?'DUPLICATE':'RECORDED');
 }
}

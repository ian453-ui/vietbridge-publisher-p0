import {AsyncStorage,exact,fail,text,authorizationGuard} from './async-storage.js';
import {approvalDigest} from './async-approval-store.js';
import {AsyncUploadPlans} from './async-upload-plans.js';
import {requireProductionAdmin} from '../production-approval-policy.js';
import {publishingPlatforms} from '../publisher-platform-policy.js';
const flags={publish_allowed:false,producer_authenticated:false,source_gate_satisfied:false};
const family=c=>[c.workspace,c.account_id,c.content_id,c.slug];
const contentHash=c=>approvalDigest({content_id:c.content_id,slug:c.slug,revision:c.revision,title:c.title,body:c.body,variants:JSON.parse(c.variants_json)});
/** Single-platform patch on the existing immutable content versions. Commands
 * reuse sites_authoring_commands; source/Review/media stay in their own scopes. */
export class AsyncVariantEdits extends AsyncStorage {
 constructor(db,options={}){super(db,options);this.options=options;}
 async source(id,scope){
  if(!this.authorization)fail('SITES_AUTHORIZATION_CONTEXT_REQUIRED');await this.scope(scope.workspace,scope.accountId);
  const row=await this.one('SELECT * FROM sites_contents WHERE id=? AND workspace=?',[id,scope.workspace]);if(!row)fail('VARIANT_CONTENT_NOT_FOUND');
  const authorization={...this.authorization,accountId:row.account_id},options={...this.options,authorization};await new AsyncStorage(this.db,options).scope(row.workspace,row.account_id);return {row,authorization,options};
 }
 async describe(x){
  const {row,options}=x;if(await contentHash(row)!==row.payload_hash)fail('VARIANT_SOURCE_CORRUPT');
  const edit=await this.one('SELECT * FROM sites_content_edits WHERE content_id=?',[row.id]),plan=await this.one('SELECT id FROM sites_upload_plans WHERE content_id=?',[row.id]);
  let source=edit?JSON.parse(edit.source_json):{root_content_id:row.id,source_plan_id:plan?.id||null};let prepared=null;
  if(source.source_plan_id){prepared=await new AsyncUploadPlans(this.db,options).read(source.source_plan_id,{workspace:row.workspace,accountId:row.account_id});const {p,manifest}=prepared;
   const actual={root_content_id:p.content_id,source_plan_id:p.id,source_review_id:p.review_id,source_subject:p.subject_fingerprint,source_event_id:p.approval_event_id,manifest_hash:p.manifest_hash,platform:manifest.platform,media:manifest.media};
   if(edit&&await approvalDigest(source)!==await approvalDigest(actual))fail('VARIANT_MEDIA_BINDING_CHANGED');source=actual;
  }
  if(edit&&edit.source_plan_id!==source.source_plan_id)fail('VARIANT_SOURCE_CORRUPT');
  const latest=await this.one('SELECT id,revision,payload_hash FROM sites_contents WHERE workspace=? AND account_id=? AND content_id=? AND slug=? ORDER BY revision DESC LIMIT 1',family(row));
  return {source,prepared,edit,latest,source_binding_hash:await approvalDigest(source)};
 }
 async view(id,scope){const x=await this.source(id,scope),d=await this.describe(x);return {content:{...x.row,variants:JSON.parse(x.row.variants_json),variants_json:undefined},source:d.source,source_binding_hash:d.source_binding_hash,latest:d.latest,requires_new_inspection:!!d.source.source_plan_id,...flags};}
 rowGuard(row){return this.guard('EXISTS(SELECT 1 FROM sites_contents WHERE id=? AND workspace=? AND account_id=? AND content_id=? AND slug=? AND revision=? AND title=? AND body=? AND variants_json=? AND payload_hash=?)',[row.id,...family(row),row.revision,row.title,row.body,row.variants_json,row.payload_hash]);}
 async save(id,input,scope,{authority=null}={}){
  exact(input,['command_id','expected_payload_hash','expected_source_binding','platform','title','body'],'VARIANT_INPUT_INVALID');
  if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(input.command_id)||(typeof input.platform!=='string'||!Object.hasOwn(publishingPlatforms,input.platform))||!text(input.title,200)||!text(input.body,20000)||![input.expected_payload_hash,input.expected_source_binding].every(x=>/^[a-f0-9]{64}$/.test(x)))fail('VARIANT_INPUT_INVALID');
  const x=await this.source(id,scope),{row}=x,owner=this.authorization.userId,commandHash=await approvalDigest({kind:'CONTENT',input:{operation:'PLATFORM_VARIANT_EDIT',workspace:scope.workspace,viewer_account_id:scope.accountId,source_row_id:id,...input}});
  // Read durable receipts before freshness/QA/approval. Scope checks still apply.
  const receipt=async()=>{const r=await this.one('SELECT * FROM sites_authoring_commands WHERE owner_user_id=? AND command_id=?',[owner,input.command_id]);if(r&&(r.kind!=='CONTENT'||r.command_hash!==commandHash))fail('VARIANT_COMMAND_CONFLICT');if(r&&r.committed!==1)fail('VARIANT_COMMAND_OUTCOME_UNKNOWN');return r;};
  const respond=async(r,duplicate)=>{const saved=await this.one('SELECT id,revision,payload_hash FROM sites_contents WHERE id=? AND workspace=? AND account_id=?',[r.entity_id,row.workspace,row.account_id]);if(!saved)fail('VARIANT_RECEIPT_CORRUPT');return {...saved,committed:true,duplicate,current_state:'READBACK_REQUIRED',...flags};};
  const prior=await receipt();if(prior)return respond(prior,true);
  const d=await this.describe(x);if(d.latest.id!==id||row.payload_hash!==input.expected_payload_hash)fail('VARIANT_VERSION_CONFLICT');if(d.source_binding_hash!==input.expected_source_binding)fail('VARIANT_MEDIA_BINDING_CHANGED');if(row.revision>=100000)fail('VARIANT_REVISION_LIMIT');
  const variants=JSON.parse(row.variants_json),replacement={...variants[input.platform],title:input.title,body:input.body};if(await approvalDigest(variants[input.platform]??null)===await approvalDigest(replacement))fail('VARIANT_UNCHANGED');variants[input.platform]=replacement;
  const newId=crypto.randomUUID(),at=new Date().toISOString(),next={...row,id:newId,revision:row.revision+1,variants_json:JSON.stringify(variants)},payloadHash=await contentHash(next),sourceJson=JSON.stringify(d.source),guards=[],events=[];
  if(d.prepared){
   requireProductionAdmin(authority);if(input.platform!==d.source.platform)fail('VARIANT_REVIEW_PLATFORM_REQUIRED');
   const approvals=new AsyncUploadPlans(this.db,x.options).approvals,s=await approvals.subject(d.source.source_review_id,{workspace:row.workspace,accountId:row.account_id}),latest=await approvals.latest(s.row.id);
   if(s.blocked&&s.blocked!=='APPROVAL_PLATFORM_EDIT_REVIEW_REQUIRED'||s.fingerprint!==d.source.source_subject)fail('VARIANT_REVIEW_SOURCE_CHANGED');
   if(!s.platform_edit&&(latest?.id!==d.source.source_event_id||latest.kind!=='CONTENT_APPROVED'))fail('VARIANT_REVIEW_SOURCE_CHANGED');
   guards.push(...approvals.subjectGuards(s),approvals.latestGuard(s.row.id,latest?.id||null),this.guard('EXISTS(SELECT 1 FROM sites_upload_plans WHERE id=? AND manifest_hash=? AND manifest_json=?)',[d.prepared.p.id,d.prepared.p.manifest_hash,d.prepared.p.manifest_json]));
   events.push(this.statement('INSERT INTO sites_review_edit_invalidations VALUES(?,?,?,?) ON CONFLICT(review_id) DO NOTHING',[s.row.id,newId,input.platform,at]));
   if(latest?.kind==='CONTENT_APPROVED')events.push(approvals.eventStatement(s.row.id,s.fingerprint,'REVOKED',authority.actor_id,'PLATFORM_TEXT_EDIT_REQUIRES_NEW_INSPECTION',{}).statement);
  }
  const statements=[authorizationGuard(this.db,x.authorization),this.rowGuard(row),this.guard('NOT EXISTS(SELECT 1 FROM sites_contents WHERE workspace=? AND account_id=? AND content_id=? AND slug=? AND revision>?)',[...family(row),row.revision]),
   ...(d.edit?[this.guard('EXISTS(SELECT 1 FROM sites_content_edits WHERE content_id=? AND source_json=? AND source_plan_id IS ?)',[row.id,d.edit.source_json,d.edit.source_plan_id])]:[this.guard('NOT EXISTS(SELECT 1 FROM sites_content_edits WHERE content_id=?)',[row.id])]),
   ...(!d.prepared?[this.guard('NOT EXISTS(SELECT 1 FROM sites_upload_plans WHERE content_id=?)',[row.id])]:[]),...guards,
   this.statement("INSERT INTO sites_authoring_commands VALUES(?,?,'CONTENT',?,?,0,?)",[owner,input.command_id,commandHash,newId,at]),
   this.statement("INSERT INTO sites_contents VALUES(?,?,?,?,?,?,?,?,?,?,'MANUAL_UNVERIFIED',?)",[newId,row.workspace,row.account_id,row.content_id,row.slug,next.revision,row.title,row.body,next.variants_json,payloadHash,at]),
   this.statement('INSERT INTO publisher_content_sources VALUES(?,?,?,?,?)',[row.workspace,row.account_id+'::'+row.content_id+'::'+row.slug,String(next.revision),newId,payloadHash]),
   this.statement('INSERT INTO sites_content_edits VALUES(?,?,?,?,?)',[newId,row.id,input.platform,d.source.source_plan_id,sourceJson]),...events,
   this.statement('UPDATE sites_authoring_commands SET committed=1 WHERE owner_user_id=? AND command_id=? AND command_hash=?',[owner,input.command_id,commandHash])];
  try{await this.batch(statements);}catch(error){const r=await receipt();if(r)return respond(r,true);if(/CHECK constraint|UNIQUE constraint/.test(error.message))fail('VARIANT_CONCURRENT_CHANGE');throw error;}
  return respond({entity_id:newId},false);
 }
}

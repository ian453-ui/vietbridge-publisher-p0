import {AsyncStorage,exact,fail,sha256,bytes} from './async-storage.js';
import {AsyncApprovalStore,approvalDigest,APPROVAL_LINEAGE_LIMITS} from './async-approval-store.js';
import {AsyncReviewStore} from './async-review-store.js';
import {bounded} from './scoped-object-store.js';
import {requireProductionAdmin} from '../production-approval-policy.js';
const flags={publish_allowed:false,producer_authenticated:false,source_gate_satisfied:false,synthetic_only:true};

/** Existing Review intake with a new, server-inspected edited payload. No real
 * inspector/provider is configured here; the native decoder adapter is a fixture. */
export class AsyncVariantReview extends AsyncStorage {
 constructor(db,options={}){super(db,options);this.options=options;this.approvals=new AsyncApprovalStore(db,options);this.provider=options.variantInspectionProvider;}
 async create(contentId,input,scope,{authority}={}){
  requireProductionAdmin(authority);exact(input,['command_id','expected_payload_hash','expected_source_binding'],'VARIANT_REVIEW_INPUT_INVALID');
  if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(input.command_id)||![input.expected_payload_hash,input.expected_source_binding].every(x=>/^[a-f0-9]{64}$/.test(x)))fail('VARIANT_REVIEW_INPUT_INVALID');
  if(!this.authorization)fail('SITES_AUTHORIZATION_CONTEXT_REQUIRED');await this.scope(scope.workspace,scope.accountId);
  if(!await this.one('SELECT 1 FROM sites_contents WHERE id=? AND workspace=? AND account_id=?',[contentId,scope.workspace,scope.accountId]))fail('VARIANT_REVIEW_SCOPE_DENIED');
  const commandHash=await approvalDigest({contentId,input,scope,actor:authority.actor_id,userId:this.authorization.userId});
  const receipt=async()=>{const r=await this.one('SELECT * FROM sites_variant_review_commands WHERE command_id=?',[input.command_id]);if(r&&r.command_hash!==commandHash)fail('VARIANT_REVIEW_COMMAND_CONFLICT');return r;};
  const respond=(id,duplicate)=>({id,committed:true,duplicate,status:'REVIEW_REQUIRED',current_state:'READBACK_REQUIRED',...flags});
  const previous=await receipt();if(previous)return respond(previous.review_id,true);
  const s=await this.approvals.editedSource(contentId,scope),{row,source,lineage,manifest}=s;
  if(input.expected_payload_hash!==row.payload_hash||input.expected_source_binding!==lineage.source_binding_hash)fail('VARIANT_REVIEW_VERSION_CHANGED');
  if(!this.provider?.inspectVariant)fail('VARIANT_REVIEW_INSPECTOR_UNAVAILABLE');
  const commandStatements=id=>[this.statement('INSERT INTO sites_variant_review_commands VALUES(?,?,?) ON CONFLICT(command_id) DO NOTHING',[input.command_id,commandHash,id]),this.guard('EXISTS(SELECT 1 FROM sites_variant_review_commands WHERE command_id=? AND command_hash=? AND review_id=?)',[input.command_id,commandHash,id])];
  const existing=async()=>{const r=await this.one('SELECT * FROM sites_variant_reviews WHERE content_id=?',[contentId]);if(!r)return null;if(await approvalDigest(JSON.parse(r.lineage_json))!==await approvalDigest(lineage))fail('VARIANT_REVIEW_CONFLICT');await this.batch([...this.approvals.editedSourceGuards(s),...commandStatements(r.review_id)]);return respond(r.review_id,true);};
  const priorVersion=await existing();if(priorVersion)return priorVersion;
  const encodedPayload=new TextEncoder().encode(JSON.stringify(lineage.payload)),currentBytes=source.assets.reduce((n,a)=>n+(a.source_id===manifest.source_id&&a.artifact_id===manifest.payload_artifact_id?encodedPayload.byteLength:a.bytes),0);
  // Reserve room for the prospective Review as well as every checked ancestor;
  // do not create a snapshot whose own approval traversal would exceed the cap.
  if(source.lineage_usage.nodes+1>APPROVAL_LINEAGE_LIMITS.nodes)fail('APPROVAL_LINEAGE_LIMIT');
  if(source.lineage_usage.bytes+currentBytes>APPROVAL_LINEAGE_LIMITS.bytes)fail('APPROVAL_LINEAGE_BYTE_LIMIT');
  const deadline=source.lineage_usage.deadline,assets=[];
  for(const a of source.assets){const raw=await this.approvals.reviews.objects.verify(a.object_id,scope,{deadline});assets.push({source_id:a.source_id,artifact_id:a.artifact_id,mime:raw.mime,data:raw.data});}
  const target=assets.find(a=>a.source_id===manifest.source_id&&a.artifact_id===manifest.payload_artifact_id);if(!target)fail('VARIANT_REVIEW_PAYLOAD_MISSING');
  // An explicit JSON envelope preserves title/body/tags/author without a platform
  // parser inventing title or retaining front matter. Only this bound Review uses it.
  target.data=encodedPayload;target.mime='text/plain; charset=utf-8';const payloadSha=await sha256(target.data);
  const {request_fingerprint,assignment_mode,handoff_policy,...base}=source.request;
  const created=row.created_at,window=Date.parse(source.request.deadline_at)-Date.parse(source.request.created_at),end=new Date(Date.parse(created)+window).toISOString();
  if(Date.now()>=Date.parse(end))fail('VARIANT_REVIEW_REQUEST_EXPIRED');
  const taskId='SYNTHETIC-EDIT-'+await approvalDigest({workspace:scope.workspace,account_id:scope.accountId,root_content_id:s.plan.content_id});
  const prior=await this.one('SELECT * FROM sites_reviews WHERE task_id=? AND request_revision<? ORDER BY request_revision DESC LIMIT 1',[taskId,row.revision]);
  if(prior&&(prior.workspace!==scope.workspace||prior.account_id!==scope.accountId))fail('REVIEW_TASK_SCOPE_CONFLICT');
  const preceding=prior?JSON.parse(prior.request_json):source.request;
  const parentManifest=source.edited?.source?.manifest;
  const oldRefs=parentManifest?.source_id===manifest.source_id?[
   {source_id:'SYNTHETIC-EDIT-CONTENT',revision:String(source.edited.lineage.content_revision),sha256:source.edited.lineage.payload_hash},
   {source_id:'SYNTHETIC-EDIT-PAYLOAD',revision:String(source.edited.lineage.content_revision),sha256:source.assets.find(a=>a.source_id===parentManifest.source_id&&a.artifact_id===parentManifest.payload_artifact_id)?.sha256}
  ]:[];
  // Remove only this validated parent's appended marker pair, by exact value
  // and position. Original source references with the same name stay untouched.
  const sourceItem=base.items.find(item=>item.source_id===manifest.source_id),refs=[...sourceItem.source_refs];
  if(oldRefs.length){if(await approvalDigest(refs.slice(-2))!==await approvalDigest(oldRefs))fail('VARIANT_REVIEW_SOURCE_REFS_CHANGED');refs.splice(-2);}
  const items=base.items.map(item=>item.source_id===manifest.source_id?{...item,content_revision:item.content_revision+row.revision-1,previous_revision:null,source_refs:[...refs,{source_id:'SYNTHETIC-EDIT-CONTENT',revision:String(row.revision),sha256:row.payload_hash},{source_id:'SYNTHETIC-EDIT-PAYLOAD',revision:String(row.revision),sha256:payloadSha}]}:item);
  const item=items.find(x=>x.source_id===manifest.source_id);item.previous_revision=await approvalDigest(preceding.items.find(x=>x.source_id===manifest.source_id));
  const payload={...base,task_id:taskId,request_revision:row.revision,created_at:created,deadline_at:end,items};
  const id=await approvalDigest(payload),request={...payload,request_fingerprint:id,assignment_mode,handoff_policy};
  const expected=await Promise.all(assets.map(async a=>({source_id:a.source_id,artifact_id:a.artifact_id,mime:a.mime,sha256:await sha256(a.data),bytes:a.data.byteLength})));
  if(performance.now()>=deadline)fail('APPROVAL_LINEAGE_TIME_LIMIT');
  const packet=await bounded(this.provider.inspectVariant({request:structuredClone(request),assets:assets.map(a=>({...a,data:a.data.slice()}))}),Math.max(1,deadline-performance.now()));
  exact(packet,['request','result','report','assets'],'VARIANT_REVIEW_INSPECTION_MISMATCH');
  if(await approvalDigest(packet.request)!==await approvalDigest(request)||!Array.isArray(packet.assets)||packet.assets.length!==expected.length)fail('VARIANT_REVIEW_INSPECTION_MISMATCH');
  for(const e of expected){const a=packet.assets.filter(a=>a.source_id===e.source_id&&a.artifact_id===e.artifact_id);if(a.length!==1||a[0].mime!==e.mime||bytes(a[0].data).byteLength!==e.bytes||await sha256(bytes(a[0].data))!==e.sha256)fail('VARIANT_REVIEW_INSPECTION_MISMATCH');}
  // Check semantic reference bindings as well as bytes; the inspector cannot
  // silently pair another article/cover with this explicitly edited payload.
  if(packet.result?.items?.length!==items.length)fail('VARIANT_REVIEW_INSPECTION_MISMATCH');
  for(const i of items){const results=packet.result.items.filter(r=>r.source_id===i.source_id),r=results[0];if(results.length!==1||r.item_fingerprint!==await approvalDigest(i)||['content_revision','visual_revision','previous_revision'].some(k=>r[k]!==i[k])||r.artifacts?.length!==i.deliverables.length)fail('VARIANT_REVIEW_INSPECTION_MISMATCH');
   for(const spec of i.deliverables){const matches=r.artifacts.filter(a=>a.artifact_id===spec.artifact_id),a=matches[0],e=expected.find(a=>a.source_id===i.source_id&&a.artifact_id===spec.artifact_id),refs=spec.references.map(artifact_id=>({artifact_id,sha256:expected.find(a=>a.source_id===i.source_id&&a.artifact_id===artifact_id).sha256}));if(matches.length!==1||a.sha256!==e.sha256||await approvalDigest(a.references)!==await approvalDigest(refs))fail('VARIANT_REVIEW_INSPECTION_MISMATCH');}
  }
  const binding=JSON.stringify({...JSON.parse(source.binding),request_fingerprint:id,result_fingerprint:await approvalDigest(packet.result)}),lineageJson=JSON.stringify(lineage);
  // The preceding committed revision is selected before inspection and pinned in
  // the final transaction. Intake inserts this revision before these assertions.
  const priorGuards=[this.guard('NOT EXISTS(SELECT 1 FROM sites_reviews WHERE task_id=? AND request_revision>? AND request_revision<?)',[taskId,prior?.request_revision||0,row.revision])];
  if(prior)priorGuards.push(this.guard('EXISTS(SELECT 1 FROM sites_reviews WHERE id=? AND task_id=? AND request_revision=? AND workspace=? AND account_id=? AND request_json=?)',[prior.id,taskId,prior.request_revision,scope.workspace,scope.accountId,prior.request_json]));
  const commitStatements=[...this.approvals.editedSourceGuards(s),...priorGuards,this.statement('INSERT INTO sites_variant_reviews VALUES(?,?,?)',[id,contentId,lineageJson]),this.statement('INSERT INTO sites_approval_bindings VALUES(?,?)',[id,binding]),...commandStatements(id)];
  const reviews=new AsyncReviewStore(this.db,{...this.options,inspectionProvider:{readInspection:async()=>packet}});
  try{await reviews.intake({...scope,task_id:request.task_id,request_revision:request.request_revision},{commitStatements});}
  catch(error){const prior=await receipt();if(prior)return respond(prior.review_id,true);const winner=await existing();if(winner)return winner;if(/CHECK constraint|UNIQUE constraint/.test(error.message))fail('VARIANT_REVIEW_SOURCE_CHANGED');throw error;}
  return respond(id,false);
 }
}

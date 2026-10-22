import {AsyncStorage,exact,fail,authorizationGuard} from './async-storage.js';
import {approvalDigest} from './async-approval-store.js';
import {AsyncReviewStore} from './async-review-store.js';
import {AsyncUploadPlans} from './async-upload-plans.js';
import {bounded} from './scoped-object-store.js';
import {requireProductionAdmin,approvalIdentityFields} from '../production-approval-policy.js';
const flags={publish_allowed:false,producer_authenticated:false,source_gate_satisfied:false,synthetic_only:true};
/** One-hop local reuse of inspected bytes. No copied approval, external producer
 * authentication, platform conversion or execution authority. Target provenance
 * must come from a server dependency; currently only a test fixture implements it. */
export class AsyncTargetReview extends AsyncStorage {
 constructor(db,options={}){super(db,options);this.options=options;this.provider=options.targetReviewProvider;}
 async create(planId,input,scope,{authority,sourceAuthority}={}){
  requireProductionAdmin(authority);requireProductionAdmin(sourceAuthority);
  exact(input,['command_id','expected_subject','expected_event_id','expected_platform'],'APPROVAL_TARGET_INPUT_INVALID');
  if(!/^[a-f0-9-]{36}$/.test(input.command_id)||!/^[a-f0-9]{64}$/.test(input.expected_subject)||!input.expected_event_id||typeof input.expected_platform!=='string')fail('APPROVAL_TARGET_INPUT_INVALID');
  if(!this.authorization)fail('SITES_AUTHORIZATION_CONTEXT_REQUIRED');const target=await this.scope(scope.workspace,scope.accountId);
  const plan=await this.one('SELECT * FROM sites_upload_plans WHERE id=? AND workspace=?',[planId,scope.workspace]);if(!plan)fail('PRODUCTION_PLAN_NOT_FOUND');
  if(plan.account_id===scope.accountId)fail('APPROVAL_DISTINCT_TARGET_REQUIRED');
  const sourceScope={workspace:scope.workspace,accountId:plan.account_id},sourceAuthorization={...this.authorization,accountId:plan.account_id},sourceOptions={...this.options,authorization:sourceAuthorization};
  // A durable command is a historical fact, not a new approval. Recheck both
  // memberships before readback, but do not hide a committed receipt because
  // current source approval, native identity or the provider has since changed.
  await new AsyncStorage(this.db,sourceOptions).scope(scope.workspace,plan.account_id);
  const commandHash=await approvalDigest({planId,scope,input,actor:authority.actor_id,source_actor:sourceAuthority.actor_id});
  const receipt=async()=>{const r=await this.one('SELECT * FROM sites_review_derivation_commands WHERE command_id=?',[input.command_id]);if(r&&r.command_hash!==commandHash)fail('APPROVAL_COMMAND_CONFLICT');return r;};
  const respond=(r,duplicate)=>({id:r.review_id,committed:true,duplicate,status:'REVIEW_REQUIRED',current_state:'READBACK_REQUIRED',...flags});
  const previous=await receipt();if(previous)return respond(previous,true);
  if(!this.provider?.readTargetBinding)fail('APPROVAL_TARGET_PROVIDER_UNAVAILABLE');
  const plans=new AsyncUploadPlans(this.db,sourceOptions),{manifest}=await plans.read(planId,sourceScope),sourceStore=plans.approvals;
  const source=await sourceStore.subject(plan.review_id,sourceScope,{allowDerivation:false}),latest=await sourceStore.latest(plan.review_id);
  if(source.blocked||source.provenance!=='SYNTHETIC_FIXTURE'||latest?.kind!=='CONTENT_APPROVED'||latest.id!==plan.approval_event_id||source.fingerprint!==plan.subject_fingerprint||input.expected_event_id!==latest.id||input.expected_subject!==source.fingerprint)fail('APPROVAL_SOURCE_CHANGED');
  if(target.platform!==input.expected_platform||target.platform!==manifest.platform)fail('APPROVAL_EXPLICIT_PLATFORM_REQUIRED');
  // No native producer transport is asserted: the source inspection is reused
  // with exact immutable hashes; this is a new local target Review request.
  const ref={workspace:scope.workspace,accountId:scope.accountId,platform:target.platform,source_review_id:source.row.id,source_subject:source.fingerprint,source_event_id:latest.id};
  const proof=await bounded(this.provider.readTargetBinding({...ref}),5000);
  if(!proof||Object.entries(ref).some(([k,v])=>proof[k]!==v)||proof.kind!=='SYNTHETIC_FIXTURE'||proof.workspace_kind!=='synthetic'||proof.source_state!=='SYNTHETIC_NO_EXTERNAL_SOURCE'||!proof.account?.enabled||proof.account.id!==scope.accountId||proof.account.workspace!==scope.workspace||proof.account.platform!==target.platform||!proof.account.external_id||proof.account.external_id!==target.external_identity)fail('APPROVAL_TARGET_BINDING_INVALID');
  const lineage={workspace:scope.workspace,source_account_id:plan.account_id,source_review_id:source.row.id,source_plan_id:planId,source_manifest_hash:plan.manifest_hash,source_subject:source.fingerprint,source_event_id:latest.id};
  const accountHash=await approvalDigest(Object.fromEntries(approvalIdentityFields.map(k=>[k,proof.account[k]??null]))),key=await approvalDigest({lineage,target:scope.accountId,accountHash,platform:target.platform});
  const {request_fingerprint,assignment_mode,handoff_policy,...base}=source.request;
  const payload={...base,task_id:'SYNTHETIC-TARGET-'+key,request_revision:1,account_id:scope.accountId};
  const id=await approvalDigest(payload),request={...payload,request_fingerprint:id,assignment_mode,handoff_policy};
  const result={...source.result,task_id:request.task_id,request_revision:1,account_id:scope.accountId,request_fingerprint:id},resultHash=await approvalDigest(result);
  const report=JSON.parse(source.row.report_json);report.receipt={...report.receipt,request_fingerprint:id,result_fingerprint:resultHash};report.inspection_reuse={source_review_id:source.row.id,source_subject:source.fingerprint,kind:'LOCAL_HASH_BOUND_REUSE'};
  const assets=[];for(const a of source.assets){const raw=await sourceStore.reviews.asset(scope.workspace,plan.account_id,source.row.id,a.source_id,a.artifact_id);assets.push({source_id:a.source_id,artifact_id:a.artifact_id,mime:raw.mime,data:raw.data});}
  const binding=JSON.stringify({kind:proof.kind,workspace_kind:proof.workspace_kind,source_state:proof.source_state,account:proof.account,account_hash:accountHash,request_fingerprint:id,result_fingerprint:resultHash}),lineageJson=JSON.stringify(lineage);
  const commitStatements=[authorizationGuard(this.db,sourceAuthorization),...sourceStore.subjectGuards(source),sourceStore.latestGuard(source.row.id,latest.id),
   this.guard('EXISTS(SELECT 1 FROM sites_upload_plans WHERE id=? AND workspace=? AND account_id=? AND manifest_hash=? AND subject_fingerprint=? AND approval_event_id=?)',[planId,scope.workspace,plan.account_id,plan.manifest_hash,source.fingerprint,latest.id]),
   this.guard('EXISTS(SELECT 1 FROM sites_account_details WHERE workspace=? AND account_id=? AND platform=? AND external_identity=?)',[scope.workspace,scope.accountId,target.platform,target.external_identity]),
   this.statement('INSERT INTO sites_review_derivations VALUES(?,?) ON CONFLICT(review_id) DO NOTHING',[id,lineageJson]),this.guard('EXISTS(SELECT 1 FROM sites_review_derivations WHERE review_id=? AND lineage_json=?)',[id,lineageJson]),
   this.statement('INSERT INTO sites_approval_bindings VALUES(?,?) ON CONFLICT(review_id) DO NOTHING',[id,binding]),this.guard('EXISTS(SELECT 1 FROM sites_approval_bindings WHERE review_id=? AND binding_json=?)',[id,binding]),
   this.statement('INSERT INTO sites_review_derivation_commands VALUES(?,?,?) ON CONFLICT(command_id) DO NOTHING',[input.command_id,commandHash,id]),this.guard('EXISTS(SELECT 1 FROM sites_review_derivation_commands WHERE command_id=? AND command_hash=? AND review_id=?)',[input.command_id,commandHash,id])];
  const reviews=new AsyncReviewStore(this.db,{...this.options,inspectionProvider:{readInspection:async()=>({request,result,report,assets})}});
  try{await reviews.intake({...scope,task_id:request.task_id,request_revision:1},{commitStatements});}
  catch(error){const r=await receipt();if(r)return respond(r,true);if(/CHECK constraint/.test(error.message))fail('APPROVAL_SOURCE_OR_TARGET_CHANGED');throw error;}
  return respond({review_id:id},false);
 }
}

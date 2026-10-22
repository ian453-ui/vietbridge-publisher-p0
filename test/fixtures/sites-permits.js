import {sitesEvidenceFixture,fileBucket,inspectedPacket} from './sites-evidence.js';
import {seedCloudApproval,syntheticAdmin,approvalCommand} from './sites-approval.js';
import {AsyncReviewStore} from '../../src/sites/async-review-store.js';
import {AsyncApprovalStore} from '../../src/sites/async-approval-store.js';
import {AsyncUploadPlans} from '../../src/sites/async-upload-plans.js';
import {AsyncSyntheticExecutor} from '../../src/sites/async-synthetic-executor.js';
import {join} from 'node:path';
export async function permitFixture(t,{existing=null}={}){
 const x=existing||await sitesEvidenceFixture(t),bucket=fileBucket(join(x.root,'permit-objects')),options={bucket,authorization:{userId:'synthetic-owner',...x.scope},requireExecutionPermit:true};let count=0;
 async function plan(body='Synthetic unique payload '+(++count)){
  const packet=inspectedPacket(x.root,x.scope,{taskId:'SYNTHETIC-PERMIT-'+crypto.randomUUID(),platformPayload:true,platformBody:body});await new AsyncReviewStore(x.f.db,{...options,inspectionProvider:{readInspection:async()=>packet}}).intake({...x.scope,task_id:packet.request.task_id,request_revision:1});await seedCloudApproval(x.f,packet,x.scope);
  const approvals=new AsyncApprovalStore(x.f.db,options),r=await approvals.decide(packet.request.request_fingerprint,approvalCommand(await approvals.view(packet.request.request_fingerprint,x.scope)),x.scope,{authority:syntheticAdmin}),plans=new AsyncUploadPlans(x.f.db,options),p=await plans.prepare(packet.request.request_fingerprint,{source_id:packet.request.items[0].source_id,payload_artifact_id:'platform',expected_subject:r.approval.subject_fingerprint,expected_event_id:r.event_id},x.scope,{authority:syntheticAdmin});
  const data=await plans.read(p.id,x.scope);return {...data,id:p.id,input:{confirmation:'SYNTHETIC_ONLY',snapshot_hash:data.job.snapshot_hash}};
 }
 const executor=new AsyncSyntheticExecutor(x.f.db,options);return {...x,options,bucket,plan,executor,run:p=>executor.run(p.id,p.input,x.scope,{authority:syntheticAdmin})};
}

// No production issuer exists. These fixtures alone register synthetic-exclusive
// authority, original-format permit rows and a deterministic SQL clock.
export async function syntheticPermitClock(f,{ms=Date.parse('2026-10-22T10:00:00.000Z')}={}){
 const {executionClockSql}=await import('../../src/sites/async-execution-permits.js'),state={ms},prepare=f.db.prepare;f.sql.function('synthetic_execution_clock',()=>state.ms);f.db.prepare=query=>prepare(query.replaceAll(executionClockSql,'synthetic_execution_clock()'));return state;
}
export async function seedPermit(x,data,clock,{expiresAt=clock.ms+3600000,prior={page:0,groups:[],interaction:0,pending:false,paused:false,complete:true},duplicate=false}={}){
 const {AsyncExecutionPermits,asyncScopeDigest}=await import('../../src/sites/async-execution-permits.js'),{sha256}=await import('../../src/sites/async-storage.js'),{scopedOperationLimits}=await import('../../src/task-action-policy.js'),{operatingDay}=await import('../../src/operating-day.js');
 const native={version:1,kind:'PAGE',subject_id:'PAGE:'+data.job.id,workspace:x.workspace,account_id:x.accountId,actor_id:'900000000001',target_page_id:'900000000002',target_id:'900000000002',platform:'facebook',transport:'BROWSER',profile_id:'synthetic-original-profile',snapshot_hash:data.job.snapshot_hash,body_hash:await sha256(data.manifest.payload.body),media_hashes:data.manifest.media.map((m,ordinal)=>({ordinal,sha256:m.sha256,size:m.bytes})),actions:['PUBLISH']},hash=await asyncScopeDigest(native),id='synthetic-original-permit-'+crypto.randomUUID(),policyId='synthetic-policy-'+x.accountId;
 const old=x.f.sql.prepare('SELECT * FROM sites_execution_policies WHERE id=?').get(policyId),policy={workspace:x.workspace,account_id:x.accountId,actor_id:native.actor_id,target_page_id:native.target_page_id,expires_at:Math.max(expiresAt,clock.ms+3600000),allowed_scope_hashes:[...(old?JSON.parse(old.policy_json).allowed_scope_hashes:[]),hash]},binding=await new AsyncExecutionPermits(x.f.db,x.options).binding(data,native),authorization={task_id:binding.task_id,approval_thread_id:'synthetic-authorized-thread',approval_message_id:'synthetic-exact-task-authorization'};
 x.f.sql.prepare("INSERT INTO sites_execution_policies VALUES(?,?,?,?,?,?,?,?,NULL,'SYNTHETIC_EXCLUSIVE') ON CONFLICT(id) DO UPDATE SET policy_json=excluded.policy_json,history_json=excluded.history_json,history_day=excluded.history_day,revision=excluded.revision").run(policyId,x.workspace,x.accountId,JSON.stringify(policy),JSON.stringify(scopedOperationLimits),JSON.stringify(prior),operatingDay(clock.ms),(old?.revision||0)+1);
 x.f.sql.prepare("INSERT INTO sites_execution_permits VALUES(?,?,?,?,?,?,?,'AVAILABLE',?,?,NULL,?)").run(id,data.job.id,policyId,JSON.stringify(native),hash,JSON.stringify(binding),JSON.stringify(authorization),clock.ms,expiresAt,Number(duplicate));return {id,policyId,native,hash,binding};
}

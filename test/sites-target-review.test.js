import test from 'node:test';
import assert from 'node:assert/strict';
import {targetReviewFixture} from './fixtures/sites-target-review.js';
import {AsyncApprovalStore} from '../src/sites/async-approval-store.js';
import {verifyProductionRequest} from '../src/production-artifact-contract.js';
import {seedPermit,syntheticPermitClock} from './fixtures/sites-permits.js';
import {AsyncUploadPlans} from '../src/sites/async-upload-plans.js';
import {syntheticAdmin,approvalCommand} from './fixtures/sites-approval.js';
test('shared reviewed media creates a fresh target-account review, never inherits approval',async t=>{
 const x=await targetReviewFixture(t),old=x.f.sql.prepare('SELECT * FROM sites_approval_events WHERE review_id=?').all(x.id),r=await x.call();assert.equal(r.status,200,JSON.stringify(r.body));
 assert.notEqual(r.body.id,x.id);assert.equal(r.body.publish_allowed,false);
 const target=new AsyncApprovalStore(x.f.db,x.targetOptions),v=await target.view(r.body.id,x.targetScope,{admin:true});assert.equal(v.state,'PENDING');assert.deepEqual(v.history,[]);assert.equal(v.can_decide,true);
 const s=await target.subject(r.body.id,x.targetScope);assert.equal(s.request.account_id,x.target);assert.notEqual(s.request.task_id,x.packet.request.task_id);assert.deepEqual(verifyProductionRequest(s.request),s.request);
 assert.deepEqual(s.assets.map(a=>a.sha256).sort(),x.packet.assets.map(a=>x.packet.report.items[0].artifacts.find(m=>m.artifact_id===a.artifact_id).sha256).sort());
 const a=await target.decide(r.body.id,approvalCommand(v),x.targetScope,{authority:syntheticAdmin}),p=await new AsyncUploadPlans(x.f.db,x.targetOptions).prepare(r.body.id,{source_id:x.packet.request.items[0].source_id,payload_artifact_id:'platform',expected_subject:a.approval.subject_fingerprint,expected_event_id:a.event_id},x.targetScope,{authority:syntheticAdmin});
 const frozen=JSON.parse(x.f.sql.prepare('SELECT snapshot_json FROM sites_job_snapshots WHERE job_id=?').get(p.job_id).snapshot_json);assert.equal(frozen.account_id,x.target);assert.equal(frozen.external_identity,'SYNTHETIC-SECOND-PAGE');assert.equal(p.job_state,'DRAFT');await target.decide(r.body.id,approvalCommand(await target.view(r.body.id,x.targetScope),{decision:'REJECT',reason:'Only target B withdrawn'}),x.targetScope,{authority:syntheticAdmin});assert.equal((await new AsyncUploadPlans(x.f.db,x.targetOptions).view(p.id,x.targetScope)).status,'STALE_PREVIEW');assert.equal((await x.approvals.view(x.id,x.scope)).state,'CONTENT_APPROVED');assert.deepEqual(x.f.sql.prepare('SELECT * FROM sites_approval_events WHERE review_id=?').all(x.id),old);
});

import {DatabaseSync} from 'node:sqlite';
import {cloudD1Fixture} from './fixtures/sites-cloud-d1.js';
import {AsyncTargetReview} from '../src/sites/async-target-review.js';
import {AsyncReviewStore} from '../src/sites/async-review-store.js';
import {AsyncSyntheticExecutor} from '../src/sites/async-synthetic-executor.js';
import {createCloudAuthoringApi} from '../src/sites/cloud-authoring-api.js';
import {inspectedPacket} from './fixtures/sites-evidence.js';
const count=(x,table)=>x.f.sql.prepare('SELECT count(*) n FROM '+table).get().n;
const derive=x=>new AsyncTargetReview(x.f.db,x.targetOptions).create(x.plan.id,x.input,x.targetScope,{authority:syntheticAdmin,sourceAuthority:syntheticAdmin});
async function approveTarget(x){const r=await derive(x),approvals=new AsyncApprovalStore(x.f.db,x.targetOptions),v=await approvals.view(r.id,x.targetScope,{admin:true}),a=await approvals.decide(r.id,approvalCommand(v),x.targetScope,{authority:syntheticAdmin});return {id:r.id,approvals,a};}
async function prepareTarget(x){const r=await approveTarget(x),p=await new AsyncUploadPlans(x.f.db,x.targetOptions).prepare(r.id,{source_id:x.packet.request.items[0].source_id,payload_artifact_id:'platform',expected_subject:r.a.approval.subject_fingerprint,expected_event_id:r.a.event_id},x.targetScope,{authority:syntheticAdmin});return {...r,p};}
function sourceHead(x){x.f.sql.prepare("INSERT INTO sites_source_heads VALUES(?,?,?,?,?,?,?,'IMPORTED',?,NULL,?)").run('synthetic-target-source',x.workspace,x.accountId,'{}',1,'a'.repeat(64),'{}','synthetic-attempt','2026-10-22T00:00:00.000Z');x.f.sql.prepare('INSERT INTO sites_review_sources VALUES(?,?,?,?)').run(x.id,'synthetic-target-source',1,'a'.repeat(64));}
async function changeSource(x,kind,db=x.f.sql){
 if(kind==='rejection')db.prepare("INSERT INTO sites_approval_events(id,review_id,subject_fingerprint,kind,actor_id,reason,checks_json,created_at) VALUES(?,?,?,'CONTENT_REJECTED',?,'withdrawn','{}',?)").run(crypto.randomUUID(),x.id,x.input.expected_subject,syntheticAdmin.actor_id,'2026-10-22T00:00:00.000Z');
 if(kind==='QA')db.prepare("UPDATE sites_source_heads SET state='QA_BLOCKED',reason='SOURCE_QA_REVIEW_REQUIRED'").run();
 if(kind==='revision'){const p=inspectedPacket(x.root,x.scope,{revision:2,prior:x.packet.request,platformPayload:true});await new AsyncReviewStore(x.f.db,{...x.options,inspectionProvider:{readInspection:async()=>p}}).intake({...x.scope,task_id:p.request.task_id,request_revision:2});}
 if(kind==='source membership'||kind==='target membership')db.prepare("UPDATE sites_project_memberships SET revoked_at='2026-10-22T00:00:00.000Z' WHERE account_id=?").run(kind==='source membership'?x.accountId:x.target);
 if(kind==='target identity')db.prepare("UPDATE sites_account_details SET external_identity='CHANGED' WHERE account_id=?").run(x.target);
}

test('two connections, repeated commands and restart retain one target review and no inherited event',async t=>{
 const x=await targetReviewFixture(t),second=cloudD1Fixture(x.path,{initialize:false});try{
 const other=new AsyncTargetReview(second.db,x.targetOptions),r=await Promise.all([derive(x),other.create(x.plan.id,x.input,x.targetScope,{authority:syntheticAdmin,sourceAuthority:syntheticAdmin})]);assert.equal(r[0].id,r[1].id);assert.equal(count(x,'sites_review_derivations'),1);assert.equal(count(x,'sites_review_derivation_commands'),1);
 assert.equal((await other.create(x.plan.id,{...x.input,command_id:crypto.randomUUID()},x.targetScope,{authority:syntheticAdmin,sourceAuthority:syntheticAdmin})).id,r[0].id);assert.equal(count(x,'sites_review_derivations'),1);
 assert.equal((await new AsyncApprovalStore(second.db,x.targetOptions).view(r[0].id,x.targetScope,{admin:true})).state,'PENDING');
 const conflicting={...x.input};x.f.sql.prepare('INSERT INTO sites_review_derivation_commands VALUES(?,?,?)').run('00000000-0000-0000-0000-000000000001','bad',r[0].id);conflicting.command_id='00000000-0000-0000-0000-000000000001';await assert.rejects(other.create(x.plan.id,conflicting,x.targetScope,{authority:syntheticAdmin,sourceAuthority:syntheticAdmin}),/APPROVAL_COMMAND_CONFLICT/);
 }finally{second.close();}
});
for(const kind of ['rejection','QA','revision','source membership','target identity'])test('source/target change invalidates only the new target approval: '+kind,async t=>{
 const x=await targetReviewFixture(t);if(kind==='QA')sourceHead(x);const r=await approveTarget(x);await changeSource(x,kind);const sourceEvents=x.f.sql.prepare('SELECT * FROM sites_approval_events WHERE review_id=?').all(x.id);
 const v=await r.approvals.view(r.id,x.targetScope,{admin:true});assert.equal(v.state,'REVOKED');assert.equal(v.can_decide,false);assert.deepEqual(x.f.sql.prepare('SELECT * FROM sites_approval_events WHERE review_id=?').all(x.id),sourceEvents);
 await assert.rejects(new AsyncUploadPlans(x.f.db,x.targetOptions).prepare(r.id,{source_id:x.packet.request.items[0].source_id,payload_artifact_id:'platform',expected_subject:r.a.approval.subject_fingerprint,expected_event_id:r.a.event_id},x.targetScope,{authority:syntheticAdmin}),/PRODUCTION_APPROVED_SYNTHETIC_SOURCE_REQUIRED/);
});
for(const kind of ['rejection','QA','source membership','target membership','target identity','database'])test('source/target change at target intake atomic batch leaves no new review/binding/receipt: '+kind,async t=>{
 const x=await targetReviewFixture(t);if(kind==='QA')sourceHead(x);const before={reviews:count(x,'sites_reviews'),bindings:count(x,'sites_approval_bindings')},base=x.f.db.batch;let hit=false;
 x.f.db.batch=async ss=>{if(!hit&&ss.some(s=>s.query.startsWith('INSERT INTO sites_review_derivations'))){hit=true;const second=new DatabaseSync(x.path);try{if(kind==='database')x.f.fault=ss.findIndex(s=>s.query.startsWith('INSERT INTO sites_review_derivation_commands'));else await changeSource(x,kind,second);}finally{second.close();}}try{return await base(ss);}finally{x.f.fault=-1;}};
 await assert.rejects(derive(x),/APPROVAL_SOURCE_OR_TARGET_CHANGED|SCOPE_DENIED|SYNTHETIC_TRANSACTION_FAILURE/);assert.equal(hit,true);assert.equal(count(x,'sites_reviews'),before.reviews);assert.equal(count(x,'sites_approval_bindings'),before.bindings);assert.equal(count(x,'sites_review_derivations'),0);assert.equal(count(x,'sites_review_derivation_commands'),0);
 if(kind==='database'){assert.equal((await derive(x)).committed,true);assert.equal(count(x,'sites_review_derivations'),1);}
});
for(const phase of ['decision','prepare'])test('concurrent source withdrawal at target '+phase+' transaction rolls back',async t=>{
 const x=await targetReviewFixture(t),r=phase==='decision'?{id:(await derive(x)).id,approvals:new AsyncApprovalStore(x.f.db,x.targetOptions)}:await approveTarget(x),v=await r.approvals.view(r.id,x.targetScope,{admin:true}),base=x.f.db.batch;let hit=false;
 x.f.db.batch=async ss=>{if(!hit&&ss.some(s=>s.query.startsWith(phase==='decision'?'INSERT INTO sites_approval_commands':'INSERT INTO sites_upload_plans'))){hit=true;const second=new DatabaseSync(x.path);try{await changeSource(x,'rejection',second);}finally{second.close();}}return base(ss);};
 if(phase==='decision')await assert.rejects(r.approvals.decide(r.id,approvalCommand(v),x.targetScope,{authority:syntheticAdmin}),/APPROVAL_CONCURRENT_CHANGE/);
 else await assert.rejects(new AsyncUploadPlans(x.f.db,x.targetOptions).prepare(r.id,{source_id:x.packet.request.items[0].source_id,payload_artifact_id:'platform',expected_subject:v.subject_fingerprint,expected_event_id:v.latest_event_id},x.targetScope,{authority:syntheticAdmin}),/PRODUCTION_APPROVAL_CHANGED/);
 assert.equal(hit,true);assert.equal(x.f.sql.prepare('SELECT count(*) n FROM sites_upload_plans WHERE account_id=?').get(x.target).n,0);
});

test('partial object failure has no approvable review; explicit retry recovers, lost commit ack returns original receipt',async t=>{
 const x=await targetReviewFixture(t),put=x.bucket.put;let writes=0;x.bucket.put=async(...args)=>{const r=await put(...args);if(++writes===2)throw Error('SYNTHETIC_OBJECT_ACK_LOST');return r;};
 await assert.rejects(derive(x),/SYNTHETIC_OBJECT_ACK_LOST/);assert.equal(count(x,'sites_review_derivations'),0);assert.equal(x.f.sql.prepare('SELECT count(*) n FROM sites_reviews WHERE account_id=?').get(x.target).n,0);
 x.bucket.put=put;const batch=x.f.db.batch;let lost=false;x.f.db.batch=async ss=>{const r=await batch(ss);if(!lost&&ss.some(s=>s.query.startsWith('INSERT INTO sites_review_derivations'))){lost=true;throw Error('COMMIT_ACK_LOST');}return r;};const r=await derive(x);assert.equal(r.committed,true);assert.equal((await derive(x)).id,r.id);assert.equal(count(x,'sites_review_derivations'),1);
});

test('HTTP defaults closed; client assertions, cross-customer target, no admin and missing platform are rejected',async t=>{
 const x=await targetReviewFixture(t),closed=createCloudAuthoringApi({db:x.f.db,origin:x.f.origin,bucket:x.bucket,getTrustedIdentity:async()=>({userId:'synthetic-owner'}),resolveApprovalAuthority:async()=>syntheticAdmin});
 assert.equal((await x.call(x.input,x.targetScope,closed)).body.error,'APPROVAL_TARGET_PROVIDER_UNAVAILABLE');assert.equal((await x.call({...x.input,authenticated:true})).body.error,'APPROVAL_TARGET_INPUT_INVALID');assert.equal((await x.call({...x.input,expected_platform:'xiaohongshu'})).body.error,'APPROVAL_EXPLICIT_PLATFORM_REQUIRED');
 const none=createCloudAuthoringApi({db:x.f.db,origin:x.f.origin,bucket:x.bucket,getTrustedIdentity:async()=>({userId:'synthetic-owner'})});assert.equal((await x.call(x.input,x.targetScope,none)).status,403);
 const w=(await x.post('/api/sites/workspaces',{name:'Other customer'})).id,a=(await x.post('/api/sites/workspaces/'+w+'/accounts',{display_name:'Other account',platform:'facebook',external_identity:'SYNTHETIC-OTHER'})).id;assert.equal((await x.call(x.input,{workspace:w,accountId:a})).body.error,'PRODUCTION_PLAN_NOT_FOUND');assert.equal((await x.call(x.input,{workspace:x.workspace,accountId:a})).status,403);
 assert.equal(count(x,'sites_review_derivations'),0);
});
for(const phase of ['before dispatch','after commit'])test('source withdrawn '+phase+': UNKNOWN only reconciles original target attempt after restart',async t=>{
 const x=await targetReviewFixture(t);sourceHead(x);const r=await prepareTarget(x),options={...x.targetOptions,requireExecutionPermit:true},executor=new AsyncSyntheticExecutor(x.f.db,options),confirmation={confirmation:'SYNTHETIC_ONLY',snapshot_hash:x.f.sql.prepare('SELECT snapshot_hash FROM publisher_jobs WHERE id=?').get(r.p.job_id).snapshot_hash},batch=x.f.db.batch;let hit=false;
 const clock=await syntheticPermitClock(x.f),data=await new AsyncUploadPlans(x.f.db,x.targetOptions).read(r.p.id,x.targetScope);await seedPermit({...x,accountId:x.target,options},data,clock);
 executor.setFault('SUBMIT_RESPONSE_LOST');x.f.db.batch=async ss=>{const matches=!hit&&ss.some(s=>s.query.startsWith('INSERT INTO sites_synthetic_objects'));if(matches&&phase==='before dispatch'){hit=true;await changeSource(x,'QA');}const v=await batch(ss);if(matches&&phase==='after commit'){hit=true;await changeSource(x,'QA');}return v;};
 assert.equal((await executor.run(r.p.id,confirmation,x.targetScope,{authority:syntheticAdmin})).state,'UNKNOWN');assert.equal(hit,true);
 const second=cloudD1Fixture(x.path,{initialize:false});try{await syntheticPermitClock(second,{ms:clock.ms});const restarted=new AsyncSyntheticExecutor(second.db,options);assert.equal((await restarted.run(r.p.id,confirmation,x.targetScope,{authority:syntheticAdmin})).state,phase==='before dispatch'?'UNKNOWN':'PUBLISHED');assert.equal((await restarted.run(r.p.id,confirmation,x.targetScope,{authority:syntheticAdmin})).state,phase==='before dispatch'?'UNKNOWN':'PUBLISHED');}finally{second.close();}
 assert.equal(count(x,'sites_synthetic_attempts'),1);assert.equal(count(x,'sites_synthetic_objects'),phase==='before dispatch'?0:1);assert.equal(x.f.sql.prepare('SELECT state FROM sites_execution_claims').get().state,phase==='before dispatch'?'UNKNOWN':'SETTLED');assert.equal(x.f.sql.prepare("SELECT count(*) n FROM sites_execution_events WHERE event='RELEASED'").get().n,0);
});

test('committed derivation receipt survives source rejection and missing provider; membership still required',async t=>{
 const x=await targetReviewFixture(t),r=await derive(x);await changeSource(x,'rejection');const closed=new AsyncTargetReview(x.f.db,{...x.targetOptions,targetReviewProvider:null});
 const again=await closed.create(x.plan.id,x.input,x.targetScope,{authority:syntheticAdmin,sourceAuthority:syntheticAdmin});assert.equal(again.id,r.id);assert.equal(again.committed,true);assert.equal(again.duplicate,true);
 assert.equal((await new AsyncApprovalStore(x.f.db,x.targetOptions).view(r.id,x.targetScope,{admin:true})).state,'BLOCKED');
 await changeSource(x,'source membership');await assert.rejects(closed.create(x.plan.id,x.input,x.targetScope,{authority:syntheticAdmin,sourceAuthority:syntheticAdmin}),/STORAGE_SCOPE_DENIED/);
});


test('server target proof must match exact source/account; chained derivation cannot expand reuse',async t=>{
 const x=await targetReviewFixture(t),provider=x.targetOptions.targetReviewProvider;
 for(const field of ['accountId','source_subject','source_event_id','platform','kind']){
  const bad=new AsyncTargetReview(x.f.db,{...x.targetOptions,targetReviewProvider:{readTargetBinding:async ref=>({...await provider.readTargetBinding(ref),[field]:'UNTRUSTED'})}});
  await assert.rejects(bad.create(x.plan.id,x.input,x.targetScope,{authority:syntheticAdmin,sourceAuthority:syntheticAdmin}),/APPROVAL_TARGET_BINDING_INVALID/);
 }
 const r=await prepareTarget(x),a=(await x.post('/api/sites/workspaces/'+x.workspace+'/accounts',{display_name:'Third target',platform:'facebook',external_identity:'SYNTHETIC-THIRD'})).id,scope={workspace:x.workspace,accountId:a},options={...x.targetOptions,authorization:{userId:'synthetic-owner',...scope}};
 await assert.rejects(new AsyncTargetReview(x.f.db,options).create(r.p.id,{command_id:crypto.randomUUID(),expected_subject:r.a.approval.subject_fingerprint,expected_event_id:r.a.event_id,expected_platform:'facebook'},scope,{authority:syntheticAdmin,sourceAuthority:syntheticAdmin}),/APPROVAL_SOURCE_CHANGED/);assert.equal(count(x,'sites_review_derivations'),1);
});

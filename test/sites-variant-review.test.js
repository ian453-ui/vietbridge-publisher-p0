import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {variantReviewFixture} from './fixtures/sites-variant-review.js';
import {syntheticAdmin,approvalCommand} from './fixtures/sites-approval.js';
import {AsyncVariantReview} from '../src/sites/async-variant-review.js';
import {AsyncApprovalStore} from '../src/sites/async-approval-store.js';
import {AsyncUploadPlans} from '../src/sites/async-upload-plans.js';
import {createCloudAuthoringApi} from '../src/sites/cloud-authoring-api.js';
import {cloudD1Fixture} from './fixtures/sites-cloud-d1.js';
import {verifyProductionRequest,createProductionRequest} from '../src/production-artifact-contract.js';
const count=(x,table)=>x.f.sql.prepare('SELECT count(*) n FROM '+table).get().n;
const approve=async(x,id)=>x.approvals.decide(id,approvalCommand(await x.approvals.view(id,x.scope)),x.scope,{authority:syntheticAdmin});
async function freeze(x,r){const a=await approve(x,r.id);return new AsyncUploadPlans(x.f.db,x.reviewOptions).prepare(r.id,{expected_subject:a.approval.subject_fingerprint,expected_event_id:a.event_id,source_id:x.plan.source_id,payload_artifact_id:'platform'},x.scope,{authority:syntheticAdmin});}
async function nextEdit(x){const v=await x.edits.view(x.saved.id,x.scope);return x.edits.save(v.content.id,{...x.saveInput,command_id:crypto.randomUUID(),expected_payload_hash:v.content.payload_hash,expected_source_binding:v.source_binding_hash,body:'第三版本完整正文。'},x.scope,{authority:syntheticAdmin});}
async function call(x,input=x.input,scope=x.scope,api=x.api){const r=await api(new Request(x.f.origin+'/api/sites/workspaces/'+scope.workspace+'/contents/'+x.saved.id+'/review?accountId='+scope.accountId,{method:'POST',headers:{origin:x.f.origin,'Content-Type':'application/json'},body:JSON.stringify(input)}));return {status:r.status,body:await r.json()};}

test('edited reviewed media enters fresh decoded pending Review then independent approval and exact frozen text/media',async t=>{
 const x=await variantReviewFixture(t,{video:true}),oldEvents=x.f.sql.prepare('SELECT * FROM sites_approval_events WHERE review_id=?').all(x.id),oldJob=x.f.sql.prepare('SELECT * FROM publisher_jobs WHERE id=?').get(x.plan.job_id),r=await call(x);assert.equal(r.status,200,JSON.stringify(r));assert.equal(r.body.publish_allowed,false);const id=r.body.id;assert.notEqual(id,x.id);assert.equal((await x.approvals.view(id,x.scope)).state,'PENDING');assert.equal(x.f.sql.prepare('SELECT count(*) n FROM sites_approval_events WHERE review_id=?').get(id).n,0);
 const row=x.f.sql.prepare('SELECT * FROM sites_reviews WHERE id=?').get(id),request=JSON.parse(row.request_json),report=JSON.parse(row.report_json);verifyProductionRequest(request);assert.equal(request.request_revision,2);assert.equal(report.items[0].artifacts.find(a=>a.kind==='video').validation.level,'VIDEO_DECODED');assert.equal(report.items[0].artifacts.find(a=>a.kind==='cover').validation.level,'IMAGE_DECODED');assert.equal(report.inspection_reuse,undefined);assert.equal(x.inspector.calls,1);
 const p=await freeze(x,r.body);assert.equal(p.payload.title,x.saveInput.title);assert.equal(p.payload.body,x.saveInput.body);assert.deepEqual(p.media.map(a=>[a.sha256,a.bytes]),x.plan.media.map(a=>[a.sha256,a.bytes]));assert.equal(p.job_state,'DRAFT');assert.notEqual(p.job_id,x.plan.job_id);assert.deepEqual(x.f.sql.prepare('SELECT * FROM publisher_jobs WHERE id=?').get(x.plan.job_id),oldJob);assert.deepEqual(x.f.sql.prepare('SELECT * FROM sites_approval_events WHERE review_id=?').all(x.id),oldEvents);
});

test('API defaults closed, denies client proof, wrong source hash, another account and another customer',async t=>{
 const x=await variantReviewFixture(t),disabled=createCloudAuthoringApi({db:x.f.db,origin:x.f.origin,bucket:x.bucket,getTrustedIdentity:async()=>({userId:'synthetic-owner'}),resolveApprovalAuthority:async()=>syntheticAdmin});
 assert.equal((await call(x,x.input,x.scope,disabled)).body.error,'VARIANT_REVIEW_INSPECTOR_UNAVAILABLE');assert.equal((await call(x,{...x.input,authenticated:true})).body.error,'VARIANT_REVIEW_INPUT_INVALID');assert.equal((await call(x,{...x.input,expected_source_binding:'0'.repeat(64)})).body.error,'VARIANT_REVIEW_VERSION_CHANGED');assert.equal((await call(x,x.input,x.targetScope)).body.error,'VARIANT_REVIEW_SCOPE_DENIED');
 const w=(await x.post('/api/sites/workspaces',{name:'Other customer'})).id,a=(await x.post('/api/sites/workspaces/'+w+'/accounts',{display_name:'Other account',platform:'facebook',external_identity:'OTHER'})).id;assert.equal((await call(x,x.input,{workspace:w,accountId:a})).body.error,'VARIANT_REVIEW_SCOPE_DENIED');assert.equal(count(x,'sites_variant_reviews'),0);assert.equal(x.inspector.calls,0);
});

test('two connections converge on one fresh Review and commands survive restart, source withdrawal and provider removal',async t=>{
 const x=await variantReviewFixture(t),f=cloudD1Fixture(x.path,{initialize:false});try{const other=new AsyncVariantReview(f.db,x.reviewOptions),r=await Promise.all([x.create(),other.create(x.saved.id,x.input,x.scope,{authority:syntheticAdmin})]);assert.equal(r[0].id,r[1].id);const second={...x.input,command_id:crypto.randomUUID()};assert.equal((await other.create(x.saved.id,second,x.scope,{authority:syntheticAdmin})).id,r[0].id);assert.equal(count(x,'sites_variant_reviews'),1);assert.equal(count(x,'sites_variant_review_commands'),2);
 await nextEdit(x);const restarted=new AsyncVariantReview(f.db,{...x.reviewOptions,variantInspectionProvider:null});assert.equal((await restarted.create(x.saved.id,x.input,x.scope,{authority:syntheticAdmin})).id,r[0].id);await assert.rejects(restarted.create(x.saved.id,{...x.input,expected_payload_hash:'0'.repeat(64)},x.scope,{authority:syntheticAdmin}),/VARIANT_REVIEW_COMMAND_CONFLICT/);f.sql.prepare("UPDATE sites_project_memberships SET revoked_at='revoked' WHERE account_id=?").run(x.accountId);await assert.rejects(restarted.create(x.saved.id,x.input,x.scope,{authority:syntheticAdmin}),/STORAGE_SCOPE_DENIED/);
 }finally{f.close();}
});

test('later edit invalidates prior new Review/approval/freeze while old creation receipt survives; latest version can reenter',async t=>{
 const x=await variantReviewFixture(t),r=await x.create(),approval=await approve(x,r.id),saved=await nextEdit(x);assert.equal((await x.approvals.view(r.id,x.scope)).state,'REVOKED');await assert.rejects(x.approvals.decide(r.id,approvalCommand(await x.approvals.view(r.id,x.scope)),x.scope,{authority:syntheticAdmin}),/APPROVAL_EDIT_SOURCE_CHANGED/);await assert.rejects(new AsyncUploadPlans(x.f.db,x.reviewOptions).prepare(r.id,{expected_subject:approval.approval.subject_fingerprint,expected_event_id:approval.event_id,source_id:x.plan.source_id,payload_artifact_id:'platform'},x.scope,{authority:syntheticAdmin}),/PRODUCTION_APPROVED_SYNTHETIC_SOURCE_REQUIRED/);
 assert.equal((await x.create()).id,r.id);await assert.rejects(x.create({...x.input,command_id:crypto.randomUUID()}),/VARIANT_VERSION_CONFLICT/);const v=await x.edits.view(saved.id,x.scope),fresh=await x.revisions.create(saved.id,{command_id:crypto.randomUUID(),expected_payload_hash:saved.payload_hash,expected_source_binding:v.source_binding_hash},x.scope,{authority:syntheticAdmin});assert.notEqual(fresh.id,r.id);const priorRequest=JSON.parse(x.f.sql.prepare('SELECT request_json FROM sites_reviews WHERE id=?').get(r.id).request_json),freshRequest=JSON.parse(x.f.sql.prepare('SELECT request_json FROM sites_reviews WHERE id=?').get(fresh.id).request_json),{request_fingerprint,assignment_mode,handoff_policy,...freshPayload}=freshRequest;createProductionRequest(freshPayload,{priorRequest});assert.equal((await x.approvals.view(fresh.id,x.scope)).state,'PENDING');assert.equal((await freeze(x,fresh)).payload.body,'第三版本完整正文。');
});

function rejectRoot(db,x,reason='explicit-source-withdrawal'){const e=db.prepare('SELECT * FROM sites_approval_events WHERE review_id=? ORDER BY sequence DESC LIMIT 1').get(x.id);db.prepare('INSERT INTO sites_approval_events(id,review_id,subject_fingerprint,kind,actor_id,reason,checks_json,created_at) VALUES(?,?,?,?,?,?,?,?)').run(crypto.randomUUID(),x.id,e.subject_fingerprint,'CONTENT_REJECTED','synthetic-admin',reason,'{}',new Date().toISOString());}

for(const reason of ['source rejection','source QA'])test('approved edited Review loses current validity after '+reason+' but retains historical receipts',async t=>{
 const x=await variantReviewFixture(t),r=await x.create(),a=await approve(x,r.id),before=count(x,'sites_upload_plans');
 if(reason==='source rejection')rejectRoot(x.f.sql,x);else{
  x.f.sql.prepare('INSERT INTO sites_source_heads VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('withdrawn-qa',x.workspace,x.accountId,'{}',1,'b'.repeat(64),'{}','QA_BLOCKED','withdrawn-attempt','MOBILE_READABILITY_RETEST_PENDING',new Date().toISOString());
  x.f.sql.prepare('INSERT INTO sites_review_sources VALUES(?,?,?,?)').run(x.id,'withdrawn-qa',1,'b'.repeat(64));
 }
 assert.equal((await x.approvals.view(r.id,x.scope)).state,'REVOKED');await assert.rejects(new AsyncUploadPlans(x.f.db,x.reviewOptions).prepare(r.id,{expected_subject:a.approval.subject_fingerprint,expected_event_id:a.event_id,source_id:x.plan.source_id,payload_artifact_id:'platform'},x.scope,{authority:syntheticAdmin}),/PRODUCTION_APPROVED_SYNTHETIC_SOURCE_REQUIRED/);
 assert.equal(count(x,'sites_upload_plans'),before);assert.equal((await x.create()).id,r.id);assert.equal(x.f.sql.prepare('SELECT kind FROM sites_approval_events WHERE id=?').get(a.event_id).kind,'CONTENT_APPROVED');
});

for(const fault of ['member revoked','identity changed','newer edit','source rejected','source QA','media corrupt','SQL rollback','commit ack lost'])test('fresh Review final batch is atomic under '+fault,async t=>{
 const x=await variantReviewFixture(t),before=count(x,'sites_reviews'),events=count(x,'sites_approval_events'),base=x.f.db.batch;let hit=false;
 x.f.db.batch=async ss=>{const final=!hit&&ss.some(s=>s.query.startsWith('INSERT INTO sites_variant_reviews'));if(final){hit=true;const db=new DatabaseSync(x.path);try{
  if(fault==='member revoked')db.prepare("UPDATE sites_project_memberships SET revoked_at='revoked' WHERE account_id=?").run(x.accountId);
  if(fault==='identity changed')db.prepare("UPDATE sites_account_details SET external_identity='wrong-target' WHERE account_id=?").run(x.accountId);
  if(fault==='newer edit')await nextEdit(x);
  if(fault==='source rejected')rejectRoot(db,x);
  if(fault==='source QA'){db.prepare('INSERT INTO sites_source_heads VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('qa',x.workspace,x.accountId,'{}',1,'a'.repeat(64),'{}','QA_BLOCKED','qa-attempt','MOBILE_READABILITY_RETEST_PENDING',new Date().toISOString());db.prepare('INSERT INTO sites_review_sources VALUES(?,?,?,?)').run(x.id,'qa',1,'a'.repeat(64));}
  if(fault==='media corrupt')db.prepare("UPDATE sites_objects SET state='CORRUPT' WHERE id=(SELECT object_id FROM sites_review_assets WHERE review_id=? AND artifact_id='cover')").run(x.id);
  if(fault==='SQL rollback')x.f.fault=ss.findIndex(s=>s.query.startsWith('INSERT INTO sites_approval_bindings'));
 }finally{db.close();}}
 try{const r=await base(ss);if(final&&fault==='commit ack lost')throw Error('LOST_COMMIT_ACK');return r;}finally{x.f.fault=-1;}};
 if(fault==='commit ack lost'){const r=await x.create();assert.equal(r.committed,true);assert.equal((await x.create()).id,r.id);assert.equal(count(x,'sites_reviews'),before+1);assert.equal(count(x,'sites_variant_review_commands'),1);}else{await assert.rejects(x.create(),/SCOPE_DENIED|VARIANT_REVIEW_SOURCE_CHANGED|SYNTHETIC_TRANSACTION_FAILURE/);assert.equal(count(x,'sites_reviews'),before);assert.equal(count(x,'sites_variant_reviews'),0);assert.equal(count(x,'sites_variant_review_commands'),0);}
 assert.equal(hit,true);assert.equal(count(x,'sites_approval_events'),events+(fault==='source rejected'?1:0));
});

for(const phase of ['approval','freeze'])test('new Review '+phase+' rechecks latest edit inside its own atomic batch',async t=>{
 const x=await variantReviewFixture(t),r=await x.create();let input;if(phase==='approval')input=approvalCommand(await x.approvals.view(r.id,x.scope));else{const a=await approve(x,r.id);input={expected_subject:a.approval.subject_fingerprint,expected_event_id:a.event_id,source_id:x.plan.source_id,payload_artifact_id:'platform'};}
 const base=x.f.db.batch;let hit=false;const before=count(x,'sites_upload_plans');x.f.db.batch=async ss=>{if(!hit&&ss.some(s=>s.query.startsWith(phase==='approval'?'INSERT INTO sites_approval_commands':'INSERT INTO sites_upload_plans'))){hit=true;await nextEdit(x);}return base(ss);};
 await assert.rejects(phase==='approval'?x.approvals.decide(r.id,input,x.scope,{authority:syntheticAdmin}):new AsyncUploadPlans(x.f.db,x.reviewOptions).prepare(r.id,input,x.scope,{authority:syntheticAdmin}),/APPROVAL_CONCURRENT_CHANGE|PRODUCTION_APPROVAL_CHANGED/);assert.equal(hit,true);assert.equal(count(x,'sites_upload_plans'),before);assert.notEqual((await x.approvals.view(r.id,x.scope)).state,'CONTENT_APPROVED');
});

for(const change of ['body bytes','cover bytes','reference hash','request account','UNKNOWN report','decode receipt','bad MP4'])test('inspector cannot bind mismatched '+change+' to an edited Review',async t=>{
 const x=await variantReviewFixture(t,{video:change==='bad MP4'}),native=x.inspector.inspectVariant.bind(x.inspector);x.inspector.inspectVariant=async input=>{
  if(change==='bad MP4'){input.assets.find(a=>a.mime==='video/mp4').data=new TextEncoder().encode('not a playable mp4');return native(input);}
  const p=await native(input);if(change==='body bytes')p.assets.find(a=>a.artifact_id==='platform').data=new TextEncoder().encode('another article');if(change==='cover bytes')p.assets.find(a=>a.artifact_id==='cover').data=p.assets.find(a=>a.artifact_id==='body').data;
  if(change==='reference hash')p.result.items[0].artifacts.find(a=>a.artifact_id==='platform').references[0].sha256='0'.repeat(64);
  if(change==='request account')p.request.account_id=x.target;
  if(change==='UNKNOWN report')p.report.status='UNKNOWN';
  if(change==='decode receipt')p.report.items[0].artifacts.find(a=>a.kind==='cover').validation.level='HASH_ONLY';return p;
 };
 await assert.rejects(x.create(),/VARIANT_REVIEW_INSPECTION_MISMATCH|REVIEW_INSPECTION_UNVERIFIED|REVIEW_DECODE_RECEIPT_REQUIRED|VIDEO_/);assert.equal(count(x,'sites_variant_reviews'),0);assert.equal(count(x,'sites_variant_review_commands'),0);
});

test('object acknowledgement loss leaves no approvable Review, explicit retry restores complete new snapshot',async t=>{
 const x=await variantReviewFixture(t),before=count(x,'sites_reviews');x.bucket.controls.afterPutError='LOST_OBJECT_ACK';await assert.rejects(x.create(),/LOST_OBJECT_ACK|OBJECT_/);assert.equal(count(x,'sites_reviews'),before);assert.equal(count(x,'sites_variant_reviews'),0);x.bucket.controls.afterPutError=null;const r=await x.create();assert.equal((await x.approvals.view(r.id,x.scope)).state,'PENDING');assert.equal(count(x,'sites_variant_reviews'),1);
});

import {AsyncSyntheticExecutor} from '../src/sites/async-synthetic-executor.js';
import {seedPermit,syntheticPermitClock} from './fixtures/sites-permits.js';
for(const phase of ['before dispatch','after submit'])test('edited Review '+phase+' update preserves UNKNOWN and reconciles only its original attempt across restart',async t=>{
 const x=await variantReviewFixture(t),r=await x.create(),p=await freeze(x,r),options={...x.reviewOptions,requireExecutionPermit:true},executor=new AsyncSyntheticExecutor(x.f.db,options),data=await new AsyncUploadPlans(x.f.db,options).read(p.id,x.scope),clock=await syntheticPermitClock(x.f);await seedPermit({...x,options},data,clock);const input={confirmation:'SYNTHETIC_ONLY',snapshot_hash:data.job.snapshot_hash},base=x.f.db.batch;let edited=false;
 executor.setFault('SUBMIT_RESPONSE_LOST');x.f.db.batch=async ss=>{const final=!edited&&ss.some(s=>s.query.startsWith('INSERT INTO sites_synthetic_objects'));if(final&&phase==='before dispatch'){edited=true;await nextEdit(x);}const r=await base(ss);if(final&&phase==='after submit'){edited=true;await nextEdit(x);}return r;};assert.equal((await executor.run(p.id,input,x.scope,{authority:syntheticAdmin})).state,'UNKNOWN');assert.equal(edited,true);
 const f=cloudD1Fixture(x.path,{initialize:false});try{await syntheticPermitClock(f,{ms:clock.ms});const restarted=new AsyncSyntheticExecutor(f.db,options);for(let i=0;i<2;i++)assert.equal((await restarted.run(p.id,input,x.scope,{authority:syntheticAdmin})).state,phase==='before dispatch'?'UNKNOWN':'PUBLISHED');}finally{f.close();}
 assert.equal(count(x,'sites_synthetic_attempts'),1);assert.equal(count(x,'sites_synthetic_objects'),phase==='before dispatch'?0:1);assert.equal(x.f.sql.prepare('SELECT state FROM sites_execution_claims').get().state,phase==='before dispatch'?'UNKNOWN':'SETTLED');assert.equal(x.f.sql.prepare("SELECT count(*) n FROM sites_execution_events WHERE event='RELEASED'").get().n,0);assert.equal((await x.create()).id,r.id);
});

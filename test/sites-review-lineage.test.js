import test from 'node:test';
import assert from 'node:assert/strict';
import {variantReviewFixture} from './fixtures/sites-variant-review.js';
import {AsyncVariantEdits} from '../src/sites/async-variant-edits.js';
import {AsyncVariantReview} from '../src/sites/async-variant-review.js';
import {AsyncApprovalStore,approvalDigest} from '../src/sites/async-approval-store.js';
import {AsyncUploadPlans} from '../src/sites/async-upload-plans.js';
import {syntheticAdmin,approvalCommand} from './fixtures/sites-approval.js';
import {verifyProductionRequest} from '../src/production-artifact-contract.js';
import {targetReviewFixture} from './fixtures/sites-target-review.js';
import {syntheticVariantInspector} from './fixtures/sites-variant-inspector.js';
import {AsyncTargetReview} from '../src/sites/async-target-review.js';
import {DatabaseSync} from 'node:sqlite';
import {cloudD1Fixture} from './fixtures/sites-cloud-d1.js';
import {AsyncSyntheticExecutor} from '../src/sites/async-synthetic-executor.js';
import {seedPermit,syntheticPermitClock} from './fixtures/sites-permits.js';
import {APPROVAL_LINEAGE_LIMITS} from '../src/sites/async-approval-store.js';
const count=(x,table)=>x.f.sql.prepare('SELECT count(*) n FROM '+table).get().n;

async function approveFreeze(x,id,scope=x.scope,options=x.reviewOptions){
 const approvals=new AsyncApprovalStore(x.f.db,options),decision=approvalCommand(await approvals.view(id,scope)),a=await approvals.decide(id,decision,scope,{authority:syntheticAdmin});
 const input={expected_subject:a.approval.subject_fingerprint,expected_event_id:a.event_id,source_id:x.plan.source_id,payload_artifact_id:'platform'},plan=await new AsyncUploadPlans(x.f.db,options).prepare(id,input,scope,{authority:syntheticAdmin});return {plan,decision,event:a.event_id,input};
}
async function editPlan(x,plan,n,scope=x.scope,options=x.reviewOptions){
 const edits=new AsyncVariantEdits(x.f.db,options),v=await edits.view(plan.content_id,scope),save={command_id:crypto.randomUUID(),expected_payload_hash:v.content.payload_hash,expected_source_binding:v.source_binding_hash,platform:'facebook',title:'连续改稿 '+n,body:'第 '+n+' 次完整改稿。\n独立审核，原媒体保留。'},saved=await edits.save(plan.content_id,save,scope,{authority:syntheticAdmin}),next=await edits.view(saved.id,scope),input={command_id:crypto.randomUUID(),expected_payload_hash:saved.payload_hash,expected_source_binding:next.source_binding_hash};return {saved,input,scope,options,create:()=>new AsyncVariantReview(x.f.db,options).create(saved.id,input,scope,{authority:syntheticAdmin})};
}

test('derived frozen Review can be edited and independently re-inspected twice more without approval reuse',async t=>{
 const x=await variantReviewFixture(t,{video:true}),first=await x.create(),history=[],plans=[];let r=first;
 for(let n=1;n<=3;n++){
  const before=await x.approvals.view(r.id,x.scope);assert.equal(before.state,'PENDING');assert.equal(before.history.length,0);
  const approved=await approveFreeze(x,r.id);plans.push(approved.plan);history.push({id:r.id,...approved});
  assert.deepEqual(approved.plan.media.map(a=>[a.sha256,a.bytes]),x.plan.media.map(a=>[a.sha256,a.bytes]));
  if(n===3)break;
  const edit=await editPlan(x,approved.plan,n+1);assert.equal((await x.approvals.view(r.id,x.scope)).state,'REVOKED');const next=await edit.create();assert.notEqual(next.id,r.id);
  const read=id=>JSON.parse(x.f.sql.prepare('SELECT request_json FROM sites_reviews WHERE id=?').get(id).request_json),old=read(r.id),fresh=read(next.id);verifyProductionRequest(fresh);assert.notEqual(fresh.task_id,old.task_id);assert.equal(fresh.items[0].previous_revision,await approvalDigest(old.items[0]));assert.equal(fresh.items[0].content_revision,old.items[0].content_revision+1);assert.equal(fresh.items[0].source_refs.length,x.packet.request.items[0].source_refs.length+2);r=next;
 }
 assert.equal(x.inspector.calls,3);assert.equal(new Set(plans.map(p=>p.job_id)).size,3);assert.equal(plans.at(-1).payload.body,'第 3 次完整改稿。\n独立审核，原媒体保留。');
 for(const h of history.slice(0,-1)){const a=await x.approvals.decide(h.id,h.decision,x.scope,{authority:syntheticAdmin});assert.equal(a.event_id,h.event);assert.equal(a.approval.state,'REVOKED');const p=await new AsyncUploadPlans(x.f.db,x.reviewOptions).prepare(h.id,h.input,x.scope,{authority:syntheticAdmin});assert.equal(p.id,h.plan.id);assert.equal(p.status,'STALE_PREVIEW');}
 assert.equal(x.f.sql.prepare("SELECT count(*) n FROM publisher_jobs WHERE state<>'DRAFT'").get().n,0);
});

async function targetChain(t,{video=false}={}){
 const x=await targetReviewFixture(t,{video}),r=await x.call();assert.equal(r.status,200);const inspector=syntheticVariantInspector(x.root),options={...x.targetOptions,variantInspectionProvider:inspector},a=await approveFreeze(x,r.body.id,x.targetScope,options),edit=await editPlan(x,a.plan,1,x.targetScope,options),first=await edit.create(),p=await approveFreeze(x,first.id,x.targetScope,options),second=await editPlan(x,p.plan,2,x.targetScope,options);
 return {...x,inspector,chainOptions:options,chainScope:x.targetScope,targetId:r.body.id,first,firstEdit:edit,firstApproved:p,second};
}
test('target-derived media supports two independent edits without transferring source approval or enabling another target hop',async t=>{
 const x=await targetChain(t,{video:true}),r=await x.second.create(),a=new AsyncApprovalStore(x.f.db,x.chainOptions);assert.equal((await a.view(r.id,x.chainScope)).state,'PENDING');const p=await approveFreeze(x,r.id,x.chainScope,x.chainOptions);assert.equal(p.plan.payload.body,'第 2 次完整改稿。\n独立审核，原媒体保留。');assert.equal(x.f.sql.prepare('SELECT account_id FROM publisher_jobs WHERE id=?').get(p.plan.job_id).account_id,x.target);assert.equal(x.inspector.calls,2);
 assert.equal((await x.approvals.view(x.id,x.scope)).state,'CONTENT_APPROVED');assert.equal((await a.view(x.first.id,x.chainScope)).state,'REVOKED');const other={...x.scope},options={...x.chainOptions,authorization:{userId:'synthetic-owner',...other}};
 await assert.rejects(new AsyncTargetReview(x.f.db,options).create(p.plan.id,{command_id:crypto.randomUUID(),expected_subject:p.input.expected_subject,expected_event_id:p.event,expected_platform:'facebook'},other,{authority:syntheticAdmin,sourceAuthority:syntheticAdmin}),/APPROVAL_SOURCE_CHANGED/);assert.equal(count(x,'sites_review_derivations'),1);
});

function rejectAncestor(db,x){const e=db.prepare('SELECT * FROM sites_approval_events WHERE review_id=? ORDER BY sequence DESC LIMIT 1').get(x.id);db.prepare("INSERT INTO sites_approval_events(id,review_id,subject_fingerprint,kind,actor_id,reason,checks_json,created_at) VALUES(?,?,?,'CONTENT_REJECTED','synthetic-admin','ancestor withdrawn','{}',?)").run(crypto.randomUUID(),x.id,e.subject_fingerprint,new Date().toISOString());}
for(const fault of ['ancestor rejection','ancestor membership','target membership','ancestor identity','ancestor QA','newer edited version','SQL failure','lost commit ack'])test('derived chain final creation batch rechecks '+fault,async t=>{
 const x=await targetChain(t),before=count(x,'sites_reviews'),commands=count(x,'sites_variant_review_commands'),batch=x.f.db.batch;let hit=false;
 x.f.db.batch=async ss=>{const final=!hit&&ss.some(s=>s.query.startsWith('INSERT INTO sites_variant_reviews'));if(final){hit=true;const db=new DatabaseSync(x.path);try{
  if(fault==='ancestor rejection')rejectAncestor(db,x);
  if(fault.endsWith('membership'))db.prepare("UPDATE sites_project_memberships SET revoked_at='withdrawn' WHERE account_id=?").run(fault==='target membership'?x.target:x.accountId);
  if(fault==='ancestor identity')db.prepare("UPDATE sites_account_details SET external_identity='different-account' WHERE account_id=?").run(x.accountId);
  if(fault==='ancestor QA'){db.prepare('INSERT INTO sites_source_heads VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('ancestor-qa',x.workspace,x.accountId,'{}',1,'a'.repeat(64),'{}','QA_BLOCKED','qa-withdrawal','MOBILE_READABILITY_RETEST_PENDING',new Date().toISOString());db.prepare('INSERT INTO sites_review_sources VALUES(?,?,?,?)').run(x.id,'ancestor-qa',1,'a'.repeat(64));}
  if(fault==='newer edited version'){const e=new AsyncVariantEdits(x.f.db,x.chainOptions),v=await e.view(x.second.saved.id,x.chainScope);await e.save(v.content.id,{command_id:crypto.randomUUID(),expected_payload_hash:v.content.payload_hash,expected_source_binding:v.source_binding_hash,platform:'facebook',title:'Concurrent latest',body:'Concurrent latest body'},x.chainScope,{authority:syntheticAdmin});}
  if(fault==='SQL failure')x.f.fault=ss.findIndex(s=>s.query.startsWith('INSERT INTO sites_variant_reviews'));
 }finally{db.close();}}
 try{const result=await batch(ss);if(final&&fault==='lost commit ack')throw Error('LOST_CHAIN_COMMIT_ACK');return result;}finally{x.f.fault=-1;}};
 if(fault==='lost commit ack'){const r=await x.second.create();assert.equal((await x.second.create()).id,r.id);assert.equal(count(x,'sites_reviews'),before+1);assert.equal(count(x,'sites_variant_review_commands'),commands+1);}else{await assert.rejects(x.second.create(),/SCOPE_DENIED|VARIANT_REVIEW_SOURCE_CHANGED|SYNTHETIC_TRANSACTION_FAILURE/);assert.equal(count(x,'sites_reviews'),before);assert.equal(count(x,'sites_variant_review_commands'),commands);}assert.equal(hit,true);
});

test('derived edit refuses wrong account/customer, stale body/media binding and concurrent revision; restart reads only the committed command',async t=>{
 const x=await targetChain(t),s=x.second;
 await assert.rejects(new AsyncVariantReview(x.f.db,{...x.chainOptions,authorization:{userId:'synthetic-owner',...x.scope}}).create(s.saved.id,s.input,x.scope,{authority:syntheticAdmin}),/VARIANT_REVIEW_SCOPE_DENIED/);
 const w=(await x.post('/api/sites/workspaces',{name:'Unrelated'})).id,a=(await x.post('/api/sites/workspaces/'+w+'/accounts',{display_name:'Unrelated',platform:'facebook',external_identity:'SYNTHETIC-OTHER'})).id,scope={workspace:w,accountId:a};await assert.rejects(new AsyncVariantReview(x.f.db,{...x.chainOptions,authorization:{userId:'synthetic-owner',...scope}}).create(s.saved.id,s.input,scope,{authority:syntheticAdmin}),/VARIANT_REVIEW_SCOPE_DENIED/);
 const store=new AsyncVariantReview(x.f.db,x.chainOptions);for(const field of ['expected_payload_hash','expected_source_binding'])await assert.rejects(store.create(s.saved.id,{...s.input,[field]:'0'.repeat(64)},x.chainScope,{authority:syntheticAdmin}),/VARIANT_REVIEW_VERSION_CHANGED/);
 const f=cloudD1Fixture(x.path,{initialize:false});try{const other=new AsyncVariantReview(f.db,x.chainOptions),results=await Promise.all([s.create(),other.create(s.saved.id,s.input,x.chainScope,{authority:syntheticAdmin})]);assert.equal(results[0].id,results[1].id);rejectAncestor(f.sql,x);const closed=new AsyncVariantReview(f.db,{...x.chainOptions,variantInspectionProvider:null});assert.equal((await closed.create(s.saved.id,s.input,x.chainScope,{authority:syntheticAdmin})).id,results[0].id);assert.equal((await new AsyncApprovalStore(f.db,x.chainOptions).view(results[0].id,x.chainScope)).state,'BLOCKED');await assert.rejects(closed.create(s.saved.id,{...s.input,command_id:crypto.randomUUID()},x.chainScope,{authority:syntheticAdmin}),/VARIANT_REVIEW_SOURCE_CHANGED/);}finally{f.close();}
});

for(const phase of ['approval','freeze','dispatch'])test('ancestor withdrawal during derived '+phase+' is checked atomically',async t=>{
 const x=await targetChain(t),r=await x.second.create(),a=new AsyncApprovalStore(x.f.db,x.chainOptions);let action,needle;
 if(phase==='approval'){const c=approvalCommand(await a.view(r.id,x.chainScope));needle='INSERT INTO sites_approval_commands';action=()=>a.decide(r.id,c,x.chainScope,{authority:syntheticAdmin});}
 else if(phase==='freeze'){const approved=await a.decide(r.id,approvalCommand(await a.view(r.id,x.chainScope)),x.chainScope,{authority:syntheticAdmin});needle='INSERT INTO sites_upload_plans';action=()=>new AsyncUploadPlans(x.f.db,x.chainOptions).prepare(r.id,{expected_subject:approved.approval.subject_fingerprint,expected_event_id:approved.event_id,source_id:x.plan.source_id,payload_artifact_id:'platform'},x.chainScope,{authority:syntheticAdmin});}
 else{const p=await approveFreeze(x,r.id,x.chainScope,x.chainOptions),options={...x.chainOptions,requireExecutionPermit:true},data=await new AsyncUploadPlans(x.f.db,options).read(p.plan.id,x.chainScope),clock=await syntheticPermitClock(x.f);await seedPermit({...x,options,accountId:x.target,scope:x.chainScope},data,clock);const executor=new AsyncSyntheticExecutor(x.f.db,options);needle='INSERT INTO sites_synthetic_objects';action=()=>executor.run(p.plan.id,{confirmation:'SYNTHETIC_ONLY',snapshot_hash:data.job.snapshot_hash},x.chainScope,{authority:syntheticAdmin});}
 const before=count(x,'sites_upload_plans'),batch=x.f.db.batch;let hit=false;x.f.db.batch=async ss=>{if(!hit&&ss.some(s=>s.query.startsWith(needle))){hit=true;const db=new DatabaseSync(x.path);try{rejectAncestor(db,x);}finally{db.close();}}return batch(ss);};
 if(phase==='dispatch'){assert.equal((await action()).state,'UNKNOWN');assert.equal((await action()).state,'UNKNOWN');assert.equal(count(x,'sites_synthetic_objects'),0);assert.equal(count(x,'sites_synthetic_attempts'),1);assert.equal(x.f.sql.prepare('SELECT state FROM sites_execution_claims').get().state,'UNKNOWN');}else await assert.rejects(action(),/APPROVAL_CONCURRENT_CHANGE|PRODUCTION_APPROVAL_CHANGED/);
 assert.equal(hit,true);assert.equal(count(x,'sites_upload_plans'),before);
});

test('already submitted derived version only reconciles across restart after ancestor withdrawal',async t=>{
 const x=await targetChain(t),r=await x.second.create(),p=await approveFreeze(x,r.id,x.chainScope,x.chainOptions),options={...x.chainOptions,requireExecutionPermit:true},data=await new AsyncUploadPlans(x.f.db,options).read(p.plan.id,x.chainScope),clock=await syntheticPermitClock(x.f);await seedPermit({...x,options,accountId:x.target,scope:x.chainScope},data,clock);const e=new AsyncSyntheticExecutor(x.f.db,options),input={confirmation:'SYNTHETIC_ONLY',snapshot_hash:data.job.snapshot_hash};e.setFault('SUBMIT_RESPONSE_LOST');assert.equal((await e.run(p.plan.id,input,x.chainScope,{authority:syntheticAdmin})).state,'UNKNOWN');rejectAncestor(x.f.sql,x);
 const f=cloudD1Fixture(x.path,{initialize:false});try{await syntheticPermitClock(f,{ms:clock.ms});const restarted=new AsyncSyntheticExecutor(f.db,options);for(let n=0;n<2;n++)assert.equal((await restarted.run(p.plan.id,input,x.chainScope,{authority:syntheticAdmin})).state,'PUBLISHED');}finally{f.close();}
 assert.equal(count(x,'sites_synthetic_objects'),1);assert.equal(count(x,'sites_synthetic_attempts'),1);assert.equal(x.f.sql.prepare('SELECT state FROM sites_execution_claims').get().state,'SETTLED');assert.equal(x.f.sql.prepare("SELECT count(*) n FROM sites_execution_events WHERE event='RELEASED'").get().n,0);assert.equal((await x.second.create()).id,r.id);
});

test('lineage depth is bounded before another inspection while prior receipts remain readable',async t=>{
 const x=await variantReviewFixture(t);let r=await x.create(),last,history=[];
 for(let n=2;n<=APPROVAL_LINEAGE_LIMITS.nodes;n++){
  const a=await approveFreeze(x,r.id);history.push({id:r.id,...a});last=await editPlan(x,a.plan,n);if(n===APPROVAL_LINEAGE_LIMITS.nodes)break;r=await last.create();
 }
 const before=count(x,'sites_reviews'),calls=x.inspector.calls;await assert.rejects(last.create(),/APPROVAL_LINEAGE_LIMIT/);assert.equal(count(x,'sites_reviews'),before);assert.equal(x.inspector.calls,calls);assert.equal((await x.create()).id,history[0].id);
});

test('cycle, node, byte and elapsed budgets are shared across edited and cross-account target ancestors',async t=>{
 const x=await targetChain(t),r=await x.second.create(),store=new AsyncApprovalStore(x.f.db,x.chainOptions),s=await store.subject(r.id,x.chainScope);assert.equal(s.lineage_usage.nodes,4);
 const key=id=>JSON.stringify([x.workspace,id===x.id?x.accountId:x.target,id]);
 for(const mode of ['cycle','nodes','bytes','time']){
  const resolution={path:mode==='cycle'?[key(x.id)]:[],budget:{nodes:mode==='nodes'?APPROVAL_LINEAGE_LIMITS.nodes-2:0,bytes:mode==='bytes'?APPROVAL_LINEAGE_LIMITS.bytes-s.assets.reduce((n,a)=>n+a.bytes,0):0,deadline:performance.now()+(mode==='time'?-1:30000)}},before=x.bucket.gets;
  await assert.rejects(store.subject(r.id,x.chainScope,{resolution}),new RegExp('APPROVAL_LINEAGE_'+({cycle:'CYCLE',nodes:'LIMIT',bytes:'BYTE_LIMIT',time:'TIME_LIMIT'}[mode])));
  if(mode==='time')assert.equal(x.bucket.gets,before);
 }
 assert.equal((await store.view(r.id,x.chainScope)).state,'PENDING');
});

test('an actual corrupt source cycle fails closed without unbounded object reads',async t=>{
 const x=await variantReviewFixture(t),r=await x.create(),a=await approveFreeze(x,r.id),edit=await editPlan(x,a.plan,2),store=new AsyncApprovalStore(x.f.db,x.reviewOptions),one=store.one.bind(store),before=x.bucket.gets;
 // Fault injection changes only a read response, not schema/permissions: make
 // this Review claim that its own edited frozen plan was its inspection source.
 store.one=async(q,args)=>{const row=await one(q,args);return q==='SELECT * FROM sites_variant_reviews WHERE review_id=?'&&args[0]===r.id?{...row,content_id:edit.saved.id}:row;};
 await assert.rejects(store.subject(r.id,x.scope),/APPROVAL_LINEAGE_CYCLE/);assert.ok(x.bucket.gets-before<10);assert.equal(count(x,'sites_variant_reviews'),1);
});

test('reinspection replaces only its own verified marker pair and preserves same-named original references',async t=>{
 const refs=[{source_id:'SYNTHETIC-EDIT-CONTENT',revision:'original',sha256:'a'.repeat(64)},{source_id:'SYNTHETIC-EDIT-PAYLOAD',revision:'original',sha256:'b'.repeat(64)},{source_id:'ORIGINAL-DOC',revision:'source-v1',sha256:'c'.repeat(64)}],x=await variantReviewFixture(t,{sourceRefs:refs});let r=await x.create();
 for(let n=2;n<=3;n++){const p=await approveFreeze(x,r.id),e=await editPlan(x,p.plan,n);r=await e.create();const request=JSON.parse(x.f.sql.prepare('SELECT request_json FROM sites_reviews WHERE id=?').get(r.id).request_json);assert.deepEqual(request.items[0].source_refs.slice(0,-2),refs);assert.equal(request.items[0].source_refs.length,5);assert.equal(request.items[0].source_refs.at(-2).sha256,e.saved.payload_hash);}
});

test('target creation reserves its own lineage node before creating an unreviewable ninth snapshot',async t=>{
 const x=await variantReviewFixture(t);let r=await x.create();
 for(let n=2;n<=APPROVAL_LINEAGE_LIMITS.nodes;n++){
  const p=await approveFreeze(x,r.id);
  if(n>=APPROVAL_LINEAGE_LIMITS.nodes-1){const input={command_id:crypto.randomUUID(),expected_subject:p.input.expected_subject,expected_event_id:p.event,expected_platform:'facebook'},store=new AsyncTargetReview(x.f.db,x.targetOptions),before=count(x,'sites_reviews');
   if(n===APPROVAL_LINEAGE_LIMITS.nodes){await assert.rejects(store.create(p.plan.id,input,x.targetScope,{authority:syntheticAdmin,sourceAuthority:syntheticAdmin}),/APPROVAL_LINEAGE_LIMIT/);assert.equal(count(x,'sites_reviews'),before);break;}
   const target=await store.create(p.plan.id,input,x.targetScope,{authority:syntheticAdmin,sourceAuthority:syntheticAdmin});assert.equal((await new AsyncApprovalStore(x.f.db,x.targetOptions).view(target.id,x.targetScope)).state,'PENDING');
  }
  const e=await editPlan(x,p.plan,n);r=await e.create();
 }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {sitesEvidenceFixture} from './fixtures/sites-evidence.js';

test('explicit platform edit creates a new source version preserving other platforms and full body',async t=>{
 const x=await sitesEvidenceFixture(t),row=x.f.sql.prepare('SELECT * FROM sites_contents WHERE account_id=?').get(x.accountId),base='/api/sites/workspaces/'+x.workspace+'/contents/'+row.id+'/variants?accountId='+x.accountId;
 const read=await x.f.call(base);assert.equal(read.status,200,JSON.stringify(read.body));
 const r=await x.f.call(base,{command_id:crypto.randomUUID(),expected_payload_hash:row.payload_hash,expected_source_binding:read.body.source_binding_hash,platform:'xiaohongshu',title:'独立小红书稿',body:'新平台完整正文。\n末段保留。'});assert.equal(r.status,200,JSON.stringify(r.body));
 const saved=x.f.sql.prepare('SELECT * FROM sites_contents WHERE id=?').get(r.body.id);assert.notEqual(saved.id,row.id);assert.equal(saved.revision,2);assert.equal(saved.body,row.body);assert.equal(saved.account_id,row.account_id);assert.deepEqual(JSON.parse(saved.variants_json).facebook,JSON.parse(row.variants_json).facebook);assert.equal(JSON.parse(saved.variants_json).xiaohongshu.body,'新平台完整正文。\n末段保留。');assert.equal(r.body.publish_allowed,false);
});

test('prototype names cannot become platform variants or create a content/command',async t=>{
 const x=await sitesEvidenceFixture(t),row=x.f.sql.prepare('SELECT * FROM sites_contents WHERE account_id=?').get(x.accountId),url='/api/sites/workspaces/'+x.workspace+'/contents/'+row.id+'/variants?accountId='+x.accountId,view=(await x.f.call(url)).body,before=x.f.sql.prepare('SELECT count(*) n FROM sites_authoring_commands').get().n;
 for(const platform of ['__proto__','constructor','toString']){const r=await x.f.call(url,{command_id:crypto.randomUUID(),expected_payload_hash:row.payload_hash,expected_source_binding:view.source_binding_hash,platform,title:'Forbidden',body:'Forbidden'});assert.equal(r.body.error,'VARIANT_INPUT_INVALID',JSON.stringify(r));}
 assert.equal(x.f.sql.prepare('SELECT count(*) n FROM sites_contents').get().n,1);assert.equal(x.f.sql.prepare('SELECT count(*) n FROM sites_authoring_commands').get().n,before);
});

import {DatabaseSync} from 'node:sqlite';
import {AsyncVariantEdits} from '../src/sites/async-variant-edits.js';
import {cloudD1Fixture} from './fixtures/sites-cloud-d1.js';
import {targetReviewFixture} from './fixtures/sites-target-review.js';
import {syntheticAdmin,approvalCommand} from './fixtures/sites-approval.js';
import {AsyncApprovalStore} from '../src/sites/async-approval-store.js';
import {AsyncTargetReview} from '../src/sites/async-target-review.js';
import {AsyncUploadPlans} from '../src/sites/async-upload-plans.js';
import {AsyncSyntheticExecutor} from '../src/sites/async-synthetic-executor.js';
import {seedPermit,syntheticPermitClock} from './fixtures/sites-permits.js';
const count=(x,table)=>x.f.sql.prepare('SELECT count(*) n FROM '+table).get().n;
async function editable(t,{review=false}={}){const x=review?await targetReviewFixture(t):await sitesEvidenceFixture(t),id=review?x.plan.content_id:x.f.sql.prepare('SELECT id FROM sites_contents WHERE account_id=?').get(x.accountId).id,options=x.options||{authorization:{userId:'synthetic-owner',...x.scope}},edits=new AsyncVariantEdits(x.f.db,options),view=await edits.view(id,x.scope),input={command_id:crypto.randomUUID(),expected_payload_hash:view.content.payload_hash,expected_source_binding:view.source_binding_hash,platform:'facebook',title:'明确平台新标题',body:'新平台完整正文。\n结尾保留。'};return {...x,editId:id,edits,editView:view,editInput:input,editOptions:options};}
const save=x=>x.edits.save(x.editId,x.editInput,x.scope,{authority:syntheticAdmin});

test('simultaneous different-platform saves conflict without overwriting; explicit rebase preserves both variants',async t=>{
 const x=await editable(t),second=cloudD1Fixture(x.path,{initialize:false});try{const other=new AsyncVariantEdits(second.db,x.editOptions),input={...x.editInput,command_id:crypto.randomUUID(),platform:'xiaohongshu',title:'XHS title',body:'XHS only'},r=await Promise.allSettled([save(x),other.save(x.editId,input,x.scope)]);assert.equal(r.filter(x=>x.status==='fulfilled').length,1);assert.match(r.find(x=>x.status==='rejected').reason.message,/VARIANT_CONCURRENT_CHANGE|VARIANT_VERSION_CONFLICT/);
 const winner=r.find(x=>x.status==='fulfilled').value,view=await x.edits.view(winner.id,x.scope),loser=r[0].status==='rejected'?x.editInput:input,applied=await other.save(winner.id,{...loser,command_id:crypto.randomUUID(),expected_payload_hash:view.content.payload_hash,expected_source_binding:view.source_binding_hash},x.scope),final=await other.view(applied.id,x.scope);assert.equal(final.content.revision,3);assert.equal(final.content.variants.facebook.body,x.editInput.body);assert.equal(final.content.variants.xiaohongshu.body,input.body);assert.equal(count(x,'sites_contents'),3);
 }finally{second.close();}
});

test('same command across connections creates one edit; receipt survives later edit and restart; conflict cannot reuse it',async t=>{
 const x=await editable(t),second=cloudD1Fixture(x.path,{initialize:false});try{const other=new AsyncVariantEdits(second.db,x.editOptions),r=await Promise.all([save(x),other.save(x.editId,x.editInput,x.scope)]);assert.equal(r[0].id,r[1].id);const view=await other.view(r[0].id,x.scope);await other.save(view.content.id,{...x.editInput,command_id:crypto.randomUUID(),platform:'xiaohongshu',expected_payload_hash:view.content.payload_hash,expected_source_binding:view.source_binding_hash},x.scope);assert.equal((await save(x)).id,r[0].id);assert.equal((await other.save(x.editId,x.editInput,x.scope)).id,r[0].id);await assert.rejects(other.save(x.editId,{...x.editInput,body:'Conflicting replay'},x.scope),/VARIANT_COMMAND_CONFLICT/);assert.equal(count(x,'sites_content_edits'),2);}finally{second.close();}
});

for(const fault of ['revoke source','revoke viewer','source body','source platform','late edit lineage','SQL insertion'])test('edit batch race rolls back all dependent rows: '+fault,async t=>{
 const x=await editable(t),viewer=(await x.post('/api/sites/workspaces/'+x.workspace+'/accounts',{display_name:'Viewer',platform:'xiaohongshu',external_identity:null})).id,scope={workspace:x.workspace,accountId:viewer},store=new AsyncVariantEdits(x.f.db,{authorization:{userId:'synthetic-owner',...scope}}),base=x.f.db.batch,before=count(x,'sites_authoring_commands');let hit=false;
 x.f.db.batch=async ss=>{if(!hit&&ss.some(s=>s.query.startsWith('INSERT INTO sites_content_edits'))){hit=true;const db=new DatabaseSync(x.path);try{
  if(fault.startsWith('revoke'))db.prepare("UPDATE sites_project_memberships SET revoked_at='revoked' WHERE account_id=?").run(fault==='revoke source'?x.accountId:viewer);
  if(fault==='source body')db.prepare("UPDATE sites_contents SET body='Changed concurrent source' WHERE id=?").run(x.editId);
  if(fault==='source platform')db.prepare("UPDATE sites_contents SET variants_json='{}' WHERE id=?").run(x.editId);
  // A synthetic late edit lineage is injected in the second connection. It must
  // be rejected even though preflight saw a manual text source.
  if(fault==='late edit lineage')db.prepare('INSERT INTO sites_content_edits VALUES(?,?,?,?,?)').run(x.editId,x.editId,'facebook',null,'{}');
  if(fault==='SQL insertion')x.f.fault=ss.findIndex(s=>s.query.startsWith('INSERT INTO sites_content_edits'));
 }finally{db.close();}}try{return await base(ss);}finally{x.f.fault=-1;}};
 await assert.rejects(store.save(x.editId,x.editInput,scope),/SCOPE_DENIED|VARIANT_CONCURRENT_CHANGE|SYNTHETIC_TRANSACTION_FAILURE/);assert.equal(hit,true);assert.equal(count(x,'sites_contents'),1);assert.equal(count(x,'sites_authoring_commands'),before);assert.equal(count(x,'sites_content_edits'),fault==='late edit lineage'?1:0);
});

test('reviewed edit retains original media lineage, revokes its approval and propagates through edit-of-edit',async t=>{
 const x=await editable(t,{review:true}),old=JSON.parse(x.f.sql.prepare('SELECT snapshot_json FROM sites_job_snapshots WHERE job_id=?').get(x.plan.job_id).snapshot_json),objects=count(x,'sites_objects');
 await assert.rejects(x.edits.save(x.editId,{...x.editInput,platform:'xiaohongshu'},x.scope,{authority:syntheticAdmin}),/VARIANT_REVIEW_PLATFORM_REQUIRED/);
 await assert.rejects(x.edits.save(x.editId,{...x.editInput,expected_source_binding:'0'.repeat(64)},x.scope,{authority:syntheticAdmin}),/VARIANT_MEDIA_BINDING_CHANGED/);
 await assert.rejects(x.edits.save(x.editId,x.editInput,x.scope),/APPROVAL_ADMIN_REQUIRED/);
 const r=await save(x),v=await x.edits.view(r.id,x.scope),approval=await x.approvals.view(x.id,x.scope,{admin:true});assert.deepEqual(v.source.media,x.plan.media);assert.equal(v.requires_new_inspection,true);assert.equal(approval.state,'REVOKED');assert.equal(approval.blocked_reason,'APPROVAL_PLATFORM_EDIT_REVIEW_REQUIRED');assert.equal(approval.can_decide,false);await assert.rejects(x.approvals.decide(x.id,approvalCommand(approval),x.scope,{authority:syntheticAdmin}),/APPROVAL_PLATFORM_EDIT_REVIEW_REQUIRED/);
 const r2=await x.edits.save(r.id,{...x.editInput,command_id:crypto.randomUUID(),expected_payload_hash:v.content.payload_hash,expected_source_binding:v.source_binding_hash,body:'Second independent edit'},x.scope,{authority:syntheticAdmin}),v2=await x.edits.view(r2.id,x.scope);assert.deepEqual(v2.source,v.source);assert.equal(count(x,'sites_objects'),objects);assert.equal(count(x,'sites_reviews'),1);assert.deepEqual(JSON.parse(x.f.sql.prepare('SELECT snapshot_json FROM sites_job_snapshots WHERE job_id=?').get(x.plan.job_id).snapshot_json),old);
 for(const candidate of [r,r2]){const blocked=await x.f.call('/api/sites/workspaces/'+x.workspace+'/tasks',{command_id:crypto.randomUUID(),account_id:x.accountId,content_id:candidate.id,expected_payload_hash:candidate.payload_hash,expected_platform:'facebook'});assert.equal(blocked.body.error,'BOUND_REVIEW_TASK_REQUIRED');}
 assert.equal((await save(x)).id,r.id);assert.equal(count(x,'sites_review_edit_invalidations'),1);
 const catalogue=(await x.f.call('/api/sites/workspaces/'+x.workspace+'/catalogue?accountId='+x.accountId)).body.contents;assert.equal(catalogue.find(c=>c.id===r2.id).review_edit.requires_new_inspection,true);
});

test('editing root media invalidates independently approved target, keeps both immutable review receipts',async t=>{
 const x=await editable(t,{review:true}),r=await new AsyncTargetReview(x.f.db,x.targetOptions).create(x.plan.id,x.input,x.targetScope,{authority:syntheticAdmin,sourceAuthority:syntheticAdmin}),approvals=new AsyncApprovalStore(x.f.db,x.targetOptions),v=await approvals.view(r.id,x.targetScope,{admin:true});await approvals.decide(r.id,approvalCommand(v),x.targetScope,{authority:syntheticAdmin});await save(x);assert.equal((await approvals.view(r.id,x.targetScope,{admin:true})).state,'REVOKED');assert.equal((await new AsyncTargetReview(x.f.db,x.targetOptions).create(x.plan.id,x.input,x.targetScope,{authority:syntheticAdmin,sourceAuthority:syntheticAdmin})).id,r.id);assert.equal(count(x,'sites_reviews'),2);
});
for(const fault of ['withdraw approval','corrupt media','SQL rollback','commit ack lost'])test('review edit transaction preserves truthful approval/media/receipt under '+fault,async t=>{
 const x=await editable(t,{review:true}),base=x.f.db.batch,before=count(x,'sites_contents');let hit=false;
 x.f.db.batch=async ss=>{const match=!hit&&ss.some(s=>s.query.startsWith('INSERT INTO sites_content_edits'));if(match){hit=true;const db=new DatabaseSync(x.path);try{if(fault==='withdraw approval')db.prepare("INSERT INTO sites_approval_events(id,review_id,subject_fingerprint,kind,actor_id,reason,checks_json,created_at) VALUES(?,?,?,'CONTENT_REJECTED',?,'concurrent withdrawal','{}',?)").run(crypto.randomUUID(),x.id,x.input.expected_subject,syntheticAdmin.actor_id,new Date().toISOString());if(fault==='corrupt media')db.prepare("UPDATE sites_objects SET state='CORRUPT' WHERE workspace=? AND account_id=?").run(x.workspace,x.accountId);if(fault==='SQL rollback')x.f.fault=ss.findIndex(s=>s.query.startsWith('INSERT INTO sites_review_edit_invalidations'));}finally{db.close();}}
 try{const r=await base(ss);if(match&&fault==='commit ack lost')throw Error('COMMIT_ACK_LOST');return r;}finally{x.f.fault=-1;}};
 if(fault==='commit ack lost'){const r=await save(x);assert.equal(r.committed,true);assert.equal((await save(x)).id,r.id);assert.equal(count(x,'sites_contents'),before+1);}else{await assert.rejects(save(x),/VARIANT_CONCURRENT_CHANGE|SYNTHETIC_TRANSACTION_FAILURE/);assert.equal(count(x,'sites_contents'),before);assert.equal(count(x,'sites_review_edit_invalidations'),0);assert.equal(x.f.sql.prepare('SELECT count(*) n FROM sites_authoring_commands WHERE command_id=?').get(x.editInput.command_id).n,0);}
 assert.equal(hit,true);
});

test('cross-customer and revoked member edits/readbacks are denied without changing original data',async t=>{
 const x=await editable(t),other=(await x.post('/api/sites/workspaces',{name:'Other customer'})).id,a=(await x.post('/api/sites/workspaces/'+other+'/accounts',{display_name:'Other',platform:'facebook',external_identity:null})).id,scope={workspace:other,accountId:a},store=new AsyncVariantEdits(x.f.db,{authorization:{userId:'synthetic-owner',...scope}});
 await assert.rejects(store.view(x.editId,scope),/VARIANT_CONTENT_NOT_FOUND/);await assert.rejects(store.save(x.editId,x.editInput,scope),/VARIANT_CONTENT_NOT_FOUND/);const r=await save(x);x.f.sql.prepare("UPDATE sites_project_memberships SET revoked_at='revoked' WHERE account_id=?").run(x.accountId);await assert.rejects(save(x),/STORAGE_SCOPE_DENIED/);assert.equal(count(x,'sites_content_edits'),1);assert.ok(r.id);
});
for(const phase of ['before dispatch','after submit'])test('editing during '+phase+' retains UNKNOWN occupancy and only reconciles original frozen attempt',async t=>{
 const x=await editable(t,{review:true}),options={...x.options,requireExecutionPermit:true},executor=new AsyncSyntheticExecutor(x.f.db,options),data=await new AsyncUploadPlans(x.f.db,options).read(x.plan.id,x.scope),clock=await syntheticPermitClock(x.f);await seedPermit({...x,options},data,clock);const confirmation={confirmation:'SYNTHETIC_ONLY',snapshot_hash:data.job.snapshot_hash},base=x.f.db.batch;let edited=false;
 executor.setFault('SUBMIT_RESPONSE_LOST');x.f.db.batch=async ss=>{const match=!edited&&ss.some(s=>s.query.startsWith('INSERT INTO sites_synthetic_objects'));if(match&&phase==='before dispatch'){edited=true;await save(x);}const r=await base(ss);if(match&&phase==='after submit'){edited=true;await save(x);}return r;};
 assert.equal((await executor.run(x.plan.id,confirmation,x.scope,{authority:syntheticAdmin})).state,'UNKNOWN');assert.equal(edited,true);const second=cloudD1Fixture(x.path,{initialize:false});try{await syntheticPermitClock(second,{ms:clock.ms});const fresh=new AsyncSyntheticExecutor(second.db,options);for(let i=0;i<2;i++)assert.equal((await fresh.run(x.plan.id,confirmation,x.scope,{authority:syntheticAdmin})).state,phase==='before dispatch'?'UNKNOWN':'PUBLISHED');}finally{second.close();}
 assert.equal(count(x,'sites_synthetic_attempts'),1);assert.equal(count(x,'sites_synthetic_objects'),phase==='before dispatch'?0:1);assert.equal(x.f.sql.prepare('SELECT state FROM sites_execution_claims').get().state,phase==='before dispatch'?'UNKNOWN':'SETTLED');assert.equal(x.f.sql.prepare("SELECT count(*) n FROM sites_execution_events WHERE event='RELEASED'").get().n,0);
});

test('historical approval command still reads its committed receipt after text edit invalidation',async t=>{
 const x=await editable(t,{review:true}),event=x.f.sql.prepare("SELECT * FROM sites_approval_events WHERE review_id=? AND kind='CONTENT_APPROVED'").get(x.id),row=x.f.sql.prepare('SELECT * FROM sites_approval_commands WHERE event_id=?').get(event.id),input={command_id:row.command_id,decision:'APPROVE',expected_subject:event.subject_fingerprint,expected_event_id:null,reason:event.reason,checks:JSON.parse(event.checks_json),confirmation:'CONTENT_ONLY'};await save(x);
 const receipt=await x.approvals.decide(x.id,input,x.scope,{authority:syntheticAdmin});assert.equal(receipt.committed,true);assert.equal(receipt.event_id,event.id);assert.equal(receipt.approval.state,'REVOKED');assert.equal(receipt.approval.can_decide,false);assert.equal(x.f.sql.prepare('SELECT count(*) n FROM sites_approval_events WHERE review_id=?').get(x.id).n,2);
});

test('historical preparation receipt remains committed/stale after edit without creating another frozen job',async t=>{
 const x=await editable(t,{review:true}),plans=new AsyncUploadPlans(x.f.db,x.options),input={expected_subject:x.input.expected_subject,expected_event_id:x.input.expected_event_id,source_id:x.plan.source_id,payload_artifact_id:'platform'},before=count(x,'publisher_jobs');await save(x);
 const receipt=await plans.prepare(x.id,input,x.scope,{authority:syntheticAdmin});assert.equal(receipt.committed,true);assert.equal(receipt.duplicate,true);assert.equal(receipt.id,x.plan.id);assert.equal(receipt.status,'STALE_PREVIEW');assert.equal(count(x,'publisher_jobs'),before);
});

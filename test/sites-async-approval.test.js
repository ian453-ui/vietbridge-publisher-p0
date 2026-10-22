import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {approvalFixture,syntheticAdmin,approvalCommand,seedCloudApproval} from './fixtures/sites-approval.js';
import {inspectedPacket} from './fixtures/sites-evidence.js';
import {cloudD1Fixture} from './fixtures/sites-cloud-d1.js';
import {AsyncApprovalStore} from '../src/sites/async-approval-store.js';
import {AsyncReviewStore} from '../src/sites/async-review-store.js';
const approve=async x=>x.approvals.decide(x.id,approvalCommand(await x.approvals.view(x.id,x.scope,{admin:true})),x.scope,{authority:syntheticAdmin});
function barrier(x,mutate){const original=x.f.db.batch;let fired=false;x.f.db.batch=async statements=>{if(!fired&&statements.some(s=>s.query.includes('INSERT INTO sites_approval_events'))){fired=true;const other=new DatabaseSync(x.path);try{mutate(other);}finally{other.close();}}return original(statements);};}
test('async approval keeps native decision, replay, revoke and restart semantics',async t=>{
 const x=await approvalFixture(t);const v=await x.approvals.view(x.id,x.scope,{admin:true}),cmd=approvalCommand(v);
 const a=await x.approvals.decide(x.id,cmd,x.scope,{authority:syntheticAdmin});assert.equal(a.approval.state,'CONTENT_APPROVED');assert.equal(a.publish_allowed,false);
 assert.equal((await x.approvals.decide(x.id,cmd,x.scope,{authority:syntheticAdmin})).event_id,a.event_id);
 const other=cloudD1Fixture(x.path,{initialize:false});try{const store=new AsyncApprovalStore(other.db,x.options),r=await store.decide(x.id,approvalCommand(await store.view(x.id,x.scope),{decision:'REJECT',reason:'Human withdraws content approval'}),x.scope,{authority:syntheticAdmin});assert.equal(r.approval.state,'CONTENT_REJECTED');assert.equal((await store.decide(x.id,cmd,x.scope,{authority:syntheticAdmin})).approval.state,'CONTENT_REJECTED');}finally{other.close();}
 assert.equal(x.f.sql.prepare('SELECT count(*) n FROM sites_approval_events').get().n,2);
});
test('client self-asserted identity and unbound real provenance cannot approve',async t=>{
 const x=await approvalFixture(t),cmd=approvalCommand(await x.approvals.view(x.id,x.scope));await assert.rejects(x.approvals.decide(x.id,cmd,x.scope,{authority:{authenticated:true}}),/APPROVAL_ADMIN_REQUIRED/);
 x.f.sql.prepare('DELETE FROM sites_approval_bindings').run();assert.equal((await x.approvals.view(x.id,x.scope,{admin:true})).can_decide,false);await assert.rejects(x.approvals.decide(x.id,cmd,x.scope,{authority:syntheticAdmin}),/PRODUCER_AUTH_UNAVAILABLE/);
});
for(const [name,mutate] of [
 ['membership revoked', (db,x)=>db.prepare('UPDATE sites_project_memberships SET revoked_at=? WHERE workspace=? AND account_id=?').run(new Date().toISOString(),x.workspace,x.accountId)],
 ['account changed',(db,x)=>db.prepare("UPDATE sites_account_details SET external_identity='DIFFERENT' WHERE account_id=?").run(x.accountId)],
 ['media state changed',(db)=>db.prepare("UPDATE sites_objects SET state='CORRUPT'").run()],
])test('approval atomic barrier: '+name,async t=>{const x=await approvalFixture(t);barrier(x,db=>mutate(db,x));await assert.rejects(approve(x),/SCOPE_DENIED|APPROVAL_CONCURRENT_CHANGE/);assert.equal(x.f.sql.prepare('SELECT count(*) n FROM sites_approval_events').get().n,0);assert.equal(x.f.sql.prepare('SELECT count(*) n FROM sites_approval_commands').get().n,0);});
test('concurrent stale decision cannot override a completed rejection',async t=>{
 const x=await approvalFixture(t);await approve(x);const view=await x.approvals.view(x.id,x.scope),old=approvalCommand(view);barrier(x,db=>{db.prepare("INSERT INTO sites_approval_events(id,review_id,subject_fingerprint,kind,actor_id,reason,checks_json,created_at) VALUES(?,?,?,'CONTENT_REJECTED',?,'concurrent reject','{}',?)").run(crypto.randomUUID(),x.id,view.subject_fingerprint,syntheticAdmin.actor_id,new Date().toISOString());});
 // Different reason ensures this is a new event, rather than native no-op approval.
 old.reason='different';await assert.rejects(x.approvals.decide(x.id,old,x.scope,{authority:syntheticAdmin}),/APPROVAL_CONCURRENT_CHANGE/);assert.equal((await x.approvals.view(x.id,x.scope)).state,'CONTENT_REJECTED');
});
test('new result revision invalidates old approval on read and refuses stale decision',async t=>{
 const x=await approvalFixture(t);await approve(x);const next=inspectedPacket(x.root,x.scope,{revision:2,prior:x.packet.request,platformPayload:true}),store=new AsyncReviewStore(x.f.db,{...x.options,inspectionProvider:{readInspection:async()=>next}});await store.intake({...x.scope,task_id:next.request.task_id,request_revision:2});await seedCloudApproval(x.f,next,x.scope);
 const view=await x.approvals.view(x.id,x.scope);assert.equal(view.state,'REVOKED');assert.equal(view.blocked_reason,'STALE_REVIEW_VERSION');assert.equal(view.history[0].kind,'REVOKED');
});
test('DB failure rolls approval event and receipt back; lost commit ack preserves receipt',async t=>{
 const x=await approvalFixture(t),cmd=approvalCommand(await x.approvals.view(x.id,x.scope)),base=x.f.db.batch;
 x.f.db.batch=async ss=>{if(ss.some(s=>s.query.includes('INSERT INTO sites_approval_events')))x.f.fault=ss.length-2;try{return await base(ss);}finally{x.f.fault=-1;}};
 await assert.rejects(x.approvals.decide(x.id,cmd,x.scope,{authority:syntheticAdmin}),/SYNTHETIC_TRANSACTION_FAILURE/);assert.equal(x.f.sql.prepare('SELECT count(*) n FROM sites_approval_events').get().n,0);
 x.f.db.batch=async ss=>{const r=await base(ss);if(ss.some(s=>s.query.includes('INSERT INTO sites_approval_commands')))throw Error('LOST_COMMIT_ACK');return r;};
 const receipt=await x.approvals.decide(x.id,cmd,x.scope,{authority:syntheticAdmin});assert.equal(receipt.committed,true);assert.equal(receipt.approval.state,'CONTENT_APPROVED');assert.equal(x.f.sql.prepare('SELECT count(*) n FROM sites_approval_events').get().n,1);
});

test('second connection creates newer revision after preflight: approval rolls back',async t=>{
 const x=await approvalFixture(t);barrier(x,db=>{const row=db.prepare('SELECT * FROM sites_reviews WHERE id=?').get(x.id);db.prepare("INSERT INTO sites_reviews VALUES(?,?,?,?,?,?,?,?,?,?,'REVIEW_REQUIRED',?)").run('f'.repeat(64),row.task_id,2,row.workspace,row.account_id,row.request_json,row.result_json,row.report_json,row.envelope_hash,row.result_fingerprint,new Date().toISOString());});await assert.rejects(approve(x),/APPROVAL_CONCURRENT_CHANGE/);assert.equal(x.f.sql.prepare('SELECT count(*) n FROM sites_approval_events').get().n,0);
});

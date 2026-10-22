import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.js';
import {ProductionApprovalStore} from '../src/production-approval-store.js';
import {ProductionSourceEvidence} from '../src/production-source-evidence.js';
import {handoffFixture} from './fixtures/production-handoff.js';
import {syntheticAdmin,approvalCommand} from './fixtures/synthetic-approval.js';
import {trustedSourceFixture} from './fixtures/trusted-production-source.js';

async function setup(t,options={}){const root=mkdtempSync(join(tmpdir(),'v3-source-')),f=await handoffFixture(root);t.after(()=>{f.store.close();rmSync(root,{recursive:true,force:true});});return {...f,source:trustedSourceFixture(f,options)};}
test('server-only exact source evidence binds human approval, native ZIP media plan; repeat observation does not duplicate decisions',async t=>{
 const f=await setup(t),s=f.source;assert.equal(f.reviews.approvals.view(f.reviewId,f.scope).state,'REVOKED');
 const receipt=await s.verify();assert.equal(receipt.current.status,'VERIFIED');assert.equal(receipt.publish_allowed,false);assert.equal(receipt.producer_authenticated,false);
 assert.notEqual(f.reviews.approvals.view(f.reviewId,f.scope).state,'CONTENT_APPROVED');const approved=s.approve();assert.equal(approved.approval.state,'CONTENT_APPROVED');
 const binding=f.store.db.prepare('SELECT * FROM production_approval_source_bindings WHERE event_id=?').get(approved.event_id);assert.equal(binding.attempt_id,receipt.attempt_id);assert.equal(binding.binding_hash,s.expected.binding_hash);
 const current=f.reviews.approvals.view(f.reviewId,f.scope);const plan=f.plans.prepare(f.reviewId,{...f.input,expected_event_id:current.latest_event_id},f.scope,{authority:syntheticAdmin});assert.equal(plan.publication_authority.mechanism,'NONE');assert.equal(plan.publish_allowed,false);assert.equal(f.factory.stats().submits,0);
 assert.equal((await s.verify()).current.status,'VERIFIED');assert.equal(s.approve().event_id,approved.event_id);assert.equal(f.store.db.prepare('SELECT count(*) n FROM production_source_decisions').get().n,1);assert.equal(f.store.db.prepare('SELECT count(*) n FROM production_source_receipts').get().n,2);
 assert.equal(f.plans.view(plan.id,f.scope).job_id,plan.job_id);
 const db=new Store(f.demo.dbPath,{seedDemo:false});try{const approvals=new ProductionApprovalStore(db.db);assert.equal(approvals.view(f.reviewId,f.scope).blocked_reason,'SOURCE_PROVIDER_UNAVAILABLE');const restored=new ProductionSourceEvidence(db.db,s.options);assert.equal(restored.view(f.reviewId,f.scope).status,'VERIFIED');assert.equal(db.db.prepare('SELECT count(*) n FROM production_source_receipts').get().n,2);assert.equal(approvals.view(f.reviewId,f.scope).state,'REVOKED','reading without provider invalidated old approval; restart never reapproves');}finally{db.close();}
});
test('source transport rejects client authenticated/authority/reference fields and unauthorized scope before reading',async t=>{
 const f=await setup(t),s=f.source,input={expected_subject:s.expected.binding.subject_fingerprint};
 for(const extra of [{authenticated:true},{producer_authenticated:true},{provider_id:'synthetic_test'},{task_reference:s.config.task_reference},{publish_allowed:true}])await assert.rejects(()=>s.service.verify(f.reviewId,{...input,...extra},f.scope,{authority:syntheticAdmin}),/SOURCE_SCHEMA_INVALID/);
 await assert.rejects(()=>s.service.verify(f.reviewId,input,f.scope,{authority:{kind:'CLIENT',actor_id:syntheticAdmin.actor_id}}),/SOURCE_ADMIN_REQUIRED/);
 await assert.rejects(()=>s.service.verify(f.reviewId,input,{workspace:f.demo.otherWorkspace,accountId:f.demo.otherAccountId},{authority:syntheticAdmin}),/APPROVAL_NOT_FOUND/);
 assert.equal(s.calls,0);assert.throws(()=>s.service.attach({...s.config,producer:{issuer:'fixture',subject:'someone-else'}}),/SOURCE_BINDING_CONFLICT/);
 const disabled=new ProductionSourceEvidence(f.store.db);await assert.rejects(()=>disabled.verify(f.reviewId,input,f.scope,{authority:syntheticAdmin}),/SOURCE_PROVIDER_UNAVAILABLE/);assert.equal(s.calls,0);
});
test('trusted read mismatches author, original task, submission, result, media digest, approval identity and unknown history all fail closed',async t=>{
 const f=await setup(t),s=f.source,baseline=structuredClone(s.snapshot),cases=[
  [x=>x.authenticated=true,'SOURCE_SCHEMA_INVALID'],[x=>x.submission.author.subject='forged','SOURCE_IDENTITY_MISMATCH'],
  [x=>x.task.author.subject='forged','SOURCE_IDENTITY_MISMATCH'],[x=>x.submission.reference='different-submission','SOURCE_REFERENCE_MISMATCH'],
  [x=>x.submission.task_reference.thread_ts='1999999999.000001','SOURCE_REFERENCE_MISMATCH'],[x=>x.task.request.task_id='SYNTHETIC-OTHER','SOURCE_PAYLOAD_MISMATCH'],
  [x=>x.submission.result.items[0].artifacts[0].sha256='f'.repeat(64),'SOURCE_PAYLOAD_MISMATCH'],
  [x=>x.decisions[0].binding_hash='f'.repeat(64),'SOURCE_APPROVAL_INVALID'],[x=>x.decisions[0].author.subject='unapproved-author','SOURCE_APPROVAL_INVALID'],
  [x=>x.decisions[0].kind='UNKNOWN','SOURCE_APPROVAL_INVALID'],[x=>x.history_complete=false,'SOURCE_SNAPSHOT_INVALID'],[x=>x.decisions=[],'SOURCE_APPROVAL_HISTORY_REQUIRED']];
 for(const [mutate,reason] of cases){const snapshot=structuredClone(baseline);mutate(snapshot);s.read=async()=>Buffer.from(JSON.stringify(snapshot));const result=await s.verify();assert.equal(result.attempt_reason,reason);assert.equal(result.current.status,'BLOCKED');assert.throws(()=>s.approve());}
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM production_source_decisions').get().n,0);assert.equal(f.store.db.prepare('SELECT count(*) n FROM production_source_receipts WHERE raw IS NOT NULL').get().n,cases.length);
});
test('new source revocation overrides prior PASS; old/conflicting history cannot roll back; plan and local approval invalidated',async t=>{
 const f=await setup(t),s=f.source;await s.verify();s.approve();const approved=f.reviews.approvals.view(f.reviewId,f.scope),plan=f.plans.prepare(f.reviewId,{...f.input,expected_event_id:approved.latest_event_id},f.scope,{authority:syntheticAdmin}),old=s.raw();
 s.revoke();assert.equal((await s.verify()).current.blocked,'SOURCE_APPROVAL_REVOKED');assert.equal(f.reviews.approvals.view(f.reviewId,f.scope).state,'REVOKED');assert.throws(()=>f.plans.view(plan.id,f.scope),/APPROVAL/);
 s.read=async()=>old;assert.equal((await s.verify()).current.blocked,'SOURCE_HISTORY_CONFLICT');s.read=async()=>{const x=JSON.parse(old);x.decisions[0].id='overwrite';return Buffer.from(JSON.stringify(x));};assert.equal((await s.verify()).current.blocked,'SOURCE_HISTORY_CONFLICT');assert.equal(f.store.db.prepare('SELECT count(*) n FROM production_source_decisions').get().n,2);
});
test('transient timeout/throw/oversize never falls back to success; late provider completion has no write; bounded reread recovers',async t=>{
 const f=await setup(t,{timeoutMs:30}),s=f.source;await s.verify();s.approve();let finish;
 s.read=()=>new Promise(resolve=>{finish=resolve;});assert.equal((await s.verify()).current.blocked,'SOURCE_PROVIDER_TIMEOUT');assert.equal(f.reviews.approvals.view(f.reviewId,f.scope).state,'REVOKED');const count=f.store.db.prepare('SELECT count(*) n FROM production_source_receipts').get().n;finish(s.raw());await new Promise(r=>setImmediate(r));assert.equal(f.store.db.prepare('SELECT count(*) n FROM production_source_receipts').get().n,count);
 s.read=async()=>{throw Error('do-not-leak-provider-secret');};assert.equal((await s.verify()).attempt_reason,'SOURCE_PROVIDER_READ_FAILED');
 s.read=async()=>Buffer.alloc(1048577);assert.equal((await s.verify()).attempt_reason,'SOURCE_RESPONSE_BUDGET');assert.equal(f.store.db.prepare('SELECT raw FROM production_source_receipts ORDER BY attempt_id DESC LIMIT 1').get().raw,null);
 s.read=async()=>s.raw();assert.equal((await s.verify()).current.status,'VERIFIED');assert.notEqual(f.reviews.approvals.view(f.reviewId,f.scope).state,'CONTENT_APPROVED');assert.equal(s.approve().approval.state,'CONTENT_APPROVED');
});
test('attempt generation: old late success cannot hide new failed or revoked observation',async t=>{
 const f=await setup(t),s=f.source;let finish;s.read=()=>new Promise(resolve=>{finish=resolve;});const a=s.verify();await new Promise(r=>setImmediate(r));s.read=async()=>{throw Error('new failure');};const b=await s.verify();finish(s.raw());const late=await a;assert.ok(late.attempt_id<b.attempt_id);assert.equal(late.current.attempt_id,b.attempt_id);assert.equal(late.current.blocked,'SOURCE_PROVIDER_READ_FAILED');
 s.read=()=>new Promise(resolve=>{finish=resolve;});const c=s.verify();await new Promise(r=>setImmediate(r));const old=s.raw();s.revoke();s.read=async()=>s.raw();const d=await s.verify();finish(old);assert.equal((await c).current.attempt_id,d.attempt_id);assert.equal(s.service.view(f.reviewId,f.scope).blocked,'SOURCE_APPROVAL_REVOKED');
});
test('freshness uses observed time, rejects future clocks, and stale evidence revokes approval',async t=>{
 let clock=Date.now();const f=await setup(t,{now:()=>clock,maxAgeMs:1000}),s=f.source;await s.verify();s.approve();clock+=1001;assert.equal(s.service.view(f.reviewId,f.scope).blocked,'SOURCE_EVIDENCE_EXPIRED');assert.equal(f.reviews.approvals.view(f.reviewId,f.scope,{now:clock}).state,'REVOKED');
 const old=JSON.parse(s.raw());old.observed_at=clock-1001;s.read=async()=>Buffer.from(JSON.stringify(old));assert.equal((await s.verify()).attempt_reason,'SOURCE_SNAPSHOT_INVALID');old.observed_at=clock+1;assert.equal((await s.verify()).attempt_reason,'SOURCE_SNAPSHOT_INVALID');
});
test('a newer authoritative revocation learned by an older read still vetoes a more recent success receipt',async t=>{
 const f=await setup(t),s=f.source;let finish;s.read=()=>new Promise(resolve=>{finish=resolve;});const old=s.verify();await new Promise(r=>setImmediate(r));s.read=async()=>s.raw();const current=await s.verify();assert.equal(current.current.status,'VERIFIED');s.approve();s.revoke();finish(s.raw());const late=await old;assert.equal(late.current.attempt_id,current.attempt_id);assert.equal(late.current.blocked,'SOURCE_APPROVAL_REVOKED');assert.equal(f.reviews.approvals.view(f.reviewId,f.scope).state,'REVOKED');
});
test('real/unverified provenance remains disabled even with source evidence; account changes cannot transfer approval',async t=>{
 const f=await setup(t),s=f.source;f.store.db.prepare('DELETE FROM production_review_provenance WHERE review_id=?').run(f.reviewId);assert.equal((await s.verify()).current.status,'VERIFIED');assert.equal(f.reviews.approvals.view(f.reviewId,f.scope,{admin:true}).blocked_reason,'PRODUCER_AUTH_UNAVAILABLE');assert.throws(()=>s.approve(),/PRODUCER_AUTH_UNAVAILABLE/);assert.throws(()=>f.prepare());
 f.store.db.prepare("UPDATE facebook_accounts SET target_page_id='999999999999999' WHERE id=?").run(f.scope.accountId);assert.equal(s.service.view(f.reviewId,f.scope).blocked,'SOURCE_SUBJECT_CHANGED');assert.throws(()=>s.approve(),/PRODUCER_AUTH_UNAVAILABLE/);
 f.store.db.prepare("UPDATE production_review_assets SET data=x'00' WHERE review_id=?").run(f.reviewId);assert.doesNotThrow(()=>s.service.view(f.reviewId,f.scope),'corrupt review must retain readable blocked status');assert.equal(s.service.view(f.reviewId,f.scope).can_verify,false);assert.equal(f.reviews.approvals.view(f.reviewId,f.scope).blocked_reason,'APPROVAL_STORAGE_CORRUPT');
});
test('approval plus source receipt link rolls back together on injected DB failure; immutable audit preserved',async t=>{
 const f=await setup(t),s=f.source;await s.verify();const before=f.store.db.prepare('SELECT count(*) n FROM production_approval_events').get().n;
 f.store.db.exec("CREATE TRIGGER synthetic_link_failure BEFORE INSERT ON production_approval_source_bindings BEGIN SELECT RAISE(ABORT,'SYNTHETIC_LINK_FAILURE'); END;");assert.throws(()=>s.approve(),/SYNTHETIC_LINK_FAILURE/);assert.equal(f.store.db.prepare('SELECT count(*) n FROM production_approval_events').get().n,before);assert.equal(f.store.db.prepare('SELECT count(*) n FROM production_approval_source_bindings').get().n,0);f.store.db.exec('DROP TRIGGER synthetic_link_failure');assert.equal(s.approve().approval.state,'CONTENT_APPROVED');
 for(const table of ['production_source_attempts','production_source_receipts','production_source_decisions','production_source_requirements','production_approval_source_bindings'])assert.throws(()=>f.store.db.exec('DELETE FROM '+table),/SOURCE_AUDIT_IMMUTABLE/);
});
test('failure while recording evidence leaves pending generation and rolls back decisions/receipt without resurrecting old approval',async t=>{
 const f=await setup(t),s=f.source;await s.verify();s.approve();s.revoke();f.store.db.exec("CREATE TRIGGER synthetic_receipt_failure BEFORE INSERT ON production_source_receipts BEGIN SELECT RAISE(ABORT,'SYNTHETIC_RECEIPT_FAILURE'); END;");await assert.rejects(()=>s.verify(),/SYNTHETIC_RECEIPT_FAILURE/);assert.equal(f.store.db.prepare('SELECT count(*) n FROM production_source_decisions').get().n,1);assert.equal(f.store.db.prepare('SELECT count(*) n FROM production_source_receipts').get().n,1);assert.equal(s.service.view(f.reviewId,f.scope).blocked,'SOURCE_VERIFICATION_PENDING');assert.equal(f.reviews.approvals.view(f.reviewId,f.scope).state,'REVOKED');
});
test('two SQLite connections retain attempt order; simulated UNKNOWN remains reconcile-only after source revocation',async t=>{
 const f=await setup(t),s=f.source;await s.verify();s.approve();const view=f.reviews.approvals.view(f.reviewId,f.scope),plan=f.plans.prepare(f.reviewId,{...f.input,expected_event_id:view.latest_event_id},f.scope,{authority:syntheticAdmin});f.executor.approve(f.scope.workspace,plan.job_id,f.publisher.job(f.scope.workspace,plan.job_id).snapshot_hash);f.factory.setFault('SUBMIT_RESPONSE_LOST');
 await assert.rejects(()=>f.executor.execute(f.scope.workspace,plan.job_id),/SYNTHETIC_SUBMIT_RESPONSE_LOST/);assert.equal(f.publisher.job(f.scope.workspace,plan.job_id).state,'UNKNOWN');assert.equal(f.factory.stats().submits,1);
 let finish;s.read=()=>new Promise(resolve=>{finish=resolve;});const old=s.verify();await new Promise(r=>setImmediate(r));const oldRaw=s.raw(),other=new Store(f.demo.dbPath,{seedDemo:false});
 try{const reader=new ProductionSourceEvidence(other.db,s.options);s.revoke();s.read=async()=>s.raw();const latest=await reader.verify(f.reviewId,{expected_subject:s.expected.binding.subject_fingerprint},f.scope,{authority:syntheticAdmin});finish(oldRaw);assert.equal((await old).current.attempt_id,latest.attempt_id);assert.equal(s.service.view(f.reviewId,f.scope).blocked,'SOURCE_APPROVAL_REVOKED');}finally{other.close();}
 await assert.rejects(()=>f.executor.execute(f.scope.workspace,plan.job_id));f.factory.setFault('NONE');const result=await f.executor.reconcile(f.scope.workspace,plan.job_id);assert.equal(result.state,'PUBLISHED');assert.equal(f.factory.stats().submits,1);assert.equal(result.evidence.syntheticOnly,true);
});

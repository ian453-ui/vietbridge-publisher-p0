import test from 'node:test';
import assert from 'node:assert/strict';
import {permitFixture,syntheticPermitClock,seedPermit} from './fixtures/sites-permits.js';
import {cloudD1Fixture} from './fixtures/sites-cloud-d1.js';
import {syntheticAdmin,approvalCommand} from './fixtures/sites-approval.js';
import {AsyncApprovalStore} from '../src/sites/async-approval-store.js';
import {AsyncSyntheticExecutor} from '../src/sites/async-synthetic-executor.js';

async function prepared(t,change){
 const x=await permitFixture(t),clock=await syntheticPermitClock(x.f),p=await x.plan();
 // A synthetic canonical source head bound to this existing Review. The mutation
 // below is the same persisted QA state used by the canonical import path.
 if(change==='source QA'){
  x.f.sql.prepare("INSERT INTO sites_source_heads VALUES(?,?,?,?,?,?,?,'IMPORTED',?,NULL,?)").run('synthetic-dispatch-source',x.workspace,x.accountId,'{}',1,'a'.repeat(64),'{}','synthetic-source-attempt',new Date(clock.ms).toISOString());
  x.f.sql.prepare('INSERT INTO sites_review_sources VALUES(?,?,?,?)').run(p.p.review_id,'synthetic-dispatch-source',1,'a'.repeat(64));
 }
 await seedPermit(x,p,clock);return {...x,p,clock};
}
async function withdraw(x,change){
 const second=cloudD1Fixture(x.path,{initialize:false});try{
  if(change==='content rejection'){
   const approvals=new AsyncApprovalStore(second.db,x.options),view=await approvals.view(x.p.p.review_id,x.scope);
   await approvals.decide(x.p.p.review_id,approvalCommand(view,{decision:'REJECT',reason:'Synthetic concurrent withdrawal after intent'}),x.scope,{authority:syntheticAdmin});
  }else second.sql.prepare("UPDATE sites_source_heads SET state='QA_BLOCKED',reason='SOURCE_QA_REVIEW_REQUIRED' WHERE source_key=?").run('synthetic-dispatch-source');
 }finally{second.close();}
}
for(const change of ['content rejection','source QA'])test(change+' after intent must atomically block actual dispatch and retain UNKNOWN quota',async t=>{
 const x=await prepared(t,change),base=x.f.db.batch;let withdrawn=false;
 x.f.db.batch=async ss=>{
  if(!withdrawn&&ss.some(s=>s.query.startsWith('INSERT INTO sites_synthetic_objects'))){
   withdrawn=true;assert.equal(x.f.sql.prepare('SELECT state FROM sites_synthetic_attempts').get().state,'SUBMITTING');assert.equal(x.f.sql.prepare('SELECT state FROM sites_execution_claims').get().state,'SUBMITTING');
   // A second writer commits after dispatch preflight, before its atomic batch.
   await withdraw(x,change);
  }
  return base(ss);
 };
 const r=await x.run(x.p);assert.equal(withdrawn,true);assert.equal(r.state,'UNKNOWN');assert.equal(r.next_action,'RECONCILE_PENDING');assert.equal(x.f.sql.prepare('SELECT count(*) n FROM sites_synthetic_objects').get().n,0);assert.equal(x.f.sql.prepare('SELECT count(*) n FROM sites_synthetic_readbacks').get().n,0);assert.equal(x.f.sql.prepare('SELECT state FROM sites_execution_claims').get().state,'UNKNOWN');assert.equal(x.f.sql.prepare('SELECT status FROM sites_execution_permits').get().status,'CONSUMED');assert.equal(x.f.sql.prepare("SELECT count(*) n FROM sites_execution_events WHERE event='RELEASED'").get().n,0);
 const second=cloudD1Fixture(x.path,{initialize:false});try{await syntheticPermitClock(second,{ms:x.clock.ms});const restarted=new AsyncSyntheticExecutor(second.db,x.options);assert.equal((await restarted.run(x.p.id,x.p.input,x.scope,{authority:syntheticAdmin})).state,'UNKNOWN');assert.equal((await restarted.recover(x.p.id,x.scope,{closePreparation:true})).state,'UNKNOWN');}finally{second.close();}
 assert.equal(x.f.sql.prepare('SELECT count(*) n FROM sites_synthetic_objects').get().n,0);assert.equal(x.f.sql.prepare('SELECT count(*) n FROM sites_synthetic_attempts').get().n,1);assert.equal(x.f.sql.prepare('SELECT state FROM sites_execution_claims').get().state,'UNKNOWN');
});
for(const change of ['content rejection','source QA'])test(change+' after actual commit does not block original readback on restart',async t=>{
 const x=await prepared(t,change),base=x.f.db.batch;let withdrawn=false;x.executor.setFault('SUBMIT_RESPONSE_LOST');
 x.f.db.batch=async ss=>{const result=await base(ss);if(!withdrawn&&ss.some(s=>s.query.startsWith('INSERT INTO sites_synthetic_objects'))){withdrawn=true;await withdraw(x,change);}return result;};
 assert.equal((await x.run(x.p)).state,'UNKNOWN');assert.equal(withdrawn,true);assert.equal(x.f.sql.prepare('SELECT state FROM sites_execution_claims').get().state,'UNKNOWN');
 const second=cloudD1Fixture(x.path,{initialize:false});try{await syntheticPermitClock(second,{ms:x.clock.ms});const restarted=new AsyncSyntheticExecutor(second.db,x.options),r=await restarted.run(x.p.id,x.p.input,x.scope,{authority:syntheticAdmin});assert.equal(r.state,'PUBLISHED');assert.equal(r.evidence.syntheticOnly,true);assert.equal((await restarted.reconcile(x.p.id,x.scope)).evidence.attempt_id,r.evidence.attempt_id);}finally{second.close();}
 assert.equal(x.f.sql.prepare('SELECT count(*) n FROM sites_synthetic_objects').get().n,1);assert.equal(x.f.sql.prepare('SELECT count(*) n FROM sites_synthetic_readbacks').get().n,1);assert.equal(x.f.sql.prepare('SELECT count(*) n FROM sites_synthetic_attempts').get().n,1);assert.equal(x.f.sql.prepare('SELECT state FROM sites_execution_claims').get().state,'SETTLED');assert.equal(x.f.sql.prepare("SELECT count(*) n FROM sites_execution_events WHERE event='RELEASED'").get().n,0);
});
test('unchanged content/source approval still dispatches and settles exactly once',async t=>{
 const x=await prepared(t,'source QA'),first=await x.run(x.p),again=await x.run(x.p);assert.equal(first.state,'PUBLISHED');assert.equal(again.evidence.attempt_id,first.evidence.attempt_id);assert.equal(first.publish_allowed,false);assert.equal(x.f.sql.prepare('SELECT count(*) n FROM sites_synthetic_objects').get().n,1);assert.equal(x.f.sql.prepare('SELECT state FROM sites_execution_claims').get().state,'SETTLED');
});

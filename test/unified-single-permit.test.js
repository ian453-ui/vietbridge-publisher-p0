import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.js';
import {UnifiedPublisher} from '../src/unified-publisher.js';
import {UnifiedExecutor} from '../src/unified-executor.js';
import {BrowserResources} from '../src/browser-resources.js';
import {executionScope} from '../src/single-execution-permit.js';
import {executionButton} from '../src/unified-client.js';
import {unifiedRoute} from '../src/unified-http.js';

const authorization={task_id:'fixture-task',approval_thread_id:'fixture-user-thread',approval_message_id:'fixture-user-approval'};
function setup(t) {
  const root=mkdtempSync(join(tmpdir(),'vb-single-permit-')),path=join(root,'publisher-unified.sqlite');
  const store=new Store(path,{seedDemo:false}),publisher=new UnifiedPublisher(store),workspace=store.saveWorkspace({name:'LP',content_root:root});
  const readers=[store];t.after(()=>{for(const reader of readers)reader.close();rmSync(root,{recursive:true,force:true});});
  const profile=store.saveProfile(workspace.id,{name:'LP Chrome',cdp_port:19852,user_data_dir:join(root,'chrome')});
  const account=publisher.saveAccount(workspace.id,{display_name:'LP Travel Visa',expected_identity:'LP Travel Visa',identity_type:'PAGE',external_id:'61594159443807',operator_actor_id:'61594159443807',target_page_id:'1459220443931651',profile_id:profile.id});
  const content=publisher.importContent(workspace.id,{source_id:'test-lp',revision:'1',title:'LP promotion',body:'Frozen promotion',media:[]});
  const job=publisher.createPageJob(workspace.id,{account_id:account.id,content_id:content.id});
  let creates=0,submits=0,failAt='',now=Date.now(),executor;
  const driver={async prepare(s,assets,before){if(failAt==='beforePrepare')throw Error('before prepare');before();if(failAt==='prepare')throw Error('prepare connection lost');return {identityVerified:true};},
    async submit(){submits++;if(failAt==='submit')throw Error('submit outcome unknown');return {id:'fixture-post',url:'https://www.facebook.com/61594159443807/posts/999'};},
    async readback(s){if(failAt==='readback')throw Error('independent readback unavailable');return {verified:true,id:'fixture-post',url:'https://www.facebook.com/61594159443807/posts/999',operatorActorId:s.operatorActorId,targetPageId:s.targetPageId,contentHash:s.contentHash,payloadHash:s.payloadHash};},failureEvidence(){return {phase:failAt,buttonVisible:false,finalClickAttempted:failAt==='submit'};},async close(){}};
  const options={enabled:false,resources:new BrowserResources(join(root,'locks')),snapshotRoot:join(root,'media'),mediaRoots:[root],drivers:{create:async()=>{
    creates++;assert.equal(store.db.isTransaction,false);const permit=executor.permits.record(job.id);assert.equal(permit.status,'CONSUMED');assert.equal(publisher.job(workspace.id,job.id).state,'PREPARING');assert.equal(permit.attempt_id,publisher.job(workspace.id,job.id).attempt_id);return driver;}}};
  executor=new UnifiedExecutor(publisher,options);executor.permits.now=()=>now;executor.approve(workspace.id,job.id,job.snapshot_hash);
  const grant=()=>executor.permits.issue(workspace.id,job.id,executionScope(job),{expiresAt:now+60000,authorization});
  const reopen=()=>{const reader=new Store(path,{seedDemo:false});readers.push(reader);const p=new UnifiedPublisher(reader),e=new UnifiedExecutor(p,options);e.permits.now=()=>now;return {publisher:p,executor:e};};
  return {root,path,store,publisher,workspace,account,content,job,executor,grant,reopen,get creates(){return creates;},get submits(){return submits;},get now(){return now;},set now(value){now=value;},set failAt(value){failAt=value;}};
}
test('default deny; exact permit enables only its job and consumes atomically before driver creation',async t=>{
  const f=setup(t);assert.equal(f.executor.executionCapability(f.workspace.id,f.job.id).canExecute,false);
  await assert.rejects(()=>f.executor.execute(f.workspace.id,f.job.id),/验收模式/);assert.equal(f.creates,0);
  const second=f.publisher.importContent(f.workspace.id,{source_id:'other',revision:'1',body:'Other content',media:[]}),other=f.publisher.createPageJob(f.workspace.id,{account_id:f.account.id,content_id:second.id});f.executor.approve(f.workspace.id,other.id,other.snapshot_hash);
  assert.equal(f.grant().canExecute,true);assert.equal(f.executor.executionCapability(f.workspace.id,other.id).canExecute,false);
  const prefix=`http://localhost/api/unified/workspaces/${f.workspace.id}/jobs`,list=unifiedRoute(f.publisher,'GET',new URL(prefix),{},f.executor).body.jobs;
  assert.deepEqual(list.filter(j=>j.canExecute).map(j=>j.id),[f.job.id]);
  assert.match(executionButton(list.find(j=>j.id===f.job.id)),/执行此任务一次/);assert.doesNotMatch(executionButton(list.find(j=>j.id===f.job.id)),/ disabled/);
  assert.match(executionButton(list.find(j=>j.id===other.id)),/ disabled/);
  assert.equal((await f.executor.execute(f.workspace.id,f.job.id)).state,'PUBLISHED');assert.equal(f.submits,1);assert.equal(f.executor.enabled,false);
  assert.equal(f.executor.executionCapability(f.workspace.id,f.job.id).permitStatus,'CONSUMED');
  await assert.rejects(()=>f.executor.execute(f.workspace.id,f.job.id));await assert.rejects(()=>f.executor.execute(f.workspace.id,other.id));assert.equal(f.submits,1);
  assert.deepEqual(f.store.db.prepare('SELECT event FROM publisher_execution_permit_events ORDER BY seq').all().map(x=>x.event),['ISSUED','CONSUMED']);
});
test('every scope field, missing/extra fields, and wrong customer deny without driver calls',async t=>{
  const f=setup(t),scope=executionScope(f.job);
  for(const key of Object.keys(scope))assert.throws(()=>f.executor.permits.issue(f.workspace.id,f.job.id,{...scope,[key]:key==='media_count'?1:'wrong'},{expiresAt:f.now+60000,authorization}),/完整匹配/);
  const missing={...scope};delete missing.transport;
  for(const invalid of [missing,{...scope,extra:'not-authorized'}])assert.throws(()=>f.executor.permits.issue(f.workspace.id,f.job.id,invalid,{expiresAt:f.now+60000,authorization}));
  f.grant();
  for(const key of Object.keys(scope)){
    f.store.db.prepare('UPDATE publisher_execution_permits SET scope_json=? WHERE job_id=?').run(JSON.stringify({...scope,[key]:key==='media_count'?1:'wrong'}),f.job.id);
    assert.equal(f.executor.executionCapability(f.workspace.id,f.job.id).canExecute,false);
    await assert.rejects(()=>f.executor.execute(f.workspace.id,f.job.id),/完整范围/);
  }
  assert.equal(f.creates,0);assert.equal(f.publisher.job(f.workspace.id,f.job.id).state,'READY');
  const other=f.store.saveWorkspace({name:'Other'});assert.throws(()=>f.executor.executionCapability(other.id,f.job.id),/不属于/);
});
test('expiry and revocation are permanent and cannot be renewed or replaced',async t=>{
  const f=setup(t);f.grant();f.now+=60000;f.executor.enabled=true;assert.equal(f.executor.executionCapability(f.workspace.id,f.job.id).permitStatus,'EXPIRED');
  await assert.rejects(()=>f.executor.execute(f.workspace.id,f.job.id),/过期/);assert.throws(f.grant,/不得续期/);
  f.executor.permits.revoke(f.workspace.id,f.job.id,'Explicit cancel');assert.equal(f.executor.executionCapability(f.workspace.id,f.job.id).permitStatus,'REVOKED');
  await assert.rejects(()=>f.executor.execute(f.workspace.id,f.job.id),/撤销/);assert.throws(f.grant,/不得续期/);assert.equal(f.creates,0);
});
test('double click and another database connection can produce only one submit',async t=>{
  const f=setup(t);f.grant();const second=f.reopen();
  const outcomes=await Promise.allSettled([f.executor.execute(f.workspace.id,f.job.id),second.executor.execute(f.workspace.id,f.job.id),f.executor.execute(f.workspace.id,f.job.id)]);
  assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);assert.equal(f.creates,1);assert.equal(f.submits,1);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM publisher_execution_permit_events WHERE event='CONSUMED'").get().n,1);
});
for(const stage of ['beforePrepare','prepare','submit','readback'])test(`consumed permit remains spent after ${stage} failure, reopen and restart`,async t=>{
  const f=setup(t);f.grant();f.failAt=stage;
  await assert.rejects(()=>f.executor.execute(f.workspace.id,f.job.id));
  const state=['beforePrepare','prepare'].includes(stage)?'BLOCKED':'UNKNOWN';assert.equal(f.publisher.job(f.workspace.id,f.job.id).state,state);
  assert.equal(f.publisher.job(f.workspace.id,f.job.id).evidence.browserDiagnostics.phase,stage);
  assert.equal(f.executor.executionCapability(f.workspace.id,f.job.id).permitStatus,'CONSUMED');
  const second=f.reopen();assert.equal(second.executor.executionCapability(f.workspace.id,f.job.id).canExecute,false);
  await assert.rejects(()=>second.executor.execute(f.workspace.id,f.job.id));assert.equal(f.creates,1);
  if(stage==='prepare'){assert.throws(()=>f.executor.reopen(f.workspace.id,f.job.id),/准备副作用/);assert.equal(f.publisher.job(f.workspace.id,f.job.id).evidence.preparationEffectsMayRemain,true);}
  if(stage==='beforePrepare'){f.executor.reopen(f.workspace.id,f.job.id);f.executor.approve(f.workspace.id,f.job.id,f.job.snapshot_hash);await assert.rejects(()=>f.executor.execute(f.workspace.id,f.job.id),/消费/);}
  assert.throws(f.grant);assert.equal(f.submits,stage==='submit'||stage==='readback'?1:0);
});
test('crash before preparation recovers as BLOCKED with consumed permit and no renewal',async t=>{
  const f=setup(t);f.grant();f.executor.claim(f.workspace.id,f.job.id);
  const second=f.reopen();second.publisher.recoverAfterShutdown();assert.equal(second.publisher.job(f.workspace.id,f.job.id).state,'BLOCKED');assert.equal(second.publisher.job(f.workspace.id,f.job.id).evidence.submitCallMayHaveStarted,false);
  assert.equal(second.executor.permits.record(f.job.id).status,'CONSUMED');await assert.rejects(()=>second.executor.execute(f.workspace.id,f.job.id));assert.equal(f.creates,0);assert.throws(f.grant);
});
test('unconsumed scope survives restart while changed content and execution traces deny',async t=>{
  const f=setup(t);f.grant();const second=f.reopen();assert.equal(second.executor.executionCapability(f.workspace.id,f.job.id).canExecute,true);
  f.store.db.prepare('UPDATE group_content SET body=? WHERE id=?').run('Changed',f.content.id);assert.equal(f.executor.executionCapability(f.workspace.id,f.job.id).canExecute,false);
  await assert.rejects(()=>f.executor.execute(f.workspace.id,f.job.id),/内容版本/);assert.equal(f.creates,0);
});
test('UNKNOWN, prior attempts/intents/media, and missing audit source cannot acquire a new permit',t=>{
  const f=setup(t),scope=executionScope(f.job),issue=authorization=>f.executor.permits.issue(f.workspace.id,f.job.id,scope,{expiresAt:f.now+60000,authorization});
  assert.throws(()=>issue({}),/授权来源/);
  f.store.db.prepare("UPDATE publisher_jobs SET state='UNKNOWN' WHERE id=?").run(f.job.id);assert.throws(()=>issue(authorization),/尚未尝试/);
  f.store.db.prepare("UPDATE publisher_jobs SET state='READY',attempt_id='previous' WHERE id=?").run(f.job.id);assert.throws(()=>issue(authorization),/尚未尝试/);
  f.store.db.prepare("UPDATE publisher_jobs SET attempt_id=NULL WHERE id=?").run(f.job.id);
  f.store.db.prepare('INSERT INTO publisher_prepare_intents VALUES(?,?)').run(f.job.id,new Date().toISOString());assert.throws(()=>issue(authorization),/执行痕迹/);
  assert.equal(f.executor.permits.record(f.job.id),undefined);
});
test('claim rollback rolls back consumption and audit together before any driver side effect',t=>{
  const f=setup(t);f.grant();f.store.db.exec("CREATE TRIGGER fail_claim BEFORE UPDATE OF state ON publisher_jobs WHEN NEW.state='PREPARING' BEGIN SELECT RAISE(ABORT,'simulated claim write failure'); END");
  assert.throws(()=>f.executor.claim(f.workspace.id,f.job.id),/claim write failure/);
  assert.equal(f.executor.permits.record(f.job.id).status,'AVAILABLE');assert.equal(f.publisher.job(f.workspace.id,f.job.id).state,'READY');assert.equal(f.creates,0);
  assert.deepEqual(f.store.db.prepare('SELECT event FROM publisher_execution_permit_events ORDER BY seq').all().map(x=>x.event),['ISSUED']);
});
test('live duplicate blocks capability and claim, retaining the original history',async t=>{
  const f=setup(t);f.grant();
  f.store.db.prepare("INSERT INTO publisher_jobs SELECT 'historical-unknown',workspace,account_id,content_id,snapshot_json,snapshot_hash||'-old','UNKNOWN',NULL,'{}',created_at,updated_at FROM publisher_jobs WHERE id=?").run(f.job.id);
  assert.equal(f.executor.executionCapability(f.workspace.id,f.job.id).canExecute,false);await assert.rejects(()=>f.executor.execute(f.workspace.id,f.job.id),/不能切换模式重发/);
  assert.equal(f.creates,0);assert.equal(f.store.db.prepare("SELECT state FROM publisher_jobs WHERE id='historical-unknown'").get().state,'UNKNOWN');
});
test('different content with unresolved same-profile submission blocks before claim or driver',async t=>{
 const f=setup(t);f.grant();
 f.store.db.prepare("INSERT INTO publisher_jobs SELECT 'profile-unknown',workspace,account_id,content_id,json_set(snapshot_json,'$.payloadHash','other-payload'),snapshot_hash||'-other','UNKNOWN',NULL,'{}',created_at,updated_at FROM publisher_jobs WHERE id=?").run(f.job.id);
 const capability=f.executor.executionCapability(f.workspace.id,f.job.id);
 assert.equal(capability.canExecute,false);assert.match(capability.reason,/UNKNOWN 待核对/);
 await assert.rejects(()=>f.executor.execute(f.workspace.id,f.job.id),/UNKNOWN 待核对/);
 assert.equal(f.creates,0);assert.equal(f.submits,0);
 assert.equal(f.publisher.job(f.workspace.id,f.job.id).state,'READY');
 assert.equal(f.executor.permits.record(f.job.id).status,'AVAILABLE');
});
test('finished UNKNOWN releases profile while retaining exact-content duplicate protection',t=>{
 const f=setup(t);f.grant();
 f.store.db.prepare("INSERT INTO publisher_jobs SELECT 'archived-unknown',workspace,account_id,content_id,json_set(json_set(json_set(snapshot_json,'$.body','Different article'),'$.contentHash','different-content'),'$.payloadHash','different-payload'),snapshot_hash||'-archived','UNKNOWN','previous-attempt','{\"operatorFinished\":true,\"stage\":\"PREPARING\",\"submissionIntent\":false,\"browserDiagnostics\":{\"finalClickAttempted\":false}}',created_at,updated_at FROM publisher_jobs WHERE id=?").run(f.job.id);
 assert.equal(f.executor.profilePending(f.job.snapshot.profileId),false);
 assert.equal(f.executor.executionCapability(f.workspace.id,f.job.id).canExecute,true);
 f.store.db.prepare("UPDATE publisher_jobs SET snapshot_json=json_set(json_set(json_set(snapshot_json,'$.body',?),'$.contentHash',?),'$.payloadHash',?) WHERE id='archived-unknown'").run(f.job.snapshot.body,f.job.snapshot.contentHash,f.job.snapshot.payloadHash);
 assert.equal(f.executor.executionCapability(f.workspace.id,f.job.id).canExecute,false);
});
test('finished UNKNOWN with submit intent still holds the browser profile',t=>{
 const f=setup(t);
 f.store.db.prepare("INSERT INTO publisher_jobs SELECT 'submitted-unknown',workspace,account_id,content_id,json_set(snapshot_json,'$.body','Different submitted article'),snapshot_hash||'-submitted','UNKNOWN','old-attempt','{\"operatorFinished\":true}',created_at,updated_at FROM publisher_jobs WHERE id=?").run(f.job.id);
 f.store.db.prepare('INSERT INTO publisher_submit_intents(job_id,attempt_id,transport,snapshot_hash,prepared_json,created_at) VALUES(?,?,?,?,?,?)').run('submitted-unknown','old-attempt','BROWSER',f.job.snapshot_hash,'{}',new Date().toISOString());
 assert.equal(f.executor.profilePending(f.job.snapshot.profileId),true);
});
test('explicit not-published decision closes unknown and preserves spent permit and submit history',async t=>{
 const f=setup(t);f.grant();f.failAt='submit';
 await assert.rejects(()=>f.executor.execute(f.workspace.id,f.job.id),/submit outcome unknown/);
 assert.equal(f.publisher.job(f.workspace.id,f.job.id).state,'UNKNOWN');
 assert.throws(()=>f.executor.resolveNotPublished(f.workspace.id,f.job.id,{}),/用户明确/);
 const decision={confirm_not_published:true,snapshot_hash:f.job.snapshot_hash,authorization_source:'Explicit fixture user confirmation'};
 const finished=f.executor.resolveNotPublished(f.workspace.id,f.job.id,decision);
 assert.equal(finished.state,'CANCELLED');
 assert.equal(finished.evidence.humanResolution.outcome,'NOT_PUBLISHED');
 assert.equal(f.executor.permits.record(f.job.id).status,'CONSUMED');
 assert.equal(f.executor.profilePending(f.job.snapshot.profileId),false);
 assert.ok(f.store.db.prepare('SELECT 1 FROM publisher_submit_intents WHERE job_id=?').get(f.job.id));
 assert.equal(f.submits,1);
 assert.throws(()=>f.executor.resolveNotPublished(f.workspace.id,f.job.id,decision),/用户明确/);
});

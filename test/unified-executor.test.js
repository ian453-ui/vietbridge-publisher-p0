import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../src/store.js';
import {UnifiedPublisher} from '../src/unified-publisher.js';
import {UnifiedExecutor} from '../src/unified-executor.js';
import {BrowserResources} from '../src/browser-resources.js';
import {operatingDay} from '../src/operating-day.js';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';

function v1History(f){
 const path=join(f.root,'v1.sqlite'),events=join(f.root,'events.jsonl'),verified=join(f.root,'verified.jsonl'),yaml=join(f.root,'ledger.yaml');
 const db=new DatabaseSync(path);db.exec('CREATE TABLE jobs(job_id TEXT,article_id TEXT,platform TEXT,account_id TEXT,state TEXT,current_attempt_id TEXT,submitted_at TEXT,published_at TEXT,updated_at TEXT);CREATE TABLE facebook_accounts(id TEXT,page_id TEXT);CREATE TABLE platform_attempts(job_id TEXT,started_at TEXT);CREATE TABLE platform_receipts(job_id TEXT,raw_status TEXT);CREATE TABLE content_snapshots(article_id TEXT,canonical_payload_json TEXT)');db.close();
 writeFileSync(events,'');writeFileSync(verified,'');writeFileSync(yaml,'published_history: {}\n');
 return {kind:'V1',path,ledger_paths:{events:[events,verified],yaml}};
}

test('operating day changes at 07:00 Asia/Shanghai',()=>{
  assert.equal(operatingDay('2026-10-15T22:59:59.000Z'),'2026-10-15');
  assert.equal(operatingDay('2026-10-15T23:00:00.000Z'),'2026-10-16');
});

function setup(t){
  const root=mkdtempSync(join(tmpdir(),'vb-executor-')),store=new Store(join(root,'publisher.sqlite'),{seedDemo:false}),publisher=new UnifiedPublisher(store),workspace=store.saveWorkspace({name:'Client',content_root:root});
  t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
  const profile=store.saveProfile(workspace.id,{name:'Chrome',cdp_port:19981,user_data_dir:join(root,'chrome')}),account=publisher.saveAccount(workspace.id,{display_name:'Client Page',expected_identity:'Client Page',identity_type:'PAGE',external_id:'12345',operator_actor_id:'12345',target_page_id:'98765',profile_id:profile.id});
  const content=publisher.importContent(workspace.id,{source_id:'c1',revision:'r1',body:'Approved body',media:[]}),job=publisher.createPageJob(workspace.id,{account_id:account.id,content_id:content.id});
  let submits=0,readback=true,prepareFail=false,submitFail=false;
  const driver={async prepare(){if(prepareFail)throw Error('preflight failed');return {identityVerified:true};},async submit(){submits++;if(submitFail)throw Error('connection lost after click');return {id:'999',url:'https://www.facebook.com/12345/posts/999'};},async readback(snapshot){if(!readback)throw Error('missing independent readback');return {verified:true,id:'999',url:'https://www.facebook.com/12345/posts/999',pageId:snapshot.targetPageId,targetPageId:snapshot.targetPageId,operatorActorId:snapshot.operatorActorId,contentHash:snapshot.contentHash};},async close(){}};
  const executor=new UnifiedExecutor(publisher,{enabled:true,resources:new BrowserResources(join(root,'locks')),drivers:{create:async()=>driver},mediaRoots:[root],snapshotRoot:join(root,'snapshots')});
  return {root,store,publisher,executor,workspace,account,job,content,driver,get submits(){return submits;},set readback(x){readback=x;},set prepareFail(x){prepareFail=x;},set submitFail(x){submitFail=x;}};
}
test('execution persists immutable intent before one submit and requires independent evidence',async t=>{
  const f=setup(t);f.executor.approve(f.workspace.id,f.job.id,f.job.snapshot_hash);
  const old=f.driver.submit;f.driver.submit=async()=>{assert.equal(f.publisher.job(f.workspace.id,f.job.id).state,'SUBMITTING');assert.equal(f.store.db.prepare('SELECT count(*) n FROM publisher_submit_intents').get().n,1);return old();};
  const result=await f.executor.execute(f.workspace.id,f.job.id);assert.equal(result.state,'PUBLISHED');assert.equal(f.submits,1);
  await assert.rejects(()=>f.executor.execute(f.workspace.id,f.job.id));assert.equal(f.submits,1);
});
test('acceptance mode rejects execution before any external call',async t=>{const f=setup(t);f.executor.enabled=false;await assert.rejects(()=>f.executor.execute(f.workspace.id,f.job.id),/验收模式/);assert.equal(f.submits,0);assert.equal(f.publisher.job(f.workspace.id,f.job.id).state,'DRAFT');});
test('new Browser Page flow waits for quota reset and requires exact frozen UI confirmation',async t=>{
  const f=setup(t);f.executor.enabled=false;
  f.executor.pageExecution={accountId:f.account.id,newJobsAfter:Date.parse(f.job.created_at)-1,blockedOperatingDay:operatingDay(Date.now()),additionalHistory:[v1History(f)]};
  f.executor.approve(f.workspace.id,f.job.id,f.job.snapshot_hash);
  assert.match(f.executor.executionCapability(f.workspace.id,f.job.id).reason,/当前运营日 Page 发布额度已用完/);
  await assert.rejects(()=>f.executor.execute(f.workspace.id,f.job.id,{confirm:true,snapshot_hash:f.job.snapshot_hash}),/当前运营日 Page 发布额度已用完/);
  assert.equal(f.submits,0);
  f.executor.pageExecution.blockedOperatingDay='2026-10-14';
  assert.equal(f.executor.executionCapability(f.workspace.id,f.job.id).mode,'PAGE_INTERACTIVE');
  assert.throws(()=>f.executor.claim(f.workspace.id,f.job.id,{}),/确认当前冻结版本/);
  assert.equal(f.publisher.job(f.workspace.id,f.job.id).state,'READY');
  const result=await f.executor.execute(f.workspace.id,f.job.id,{confirm:true,snapshot_hash:f.job.snapshot_hash});
  assert.equal(result.state,'PUBLISHED');assert.equal(f.submits,1);
  await assert.rejects(()=>f.executor.execute(f.workspace.id,f.job.id,{confirm:true,snapshot_hash:f.job.snapshot_hash}));assert.equal(f.submits,1);
});
test('an audited pre-form overlay failure can reuse its original Page task while its history remains',t=>{
 const f=setup(t),source=v1History(f);f.executor.enabled=false;
 f.executor.pageExecution={accountId:f.account.id,newJobsAfter:Date.parse(f.job.created_at)-1,blockedOperatingDay:'2026-10-14',additionalHistory:[source]};
 f.executor.approve(f.workspace.id,f.job.id,f.job.snapshot_hash);
 const attempt='ac78bd65-9f5a-440a-ac80-6c26f53e53a1',at=new Date().toISOString();
 const error="locator.innerText: Error: strict mode violation: locator('body') resolved to 2 elements: browser-skill-overlay body";
 const recovery={version:1,errorCode:'BODY_SELECTOR_OVERLAY_STRICT',sourceBuild:'7686640800ed9cc99ee33f22681ea2dc738353ba',originalState:'UNKNOWN',originalStage:'PREPARING',originalAttemptId:attempt,snapshotHash:f.job.snapshot_hash,finalClickAttempted:false,formWriteReached:false,submissionIntent:false,at};
 f.store.db.prepare('INSERT INTO publisher_prepare_intents VALUES(?,?)').run(f.job.id,at);
 f.store.db.prepare('UPDATE publisher_jobs SET evidence_json=? WHERE id=?').run(JSON.stringify({error,pristinePreparationRecovery:recovery}),f.job.id);
 assert.equal(f.executor.executionCapability(f.workspace.id,f.job.id).canExecute,false,'an unlogged recovery cannot bypass history');
 f.store.event(f.workspace.id,'publisher_pristine_preparation_recovered',{job_id:f.job.id,original_attempt_id:attempt});
 assert.equal(f.executor.executionCapability(f.workspace.id,f.job.id).canExecute,true);
 f.store.db.prepare('UPDATE publisher_jobs SET evidence_json=? WHERE id=?').run(JSON.stringify({error,pristinePreparationRecovery:{...recovery,finalClickAttempted:true}}),f.job.id);
 assert.equal(f.executor.executionCapability(f.workspace.id,f.job.id).canExecute,false,'uncertain final click remains blocked');
 f.store.db.prepare('UPDATE publisher_jobs SET evidence_json=? WHERE id=?').run(JSON.stringify({error,pristinePreparationRecovery:recovery}),f.job.id);
 f.store.db.prepare('INSERT INTO publisher_submit_intents VALUES(?,?,?,?,?,?)').run(f.job.id,attempt,'BROWSER',f.job.snapshot_hash,'{}',at);
 assert.equal(f.executor.executionCapability(f.workspace.id,f.job.id).canExecute,false,'submit intent remains a hard blocker');
});
test('interactive Page setting cannot revive old READY jobs or exceed one local operating-day Page attempt',async t=>{
  const f=setup(t);f.executor.enabled=false;f.executor.approve(f.workspace.id,f.job.id,f.job.snapshot_hash);
  f.executor.pageExecution={accountId:f.account.id,newJobsAfter:Date.parse(f.job.created_at)+1,blockedOperatingDay:'2026-10-14',additionalHistory:[v1History(f)]};
  assert.match(f.executor.executionCapability(f.workspace.id,f.job.id).reason,/新建的浏览器 Page/);
  f.executor.pageExecution.newJobsAfter=Date.parse(f.job.created_at)-1;
  await f.executor.execute(f.workspace.id,f.job.id,{confirm:true,snapshot_hash:f.job.snapshot_hash});
  const content=f.publisher.importContent(f.workspace.id,{source_id:'another',revision:'r1',body:'Different approved Page body',media:[]});
  const second=f.publisher.createPageJob(f.workspace.id,{account_id:f.account.id,content_id:content.id});f.executor.approve(f.workspace.id,second.id,second.snapshot_hash);
  assert.match(f.executor.executionCapability(f.workspace.id,second.id).reason,/发布尝试/);
  await assert.rejects(()=>f.executor.execute(f.workspace.id,second.id,{confirm:true,snapshot_hash:second.snapshot_hash}),/发布尝试/);
  assert.equal(f.submits,1);
});
test('bounded Page rejects unresolved manual claim before any driver call',async t=>{
 const f=setup(t);f.executor.enabled=false;f.executor.pageExecution={accountId:f.account.id,newJobsAfter:Date.parse(f.job.created_at)-1,blockedOperatingDay:'2026-10-14',additionalHistory:[v1History(f)]};
 f.executor.approve(f.workspace.id,f.job.id,f.job.snapshot_hash);
 f.store.db.prepare("INSERT INTO records(kind,id,workspace,value) VALUES('manual_facebook_page_publication',?,?,?)").run('manual-claim',f.workspace.id,JSON.stringify({actor_id:f.account.operator_actor_id,business_page_id:f.account.target_page_id,body_sha256:'a'.repeat(64),state:'CLAIMED',created_at:new Date().toISOString()}));
 assert.equal(f.executor.executionCapability(f.workspace.id,f.job.id).canExecute,false);
 await assert.rejects(()=>f.executor.execute(f.workspace.id,f.job.id,{confirm:true,snapshot_hash:f.job.snapshot_hash}),/跨入口历史/);assert.equal(f.submits,0);
});
test('scoped archive of old manual claim releases different body but still blocks the original body',t=>{
 const f=setup(t);f.executor.enabled=false;f.executor.pageExecution={accountId:f.account.id,newJobsAfter:Date.parse(f.job.created_at)-1,blockedOperatingDay:'2026-10-14',additionalHistory:[v1History(f)]};
 f.executor.approve(f.workspace.id,f.job.id,f.job.snapshot_hash);
 const row={actor_id:f.account.operator_actor_id,business_page_id:f.account.target_page_id,body_sha256:'a'.repeat(64),content_id:'historical-content',state:'CLAIMED',created_at:'2026-10-13T20:05:51Z',publisher_job_id:null,publisher_execution_receipt:false};
 row.scoped_archive={version:1,scope:'ORIGINAL_CONTENT_ONLY',original_state:'CLAIMED',actor_id:row.actor_id,business_page_id:row.business_page_id,body_sha256:row.body_sha256,content_id:row.content_id,outcome:'UNRESOLVED',at:new Date().toISOString()};
 f.store.db.prepare("INSERT INTO records(kind,id,workspace,value) VALUES('manual_facebook_page_publication',?,?,?)").run('archived-claim',f.workspace.id,JSON.stringify(row));
 assert.equal(f.executor.executionCapability(f.workspace.id,f.job.id).canExecute,true);
 row.body_sha256=createHash('sha256').update(f.job.snapshot.body).digest('hex');row.scoped_archive.body_sha256=row.body_sha256;
 f.store.db.prepare("UPDATE records SET value=? WHERE kind='manual_facebook_page_publication' AND id='archived-claim'").run(JSON.stringify(row));
 assert.equal(f.executor.executionCapability(f.workspace.id,f.job.id).canExecute,false);
});
test('bounded Page rejects V1 same operating-day publication and missing history',async t=>{
 const f=setup(t),source=v1History(f);f.executor.enabled=false;f.executor.pageExecution={accountId:f.account.id,newJobsAfter:Date.parse(f.job.created_at)-1,blockedOperatingDay:'2026-10-14',additionalHistory:[source]};f.executor.approve(f.workspace.id,f.job.id,f.job.snapshot_hash);
 const db=new DatabaseSync(source.path);db.prepare('INSERT INTO facebook_accounts VALUES(?,?)').run('old-account',f.account.target_page_id);db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?,?)').run('old-v1','old-article','facebook','old-account','PUBLISHED','old-attempt',new Date().toISOString(),new Date().toISOString(),new Date().toISOString());db.prepare('INSERT INTO content_snapshots VALUES(?,?)').run('old-article',JSON.stringify({payloads:{facebook:{body:'Different body'}}}));db.close();
 assert.match(f.executor.executionCapability(f.workspace.id,f.job.id).reason,/发布尝试/);await assert.rejects(()=>f.executor.execute(f.workspace.id,f.job.id,{confirm:true,snapshot_hash:f.job.snapshot_hash}),/发布尝试/);assert.equal(f.submits,0);
 f.executor.pageExecution.additionalHistory=[];assert.match(f.executor.executionCapability(f.workspace.id,f.job.id).reason,/HISTORY_COVERAGE/);await assert.rejects(()=>f.executor.execute(f.workspace.id,f.job.id,{confirm:true,snapshot_hash:f.job.snapshot_hash}),/HISTORY_COVERAGE/);assert.equal(f.submits,0);
});
test('bounded Page counts manual claims across workspaces for the same actor and Page',async t=>{
 const f=setup(t);f.executor.enabled=false;f.executor.pageExecution={accountId:f.account.id,newJobsAfter:Date.parse(f.job.created_at)-1,blockedOperatingDay:'2026-10-14',additionalHistory:[v1History(f)]};f.executor.approve(f.workspace.id,f.job.id,f.job.snapshot_hash);
 const other=f.store.saveWorkspace({name:'Other client',content_root:f.root});f.store.db.prepare("INSERT INTO records(kind,id,workspace,value) VALUES('manual_facebook_page_publication',?,?,?)").run('cross-workspace',other.id,JSON.stringify({actor_id:f.account.operator_actor_id,business_page_id:f.account.target_page_id,body_sha256:'b'.repeat(64),state:'CLAIMED',created_at:new Date().toISOString()}));
 assert.match(f.executor.executionCapability(f.workspace.id,f.job.id).reason,/跨入口历史/);await assert.rejects(()=>f.executor.execute(f.workspace.id,f.job.id,{confirm:true,snapshot_hash:f.job.snapshot_hash}),/跨入口历史/);assert.equal(f.submits,0);
});
test('bounded Page counts external unified frozen identity after account metadata changes',async t=>{
 const f=setup(t),source=v1History(f),path=join(f.root,'other-unified.sqlite');f.executor.enabled=false;f.executor.pageExecution={accountId:f.account.id,newJobsAfter:Date.parse(f.job.created_at)-1,blockedOperatingDay:'2026-10-14',additionalHistory:[source,{kind:'UNIFIED',path}]};f.executor.approve(f.workspace.id,f.job.id,f.job.snapshot_hash);
 const db=new DatabaseSync(path);db.exec('CREATE TABLE facebook_accounts(id TEXT,workspace TEXT,operator_actor_id TEXT,external_id TEXT,target_page_id TEXT);CREATE TABLE publisher_jobs(id TEXT,workspace TEXT,account_id TEXT,state TEXT,attempt_id TEXT,snapshot_json TEXT,updated_at TEXT)');db.prepare('INSERT INTO facebook_accounts VALUES(?,?,?,?,?)').run('changed-account','another-workspace','99999','99999','88888');db.prepare('INSERT INTO publisher_jobs VALUES(?,?,?,?,?,?,?)').run('prior-unified','another-workspace','changed-account','PUBLISHED','prior-attempt',JSON.stringify({platform:'facebook',operatorActorId:f.account.operator_actor_id,targetPageId:f.account.target_page_id,body:'Earlier body'}),new Date().toISOString());db.close();
 assert.match(f.executor.executionCapability(f.workspace.id,f.job.id).reason,/发布尝试/);await assert.rejects(()=>f.executor.execute(f.workspace.id,f.job.id,{confirm:true,snapshot_hash:f.job.snapshot_hash}),/发布尝试/);assert.equal(f.submits,0);
});
test('bounded Page uses immutable cross-workspace preparation day after a later status update',t=>{
 const f=setup(t),source=v1History(f),path=join(f.root,'later-updated.sqlite');f.executor.enabled=false;f.executor.pageExecution={accountId:f.account.id,newJobsAfter:Date.parse(f.job.created_at)-1,blockedOperatingDay:'2026-10-14',additionalHistory:[source,{kind:'UNIFIED',path}]};f.executor.approve(f.workspace.id,f.job.id,f.job.snapshot_hash);
 const db=new DatabaseSync(path);db.exec('CREATE TABLE facebook_accounts(id TEXT,workspace TEXT,operator_actor_id TEXT,external_id TEXT,target_page_id TEXT);CREATE TABLE publisher_jobs(id TEXT,workspace TEXT,account_id TEXT,state TEXT,attempt_id TEXT,snapshot_json TEXT,updated_at TEXT);CREATE TABLE publisher_prepare_intents(job_id TEXT,created_at TEXT)');db.prepare('INSERT INTO facebook_accounts VALUES(?,?,?,?,?)').run('other-account','another-workspace','99999','99999','88888');db.prepare('INSERT INTO publisher_jobs VALUES(?,?,?,?,?,?,?)').run('old','another-workspace','other-account','PUBLISHED','prior-attempt',JSON.stringify({platform:'facebook',operatorActorId:f.account.operator_actor_id,targetPageId:f.account.target_page_id,body:'Other body'}),'2026-10-18T04:00:00.000Z');db.prepare('INSERT INTO publisher_prepare_intents VALUES(?,?)').run('old',new Date().toISOString());db.close();
 assert.match(f.executor.executionCapability(f.workspace.id,f.job.id).reason,/发布尝试/);assert.equal(f.submits,0);
});
test('unbound V1 mirror rows require a proven different Page, otherwise fail closed',async t=>{
 const f=setup(t),source=v1History(f);f.executor.enabled=false;f.executor.pageExecution={accountId:f.account.id,newJobsAfter:Date.parse(f.job.created_at)-1,blockedOperatingDay:'2026-10-14',additionalHistory:[source]};f.executor.approve(f.workspace.id,f.job.id,f.job.snapshot_hash);
 writeFileSync(source.ledger_paths.yaml,'published_history:\n  Other-Page:\n    facebook:\n      status: PUBLISHED\n      id: "111111_222222"\n      url: https://www.facebook.com/otherPage/posts/222222\n');assert.equal(f.executor.executionCapability(f.workspace.id,f.job.id).canExecute,true);
 writeFileSync(source.ledger_paths.yaml,`published_history:\n  Same-Page:\n    facebook:\n      status: PUBLISHED\n      id: "${f.account.target_page_id}_333333"\n      url: https://www.facebook.com/samePage/posts/333333\n`);assert.match(f.executor.executionCapability(f.workspace.id,f.job.id).reason,/LEDGER_SCOPE_AMBIGUOUS/);assert.equal(f.submits,0);
 writeFileSync(source.ledger_paths.yaml,'unrelated: {}\n');assert.match(f.executor.executionCapability(f.workspace.id,f.job.id).reason,/LEDGER_HISTORY_SHAPE_REQUIRED/);assert.equal(f.submits,0);
});
test('submit uncertainty retains durable lock and allows only readback, never resend',async t=>{
  const f=setup(t);f.executor.approve(f.workspace.id,f.job.id,f.job.snapshot_hash);f.submitFail=true;
  await assert.rejects(()=>f.executor.execute(f.workspace.id,f.job.id));assert.equal(f.publisher.job(f.workspace.id,f.job.id).state,'UNKNOWN');
  await assert.rejects(()=>f.executor.execute(f.workspace.id,f.job.id));assert.equal(f.submits,1);
  f.submitFail=false;const result=await f.executor.reconcile(f.workspace.id,f.job.id);assert.equal(result.state,'PUBLISHED');assert.equal(f.submits,1);
});
test('before-submit failure can return to review without inventing a successful publication',async t=>{
  const f=setup(t);f.executor.approve(f.workspace.id,f.job.id,f.job.snapshot_hash);f.prepareFail=true;
  await assert.rejects(()=>f.executor.execute(f.workspace.id,f.job.id));assert.equal(f.publisher.job(f.workspace.id,f.job.id).state,'BLOCKED');assert.equal(f.submits,0);
  assert.equal(f.executor.reopen(f.workspace.id,f.job.id).state,'DRAFT');
});
test('verified external manual Page work closes only its original pre-submit task without a synthetic submit intent',async t=>{
  const f=setup(t);f.executor.approve(f.workspace.id,f.job.id,f.job.snapshot_hash);f.prepareFail=true;
  await assert.rejects(()=>f.executor.execute(f.workspace.id,f.job.id));
  assert.equal(f.publisher.job(f.workspace.id,f.job.id).state,'BLOCKED');
  const url='https://www.facebook.com/12345/posts/999';
  f.publisher.manualComplete(f.workspace.id,f.job.id,{acknowledge:true,snapshot_hash:f.job.snapshot_hash,url});
  const result=await f.executor.reconcile(f.workspace.id,f.job.id,{platform_id:'999'});
  assert.equal(result.state,'PUBLISHED');assert.equal(result.evidence.externalManualVerified,true);
  assert.equal(result.evidence.humanConfirmation.previousState,'BLOCKED');assert.equal(result.evidence.preparationFailure.finalSubmitNotCalled,true);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM publisher_submit_intents WHERE job_id=?').get(f.job.id).n,0);
  assert.equal(f.submits,0);
});
test('pre-submit task cannot be completed by a mismatched or absent manual platform ID',async t=>{
  const f=setup(t);f.executor.approve(f.workspace.id,f.job.id,f.job.snapshot_hash);f.prepareFail=true;
  await assert.rejects(()=>f.executor.execute(f.workspace.id,f.job.id));
  await assert.rejects(()=>f.executor.reconcile(f.workspace.id,f.job.id,{platform_id:'999'}));
  f.publisher.manualComplete(f.workspace.id,f.job.id,{acknowledge:true,snapshot_hash:f.job.snapshot_hash,url:'https://www.facebook.com/12345/posts/888'});
  await assert.rejects(()=>f.executor.reconcile(f.workspace.id,f.job.id,{platform_id:'999'}),/作品 ID 与原人工确认不一致/);
  f.driver.readback=async s=>({verified:true,id:'888',url:'https://www.facebook.com/12345/posts/other',targetPageId:s.targetPageId,operatorActorId:s.operatorActorId,contentHash:s.contentHash});
  await assert.rejects(()=>f.executor.reconcile(f.workspace.id,f.job.id,{platform_id:'888'}),/未记录最终提交意图/);
  assert.equal(f.publisher.job(f.workspace.id,f.job.id).state,'UNKNOWN');assert.equal(f.submits,0);
});
test('bounded Page recovers the same proven pre-submit task with an audit event and no spent publication slot',async t=>{
  const f=setup(t);f.executor.enabled=false;
  f.executor.pageExecution={accountId:f.account.id,newJobsAfter:Date.parse(f.job.created_at)-1,blockedOperatingDay:'2026-10-14',additionalHistory:[v1History(f)]};
  f.executor.approve(f.workspace.id,f.job.id,f.job.snapshot_hash);f.prepareFail=true;
  await assert.rejects(()=>f.executor.execute(f.workspace.id,f.job.id,{confirm:true,snapshot_hash:f.job.snapshot_hash}),/preflight failed/);
  const failed=f.publisher.job(f.workspace.id,f.job.id),firstAttempt=failed.attempt_id;
  assert.equal(failed.state,'BLOCKED');assert.equal(f.submits,0);
  const otherContent=f.publisher.importContent(f.workspace.id,{source_id:'other',revision:'r1',body:'Different body',media:[]});
  const other=f.publisher.createPageJob(f.workspace.id,{account_id:f.account.id,content_id:otherContent.id});f.executor.approve(f.workspace.id,other.id,other.snapshot_hash);
  assert.equal(f.executor.executionCapability(f.workspace.id,other.id).canExecute,true,'a pristine failure does not spend Page quota');
  const reopened=f.executor.reopen(f.workspace.id,f.job.id);
  assert.equal(reopened.state,'DRAFT');assert.equal(reopened.attempt_id,null);
  assert.equal(reopened.evidence.preSubmissionRecovery.attemptId,firstAttempt);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM events WHERE event='publisher_pristine_pre_submit_recovered' AND json_extract(value,'$.attempt_id')=?").get(firstAttempt).n,1);
  f.prepareFail=false;f.executor.approve(f.workspace.id,f.job.id,f.job.snapshot_hash);
  assert.equal(f.executor.executionCapability(f.workspace.id,f.job.id).canExecute,true);
  const result=await f.executor.execute(f.workspace.id,f.job.id,{confirm:true,snapshot_hash:f.job.snapshot_hash});
  assert.equal(result.state,'PUBLISHED');assert.notEqual(result.attempt_id,firstAttempt);assert.equal(f.submits,1);
});
test('bounded Page refuses recovery when a prepare or submit trace appears after pre-submit failure',async t=>{
  const f=setup(t);f.executor.enabled=false;
  f.executor.pageExecution={accountId:f.account.id,newJobsAfter:Date.parse(f.job.created_at)-1,blockedOperatingDay:'2026-10-14',additionalHistory:[v1History(f)]};
  f.executor.approve(f.workspace.id,f.job.id,f.job.snapshot_hash);f.prepareFail=true;
  await assert.rejects(()=>f.executor.execute(f.workspace.id,f.job.id,{confirm:true,snapshot_hash:f.job.snapshot_hash}));
  f.store.db.prepare('INSERT INTO publisher_prepare_intents VALUES(?,?)').run(f.job.id,new Date().toISOString());
  assert.throws(()=>f.executor.reopen(f.workspace.id,f.job.id),/不能释放执行资格/);
  assert.equal(f.publisher.job(f.workspace.id,f.job.id).state,'BLOCKED');
});
test('retained prepared Page composer continues the original attempt once and requires readback',async t=>{
  const f=setup(t);f.executor.enabled=false;
  f.executor.pageExecution={accountId:f.account.id,newJobsAfter:Date.parse(f.job.created_at)-1,blockedOperatingDay:'2026-10-14',additionalHistory:[v1History(f)]};
  f.executor.approve(f.workspace.id,f.job.id,f.job.snapshot_hash);
  f.driver.prepare=async(_snapshot,_assets,onWrite)=>{onWrite();throw Error('MEDIA_COUNT_CHANGED');};
  f.driver.failureEvidence=()=>({phase:'READINESS',composerRetained:true,finalClickAttempted:false});
  await assert.rejects(()=>f.executor.execute(f.workspace.id,f.job.id,{confirm:true,snapshot_hash:f.job.snapshot_hash}),/MEDIA_COUNT_CHANGED/);
  const blocked=f.publisher.job(f.workspace.id,f.job.id),attempt=blocked.attempt_id;
  assert.equal(blocked.state,'BLOCKED');assert.equal(f.submits,0);
  f.driver.adoptPrepared=async()=>({retainedComposer:true,mediaCount:0});
  assert.equal((await f.executor.resumePrepared(f.workspace.id,f.job.id,{confirm:true,attempt_id:attempt,snapshot_hash:f.job.snapshot_hash})).state,'PUBLISHED');
  assert.equal(f.publisher.job(f.workspace.id,f.job.id).attempt_id,attempt);assert.equal(f.submits,1);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM events WHERE event='publisher_retained_composer_submitting' AND json_extract(value,'$.attempt_id')=?").get(attempt).n,1);
  await assert.rejects(()=>f.executor.resumePrepared(f.workspace.id,f.job.id,{confirm:true,attempt_id:attempt,snapshot_hash:f.job.snapshot_hash}));assert.equal(f.submits,1);
});
test('retained composer cannot continue if final click may have happened',async t=>{
  const f=setup(t);f.executor.enabled=false;
  f.executor.pageExecution={accountId:f.account.id,newJobsAfter:Date.parse(f.job.created_at)-1,blockedOperatingDay:'2026-10-14',additionalHistory:[v1History(f)]};
  f.executor.approve(f.workspace.id,f.job.id,f.job.snapshot_hash);
  f.driver.prepare=async(_snapshot,_assets,onWrite)=>{onWrite();throw Error('MEDIA_COUNT_CHANGED');};
  f.driver.failureEvidence=()=>({phase:'READINESS',composerRetained:true,finalClickAttempted:true});
  await assert.rejects(()=>f.executor.execute(f.workspace.id,f.job.id,{confirm:true,snapshot_hash:f.job.snapshot_hash}));
  const blocked=f.publisher.job(f.workspace.id,f.job.id);
  await assert.rejects(()=>f.executor.resumePrepared(f.workspace.id,f.job.id,{confirm:true,attempt_id:blocked.attempt_id,snapshot_hash:f.job.snapshot_hash}),/确定准备阶段证据/);
  assert.equal(f.submits,0);assert.equal(f.publisher.job(f.workspace.id,f.job.id).state,'BLOCKED');
});
test('a retained composer stays eligible after a no-click readiness trial failure on the same attempt',async t=>{
  const f=setup(t);f.executor.enabled=false;
  f.executor.pageExecution={accountId:f.account.id,newJobsAfter:Date.parse(f.job.created_at)-1,blockedOperatingDay:'2026-10-14',additionalHistory:[v1History(f)]};
  f.executor.approve(f.workspace.id,f.job.id,f.job.snapshot_hash);
  f.driver.prepare=async(_snapshot,_assets,onWrite)=>{onWrite();throw Error('MEDIA_COUNT_CHANGED');};
  f.driver.failureEvidence=()=>({phase:'READINESS',composerRetained:true,finalClickAttempted:false});
  await assert.rejects(()=>f.executor.execute(f.workspace.id,f.job.id,{confirm:true,snapshot_hash:f.job.snapshot_hash}));
  const attempt=f.publisher.job(f.workspace.id,f.job.id).attempt_id,input={confirm:true,attempt_id:attempt,snapshot_hash:f.job.snapshot_hash};
  f.driver.adoptPrepared=async()=>{throw Error('PUBLISH_BUTTON_SCROLL_FAILED');};
  await assert.rejects(()=>f.executor.resumePrepared(f.workspace.id,f.job.id,input),/PUBLISH_BUTTON_SCROLL_FAILED/);
  assert.equal(f.executor.canResumePrepared(f.publisher.job(f.workspace.id,f.job.id)),true);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM publisher_submit_intents WHERE job_id=?').get(f.job.id).n,0);
  f.driver.adoptPrepared=async()=>({retainedComposer:true});
  assert.equal((await f.executor.resumePrepared(f.workspace.id,f.job.id,input)).state,'PUBLISHED');
  assert.equal(f.submits,1);assert.equal(f.publisher.job(f.workspace.id,f.job.id).attempt_id,attempt);
});
test('preparing failures after a durable prepare intent release the profile but retain media side effects for review',async t=>{
 for(const reason of ['strict mode: browser-skill-overlay body','approved media upload failed','connection lost before submit','preparation timeout']){
  const f=setup(t);f.executor.approve(f.workspace.id,f.job.id,f.job.snapshot_hash);
  f.driver.prepare=async(_snapshot,_assets,onWrite)=>{onWrite();throw Error(reason);};
  await assert.rejects(()=>f.executor.execute(f.workspace.id,f.job.id),new RegExp(reason));
  const job=f.publisher.job(f.workspace.id,f.job.id);
  assert.equal(job.state,'BLOCKED');assert.equal(job.evidence.stage,'PREPARING');
  assert.equal(job.evidence.submissionIntent,false);assert.equal(job.evidence.submitCallMayHaveStarted,false);
  assert.equal(job.evidence.preparationFailure.finalSubmitNotCalled,true);
  assert.equal(job.evidence.preparationEffectsMayRemain,true);
  assert.equal(f.submits,0);assert.equal(f.executor.profilePending(f.account.profile_id),false);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM publisher_submit_intents WHERE job_id=?').get(f.job.id).n,0);
  assert.throws(()=>f.executor.reopen(f.workspace.id,f.job.id),/准备副作用/);
 }
});
test('shutdown recovery separates PREPARING without submit intent from SUBMITTING uncertainty',t=>{
 const pre=setup(t);pre.executor.approve(pre.workspace.id,pre.job.id,pre.job.snapshot_hash);
 pre.store.db.prepare("UPDATE publisher_jobs SET state='PREPARING',attempt_id='pre-attempt' WHERE id=?").run(pre.job.id);
 pre.store.db.prepare('INSERT INTO publisher_prepare_intents VALUES(?,?)').run(pre.job.id,new Date().toISOString());
 assert.equal(pre.publisher.recoverAfterShutdown(),1);
 const blocked=pre.publisher.job(pre.workspace.id,pre.job.id);
 assert.equal(blocked.state,'BLOCKED');assert.equal(blocked.evidence.preparationFailure.finalSubmitNotCalled,true);
 assert.equal(blocked.evidence.preparationEffectsMayRemain,true);
 const post=setup(t);post.executor.approve(post.workspace.id,post.job.id,post.job.snapshot_hash);
 post.store.db.prepare("UPDATE publisher_jobs SET state='SUBMITTING',attempt_id='post-attempt' WHERE id=?").run(post.job.id);
 post.store.db.prepare('INSERT INTO publisher_submit_intents VALUES(?,?,?,?,?,?)').run(post.job.id,'post-attempt','BROWSER',post.job.snapshot_hash,'{}',new Date().toISOString());
 assert.equal(post.publisher.recoverAfterShutdown(),1);
 const unknown=post.publisher.job(post.workspace.id,post.job.id);
 assert.equal(unknown.state,'UNKNOWN');assert.equal(unknown.evidence.submitCallMayHaveStarted,true);
});
test('finishing a proven pre-submit UNKNOWN preserves UNKNOWN and releases only its profile hold',t=>{
 const f=setup(t);f.executor.approve(f.workspace.id,f.job.id,f.job.snapshot_hash);
 f.store.db.prepare("UPDATE publisher_jobs SET state='UNKNOWN',attempt_id='pre-attempt',evidence_json=? WHERE id=?").run(JSON.stringify({stage:'PREPARING',submissionIntent:false,error:'selector failed',browserDiagnostics:{composerRetained:true,finalClickAttempted:false}}),f.job.id);
 const ended=f.publisher.finish(f.workspace.id,f.job.id);
 assert.equal(ended.state,'UNKNOWN');assert.equal(ended.evidence.operatorFinished,true);
 assert.equal(ended.evidence.preSubmissionVerified,true);assert.equal(f.executor.profilePending(f.account.profile_id),false);
 const ambiguous=setup(t);ambiguous.executor.approve(ambiguous.workspace.id,ambiguous.job.id,ambiguous.job.snapshot_hash);
 ambiguous.store.db.prepare("UPDATE publisher_jobs SET state='UNKNOWN',attempt_id='ambiguous-attempt',evidence_json=? WHERE id=?").run(JSON.stringify({stage:'PREPARING',submissionIntent:false,browserDiagnostics:{composerRetained:true}}),ambiguous.job.id);
 const ambiguousEnded=ambiguous.publisher.finish(ambiguous.workspace.id,ambiguous.job.id);
 assert.equal(ambiguousEnded.state,'UNKNOWN');assert.equal(ambiguousEnded.evidence.operatorFinished,true);
 assert.equal(ambiguousEnded.evidence.preSubmissionVerified,undefined);assert.equal(ambiguous.executor.profilePending(ambiguous.account.profile_id),true);
 const g=setup(t);g.executor.approve(g.workspace.id,g.job.id,g.job.snapshot_hash);
 g.store.db.prepare("UPDATE publisher_jobs SET state='UNKNOWN',attempt_id='post-attempt',evidence_json=? WHERE id=?").run(JSON.stringify({stage:'SUBMITTING',submissionIntent:true,browserDiagnostics:{finalClickAttempted:true}}),g.job.id);
 const unresolved=g.publisher.finish(g.workspace.id,g.job.id);
 assert.equal(unresolved.state,'UNKNOWN');assert.equal(g.executor.profilePending(g.account.profile_id),true);
});
test('wrong identity or body evidence cannot finish an uncertain task',async t=>{
  const f=setup(t);f.executor.approve(f.workspace.id,f.job.id,f.job.snapshot_hash);f.readback=false;await assert.rejects(()=>f.executor.execute(f.workspace.id,f.job.id));
  assert.throws(()=>f.executor.complete(f.workspace.id,f.job.id,{verified:true,id:'999',pageId:'different',contentHash:f.job.snapshot.contentHash}),/完整/);assert.equal(f.publisher.job(f.workspace.id,f.job.id).state,'UNKNOWN');
});
test('approved media is copied and checked independently from changing source files',async t=>{
  const f=setup(t),path=join(f.root,'cover.png');writeFileSync(path,Buffer.from([137,80,78,71,13,10,26,10,0,1]));
  const content=f.publisher.importContent(f.workspace.id,{source_id:'image',revision:'r1',body:'Image body',media:[path]}),job=f.publisher.createPageJob(f.workspace.id,{account_id:f.account.id,content_id:content.id});
  f.executor.approve(f.workspace.id,job.id,job.snapshot_hash);writeFileSync(path,'changed source');
  const asset=f.store.db.prepare('SELECT * FROM publisher_job_assets WHERE job_id=?').get(job.id);assert.notEqual(asset.path,path);
  writeFileSync(asset.path,'tampered snapshot');await assert.rejects(()=>f.executor.execute(f.workspace.id,job.id),/媒体/);assert.equal(f.submits,0);
});

import {createHash} from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,mkdirSync,readFileSync,existsSync,realpathSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.js';
import {UnifiedPublisher} from '../src/unified-publisher.js';
import {UnifiedExecutor} from '../src/unified-executor.js';
import {PublisherDiagnostics} from '../src/publisher-diagnostics.js';
import {BrowserResources} from '../src/browser-resources.js';
import {executionScope} from '../src/single-execution-permit.js';
import {unifiedRoute} from '../src/unified-http.js';
function fixture(t){
  const root=mkdtempSync(join(tmpdir(),'vb-diagnostics-')),store=new Store(join(root,'publisher-unified.sqlite'),{seedDemo:false}),publisher=new UnifiedPublisher(store);t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
  const ws=store.saveWorkspace({name:'LP'}),profile=store.saveProfile(ws.id,{name:'LP',cdp_port:17921,user_data_dir:join(root,'profile')}),account=publisher.saveAccount(ws.id,{display_name:'LP',expected_identity:'LP',identity_type:'PAGE',external_id:'61594159443807',operator_actor_id:'61594159443807',target_page_id:'1459220443931651',profile_id:profile.id}),content=publisher.importContent(ws.id,{source_id:'fixture',revision:'1',body:'Approved',media:[]}),job=publisher.createPageJob(ws.id,{account_id:account.id,content_id:content.id});
  let calls=0,wait,fail=false;
  const driver={async diagnose(snapshot,progress){calls++;assert.equal(snapshot.cdpPort,17921);progress({stage:'SCENE_SAVED',absenceProven:false});if(wait)await wait;if(fail)throw Error('identity blocked');return {conclusion:'INCOMPLETE',absenceProven:false,errors:[]};},async close(){},prepare(){throw Error('prepare forbidden');},submit(){throw Error('submit forbidden');},readback(){throw Error('complete readback forbidden');}};
  const executor=new UnifiedExecutor(publisher,{enabled:false,resources:new BrowserResources(join(root,'locks')),drivers:{create:async()=>driver},snapshotRoot:join(root,'media')});executor.approve(ws.id,job.id,job.snapshot_hash);executor.permits.issue(ws.id,job.id,executionScope(job),{expiresAt:Date.now()+60000,authorization:{task_id:'task',approval_thread_id:'thread',approval_message_id:'approval'}});executor.claim(ws.id,job.id);
  store.db.prepare("UPDATE publisher_jobs SET state='UNKNOWN' WHERE id=?").run(job.id);store.db.prepare('INSERT INTO publisher_prepare_intents VALUES(?,?)').run(job.id,'original-time');store.db.prepare('INSERT INTO publisher_submit_intents VALUES(?,?,?,?,?,?)').run(job.id,publisher.job(ws.id,job.id).attempt_id,'BROWSER',job.snapshot_hash,'{}','original-submit-time');
  mkdirSync(profile.user_data_dir,{recursive:true});const release=executor.acquireResources(publisher.job(ws.id,job.id).snapshot);release();
  driver.observeComposer=driver.diagnose;const diagnostic=new PublisherDiagnostics(executor,{composerObservation:true,observationBudgetMs:25,cleanupBudgetMs:10});executor.composerObservations=diagnostic;executor.diagnostics=new PublisherDiagnostics(executor);
  const leaseFile=join(root,'locks',createHash('sha256').update(realpathSync(profile.user_data_dir)).digest('hex'),'owner.json');
  const history=()=>JSON.stringify(['publisher_jobs','publisher_execution_permits','publisher_execution_permit_events','publisher_prepare_intents','publisher_submit_intents','publisher_submit_receipts','publisher_job_assets'].map(table=>store.db.prepare(`SELECT * FROM ${table}`).all()));
  return {store,publisher,ws,job,executor,diagnostic,history,leaseFile,driver,profile,get calls(){return calls;},set wait(v){wait=v;},set fail(v){fail=v;}};
}

const input=f=>({...executionScope(f.job),profile_id:f.profile.id});
test('exact scope observes once, retains original lease bytes/seven-table history and isolates publication reports',async t=>{
 const f=fixture(t),before=f.history(),lease=readFileSync(f.leaseFile,'utf8');let release;f.wait=new Promise(r=>release=r);
 const url=new URL(`http://localhost/api/unified/workspaces/${f.ws.id}/jobs/${f.job.id}/composer-observation`),r=unifiedRoute(f.publisher,'POST',url,input(f),f.executor);assert.equal(r.status,202);assert.equal(r.body.state,'RUNNING');assert.equal(f.diagnostic.start(f.ws.id,f.job.id,input(f)).id,r.body.id);assert.throws(()=>f.executor.diagnostics.start(f.ws.id,f.job.id,{snapshot_hash:f.job.snapshot_hash}));release();await Promise.all(f.diagnostic.running.values());assert.equal(f.calls,1);assert.equal(f.history(),before);assert.equal(readFileSync(f.leaseFile,'utf8'),lease);assert.equal(existsSync(join(f.leaseFile,'..','readback')),false);assert.equal(f.executor.active.size,0);assert.equal(f.executor.diagnostics.view(f.ws.id,f.job.id).state,'NOT_STARTED');assert.equal(unifiedRoute(f.publisher,'GET',url,{},f.executor).body.state,'DONE');f.diagnostic.start(f.ws.id,f.job.id,input(f));assert.equal(f.calls,1);
});
test('wrong scope, actor/target/profile/hash and missing pending lease block before connection',async t=>{
 const f=fixture(t),before=f.history();for(const key of ['job_id','workspace','content_id','account_id','operator_actor_id','target_page_id','profile_id','platform','transport','snapshot_hash','media_count'])assert.throws(()=>f.diagnostic.start(f.ws.id,f.job.id,{...input(f),[key]:'wrong'}));assert.equal(f.calls,0);assert.equal(f.history(),before);rmSync(join(f.leaseFile,'..'),{recursive:true});assert.throws(()=>f.diagnostic.start(f.ws.id,f.job.id,input(f)),/LEASE_REQUIRED/);assert.equal(f.calls,0);
});
test('hang remains bounded and retains readback/active ownership; late progress cannot overwrite DONE',async t=>{
 const f=fixture(t),before=f.history(),lease=readFileSync(f.leaseFile,'utf8');let late;f.driver.observeComposer=async(s,progress)=>{late=progress;return new Promise(()=>{});};f.diagnostic.start(f.ws.id,f.job.id,input(f));await Promise.all(f.diagnostic.running.values());const r=f.diagnostic.view(f.ws.id,f.job.id);assert.equal(r.state,'DONE');assert.equal(r.result.leaseRetained,true);assert.equal(f.executor.active.has(f.profile.id),true);assert.equal(existsSync(join(f.leaseFile,'..','readback')),true);assert.equal(readFileSync(f.leaseFile,'utf8'),lease);late({private:'must not persist'});assert.deepEqual(f.diagnostic.view(f.ws.id,f.job.id),r);assert.equal(f.history(),before);
});
test('disconnect failure retains ownership and restart recovery touches only observation records',async t=>{
 const f=fixture(t),before=f.history();f.driver.close=async()=>{throw Error('private token error');};f.diagnostic.start(f.ws.id,f.job.id,input(f));await Promise.all(f.diagnostic.running.values());assert.equal(f.diagnostic.view(f.ws.id,f.job.id).result.leaseRetained,true);assert.equal(f.executor.active.has(f.profile.id),true);assert.equal(JSON.stringify(f.diagnostic.view(f.ws.id,f.job.id)).includes('private token'),false);f.diagnostic.recover();assert.equal(f.history(),before);
});

test('ACTIVE/wrong owner/readback conflict and changed account mapping cannot acquire or connect',async t=>{
 const f=fixture(t),before=f.history(),bytes=readFileSync(f.leaseFile,'utf8');for(const patch of [{phase:'ACTIVE'},{owner:'operator:someone-else'}]){writeFileSync(f.leaseFile,JSON.stringify({...JSON.parse(bytes),...patch}));assert.throws(()=>f.diagnostic.start(f.ws.id,f.job.id,input(f)),/OWNER_OR_LEASE_BUSY/);assert.equal(f.calls,0);}writeFileSync(f.leaseFile,bytes);mkdirSync(join(f.leaseFile,'..','readback'));assert.throws(()=>f.diagnostic.start(f.ws.id,f.job.id,input(f)),/OWNER_OR_LEASE_BUSY/);rmSync(join(f.leaseFile,'..','readback'),{recursive:true});assert.equal(f.history(),before);assert.equal(readFileSync(f.leaseFile,'utf8'),bytes);
 f.store.db.prepare('UPDATE facebook_accounts SET external_id=? WHERE id=?').run('other',f.job.account_id);assert.throws(()=>f.diagnostic.start(f.ws.id,f.job.id,input(f)));assert.equal(f.calls,0);
});

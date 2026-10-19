import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
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
  const diagnostic=new PublisherDiagnostics(executor);executor.diagnostics=diagnostic;
  const history=()=>JSON.stringify(['publisher_jobs','publisher_execution_permits','publisher_execution_permit_events','publisher_prepare_intents','publisher_submit_intents','publisher_submit_receipts'].map(table=>store.db.prepare(`SELECT * FROM ${table}`).all()));
  return {store,publisher,ws,job,executor,diagnostic,history,get calls(){return calls;},set wait(v){wait=v;},set fail(v){fail=v;}};
}
test('exact original UNKNOWN scope starts one read-only run, preserves every historical record and serves persistent progress',async t=>{
  const f=fixture(t),before=f.history();let release;f.wait=new Promise(r=>release=r);const url=new URL(`http://localhost/api/unified/workspaces/${f.ws.id}/jobs/${f.job.id}/diagnostics`),response=unifiedRoute(f.publisher,'POST',url,{snapshot_hash:f.job.snapshot_hash},f.executor);assert.equal(response.status,202);assert.equal(response.body.state,'RUNNING');assert.deepEqual(response.body.scope,executionScope(f.job));assert.throws(()=>f.diagnostic.start(f.ws.id,f.job.id,{snapshot_hash:f.job.snapshot_hash}),/正在进行/);release();await Promise.all([...f.diagnostic.running.values()]);assert.equal(f.calls,1);assert.equal(f.history(),before);const read=unifiedRoute(f.publisher,'GET',url,{},f.executor);assert.equal(read.body.state,'DONE');assert.equal(read.body.result.conclusion,'INCOMPLETE');assert.equal(f.executor.enabled,false);
});
test('wrong hash/customer/state fail closed before any platform connection; errors are diagnostic-only',async t=>{
  const f=fixture(t),before=f.history();assert.throws(()=>f.diagnostic.start(f.ws.id,f.job.id,{snapshot_hash:'wrong'}));assert.throws(()=>f.diagnostic.start('wrong',f.job.id,{snapshot_hash:f.job.snapshot_hash}));assert.equal(f.calls,0);f.fail=true;f.diagnostic.start(f.ws.id,f.job.id,{snapshot_hash:f.job.snapshot_hash});await Promise.all([...f.diagnostic.running.values()]);assert.equal(f.diagnostic.view(f.ws.id,f.job.id).result.conclusion,'BLOCKED');assert.equal(f.history(),before);assert.equal(f.diagnostic.view(f.ws.id,f.job.id).result.errors[0].error,'identity blocked');
});
test('startup recovery affects only interrupted diagnostic rows, never UNKNOWN/CONSUMED history',async t=>{
  const f=fixture(t),before=f.history(),at=new Date().toISOString();f.store.db.prepare("INSERT INTO publisher_diagnostic_runs VALUES('interrupted',?,?,?,'RUNNING','{}',?,?)").run(f.job.id,f.ws.id,JSON.stringify(executionScope(f.job)),at,at);f.diagnostic.recover();assert.equal(f.diagnostic.view(f.ws.id,f.job.id).result.conclusion,'INCOMPLETE');assert.equal(f.history(),before);
});

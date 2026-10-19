import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {createApp} from '../src/server.js';
import {Store} from '../src/store.js';
import {UnifiedPublisher} from '../src/unified-publisher.js';
import {SingleExecutionPermits,executionScope} from '../src/single-execution-permit.js';

test('authenticated per-job capability coexists with disabled global publishing and interaction endpoints',async()=>{
  const root=mkdtempSync(join(tmpdir(),'vb-single-http-')),path=join(root,'publisher-unified.sqlite');
  const cloud={mode:'mac-tunnel',executionConnected:true,host:'publisher.vietbridge.one',origin:'https://publisher.vietbridge.one',user:'test',password:'test-disposable-password',dataDir:root,accessFile:join(root,'publisher-access.json')};
  let creates=0,submits=0;
  const drivers={create:async s=>{creates++;return {async prepare(snapshot,assets,before){before();return {};},async submit(){submits++;return {id:'mock-post'};},async readback(){return {verified:true,id:'mock-post',targetPageId:s.targetPageId,operatorActorId:s.operatorActorId,contentHash:s.contentHash};},async close(){}};}};
  const server=createApp(path,{unified:true,cloud,drivers,library:{roots:[root]},executionEnabled:false});
  const auth={authorization:'Basic '+Buffer.from(cloud.user+':'+cloud.password).toString('base64')};
  async function request(url,body,headers=auth){
    const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);Object.assign(req,{url,method:body===undefined?'GET':'POST',headers:{host:cloud.host,...headers}});
    let status=200,text='';const res={setHeader(){},writeHead(code){status=code;},end(value=''){text+=value;}};
    await server.listeners('request')[0](req,res);return {status,data:JSON.parse(text)};
  }
  let reader;
  try {
    const state=(await request('/api/state')).data,headers={...auth,origin:cloud.origin,'content-type':'application/json','x-local-token':state.token};
    const ws=(await request('/api/workspaces',{name:'LP',content_root:root},headers)).data;
    const profile=(await request(`/api/workspaces/${ws.id}/profiles`,{name:'LP Browser',cdp_port:19853,user_data_dir:join(root,'chrome')},headers)).data;
    const account=(await request(`/api/workspaces/${ws.id}/accounts`,{display_name:'LP',expected_identity:'LP',identity_type:'PAGE',external_id:'61594159443807',operator_actor_id:'61594159443807',target_page_id:'1459220443931651',profile_id:profile.id},headers)).data;
    const base=`/api/unified/workspaces/${ws.id}`,content=(await request(base+'/content',{source_id:'LP-promotion',revision:'1',body:'Approved promotion',media:[]},headers)).data;
    const job=(await request(base+'/jobs',{account_id:account.id,content_id:content.id},headers)).data;
    await request(base+`/jobs/${job.id}/approve`,{snapshot_hash:job.snapshot_hash},headers);
    reader=new Store(path,{seedDemo:false});const publisher=new UnifiedPublisher(reader),permits=new SingleExecutionPermits(publisher);
    permits.issue(ws.id,job.id,executionScope(job),{expiresAt:Date.now()+60000,authorization:{task_id:'test',approval_thread_id:'user-thread',approval_message_id:'user-message'}});
    const exact=base+`/jobs/${job.id}/execution-capability`;
    assert.equal((await request(exact,undefined,{})).status,401);
    assert.equal((await request(exact)).data.canExecute,true);
    assert.deepEqual((await request(exact)).data.scope,executionScope(job));
    assert.equal((await request(exact)).data.state,'READY');assert.equal((await request(exact)).data.attemptId,null);
    assert.equal((await request(base+'/jobs')).data.jobs[0].canExecute,true);
    const capabilities=(await request('/api/automation/capabilities')).data;
    assert.equal(capabilities.scoped_execution.global_execution_enabled,false);assert.equal(capabilities.operations.submit_platform_task.supported,false);assert.equal(capabilities.operations.submit_to_facebook.supported,false);
    assert.equal((await request('/api/health')).data.executionEnabled,false);assert.equal((await request('/api/health')).data.scanSchedulerEnabled,false);
    const otherContent=(await request(base+'/content',{source_id:'Other',revision:'1',body:'Other unapproved content',media:[]},headers)).data;
    const otherJob=(await request(base+'/jobs',{account_id:account.id,content_id:otherContent.id},headers)).data;
    await request(base+`/jobs/${otherJob.id}/approve`,{snapshot_hash:otherJob.snapshot_hash},headers);
    assert.equal((await request(base+`/jobs/${otherJob.id}/execution-capability`)).data.canExecute,false);
    assert.equal((await request(base+`/jobs/${otherJob.id}/execute`,{},headers)).status,409);
    for(const suffix of ['/group-jobs/auto-publish','/group-jobs/test/prepare','/engagement/candidates/test/reserve','/proactive/posts/test/execute'])
      assert.equal((await request(`/api/workspaces/${ws.id}`+suffix,{},headers)).status,409);
    const execute=base+`/jobs/${job.id}/execute`;
    assert.equal((await request(execute,{},auth)).status,409);
    assert.equal((await request(execute,{},{...headers,origin:'https://evil.example'})).status,409);
    const token=(await request('/api/access/tokens',{name:'Read-only app',password:cloud.password,workspaces:[ws.id],scopes:['jobs:read'],days:1},headers)).data.token;
    assert.equal((await request(execute,{},{authorization:'Bearer '+token,'content-type':'application/json'})).status,403);
    assert.equal(creates,0);assert.equal(permits.record(job.id).status,'AVAILABLE');
    // There is deliberately no HTTP route to grant or renew a permit.
    assert.equal((await request(base+`/jobs/${job.id}/execution-permit`,{},headers)).status,404);
    const result=await request(execute,{},headers);assert.equal(result.status,200);assert.equal(result.data.state,'PUBLISHED');assert.equal(submits,1);
    assert.equal((await request(exact)).data.canExecute,false);assert.equal((await request(exact)).data.permitStatus,'CONSUMED');
    assert.equal((await request(execute,{},headers)).status,409);assert.equal(creates,1);assert.equal(submits,1);
    // Diagnostic authorization is independently guarded and never re-executes the historical task.
    reader.db.prepare("UPDATE publisher_jobs SET state='UNKNOWN' WHERE id=?").run(job.id);
    const historical=JSON.stringify(reader.db.prepare('SELECT * FROM publisher_jobs WHERE id=?').get(job.id)),diag=base+`/jobs/${job.id}/diagnostics`;
    assert.equal((await request(diag,undefined,{})).status,401);assert.equal((await request(diag,{snapshot_hash:job.snapshot_hash},auth)).status,409);
    assert.equal((await request(diag,{snapshot_hash:job.snapshot_hash},{...headers,origin:'https://evil.example'})).status,409);
    assert.equal((await request(diag,undefined,{authorization:'Bearer '+token})).status,403);
    assert.equal((await request(diag,{snapshot_hash:'wrong'},headers)).status,409);
    assert.equal((await request(diag,{snapshot_hash:job.snapshot_hash},headers)).status,202);
    let diagnostic;for(let i=0;i<20;i++){diagnostic=(await request(diag)).data;if(diagnostic.state==='DONE')break;}
    assert.equal(diagnostic.state,'DONE');assert.equal(diagnostic.result.conclusion,'BLOCKED'); // mock has no diagnose method
    assert.equal(JSON.stringify(reader.db.prepare('SELECT * FROM publisher_jobs WHERE id=?').get(job.id)),historical);assert.equal(submits,1);
  } finally {reader?.close();server.emit('close');rmSync(root,{recursive:true,force:true});}
});

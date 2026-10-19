import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Readable} from 'node:stream';
import {createApp} from '../src/server.js';

test('unified production handler preserves auth and CSRF and creates scoped native tasks without V1 binding',async()=>{
  const root=mkdtempSync(join(tmpdir(),'vb-unified-handler-'));
  const cloud={mode:'mac-tunnel',executionConnected:true,host:'publisher.vietbridge.one',origin:'https://publisher.vietbridge.one',user:'fixture',password:'disposable-test-password-not-a-credential',dataDir:root};
  const server=createApp(join(root,'publisher-unified.sqlite'),{unified:true,cloud});
  const auth={authorization:'Basic '+Buffer.from(cloud.user+':'+cloud.password).toString('base64')};
  async function request(path,body,headers=auth) {
    const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);
    Object.assign(req,{url:path,method:body===undefined?'GET':'POST',headers:{host:cloud.host,...headers}});
    let status=200,text='';const res={setHeader(){},writeHead(code){status=code;},end(value=''){text+=value;}};
    await server.listeners('request')[0](req,res);
    return {status,text,json:()=>JSON.parse(text)};
  }
  try {
    assert.equal((await request('/api/state',undefined,{})).status,401);
    assert.equal((await request('/api/state',undefined,{...auth,host:'wrong.example'})).status,409);
    const state=(await request('/api/state')).json();assert.equal(state.unified,true);assert.deepEqual(state.workspaces,[]);
    assert.equal((await request('/api/health',undefined,{})).status,401);
    const health=(await request('/api/health')).json();assert.equal(health.version,'2.3.0-alpha.2');assert.equal(health.mode,'publisher-unified');assert.equal(health.executionEnabled,false);
    assert.equal((await request('/api/automation/capabilities',undefined,{})).status,401);
    const capability=(await request('/api/automation/capabilities')).json();
    assert.equal(capability.transport,'AUTHENTICATED_BROWSER_UI');
    assert.equal(capability.operations.submit_to_facebook.supported,false);
    assert.deepEqual(capability.operations.select_publish_transport.values,['API','BROWSER']);
    const headers={...auth,origin:cloud.origin,'content-type':'application/json','x-local-token':state.token};
    assert.equal((await request('/api/workspaces',{name:'LP'},auth)).status,409);
    const workspace=(await request('/api/workspaces',{name:'LP'},headers)).json();
    const base=`/api/workspaces/${workspace.id}`;
    const profile=(await request(base+'/profiles',{name:'LP Chrome',cdp_port:19221,user_data_dir:join(root,'chrome')},headers)).json();
    const account=(await request(base+'/accounts',{display_name:'LP Page',identity_type:'PAGE',external_id:'10011',operator_actor_id:'10011',target_page_id:'20022',profile_id:profile.id},headers)).json();
    assert.equal(account.execution_transport,'BROWSER');
    const unified=`/api/unified/workspaces/${workspace.id}`;
    const content=(await request(unified+'/content',{source_id:'LP-011',revision:'r1',body:'cloud snapshot',media:[]},headers)).json();
    const made=await request(unified+'/jobs',{account_id:account.id,content_id:content.id},headers);assert.equal(made.status,201);
    const job=made.json();assert.equal(job.state,'DRAFT');
    const approvePath=unified+`/jobs/${job.id}/approve`;
    assert.equal((await request(approvePath,{snapshot_hash:job.snapshot_hash},{...headers,origin:'https://evil.example'})).status,409);
    assert.equal((await request(approvePath,{snapshot_hash:job.snapshot_hash},headers)).json().state,'READY');
    assert.equal((await request(unified+'/jobs?accountId='+account.id)).json().jobs.length,1);
    assert.equal((await request('/publisher/?workspace='+workspace.id+'&accountId='+account.id)).status,503);
    const verification=(await request('/api/publication-verification?workspace='+workspace.id+'&accountId='+account.id)).json();
    assert.equal(verification.rows[0].job_id,job.id);
    assert.equal(verification.rows[0].verification_status,'NOT_VERIFIED');
    assert.equal((await request(base+'/group-jobs/auto-publish',{job_ids:[]},headers)).status,409);
    assert.equal((await request(base+'/accounts',{...account,publisher_transport:'API'},headers)).status,409);
    assert.equal((await request('/unified-client.js')).status,200);
  } finally {server.emit('close');rmSync(root,{recursive:true,force:true});}
});

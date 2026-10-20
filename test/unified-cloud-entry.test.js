import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {request} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
const entry=new URL('../src/unified-cloud-server.js',import.meta.url);
function launch(root,overrides={}) {
 const env={PATH:process.env.PATH,PUBLISHER_MODE:'cloud',PUBLIC_ORIGIN:'https://fixture.invalid',ADMIN_USER:'fixture',ADMIN_PASSWORD:'test-only-disposable-value',DATA_DIR:root,PORT:'0',...overrides};
 const child=spawn(process.execPath,[entry.pathname,join(root,'publisher-unified.sqlite')],{env,stdio:['ignore','pipe','pipe']});
 let output='';child.stderr.on('data',x=>output+=x);
 const exited=new Promise(resolve=>child.once('exit',code=>resolve({code,output})));
 const ready=new Promise((resolve,reject)=>{let text='';const timeout=setTimeout(()=>{child.kill();reject(Error('startup timeout'));},10000);child.once('exit',()=>{clearTimeout(timeout);reject(Error(output));});child.stdout.on('data',x=>{text+=x;for(const line of text.split('\n')){try{const info=JSON.parse(line);if(info.service){clearTimeout(timeout);resolve(info);}}catch{}}});});
 ready.catch(()=>{});
 return {child,ready,exited};
}
function call(port,path,auth=true,host='fixture.invalid') {return new Promise((resolve,reject)=>{const req=request({hostname:'127.0.0.1',port,path,headers:{host,...(auth?{authorization:'Basic '+Buffer.from('fixture:test-only-disposable-value').toString('base64')}:{})}},res=>{let body='';res.on('data',x=>body+=x);res.on('end',()=>resolve({status:res.statusCode,body}));});req.on('error',reject);req.end();});}
test('real cloud entry serves unified with authentication and disabled execution, then reopens its own database',async()=>{
 const root=mkdtempSync(join(tmpdir(),'unified-cloud-entry-'));let running;
 try{
  for(let attempt=0;attempt<2;attempt++){
   running=launch(root);const info=await running.ready;assert.equal(info.host,'127.0.0.1');
   assert.equal((await call(info.port,'/api/state',false)).status,401);
   assert.equal((await call(info.port,'/api/state',true,'wrong.invalid')).status,409);
   const state=JSON.parse((await call(info.port,'/api/state')).body);assert.equal(state.unified,true);assert.deepEqual(state.workspaces,[]);
   const health=JSON.parse((await call(info.port,'/api/health')).body);
   for(const key of ['executionEnabled','pageExecutionEnabled','scanSchedulerEnabled'])assert.equal(health[key],false);
   assert.equal((await call(info.port,'/')).status,200);assert.equal((await call(info.port,'/unified-client.js')).status,200);
   assert.equal((await call(info.port,'/api/group-library')).status,409);
   running.child.kill('SIGTERM');assert.equal((await running.exited).code,0);
  }
 }finally{running?.child.kill();rmSync(root,{recursive:true,force:true});}
});
test('cloud entry rejects execution capability flags and incompatible database',async()=>{
 const root=mkdtempSync(join(tmpdir(),'unified-cloud-reject-'));
 try{
  for(const key of ['PUBLISHER_ENABLE_EXECUTION','PUBLISHER_ENABLE_PAGE_EXECUTION','PUBLISHER_ENABLE_GROUP_INTERACTION','PUBLISHER_ENABLE_SCAN_SCHEDULER','PUBLISHER_ENABLE_CONTENT_SYNC','PUBLISHER_SCOPED_AUTHORIZATION_FILE','PUBLISHER_READONLY_DIAGNOSTIC_CONFIG','PUBLISHER_BROWSER_REOPEN_AUTHORIZATION_FILE']){
   const run=launch(root,{[key]:'1'});const result=await run.exited;assert.notEqual(result.code,0,key);assert.match(result.output,/CLOUD_(EXECUTION_DISABLED|LOCAL_CAPABILITY_UNAVAILABLE)/);
  }
  const db=new DatabaseSync(join(root,'publisher-unified.sqlite'));db.exec('CREATE TABLE unrelated(id TEXT)');db.close();
  const run=launch(root);const result=await run.exited;assert.notEqual(result.code,0);assert.match(result.output,/不能复用旧运行数据库/);
 }finally{rmSync(root,{recursive:true,force:true});}
});

import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {Store} from '../src/store.js';
import {UnifiedPublisher} from '../src/unified-publisher.js';
import {readGptDriveInbox,approveGptDriveItem} from '../src/gpt-drive-inbox.js';
import {reviewLocalContent} from '../src/content-workbench.js';
test('isolated cloud restart preserves reviewed source import, frozen draft and idempotent source ledger',async()=>{
 const root=mkdtempSync(join(tmpdir(),'cloud-persistence-')),demo=join(root,'demo'),dbPath=join(root,'publisher-unified.sqlite');let running,store;
 try{
  const made=spawnSync(process.execPath,[new URL('../scripts/content-workbench.mjs',import.meta.url).pathname,'demo','--out',demo],{encoding:'utf8'});assert.equal(made.status,0,made.stderr);
  const client=join(demo,'synthetic-client'),manifestPath=join(client,'publisher-manifest.json'),manifest=JSON.parse(readFileSync(manifestPath));
  const request=JSON.parse(readFileSync(join(demo,'request.json'))),result=JSON.parse(readFileSync(join(demo,'result.json')));
  assert.equal(reviewLocalContent(request,result,client).status,'REVIEW_REQUIRED');
  const candidate=readGptDriveInbox(client,manifest)[0];approveGptDriveItem(client,candidate);
  assert.equal(approveGptDriveItem(client,candidate).already_applied,true);
  const approvedBytes=readFileSync(manifestPath);
  store=new Store(dbPath,{seedDemo:false});let publisher=new UnifiedPublisher(store);
  const ws=store.saveWorkspace({name:'Synthetic cloud persistence'}),profile=store.saveProfile(ws.id,{name:'Unused fixture profile',cdp_port:19331,user_data_dir:join(root,'unused-profile')});
  const account=publisher.saveAccount(ws.id,{display_name:'Synthetic Page',identity_type:'PAGE',external_id:'10001',operator_actor_id:'10001',target_page_id:'20001',profile_id:profile.id});
  const input={source_id:candidate.articleId,revision:candidate.revision,title:candidate.title,body:candidate.body,media:[candidate.assets[0].path]};
  const content=publisher.importContent(ws.id,input);assert.equal(publisher.importContent(ws.id,input).id,content.id);
  const job=publisher.createPageJob(ws.id,{account_id:account.id,content_id:content.id});assert.equal(job.state,'DRAFT');store.close();store=null;
  for(let attempt=0;attempt<2;attempt++){
   running=launch(root);const info=await running.ready;
   assert.equal((await call(info.port,'/api/state',false)).status,401);
   const jobs=JSON.parse((await call(info.port,`/api/unified/workspaces/${ws.id}/jobs?accountId=${account.id}`)).body).jobs;
   assert.equal(jobs.length,1);assert.equal(jobs[0].id,job.id);assert.equal(jobs[0].state,'DRAFT');assert.equal(jobs[0].snapshot_hash,job.snapshot_hash);assert.equal(jobs[0].snapshot.body,input.body);
   assert.equal((await call(info.port,'/api/group-library')).status,409);
   const capability=JSON.parse((await call(info.port,`/api/unified/workspaces/${ws.id}/jobs/${job.id}/execution-capability`)).body);assert.equal(capability.canExecute,false);
   running.child.kill('SIGTERM');assert.equal((await running.exited).code,0);running=null;
  }
  store=new Store(dbPath,{seedDemo:false});publisher=new UnifiedPublisher(store);assert.equal(publisher.importContent(ws.id,input).id,content.id);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM publisher_content_sources').get().n,1);assert.equal(store.db.prepare('SELECT COUNT(*) n FROM publisher_jobs').get().n,1);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM attempts').get().n,0);
  assert.deepEqual(readFileSync(manifestPath),approvedBytes);assert.equal(approveGptDriveItem(client,candidate).already_applied,true);
 }finally{running?.child.kill();store?.close();rmSync(root,{recursive:true,force:true});}
});

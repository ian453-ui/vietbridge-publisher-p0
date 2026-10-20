import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,chmodSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {request as httpRequest} from 'node:http';
import {Readable} from 'node:stream';
import {Store} from '../src/store.js';
import {createApp} from '../src/server.js';
import {openDatabase} from '../legacy-p0/src/database.ts';
import {createPublisherServer} from '../legacy-p0/src/web-server.ts';
import {GoogleDriveCanonicalSync} from '../legacy-p0/src/google-drive-canonical-sync.ts';

function fixtures(){
 const root=mkdtempSync(join(tmpdir(),'vb-production-mount-')),operatorDb=join(root,'operator.sqlite'),publisherDb=join(root,'publisher.sqlite'),content=join(root,'content'),scopeFile=join(root,'scopes.json');mkdirSync(content);
 const id='VBE-20260928-083';
 writeFileSync(join(content,'manifest.json'),JSON.stringify({article_id:id,title:'隔离草稿测试',source_doc_id:'fixture-source',qa_status:'PENDING_FACT_QA',visual_qa_status:'PENDING',active_assets:[id+'-cover.png']}));
 writeFileSync(join(content,id+'-cover.png'),Buffer.from([137,80,78,71,13,10,26,10,1]));writeFileSync(join(content,id+'-wechat-public.md'),'# 隔离草稿测试\n\n仅验证建任务，禁止平台执行。');
 const config=join(root,'fixture.env');writeFileSync(config,'FB_PAGE_ID=12345\nFB_API_ENABLED=true\n');chmodSync(config,0o600);
 const db=openDatabase(publisherDb);db.prepare('INSERT INTO facebook_accounts(id,display_name,page_id,page_name,config_url,enabled,updated_at) VALUES(?,?,?,?,?,1,?)').run('p-a','Fixture','12345','Fixture',config,'2026-10-05');db.close();
 const store=new Store(operatorDb);
 store.db.prepare("UPDATE records SET value=? WHERE kind='workspaces' AND id='ws-vietbridge'").run(JSON.stringify({id:'ws-vietbridge',name:'Fixture customer',content_root:content}));
 store.db.prepare('INSERT INTO execution_profiles(id,workspace,name,cdp_port,user_data_dir) VALUES(?,?,?,?,?)').run('fixture-profile','ws-vietbridge','Fixture',59001,join(root,'chrome'));
 store.db.prepare('INSERT INTO facebook_accounts(id,workspace,display_name,identity_type,profile_id,expected_identity,session_health) VALUES(?,?,?,?,?,?,?)').run('a','ws-vietbridge','Fixture','PAGE','fixture-profile','Fixture','UNKNOWN');store.close();
 const cloud={mode:'mac-tunnel',executionConnected:true,origin:'https://publisher.vietbridge.one',host:'publisher.vietbridge.one',password:'fixture-password-with-24-characters',user:'fixture',dataDir:root};
 const publisher={dbPath:publisherDb,scopeFile,bindings:[{workspace:'ws-vietbridge',accountId:'a',publisherAccountId:'p-a',contentRoot:content,platforms:['facebook','wechat_official_account']}],contentRoots:[content],ledgerPath:join(root,'unused-ledger.yaml'),stagingRoot:join(root,'staging'),mirrorPath:join(root,'events.jsonl'),workerEnabled:false,driveSyncEnabled:false};
 return {root,operatorDb,publisherDb,content,scopeFile,id,cloud,publisher};
}
async function request(server,path,{method='GET',body,headers={}}={}){
 const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);Object.assign(req,{method,url:path,headers:{host:'publisher.vietbridge.one',...headers}});
 let status=200,text='';const responseHeaders={};const res={setHeader(k,v){responseHeaders[k.toLowerCase()]=v;},writeHead(s,h={}){status=s;Object.assign(responseHeaders,h);},end(b=''){text+=b;}};
 await server.listeners('request')[0](req,res);return {status,text,headers:responseHeaders,json:()=>JSON.parse(text)};
}
function socketRequest(server,path,{method='GET',body,headers={}}={}){return new Promise((resolve,reject)=>{const request=httpRequest({hostname:'127.0.0.1',port:server.address().port,path,method,headers},response=>{let text='';response.setEncoding('utf8');response.on('data',chunk=>text+=chunk);response.on('end',()=>resolve({status:response.statusCode,text,json:()=>JSON.parse(text)}));});request.on('error',reject);if(body!==undefined)request.write(body);request.end();});}
const query='?workspace=ws-vietbridge&accountId=a';
test('real V2 handler mounts real V1 dashboard and preserves public/localhost authentication',async()=>{
 const f=fixtures(),server=createApp(f.operatorDb,{cloud:f.cloud,publisher:f.publisher});
 try{
  const auth={authorization:'Basic '+Buffer.from(f.cloud.user+':'+f.cloud.password).toString('base64')};
  assert.equal((await request(server,'/publisher/'+query)).status,401);
  const page=await request(server,'/publisher/'+query,{headers:auth});assert.equal(page.status,200);assert.match(page.text,/integrationSettings/);assert.match(page.text,/prefix.*publisher/);assert.match(page.headers['content-security-policy'],/nonce-/);assert.doesNotMatch(page.headers['content-security-policy'],/script-src[^;]*unsafe-inline/);assert.equal(page.headers['x-frame-options'],'SAMEORIGIN');
  assert.equal((await request(server,'/api/health',{headers:{...auth,host:'localhost:17882'}})).status,200);
  assert.equal((await request(server,'/api/health',{headers:{...auth,host:'localhost:17882.evil'}})).status,409);
  assert.equal((await request(server,'/publisher/'+query.replace('accountId=a','accountId=other'),{headers:auth})).status,409);
  assert.equal((await request(server,'/publisher/api/history/clear'+query,{method:'POST',body:{},headers:auth})).status,403);
  const session=(await request(server,'/api/state?workspace=ws-vietbridge',{headers:auth})).json();
  const gate=await request(server,'/api/workspaces/ws-vietbridge/group-jobs/auto-publish',{method:'POST',body:{job_ids:[]},headers:{...auth,origin:f.cloud.origin,'content-type':'application/json','x-local-token':session.token}});
  assert.equal(gate.status,409);assert.match(gate.text,/验收模式/);
 }finally{server.emit('close');await new Promise(r=>setImmediate(r));rmSync(f.root,{recursive:true,force:true});}
});
test('socket HTTP accepts authenticated public and loopback hosts, rejects foreign host and CSRF',async()=>{
 const f=fixtures(),server=createApp(f.operatorDb,{cloud:f.cloud,publisher:f.publisher});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
  const auth={host:f.cloud.host,authorization:'Basic '+Buffer.from(f.cloud.user+':'+f.cloud.password).toString('base64')};
  assert.equal((await socketRequest(server,'/api/health',{headers:{host:f.cloud.host}})).status,401);
  const publicHealth=await socketRequest(server,'/api/health',{headers:auth});assert.equal(publicHealth.status,200);assert.equal(publicHealth.json().executionConnected,true);
  const v1Page=await socketRequest(server,'/publisher/'+query,{headers:auth});assert.equal(v1Page.status,200);assert.match(v1Page.text,/integrationSettings/);
  const port=server.address().port;
  assert.equal((await socketRequest(server,'/api/health',{headers:{...auth,host:`localhost:${port}`}})).status,200);
  assert.equal((await socketRequest(server,'/api/health',{headers:{...auth,host:'second.example'}})).status,409);
  assert.equal((await socketRequest(server,'/publisher/api/tasks/execute'+query,{method:'POST',headers:{...auth,origin:'https://attacker.example','content-type':'application/json','x-local-token':'invalid'},body:'{}'})).status,403);
 }finally{await new Promise(r=>server.close(r));rmSync(f.root,{recursive:true,force:true});}
});
test('real scoped draft creation, internal verification, account fencing and restart retain provenance',async()=>{
 const f=fixtures();let server=createApp(f.operatorDb,{cloud:f.cloud,publisher:f.publisher});
 try{
  const auth={authorization:'Basic '+Buffer.from(f.cloud.user+':'+f.cloud.password).toString('base64')};
  const session=(await request(server,'/api/state?workspace=ws-vietbridge',{headers:auth})).json();
  const headers={...auth,origin:f.cloud.origin,'content-type':'application/json','x-local-token':session.token};
  const candidates=(await request(server,'/publisher/api/content/candidates'+query+'&includeIncomplete=1',{headers:auth})).json();
  const item=candidates.candidates.find(x=>x.articleId===f.id);assert.ok(item);
  const input={mode:'article_id',value:f.id,platforms:['wechat_official_account'],selectedArticleId:item.articleId,selectedPackageRoot:item.packageRoot,selectedVersion:item.version};
  assert.equal((await request(server,'/publisher/api/tasks/execute'+query,{method:'POST',body:{...input,facebookAccountId:'other'},headers})).status,409);
  const created=await request(server,'/publisher/api/tasks/execute'+query,{method:'POST',body:input,headers});assert.equal(created.status,201,created.text);
  const batch=created.json();assert.equal(batch.control_state,'AWAITING_APPROVAL');assert.ok(batch.jobs.every(j=>j.state==='READY_FOR_USER_APPROVAL'));
  assert.equal((await request(server,'/publisher/api/batches/'+batch.batch_id+'/approve'+query,{method:'POST',body:{},headers})).status,409);
  assert.equal(JSON.parse(readFileSync(f.scopeFile))[0].batchId,batch.batch_id);
  const report=await request(server,'/api/publication-verification'+query,{headers:auth});assert.equal(report.status,200,report.text);assert.equal(report.json().rows.length,1);
  assert.equal((await request(server,'/publisher/api/batches/'+batch.batch_id+'/stop'+query,{method:'POST',body:{},headers})).status,200);
  const listed=(await request(server,'/publisher/api/batches'+query,{headers:auth})).json();assert.equal(listed.batches[0].control_state,'TERMINATED');
  server.emit('close');await new Promise(r=>setImmediate(r));server=createApp(f.operatorDb,{cloud:f.cloud,publisher:f.publisher});
  const recovered=(await request(server,'/publisher/api/batches'+query,{headers:auth})).json();assert.equal(recovered.batches[0].batch_id,batch.batch_id);assert.equal(recovered.batches[0].control_state,'TERMINATED');
 }finally{server.emit('close');await new Promise(r=>setImmediate(r));rmSync(f.root,{recursive:true,force:true});}
});
test('database collision and missing paths fail before V2 initialization can modify V1',()=>{
 const f=fixtures();try{
  assert.throws(()=>createApp(f.publisherDb,{cloud:f.cloud,publisher:f.publisher}),/数据库必须分离/);
  const db=openDatabase(f.publisherDb);assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='records'").get(),undefined);db.close();
  const missing=join(f.root,'missing.sqlite');assert.throws(()=>createApp(missing,{cloud:f.cloud,publisher:f.publisher}),/现有两个独立数据库/);assert.equal(existsSync(missing),false);
 }finally{rmSync(f.root,{recursive:true,force:true});}
});
test('unknown legacy tasks remain retained but invisible and cannot be silently adopted',async()=>{
 const f=fixtures(),db=openDatabase(f.publisherDb),time='2026-10-05';
 db.prepare("INSERT INTO publication_batches(batch_id,title,source_mode,platforms_json,default_all_platforms,control_state,created_at,updated_at) VALUES('legacy','legacy','ledger','[\"facebook\"]',0,'AWAITING_APPROVAL',?,?)").run(time,time);
 db.prepare("INSERT INTO jobs(job_id,article_id,platform,account_id,package_hash,state,batch_id,created_at,updated_at) VALUES('legacy-job',?,'facebook','facebook:p-a:12345','legacy','READY_FOR_USER_APPROVAL','legacy',?,?)").run(f.id,time,time);db.close();
 const server=createApp(f.operatorDb,{cloud:f.cloud,publisher:f.publisher});
 try{
  const auth={authorization:'Basic '+Buffer.from(f.cloud.user+':'+f.cloud.password).toString('base64')};
  const session=(await request(server,'/api/state?workspace=ws-vietbridge',{headers:auth})).json();
  assert.deepEqual((await request(server,'/publisher/api/batches'+query,{headers:auth})).json().batches,[]);
  assert.equal((await request(server,'/publisher/api/jobs/legacy-job'+query,{headers:auth})).status,404);
  const result=await request(server,'/publisher/api/tasks/execute'+query,{method:'POST',body:{mode:'article_id',value:f.id,selectedArticleId:f.id,platforms:['facebook']},headers:{...auth,origin:f.cloud.origin,'content-type':'application/json','x-local-token':session.token}});
  assert.equal(result.status,400);assert.match(result.text,/未确认归属/);
  const check=openDatabase(f.publisherDb);assert.equal(check.prepare("SELECT state FROM jobs WHERE job_id='legacy-job'").get().state,'READY_FOR_USER_APPROVAL');check.close();
 }finally{server.emit('close');await new Promise(r=>setImmediate(r));rmSync(f.root,{recursive:true,force:true});}
});
test('a second valid customer/account cannot read or stop another customer publication',async()=>{
 const f=fixtures(),otherContent=join(f.root,'other-content');mkdirSync(otherContent);
 const store=new Store(f.operatorDb);
 store.db.prepare('INSERT INTO records(kind,id,workspace,value) VALUES(?,?,?,?)').run('workspaces','ws-other','ws-other',JSON.stringify({id:'ws-other',name:'Other customer',content_root:otherContent}));
 store.db.prepare('INSERT INTO execution_profiles(id,workspace,name,cdp_port,user_data_dir) VALUES(?,?,?,?,?)').run('other-profile','ws-other','Other',59002,join(f.root,'other-chrome'));
 store.db.prepare('INSERT INTO facebook_accounts(id,workspace,display_name,identity_type,profile_id,expected_identity,session_health) VALUES(?,?,?,?,?,?,?)').run('b','ws-other','Other','PAGE','other-profile','Other','UNKNOWN');store.close();
 f.publisher.bindings.push({workspace:'ws-other',accountId:'b',publisherAccountId:'p-a',contentRoot:otherContent,platforms:['facebook']});
 const server=createApp(f.operatorDb,{cloud:f.cloud,publisher:f.publisher});
 try{
  const auth={authorization:'Basic '+Buffer.from(f.cloud.user+':'+f.cloud.password).toString('base64')};
  const session=(await request(server,'/api/state?workspace=ws-vietbridge',{headers:auth})).json(),headers={...auth,origin:f.cloud.origin,'content-type':'application/json','x-local-token':session.token};
  const item=(await request(server,'/publisher/api/content/candidates'+query+'&includeIncomplete=1',{headers:auth})).json().candidates[0];
  const created=(await request(server,'/publisher/api/tasks/execute'+query,{method:'POST',body:{mode:'article_id',value:f.id,platforms:['wechat_official_account'],selectedArticleId:f.id,selectedPackageRoot:item.packageRoot,selectedVersion:item.version},headers})).json();
  assert.ok(created.batch_id);
  const other='?workspace=ws-other&accountId=b';
  assert.deepEqual((await request(server,'/publisher/api/batches'+other,{headers:auth})).json().batches,[]);
  assert.equal((await request(server,'/publisher/api/jobs/'+created.jobs[0].job_id+other,{headers:auth})).status,404);
  assert.equal((await request(server,'/publisher/api/batches/'+created.batch_id+'/stop'+other,{method:'POST',body:{},headers})).status,404);
  assert.equal((await request(server,'/publisher/api/batches'+query,{headers:auth})).json().batches[0].control_state,'AWAITING_APPROVAL');
 }finally{server.emit('close');await new Promise(r=>setImmediate(r));rmSync(f.root,{recursive:true,force:true});}
});

test('same customer with another account cannot adopt, read, stop or retry an owned legacy task',async()=>{
 const f=fixtures(),store=new Store(f.operatorDb);
 store.db.prepare('INSERT INTO facebook_accounts(id,workspace,display_name,identity_type,profile_id,expected_identity,session_health) VALUES(?,?,?,?,?,?,?)').run('b','ws-vietbridge','Second account','PAGE','fixture-profile','Second','UNKNOWN');store.close();
 f.publisher.bindings.push({...f.publisher.bindings[0],accountId:'b'});
 const server=createApp(f.operatorDb,{cloud:f.cloud,publisher:f.publisher});
 try{
  const auth={authorization:'Basic '+Buffer.from(f.cloud.user+':'+f.cloud.password).toString('base64')};
  const session=(await request(server,'/api/state?workspace=ws-vietbridge',{headers:auth})).json();
  const headers={...auth,origin:f.cloud.origin,'content-type':'application/json','x-local-token':session.token};
  const item=(await request(server,'/publisher/api/content/candidates'+query+'&includeIncomplete=1',{headers:auth})).json().candidates[0];
  const input={mode:'article_id',value:f.id,platforms:['wechat_official_account'],selectedArticleId:f.id,selectedPackageRoot:item.packageRoot,selectedVersion:item.version};
  const created=(await request(server,'/publisher/api/tasks/execute'+query,{method:'POST',body:input,headers})).json();assert.ok(created.batch_id);
  const other=query.replace('accountId=a','accountId=b');
  assert.deepEqual((await request(server,'/publisher/api/batches'+other,{headers:auth})).json().batches,[]);
  for(const suffix of ['', '/preview','/assets/forged','/retry','/reconcile']){
   const method=['/retry','/reconcile'].includes(suffix)?'POST':'GET';
   assert.equal((await request(server,'/publisher/api/jobs/'+created.jobs[0].job_id+suffix+other,{method,body:method==='POST'?{}:undefined,headers})).status,404);
  }
  assert.equal((await request(server,'/publisher/api/batches/'+created.batch_id+'/stop'+other,{method:'POST',body:{},headers})).status,404);
  assert.equal((await request(server,'/publisher/api/tasks/execute'+other,{method:'POST',body:input,headers})).status,400);
  assert.equal((await request(server,'/publisher/api/facebook/accounts'+other,{headers:auth})).status,404);
  const check=openDatabase(f.publisherDb);assert.equal(check.prepare('SELECT COUNT(*) n FROM publication_batches').get().n,1);assert.equal(check.prepare('SELECT control_state FROM publication_batches WHERE batch_id=?').get(created.batch_id).control_state,'AWAITING_APPROVAL');check.close();
 }finally{server.emit('close');await new Promise(r=>setImmediate(r));rmSync(f.root,{recursive:true,force:true});}
});

test('unowned UNKNOWN history cannot be retried, stopped, exposed or adopted through integrated routes',async()=>{
 const f=fixtures(),db=openDatabase(f.publisherDb),time='2026-10-05';
 db.prepare("INSERT INTO publication_batches(batch_id,title,source_mode,platforms_json,default_all_platforms,control_state,created_at,updated_at) VALUES('unknown','private','ledger','[\"facebook\"]',0,'AWAITING_APPROVAL',?,?)").run(time,time);
 db.prepare("INSERT INTO jobs(job_id,article_id,platform,account_id,package_hash,state,batch_id,created_at,updated_at) VALUES('unknown-job',?,'facebook','private','private','UNKNOWN','unknown',?,?)").run(f.id,time,time);db.close();
 const server=createApp(f.operatorDb,{cloud:f.cloud,publisher:f.publisher});
 try{
  const auth={authorization:'Basic '+Buffer.from(f.cloud.user+':'+f.cloud.password).toString('base64')};
  const state=(await request(server,'/api/state?workspace=ws-vietbridge',{headers:auth})).json(),headers={...auth,origin:f.cloud.origin,'content-type':'application/json','x-local-token':state.token};
  for(const path of ['/api/jobs/unknown-job/retry','/api/jobs/unknown-job/reconcile','/api/batches/unknown/stop'])assert.equal((await request(server,'/publisher'+path+query,{method:'POST',body:{},headers})).status,404);
  assert.deepEqual((await request(server,'/publisher/api/jobs'+query,{headers:auth})).json().jobs,[]);
  assert.equal((await request(server,'/publisher/api/tasks/execute'+query,{method:'POST',body:{mode:'article_id',value:f.id,platforms:['facebook']},headers})).status,400);
  const check=openDatabase(f.publisherDb);assert.equal(check.prepare("SELECT state FROM jobs WHERE job_id='unknown-job'").get().state,'UNKNOWN');check.close();
 }finally{server.emit('close');await new Promise(r=>setImmediate(r));rmSync(f.root,{recursive:true,force:true});}
});


test('integrated boot never creates a sync connector; headers cannot replace internal ownership and worker mode is rejected',async()=>{
 const f=fixtures(),original=GoogleDriveCanonicalSync.makeClient;let connects=0,server;
 GoogleDriveCanonicalSync.makeClient=async()=>{connects++;throw Error('unexpected sync connector');};
 const integration={context(){throw Error('INTERNAL_CONTEXT_REQUIRED');},batchAllowed(){return false;},batchIds(){return [];},register(){throw Error('no authority');}};
 try{
  assert.throws(()=>createPublisherServer({...f.publisher,integration,workerEnabled:true}),/INTEGRATED_LEGACY_EXECUTION_NOT_SUPPORTED/);
  server=createPublisherServer({...f.publisher,integration});
  const result=await request(server,'/api/batches?workspace=ws-vietbridge&accountId=a',{headers:{'x-workspace':'ws-vietbridge','x-account-id':'a'}});
  assert.equal(result.status,400);assert.match(result.text,/INTERNAL_CONTEXT_REQUIRED/);assert.equal(connects,0);
 }finally{GoogleDriveCanonicalSync.makeClient=original;server?.emit('close');await new Promise(r=>setImmediate(r));rmSync(f.root,{recursive:true,force:true});}
});

// Fixture provenance uses the same documented binding shape as the handoff file.
async function historyFixture(){
 const f=fixtures(),store=new Store(f.operatorDb);
 store.db.prepare('INSERT INTO facebook_accounts(id,workspace,display_name,identity_type,profile_id,expected_identity,session_health) VALUES(?,?,?,?,?,?,?)').run('b','ws-vietbridge','Another bound account','PAGE','fixture-profile','Other','UNKNOWN');store.close();
 f.publisher.bindings.push({...f.publisher.bindings[0],accountId:'b'});
 const {scopeFingerprint}=await import('../src/publisher-integration.js');
 const db=openDatabase(f.publisherDb),scopes=[];
 function batch(id,bindingIndex){
  const time='2026-10-05';db.prepare('INSERT INTO publication_batches(batch_id,title,source_mode,platforms_json,default_all_platforms,control_state,created_at,updated_at) VALUES(?,?,?, ?,0,?,?,?)').run(id,id,'article_id','["facebook","wechat_official_account"]','AWAITING_APPROVAL',time,time);
  if(bindingIndex!==undefined){const b=f.publisher.bindings[bindingIndex],c={id:b.workspace,operatorAccountId:b.accountId,publisherAccountId:b.publisherAccountId,contentRoot:b.contentRoot,platforms:b.platforms};scopes.push({batchId:id,workspace:b.workspace,accountId:b.accountId,publisherAccountId:b.publisherAccountId,fingerprint:scopeFingerprint(c),sourceRef:'isolated-test-fixture'});writeFileSync(f.scopeFile,JSON.stringify(scopes));}
 }
 function job(id,batchId,state,platform='facebook',time='2026-10-06'){
  db.prepare('INSERT INTO jobs(job_id,article_id,platform,account_id,package_hash,state,batch_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(id,f.id,platform,'fixture-history',id,state,batchId,time,time);
 }
 return {...f,db,batch,job,auth:{authorization:'Basic '+Buffer.from(f.cloud.user+':'+f.cloud.password).toString('base64')}};
}

test('candidate published/draft/deleted status uses only the exact registered account binding, including article-only ledger mirrors',async()=>{
 const f=await historyFixture();let server;
 try{
  writeFileSync(join(f.content,f.id+'-facebook-public.txt'),'Approved Facebook fixture body');
  writeFileSync(f.publisher.ledgerPath,`published_history:\n  ${f.id}:\n    facebook:\n      status: PUBLISHED\n    wechat:\n      status: PUBLISHED\n`);
  f.batch('other',1);f.batch('own',0);
  f.job('other-published','other','PUBLISHED');f.job('other-draft','other','DRAFT_API_WRITTEN_NOT_PUBLISHED','wechat_official_account');
  server=createApp(f.operatorDb,{cloud:f.cloud,publisher:f.publisher});
  const candidates=async(includePublished=false)=>{
   const result=await request(server,'/publisher/api/content/candidates'+query+(includePublished?'&includePublished=1':''),{headers:f.auth});assert.equal(result.status,200,result.text);return result.json().candidates;
  };
  let item=(await candidates()).find(p=>p.articleId===f.id);assert.ok(item,'another account must not hide the candidate');assert.deepEqual(item.publishedPlatforms,[]);assert.deepEqual(item.draftPlatforms,[]);
  f.job('own-draft','own','DRAFT_API_WRITTEN_NOT_PUBLISHED','wechat_official_account','2026-10-07');
  item=(await candidates()).find(p=>p.articleId===f.id);assert.ok(item);assert.deepEqual(item.publishedPlatforms,[]);assert.deepEqual(item.draftPlatforms,['wechat_official_account']);
  f.job('own-published','own','PUBLISHED','facebook','2026-10-07');assert.equal((await candidates()).length,0,'own completed platforms still hide the candidate by default');
  f.job('other-delete-fb','other','PLATFORM_DELETED','facebook','2026-10-08');f.job('other-delete-draft','other','PLATFORM_DELETED','wechat_official_account','2026-10-08');
  item=(await candidates(true)).find(p=>p.articleId===f.id);assert.deepEqual(item.publishedPlatforms,['facebook']);assert.deepEqual(item.draftPlatforms,['wechat_official_account']);
  f.job('own-delete-draft','own','PLATFORM_DELETED','wechat_official_account','2026-10-09');item=(await candidates()).find(p=>p.articleId===f.id);assert.ok(item);assert.deepEqual(item.draftPlatforms,[]);assert.deepEqual(item.publishedPlatforms,['facebook']);
 }finally{server?.emit('close');await new Promise(r=>setImmediate(r));f.db.close();rmSync(f.root,{recursive:true,force:true});}
});

test('unregistered UNKNOWN history never becomes a candidate completion flag or gains adoption/execution authority',async()=>{
 const f=await historyFixture();let server;
 try{
  f.batch('unregistered');f.job('unknown-unregistered','unregistered','UNKNOWN','wechat_official_account');
  server=createApp(f.operatorDb,{cloud:f.cloud,publisher:f.publisher});
  const result=await request(server,'/publisher/api/content/candidates'+query,{headers:f.auth}),item=result.json().candidates.find(p=>p.articleId===f.id);assert.ok(item);assert.deepEqual(item.publishedPlatforms,[]);assert.deepEqual(item.draftPlatforms,[]);
  const state=(await request(server,'/api/state?workspace=ws-vietbridge',{headers:f.auth})).json(),headers={...f.auth,origin:f.cloud.origin,'content-type':'application/json','x-local-token':state.token};
  const creation=await request(server,'/publisher/api/tasks/execute'+query,{method:'POST',headers,body:{mode:'article_id',value:f.id,selectedArticleId:f.id,selectedPackageRoot:item.packageRoot,selectedVersion:item.version,platforms:['wechat_official_account']}});assert.equal(creation.status,400);assert.match(creation.text,/未确认归属/);
  for(const op of ['retry','reconcile'])assert.equal((await request(server,'/publisher/api/jobs/unknown-unregistered/'+op+query,{method:'POST',headers,body:{}})).status,404);
  assert.equal(f.db.prepare("SELECT state FROM jobs WHERE job_id='unknown-unregistered'").get().state,'UNKNOWN');assert.equal(f.db.prepare('SELECT COUNT(*) n FROM jobs').get().n,1);
 }finally{server?.emit('close');await new Promise(r=>setImmediate(r));f.db.close();rmSync(f.root,{recursive:true,force:true});}
});

test('jobs applies the binding before its 200-row limit so 205 newer foreign jobs cannot displace old owned history',async()=>{
 const f=await historyFixture();let server;
 try{
  f.batch('busy-other',1);f.batch('old-own',0);f.batch('unregistered');
  f.job('owned-old-ready','old-own','READY_FOR_USER_APPROVAL','facebook','2020-01-01');f.job('owned-old-unknown','old-own','UNKNOWN','facebook','2020-01-02');
  for(let i=0;i<205;i++)f.job('foreign-'+i,'busy-other','PUBLISHED','facebook','2026-10-09');
  f.job('unregistered-new','unregistered','UNKNOWN','facebook','2026-10-10');
  server=createApp(f.operatorDb,{cloud:f.cloud,publisher:f.publisher});
  const own=await request(server,'/publisher/api/jobs'+query,{headers:f.auth});assert.equal(own.status,200);assert.deepEqual(own.json().jobs.map(j=>j.job_id),['owned-old-unknown','owned-old-ready']);assert.equal(own.json().jobs[0].state,'UNKNOWN');
  const other=await request(server,'/publisher/api/jobs'+query.replace('accountId=a','accountId=b'),{headers:f.auth});assert.equal(other.status,200);assert.equal(other.json().jobs.length,200);assert.ok(other.json().jobs.every(j=>j.batch_id==='busy-other'));
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM jobs').get().n,208);
 }finally{server?.emit('close');await new Promise(r=>setImmediate(r));f.db.close();rmSync(f.root,{recursive:true,force:true});}
});


test('owned UNKNOWN history remains visible but cannot be replaced by staging a fresh content version',async()=>{
 const f=await historyFixture();let server;
 try{
  f.batch('owned-pending',0);f.job('owned-unknown','owned-pending','UNKNOWN','wechat_official_account');
  server=createApp(f.operatorDb,{cloud:f.cloud,publisher:f.publisher});
  const item=(await request(server,'/publisher/api/content/candidates'+query,{headers:f.auth})).json().candidates.find(p=>p.articleId===f.id);assert.ok(item);
  const state=(await request(server,'/api/state?workspace=ws-vietbridge',{headers:f.auth})).json(),headers={...f.auth,origin:f.cloud.origin,'content-type':'application/json','x-local-token':state.token};
  const input={mode:'article_id',value:f.id,selectedArticleId:f.id,selectedPackageRoot:item.packageRoot,selectedVersion:item.version,platforms:['wechat_official_account']};
  for(const republish of [false,true]){const result=await request(server,'/publisher/api/tasks/execute'+query,{method:'POST',headers,body:{...input,republish}});assert.equal(result.status,409);assert.match(result.text,/结果待核对/);}
  assert.equal((await request(server,'/publisher/api/jobs'+query,{headers:f.auth})).json().jobs[0].state,'UNKNOWN');assert.equal(f.db.prepare('SELECT COUNT(*) n FROM jobs').get().n,1);
 }finally{server?.emit('close');await new Promise(r=>setImmediate(r));f.db.close();rmSync(f.root,{recursive:true,force:true});}
});

test('history clear and restore use real scoped routes without hiding uncertain or active failures',async()=>{
 const f=await historyFixture();let server;
 try{
  for(const [id,owner] of [['ended',0],['active',0],['foreign',1],['unregistered',undefined]])f.batch(id,owner);
  f.db.prepare("UPDATE publication_batches SET control_state='COMPLETED' WHERE batch_id!='active'").run();
  for(const state of ['FAILED','FAILED_PREFLIGHT','BLOCKED_CAPABILITY'])f.job('ended-'+state,'ended',state);
  for(const state of ['UNKNOWN','SUBMITTED_PENDING_CONFIRMATION','RECONCILE_PENDING','PUBLISHED_ID_PENDING','JOB_WAITING_HUMAN'])f.job('pending-'+state,'ended',state);
  f.job('ambiguous-failure','ended','FAILED');f.db.prepare("UPDATE jobs SET submit_safety_domain='MAY_HAVE_SUBMITTED' WHERE job_id='ambiguous-failure'").run();
  f.job('active-failure','active','FAILED');f.job('foreign-failure','foreign','FAILED');f.job('unregistered-failure','unregistered','FAILED');
  const before={jobs:f.db.prepare('SELECT * FROM jobs ORDER BY job_id').all(),batches:f.db.prepare('SELECT * FROM publication_batches ORDER BY batch_id').all(),transitions:f.db.prepare('SELECT * FROM state_transitions').all()};
  server=createApp(f.operatorDb,{cloud:f.cloud,publisher:f.publisher});
  const state=(await request(server,'/api/state?workspace=ws-vietbridge',{headers:f.auth})).json(),headers={...f.auth,origin:f.cloud.origin,'content-type':'application/json','x-local-token':state.token};
  const post=async(action,account='a')=>request(server,'/publisher/api/history/'+action+query.replace('accountId=a','accountId='+account),{method:'POST',headers,body:{}});
  const hidden=()=>f.db.prepare('SELECT job_id FROM hidden_history ORDER BY job_id').all().map(x=>x.job_id);
  assert.equal((await request(server,'/publisher/api/history/clear'+query,{method:'POST',headers:f.auth,body:{}})).status,403);
  assert.deepEqual(hidden(),[]);
  let result=await post('clear');assert.equal(result.status,200,result.text);assert.equal(result.json().hidden,3);
  assert.deepEqual(hidden(),['ended-BLOCKED_CAPABILITY','ended-FAILED','ended-FAILED_PREFLIGHT']);
  assert.equal((await post('clear')).json().hidden,0,'clearing twice is idempotent');
  const batches=(await request(server,'/publisher/api/batches'+query,{headers:f.auth})).json().batches;
  const ended=batches.find(b=>b.batch_id==='ended');
  assert.ok(ended.jobs.filter(j=>j.job_id.startsWith('ended-')).every(j=>j.history_hidden));
  assert.ok(ended.jobs.filter(j=>!j.job_id.startsWith('ended-')).every(j=>!j.history_hidden));
  result=await post('restore','b');assert.equal(result.status,200);assert.equal(hidden().length,3,'another account cannot restore our markers');
  result=await post('clear','b');assert.equal(result.status,200);assert.equal(result.json().hidden,1);
  result=await post('restore');assert.equal(result.status,200);assert.deepEqual(hidden(),['foreign-failure']);
  const restored=(await request(server,'/publisher/api/batches'+query,{headers:f.auth})).json().batches;
  assert.ok(restored.flatMap(b=>b.jobs).every(j=>!j.history_hidden));
  assert.equal((await post('restore','b')).status,200);assert.deepEqual(hidden(),[]);
  assert.deepEqual(f.db.prepare('SELECT * FROM jobs ORDER BY job_id').all(),before.jobs);
  assert.deepEqual(f.db.prepare('SELECT * FROM publication_batches ORDER BY batch_id').all(),before.batches);
  assert.deepEqual(f.db.prepare('SELECT * FROM state_transitions').all(),before.transitions);
 }finally{server?.emit('close');await new Promise(r=>setImmediate(r));f.db.close();rmSync(f.root,{recursive:true,force:true});}
});

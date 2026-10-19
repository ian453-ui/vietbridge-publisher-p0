import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,chmodSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {request as httpRequest} from 'node:http';
import {Readable} from 'node:stream';
import {Store} from '../src/store.js';
import {createApp} from '../src/server.js';
import {openDatabase} from '../../Publisher-P0/src/database.ts';

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

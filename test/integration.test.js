import {image as png} from './helpers/manual-sync-fixture.js';
import test from 'node:test';import assert from 'node:assert/strict';import {chmodSync,mkdtempSync,writeFileSync,mkdirSync,readFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {dirname,join} from 'node:path';import {createApp} from '../src/server.js';
test('HTTP persistence, isolation, approvals, duplicate prevention and recovery',async()=>{
 const path=join(mkdtempSync(join(tmpdir(),'smo-v2-')),'test.sqlite');let server,base,token;
 async function start(){server=createApp(path);await new Promise(r=>server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port;token=(await read()).token;}
 async function read(ws=''){return (await fetch(base+'/api/state'+(ws?'?workspace='+ws:''))).json();}
 async function act(ws,kind,id,action,b){const r=await fetch(`${base}/api/workspaces/${ws}/${kind}/${id}/${action}`,{method:'POST',headers:{'content-type':'application/json','x-local-token':token,origin:base},body:JSON.stringify(b)});return {status:r.status,value:await r.json()};}
 const close=()=>new Promise(r=>server.close(r));await start();
 try{
 assert.equal((await read()).tasks.length,0);const a=await read('ws-vietbridge');assert.ok(a.content.every(c=>c.workspaceId==='ws-vietbridge'));
 for(const p of ['/','/client.js','/styles.css'])assert.equal((await fetch(base+p)).status,200);
 let t=a.tasks[0];assert.equal((await act('ws-abc','tasks',t.id,'approve',{version:t.version})).status,409);
 assert.equal((await act('ws-vietbridge','tasks',t.id,'prepare',{version:t.version})).status,409);
 t=(await act('ws-vietbridge','tasks',t.id,'approve',{version:t.version})).value;
 const content=a.content.find(c=>c.id===t.contentId);await act('ws-vietbridge','content',content.id,'revise',{body:'新的审核正文'});
 assert.equal((await act('ws-vietbridge','tasks',t.id,'prepare',{version:t.version})).status,409);
 t=(await act('ws-vietbridge','tasks',t.id,'approve',{version:t.version})).value;
 t=(await act('ws-vietbridge','tasks',t.id,'prepare',{version:t.version})).value;assert.equal(t.state,'COMPOSER_READY');
 const results=await Promise.all([act('ws-vietbridge','tasks',t.id,'submit',{version:t.version}),act('ws-vietbridge','tasks',t.id,'submit',{version:t.version})]);assert.deepEqual(results.map(x=>x.status).sort(),[200,409]);
 await close();await start();t=(await read('ws-vietbridge')).tasks.find(x=>x.id===t.id);assert.equal(t.state,'UNKNOWN');
 t=(await act('ws-vietbridge','tasks',t.id,'reconcile',{version:t.version})).value;assert.equal(t.state,'PUBLISHED');assert.equal((await act('ws-vietbridge','tasks',t.id,'prepare',{version:t.version})).status,409);
 const c=a.comments.find(c=>c.intent!=='RISK_QUESTION');assert.equal((await act('ws-vietbridge','comments',c.id,'reply',{body:'谢谢您的反馈'})).status,200);assert.equal((await act('ws-vietbridge','comments',c.id,'reply',{body:'重复回复'})).status,409);
 assert.ok((await read('ws-vietbridge')).audit.length>0);
 }finally{await close();}
});

test('Facebook Group API creates tenant-scoped profile, account, content and independent jobs',async()=>{
 const path=join(mkdtempSync(join(tmpdir(),'smo-fb-http-')),'test.sqlite'),server=createApp(path);await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 try{const state=await (await fetch(base+'/api/state?workspace=ws-vietbridge')).json(),headers={'content-type':'application/json','x-local-token':state.token,origin:base};const post=async(path,body)=>{const r=await fetch(base+path,{method:'POST',headers,body:JSON.stringify(body)});return {status:r.status,value:await r.json()}};
 const profile=(await post('/api/workspaces/ws-vietbridge/profiles',{name:'FB',cdp_port:19124,user_data_dir:'/tmp/fb-http'})).value;
 const config=join(dirname(path),'account.env');writeFileSync(config,'FB_ACCOUNT_NAME=Imported\nFB_PAGE_NAME=Imported Page\nFB_PAGE_ID=3003\nFB_PAGE_ACCESS_TOKEN=must-not-leak\n');chmodSync(config,0o600);
 const imported=await post('/api/workspaces/ws-vietbridge/accounts/import-local',{config_url:`file://${config}`});assert.equal(imported.value.external_id,'');assert.equal(imported.value.target_page_id,'3003');assert.doesNotMatch(JSON.stringify(imported.value),/must-not-leak/);
 const account=(await post('/api/workspaces/ws-vietbridge/accounts',{display_name:'VB',expected_identity:'VB',profile_id:profile.id})).value;
 const g1=(await post('/api/workspaces/ws-vietbridge/groups/manual',{account_id:account.id,name:'A',url:'https://facebook.com/groups/1'})).value,g2=(await post('/api/workspaces/ws-vietbridge/groups/manual',{account_id:account.id,name:'Visa B',url:'https://facebook.com/groups/2'})).value;
 const content=(await post('/api/workspaces/ws-vietbridge/content',{title:'中文',body:'中文正文完整',media:[]})).value;
 const blocked=await post('/api/workspaces/ws-vietbridge/group-jobs',{account_id:account.id,content_id:content.id,group_ids:[g1.id,g2.id],group_name_exclude:'visa'});assert.equal(blocked.status,409);
 const jobs=await post('/api/workspaces/ws-vietbridge/group-jobs',{account_id:account.id,content_id:content.id,group_ids:[g1.id,g2.id]});assert.equal(jobs.status,201);assert.equal(jobs.value.length,2);
 const isolated=await fetch(base+'/api/facebook?workspace=ws-abc').then(r=>r.json());assert.equal(isolated.accounts.length,0);
 }finally{await new Promise(r=>server.close(r));}
});

test('customer API creates and edits a workspace',async()=>{
 const path=join(mkdtempSync(join(tmpdir(),'smo-http-customer-')),'db.sqlite'),server=createApp(path);await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 try{const state=await fetch(base+'/api/state').then(r=>r.json()),headers={'content-type':'application/json','x-local-token':state.token,origin:base};const call=async body=>{const r=await fetch(base+'/api/workspaces',{method:'POST',headers,body:JSON.stringify(body)});return {status:r.status,value:await r.json()}};const created=await call({name:'Client A',brand:'Brand A'});assert.equal(created.status,201);const edited=await call({...created.value,name:'Client B'});assert.equal(edited.status,200);assert.equal(edited.value.id,created.value.id);const isolated=await fetch(base+`/api/state?workspace=${created.value.id}`).then(r=>r.json());assert.equal(isolated.content.length,0);assert.equal(isolated.workspaces.find(x=>x.id===created.value.id).name,'Client B');}finally{await new Promise(r=>server.close(r))}
});

test('GPT inbox rejection endpoint persists a local decision without changing Drive source',async()=>{
 const temp=mkdtempSync(join(tmpdir(),'smo-gpt-reject-http-')),dbPath=join(temp,'db.sqlite'),roots=join(temp,'library'),client=join(roots,'clients','lp'),inbox=join(client,'GPT-INBOX','draft'),server=createApp(dbPath,{library:{roots:[roots],snapshotRoot:join(temp,'snapshots')}});
 mkdirSync(inbox,{recursive:true});mkdirSync(join(client,'READY','content'),{recursive:true});mkdirSync(join(client,'READY','assets'),{recursive:true});
 writeFileSync(join(client,'publisher-manifest.json'),JSON.stringify({status:'READY',items:[]}));
 const image=Buffer.concat([png,Buffer.alloc(200,9)]),imagePath=join(inbox,'cover.png'),submissionPath=join(inbox,'submission.json');writeFileSync(imagePath,image);writeFileSync(submissionPath,JSON.stringify({schema_version:1,status:'READY_FOR_REVIEW',content_id:'LP-FB-HTTP-001',title:'HTTP review',facebook_caption:'Pending body',primary_image:'cover.png'}));
 const sourceBefore=readFileSync(submissionPath,'utf8');await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 try{
  const state=await fetch(base+'/api/state').then(r=>r.json()),headers={'content-type':'application/json','x-local-token':state.token,origin:base};
  const created=await fetch(base+'/api/workspaces',{method:'POST',headers,body:JSON.stringify({name:'LP',brand:'LP',content_root:client})}).then(r=>r.json());
  const catalogue=()=>fetch(`${base}/api/group-library?workspace=${encodeURIComponent(created.id)}&refresh=1`).then(r=>r.json());
  const [draft]=(await catalogue()).items;assert.equal(draft.reviewStatus,'PENDING_REVIEW');
  const rejected=await fetch(`${base}/api/workspaces/${created.id}/library/reject-gpt`,{method:'POST',headers,body:JSON.stringify({key:draft.key,revision:draft.revision})});
  assert.equal(rejected.status,200);assert.equal((await rejected.json()).status,'REJECTED');assert.equal((await catalogue()).items.length,0);
  assert.equal(readFileSync(submissionPath,'utf8'),sourceBefore);assert.deepEqual(readFileSync(imagePath),image);
 }finally{await new Promise(r=>server.close(r));}
});

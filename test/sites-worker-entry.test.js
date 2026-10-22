import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import worker,{createPublisherSite,PUBLISHER_SITE_PROJECT_ID} from '../src/sites/worker-entry.js';
import {cloudD1Fixture} from './fixtures/sites-cloud-d1.js';
import {seedSitesRecords,fileBucket,inspectedPacket} from './fixtures/sites-evidence.js';
import {AsyncReviewStore} from '../src/sites/async-review-store.js';

const origin='https://synthetic-worker.invalid';
const types={'/cloud-console.html':'text/html','/cloud-console.js':'text/javascript','/cloud-console.css':'text/css'};
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'v3-worker-')),path=join(root,'db.sqlite'),f=cloudD1Fixture(path);
 t.after(()=>{f.close();rmSync(root,{recursive:true,force:true});});
 const assets={async fetch(request){const path=new URL(request.url).pathname;assert.equal(request.method,'GET');assert.equal([...request.headers].length,0);assert.ok(Object.hasOwn(types,path));return new Response(readFileSync(new URL('../src/sites'+path,import.meta.url)),{headers:{'Content-Type':types[path],'Set-Cookie':'must-not-leak=1'}});}};
 const env={DB:f.db,ASSETS:assets,PUBLISHER_CANONICAL_ORIGIN:origin};let user='synthetic-owner',calls=0;
 const app=createPublisherSite({getTrustedIdentity:async()=>{calls++;return user?{userId:user}:null;}});
 const request=(path,body,options={})=>new Request(origin+path,{method:body?'POST':'GET',headers:{origin,...(body?{'Content-Type':'application/json'}:{}),...options.headers},...(body?{body:JSON.stringify(body)}:{}),...options});
 const call=async(path,body)=>{const r=await app.fetch(request(path,body),env);return {status:r.status,body:await r.json()};};
 return {root,path,f,env,app,request,call,get calls(){return calls;},set user(value){user=value;}};
}
async function seed(f){
 const post=async(path,body)=>{const r=await f.call(path,{command_id:crypto.randomUUID(),...body});assert.equal(r.status,200,JSON.stringify(r));return r.body;};
 const w=(await post('/api/sites/workspaces',{name:'Synthetic worker customer'})).id,base='/api/sites/workspaces/'+w,a=(await post(base+'/accounts',{display_name:'Synthetic worker account',platform:'facebook',external_identity:null})).id;
 const content=await post(base+'/contents',{account_id:a,content_id:'SYNTHETIC-WORKER-074',slug:'worker-source',revision:1,title:'Full title',body:'Full original body',variants:{facebook:{title:'FB title',body:'Explicit platform ending'}}});
 return {w,a,base,content,post};
}

test('default Worker exports fetch but refuses missing official identity and canonical origin',async t=>{
 const f=fixture(t),r=f.request('/api/sites/workspaces',null,{headers:{'oai-authenticated-user-id':'synthetic-owner','X-Forwarded-Host':new URL(origin).host}});
 assert.equal(PUBLISHER_SITE_PROJECT_ID,'appgprj_6ad97a034fd08191a8399eeda10f048c');
 assert.equal((await worker.fetch(r,{DB:f.f.db})).status,503);
 const denied=await worker.fetch(r,{...f.env,getTrustedIdentity:async()=>({userId:'synthetic-owner'})});
 assert.equal((await denied.json()).error,'SITES_IDENTITY_INTEGRATION_UNAVAILABLE');assert.equal(f.f.reads,0);assert.equal(f.f.writes,0);
});
test('missing database, malformed bucket and untrusted origins fail closed for document and API',async t=>{
 const f=fixture(t);
 for(const path of ['/','/cloud-console.js','/api/sites/workspaces']){
  for(const DB of [null,{}, {prepare(){}}])assert.equal((await(await f.app.fetch(f.request(path),{...f.env,DB})).json()).error,'SITES_RUNTIME_BINDING_REQUIRED');
 }
 for(const value of ['',origin+'/',origin+'/path','http://public.invalid','http://127.0.0.1:6000','https://user:pass@synthetic-worker.invalid'])assert.equal((await(await f.app.fetch(f.request('/'),{...f.env,PUBLISHER_CANONICAL_ORIGIN:value})).json()).error,'SITES_ORIGIN_REQUIRED');
 assert.equal((await f.app.fetch(new Request('https://foreign.invalid/',{headers:{Host:new URL(origin).host}}),f.env)).status,409);
 assert.equal((await(await f.app.fetch(f.request('/'),{...f.env,BUCKET:{get(){}}})).json()).error,'R2_BINDING_REQUIRED');assert.equal(f.f.writes,0);
});
test('null, invalid and throwing identity resolvers cannot be replaced with browser claims',async t=>{
 const f=fixture(t),req=f.request('/',null,{headers:{'oai-authenticated-user-id':'synthetic-owner',Cookie:'user=synthetic-owner',Authorization:'Bearer synthetic-not-authority'}});
 for(const identity of [null,{}, {userId:' '},{userId:5},{userId:' owner'},{userId:'x'.repeat(301)}]){
  const app=createPublisherSite({getTrustedIdentity:async()=>identity});assert.equal((await app.fetch(req,f.env)).status,401);
 }
 const app=createPublisherSite({getTrustedIdentity:async()=>{throw Error('private-provider-details');}}),r=await app.fetch(req,f.env);
 assert.equal(r.status,503);assert.doesNotMatch(await r.text(),/private-provider-details/);assert.equal(f.f.reads,0);assert.equal(f.f.writes,0);
});
test('protected static routes serve exact existing bytes, HEAD and security headers without forwarding credentials',async t=>{
 const f=fixture(t);
 for(const [route,file] of [['/','/cloud-console.html'],['/cloud-console.js','/cloud-console.js'],['/cloud-console.css','/cloud-console.css']]){
  const r=await f.app.fetch(f.request(route+'?ignored=1',null,{headers:{Cookie:'synthetic-secret=1'}}),f.env);
  assert.equal(r.status,200);assert.deepEqual(Buffer.from(await r.arrayBuffer()),readFileSync(new URL('../src/sites'+file,import.meta.url)));
  assert.equal(r.headers.get('Set-Cookie'),null);assert.equal(r.headers.get('X-Content-Type-Options'),'nosniff');assert.equal(r.headers.get('Cache-Control'),'private, no-store');assert.match(r.headers.get('Content-Security-Policy'),/frame-ancestors 'none'/);
  const head=await f.app.fetch(f.request(route,null,{method:'HEAD'}),f.env);assert.equal(head.status,200);assert.equal(await head.text(),'');
 }
 assert.equal(f.calls,6);assert.equal(f.f.reads,0);assert.equal(f.f.writes,0);
});
test('routing rejects private files, SPA fallbacks, redirects and unsupported methods',async t=>{
 const f=fixture(t);
 for(const path of ['/.openai/hosting.json','/.env','/src/sites/cloud-authoring-api.js','/cloud-console.html','/unknown','/api/publish'])assert.equal((await f.app.fetch(f.request(path),f.env)).status,404);
 assert.equal((await f.app.fetch(f.request('/',{}),f.env)).status,405);
 assert.equal((await f.app.fetch(f.request('/api/sites/workspaces',null,{method:'DELETE'}),f.env)).status,405);
 assert.equal((await(await f.app.fetch(f.request('/'),{...f.env,ASSETS:null})).json()).error,'SITES_ASSET_BINDING_REQUIRED');
 for(const response of [new Response('<html>fallback</html>',{headers:{'Content-Type':'text/html'}}),new Response(null,{status:302,headers:{location:'https://foreign.invalid'}}),new Response('missing',{status:404})])assert.equal((await(await f.app.fetch(f.request('/cloud-console.js'),{...f.env,ASSETS:{fetch:async()=>response}})).json()).error,'SITES_ASSET_INVALID');
 const failing={fetch:async()=>{throw Error('provider-internal');}};assert.equal((await(await f.app.fetch(f.request('/'),{...f.env,ASSETS:failing})).json()).error,'SITES_ASSET_UNAVAILABLE');
 let seen;const app=createPublisherSite({getTrustedIdentity:async()=>({userId:'synthetic-owner'}),readAsset:async(path,context)=>{seen={path,env:context.env};return new Response('html',{headers:{'Content-Type':'text/html'}});}});
 assert.equal((await app.fetch(f.request('/'),{...f.env,ASSETS:null})).status,200);assert.equal(seen.path,'/cloud-console.html');assert.equal(seen.env.DB,f.f.db);
});
test('Worker authoring persists exact scoped tasks and retains UNKNOWN receipts after restart',async t=>{
 const f=fixture(t),s=await seed(f),ready=await f.call(s.base+'/task-preflight',{account_id:s.a,expected_platform:'facebook',items:[{content_id:s.content.id,expected_payload_hash:s.content.payload_hash}]}),command={command_id:crypto.randomUUID(),...ready.body.items[0].task_input},job=await f.call(s.base+'/tasks',command);
 assert.equal(job.status,200);assert.equal(job.body.state,'DRAFT');assert.equal(job.body.publish_allowed,false);
 f.f.sql.prepare("UPDATE publisher_jobs SET state='UNKNOWN',attempt_id='synthetic-original' WHERE id=?").run(job.body.id);
 const reopened=cloudD1Fixture(f.path,{initialize:false});try{
  const response=await f.app.fetch(f.request(s.base+'/tasks',command),{...f.env,DB:reopened.db}),receipt=await response.json();assert.equal(receipt.id,job.body.id);assert.equal(receipt.state,'UNKNOWN');assert.equal(receipt.snapshot_hash,job.body.snapshot_hash);
 }finally{reopened.close();}
 const other=await seed(f);assert.equal((await f.call(s.base+'/tasks?accountId='+other.a)).status,403);assert.equal((await f.call(other.base+'/tasks',{...command,command_id:crypto.randomUUID(),account_id:other.a})).status,404);
 f.user='intruder';assert.equal((await f.call(s.base+'/tasks?accountId='+s.a)).status,403);f.user=null;assert.equal((await f.call(s.base+'/tasks?accountId='+s.a)).status,401);f.user='synthetic-owner';
 f.f.sql.prepare("UPDATE sites_project_memberships SET revoked_at='synthetic-revoked' WHERE workspace=? AND account_id=?").run(s.w,s.a);assert.equal((await f.call(s.base+'/tasks?accountId='+s.a)).status,403);
 assert.equal(f.f.sql.prepare('SELECT count(*) n FROM publisher_jobs').get().n,1);assert.equal(f.f.sql.prepare('SELECT count(*) n FROM sites_execution_claims').get().n,0);
});
test('one Worker instance never caches an identity or database between concurrent requests',async t=>{
 const a=fixture(t),b=fixture(t);await seed(a);await seed(b);
 const reqA=a.request('/api/sites/workspaces'),reqB=b.request('/api/sites/workspaces'),identities=new WeakMap([[reqA,{userId:'synthetic-owner'}],[reqB,{userId:'intruder'}]]);
 const app=createPublisherSite({getTrustedIdentity:async req=>{await Promise.resolve();return identities.get(req);}});
 const [ra,rb]=await Promise.all([app.fetch(reqA,a.env),app.fetch(reqB,b.env)]);assert.equal((await ra.json()).workspaces.length,1);assert.deepEqual((await rb.json()).workspaces,[]);
 identities.set(reqB,{userId:'synthetic-owner'});assert.equal((await(await app.fetch(reqB,b.env)).json()).workspaces.length,1);
 assert.notEqual(a.f.sql.prepare('SELECT id FROM sites_workspaces').get().id,b.f.sql.prepare('SELECT id FROM sites_workspaces').get().id);
});
test('Worker forwards transaction rollback and rejects foreign-origin writes without side effects',async t=>{
 const f=fixture(t),s=await seed(f),cmd={command_id:crypto.randomUUID(),account_id:s.a,content_id:s.content.id,expected_payload_hash:s.content.payload_hash};f.f.fault=4;
 assert.equal((await f.call(s.base+'/tasks',cmd)).status,409);assert.equal(f.f.sql.prepare('SELECT count(*) n FROM publisher_jobs').get().n,0);assert.equal(f.f.sql.prepare('SELECT count(*) n FROM sites_authoring_commands WHERE command_id=?').get(cmd.command_id).n,0);
 f.f.fault=-1;const forged=f.request(s.base+'/tasks',cmd);forged.headers.set('Origin','https://foreign.invalid');assert.equal((await f.app.fetch(forged,f.env)).status,403);assert.equal(f.f.sql.prepare('SELECT count(*) n FROM publisher_jobs').get().n,0);
 assert.equal((await f.call(s.base+'/tasks',cmd)).status,200);
});
test('Worker injects the exact R2 method binding and preserves scoped media integrity checks',async t=>{
 const f=fixture(t),s=await seedSitesRecords(f.f),bucket=fileBucket(join(f.root,'objects')),packet=inspectedPacket(f.root,s.scope),store=new AsyncReviewStore(f.f.db,{bucket,inspectionProvider:{readInspection:async()=>packet}}),review=await store.intake({...s.scope,task_id:packet.request.task_id,request_revision:1}),asset=packet.assets[0],path='/api/sites/workspaces/'+s.workspace+'/reviews/'+review.id+'/assets/'+asset.source_id+'/'+asset.artifact_id+'?accountId='+s.accountId;
 const r=await f.app.fetch(f.request(path),{...f.env,BUCKET:bucket});assert.equal(r.status,200);assert.deepEqual(Buffer.from(await r.arrayBuffer()),Buffer.from(asset.data));
 assert.equal((await f.app.fetch(f.request(path),f.env)).status,503);f.user='intruder';const reads=bucket.gets;assert.equal((await f.app.fetch(f.request(path),{...f.env,BUCKET:bucket})).status,403);assert.equal(bucket.gets,reads);
});
test('missing schema is a storage failure and never triggers request-time DDL or enrollment',async t=>{
 const f=fixture(t),blank=cloudD1Fixture(join(f.root,'blank.sqlite'),{initialize:false});try{
  const r=await f.app.fetch(f.request('/api/sites/workspaces',{command_id:crypto.randomUUID(),name:'Not enrolled'}),{...f.env,DB:blank.db});assert.equal(r.status,503);assert.doesNotMatch(await r.text(),/no such table/);assert.equal(blank.sql.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table'").get().n,0);
 }finally{blank.close();}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {ApiDriver} from '../src/unified-drivers.js';
const snapshot={workspace:'SYNTHETIC-WORKSPACE',accountId:'SYNTHETIC-ACCOUNT',externalId:'900000001',operatorActorId:'900000001',targetPageId:'900000002',platform:'facebook',title:'Synthetic video',body:'Synthetic complete approved body.',contentHash:'a'.repeat(64),payloadHash:'b'.repeat(64),media:['synthetic.mp4'],transport:'API'};
test('existing API driver can use an injected cloud video reader without opening a local credential/client',async()=>{
 const result={verified:true,id:'900000003',targetPageId:snapshot.targetPageId,operatorActorId:snapshot.operatorActorId,contentHash:snapshot.contentHash};let reads=0;
 const driver=new ApiDriver(snapshot,{client:{useConfig(){throw Error('LEGACY_LOCAL_CONFIG_MUST_NOT_RUN');}},videoReadback:{async readback(s,r){assert.deepEqual(s,snapshot);assert.equal(r.id,'900000003');reads++;return result;}}});
 assert.deepEqual(await driver.readback(snapshot,{id:'900000003'}),result);assert.equal(reads,1);
});

import {createServer} from 'node:http';
import {FacebookVideoReadback} from '../src/sites/facebook-video-readback.js';
import {digest} from '../src/sites/async-storage.js';
const videoId='900000003',fixtureToken='synthetic-not-a-real-token';
async function protocolFixture(t,{s=snapshot,jobId='synthetic-original-job',attemptId='synthetic-original-attempt'}={}){
 const expected={operation:'FACEBOOK_VIDEO_READBACK',workspace:s.workspace,account_id:s.accountId,operator_actor_id:s.operatorActorId,target_page_id:s.targetPageId,snapshot_hash:await digest(s),object_id:videoId};
 const state={calls:[],allow:true,grantPatch:null,response:null,token:fixtureToken,video:{id:videoId,from:{id:s.targetPageId},title:s.title,description:s.body,published:true,status:{video_status:'ready'},permalink_url:'https://www.facebook.com/'+s.targetPageId+'/videos/'+videoId+'/?tracking=discard'}};
 const server=createServer(async(req,res)=>{state.calls.push({method:req.method,url:req.url,authorization:req.headers.authorization});if(state.response&&await state.response(req,res))return;res.setHeader('content-type','application/json');res.end(JSON.stringify(new URL(req.url,'http://fixture').pathname.endsWith('/me')?{id:s.targetPageId}:state.video));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});const origin='http://127.0.0.1:'+server.address().port;
 const provider={async resolveReadback(binding){assert.deepEqual(binding,expected);return {...{binding:expected,job_id:jobId,attempt_id:attemptId,authorization_revision:'synthetic-existing-read-grant',expires_at:Date.now()+60000,api_version:'v25.0',credential:{kind:'PAGE_ACCESS_TOKEN',value:state.token}},...state.grantPatch};},async revalidateReadback(proof){assert.deepEqual(proof,{...expected,job_id:jobId,attempt_id:attemptId,authorization_revision:'synthetic-existing-read-grant'});return state.allow;}};
 const request=(url,init)=>{const u=new URL(url);assert.equal(u.origin,'https://graph.facebook.com');assert.equal(init.method,'GET');assert.equal(init.redirect,'error');assert.equal(u.searchParams.has('access_token'),false);return fetch(origin+u.pathname+u.search,init);};
 const adapter=new FacebookVideoReadback({provider,request}),read=()=>adapter.readback(s,{id:videoId});return {s,state,provider,request,adapter,read,expected,origin};
}
test('portable Graph protocol verifies Page and original video with bounded whitelisted evidence in original API driver',async t=>{
 const f=await protocolFixture(t),driver=new ApiDriver(f.s,{client:{useConfig(){throw Error('NO_LOCAL_ACCESS');}},videoReadback:f.adapter}),r=await driver.readback(f.s,{id:videoId});assert.equal(r.verified,true);assert.equal(r.mediaBytesVerified,false);assert.equal(r.readbackBinding.snapshot_hash,f.expected.snapshot_hash);assert.equal(r.readbackBinding.attempt_id,'synthetic-original-attempt');assert.equal(r.evidence_sha256,await digest(r.observation));assert.equal(r.url,'https://www.facebook.com/'+snapshot.targetPageId+'/videos/'+videoId+'/');assert.equal(f.state.calls.length,2);assert.ok(f.state.calls.every(c=>c.method==='GET'&&c.authorization==='Bearer '+fixtureToken&&!c.url.includes(fixtureToken)));assert.doesNotMatch(JSON.stringify(r),/synthetic-not-a-real-token|tracking=/);
});
test('provider unavailable, missing original receipt and wrong scope fail before any request',async t=>{
 let calls=0;await assert.rejects(new FacebookVideoReadback({request:()=>{calls++;}}).readback(snapshot,{id:videoId}),/READBACK_PROVIDER_UNAVAILABLE/);assert.equal(calls,0);
 const f=await protocolFixture(t);for(const id of [null,'','../me','1?access_token=bad'])await assert.rejects(f.adapter.readback(snapshot,{id}),/READBACK_INPUT_INVALID/);
 f.state.grantPatch={binding:{...f.expected,account_id:'other'}};await assert.rejects(f.read(),/READBACK_AUTHORITY_MISMATCH/);assert.equal(f.state.calls.length,0);
});
for(const change of ['owner','id','title','body','processing','unpublished','link-host','link-id','graph-error'])test('unconfirmed '+change+' never becomes a verified video or absence proof',async t=>{
 const f=await protocolFixture(t),v=f.state.video;if(change==='owner')v.from.id='999';if(change==='id')v.id='999';if(change==='title')v.title+='changed';if(change==='body')v.description='truncated';if(change==='processing')v.status.video_status='processing';if(change==='unpublished')v.published=false;if(change==='link-host')v.permalink_url='https://facebook.com.evil.invalid/videos/'+videoId;if(change==='link-id')v.permalink_url='https://www.facebook.com/reel/999';if(change==='graph-error')v.error={message:fixtureToken};
 await assert.rejects(f.read(),e=>{assert.equal(e.absenceProven,false);assert.equal(e.next_action,'RECONCILE_PENDING');assert.ok(!e.message.includes(fixtureToken));return /READBACK_/.test(e.message);});assert.equal(f.state.calls.length,2);
});
test('wrong actual Page identity stops before reading a video, with no alternative account lookup',async t=>{
 const f=await protocolFixture(t);f.state.response=async(req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({id:'999'}));return true;};await assert.rejects(f.read(),/READBACK_PAGE_MISMATCH/);assert.equal(f.state.calls.length,1);
});
for(const status of [401,403,404,429,500])test('HTTP '+status+' is one failed read, not absence, retry or token refresh',async t=>{
 const f=await protocolFixture(t);f.state.response=async(req,res)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:fixtureToken,paging:{next:'https://untrusted.invalid'}}}));return true;};await assert.rejects(f.read(),e=>{assert.equal(e.code,'READBACK_HTTP_'+status);assert.equal(e.absenceProven,false);return !e.message.includes(fixtureToken);});assert.equal(f.state.calls.length,1);
});
test('redirects never forward the bearer token to another endpoint',async t=>{
 const f=await protocolFixture(t);f.state.response=async(req,res)=>{res.writeHead(302,{location:f.origin+'/trap'});res.end();return true;};await assert.rejects(f.read(),/READBACK_TRANSPORT_UNAVAILABLE/);assert.equal(f.state.calls.length,1);
});
for(const bad of ['length','stream-limit','html','malformed','utf8','slow-body'])test('bounded response rejects '+bad,async t=>{
 const f=await protocolFixture(t);f.state.response=async(req,res)=>{res.setHeader('content-type',bad==='html'?'text/html':'application/json');if(bad==='length')res.setHeader('content-length','999999');if(bad==='length')res.end('{}');if(bad==='stream-limit'){res.write(' '.repeat(200));res.end(' '.repeat(200));}if(bad==='html')res.end('<html>');if(bad==='malformed')res.end('{broken');if(bad==='utf8')res.end(Buffer.from([0xff,0xff]));if(bad==='slow-body'){res.flushHeaders();res.write('{');}return true;};const reader=new FacebookVideoReadback({provider:f.provider,request:f.request,maxBytes:256,timeoutMs:200});await assert.rejects(reader.readback(snapshot,{id:videoId}),/READBACK_/);assert.equal(f.state.calls.length,1);
});
test('whole read deadline also bounds a transport/provider that ignores abort; no late success',async t=>{
 const f=await protocolFixture(t),never=()=>new Promise(()=>{});for(const adapter of [new FacebookVideoReadback({provider:f.provider,request:never,timeoutMs:20}),new FacebookVideoReadback({provider:{resolveReadback:never,revalidateReadback:never},request:f.request,timeoutMs:20})]){const start=performance.now();await assert.rejects(adapter.readback(snapshot,{id:videoId}),/READBACK_DEADLINE/);assert.ok(performance.now()-start<1000);}assert.equal(f.state.calls.length,0);
});
test('read-authority withdrawal during IO prevents success without treating content withdrawal as a read ban',async t=>{
 const f=await protocolFixture(t),base=f.request;const reader=new FacebookVideoReadback({provider:f.provider,request:async(u,i)=>{const r=await base(u,i);if(!new URL(u).pathname.endsWith('/me'))f.state.allow=false;return r;}});await assert.rejects(reader.readback(snapshot,{id:videoId}),/READBACK_AUTHORITY_CHANGED/);assert.equal(f.state.calls.length,2);
 f.state.allow=true;assert.equal((await f.read()).verified,true); // content approval is intentionally not this read-only grant
});
test('parallel client/account readers do not cache or mix token, Page, frozen version or receipt evidence',async t=>{
 const a=await protocolFixture(t),b=await protocolFixture(t,{s:{...snapshot,workspace:'SYNTHETIC-SECOND',accountId:'SYNTHETIC-SECOND',operatorActorId:'900000004',externalId:'900000004',targetPageId:'900000005'}});b.state.token='synthetic-second-token';const [ra,rb]=await Promise.all([a.read(),b.read()]);assert.notEqual(ra.readbackBinding.workspace,rb.readbackBinding.workspace);assert.notEqual(ra.pageId,rb.pageId);assert.ok(a.state.calls.every(c=>c.authorization==='Bearer '+fixtureToken));assert.ok(b.state.calls.every(c=>c.authorization==='Bearer synthetic-second-token'));
 await assert.rejects(a.adapter.readback({...snapshot,body:'Changed after freeze'},{id:videoId}),/READBACK_AUTHORITY_UNAVAILABLE/);assert.equal(a.state.calls.length,2);
});

test('provider exceptions and expired grants cannot leak secrets or start HTTP',async t=>{
 const f=await protocolFixture(t);f.state.grantPatch={expires_at:Date.now()-1};await assert.rejects(f.read(),/READBACK_AUTHORITY_MISMATCH/);f.provider.resolveReadback=()=>{throw Error(fixtureToken);};await assert.rejects(f.read(),e=>e.code==='READBACK_AUTHORITY_UNAVAILABLE'&&!e.message.includes(fixtureToken));assert.equal(f.state.calls.length,0);
});
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../src/store.js';
import {UnifiedPublisher} from '../src/unified-publisher.js';
import {UnifiedExecutor} from '../src/unified-executor.js';
import {BrowserResources} from '../src/browser-resources.js';
import {syntheticVideo} from './fixtures/synthetic-video.js';
test('original UNKNOWN job survives failed protocol read and restart; exact readback persists once with no submit',async t=>{
 const root=mkdtempSync(join(tmpdir(),'v3-readback-')),path=join(root,'publisher.sqlite');let store=new Store(path,{seedDemo:false}),publisher=new UnifiedPublisher(store);t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 const workspace=store.saveWorkspace({name:'Synthetic protocol client',content_root:root}),profile=store.saveProfile(workspace.id,{name:'Synthetic resource only',cdp_port:19981,user_data_dir:join(root,'profile')}),account=publisher.saveAccount(workspace.id,{display_name:'Synthetic Page',expected_identity:'Synthetic Page',identity_type:'PAGE',external_id:snapshot.externalId,operator_actor_id:snapshot.operatorActorId,target_page_id:snapshot.targetPageId,profile_id:profile.id}),file=join(root,'video.mp4');writeFileSync(file,syntheticVideo());
 const content=publisher.importContent(workspace.id,{source_id:'SYNTHETIC-READBACK',revision:'r1',title:snapshot.title,body:snapshot.body,media:[file]}),job=publisher.createPageJob(workspace.id,{account_id:account.id,content_id:content.id}),f=await protocolFixture(t,{s:job.snapshot,jobId:job.id,attemptId:'synthetic-persisted-attempt'});let submits=0;
 const resolve=f.provider.resolveReadback,revalidate=f.provider.revalidateReadback;
 const original=()=>{const j=publisher.job(workspace.id,job.id),r=store.db.prepare('SELECT platform_id FROM publisher_submit_receipts WHERE job_id=?').get(j.id);return ['UNKNOWN','PUBLISHED'].includes(j.state)&&j.attempt_id==='synthetic-persisted-attempt'&&j.snapshot_hash===f.expected.snapshot_hash&&r?.platform_id===videoId;};
 f.provider.resolveReadback=async b=>{assert.equal(original(),true);return resolve(b);};f.provider.revalidateReadback=async p=>original()&&await revalidate(p);
 const drivers={create:async s=>{const d=new ApiDriver(s,{client:{useConfig(){throw Error('NO_LOCAL_CONFIG');},async close(){}},videoReadback:f.adapter});d.submit=()=>{submits++;throw Error('FORBIDDEN_SUBMIT');};return d;}};
 const makeExecutor=()=>new UnifiedExecutor(publisher,{enabled:false,drivers,resources:new BrowserResources(join(root,'locks')),mediaRoots:[root],snapshotRoot:join(root,'snapshots')});let executor=makeExecutor();executor.freezeMedia(job);
 store.db.prepare("UPDATE publisher_jobs SET state='UNKNOWN',attempt_id=? WHERE id=?").run('synthetic-persisted-attempt',job.id);store.db.prepare('INSERT INTO publisher_submit_intents VALUES(?,?,?,?,?,?)').run(job.id,'synthetic-persisted-attempt',job.snapshot.transport,job.snapshot_hash,'{}',new Date().toISOString());store.db.prepare('INSERT INTO publisher_submit_receipts VALUES(?,?,?,?,?)').run(job.id,videoId,'','{}',new Date().toISOString());
 f.state.response=async(req,res)=>{res.writeHead(503,{'content-type':'application/json'});res.end('{}');return true;};await assert.rejects(executor.reconcile(workspace.id,job.id),/READBACK_HTTP_503/);assert.equal(publisher.job(workspace.id,job.id).state,'UNKNOWN');assert.equal(submits,0);
 store.close();store=new Store(path,{seedDemo:false});publisher=new UnifiedPublisher(store);executor=makeExecutor();f.state.response=null;const result=await executor.reconcile(workspace.id,job.id);assert.equal(result.state,'PUBLISHED');assert.equal(result.attempt_id,'synthetic-persisted-attempt');assert.equal(result.evidence.readbackBinding.job_id,job.id);assert.doesNotMatch(JSON.stringify(result.evidence),/synthetic-not-a-real-token/);await assert.rejects(executor.reconcile(workspace.id,job.id));assert.equal(submits,0);assert.equal(store.db.prepare('SELECT count(*) n FROM publisher_submit_intents').get().n,1);assert.equal(store.db.prepare('SELECT count(*) n FROM publisher_submit_receipts').get().n,1);
});

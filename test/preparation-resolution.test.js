import {matchesRetainedFacebookPublication} from '../src/facebook-preparation-duplicate.js';
import test from 'node:test';
import {Readable} from 'node:stream';
import {createApp} from '../src/server.js';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {Store} from '../src/store.js';
import {UnifiedPublisher} from '../src/unified-publisher.js';
import {UnifiedExecutor} from '../src/unified-executor.js';
import {BrowserResources} from '../src/browser-resources.js';
async function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'prep-resolution-')),store=new Store(join(root,'db.sqlite'),{seedDemo:false}),publisher=new UnifiedPublisher(store);t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 const ws=store.saveWorkspace({name:'Client',content_root:root}),profile=store.saveProfile(ws.id,{name:'Chrome',cdp_port:19990,user_data_dir:join(root,'profile')});mkdirSync(profile.user_data_dir);
 const account=publisher.saveAccount(ws.id,{display_name:'Page',expected_identity:'Page',identity_type:'PAGE',external_id:'12345',operator_actor_id:'12345',target_page_id:'98765',profile_id:profile.id}),image=join(root,'old.png');writeFileSync(image,Buffer.from([137,80,78,71,13,10,26,10,1]));
 const content=publisher.importContent(ws.id,{source_id:'old',revision:'1',body:'Old frozen body',media:[image]}),job=publisher.createPageJob(ws.id,{account_id:account.id,content_id:content.id});let calls=0;
 const driver={async prepare(s,a,onWrite){calls++;onWrite();throw Error('trial interrupted');},failureEvidence(){return {phase:'READINESS',finalClickAttempted:false,composerRetained:true};},submit(){throw Error('submit forbidden');},async close(){}};
 const executor=new UnifiedExecutor(publisher,{enabled:true,resources:new BrowserResources(join(root,'locks')),drivers:{create:async()=>driver},mediaRoots:[root],snapshotRoot:join(root,'snapshots')});executor.approve(ws.id,job.id,job.snapshot_hash);await assert.rejects(()=>executor.execute(ws.id,job.id));
 // Seed the pre-fix interrupted-preparation shape. New live failures are
 // BLOCKED immediately; this recovery endpoint remains for legacy UNKNOWNs.
 const legacy=publisher.job(ws.id,job.id).evidence;delete legacy.preparationFailure;delete legacy.preparationEffectsMayRemain;
 store.db.prepare("UPDATE publisher_jobs SET state='UNKNOWN',evidence_json=? WHERE id=?").run(JSON.stringify(legacy),job.id);
 executor.resources.acquire(profile.user_data_dir,'operator:'+profile.id,()=>true)();
 const current=()=>publisher.job(ws.id,job.id),request={acknowledge_preparation_effects:true,expected_attempt_id:current().attempt_id,snapshot_hash:job.snapshot_hash},lease=join(root,'locks',createHash('sha256').update(realpathSync(profile.user_data_dir)).digest('hex'),'owner.json');
 const history=()=>JSON.stringify(['publisher_execution_permits','publisher_execution_permit_events','publisher_prepare_intents','publisher_submit_intents','publisher_submit_receipts','publisher_job_assets'].map(table=>store.db.prepare(`SELECT * FROM ${table}`).all()));
 return {root,store,publisher,ws,profile,account,job,content,executor,current,request,lease,history,get calls(){return calls;}};
}
test('exact interrupted preparation resolves once to review-blocked, retains assets/audit and protects old content while freeing other content',async t=>{
 const f=await fixture(t),before=f.history(),evidence=f.current().evidence,assets=f.store.db.prepare('SELECT * FROM publisher_job_assets').all(),oldBytes=readFileSync(assets[0].path);
 const r=await f.executor.resolvePreparation(f.ws.id,f.job.id,f.request);assert.equal(r.state,'BLOCKED');assert.equal(r.evidence.preparationEffectsMayRemain,true);assert.deepEqual(r.evidence.browserDiagnostics,evidence.browserDiagnostics);assert.equal(r.evidence.error,evidence.error);assert.equal(r.attempt_id,f.request.expected_attempt_id);assert.equal(r.snapshot_hash,f.request.snapshot_hash);assert.equal(f.history(),before);assert.deepEqual(readFileSync(assets[0].path),oldBytes);assert.equal(f.calls,1);
 assert.deepEqual(await f.executor.resolvePreparation(f.ws.id,f.job.id,f.request),r);assert.equal(f.store.db.prepare("SELECT count(*) n FROM events WHERE event='publisher_preparation_resolved'").get().n,1);assert.throws(()=>f.executor.reopen(f.ws.id,f.job.id),/准备副作用/);
 assert.throws(()=>f.publisher.createPageJob(f.ws.id,{account_id:f.account.id,content_id:f.content.id}),/相同(目标|实际)/);
 f.publisher.finish(f.ws.id,f.job.id);assert.throws(()=>f.publisher.createPageJob(f.ws.id,{account_id:f.account.id,content_id:f.content.id}),/相同(目标|实际)/);
 const newImage=join(f.root,'new.png');writeFileSync(newImage,Buffer.from([137,80,78,71,13,10,26,10,2]));const content=f.publisher.importContent(f.ws.id,{source_id:'new',revision:'1',body:'Different article',media:[newImage]}),next=f.publisher.createPageJob(f.ws.id,{account_id:f.account.id,content_id:content.id});f.executor.approve(f.ws.id,next.id,next.snapshot_hash);assert.doesNotThrow(()=>f.executor.assertClaimable(f.publisher.job(f.ws.id,next.id)));
 const nextAssets=f.store.db.prepare('SELECT * FROM publisher_job_assets WHERE job_id=?').all(next.id);assert.notEqual(nextAssets[0].path,assets[0].path);assert.notEqual(nextAssets[0].sha256,assets[0].sha256);assert.equal(f.calls,1);
});
test('stale requests, uncertain final click, submit intent/receipt and non-PREPARING evidence cannot resolve',async t=>{
 for(const kind of ['attempt','hash','missing-final','final-true','stage','submission-unknown','submit-intent','receipt','missing-prepare'])await t.test(kind,async t=>{
  const f=await fixture(t),request={...f.request},e=f.current().evidence;
  if(kind==='attempt')request.expected_attempt_id='stale';if(kind==='hash')request.snapshot_hash='stale';if(kind==='missing-final')delete e.browserDiagnostics.finalClickAttempted;if(kind==='final-true')e.browserDiagnostics.finalClickAttempted=true;if(kind==='stage')e.stage='SUBMITTING';if(kind==='submission-unknown')delete e.submissionIntent;
  f.store.db.prepare('UPDATE publisher_jobs SET evidence_json=? WHERE id=?').run(JSON.stringify(e),f.job.id);
  if(kind==='submit-intent')f.store.db.prepare('INSERT INTO publisher_submit_intents VALUES(?,?,?,?,?,?)').run(f.job.id,f.request.expected_attempt_id,'BROWSER',f.job.snapshot_hash,'{}','time');if(kind==='receipt')f.store.db.prepare('INSERT INTO publisher_submit_receipts VALUES(?,?,?,?,?)').run(f.job.id,'post','url','{}','time');if(kind==='missing-prepare')f.store.db.prepare('DELETE FROM publisher_prepare_intents WHERE job_id=?').run(f.job.id);
  const before=f.history(),lease=readFileSync(f.lease);await assert.rejects(()=>f.executor.resolvePreparation(f.ws.id,f.job.id,request));assert.equal(f.current().state,'UNKNOWN');assert.equal(f.history(),before);assert.deepEqual(readFileSync(f.lease),lease);assert.equal(f.calls,1);
 });
});
test('active executor, persisted execution, diagnostic and readback lease conflicts block resolution',async t=>{
 for(const kind of ['active','execution','diagnostic','readback','lease-active','lease-owner'])await t.test(kind,async t=>{
  const f=await fixture(t);if(kind==='active')f.executor.active.add(f.profile.id);if(kind==='execution')f.store.db.prepare("UPDATE publisher_jobs SET state='PREPARING' WHERE id=?").run(f.job.id);
  if(kind==='diagnostic'){f.store.db.exec('CREATE TABLE publisher_composer_observations(job_id TEXT,state TEXT)');f.store.db.prepare('INSERT INTO publisher_composer_observations VALUES(?,?)').run(f.job.id,'RUNNING');}
  if(kind==='readback')mkdirSync(join(f.lease,'..','readback'));if(kind.startsWith('lease-')){const o=JSON.parse(readFileSync(f.lease));if(kind==='lease-active')o.phase='ACTIVE';else o.owner='operator:other';writeFileSync(f.lease,JSON.stringify(o));}
  const state=f.current().state,before=f.history(),lease=readFileSync(f.lease);await assert.rejects(()=>f.executor.resolvePreparation(f.ws.id,f.job.id,f.request));assert.equal(f.current().state,state);assert.equal(f.history(),before);assert.deepEqual(readFileSync(f.lease),lease);
 });
});
test('transaction reread blocks a raced submit intent and rolls back state if audit persistence fails',async t=>{
 for(const kind of ['intent-race','audit-failure'])await t.test(kind,async t=>{
  const f=await fixture(t),acquire=f.executor.acquireResources.bind(f.executor);if(kind==='intent-race')f.executor.acquireResources=(...args)=>{const release=acquire(...args);f.store.db.prepare('INSERT INTO publisher_submit_intents VALUES(?,?,?,?,?,?)').run(f.job.id,f.request.expected_attempt_id,'BROWSER',f.job.snapshot_hash,'{}','time');return release;};else f.store.event=()=>{throw Error('audit unavailable');};
  await assert.rejects(()=>f.executor.resolvePreparation(f.ws.id,f.job.id,f.request));assert.equal(f.current().state,'UNKNOWN');assert.equal(f.current().evidence.preparationResolution,undefined);assert.equal(f.executor.active.size,0);assert.equal(existsSync(f.lease),true);assert.equal(existsSync(join(f.lease,'..','readback')),false);
 });
});

test('existing recovery HTTP entry requires administrator CSRF and exact attempt/hash',async t=>{
 const f=await fixture(t),cloud={mode:'mac-tunnel',executionConnected:true,host:'publisher.vietbridge.one',origin:'https://publisher.vietbridge.one',user:'fixture',password:'disposable-test-password',dataDir:f.root,accessFile:join(f.root,'access.json')};
 const server=createApp(join(f.root,'db.sqlite'),{unified:true,cloud,resources:f.executor.resources,executionEnabled:false,library:{roots:[f.root],gptInboxBase:null},drivers:{create:async()=>{throw Error('no browser connection allowed');}}});t.after(()=>server.close());
 const auth={authorization:'Basic '+Buffer.from(cloud.user+':'+cloud.password).toString('base64')},url=`/api/unified/workspaces/${f.ws.id}/jobs/${f.job.id}/resolve-preparation`;
 async function call(url,body,headers={}){const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);Object.assign(req,{url,method:body===undefined?'GET':'POST',headers:{host:cloud.host,...headers}});let status=200,text='';const res={setHeader(){},writeHead(n){status=n;},end(s=''){text+=s;}};await server.listeners('request')[0](req,res);return {status,data:JSON.parse(text)};}
 const before=f.history();assert.equal((await call(url,f.request)).status,401);assert.equal((await call(url,f.request,auth)).status,409);const state=(await call('/api/state',undefined,auth)).data,headers={...auth,origin:cloud.origin,'content-type':'application/json','x-local-token':state.token};
 assert.equal((await call(url,f.request,{...headers,origin:'https://evil.example'})).status,409);assert.equal((await call(url,{acknowledge_preparation_effects:true},headers)).status,409);assert.equal(f.current().state,'UNKNOWN');assert.equal(f.history(),before);
 assert.equal((await call(url,f.request,headers)).status,200);assert.equal(f.current().state,'BLOCKED');assert.equal((await call(url,f.request,headers)).status,200);assert.equal(f.history(),before);assert.equal(f.store.db.prepare("SELECT count(*) n FROM events WHERE event='publisher_preparation_resolved'").get().n,1);
});

test('unused Facebook image metadata and relocated identical bytes cannot bypass retained publication guard at create or claim',async t=>{
 const f=await fixture(t),payloads=[{title:'Only bookkeeping title'},{tags:['Bookkeeping']},{author:'Bookkeeping author'}];
 // Precreated jobs exist before recovery and must be fenced at claim afterwards.
 const pending=payloads.map(payload=>f.publisher.createPageJob(f.ws.id,{account_id:f.account.id,content_id:f.content.id,payload}));for(const j of pending)f.executor.approve(f.ws.id,j.id,j.snapshot_hash);
 const copied=join(f.root,'relocated.png');writeFileSync(copied,readFileSync(f.job.snapshot.media[0]));const relocated=f.publisher.importContent(f.ws.id,{source_id:'relocated',revision:'1',body:f.job.snapshot.body,media:[copied]});const pendingCopy=f.publisher.createPageJob(f.ws.id,{account_id:f.account.id,content_id:relocated.id,payload:{title:'New bookkeeping title'}});f.executor.approve(f.ws.id,pendingCopy.id,pendingCopy.snapshot_hash);
 await f.executor.resolvePreparation(f.ws.id,f.job.id,f.request);
 for(const payload of payloads)assert.throws(()=>f.publisher.createPageJob(f.ws.id,{account_id:f.account.id,content_id:f.content.id,payload}),/实际正文与媒体/);
 assert.throws(()=>f.publisher.createPageJob(f.ws.id,{account_id:f.account.id,content_id:relocated.id,payload:{title:'Yet another title'}}),/实际正文与媒体/);
 for(const j of [...pending,pendingCopy]){assert.throws(()=>f.executor.assertClaimable(f.publisher.job(f.ws.id,j.id)),/实际正文与媒体/);assert.throws(()=>f.executor.claim(f.ws.id,j.id),/实际正文与媒体/);assert.equal(f.publisher.job(f.ws.id,j.id).state,'READY');}
 assert.equal(f.calls,1);assert.equal(f.store.db.prepare('SELECT count(*) n FROM publisher_submit_intents').get().n,0);
});

test('actual video title participates while missing retained asset evidence fails closed',()=>{
 const snapshot={platform:'facebook',targetPageId:'98765',body:'Frozen body',title:'Actual video title',media:['old.mp4']},row={id:'old',snapshot,evidence:{preparationResolution:{},preparationEffectsMayRemain:true}},db={prepare(){return {all:()=>[{sha256:'a'.repeat(64)}]};}};
 assert.equal(matchesRetainedFacebookPublication(db,row,{...snapshot,media:['relocated.mp4']},'new'),true);assert.equal(matchesRetainedFacebookPublication(db,row,{...snapshot,title:'Different actual title'},'new'),false);
 assert.throws(()=>matchesRetainedFacebookPublication({prepare(){return {all:()=>[]};}},row,snapshot,'new'),/MEDIA_EVIDENCE_INCOMPLETE/);
});

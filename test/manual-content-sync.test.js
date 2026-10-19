import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,chmodSync,symlinkSync,mkdirSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {fixture,image} from './helpers/manual-sync-fixture.js';
import {ContentSyncOnce} from '../maintenance/content-sync-once.mjs';
import {loadMaintenanceConfig} from '../maintenance/scoped-config.mjs';
import {createControlledApp} from '../maintenance/controlled-app.mjs';

test('manual policy requires original zero-scope private configuration, bounded expiry and real approval reference',t=>{
 const f=fixture(t),file=join(f.root,'policy.json');writeFileSync(file,JSON.stringify(f.authorization),{mode:0o600});
 assert.deepEqual(loadMaintenanceConfig(undefined,undefined,undefined,file).manualContentSync,f.authorization);
 assert.throws(()=>loadMaintenanceConfig('/unused-scoped-policy',undefined,undefined,file),/MANUAL_SYNC_REQUIRES_ZERO_SCOPE/);
 chmodSync(file,0o644);assert.throws(()=>loadMaintenanceConfig(undefined,undefined,undefined,file),/0600/);chmodSync(file,0o600);
 symlinkSync(file,join(f.root,'policy-link'));assert.throws(()=>loadMaintenanceConfig(undefined,undefined,undefined,join(f.root,'policy-link')),/PRIVATE_AUTHORIZATION/);
 for(const patch of [{operation:'PUBLISH'},{approval_message_id:'<MISSING>'},{expires_at:f.authorization.issued_at+86400001}])assert.throws(()=>new ContentSyncOnce(()=>f.sync,{...f.authorization,...patch},f.root),/AUTHORIZATION_INVALID/);
 assert.throws(()=>createControlledApp(()=>{},f.dbPath,{config:{version:1,manualContentSync:f.authorization},head:'a'.repeat(40),cloud:f.cloud}),/REQUIRES_ZERO_SCOPE/);
});

test('without manual policy maintenance preserves sources and permits only validated local preparation, never sync or platform execution',async t=>{
 const f=fixture(t),m=await f.mount({policy:null});const status=await(await m.get('/api/content-sync?workspace='+f.ws.id+'&accountId='+f.account.id)).json();
 assert.equal(status.enabled,true);assert.equal(status.manualPermission.canRun,false);assert.equal(status.automatic,false);
 assert.equal((await m.post('/api/content-sync/run')).status,423);
 assert.equal((await m.post('/api/unified/workspaces/'+f.ws.id+'/jobs')).status,409);assert.equal((await m.post('/api/unified/workspaces/'+f.ws.id+'/jobs/fixture/execute')).status,423);
 assert.equal(f.calls(),0);assert.equal(f.submissions(),0);
});

test('admin, CSRF, origin, exact workspace/account and exact body are checked before one attempt or download',async t=>{
 const f=fixture(t),m=await f.mount(),input={workspace:f.ws.id,account_id:f.account.id};
 const cases=[['/api/content-sync/run',input,{authorization:''},401],['/api/content-sync/run',input,{'x-local-token':''},409],['/api/content-sync/run',input,{origin:'https://evil.example'},409],['/api/content-sync/run',{...input,workspace:'ws-wrong'},{},409],['/api/content-sync/run',{...input,account_id:'wrong-account'},{},409],['/api/content-sync/run',{...input,source:'arbitrary-source'},{},409],['/api/content-sync/run?override=1',input,{},409],['/api/content-sync/run',input,{authorization:'Bearer '+m.appToken()},403]];
 for(const [path,body,extra,status] of cases)assert.equal((await m.post(path,body,extra)).status,status,path);
 assert.equal(f.calls(),0);assert.equal(existsSync(join(f.root,'manual-content-sync')),false);
 const health=await(await m.get('/api/health')).json();assert.equal(health.executionEnabled,false);assert.equal(health.scanSchedulerEnabled,false);
});

test('missing source, connector and changed source identity refuse before any attempt',async t=>{
 for(const mode of ['missing','no-connector','wrong-project','wrong-manifest','wrong-root']){
  const f=fixture(t),policy=structuredClone(f.authorization);let sources=[f.source],factory=f.makeClient;
  if(mode==='missing')sources=[];if(mode==='no-connector')factory=undefined;if(mode==='wrong-project')policy.scope.project_id='WRONG';if(mode==='wrong-manifest')policy.scope.manifest_drive_file_id='other-manifest';if(mode==='wrong-root'){policy.scope.source_root=join(f.root,'other-root');mkdirSync(policy.scope.source_root);}
  const m=await f.mount({policy,sources,factory:mode==='no-connector'?null:factory});assert.equal((await m.post('/api/content-sync/run')).status,409,mode);assert.equal(f.calls(),0,mode);assert.equal(existsSync(join(f.root,'manual-content-sync')),false,mode);
 }
});

test('disabled account and second physical directory owner cannot receive source data',async t=>{
 const f=fixture(t),m=await f.mount();f.store.db.prepare('UPDATE facebook_accounts SET enabled=0 WHERE id=?').run(f.account.id);assert.equal((await m.post('/api/content-sync/run')).status,409);f.store.db.prepare('UPDATE facebook_accounts SET enabled=1 WHERE id=?').run(f.account.id);
 f.store.saveWorkspace({name:'Other owner',content_root:f.client});assert.equal((await m.post('/api/content-sync/run')).status,409);assert.equal(f.calls(),0);
 const g=fixture(t),alias=join(g.root,'root-alias');symlinkSync(g.client,alias,'dir');g.sync.binding=()=>g.source;g.sync.store={list:()=>[{id:g.ws.id,content_root:g.client},{id:'ws-other',content_root:alias}]};const once=new ContentSyncOnce(()=>g.sync,g.authorization,g.root);assert.throws(()=>once.bound(),/UNIQUE_OWNER_REQUIRED/);
});

test('one successful run reads only exact registered source, discovers data and preserves all publication history',async t=>{
 const f=fixture(t);f.add('GOOD-001','Fixture public copy');const old=f.publisher.importContent(f.ws.id,{source_id:'old-draft',revision:'1',body:'Frozen old',media:[]}),job=f.publisher.createPageJob(f.ws.id,{content_id:old.id,account_id:f.account.id});f.store.db.prepare("UPDATE publisher_jobs SET state='UNKNOWN',attempt_id='retained-attempt' WHERE id=?").run(job.id);const before=f.store.db.prepare('SELECT * FROM publisher_jobs').all();
 const m=await f.mount(),r=await m.post('/api/content-sync/run');assert.equal(r.status,200,await r.clone().text());const s=await r.json();assert.equal(s.automatic,false);assert.equal(s.publicationSideEffects,false);assert.equal(s.manualPermission.canRun,false);assert.ok(s.lastCompletedAt);assert.equal(s.lastResult[0].items,1);assert.equal(f.library.catalogue(f.ws.id,'',true)[0].body,'Fixture public copy');
 assert.deepEqual(f.store.db.prepare('SELECT * FROM publisher_jobs').all(),before);assert.equal(f.store.db.prepare('SELECT count(*) n FROM publisher_submit_intents').get().n,0);assert.equal(f.submissions(),0);assert.equal((await m.post('/api/content-sync/run')).status,409);assert.equal(f.calls(),3);
 await m.close();const second=await f.mount({policy:{...f.authorization,id:'changed-id',expires_at:f.authorization.expires_at+1000}});assert.equal((await second.post('/api/content-sync/run')).status,409);assert.equal(f.calls(),3);
});

test('overlapping duplicate request never starts another download or coalesces an unrelated source run',async t=>{
 const f=fixture(t);let release;const factory=async()=>({downloadRaw:()=>new Promise(r=>{release=r;})});const m=await f.mount({factory});const first=m.post('/api/content-sync/run');for(let i=0;i<30&&!release;i++)await new Promise(r=>setTimeout(r,5));assert.ok(release);assert.equal((await m.post('/api/content-sync/run')).status,409);release(Buffer.from(JSON.stringify(f.manifest)));assert.equal((await first).status,200);
 const g=fixture(t);g.sync.inflight.set(g.ws.id,Promise.resolve());const once=new ContentSyncOnce(()=>g.sync,g.authorization,g.root);assert.throws(()=>once.check(g.ws.id,g.account.id,{workspace:g.ws.id,account_id:g.account.id}),/SOURCE_ACTIVE/);
});

test('connector failure remains sanitized and consumed, without fabricated completion or retry',async t=>{
 const f=fixture(t),m=await f.mount({factory:async()=>{throw Error('private secret fixture failure');}}),r=await m.post('/api/content-sync/run');assert.equal(r.status,409);assert.equal((await r.json()).error,'CONTENT_SYNC_FAILED');const state=await(await m.get('/api/content-sync?workspace='+f.ws.id+'&accountId='+f.account.id)).json();assert.equal(state.manualPermission.canRun,false);assert.ok(!state.lastCompletedAt);assert.ok(!JSON.stringify(state).includes('private secret'));assert.equal((await m.post('/api/content-sync/run')).status,409);assert.equal(f.calls(),0);
});

test('bad new revision does not overwrite old body or old draft while healthy new content stays readable',async t=>{
 const f=fixture(t);f.add('OLD-001','Old readable');await f.sync.run(f.ws.id,f.account.id);const oldRow=f.library.catalogue(f.ws.id)[0],[content]=f.library.import(f.ws.id,[{key:oldRow.key,revision:oldRow.revision}]),job=f.publisher.createPageJob(f.ws.id,{account_id:f.account.id,content_id:content.id});const frozen=JSON.stringify(job.snapshot),hash=job.snapshot_hash;
 f.files.set('OLD-001-body',Buffer.from('---\npublish_caption: Half update\n---\n# Fixture'));f.files.delete('OLD-001-image');f.add('NEW-002','Healthy new');f.manifest.items.push(null);f.manifest.manifest_revision=2;
 const m=await f.mount(),r=await m.post('/api/content-sync/run');assert.equal(r.status,200);const status=await r.json();assert.ok(status.lastResult[0].errors.length);const rows=f.library.catalogue(f.ws.id,'',true);assert.equal(rows.find(x=>x.articleId==='NEW-002').body,'Healthy new');assert.equal(rows.find(x=>x.articleId==='OLD-001').ready,false);assert.ok(readFileSync(oldRow.sourcePath,'utf8').includes('Old readable'));assert.equal(f.publisher.job(f.ws.id,job.id).snapshot_hash,hash);assert.equal(JSON.stringify(f.publisher.job(f.ws.id,job.id).snapshot),frozen);assert.ok(readFileSync(JSON.parse(content.media_json)[0]).equals(image));assert.equal(status.publicationSideEffects,false);
});

test('policy expiration during reads stops file commit and leaves old library version intact',async t=>{
 const f=fixture(t);f.add('OLD-001','Old');await f.sync.run(f.ws.id,f.account.id);const before=readFileSync(join(f.client,'publisher-manifest.json'));f.add('NEW-002','Do not read after expiration');let guardedReads=0;let clock=f.authorization.issued_at+1000;const once=new ContentSyncOnce(()=>f.sync,f.authorization,f.root,{now:()=>clock});f.sync.workers.get(f.ws.id).drive={downloadRaw:async id=>{guardedReads++;if(id===f.source.manifestDriveFileId)return Buffer.from(JSON.stringify(f.manifest));clock=f.authorization.expires_at+1;return f.files.get(id);}};
 await assert.rejects(once.run(f.ws.id,f.account.id),/MANUAL_SYNC_AUTHORIZATION_INVALID/);assert.ok(readFileSync(join(f.client,'publisher-manifest.json')).equals(before));assert.equal(f.sync.status(f.ws.id,f.account.id).error,'MANUAL_SYNC_AUTHORIZATION_INVALID');assert.equal(once.capability().canRun,false);assert.equal(guardedReads,2,'only manifest and first body read; no image or later item after expiry');
});


test('expired policy, corrupt/private marker and account capability fail closed before download',async t=>{
 const f=fixture(t),once=new ContentSyncOnce(()=>f.sync,f.authorization,f.root);
 assert.equal(once.capability(f.ws.id,'different-account').canRun,false);
 const expired=new ContentSyncOnce(()=>f.sync,{...f.authorization,issued_at:Date.now()-2000,expires_at:Date.now()-1000},f.root);assert.equal(expired.capability().canRun,false);assert.throws(()=>expired.check(f.ws.id,f.account.id,{workspace:f.ws.id,account_id:f.account.id}),/AUTHORIZATION_INVALID/);assert.equal(existsSync(join(f.root,'manual-content-sync')),false);
 mkdirSync(once.directory,{mode:0o700});writeFileSync(once.marker,'invalid private fixture',{mode:0o600});assert.equal(once.capability().reason,'MANUAL_SYNC_PRIVATE_STATE_REQUIRED');
 writeFileSync(once.marker,JSON.stringify({stage:'DONE'}));chmodSync(once.marker,0o644);assert.equal(once.capability().reason,'MANUAL_SYNC_PRIVATE_STATE_REQUIRED');assert.equal(f.calls(),0);
});

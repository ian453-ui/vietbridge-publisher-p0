import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync,writeFileSync,mkdirSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {fixture} from './helpers/manual-sync-fixture.js';
import {ContentSyncOnce} from '../maintenance/content-sync-once.mjs';

const authCodes=['GOOGLE_DRIVE_NOT_AUTHORIZED','GOOGLE_DRIVE_AUTH_EXPIRED','GOOGLE_DRIVE_ACCESS_TOKEN_MISSING','GOOGLE_TOKEN_HTTP_429','GOOGLE_TOKEN_HTTP_503','GOOGLE_DRIVE_DOWNLOAD_HTTP_401','GOOGLE_DRIVE_DOWNLOAD_HTTP_403'];
const stages=['manifest','body','image'];
const marker=f=>JSON.parse(readFileSync(join(f.root,'manual-content-sync',readdirSync(join(f.root,'manual-content-sync')).find(x=>x.endsWith('.json'))),'utf8'));

async function prepared(t){
 const f=fixture(t);f.add('OLD-001','Old readable');await f.sync.run(f.ws.id,f.account.id);
 const oldRow=f.library.catalogue(f.ws.id)[0],[content]=f.library.import(f.ws.id,[{key:oldRow.key,revision:oldRow.revision}]);
 const job=f.publisher.createPageJob(f.ws.id,{account_id:f.account.id,content_id:content.id});f.store.db.prepare("UPDATE publisher_jobs SET state='UNKNOWN',attempt_id='frozen-fixture-attempt' WHERE id=?").run(job.id);
 const before=readFileSync(join(f.client,'publisher-manifest.json')),jobs=f.store.db.prepare('SELECT * FROM publisher_jobs').all(),media=JSON.parse(content.media_json).map(path=>({path,bytes:readFileSync(path)}));
 f.files.set('OLD-001-body',Buffer.from('---\npublish_caption: New unseen body\n---\n# Fixture'));f.manifest.manifest_revision=2;f.add('NEW-002','Must not read after fatal failure');
 return {...f,before,jobs,media};
}

function stageId(f,stage){return stage==='manifest'?f.source.manifestDriveFileId:'OLD-001-'+stage;}
async function assertFailure(f,m,response,reads,expectedCode,expectedReads){
 assert.equal(response.status,409);assert.equal((await response.json()).error,expectedCode);
 const persisted=marker(f);assert.equal(persisted.stage,'BLOCKED');assert.equal(persisted.error,expectedCode);
 const status=await(await m.get('/api/content-sync?workspace='+f.ws.id+'&accountId='+f.account.id)).json();
 assert.equal(status.error,expectedCode);assert.equal(status.lastError,expectedCode);assert.equal(status.lastCompletedAt,null);assert.equal(status.manualPermission.canRun,false);assert.equal(status.automatic,false);assert.equal(status.publicationSideEffects,false);
 assert.equal(reads.length,expectedReads);assert.ok(readFileSync(join(f.client,'publisher-manifest.json')).equals(f.before));assert.deepEqual(f.store.db.prepare('SELECT * FROM publisher_jobs').all(),f.jobs);for(const {path,bytes} of f.media)assert.ok(readFileSync(path).equals(bytes));
 assert.equal(f.submissions(),0);assert.equal(f.store.db.prepare('SELECT count(*) n FROM publisher_submit_intents').get().n,0);
 assert.equal((await m.post('/api/content-sync/run')).status,409);assert.equal(reads.length,expectedReads);
 await m.close();const restarted=await f.mount({policy:{...f.authorization,id:'replacement-id',expires_at:f.authorization.expires_at+1000}});assert.equal((await restarted.post('/api/content-sync/run')).status,409);assert.equal(reads.length,expectedReads);
}

for(const stage of stages)for(const errorCode of authCodes)test(`fatal ${errorCode} during ${stage} is BLOCKED once, preserves old manifest and stops reads`,async t=>{
 const f=await prepared(t),reads=[],target=stageId(f,stage);
 const factory=async()=>({downloadRaw:async id=>{reads.push(id);if(id===target)throw Error(errorCode);return id===f.source.manifestDriveFileId?Buffer.from(JSON.stringify(f.manifest)):f.files.get(id);}});
 const m=await f.mount({factory});await assertFailure(f,m,await m.post('/api/content-sync/run'),reads,errorCode,stages.indexOf(stage)+1);
});

const bindingCases=[
 ['account disabled','manifest',f=>f.store.db.prepare('UPDATE facebook_accounts SET enabled=0 WHERE id=?').run(f.account.id),'MANUAL_SYNC_BINDING_INVALID'],
 ['workspace root changed','body',f=>{const other=join(f.root,'clients','other');mkdirSync(other);f.store.saveWorkspace({id:f.ws.id,name:'Fixture',content_root:other});},'MANUAL_SYNC_BINDING_INVALID'],
 ['second owner added','image',f=>f.store.saveWorkspace({name:'Second owner',content_root:f.client}),'MANUAL_SYNC_BINDING_INVALID'],
 ['registered project changed','manifest',f=>{f.source.projectId='OTHER-PROJECT';},'MANUAL_SYNC_SOURCE_CHANGED'],
 ['registered manifest changed','body',f=>{f.source.manifestDriveFileId='other-manifest';},'MANUAL_SYNC_SOURCE_CHANGED'],
 ['physical root replaced at same path','image',f=>{renameSync(f.client,join(f.root,'original-client'));mkdirSync(f.client);writeFileSync(join(f.client,'publisher-manifest.json'),f.before);},'MANUAL_SYNC_ROOT_CHANGED']
];
for(const [label,stage,mutate,errorCode] of bindingCases)test(`binding ${label} during ${stage} is fatal without a manifest switch`,async t=>{
 const f=await prepared(t),reads=[],target=stageId(f,stage),manifestId=f.source.manifestDriveFileId;
 const factory=async()=>({downloadRaw:async id=>{reads.push(id);const bytes=id===manifestId?Buffer.from(JSON.stringify(f.manifest)):f.files.get(id);if(id===target)mutate(f);return bytes;}});
 const m=await f.mount({factory});await assertFailure(f,m,await m.post('/api/content-sync/run'),reads,errorCode,stages.indexOf(stage)+1);
});

test('fatal read preserves prior completion timestamp but exposes new failure and consumes approval',async t=>{
 const f=await prepared(t),worker=f.sync.workers.get(f.ws.id),oldCompleted=worker.status().lastCompletedAt,oldResult=worker.status().lastResult;let reads=0;
 worker.drive={downloadRaw:async()=>{reads++;throw Error('GOOGLE_DRIVE_AUTH_EXPIRED');}};
 const once=new ContentSyncOnce(()=>f.sync,f.authorization,f.root);await assert.rejects(once.run(f.ws.id,f.account.id),/GOOGLE_DRIVE_AUTH_EXPIRED/);
 assert.equal(worker.status().lastCompletedAt,oldCompleted);assert.equal(worker.status().lastResult,oldResult);assert.equal(worker.status().lastError,'GOOGLE_DRIVE_AUTH_EXPIRED');assert.equal(f.sync.status(f.ws.id,f.account.id).error,'GOOGLE_DRIVE_AUTH_EXPIRED');assert.equal(marker(f).stage,'BLOCKED');assert.equal(once.capability().canRun,false);assert.equal(reads,1);assert.ok(readFileSync(join(f.client,'publisher-manifest.json')).equals(f.before));
});

test('ordinary missing body is still isolated while a healthy later item completes successfully',async t=>{
 const f=await prepared(t),reads=[];
 const factory=async()=>({downloadRaw:async id=>{reads.push(id);if(id==='OLD-001-body')throw Error('GOOGLE_DRIVE_DOWNLOAD_HTTP_404');return id===f.source.manifestDriveFileId?Buffer.from(JSON.stringify(f.manifest)):f.files.get(id);}});
 const m=await f.mount({factory}),r=await m.post('/api/content-sync/run');assert.equal(r.status,200);const status=await r.json();assert.equal(marker(f).stage,'DONE');assert.ok(status.lastCompletedAt);assert.equal(status.lastResult[0].errors[0].error,'MANIFEST_DOWNLOAD_FAILED');const rows=f.library.catalogue(f.ws.id,'',true);assert.equal(rows.find(x=>x.articleId==='OLD-001').ready,false);assert.equal(rows.find(x=>x.articleId==='NEW-002').body,'Must not read after fatal failure');assert.deepEqual(f.store.db.prepare('SELECT * FROM publisher_jobs').all(),f.jobs);assert.equal(f.submissions(),0);assert.equal(reads.length,4);
});


for(const stage of stages)for(const kind of ['fetch','timeout','response-json'])test(`opaque ${kind} transport failure during ${stage} aborts safely rather than being mistaken for item damage`,async t=>{
 const f=await prepared(t),reads=[],target=stageId(f,stage);
 const factory=async()=>({downloadRaw:async id=>{reads.push(id);if(id===target)throw kind==='fetch'?new TypeError('fetch failed'):kind==='response-json'?new SyntaxError('private token response fixture detail'):Object.assign(Error('private transport fixture detail'),{name:'TimeoutError'});return id===f.source.manifestDriveFileId?Buffer.from(JSON.stringify(f.manifest)):f.files.get(id);}});
 const m=await f.mount({factory});await assertFailure(f,m,await m.post('/api/content-sync/run'),reads,kind==='response-json'?'GOOGLE_DRIVE_READ_RESPONSE_INVALID':'GOOGLE_DRIVE_READ_TRANSPORT_FAILED',stages.indexOf(stage)+1);
});

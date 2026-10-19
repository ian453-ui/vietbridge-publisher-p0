import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,readFileSync,symlinkSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {fixture,image} from './helpers/manual-sync-fixture.js';
import {PublisherAccess} from '../src/publisher-access.js';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function localFixture(t){
 const f=fixture(t),bodies=new Map();
 for(let i=1;i<=21;i++){
  const id='MOCK-FB-'+String(i).padStart(3,'0'),body=`Mock travel note ${i}.\nComplete fixture detail for preview.\nFixture call to action.`;bodies.set(id,body);const item=f.add(id,body);f.files.set(id+'-body',Buffer.from('---\npublish_caption: |\n'+body.split('\n').map(x=>'  '+x).join('\n')+'\n---\n# Fixture'));
  for(const [name,key] of [[item.body_source,id+'-body'],[item.primary_image,id+'-image']]){const path=join(f.client,name);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,f.files.get(key));}
 }
 writeFileSync(join(f.client,'publisher-manifest.json'),JSON.stringify(f.manifest));
 return {...f,bodies,mountLocal:()=>f.mount({policy:null,sources:[],factory:null,options:{library:{roots:[f.root],snapshotRoot:join(f.root,'fixture-frozen'),gptInboxBase:null}}})};
}
async function catalogue(m,workspace){const r=await m.get('/api/group-library?workspace='+workspace);assert.equal(r.status,200);return (await r.json()).items;}
async function selected(m,f,row){const r=await m.post('/api/workspaces/'+f.ws.id+'/library/import',{selections:[{key:row.key,revision:row.revision}]});assert.equal(r.status,201,await r.clone().text());return (await r.json()).contents[0];}
const unchanged=(f,rows)=>{for(const before of rows)assert.deepEqual(f.store.db.prepare('SELECT * FROM publisher_jobs WHERE id=?').get(before.id),before);assert.equal(f.submissions(),0);assert.equal(f.calls(),0);for(const name of ['publisher_submit_intents','publisher_submit_receipts','publisher_execution_permits','publisher_execution_permit_events'])assert.equal(f.store.db.prepare('SELECT count(*) n FROM '+name).get().n,0);};

test('21 mock local articles can be selected, previewed, drafted and version-confirmed while UNKNOWN history and platform boundaries remain frozen',async t=>{
 const f=localFixture(t),old=f.publisher.importContent(f.ws.id,{source_id:'frozen-old',revision:'1',body:'Frozen historical body',media:[]}),historic=f.publisher.createPageJob(f.ws.id,{content_id:old.id,account_id:f.account.id});f.store.db.prepare("UPDATE publisher_jobs SET state='UNKNOWN',attempt_id='frozen-attempt' WHERE id=?").run(historic.id);const history=f.store.db.prepare('SELECT * FROM publisher_jobs').all(),m=await f.mountLocal();
 const rows=await catalogue(m,f.ws.id);assert.equal(rows.length,21);assert.ok(rows.every(r=>r.ready!==false));const row=rows.find(r=>r.articleId==='MOCK-FB-013'),content=await selected(m,f,row);assert.equal(content.body,f.bodies.get(row.articleId));const again=await selected(m,f,row);assert.equal(again.id,content.id);assert.equal(f.store.db.prepare('SELECT count(*) n FROM group_library_imports').get().n,1);
 const preview=await m.get('/api/group-library/content-media?workspace='+f.ws.id+'&contentId='+content.id+'&index=0&platform=facebook');assert.equal(preview.status,200);assert.equal(sha(Buffer.from(await preview.arrayBuffer())),sha(image));assert.ok(JSON.parse(content.media_json)[0].startsWith(join(f.root,'fixture-frozen')));
 const path='/api/unified/workspaces/'+f.ws.id;const created=await m.post(path+'/jobs',{account_id:f.account.id,content_id:content.id,payload:{title:'Fixture preview',body:content.body,tags:[],author:'Fixture'}});assert.equal(created.status,201,await created.clone().text());const job=await created.json();assert.equal(job.state,'DRAFT');assert.equal(job.snapshot.body,content.body);assert.equal(job.snapshot.media.length,1);
 const approved=await m.post(path+'/jobs/'+job.id+'/approve',{snapshot_hash:job.snapshot_hash});assert.equal(approved.status,200,await approved.clone().text());assert.equal((await approved.json()).state,'READY');assert.equal((await m.post(path+'/jobs/'+job.id+'/execute',{confirm:true})).status,423);assert.equal((await m.post(path+'/jobs/'+historic.id+'/approve',{snapshot_hash:historic.snapshot_hash})).status,409);unchanged(f,history);
});

test('local preparation keeps normal administrator, origin, CSRF and exact body validation and denies application tokens',async t=>{
 const f=localFixture(t),m=await f.mountLocal(),row=(await catalogue(m,f.ws.id))[0],path='/api/workspaces/'+f.ws.id+'/library/import',input={selections:[{key:row.key,revision:row.revision}]};
 for(const [extra,status] of [[{authorization:''},401],[{'x-local-token':''},409],[{origin:'https://evil.invalid'},409]])assert.equal((await m.post(path,input,extra)).status,status);
 assert.equal((await m.post(path,{...input,execute:true})).status,409);assert.equal((await m.post(path+'?workspace=ws-other',input)).status,409);assert.equal((await m.post(path,{selections:[{...input.selections[0],media:'/outside'}]})).status,409);
 const access=new PublisherAccess(f.cloud),token=access.createToken({name:'fixture-local-app',password:f.cloud.password,workspaces:[f.ws.id],scopes:['content:import','jobs:create'],days:1}).token;const r=await m.post('/api/unified/workspaces/'+f.ws.id+'/content',{source_id:'app-fixture',revision:'1',body:'Fixture',media:[]},{authorization:'Bearer '+token});assert.equal(r.status,409);assert.equal((await r.json()).error,'LOCAL_PREPARATION_ADMIN_REQUIRED');assert.equal(f.store.db.prepare('SELECT count(*) n FROM group_library_imports').get().n,0);unchanged(f,[]);
});

test('cross-workspace selections, accounts, content and stale source revisions cannot create local tasks or change frozen data',async t=>{
 const f=localFixture(t),m=await f.mountLocal(),rows=await catalogue(m,f.ws.id),row=rows[0],other=join(f.root,'clients','other');mkdirSync(other);writeFileSync(join(other,'publisher-manifest.json'),JSON.stringify({status:'READY',items:[]}));const ws=f.store.saveWorkspace({name:'Other fixture',content_root:other});const foreignMedia=join(other,'private-other.png');writeFileSync(foreignMedia,image);assert.equal((await m.post('/api/unified/workspaces/'+f.ws.id+'/content',{source_id:'wrong-media-fixture',revision:'1',body:'Wrong workspace photo',media:[foreignMedia]})).status,409);assert.equal(f.store.db.prepare('SELECT count(*) n FROM publisher_content_sources').get().n,0);
 const importPath='/api/workspaces/'+ws.id+'/library/import';assert.equal((await m.post(importPath,{selections:[{key:row.key,revision:row.revision}]})).status,409);assert.equal((await m.post('/api/unified/workspaces/'+ws.id+'/accounts/select',{id:f.account.id})).status,409);const content=await selected(m,f,row);assert.equal((await m.post('/api/unified/workspaces/'+ws.id+'/jobs',{content_id:content.id,account_id:f.account.id})).status,409);
 writeFileSync(join(f.client,f.manifest.items[0].body_source),'---\npublish_caption: Changed actual fixture body\n---\n# Fixture');await catalogue(m,f.ws.id);assert.equal((await m.post('/api/workspaces/'+f.ws.id+'/library/import',{selections:[{key:row.key,revision:row.revision}]})).status,409);assert.equal(f.store.db.prepare('SELECT count(*) n FROM publisher_jobs').get().n,0);unchanged(f,[]);
});

test('same logical source accepts a separate revision and new file without changing old UUID, published task or frozen media',async t=>{
 const f=localFixture(t),m=await f.mountLocal(),base='/api/unified/workspaces/'+f.ws.id;const firstImage=join(f.client,'revision-1.png'),nextImage=join(f.client,'revision-8.png');writeFileSync(firstImage,image);writeFileSync(nextImage,Buffer.concat([image,Buffer.from('fixture-new-media')]));
 async function revision(rev,body,path){const r=await m.post(base+'/content',{source_id:'MOCK-STABLE-ITEM',revision:rev,title:'Fixture revision',body,media:[path]});assert.equal(r.status,201,await r.clone().text());return r.json();}
 const old=await revision('content-1-media-7','Original fixture',firstImage),create=await m.post(base+'/jobs',{account_id:f.account.id,content_id:old.id}),job=await create.json();assert.equal(create.status,201);assert.equal((await m.post(base+'/jobs/'+job.id+'/approve',{snapshot_hash:job.snapshot_hash})).status,200);f.store.db.prepare("UPDATE publisher_jobs SET state='PUBLISHED' WHERE id=?").run(job.id);const history=f.store.db.prepare('SELECT * FROM publisher_jobs').all(),asset=f.store.db.prepare('SELECT path,sha256 FROM publisher_job_assets WHERE job_id=?').get(job.id),frozen=readFileSync(asset.path);
 const next=await revision('content-2-media-8','Corrected fixture',nextImage);assert.notEqual(next.id,old.id);assert.equal((await revision('content-2-media-8','Corrected fixture',nextImage)).id,next.id);const oldRow=f.store.db.prepare('SELECT body,media_json FROM group_content WHERE id=?').get(old.id);assert.equal(oldRow.body,'Original fixture');assert.deepEqual(JSON.parse(oldRow.media_json),[firstImage]);assert.ok(readFileSync(asset.path).equals(frozen));assert.equal(sha(frozen),asset.sha256);assert.equal(f.store.db.prepare("SELECT count(*) n FROM publisher_content_sources WHERE source_id='MOCK-STABLE-ITEM'").get().n,2);unchanged(f,history);
});

test('local preparation never opens platform, scheduling, history rewrite, identity or synchronization endpoints',async t=>{
 const f=localFixture(t),m=await f.mountLocal(),u='/api/unified/workspaces/'+f.ws.id,b='/api/workspaces/'+f.ws.id;const paths=[u+'/jobs/fixture/execute',u+'/jobs/fixture/reconcile',u+'/jobs/fixture/reopen',u+'/jobs/fixture/resolve-preparation',u+'/jobs/fixture/finish',u+'/jobs/fixture/manual-complete',u+'/jobs/fixture/finish-unpublished',u+'/accounts/'+f.account.id+'/inspect',u+'/accounts/'+f.account.id+'/transport',u+'/accounts',b+'/profiles',b+'/group-jobs',b+'/group-jobs/fixture/prepare',b+'/group-jobs/auto-publish',b+'/proactive/scan',b+'/proactive/posts/fixture/execute','/api/content-sync/run','/api/access/tokens'];for(const path of paths)assert.equal((await m.post(path,{})).status,423,path);unchanged(f,[]);
});


test('two workspaces cannot share one physical client directory through an alias',async t=>{
 const f=localFixture(t),m=await f.mountLocal(),row=(await catalogue(m,f.ws.id))[0],alias=join(f.root,'clients','alias');symlinkSync(f.client,alias,'dir');f.store.saveWorkspace({name:'Other owner fixture',content_root:alias});
 const r=await m.post('/api/workspaces/'+f.ws.id+'/library/import',{selections:[{key:row.key,revision:row.revision}]});assert.equal(r.status,409);assert.equal(f.store.db.prepare('SELECT count(*) n FROM group_library_imports').get().n,0);unchanged(f,[]);
});

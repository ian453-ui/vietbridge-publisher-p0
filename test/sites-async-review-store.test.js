import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {writeFileSync} from 'node:fs';
import {AsyncReviewStore} from '../src/sites/async-review-store.js';
import {ScopedObjectStore} from '../src/sites/scoped-object-store.js';
import {sitesEvidenceFixture,fileBucket,inspectedPacket} from './fixtures/sites-evidence.js';
import {cloudD1Fixture} from './fixtures/sites-cloud-d1.js';

const ref=(f,p)=>({...f.scope,task_id:p.request.task_id,request_revision:p.request.request_revision});
const service=(f,b,p)=>new AsyncReviewStore(f.f.db,{bucket:b,inspectionProvider:{readInspection:async()=>p}});
test('cloud Review requires configured inspector; rejected packet does no object writes',async t=>{
 const f=await sitesEvidenceFixture(t),b=fileBucket(join(f.root,'bucket')),p=inspectedPacket(f.root,f.scope),s=new AsyncReviewStore(f.f.db,{bucket:b});await assert.rejects(()=>s.intake(ref(f,p)),/INSPECTOR_UNAVAILABLE/);
 const bad=structuredClone(p);bad.report.scope_status='UNKNOWN';await assert.rejects(()=>service(f,b,bad).intake(ref(f,bad)),/INSPECTION_UNVERIFIED/);
 const changed=structuredClone(p);changed.assets[0].data[0]^=1;await assert.rejects(()=>service(f,b,changed).intake(ref(f,changed)),/HASH_MISMATCH/);assert.equal(b.puts,0);assert.equal(f.f.sql.prepare('SELECT count(*) n FROM sites_objects').get().n,0);
});
test('native image decoded Review persists with exact scoped objects, survives reopen and never enables approval',async t=>{
 const f=await sitesEvidenceFixture(t),b=fileBucket(join(f.root,'bucket')),p=inspectedPacket(f.root,f.scope),s=service(f,b,p),r=await s.intake(ref(f,p));assert.equal(r.status,'REVIEW_REQUIRED');assert.equal((await s.intake(ref(f,p))).status,'DUPLICATE');assert.equal(b.puts,2);
 const other=cloudD1Fixture(f.path,{initialize:false});try{const reopened=new AsyncReviewStore(other.db,{bucket:fileBucket(join(f.root,'bucket'))}),v=await reopened.detail(f.workspace,f.accountId,r.id);assert.equal(v.assets.length,2);assert.equal(v.can_decide,false);assert.equal(v.publish_allowed,false);assert.equal(v.report.items[0].artifacts.find(x=>x.kind==='cover').validation.level,'IMAGE_DECODED');
  const a=await reopened.asset(f.workspace,f.accountId,r.id,p.assets[0].source_id,p.assets[0].artifact_id);assert.deepEqual(Buffer.from(a.data),Buffer.from(p.assets[0].data));await assert.rejects(()=>reopened.asset(f.workspace,'other',r.id,p.assets[0].source_id,p.assets[0].artifact_id),/SCOPE_DENIED/);
 }finally{other.close();}
 const w=(await f.post('/api/sites/workspaces',{name:'Other customer'})).id,a=(await f.post('/api/sites/workspaces/'+w+'/accounts',{display_name:'Other customer account',platform:'facebook',external_identity:null})).id,scope={workspace:w,accountId:a},cross=inspectedPacket(f.root,scope);
 await assert.rejects(()=>service(f,b,cross).intake({...scope,task_id:cross.request.task_id,request_revision:1}),/TASK_SCOPE_CONFLICT/);assert.equal(b.puts,2);
});
test('object put committed then failed leaves STAGED; restart reconciles without a second put; timeout never poisons READY',async t=>{
 const f=await sitesEvidenceFixture(t),dir=join(f.root,'bucket'),b=fileBucket(dir),store=new ScopedObjectStore(f.f.db,b),binding={...f.scope,review_id:'synthetic-review',source_id:'SYNTHETIC-074',artifact_id:'body'},data=new TextEncoder().encode('exact body');b.controls.afterPutError='SYNTHETIC_AFTER_PUT';
 await assert.rejects(()=>store.put(binding,data,'text/plain; charset=utf-8'),/AFTER_PUT/);const row=f.f.sql.prepare('SELECT * FROM sites_objects').get();assert.equal(row.state,'STAGED');assert.equal(b.puts,1);
 const recoveredBucket=fileBucket(dir),reopened=new ScopedObjectStore(f.f.db,recoveredBucket,{timeoutMs:100});const ready=await reopened.verify(row.id,f.scope);assert.equal(ready.state,'READY');assert.equal(recoveredBucket.puts,0);
 recoveredBucket.controls.getError='TIMEOUT';await assert.rejects(()=>reopened.verify(row.id,f.scope),/TIMEOUT/);assert.equal(f.f.sql.prepare('SELECT state FROM sites_objects').get().state,'READY');recoveredBucket.controls.getError=null;assert.deepEqual((await reopened.verify(row.id,f.scope)).data,data);
 const plan=await reopened.recoveryPlan(f.workspace,f.accountId);assert.equal(plan.objects[0].action,'RECONCILE_BY_ID');assert.equal(plan.delete_allowed,false);
});
test('positive object corruption blocks reads, scoped access and oversize payloads never touch another key',async t=>{
 const f=await sitesEvidenceFixture(t),b=fileBucket(join(f.root,'bucket')),s=new ScopedObjectStore(f.f.db,b),binding={...f.scope,review_id:'synthetic-review',source_id:'SYNTHETIC-074',artifact_id:'body'},r=await s.put(binding,new TextEncoder().encode('good'),'text/plain; charset=utf-8'),row=f.f.sql.prepare('SELECT * FROM sites_objects').get();
 writeFileSync(b.file(row.object_key),'evil');await assert.rejects(()=>s.verify(r.id,f.scope),/INTEGRITY_MISMATCH/);assert.equal(f.f.sql.prepare('SELECT state FROM sites_objects').get().state,'CORRUPT');await assert.rejects(()=>s.put(binding,new TextEncoder().encode('good'),'text/plain; charset=utf-8'),/CORRUPT/);
 const gets=b.gets;await assert.rejects(()=>s.verify(r.id,{workspace:f.workspace,accountId:'wrong'}),/SCOPE_DENIED/);assert.equal(b.gets,gets);await assert.rejects(()=>s.put(binding,new Uint8Array(16*1024*1024+1),'text/plain; charset=utf-8'),/SIZE_LIMIT/);assert.equal(b.puts,1);
});
test('second Review asset reference insertion failure rolls back receipt/references; immutable objects recover without deletion',async t=>{
 const f=await sitesEvidenceFixture(t),b=fileBucket(join(f.root,'bucket')),p=inspectedPacket(f.root,f.scope),s=service(f,b,p);f.f.sql.exec("CREATE TEMP TRIGGER fail_cover BEFORE INSERT ON sites_review_assets WHEN NEW.artifact_id='cover' BEGIN SELECT RAISE(ABORT,'SYNTHETIC_SECOND_REFERENCE'); END");
 await assert.rejects(()=>s.intake(ref(f,p)),/SECOND_REFERENCE/);assert.equal(f.f.sql.prepare('SELECT count(*) n FROM sites_reviews').get().n,0);assert.equal(f.f.sql.prepare('SELECT count(*) n FROM sites_review_assets').get().n,0);assert.equal(f.f.sql.prepare('SELECT count(*) n FROM sites_objects WHERE state=\'READY\'').get().n,2);
 const recovery=await s.objects.recoveryPlan(f.workspace,f.accountId);assert.ok(recovery.objects.every(x=>x.action==='RECONCILE_BY_ID'&&!x.delete_allowed));f.f.sql.exec('DROP TRIGGER fail_cover');assert.equal((await s.intake(ref(f,p))).status,'REVIEW_REQUIRED');assert.equal(b.puts,2);assert.equal(f.f.sql.prepare('SELECT count(*) n FROM sites_review_assets').get().n,2);
});
test('two Review writers converge, same-version changed result conflicts, newer version never rewrites old bytes',async t=>{
 const f=await sitesEvidenceFixture(t),dir=join(f.root,'bucket'),p=inspectedPacket(f.root,f.scope),s=service(f,fileBucket(dir),p),other=cloudD1Fixture(f.path,{initialize:false});t.after(()=>other.close());const s2=new AsyncReviewStore(other.db,{bucket:fileBucket(dir),inspectionProvider:{readInspection:async()=>p}});
 const results=await Promise.all([s.intake(ref(f,p)),s2.intake(ref(f,p))]);assert.equal(results[0].id,results[1].id);assert.equal(f.f.sql.prepare('SELECT count(*) n FROM sites_reviews').get().n,1);
 const same=inspectedPacket(f.root,f.scope);await assert.rejects(()=>service(f,fileBucket(dir),same).intake(ref(f,same)),/CONFLICTING_REVIEW_RESULT/);
 const next=inspectedPacket(f.root,f.scope,{revision:2,prior:p.request});await service(f,fileBucket(dir),next).intake(ref(f,next));assert.equal((await s.detail(f.workspace,f.accountId,results[0].id)).state,'SUPERSEDED');await assert.rejects(()=>s.intake(ref(f,p)),/STALE_REVIEW_VERSION/);assert.equal(f.f.sql.prepare('SELECT count(*) n FROM sites_reviews').get().n,2);
});

test('Review SQL commit followed by lost acknowledgement reconciles to the same receipt and objects',async t=>{
 const f=await sitesEvidenceFixture(t),b=fileBucket(join(f.root,'bucket')),p=inspectedPacket(f.root,f.scope),batch=f.f.db.batch;let lose=true;
 const db={prepare:query=>f.f.db.prepare(query),async batch(statements){const r=await batch(statements);if(lose&&statements.some(s=>s.query.startsWith('INSERT INTO sites_reviews'))){lose=false;throw Error('SYNTHETIC_COMMIT_ACK_LOST');}return r;}},s=new AsyncReviewStore(db,{bucket:b,inspectionProvider:{readInspection:async()=>p}});
 await assert.rejects(()=>s.intake(ref(f,p)),/COMMIT_ACK_LOST/);assert.equal(f.f.sql.prepare('SELECT count(*) n FROM sites_reviews').get().n,1);assert.equal((await s.intake(ref(f,p))).status,'DUPLICATE');assert.equal(f.f.sql.prepare('SELECT count(*) n FROM sites_reviews').get().n,1);assert.equal(b.puts,2);
});

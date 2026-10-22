import test from 'node:test';
import assert from 'node:assert/strict';
import {AsyncMetricStore} from '../src/sites/async-metric-store.js';
import {MetricObservationStore} from '../src/metric-observation-store.js';
import {validateMetricObservation} from '../src/metric-observation.js';
import {sitesEvidenceFixture} from './fixtures/sites-evidence.js';
import {cloudD1Fixture} from './fixtures/sites-cloud-d1.js';
import {metricPacket,metricSelector,metricNow} from './fixtures/synthetic-metrics.js';

test('async metric writes preserve native canonical IDs, raw evidence, duplicates/conflicts and restart',async t=>{
 const f=await sitesEvidenceFixture(t),s=new AsyncMetricStore(f.f.db),id=(await s.registerTarget(f.target)).id,p=metricPacket(f.target),r=await s.ingest(id,p,{...f.scope,now:metricNow});assert.equal(r.status,'RECORDED');assert.equal((await s.ingest(id,p,{...f.scope,now:metricNow})).status,'DUPLICATE');
 const target=f.target,binding=Object.fromEntries(['workspace','account_id','platform','object_id','content_revision','publication_job_id','source_reference','source_transport','operator_actor_id','business_asset_id','source_account_id','source_object_id'].map(k=>[k,target[k]]));assert.equal((await s.checked(target,p,metricNow)).record.source.sha256,validateMetricObservation(p.observation,{binding,evidenceBytes:p.evidenceBytes,now:metricNow}).source.sha256);
 const other=cloudD1Fixture(f.path,{initialize:false});try{const reopened=new AsyncMetricStore(other.db);assert.equal((await reopened.snapshot(r.series_id,f.scope)).value,100);const native=new MetricObservationStore(other.sql);assert.deepEqual((await reopened.snapshot(r.series_id,f.scope)).observation_ids,native.snapshot(r.series_id,f.scope).observation_ids);}finally{other.close();}
 const conflict=await s.ingest(id,metricPacket(target,{value:88}),{...f.scope,now:metricNow});assert.equal(conflict.status,'CONFLICT_RETAINED');assert.equal((await s.snapshot(r.series_id,f.scope)).value,null);assert.equal((await s.history(r.series_id,f.scope)).entries.length,2);
});
test('async metrics bind exact frozen job and reject cross-scope/task/target changes',async t=>{
 const f=await sitesEvidenceFixture(t),s=new AsyncMetricStore(f.f.db),id=(await s.registerTarget(f.target)).id;
 for(const key of ['content_id','content_revision','account_id','workspace','object_id','task_id'])await assert.rejects(()=>s.registerTarget({...f.target,[key]:'changed',...(key==='object_id'?{source_object_id:'changed'}:{})}));
 await assert.rejects(()=>s.ingest(id,metricPacket(f.target),{workspace:f.workspace,accountId:'wrong'}));
 const p=metricPacket(f.target);p.observation.object_id='other';await assert.rejects(()=>s.ingest(id,p,{...f.scope,now:metricNow}),/SCOPE_MISMATCH/);
 await assert.rejects(()=>s.registerTarget({...f.target,publication_job_id:'missing-job'}));assert.equal(f.f.sql.prepare('SELECT count(*) n FROM metric_targets').get().n,1);
});
test('async metric raw insert failure rolls back all rows; oversized and corrupt raw data fail closed',async t=>{
 const f=await sitesEvidenceFixture(t),s=new AsyncMetricStore(f.f.db),id=(await s.registerTarget(f.target)).id,p=metricPacket(f.target);
 f.f.fault=3;await assert.rejects(()=>s.ingest(id,p,{...f.scope,now:metricNow}),/SYNTHETIC_TRANSACTION_FAILURE/);assert.equal(f.f.sql.prepare('SELECT count(*) n FROM metric_series').get().n,0);assert.equal(f.f.sql.prepare('SELECT count(*) n FROM sites_write_assertions').get().n,0);f.f.fault=-1;
 await assert.rejects(()=>s.ingest(id,{...p,evidenceBytes:new Uint8Array(262145)},f.scope),/BUDGET/);const r=await s.ingest(id,p,{...f.scope,now:metricNow});f.f.sql.prepare('UPDATE metric_raw_evidence SET data=? WHERE observation_id=?').run(Buffer.from('wrong'),r.id);await assert.rejects(()=>s.snapshot(r.series_id,f.scope),/STORAGE_CORRUPT/);
});
test('async as-of exact 12:00 A/B counterexample and late old failures preserve generation ordering after reopen',async t=>{
 const f=await sitesEvidenceFixture(t),s=new AsyncMetricStore(f.f.db),id=(await s.registerTarget(f.target)).id,at=n=>metricNow+n*1000,p=metricPacket(f.target,{at:new Date(at(5)).toISOString()}),shape=metricSelector(p);
 const a=await s.beginCollection(id,shape,{...f.scope,now:at(0)}),r=await s.ingest(id,p,{...f.scope,now:at(5)}),b=await s.beginCollection(id,shape,{...f.scope,now:at(10)});await s.failCollection(b.id,{...f.scope,now:at(15)});await s.failCollection(a.id,{...f.scope,now:at(20)});
 const other=cloudD1Fixture(f.path,{initialize:false});try{const report=await new AsyncMetricStore(other.db).snapshot(r.series_id,{...f.scope,asOf:new Date(at(18)).toISOString()});assert.equal(report.status,'COLLECTION_FAILED');assert.equal(report.collection_attempt.id,b.id);assert.equal(report.value,null);}finally{other.close();}
 const c=await s.beginCollection(id,shape,{...f.scope,now:at(25)}),d=await s.beginCollection(id,shape,{...f.scope,now:at(30)});await s.ingest(id,metricPacket(f.target,{value:222,at:new Date(at(32)).toISOString()}),{...f.scope,now:at(32),attemptId:d.id});await s.failCollection(c.id,{...f.scope,now:at(40)});assert.equal((await s.snapshot(r.series_id,f.scope)).value,222);
});
test('async metric attempts serialize generations across connections, preserve pending, null and distinct windows',async t=>{
 const f=await sitesEvidenceFixture(t),s=new AsyncMetricStore(f.f.db),id=(await s.registerTarget(f.target)).id,other=cloudD1Fixture(f.path,{initialize:false});t.after(()=>other.close());const p=metricPacket(f.target),shape=metricSelector(p),s2=new AsyncMetricStore(other.db);
 const attempts=await Promise.all([s.beginCollection(id,shape,{...f.scope,now:metricNow}),s2.beginCollection(id,shape,{...f.scope,now:metricNow})]),ordered=f.f.sql.prepare('SELECT id,generation FROM metric_collection_attempts ORDER BY generation').all();assert.deepEqual(ordered.map(x=>x.generation),[1,2]);assert.equal((await s.snapshot(attempts[0].series_id,f.scope)).status,'COLLECTION_PENDING');
 await s.ingest(id,p,{...f.scope,now:metricNow+1,attemptId:ordered[0].id});assert.equal((await s.snapshot(attempts[0].series_id,f.scope)).value,null);
 await s.ingest(id,metricPacket(f.target,{value:null,availability:'PERMISSION_DENIED',reason:'SYNTHETIC_DENIED'}),{...f.scope,now:metricNow+1,attemptId:ordered[1].id});assert.equal((await s.snapshot(attempts[0].series_id,f.scope)).reason,'SYNTHETIC_DENIED');
 for(const packet of [metricPacket(f.target,{name:'reach'}),metricPacket(f.target,{window:{kind:'UNKNOWN',start:null,end:null,timezone:null}})])await s.ingest(id,packet,{...f.scope,now:metricNow});assert.equal((await s.list(f.workspace,f.accountId)).snapshots.length,3);
 await assert.rejects(()=>s.failCollection(attempts[0].id,{...f.scope,now:metricNow+2}));assert.equal(f.f.sql.prepare('SELECT count(*) n FROM metric_attempt_observations').get().n,2);
});

test('async same-timestamp older late success stays in history without contaminating current generation',async t=>{
 const f=await sitesEvidenceFixture(t),s=new AsyncMetricStore(f.f.db),id=(await s.registerTarget(f.target)).id,at=n=>metricNow+n*1000,p=metricPacket(f.target,{value:200,at:new Date(at(12)).toISOString()}),shape=metricSelector(p),a=await s.beginCollection(id,shape,{...f.scope,now:at(0)}),b=await s.beginCollection(id,shape,{...f.scope,now:at(10)});
 const r=await s.ingest(id,p,{...f.scope,now:at(12),attemptId:b.id});await s.ingest(id,metricPacket(f.target,{value:90,at:p.observation.observed_at}),{...f.scope,now:at(20),attemptId:a.id});assert.equal((await s.snapshot(r.series_id,f.scope)).value,200);assert.equal((await s.history(r.series_id,f.scope)).entries.length,2);
});
